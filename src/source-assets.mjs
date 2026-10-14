// Observations of supplied source declarations only. This module has no gates or I/O.
import crypto from "node:crypto";

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value, field) => object(value) && Object.hasOwn(value, field);
const sha256 = text => crypto.createHash("sha256").update(text, "utf8").digest("hex");
const observation = (field, verdict, evidence) => ({ field, verdict, evidence });
const declaration = (row, field) => ({ present: own(row, field), value: own(row, field) ? structuredClone(row[field]) : null });

function layout(value, fields) {
  const supplied = fields.filter(field => own(value, field));
  if (supplied.length !== 1) return { field: null, rows: null,
    observation: observation("asset_layout", "undetermined", { reason: supplied.length ? "multiple_supplied_layouts" : "layout_not_supplied", supplied_fields: supplied }) };
  const field = supplied[0];
  if (!Array.isArray(value[field])) return { field, rows: null,
    observation: observation("asset_layout", "undetermined", { reason: "unsupported_asset_layout", supplied_field: field }) };
  const unresolvedRows = value[field].filter(row => !object(row) || typeof row.id !== "string").length;
  return { field, rows: value[field], observation: observation("asset_layout", unresolvedRows ? "undetermined" : "pass",
    { supplied_field: field, rows: value[field].length, unresolved_identity_rows: unresolvedRows,
      meaning: "Recognized field layout only; no source schema or authority has been certified." }) };
}

function identity(rows, id, side) {
  if (!rows) return { row: null, observation: observation(`${side}.id`, "undetermined", { reason: "asset_layout_unavailable" }) };
  const matches = rows.filter(row => object(row) && own(row, "id") && row.id === id);
  return { row: matches.length === 1 ? matches[0] : null,
    observation: observation(`${side}.id`, matches.length > 1 ? "fail" : matches.length ? "pass" : "undetermined",
      { matches: matches.length, reason: matches.length > 1 ? "ambiguous_selected_identity" : matches.length ? "unique_selected_identity" : "selected_asset_not_supplied" }) };
}

function textObservation(requestRow, packetRow) {
  const fields = ["text", "display_text"].filter(field => own(packetRow, field));
  if (fields.length !== 1) return { field: null, value: null,
    observation: observation("text_bytes", "undetermined", { reason: fields.length ? "multiple_supplied_text_fields" : "packet_text_not_supplied", supplied_fields: fields }) };
  const field = fields[0], value = packetRow[field];
  if (typeof value !== "string" || !own(requestRow, "text") || typeof requestRow.text !== "string") return { field, value: typeof value === "string" ? value : null,
    observation: observation("text_bytes", "undetermined", { reason: "supported_text_bytes_unavailable", packet_field: field, request_field: "text" }) };
  return { field, value, observation: observation("text_bytes", requestRow.text === value ? "pass" : "fail",
    { packet_field: field, request_field: "text", exact_text_equal: requestRow.text === value,
      exact_utf8_equal: Buffer.from(requestRow.text, "utf8").equals(Buffer.from(value, "utf8")),
      request_utf8_bytes: Buffer.byteLength(requestRow.text, "utf8"), packet_utf8_bytes: Buffer.byteLength(value, "utf8"),
      request_sha256_utf8: sha256(requestRow.text), packet_sha256_utf8: sha256(value),
      meaning: "Exact supplied strings and UTF-8 bytes; no punctuation, whitespace or Unicode normalization." }) };
}

function hashObservation(packetRow, text) {
  const field = text.field === "display_text" ? "sha256_display_utf8" : text.field === "text" ? "sha256_utf8" : null;
  if (!field) return observation("sha256_utf8", "undetermined", { reason: "text_field_unresolved" });
  if (!own(packetRow, field)) return observation(field, "undetermined", { reason: "hash_not_supplied", text_field: text.field });
  const declared = packetRow[field];
  if (text.value === null) return observation(field, "undetermined", { reason: "text_bytes_unavailable", declared, text_field: text.field });
  if (typeof declared !== "string" || !/^[a-fA-F0-9]{64}$/.test(declared)) return observation(field, "undetermined",
    { reason: "hash_encoding_unrecognized", declared, text_field: text.field });
  const observed = sha256(text.value);
  return observation(field, declared.toLowerCase() === observed ? "pass" : "fail",
    { declared, observed, text_field: text.field, algorithm: "SHA-256 of UTF-8 bytes" });
}

/**
 * Compare request.course_context.source_assets with one explicitly supplied packet
 * source_assets or assets array. Only selected IDs are joined. Missing declarations
 * stay undetermined. The result is instrumentation and never alters an evaluator gate.
 */
export function inspectSourceAssets(request, sourcePacket, { selectedSourceRefs } = {}) {
  const requestLayout = layout(request?.course_context, ["source_assets"]);
  const packetLayout = layout(sourcePacket, ["source_assets", "assets"]);
  if (selectedSourceRefs !== undefined && (!Array.isArray(selectedSourceRefs) || !selectedSourceRefs.every(id => typeof id === "string")))
    throw new TypeError("selectedSourceRefs must be an array of supplied source IDs");
  const refs = [...new Set(selectedSourceRefs ?? (requestLayout.rows ?? []).filter(row => object(row) && typeof row.id === "string").map(row => row.id))];
  const assets = refs.map(sourceRef => {
    const requestIdentity = identity(requestLayout.rows, sourceRef, "request"), packetIdentity = identity(packetLayout.rows, sourceRef, "packet");
    const observations = [requestIdentity.observation, packetIdentity.observation];
    if (!requestIdentity.row || !packetIdentity.row) {
      observations.push(observation("text_bytes", "undetermined", { reason: "unique_selected_identity_unavailable" }),
        observation("sha256_utf8", "undetermined", { reason: "unique_selected_identity_unavailable" }));
    } else {
      const text = textObservation(requestIdentity.row, packetIdentity.row);
      observations.push(text.observation, hashObservation(packetIdentity.row, text));
    }
    return { source_ref: sourceRef, observations,
      provided_role: declaration(packetIdentity.row, "role"), provided_wording_status: declaration(packetIdentity.row, "wording_status"),
      uninterpreted_hash_fields: packetIdentity.row ? Object.keys(packetIdentity.row).filter(field => /^sha256/.test(field)
        && !observations.some(row => row.field === field && row.evidence.algorithm === "SHA-256 of UTF-8 bytes")).sort() : [],
      interpretation: "Role and wording status are supplied declarations, not a source authority or quality decision." };
  });
  const observations = [requestLayout.observation, packetLayout.observation, ...assets.flatMap(asset => asset.observations)];
  return { version: 1, request_asset_field: requestLayout.field, packet_asset_field: packetLayout.field,
    layout_observations: [requestLayout.observation, packetLayout.observation], selected_source_refs: refs, assets,
    observation_counts: Object.fromEntries(["pass", "fail", "undetermined"].map(verdict => [verdict, observations.filter(row => row.verdict === verdict).length])),
    scope: "Supplied asset identity, text bytes and recognized UTF-8 hash declarations only; no original-source comparison or canonical-block hash interpretation.",
    question_quality_claim: false, source_schema_verified: false, external_source_verified: false, source_factual_approval: false, rights_approval: false,
    academic_approval: false, learner_outcome_measured: false };
}
