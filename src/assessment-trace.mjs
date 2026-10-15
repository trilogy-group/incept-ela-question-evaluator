// Audit supplied assessment events against a declared policy. This does not authenticate events or marks.
import crypto from "node:crypto";

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const sorted = value => Array.isArray(value) ? value.map(sorted) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
export const assessmentPolicyHash = policy => crypto.createHash("sha256").update(JSON.stringify(sorted(policy))).digest("hex");
const text = value => typeof value === "string" && value.trim().length > 0;
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
const fingerprint = item => JSON.stringify({ question: item.view?.stem ?? item.view?.prompt,
  options: [...(item.view?.options ?? item.view?.candidates ?? [])].sort() });
const kinds = new Set(["answer", "submit", "feedback", "help", "teach", "bank-attempt", "gap-state", "score", "writing-score", "writing-fix", "model", "frame-change", "followup", "close"]);

export function attachAssessmentTrace(packet, audit) {
  if (!audit.supplied) return;
  packet.state.supplied_runtime_observations = audit;
  packet.field_checks.push(...audit.checks);
  packet.holds.push(...audit.checks.filter(row => row.verdict === "unsure").map(row => ({ item_id: null, reason: row.id })));
}

export function auditAssessmentTrace({ policy, trace, contextSha256, setSha256, items = [] }) {
  const checks = [], add = (id, verdict, evidence = {}) => checks.push({ id, verdict: typeof verdict === "boolean" ? verdict ? "pass" : "fail" : verdict, evidence });
  const finish = extra => ({ version: 1, status: checks.some(row => row.verdict === "fail") ? "needs_revision"
    : checks.some(row => row.verdict === "unsure") ? "not_verified" : "checks_passed_unqualified",
    checks, runtime_authenticated: false, marks_independently_validated: false, qualified: false,
    session_complete: false, coverage: "Supplied events only; missing continuation is not checked.",
    meaning: "Consistency of supplied event claims and author keys against supplied policy; not observed learning or trustworthy marking.", ...extra });
  if (trace === undefined || trace === null) {
    add("runtime_evidence_supplied", "unsure"); return finish({ supplied: false });
  }
  if (!policy) { add("runtime_policy_available", false); return finish({ supplied: true }); }
  if (!object(policy) || !Array.isArray(policy.item_rules) || !Array.isArray(policy.parameters) || !Array.isArray(policy.gaps)) {
    add("runtime_policy_available", false); return finish({ supplied: true });
  }
  const bound = object(trace) && trace.version === "assessment-trace/0.1" && text(trace.session_id)
    && trace.policy_sha256 === assessmentPolicyHash(policy) && trace.context_sha256 === contextSha256 && trace.set_sha256 === setSha256;
  add("runtime_evidence_binding", bound);
  if (!bound || !Array.isArray(trace.events)) {
    if (bound) add("runtime_events_present", false);
    return finish({ supplied: true });
  }
  const byId = new Map(items.map(item => [item.id, item])), rules = new Map(policy.item_rules.map(rule => [rule.item_id, rule]));
  const parameters = new Map(policy.parameters.map(row => [row.id, row]));
  const parameter = ref => {
    const row = parameters.get(ref);
    return row?.status === "confirmed" && typeof row.value === "number" ? row.value : null;
  };
  const gaps = new Map(policy.gaps.map(gap => [gap.id, { policy: gap, status: "not-open", attempts: 0, streak: 0, seen: new Set(), seenContent: new Set(), taught: false, contexts: {} }]));
  const checkpointRules = policy.item_rules.filter(rule => ["checkpoint-test", "mastery-gate"].includes(rule.moment));
  const answers = new Map(), eventIds = new Set(), frozen = new Map(), writingMarks = new Map(), feedbackSeen = new Set();
  let firstWritingMarks = null;
  let lastOrder = 0, submitted = false, writingFixed = false, pendingWritingFix = false, sessionClosed = false, frameMoves = 0, redrafts = 0, expectedPoints = null;
  const validSelection = (item, selected) => {
    const options = item?.view?.options ?? item?.view?.candidates;
    const count = item?.view?.selection_count ?? policy.scoring?.find(group => group.kind === "select-n" && group.item_ids.includes(item?.id))?.selection_count ?? 1;
    return Array.isArray(options) && Array.isArray(selected) && selected.length === count && new Set(selected).size === selected.length
      && selected.every(index => Number.isInteger(index) && index >= 0 && index < options.length);
  };
  const correctness = (item, selected) => {
    const options = item?.view?.options ?? item?.view?.candidates, key = item?.view?.key;
    if (!Array.isArray(options) || !Array.isArray(key) || !key.length) return null;
    if (!Array.isArray(selected) || !selected.length || new Set(selected).size !== selected.length
      || !selected.every(index => Number.isInteger(index) && index >= 0 && index < options.length)) return null;
    return same([...selected].sort((a,b) => a-b), [...key].sort((a,b) => a-b));
  };
  const scoreSnapshot = () => {
    let points = 0, known = true; const grouped = new Set();
    for (const group of policy.scoring ?? []) {
      group.item_ids.forEach(id => grouped.add(id));
      const values = group.item_ids.map(id => frozen.get(id));
      let pattern;
      if (group.kind === "linked-pair") pattern = values.every(row => typeof row?.correct === "boolean") ? values.map(row => row.correct ? "1" : "0").join("") : null;
      else {
        const item = byId.get(group.item_ids[0]), selected = values[0]?.selected;
        pattern = validSelection(item, selected) && typeof values[0]?.correct === "boolean"
          ? String(selected.filter(index => item.view.key.includes(index)).length) : null;
      }
      if (pattern === null || typeof group.points[pattern] !== "number") known = false;
      else points += group.points[pattern];
    }
    for (const rule of checkpointRules.filter(rule => rule.score_basis === "first-submission" && !grouped.has(rule.item_id))) {
      const correct = frozen.get(rule.item_id)?.correct;
      if (typeof correct !== "boolean") known = false; else points += correct ? 1 : 0;
    }
    return known ? points : null;
  };
  for (const event of trace.events) {
    const valid = object(event) && text(event.id) && !eventIds.has(event.id) && Number.isInteger(event.order) && event.order > lastOrder && kinds.has(event.type);
    add("runtime_event_shape", valid, { event_id: event?.id ?? null });
    if (!valid) continue;
    eventIds.add(event.id); lastOrder = event.order;
    add("runtime_event_before_close", !sessionClosed || event.type === "followup", { event_id: event.id });
    if (sessionClosed && event.type !== "followup") continue;
    const item = byId.get(event.item_id), rule = rules.get(event.item_id), gap = gaps.get(event.gap_id);
    if (event.item_id !== undefined && !item) { add("runtime_item_reference", false, { event_id: event.id }); continue; }
    if (event.gap_id !== undefined && !gap) { add("runtime_gap_reference", false, { event_id: event.id }); continue; }
    if (event.type === "answer") {
      add("runtime_answer_declared", Boolean(rule) && !submitted, { event_id: event.id });
      const written = item?.id === policy.writing?.item_id;
      const validAnswer = written ? text(event.response) : validSelection(item, event.selected);
      add("runtime_answer_selection", validAnswer, { event_id: event.id });
      if (rule && !submitted && validAnswer) answers.set(item.id, written ? { response: event.response, correct: null }
        : { selected: structuredClone(event.selected), correct: correctness(item, event.selected) });
    }
    if (["feedback", "help", "teach", "model"].includes(event.type)) {
      const protectedTest = rule && ["checkpoint-test", "mastery-gate"].includes(rule.moment);
      add("runtime_feedback_timing", !rule && checkpointRules.length && !submitted ? "unsure" : !protectedTest || submitted,
        { event_id: event.id, moment: rule?.moment ?? null });
      if (event.type === "feedback" && rule && (!protectedTest || submitted) && text(event.content)) feedbackSeen.add(item.id);
      if (event.type === "teach" && gap && (!protectedTest || submitted)) gap.taught = true;
      if (event.type === "model" && policy.writing && event.item_id === policy.writing.item_id) add("runtime_writing_model_is_different", false, { event_id: event.id });
    }
    if (event.type === "submit") {
      add("runtime_single_submission", !submitted, { event_id: event.id });
      if (!submitted) {
        submitted = true;
        for (const r of checkpointRules) {
          const answer = answers.get(r.item_id);
          add("runtime_submission_complete", Boolean(answer), { item_id: r.item_id });
          if (answer) {
            frozen.set(r.item_id, structuredClone(answer));
            if (answer.correct === null) add("runtime_submission_mark", "unsure", { item_id: r.item_id,
              meaning: "No independently validated mark is available for this response." });
            if (answer.correct === false) {
              const selectedRoutes = r.misconception_routes.filter(route => answer.selected.some(index =>
                route.option_ref === `/view/options/${index}` || route.option_ref === `/view/candidates/${index}`));
              const routed = selectedRoutes.length ? [...new Set(selectedRoutes.map(route => route.gap_ref))] : r.gap_refs;
              if (!selectedRoutes.length && r.gap_refs.length > 1) add("runtime_misconception_route_resolved", "unsure", { item_id: r.item_id });
              for (const ref of routed) gaps.get(ref).status = "todo";
            }
          }
        }
        expectedPoints = scoreSnapshot();
      }
    }
    if (event.type === "score") {
      add("runtime_score_scope", event.item_id === undefined, { event_id: event.id, meaning: "The supplied score is the complete frozen submission total, not an item mark." });
      add("runtime_score_immutable", !submitted ? false : expectedPoints === null ? "unsure" : event.points === expectedPoints,
        { event_id: event.id, expected_points: expectedPoints });
    }
    if (event.type === "bank-attempt") {
      if (!gap || !item || !policy.remediation) { add("runtime_remediation_available", false, { event_id: event.id }); continue; }
      const before = checks.length;
      const remediation = policy.remediation, limit = parameter(remediation.bank_limit_parameter_ref), streak = parameter(remediation.streak_parameter_ref);
      const selectionValid = validSelection(item, event.selected);
      const outcome = selectionValid ? correctness(item, event.selected) : null;
      add("runtime_bank_selection", selectionValid, { event_id: event.id });
      add("runtime_bank_membership", gap.policy.bank_item_ids.includes(item.id), { event_id: event.id });
      add("runtime_remediation_after_submit", submitted || !checkpointRules.length, { event_id: event.id });
      add("runtime_remediation_terminal", ["todo", "open"].includes(gap.status), { event_id: event.id });
      if (remediation.fresh_items_required) add("runtime_bank_freshness", !gap.seen.has(item.id)
        && !gap.seenContent.has(fingerprint(item))
        && !checkpointRules.some(r => r.item_id === item.id || fingerprint(byId.get(r.item_id)) === fingerprint(item)), { event_id: event.id });
      if (limit !== null) add("runtime_bank_limit", gap.attempts < limit, { event_id: event.id }); else add("runtime_bank_limit", "unsure");
      if (remediation.initial_order === "unknown") add("runtime_teaching_order", "unsure");
      else if (gap.attempts === 0 && remediation.initial_order === "teach-before-retest" || gap.lastCorrect === false) add("runtime_teaching_order", gap.taught, { event_id: event.id });
      if (checks.slice(before).some(row => row.verdict === "fail")) continue;
      gap.attempts++; gap.seen.add(item.id); gap.seenContent.add(fingerprint(item)); gap.status = "open"; gap.lastCorrect = selectionValid ? outcome : null; gap.taught = false;
      if (outcome === null) add("runtime_bank_mark", "unsure", { event_id: event.id });
      else if (outcome) gap.streak++; else if (remediation.wrong_resets_streak) gap.streak = 0;
      if (["taught", "transfer"].includes(event.context)) gap.contexts[event.context] = outcome;
      if (streak === null) add("runtime_streak_rule", "unsure");
    }
    if (event.type === "gap-state") {
      if (!gap || !policy.remediation?.terminal_states.includes(event.status)) { add("runtime_gap_state", false, { event_id: event.id }); continue; }
      const streak = parameter(policy.remediation?.streak_parameter_ref), limit = parameter(policy.remediation?.bank_limit_parameter_ref);
      const validClose = event.status === "closed" ? streak === null ? null : gap.streak >= streak
        : limit === null ? null : gap.attempts >= Math.min(limit, gap.policy.bank_item_ids.length);
      add("runtime_gap_state", validClose === null ? "unsure" : validClose, { event_id: event.id });
      if (validClose) gap.status = event.status;
    }
    if (event.type === "writing-score") {
      const writing = policy.writing;
      if (!writing || item?.id !== writing.item_id || !object(event.components)) { add("runtime_writing_components", false, { event_id: event.id }); continue; }
      const timingValid = !["checkpoint-test", "mastery-gate"].includes(rule?.moment) || submitted;
      add("runtime_writing_mark_timing", timingValid, { event_id: event.id });
      const complete = Object.keys(event.components).length === writing.components.length
        && writing.components.every(component => typeof event.components[component.id] === "boolean");
      add("runtime_writing_components", complete, { event_id: event.id });
      const responseAvailable = text(answers.get(writing.item_id)?.response);
      add("runtime_writing_response_available", responseAvailable, { event_id: event.id });
      const versionValid = writingMarks.size === 0 || pendingWritingFix;
      add("runtime_writing_mark_version", versionValid, { event_id: event.id });
      if (complete && versionValid && responseAvailable && timingValid) {
        firstWritingMarks ??= structuredClone(event.components);
        pendingWritingFix = false;
        writingMarks.clear(); writing.components.forEach(component => writingMarks.set(component.id, event.components[component.id]));
        const claim = writing.components.find(component => ["claim", "answer", "C", "A"].includes(component.role));
        if (!claim) add("runtime_writing_claim_role", false, { event_id: event.id });
        else if (event.components[claim.id] === false && gaps.has(writing.claim_failure_gap_ref)) gaps.get(writing.claim_failure_gap_ref).status = "todo";
      }
    }
    if (event.type === "writing-fix") {
      const writing = policy.writing, firstFailed = writing?.repair_order.find(id => writingMarks.get(id) === false);
      const bound = Boolean(writing) && item?.id === writing.item_id;
      add("runtime_writing_item_binding", bound, { event_id: event.id });
      add("runtime_writing_repair_order", bound && Boolean(firstFailed) && event.component_id === firstFailed, { event_id: event.id });
      add("runtime_writing_fix_response", text(event.response), { event_id: event.id });
      const timingValid = !["checkpoint-test", "mastery-gate"].includes(rules.get(writing?.item_id)?.moment) || submitted;
      add("runtime_writing_mark_timing", timingValid, { event_id: event.id });
      const max = parameter(writing?.max_redrafts_parameter_ref);
      redrafts++; if (max !== null) add("runtime_writing_redraft_limit", redrafts <= max, { event_id: event.id });
      writingFixed = bound && Boolean(firstFailed) && event.component_id === firstFailed && text(event.response) && timingValid;
      pendingWritingFix = writingFixed;
    }
    if (event.type === "frame-change") {
      add("runtime_writing_item_binding", item?.id === policy.writing?.item_id && Boolean(policy.writing), { event_id: event.id });
      const max = parameter(policy.writing?.frame.max_change_parameter_ref);
      const valid = Number.isInteger(event.from) && Number.isInteger(event.to) && event.from >= 0 && event.to >= 0
        && event.from < (policy.writing?.frame.rungs.length ?? 0) && event.to < (policy.writing?.frame.rungs.length ?? 0);
      frameMoves += valid ? Math.abs(event.to-event.from) : Infinity;
      add("runtime_frame_change_bound", !valid ? false : max === null ? "unsure" : frameMoves <= max, { event_id: event.id });
    }
    if (event.type === "followup") add("runtime_later_independence", "unsure", { event_id: event.id,
      meaning: "A supplied later-success claim does not authenticate a separate independent learner attempt." });
    if (event.type === "close") {
      sessionClosed = true;
      add("runtime_close_after_submit", submitted || !checkpointRules.length, { event_id: event.id });
      add("runtime_close_gaps_terminal", [...gaps.values()].every(value => ["not-open", "closed", "flagged"].includes(value.status)), { event_id: event.id });
      if (policy.writing && [...writingMarks.values()].some(value => value === false)) add("runtime_close_writing_submitted", writingFixed, { event_id: event.id });
      if (policy.writing && !writingMarks.size) add("runtime_writing_mark_supplied", "unsure", { event_id: event.id });
      if (pendingWritingFix) add("runtime_writing_remark_supplied", "unsure", { event_id: event.id });
      for (const r of policy.item_rules.filter(r => r.feedback.required && answers.has(r.item_id)))
        add("runtime_required_feedback_supplied", feedbackSeen.has(r.item_id) ? true : "unsure", { item_id: r.item_id });
    }
  }
  if (checkpointRules.length && !submitted) add("runtime_submission_present", "unsure");
  return finish({ supplied: true, first_submission: [...frozen].map(([item_id, value]) => ({ item_id, ...value })), points: expectedPoints,
    session_complete: sessionClosed && checks.every(row => row.verdict === "pass"),
    first_writing_marks: firstWritingMarks, latest_writing_marks: writingMarks.size ? Object.fromEntries(writingMarks) : null,
    gaps: [...gaps].map(([id, gap]) => ({ id, status: gap.status, tries: gap.attempts, streak: gap.streak,
      diagnostic: gap.contexts.taught === false ? "knowledge-gap-claim" : gap.contexts.taught === true && gap.contexts.transfer === false ? "transfer-gap-claim" : "undetermined" })) });
}
