// Finished course/question transports only. No writer code, prompts or draft logs are read.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { inputIssues, packetProjection } from "./packet.mjs";
import { seenBefore, asText } from "./seen.mjs";

export const digest = value => crypto.createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex");
const arr = value => Array.isArray(value) ? value : [];
const present = value => typeof value === "string" && value.trim().length > 0;
function grouped(rows) {
  const map = new Map();
  for (const row of rows) { if (!map.has(row.id)) map.set(row.id, []); map.get(row.id).push(row); }
  return map;
}
const aliases = { mcq: ["reading_mcq", "key_term_mcq"], source_choice: ["reading_mcq"], evidence_selection: ["evidence_select"],
  short_explanation: ["open_check", "open_prompt"], scr: ["open_check", "open_prompt"], classification: ["classify"],
  integrated_response: ["open_check", "open_prompt"], rebuttal: ["open_check", "open_prompt"] };

export function loadLessonPackage(directory, { coursePin } = {}) {
  const root = fs.realpathSync(directory);
  const files = {};
  for (const name of ["course-request.json", "course-source-packet.json", "lesson-context.json", "question-set.json"]) {
    const file = path.join(root, name), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw new Error("invalid finished lesson transport");
    const bytes = fs.readFileSync(file); files[name] = { bytes, sha256: digest(bytes), value: JSON.parse(bytes) };
  }
  if (coursePin && files["course-request.json"].sha256 !== coursePin) throw new Error("course request differs from its external pin");
  const request = files["course-request.json"].value, source = files["course-source-packet.json"].value;
  const context = files["lesson-context.json"].value, set = files["question-set.json"].value;
  const issues = inputIssues(context, set);
  if (issues.length) throw new Error(`invalid finished lesson packet: ${issues.join("; ")}`);
  let runtimeEvidence = null;
  const runtimeFile = path.join(root, "runtime-evidence.json");
  let runtimeStat;
  try { runtimeStat = fs.lstatSync(runtimeFile); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (runtimeStat) {
    if (!runtimeStat.isFile() || runtimeStat.isSymbolicLink() || runtimeStat.size > 16 * 1024 * 1024) throw new Error("invalid runtime evidence transport");
    const bytes = fs.readFileSync(runtimeFile); runtimeEvidence = { bytes, sha256: digest(bytes), value: JSON.parse(bytes) };
    files["runtime-evidence.json"] = runtimeEvidence;
  }
  return { request, source, context, set, hashes: Object.fromEntries(Object.entries(files).map(([name, file]) => [name, file.sha256])),
    runtimeEvidence, external_course_pin_verified: Boolean(coursePin) };
}

export function auditLessonAlignment(request, set, context = null) {
  const course = request.course_context ?? {}, phases = arr(course.lesson_plan?.phases), blueprint = arr(request.sequence_blueprint);
  const assetRows = grouped(arr(course.source_assets)), targetRows = grouped(arr(course.core_knowledge)), keyRows = grouped(arr(course.content_keys));
  const assets = new Map([...assetRows].filter(([, rows]) => rows.length === 1).map(([id, rows]) => [id, rows[0]]));
  const targets = new Set(targetRows.keys()), keys = new Set(keyRows.keys());
  const pairMap = grouped(arr(course.pairing_tables).flatMap(table => arr(table.pairs))), pairs = new Set(pairMap.keys());
  const phaseRows = grouped(phases);
  const phaseMap = new Map(phases.map((phase, index) => [phase.id, { ...phase, position: index }]));
  const pageMap = new Map(arr(context?.native?.pages).map((page, index) => [page.id, index]));
  const checks = [], add = (id, condition, evidence) => checks.push({ id, verdict: condition ? "pass" : "fail", evidence });
  add("declared_course_inputs", assets.size > 0 && targets.size > 0 && phases.length > 0 && blueprint.length > 0, { assets: assets.size, targets: targets.size, phases: phases.length, blueprint: blueprint.length });
  add("planned_slots_filled", set.items.length === blueprint.length, { requested: blueprint.length, returned: set.items.length });
  let previousPhase = -1;
  const observedPhases = new Set(), observedTargets = new Set();
  const items = set.items.map((item, index) => {
    const alignment = item.alignment ?? {}, plan = blueprint[index] ?? {}, desired = plan.position?.alignment ?? plan.alignment ?? plan;
    const issues = [], refs = {};
    for (const [field, allowed] of [["target_refs", targets], ["source_refs", new Set(assets.keys())], ["content_key_refs", keys], ["pair_refs", pairs]]) {
      refs[field] = arr(alignment[field]);
      if (!refs[field].length || refs[field].some(ref => !allowed.has(ref))) issues.push(`missing_or_unknown_${field}`);
      const expected = desired[field] ?? (field === "target_refs" ? plan.target : null);
      if (Array.isArray(expected) && (expected.some(ref => !refs[field].includes(ref)) || refs[field].some(ref => !expected.includes(ref)))) issues.push(`differs_from_planned_${field}`);
    }
    for (const [field, rows] of [["target_refs", targetRows], ["source_refs", assetRows], ["content_key_refs", keyRows], ["pair_refs", pairMap]]) {
      if (refs[field].some(ref => (rows.get(ref)?.length ?? 0) > 1)) issues.push(`ambiguous_${field}`);
    }
    const phase = phaseMap.get(alignment.phase_ref);
    if (!phase || (desired.phase_ref && alignment.phase_ref !== desired.phase_ref)) issues.push("unknown_or_wrong_phase");
    if ((phaseRows.get(alignment.phase_ref)?.length ?? 0) > 1) issues.push("ambiguous_phase_ref");
    if (phase) {
      if (phase.position < previousPhase) issues.push("phase_order_reversed");
      if (item.page !== phase.id) issues.push("item_page_differs_from_declared_phase");
      if (context && !pageMap.has(phase.id)) issues.push("phase_page_absent");
      for (const prerequisite of arr(phase.after)) {
        const actualBefore = context ? pageMap.has(prerequisite) && pageMap.get(prerequisite) < pageMap.get(phase.id)
          : phaseMap.has(prerequisite) && phaseMap.get(prerequisite).position < phase.position;
        if (!actualBefore) issues.push("prerequisite_phase_not_yet_present");
      }
      previousPhase = Math.max(previousPhase, phase.position); observedPhases.add(phase.id);
      for (const target of refs.target_refs) observedTargets.add(target);
    }
    if (item.order !== index + 1) issues.push("slot_order_differs");
    if (desired.role && alignment.role !== desired.role) issues.push("role_differs_from_plan");
    if (desired.support && alignment.support !== desired.support) issues.push("support_differs_from_plan");
    const formats = arr(plan.formats).flatMap(format => aliases[format] ?? [format]);
    if (formats.length && !formats.includes(item.kind)) issues.push("format_differs_from_plan");
    const anchors = arr(item.source_anchors);
    if (!anchors.length) issues.push("source_anchors_missing");
    for (const anchor of anchors) {
      const asset = assets.get(anchor.source_ref);
      if (!asset || !refs.source_refs.includes(anchor.source_ref) || !present(anchor.quote) || !String(asset.text ?? "").includes(anchor.quote)) issues.push("source_anchor_not_exact_in_declared_asset");
    }
    const pairingRelationships = refs.pair_refs.map(id => {
      const candidates = pairMap.get(id) ?? [], pair = candidates[0], problems = [];
      if (candidates.length !== 1) problems.push("missing_or_ambiguous_pair_row");
      for (const field of ["target_ref", "source_ref"]) {
        if (!pair || !present(pair[field])) problems.push(`missing_required_pair_${field}`);
      }
      const fields = [["target_ref", refs.target_refs], ["source_ref", refs.source_refs],
        ["content_key_ref", refs.content_key_refs], ["phase_ref", [alignment.phase_ref]]];
      for (const [field, selected] of fields) {
        if (pair && Object.hasOwn(pair, field) && (!present(pair[field]) || !selected.includes(pair[field])))
          problems.push(`pair_${field}_not_in_item_alignment`);
      }
      const candidatesForKey = keyRows.get(pair?.content_key_ref) ?? [], key = candidatesForKey.length === 1 ? candidatesForKey[0] : null;
      if (candidatesForKey.length > 1) problems.push("ambiguous_pair_content_key");
      for (const [field, pairField] of [["target_refs", "target_ref"], ["source_refs", "source_ref"], ["phase_refs", "phase_ref"]]) {
        if (key && Object.hasOwn(pair, pairField) && Object.hasOwn(key, field) && (!Array.isArray(key[field]) || !key[field].includes(pair[pairField])))
          problems.push(`pair_differs_from_content_key_${field}`);
      }
      const missing = fields.map(([field]) => field).filter(field => !pair || !Object.hasOwn(pair, field));
      if (problems.length) issues.push("pairing_relationship_invalid");
      return { pair_ref: id, status: problems.length ? "invalid" : missing.length ? "undetermined" : "declared_tuple_checked",
        missing_fields: missing, issues: problems, semantic_warrant: "requires independent review" };
    });
    return { item_id: item.id, order: item.order, kind: item.kind, alignment, source_anchors: anchors,
      pairing_relationships: pairingRelationships,
      structure: issues.length ? "fail" : "pass", issues: [...new Set(issues)], factual_entailment: "requires independent review" };
  });
  add("every_planned_target_referenced", [...targets].every(target => observedTargets.has(target)), { missing: [...targets].filter(target => !observedTargets.has(target)) });
  const questionPhases = new Set(blueprint.map(plan => (plan.position?.alignment ?? plan.alignment ?? plan).phase_ref).filter(present));
  add("every_planned_question_phase_represented", [...questionPhases].every(phase => observedPhases.has(phase)), { missing: [...questionPhases].filter(phase => !observedPhases.has(phase)) });
  if (context) add("all_teaching_phases_present", phases.every(phase => pageMap.has(phase.id)), { missing: phases.filter(phase => !pageMap.has(phase.id)).map(phase => phase.id) });
  return { version: 1, checks, items, status: checks.some(check => check.verdict === "fail") || items.some(item => item.structure === "fail") ? "needs_revision" : "structural_alignment_checked",
    meaning: "Reference integrity and declared sequence only; source entailment, teaching quality, readiness and served learner exposure are unverified.", academic_approval: false };
}

function learnerTask(item) {
  const view = item.view ?? {};
  if (["reading_mcq", "key_term_mcq", "film_mcq", "rebuild_choice"].includes(item.kind)) return { question: view.stem, options: arr(view.options) };
  if (item.kind === "evidence_select") return { question: view.prompt, evidence_options: [...arr(view.candidates), ...arr(view.decoys)].sort() };
  if (item.kind === "classify") return { question: view.prompt, words: arr(view.items).map(word => word.word), destinations: Object.values(view.boxes ?? {}).flatMap(box => [box.is, box.seems, box.wanted]).filter(present) };
  return { question: view.prompt ?? view.rubric?.question ?? null };
}

export function lessonReviewPacket(context, set) {
  const projected = packetProjection(context, set);
  const items = projected.set.items.map(item => ({ id: item.id, kind: item.kind, order: item.order,
    seen_before: asText(seenBefore(projected.context.native, item, projected.set.items)), task: learnerTask(item),
    review: { answerable: null, unambiguous: null, independently_expected_answer: null, proposed_scoring_criteria: null, rationale: null } }));
  return { version: 1, stage: "independent_answer_before_author_key", input: projected.hashes, items,
    source_key_and_feedback_withheld: true, labels: "pending; not academic gold", learner_exposure: "authoring preview; delivered UI and conditional routes unverified" };
}

export function lessonText(context, set, audit) {
  const lines = [context.lesson.title ?? context.lesson.id, "Prepared for internal review; academic approval pending.", `Lesson question: ${context.lesson.learning_question}`, ""];
  for (const item of set.items) {
    const task = learnerTask(item), row = audit.items.find(row => row.item_id === item.id);
    lines.push(`${item.order}. ${item.kind} | ${item.alignment?.role ?? "unplaced"}`, String(task.question ?? "Missing question"));
    for (const [index, option] of arr(task.options ?? task.evidence_options).entries()) lines.push(`   ${String.fromCharCode(65 + index)}. ${option}`);
    if (task.words) lines.push(`   Words: ${task.words.join("; ")}`, `   Destinations: ${task.destinations.join("; ")}`);
    if (item.view?.key) lines.push(`   Intended key (unvalidated): ${item.view.key.map(index => String.fromCharCode(65 + index)).join(", ")}`);
    if (item.view?.rubric) {
      lines.push("   Proposed rubric:");
      for (const criterion of arr(item.view.rubric.criteria)) lines.push(`   - ${criterion.requirement}`);
    }
    for (const anchor of arr(item.source_anchors)) lines.push(`   Source ${anchor.source_ref}: ${anchor.quote}`);
    lines.push(`   Placement/source fields: ${row?.structure ?? "unknown"}${row?.issues.length ? ` (${row.issues.join(", ")})` : ""}`, "");
  }
  lines.push("This editor view includes intended answers. The separate academic review packets withhold them.", "Exact citations and passing checks do not establish question quality or individual difficulty.");
  return lines.join("\n") + "\n";
}
