// Intake and blind review preparation for finished native activity transports. No models run here.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { resolvePointer } from "./packet.mjs";
import { digest } from "./lesson-package.mjs";
import { validateEmittedChecks, CRITERION_METADATA_PIN } from "./criterion-metadata.mjs";
import { resolveInstructionalContext } from "./instructional-context.mjs";
import { prepareSequenceReview, learnerReviewContext, summarizeSequenceReview } from "./sequence-review.mjs";
import { parseCliOptions } from "./cli-options.mjs";
import { inspectSequenceReturn } from "./sequence-return.mjs";

const object = value => value && typeof value === "object" && !Array.isArray(value);
const list = value => Array.isArray(value) ? value : [];
const text = value => typeof value === "string" && value.trim().length > 0;
const ordered = value => Array.isArray(value) ? value.map(ordered) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
const equal = (a, b) => JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));
const assert = (condition, message) => { if (!condition) throw new Error(`native intake: ${message}`); };
const pick = (value, keys) => object(value) ? Object.fromEntries(keys.filter(key => typeof value[key] === "string").map(key => [key, value[key]])) : {};
const strings = value => Array.isArray(value) && value.every(text) ? value : null;
function learnerView(item) {
  const view = item.view, task = pick(view, ["prompt", "response_mode"]);
  if (list(view.response_parts).every(text)) task.response_parts = view.response_parts;
  if (["single_choice", "multiple_select", "evidence_selection", "word_selection"].includes(item.family)) Object.assign(task, { options: strings(view.options) }, pick(view, ["claim", "selection_rule"]));
  if (item.family === "classification") {
    task.categories = list(view.categories).map(row => pick(row, ["id", "label", "entity", "relation", "description"]));
    task.entries = list(view.entries).map(row => pick(row, ["id", "text"]));
  }
  if (item.family === "inline_choice") {
    Object.assign(task, pick(view, ["surrounding_text"]));
    task.blanks = list(view.blanks).map(row => ({ ...pick(row, ["id"]), options: strings(row?.options) }));
  }
  if (item.family === "shared_cloze") {
    Object.assign(task, pick(view, ["surrounding_text", "reuse_policy"]));
    task.bank = list(view.bank).map(row => pick(row, ["id", "text"]));
    task.blanks = list(view.blanks).map(row => pick(row, ["id"]));
  }
  if (["matching", "sequence"].includes(item.family)) task.entries = list(view.entries).map(row => pick(row, ["id", "text"]));
  if (item.family === "matching") task.options = list(view.options).map(row => pick(row, ["id", "text"]));
  if (item.family === "sequence") Object.assign(task, pick(view, ["ordering_rule", "tie_policy"]));
  if (item.family === "nonresponse") Object.assign(task, pick(view, ["instruction"]));
  if (item.family === "word_web") Object.assign(task, pick(view, ["centre", "link_rule"]));
  if (item.family === "say_back") Object.assign(task, pick(view, ["statement"]));
  if (item.family === "self_report") task.scale = strings(view.scale);
  return task;
}
function read(directory, name) {
  const file = path.join(directory, name), stat = fs.lstatSync(file);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size < 16 * 1024 * 1024, "invalid finished artifact");
  const bytes = fs.readFileSync(file);
  return { bytes, sha256: digest(bytes), value: JSON.parse(bytes) };
}
export function nativeFieldChecks(item) {
  const view = item.view, checks = [], add = (id, valid) => checks.push({ id, verdict: valid ? "pass" : "fail" });
  add(item.family === "nonresponse" ? "instruction_present" : "prompt_present", text(item.family === "nonresponse" ? view.instruction : view.prompt));
  if (["single_choice", "multiple_select", "evidence_selection", "word_selection"].includes(item.family)) {
    add("options_present", list(view.options).length >= 2 && view.options.every(text));
    add("options_distinct", Array.isArray(view.options) && new Set(view.options).size === view.options.length);
    add("key_valid", list(view.key).length > 0 && new Set(view.key).size === view.key.length && view.key.every(key => Number.isInteger(key) && key >= 0 && key < list(view.options).length)
      && (item.family !== "single_choice" || view.key.length === 1));
  } else if (item.family === "classification") {
    const entries = list(view.entries), categories = list(view.categories), destinations = new Set(categories.map(row => row?.id));
    add("entries_present", entries.length > 0 && entries.every(row => object(row) && text(row.id) && text(row.text)) && new Set(entries.map(row => row.id)).size === entries.length);
    add("categories_present", categories.length > 0 && categories.every(row => object(row) && text(row.id) && text(row.label) && text(row.description)) && destinations.size === categories.length);
    add("mapping_valid", object(view.mapping) && entries.length > 0 && entries.every(row => destinations.has(view.mapping[row.id])));
  } else if (["written_response", "oral_response", "word_web"].includes(item.family)) {
    add("rubric_requirements_present", list(view.rubric?.criteria).length > 0 && view.rubric.criteria.every(row => object(row) && text(row.requirement)));
    add("sample_answer_present", text(view.sample_answer));
  } else if (item.family === "inline_choice") {
    add("blanks_present", list(view.blanks).length > 0);
    add("blank_keys_valid", list(view.blanks).length > 0 && view.blanks.every(row => object(row) && text(row.id) && list(row.options).length >= 2
      && row.options.every(text) && Number.isInteger(row.key) && row.key >= 0 && row.key < row.options.length));
  } else if (item.family === "shared_cloze") {
    const bank = list(view.bank), blanks = list(view.blanks), ids = new Set(bank.map(row => row?.id));
    add("bank_entries_present", bank.length > 0 && bank.every(row => object(row) && text(row.id) && text(row.text)) && ids.size === bank.length);
    add("shared_blank_keys_valid", blanks.length > 0 && blanks.every(row => object(row) && text(row.id) && ids.has(row.key)) && new Set(blanks.map(row => row.id)).size === blanks.length);
    add("shared_bank_reuse_obeys_rule", ["single-use", "reusable"].includes(view.reuse_policy) && (view.reuse_policy !== "single-use" || new Set(blanks.map(row => row.key)).size === blanks.length));
  } else if (["matching", "sequence"].includes(item.family)) {
    const entries = list(view.entries), ids = new Set(entries.map(row => row?.id));
    add("response_entries_present", entries.length > 0 && entries.every(row => object(row) && text(row.id) && text(row.text)) && ids.size === entries.length);
    if (item.family === "matching") {
      const options = list(view.options), destinations = new Set(options.map(row => row?.id));
      add("matching_options_present", options.length > 0 && options.every(row => object(row) && text(row.id) && text(row.text)) && destinations.size === options.length);
      add("matching_mapping_valid", object(view.mapping) && entries.length > 0 && entries.every(row => destinations.has(view.mapping[row.id])));
    } else {
      add("sequence_key_is_permutation", Array.isArray(view.key) && view.key.length === entries.length && new Set(view.key).size === entries.length && view.key.every(id => ids.has(id)));
      add("ordering_rule_and_tie_policy_present", text(view.ordering_rule) && text(view.tie_policy));
    }
  } else if (item.family === "nonresponse") {
    add("instruction_has_no_response_key", !["key", "mapping", "rubric", "sample_answer"].some(field => Object.hasOwn(view, field)));
  } else if (item.family === "say_back") {
    add("recall_statement_present", text(view.statement));
    add("recall_is_not_reasoning_grade", view.scoring === "unscored-recall");
  } else if (item.family === "self_report") {
    add("report_scale_present", list(view.scale).length >= 2 && view.scale.every(text));
    add("report_is_not_correctness_grade", view.scoring === "none");
  } else add("family_field_interpreter_available", false);
  return checks;
}
export function prepareNativeIntake(directory, output, { sourcePin, replayConfig } = {}) {
  const root = fs.realpathSync(directory), contextFile = read(root, "lesson-context.json"), setFile = read(root, "question-set.json");
  const context = contextFile.value, set = setFile.value;
  assert(context.contract === "lesson-context 0.1" && set.contract === "question-set native 0.2"
    && context.adapter_extension === "native-activity-transport/0.2" && set.adapter_extension === context.adapter_extension, "unsupported transport version");
  assert(text(context.lesson?.id) && set.lesson === context.lesson.id && object(context.native), "lesson identity differs");
  const source = context.source?.lesson_source ?? context.source?.source;
  assert(object(source) && equal(source, set.source?.lesson_source ?? set.source?.source), "source pins differ");
  if (sourcePin) assert(source.sha256 === sourcePin, "external source pin differs");
  const course = context.native.course_context;
  assert(object(course) && Array.isArray(course.source_assets) && Array.isArray(course.core_knowledge) && Array.isArray(course.lesson_plan?.phases), "course inputs missing");
  for (const asset of course.source_assets) {
    assert(object(asset) && text(asset.id) && (asset.kind == null || text(asset.kind)) && (asset.text == null || typeof asset.text === "string"), "invalid visible source fields");
    assert(asset.media_ref == null || typeof asset.media_ref === "string", "invalid visible media reference");
    assert(asset.time_range == null || (Array.isArray(asset.time_range) && asset.time_range.length === 2 && asset.time_range.every(value => Number.isFinite(value) && value >= 0)
      && asset.time_range[0] <= asset.time_range[1]), "invalid visible media time range");
    assert(asset.source_status == null || typeof asset.source_status === "string", "invalid source status");
  }
  const assets = new Map(course.source_assets.map(row => [row.id, row])), phases = new Map(course.lesson_plan.phases.map(row => [row.id, row]));
  assert(assets.size === course.source_assets.length && phases.size === course.lesson_plan.phases.length, "duplicate course source or phase ids");
  const targets = new Set(course.core_knowledge.map(row => row.id)), contentKeys = new Set(list(course.content_keys).map(row => row.id)), pairs = new Set(list(course.pairing_map).map(row => row.id));
  assert(list(set.items).length > 0, "empty activity set");
  const identities = new Set(), orders = new Set(), cases = [], authors = [], observations = [];
  let previousPhasePosition = -1;
  for (const item of set.items) {
    assert(object(item) && text(item.id) && !identities.has(item.id) && Number.isInteger(item.order) && item.order > 0 && !orders.has(item.order), "invalid or duplicated activity identity");
    const precedingIds = new Set(identities); identities.add(item.id); orders.add(item.order);
    assert(text(item.kind) && text(item.family) && object(item.view) && object(item.native), "activity fields missing");
    const target = resolvePointer(context.native, item.pointer), page = list(context.native.pages).find(row => row.id === item.page);
    assert(target.found && equal(target.target, item.native) && equal(item.view, item.native.view) && item.id === item.native.id && item.kind === item.native.kind && item.family === item.native.family
      && page && target.ancestors.includes(page), "activity differs from its native pointer");
    const phase = phases.get(item.alignment?.phase_ref);
    const phasePosition = course.lesson_plan.phases.indexOf(phase);
    assert(phase && phasePosition >= previousPhasePosition && (phase.exposure_order === undefined || Number.isInteger(phase.exposure_order) && phase.exposure_order > 0), "phase or exposure order differs");
    previousPhasePosition = phasePosition;
    const declared = item.native.source_context, alignment = item.alignment;
    assert(object(declared) && object(alignment) && declared.id === item.id && declared.native_kind === item.kind && declared.family === item.family
      && declared.page_ref === item.page && declared.phase_ref === alignment.phase_ref, "native source context differs");
    assert(text(alignment.role) && alignment.role === declared.role && text(alignment.support) && alignment.support === declared.support
      && (phase.role === undefined || text(phase.role)) && (phase.support === undefined || text(phase.support) && phase.support === alignment.support),
      "role or support differs from declared context");
    for (const [field, allowed] of [["target_refs", targets], ["content_key_refs", contentKeys], ["pair_refs", pairs]]) {
      assert(Array.isArray(alignment[field]) && equal(alignment[field], declared[field]) && alignment[field].every(ref => text(ref) && allowed.has(ref)), `unknown or differing ${field}`);
    }
    assert(equal(alignment.target_refs, phase.target_refs), "phase targets differ");
    assert(Array.isArray(alignment.depends_on) && equal(alignment.depends_on, declared.depends_on)
      && alignment.depends_on.every(ref => precedingIds.has(ref)), "absent, forward or differing dependency");
    assert(Array.isArray(item.source_bindings) && equal(item.source_bindings, item.native.source_bindings), "native source bindings differ");
    assert(Array.isArray(phase.source_refs) && phase.source_refs.every(ref => assets.has(ref)), "phase names an absent source");
    const id = `native-${digest({ kind: item.kind, order: item.order, view: item.view }).slice(0, 24)}`;
    const visibleSources = phase.source_refs.map(ref => ({ id: ref, kind: assets.get(ref).kind ?? null, text: assets.get(ref).text ?? null,
      time_range: assets.get(ref).time_range ?? null, media_ref: assets.get(ref).media_ref ?? null, source_status: assets.get(ref).source_status ?? null }));
    const checks = nativeFieldChecks(item);
    for (const [index, binding] of list(item.source_bindings).entries()) {
      const field = typeof binding.field_ref === "string" && binding.field_ref.startsWith("/view/") ? resolvePointer(item, binding.field_ref) : { found: false };
      checks.push({ id: `binding_${index + 1}_declared_and_exact`, verdict: field.found && phase.source_refs.includes(binding.source_ref)
        && text(binding.quote) && String(assets.get(binding.source_ref)?.text ?? "").includes(binding.quote) ? "pass" : "fail" });
    }
    const task = learnerView(item), role = item.alignment.role;
    cases.push({ id, kind: item.kind, family: item.family, order: item.order, declared_role: role, declared_phase_role: phase.role ?? null,
      phase_to_task_role_relation: "not verified; phase labels and assessment purpose are separate declarations", declared_support: alignment.support,
      learner_view: task, visible_sources: visibleSources, earlier_activity_ids: cases.map(row => row.id),
      exposure: "Declared source availability and prior task order only; learner response, conditional feedback and served UI are not verified.",
      review: { intended_use: null, answerable: null, clarity: null, independently_expected_response: null, scoring_requirements: null,
        suitability_and_access: null, sequence_fit: null, rationale: null } });
    authors.push({ id, author_item_id: item.id, view: item.view, source_bindings: list(item.source_bindings),
      declared_targets: course.core_knowledge.filter(row => list(item.alignment.target_refs).includes(row.id)), alignment: item.alignment });
    observations.push({ id, kind: item.kind, family: item.family, checks, academic_approval: false,
      status: checks.every(row => row.verdict === "pass") ? "checked_fields_only" : "field_fault_or_unsupported_interpreter" });
  }
  assert(set.items.every((item, index) => item.order === index + 1), "activity order is not a complete sequence");
  const instructionalContext = resolveInstructionalContext({ request: { course_context: course, student_context: context.native.student_context }, context, set });
  const contextById = new Map(instructionalContext.items.map(item => [item.item_id, item]));
  for (const [index, item] of cases.entries()) {
    const resolved = contextById.get(set.items[index].id);
    const { measurement_intent, ...blindPurpose } = resolved.assessment_purpose;
    item.assessment_purpose = blindPurpose;
    item.learner_context = learnerReviewContext(resolved);
    if (instructionalContext.whole_lesson.instructional_plan) {
      item.visible_sources = [];
      item.exposure = "Explicit plan event content is the declared learner preview; whole provenance assets are withheld. Actual served exposure remains unverified.";
    }
    item.context_holds = resolved.holds;
  }
  const returnedSequence = inspectSequenceReturn({ context, set });
  const sequenceReview = prepareSequenceReview(instructionalContext, { route: "native0.2", returnedSequence });
  const noResponseKeys = value => Array.isArray(value) ? value.map(noResponseKeys) : object(value)
    ? Object.fromEntries(Object.entries(value).filter(([field]) => !["key", "keys", "mapping", "producer", "made_by", "metadata"].includes(field)).map(([field, child]) => [field, noResponseKeys(child)])) : value;
  sequenceReview.state.proposed_marking_guides = set.items.map(item => ({ item_id: item.id,
    ...Object.fromEntries(["rubric", "sample_answer", "scoring"].filter(field => Object.hasOwn(item.view, field)).map(field => [field, noResponseKeys(item.view[field])])) }));
  sequenceReview.state.marking_guide_status = "Unvalidated author proposals for design review; actual runtime marking accuracy is not established.";
  const fieldSources = validateEmittedChecks("native0.2", [...observations.flatMap((item, index) => item.checks.map(check => ({ check, family: item.family, stage: "field", purpose: instructionalContext.items[index].assessment_purpose.purpose }))),
    ...returnedSequence.checks.map(check => ({ check, stage: "sequence-field", purpose: instructionalContext.whole_lesson.purpose.purpose }))]);
  const criterionSources = { pins: CRITERION_METADATA_PIN, ...fieldSources, checked: fieldSources.checked + sequenceReview.criterion_sources.checked,
    annotations: [...fieldSources.annotations, ...sequenceReview.criterion_sources.annotations] };
  assert(!fs.existsSync(output), "output already exists"); fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  const write = (name, value) => fs.writeFileSync(path.join(output, name), Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  write("lesson-context.json", contextFile.bytes); write("question-set.json", setFile.bytes);
  write("review-packet.json", { version: 1, stage: "independent_response_before_author_key", items: cases, labels: "pending", qualification: false });
  write("author-fields.json", { version: 1, items: authors, status: "author proposals; not gold labels" });
  write("instructional-context.json", instructionalContext);
  write("sequence-review-packet.json", sequenceReview);
  write("field-observations.json", observations);
  write("criterion-sources.json", criterionSources);
  const hashes = Object.fromEntries(["lesson-context.json", "question-set.json", "review-packet.json", "author-fields.json", "field-observations.json", "criterion-sources.json", "instructional-context.json", "sequence-review-packet.json"].map(name => [name, digest(fs.readFileSync(path.join(output, name)))]));
  const receipt = { version: 1, at: new Date().toISOString(), source, input_hashes: { context: contextFile.sha256, set: setFile.sha256 }, files: hashes,
    ...(replayConfig ? { replay_config: replayConfig } : {}),
    runtime_files: Object.fromEntries(["native-intake.mjs", "packet.mjs", "lesson-package.mjs", "criterion-metadata.mjs", "instructional-context.mjs", "sequence-review.mjs", "sequence-return.mjs"].map(name => [name, digest(fs.readFileSync(new URL(name, import.meta.url)))])),
    criterion_metadata: CRITERION_METADATA_PIN,
    activities: cases.length, kinds: [...new Set(cases.map(row => row.kind))], returned_sequence: returnedSequence,
    code_checks: observations.reduce((n, row) => n + row.checks.length, returnedSequence.checks.length),
    code_failures: observations.reduce((n, row) => n + row.checks.filter(check => check.verdict === "fail").length, returnedSequence.checks.filter(check => check.verdict === "fail").length),
    context_holds: instructionalContext.held_items, sequence_review: { status: "prepared; no semantic judgment run", holds: sequenceReview.holds, qualification: false },
    external_source_pin_verified: Boolean(sourcePin), review_stage: "prepared; quality evaluation deferred", model_calls: 0, independent_gold_labels: 0, qualified: false };
  write("receipt.json", receipt); return { ...receipt, root: output };
}
export function runNativeIntakeCli({ root, argv = process.argv.slice(2) }) {
  const parsed = parseCliOptions(argv);
  assert(parsed.route === "native", "unsupported route");
  const flags = Object.fromEntries(Object.entries(parsed.flags).map(([key, value]) => [`--${key}`, value]));
  const active = (flags["--judge"] ?? "none") !== "none" || (flags["--side-judge"] ?? "none") !== "none";
  assert(active || !flags["--env-file"], "launch credentials require an active development judge");
  let replay;
  if (active || flags["--config"]) {
    const configFile = path.resolve(root, flags["--config"] ?? "config.lesson.json"), bytes = fs.readFileSync(configFile), config = JSON.parse(bytes);
    assert(config.version === 1 && config.execution === "offline-only" && ["samples", "repeats"].every(key => Number.isInteger(config[key]) && config[key] >= 1 && config[key] <= 16) && config.repeats >= 2, "invalid replay configuration");
    replay = { configFile, config, pin: { sha256: digest(bytes), samples: config.samples, repeats: config.repeats } };
  }
  assert(text(flags["--native-package"]), "missing finished package");
  const output = path.resolve(root, flags["--out"] ?? `.local/native-intake/${crypto.randomUUID()}`);
  assert(output.startsWith(path.join(root, ".local") + path.sep), "output must be private within this checkout");
  let cursor = root;
  for (const part of path.relative(root, output).split(path.sep)) { cursor = path.join(cursor, part); assert(!fs.existsSync(cursor) || !fs.lstatSync(cursor).isSymbolicLink(), "output symlinks unsupported"); }
  const receipt = prepareNativeIntake(path.resolve(flags["--native-package"]), output, { sourcePin: flags["--native-source-pin"], replayConfig: replay?.pin });
  return active ? runNativeDevelopmentReview({ root, output, flags, receipt, replay }) : receipt;
}

export function verifyNativePreparation(output, receipt) {
  const { root, ...recorded } = receipt;
  const expectedReceiptHash = digest(JSON.stringify(recorded, null, 2) + "\n");
  assert(read(output, "receipt.json").sha256 === expectedReceiptHash, "prepared receipt hash differs");
  const artifacts = {};
  for (const [name, expected] of Object.entries(recorded.files)) {
    const file = read(output, name);
    assert(file.sha256 === expected, "prepared artifact hash differs");
    artifacts[name] = file.value;
  }
  return { receipt_sha256: expectedReceiptHash, files_verified: Object.keys(recorded.files).length, artifacts };
}

async function runNativeDevelopmentReview({ root, output: out, flags, receipt, replay }) {
  const { runtimeSnapshot } = await import("./replay.mjs");
  const { runFrozenLessonDraws, lessonAccounting } = await import("./text-lesson-cli.mjs");
  const preparation = verifyNativePreparation(out, receipt);
  const { configFile, config } = replay;
  const sequence = preparation.artifacts["sequence-review-packet.json"], packet = { version: 1, cases: [], sequence_review: sequence };
  const writeOut = (name, value) => fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  writeOut("solver-packet.json", packet);
  const protocolBytes = fs.readFileSync(path.join(root, "criteria/text-lesson-probe.json"));
  const manifest = { version: 1, route: "native0.2", mode: "development", runtime: runtimeSnapshot(root, configFile),
    packet_sha256: digest(fs.readFileSync(path.join(out, "solver-packet.json"))), protocol_sha256: digest(protocolBytes),
    preparation_receipt_sha256: preparation.receipt_sha256,
    config: { samples: config.samples, repeats: config.repeats }, qualified: false, independent_gold_labels: 0,
    scope: "Whole-sequence instructional design across supplied native activities; per-format semantic correctness and runtime marking remain unverified." };
  writeOut("manifest.json", manifest);
  const draws = await runFrozenLessonDraws({ root, out, configFile, config, manifest,
    judge: flags["--judge"] ?? "none", sideJudge: flags["--side-judge"] ?? "none", envFile: flags["--env-file"] });
  verifyNativePreparation(out, receipt);
  const summary = summarizeSequenceReview(draws, sequence), accounting = lessonAccounting(draws);
  if (receipt.code_failures) summary.status = "needs_revision";
  writeOut("report.json", { ...manifest, activities: receipt.activities, summary, accounting });
  return { out: path.relative(root, out), activities: receipt.activities, draws: draws.length, status: summary.status, accounting, qualified: false };
}
