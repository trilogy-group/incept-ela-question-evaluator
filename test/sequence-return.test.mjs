import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { inspectSequenceReturn } from "../src/sequence-return.mjs";

// Generic finished public declarations; matching them does not supply academic judgments.
const sorted = value => Array.isArray(value) ? value.map(sorted) : value !== null && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
const digest = value => crypto.createHash("sha256").update(JSON.stringify(sorted(value)), "utf8").digest("hex");
function fixture() {
  const support = { mode: "source-visible", event_refs: ["E1"], source_refs: ["S1"], answer_exposure: "allowed" };
  const declared = { version: "instructional-plan/0.1", id: "TOY-PLAN", lesson: { purpose: "practice", scope: "static-design", objective: "Explain a source action.", goal_refs: ["K1"] },
    goal_authority: [{ goal_ref: "K1", kind: "packet-proposed", source_refs: ["S1"], note: "Fictional declaration." }],
    events: [{ id: "E1", order: 1, before_item_id: "Q1", kind: "teaching", status: "declared", content: "The fox crosses.", source_refs: ["S1"], target_refs: ["K1"], revealed_target_refs: ["K1"], provenance: "toy teaching" },
      { id: "E2", order: 2, before_item_id: "Q2", kind: "teaching", status: "declared", content: "Explain a second line.", source_refs: ["S1"], target_refs: ["K1"], revealed_target_refs: [], provenance: "toy later teaching" }],
    items: [1, 2].map(order => ({ item_id: `Q${order}`, purpose: "practice", scope: "static-design", measurement_intent: "Source-supported explanation.", goal_refs: ["K1"], prior_event_refs: ["E1"], prepares_for_item_ids: [],
      expected_evidence: [{ id: `EV${order}`, goal_refs: ["K1"], claim: "Quotes and explains the action.", source_refs: ["S1"] }], support: structuredClone(support) })),
    sequence: { goal_coverage: [{ goal_ref: "K1", item_ids: ["Q1", "Q2"] }], support_transitions: [{ from_item_id: "Q1", to_item_id: "Q2", reason: "Repeated practice." }] } };
  const request = { course_context: { instructional_plan: declared, core_knowledge: [{ id: "K1" }], source_assets: [{ id: "S1", text: "The fox crosses." }] },
    student_context: { language: "English" }, sequence_blueprint: [{ id: "Q1" }, { id: "Q2" }], source_provenance: { revision: "toy-v1" } };
  const returned = { plan_id: declared.id, context_sha256: digest(request), lesson: structuredClone(declared.lesson), goal_authority: structuredClone(declared.goal_authority),
    items: declared.items.map(item => ({ item_id: item.item_id, purpose: item.purpose, scope: item.scope, measurement_intent: item.measurement_intent, support: structuredClone(item.support), context_event_refs: ["E1"],
      expected_evidence: item.expected_evidence.map(evidence => ({ expectation_id: evidence.id, claim: evidence.claim, field_refs: ["/view/prompt", "/view/rubric/criteria/0/requirement"] })) })),
    goal_coverage: structuredClone(declared.sequence.goal_coverage), support_transitions: structuredClone(declared.sequence.support_transitions) };
  return { request, context: { native: { ...structuredClone(request), sequence_plan: structuredClone(returned) } },
    set: { items: [1, 2].map(order => ({ id: `Q${order}`, order, view: { prompt: "Explain the source action.", rubric: { criteria: [{ requirement: "Quote and explain." }] } } })), sequence_plan: returned } };
}
function copiedChange(pkg, change) { change(pkg.set.sequence_plan); pkg.context.native.sequence_plan = structuredClone(pkg.set.sequence_plan); }
const check = (report, id) => report.checks.find(row => row.id === id)?.verdict;

test("both returned plans may be absent in a legacy packet, while one-sided or malformed plans fail", () => {
  const legacy = fixture(); delete legacy.set.sequence_plan; delete legacy.context.native.sequence_plan;
  assert.equal(inspectSequenceReturn(legacy).status, "absent");
  const one = fixture(); delete one.context.native.sequence_plan; assert.equal(inspectSequenceReturn(one).status, "needs_revision");
  const malformed = fixture(); malformed.set.sequence_plan = null; malformed.context.native.sequence_plan = null;
  assert.equal(inspectSequenceReturn(malformed).status, "needs_revision");
});
test("matching copies, context hash, declarations and existing field refs yield fields-only status", () => {
  const report = inspectSequenceReturn(fixture()); assert.equal(report.status, "checked_fields_only");
  assert.equal(report.checks.length, 4); assert(report.checks.every(row => row.verdict === "pass")); assert.equal(report.qualification, false);
  assert.match(report.meaning, /semantic sufficiency.*unqualified/);
});
test("canonical context hashing ignores object key order while retaining array order and Unicode", () => {
  const pkg = fixture(); pkg.request.student_context = { language: "English", note: "façade — 考え" };
  pkg.context.native.student_context = { note: "façade — 考え", language: "English" };
  copiedChange(pkg, returned => { returned.context_sha256 = digest(pkg.request); });
  assert.equal(inspectSequenceReturn(pkg).status, "checked_fields_only");
  pkg.context.native.sequence_blueprint.reverse(); assert.equal(check(inspectSequenceReturn(pkg), "sequence_return_plan_matches"), "fail");
});
test("a retained native context cannot differ behind a valid request hash", () => {
  const pkg = fixture(); pkg.context.native.course_context.source_assets[0].text = "Different source.";
  const report = inspectSequenceReturn(pkg); assert.equal(check(report, "sequence_return_plan_matches"), "fail");
  assert(report.checks.find(row => row.id === "sequence_return_plan_matches").evidence.issues.includes("retained_native_context_differs"));
});
test("native-only and partial reconstructed requests use retained public context fields", () => {
  const pkg = fixture(); pkg.request = { course_context: pkg.context.native.course_context };
  assert.equal(inspectSequenceReturn(pkg).status, "checked_fields_only"); delete pkg.request.course_context;
  assert.equal(inspectSequenceReturn(pkg).status, "checked_fields_only");
});
test("returned plan IDs, item conditions, order and expected-evidence claims must match the declaration", () => {
  for (const mutate of [returned => { returned.plan_id = "OTHER"; }, returned => { returned.items.reverse(); }, returned => { returned.items[0].purpose = "assessment"; },
    returned => { returned.items[0].measurement_intent = "Different measurement."; }, returned => { returned.items[0].support.answer_exposure = "withheld"; },
    returned => { returned.items[0].expected_evidence[0].expectation_id = "MISSING"; }, returned => { returned.items[0].expected_evidence[0].claim = "Different claim."; }]) {
    const pkg = fixture(); copiedChange(pkg, mutate); assert.equal(check(inspectSequenceReturn(pkg), "sequence_return_plan_matches"), "fail");
  }
});
test("source-declared lesson, authority, coverage and transition rows cannot be silently rewritten", () => {
  const lesson = fixture(); copiedChange(lesson, returned => { returned.lesson.objective = "Different objective."; }); assert.equal(check(inspectSequenceReturn(lesson), "sequence_return_plan_matches"), "fail");
  const authority = fixture(); copiedChange(authority, returned => { returned.goal_authority[0].kind = "course-declared"; }); assert.equal(check(inspectSequenceReturn(authority), "sequence_return_plan_matches"), "fail");
  for (const mutate of [returned => { returned.goal_coverage[0].item_ids.pop(); }, returned => { returned.support_transitions[0].reason = "New rationale."; }]) {
    const pkg = fixture(); copiedChange(pkg, mutate); assert.equal(check(inspectSequenceReturn(pkg), "sequence_return_coverage_matches"), "fail");
  }
});
test("unknown, future, duplicate or omitted required context event references fail", () => {
  for (const refs of [["UNKNOWN"], ["E1", "E2"], ["E1", "E1"], []]) {
    const pkg = fixture(); copiedChange(pkg, returned => { returned.items[0].context_event_refs = refs; });
    assert.equal(check(inspectSequenceReturn(pkg), "sequence_return_plan_matches"), "fail");
  }
  const prior = fixture(); copiedChange(prior, returned => { returned.items[1].context_event_refs = ["E1", "E2"]; });
  assert.equal(inspectSequenceReturn(prior).status, "checked_fields_only");
});
test("missing, non-view, malformed and duplicate evidence field pointers fail independently", () => {
  for (const refs of [["/view/missing"], ["/id"], ["/view/~bad"], ["/view/prompt", "/view/prompt"], []]) {
    const pkg = fixture(); copiedChange(pkg, returned => { returned.items[0].expected_evidence[0].field_refs = refs; });
    assert.equal(check(inspectSequenceReturn(pkg), "sequence_return_evidence_fields_resolve"), "fail");
  }
});
test("returned teacher-only extras are not copied into the sequence design projection", () => {
  const pkg = fixture(); copiedChange(pkg, returned => { returned.metadata = { producer: "HIDDEN_WRITER" }; returned.items[0].key = [0]; returned.items[0].expected_evidence[0].mapping = { secret: "answer" }; });
  const projected = inspectSequenceReturn(pkg).declared_sequence_plan;
  assert.equal(JSON.stringify(projected).includes("HIDDEN_WRITER"), false); assert.equal(Object.hasOwn(projected.items[0], "key"), false); assert.equal(Object.hasOwn(projected.items[0].expected_evidence[0], "mapping"), false);
});
test("inspection does not mutate finished public packets and cannot approve semantic evidence sufficiency", () => {
  const pkg = fixture(), before = structuredClone(pkg), report = inspectSequenceReturn(pkg);
  assert.deepEqual(pkg, before); assert.equal(report.qualification, false);
  assert.match(report.checks.find(row => row.id === "sequence_return_evidence_fields_resolve").evidence.meaning, /does not show/);
});
