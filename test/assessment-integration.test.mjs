import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { loadLessonPackage, digest } from "../src/lesson-package.mjs";
import { prepareTextLesson, summarizeTextLesson, textLessonReviewPacket } from "../src/text-lesson.mjs";
import { summarizeSequenceReview } from "../src/sequence-review.mjs";
import { assessmentPolicyHash } from "../src/assessment-trace.mjs";
import { prepareNativeIntake, verifyNativePreparation } from "../src/native-intake.mjs";

// Synthetic packets and forced-positive observations test integration only.
// They are not independent gold, semantic judgments or recommendations for thresholds.
const sourceText = "The fox crossed. The hare waited. A first token was marked. A second token was marked.";
function fixture() {
  const views = [
    { stem: "Choose the two animal actions stated in the passage.", options: ["The fox crossed.", "The hare waited.", "The owl flew."],
      response_rule: "select-n", selection_count: 2, key: [1, 0] },
    { stem: "Was the first token marked?", options: ["Marked", "Unmarked"], key: [0] },
    { stem: "Was the second token marked?", options: ["Unmarked", "Marked"], key: [1] }
  ].map(view => ({ ...view, option_feedback: view.options.map(() => "AUTHOR_FEEDBACK_SENTINEL"), correct_feedback: "AUTHOR_CORRECT_SENTINEL" }));
  const items = views.map((view, index) => ({ id: ["Q", "B1", "B2"][index], order: index + 1, kind: "reading_mcq", page: "READ",
    pointer: `/pages/0/question_slots/${index}`, native: { id: `N${index}`, type: "reading_mcq", ...structuredClone(view) }, view,
    alignment: { phase_ref: "READ", role: "question", support: "source-visible", target_refs: ["K"], source_refs: ["S"], content_key_refs: ["CK"], pair_refs: ["PAIR"], depends_on: [] },
    source_anchors: [{ source_ref: "S", quote: "The fox crossed.", field_ref: "/view/stem", relation: "limits" }] }));
  const policy = { version: "assessment-policy/0.1", id: "SYNTHETIC-ASSESSMENT", provenance: { status: "course-declared", source_ref: "POLICY_SOURCE_SENTINEL", revision: "synthetic-v1" },
    parameters: [{ id: "streak", value: 2, status: "confirmed", source_ref: "STREAK_DECISION_SENTINEL" }, { id: "bank", value: 2, status: "confirmed", source_ref: "BANK_DECISION_SENTINEL" }],
    item_rules: [{ item_id: "Q", moment: "checkpoint-test", feedback: { timing: "after-submit", required: true, elaboration: "explanation" }, score_basis: "first-submission",
      support: { frame_policy: "none", allowed_tool_refs: [] }, gap_refs: ["G"], misconception_routes: [{ option_ref: "/view/options/2", tag: "MISCONCEPTION_SENTINEL", gap_ref: "G", teach_event_ref: "TEACH" }] }],
    gaps: [{ id: "G", target_refs: ["K"], category: "Ideas", prerequisite_refs: [], bank_item_ids: ["B1", "B2"],
      teach_card: { form: "single-feature", rule: "POLICY_RULE_SENTINEL", positive: "POLICY_POSITIVE_SENTINEL", negative: "POLICY_NEGATIVE_SENTINEL", difference: "POLICY_DIFFERENCE_SENTINEL" } }],
    remediation: { streak_parameter_ref: "streak", bank_limit_parameter_ref: "bank", initial_order: "retest-before-teach", wrong_resets_streak: true, terminal_states: ["closed", "flagged"], fresh_items_required: true },
    scoring: [{ id: "SELECT", kind: "select-n", item_ids: ["Q"], selection_count: 2, points: { "0": 0, "1": 1, "2": 2 } }] };
  const plan = { version: "instructional-plan/0.1", id: "PLAN", lesson: { purpose: "assessment", scope: "static-design", objective: "Identify stated actions.", goal_refs: ["K"] },
    goal_authority: [{ goal_ref: "K", kind: "course-declared", source_refs: ["S"], note: "Synthetic declared target; not independently approved." }],
    events: [{ id: "TEXT", order: 1, before_item_id: "Q", kind: "teaching", status: "declared", content: sourceText, source_refs: ["S"], target_refs: ["K"], revealed_target_refs: [], provenance: "synthetic text" },
      { id: "TEACH", order: 2, before_item_id: "END", kind: "teaching", status: "declared", content: "FUTURE_TEACHING_SENTINEL", source_refs: ["S"], target_refs: ["K"], revealed_target_refs: ["K"], provenance: "synthetic correction" }],
    items: items.map(item => ({ item_id: item.id, purpose: item.id === "Q" ? "assessment" : "practice", scope: "static-design", goal_refs: ["K"], prior_event_refs: ["TEXT"], prepares_for_item_ids: [],
      expected_evidence: [{ id: `EV-${item.id}`, goal_refs: ["K"], claim: "EXPECTED_EVIDENCE_SENTINEL", source_refs: ["S"] }], support: { mode: "source-visible", event_refs: ["TEXT"], source_refs: ["S"], answer_exposure: "withheld" } })),
    sequence: { goal_coverage: [{ goal_ref: "K", item_ids: items.map(item => item.id) }], support_transitions: [] } };
  const course = { core_knowledge: [{ id: "K", claim: "Identify stated actions.", performance: "Select the actions stated in the text." }], source_assets: [{ id: "S", kind: "text", text: sourceText }],
    content_keys: [{ id: "CK", target_refs: ["K"], source_refs: ["S"], phase_refs: ["READ"] }], pairing_tables: [{ id: "T", pairs: [{ id: "PAIR", target_ref: "K", source_ref: "S", content_key_ref: "CK", phase_ref: "READ" }] }],
    lesson_plan: { phases: [{ id: "READ", role: "question", support: "source-visible", target_refs: ["K"], source_refs: ["S"], after: [] }] }, instructional_plan: plan, assessment_policy: policy };
  return { request: { course_context: course, sequence_blueprint: items.map(item => ({ role: "question", support: "source-visible", formats: ["reading_mcq"], alignment: structuredClone(item.alignment) })) },
    source: { assets: structuredClone(course.source_assets) }, context: { contract: "lesson-context 0.1", source: {}, lesson: { id: "SYNTHETIC", title: "Synthetic assessment", learning_question: "What happened?", keywords: [] },
      native: { pages: [{ id: "READ", nodes: [{ type: "reading", blocks: [{ lines: [sourceText] }] }], question_slots: items.map(item => item.native) }] } },
    set: { contract: "question-set 0.1", source: {}, made_by: { kind: "authored" }, lesson: "SYNTHETIC", items } };
}
function positiveDraw(plan) {
  return { sequence_review: { providers: { side: { checks: plan.sequence_review.questions.map(q => ({ id: q.id, verdict: "yes" })) } } },
    results: plan.cases.map(row => { const key = plan.expectations.find(item => item.id === row.id).key;
      return { id: row.id, providers: { side: { blind: { checks: row.blind_questions.map(q => ({ id: q.id,
        verdict: q.id.startsWith("option_") && !key.includes(q.id.slice(7).charCodeAt(0) - 65) ? "no" : "yes" })) },
      editorial: { checks: row.editorial_questions.map(q => ({ id: q.id, verdict: "yes" })) } } } }; }) };
}
function temporary(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "assessment-integration-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function writePackage(root, pkg) {
  fs.mkdirSync(root, { recursive: true });
  for (const [name, value] of [["course-request.json", pkg.request], ["course-source-packet.json", pkg.source], ["lesson-context.json", pkg.context], ["question-set.json", pkg.set]])
    fs.writeFileSync(path.join(root, name), JSON.stringify(value) + "\n");
}
function bindTrace(root, pkg, events = [{ type: "answer", item_id: "Q", selected: [0, 1] }, { type: "submit" }, { type: "feedback", item_id: "Q", content: "The passage states that the fox crossed and the hare waited." }, { type: "score", points: 2 }, { type: "close" }]) {
  const value = { version: "assessment-trace/0.1", session_id: "synthetic-session", policy_sha256: assessmentPolicyHash(pkg.request.course_context.assessment_policy),
    context_sha256: digest(fs.readFileSync(path.join(root, "lesson-context.json"))), set_sha256: digest(fs.readFileSync(path.join(root, "question-set.json"))),
    events: events.map((event, index) => ({ id: `E${index}`, order: index + 1, ...event })) };
  fs.writeFileSync(path.join(root, "runtime-evidence.json"), JSON.stringify(value) + "\n"); return value;
}

test("text preparation keeps scoped policy and author material out of every blind packet", () => {
  const plan = prepareTextLesson(fixture()), blind = JSON.stringify(textLessonReviewPacket(plan));
  for (const hidden of ["POLICY_SOURCE_SENTINEL", "STREAK_DECISION_SENTINEL", "MISCONCEPTION_SENTINEL", "POLICY_RULE_SENTINEL", "POLICY_POSITIVE_SENTINEL", "POLICY_NEGATIVE_SENTINEL", "AUTHOR_FEEDBACK_SENTINEL", "AUTHOR_CORRECT_SENTINEL", "EXPECTED_EVIDENCE_SENTINEL", "FUTURE_TEACHING_SENTINEL"])
    assert.equal(blind.includes(hidden), false, hidden);
  assert.equal(plan.cases[0].editorial.instructional_design.assessment_policy.moment, "checkpoint-test");
  assert.equal(plan.sequence_review.state.whole_lesson.assessment_policy.policy.provenance.source_ref, "POLICY_SOURCE_SENTINEL");
  assert(plan.sequence_review.questions.some(q => q.id.startsWith("assessment_policy_")));
  assert.equal(plan.cases[1].blind.learner_context.prior_tasks[0].task.response_rule, "select-n");
  assert.equal(plan.cases[1].blind.learner_context.prior_tasks[0].task.selection_count, 2);
});
test("positive mock observations preserve select-n semantics without qualifying the evaluator", () => {
  const plan = prepareTextLesson(fixture()), summary = summarizeTextLesson([positiveDraw(plan)], plan);
  assert.equal(plan.response_profile.choice, "single-best and explicit select-n");
  assert.equal(summary.status, "checks_passed_unqualified");
  assert.deepEqual(summary.items[0].models.side.outcomes[0].selected, [0, 1]);
  assert.equal(summary.items[0].models.side.outcomes[0].author_key_agreement, true);
  const selectAnnotations = plan.criterion_sources.annotations.filter(row => row.stage === "blind" && row.criterion_id.startsWith("option_")
    && row.applicability.reason === "single_best_source_scope_not_established_for_select_n");
  assert.equal(selectAnnotations.length, 3);
  assert(selectAnnotations.every(row => row.applicability.state === "undetermined" && row.academic_qualification === false));
  assert(selectAnnotations.some(row => row.source_records.some(source => source.id === "one-answer-the-text-settles")));
  assert.equal(summary.independent_gold_labels, 0); assert.equal(summary.qualified, false);
});
test("policy contradictions cannot be rescued by positive sequence and editorial observations", () => {
  const pkg = fixture(); pkg.request.course_context.assessment_policy.item_rules[0].feedback.timing = "immediate";
  const plan = prepareTextLesson(pkg), draw = positiveDraw(plan), summary = summarizeTextLesson([draw], plan);
  assert(plan.sequence_review.field_checks.some(q => q.id.endsWith("feedback_timing") && q.verdict === "fail"));
  assert.equal(summary.sequence_review.status, "needs_revision"); assert.equal(summary.status, "needs_revision");
  assert.equal(summary.qualified, false);
});
test("proposed consumed settings stay held despite otherwise positive observations", () => {
  for (const mutate of [policy => { policy.parameters[0].status = "proposed"; }, policy => { policy.parameters[0].status = "unknown"; policy.parameters[0].value = null; }, policy => { policy.provenance.status = "proposed"; }]) {
    const pkg = fixture(); mutate(pkg.request.course_context.assessment_policy);
    const plan = prepareTextLesson(pkg), summary = summarizeTextLesson([positiveDraw(plan)], plan);
    assert(plan.sequence_review.holds.length > 0); assert.equal(summary.status, "not_verified"); assert.equal(summary.qualified, false);
  }
});
test("file-loaded optional runtime evidence binds exact context, set and policy pins", t => {
  const root = temporary(t), pkg = fixture(); writePackage(root, pkg);
  const before = loadLessonPackage(root); assert.equal(before.runtimeEvidence, null);
  assert.equal(prepareTextLesson(before).assessment_trace.supplied, false);
  const original = bindTrace(root, pkg), loaded = loadLessonPackage(root), plan = prepareTextLesson(loaded);
  assert.equal(loaded.hashes["runtime-evidence.json"], digest(fs.readFileSync(path.join(root, "runtime-evidence.json"))));
  assert.equal(plan.assessment_trace.supplied, true); assert.equal(plan.assessment_trace.status, "checks_passed_unqualified");
  assert.equal(plan.assessment_trace.runtime_authenticated, false); assert.equal(plan.assessment_trace.marks_independently_validated, false);
  for (const field of ["context_sha256", "set_sha256", "policy_sha256"]) {
    fs.writeFileSync(path.join(root, "runtime-evidence.json"), JSON.stringify({ ...original, [field]: "0".repeat(64) }));
    const invalid = prepareTextLesson(loadLessonPackage(root));
    assert.equal(invalid.assessment_trace.status, "needs_revision");
    assert.equal(summarizeTextLesson([positiveDraw(invalid)], invalid).status, "needs_revision");
  }
});

function asNative(pkg) {
  const source = { sha256: "a".repeat(64), commit: "b".repeat(40) };
  const items = pkg.set.items.map(item => {
    const view = structuredClone(item.view); view.prompt = view.stem; delete view.stem;
    const family = view.response_rule === "select-n" ? "multiple_select" : "single_choice";
    const alignment = structuredClone(item.alignment);
    const native = { id: item.id, kind: item.kind, family, view, source_bindings: [], source_context: { id: item.id, native_kind: item.kind, family, page_ref: "READ", ...alignment } };
    return { id: item.id, kind: item.kind, family, view, native, order: item.order, page: item.page, pointer: item.pointer, alignment, source_bindings: [] };
  });
  const context = structuredClone(pkg.context); context.adapter_extension = "native-activity-transport/0.2"; context.source = { lesson_source: source };
  context.native.course_context = structuredClone(pkg.request.course_context); context.native.pages[0].question_slots = items.map(item => item.native);
  context.native.course_context.pairing_map = [{ id: "PAIR", knowledge_refs: ["K"] }];
  return { ...pkg, context, set: { contract: "question-set native 0.2", adapter_extension: context.adapter_extension, lesson: context.lesson.id, source: { lesson_source: source }, items } };
}
test("native preparation separates policy from blind tasks and verifies assessment-artifact integrity", t => {
  const root = temporary(t), input = path.join(root, "input"), output = path.join(root, "review"), pkg = asNative(fixture()); writePackage(input, pkg); bindTrace(input, pkg);
  const receipt = prepareNativeIntake(input, output), verified = verifyNativePreparation(output, receipt);
  const blind = verified.artifacts["review-packet.json"], assessment = verified.artifacts["assessment-review.json"];
  assert.equal(blind.items[0].learner_view.selection_count, 2);
  for (const hidden of ["POLICY_RULE_SENTINEL", "POLICY_SOURCE_SENTINEL", "MISCONCEPTION_SENTINEL", "AUTHOR_FEEDBACK_SENTINEL"]) assert.equal(JSON.stringify(blind).includes(hidden), false);
  assert.equal(assessment.policy.policy.id, "SYNTHETIC-ASSESSMENT"); assert.equal(assessment.runtime.supplied, true);
  assert.equal(assessment.runtime.status, "checks_passed_unqualified");
  assert.equal(receipt.files["runtime-evidence.json"], digest(fs.readFileSync(path.join(input, "runtime-evidence.json"))));
  assert.equal(receipt.model_calls, 0); assert.equal(receipt.qualified, false);
  fs.writeFileSync(path.join(output, "assessment-review.json"), JSON.stringify({ policy: null, runtime: { status: "checks_passed_unqualified" } }));
  assert.throws(() => verifyNativePreparation(output, receipt), /prepared artifact hash differs/);
});
test("native policy contradictions remain revision outcomes despite positive sequence observations", t => {
  const root = temporary(t), pkg = asNative(fixture()); pkg.context.native.course_context.assessment_policy.item_rules[0].feedback.timing = "immediate";
  const input = path.join(root, "input"), output = path.join(root, "review"); writePackage(input, pkg);
  const receipt = prepareNativeIntake(input, output), packet = verifyNativePreparation(output, receipt).artifacts["sequence-review-packet.json"];
  const draws = [{ sequence_review: { providers: { side: { checks: packet.questions.map(q => ({ id: q.id, verdict: "yes" })) } } } }];
  assert(receipt.code_failures > 0); assert.equal(summarizeSequenceReview(draws, packet).status, "needs_revision");
});
test("a native runtime binding fault reaches saved receipts and cannot be overridden by a positive review", t => {
  const root = temporary(t), pkg = asNative(fixture()), input = path.join(root, "input"), output = path.join(root, "review"); writePackage(input, pkg);
  const trace = bindTrace(input, pkg); trace.set_sha256 = "0".repeat(64);
  fs.writeFileSync(path.join(input, "runtime-evidence.json"), JSON.stringify(trace));
  const receipt = prepareNativeIntake(input, output), artifacts = verifyNativePreparation(output, receipt).artifacts, packet = artifacts["sequence-review-packet.json"];
  assert.equal(artifacts["assessment-review.json"].runtime.status, "needs_revision");
  assert(receipt.code_failures > 0);
  const draws = [{ sequence_review: { providers: { side: { checks: packet.questions.map(q => ({ id: q.id, verdict: "yes" })) } } } }];
  assert.equal(summarizeSequenceReview(draws, packet).status, "needs_revision");
});
test("the existing text CLI writes pinned assessment evidence offline without a network call", t => {
  const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), root = temporary(t);
  for (const directory of ["src", "criteria", "contracts", "bin"]) fs.cpSync(path.join(repository, directory), path.join(root, directory), { recursive: true });
  fs.mkdirSync(path.join(root, "fixtures"));
  for (const file of ["fixtures/knowledge-baseline.json", "fixtures/criterion-source-records.json", "config.lesson.json"]) fs.copyFileSync(path.join(repository, file), path.join(root, file));
  const input = path.join(root, ".local", "finished"), pkg = fixture(); writePackage(input, pkg); bindTrace(input, pkg);
  const attempted = path.join(root, "network-attempt"), guard = path.join(root, "network-guard.mjs");
  fs.writeFileSync(guard, `import fs from "node:fs"; globalThis.fetch = () => { fs.writeFileSync(${JSON.stringify(attempted)}, "attempted"); throw new Error("NETWORK_FORBIDDEN"); };`);
  const child = spawnSync(process.execPath, ["--import", guard, "--", path.join(root, "bin/evaluate.mjs"), "--lesson-package", input, "--config", "config.lesson.json", "--out", ".local/review"],
    { cwd: root, env: {}, encoding: "utf8", timeout: 30000 });
  assert.equal(child.status, 0, child.stderr);
  const output = path.join(root, ".local", "review"), read = file => JSON.parse(fs.readFileSync(path.join(output, file)));
  const manifest = read("manifest.json"), assessment = read("assessment-review.json"), report = read("report.json");
  assert.equal(manifest.assessment_review_sha256, digest(fs.readFileSync(path.join(output, "assessment-review.json"))));
  assert.equal(manifest.lesson_input_hashes["runtime-evidence.json"], digest(fs.readFileSync(path.join(input, "runtime-evidence.json"))));
  assert.deepEqual(fs.readFileSync(path.join(output, "runtime-evidence.json")), fs.readFileSync(path.join(input, "runtime-evidence.json")));
  assert.equal(assessment.runtime.status, "checks_passed_unqualified");
  assert.equal(report.model_calls, 0); assert.equal(report.qualified, false); assert.equal(fs.existsSync(attempted), false);
});
