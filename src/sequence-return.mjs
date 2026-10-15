// Check returned design declarations and field bindings, never their educational sufficiency.
import crypto from "node:crypto";
import { resolvePointer } from "./packet.mjs";

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value, key) => object(value) && Object.hasOwn(value, key);
const string = value => typeof value === "string" && value.trim().length > 0;
const ordered = value => Array.isArray(value) ? value.map(ordered) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
const canonical = value => JSON.stringify(ordered(value));
const equal = (left, right) => canonical(left) === canonical(right);
const hash = value => crypto.createHash("sha256").update(canonical(value), "utf8").digest("hex");
const strings = value => Array.isArray(value) && value.every(string);
const unique = values => new Set(values).size === values.length;
function pick(row, fields, lists = []) {
  return object(row) ? Object.fromEntries([...fields.filter(field => typeof row[field] === "string").map(field => [field, row[field]]),
    ...lists.filter(field => strings(row[field])).map(field => [field, [...row[field]]])]) : {};
}
function publicReturn(value) {
  if (!object(value)) return null;
  return { ...pick(value, ["plan_id", "context_sha256"]),
    lesson: pick(value.lesson, ["purpose", "scope", "objective", "purpose_note"], ["goal_refs"]),
    goal_authority: Array.isArray(value.goal_authority) ? value.goal_authority.map(row => pick(row, ["goal_ref", "kind", "note"], ["source_refs"])) : [],
    items: Array.isArray(value.items) ? value.items.map(row => ({ ...pick(row, ["item_id", "purpose", "scope", "measurement_intent"], ["context_event_refs"]),
      support: pick(row?.support, ["mode", "answer_exposure"], ["event_refs", "source_refs"]),
      expected_evidence: Array.isArray(row?.expected_evidence) ? row.expected_evidence.map(evidence => pick(evidence, ["expectation_id", "claim"], ["field_refs"])) : [] })) : [],
    goal_coverage: Array.isArray(value.goal_coverage) ? value.goal_coverage.map(row => pick(row, ["goal_ref"], ["item_ids"])) : [],
    support_transitions: Array.isArray(value.support_transitions) ? value.support_transitions.map(row => pick(row, ["from_item_id", "to_item_id", "reason"])) : [] };
}
function contextPayload(request, native, fallback = true) {
  const get = field => own(request, field) ? request[field] : fallback ? native?.[field] : undefined;
  return { course_context: get("course_context"), student_context: get("student_context") ?? null,
    sequence_blueprint: get("sequence_blueprint"), source_provenance: get("source_provenance") ?? null };
}

// Recognize only fields consumed as task/response requirements by the route's interpreter.
// Exact leaf paths keep a mixed object (for example a rubric with accepted answers and nudges)
// from borrowing the role of its requirement field. This is not evidence of learner production.
function responseContractFields(context, set, item) {
  const view = item.view, fields = new Set();
  if (context.contract !== "lesson-context 0.1" || !object(view)) return null;
  const scalar = (field, root = view, prefix = "/view") => { if (string(root?.[field])) fields.add(`${prefix}/${field}`); };
  const list = (field, root = view, prefix = "/view") => {
    if (strings(root?.[field])) root[field].forEach((value, index) => { if (string(value)) fields.add(`${prefix}/${field}/${index}`); });
  };
  const rows = (field, columns) => {
    if (Array.isArray(view[field])) view[field].forEach((row, index) => {
      if (object(row)) columns.forEach(column => scalar(column, row, `/view/${field}/${index}`));
    });
  };
  const rubric = () => {
    if (object(view.rubric) && Array.isArray(view.rubric.criteria)) view.rubric.criteria.forEach((row, index) => {
      if (object(row)) scalar("requirement", row, `/view/rubric/criteria/${index}`);
    });
  };
  if (set.contract === "question-set native 0.2"
    && set.adapter_extension === "native-activity-transport/0.2" && context.adapter_extension === set.adapter_extension) {
    const family = item.family;
    if (!["single_choice", "multiple_select", "evidence_selection", "word_selection", "classification", "written_response", "oral_response",
      "word_web", "inline_choice", "shared_cloze", "matching", "sequence", "nonresponse", "say_back", "self_report"].includes(family)) return null;
    if (family === "nonresponse") {
      // An instruction without a response operation cannot supply an expected-response binding.
      return fields;
    }
    scalar("prompt"); scalar("response_mode"); list("response_parts");
    if (["single_choice", "multiple_select", "evidence_selection", "word_selection"].includes(family)) {
      list("options"); scalar("selection_rule");
      if (family === "evidence_selection") scalar("claim");
    }
    if (family === "classification") { rows("entries", ["text"]); rows("categories", ["label", "entity", "relation", "description"]); }
    if (["written_response", "oral_response", "word_web"].includes(family)) rubric();
    if (family === "inline_choice") {
      scalar("surrounding_text");
      if (Array.isArray(view.blanks)) view.blanks.forEach((row, index) => { if (object(row)) list("options", row, `/view/blanks/${index}`); });
    }
    if (family === "shared_cloze") { scalar("surrounding_text"); scalar("reuse_policy"); rows("bank", ["text"]); }
    if (["matching", "sequence"].includes(family)) rows("entries", ["text"]);
    if (family === "matching") rows("options", ["text"]);
    if (family === "sequence") { scalar("ordering_rule"); scalar("tie_policy"); }
    if (family === "word_web") { scalar("centre"); scalar("link_rule"); }
    if (family === "say_back") scalar("statement");
    if (family === "self_report") list("scale");
    return fields;
  }
  if (set.contract !== "question-set 0.1" || set.adapter_extension !== undefined || context.adapter_extension !== undefined || item.family !== undefined) return null;
  if (!["reading_mcq", "evidence_select", "classify", "open_check", "open_prompt"].includes(item.kind)) return null;
  if (["reading_mcq", "evidence_select"].includes(item.kind)
    && (view.response_rule !== undefined && view.response_rule !== "single-best" || Array.isArray(view.key) && view.key.length > 1)) return null;
  if (item.kind === "classify" && (view.response_rule !== undefined && view.response_rule !== "unique-category"
    || object(view.mapping) && Object.values(view.mapping).some(Array.isArray))) return null;
  // This is the same stem/prompt precedence as the text blind-solving packet.
  scalar(view.stem == null ? "prompt" : "stem");
  if (item.kind === "reading_mcq") list("options");
  if (item.kind === "evidence_select") { list("candidates"); scalar("selection_rule"); }
  if (item.kind === "classify") { rows("entries", ["text"]); rows("categories", ["label", "description"]); }
  if (["open_check", "open_prompt"].includes(item.kind)) rubric();
  return fields;
}

export function inspectSequenceReturn({ request = {}, context = {}, set = {} } = {}) {
  const native = object(context.native) ? context.native : {}, setPresent = own(set, "sequence_plan"), contextPresent = own(native, "sequence_plan");
  if (!setPresent && !contextPresent) return { status: "absent", checks: [], declared_sequence_plan: null, qualification: false,
    meaning: "Legacy packet with no returned sequence declaration; this does not establish complete instructional context." };
  const returned = set.sequence_plan, nativeReturn = native.sequence_plan, payload = contextPayload(request, native);
  const plan = payload.course_context?.instructional_plan, actual = Array.isArray(set.items) ? set.items : [];
  const checks = [], add = (id, ok, evidence) => checks.push({ id, verdict: ok ? "pass" : "fail", evidence });
  const copiesMatch = setPresent && contextPresent && object(returned) && object(nativeReturn) && equal(returned, nativeReturn);
  add("sequence_return_copies_match", copiesMatch, { set_present: setPresent, context_present: contextPresent });

  let matches = object(returned) && object(plan) && plan.version === "instructional-plan/0.1"
    && string(plan.id) && object(plan.lesson) && Array.isArray(plan.goal_authority) && actual.length > 0
    && object(payload.course_context) && Array.isArray(payload.sequence_blueprint)
    && Array.isArray(plan.items) && Array.isArray(plan.events) && Array.isArray(returned.items);
  const problems = [], issue = code => { matches = false; if (!problems.includes(code)) problems.push(code); };
  if (matches) {
    const expectedHash = hash(payload), retained = contextPayload({}, native, true);
    if (!/^[a-f0-9]{64}$/.test(returned.context_sha256 ?? "") || returned.context_sha256 !== expectedHash) issue("context_hash_differs");
    if (!object(retained.course_context) || !Array.isArray(retained.sequence_blueprint) || hash(retained) !== expectedHash) issue("retained_native_context_differs");
    if (returned.plan_id !== plan.id || !equal(returned.lesson, plan.lesson) || !equal(returned.goal_authority, plan.goal_authority)) issue("declared_plan_differs");
    const actualIds = actual.map(item => item?.id), declaredIds = plan.items.map(item => item?.item_id), returnedIds = returned.items.map(item => item?.item_id);
    if (!actualIds.every(string) || !unique(actualIds) || !equal(returnedIds, actualIds) || !equal(declaredIds, actualIds)) issue("item_order_or_coverage_differs");
    const positions = new Map(actualIds.map((id, index) => [id, index + 1])), events = new Map(plan.events.map(event => [event?.id, event]));
    if (events.size !== plan.events.length || ![...events.keys()].every(string)) issue("event_identity_invalid");
    for (const [index, item] of returned.items.entries()) {
      const declared = plan.items[index];
      if (!object(item) || !object(declared)) { issue("item_declaration_invalid"); continue; }
      if (item.purpose !== declared.purpose || item.scope !== declared.scope || !equal(item.measurement_intent, declared.measurement_intent) || !equal(item.support, declared.support)) issue("item_conditions_differ");
      const refs = item.context_event_refs, required = [...(Array.isArray(declared.prior_event_refs) ? declared.prior_event_refs : []), ...(Array.isArray(declared.support?.event_refs) ? declared.support.event_refs : [])];
      if (!strings(refs) || !unique(refs) || required.some(ref => !refs.includes(ref))) issue("required_context_events_missing_or_duplicate");
      else for (const ref of refs) {
        const event = events.get(ref), anchor = event?.before_item_id === "END" ? actualIds.length + 1 : positions.get(event?.before_item_id);
        if (!event || anchor === undefined || anchor > index + 1) issue("context_event_unknown_or_future");
      }
      const proposed = item.expected_evidence, expected = declared.expected_evidence;
      if (!Array.isArray(proposed) || !Array.isArray(expected) || proposed.length !== expected.length || !unique(proposed.map(row => row?.expectation_id))) issue("expected_evidence_identity_differs");
      else for (const evidence of proposed) {
        const original = expected.find(row => row?.id === evidence?.expectation_id);
        if (!object(evidence) || !original || evidence.claim !== original.claim) issue("expected_evidence_claim_differs");
      }
    }
  } else problems.push("returned_or_source_plan_malformed");
  add("sequence_return_plan_matches", matches, { issues: problems });

  let fieldsResolve = object(returned) && Array.isArray(returned.items) && returned.items.length === actual.length, fieldCount = 0;
  const fieldIssues = [], fieldIssue = (item, code, fieldRef) => {
    fieldsResolve = false;
    fieldIssues.push({ item_id: item?.item_id ?? null, code, ...(fieldRef === undefined ? {} : { field_ref: fieldRef }) });
  };
  if (fieldsResolve) for (const item of returned.items) {
    const candidate = actual.find(row => row?.id === item?.item_id);
    if (!candidate || !Array.isArray(item?.expected_evidence)) { fieldIssue(item, "expected_evidence_item_missing"); continue; }
    const responseFields = responseContractFields(context, set, candidate);
    if (responseFields === null) fieldIssue(item, "unsupported_response_profile");
    for (const evidence of item.expected_evidence) {
      if (!strings(evidence?.field_refs) || !evidence.field_refs.length || !unique(evidence.field_refs)) { fieldIssue(item, "invalid_field_reference_list"); continue; }
      for (const ref of evidence.field_refs) {
        fieldCount++;
        if (!ref.startsWith("/view/") || !resolvePointer(candidate, ref).found) fieldIssue(item, "field_pointer_does_not_resolve", ref);
        else if (responseFields !== null && !responseFields.has(ref)) fieldIssue(item, "field_is_not_response_contract", ref);
      }
    }
  }
  add("sequence_return_evidence_fields_resolve", fieldsResolve, { checked_field_references: fieldCount, issues: fieldIssues,
    meaning: "Pointers resolve to recognized task or scoring requirement leaves in a supported response profile; array and object containers require narrower leaf bindings. A rubric describes expected responses, not observed learner production; this does not show that a task elicits the claimed evidence." });
  const coverageMatches = object(returned) && object(plan?.sequence) && Array.isArray(returned.goal_coverage) && Array.isArray(returned.support_transitions)
    && equal(returned.goal_coverage, plan.sequence.goal_coverage) && equal(returned.support_transitions, plan.sequence.support_transitions);
  add("sequence_return_coverage_matches", coverageMatches, { meaning: "Exact declared coverage and transition rows, not measured learning coverage or a warranted progression." });
  return { status: checks.every(check => check.verdict === "pass") ? "checked_fields_only" : "needs_revision", checks,
    declared_sequence_plan: publicReturn(returned ?? nativeReturn), qualification: false,
    meaning: "Returned design declarations match supplied instructions and supported response-contract field pointers; semantic sufficiency and academic quality remain unqualified." };
}
