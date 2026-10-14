import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { QUALIFICATION_POLICY, exactLowerBound, getCriterionFamily, validateQualificationRegistry, loadQualification,
  qualify as checkEligibility, qualificationSigningPayload, validateTrustedReviewers, loadTrustedReviewers } from "../src/qualification.mjs";
import { judgeQuestions } from "../src/checks.mjs";

const hash = (x) => crypto.createHash("sha256").update(String(x)).digest("hex");
const target = { kind: "open_check", criterion_id: "reveal_meets_1" };
const scope = () => ({ context_sha256: hash("context"), runtime_sha256: hash("runtime"), profile_sha256: hash("profile"), gates_sha256: hash("gates"), judge_packet_sha256: hash("exact-judge-packet"), samples: 3,
  model: "jev-1.13.0", now: "2026-10-14T00:00:00.000Z" });
const cases = (n, label) => Array.from({ length: n }, (_, i) => ({ input_sha256: hash(`${label}-${i}`), independence_group: `${label}-${i}`, expected: label, draws: [label, label] }));
const certificate = (n = 368) => { const c = { id: "synthetic-math-fixture", operation: "open_check", criterion_family: "reveal_meets_N",
  ...Object.fromEntries(Object.entries(scope()).filter(([k]) => !["now", "judge_packet_sha256"].includes(k))), served_revision: "synthetic-reviewed-revision", revision_verified: true,
  expires_at: "2027-01-01T00:00:00.000Z", provenance: { independent_human_gold: true, held_out: true, predeclared_scope: true, independence_reviewed: true,
    review_receipt_sha256: hash("synthetic-reviewed-receipt"), holdout_sha256: hash("synthetic-holdout") }, cases: [...cases(n, "pass"), ...cases(n, "fail")] };
  if (c.cases.length) c.cases[0].input_sha256 = scope().judge_packet_sha256;
  return c;
};
// Ephemeral test-only keys. No private key is exported, written to disk or bundled in the source tree.
const pair = crypto.generateKeyPairSync("ed25519");
const reviewer = { id: "synthetic-reviewer", public_key_pem: pair.publicKey.export({ type: "spki", format: "pem" }) };
const trusted = validateTrustedReviewers({ schema_version: 1, reviewers: [reviewer] });
const signed = (c, key = pair.privateKey, reviewerId = reviewer.id) => ({ ...structuredClone(c), review_signature: {
  reviewer_id: reviewerId, algorithm: "ed25519", value: crypto.sign(null, qualificationSigningPayload(c), key).toString("base64") } });
const registry = (c = certificate()) => validateQualificationRegistry({ schema_version: 1, certificates: [signed(c)] });
const qualify = (r, s, t) => checkEligibility(r, s, t, trusted);

test("joint 95 percent policy needs 368 zero-error independent cases in each stratum for a 99 percent lower bound", () => {
  assert.equal(QUALIFICATION_POLICY.target_accuracy, 0.99); assert.equal(QUALIFICATION_POLICY.joint_confidence, 0.95);
  assert.equal(QUALIFICATION_POLICY.alpha_per_stratum, 0.025); assert.ok(Object.isFrozen(QUALIFICATION_POLICY.strata));
  assert.equal(QUALIFICATION_POLICY.zero_observed_misses, true);
  assert.equal(QUALIFICATION_POLICY.exact_judge_packet_required, true); assert.equal(QUALIFICATION_POLICY.review_signature_algorithm, "ed25519");
  assert.equal(QUALIFICATION_POLICY.exact_packet_human_label_required, true);
  assert.ok(exactLowerBound(368, 368, 0.025) >= 0.99);
  assert.ok(exactLowerBound(367, 367, 0.025) < 0.99);
  assert.equal(qualify(registry(certificate(367)), scope(), target).eligible, false);
  const result = qualify(registry(), scope(), target);
  assert.equal(result.eligible, true); assert.equal(result.metrics.pass.total, 368); assert.equal(result.metrics.fail.total, 368);
  assert.equal(result.verified_expected_verdict, "pass");
  assert.equal(result.metrics.pass.repeated_draws, 736);
  assert.equal(JSON.stringify(result).includes("independence_group"), false); assert.equal(JSON.stringify(result).includes("holdout"), false);
});

test("exact lower bound agrees with closed-form small cases and rejects malformed math arguments", () => {
  assert.equal(exactLowerBound(0, 0), 0); assert.equal(exactLowerBound(0, 10), 0);
  assert.ok(Math.abs(exactLowerBound(1, 2, 0.025) - (1 - Math.sqrt(0.975))) < 1e-12);
  assert.ok(Math.abs(exactLowerBound(1, 2, 0.9) - (1 - Math.sqrt(0.1))) < 1e-12);
  // For one miss, the exact tail at p=.99 is .99^(n-1) * (.99 + .01*n).
  let n = 2; while (Math.pow(0.99, n - 1) * (0.99 + 0.01 * n) > 0.025) n++;
  assert.equal(n, 555);
  assert.ok(exactLowerBound(n - 1, n) >= 0.99);
  assert.ok(exactLowerBound(n - 2, n - 1) < 0.99);
  for (const args of [[-1, 5], [6, 5], [1.5, 5], [1, -1], [1, 5, 0], [1, 5, 1], [1, 5, NaN]]) assert.throws(() => exactLowerBound(...args), RangeError);
});

test("one wrong or abstaining repeated draw makes the entire independent case a miss", () => {
  for (const bad of ["fail", "unsure", "unavailable", "error"]) {
    const c = certificate(); c.cases[0].draws = ["pass", "pass", bad];
    const result = qualify(registry(c), scope(), target);
    assert.equal(result.eligible, false); assert.ok(result.reasons.includes("pass_accuracy_lower_bound_below_target"));
  }
  const c = certificate(); c.cases[368].draws.push("pass");
  assert.ok(qualify(registry(c), scope(), target).reasons.includes("fail_accuracy_lower_bound_below_target"));
  const inflated = certificate(1); inflated.cases.forEach((row) => { row.draws = Array(1000).fill(row.expected); });
  assert.equal(qualify(registry(inflated), scope(), target).eligible, false);
  const statisticallyEnough = certificate(555); statisticallyEnough.cases[0].draws.push("fail");
  assert.ok(exactLowerBound(554, 555) >= 0.99);
  const zeroMissGate = qualify(registry(statisticallyEnough), scope(), target);
  assert.equal(zeroMissGate.eligible, false); assert.ok(zeroMissGate.reasons.includes("pass_observed_misses"));
});

test("certificate validation rejects duplicate fingerprints, duplicate independence groups and incomplete repeats", () => {
  const mutations = [
    (c) => { c.cases[1].input_sha256 = c.cases[0].input_sha256; },
    (c) => { c.cases[1].independence_group = c.cases[0].independence_group; },
    (c) => { c.cases[0].draws = ["pass"]; },
    (c) => { c.cases[0].draws = ["pass", "unknown"]; },
    (c) => { c.cases[0].input_sha256 = "not-a-hash"; },
    (c) => { c.context_sha256 = "A".repeat(64); },
    (c) => { c.criterion_family = "future_family"; },
    (c) => { c.expires_at = "2027-02-30T00:00:00Z"; },
    (c) => { c.samples = 0; },
    (c) => { c.judge_packet_sha256 = scope().judge_packet_sha256; },
    (c) => { c.cases[0].expected = "unsure"; },
    (c) => { c.unreviewed_accuracy = 1; }
  ];
  for (const mutate of mutations) { const c = certificate(2); mutate(c); assert.throws(() => registry(c), /invalid qualification registry/); }
  const c = signed(certificate(2));
  assert.throws(() => validateQualificationRegistry({ schema_version: 1, certificates: [c, structuredClone(c)] }), /invalid qualification registry/);
});

test("scope, gates, samples, model identity, expiry and human-label prerequisites all fail closed", () => {
  const r = registry();
  for (const field of ["context_sha256", "runtime_sha256", "profile_sha256", "gates_sha256"]) {
    const s = scope(); s[field] = hash("other"); assert.ok(qualify(r, s, target).reasons.includes(`${field}_mismatch`));
  }
  assert.ok(qualify(r, { ...scope(), samples: 2 }, target).reasons.includes("samples_mismatch"));
  for (const judge_packet_sha256 of [undefined, "invalid", "A".repeat(64)]) {
    assert.ok(qualify(r, { ...scope(), judge_packet_sha256 }, target).reasons.includes("invalid_qualification_scope"));
  }
  assert.ok(qualify(r, { ...scope(), model: "jev-1.14.0" }, target).reasons.includes("model_mismatch"));
  for (const model of ["jev-latest", "jev-preview", "jev-stable"]) assert.ok(qualify(r, { ...scope(), model }, target).reasons.includes("model_alias_not_qualified"));
  assert.ok(qualify(r, { ...scope(), now: "2027-01-01T00:00:00.000Z" }, target).reasons.includes("certificate_expired"));
  for (const flag of ["independent_human_gold", "held_out", "predeclared_scope", "independence_reviewed"]) {
    const c = certificate(); c.provenance[flag] = false; assert.ok(qualify(registry(c), scope(), target).reasons.includes(`${flag}_required`));
  }
  const c = certificate(); c.revision_verified = false;
  assert.ok(qualify(registry(c), scope(), target).reasons.includes("served_revision_unverified"));
  assert.equal(qualify(r, scope(), { kind: "classify", criterion_id: "word_1_fits" }).eligible, false);
  assert.equal(qualify(r, scope(), { kind: "open_check", criterion_id: "future_check" }).eligible, false);
});

test("registry loading has an immutable empty default and never exposes invalid file contents in diagnostics", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qualification-test-"));
  try {
    const file = path.join(dir, "registry.json"), missing = loadQualification(file);
    assert.deepEqual(missing.certificates, []); assert.equal(qualify(missing, scope(), target).eligible, false);
    fs.writeFileSync(file, "PRIVATE_INVALID_CONTENT_SENTINEL", { mode: 0o600 });
    assert.throws(() => loadQualification(file), (error) => error.message === "invalid qualification registry");
    fs.writeFileSync(file, JSON.stringify({ schema_version: 1, certificates: [signed(certificate())] }), { mode: 0o600 });
    const r = loadQualification(file); assert.equal(qualify(r, scope(), target).eligible, true);
    assert.throws(() => { r.certificates[0].cases[0].draws.push("fail"); }, TypeError);
    assert.equal(loadQualification().certificates.length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("self-attested or self-signed evidence cannot establish external reviewer trust", () => {
  const r = registry();
  const noTrust = checkEligibility(r, scope(), target);
  assert.equal(noTrust.eligible, false); assert.ok(noTrust.reasons.includes("trusted_reviewers_missing"));
  const stranger = crypto.generateKeyPairSync("ed25519");
  const unknownSigner = validateQualificationRegistry({ schema_version: 1, certificates: [signed(certificate(), stranger.privateKey, "untrusted-reviewer")] });
  assert.ok(checkEligibility(unknownSigner, scope(), target, trusted).reasons.includes("reviewer_not_trusted"));
  const impersonated = validateQualificationRegistry({ schema_version: 1, certificates: [signed(certificate(), stranger.privateKey, reviewer.id)] });
  assert.ok(checkEligibility(impersonated, scope(), target, trusted).reasons.includes("review_signature_invalid"));
  assert.throws(() => validateQualificationRegistry({ schema_version: 1, certificates: [signed(certificate())], reviewers: [reviewer] }), /invalid qualification registry/);
  assert.throws(() => validateQualificationRegistry({ schema_version: 1, certificates: [certificate()] }), /invalid qualification registry/);
});

test("authentic signature binds every certificate field and exact packet; key order is canonical", () => {
  const c = signed(certificate());
  const reordered = Object.fromEntries(Object.entries(c).reverse());
  assert.deepEqual(qualificationSigningPayload(reordered), qualificationSigningPayload(c));
  const r = validateQualificationRegistry({ schema_version: 1, certificates: [reordered] });
  const result = checkEligibility(r, scope(), target, trusted);
  assert.equal(result.eligible, true); assert.equal(result.reviewer_id, reviewer.id);
  assert.equal(result.scope.judge_packet_sha256, scope().judge_packet_sha256);
  assert.equal(result.trusted_reviewers_sha256, trusted.sha256);
  for (const mutate of [
    (x) => { x.expires_at = "2028-01-01T00:00:00.000Z"; },
    (x) => { x.cases[0].draws.push("pass"); },
    (x) => { x.provenance.review_receipt_sha256 = hash("unreviewed-replacement"); },
    (x) => { x.cases[0].input_sha256 = hash("changed-question-or-state"); }
  ]) {
    const altered = structuredClone(c); mutate(altered);
    const changed = validateQualificationRegistry({ schema_version: 1, certificates: [altered] });
    const s = { ...scope(), judge_packet_sha256: altered.cases[0].input_sha256 };
    assert.ok(checkEligibility(changed, s, target, trusted).reasons.includes("review_signature_invalid"));
  }
  const differentPacket = checkEligibility(r, { ...scope(), judge_packet_sha256: hash("different-item-same-context-and-family") }, target, trusted);
  assert.equal(differentPacket.eligible, false); assert.ok(differentPacket.reasons.includes("judge_packet_human_label_missing"));
});

test("trusted reviewer stores validate Ed25519 public keys, load empty by default and cache only validated frozen objects", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-test-"));
  try {
    const file = path.join(dir, "reviewers.json");
    assert.deepEqual(loadTrustedReviewers(file).reviewers, []); assert.deepEqual(loadTrustedReviewers().reviewers, []);
    fs.writeFileSync(file, JSON.stringify({ schema_version: 1, reviewers: [reviewer] }), { mode: 0o600 });
    const loaded = loadTrustedReviewers(file);
    assert.equal(checkEligibility(registry(), scope(), target, loaded).eligible, true);
    assert.equal(validateTrustedReviewers(loaded), loaded);
    const r = registry(); assert.equal(validateQualificationRegistry(r), r);
    assert.throws(() => { loaded.reviewers[0].public_key_pem = "replacement"; }, TypeError);
    const ec = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    assert.throws(() => validateTrustedReviewers({ schema_version: 1, reviewers: [{ id: reviewer.id, public_key_pem: ec.publicKey.export({ type: "spki", format: "pem" }) }] }), /invalid trusted reviewer configuration/);
    assert.throws(() => validateTrustedReviewers({ schema_version: 1, reviewers: [reviewer, reviewer] }), /invalid trusted reviewer configuration/);
    fs.writeFileSync(file, "PRIVATE_INVALID_TRUST_CONTENT_SENTINEL", { mode: 0o600 });
    assert.throws(() => loadTrustedReviewers(file), (error) => error.message === "invalid trusted reviewer configuration");
    const malformed = signed(certificate()); malformed.review_signature.value = "not-a-signature";
    assert.throws(() => validateQualificationRegistry({ schema_version: 1, certificates: [malformed] }), /invalid qualification registry/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("eligibility requires the exact packet's signed human verdict and rejects conflicting trusted verdicts", () => {
  const missing = certificate(); missing.cases[0].input_sha256 = hash("different-reviewed-packet");
  const rejected = qualify(registry(missing), scope(), target);
  assert.equal(rejected.eligible, false); assert.ok(rejected.reasons.includes("judge_packet_human_label_missing"));
  assert.equal(Object.hasOwn(rejected, "verified_expected_verdict"), false);
  const fail = certificate(); fail.id = "synthetic-reviewed-fail";
  fail.cases[0].input_sha256 = hash("other-pass-packet"); fail.cases[368].input_sha256 = scope().judge_packet_sha256;
  const result = qualify(registry(fail), scope(), target);
  assert.equal(result.eligible, true); assert.equal(result.verified_expected_verdict, "fail");
  assert.equal(Object.hasOwn(result, "cases"), false);
  const conflicting = validateQualificationRegistry({ schema_version: 1, certificates: [signed(certificate()), signed(fail)] });
  const conflict = qualify(conflicting, scope(), target);
  assert.equal(conflict.eligible, false); assert.deepEqual(conflict.reasons, ["conflicting_verified_verdicts"]);
});

test("one signed study qualifies multiple exact reviewed packets without approving unseen inputs", () => {
  const c = certificate(), r = registry(c);
  const first = qualify(r, scope(), target);
  const secondScope = { ...scope(), judge_packet_sha256: c.cases[368].input_sha256 };
  const second = qualify(r, secondScope, target);
  assert.equal(first.eligible, true); assert.equal(second.eligible, true);
  assert.equal(first.certificate_id, second.certificate_id);
  assert.equal(first.verified_expected_verdict, "pass"); assert.equal(second.verified_expected_verdict, "fail");
  assert.equal(second.scope.judge_packet_sha256, secondScope.judge_packet_sha256);
  assert.notEqual(first.scope.judge_packet_sha256, second.scope.judge_packet_sha256);
  const unseen = qualify(r, { ...scope(), judge_packet_sha256: hash("unreviewed-packet") }, target);
  assert.equal(unseen.eligible, false); assert.ok(unseen.reasons.includes("judge_packet_human_label_missing"));
});

test("canonical mapping covers all current judge criteria and rejects wrong operation or unanchored IDs", () => {
  const qset = JSON.parse(fs.readFileSync(new URL("../fixtures/reference/question-set.json", import.meta.url)));
  let total = 0;
  for (const item of qset.items) for (const { q } of judgeQuestions(item)) { assert.ok(getCriterionFamily(item.kind, q.id), q.id); total++; }
  assert.equal(total, 543);
  assert.equal(getCriterionFamily("classify", "word_2_iago_is_also_fits"), "word_N_target_also_fits");
  assert.equal(getCriterionFamily("open_check", "accepted_2_1_meets"), "accepted_N_M_meets");
  for (const [kind, criterion] of [["classify", "reveal_meets_1"], ["open_check", "reveal_meets_0"], ["open_check", "reveal_meets_1\n"], ["open_check", "prefix_reveal_meets_1"], ["future", "answerable"]]) assert.equal(getCriterionFamily(kind, criterion), null);
});
