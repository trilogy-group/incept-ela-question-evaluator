// Resolve declared teaching conditions without inventing learner exposure or quality approval.
import { inspectSequenceReturn } from "./sequence-return.mjs";
import { resolveAssessmentPolicy } from "./assessment-policy.mjs";
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value, key) => object(value) && Object.hasOwn(value, key);
const clone = value => structuredClone(value);
export class InstructionalContextError extends Error {
  constructor(code, field) { super(`instructional context: ${code} (${field})`); this.name = "InstructionalContextError"; this.code = code; this.field = field; }
}
function need(ok, code, field) { if (!ok) throw new InstructionalContextError(code, field); }
function text(value, field, optional = false) {
  if (optional && (value === undefined || value === null)) return null;
  need(typeof value === "string" && value.trim().length > 0, "invalid_text", field); return value;
}
function list(value, field, optional = false) {
  if (optional && value === undefined) return [];
  need(Array.isArray(value), "invalid_list", field); return value;
}
function textList(value, field, optional = false) { return list(value, field, optional).map((v, i) => text(v, `${field}/${i}`)); }
function rows(value, field, optional = false) { return list(value, field, optional).map((v, i) => { need(object(v), "invalid_row", `${field}/${i}`); return v; }); }
function uniqueRows(value, field, optional = false) {
  const found = new Set();
  return rows(value, field, optional).map((row, i) => { const id = text(row.id, `${field}/${i}/id`); need(!found.has(id), "duplicate_id", `${field}/${i}/id`); found.add(id); return row; });
}
function choose(row, fields, lists = []) {
  return Object.fromEntries([...fields.filter(field => own(row, field)).map(field => [field, clone(row[field])]),
    ...lists.filter(field => own(row, field)).map(field => [field, clone(row[field])])]);
}
const taskFields = ["stem", "prompt", "question", "response_mode", "response_rule", "selection_rule", "surrounding_text", "ordering_rule", "tie_policy", "reuse_policy", "instruction", "statement", "centre", "link_rule"];
function taskView(item) {
  const view = object(item.view) ? item.view : {};
  const out = Object.fromEntries(taskFields.filter(field => typeof view[field] === "string").map(field => [field, view[field]]));
  if (Number.isInteger(view.selection_count)) out.selection_count = view.selection_count;
  if (item.family === "evidence_selection" && typeof view.claim === "string") out.claim = view.claim;
  for (const field of ["options", "response_parts", "scale"]) {
    if (own(view, field) && Array.isArray(view[field])) out[field] = view[field].every(value => typeof value === "string") ? [...view[field]] : view[field].filter(object).map((row, index) => ({ id: `O${index + 1}`, ...choose(row, ["text"]) }));
  }
  if (!out.prompt && typeof view.rubric?.question === "string") out.prompt = view.rubric.question;
  if (Array.isArray(view.items)) out.words = view.items.map(row => row?.word).filter(value => typeof value === "string");
  if (object(view.boxes)) out.destinations = Object.values(view.boxes).flatMap(box => object(box) ? ["is", "seems", "wanted"].filter(relation => typeof box[relation] === "string").map(relation => ({ relation, label: box[relation] })) : []);
  if (Array.isArray(view.candidates) || Array.isArray(view.decoys)) out.evidence_options = [...(view.candidates ?? []), ...(view.decoys ?? [])].filter(value => typeof value === "string").sort();
  for (const field of ["entries", "categories", "bank", "blanks"]) if (own(view, field) && Array.isArray(view[field]))
    out[field] = view[field].filter(object).map((row, index) => ({ id: `${field.slice(0, 1).toUpperCase()}${index + 1}`, ...choose(row, ["text", "label", "description", "relation"]),
      ...(Array.isArray(row.options) ? { options: row.options.filter(value => typeof value === "string") } : {}) }));
  return out;
}
function readingText(value, field) {
  const out = [];
  const walk = (row, path, stringAllowed = false) => {
    if (stringAllowed && typeof row === "string") { out.push(text(row, path)); return; }
    need(object(row), "unsupported_passive_node_content", path);
    if (own(row, "type")) need(row.type === "reading", "unsupported_passive_node", `${path}/type`);
    // The public projection strips this explicit nonlearner wrapper; do not interpret its contents.
    if (own(row, "metadata") && Object.keys(row).every(key => key === "metadata")) return;
    const before = out.length;
    if (own(row, "who")) need(row.who === null || typeof row.who === "string", "invalid_text", `${path}/who`);
    for (const key of ["line", "stage", "text", "title", "paragraph", "t"]) if (own(row, key)) {
      const content = text(row[key], `${path}/${key}`);
      out.push(key === "line" && typeof row.who === "string" ? `${row.who}: ${content}` : content);
    }
    for (const key of ["lines", "paragraphs", "blocks", "parts"]) if (own(row, key)) {
      const children = list(row[key], `${path}/${key}`);
      need(children.length > 0, "unsupported_passive_node_content", `${path}/${key}`);
      children.forEach((child, i) => walk(child, `${path}/${key}/${i}`, ["lines", "paragraphs"].includes(key)));
    }
    need(out.length > before, "unsupported_passive_node_content", path);
  }; walk(value, field); return out;
}
function passiveEvents(context) {
  const pages = rows(context.native?.pages, "context/native/pages", true), events = [];
  for (const [pi, page] of pages.entries()) {
    const pageId = text(page.id, `context/native/pages/${pi}/id`);
    const available = !page.extra || context.native?.extras?.[page.extra] === true;
    for (const [ni, node] of rows(page.nodes, `context/native/pages/${pi}/nodes`, true).entries()) {
      let content = [], type = node.type;
      const field = `context/native/pages/${pi}/nodes/${ni}`;
      need(["reading", "instruction", "learning_question", "key_term", "definition", "worked_instruction", "worked-teaching", "recall-model"].includes(type), "unsupported_passive_node", `${field}/type`);
      if (type === "reading") content = readingText(node, field);
      if (["instruction", "learning_question", "key_term", "definition"].includes(type)) {
        content = [node.learning_question, node.text, node.term && node.meaning ? `${node.term}: ${node.meaning}` : null,
          node.key_term?.term && node.key_term?.meaning ? `${node.key_term.term}: ${node.key_term.meaning}` : null,
          ...(Array.isArray(node.keywords) ? node.keywords.map(row => `${row.word}: ${row.meaning}`) : []),
          ...(Array.isArray(node.glossary) ? node.glossary.map(row => `${row.term}: ${row.note}`) : [])].filter(v => typeof v === "string" && v.trim());
      }
      if (["worked_instruction", "worked-teaching", "recall-model"].includes(type)) {
        content = [node.line, node.quote, node.text, node.statement, ...(Array.isArray(node.steps) ? node.steps.flatMap(step => [step.stem, step.sentence, step.think]) : [])].filter(v => typeof v === "string" && v.trim());
      }
      need(content.some(value => value.trim().length > 0), "unsupported_passive_node_content", field);
      events.push({ id: `passive-${pi}-${ni}`, page_ref: pageId, page_position: pi, node_position: ni,
        kind: type, text: content.join("\n"), availability: available ? "declared_passive" : "conditional_unknown",
        source: "supplied lesson-context; not observed learner exposure" });
    }
  }
  return events;
}

const PURPOSES = new Set(["practice", "assessment", "diagnostic", "instruction"]);
const SCOPES = new Set(["static-design", "individualized", "mastery-claim"]);
function member(value, values, field) { text(value, field); need(values.has(value), "unsupported_value", field); return value; }
function references(value, allowed, field, optional = false) {
  const refs = textList(value, field, optional);
  need(new Set(refs).size === refs.length, "duplicate_reference", field);
  need(refs.every(ref => allowed.has(ref)), "unknown_reference", field); return refs;
}
function publicCourse(course) {
  const targets = uniqueRows(course.core_knowledge, "course/core_knowledge", true).map(row => choose(row, ["id", "claim", "performance", "status", "source_refs"]));
  const sources = uniqueRows(course.source_assets, "course/source_assets", true).map(row => choose(row, ["id", "kind", "text", "media_ref", "time_range", "source_status"]));
  for (const [i, row] of targets.entries()) {
    if (own(row, "claim")) text(row.claim, `course/core_knowledge/${i}/claim`);
    if (own(row, "performance")) text(row.performance, `course/core_knowledge/${i}/performance`);
  }
  for (const [i, row] of sources.entries()) {
    if (own(row, "text") && row.text !== null) need(typeof row.text === "string", "invalid_text", `course/source_assets/${i}/text`);
    for (const field of ["kind", "media_ref", "source_status"]) if (own(row, field) && row[field] !== null) text(row[field], `course/source_assets/${i}/${field}`);
    if (own(row, "time_range") && row.time_range !== null) need(Array.isArray(row.time_range) && row.time_range.length === 2 && row.time_range.every(value => Number.isFinite(value) && value >= 0) && row.time_range[0] <= row.time_range[1], "invalid_media_range", `course/source_assets/${i}/time_range`);
  }
  const sourceIds = new Set(sources.map(row => row.id));
  for (const [i, row] of targets.entries()) if (own(row, "source_refs")) references(row.source_refs, sourceIds, `course/core_knowledge/${i}/source_refs`);
  const prerequisites = list(course.prerequisites, "course/prerequisites", true).map((row, i) => {
    if (typeof row === "string") return { claim: text(row, `course/prerequisites/${i}`), status: "supplied prerequisite; learner fluency unverified" };
    need(object(row), "invalid_row", `course/prerequisites/${i}`);
    return choose(row, ["id", "claim", "description", "performance", "status", "source_refs"]);
  });
  const graph = course.knowledge_map;
  if (graph !== undefined) need(object(graph) || Array.isArray(graph), "invalid_graph", "course/knowledge_map");
  let knowledgeMap = null;
  if (Array.isArray(graph)) knowledgeMap = rows(graph, "course/knowledge_map").map(row => choose(row, ["knowledge_ref", "content_key_ref", "relation", "status", "rationale"]));
  else if (graph) {
    const nodes = uniqueRows(graph.nodes, "course/knowledge_map/nodes", true).map(row => choose(row, ["id", "role", "claim", "performance", "status", "source_refs"]));
    const ids = new Set(nodes.map(row => row.id));
    const edges = rows(graph.edges, "course/knowledge_map/edges", true).map((row, i) => {
      text(row.from, `course/knowledge_map/edges/${i}/from`); text(row.to, `course/knowledge_map/edges/${i}/to`);
      need(ids.has(row.from) && ids.has(row.to), "unknown_reference", `course/knowledge_map/edges/${i}`);
      return choose(row, ["from", "to", "relation", "warrant", "status"]);
    });
    knowledgeMap = { revision: graph.revision ?? null, nodes, edges };
  }
  const pairings = rows(course.pairing_tables, "course/pairing_tables", true).map((row, i) => ({ ...choose(row, ["id", "status", "rationale"]),
    pairs: rows(row.pairs, `course/pairing_tables/${i}/pairs`, true).map(pair => choose(pair, ["id", "target_ref", "source_ref", "content_key_ref", "phase_ref", "rationale", "status"])) }));
  const pairingMap = rows(course.pairing_map, "course/pairing_map", true).map(row => choose(row, ["id", "knowledge_refs", "relation", "rationale", "status"]));
  const prior = course.prior_exposure;
  if (prior !== undefined) need(Array.isArray(prior) || object(prior), "invalid_prior_exposure", "course/prior_exposure");
  const priorRows = prior === undefined ? [] : rows(Array.isArray(prior) ? prior : prior.events, "course/prior_exposure/events").map(row => choose(row, ["id", "role", "content", "timing", "status", "source_refs", "source_ref", "original_pointer", "availability"]));
  if (course.authorized_procedure !== undefined && course.authorized_procedure !== null) {
    need(object(course.authorized_procedure), "invalid_procedure", "course/authorized_procedure");
    textList(course.authorized_procedure.steps, "course/authorized_procedure/steps", true);
  }
  const lessonPlan = course.lesson_plan;
  if (lessonPlan !== undefined) need(object(lessonPlan), "invalid_lesson_plan", "course/lesson_plan");
  const phases = rows(lessonPlan?.phases, "course/lesson_plan/phases", true).map(row => choose(row, ["id", "role", "target_refs", "source_refs", "content_key_refs", "after", "support", "exposure_order"]));
  return { targets, sources, prerequisites, knowledge_map: knowledgeMap, pairing_tables: pairings, pairing_map: pairingMap,
    declared_prior_exposure: priorRows, lesson_plan: { phases },
    content_keys: rows(course.content_keys, "course/content_keys", true).map(row => choose(row, ["id", "claim", "target_refs", "source_refs", "phase_refs", "status"])),
    authorized_procedure: object(course.authorized_procedure) ? choose(course.authorized_procedure, ["source", "status", "steps"]) : null,
    curriculum_revision: course.curriculum_revision ?? null, lesson_position: course.lesson_position ?? null,
    known_constraints: textList(course.known_constraints, "course/known_constraints", true) };
}
function knownStudentContext(request, course) {
  const supplied = request.student_context ?? course.learner_constraints;
  if (supplied === undefined || supplied === null) return { status: "unknown", supplied: null, readiness: "unmeasured" };
  need(object(supplied), "invalid_student_context", "student_context");
  for (const field of ["language", "access_needs", "accessibility_needs", "individual_reading_level", "response_support", "status"]) if (own(supplied, field) && supplied[field] !== null) text(supplied[field], `student_context/${field}`);
  if (own(supplied, "grade") && supplied.grade !== null) need(typeof supplied.grade === "string" || Number.isFinite(supplied.grade), "invalid_grade", "student_context/grade");
  for (const field of ["response_history", "learner_history"]) if (own(supplied, field) && supplied[field] !== null) {
    need(Array.isArray(supplied[field]), "invalid_history", `student_context/${field}`);
    need(supplied[field].length === 0, "unbound_history_requires_plan_events", `student_context/${field}`);
  }
  return { status: "supplied_declaration", supplied: choose(supplied, ["grade", "language", "access_needs", "accessibility_needs", "individual_reading_level", "response_support", "prerequisite_response_evidence", "individual_difficulty", "status"]),
    readiness: "not established by supplied learner descriptors or claimed events" };
}
function resolvePlan(plan, { ids, targets, sources, position }) {
  if (plan === undefined) return null;
  need(object(plan) && plan.version === "instructional-plan/0.1", "unsupported_plan", "course/instructional_plan");
  text(plan.id, "instructional_plan/id"); need(object(plan.lesson), "invalid_lesson", "instructional_plan/lesson");
  const lesson = { purpose: member(plan.lesson.purpose, PURPOSES, "instructional_plan/lesson/purpose"),
    scope: member(plan.lesson.scope, SCOPES, "instructional_plan/lesson/scope"), objective: text(plan.lesson.objective, "instructional_plan/lesson/objective"),
    goal_refs: references(plan.lesson.goal_refs, targets, "instructional_plan/lesson/goal_refs") };
  if (own(plan.lesson, "purpose_note")) lesson.purpose_note = text(plan.lesson.purpose_note, "instructional_plan/lesson/purpose_note");
  const authoritySeen = new Set();
  const authorities = rows(plan.goal_authority, "instructional_plan/goal_authority").map((row, i) => {
    const field = `instructional_plan/goal_authority/${i}`;
    need(targets.has(row.goal_ref), "unknown_reference", `${field}/goal_ref`); need(!authoritySeen.has(row.goal_ref), "duplicate_reference", `${field}/goal_ref`); authoritySeen.add(row.goal_ref);
    return { goal_ref: row.goal_ref, kind: member(row.kind, new Set(["course-declared", "packet-proposed", "source-projected", "unknown"]), `${field}/kind`),
      source_refs: references(row.source_refs, sources, `${field}/source_refs`), note: text(row.note, `${field}/note`) };
  });
  let lastOrder = 0, lastAnchor = 0; const eventIds = new Set();
  const events = rows(plan.events, "instructional_plan/events").map((row, i) => {
    const field = `instructional_plan/events/${i}`, id = text(row.id, `${field}/id`);
    need(!eventIds.has(id), "duplicate_id", `${field}/id`); eventIds.add(id);
    need(Number.isInteger(row.order) && row.order > lastOrder, "event_order_invalid", `${field}/order`); lastOrder = row.order;
    const anchor = row.before_item_id === "END" ? ids.size + 1 : position.get(row.before_item_id);
    need(anchor !== undefined, "unknown_reference", `${field}/before_item_id`); need(anchor >= lastAnchor, "event_anchor_reversed", `${field}/before_item_id`); lastAnchor = anchor;
    const event = { id, order: row.order, before_item_id: row.before_item_id, before_position: anchor,
      kind: member(row.kind, new Set(["teaching", "task", "response", "feedback", "media"]), `${field}/kind`),
      status: member(row.status, new Set(["declared", "observed", "conditional"]), `${field}/status`),
      content: text(row.content, `${field}/content`), source_refs: references(row.source_refs, sources, `${field}/source_refs`),
      target_refs: references(row.target_refs, targets, `${field}/target_refs`),
      revealed_target_refs: references(row.revealed_target_refs, targets, `${field}/revealed_target_refs`),
      provenance: text(row.provenance, `${field}/provenance`),
      disclosed_item_ids: references(row.disclosed_item_ids, ids, `${field}/disclosed_item_ids`, true) };
    if (event.kind === "response") need(event.status !== "declared", "response_requires_observed_or_conditional_status", `${field}/status`);
    return event;
  });
  const eventMap = new Map(events.map(row => [row.id, row])), itemSeen = new Set();
  const items = rows(plan.items, "instructional_plan/items").map((row, i) => {
    const field = `instructional_plan/items/${i}`; need(ids.has(row.item_id), "unknown_reference", `${field}/item_id`); need(!itemSeen.has(row.item_id), "duplicate_reference", `${field}/item_id`); itemSeen.add(row.item_id);
    const prior = references(row.prior_event_refs, eventIds, `${field}/prior_event_refs`);
    need(prior.every(ref => eventMap.get(ref).before_position <= position.get(row.item_id)), "future_event_as_prior", `${field}/prior_event_refs`);
    const prepares = references(row.prepares_for_item_ids, ids, `${field}/prepares_for_item_ids`);
    need(prepares.every(ref => position.get(ref) > position.get(row.item_id)), "future_task_order_invalid", `${field}/prepares_for_item_ids`);
    need(object(row.support), "invalid_support", `${field}/support`);
    const support = { mode: member(row.support.mode, new Set(["none", "source-visible", "guided", "worked-example", "mixed"]), `${field}/support/mode`),
      event_refs: references(row.support.event_refs, eventIds, `${field}/support/event_refs`), source_refs: references(row.support.source_refs, sources, `${field}/support/source_refs`),
      answer_exposure: member(row.support.answer_exposure, new Set(["allowed", "withheld", "unknown"]), `${field}/support/answer_exposure`) };
    need(support.event_refs.every(ref => eventMap.get(ref).before_position <= position.get(row.item_id)), "future_event_as_support", `${field}/support/event_refs`);
    const evidenceIds = new Set();
    const expected = rows(row.expected_evidence, `${field}/expected_evidence`).map((evidence, j) => {
      const efield = `${field}/expected_evidence/${j}`, id = text(evidence.id, `${efield}/id`); need(!evidenceIds.has(id), "duplicate_id", `${efield}/id`); evidenceIds.add(id);
      return { id, goal_refs: references(evidence.goal_refs, targets, `${efield}/goal_refs`), claim: text(evidence.claim, `${efield}/claim`), source_refs: references(evidence.source_refs, sources, `${efield}/source_refs`) };
    });
    const item = { item_id: row.item_id, purpose: member(row.purpose, PURPOSES, `${field}/purpose`), scope: member(row.scope, SCOPES, `${field}/scope`),
      goal_refs: references(row.goal_refs, targets, `${field}/goal_refs`), prior_event_refs: prior, prepares_for_item_ids: prepares, expected_evidence: expected, support };
    if (own(row, "measurement_intent")) item.measurement_intent = text(row.measurement_intent, `${field}/measurement_intent`);
    return item;
  });
  need(object(plan.sequence), "invalid_sequence", "instructional_plan/sequence");
  const coverageSeen = new Set();
  const coverage = rows(plan.sequence.goal_coverage, "instructional_plan/sequence/goal_coverage").map((row, i) => {
    need(targets.has(row.goal_ref), "unknown_reference", `instructional_plan/sequence/goal_coverage/${i}/goal_ref`);
    need(!coverageSeen.has(row.goal_ref), "duplicate_reference", `instructional_plan/sequence/goal_coverage/${i}/goal_ref`); coverageSeen.add(row.goal_ref);
    return { goal_ref: row.goal_ref, item_ids: references(row.item_ids, ids, `instructional_plan/sequence/goal_coverage/${i}/item_ids`) };
  });
  const transitions = rows(plan.sequence.support_transitions, "instructional_plan/sequence/support_transitions").map((row, i) => {
    const field = `instructional_plan/sequence/support_transitions/${i}`;
    need(ids.has(row.from_item_id) && ids.has(row.to_item_id), "unknown_reference", field);
    need(position.get(row.from_item_id) < position.get(row.to_item_id), "support_transition_order_invalid", field);
    return { from_item_id: row.from_item_id, to_item_id: row.to_item_id, reason: text(row.reason, `${field}/reason`) };
  });
  return { version: plan.version, id: plan.id, lesson, goal_authority: authorities, events, items, sequence: { goal_coverage: coverage, support_transitions: transitions } };
}

export function resolveInstructionalContext({ request = {}, context = {}, set = {} } = {}) {
  need(object(request) && object(context) && object(set), "invalid_input", "input");
  const course = request.course_context ?? context.native?.course_context ?? {}; need(object(course), "invalid_course", "course_context");
  const courseData = publicCourse(course), sourceMap = new Map(courseData.sources.map(row => [row.id, row]));
  const setItems = uniqueRows(set.items, "set/items"), positions = new Map();
  for (const [i, item] of setItems.entries()) { need(item.order === i + 1, "item_order_invalid", `set/items/${i}/order`); positions.set(item.id, i + 1); }
  const ids = new Set(positions.keys()), targets = new Set(courseData.targets.map(row => row.id)), sources = new Set(sourceMap.keys());
  const plan = resolvePlan(course.instructional_plan, { ids, targets, sources, position: positions });
  const returnedSequence = inspectSequenceReturn({ request, context, set });
  need(!own(course, "checkpoint_policy") && !own(course, "assessment_trace") && !own(course.instructional_plan?.lesson, "assessment_policy"),
    "unsupported_assessment_policy_location", "course_context");
  const assessmentPolicy = resolveAssessmentPolicy(course.assessment_policy, { items: setItems,
    eventIds: new Set((plan?.events ?? []).map(event => event.id)), targetIds: targets });
  const student = knownStudentContext(request, course), passive = passiveEvents(context);
  const pages = rows(context.native?.pages, "context/native/pages", true), pagePositions = new Map(pages.map((page, i) => [page.id, i]));
  need(pagePositions.size === pages.length, "duplicate_id", "context/native/pages");
  const blueprints = rows(request.sequence_blueprint, "request/sequence_blueprint", true);
  const itemContexts = setItems.map((item, index) => {
    const declaration = plan?.items.find(row => row.item_id === item.id), phase = rows(course.lesson_plan?.phases, "course/lesson_plan/phases", true).find(row => row.id === item.alignment?.phase_ref);
    const returnedRefs = returnedSequence.declared_sequence_plan?.items.find(row => row.item_id === item.id)?.context_event_refs ?? [];
    const policyItem = assessmentPolicy?.item_policies.find(row => row.item_id === item.id) ?? null;
    const legacyPurpose = item.assessment_purpose ?? blueprints[index]?.assessment_purpose;
    if (legacyPurpose !== undefined) member(legacyPurpose, PURPOSES, `items/${index}/assessment_purpose`);
    const purpose = declaration ? { state: "declared", purpose: declaration.purpose, scope: declaration.scope, measurement_intent: declaration.measurement_intent ?? null, source: "instructional_plan/items" }
      : legacyPurpose ? { state: "declared", purpose: legacyPurpose, scope: "static-design", measurement_intent: null, source: "explicit assessment_purpose" }
      : { state: "undetermined", purpose: null, scope: null, measurement_intent: null, source: null, reason: "assessment_purpose_missing" };
    const prior = plan?.events.filter(event => event.before_position <= item.order) ?? [];
    const future = plan?.events.filter(event => event.before_position > item.order) ?? [];
    const conditional = prior.filter(event => event.status === "conditional");
    const priorTeaching = prior.filter(event => ["teaching", "media"].includes(event.kind) && event.status !== "conditional");
    const pagePosition = pagePositions.get(item.page), match = /\/nodes\/(\d+)(?:\/|$)/.exec(item.pointer ?? "");
    const legacyPrior = passive.filter(event => pagePosition !== undefined && (event.page_position < pagePosition || event.page_position === pagePosition && (!match || event.node_position <= Number(match[1]))));
    const orderedTeaching = plan ? priorTeaching : legacyPrior.filter(event => event.availability !== "conditional_unknown");
    const legacyConditional = plan ? [] : legacyPrior.filter(event => event.availability === "conditional_unknown");
    const itemGoals = declaration?.goal_refs ?? (Array.isArray(item.alignment?.target_refs) ? item.alignment.target_refs : []);
    const relevantReveals = prior.filter(event => event.revealed_target_refs.some(ref => itemGoals.includes(ref)));
    const answerExposure = declaration?.support.answer_exposure ?? "unknown";
    const disclosures = prior.filter(event => event.disclosed_item_ids.includes(item.id));
    const withheldConflict = answerExposure === "withheld" && disclosures.some(event => event.status !== "conditional");
    const requiredConditional = conditional.filter(event => !declaration || declaration.prior_event_refs.includes(event.id) || declaration.support.event_refs.includes(event.id)
      || returnedRefs.includes(event.id) || event.disclosed_item_ids.includes(item.id));
    const unscoredNonKnowledge = item.family === "self_report" && item.view?.scoring === "none"
      || item.family === "nonresponse" && purpose.purpose === "instruction";
    const holds = [declaration && !declaration.goal_refs.length && !unscoredNonKnowledge && "item_goals_missing", declaration && !declaration.expected_evidence.length && "expected_evidence_missing", purpose.state !== "declared" && "assessment_purpose_missing", requiredConditional.length > 0 && "conditional_exposure_unresolved", legacyConditional.length > 0 && "conditional_exposure_unresolved", withheldConflict && "declared_withheld_answer_exposure_conflict", purpose.scope && purpose.scope !== "static-design" && "individual_readiness_and_mastery_unverified"].filter(Boolean);
    const knownSources = orderedTeaching.flatMap(event => Array.isArray(event.source_refs) ? event.source_refs : []);
    return { item_id: item.id, order: item.order, assessment_purpose: purpose,
      learner_context: { ordered_teaching: orderedTeaching, prior_tasks: setItems.slice(0, index).map(priorItem => ({ item_id: priorItem.id, order: priorItem.order, kind: priorItem.kind, exposure: "planned response opportunity; not observed learner exposure or success", task: taskView(priorItem) })),
        declared_events: prior.filter(event => event.status === "declared" && !["teaching", "media"].includes(event.kind)),
        observed_events: prior.filter(event => event.status === "observed"), sources: [...new Set(knownSources)].map(ref => sourceMap.get(ref)),
        exposure_status: plan ? "explicit supplied event declarations; observed claims are not authenticated learner events" : "passive authoring preview; response routes unknown",
        unknowns: ["actual served UI and media exposure", "learner state and calibrated readiness", ...(!plan ? ["previous conditional feedback and response history"] : [])] },
      design_context: { target_performances: courseData.targets.filter(target => itemGoals.includes(target.id)), declared_role: item.alignment?.role ?? phase?.role ?? null,
        assessment_policy: policyItem,
        support: declaration?.support ?? { declared: item.alignment?.support ?? phase?.support ?? blueprints[index]?.support ?? null, answer_exposure: "unknown" },
        prerequisites: courseData.prerequisites, known_student_context: student, required_prior_event_refs: declaration?.prior_event_refs ?? [],
        returned_context_event_refs: returnedRefs,
        expected_evidence: declaration?.expected_evidence ?? [], prepares_for_item_ids: declaration?.prepares_for_item_ids ?? [],
        conditional_events: [...conditional, ...legacyConditional], future_teaching: future.filter(event => ["teaching", "media"].includes(event.kind)),
        prior_revealed_targets: relevantReveals.map(event => ({ event_id: event.id, status: event.status, target_refs: event.revealed_target_refs })),
        explicit_answer_disclosures: disclosures, answer_exposure_policy: answerExposure, answer_exposure_conflict: withheldConflict,
        unknowns: !plan ? ["No explicit instructional plan; purposes and evidence coverage unresolved"] : [] },
      holds: [...(plan && !declaration ? ["instructional_plan_item_missing"] : []),
        ...(returnedSequence.status === "needs_revision" ? ["returned_sequence_contract_fault"] : []),
        ...(policyItem?.holds ?? []).map(hold => typeof hold === "string" ? hold : hold.reason), ...holds], contextual_quality: "unqualified" };
  });
  return { version: 1, whole_lesson: { objective: plan?.lesson.objective ?? context.lesson?.learning_question ?? course.learning_question ?? null,
      purpose: plan?.lesson ?? { purpose: null, scope: null, reason: "instructional_plan_missing" },
      ...courseData, instructional_plan: plan, assessment_policy: assessmentPolicy, known_student_context: student,
      tasks: setItems.map(item => ({ item_id: item.id, order: item.order, kind: item.kind, task: taskView(item) })),
      declared_passive_teaching: passive, source_authority: courseData.targets.map(row => plan?.goal_authority.find(authority => authority.goal_ref === row.id) ?? ({ goal_ref: row.id, kind: "unknown", note: "Supplied target; course authority not established" })),
      constraints: [...courseData.known_constraints, ...textList(request.known_constraints, "request/known_constraints", true)],
      interpretation: "Declarations and source availability, not independent approval, observed learner readiness, answer leakage or measured learning." },
    items: itemContexts, held_items: itemContexts.filter(item => item.holds.length).map(item => ({ item_id: item.item_id, reasons: item.holds })),
    qualification: false, independent_gold_labels: 0 };
}
