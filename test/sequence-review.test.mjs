import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import { resolveInstructionalContext } from "../src/instructional-context.mjs";
import { prepareSequenceReview, summarizeSequenceReview, runSequenceReview, learnerReviewContext } from "../src/sequence-review.mjs";
import { prepareTextLesson, summarizeTextLesson, runLessonDraw } from "../src/text-lesson.mjs";
import { lessonAccounting } from "../src/text-lesson-cli.mjs";

const protocol = JSON.parse(fs.readFileSync(new URL("../criteria/corpus-choice-probe.json", import.meta.url)));
// Fictional course declarations and deterministic mock verdicts, never independent academic labels.
function fixture() {
  const views = [1, 2].map(index => ({ prompt: `Explain the fox action ${index}.`, sample_answer: "AUTHOR_SAMPLE_SENTINEL",
    rubric: { criteria: [{ id: `CR${index}`, requirement: "Quote the action and explain it.", accept: ["A source-supported explanation."] }] }, feedback: "Use the source words." }));
  const native = views.map((view, index) => ({ id: `SLOT${index + 1}`, type: "open_check", ...structuredClone(view) }));
  const items = views.map((view, index) => ({ id: `Q${index + 1}`, kind: "open_check", order: index + 1, page: "P1", pointer: `/pages/0/question_slots/${index}`, native: native[index], view,
    alignment: { role: "practice", target_refs: ["K1"], support: "source-visible" }, source_anchors: [] }));
  const course = { core_knowledge: [{ id: "K1", claim: "The fox crosses the river.", performance: "Explain a source-supported action." }], source_assets: [{ id: "S1", text: "The fox crosses the river. ASSET_ONLY_SENTINEL" }],
    instructional_plan: { version: "instructional-plan/0.1", id: "TOY-PLAN", lesson: { purpose: "practice", scope: "static-design", objective: "Explain a source-supported action.", goal_refs: ["K1"] },
      goal_authority: [{ goal_ref: "K1", kind: "course-declared", source_refs: ["S1"], note: "Fictional course declaration for integration tests, not academic approval." }],
      events: [{ id: "E1", order: 1, before_item_id: "Q1", kind: "teaching", status: "declared", content: "The fox crosses the river.", source_refs: ["S1"], target_refs: ["K1"], revealed_target_refs: ["K1"], provenance: "PRODUCER_ONLY_SENTINEL" },
        { id: "E2", order: 2, before_item_id: "END", kind: "teaching", status: "declared", content: "FUTURE_TEACHING_SENTINEL", source_refs: ["S1"], target_refs: ["K1"], revealed_target_refs: [], provenance: "later teaching" }],
      items: items.map(item => ({ item_id: item.id, purpose: "practice", scope: "static-design", measurement_intent: "MEASUREMENT_DESIGN_SENTINEL", goal_refs: ["K1"], prior_event_refs: ["E1"], prepares_for_item_ids: [],
        expected_evidence: [{ id: `EV-${item.id}`, goal_refs: ["K1"], claim: "EXPECTED_EVIDENCE_SENTINEL", source_refs: ["S1"] }],
        support: { mode: "source-visible", event_refs: ["E1"], source_refs: ["S1"], answer_exposure: "allowed" } })),
      sequence: { goal_coverage: [{ goal_ref: "K1", item_ids: ["Q1", "Q2"] }], support_transitions: [{ from_item_id: "Q1", to_item_id: "Q2", reason: "Deliberate repeated practice." }] } } };
  return { request: { course_context: course, sequence_blueprint: items.map(() => ({ role: "practice", support: "source-visible" })) },
    context: { contract: "lesson-context 0.1", source: {}, lesson: { id: "TOY", learning_question: "What does the fox do?", keywords: [] }, native: { pages: [{ id: "P1", nodes: [{ type: "reading", blocks: [{ lines: ["The fox crosses the river. ASSET_ONLY_SENTINEL"] }] },
      { type: "instruction", text: "FUTURE_TEACHING_SENTINEL" }], question_slots: native }] } },
    set: { contract: "question-set 0.1", source: {}, made_by: { kind: "authored" }, lesson: "TOY", items } };
}
function allYesDraw(plan) {
  return { sequence_review: { providers: { side: { checks: plan.sequence_review.questions.map(question => ({ id: question.id, verdict: "yes" })) } } },
    results: plan.cases.map(item => ({ id: item.id, providers: { side: { blind: { checks: item.blind_questions.map(question => ({ id: question.id, verdict: "yes" })) },
      editorial: { checks: item.editorial_questions.map(question => ({ id: question.id, verdict: "yes" })) } } } })) };
}
function returnSequence(pkg, extraRefs = []) {
  const sorted = value => Array.isArray(value) ? value.map(sorted) : value !== null && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
  const payload = { course_context: pkg.request.course_context, student_context: null,
    sequence_blueprint: pkg.request.sequence_blueprint, source_provenance: null };
  const plan = payload.course_context.instructional_plan;
  Object.assign(pkg.context.native, structuredClone(payload));
  pkg.set.sequence_plan = { plan_id: plan.id, context_sha256: crypto.createHash("sha256").update(JSON.stringify(sorted(payload))).digest("hex"),
    lesson: structuredClone(plan.lesson), goal_authority: structuredClone(plan.goal_authority),
    items: plan.items.map((item, index) => ({ item_id: item.item_id, purpose: item.purpose, scope: item.scope,
      measurement_intent: item.measurement_intent, support: structuredClone(item.support),
      context_event_refs: [...new Set([...item.prior_event_refs, ...item.support.event_refs, ...(index === 1 ? extraRefs : [])])],
      expected_evidence: item.expected_evidence.map(evidence => ({ expectation_id: evidence.id, claim: evidence.claim, field_refs: ["/view/prompt"] })) })),
    goal_coverage: structuredClone(plan.sequence.goal_coverage), support_transitions: structuredClone(plan.sequence.support_transitions) };
  pkg.context.native.sequence_plan = structuredClone(pkg.set.sequence_plan);
}
function mockProvider(calls, answer = () => 1) {
  return { name: "gemini-flash", model: "test-alias", async ask(state, questions, { sample }) {
    calls.push({ state: structuredClone(state), ids: questions.map(question => question.id), sample });
    return { model: "gemini-3.8-flash", answers: Object.fromEntries(questions.map(question => [question.id, { noul: answer(question.id, sample, state) }])), usage: { costInUSD: 0.01 } };
  } };
}

test("whole-sequence state changes with declared purpose and measurement intent", () => {
  const pkg = fixture(), before = prepareSequenceReview(resolveInstructionalContext(pkg));
  pkg.request.course_context.instructional_plan.lesson.purpose = "diagnostic";
  pkg.request.course_context.instructional_plan.items[0].measurement_intent = "Probe an untaught response; not a mastery claim.";
  const after = prepareSequenceReview(resolveInstructionalContext(pkg));
  assert.notDeepEqual(after.state, before.state);
  assert.equal(after.state.whole_lesson.purpose.purpose, "diagnostic");
  assert.equal(after.state.items[0].assessment_purpose.measurement_intent, "Probe an untaught response; not a mastery claim.");
  assert.equal(after.qualification, false);
});
test("taught knowledge does not create an automatic leak, but an explicit withheld task disclosure holds review", () => {
  const pkg = fixture(); pkg.request.course_context.instructional_plan.items[0].purpose = "assessment";
  pkg.request.course_context.instructional_plan.items[0].support.answer_exposure = "withheld";
  let packet = prepareSequenceReview(resolveInstructionalContext(pkg));
  assert.equal(packet.holds.some(hold => hold.reason === "declared_withheld_answer_exposure_conflict"), false);
  pkg.request.course_context.instructional_plan.events[0].disclosed_item_ids = ["Q1"];
  packet = prepareSequenceReview(resolveInstructionalContext(pkg));
  assert(packet.holds.some(hold => hold.reason === "declared_withheld_answer_exposure_conflict"));
});
test("explicit event timing governs the blind text preview instead of an unrestricted passive source union", () => {
  const plan = prepareTextLesson(fixture()), blind = plan.cases[0].blind;
  assert(blind.seen_before.includes("The fox crosses the river."));
  for (const hidden of ["ASSET_ONLY_SENTINEL", "FUTURE_TEACHING_SENTINEL", "PRODUCER_ONLY_SENTINEL", "EXPECTED_EVIDENCE_SENTINEL", "MEASUREMENT_DESIGN_SENTINEL", "AUTHOR_SAMPLE_SENTINEL"]) assert.equal(JSON.stringify(blind).includes(hidden), false, hidden);
  assert.equal(plan.sequence_review.state.whole_lesson.sources[0].text.includes("ASSET_ONLY_SENTINEL"), true);
});
test("an asset citation does not expose its entire text in the learner projection", () => {
  const resolved = resolveInstructionalContext(fixture()), learner = learnerReviewContext(resolved.items[0]);
  assert.equal(JSON.stringify(learner).includes("ASSET_ONLY_SENTINEL"), false);
  assert.equal(JSON.stringify(learner).includes("PRODUCER_ONLY_SENTINEL"), false);
  assert.equal(learner.ordered_teaching[0].content, "The fox crosses the river.");
});
test("one sequence defect vetoes otherwise affirmative item observations", () => {
  const plan = prepareTextLesson(fixture()), draw = allYesDraw(plan);
  draw.sequence_review.providers.side.checks[1].verdict = "no";
  const summary = summarizeTextLesson([draw], plan);
  assert.equal(summary.sequence_review.status, "needs_revision"); assert.equal(summary.status, "needs_revision"); assert.equal(summary.qualified, false);
});
test("a returned extra conditional feedback reference holds item and sequence even when all mock verdicts agree", () => {
  const pkg = fixture(), event = pkg.request.course_context.instructional_plan.events[1];
  Object.assign(event, { before_item_id: "Q2", kind: "feedback", status: "conditional", content: "CONDITIONAL_CORRECTION_SENTINEL" });
  returnSequence(pkg, ["E2"]);
  const plan = prepareTextLesson(pkg), second = plan.cases[1];
  assert.equal(plan.returned_sequence.status, "checked_fields_only");
  assert(second.context_holds.includes("conditional_exposure_unresolved"));
  assert.equal(JSON.stringify(second.blind).includes("CONDITIONAL_CORRECTION_SENTINEL"), false);
  assert(plan.sequence_review.holds.some(row => row.item_id === "Q2" && row.reason === "conditional_exposure_unresolved"));
  const summary = summarizeTextLesson([allYesDraw(plan)], plan);
  assert.equal(summary.status, "not_verified"); assert.equal(summary.qualified, false);
});
test("a returned extra declared feedback reference is retained without inventing a conditional hold", () => {
  const pkg = fixture(), event = pkg.request.course_context.instructional_plan.events[1];
  Object.assign(event, { before_item_id: "Q2", kind: "feedback", status: "declared", content: "A planned correction." });
  returnSequence(pkg, ["E2"]);
  const plan = prepareTextLesson(pkg), second = plan.instructional_context.items[1];
  assert.equal(plan.returned_sequence.status, "checked_fields_only");
  assert.deepEqual(second.design_context.returned_context_event_refs, ["E1", "E2"]);
  assert.equal(second.holds.includes("conditional_exposure_unresolved"), false);
  assert(second.learner_context.exposure_status.includes("not authenticated"));
});
test("invalid returned context cannot be rescued by unanimous item and sequence models", () => {
  for (const ref of ["E2", "UNKNOWN"]) {
    const pkg = fixture(); returnSequence(pkg, [ref]);
    const plan = prepareTextLesson(pkg);
    assert.equal(plan.returned_sequence.status, "needs_revision");
    assert(plan.cases.every(item => item.context_holds.includes("returned_sequence_contract_fault")));
    assert.equal(JSON.stringify(plan.cases[1].blind).includes("FUTURE_TEACHING_SENTINEL"), false);
    assert.equal(summarizeTextLesson([allYesDraw(plan)], plan).status, "needs_revision");
  }
});
test("mismatched returned copies hold context without treating either copy as established exposure", () => {
  const pkg = fixture(); returnSequence(pkg);
  pkg.context.native.sequence_plan.items[1].context_event_refs.push("E2");
  const plan = prepareTextLesson(pkg);
  assert.equal(plan.returned_sequence.status, "needs_revision");
  assert(plan.cases.every(item => item.context_holds.includes("returned_sequence_contract_fault")));
  assert.equal(summarizeTextLesson([allYesDraw(plan)], plan).qualified, false);
});
test("missing, empty and duplicate whole-sequence checks cannot produce a green summary", () => {
  const plan = prepareTextLesson(fixture());
  for (const mutate of [checks => checks.splice(0, 1), checks => checks.splice(0), checks => { checks[1] = { ...checks[0] }; }, checks => checks.push({ id: "unexpected", verdict: "yes" })]) {
    const draw = allYesDraw(plan); mutate(draw.sequence_review.providers.side.checks);
    const summary = summarizeSequenceReview([draw], plan.sequence_review);
    assert.equal(summary.status, "not_verified"); assert.equal(summary.models.side.outcomes[0].complete, false);
  }
});
test("an absent sequence draw remains unverified even if another draw is complete", () => {
  const plan = prepareTextLesson(fixture()), good = allYesDraw(plan);
  assert.equal(summarizeSequenceReview([good, { results: good.results }], plan.sequence_review).status, "not_verified");
  assert.equal(summarizeSequenceReview([], plan.sequence_review).status, "not_verified");
});
test("empty or duplicate blind/editorial item checks and missing item draws never pass vacuously", () => {
  const plan = prepareTextLesson(fixture());
  for (const mutate of [draw => { draw.results[0].providers.side.blind.checks = []; }, draw => { draw.results[0].providers.side.editorial.checks = []; },
    draw => { draw.results[0].providers.side.blind.checks[1] = { ...draw.results[0].providers.side.blind.checks[0] }; }]) {
    const draw = allYesDraw(plan); mutate(draw); assert.equal(summarizeTextLesson([draw], plan).status, "not_verified");
  }
  const good = allYesDraw(plan), incomplete = allYesDraw(plan); incomplete.results.shift();
  assert.equal(summarizeTextLesson([good, incomplete], plan).status, "not_verified");
});
test("lesson-level mastery and incomplete explicit plans stay held independently of mock agreement", () => {
  const mastery = fixture(); mastery.request.course_context.instructional_plan.lesson.scope = "mastery-claim";
  const masteryPacket = prepareSequenceReview(resolveInstructionalContext(mastery)); assert(masteryPacket.holds.length > 0);
  const missing = fixture(); missing.request.course_context.instructional_plan.items.pop(); missing.set.items[1].assessment_purpose = "practice";
  const missingResolved = resolveInstructionalContext(missing); assert(missingResolved.items[1].holds.includes("instructional_plan_item_missing"));
});
test("sequence review precedes separate stateless item calls and all costs include its samples", async () => {
  const plan = prepareTextLesson(fixture()), calls = [], progress = [];
  const draw = await runLessonDraw({ cases: plan.cases, sequence_review: plan.sequence_review }, { side: mockProvider(calls), protocol, samples: 2, draw: 1, onResult: row => progress.push(row) });
  assert.equal(calls.length, 10); assert(calls.slice(0, 2).every(call => call.state.whole_lesson));
  assert.equal(progress[0].stage, "sequence");
  const blindCalls = calls.filter(call => Object.hasOwn(call.state, "question"));
  assert.equal(blindCalls.length, 4);
  for (const call of blindCalls) for (const hidden of ["EXPECTED_EVIDENCE_SENTINEL", "MEASUREMENT_DESIGN_SENTINEL", "AUTHOR_SAMPLE_SENTINEL", "FUTURE_TEACHING_SENTINEL"]) assert.equal(JSON.stringify(call.state).includes(hidden), false);
  assert(calls.every(call => !Object.hasOwn(call.state, "providers") && !Object.hasOwn(call.state, "sequence_review")));
  const costs = lessonAccounting([draw]); assert.equal(costs.providers.side.logical_sample_calls, 10); assert.equal(costs.providers.side.reported_cost_samples, 10);
  assert(Math.abs(costs.providers.side.gateway_reported_usd - 0.1) < 1e-12);
  assert.equal(summarizeTextLesson([draw], plan).qualified, false);
});
test("one uncertain sequence sample remains unsure and cannot be rescued by repeated yes answers", async () => {
  const packet = prepareSequenceReview(resolveInstructionalContext(fixture())), calls = [];
  const result = await runSequenceReview(packet, { side: mockProvider(calls, (id, sample) => id === "sequence_preparation" && sample === 1 ? 0.5 : 1), protocol, samples: 3, draw: 1 });
  assert.equal(result.providers.side.checks.find(check => check.id === "sequence_preparation").verdict, "unsure");
  assert.equal(summarizeSequenceReview([{ sequence_review: result }], packet).status, "not_verified");
});

test("missing field observations remain unverified even when every returned model verdict is yes", () => {
  const plan = prepareTextLesson(fixture()), draw = allYesDraw(plan); plan.fields[0].checks = [];
  assert.equal(summarizeTextLesson([draw], plan).status, "not_verified");
});
