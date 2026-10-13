// decide(): n concurrent samples of one batched typed request -> validated -> aggregated -> gated -> logged.
// One retry for questions whose every sample came back invalid (bounded recovery). Unknown is never zero.
import { validateAnswer, aggregate, passes, GATES, PROMPT_VERSION } from "./questions.mjs";

export async function decide(state, questions, { provider, samples = 1, gates = GATES, log = null, tag = null } = {}) {
  if (!provider) throw new Error("decide: provider required");
  const t0 = Date.now();
  const runSamples = async (qs) => {
    const results = await Promise.all(Array.from({ length: samples }, (_, i) => provider.ask(state, qs, { sample: i }).catch((e) => ({ error: String(e?.message ?? e) }))));
    const perQ = Object.fromEntries(qs.map((q) => [q.id, []]));
    let model = provider.model;
    let usage = [], observations = [];
    for (const r of results) {
      observations.push({ model: r.model ?? null, reported_served_revision: r.served_revision ?? null, unavailable: Boolean(r.error) });
      if (r.model) model = r.model;
      if (r.usage) usage.push(r.usage);
      for (const q of qs) perQ[q.id].push(r.error ? { unavailable: true, reason: `transport:${r.error}` } : validateAnswer(q, r.answers?.[q.id]));
    }
    return { perQ, model, usage, observations };
  };
  let { perQ, model, usage, observations } = await runSamples(questions);
  const dead = questions.filter((q) => perQ[q.id].every((a) => a.unavailable));
  let retried = 0;
  if (dead.length) {
    retried = dead.length;
    const again = await runSamples(dead);
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
  const record = { at: new Date().toISOString(), tag, provider: provider.name, model, prompt_version: PROMPT_VERSION, samples, retried, logical_sample_calls: observations.length, serving_observations: observations, ms: Date.now() - t0, usage, state, questions, answers };
  if (log) log.push(record);
  return { answers, meta: record };
}
