// Source references and assessment records. Preparation never approves quality or calls a model.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { resolvePointer } from "./packet.mjs";
import { digest } from "./lesson-package.mjs";

const object = value => value && typeof value === "object" && !Array.isArray(value);
const ordered = value => Array.isArray(value) ? value.map(ordered) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
const canonical = value => JSON.stringify(ordered(value));
const list = value => Array.isArray(value) ? value : [];
const text = value => typeof value === "string" && value.trim().length > 0;
const choiceKinds = new Set(["film_mcq", "key_term_mcq", "reading_mcq", "rebuild_choice"]);
const kinds = new Set(["integration-test", "source-review", "model-development", "human-review", "generator-context-coverage", "manual-notes"]);
const json = file => JSON.parse(fs.readFileSync(file, "utf8"));
function assertSourceView(row, ancestors) {
  const native = row.native, view = row.view;
  if (!object(view)) return;
  const same = (field, expected) => assert(canonical(view[field]) === canonical(expected), `normalized ${field} differs from source native`);
  if (choiceKinds.has(row.kind)) {
    const options = list(native.options).map(option => typeof option === "string" ? option : option?.text);
    same("options", options);
    const answer = native.answer ?? native.correct;
    same("key", [typeof answer === "string" ? options.indexOf(answer) : answer]);
    if (row.kind !== "rebuild_choice") same("stem", native.stem ?? native.q ?? native.task);
    if (row.kind === "film_mcq") same("option_feedback", native.feedback);
    if (["reading_mcq", "key_term_mcq"].includes(row.kind)) {
      same("option_feedback", list(native.options).map(option => object(option) ? option.why ?? null : null));
      same("correct_feedback", native.yes ?? null);
    }
  }
  if (row.kind === "classify") {
    same("prompt", native.goal); same("boxes", native.boxes);
    same("items", list(native.words).map(word => ({ word: word.w, to: word.to, kind: word.kind, meaning: word.meaning })));
  }
  if (row.kind === "open_check") {
    const prompts = [native.question, ...ancestors.filter(object).flatMap(value => [value.task, value.line, value.verdict_task, value.prompt])].filter(text);
    assert(prompts.includes(view.prompt), "normalized prompt differs from source native/context"); same("rubric", native);
  }
}
const write = (directory, name, value) => fs.writeFileSync(path.join(directory, name), typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
const assert = (condition, message) => { if (!condition) throw new Error(`golden: ${message}`); };
function safePath(root, relative) {
  assert(typeof relative === "string" && relative && !path.isAbsolute(relative), "invalid relative artifact path");
  const target = path.resolve(root, relative);
  assert(target.startsWith(root + path.sep), "artifact leaves its bundle");
  let cursor = root;
  for (const part of path.relative(root, target).split(path.sep)) {
    cursor = path.join(cursor, part);
    assert(!fs.existsSync(cursor) || !fs.lstatSync(cursor).isSymbolicLink(), "artifact symlinks are unsupported");
  }
  return target;
}
function read(file) {
  const stat = fs.lstatSync(file);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size < 64 * 1024 * 1024, "invalid source artifact");
  return fs.readFileSync(file);
}
export function sourceFieldChecks(row) {
  const view = row.view ?? {}, checks = [], add = (id, pass) => checks.push({ id, verdict: pass ? "pass" : "fail", method: "code" });
  if (choiceKinds.has(row.kind)) {
    const options = view.options, key = view.key;
    add("choices_present", Array.isArray(options) && options.length >= 2 && options.every(text));
    add("one_in_range_key", Array.isArray(options) && Array.isArray(key) && key.length === 1 && Number.isInteger(key[0]) && key[0] >= 0 && key[0] < options.length);
    add("literal_options_distinct", Array.isArray(options) && new Set(options).size === options.length);
  }
  if (row.kind === "classify") {
    add("classification_items_present", list(view.items ?? row.native?.words).length > 0);
    add("classification_destinations_present", object(view.boxes ?? row.native?.boxes) && Object.keys(view.boxes ?? row.native.boxes).length > 0);
  }
  if (["open_check", "quote_analysis"].includes(row.kind)) {
    const rubric = view.rubric ?? row.native;
    add("rubric_criteria_present", list(rubric?.criteria).length > 0);
    add("rubric_requirements_present", list(rubric?.criteria).length > 0 && rubric.criteria.every(criterion => object(criterion) && text(criterion.requirement)));
  }
  return { checks, status: checks.some(check => check.verdict === "fail") ? "field_fault" : checks.length ? "checked_fields_only" : "no_interpreted_field_checks",
    quality: "not evaluated", qualified: false };
}
function assessmentPlan(row, tier) {
  const confidence = row.kind === "confidence_self_report";
  const input = row.kind === "source_text_with_learning_question";
  return { reference_id: row.reference_id, kind: row.kind, role: row.role,
    unit_type: input ? "source_input" : "authored_activity",
    expected_baseline: tier === "primary" ? "positive by user designation; no independent per-criterion label" : "secondary reference candidate; no quality verdict",
    prerequisites: input ? ["finished question or task", "intended answer or scoring contract", "declared learner exposure"] : [],
    dimensions: (input ? ["source_and_context_integrity", "target_knowledge_and_intended_use", "content_suitability_and_access"] : confidence ? ["response_collection_contract"] : ["source_and_context_integrity", "target_knowledge_and_role", "wording_and_access", "answer_or_scoring_contract", "cueing_and_allowed_support", "feedback_grounding", "sequence_fit"])
      .map(dimension => ({ id: dimension, status: "not_run", verdict: null, applicability: "confirm against this task's role and supplied context before scoring" })),
    independent_human_label: null, whole_item_approval: false };
}
function controlledVariants(references) {
  const variants = [], add = (parent, operation, field, value, expectedCheck) => {
    const row = structuredClone(parent); row.view ??= {}; row.view[field] = value;
    const result = sourceFieldChecks(row);
    assert(result.checks.some(check => check.id === expectedCheck && check.verdict === "fail"), "derived fault was not detected by its declared source constraint");
    variants.push({ id: `fault-${digest({ parent: parent.reference_id, operation }).slice(0, 20)}`, parent_reference_id: parent.reference_id,
      kind: parent.kind, role: parent.role, operation, patch: { pointer: `/view/${field}`, before: parent.view?.[field] ?? null, after: value },
      candidate: row, expected: { check: expectedCheck, verdict: "fail", basis: "explicit field constraint; not an academic quality label" }, code_observation: result });
  };
  for (const parent of references.filter(row => choiceKinds.has(row.kind))) {
    add(parent, "key_out_of_range", "key", [parent.view.options.length], "one_in_range_key");
    const options = [...parent.view.options]; options[1] = options[0];
    add(parent, "duplicate_choice", "options", options, "literal_options_distinct");
  }
  for (const parent of references.filter(row => row.kind === "classify")) add(parent, "empty_classification", "items", [], "classification_items_present");
  for (const parent of references.filter(row => row.kind === "open_check" && row.view?.rubric?.criteria?.length))
    add(parent, "empty_marking_criteria", "rubric", { ...parent.view.rubric, criteria: [] }, "rubric_criteria_present");
  return variants;
}
export function prepareGolden(captureDirectory, outputDirectory, { tier = "primary" } = {}) {
  assert(["primary", "secondary"].includes(tier), "invalid reference tier");
  const capture = fs.realpathSync(captureDirectory), output = path.resolve(outputDirectory);
  const manifestBytes = read(safePath(capture, "positive-reference/manifest.json")), sourceManifest = JSON.parse(manifestBytes);
  const questionBytes = read(safePath(capture, sourceManifest.questions)), contextBytes = read(safePath(capture, sourceManifest.lesson_context));
  assert(digest(questionBytes) === sourceManifest.questions_sha256 && digest(contextBytes) === sourceManifest.source.sha256, "capture hash mismatch");
  const context = JSON.parse(contextBytes), rows = questionBytes.toString("utf8").trim().split("\n").map(line => JSON.parse(line));
  assert(rows.length > 0 && rows.length === sourceManifest.source_occurrences, "source count differs");
  const references = rows.map(row => {
    assert(text(row.kind) && text(row.role) && text(row.pointer) && Number.isInteger(row.extraction_order), "reference identity incomplete");
    const resolved = resolvePointer(context, row.pointer);
    assert(resolved.found && canonical(resolved.target) === canonical(row.native), "reference native differs from pinned context");
    assertSourceView(row, resolved.ancestors);
    assert(row.source_commit === sourceManifest.source.commit && row.source_sha256 === sourceManifest.source.sha256, "reference source pin differs");
    return { ...row, reference_id: `reference-${digest({ source: row.source_sha256, pointer: row.pointer, operation: row.operation, native: row.native }).slice(0, 24)}` };
  });
  assert(new Set(references.map(row => row.reference_id)).size === references.length, "duplicate reference identity");
  assert(!fs.existsSync(output), "output already exists");
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(output, "source"), { mode: 0o700 });
  fs.mkdirSync(path.join(output, "assessments"), { mode: 0o700 });
  write(output, "source/manifest.json", manifestBytes); write(output, "source/questions.jsonl", questionBytes); write(output, "source/lesson.json", contextBytes);
  write(output, "references.json", references);
  const variants = controlledVariants(references);
  write(output, "controlled-variants.json", variants); write(output, "assessment-plan.json", references.map(row => assessmentPlan(row, tier)));
  write(output, "field-observations.json", references.map(row => ({ reference_id: row.reference_id, ...sourceFieldChecks(row) })));
  write(output, "assessments/journal.jsonl", "");
  const files = Object.fromEntries(["source/manifest.json", "source/questions.jsonl", "source/lesson.json", "references.json", "controlled-variants.json", "assessment-plan.json", "field-observations.json"]
    .map(file => [file, digest(read(path.join(output, file)))]));
  const manifest = { version: 1, id: "current-golden-reference", source: sourceManifest.source, source_sha256: sourceManifest.source.sha256, files,
    capture_kind: sourceManifest.finished_capture === false ? "source_inputs" : "authored_activities",
    finished_assessment_units: sourceManifest.finished_assessment_units ?? null,
    references: references.length, kinds: [...new Set(references.map(row => row.kind))], controlled_variants: variants.length,
    roles: Object.fromEntries([...new Set(references.map(row => row.role))].map(role => [role, references.filter(row => row.role === role).length])),
    tier, priority: tier === "primary" ? 1 : 2,
    designation: tier === "primary" ? "user-designated default golden positive reference" : "lower-priority reference candidate; not a default positive quality label",
    independent_human_quality_labels: 0, qualification: false,
    evaluation_stage: "prepared; quality evaluation deferred", variant_scope: "Normalized candidate-view field controls; native UI behavior and pedagogical quality unmeasured." };
  write(output, "manifest.json", manifest);
  return checkGolden(output);
}
export function checkGolden(directory, expectedManifestHash) {
  const root = fs.realpathSync(directory), manifestBytes = read(path.join(root, "manifest.json")), manifest = JSON.parse(manifestBytes);
  assert(manifest.version === 1 && manifest.id === "current-golden-reference" && manifest.qualification === false, "invalid bundle manifest");
  assert(manifest.tier === undefined || ["primary", "secondary"].includes(manifest.tier), "invalid reference tier");
  if (expectedManifestHash) assert(digest(manifestBytes) === expectedManifestHash, "external bundle pin differs");
  for (const [file, hash] of Object.entries(manifest.files)) assert(digest(read(safePath(root, file))) === hash, "immutable reference artifact changed");
  const journalBytes = read(safePath(root, "assessments/journal.jsonl"));
  const records = journalBytes.toString().split("\n").filter(Boolean).map(line => JSON.parse(line));
  let previous = null;
  for (const row of records) {
    assert(row.previous_sha256 === previous && text(row.assessment_id), "assessment journal chain differs");
    assert(digest(read(safePath(root, row.artifact))) === row.artifact_sha256, "assessment artifact changed");
    const envelope = json(safePath(root, row.receipt));
    assert(digest(read(safePath(root, row.receipt))) === row.receipt_sha256 && envelope.assessment_id === row.assessment_id, "assessment receipt changed");
    assert(envelope.golden_manifest_sha256 === digest(manifestBytes) && envelope.artifact === row.artifact && envelope.artifact_sha256 === row.artifact_sha256,
      "assessment receipt belongs to another bundle or artifact");
    assert(kinds.has(envelope.kind) && ["same-reference", "related-diagnostic", "historical", "generated-candidate"].includes(envelope.relation)
      && envelope.independent_labels_admitted === 0 && envelope.quality_approval === false && envelope.qualification === false, "invalid assessment admission receipt");
    if (envelope.relation === "same-reference") assert(json(safePath(root, row.artifact)).golden_manifest_sha256 === digest(manifestBytes), "same-reference artifact pin differs");
    previous = digest(JSON.stringify(row));
  }
  return { root, tier: manifest.tier ?? "primary", manifest_sha256: digest(manifestBytes), references: manifest.references, kinds: manifest.kinds.length,
    controlled_variants: manifest.controlled_variants, assessment_records: records.length, assessment_journal_sha256: digest(journalBytes),
    integrity: "checked against recorded hashes; retain the returned journal pin separately to detect truncation", independent_human_quality_labels: 0, qualified: false, model_calls: 0 };
}
export function attachAssessment(directory, file, { kind, relation = "related-diagnostic" } = {}) {
  assert(kinds.has(kind) && ["same-reference", "related-diagnostic", "historical", "generated-candidate"].includes(relation), "invalid assessment kind or relation");
  const root = fs.realpathSync(directory), lock = safePath(root, "assessments/.lock");
  const descriptor = fs.openSync(lock, "wx", 0o600);
  try {
    const checked = checkGolden(root), bytes = read(file), payload = JSON.parse(bytes);
    assert(object(payload), "assessment must be a JSON object");
    assert(!/(?:apk_|apikey_|sk-(?:proj-)?)[A-Za-z0-9_-]{20,}/.test(bytes.toString()), "assessment contains credential-shaped data");
    if (relation === "same-reference") assert(payload.golden_manifest_sha256 === checked.manifest_sha256, "same-reference assessment lacks this exact bundle pin");
    const journal = safePath(root, "assessments/journal.jsonl"), previousRows = fs.readFileSync(journal, "utf8").split("\n").filter(Boolean);
    const id = crypto.randomUUID(), artifact = `assessments/${id}.artifact.json`, receipt = `assessments/${id}.receipt.json`;
    write(root, artifact, bytes);
    const envelope = { version: 1, assessment_id: id, kind, relation, golden_manifest_sha256: checked.manifest_sha256, at: new Date().toISOString(),
      artifact, artifact_sha256: digest(bytes), input_or_runtime_claims: "Retained in original artifact; importer does not validate its claims or transfer verdicts to current references.",
      independent_labels_admitted: 0, quality_approval: false, qualification: false };
    write(root, receipt, envelope);
    const entry = { assessment_id: id, previous_sha256: previousRows.length ? digest(previousRows.at(-1)) : null,
      artifact, artifact_sha256: digest(bytes), receipt, receipt_sha256: digest(read(path.join(root, receipt))) };
    fs.appendFileSync(journal, JSON.stringify(entry) + "\n");
    return { ...envelope, assessment_records: previousRows.length + 1, model_calls: 0 };
  } finally { fs.closeSync(descriptor); fs.unlinkSync(lock); }
}
