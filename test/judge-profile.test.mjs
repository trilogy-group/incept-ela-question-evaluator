import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { getJudgeProfile, selectJudgeQuestions, validateJudgeProfile } from "../src/judge-profile.mjs";
import { judgeQuestions } from "../src/checks.mjs";

const typed = (id) => ({ id, type: "noul", instructions: "Fixture criterion." });
const wrapped = (id) => ({ q: typed(id), required: true, expect: true });
const selected = (kind, ids) => selectJudgeQuestions(getJudgeProfile(), kind, ids.map(typed));
const raw = () => {
  const profile = structuredClone(getJudgeProfile()); delete profile.sha256; return profile;
};

test("default judge profile is frozen, versioned, development-only and separates labelled evidence from coverage", () => {
  const p = getJudgeProfile();
  assert.equal(p.id, "jev-partial-v1"); assert.equal(p.status, "development-only"); assert.equal(p.qualification, false);
  assert.match(p.sha256, /^[a-f0-9]{64}$/); assert.equal(validateJudgeProfile(p).sha256, p.sha256);
  assert.equal(p.source.labelled_development_cases, 16); assert.equal(p.source.stress_controls, 6);
  assert.equal(p.source.full_reference.labelled_for_accuracy, false); assert.equal(p.source.independent_gold_labels, 0);
  assert.deepEqual(p.observed_model_ids, ["jev-1.13.0"]);
  assert.throws(() => { p.selection.operations.open_check.push("^answerable$"); }, TypeError);
  assert.throws(() => { p.source.full_reference.labelled_for_accuracy = true; }, TypeError);
});

test("partial profile selects only anchored criterion families within their own operations", () => {
  const cases = [
    ["classify", ["word_1_fits", "word_12_iago_is_also_fits"], ["word_0_fits", "word_1__also_fits", "word_1_fits_more", "word_1_iago_is_also_fits\n", "option_A_correct"]],
    ["open_check", ["reveal_meets_1", "accepted_12_2_meets"], ["reveal_meets_0", "accepted_1_0_meets", "accepted_1_1_meets_more", "prefix_reveal_meets_1", "reveal_meets_1\n", "misreading_2_passes", "decoy_1_supports"]]
  ];
  for (const [kind, included, excluded] of cases) {
    const result = selected(kind, [...included, ...excluded]);
    assert.deepEqual(result.selected.map((q) => q.id), included, kind);
    assert.deepEqual(result.excluded.map((e) => e.criterion_id), excluded, kind);
    assert.ok(result.excluded.every((e) => e.reason === "criterion_outside_profile"));
  }
});

test("general semantics remain excluded with explicit scope reasons and original wrappers preserved", () => {
  const checks = ["answerable", "answer_in_seen", "feedback_A_true", "feedback_A_points_to_the_text", "feedback_A_gives_answer", "correct_feedback_true", "serves_the_lesson", "prompt_clear"];
  const keep = wrapped("word_1_fits"), omit = checks.map(wrapped), questions = [keep, ...omit];
  const result = selectJudgeQuestions(getJudgeProfile(), "classify", questions);
  assert.equal(result.selected[0], keep);
  assert.ok(result.excluded.every((e, i) => e.question === omit[i] && e.reason === "criterion_outside_profile"));
  assert.equal(questions.length, checks.length + 1);
  for (const kind of ["film_mcq", "reading_mcq", "key_term_mcq", "rebuild_choice", "evidence_select", "open_prompt", "word_web", "say_back", "choice", "future_operation"]) {
    const r = selected(kind, ["key_correct", "candidate_1_supports", "word_1_fits", "reveal_meets_1", "answerable"]);
    assert.equal(r.selected.length, 0); assert.ok(r.excluded.every((e) => e.reason === "operation_outside_profile"));
  }
});

test("explicit full experimental route retains supplied checks only for known operations and stays unqualified", () => {
  const profile = getJudgeProfile("jev-full-experimental"), questions = [wrapped("key_correct"), wrapped("answer_in_seen"), wrapped("serves_the_lesson")];
  const r = selectJudgeQuestions(profile, "reading_mcq", questions);
  assert.deepEqual(r.selected, questions); assert.equal(r.excluded.length, 0); assert.equal(profile.qualification, false);
  assert.notEqual(profile.sha256, getJudgeProfile().sha256);
  assert.equal(selectJudgeQuestions(profile, "future_operation", questions).selected.length, 0);
});

test("malformed or broadened v1 profiles fail closed instead of silently expanding coverage", () => {
  const mutate = [
    (p) => { p.qualification = true; }, (p) => { p.status = "qualified"; },
    (p) => { p.selection.operations.open_check = [".*"]; },
    (p) => { p.selection.operations.open_check = ["^.*$"]; },
    (p) => { p.selection.operations.open_check.push("^answerable$"); },
    (p) => { p.selection.operations.say_back = ["^key_correct$"]; },
    (p) => { p.selection.operations.classify = p.selection.operations.open_check; },
    (p) => { p.observed_models_scope = "immutable revision"; },
    (p) => { p.source.full_reference.labelled_for_accuracy = true; },
    (p) => { p.sha256 = "0".repeat(64); }
  ];
  for (const change of mutate) { const p = raw(); change(p); assert.throws(() => validateJudgeProfile(p), /invalid judge profile/); }
  assert.throws(() => getJudgeProfile("automatic"), /unknown judge profile/);
  assert.throws(() => selectJudgeQuestions(getJudgeProfile(), "reading_mcq", [typed("key_correct"), typed("key_correct")]), /duplicated/);
});

test("reference judge questions are partitioned without dropping or changing criterion definitions", () => {
  const set = JSON.parse(fs.readFileSync(new URL("../fixtures/reference/question-set.json", import.meta.url)));
  let total = 0, included = 0, omitted = 0;
  for (const item of set.items) {
    const questions = judgeQuestions(item), before = JSON.stringify(questions);
    const { selected, excluded } = selectJudgeQuestions(getJudgeProfile(), item.kind, questions);
    assert.equal(selected.length + excluded.length, questions.length);
    assert.equal(JSON.stringify(questions), before);
    total += questions.length; included += selected.length; omitted += excluded.length;
  }
  assert.equal(total, 543); assert.ok(included > 0); assert.ok(omitted > 0);
});
