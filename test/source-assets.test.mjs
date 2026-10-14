import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { inspectSourceAssets } from "../src/source-assets.mjs";

const sha = value => crypto.createHash("sha256").update(value, "utf8").digest("hex");
const fixture = () => ({
  request: { course_context: { source_assets: [{ id: "source-one", text: "Supplied café.\nA second line." }, { id: "source-two", text: "Proposed instruction." }] } },
  packet: { source: { commit: "0".repeat(40), sha256_source_bytes: "0".repeat(64), status: "declared historical pin" },
    source_assets: [{ id: "source-one", display_text: "Supplied café.\nA second line.", sha256_display_utf8: sha("Supplied café.\nA second line."),
      role: "abridged-dialogue", sha256_blocks_canonical_json: "0".repeat(64) },
      { id: "source-two", display_text: "Proposed instruction.", role: "proposed-instruction-not-assessment", wording_status: "proposed-authoring-choice" }] }
});
const asset = (result, id = "source-one") => result.assets.find(row => row.source_ref === id);
const field = (result, name, id) => asset(result, id).observations.find(row => row.field === name);

test("recognized display declarations show byte/hash consistency without source or academic approval", () => {
  const { request, packet } = fixture(), before = structuredClone({ request, packet }), result = inspectSourceAssets(request, packet);
  assert.equal(field(result, "text_bytes").verdict, "pass");
  assert.equal(field(result, "sha256_display_utf8").verdict, "pass");
  assert.equal(field(result, "sha256_display_utf8", "source-two").verdict, "undetermined");
  assert.deepEqual(asset(result).uninterpreted_hash_fields, ["sha256_blocks_canonical_json"]);
  assert.deepEqual(asset(result, "source-two").provided_wording_status, { present: true, value: "proposed-authoring-choice" });
  assert.deepEqual(asset(result, "source-two").provided_role, { present: true, value: "proposed-instruction-not-assessment" });
  for (const flag of ["question_quality_claim", "source_schema_verified", "external_source_verified", "source_factual_approval", "rights_approval", "academic_approval", "learner_outcome_measured"])
    assert.equal(result[flag], false);
  assert.deepEqual({ request, packet }, before);
});

test("legacy packet text is a separate supported declaration and absent hash stays undetermined", () => {
  const { request } = fixture(), text = request.course_context.source_assets[0].text;
  const result = inspectSourceAssets(request, { assets: [{ id: "source-one", text }] }, { selectedSourceRefs: ["source-one"] });
  assert.equal(result.packet_asset_field, "assets");
  assert.equal(field(result, "text_bytes").verdict, "pass");
  assert.equal(field(result, "sha256_utf8").verdict, "undetermined");
  assert.equal(field(result, "sha256_utf8").evidence.reason, "hash_not_supplied");
  const withHash = inspectSourceAssets(request, { assets: [{ id: "source-one", text, sha256_utf8: sha(text).toUpperCase() }] }, { selectedSourceRefs: ["source-one"] });
  assert.equal(field(withHash, "sha256_utf8").verdict, "pass");
});

test("punctuation, line endings and Unicode byte drift cannot be normalized into a pass", () => {
  for (const alter of [text => text.replace(".", "!"), text => text.replace("\n", "\r\n"), text => text.normalize("NFD")]) {
    const { request, packet } = fixture();
    packet.source_assets[0].display_text = alter(packet.source_assets[0].display_text);
    packet.source_assets[0].sha256_display_utf8 = sha(packet.source_assets[0].display_text);
    const result = inspectSourceAssets(request, packet, { selectedSourceRefs: ["source-one"] });
    assert.equal(field(result, "text_bytes").verdict, "fail");
    assert.equal(field(result, "sha256_display_utf8").verdict, "pass");
  }
});

test("equal two-copy text does not conceal a stale supplied hash or establish authenticity", () => {
  const { request, packet } = fixture();
  packet.source_assets[0].display_text += " Changed consistently in two copies.";
  request.course_context.source_assets[0].text = packet.source_assets[0].display_text;
  let result = inspectSourceAssets(request, packet, { selectedSourceRefs: ["source-one"] });
  assert.equal(field(result, "text_bytes").verdict, "pass");
  assert.equal(field(result, "sha256_display_utf8").verdict, "fail");
  packet.source_assets[0].sha256_display_utf8 = sha(packet.source_assets[0].display_text);
  result = inspectSourceAssets(request, packet, { selectedSourceRefs: ["source-one"] });
  assert.equal(result.observation_counts.fail, 0);
  assert.equal(result.external_source_verified, false);
  assert.equal(result.source_factual_approval, false);
  assert.equal(result.academic_approval, false);
});

test("identical and conflicting duplicate selected identities fail in either array order", () => {
  for (const side of ["request", "packet"]) for (const conflict of [false, true]) for (const prepend of [false, true]) {
    const { request, packet } = fixture(), rows = side === "request" ? request.course_context.source_assets : packet.source_assets;
    const duplicate = structuredClone(rows[0]);
    if (conflict) duplicate[side === "request" ? "text" : "display_text"] = "Contradictory supplied bytes.";
    if (prepend) rows.unshift(duplicate); else rows.push(duplicate);
    const result = inspectSourceAssets(request, packet, { selectedSourceRefs: ["source-one"] });
    assert.equal(field(result, `${side}.id`).verdict, "fail");
    assert.equal(field(result, "text_bytes").verdict, "undetermined");
    assert.equal(field(result, `${side}.id`).evidence.matches, 2);
  }
});

test("unselected duplicate rows do not widen the declared observation scope", () => {
  const { request, packet } = fixture();
  packet.source_assets.push(structuredClone(packet.source_assets[1]));
  const result = inspectSourceAssets(request, packet, { selectedSourceRefs: ["source-one", "source-one"] });
  assert.deepEqual(result.selected_source_refs, ["source-one"]);
  assert.equal(result.assets.length, 1);
  assert.equal(result.observation_counts.fail, 0);
  assert.equal(field(result, "text_bytes").verdict, "pass");
});

test("missing, unsupported and ambiguous layouts remain unverified without choosing a schema", () => {
  const { request, packet } = fixture();
  for (const missing of [{}, null, { source_assets: "unknown" }, { source_assets: packet.source_assets, assets: packet.source_assets }]) {
    const result = inspectSourceAssets(request, missing, { selectedSourceRefs: ["source-one"] });
    assert.equal(result.layout_observations[1].verdict, "undetermined");
    assert.equal(field(result, "packet.id").verdict, "undetermined");
    assert.equal(field(result, "text_bytes").verdict, "undetermined");
    assert.equal(result.observation_counts.fail, 0);
  }
  const noRequest = inspectSourceAssets({}, packet, { selectedSourceRefs: ["source-one"] });
  assert.equal(field(noRequest, "request.id").verdict, "undetermined");
  assert.equal(field(noRequest, "text_bytes").verdict, "undetermined");
});

test("missing asset/text, unrecognized hash encoding and multiple text fields stay undetermined", () => {
  const { request, packet } = fixture();
  const absent = inspectSourceAssets(request, { source_assets: [] }, { selectedSourceRefs: ["source-one"] });
  assert.equal(field(absent, "packet.id").verdict, "undetermined");
  for (const change of [row => delete row.display_text, row => { row.display_text = { lines: ["unknown text layout"] }; },
    row => { row.text = row.display_text; }, row => { row.sha256_display_utf8 = "unsupported-hash-encoding"; }]) {
    const candidate = structuredClone(packet); change(candidate.source_assets[0]);
    const result = inspectSourceAssets(request, candidate, { selectedSourceRefs: ["source-one"] });
    assert.equal(result.observation_counts.fail, 0);
    assert.ok(asset(result).observations.some(row => row.verdict === "undetermined"));
  }
});

test("wrong declared UTF-8 hash fails without interpreting arbitrary block hashes", () => {
  const { request, packet } = fixture();
  packet.source_assets[0].sha256_display_utf8 = "0".repeat(64);
  const result = inspectSourceAssets(request, packet, { selectedSourceRefs: ["source-one"] });
  assert.equal(field(result, "text_bytes").verdict, "pass");
  assert.equal(field(result, "sha256_display_utf8").verdict, "fail");
  assert.equal(asset(result).observations.some(row => row.field === "sha256_blocks_canonical_json"), false);
  assert.deepEqual(asset(result).uninterpreted_hash_fields, ["sha256_blocks_canonical_json"]);
});

test("a hash for a different text field is not silently treated as checked", () => {
  const { request, packet } = fixture();
  delete packet.source_assets[0].sha256_display_utf8;
  packet.source_assets[0].sha256_utf8 = sha(packet.source_assets[0].display_text);
  const result = inspectSourceAssets(request, packet, { selectedSourceRefs: ["source-one"] });
  assert.equal(field(result, "text_bytes").verdict, "pass");
  assert.equal(field(result, "sha256_display_utf8").verdict, "undetermined");
  assert.deepEqual(asset(result).uninterpreted_hash_fields, ["sha256_blocks_canonical_json", "sha256_utf8"]);
});

test("invalid caller selection is rejected instead of inventing scope", () => {
  const { request, packet } = fixture();
  for (const selectedSourceRefs of [null, "source-one", ["source-one", 3]])
    assert.throws(() => inspectSourceAssets(request, packet, { selectedSourceRefs }), /selectedSourceRefs must be an array/);
});
