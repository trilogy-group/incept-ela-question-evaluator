// Evaluate a question set against its lesson context: code checks, then the judge's bounded questions (several samples
// each, so a verdict's stability is on record), then the set as a whole. Unsure is never a pass.
import { decide, GATES, ENGINE_SNAPSHOT } from "./engine.mjs";
import { seenBefore, asText, playLines, studentText } from "./seen.mjs";
import { codeChecks, judgeQuestions, judgeItem, isChoice, norm } from "./checks.mjs";
import { packetProjection, inputIssues, viewIssues, layoutIssues } from "./packet.mjs";

export const VERSION = "question-evaluator 0.2-development";
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

export async function evaluate(context, qset, { provider = null, samples = 3, concurrency = 4, log = null } = {}) {
  const issues = inputIssues(context, qset);
  const packet = packetProjection(context, qset);
  context = packet.context; qset = packet.set;
  if (issues.length) return {
    evaluator: { version: VERSION, qualification: "unqualified", judge: null },
    input: packet.hashes, counts: { unsure: qset.items.length }, judge_agreement: null, set: [],
    input_issues: issues, status: "unverified",
    items: qset.items.map((it) => ({ id: it.id, kind: it.kind, order: it.order, pointer: it.pointer, status: "unsure", checks: [{ id: "input_contract", method: "code", required: true, verdict: "unavailable", evidence: { issues } }], judge: null }))
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
    let meta = null;
    if (!provider) for (const q of qs) checks.push({ id: q.q.id, method: "judge", required: q.required, verdict: "unavailable", evidence: { note: "no judge was called" } });
    if (provider && qs.length) {
      const state = { learning_question: lq, keywords, seen_before: seen.text, item: judgeItem(it) };
      const r = await decide(state, qs.map((x) => x.q), { provider, samples, tag: it.id, log });
      meta = { model: r.meta.model, serving_observations: r.meta.serving_observations, served_revision: null, revision_verified: false, ms: r.meta.ms, retried: r.meta.retried };
      for (const x of qs) {
        const a = r.answers[x.q.id];
        checks.push({ id: x.q.id, method: "judge", required: x.required, expect: x.expect ? "yes" : "no", verdict: judgeVerdict(a, x.expect, x.required),
          p_yes: a?.unavailable ? null : Number(a.value.toFixed(3)), agreement: a?.agreement ?? null, valid: a?.valid ?? 0, gate: a?.gate_reasons ?? [] });
      }
    }
    results.push({ item: it, checks, seen_pages: parts.map((p) => p.page), seen_dropped: seen.dropped, judge: meta });
  };
  const queue = [...qset.items];
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, async () => { while (queue.length) await run(queue.shift()); }));
  results.sort((a, b) => a.item.order - b.item.order);
  const items = results.map((r) => ({ id: r.item.id, kind: r.item.kind, native_operation: r.item.public_native_format ?? r.item.native_format ?? r.item.view?.native_format ?? r.item.adapter_extension?.operation ?? null, native_operation_status: "declared-unverified", order: r.item.order, pointer: r.item.pointer, status: status(r.checks), checks: r.checks,
    seen_pages: r.seen_pages, seen_dropped: r.seen_dropped, judge: r.judge }));
  const counts = items.reduce((m, x) => ({ ...m, [x.status]: (m[x.status] || 0) + 1 }), {});
  const stab = items.flatMap((x) => x.checks.filter((c) => c.method === "judge" && c.agreement != null).map((c) => c.agreement));
  return {
    evaluator: { version: VERSION, qualification: "unqualified", independent_gold_labels: 0, judge: provider ? { name: provider.name, model: provider.model, samples, gates: GATES, served_revision: null, revision_verified: false } : null, engine_source_commit: ENGINE_SNAPSHOT.git_commit },
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
