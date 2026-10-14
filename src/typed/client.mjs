// decide(): n concurrent samples of one batched typed request -> validated -> aggregated -> gated -> logged.
// One retry for questions whose every sample came back invalid (bounded recovery). Unknown is never zero.
import { validateAnswer, aggregate, passes, GATES, PROMPT_VERSION } from "./questions.mjs";

const FAILED = Symbol("provider failure");
const PROVIDER_CODE = /^(?:HTTP_(?:[1-5][0-9]{2}|UNKNOWN)|TIMEOUT|TRANSPORT_UNAVAILABLE|INVALID_JSON|INVALID_CATEGORICAL|INCOMPLETE_COMPLETION|UNAVAILABLE)$/;
const VALIDATION_CODES = new Set(["answer_missing", "probability_value", "probability_keys", "probability_sum",
  "choice_invalid", "choice_not_maximal", "confidence_invalid", "score_invalid", "answer_type"]);

/** Only a bounded code crosses from a provider exception into an evaluation artifact. */
export function safeFailureCode(error) {
  let code;
  try { code = error?.code; } catch { return "UNAVAILABLE"; }
  return typeof code === "string" && PROVIDER_CODE.test(code) ? code : "UNAVAILABLE";
}
const safeValidationCode = (reason) => VALIDATION_CODES.has(reason) ? reason : "answer_invalid";

export async function decide(state, questions, { provider, samples = 1, gates = GATES, log = null, tag = null } = {}) {
  if (!provider) throw new Error("decide: provider required");
  const t0 = Date.now();
  const failureObservations = [];
  const runSamples = async (qs, phase) => {
    const results = await Promise.all(Array.from({ length: samples }, (_, i) => Promise.resolve()
      .then(() => provider.ask(state, qs, { sample: i }))
      .catch((error) => ({ [FAILED]: safeFailureCode(error) }))));
    const perQ = Object.fromEntries(qs.map((q) => [q.id, []]));
    let model = provider.model;
    let usage = [], observations = [];
    for (const [sample, r] of results.entries()) {
      const providerCode = r?.[FAILED] ?? (r?.error ? "UNAVAILABLE" : null);
      observations.push({ model: r?.model ?? null, reported_served_revision: r?.served_revision ?? null, unavailable: providerCode !== null });
      if (r?.model) model = r.model;
      if (r?.usage) usage.push(r.usage);
      for (const q of qs) {
        const answer = providerCode === null ? validateAnswer(q, r?.answers?.[q.id])
          : { unavailable: true, reason: `transport:${providerCode}` };
        if (answer.unavailable) {
          const code = providerCode ?? safeValidationCode(answer.reason);
          failureObservations.push({ phase, sample, question_id: q.id, source: providerCode === null ? "validation" : "provider", code });
          answer.reason = providerCode === null ? code : `transport:${code}`;
        }
        perQ[q.id].push(answer);
      }
    }
    return { perQ, model, usage, observations };
  };
  let { perQ, model, usage, observations } = await runSamples(questions, "initial");
  const dead = questions.filter((q) => perQ[q.id].every((a) => a.unavailable));
  let retried = 0;
  if (dead.length) {
    retried = dead.length;
    const again = await runSamples(dead, "recovery");
    for (const q of dead) perQ[q.id] = again.perQ[q.id];
    usage.push(...again.usage);
    observations.push(...again.observations);
  }
  const answers = {};
  for (const q of questions) {
    const agg = aggregate(q, perQ[q.id]);
    const gate = passes(agg, gates);
    answers[q.id] = { ...agg, pass: gate.pass, gate_reasons: gate.reasons, top: gate.top, margin: gate.margin };
  }
  const record = { at: new Date().toISOString(), tag, provider: provider.name, model, prompt_version: PROMPT_VERSION, samples, retried, logical_sample_calls: observations.length, serving_observations: observations, failure_observations: failureObservations, ms: Date.now() - t0, usage, state, questions, answers };
  if (log) log.push(record);
  return { answers, meta: record };
}
