// Private human-review pilot data. This module performs no I/O writes, model calls or qualification.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectCriterionPackets } from "./evaluate.mjs";
import { packetProjection } from "./packet.mjs";
import { runtimeSnapshot, sha } from "./replay.mjs";
import { KNOWLEDGE_BASELINE } from "./knowledge-baseline.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const record = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const ordered = (x) => Array.isArray(x) ? x.map(ordered) : record(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, ordered(x[k])])) : x;
export const pilotHash = (value) => sha(JSON.stringify(ordered(value)));
const freeze = (x) => { if (x && typeof x === "object") { Object.values(x).forEach(freeze); Object.freeze(x); } return x; };
const sealed = (value) => freeze({ ...structuredClone(value), sha256: pilotHash(value) });
const withoutHash = ({ sha256, ...value }) => value;
const isHash = (x) => typeof x === "string" && /^[a-f0-9]{64}$/.test(x);
const text = (x) => typeof x === "string" && x.trim().length > 0;
const alias = (x) => typeof x === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(x);
const key = (item, criterion) => JSON.stringify([item, criterion]);
const normAlias = (x) => x?.trim().toLowerCase();
const fail = (what) => { throw new TypeError(`invalid pilot ${what}`); };
const integrity = (value, name) => { if (!record(value) || !isHash(value.sha256) || pilotHash(withoutHash(value)) !== value.sha256) fail(`${name} hash`); };
const LIMITS = ["pilot only; academically unqualified", "source development observations are not human gold or holdout evidence",
  "reviewer aliases and independence declarations require external identity and process verification",
  "criterion checks within a lesson are correlated; repeated draws do not increase distinct cases",
  "learner exposure is an unverified native reconstruction", "criterion snapshots can differ from actual batched model requests",
  "fresh holdout, academic review identities and authenticated evidence remain external prerequisites"];

function blankTemplate(sheet) {
  const template = structuredClone(sheet); delete template.template_sha256;
  template.reviewer_alias = null; template.independent_review_declared = false;
  template.rows.forEach((row) => { row.verdict = null; row.rationale = null; });
  return template;
}
function validateBundle(bundle) {
  integrity(bundle, "bundle");
  if (bundle.schema_version !== 1 || bundle.qualification !== "unqualified" || bundle.kind !== "human-review-pilot"
    || !Array.isArray(bundle.entries) || !bundle.entries.length || !Array.isArray(bundle.sheet_templates) || bundle.sheet_templates.length !== 2) fail("bundle");
  const cases = new Set(), pairs = new Set();
  for (const row of bundle.entries) {
    if (!text(row.case_id) || cases.has(row.case_id) || pairs.has(key(row.item_id, row.criterion_id))
      || !["classify", "open_check"].includes(row.kind) || typeof row.expect !== "boolean"
      || sha(JSON.stringify(row.packet)) !== row.criterion_packet_sha256) fail("case mapping");
    cases.add(row.case_id); pairs.add(key(row.item_id, row.criterion_id));
  }
}

export function preparePilot(context, set, { baseline, source, observations = [], configFile = path.join(ROOT, "config.json"), model = null, samples = 3, projected = false } = {}) {
  for (const pin of [baseline, source]) if (!record(pin) || !text(pin.id) || !isHash(pin.sha256)) fail("source pin");
  const manifestBytes = fs.readFileSync(path.join(ROOT, "fixtures/reference/manifest.json"));
  const baselineBytes = fs.readFileSync(path.join(ROOT, "fixtures/knowledge-baseline.json"));
  if (sha(baselineBytes) !== KNOWLEDGE_BASELINE.sha256) fail("knowledge baseline hash");
  const pinnedFiles = JSON.parse(baselineBytes).public_files, manifest = JSON.parse(manifestBytes), reference = {};
  if (manifest.authored_source_commit !== "3ed708e126aec14b7456679b9236e01c1081df16") fail("authored reference commit");
  for (const [name, relative, pinnedPath] of [["context", "fixtures/reference/lesson-context.json", "contract/examples/othello-1-1/lesson-context.json"],
    ["set", "fixtures/reference/question-set.json", "contract/examples/othello-1-1/question-set.json"]]) {
    const bytes = fs.readFileSync(path.join(ROOT, relative));
    if (sha(bytes) !== manifest.files.find((row) => row.path === relative)?.sha256
      || sha(bytes) !== pinnedFiles.find((row) => row.path === pinnedPath)?.sha256) fail("reference source hash");
    reference[name] = JSON.parse(bytes);
  }
  if (baseline.id !== KNOWLEDGE_BASELINE.release || baseline.sha256 !== KNOWLEDGE_BASELINE.sha256
    || source.id !== `authored-reference-${manifest.authored_source_commit.slice(0, 7)}` || source.sha256 !== sha(manifestBytes)) fail("source pin mismatch");
  if (pilotHash(packetProjection(context, set).hashes) !== pilotHash(packetProjection(reference.context, reference.set).hashes)) fail("reference packet mismatch");
  if (!Number.isInteger(samples) || samples < 1 || samples > 16) fail("samples");
  if (model !== null && (!record(model) || !["provider", "requested", "reported"].every((k) => text(model[k])))) fail("model scope");
  const collected = collectCriterionPackets(context, set, { profile: "jev-partial-v1", projected });
  if (!collected.entries.length) fail("empty criterion collection");
  const packet = packetProjection(context, set), runtime = runtimeSnapshot(ROOT, configFile), pilotId = crypto.randomUUID();
  const bindings = { ...collected.input, packet_sha256: sha(JSON.stringify({ context: packet.context, set: packet.set }, null, 1) + "\n"),
    runtime_sha256: runtime.sha256, profile_sha256: collected.profile.sha256, baseline_sha256: baseline.sha256, source_sha256: source.sha256 };
  const entries = collected.entries.map((row) => ({ case_id: `case-${pilotHash([row.item_id, row.criterion_id]).slice(0, 24)}`,
    item_id: row.item_id, kind: row.kind, criterion_id: row.criterion_id, expect: row.expect, required: row.required,
    packet: row.packet, criterion_packet_sha256: row.judge_packet_sha256, learner_exposure: row.learner_exposure, dropped_pages: row.dropped_pages }));
  const sheets = [1, 2].map((slot) => {
    const sheet = { schema_version: 1, pilot_id: pilotId, sheet_id: crypto.randomUUID(), reviewer_slot: slot,
      bindings, reviewer_alias: null, independent_review_declared: false,
      instructions: "Review each supplied question against its supplied context. Record yes, no or unsure, and a rationale. Leave unanswered rows blank. Do not consult another reviewer or any model results. Learner exposure is unverified; this is a pilot, not whole-item approval.",
      rows: entries.map((row) => ({ case_id: row.case_id, packet: row.packet, criterion_packet_sha256: row.criterion_packet_sha256,
        learner_exposure: row.learner_exposure, dropped_pages: row.dropped_pages, verdict: null, rationale: null })) };
    return { ...structuredClone(sheet), template_sha256: pilotHash(sheet) };
  });
  const bundle = sealed({ schema_version: 1, kind: "human-review-pilot", pilot_id: pilotId, qualification: "unqualified", status: "awaiting-human-review",
    bindings, model: model === null ? null : { provider: model.provider, requested: model.requested, reported: model.reported }, samples,
    entries, sheet_templates: sheets.map(({ sheet_id, reviewer_slot, template_sha256 }) => ({ sheet_id, reviewer_slot, template_sha256 })),
    counts: { criteria: entries.length, units: new Set(entries.map((row) => row.item_id)).size, unsupported_units: collected.unsupported.length },
    observations_sha256: pilotHash(observations), limitations: LIMITS });
  const provenance = sealed({ schema_version: 1, pilot_id: pilotId, bundle_sha256: bundle.sha256, baseline, source, runtime, observations,
    observations_status: "source-supported development observations only; no inferred human verdicts", unsupported: collected.unsupported });
  validateBundle(bundle);
  return { bundle, sheets, provenance };
}

export function reconcileReviews(bundle, reviews, adjudication = null) {
  validateBundle(bundle);
  if (!Array.isArray(reviews) || reviews.length !== 2) fail("two reviewer sheets required");
  const usedSheets = new Set(), aliases = new Set();
  const sheets = reviews.map((sheet) => {
    const template = bundle.sheet_templates.find((t) => t.sheet_id === sheet?.sheet_id);
    if (!template || usedSheets.has(sheet.sheet_id) || sheet.template_sha256 !== template.template_sha256 || !Array.isArray(sheet.rows)
      || pilotHash(blankTemplate(sheet)) !== template.template_sha256) fail("review sheet template");
    usedSheets.add(sheet.sheet_id);
    if (sheet.reviewer_alias !== null) {
      if (!alias(sheet.reviewer_alias) || aliases.has(normAlias(sheet.reviewer_alias))) fail("reviewer identity or duplicate");
      aliases.add(normAlias(sheet.reviewer_alias));
    }
    if (typeof sheet.independent_review_declared !== "boolean") fail("independence declaration");
    for (const row of sheet.rows) {
      if (![null, "yes", "no", "unsure"].includes(row.verdict) || (row.rationale !== null && typeof row.rationale !== "string")) fail("human response");
      if (row.verdict !== null && (!sheet.reviewer_alias || !sheet.independent_review_declared || !text(row.rationale))) fail("incomplete reviewer declaration or rationale");
    }
    return sheet;
  }).sort((a, b) => a.reviewer_slot - b.reviewer_slot);
  const reviewsHash = pilotHash(sheets), resolutions = new Map();
  if (adjudication !== null) {
    if (!record(adjudication) || adjudication.bundle_sha256 !== bundle.sha256 || adjudication.reviews_sha256 !== reviewsHash
      || !alias(adjudication.adjudicator_alias) || aliases.has(normAlias(adjudication.adjudicator_alias))
      || adjudication.independent_review_declared !== true || !Array.isArray(adjudication.rows)) fail("adjudication scope or identity");
    for (const row of adjudication.rows) {
      if (!bundle.entries.some((entry) => entry.case_id === row.case_id) || resolutions.has(row.case_id)
        || !["yes", "no", "unsure"].includes(row.verdict) || !text(row.rationale)) fail("adjudication row");
      resolutions.set(row.case_id, row);
    }
  }
  const labels = bundle.entries.map((entry, index) => {
    const a = sheets[0].rows[index].verdict, b = sheets[1].rows[index].verdict;
    let humanAnswer = a === b && ["yes", "no"].includes(a) ? a : null;
    let status = humanAnswer === null ? "pending" : "agreed";
    let reason = humanAnswer !== null ? "reviewers_agree" : a === null || b === null ? "incomplete_reviews" : a === "unsure" || b === "unsure" ? "reviewer_unsure" : "reviewer_disagreement";
    const resolution = resolutions.get(entry.case_id);
    if (resolution) {
      if (humanAnswer !== null || a === null || b === null) fail("adjudication requires two completed unresolved reviews");
      if (resolution.verdict !== "unsure") { humanAnswer = resolution.verdict; status = "adjudicated"; reason = "explicit_adjudication"; }
      else reason = "adjudicator_unsure";
    }
    return { case_id: entry.case_id, item_id: entry.item_id, criterion_id: entry.criterion_id, human_answer: humanAnswer,
      verdict: humanAnswer === null ? null : (humanAnswer === "yes") === entry.expect ? "pass" : "fail", status, reason };
  });
  return sealed({ schema_version: 1, pilot_id: bundle.pilot_id, bundle_sha256: bundle.sha256, qualification: "unqualified", independent_gold: false, held_out: false,
    reviewer_aliases: sheets.map((sheet) => sheet.reviewer_alias), reviews_sha256: reviewsHash,
    adjudication_sha256: adjudication === null ? null : pilotHash(adjudication), labels_sha256: pilotHash(labels), labels,
    counts: { resolved: labels.filter((row) => row.verdict !== null).length, pending: labels.filter((row) => row.verdict === null).length }, limitations: LIMITS });
}

function reportIndex(report) {
  if (!Array.isArray(report?.items)) fail("report items");
  const index = new Map(), items = new Set();
  for (const item of report.items) {
    if (!text(item.id) || items.has(item.id) || !Array.isArray(item.checks)) fail("duplicate or malformed report item");
    items.add(item.id);
    for (const check of item.checks.filter((row) => row.method === "judge")) {
      const pair = key(item.id, check.id);
      if (!text(check.id) || index.has(pair)) fail("duplicate report criterion");
      index.set(pair, { item, check });
    }
  }
  return index;
}

export function scorePilot(bundle, reconciled, draws) {
  validateBundle(bundle); integrity(reconciled, "reconciliation");
  if (reconciled.bundle_sha256 !== bundle.sha256 || reconciled.labels_sha256 !== pilotHash(reconciled.labels)
    || reconciled.labels.length !== bundle.entries.length || reconciled.qualification !== "unqualified"
    || reconciled.independent_gold !== false || reconciled.held_out !== false) fail("reconciled labels");
  reconciled.labels.forEach((label, i) => {
    const entry = bundle.entries[i];
    if (label.case_id !== entry.case_id || label.item_id !== entry.item_id || label.criterion_id !== entry.criterion_id
      || ![null, "pass", "fail"].includes(label.verdict)
      || (label.verdict === null ? label.human_answer !== null || label.status !== "pending"
        : !["yes", "no"].includes(label.human_answer) || !["agreed", "adjudicated"].includes(label.status))
      || (label.verdict !== null && label.verdict !== ((label.human_answer === "yes") === entry.expect ? "pass" : "fail"))) fail("label orientation");
  });
  const resolved = reconciled.labels.filter((row) => row.verdict !== null).length, pending = bundle.entries.length - resolved;
  if (reconciled.counts?.resolved !== resolved || reconciled.counts?.pending !== pending) fail("reconciled label counts");
  if (!Array.isArray(draws) || !draws.length) fail("empty report draws");
  const reportHashes = new Set(), invocations = new Set(), processes = new Set(), perCriterion = new Map(), drawScores = [];
  for (const frozen of draws) {
    const report = frozen?.report, execution = report?.execution;
    if (!record(report) || frozen.report_sha256 !== pilotHash(report) || frozen.labels_sha256 !== reconciled.labels_sha256) fail("frozen report or changed labels");
    if (reportHashes.has(frozen.report_sha256) || !text(execution?.invocation_id) || invocations.has(execution.invocation_id)
      || !Number.isInteger(execution.pid) || execution.pid <= 0 || processes.has(execution.pid)) fail("duplicate or incomplete draw identity");
    reportHashes.add(frozen.report_sha256); invocations.add(execution.invocation_id); processes.add(execution.pid);
    for (const field of ["packet_sha256", "runtime_sha256", "profile_sha256"]) if (execution[field] !== bundle.bindings[field]) fail("report build or packet mismatch");
    for (const field of ["context_projection_sha256", "set_projection_sha256"]) if (report.input?.[field] !== bundle.bindings[field]) fail("report input mismatch");
    if (report.evaluator?.judge_profile?.sha256 !== bundle.bindings.profile_sha256) fail("report profile mismatch");
    if (report.evaluator?.knowledge_baseline?.sha256 !== bundle.bindings.baseline_sha256) fail("report knowledge baseline mismatch");
    const judge = report.evaluator.judge;
    if (bundle.model === null ? judge !== null : !judge || judge.name !== bundle.model.provider || judge.model !== bundle.model.requested || judge.samples !== bundle.samples) fail("report model mismatch");
    const index = reportIndex(report), counts = { labelled_criteria: 0, pending_labels: 0, correct_approvals: 0, correct_rejections: 0, false_approvals: 0, false_rejections: 0, abstentions: 0 };
    let batchedSnapshots = 0;
    for (let i = 0; i < bundle.entries.length; i++) {
      const entry = bundle.entries[i], label = reconciled.labels[i], found = index.get(key(entry.item_id, entry.criterion_id));
      if (!found || found.check.criterion_packet_sha256 !== entry.criterion_packet_sha256) fail("criterion snapshot mismatch or missing check");
      const { check, item } = found;
      if (check.expect !== (entry.expect ? "yes" : "no") || !["pass", "fail", "flag", "unsure", "unavailable"].includes(check.verdict)) fail("criterion orientation or verdict");
      if (check.requested && !isHash(check.request_packet_sha256)) fail("missing actual request hash");
      if (check.requested && check.request_packet_sha256 !== entry.criterion_packet_sha256) batchedSnapshots++;
      const observations = item.judge?.serving_observations || [];
      if (bundle.model && observations.some((o) => !o.unavailable && o.model !== bundle.model.reported)) fail("reported model mismatch");
      const usable = check.requested === true && check.scope === "selected" && check.valid === bundle.samples
        && !(check.gate?.length) && !(item.judge?.serving_issues?.length) && bundle.model !== null
        && observations.filter((o) => !o.unavailable && o.model === bundle.model.reported).length >= bundle.samples;
      const verdict = usable && ["pass", "fail", "flag"].includes(check.verdict) ? check.verdict === "flag" ? "fail" : check.verdict : "abstain";
      if (!perCriterion.has(entry.case_id)) perCriterion.set(entry.case_id, []);
      perCriterion.get(entry.case_id).push(verdict);
      if (label.verdict === null) { counts.pending_labels++; continue; }
      counts.labelled_criteria++;
      if (verdict === "abstain") counts.abstentions++;
      else if (label.verdict === "pass") counts[verdict === "pass" ? "correct_approvals" : "false_rejections"]++;
      else counts[verdict === "fail" ? "correct_rejections" : "false_approvals"]++;
    }
    drawScores.push({ report_sha256: frozen.report_sha256, invocation_id: execution.invocation_id, counts, snapshot_differs_from_actual_request: batchedSnapshots });
  }
  const variation = bundle.entries.map((entry) => { const verdicts = perCriterion.get(entry.case_id); return { case_id: entry.case_id,
    item_id: entry.item_id, criterion_id: entry.criterion_id, verdicts, varied: new Set(verdicts).size > 1 }; });
  return sealed({ schema_version: 1, pilot_id: bundle.pilot_id, bundle_sha256: bundle.sha256, labels_sha256: reconciled.labels_sha256,
    qualification: "unqualified", status: "pilot", independent_gold: false, held_out: false,
    counts: { distinct_criteria: bundle.entries.length, distinct_units: bundle.counts.units, resolved_labels: resolved,
      pending_labels: pending, draws: draws.length, varied_criteria: variation.filter((row) => row.varied).length },
    draws: drawScores, repeat_variation: variation, limitations: LIMITS });
}
