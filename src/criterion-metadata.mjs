// A checked reflection of existing checks, never a new evaluator or qualification gate.
import fs from "node:fs";
import crypto from "node:crypto";

const CATALOG_SHA256 = "8951d33f72b853c22b5f9860c708c654a24c90186a62f2767080580c721c4172";
const SOURCE_SHA256 = "5d93d80f678ec54c54be8b6d0a166399f32d883077462f08f1268dbdd8286a46";
const catalogUrl = new URL("../criteria/route-checks.json", import.meta.url);
const sourceUrl = new URL("../fixtures/criterion-source-records.json", import.meta.url);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = value => typeof value === "string" && value.trim().length > 0;
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const fail = message => { throw new Error(`criterion metadata: ${message}`); };
const assert = (condition, message) => { if (!condition) fail(message); };
const ordered = value => Array.isArray(value) ? value.map(ordered) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
const equal = (a, b) => JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));
function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function readPinned(file, expected, label) {
  const bytes = fs.readFileSync(file);
  assert(sha(bytes) === expected, `${label} file hash differs`);
  return JSON.parse(bytes);
}

const CATALOG = freeze(readPinned(catalogUrl, CATALOG_SHA256, "catalog"));
const SOURCE = freeze(readPinned(sourceUrl, SOURCE_SHA256, "source snapshot"));
export const CRITERION_METADATA_PIN = freeze({ version: 1, catalog_sha256: CATALOG_SHA256,
  source_snapshot_sha256: SOURCE_SHA256, source_commit: SOURCE.source_commit,
  academic_qualification: false, source_records_refreshed: false });

function recordMap(sourceSnapshot) {
  assert(object(sourceSnapshot) && sourceSnapshot.version === 1 && Array.isArray(sourceSnapshot.records), "invalid source snapshot");
  const records = new Map();
  for (const record of sourceSnapshot.records) {
    assert(object(record) && text(record.id) && !records.has(record.id), "missing or duplicate source record id");
    assert(/^[a-z0-9-]+$/.test(record.id) && record.path === `learnings/${record.id}.json`, "invalid source record path");
    assert(/^[0-9a-f]{64}$/.test(record.record_sha256), `invalid source record hash: ${record.id}`);
    assert(["held", "contested", "open"].includes(record.status) && ["universal", "domain"].includes(record.scope)
      && ["measured", "adopted-rule", "external-research", "open-question"].includes(record.kind), `invalid source status: ${record.id}`);
    assert(text(record.statement) && text(record.detail) && text(record.against)
      && object(record.conditions) && record.conditions.binding_rule_inferred === false, `incomplete source limits: ${record.id}`);
    records.set(record.id, record);
  }
  return records;
}

// Callers explicitly supply raw public bytes; the default never discovers a sibling checkout.
export function verifySourceRecordBytes(sourceRecordBytes, { sourceSnapshot = SOURCE } = {}) {
  const records = recordMap(sourceSnapshot);
  assert(sourceRecordBytes instanceof Map || object(sourceRecordBytes), "raw source record bytes must be a map or object");
  for (const [id, record] of records) {
    const raw = sourceRecordBytes instanceof Map ? sourceRecordBytes.get(id) : sourceRecordBytes[id];
    assert(typeof raw === "string" || Buffer.isBuffer(raw), `source record absent: ${id}`);
    assert(sha(raw) === record.record_sha256, `source record hash differs: ${id}`);
    const parsed = JSON.parse(String(raw));
    for (const key of ["id", "statement", "role", "facets", "scope", "domains", "kind", "status", "detail", "against"])
      assert(equal(parsed[key], record[key]), `source record fields differ: ${id}.${key}`);
  }
  // Supplied records must also match the trusted frozen selection, not an arbitrary replacement snapshot.
  assert(equal(sourceSnapshot, SOURCE), "source snapshot differs from frozen fields");
  return { records_verified: records.size, external_source_records_verified: true, academic_qualification: false };
}

function nativeSignature(registry) {
  assert(object(registry) && Array.isArray(registry.checks) && Array.isArray(registry.set), "invalid native registry");
  return [...registry.checks, ...registry.set].map(check => Object.fromEntries(["id", "method", "required", "applies_to", "learnings"]
    .filter(key => Object.hasOwn(check, key)).map(key => [key, check[key]])));
}

export function validateCriterionMetadata({ catalog = CATALOG, sourceSnapshot = SOURCE,
  sourceRecordBytes, nativeRegistry } = {}) {
  assert(object(catalog) && catalog.version === 1 && catalog.qualification === false && Array.isArray(catalog.entries), "invalid catalog");
  assert(catalog.source_snapshot?.sha256 === SOURCE_SHA256 && catalog.source_snapshot?.source_commit === SOURCE.source_commit,
    "catalog source snapshot pin differs");
  const records = recordMap(sourceSnapshot), identities = new Set();
  for (const entry of catalog.entries) {
    assert(object(entry) && ["native", "text", "native0.2"].includes(entry.route) && text(entry.id) && text(entry.stage), "invalid route entry");
    const identity = JSON.stringify([entry.route, entry.stage, entry.id, entry.scope]);
    assert(!identities.has(identity), "duplicate route entry"); identities.add(identity);
    assert(object(entry.scope) && Array.isArray(entry.scope.kinds) && Array.isArray(entry.scope.families)
      && object(entry.emitted_contract), "missing emitted contract");
    assert(["source_bounded", "transport_integrity", "instrumentation"].includes(entry.classification), "unknown claim classification");
    assert(entry.question_quality_claim === (entry.classification === "source_bounded"), "quality claim exceeds check classification");
    assert(Array.isArray(entry.records) && (entry.classification !== "source_bounded" || entry.records.length > 0), "source-bounded check has no source");
    assert(text(entry.operationalization) && entry.applicability?.decision_source === "explicit declaration only; source prose is not executable policy",
      "missing bounded operationalization");
    for (const id of entry.records) assert(records.has(id), `source record absent: ${id}`);
    assert(text(entry.id_pattern) && entry.id_pattern.startsWith("^") && entry.id_pattern.endsWith("$"), "unbounded criterion pattern");
    try { new RegExp(entry.id_pattern); } catch { fail("invalid criterion pattern"); }
  }
  assert(equal(sourceSnapshot, SOURCE), "source snapshot differs from frozen fields");
  assert(equal(catalog, CATALOG), "catalog differs from frozen operational contracts");
  if (nativeRegistry !== undefined)
    assert(equal(nativeSignature(nativeRegistry), catalog.native_registry_contract), "native registry required/applicability/source contract drift");
  if (sourceRecordBytes !== undefined) verifySourceRecordBytes(sourceRecordBytes, { sourceSnapshot });
  return { ...CRITERION_METADATA_PIN, entries: catalog.entries.length, records: records.size,
    external_source_records_verified: sourceRecordBytes !== undefined };
}

function matches(entry, route, id, { stage, kind, family }, enforceContext) {
  if (entry.route !== route || (stage && entry.stage !== stage) || !new RegExp(entry.id_pattern).test(id)) return false;
  if (kind !== undefined && entry.scope.kinds.length && !entry.scope.kinds.includes(kind)) return false;
  if (family !== undefined && entry.scope.families.length && !entry.scope.families.includes(family)) return false;
  if (enforceContext && ((entry.scope.kinds.length && !text(kind)) || (entry.scope.families.length && !text(family)))) return false;
  return true;
}
function entryFor(route, id, context, enforceContext = false) {
  assert(text(context.stage), "emitted stage is required");
  const found = CATALOG.entries.filter(entry => matches(entry, route, id, context, enforceContext));
  assert(found.length === 1, found.length ? `ambiguous operation context: ${route}/${id}` : `unregistered check or operation scope drift: ${route}/${id}`);
  return found[0];
}

function applicability(context, entry) {
  if ((entry.scope.kinds.length && !text(context.kind)) || (entry.scope.families.length && !text(context.family)))
    return { state: "undetermined", reason: "operation_context_missing" };
  if (entry.classification !== "source_bounded") return { state: "applies", reason: "emitted_operation_integrity_only",
    purpose: context.purpose ?? null, source: "Registered transport or instrumentation operation; no academic applicability or quality claim." };
  if (!text(context.purpose)) return { state: "undetermined", reason: "assessment_purpose_missing" };
  const decision = context.applicabilityDecision;
  if (!object(decision) || !["applies", "not_applicable", "undetermined"].includes(decision.state) || !text(decision.reason))
    return { state: "undetermined", reason: "explicit_applicability_decision_missing" };
  if (Object.hasOwn(decision, "unresolvedConditions") && (!Array.isArray(decision.unresolvedConditions) || decision.unresolvedConditions.length))
    return { state: "undetermined", reason: "declared_conditions_unresolved", purpose: context.purpose };
  return { state: decision.state, reason: decision.reason, purpose: context.purpose,
    source: "caller declaration; not independently validated academic judgment" };
}

// Compact references bind verbatim conditions/against fields in the pinned snapshot. Nothing is inferred from them.
export function metadataForCheck(route, id, context = {}) {
  const entry = entryFor(route, id, context);
  return freeze({ route, criterion_id: id, criterion_family: entry.id, stage: entry.stage,
    classification: entry.classification, question_quality_claim: entry.question_quality_claim,
    quality_dimension: entry.quality_dimension, operationalization: entry.operationalization,
    emitted_contract: entry.emitted_contract, operation_scope: entry.scope,
    applicability: applicability(context, entry), conditions: entry.applicability.conditions,
    source_snapshot: CATALOG.source_snapshot,
    source_records: entry.records.map(id => {
      const index = SOURCE.records.findIndex(record => record.id === id), record = SOURCE.records[index];
      return { id, record_sha256: record.record_sha256, role: record.role, status: record.status,
        scope: record.scope, kind: record.kind, domains: record.domains,
        conditions_pointer: `/records/${index}/conditions`, detail_pointer: `/records/${index}/detail`, against_pointer: `/records/${index}/against` };
    }), academic_qualification: false, learner_outcome_measured: false });
}

export function sourceRecordMetadata(id) {
  const record = SOURCE.records.find(record => record.id === id);
  assert(record, `source record absent: ${id}`); return record;
}

// Row shape: {check: original emitted check, stage, kind?, family?, purpose?, applicabilityDecision?}.
// This validates only supplied rows; callers retain original verdicts and choose coverage inputs explicitly.
export function validateEmittedChecks(route, rows) {
  assert(Array.isArray(rows), "emissions must be an array");
  const annotations = rows.map(row => {
    assert(object(row) && object(row.check) && text(row.check.id), "invalid emitted check");
    const entry = entryFor(route, row.check.id, row, true), contract = entry.emitted_contract;
    for (const field of ["required", "method"]) {
      if (contract[field] === null) assert(!Object.hasOwn(row.check, field), `emitted ${field} field drift: ${route}/${row.check.id}`);
      else assert(row.check[field] === contract[field], `emitted ${field} contract drift: ${route}/${row.check.id}`);
    }
    return metadataForCheck(route, row.check.id, row);
  });
  return freeze({ route, checked: rows.length, coverage: "complete for supplied emissions only", annotations,
    academic_qualification: false, independent_gold_labels: 0 });
}

// Explicit alternate files must carry the same reviewed pins. Useful for portable checkout checks.
export function loadCriterionMetadata({ catalogFile = catalogUrl, sourceSnapshotFile = sourceUrl } = {}) {
  const catalog = readPinned(catalogFile, CATALOG_SHA256, "catalog"), sourceSnapshot = readPinned(sourceSnapshotFile, SOURCE_SHA256, "source snapshot");
  validateCriterionMetadata({ catalog, sourceSnapshot });
  return freeze({ catalog, sourceSnapshot, pins: CRITERION_METADATA_PIN });
}
