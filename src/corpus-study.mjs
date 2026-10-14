// Key-blind development diagnostics. This module never receives the author's key.
import crypto from "node:crypto";
import { noul, GATES } from "./engine.mjs";
import { validateAnswer, passes } from "./typed/questions.mjs";
import { safeFailureCode } from "./typed/client.mjs";

export const corpusHash = value => crypto.createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex");
const label = index => String.fromCharCode(65 + index);
const text = value => typeof value === "string" && value.trim().length > 0;

export function blindState(context, draw = 1, control = null) {
  const stem = context.stem ?? context.question;
  const paragraphs = context.passages ?? context.stimulus;
  const original = (Array.isArray(context.options) ? context.options : Object.values(context.options ?? {})).map(option => typeof option === "string" ? option : option?.text);
  const passages = (Array.isArray(paragraphs) ? paragraphs : typeof paragraphs === "string" ? [paragraphs] : []).map(passage => typeof passage === "string" ? passage : passage?.text);
  if (!text(stem) || original.length < 2 || original.length > 8 || !original.every(text) || !passages.every(text)) throw new TypeError("invalid blind passage-choice state");
  const sourceIndexes = original.map((_, index) => index);
  // First two fresh-process draws use identical inputs; later draws stress answer order.
  const shift = Math.max(0, draw - 2) % original.length;
  const order = [...sourceIndexes.slice(shift), ...sourceIndexes.slice(0, shift)];
  const choices = order.map(index => ({ text: original[index], source_index: index }));
  const expanded = control === "duplicate_options" ? choices.flatMap(choice => [choice, { ...choice }]) : choices;
  if (expanded.length > 16) throw new TypeError("control option budget exceeded");
  const state = { passages: control === "missing_passages" ? [] : [...passages], question: stem,
    options: Object.fromEntries(expanded.map((choice, index) => [label(index), choice.text])) };
  const instruction = Array.isArray(context.instruction) ? context.instruction.filter(text).join("\n") : context.instruction;
  if (text(instruction)) state.instruction = instruction;
  return { state, position_map: expanded.map(choice => choice.source_index), original_option_count: original.length };
}

export function probeQuestions(state, protocol) {
  return [...Object.keys(state.options).map(key => noul(`option_${key}`, protocol.option_instruction.replace("{label}", key))),
    noul("answerable", protocol.answerable_instruction), noul("clear", protocol.clear_instruction)];
}

function boundedUsage(input) {
  return Object.fromEntries(Object.entries(input ?? {}).filter(([key, value]) => /^(?:prompt_tokens|completion_tokens|total_tokens|input_tokens|output_tokens)$/.test(key) && Number.isSafeInteger(value) && value >= 0));
}
const revision = value => typeof value === "string" && value.length <= 128 && /^[A-Za-z0-9._:/-]+$/.test(value)
  && !/^(?:apk_|apikey_|sk-)/.test(value) ? value : null;

export function summarizeProbeSamples(observations, questions, samples) {
  return questions.map(question => {
    const entries = observations.map(observation => ({ sample: observation.sample, ...observation.answers[question.id] }));
    const reasons = [];
    if (entries.length !== samples || entries.some(entry => !entry.valid)) reasons.push("incomplete_or_invalid_sample_set");
    if (entries.some(entry => entry.category === "unsure")) reasons.push("a_sample_abstained");
    const categories = new Set(entries.filter(entry => entry.valid).map(entry => entry.category));
    if (categories.has("yes") && categories.has("no")) reasons.push("samples_disagree");
    if (observations.some(observation => !observation.model_verified_for_trial)) reasons.push("reported_model_outside_declared_trial");
    if (new Set(observations.map(observation => observation.reported_model)).size !== 1) reasons.push("reported_model_changed");
    const verdict = reasons.length ? entries.some(entry => !entry.valid) ? "unavailable" : "unsure" : [...categories][0] ?? "unavailable";
    return { id: question.id, verdict, samples: entries, reasons };
  });
}

export function summarizeProbe(checks, positionMap, control = null) {
  const options = checks.filter(check => check.id.startsWith("option_"));
  const unresolved = options.some(check => !["yes", "no"].includes(check.verdict));
  const positives = options.flatMap((check, index) => check.verdict === "yes" ? [{ label: check.id.slice(7), source_position: positionMap[index] }] : []);
  const unique = !unresolved && positives.length === 1;
  let outcome = unresolved ? "unresolved" : unique ? "unique_supported_option" : positives.length > 1 ? "multiple_supported_options" : "no_supported_option";
  if (control === "duplicate_options") outcome = unique ? "control_violation_unique_duplicate" : unresolved ? "control_unresolved" : "control_no_unique_approval";
  if (control === "missing_passages") outcome = positives.length ? "control_violation_answer_without_passage" : unresolved ? "control_unresolved" : "control_no_answer_without_passage";
  return { outcome, positive_options: positives, selected_source_position: unique ? positives[0].source_position : null,
    answerable: checks.find(check => check.id === "answerable")?.verdict ?? "unavailable",
    clear: checks.find(check => check.id === "clear")?.verdict ?? "unavailable",
    whole_item_status: "unverified", accuracy: "unmeasured" };
}

export async function runProbe(candidate, { provider, protocol, draw, samples, control = null } = {}) {
  const { state, position_map } = blindState(candidate.solver_context, draw, control);
  const questions = probeQuestions(state, protocol);
  const allowedModels = provider.name === "jev" ? protocol.primary_reported_models : protocol.side_reported_models;
  const observations = await Promise.all(Array.from({ length: samples }, async (_, sample) => {
    const started = Date.now();
    try {
      const response = await provider.ask(state, questions, { sample });
      const model = typeof response.model === "string" && allowedModels.includes(response.model) ? response.model : null;
      const answers = Object.fromEntries(questions.map(question => {
        const raw = response.error ? null : response.answers?.[question.id];
        const validated = validateAnswer(question, raw);
        if (validated.unavailable) return [question.id, { valid: false, category: "unavailable", reason: validated.reason }];
        const gated = passes(validated, GATES);
        const p = validated.value;
        const categoricalUnsure = provider.name !== "jev" && p === 0.5;
        return [question.id, { valid: true, p_yes: p, category: categoricalUnsure || !gated.pass ? "unsure" : p >= 0.5 ? "yes" : "no",
          gate_reasons: categoricalUnsure ? ["categorical_unsure"] : gated.reasons }];
      }));
      return { sample, reported_model: model, model_verified_for_trial: Boolean(model), reported_served_revision: revision(response.served_revision),
        serving_revision_verified: false, usage: boundedUsage(response.usage), ms: Date.now() - started, answers };
    } catch (error) {
      const code = safeFailureCode(error);
      return { sample, reported_model: null, model_verified_for_trial: false, error_code: code, ms: Date.now() - started,
        answers: Object.fromEntries(questions.map(question => [question.id, { valid: false, category: "unavailable", reason: code }])) };
    }
  }));
  const checks = summarizeProbeSamples(observations, questions, samples);
  return { id: candidate.id, control, provider: provider.name, requested_model: provider.model, draw,
    solver_packet_sha256: corpusHash({ state, questions }), position_map, checks, observations,
    ...summarizeProbe(checks, position_map, control), logical_sample_calls: observations.length,
    actual_http_or_billed_requests: "not established by logical sample counts", qualification: false };
}

export async function runCorpusDraw(cases, { primary = null, side = null, protocol, draw, samples, controls = [], onResult = () => {} } = {}) {
  const queue = [...cases.map(candidate => ({ candidate, control: null })), ...controls];
  const results = [];
  await Promise.all(Array.from({ length: protocol.concurrency }, async () => {
    while (queue.length) {
      const { candidate, control } = queue.shift();
      // Each provider sees the same blind evidence and no answers from the other.
      const primaryResult = primary ? await runProbe(candidate, { provider: primary, protocol, draw, samples, control }) : null;
      const sideResult = side ? await runProbe(candidate, { provider: side, protocol, draw, samples, control }) : null;
      const result = { id: candidate.id, control, primary: primaryResult, side: sideResult };
      results.push(result);
      await onResult(result);
    }
  }));
  return results.sort((a, b) => `${a.id}/${a.control ?? ""}`.localeCompare(`${b.id}/${b.control ?? ""}`));
}

export function summarizeCorpusDraws(draws, expectations) {
  const result = [];
  const providers = ["primary", "side"];
  for (const expected of expectations) {
    if (!Array.isArray(expected.authored_key) || expected.authored_key.length !== 1 || !Number.isInteger(expected.authored_key[0]) || expected.authored_key[0] < 0) throw new TypeError("source comparison requires exactly one authored index");
    const observations = draws.map(draw => draw.results.find(row => row.id === expected.id && row.control === null));
    const models = {};
    for (const provider of providers) {
      const records = observations.map(row => row?.[provider]).filter(Boolean);
      if (!records.length) continue;
      const signatures = records.map(record => JSON.stringify({ outcome: record.outcome, selected: record.selected_source_position,
        positive: record.positive_options.map(option => option.source_position).sort((a, b) => a - b), answerable: record.answerable, clear: record.clear }));
      const complete = records.length === draws.length;
      const identicalDraws = records.filter(record => record.draw <= 2);
      const identicalInputs = identicalDraws.length === 2 && identicalDraws[0].solver_packet_sha256 === identicalDraws[1].solver_packet_sha256;
      const sameVerdict = (a, b) => JSON.stringify({ outcome: a.outcome, positive: a.positive_options.map(option => option.source_position).sort((x, y) => x - y), answerable: a.answerable, clear: a.clear }) === JSON.stringify({ outcome: b.outcome, positive: b.positive_options.map(option => option.source_position).sort((x, y) => x - y), answerable: b.answerable, clear: b.clear });
      const reportedModels = [...new Set(records.flatMap(record => record.observations.map(observation => observation.reported_model)))];
      const revisions = [...new Set(records.flatMap(record => record.observations.map(observation => observation.reported_served_revision ?? null)))];
      models[provider] = { draws: records.length, complete, stable: complete && signatures.every(signature => signature === signatures[0]),
        stability_meaning: "Verdict consistency under changed option order; fixed serving revision unverified.",
        identical_input_repetition: { complete: identicalInputs, same_verdict: identicalInputs ? sameVerdict(...identicalDraws) : null },
        reported_models: reportedModels, reported_served_revisions: revisions, reported_revision_drift: revisions.filter(Boolean).length > 1,
        serving_revision_verified: false,
        source_key_comparisons: records.map(record => ({ draw: record.draw, outcome: record.outcome,
          selected_source_position: record.selected_source_position,
          matches_source_key: record.outcome === "unique_supported_option" ? record.selected_source_position === expected.authored_key[0] : null,
          answerable: record.answerable, clear: record.clear })),
        logical_sample_calls: records.reduce((sum, record) => sum + record.logical_sample_calls, 0) };
    }
    result.push({ id: expected.id, corpus_id: expected.corpus_id, source_key: expected.authored_key, provenance: expected.provenance, models,
      qualification: false, academic_quality: "unmeasured" });
  }
  const controls = draws.flatMap(draw => draw.results.filter(row => row.control).map(row => ({ draw: draw.draw, id: row.id, control: row.control,
    primary: row.primary?.outcome ?? null, side: row.side?.outcome ?? null })));
  return { items: result, controls, qualification: false, independent_gold_labels: 0, accuracy: "unmeasured",
    meaning: "Repeated derived text-solving diagnostics and comparison with unvalidated source keys; not native lesson evaluation, learner readiness, or independent academic accuracy." };
}
