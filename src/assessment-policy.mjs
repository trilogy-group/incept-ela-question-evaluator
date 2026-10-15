// Supplied, scoped assessment rules. Field checks do not establish teaching quality or authority.
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value, key) => object(value) && Object.hasOwn(value, key);
const clone = value => structuredClone(value);
export class AssessmentPolicyError extends Error {
  constructor(code, field) { super(`assessment policy: ${code} (${field})`); this.name = "AssessmentPolicyError"; this.code = code; this.field = field; }
}
const need = (ok, code, field) => { if (!ok) throw new AssessmentPolicyError(code, field); };
function text(value, field) { need(typeof value === "string" && value.trim().length > 0, "invalid_text", field); return value; }
function shape(value, required, optional, field) {
  need(object(value), "invalid_object", field);
  need(required.every(key => own(value, key)), "missing_field", field);
  need(Object.keys(value).every(key => required.includes(key) || optional.includes(key)), "unknown_field", field);
}
function list(value, field) { need(Array.isArray(value), "invalid_list", field); return value; }
function texts(value, field) {
  const rows = list(value, field).map((row, i) => text(row, `${field}/${i}`));
  need(new Set(rows).size === rows.length, "duplicate_reference", field); return rows;
}
function member(value, allowed, field) { text(value, field); need(allowed.includes(value), "unsupported_value", field); return value; }
function boolean(value, field) { need(typeof value === "boolean", "invalid_boolean", field); }
function refs(value, allowed, field) { const rows = texts(value, field); need(rows.every(ref => allowed.has(ref)), "unknown_reference", field); return rows; }
function unique(rows, key, field) {
  const seen = new Set();
  for (const [i, row] of list(rows, field).entries()) {
    need(object(row), "invalid_object", `${field}/${i}`); const id = text(row[key], `${field}/${i}/${key}`);
    need(!seen.has(id), "duplicate_id", `${field}/${i}/${key}`); seen.add(id);
  }
  return seen;
}
function ids(value, field) {
  need(value instanceof Set || Array.isArray(value), "invalid_reference_context", field);
  return new Set([...value].map((row, i) => text(row, `${field}/${i}`)));
}
const ROLE_ALIASES = Object.freeze({ claim: "claim", answer: "claim", C: "claim", A: "claim",
  evidence: "evidence", E: "evidence", E1: "evidence", reasoning: "reasoning", explain: "reasoning", explanation: "reasoning", R: "reasoning", E2: "reasoning" });
function requirementField(item, pointer) {
  const match = /^\/view\/rubric\/criteria\/(0|[1-9][0-9]*)\/requirement$/.exec(pointer);
  return match ? item.view?.rubric?.criteria?.[Number(match[1])]?.requirement : undefined;
}
function choiceOptions(item) {
  const choices = ["options", "candidates"].filter(field => Array.isArray(item.view?.[field]));
  if (choices.length !== 1) return null;
  const field = choices[0];
  return item.view[field].map((value, index) => ({ ref: `/view/${field}/${index}`, index, value }));
}
function declaredChoiceKey(item) {
  const options = choiceOptions(item), key = item.view?.key;
  return options && Array.isArray(key) && key.length > 0 && new Set(key).size === key.length
    && key.every(index => Number.isInteger(index) && index >= 0 && index < options.length) ? key : null;
}

/** Resolve candidate policy declarations only. No I/O, defaults, trace evidence or model calls. */
export function resolveAssessmentPolicy(value, { items = [], eventIds = [], targetIds = [] } = {}) {
  if (value === undefined) return null;
  const policy = clone(value), base = "assessment_policy";
  shape(policy, ["version", "id", "provenance", "parameters", "item_rules", "gaps"], ["remediation", "writing", "scoring"], base);
  need(policy.version === "assessment-policy/0.1", "unsupported_version", `${base}/version`); text(policy.id, `${base}/id`);
  shape(policy.provenance, ["status", "source_ref", "revision"], [], `${base}/provenance`);
  member(policy.provenance.status, ["proposed", "course-declared"], `${base}/provenance/status`);
  text(policy.provenance.source_ref, `${base}/provenance/source_ref`); text(policy.provenance.revision, `${base}/provenance/revision`);
  need(Array.isArray(items), "invalid_reference_context", "items"); unique(items, "id", "items");
  const itemMap = new Map(items.map(item => [item.id, item])), itemIds = new Set(itemMap.keys());
  const events = ids(eventIds, "eventIds"), targets = ids(targetIds, "targetIds");
  const parameters = unique(policy.parameters, "id", `${base}/parameters`), parameterMap = new Map();
  for (const [i, row] of policy.parameters.entries()) {
    const field = `${base}/parameters/${i}`;
    shape(row, ["id", "value", "status", "source_ref"], [], field);
    member(row.status, ["confirmed", "proposed", "unknown"], `${field}/status`); text(row.source_ref, `${field}/source_ref`);
    need(row.value === null || typeof row.value === "boolean" || typeof row.value === "string" || typeof row.value === "number" && Number.isFinite(row.value), "invalid_parameter_value", `${field}/value`);
    need(row.status !== "confirmed" || row.value !== null, "confirmed_parameter_missing_value", `${field}/value`);
    parameterMap.set(row.id, row);
  }
  const gapIds = unique(policy.gaps, "id", `${base}/gaps`);
  for (const [i, row] of policy.gaps.entries()) {
    const field = `${base}/gaps/${i}`;
    shape(row, ["id", "target_refs", "category", "prerequisite_refs", "bank_item_ids", "teach_card"], [], field);
    refs(row.target_refs, targets, `${field}/target_refs`); text(row.category, `${field}/category`);
    refs(row.prerequisite_refs, targets, `${field}/prerequisite_refs`); refs(row.bank_item_ids, itemIds, `${field}/bank_item_ids`);
    shape(row.teach_card, ["form", "rule", "positive", "negative", "difference"], [], `${field}/teach_card`);
    member(row.teach_card.form, ["single-feature", "feature-list", "confused-pair", "unknown"], `${field}/teach_card/form`);
    for (const fieldName of ["rule", "positive", "negative", "difference"]) text(row.teach_card[fieldName], `${field}/teach_card/${fieldName}`);
  }
  unique(policy.item_rules, "item_id", `${base}/item_rules`);
  for (const [i, row] of policy.item_rules.entries()) {
    const field = `${base}/item_rules/${i}`;
    shape(row, ["item_id", "moment", "feedback", "score_basis", "support", "gap_refs", "misconception_routes"], [], field);
    need(itemIds.has(row.item_id), "unknown_reference", `${field}/item_id`);
    member(row.moment, ["acquisition", "spot-check", "checkpoint-test", "review-practice", "mastery-gate"], `${field}/moment`);
    shape(row.feedback, ["timing", "required", "elaboration"], [], `${field}/feedback`);
    member(row.feedback.timing, ["immediate", "after-submit", "guide", "unknown"], `${field}/feedback/timing`);
    boolean(row.feedback.required, `${field}/feedback/required`);
    member(row.feedback.elaboration, ["explanation", "correct-answer", "right-wrong", "unknown"], `${field}/feedback/elaboration`);
    member(row.score_basis, ["first-submission", "practice-only", "unknown"], `${field}/score_basis`);
    shape(row.support, ["frame_policy", "allowed_tool_refs"], [], `${field}/support`);
    member(row.support.frame_policy, ["none", "declared-rung", "unknown"], `${field}/support/frame_policy`);
    texts(row.support.allowed_tool_refs, `${field}/support/allowed_tool_refs`); refs(row.gap_refs, gapIds, `${field}/gap_refs`);
    const optionRefs = new Set((choiceOptions(itemMap.get(row.item_id)) ?? []).map(option => option.ref));
    unique(row.misconception_routes, "option_ref", `${field}/misconception_routes`);
    for (const [j, route] of row.misconception_routes.entries()) {
      const routeField = `${field}/misconception_routes/${j}`;
      shape(route, ["option_ref", "tag", "gap_ref", "teach_event_ref"], [], routeField);
      need(optionRefs.has(route.option_ref), "unknown_option_reference", `${routeField}/option_ref`); text(route.tag, `${routeField}/tag`);
      need(row.gap_refs.includes(route.gap_ref), "unknown_reference", `${routeField}/gap_ref`);
      need(events.has(route.teach_event_ref), "unknown_reference", `${routeField}/teach_event_ref`);
    }
  }
  if (own(policy, "scoring")) {
    unique(policy.scoring, "id", `${base}/scoring`);
    const groupedItems = new Set();
    for (const [i, row] of policy.scoring.entries()) {
      const field = `${base}/scoring/${i}`;
      shape(row, ["id", "kind", "item_ids", "points"], ["selection_count"], field);
      member(row.kind, ["linked-pair", "select-n"], `${field}/kind`);
      const scoredItems = refs(row.item_ids, itemIds, `${field}/item_ids`);
      need(scoredItems.every(id => !groupedItems.has(id)), "overlapping_scoring_groups", `${field}/item_ids`);
      scoredItems.forEach(id => groupedItems.add(id));
      shape(row.points, [], Object.keys(row.points ?? {}), `${field}/points`);
      let pointKeys;
      if (row.kind === "linked-pair") {
        need(scoredItems.length === 2 && !own(row, "selection_count"), "invalid_scoring_shape", field);
        pointKeys = ["00", "01", "10", "11"];
      } else {
        need(scoredItems.length === 1 && Number.isInteger(row.selection_count) && row.selection_count > 0, "invalid_scoring_shape", field);
        const options = choiceOptions(itemMap.get(scoredItems[0]));
        need(options && row.selection_count <= options.length, "invalid_selection_count", `${field}/selection_count`);
        pointKeys = Array.from({ length: row.selection_count + 1 }, (_, index) => String(index));
      }
      need(Object.keys(row.points).length === pointKeys.length && pointKeys.every(key => own(row.points, key)), "incomplete_points_table", `${field}/points`);
      need(Object.values(row.points).every(points => typeof points === "number" && Number.isFinite(points) && points >= 0), "invalid_points", `${field}/points`);
    }
  }
  const parameterUse = [];
  function parameter(ref, field, minimum, itemId = null) {
    text(ref, field); need(parameters.has(ref), "unknown_reference", field);
    const row = parameterMap.get(ref);
    if (row.value !== null) need(Number.isInteger(row.value) && row.value >= minimum, "invalid_parameter_value", field);
    parameterUse.push({ id: ref, item_id: itemId, field, status: row.status });
    return row;
  }
  if (own(policy, "remediation")) {
    const row = policy.remediation, field = `${base}/remediation`;
    shape(row, ["streak_parameter_ref", "bank_limit_parameter_ref", "initial_order", "wrong_resets_streak", "terminal_states", "fresh_items_required"], [], field);
    parameter(row.streak_parameter_ref, `${field}/streak_parameter_ref`, 1); parameter(row.bank_limit_parameter_ref, `${field}/bank_limit_parameter_ref`, 1);
    member(row.initial_order, ["teach-before-retest", "retest-before-teach", "unknown"], `${field}/initial_order`);
    boolean(row.wrong_resets_streak, `${field}/wrong_resets_streak`); boolean(row.fresh_items_required, `${field}/fresh_items_required`);
    const states = texts(row.terminal_states, `${field}/terminal_states`);
    need(states.length > 0 && states.every(state => ["closed", "flagged"].includes(state)), "unsupported_value", `${field}/terminal_states`);
  }
  const componentRoles = [];
  if (own(policy, "writing")) {
    const row = policy.writing, field = `${base}/writing`;
    shape(row, ["item_id", "components", "repair_order", "claim_failure_gap_ref", "conventions_scored", "frame"], ["max_redrafts_parameter_ref"], field);
    need(itemIds.has(row.item_id), "unknown_reference", `${field}/item_id`); unique(row.components, "id", `${field}/components`);
    for (const [i, component] of row.components.entries()) {
      const cfield = `${field}/components/${i}`;
      shape(component, ["id", "role", "requirement_ref"], [], cfield);
      member(component.role, Object.keys(ROLE_ALIASES), `${cfield}/role`); text(component.requirement_ref, `${cfield}/requirement_ref`);
      componentRoles.push({ id: component.id, role: ROLE_ALIASES[component.role], declared_role: component.role, requirement_ref: component.requirement_ref });
    }
    refs(row.repair_order, new Set(row.components.map(component => component.id)), `${field}/repair_order`);
    need(gapIds.has(row.claim_failure_gap_ref), "unknown_reference", `${field}/claim_failure_gap_ref`);
    boolean(row.conventions_scored, `${field}/conventions_scored`);
    shape(row.frame, ["mode", "rungs"], ["max_change_parameter_ref", "fade_success_parameter_ref"], `${field}/frame`);
    member(row.frame.mode, ["none", "ladder", "unknown"], `${field}/frame/mode`); texts(row.frame.rungs, `${field}/frame/rungs`);
    if (own(row.frame, "max_change_parameter_ref")) parameter(row.frame.max_change_parameter_ref, `${field}/frame/max_change_parameter_ref`, 0, row.item_id);
    if (own(row.frame, "fade_success_parameter_ref")) parameter(row.frame.fade_success_parameter_ref, `${field}/frame/fade_success_parameter_ref`, 1, row.item_id);
    if (own(row, "max_redrafts_parameter_ref")) parameter(row.max_redrafts_parameter_ref, `${field}/max_redrafts_parameter_ref`, 0, row.item_id);
  }

  const checks = [], holds = [], requirements = [];
  const add = (id, verdict, evidence) => checks.push({ id: `assessment_policy_${id}`, verdict, evidence });
  const hold = (reason, itemId = null) => { if (!holds.some(row => row.reason === reason && (row.item_id ?? null) === itemId)) holds.push({ ...(itemId ? { item_id: itemId } : {}), reason }); };
  function requirement(id, question, itemIds = [], moments = []) {
    requirements.push({ id: `assessment_policy_${id}`, question, source_ref: policy.provenance.source_ref,
      scope: { policy_id: policy.id, item_ids: itemIds, moments, provenance_status: policy.provenance.status, authority: "supplied declaration; not authenticated academic authority" } });
  }
  add("provenance_retained", "pass", { ...policy.provenance, meaning: "Supplied attribution and revision only; authority and source claims are unverified." });
  if (policy.provenance.status === "proposed") hold("assessment_policy_proposed");
  for (const row of policy.parameters) if (row.status !== "confirmed") {
    const uses = parameterUse.filter(use => use.id === row.id);
    if (uses.length) for (const use of uses) hold(`assessment_policy_parameter_${row.id}_${row.status}`, use.item_id);
  }
  add("parameter_decisions", parameterUse.some(row => row.status !== "confirmed") ? "unsure" : "pass",
    { used_parameters: parameterUse, meaning: "Confirmed means declared resolved, not evidence that its value improves learning." });
  for (const [i, row] of (policy.scoring ?? []).entries()) {
    add(`scoring_${i + 1}_table`, "pass", { scoring_id: row.id, kind: row.kind, item_ids: row.item_ids,
      meaning: "Explicit complete point table and references only; score and gap states remain separate, and author keys are unvalidated intent." });
    const supported = row.kind === "linked-pair" ? row.item_ids.every(id => {
      const item = itemMap.get(id), key = declaredChoiceKey(item);
      return key?.length === 1 && (item.view?.response_rule === undefined || item.view.response_rule === "single-best");
    }) : (() => {
      const item = itemMap.get(row.item_ids[0]), key = declaredChoiceKey(item), view = item.view ?? {};
      const counts = ["select_count", "selection_count", "count", "pick"].filter(field => own(view, field)).map(field => view[field]);
      const ruleSupported = view.response_rule === undefined || ["select-n", "choose-n", "multi-select", "exactly-n"].includes(view.response_rule)
        || view.response_rule === "single-best" && row.selection_count === 1;
      return key?.length === row.selection_count && counts.every(count => Number.isInteger(count) && count === row.selection_count) && ruleSupported;
    })();
    add(`scoring_${i + 1}_author_response`, supported ? "pass" : "unsure", { scoring_id: row.id, item_ids: row.item_ids,
      meaning: "Supported supplied choice-key shape and explicit count agreement only; author keys are not validated correctness labels." });
    if (!supported) for (const itemId of row.item_ids) hold(`assessment_policy_scoring_${row.id}_response_unresolved`, itemId);
    requirement(`scoring_${i + 1}_fit`, "Does this supplied scoring table reflect what the linked parts or selections actually demonstrate under the declared purpose? Do not infer gap closure, mastery or independent marking accuracy from a point total.", row.item_ids);
  }
  for (const [i, row] of policy.item_rules.entries()) {
    const prefix = `item_${i + 1}`, item = itemMap.get(row.item_id), options = choiceOptions(item);
    const practice = ["acquisition", "spot-check", "review-practice"].includes(row.moment);
    const timing = row.feedback.timing === "unknown" ? "unsure" : row.moment === "review-practice" ? ["immediate", "after-submit"].includes(row.feedback.timing) ? "pass" : "fail" : practice ? row.feedback.timing === "immediate" ? "pass" : "fail"
      : row.moment === "checkpoint-test" ? row.feedback.timing === "after-submit" ? "pass" : "fail" : ["after-submit", "guide"].includes(row.feedback.timing) ? "pass" : "fail";
    add(`${prefix}_feedback_timing`, timing, { item_id: row.item_id, moment: row.moment, declared_timing: row.feedback.timing, meaning: "Consistency with the declared moment contract only; no universal feedback-timing claim." });
    if (timing !== "pass") hold(`assessment_policy_feedback_timing_${timing}`, row.item_id);
    const basis = row.score_basis === "unknown" ? "unsure" : row.score_basis === (practice ? "practice-only" : "first-submission") ? "pass" : "fail";
    add(`${prefix}_score_basis`, basis, { item_id: row.item_id, moment: row.moment, declared_basis: row.score_basis });
    if (basis !== "pass") hold(`assessment_policy_score_basis_${basis}`, row.item_id);
    for (const [field, decision] of [["feedback_elaboration", row.feedback.elaboration], ["frame_policy", row.support.frame_policy]]) if (decision === "unknown") hold(`assessment_policy_${field}_unknown`, row.item_id);
    if (options) {
      const key = declaredChoiceKey(item), keyKnown = key !== null;
      const expected = keyKnown ? options.filter(option => !key.includes(option.index)).map(option => option.ref) : [];
      const actual = row.misconception_routes.map(route => route.option_ref);
      const covered = keyKnown && expected.every(ref => actual.includes(ref)) && actual.every(ref => expected.includes(ref));
      add(`${prefix}_misconception_routes`, !keyKnown ? "unsure" : covered ? "pass" : "fail", { item_id: row.item_id,
        missing: expected.filter(ref => !actual.includes(ref)), unexpected: keyKnown ? actual.filter(ref => !expected.includes(ref)) : [],
        key_status: "unvalidated author intent only", meaning: "Route coverage and references only; misconception accuracy needs semantic review." });
      if (!keyKnown || !covered) hold(`assessment_policy_misconception_routes_${keyKnown ? "incomplete" : "unknown"}`, row.item_id);
    }
    requirement(`${prefix}_feedback_fit`, "Does the supplied feedback policy fit this declared instructional moment and its measurement claims, given the actual task, support and available learner context? For review practice, assess the adopted course choice of timing; do not impose immediate feedback. Missing context or unresolved decisions require uncertainty.", [row.item_id], [row.moment]);
    if (row.moment === "acquisition") requirement(`${prefix}_acquisition_sequence`, "For this declared acquisition moment, does the supplied ordered teaching introduce the rule, model qualifying and nonqualifying instances in a suitable form, and then ask the learner to apply it to fresh cases? Missing required teaching or context means unsure; a successful recognition item alone does not establish acquisition.", [row.item_id], [row.moment]);
  }
  const checkpointItems = policy.item_rules.filter(row => row.moment === "checkpoint-test").map(row => row.item_id);
  if (checkpointItems.length) requirement("checkpoint_context", "Does the supplied checkpoint passage fit the adopted course requirements and, where new-context transfer is claimed, require the taught concepts through new content rather than a copied lesson scene? Judge novelty only against supplied prior materials; unknown learner exposure stays unknown. Do not invent a genre requirement or claim independent transfer from question format alone.", checkpointItems, ["checkpoint-test"]);
  if (policy.gaps.length) {
    if (!policy.remediation) hold("assessment_policy_remediation_missing");
    for (const [i, gap] of policy.gaps.entries()) {
      if (!gap.target_refs.length) hold(`assessment_policy_gap_${gap.id}_targets_missing`);
      if (!gap.bank_item_ids.length) hold(`assessment_policy_gap_${gap.id}_bank_missing`);
      if (gap.teach_card.form === "unknown") hold(`assessment_policy_gap_${gap.id}_teaching_form_unknown`);
      add(`gap_${i + 1}_references`, gap.target_refs.length && gap.bank_item_ids.length ? "pass" : "unsure", { gap_ref: gap.id,
        bank_items: gap.bank_item_ids.length, meaning: "References exist; fresh content, prerequisite validity and transfer are unverified." });
    }
    const correctedItems = policy.item_rules.filter(row => row.gap_refs.length).map(row => row.item_id);
    requirement("concept_operation", "Where the supplied target explicitly requires identifying a concept label from evidence, does the task demand that operation, offer relevant labels, and avoid giving the label in its stem or substituting bare yes/no recognition? Do not infer that target from an item name or impose it on other tasks. Judge word-in-context and evidence-selection tasks by their own declared operations.", correctedItems);
    requirement("corrective_design", "Do the actual corrective explanations, contrasted examples, misconception routes, prerequisites and fresh practice tasks address the stated gaps without creating a new misconception? For the declared teaching form, do contrast examples isolate the intended distinction while holding irrelevant features steady, with later examples varying irrelevant context? For categories inspect defining features and what each nonexample omits; for confused terms inspect the taught distinction. Matching references and tags alone cannot establish this.", correctedItems);
  }
  if (policy.remediation) {
    if (policy.remediation.initial_order === "unknown") hold("assessment_policy_remediation_order_unknown");
    const exit = policy.remediation.terminal_states.includes("flagged");
    add("remediation_bounded_exit", exit ? "pass" : "fail", { terminal_states: policy.remediation.terminal_states, meaning: "Declared flag exit only; served transition behaviour requires a bound event trace." });
    if (!exit) hold("assessment_policy_remediation_exit_missing");
    requirement("remediation_fit", "Are this supplied correction order, success streak, bank limit, stopping rule and follow-up claims justified for the stated purpose? Distinguish practice success from a later independent response and preserve unresolved design decisions.");
  }
  if (policy.writing) {
    const writing = policy.writing, item = itemMap.get(writing.item_id), roles = componentRoles.map(row => row.role);
    const complete = ["claim", "evidence", "reasoning"].every(role => roles.filter(value => value === role).length === 1) && roles.length === 3;
    add("writing_components", complete ? "pass" : "fail", { item_id: writing.item_id, component_roles: componentRoles,
      meaning: "Role aliases only; distinct rubric requirements are preserved and their adequacy is unverified." });
    if (!complete) hold("assessment_policy_writing_components_incomplete", writing.item_id);
    const requirementRefs = componentRoles.map(row => row.requirement_ref);
    const fieldStatus = new Set(requirementRefs).size === requirementRefs.length && componentRoles.every(row => typeof requirementField(item, row.requirement_ref) === "string" && requirementField(item, row.requirement_ref).trim());
    add("writing_requirement_fields", fieldStatus ? "pass" : "fail", { item_id: writing.item_id,
      requirement_refs: requirementRefs, meaning: "Each component points to a distinct supplied rubric requirement field; the rubric is not a qualified marker." });
    if (!fieldStatus) hold("assessment_policy_writing_requirement_fields_invalid", writing.item_id);
    const claim = componentRoles.find(row => row.role === "claim"), ordered = writing.repair_order.length === componentRoles.length && componentRoles.every(row => writing.repair_order.includes(row.id)) && writing.repair_order[0] === claim?.id;
    add("writing_repair_order", ordered ? "pass" : "fail", { item_id: writing.item_id, repair_order: writing.repair_order, meaning: "Declared claim-first component order only; trace and semantic review are separate." });
    if (!ordered) hold("assessment_policy_writing_repair_order_invalid", writing.item_id);
    const frame = writing.frame, frameKnown = frame.mode === "none" ? frame.rungs.length === 0 : frame.mode === "ladder" ? frame.rungs.length > 0 && own(frame, "max_change_parameter_ref") && own(frame, "fade_success_parameter_ref") : false;
    add("writing_frame_decisions", frameKnown ? "pass" : "unsure", { item_id: writing.item_id, frame_mode: frame.mode, conventions_scored: writing.conventions_scored });
    if (!frameKnown) hold("assessment_policy_writing_frame_decisions_unresolved", writing.item_id);
    requirement("writing_response", "Do the actual writing task and separate component requirements demand an accurate claim, appropriate evidence and reasoning that connects them? Check whether component repairs, claim-error routing, conventions and the declared support fit this stage. Role labels and a model response are insufficient evidence.", [writing.item_id]);
    requirement("writing_support", "Does the supplied frame policy preserve what this writing response claims to measure, and are any redraft, model, fading and frame-change rules justified and bounded? Do not treat supported success as independent production or infer a universal frame ladder.", [writing.item_id]);
  }
  const itemPolicies = policy.item_rules.map(row => ({ ...clone(row), holds: holds.filter(held => !held.item_id || held.item_id === row.item_id).map(held => held.reason),
    ...(policy.writing?.item_id === row.item_id ? { writing: clone(policy.writing), component_roles: clone(componentRoles) } : {}) }));
  return { policy, checks, holds, item_policies: itemPolicies, requirements };
}
