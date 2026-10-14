// Evaluate a question set against its lesson context: code checks, then the judge's bounded questions (several samples
// each, so a verdict's stability is on record), then the set as a whole. Unsure is never a pass.
import { decide, GATES, ENGINE_SNAPSHOT } from "./engine.mjs";
import { seenBefore, asText, playLines, studentText } from "./seen.mjs";
import { codeChecks, judgeQuestions, judgeItem, isChoice, norm } from "./checks.mjs";
import { packetProjection, inputIssues, viewIssues, layoutIssues } from "./packet.mjs";
import { getJudgeProfile, selectJudgeQuestions } from "./judge-profile.mjs";
import { QUALIFICATION_POLICY, qualify, validateQualificationRegistry, validateTrustedReviewers } from "./qualification.mjs";
import { runtimeSnapshot, sha } from "./replay.mjs";
import { KNOWLEDGE_BASELINE } from "./knowledge-baseline.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const VERSION = "question-evaluator 0.5-development";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_SEEN = 60000;   // characters of what came before; the oldest pages give way first, the item's own page never

function trimSeen(parts) {
  let text = asText(parts);
  const kept = [...parts];
  while (text.length > MAX_SEEN && kept.length > 1) { kept.shift(); text = asText(kept); }
  return { text, dropped: parts.length - kept.length };
}

function judgeVerdict(ans, expect, required) {
  if (!ans || ans.unavailable) return "unavailable";
  if (!ans.pass) return "unsure";
  return (ans.value >= 0.5) === expect ? "pass" : required ? "fail" : "flag";
}

function judgeState(it, seen, learningQuestion, keywords, profile, criterionId = null) {
  const item = judgeItem(it);
  if (profile.id === "jev-full-experimental") return { learning_question: learningQuestion, keywords, seen_before: seen, item };
  if (profile.id === "jev-qualified-v1") {
    const state = { seen_before: seen, item };
    if (isChoice(it)) {
      if (!criterionId.startsWith("feedback_")) delete item.feedback;
      if (criterionId !== "correct_feedback_true") delete item.correct_feedback;
      if (criterionId === "serves_the_lesson") state.learning_question = learningQuestion;
    }
    if (it.kind === "open_check") {
      if (!criterionId.startsWith("nudge_")) delete item.nudges;
      if (!criterionId.startsWith("misreading_")) delete item.misreadings;
    }
    return state;
  }
  // Unassessed feedback must not tell the judge which option its author intended to be right.
  if (isChoice(it)) return { seen_before: seen, item: { question: item.question, options: item.options } };
  if (it.kind === "open_check") { delete item.nudges; delete item.misreadings; }
  return { seen_before: seen, item };
}

export function criterionPacket(item, seen, learningQuestion, keywords, question) {
  return { state: judgeState(item, seen, learningQuestion, keywords, getJudgeProfile("jev-qualified-v1"), question.id), questions: [question] };
}

// Review the same criterion/context snapshots used by evaluation, without inferred human labels.
export function collectCriterionPackets(context, qset, { profile: profileId = "jev-partial-v1", projected = false } = {}) {
  const issues = inputIssues(context, qset, { projected });
  if (issues.length) throw new Error("invalid public review packet");
  const projectedPacket = packetProjection(context, qset), profile = getJudgeProfile(profileId);
  if (profile.id !== "jev-partial-v1") throw new Error("review pilot supports only the partial criterion profile");
  context = projectedPacket.context; qset = projectedPacket.set;
  const lesson = context.native, learningQuestion = context.lesson.learning_question;
  const keywords = Object.fromEntries((context.lesson.keywords || []).map((k) => typeof k === "string" ? [k, null] : [k?.word, k?.meaning ?? null]).filter(([word]) => typeof word === "string"));
  const entries = [], unsupported = [];
  for (const item of qset.items) {
    const missing = [...layoutIssues(context, item), ...viewIssues(item)];
    if (missing.length) { unsupported.push({ item_id: item.id, issues: missing }); continue; }
    const seen = trimSeen(seenBefore(lesson, item, qset.items));
    for (const check of selectJudgeQuestions(profile, item.kind, judgeQuestions(item)).selected) {
      const packet = criterionPacket(item, seen.text, learningQuestion, keywords, check.q);
      entries.push({ item_id: item.id, kind: item.kind, criterion_id: check.q.id, expect: check.expect,
        required: check.required, packet, judge_packet_sha256: sha(JSON.stringify(packet)),
        learner_exposure: "unverified native reconstruction", dropped_pages: seen.dropped });
    }
  }
  return { input: projectedPacket.hashes, profile, entries, unsupported };
}
const publicQualification = (qualification) => {
  const { verified_expected_verdict, ...result } = qualification;
  return result;
};

function servingIssues(meta, provider, profile) {
  const observations = meta.serving_observations || [];
  const models = [...new Set(observations.filter((o) => !o.unavailable).map((o) => o.model))];
  const issues = [];
  if (observations.some((o) => !o.unavailable && !o.model)) issues.push("reported_model_missing");
  if (models.length > 1) issues.push("reported_model_changed_within_call");
  if (provider.name === "jev" && profile.id === "jev-partial-v1" && models.some((m) => !profile.observed_model_ids.includes(m))) issues.push("reported_model_outside_development_trial");
  return issues;
}

function status(checks) {
  const req = checks.filter((c) => c.required);
  if (req.some((c) => c.verdict === "fail")) return "fails";
  if (!req.length || req.some((c) => !["pass", "not_applicable"].includes(c.verdict))) return "unsure";
  return "checks_passed_unqualified";
}

function setChecks(items) {
  const out = [];
  const choice = items.filter((it) => isChoice(it.item) && it.item.view.options.length >= 3);
  const pos = {};
  for (const { item } of choice) pos[String.fromCharCode(65 + item.view.key[0])] = (pos[String.fromCharCode(65 + item.view.key[0])] || 0) + 1;
  const n = choice.length, top = Math.max(0, ...Object.values(pos));
  out.push({ id: "key_positions", method: "code", required: false, verdict: n >= 8 && (top / n > 0.5 || Object.keys(pos).length < 3) ? "flag" : "pass", evidence: { positions: pos, items: n } });
  const longest = items.filter((it) => it.checks.some((c) => c.id === "key_is_longest" && c.verdict === "flag")).map((it) => it.item.id);
  out.push({ id: "key_is_longest_rate", method: "code", required: false, verdict: n && longest.length / n > 0.4 ? "flag" : "pass", evidence: { longest: longest.length, of: n, items: longest } });
  return out;
}

function lessonChecks(lesson, items) {
  const out = [];
  const text = norm(items.map(({ item }) => studentText(item.native).join(" ")).join(" "));
  const words = (lesson.keywords || []).map((k) => typeof k === "string" ? k : k?.word).filter((w) => typeof w === "string" && w.trim());
  const missing = words.filter((w) => !text.includes(norm(w)));
  out.push({ id: "keywords_used_by_questions", method: "code", required: false, verdict: missing.length ? "flag" : "pass", evidence: missing.length ? { not_in_any_question: missing } : { keywords: words.length } });
  const exposed = [];
  items.forEach(({ item }, i) => {
    if (!isChoice(item)) return;
    const keyText = norm(item.view.options[item.view.key[0]]);
    if (keyText.split(" ").length < 2) return;
    for (const { item: e } of items.slice(0, i)) {
      const shown = norm([...(e.view.option_feedback || []), e.view.correct_feedback, e.view.rubric?.reveal, e.view.reveal].filter(Boolean).join(" "));
      if (` ${shown} `.includes(` ${keyText} `)) { exposed.push({ item: item.id, answer: item.view.options[item.view.key[0]], given_earlier_by: e.id }); break; }
    }
  });
  out.push({ id: "earlier_items_give_the_key", method: "code", required: false, verdict: exposed.length ? "flag" : "pass", evidence: exposed.length ? { exposed } : {} });
  return out;
}

export function evaluate(context, qset, options = {}) {
  return evaluateInput(context, qset, options, false);
}

// Internal replay entry point: the CLI has validated public provenance before freezing this stripped packet.
// All remaining transport and interpreter checks still run; this does not confer quality qualification.
export function evaluateProjection(context, qset, options = {}) {
  return evaluateInput(context, qset, options, true);
}

async function evaluateInput(context, qset, { provider = null, providerFactory = null, model = null, samples = 3, concurrency = 4, log = null, profile: profileId = null, mode = "qualified", qualification = null, trustedReviewers = null, configFile = path.join(ROOT, "config.json") } = {}, projected) {
  if (!["qualified", "development"].includes(mode)) throw new Error("unknown evaluation mode");
  const profile = getJudgeProfile(profileId || (mode === "qualified" ? "jev-qualified-v1" : "jev-partial-v1"));
  if ((mode === "qualified") !== (profile.id === "jev-qualified-v1")) throw new Error("judge profile does not match evaluation mode");
  const registry = validateQualificationRegistry(qualification || { schema_version: 1, certificates: [] });
  const trust = validateTrustedReviewers(trustedReviewers || { schema_version: 1, reviewers: [] });
  const requestedModel = model || provider?.model || "jev-latest";
  const decisionBuild = { runtime_sha256: runtimeSnapshot(ROOT, configFile).sha256, profile_sha256: profile.sha256, samples, gates_sha256: sha(JSON.stringify(GATES)), model: requestedModel, now: new Date().toISOString() };
  let pendingProvider = null;
  const getProvider = async () => {
    if (provider) return provider;
    if (!providerFactory) return null;
    pendingProvider ||= Promise.resolve().then(providerFactory);
    provider = await pendingProvider;
    if (!provider || provider.model !== requestedModel) throw new Error("requested judge model changed before execution");
    return provider;
  };
  if (!Number.isInteger(samples) || samples < 1 || samples > 16) throw new Error("samples must be an integer from 1 to 16");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error("concurrency must be an integer from 1 to 16");
  const issues = inputIssues(context, qset, { projected });
  const packet = packetProjection(context, qset);
  context = packet.context; qset = packet.set;
  if (issues.length) return {
    evaluator: { version: VERSION, qualification: "unqualified", judge: null, judge_profile: profile },
    input: packet.hashes, counts: { unsure: qset.items.length }, judge_agreement: null, set: [],
    input_issues: issues, status: "unverified", transport: { status: "rejected" },
    items: qset.items.map((it, i) => ({ id: it?.id ?? `invalid-item-${i + 1}`, input_position: i + 1, kind: it?.kind ?? null, order: it?.order ?? null, pointer: it?.pointer ?? null, status: "unsure", checks: [{ id: "input_contract", method: "code", required: true, verdict: "unavailable", evidence: { issues } }], judge: null }))
  };
  const lesson = context.native, lq = context.lesson.learning_question;
  const keywords = Object.fromEntries((context.lesson.keywords || []).map((k) => typeof k === "string" ? [k, null] : [k?.word, k?.meaning ?? null]).filter(([word]) => typeof word === "string"));
  const play = norm(playLines(lesson).join(" "));
  const playPairs = new Set(play.split(" ").slice(1).map((w, i, a) => `${play.split(" ")[i]} ${w}`));
  const results = [];
  const run = async (it) => {
    const unsupported = [...layoutIssues(context, it), ...viewIssues(it)];
    if (unsupported.length) { results.push({ item: it, checks: [{ id: "format_coverage", method: "code", required: true, verdict: "unavailable", evidence: { issues: unsupported } }], seen_pages: [], seen_dropped: 0, judge: null }); return; }
    const parts = seenBefore(lesson, it, qset.items);
    const seen = trimSeen(parts);
    const checks = codeChecks(it, { play, playPairs, seen: seen.text });
    // The native reference permits conditional hints, retries and optional pages. This reconstruction is not an
    // authenticated learner exposure packet. Triage is useful, but it cannot establish context-complete quality.
    checks.push({ id: "learner_exposure_complete", method: "context", required: true, verdict: "unavailable", evidence: { note: "native lesson reconstruction; exact served view, conditional feedback and runtime marking are not verified", dropped_pages: seen.dropped } });
    const qs = judgeQuestions(it);
    const { selected, excluded } = selectJudgeQuestions(profile, it.kind, qs);
    const excludedIds = new Set(excluded.map((x) => x.criterion_id));
    const packets = new Map(qs.map((x) => [x.q.id, criterionPacket(it, seen.text, lq, keywords, x.q)]));
    const qualifications = new Map(selected.map((x) => [x.q.id, mode === "qualified" ? qualify(registry, { ...decisionBuild, now: new Date().toISOString(), context_sha256: packet.hashes.context_projection_sha256, judge_packet_sha256: sha(JSON.stringify(packets.get(x.q.id))) }, { kind: it.kind, criterion_id: x.q.id }, trust) : { eligible: false, reasons: ["explicit_development_mode"] }]));
    const eligible = selected.filter((x) => mode === "development" || qualifications.get(x.q.id).eligible);
    const eligibleIds = new Set(eligible.map((x) => x.q.id));
    const activeProvider = eligible.length ? await getProvider() : null;
    if (activeProvider && mode === "qualified" && (activeProvider.name !== "jev" || activeProvider.model !== requestedModel)) throw new Error("qualified Jev route requires the declared Jev provider and fixed model");
    let meta = null;
    for (const x of qs) if (!eligibleIds.has(x.q.id) || !activeProvider) checks.push({ id: x.q.id, method: "judge", required: x.required, expect: x.expect ? "yes" : "no", criterion_packet_sha256: sha(JSON.stringify(packets.get(x.q.id))), request_packet_sha256: null, verdict: "unavailable", scope: excludedIds.has(x.q.id) ? "outside_profile" : "selected", requested: false, accuracy_qualification: publicQualification(qualifications.get(x.q.id) || { eligible: false, reasons: ["criterion_outside_profile"] }), evidence: { note: excludedIds.has(x.q.id) ? "criterion is outside the selected profile" : !eligibleIds.has(x.q.id) ? "99 percent qualification gate has not cleared for this scope" : "no judge was called" } });
    if (activeProvider && eligible.length) {
      const calls = mode === "qualified" ? await Promise.all(eligible.map((x) => {
        const input = packets.get(x.q.id);
        return decide(input.state, input.questions, { provider: activeProvider, samples, tag: `${it.id}/${x.q.id}`, log });
      })) : [await decide(judgeState(it, seen.text, lq, keywords, profile), eligible.map((x) => x.q), { provider: activeProvider, samples, tag: it.id, log })];
      const observations = calls.flatMap((r) => r.meta.serving_observations);
      const r = { answers: Object.assign({}, ...calls.map((r) => r.answers)), meta: { model: calls[0].meta.model, serving_observations: observations, ms: Math.max(...calls.map((r) => r.meta.ms)), retried: calls.reduce((n, r) => n + r.meta.retried, 0) } };
      const serving = servingIssues(r.meta, activeProvider, profile);
      meta = { model: r.meta.model, serving_observations: r.meta.serving_observations, serving_issues: serving, served_revision: null, revision_verified: false, ms: r.meta.ms, retried: r.meta.retried };
      for (const x of eligible) {
        const a = r.answers[x.q.id];
        const gate = [...(a?.gate_reasons || []), ...serving];
        const accuracy = qualifications.get(x.q.id);
        const criterionCall = mode === "qualified" ? calls.find((call) => Object.hasOwn(call.answers, x.q.id)) : null;
        if (criterionCall && (criterionCall.meta.retried > 0 || criterionCall.meta.serving_observations.some((observation) => observation.unavailable))) gate.push("request_recovery_in_qualified_route");
        if (mode === "qualified" && r.meta.serving_observations.some((o) => !o.unavailable && (o.model !== accuracy.model || o.reported_served_revision !== accuracy.served_revision))) gate.push("serving_identity_does_not_match_certificate");
        if (mode === "qualified" && Date.parse(accuracy.expires_at) <= Date.now()) gate.push("qualification_expired_during_request");
        const observed = judgeVerdict(a, x.expect, x.required);
        if (mode === "qualified" && (observed === "flag" ? "fail" : observed) !== accuracy.verified_expected_verdict) gate.push("verdict_disagrees_with_verified_label");
        if (a?.valid !== samples) gate.push("incomplete_sample_set");
        const actualPacket = mode === "qualified" ? packets.get(x.q.id) : { state: judgeState(it, seen.text, lq, keywords, profile), questions: eligible.map((entry) => entry.q) };
        checks.push({ id: x.q.id, method: "judge", required: x.required, expect: x.expect ? "yes" : "no", criterion_packet_sha256: sha(JSON.stringify(packets.get(x.q.id))), request_packet_sha256: sha(JSON.stringify(actualPacket)), scope: "selected", requested: true, accuracy_qualification: publicQualification(accuracy), verdict: serving.length || gate.some((reason) => ["serving_identity_does_not_match_certificate", "qualification_expired_during_request", "verdict_disagrees_with_verified_label", "request_recovery_in_qualified_route"].includes(reason)) || a?.valid !== samples ? "unavailable" : observed,
          p_yes: a?.unavailable ? null : Number(a.value.toFixed(3)), agreement: a?.agreement ?? null, valid: a?.valid ?? 0, gate });
      }
    }
    // Keep the criterion order identical in offline, partial and experimental reports.
    const order = new Map(qs.map((q, i) => [q.q.id, i]));
    checks.sort((a, b) => (order.has(a.id) ? order.get(a.id) : -1) - (order.has(b.id) ? order.get(b.id) : -1));
    results.push({ item: it, checks, seen_pages: parts.map((p) => p.page), seen_dropped: seen.dropped, judge: meta });
  };
  const queue = [...qset.items];
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, async () => { while (queue.length) await run(queue.shift()); }));
  results.sort((a, b) => a.item.order - b.item.order);
  const items = results.map((r) => ({ id: r.item.id, kind: r.item.kind, native_operation: r.item.public_native_format ?? r.item.native_format ?? r.item.view?.native_format ?? r.item.adapter_extension?.operation ?? null, native_operation_status: "declared-unverified", order: r.item.order, pointer: r.item.pointer, status: status(r.checks), checks: r.checks,
    seen_pages: r.seen_pages, seen_dropped: r.seen_dropped, judge: r.judge }));
  const counts = items.reduce((m, x) => ({ ...m, [x.status]: (m[x.status] || 0) + 1 }), {});
  const stab = items.flatMap((x) => x.checks.filter((c) => c.method === "judge" && c.agreement != null).map((c) => c.agreement));
  const semantics = items.flatMap((x) => x.checks.filter((c) => c.method === "judge"));
  const coverage = {
    total_criteria: semantics.length, selected_by_profile: semantics.filter((c) => c.scope === "selected").length,
    qualified_eligible_criteria: semantics.filter((c) => c.accuracy_qualification?.eligible).length,
    outside_profile: semantics.filter((c) => c.scope === "outside_profile").length,
    requested_criteria: semantics.filter((c) => c.requested).length,
    returned_usable_criteria: semantics.filter((c) => c.requested && c.verdict !== "unavailable").length,
    unavailable_criteria: semantics.filter((c) => c.verdict === "unavailable").length,
    unsupported_items: items.filter((it) => it.checks.some((c) => c.id === "format_coverage")).length,
    meaning: "criterion coverage in development triage; not academic qualification or whole-item approval"
  };
  return {
    evaluator: { version: VERSION, knowledge_baseline: KNOWLEDGE_BASELINE, qualification: "unqualified", mode, qualification_policy: QUALIFICATION_POLICY, qualification_registry_sha256: registry.sha256, trusted_reviewers_sha256: trust.sha256, independent_gold_labels: 0, judge_profile: profile, judge: provider ? { name: provider.name, model: provider.model, samples, gates: GATES, served_revision: null, revision_verified: false } : null, engine_source_commit: ENGINE_SNAPSHOT.git_commit },
    judge_coverage: coverage,
    input: packet.hashes, status: "unverified",
    counts, judge_agreement: stab.length ? { judgements: stab.length, unanimous: stab.filter((a) => a === 1).length, mean: Number((stab.reduce((s, a) => s + a, 0) / stab.length).toFixed(3)) } : null,
    transport: { status: "accepted", native_copies_match_pointer_targets: true },
    set: results.some((r) => r.checks.some((c) => c.id === "format_coverage")) ? [{ id: "set_scope_coverage", method: "context", required: false, verdict: "unavailable", evidence: { note: "one or more native operations lack a verified evaluator interpreter" } }] : [...setChecks(results), ...lessonChecks(context.lesson, results)], items,
  };
}

/** A short report a person can read: the counts, then every item that fails or is unsure, then the flags. */
export function markdown(rep) {
  const L = [`# Question set review`, "", "Development triage only. No independently qualified good-question verdict is available.", "",
    `${rep.evaluator.version}; judge ${rep.evaluator.judge ? `${rep.evaluator.judge.name} ${rep.evaluator.judge.model}, ${rep.evaluator.judge.samples} samples each` : "none (code checks only)"}.`, ""];
  L.push(`Items: ${Object.entries(rep.counts).map(([k, v]) => `${v} ${k}`).join(", ")}.`);
  if (rep.judge_coverage) L.push(`Judge profile: ${rep.evaluator.judge_profile.id}. ${rep.judge_coverage.requested_criteria} of ${rep.judge_coverage.total_criteria} criteria requested; ${rep.judge_coverage.outside_profile} outside scope; ${rep.judge_coverage.unavailable_criteria} unavailable. Coverage is not quality qualification.`);
  if (rep.evaluator.mode) L.push(`Mode: ${rep.evaluator.mode}; ${rep.judge_coverage?.qualified_eligible_criteria || 0} criteria cleared the scoped 99 percent evidence gate.`);
  if (rep.judge_agreement) L.push(`Within-call sample agreement: ${rep.judge_agreement.unanimous} of ${rep.judge_agreement.judgements} judgements were unanimous. This is not independent repeatability or accuracy.`);
  if (rep.input_issues?.length) L.push(`Input unavailable: ${rep.input_issues.join("; ")}.`);
  L.push("", "| item | kind | status | failing or unsure checks | flags |", "|---|---|---|---|---|");
  for (const it of rep.items) {
    const bad = it.checks.filter((c) => c.required && c.verdict !== "pass" && c.verdict !== "not_applicable").map((c) => `${c.id} (${c.verdict})`);
    const flags = it.checks.filter((c) => c.verdict === "flag").map((c) => c.id);
    L.push(`| ${it.id} | ${it.kind} | ${it.status} | ${bad.join(", ")} | ${flags.join(", ")} |`);
  }
  L.push("", "Across the set:", "");
  for (const c of rep.set) L.push(`- ${c.id}: ${c.verdict}${c.verdict !== "pass" ? ` (${JSON.stringify(c.evidence)})` : ""}`);
  return L.join("\n") + "\n";
}
