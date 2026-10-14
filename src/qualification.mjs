// Pure certificate checks and exact binomial math. No provider or credential dependencies.
import fs from "node:fs";
import crypto from "node:crypto";

const record = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const freeze = (x) => { if (x && typeof x === "object") { Object.values(x).forEach(freeze); Object.freeze(x); } return x; };
const ordered = (x) => Array.isArray(x) ? x.map(ordered) : record(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, ordered(x[k])])) : x;
const sha = (x) => crypto.createHash("sha256").update(JSON.stringify(ordered(x))).digest("hex");
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const hash = (x) => typeof x === "string" && HASH.test(x);
const id = (x) => typeof x === "string" && ID.test(x);
const exactKeys = (x, keys) => record(x) && Object.keys(x).length === keys.length && keys.every((k) => Object.hasOwn(x, k));
const invalid = () => { throw new TypeError("invalid qualification registry"); };
const policy = JSON.parse(fs.readFileSync(new URL("../criteria/jev-qualification.json", import.meta.url), "utf8"));
if (policy.schema_version !== 1 || policy.id !== "jev-qualification-v1" || policy.target_accuracy !== 0.99 || policy.joint_confidence !== 0.95
  || policy.alpha_per_stratum !== 0.025 || policy.zero_observed_misses !== true || policy.minimum_draws_per_case !== 2 || JSON.stringify(policy.strata) !== '["pass","fail"]'
  || policy.multiplicity_method !== "Bonferroni" || policy.review_signature_algorithm !== "ed25519" || policy.exact_judge_packet_required !== true
  || policy.exact_packet_human_label_required !== true) throw new TypeError("invalid qualification policy");
export const QUALIFICATION_POLICY = freeze({ ...policy, sha256: sha(policy) });

const CHOICE = [
  [/^key_correct$/, "key_correct"], [/^option_[A-Z]_correct$/, "option_X_correct"], [/^answer_in_seen$/, "answer_in_seen"],
  [/^feedback_[A-Z]_points_to_the_text$/, "feedback_X_points_to_the_text"], [/^feedback_[A-Z]_true$/, "feedback_X_true"],
  [/^correct_feedback_true$/, "correct_feedback_true"], [/^feedback_[A-Z]_gives_answer$/, "feedback_X_gives_answer"],
  [/^option_[A-Z]_from_the_text$/, "option_X_from_the_text"], [/^serves_the_lesson$/, "serves_the_lesson"]
];
const FAMILIES = {
  film_mcq: CHOICE, reading_mcq: CHOICE, key_term_mcq: CHOICE, rebuild_choice: CHOICE,
  open_check: [[/^reveal_meets_[1-9][0-9]*$/, "reveal_meets_N"], [/^accepted_[1-9][0-9]*_[1-9][0-9]*_meets$/, "accepted_N_M_meets"],
    [/^misreading_[1-9][0-9]*_passes$/, "misreading_N_passes"], [/^answerable$/, "answerable"], [/^prompt_clear$/, "prompt_clear"],
    [/^nudge_[1-9][0-9]*_[1-9][0-9]*_gives_answer$/, "nudge_N_M_gives_answer"]],
  evidence_select: [[/^candidate_[1-9][0-9]*_supports$/, "candidate_N_supports"], [/^decoy_[1-9][0-9]*_supports$/, "decoy_N_supports"]],
  classify: [[/^word_[1-9][0-9]*_fits$/, "word_N_fits"], [/^word_[1-9][0-9]*_[A-Za-z][A-Za-z0-9_]*_also_fits$/, "word_N_target_also_fits"]],
  open_prompt: [[/^reveal_true$/, "reveal_true"], [/^answerable$/, "answerable"]],
  word_web: [[/^answerable$/, "answerable"]], say_back: [[/^answerable$/, "answerable"]]
};
export function getCriterionFamily(kind, criterionId) {
  if (typeof criterionId !== "string" || /[\r\n\u2028\u2029]/.test(criterionId) || !Object.hasOwn(FAMILIES, kind)) return null;
  return FAMILIES[kind].find(([pattern]) => pattern.test(criterionId))?.[1] ?? null;
}

/** Lower endpoint L solves Pr(Binomial(total, L) >= correct) = alpha. */
export function exactLowerBound(correct, total, alpha = QUALIFICATION_POLICY.alpha_per_stratum) {
  if (!Number.isSafeInteger(correct) || !Number.isSafeInteger(total) || total < 0 || correct < 0 || correct > total
    || typeof alpha !== "number" || !Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) throw new RangeError("invalid binomial arguments");
  if (correct === 0) return 0;
  if (correct === total) return Math.exp(Math.log(alpha) / total);
  let logChoose = 0;
  const k = Math.min(correct, total - correct);
  for (let i = 1; i <= k; i++) logChoose += Math.log(total - k + i) - Math.log(i);
  const logTail = (p) => {
    if (p === 0) return -Infinity;
    if (p === 1) return 0;
    const logP = Math.log(p), logQ = Math.log1p(-p);
    let term = logChoose + correct * logP + (total - correct) * logQ, sum = term;
    for (let j = correct; j < total; j++) {
      term += Math.log(total - j) - Math.log(j + 1) + logP - logQ;
      const hi = Math.max(sum, term), lo = Math.min(sum, term);
      sum = hi + Math.log1p(Math.exp(lo - hi));
    }
    return sum;
  };
  const target = Math.log(alpha);
  let lower = 0, upper = 1;
  for (let i = 0; i < 80; i++) {
    const mid = (lower + upper) / 2;
    if (mid === lower || mid === upper) break;
    if (logTail(mid) <= target) lower = mid; else upper = mid;
  }
  return lower;
}

const CERT_KEYS = ["id", "operation", "criterion_family", "context_sha256", "runtime_sha256", "profile_sha256", "samples", "gates_sha256", "model", "served_revision", "revision_verified", "expires_at", "provenance", "cases", "review_signature"];
const PROVENANCE_KEYS = ["independent_human_gold", "held_out", "predeclared_scope", "independence_reviewed", "review_receipt_sha256", "holdout_sha256"];
const SCOPE_HASHES = ["context_sha256", "runtime_sha256", "profile_sha256", "gates_sha256"];
const FLAGS = ["independent_human_gold", "held_out", "predeclared_scope", "independence_reviewed"];
const DRAWS = new Set(["pass", "fail", "unsure", "unavailable", "error"]);
const validDate = (x) => typeof x === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(x)
  && Number.isFinite(Date.parse(x)) && new Date(Date.parse(x)).toISOString() === (x.includes(".") ? x : x.replace("Z", ".000Z"));
const validatedRegistries = new WeakSet(), validatedReviewerStores = new WeakSet();
const publicKeys = new WeakMap(), signatureChecks = new WeakMap(), certificateMetrics = new WeakMap();
const validSignature = (value) => typeof value === "string" && /^[A-Za-z0-9+/]{86}==$/.test(value)
  && Buffer.from(value, "base64").length === 64 && Buffer.from(value, "base64").toString("base64") === value;

/** Canonical UTF-8 bytes to sign with Ed25519; object key order never changes the payload. */
export function qualificationSigningPayload(certificate) {
  if (!record(certificate)) invalid();
  return Buffer.from(JSON.stringify(ordered(Object.fromEntries(Object.entries(certificate).filter(([key]) => key !== "review_signature")))), "utf8");
}

export function validateQualificationRegistry(input) {
  if (validatedRegistries.has(input)) return input;
  if (!record(input) || Object.keys(input).some((k) => !["schema_version", "certificates", "sha256"].includes(k))
    || input.schema_version !== 1 || !Array.isArray(input.certificates)) invalid();
  const ids = new Set();
  for (const c of input.certificates) {
    if (!exactKeys(c, CERT_KEYS) || !id(c.id) || ids.has(c.id) || !Object.hasOwn(FAMILIES, c.operation)
      || !FAMILIES[c.operation].some(([, family]) => family === c.criterion_family)) invalid();
    ids.add(c.id);
    if (!SCOPE_HASHES.every((k) => hash(c[k])) || !Number.isSafeInteger(c.samples) || c.samples < 1 || c.samples > 16
      || typeof c.model !== "string" || !MODEL.test(c.model) || !id(c.served_revision) || typeof c.revision_verified !== "boolean" || !validDate(c.expires_at)) invalid();
    if (!exactKeys(c.provenance, PROVENANCE_KEYS) || !FLAGS.every((k) => typeof c.provenance[k] === "boolean")
      || !hash(c.provenance.review_receipt_sha256) || !hash(c.provenance.holdout_sha256) || !Array.isArray(c.cases)) invalid();
    if (!exactKeys(c.review_signature, ["reviewer_id", "algorithm", "value"]) || !id(c.review_signature.reviewer_id)
      || c.review_signature.algorithm !== "ed25519" || !validSignature(c.review_signature.value)) invalid();
    const inputs = new Set(), groups = new Set();
    for (const row of c.cases) {
      if (!exactKeys(row, ["input_sha256", "independence_group", "expected", "draws"]) || !hash(row.input_sha256) || inputs.has(row.input_sha256)
        || !id(row.independence_group) || groups.has(row.independence_group) || !["pass", "fail"].includes(row.expected)
        || !Array.isArray(row.draws) || row.draws.length < QUALIFICATION_POLICY.minimum_draws_per_case || !row.draws.every((d) => DRAWS.has(d))) invalid();
      inputs.add(row.input_sha256); groups.add(row.independence_group);
    }
  }
  const registry = { schema_version: 1, certificates: structuredClone(input.certificates) }, sha256 = sha({ schema_version: 1, certificates: input.certificates });
  if (input.sha256 !== undefined && input.sha256 !== sha256) invalid();
  const result = freeze({ ...registry, sha256 }); validatedRegistries.add(result); return result;
}

export function loadQualification(file) {
  if (file === undefined || file === null) return validateQualificationRegistry({ schema_version: 1, certificates: [] });
  let bytes;
  try { bytes = fs.readFileSync(file, "utf8"); }
  catch (error) { if (error?.code === "ENOENT") return validateQualificationRegistry({ schema_version: 1, certificates: [] }); throw new TypeError("qualification registry unavailable"); }
  let input;
  try { input = JSON.parse(bytes); } catch { invalid(); }
  return validateQualificationRegistry(input);
}

const invalidReviewers = () => { throw new TypeError("invalid trusted reviewer configuration"); };
export function validateTrustedReviewers(input) {
  if (validatedReviewerStores.has(input)) return input;
  if (!record(input) || Object.keys(input).some((key) => !["schema_version", "reviewers", "sha256"].includes(key))
    || input.schema_version !== 1 || !Array.isArray(input.reviewers)) invalidReviewers();
  const keys = new Map();
  for (const reviewer of input.reviewers) {
    if (!exactKeys(reviewer, ["id", "public_key_pem"]) || !id(reviewer.id) || keys.has(reviewer.id) || typeof reviewer.public_key_pem !== "string"
      || reviewer.public_key_pem.length > 4096 || !/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\r?\n?$/.test(reviewer.public_key_pem)) invalidReviewers();
    let key;
    try { key = crypto.createPublicKey(reviewer.public_key_pem); } catch { invalidReviewers(); }
    if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") invalidReviewers();
    keys.set(reviewer.id, key);
  }
  const store = { schema_version: 1, reviewers: structuredClone(input.reviewers) }, sha256 = sha(store);
  if (input.sha256 !== undefined && input.sha256 !== sha256) invalidReviewers();
  const result = freeze({ ...store, sha256 }); validatedReviewerStores.add(result); publicKeys.set(result, keys); return result;
}
const EMPTY_REVIEWERS = validateTrustedReviewers({ schema_version: 1, reviewers: [] });
export function loadTrustedReviewers(file) {
  if (file === undefined || file === null) return EMPTY_REVIEWERS;
  let bytes;
  try { bytes = fs.readFileSync(file, "utf8"); }
  catch (error) { if (error?.code === "ENOENT") return EMPTY_REVIEWERS; throw new TypeError("trusted reviewer configuration unavailable"); }
  let input;
  try { input = JSON.parse(bytes); } catch { invalidReviewers(); }
  return validateTrustedReviewers(input);
}
function authenticReview(certificate, trusted) {
  if (!trusted.reviewers.length) return "trusted_reviewers_missing";
  const key = publicKeys.get(trusted).get(certificate.review_signature.reviewer_id);
  if (!key) return "reviewer_not_trusted";
  let results = signatureChecks.get(certificate);
  if (!results) { results = new WeakMap(); signatureChecks.set(certificate, results); }
  if (!results.has(trusted)) {
    let verified = false;
    try { verified = crypto.verify(null, qualificationSigningPayload(certificate), key, Buffer.from(certificate.review_signature.value, "base64")); } catch { /* Fail closed without exposing key or certificate contents. */ }
    results.set(trusted, verified);
  }
  return results.get(trusted) ? null : "review_signature_invalid";
}

function metrics(certificate) {
  if (certificateMetrics.has(certificate)) return certificateMetrics.get(certificate);
  const strata = Object.fromEntries(QUALIFICATION_POLICY.strata.map((label) => {
    const cases = certificate.cases.filter((row) => row.expected === label);
    const correct = cases.filter((row) => row.draws.every((draw) => draw === label)).length;
    return [label, { total: cases.length, correct, misses: cases.length - correct,
      abstention_or_error_cases: cases.filter((row) => row.draws.some((d) => ["unsure", "unavailable", "error"].includes(d))).length,
      repeated_draws: cases.reduce((n, row) => n + row.draws.length, 0), lower_bound: exactLowerBound(correct, cases.length) }];
  }));
  const result = freeze({ ...strata, target_accuracy: QUALIFICATION_POLICY.target_accuracy, joint_confidence: QUALIFICATION_POLICY.joint_confidence,
    alpha_per_stratum: QUALIFICATION_POLICY.alpha_per_stratum, zero_observed_misses: QUALIFICATION_POLICY.zero_observed_misses, minimum_draws_per_case: QUALIFICATION_POLICY.minimum_draws_per_case });
  certificateMetrics.set(certificate, result); return result;
}
const alias = (model) => /(?:^|[-_])(?:latest|preview|stable|default|auto)(?:$|[-_])/i.test(model);

export function qualify(registry, scope, { kind, criterion_id } = {}, trustedReviewers = EMPTY_REVIEWERS) {
  const r = validateQualificationRegistry(registry);
  const trusted = validateTrustedReviewers(trustedReviewers);
  const family = getCriterionFamily(kind, criterion_id);
  const base = { eligible: false, criterion_family: family, registry_sha256: r.sha256, trusted_reviewers_sha256: trusted.sha256, policy_id: QUALIFICATION_POLICY.id, policy_sha256: QUALIFICATION_POLICY.sha256 };
  if (!family) return freeze({ ...base, reasons: ["unknown_criterion_family"] });
  const now = scope?.now === undefined ? Date.now() : scope.now instanceof Date ? scope.now.getTime() : typeof scope.now === "number" ? scope.now : validDate(scope.now) ? Date.parse(scope.now) : NaN;
  if (!record(scope) || !SCOPE_HASHES.every((k) => hash(scope[k])) || !hash(scope.judge_packet_sha256) || !Number.isSafeInteger(scope.samples) || scope.samples < 1 || scope.samples > 16
    || typeof scope.model !== "string" || !MODEL.test(scope.model) || !Number.isFinite(now)) return freeze({ ...base, reasons: ["invalid_qualification_scope"] });
  if (alias(scope.model)) return freeze({ ...base, reasons: ["model_alias_not_qualified"] });
  const candidates = r.certificates.filter((c) => c.operation === kind && c.criterion_family === family);
  if (!candidates.length) return freeze({ ...base, reasons: ["missing_certificate"] });
  const eligible = [], allReasons = new Set();
  for (const c of candidates) {
    const reasons = [];
    const reviewIssue = authenticReview(c, trusted);
    if (reviewIssue) reasons.push(reviewIssue);
    for (const key of SCOPE_HASHES) if (c[key] !== scope[key]) reasons.push(`${key}_mismatch`);
    const packetCase = c.cases.find((row) => row.input_sha256 === scope.judge_packet_sha256);
    if (!packetCase) reasons.push("judge_packet_human_label_missing");
    if (c.samples !== scope.samples) reasons.push("samples_mismatch");
    if (c.model !== scope.model) reasons.push("model_mismatch");
    if (alias(c.model)) reasons.push("model_alias_not_qualified");
    if (!c.revision_verified) reasons.push("served_revision_unverified");
    if (Date.parse(c.expires_at) <= now) reasons.push("certificate_expired");
    for (const flag of FLAGS) if (!c.provenance[flag]) reasons.push(`${flag}_required`);
    const m = metrics(c);
    for (const label of QUALIFICATION_POLICY.strata) {
      if (m[label].lower_bound < QUALIFICATION_POLICY.target_accuracy) reasons.push(`${label}_accuracy_lower_bound_below_target`);
      if (QUALIFICATION_POLICY.zero_observed_misses && m[label].misses > 0) reasons.push(`${label}_observed_misses`);
    }
    if (!reasons.length) eligible.push({ certificate: c, metrics: m, verified_expected_verdict: packetCase.expected });
    reasons.forEach((reason) => allReasons.add(reason));
  }
  if (!eligible.length) return freeze({ ...base, reasons: [...allReasons] });
  if (new Set(eligible.map(({ certificate: c }) => c.served_revision)).size > 1) return freeze({ ...base, reasons: ["ambiguous_served_revisions"] });
  if (new Set(eligible.map((entry) => entry.verified_expected_verdict)).size > 1) return freeze({ ...base, reasons: ["conflicting_verified_verdicts"] });
  const { certificate: c, metrics: m, verified_expected_verdict } = eligible[0];
  return freeze({ ...base, eligible: true, reasons: [], certificate_id: c.id, model: c.model, served_revision: c.served_revision,
    reviewer_id: c.review_signature.reviewer_id, verified_expected_verdict, expires_at: c.expires_at, metrics: m, scope: { operation: c.operation, criterion_family: c.criterion_family,
      context_sha256: c.context_sha256, runtime_sha256: c.runtime_sha256, profile_sha256: c.profile_sha256, gates_sha256: c.gates_sha256, judge_packet_sha256: scope.judge_packet_sha256, samples: c.samples } });
}
