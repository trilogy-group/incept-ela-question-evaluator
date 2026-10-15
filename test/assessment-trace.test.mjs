import test from "node:test";
import assert from "node:assert/strict";
import { assessmentPolicyHash, auditAssessmentTrace } from "../src/assessment-trace.mjs";
import { resolveAssessmentPolicy } from "../src/assessment-policy.mjs";

// Synthetic declarations and events verify consistency checks, never learner outcomes or marking accuracy.
const contextSha256 = "a".repeat(64), setSha256 = "b".repeat(64);
const clone = value => structuredClone(value);
const choice = (id, stem, options = ["kept", "lost"], key = [0]) => ({ id, view: { stem, options, key } });
const rule = (item_id, moment = "checkpoint-test") => ({ item_id, moment,
  feedback: { timing: moment === "spot-check" ? "immediate" : "after-submit", required: false, elaboration: "explanation" },
  score_basis: moment === "spot-check" ? "practice-only" : "first-submission",
  support: { frame_policy: "none", allowed_tool_refs: [] }, gap_refs: ["G1"], misconception_routes: [] });
function fixture() {
  const items = [choice("Q1", "Which token was kept?", ["blue token", "red token"]),
    ...[1, 2, 3, 4].map(n => choice(`B${n}`, `Which case ${n} preserves the feature?`))];
  const policy = { version: "assessment-policy/0.1", id: "SYNTHETIC-POLICY",
    provenance: { status: "course-declared", source_ref: "synthetic-declaration", revision: "toy-v1" },
    parameters: [{ id: "STREAK", value: 2, status: "confirmed", source_ref: "synthetic-decision" },
      { id: "BANK", value: 3, status: "confirmed", source_ref: "synthetic-decision" }],
    item_rules: [rule("Q1")],
    gaps: [{ id: "G1", target_refs: ["K1"], category: "Ideas", prerequisite_refs: [], bank_item_ids: ["B1", "B2", "B3"],
      teach_card: { form: "single-feature", rule: "Preserve the feature.", positive: "Feature present.", negative: "Feature absent.", difference: "One feature differs." } }],
    remediation: { streak_parameter_ref: "STREAK", bank_limit_parameter_ref: "BANK", initial_order: "retest-before-teach",
      wrong_resets_streak: true, terminal_states: ["closed", "flagged"], fresh_items_required: true } };
  return { policy, items };
}
function writingFixture(roleAliases = false) {
  const f = fixture();
  f.items.push({ id: "W1", view: { prompt: "Explain the synthetic action.", rubric: { criteria: [
    { requirement: "State an accurate claim." }, { requirement: "Give supporting evidence." }, { requirement: "Connect evidence and claim." }] } } },
  { id: "W2", view: { prompt: "Explain a different action." } });
  f.policy.item_rules.push(rule("W1", "spot-check"));
  f.policy.parameters.push({ id: "REDRAFTS", value: 1, status: "confirmed", source_ref: "synthetic-decision" },
    { id: "FRAME", value: 1, status: "confirmed", source_ref: "synthetic-decision" },
    { id: "FADE", value: 2, status: "confirmed", source_ref: "synthetic-decision" });
  f.policy.writing = { item_id: "W1", components: ["C", "E", "R"].map((id, i) => ({ id,
    role: roleAliases ? id : ["claim", "evidence", "reasoning"][i], requirement_ref: `/view/rubric/criteria/${i}/requirement` })),
  repair_order: ["C", "E", "R"], claim_failure_gap_ref: "G1", conventions_scored: false,
  max_redrafts_parameter_ref: "REDRAFTS", frame: { mode: "ladder", rungs: ["full", "stem", "blank"],
    max_change_parameter_ref: "FRAME", fade_success_parameter_ref: "FADE" } };
  return f;
}
function audit(f, events, traceChanges = {}) {
  const trace = { version: "assessment-trace/0.1", session_id: "synthetic-session", policy_sha256: assessmentPolicyHash(f.policy),
    context_sha256: contextSha256, set_sha256: setSha256,
    events: events.map((event, i) => ({ id: `E${i + 1}`, order: i + 1, ...event })), ...traceChanges };
  return auditAssessmentTrace({ ...f, trace, contextSha256, setSha256 });
}
const answer = (item_id = "Q1", selected = [1]) => ({ type: "answer", item_id, selected });
const submit = { type: "submit" };
const base = () => [answer(), submit];
const writingAnswer = () => ({ type: "answer", item_id: "W1", response: "The synthetic action preserves the stated feature." });
const writingBase = (correct = false) => [answer("Q1", [correct ? 0 : 1]), writingAnswer(), submit];
const bank = (item_id, selected = [0]) => ({ type: "bank-attempt", gap_id: "G1", item_id, selected });
const teach = () => ({ type: "teach", gap_id: "G1" });
const mark = (C, E, R) => ({ type: "writing-score", item_id: "W1", components: { C, E, R } });
const fix = (component_id, response = "Revised synthetic response.") => ({ type: "writing-fix", item_id: "W1", component_id, response });
const verdicts = (report, id) => report.checks.filter(row => row.id === id).map(row => row.verdict);
const hasFail = (report, id) => assert(verdicts(report, id).includes("fail"), `Expected failing ${id}; got ${JSON.stringify(report)}`);

test("synthetic trace fixtures satisfy the assessment-policy field validator", () => {
  for (const f of [fixture(), writingFixture(), writingFixture(true)]) {
    const resolved = resolveAssessmentPolicy(f.policy, { items: f.items, targetIds: ["K1"], eventIds: [] });
    assert.equal(resolved.policy.version, "assessment-policy/0.1");
  }
});

test("policy hashing ignores object-key order but preserves array order and changed decisions", () => {
  const a = fixture().policy, b = Object.fromEntries(Object.entries(a).reverse());
  assert.equal(assessmentPolicyHash(a), assessmentPolicyHash(b));
  b.parameters = clone(a.parameters).reverse(); assert.notEqual(assessmentPolicyHash(a), assessmentPolicyHash(b));
  const c = clone(a); c.parameters[0].value = 3; assert.notEqual(assessmentPolicyHash(a), assessmentPolicyHash(c));
});

test("editable answers are frozen at submission and later practice cannot improve that score", () => {
  const f = fixture(), events = [answer("Q1", [0]), answer(), submit, { type: "score", points: 0 },
    bank("B1"), bank("B2"), { type: "gap-state", gap_id: "G1", status: "closed" }, { type: "score", points: 0 }, { type: "close" }];
  const before = clone({ f, events }), report = audit(f, events);
  assert.equal(report.status, "checks_passed_unqualified");
  assert.deepEqual(report.first_submission, [{ item_id: "Q1", selected: [1], correct: false }]);
  assert.equal(report.points, 0); assert.equal(report.gaps[0].status, "closed");
  assert.deepEqual({ f, events }, before);
  for (const flag of ["runtime_authenticated", "marks_independently_validated", "qualified"]) assert.equal(report[flag], false);
  hasFail(audit(f, [...events.slice(0, -1), { type: "score", points: 1 }, events.at(-1)]), "runtime_score_immutable");
});

test("post-submit answers, duplicate submissions and pre-submit scores fail", () => {
  const f = fixture();
  hasFail(audit(f, [...base(), answer("Q1", [0])]), "runtime_answer_declared");
  hasFail(audit(f, [...base(), submit]), "runtime_single_submission");
  hasFail(audit(f, [{ type: "score", points: 0 }, ...base()]), "runtime_score_immutable");
});

test("events after a completed close are rejected without changing the closed snapshot", () => {
  const f = fixture(), complete = [...base(), bank("B1"), bank("B2"), { type: "gap-state", gap_id: "G1", status: "closed" }, { type: "close" }];
  const closed = audit(f, complete), after = audit(f, [...complete, bank("B3", [1])]);
  assert.equal(closed.status, "checks_passed_unqualified");
  hasFail(after, "runtime_event_before_close");
  assert.deepEqual(after.gaps, closed.gaps);
  assert.deepEqual(after.first_submission, closed.first_submission);
  assert.equal(after.points, closed.points);
});

test("aggregate score events cannot impersonate an item-specific mark", () => {
  const report = audit(fixture(), [...base(), { type: "score", item_id: "B4", points: 0 }]);
  hasFail(report, "runtime_score_scope");
});

test("feedback, help, teaching and models cannot precede protected checkpoint or gate submission", () => {
  for (const moment of ["checkpoint-test", "mastery-gate"]) for (const type of ["feedback", "help", "teach", "model"]) {
    const f = fixture(); f.policy.item_rules[0].moment = moment;
    hasFail(audit(f, [answer(), { type, item_id: "Q1" }, submit]), "runtime_feedback_timing");
    assert.equal(audit(f, [...base(), { type, item_id: "Q1" }]).status, "checks_passed_unqualified");
  }
});

test("unscoped feedback during a protected test cannot evade timing checks", () => {
  for (const type of ["feedback", "help", "teach", "model"]) {
    assert.notEqual(audit(fixture(), [answer(), { type }, submit]).status, "checks_passed_unqualified", type);
  }
});

test("practice feedback may occur before the checkpoint is submitted", () => {
  const f = fixture(); f.items.push(choice("P1", "Practice a different case.")); f.policy.item_rules.push(rule("P1", "spot-check"));
  const report = audit(f, [{ type: "feedback", item_id: "P1" }, ...base()]);
  assert.equal(report.status, "checks_passed_unqualified");
});

test("required feedback cannot be omitted from an otherwise complete session", () => {
  const f = fixture(); f.policy.item_rules[0].feedback.required = true;
  const events = [answer("Q1", [0]), submit, { type: "score", points: 1 }, { type: "close" }];
  assert.notEqual(audit(f, events).status, "checks_passed_unqualified");
  const withFeedback = [...events.slice(0, -1), { type: "feedback", item_id: "Q1", content: "The source action supports the selected case." }, events.at(-1)];
  assert.equal(audit(f, withFeedback).status, "checks_passed_unqualified");
  assert.equal(audit(fixture(), events).status, "checks_passed_unqualified");
});

test("unrelated or unscoped feedback cannot satisfy another item's required feedback", () => {
  const f = fixture(); f.policy.item_rules[0].feedback.required = true;
  f.items.push(choice("P1", "Practice a different case.")); f.policy.item_rules.push(rule("P1", "spot-check"));
  for (const event of [{ type: "feedback", item_id: "P1", content: "Review the other case." }, { type: "feedback", content: "A response without an item binding." }]) {
    assert.notEqual(audit(f, [answer("Q1", [0]), submit, event, { type: "close" }]).status, "checks_passed_unqualified");
  }
});

test("feedback metadata and empty content do not establish required feedback delivery", () => {
  const f = fixture(); f.policy.item_rules[0].feedback.required = true;
  for (const content of [undefined, null, "", "   ", 42]) {
    const event = { type: "feedback", item_id: "Q1" };
    if (content !== undefined) event.content = content;
    assert.notEqual(audit(f, [answer("Q1", [0]), submit, event, { type: "close" }]).status, "checks_passed_unqualified");
  }
});

test("linked-pair points follow the complete supplied table without closing a wrong gap", () => {
  for (const [pattern, points] of [["00", 0], ["01", 0], ["10", 1], ["11", 2]]) {
    const f = fixture(); f.items.push(choice("Q2", "Choose the supporting case.")); f.policy.item_rules.push(rule("Q2"));
    f.policy.scoring = [{ id: "PAIR", kind: "linked-pair", item_ids: ["Q1", "Q2"], points: { "00": 0, "01": 0, "10": 1, "11": 2 } }];
    const report = audit(f, [answer("Q1", [pattern[0] === "1" ? 0 : 1]), answer("Q2", [pattern[1] === "1" ? 0 : 1]), submit, { type: "score", points }]);
    assert.equal(report.status, "checks_passed_unqualified", pattern); assert.equal(report.points, points);
    assert.equal(report.gaps[0].status, pattern === "11" ? "not-open" : "todo");
  }
});

test("select-n partial points preserve the gap and reject invalid selected indexes", () => {
  const f = fixture(); f.items[0].view.options = ["one", "two", "three", "four"]; f.items[0].view.key = [0, 2];
  f.policy.scoring = [{ id: "SELECT", kind: "select-n", item_ids: ["Q1"], selection_count: 2, points: { "0": 0, "1": 1, "2": 2 } }];
  const report = audit(f, [answer("Q1", [0, 1]), submit, { type: "score", points: 1 }]);
  assert.equal(report.status, "checks_passed_unqualified"); assert.equal(report.gaps[0].status, "todo");
  for (const selected of [[0, 0], [-1, 0], [0, 4]]) {
    assert.equal(audit(f, [answer("Q1", selected), submit, { type: "score", points: 1 }]).status, "needs_revision", JSON.stringify(selected));
  }
});

test("the selected wrong option opens its routed gap while leaving other gaps unopened", () => {
  const f = fixture(); f.items[0].view.options = ["supported case", "first misreading", "second misreading"];
  f.policy.gaps.push({ ...clone(f.policy.gaps[0]), id: "G2", target_refs: ["K2"], bank_item_ids: ["B4"] });
  f.policy.item_rules[0].gap_refs = ["G1", "G2"];
  f.policy.item_rules[0].misconception_routes = [1, 2].map(index => ({ option_ref: `/view/options/${index}`,
    tag: `MISREADING_${index}`, gap_ref: `G${index}`, teach_event_ref: `T${index}` }));
  resolveAssessmentPolicy(f.policy, { items: f.items, targetIds: ["K1", "K2"], eventIds: ["T1", "T2"] });
  for (const selected of [1, 2]) {
    const report = audit(f, [answer("Q1", [selected]), submit]);
    assert.equal(report.status, "checks_passed_unqualified");
    assert.equal(report.gaps.find(gap => gap.id === `G${selected}`).status, "todo");
    assert.equal(report.gaps.find(gap => gap.id === `G${selected === 1 ? 2 : 1}`).status, "not-open");
  }
  const missing = clone(f); missing.policy.item_rules[0].misconception_routes = [];
  const unresolved = audit(missing, [answer("Q1", [1]), submit]);
  assert.equal(unresolved.status, "not_verified");
  assert(verdicts(unresolved, "runtime_misconception_route_resolved").includes("unsure"));
});

test("empty, malformed or missing answers cannot count as complete submitted responses", () => {
  for (const selected of [[], null, "0", [99], [0, 0]]) {
    assert.equal(audit(fixture(), [answer("Q1", selected), submit]).status, "needs_revision", String(selected));
  }
  assert.equal(audit(fixture(), [{ type: "answer", item_id: "Q1" }, submit]).status, "needs_revision");
  hasFail(audit(fixture(), [submit]), "runtime_submission_complete");
});

test("freshness rejects repeated banks, the test item and a shuffled clone of that item", () => {
  const repeated = audit(fixture(), [...base(), bank("B1"), bank("B1")]); hasFail(repeated, "runtime_bank_freshness");
  const original = fixture(); original.policy.gaps[0].bank_item_ids.push("Q1");
  hasFail(audit(original, [...base(), bank("Q1", [0])]), "runtime_bank_freshness");
  const shuffled = fixture(); const copied = clone(shuffled.items[0]); copied.id = "COPY"; copied.view.options.reverse(); copied.view.key = [1];
  shuffled.items.push(copied); shuffled.policy.gaps[0].bank_item_ids.push("COPY");
  hasFail(audit(shuffled, [...base(), bank("COPY", [1])]), "runtime_bank_freshness");
});

test("bank prompt-and-options clones remain reused content under different IDs", () => {
  for (const shuffled of [false, true]) {
    const f = fixture(); f.items[1].view = { prompt: "Which case preserves this feature?", options: ["present", "absent"], key: [0] };
    f.items[2].view = clone(f.items[1].view);
    if (shuffled) { f.items[2].view.options.reverse(); f.items[2].view.key = [1]; }
    hasFail(audit(f, [...base(), bank("B1"), bank("B2", [shuffled ? 1 : 0])]), "runtime_bank_freshness");
  }
});

test("bank use must be declared, follow submission and stop at the confirmed cap", () => {
  hasFail(audit(fixture(), [bank("B1"), ...base()]), "runtime_remediation_after_submit");
  hasFail(audit(fixture(), [...base(), bank("B4")]), "runtime_bank_membership");
  const f = fixture(); f.policy.gaps[0].bank_item_ids.push("B4");
  hasFail(audit(f, [...base(), bank("B1"), bank("B2"), bank("B3"), bank("B4")]), "runtime_bank_limit");
});

test("rejected bank attempts cannot earn a gap-closing streak", () => {
  for (const invalid of [bank("B4"), bank("B1")]) {
    const report = audit(fixture(), [...base(), bank("B1"), invalid, { type: "gap-state", gap_id: "G1", status: "closed" }]);
    assert.equal(report.status, "needs_revision");
    assert.equal(report.gaps[0].streak, 1);
    assert.equal(report.gaps[0].status, "open");
  }
  const notOpened = audit(fixture(), [answer("Q1", [0]), submit, bank("B1"), bank("B2"), { type: "gap-state", gap_id: "G1", status: "closed" }]);
  assert.equal(notOpened.gaps[0].streak, 0);
  assert.equal(notOpened.gaps[0].status, "not-open");
});

test("malformed bank selections fail rather than becoming unknown marking claims", () => {
  for (const selected of [[], [-1], [2], [0, 0], null, "0"]) {
    assert.equal(audit(fixture(), [...base(), bank("B1", selected)]).status, "needs_revision", JSON.stringify(selected));
  }
});

test("wrong bank answers reset the streak and exhausted unresolved banks may be flagged", () => {
  const events = [...base(), bank("B1"), bank("B2", [1]), teach(), bank("B3"), { type: "gap-state", gap_id: "G1", status: "flagged" }, { type: "close" }];
  const report = audit(fixture(), events); assert.equal(report.status, "checks_passed_unqualified");
  assert.equal(report.gaps[0].streak, 1); assert.equal(report.gaps[0].tries, 3); assert.equal(report.gaps[0].status, "flagged");
  const wrongClose = clone(events); wrongClose.at(-2).status = "closed";
  hasFail(audit(fixture(), wrongClose), "runtime_gap_state");
});

test("premature closure or flagging, nonterminal lesson closure and terminal bank retries fail", () => {
  hasFail(audit(fixture(), [...base(), bank("B1"), { type: "gap-state", gap_id: "G1", status: "closed" }]), "runtime_gap_state");
  hasFail(audit(fixture(), [...base(), bank("B1"), { type: "gap-state", gap_id: "G1", status: "flagged" }]), "runtime_gap_state");
  hasFail(audit(fixture(), [...base(), { type: "close" }]), "runtime_close_gaps_terminal");
  hasFail(audit(fixture(), [...base(), bank("B1"), bank("B2"), { type: "gap-state", gap_id: "G1", status: "closed" }, bank("B3")]), "runtime_remediation_terminal");
  hasFail(audit(fixture(), [...base(), { type: "gap-state", gap_id: "G1", status: "invented" }]), "runtime_gap_state");
});

test("gap transitions respect the policy's declared terminal-state choices", () => {
  const f = fixture(); f.policy.remediation.terminal_states = ["flagged"];
  assert.equal(audit(f, [...base(), bank("B1"), bank("B2"), { type: "gap-state", gap_id: "G1", status: "closed" }]).status, "needs_revision");
});

test("declared initial teaching order and correction after a wrong bank response are enforced", () => {
  const f = fixture(); f.policy.remediation.initial_order = "teach-before-retest";
  hasFail(audit(f, [...base(), bank("B1")]), "runtime_teaching_order");
  assert.equal(audit(f, [...base(), teach(), bank("B1")]).status, "checks_passed_unqualified");
  hasFail(audit(fixture(), [...base(), bank("B1", [1]), bank("B2")]), "runtime_teaching_order");
});

test("proposed numeric decisions and unknown teaching order remain unverified", () => {
  const f = fixture(); f.policy.parameters.forEach(row => { row.status = "proposed"; }); f.policy.remediation.initial_order = "unknown";
  const report = audit(f, [...base(), bank("B1"), bank("B2"), { type: "gap-state", gap_id: "G1", status: "closed" }]);
  assert.equal(report.status, "not_verified"); assert.equal(report.qualified, false);
  for (const id of ["runtime_bank_limit", "runtime_streak_rule", "runtime_teaching_order", "runtime_gap_state"]) assert(verdicts(report, id).includes("unsure"));
});

test("diagnostic tags retain their supplied response pattern without establishing learner diagnosis", () => {
  const transfer = audit(fixture(), [...base(), { ...bank("B1"), context: "taught" }, { ...bank("B2", [1]), context: "transfer" }]);
  assert.equal(transfer.gaps[0].diagnostic, "transfer-gap-claim"); assert.equal(transfer.qualified, false);
  const knowledge = audit(fixture(), [...base(), { ...bank("B1", [1]), context: "taught" }]);
  assert.equal(knowledge.gaps[0].diagnostic, "knowledge-gap-claim");
  assert.equal(audit(fixture(), [...base(), { type: "followup", gap_id: "G1" }]).status, "not_verified");
});

test("CER marks require complete components and repairs follow the first failing component", () => {
  const f = writingFixture();
  hasFail(audit(f, [...writingBase(), { type: "writing-score", item_id: "W1", components: { C: true, E: false } }]), "runtime_writing_components");
  hasFail(audit(f, [...writingBase(), mark(false, false, false), fix("E")]), "runtime_writing_repair_order");
  const repaired = audit(f, [...writingBase(), mark(true, false, false), fix("E")]);
  assert.equal(repaired.status, "checks_passed_unqualified");
  const claimGap = audit(f, [...writingBase(true), mark(false, true, true)]);
  assert.equal(claimGap.gaps[0].status, "todo");
});

test("writing marks require an actual response for the configured writing item", () => {
  const report = audit(writingFixture(), [...base(), mark(true, true, true)]);
  hasFail(report, "runtime_writing_response_available");
  assert.equal(report.first_writing_marks, null);
  assert.equal(report.latest_writing_marks, null);
});

test("a second writing mark cannot overwrite the first mark without a submitted fix", () => {
  const f = writingFixture();
  const report = audit(f, [...writingBase(), mark(true, false, true), mark(true, true, false), fix("E")]);
  hasFail(report, "runtime_writing_mark_version");
  assert.deepEqual(verdicts(report, "runtime_writing_repair_order"), ["pass"]);
  assert.deepEqual(report.first_writing_marks, { C: true, E: false, R: true });
  assert.deepEqual(report.latest_writing_marks, { C: true, E: false, R: true });
  const valid = audit(f, [...writingBase(), mark(true, false, true), fix("E"), mark(true, true, true)]);
  assert.equal(valid.status, "checks_passed_unqualified");
  assert.deepEqual(valid.first_writing_marks, { C: true, E: false, R: true });
  assert.deepEqual(valid.latest_writing_marks, { C: true, E: true, R: true });
  const reusedFix = audit(f, [...writingBase(), mark(true, false, true), fix("E"), mark(true, true, true), mark(true, false, true)]);
  hasFail(reusedFix, "runtime_writing_mark_version");
});

test("writing fixes bind a nonempty response rather than only a component label", () => {
  const f = writingFixture();
  for (const response of [undefined, null, "", "   ", 0, false, {}]) {
    const event = { type: "writing-fix", item_id: "W1", component_id: "E" };
    if (response !== undefined) event.response = response;
    assert.equal(audit(f, [...writingBase(), mark(true, false, true), event]).status, "needs_revision", JSON.stringify(response));
  }
  assert.equal(audit(f, [...writingBase(), mark(true, false, true), fix("E", "  A revised response.  ")]).status, "checks_passed_unqualified");
});

test("closing after a submitted writing fix requires a separate re-mark observation", () => {
  const f = writingFixture();
  const events = [...writingBase(true), mark(true, false, true), fix("E")];
  const pending = audit(f, [...events, { type: "close" }]);
  assert.equal(pending.status, "not_verified");
  assert(verdicts(pending, "runtime_writing_remark_supplied").includes("unsure"));
  const remarked = audit(f, [...events, mark(true, true, true), { type: "close" }]);
  assert.equal(remarked.status, "checks_passed_unqualified");
  assert.equal(remarked.marks_independently_validated, false);
});

test("validated AEE and CER role aliases never throw or change claim-failure routing", () => {
  for (const roles of [["C", "E", "R"], ["A", "E1", "E2"], ["answer", "evidence", "explain"]]) {
    const f = writingFixture(true); f.policy.writing.components.forEach((component, i) => { component.role = roles[i]; });
    const validated = resolveAssessmentPolicy(f.policy, { items: f.items, targetIds: ["K1"], eventIds: [] });
    const report = audit({ ...f, policy: validated.policy }, [...writingBase(true), mark(false, true, true)]);
    assert.equal(report.gaps[0].status, "todo", roles.join("/"));
  }
});

test("writing fixes and frame changes must identify the configured writing item", () => {
  const f = writingFixture();
  for (const item_id of ["W2", undefined]) {
    assert.equal(audit(f, [...writingBase(), mark(true, false, true), { ...fix("E"), item_id }]).status, "needs_revision");
    assert.equal(audit(f, [...base(), { type: "frame-change", item_id, from: 0, to: 1 }]).status, "needs_revision");
  }
});

test("checkpoint writing marks and repairs cannot occur before the protected submission", () => {
  const f = writingFixture(); f.policy.item_rules[1] = rule("W1");
  assert.equal(audit(f, [mark(true, false, false), answer(), submit]).status, "needs_revision");
  assert.equal(audit(f, [mark(true, false, false), fix("E"), answer(), submit]).status, "needs_revision");
});

test("rejected pre-submit writing marks cannot populate first marks or open a claim gap", () => {
  const f = writingFixture(); f.policy.item_rules[1] = rule("W1");
  const report = audit(f, [answer("Q1", [0]), writingAnswer(), mark(false, false, false), submit]);
  hasFail(report, "runtime_writing_mark_timing");
  assert.equal(report.first_writing_marks, null);
  assert.equal(report.latest_writing_marks, null);
  assert.equal(report.gaps[0].status, "not-open");
});

test("writing models use a different question, redrafts are capped and frame changes are bounded", () => {
  const f = writingFixture();
  hasFail(audit(f, [...base(), { type: "model", item_id: "W1" }]), "runtime_writing_model_is_different");
  assert.equal(audit(f, [...base(), { type: "model", item_id: "W2" }]).status, "checks_passed_unqualified");
  hasFail(audit(f, [...writingBase(), mark(true, false, false), fix("E"),
    mark(true, true, false), fix("R")]), "runtime_writing_redraft_limit");
  assert.equal(audit(f, [...base(), { type: "frame-change", item_id: "W1", from: 0, to: 1 }]).status, "checks_passed_unqualified");
  for (const changes of [[{ from: 0, to: 2 }], [{ from: 0, to: 1 }, { from: 1, to: 0 }], [{ from: 0, to: 3 }], [{ from: -1, to: 0 }]]) {
    hasFail(audit(f, [...base(), ...changes.map(change => ({ type: "frame-change", item_id: "W1", ...change }))]), "runtime_frame_change_bound");
  }
});

test("invalid pins, shape, versions and references fail without authenticating runtime evidence", () => {
  const f = fixture();
  for (const changes of [{ policy_sha256: "0".repeat(64) }, { context_sha256: "0".repeat(64) }, { set_sha256: "0".repeat(64) },
    { version: "assessment-trace/9" }, { session_id: " " }, { events: {} }]) assert.equal(audit(f, base(), changes).status, "needs_revision");
  for (const event of [null, { type: "invented" }, { type: "submit", id: "" }, { type: "submit", order: 0 },
    { type: "feedback", item_id: "MISSING" }, { type: "teach", gap_id: "MISSING" }]) {
    assert.equal(audit(f, [event, ...base()]).status, "needs_revision", JSON.stringify(event));
  }
  hasFail(audit(f, [answer(), { ...submit, id: "E1" }]), "runtime_event_shape");
  hasFail(audit(f, [answer(), { ...submit, order: 1 }]), "runtime_event_shape");
});

test("missing trace or submission stays unverified while missing policy fails", () => {
  const f = fixture();
  for (const trace of [undefined, null]) {
    const report = auditAssessmentTrace({ ...f, trace, contextSha256, setSha256 });
    assert.equal(report.status, "not_verified"); assert.equal(report.supplied, false); assert.equal(report.qualified, false);
  }
  assert.equal(audit(f, [answer()]).status, "not_verified");
  const trace = { version: "assessment-trace/0.1", session_id: "synthetic-session", events: [] };
  assert.equal(auditAssessmentTrace({ trace, contextSha256, setSha256 }).status, "needs_revision");
});

test("partial event consistency does not claim complete session coverage", () => {
  const report = audit(fixture(), base());
  assert.equal(report.status, "checks_passed_unqualified");
  assert.equal(report.gaps[0].status, "todo");
  assert.equal(report.session_complete, false);
  assert.match(report.coverage, /supplied events only/i);
  assert.match(report.coverage, /missing continuation is not checked/i);
});
