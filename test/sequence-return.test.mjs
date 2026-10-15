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
  return { request, context: { contract: "lesson-context 0.1", native: { ...structuredClone(request), sequence_plan: structuredClone(returned) } },
    set: { contract: "question-set 0.1", items: [1, 2].map(order => ({ id: `Q${order}`, order, kind: "open_check",
      view: { prompt: "Explain the source action.", sample_answer: "The fox crosses.", rubric: { criteria: [{ requirement: "Quote and explain." }] } } })), sequence_plan: returned } };
}
function copiedChange(pkg, change) { change(pkg.set.sequence_plan); pkg.context.native.sequence_plan = structuredClone(pkg.set.sequence_plan); }
const check = (report, id) => report.checks.find(row => row.id === id)?.verdict;
const fieldsCheck = pkg => inspectSequenceReturn(pkg).checks.find(row => row.id === "sequence_return_evidence_fields_resolve");
function withFields(refs, item = {}) {
  const pkg = fixture(); Object.assign(pkg.set.items[0], item);
  copiedChange(pkg, returned => { returned.items[0].expected_evidence[0].field_refs = refs; });
  return pkg;
}
function nativeFields(refs, family, view) {
  const pkg = withFields(refs);
  pkg.set.contract = "question-set native 0.2";
  pkg.set.adapter_extension = pkg.context.adapter_extension = "native-activity-transport/0.2";
  pkg.set.items.forEach(item => { item.family = "written_response"; });
  Object.assign(pkg.set.items[0], { family, view });
  return pkg;
}

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
test("existing author answers, feedback and unknown fields cannot bind expected learner evidence", () => {
  const view = { prompt: "Explain the source action.", key: [0], mapping: { E1: "C1" }, sample_answer: "The fox crosses.",
    feedback: "The fox crosses.", correct_feedback: "The fox crosses.", option_feedback: ["The fox crosses."], entry_feedback: { E1: "The fox crosses." },
    arbitrary: "The fox crosses.", rubric: { criteria: [{ requirement: "Quote and explain.", accept: ["The fox crosses."], evidence: ["The fox crosses."],
      keywords: ["crosses"], nudge: "Read the action.", second_nudge: "Find crosses." }], reveal: "The fox crosses.", misreadings: [{ reply: "Read again." }] } };
  for (const ref of ["/view/key", "/view/key/0", "/view/mapping/E1", "/view/sample_answer", "/view/feedback", "/view/correct_feedback",
    "/view/option_feedback/0", "/view/entry_feedback/E1", "/view/arbitrary", "/view/rubric/criteria/0/accept/0", "/view/rubric/criteria/0/evidence/0",
    "/view/rubric/criteria/0/keywords/0", "/view/rubric/criteria/0/nudge", "/view/rubric/criteria/0/second_nudge", "/view/rubric/reveal", "/view/rubric/misreadings/0/reply"]) {
    const result = fieldsCheck(withFields([ref], { view }));
    assert.equal(result.verdict, "fail", ref); assert.equal(result.evidence.issues[0].code, "field_is_not_response_contract", ref);
  }
  const mixed = fieldsCheck(withFields(["/view/prompt", "/view/rubric/criteria/0/requirement", "/view/sample_answer"], { view }));
  assert.equal(mixed.verdict, "fail"); assert.equal(mixed.evidence.checked_field_references, 5);
  assert.deepEqual(mixed.evidence.issues.map(row => row.field_ref), ["/view/sample_answer"]);
});
test("mixed containers, encoded lookalike paths and non-string leaves cannot borrow a requirement role", () => {
  const view = { prompt: "Explain.", "prompt/key": "Author answer.", "prompt~key": "Author answer.",
    rubric: { criteria: [{ requirement: "Explain the action.", sample_answer: "The fox crosses." }] } };
  view["rubric/criteria/0/requirement"] = "Author answer.";
  for (const ref of ["/view", "/view/rubric", "/view/rubric/criteria", "/view/rubric/criteria/0", "/view/prompt~1key", "/view/prompt~0key", "/view/rubric~1criteria~10~1requirement"]) {
    assert.equal(fieldsCheck(withFields([ref], { view })).verdict, "fail", ref);
  }
  for (const value of [null, 1, true, {}, ["Explain."]]) {
    assert.equal(fieldsCheck(withFields(["/view/prompt"], { view: { prompt: value } })).verdict, "fail");
    assert.equal(fieldsCheck(withFields(["/view/rubric/criteria/0/requirement"], { view: { rubric: { criteria: [{ requirement: value }] } } })).verdict, "fail");
  }
  const choice = { kind: "reading_mcq", view: { stem: "Choose.", options: ["Fox", "Hare"], key: [0] } };
  for (const ref of ["/view/options", "/view/options/length", "/view/options/00"]) assert.equal(fieldsCheck(withFields([ref], choice)).verdict, "fail", ref);
});
test("text evidence bindings follow supported task fields and the interpreter's response rule", () => {
  for (const [kind, view, refs] of [
    ["reading_mcq", { stem: "Who crosses?", options: ["Fox", "Hare"], key: [0], response_rule: "single-best" }, ["/view/stem", "/view/options/0"]],
    ["evidence_select", { prompt: "Choose the action.", candidates: ["crosses", "waits"], key: [0], selection_rule: "Select exactly one." }, ["/view/prompt", "/view/candidates/1", "/view/selection_rule"]],
    ["classify", { prompt: "Classify the action.", entries: [{ id: "E1", text: "crosses" }], categories: [{ id: "C1", label: "Action", description: "A movement." }], mapping: { E1: "C1" } },
      ["/view/prompt", "/view/entries/0/text", "/view/categories/0/label", "/view/categories/0/description"]],
    ["open_check", { prompt: "Explain.", rubric: { criteria: [{ requirement: "Quote the action." }] } }, ["/view/prompt", "/view/rubric/criteria/0/requirement"]],
    ["open_prompt", { prompt: "Explain.", rubric: { criteria: [{ requirement: "Explain the action." }] } }, ["/view/prompt", "/view/rubric/criteria/0/requirement"]]
  ]) assert.equal(fieldsCheck(withFields(refs, { kind, view })).verdict, "pass", kind);
  const unusedPrompt = withFields(["/view/prompt"], { view: { stem: "Actual question.", prompt: "Unused field." } });
  assert.equal(fieldsCheck(unusedPrompt).verdict, "fail");
  for (const [kind, view, ref] of [
    ["reading_mcq", { stem: "Choose.", options: ["A", "B"], key: [0], rubric: { criteria: [{ requirement: "A" }] } }, "/view/rubric/criteria/0/requirement"],
    ["evidence_select", { prompt: "Choose.", candidates: ["A", "B"], key: [0], claim: "Author metadata claim." }, "/view/claim"],
    ["classify", { prompt: "Classify.", entries: [{ id: "E1", text: "A" }], categories: [], mapping: { E1: "C1" } }, "/view/entries/0/id"]
  ]) assert.equal(fieldsCheck(withFields([ref], { kind, view })).verdict, "fail", ref);
  for (const mutate of [pkg => { delete pkg.set.contract; }, pkg => { pkg.set.contract = "question-set 0.9"; }, pkg => { pkg.context.contract = "lesson-context 0.9"; },
    pkg => { pkg.set.items[0].kind = "uninterpreted_response"; }, pkg => { pkg.set.items[0].family = "written_response"; },
    pkg => { pkg.set.adapter_extension = "unknown/0.1"; }, pkg => { pkg.context.adapter_extension = "unknown/0.1"; },
    pkg => { Object.assign(pkg.set.items[0], { kind: "reading_mcq", view: { prompt: "Choose.", response_rule: "choose-all" } }); },
    pkg => { Object.assign(pkg.set.items[0], { kind: "reading_mcq", view: { prompt: "Choose.", key: [0, 1] } }); },
    pkg => { Object.assign(pkg.set.items[0], { kind: "classify", view: { prompt: "Classify.", response_rule: "multiple-categories" } }); },
    pkg => { Object.assign(pkg.set.items[0], { kind: "classify", view: { prompt: "Classify.", mapping: { E1: ["C1", "C2"] } } }); }
  ]) {
    const pkg = withFields(["/view/prompt"]); mutate(pkg); const result = fieldsCheck(pkg);
    assert.equal(result.verdict, "fail"); assert(result.evidence.issues.some(row => row.code === "unsupported_response_profile"));
  }
});
test("native bindings recognize each supported response family's task and scoring requirement leaves", () => {
  for (const [family, extra, refs] of [
    ...["single_choice", "multiple_select", "word_selection"].map(family => [family, { options: ["Fox", "Hare"], selection_rule: "Choose." }, ["/view/options/0", "/view/selection_rule"]]),
    ["evidence_selection", { options: ["crosses", "waits"], claim: "Find the action." }, ["/view/options/1", "/view/claim"]],
    ["classification", { entries: [{ id: "E1", text: "Fox" }], categories: [{ id: "C1", label: "Animal", description: "An animal.", entity: "Fox", relation: "is" }] },
      ["/view/entries/0/text", "/view/categories/0/label", "/view/categories/0/description", "/view/categories/0/entity", "/view/categories/0/relation"]],
    ...["written_response", "oral_response", "word_web"].map(family => [family, { rubric: { criteria: [{ requirement: "Explain the action." }] } }, ["/view/rubric/criteria/0/requirement"]]),
    ["inline_choice", { surrounding_text: "The [blank] crosses.", blanks: [{ id: "B1", options: ["Fox", "Hare"], key: 0 }] }, ["/view/surrounding_text", "/view/blanks/0/options/0"]],
    ["shared_cloze", { surrounding_text: "The [blank] crosses.", bank: [{ id: "W1", text: "Fox" }], blanks: [{ id: "B1", key: "W1" }], reuse_policy: "single-use" },
      ["/view/surrounding_text", "/view/bank/0/text", "/view/reuse_policy"]],
    ["matching", { entries: [{ id: "E1", text: "Fox" }], options: [{ id: "O1", text: "crosses" }], mapping: { E1: "O1" } }, ["/view/entries/0/text", "/view/options/0/text"]],
    ["sequence", { entries: [{ id: "E1", text: "Cross." }], key: ["E1"], ordering_rule: "Order events.", tie_policy: "No ties." }, ["/view/entries/0/text", "/view/ordering_rule", "/view/tie_policy"]],
    ["say_back", { statement: "The fox crosses.", scoring: "unscored-recall" }, ["/view/statement"]],
    ["self_report", { scale: ["Unsure", "Sure"], scoring: "none" }, ["/view/scale/0"]]
  ]) {
    const view = { prompt: "Respond to the source.", response_mode: "Declared response.", response_parts: ["One part."], ...extra };
    assert.equal(fieldsCheck(nativeFields(["/view/prompt", "/view/response_mode", "/view/response_parts/0", ...refs], family, view)).verdict, "pass", family);
  }
  const web = nativeFields(["/view/centre", "/view/link_rule"], "word_web", { prompt: "Build a web.", centre: "crossing", link_rule: "Explain each link." });
  assert.equal(fieldsCheck(web).verdict, "pass");
});
test("native family boundaries reject keys inside blanks, whole mixed containers and unsupported profiles", () => {
  const view = { prompt: "Choose.", blanks: [{ id: "B1", options: ["Fox", "Hare"], key: 0, feedback: "Fox." }],
    rubric: { criteria: [{ requirement: "Choose Fox." }] }, sample_answer: "Fox.", feedback: "Fox.", unknown: "Fox." };
  for (const ref of ["/view/blanks", "/view/blanks/0", "/view/blanks/0/options", "/view/blanks/0/id", "/view/blanks/0/key", "/view/blanks/0/feedback",
    "/view/rubric/criteria/0/requirement", "/view/sample_answer", "/view/feedback", "/view/unknown"]) {
    assert.equal(fieldsCheck(nativeFields(["/view/prompt", ref], "inline_choice", view)).verdict, "fail", ref);
  }
  for (const mutate of [pkg => { pkg.set.items[0].family = "uninterpreted_response"; }, pkg => { delete pkg.set.adapter_extension; },
    pkg => { pkg.context.adapter_extension = "native-activity-transport/0.9"; }, pkg => { pkg.set.contract = "question-set native 0.9"; }]) {
    const pkg = nativeFields(["/view/prompt"], "written_response", { prompt: "Explain." }); mutate(pkg);
    const result = fieldsCheck(pkg); assert.equal(result.verdict, "fail"); assert(result.evidence.issues.some(row => row.code === "unsupported_response_profile"));
  }
  const instruction = fieldsCheck(nativeFields(["/view/instruction"], "nonresponse", { instruction: "Read the source." }));
  assert.equal(instruction.verdict, "fail"); assert.equal(instruction.evidence.issues[0].code, "field_is_not_response_contract");
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
  assert.match(report.checks.find(row => row.id === "sequence_return_evidence_fields_resolve").evidence.meaning, /not observed learner production/);
});
