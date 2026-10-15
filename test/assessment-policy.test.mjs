import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { resolveAssessmentPolicy, AssessmentPolicyError } from "../src/assessment-policy.mjs";

// Fictional supplied policies test software behaviour; they are not academic decisions or recommended settings.
function fixture() {
  const items = [{ id: "Q", kind: "reading_mcq", view: { stem: "Which token is red?", options: ["Red token", "Blue token", "Green token"], key: [0] } },
    { id: "W", kind: "open_check", view: { prompt: "Explain which token was selected and why.", sample_answer: "AUTHOR_MODEL_SENTINEL", rubric: { criteria: [
      { requirement: "Make a source-supported claim." }, { requirement: "Provide relevant source evidence." }, { requirement: "Explain how the evidence supports the claim." }] } } },
    ...Array.from({ length: 4 }, (_, i) => ({ id: `BANK${i + 1}`, kind: "reading_mcq", view: { stem: `Select the marked token in scene ${i + 1}.`, options: ["Marked token", "Unmarked token"], key: [0] } }))];
  const policy = { version: "assessment-policy/0.1", id: "SYNTHETIC-POLICY", provenance: { status: "course-declared", source_ref: "synthetic-policy-source", revision: "synthetic-v1" },
    parameters: [{ id: "streak", value: 1, status: "confirmed", source_ref: "synthetic-streak-decision" }, { id: "bank", value: 4, status: "confirmed", source_ref: "synthetic-bank-decision" }],
    item_rules: [{ item_id: "Q", moment: "checkpoint-test", feedback: { timing: "after-submit", required: true, elaboration: "explanation" }, score_basis: "first-submission",
      support: { frame_policy: "none", allowed_tool_refs: ["text-zoom"] }, gap_refs: ["G"], misconception_routes: [
        { option_ref: "/view/options/1", tag: "COLOR_CONFUSION", gap_ref: "G", teach_event_ref: "TEACH" },
        { option_ref: "/view/options/2", tag: "MARK_CONFUSION", gap_ref: "G", teach_event_ref: "TEACH" }] },
      { item_id: "W", moment: "checkpoint-test", feedback: { timing: "after-submit", required: true, elaboration: "explanation" }, score_basis: "first-submission",
        support: { frame_policy: "none", allowed_tool_refs: [] }, gap_refs: ["G"], misconception_routes: [] }],
    gaps: [{ id: "G", target_refs: ["K"], category: "Token knowledge", prerequisite_refs: ["P"], bank_item_ids: items.filter(item => item.id.startsWith("BANK")).map(item => item.id),
      teach_card: { form: "single-feature", rule: "Select a token by its visible color.", positive: "A red round token is selected.", negative: "A blue round token is not selected.", difference: "The token color changes." } }],
    remediation: { streak_parameter_ref: "streak", bank_limit_parameter_ref: "bank", initial_order: "teach-before-retest", wrong_resets_streak: true, terminal_states: ["closed", "flagged"], fresh_items_required: true },
    writing: { item_id: "W", components: [
      { id: "C", role: "claim", requirement_ref: "/view/rubric/criteria/0/requirement" },
      { id: "E", role: "evidence", requirement_ref: "/view/rubric/criteria/1/requirement" },
      { id: "R", role: "reasoning", requirement_ref: "/view/rubric/criteria/2/requirement" }], repair_order: ["C", "E", "R"], claim_failure_gap_ref: "G", conventions_scored: false, frame: { mode: "none", rungs: [] } } };
  return { policy, context: { items, eventIds: new Set(["TEACH"]), targetIds: new Set(["K", "P"]) } };
}
const resolve = ({ policy, context }) => resolveAssessmentPolicy(policy, context);
const verdict = (report, id) => report.checks.find(row => row.id === `assessment_policy_${id}`)?.verdict;
function fails(mutate, code) {
  const fixtureValue = fixture(); mutate(fixtureValue.policy, fixtureValue.context);
  assert.throws(() => resolve(fixtureValue), error => error instanceof AssessmentPolicyError && error.code === code);
}
test("absent optional policy stays absent, while null and malformed declarations are rejected", () => {
  assert.equal(resolveAssessmentPolicy(undefined), null);
  for (const value of [null, [], "policy"]) assert.throws(() => resolveAssessmentPolicy(value), AssessmentPolicyError);
  fails(policy => { policy.version = "assessment-policy/future"; }, "unsupported_version");
  fails(policy => { policy.extra = true; }, "unknown_field");
  fails(policy => { delete policy.provenance; }, "missing_field");
  fails(policy => { policy.provenance.revision = " "; }, "invalid_text");
});
test("resolution is pure and preserves policy, per-item decisions and separate semantic questions", () => {
  const pkg = fixture(), before = structuredClone(pkg.policy), result = resolve(pkg);
  assert.deepEqual(pkg.policy, before); assert.deepEqual(result.policy, before); assert.notEqual(result.policy, pkg.policy);
  assert.equal(result.holds.length, 0); assert(result.checks.every(check => check.verdict === "pass"));
  assert.equal(result.item_policies[1].writing.components[2].requirement_ref, "/view/rubric/criteria/2/requirement");
  assert(result.requirements.some(row => row.id === "assessment_policy_writing_response"));
  assert(result.requirements.every(row => row.source_ref === before.provenance.source_ref && row.scope.authority.includes("not authenticated")));
  assert.equal(JSON.stringify(result).includes("AUTHOR_MODEL_SENTINEL"), false);
  result.policy.gaps[0].teach_card.rule = "Changed output";
  assert.deepEqual(pkg.policy, before);
});
test("proposed policy source status is retained without authenticating course authority", () => {
  const pkg = fixture(); pkg.policy.provenance.status = "proposed";
  const result = resolve(pkg);
  assert(result.holds.some(row => row.reason === "assessment_policy_proposed"));
  assert(result.item_policies.every(row => row.holds.includes("assessment_policy_proposed")));
  assert.equal(verdict(result, "provenance_retained"), "pass");
  assert.match(result.checks[0].evidence.meaning, /authority.*unverified/);
});
test("the declared moment controls timing and score basis independently of question format", () => {
  for (const moment of ["acquisition", "spot-check"]) {
    const pkg = fixture(), rule = pkg.policy.item_rules[0]; rule.moment = moment; rule.feedback.timing = "immediate"; rule.score_basis = "practice-only";
    const result = resolve(pkg); assert.equal(verdict(result, "item_1_feedback_timing"), "pass"); assert.equal(verdict(result, "item_1_score_basis"), "pass");
    assert.equal(verdict(result, "item_2_feedback_timing"), "pass");
    rule.feedback.timing = "after-submit"; rule.score_basis = "first-submission";
    const wrong = resolve(pkg); assert.equal(verdict(wrong, "item_1_feedback_timing"), "fail"); assert.equal(verdict(wrong, "item_1_score_basis"), "fail");
  }
  const checkpoint = fixture(); checkpoint.policy.item_rules[0].feedback.timing = "immediate";
  assert.equal(verdict(resolve(checkpoint), "item_1_feedback_timing"), "fail");
  const gate = fixture(); gate.policy.item_rules[0].moment = "mastery-gate"; gate.policy.item_rules[0].feedback.timing = "guide";
  assert.equal(verdict(resolve(gate), "item_1_feedback_timing"), "pass");
});
test("review practice retains the adopted course timing while keeping its score separate", () => {
  const pkg = fixture(), rule = pkg.policy.item_rules[0]; rule.moment = "review-practice"; rule.score_basis = "practice-only";
  for (const timing of ["immediate", "after-submit"]) {
    rule.feedback.timing = timing;
    const result = resolve(pkg); assert.equal(verdict(result, "item_1_feedback_timing"), "pass"); assert.equal(verdict(result, "item_1_score_basis"), "pass");
    assert(result.requirements.find(row => row.id === "assessment_policy_item_1_feedback_fit").question.includes("adopted course choice"));
  }
  rule.feedback.timing = "unknown";
  assert.equal(verdict(resolve(pkg), "item_1_feedback_timing"), "unsure");
  rule.score_basis = "first-submission";
  assert.equal(verdict(resolve(pkg), "item_1_score_basis"), "fail");
});
test("unknown timing, elaboration, support and score stay explicit item holds", () => {
  const pkg = fixture(), rule = pkg.policy.item_rules[0]; rule.feedback.timing = rule.feedback.elaboration = rule.support.frame_policy = rule.score_basis = "unknown";
  const result = resolve(pkg); assert.equal(verdict(result, "item_1_feedback_timing"), "unsure"); assert.equal(verdict(result, "item_1_score_basis"), "unsure");
  assert(result.holds.filter(row => row.item_id === "Q").length >= 4);
  assert.equal(result.item_policies[1].holds.some(reason => reason === "assessment_policy_frame_policy_unknown"), false);
});
test("every wrong authored choice has a resolving misconception route, without certifying the key", () => {
  const pkg = fixture(); pkg.policy.item_rules[0].misconception_routes.pop();
  let result = resolve(pkg), check = result.checks.find(row => row.id === "assessment_policy_item_1_misconception_routes");
  assert.equal(check.verdict, "fail"); assert.deepEqual(check.evidence.missing, ["/view/options/2"]);
  pkg.policy.item_rules[0].misconception_routes[0].option_ref = "/view/options/0";
  result = resolve(pkg); check = result.checks.find(row => row.id === "assessment_policy_item_1_misconception_routes");
  assert.deepEqual(check.evidence.unexpected, ["/view/options/0"]); assert.equal(check.evidence.key_status, "unvalidated author intent only");
});
test("choice coverage respects candidate fields and missing or malformed author keys stay unknown", () => {
  const pkg = fixture(), item = pkg.context.items[0]; item.view.candidates = item.view.options; delete item.view.options;
  pkg.policy.item_rules[0].misconception_routes.forEach(route => { route.option_ref = route.option_ref.replace("options", "candidates"); });
  assert.equal(verdict(resolve(pkg), "item_1_misconception_routes"), "pass");
  for (const key of [undefined, [], [99], [0, 0], ["A"]]) {
    item.view.key = key; assert.equal(verdict(resolve(pkg), "item_1_misconception_routes"), "unsure");
  }
});
test("unknown or duplicate item, option, gap, target, bank and teaching references cannot enter a policy", () => {
  for (const mutate of [policy => { policy.item_rules[0].item_id = "MISSING"; }, policy => { policy.item_rules[0].gap_refs = ["MISSING"]; },
    policy => { policy.gaps[0].target_refs = ["MISSING"]; }, policy => { policy.gaps[0].prerequisite_refs = ["MISSING"]; },
    policy => { policy.gaps[0].bank_item_ids.push("MISSING"); }, policy => { policy.item_rules[0].misconception_routes[0].teach_event_ref = "MISSING"; }]) fails(mutate, "unknown_reference");
  fails(policy => { policy.item_rules[0].misconception_routes[0].option_ref = "/view/options/99"; }, "unknown_option_reference");
  fails(policy => { policy.item_rules.push(structuredClone(policy.item_rules[0])); }, "duplicate_id");
  fails(policy => { policy.item_rules[0].misconception_routes.push(structuredClone(policy.item_rules[0].misconception_routes[0])); }, "duplicate_id");
  fails(policy => { policy.gaps[0].bank_item_ids.push(policy.gaps[0].bank_item_ids[0]); }, "duplicate_reference");
});
test("proposed and unknown consumed parameter decisions hold only the affected declared scope", () => {
  for (const status of ["proposed", "unknown"]) {
    const pkg = fixture(); pkg.policy.parameters[0].status = status;
    if (status === "unknown") pkg.policy.parameters[0].value = null;
    const result = resolve(pkg); assert.equal(verdict(result, "parameter_decisions"), "unsure");
    assert(result.holds.some(row => row.reason === `assessment_policy_parameter_streak_${status}`));
  }
  const pkg = fixture(); pkg.policy.parameters.push({ id: "unused", value: null, status: "unknown", source_ref: "unrelated-decision" });
  assert.equal(verdict(resolve(pkg), "parameter_decisions"), "pass");
  assert.equal(resolve(pkg).holds.some(row => row.reason.includes("unused")), false);
});
test("numeric parameter references reject invalid types and confirmed missing values without selecting thresholds", () => {
  fails(policy => { policy.remediation.streak_parameter_ref = "MISSING"; }, "unknown_reference");
  fails(policy => { policy.parameters.push(structuredClone(policy.parameters[0])); }, "duplicate_id");
  for (const value of [-1, 0, 1.5, "four", true, Infinity]) fails(policy => { policy.parameters[0].value = value; }, "invalid_parameter_value");
  fails(policy => { policy.parameters[0].value = null; }, "confirmed_parameter_missing_value");
  const pkg = fixture(); pkg.policy.parameters[0].value = 5; pkg.policy.parameters[1].value = 9;
  assert.equal(verdict(resolve(pkg), "parameter_decisions"), "pass");
});
test("remediation order is explicitly supplied, terminal flagging is bounded, and missing banks remain held", () => {
  const pkg = fixture(); pkg.policy.remediation.initial_order = "unknown";
  assert(resolve(pkg).holds.some(row => row.reason === "assessment_policy_remediation_order_unknown"));
  pkg.policy.remediation.initial_order = "retest-before-teach"; assert.equal(resolve(pkg).holds.length, 0);
  pkg.policy.remediation.terminal_states = ["closed"];
  assert.equal(verdict(resolve(pkg), "remediation_bounded_exit"), "fail");
  pkg.policy.gaps[0].bank_item_ids = [];
  assert.equal(verdict(resolve(pkg), "gap_1_references"), "unsure");
  delete pkg.policy.remediation; assert(resolve(pkg).holds.some(row => row.reason === "assessment_policy_remediation_missing"));
});
test("component aliases normalize roles while retaining every original component and rubric reference", () => {
  const pkg = fixture(); pkg.policy.writing.components.forEach((row, i) => { row.role = ["A", "E1", "E2"][i]; });
  const result = resolve(pkg), writing = result.item_policies.find(row => row.item_id === "W");
  assert.equal(verdict(result, "writing_components"), "pass");
  assert.deepEqual(writing.component_roles.map(row => row.role), ["claim", "evidence", "reasoning"]);
  assert.deepEqual(writing.writing.components.map(row => row.role), ["A", "E1", "E2"]);
  assert.equal(new Set(writing.component_roles.map(row => row.requirement_ref)).size, 3);
});
test("a writing component must reference a distinct actual requirement, not a model answer or feedback", () => {
  for (const pointer of ["/view/sample_answer", "/view/feedback", "/view/rubric/criteria/90/requirement", "/view/rubric/criteria/0/requirement"]) {
    const pkg = fixture(); pkg.policy.writing.components[2].requirement_ref = pointer;
    assert.equal(verdict(resolve(pkg), "writing_requirement_fields"), "fail");
  }
  const pkg = fixture(); pkg.context.items[1].view.rubric.criteria[2].requirement = " ";
  assert.equal(verdict(resolve(pkg), "writing_requirement_fields"), "fail");
});
test("missing component roles and non-claim-first repair order remain structural defects", () => {
  const pkg = fixture(); pkg.policy.writing.components[2].role = "evidence";
  assert.equal(verdict(resolve(pkg), "writing_components"), "fail");
  const order = fixture(); order.policy.writing.repair_order = ["E", "C", "R"];
  assert.equal(verdict(resolve(order), "writing_repair_order"), "fail");
  order.policy.writing.repair_order = ["C", "E"];
  assert.equal(verdict(resolve(order), "writing_repair_order"), "fail");
});
test("writing frame decisions are explicit and proposed frame parameters are held for that writing item", () => {
  const pkg = fixture(); pkg.policy.writing.frame = { mode: "ladder", rungs: ["complete", "partial", "independent"] };
  assert.equal(verdict(resolve(pkg), "writing_frame_decisions"), "unsure");
  pkg.policy.parameters.push({ id: "frame-change", value: 2, status: "proposed", source_ref: "synthetic-frame-change" },
    { id: "fade", value: 3, status: "confirmed", source_ref: "synthetic-fade" });
  Object.assign(pkg.policy.writing.frame, { max_change_parameter_ref: "frame-change", fade_success_parameter_ref: "fade" });
  const result = resolve(pkg); assert.equal(verdict(result, "writing_frame_decisions"), "pass");
  assert(result.holds.some(row => row.item_id === "W" && row.reason === "assessment_policy_parameter_frame-change_proposed"));
  assert.equal(result.item_policies[0].holds.some(reason => reason.includes("frame-change")), false);
  pkg.policy.writing.conventions_scored = true; assert.equal(resolve(pkg).policy.writing.conventions_scored, true);
});
test("an optional empty policy adds no numeric defaults or invented writing/remediation decisions", () => {
  const pkg = fixture(); pkg.policy.parameters = []; pkg.policy.item_rules = []; pkg.policy.gaps = []; delete pkg.policy.remediation; delete pkg.policy.writing;
  const result = resolve(pkg); assert.deepEqual(result.policy.parameters, []); assert.equal(result.item_policies.length, 0); assert.equal(result.requirements.length, 0);
  assert.equal(Object.hasOwn(result.policy, "remediation"), false);
});
test("linked-pair point tables are explicit, complete and independent from gap declarations", () => {
  const pkg = fixture(); pkg.policy.scoring = [{ id: "PAIR", kind: "linked-pair", item_ids: ["Q", "BANK1"], points: { "00": 0, "01": 0.25, "10": 0.5, "11": 1 } }];
  const beforeGaps = structuredClone(pkg.policy.gaps), result = resolve(pkg);
  assert.equal(verdict(result, "scoring_1_table"), "pass"); assert.deepEqual(result.policy.gaps, beforeGaps);
  assert(result.requirements.some(row => row.id === "assessment_policy_scoring_1_fit"));
  delete pkg.policy.scoring[0].points["01"];
  assert.throws(() => resolve(pkg), error => error.code === "incomplete_points_table");
});
test("linked-pair scoring rejects duplicate/unknown parts, extra outcomes and negative points", () => {
  const scoring = { id: "PAIR", kind: "linked-pair", item_ids: ["Q", "BANK1"], points: { "00": 0, "01": 0, "10": 1, "11": 4 } };
  for (const [mutate, code] of [
    [row => { row.item_ids = ["Q", "Q"]; }, "duplicate_reference"], [row => { row.item_ids[1] = "MISSING"; }, "unknown_reference"],
    [row => { row.item_ids.pop(); }, "invalid_scoring_shape"], [row => { row.points.extra = 8; }, "incomplete_points_table"],
    [row => { row.points["10"] = -1; }, "invalid_points"], [row => { row.selection_count = 1; }, "invalid_scoring_shape"]]) {
    const pkg = fixture(); pkg.policy.scoring = [structuredClone(scoring)]; mutate(pkg.policy.scoring[0]);
    assert.throws(() => resolve(pkg), error => error.code === code);
  }
});
test("selection scoring requires the exact selection count and every possible correct-count row", () => {
  const pkg = fixture(); pkg.context.items[0].view.key = [0, 2]; pkg.policy.item_rules[0].misconception_routes.pop();
  pkg.policy.scoring = [{ id: "SELECT", kind: "select-n", item_ids: ["Q"], selection_count: 2, points: { "0": 0, "1": 0.25, "2": 1 } }];
  assert.equal(verdict(resolve(pkg), "scoring_1_table"), "pass");
  delete pkg.policy.scoring[0].points["1"];
  assert.throws(() => resolve(pkg), error => error.code === "incomplete_points_table");
  pkg.policy.scoring[0].selection_count = 10;
  assert.throws(() => resolve(pkg), error => error.code === "invalid_selection_count");
});
test("one response cannot be counted by overlapping scoring groups", () => {
  const pkg = fixture(); pkg.policy.scoring = [
    { id: "PAIR1", kind: "linked-pair", item_ids: ["Q", "BANK1"], points: { "00": 0, "01": 0, "10": 1, "11": 4 } },
    { id: "PAIR2", kind: "linked-pair", item_ids: ["Q", "BANK2"], points: { "00": 0, "01": 0, "10": 1, "11": 4 } }];
  assert.throws(() => resolve(pkg), error => error.code === "overlapping_scoring_groups");
});
test("linked-pair scoring needs supported single-choice parts and does not assume open-response marking", () => {
  const pkg = fixture(); pkg.policy.scoring = [{ id: "PAIR", kind: "linked-pair", item_ids: ["Q", "BANK1"], points: { "00": 0, "01": 0, "10": 1, "11": 4 } }];
  assert.equal(verdict(resolve(pkg), "scoring_1_author_response"), "pass");
  pkg.context.items[0].view.key = [0, 1];
  assert.equal(verdict(resolve(pkg), "scoring_1_author_response"), "unsure");
  pkg.policy.scoring[0].item_ids[0] = "W";
  const result = resolve(pkg); assert.equal(verdict(result, "scoring_1_author_response"), "unsure");
  assert(result.holds.some(row => row.item_id === "W" && row.reason === "assessment_policy_scoring_PAIR_response_unresolved"));
});
test("select-n policy count must agree with author-key cardinality and every explicit response count", () => {
  const pkg = fixture(); pkg.policy.scoring = [{ id: "SELECT", kind: "select-n", item_ids: ["Q"], selection_count: 2, points: { "0": 0, "1": 0.5, "2": 4 } }];
  assert.equal(verdict(resolve(pkg), "scoring_1_author_response"), "unsure");
  Object.assign(pkg.context.items[0].view, { key: [0, 2], select_count: 2, count: 2, response_rule: "select-n" });
  assert.equal(verdict(resolve(pkg), "scoring_1_author_response"), "pass");
  pkg.context.items[0].view.count = 1;
  assert.equal(verdict(resolve(pkg), "scoring_1_author_response"), "unsure");
  pkg.context.items[0].view.count = 2; pkg.context.items[0].view.response_rule = "single-best";
  assert.equal(verdict(resolve(pkg), "scoring_1_author_response"), "unsure");
});
test("the schema retains generic decision fields, role aliases and explicit scoring shapes", () => {
  const schema = JSON.parse(fs.readFileSync(new URL("../contracts/assessment-policy.schema.json", import.meta.url)));
  assert.equal(schema.properties.version.const, "assessment-policy/0.1"); assert.equal(schema.additionalProperties, false);
  assert(schema.properties.writing.properties.components.items.properties.role.enum.includes("A"));
  assert(schema.properties.scoring.items.properties.kind.enum.includes("select-n"));
  assert.equal(JSON.stringify(schema).includes('"default"'), false);
});
