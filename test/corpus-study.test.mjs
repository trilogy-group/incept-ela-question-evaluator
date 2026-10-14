import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { blindState, runProbe, summarizeCorpusDraws } from "../src/corpus-study.mjs";

const protocol = JSON.parse(fs.readFileSync(new URL("../criteria/corpus-choice-probe.json", import.meta.url)));
const candidate = { id: "case-001", authored_key: [0], producer: "hidden-maker", solver_context: {
  question: "According to the passage, who crossed the river?", stimulus: [{ text: "The fox crossed the river." }],
  options: [{ text: "Fox" }, { text: "Hare" }], instruction: ["Choose one answer."],
  key: [0], feedback: "secret-feedback", rubric: "secret-rubric", native: { producer: "secret-producer" }
} };
function provider({ name = "jev", probabilities, model, error, revision } = {}) {
  return { name, model: "test-alias", async ask(state, questions, { sample }) {
    assert.deepEqual(Object.keys(state).sort(), ["instruction", "options", "passages", "question"]);
    assert.doesNotMatch(JSON.stringify(state), /secret|authored_key|producer|rubric|feedback/);
    if (error) throw error;
    return { model: model ?? (name === "jev" ? "jev-1.13.0" : "gemini-3.8-flash"), served_revision: revision,
      answers: Object.fromEntries(questions.map(q => [q.id, { noul: probabilities ? probabilities(q.id, sample, state) : q.id === "option_A" || !q.id.startsWith("option_") ? 1 : 0 }])) };
  } };
}
const probe = (p, options = {}) => runProbe(candidate, { provider: p, protocol, draw: 1, samples: 3, ...options });

test("blind payload keeps only learner text and rotates choices with a reversible source map", () => {
  const first = blindState(candidate.solver_context, 1), second = blindState(candidate.solver_context, 3);
  assert.deepEqual(blindState(candidate.solver_context, 2), first);
  assert.deepEqual(first.position_map, [0, 1]); assert.deepEqual(second.position_map, [1, 0]);
  assert.deepEqual(second.state.options, { A: "Hare", B: "Fox" });
  assert.deepEqual(first.state.passages, ["The fox crossed the river."]);
  assert.equal(first.state.instruction, "Choose one answer.");
  assert.doesNotMatch(JSON.stringify(first.state), /secret|key|producer/);
});

test("source-key agreement is computed after blind solving and uses canonical option position", async () => {
  const p = provider({ probabilities: (id, sample, state) => id.startsWith("option_") ? Number(state.options[id.slice(7)] === "Fox") : 1 });
  const a = await probe(p), b = await probe(p, { draw: 3 });
  const result = summarizeCorpusDraws([{ results: [{ id: candidate.id, control: null, primary: a }] }, { results: [{ id: candidate.id, control: null, primary: b }] }],
    [{ id: candidate.id, authored_key: [0], corpus_id: "source-row", provenance: [] }]);
  assert.equal(result.items[0].models.primary.stable, true);
  assert.deepEqual(result.items[0].models.primary.source_key_comparisons.map(x => x.matches_source_key), [true, true]);
  assert.equal(result.accuracy, "unmeasured"); assert.equal(result.independent_gold_labels, 0);
  assert.throws(() => summarizeCorpusDraws([], [{ id: "bad", authored_key: { indices: [0] } }]), /exactly one/);
});

test("an abstention in any Gemini sample vetoes an otherwise affirmative result", async () => {
  const result = await probe(provider({ name: "gemini-flash", probabilities: (id, sample) => id === "option_A" ? [1, 1, 0.5][sample] : id.startsWith("option_") ? 0 : 1 }));
  const check = result.checks.find(c => c.id === "option_A");
  assert.equal(check.verdict, "unsure"); assert.equal(result.outcome, "unresolved");
  assert.deepEqual(check.samples.map(s => s.p_yes), [1, 1, 0.5]);
  assert.ok(check.reasons.includes("a_sample_abstained"));
});

test("conflicting or uncertain Jev samples remain unresolved", async () => {
  for (const probs of [[0.95, 0.05, 0.95], [0.95, 0.51, 0.95]]) {
    const result = await probe(provider({ probabilities: (id, sample) => id === "option_A" ? probs[sample] : 0 }));
    assert.equal(result.checks[0].verdict, "unsure"); assert.equal(result.outcome, "unresolved");
  }
});

test("an unrecognized reported model cannot support a resolved verdict", async () => {
  const result = await probe(provider({ model: "different-model" }));
  assert.equal(result.outcome, "unresolved");
  assert.equal(result.observations[0].reported_model, null);
  assert.ok(result.checks[0].reasons.includes("reported_model_outside_declared_trial"));
});

test("failed samples retain only bounded codes and cannot become passes", async () => {
  const error = new Error("do not retain sensitive transport response"); error.code = "HTTP_503";
  const result = await probe(provider({ error }));
  assert.equal(result.checks[0].verdict, "unavailable");
  assert.equal(result.observations[0].error_code, "HTTP_503");
  assert.doesNotMatch(JSON.stringify(result), /sensitive transport/);
});

test("controls diagnose symmetry and absent passages separately from source questions", async () => {
  const duplicate = await probe(provider(), { control: "duplicate_options" });
  assert.equal(duplicate.outcome, "control_violation_unique_duplicate");
  assert.deepEqual(duplicate.position_map, [0, 0, 1, 1]);
  const missing = await probe(provider(), { control: "missing_passages" });
  assert.equal(missing.outcome, "control_violation_answer_without_passage");
  assert.equal(duplicate.whole_item_status, "unverified"); assert.equal(missing.qualification, false);
});

test("affirmative uniqueness cannot conceal multiple supported choice labels", async () => {
  const result = await probe(provider({ probabilities: (id, sample, state) => id.startsWith("option_") ? Number(state.options[id.slice(7)] === "Fox") : 1 }), { control: "duplicate_options" });
  assert.equal(result.outcome, "control_no_unique_approval");
  assert.equal(result.positive_options.length, 2);
  assert.deepEqual(result.criterion_contradictions, ["affirmative_uniqueness_conflicts_with_supported_option_count"]);
});

test("reported serving revisions are preserved without claiming independent verification", async () => {
  const result = await probe(provider({ revision: "service-build.123" }));
  assert.equal(result.observations[0].reported_served_revision, "service-build.123");
  assert.equal(result.observations[0].serving_revision_verified, false);
});
