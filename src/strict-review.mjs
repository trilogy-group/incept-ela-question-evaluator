// Individual-sample uncertainty and conflict veto for development review.
import { evaluateProjection } from "./evaluate.mjs";
import { validateAnswer, passes, GATES } from "./typed/questions.mjs";
import { safeFailureCode } from "./typed/client.mjs";
import { digest } from "./lesson-package.mjs";

export async function reviewStrictProjection(context, set, options = {}) {
  const { provider = null, providerFactory = null, role = "primary", ...rest } = options;
  const observations = [], journal = rest.log ?? [];
  const wrap = candidate => ({ ...candidate, async ask(state, questions, sampleOptions) {
    const stateHash = digest(state), sample = sampleOptions?.sample ?? null;
    let response;
    try { response = await candidate.ask(state, questions, sampleOptions); }
    catch (error) {
      const code = safeFailureCode(error);
      for (const question of questions) observations.push({ state_sha256: stateHash, criterion_id: question.id, sample, category: "unavailable", code });
      const safe = new Error("strict review provider unavailable; details suppressed"); safe.code = code; throw safe;
    }
    for (const question of questions) {
      const value = validateAnswer(question, response?.error ? null : response?.answers?.[question.id]);
      const gate = value.unavailable ? null : passes(value, GATES);
      observations.push({ state_sha256: stateHash, criterion_id: question.id, sample,
        category: value.unavailable ? "unavailable" : !gate.pass ? "unsure" : value.value >= .5 ? "yes" : "no",
        ...(value.unavailable ? { code: value.reason } : { p_yes: value.value, gate_reasons: gate.reasons }) });
    }
    return response;
  } });
  const factory = providerFactory ? async () => {
    try { return wrap(await providerFactory()); }
    catch (error) {
      const safe = new Error("strict review provider initialization unavailable; details suppressed");
      safe.code = safeFailureCode(error); throw safe;
    }
  } : null;
  const report = await evaluateProjection(context, set, { ...rest, log: journal, provider: provider ? wrap(provider) : null, providerFactory: factory });
  const grouped = new Map();
  for (const observation of observations) {
    const key = `${observation.state_sha256}/${observation.criterion_id}`;
    if (!grouped.has(key)) grouped.set(key, []); grouped.get(key).push(observation);
  }
  for (const item of report.items) {
    for (const check of item.checks) {
      const row = journal.find(row => row.tag === item.id || row.tag === `${item.id}/${check.id}`);
      if (check.method !== "judge" || !check.requested || !row) continue;
      const samples = grouped.get(`${digest(row.state)}/${check.id}`) ?? [];
      const categories = new Set(samples.map(sample => sample.category)), reasons = [];
      if (categories.has("unavailable")) reasons.push("an_attempt_unavailable");
      if (categories.has("unsure")) reasons.push("a_sample_abstained");
      if (categories.has("yes") && categories.has("no")) reasons.push("samples_disagree");
      if (!samples.length) reasons.push("sample_record_missing");
      if (reasons.length) {
        check.verdict = categories.has("unavailable") || !samples.length ? "unavailable" : "unsure";
        check.gate = [...new Set([...(check.gate ?? []), ...reasons])];
      }
      check.individual_samples = samples.map(({ state_sha256, criterion_id, ...sample }) => sample);
    }
    const required = item.checks.filter(check => check.required);
    item.status = required.some(check => check.verdict === "fail") ? "fails"
      : !required.length || required.some(check => !["pass", "not_applicable"].includes(check.verdict)) ? "unsure" : "checks_passed_unqualified";
  }
  report.counts = report.items.reduce((counts, item) => { counts[item.status] = (counts[item.status] ?? 0) + 1; return counts; }, {});
  const agreements = report.items.flatMap(item => item.checks.filter(check => check.method === "judge" && ["pass", "fail", "flag"].includes(check.verdict)
    && Number.isFinite(check.agreement)).map(check => check.agreement));
  report.judge_agreement = agreements.length ? { judgements: agreements.length, unanimous: agreements.filter(value => value === 1).length,
    mean: Number((agreements.reduce((sum, value) => sum + value, 0) / agreements.length).toFixed(3)) } : null;
  const semantic = report.items.flatMap(item => item.checks.filter(check => check.method === "judge"));
  if (report.judge_coverage) report.judge_coverage = { ...report.judge_coverage,
    returned_usable_criteria: semantic.filter(check => check.requested && check.verdict !== "unavailable").length,
    unavailable_criteria: semantic.filter(check => check.verdict === "unavailable").length };
  report.evaluator = { ...report.evaluator, role, strict_sample_veto: true, accuracy: "unmeasured", qualification: "unqualified" };
  report.status = "unverified";
  return report;
}
