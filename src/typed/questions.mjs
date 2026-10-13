// Typed questions and typed answers. Three primitives (TypeSafe Jev): noul (yes/no probability),
// choice (one of N options with a probability per option and a confidence), score (ordered levels).
// Code owns validation, aggregation over samples, and the support gates. The model never emits a count.

export const GATES = Object.freeze({ confidence: 0.55, top: 0.6, margin: 0.15 });
export const PROMPT_VERSION = "engine-bank-2026-09-22.1";

export function noul(id, instructions, criteria) {
  const q = { id, type: "noul", instructions };
  if (criteria) q.criteria = criteria;
  return q;
}

export function choice(id, instructions, criteria) {
  if (!criteria || typeof criteria !== "object" || Array.isArray(criteria)) {
    throw new TypeError(`choice ${id}: criteria must be an object of option -> description`);
  }
  const keys = Object.keys(criteria);
  if (keys.length < 2 || keys.length > 255) throw new RangeError(`choice ${id}: 2..255 options`);
  return { id, type: "choice", instructions, criteria: { ...criteria } };
}

export function score(id, instructions, levels) {
  if (!Array.isArray(levels) || levels.length < 2 || levels.length > 10) {
    throw new RangeError(`score ${id}: 2..10 ordered level descriptions`);
  }
  return { id, type: "score", instructions, criteria: [...levels] };
}

export function unavailable(id, type, reason) {
  return { id, type, value: "unknown", probabilities: {}, confidence: 0, unavailable: true, reason };
}

const finite01 = (x) => typeof x === "number" && Number.isFinite(x) && x >= -1e-9 && x <= 1 + 1e-9;

/** Normalize one raw provider answer against its question. Invalid -> unavailable with a reason. */
export function validateAnswer(q, raw) {
  if (!raw || typeof raw !== "object") return unavailable(q.id, q.type, "answer_missing");
  if (q.type === "noul") {
    const p = raw.noul;
    if (!finite01(p)) return unavailable(q.id, q.type, "probability_value");
    // The API supplies no confidence for a noul (a noul's probability already carries its uncertainty).
    // This is our own derived statistic — distance from 0.5 — and the gates treat it as such.
    return { id: q.id, type: "noul", value: p, probabilities: { yes: p, no: 1 - p }, confidence: Math.max(p, 1 - p), confidenceDerived: true };
  }
  if (q.type === "choice") {
    const keys = Object.keys(q.criteria);
    const probs = raw.probabilities;
    if (!probs || typeof probs !== "object") return unavailable(q.id, q.type, "probability_keys");
    const pk = Object.keys(probs);
    if (pk.length !== keys.length || !keys.every((k) => k in probs)) return unavailable(q.id, q.type, "probability_keys");
    if (!keys.every((k) => finite01(probs[k]))) return unavailable(q.id, q.type, "probability_value");
    const sum = keys.reduce((s, k) => s + probs[k], 0);
    if (Math.abs(sum - 1) > 0.03) return unavailable(q.id, q.type, "probability_sum");
    if (!keys.includes(raw.choice)) return unavailable(q.id, q.type, "choice_invalid");
    const max = Math.max(...keys.map((k) => probs[k]));
    if (probs[raw.choice] < max - 1e-6) return unavailable(q.id, q.type, "choice_not_maximal");
    if (!finite01(raw.confidence)) return unavailable(q.id, q.type, "confidence_invalid");
    return { id: q.id, type: "choice", value: raw.choice, probabilities: { ...probs }, confidence: raw.confidence };
  }
  if (q.type === "score") {
    const n = q.criteria.length;
    let s = raw.score;
    if (typeof s !== "number" || !Number.isFinite(s)) return unavailable(q.id, q.type, "score_invalid");
    let probs = raw.probabilities;
    if (Array.isArray(probs)) probs = Object.fromEntries(probs.map((p, i) => [String(i + 1), p]));
    // The provider may index levels from 0 (jev-1.13.0 does) or from 1. Normalize to 1-based.
    const zeroBased = probs && typeof probs === "object" && Object.prototype.hasOwnProperty.call(probs, "0");
    if (zeroBased) { probs = Object.fromEntries(Object.entries(probs).map(([k, v]) => [String(Number(k) + 1), v])); s = s + 1; }
    else if (!probs && s >= 0 && s < 1 && n >= 2) s = s + 1;
    if (s < 1 || s > n) return unavailable(q.id, q.type, "score_invalid");
    if (!probs || typeof probs !== "object") probs = Object.fromEntries(q.criteria.map((_, i) => [String(i + 1), i + 1 === Math.round(s) ? 1 : 0]));
    const keys = q.criteria.map((_, i) => String(i + 1));
    if (!keys.every((k) => finite01(probs[k] ?? NaN))) return unavailable(q.id, q.type, "probability_value");
    const sum = keys.reduce((a, k) => a + probs[k], 0);
    if (Math.abs(sum - 1) > 0.03) return unavailable(q.id, q.type, "probability_sum");
    if (!finite01(raw.confidence ?? 1)) return unavailable(q.id, q.type, "confidence_invalid");
    const legend = typeof raw.legend === "string" ? raw.legend : q.criteria[Math.max(0, Math.min(n - 1, Math.round(s) - 1))];
    return { id: q.id, type: "score", value: s, legend, probabilities: Object.fromEntries(keys.map((k) => [k, probs[k]])), confidence: raw.confidence ?? 1 };
  }
  return unavailable(q.id, q.type, "answer_type");
}

/** Average per-option probabilities over valid samples; the choice is the argmax of the mean. */
export function aggregate(q, samples) {
  const valid = samples.filter((a) => a && !a.unavailable);
  if (valid.length === 0) {
    const r = samples.map((a) => a?.reason).filter(Boolean).join("|") || "no_samples";
    return { ...unavailable(q.id, q.type, r), samples: samples.length, valid: 0, agreement: null };
  }
  const keys = Object.keys(valid[0].probabilities);
  const mean = Object.fromEntries(keys.map((k) => [k, valid.reduce((s, a) => s + (a.probabilities[k] ?? 0), 0) / valid.length]));
  const confidence = valid.reduce((s, a) => s + a.confidence, 0) / valid.length;
  let value;
  if (q.type === "noul") value = mean.yes;
  else if (q.type === "choice") value = keys.reduce((b, k) => (mean[k] > mean[b] ? k : b), keys[0]);
  else value = valid.reduce((s, a) => s + a.value, 0) / valid.length;
  const agreeWith = (a) => (q.type === "noul" ? (a.value >= 0.5) === (value >= 0.5) : q.type === "choice" ? a.value === value : Math.round(a.value) === Math.round(value));
  const agreement = valid.length > 1 ? valid.filter(agreeWith).length / valid.length : null;
  const out = { id: q.id, type: q.type, value, probabilities: mean, confidence, samples: samples.length, valid: valid.length, agreement };
  if (q.type === "score") out.legend = q.criteria[Math.max(0, Math.min(q.criteria.length - 1, Math.round(value) - 1))];
  return out;
}

/** Support gates (conservative engineering thresholds, not calibrated correctness). */
export function passes(ans, gates = GATES) {
  if (!ans || ans.unavailable) return { pass: false, reasons: ["unavailable"] };
  const ps = Object.values(ans.probabilities).sort((a, b) => b - a);
  const top = ps[0] ?? 0;
  const margin = top - (ps[1] ?? 0);
  const reasons = [];
  if (ans.confidence < gates.confidence) reasons.push(`confidence<${gates.confidence}`);
  if (top < gates.top) reasons.push(`top<${gates.top}`);
  if (margin < gates.margin) reasons.push(`margin<${gates.margin}`);
  return { pass: reasons.length === 0, reasons, top, margin };
}

/** Deterministic option-order rotation per sample (option order shifts answers; rotate and average). */
export function rotateCriteria(q, sample) {
  if (q.type !== "choice" || sample === 0) return q;
  const keys = Object.keys(q.criteria);
  const k = sample % keys.length;
  const rotated = [...keys.slice(k), ...keys.slice(0, k)];
  return { ...q, criteria: Object.fromEntries(rotated.map((key) => [key, q.criteria[key]])) };
}
