// Independent development signal. Primary verdicts, qualification evidence and human labels never enter this route.
import crypto from "node:crypto";
import { evaluateProjection } from "./evaluate.mjs";

const SIDE_PROVIDER = "maat-gemini-flash";
const DEFAULT_MODEL = "gemini-group/gemini-3.8-flash";
const ENCODING = "yes=1/no=0/unsure=.5; not calibrated confidence";
const fingerprint = (state) => crypto.createHash("sha256").update(JSON.stringify(state)).digest("hex");
const pairKey = (item, criterion) => JSON.stringify([item, criterion]);
const normalized = (verdict) => verdict === "flag" ? "fail" : ["pass", "fail"].includes(verdict) ? verdict : null;

export async function reviewSideProjection(context, set, { provider = null, providerFactory = null, model = null, samples = 3, log = null, configFile } = {}) {
  if (provider && providerFactory) throw new Error("side review accepts one provider source");
  if (providerFactory !== null && typeof providerFactory !== "function") throw new Error("invalid side provider factory");
  if (log !== null && !Array.isArray(log)) throw new Error("invalid side review journal");
  const requestedModel = model ?? provider?.model ?? DEFAULT_MODEL;
  if (typeof requestedModel !== "string" || !requestedModel.trim()) throw new Error("side review requires a model identifier");
  const journal = [], uncertain = new Set(), states = new WeakMap();
  const stateHash = (state) => {
    if (!states.has(state)) states.set(state, fingerprint(state));
    return states.get(state);
  };
  const checkedProvider = (candidate) => {
    if (!candidate || candidate.name !== SIDE_PROVIDER || candidate.model !== requestedModel || typeof candidate.ask !== "function") {
      throw new Error("side review requires the declared MAAT Gemini Flash provider");
    }
    return { name: SIDE_PROVIDER, model: requestedModel, async ask(state, questions, options) {
      const key = stateHash(state);
      let response;
      try { response = await candidate.ask(state, questions, options); }
      catch (error) {
        const code = typeof error?.code === "string" && /^(?:HTTP_(?:[1-5][0-9]{2}|UNKNOWN)|TRANSPORT_UNAVAILABLE|TIMEOUT|INVALID_JSON|INVALID_CATEGORICAL|INCOMPLETE_COMPLETION)$/.test(error.code) ? error.code : "UNAVAILABLE";
        throw new Error(`side provider unavailable (${code}); provider details suppressed`);
      }
      for (const question of questions) if (response?.answers?.[question.id]?.noul === 0.5) uncertain.add(pairKey(key, question.id));
      return response;
    } };
  };
  const factory = providerFactory ? async () => {
    let candidate;
    try { candidate = await providerFactory(); }
    catch { throw new Error("side provider initialization unavailable; provider details suppressed"); }
    return checkedProvider(candidate);
  } : null;
  const report = await evaluateProjection(context, set, { provider: provider ? checkedProvider(provider) : null,
    providerFactory: factory, model: requestedModel, samples, log: journal, configFile,
    mode: "development", profile: "jev-full-experimental" });
  // The typed client averages numeric noul values. Here .5 encodes a categorical abstention,
  // so any such draw excludes that criterion from a decisive side verdict.
  const unsureChecks = new Set();
  for (const row of journal) for (const question of row.questions) {
    if (uncertain.has(pairKey(stateHash(row.state), question.id))) unsureChecks.add(pairKey(row.tag, question.id));
  }
  for (const item of report.items) {
    for (const check of item.checks) if (check.method === "judge" && unsureChecks.has(pairKey(item.id, check.id))) {
      if (check.verdict !== "unavailable") check.verdict = "unsure";
      check.agreement = null;
      check.gate = [...new Set([...(check.gate || []), "categorical_draw_unsure"])];
    }
    const required = item.checks.filter((check) => check.required);
    if (required.some((check) => check.verdict === "fail")) item.status = "fails";
    else if (required.some((check) => !["pass", "not_applicable"].includes(check.verdict))) item.status = "unsure";
  }
  report.counts = report.items.reduce((counts, item) => { counts[item.status] = (counts[item.status] || 0) + 1; return counts; }, {});
  const agreements = report.items.flatMap((item) => item.checks.filter((check) => check.method === "judge" && check.requested
    && normalized(check.verdict) !== null && Number.isFinite(check.agreement)).map((check) => check.agreement));
  report.judge_agreement = agreements.length ? { judgements: agreements.length, unanimous: agreements.filter((value) => value === 1).length,
    mean: Number((agreements.reduce((sum, value) => sum + value, 0) / agreements.length).toFixed(3)) } : null;
  report.evaluator = { ...report.evaluator, role: "side", qualification: "unqualified", accuracy: "unmeasured",
    categorical_encoding: ENCODING, signal_only: true, independent_gold_labels: 0 };
  report.status = "unverified";
  if (log) log.push(...journal);
  return report;
}

function indexedChecks(report) {
  if (!report || !Array.isArray(report.items)) throw new Error("invalid side comparison report");
  const checks = new Map(), itemIds = new Set();
  for (const item of report.items) {
    if (!item || typeof item.id !== "string" || !item.id || itemIds.has(item.id) || !Array.isArray(item.checks)) throw new Error("invalid or duplicate comparison item");
    itemIds.add(item.id);
    for (const check of item.checks) {
      if (check?.method !== "judge") continue;
      if (typeof check.id !== "string" || !check.id || typeof check.verdict !== "string") throw new Error("invalid comparison criterion");
      const key = pairKey(item.id, check.id);
      if (checks.has(key)) throw new Error("duplicate comparison criterion");
      checks.set(key, { item_id: item.id, criterion_id: check.id, verdict: check.verdict });
    }
  }
  return checks;
}

/** Pair categorical judgments only. This neither changes the primary report nor measures correctness. */
export function compareSide(primary, side) {
  const input = {};
  for (const key of ["context_projection_sha256", "set_projection_sha256"]) {
    const value = primary?.input?.[key];
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value) || value !== side?.input?.[key]) throw new Error("side comparison input hash mismatch");
    input[key] = value;
  }
  const p = indexedChecks(primary), s = indexedChecks(side);
  const counts = { primary_criteria: p.size, side_criteria: s.size, matched_pairs: 0, comparable_pairs: 0, agreements: 0, disagreements: 0,
    excluded_pairs: 0, primary_only: 0, side_only: 0, primary_unsure: 0, primary_unavailable: 0, primary_other: 0,
    side_unsure: 0, side_unavailable: 0, side_other: 0 };
  for (const [name, index] of [["primary", p], ["side", s]]) for (const row of index.values()) {
    if (row.verdict === "unsure") counts[`${name}_unsure`]++;
    else if (row.verdict === "unavailable") counts[`${name}_unavailable`]++;
    else if (!normalized(row.verdict)) counts[`${name}_other`]++;
  }
  const disagreements = [];
  for (const [key, row] of p) {
    const other = s.get(key);
    if (!other) { counts.primary_only++; continue; }
    counts.matched_pairs++;
    const a = normalized(row.verdict), b = normalized(other.verdict);
    if (a === null || b === null) { counts.excluded_pairs++; continue; }
    counts.comparable_pairs++;
    if (a === b) counts.agreements++;
    else { counts.disagreements++; disagreements.push({ item_id: row.item_id, criterion_id: row.criterion_id,
      primary_verdict: row.verdict, side_verdict: other.verdict }); }
  }
  for (const key of s.keys()) if (!p.has(key)) counts.side_only++;
  return { role: "side_comparison", qualification: "unqualified", qualified: false, status: "unverified", accuracy: "unmeasured",
    input, counts, agreement_rate: counts.comparable_pairs ? counts.agreements / counts.comparable_pairs : null, disagreements,
    primary_overridden: false, meaning: "Agreement of paired categorical judgments only; neither model is gold. No averaging, primary override, academic qualification or verified learner-context claim." };
}
