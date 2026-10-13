// The checks. Code decides everything code can (keys, shapes, exact quotations, what the marker's keyword pass would
// do); the judge gets one bounded yes-or-no question per remaining criterion, about exactly what the student sees.
// Every check is required (it can fail an item) or advisory (it flags, never fails).
import { noul } from "./engine.mjs";
import { studentText } from "./seen.mjs";

const CHOICE = new Set(["film_mcq", "reading_mcq", "key_term_mcq", "rebuild_choice"]);
export const isChoice = (it) => CHOICE.has(it.kind);
export const norm = (s) => String(s ?? "").toLowerCase().replace(/[‘’ʼ`]/g, "'").replace(/[“”]/g, '"').replace(/[—–-]/g, " ")
  .replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
const STOP = new Set("the a an of to and or in on for by with is are was were be it its that this as at from not no his her him he she they them their who what which".split(" "));
const content = (s) => norm(s).split(" ").filter((w) => w.length > 2 && !STOP.has(w));
const letter = (i) => String.fromCharCode(65 + i);
/** Feedback that sends the student back rather than stating something: an instruction to look, or a question. */
export const isPointer = (f) => /^\s*(look|find|read|check|go back|think about|see|reread)\b/i.test(f) || /\?\s*$/.test(f);

/** Quoted stretches of three or more words in a string: what must be the play's own words. */
export function quotations(s) {
  const out = [];
  for (const m of String(s ?? "").matchAll(/[“"]([^”"]{3,}?)[”"]/g)) if (norm(m[1]).split(" ").length >= 3) out.push(m[1]);
  return out;
}

/** Does an answer pass the rubric's keyword groups (every group needs one alternative; a trailing * is a prefix)? */
export function matchesKeywords(answer, groups) {
  const words = norm(answer).split(" ");
  const hit = (alt) => { const a = norm(alt.replace(/\*$/, "")); return alt.endsWith("*") ? words.some((w) => w.startsWith(a)) : (` ${words.join(" ")} `).includes(` ${a} `); };
  return (groups || []).every((g) => (Array.isArray(g) ? g : [g]).some(hit));
}

const rec = (id, verdict, required, evidence) => ({ id, method: "code", required, verdict, evidence });

const bigrams = (ws) => ws.slice(1).map((w, i) => `${ws[i]} ${w}`);
/** Is a quoted stretch an attempt at the play's words? Half or more of its word pairs occur in the play. Frames
 *  ("…when he says ___"), terms and sample answers in quotation marks are not. */
export function looksLikePlay(q, playPairs) {
  const ws = norm(q).split(" ").filter(Boolean);
  if (ws.length < 4 || /_{2,}/.test(q)) return false;
  const bs = bigrams(ws);
  return bs.filter((b) => playPairs.has(b)).length / bs.length >= 0.5;
}

/** Code checks for one item. `play` is the normalised text of every play line the lesson shows; `seen` the student's text so far. */
export function codeChecks(it, { play, playPairs, seen }) {
  const v = it.view, out = [];
  const quoteCheck = (fields) => {
    const qs = fields.flatMap(quotations).filter((q) => looksLikePlay(q, playPairs));
    const missing = qs.filter((q) => !play.includes(norm(q)));
    out.push(rec("quotes_exact", qs.length ? (missing.length ? "fail" : "pass") : "not_applicable", true, missing.length ? { misquoted: missing } : { quotations: qs.length }));
  };
  if (isChoice(it)) {
    const k = v.key;
    out.push(rec("one_key", Array.isArray(k) && k.length === 1 && Number.isInteger(k[0]) && k[0] >= 0 && k[0] < v.options.length ? "pass" : "fail", true, { key: k, options: v.options.length }));
    const ns = v.options.map(norm);
    out.push(rec("options_distinct", new Set(ns).size === ns.length ? "pass" : "fail", true, {}));
    const key = k[0], keyText = v.options[key];
    if (v.option_feedback) {
      const missing = v.options.map((_, i) => i).filter((i) => i !== key && !String(v.option_feedback[i] ?? "").trim());
      out.push(rec("feedback_each_wrong_option", missing.length ? "fail" : "pass", true, missing.length ? { without_feedback: missing.map(letter) } : {}));
      const kw = content(keyText);
      const naming = v.options.map((_, i) => i).filter((i) => i !== key && kw.length >= 2 && kw.every((w) => content(v.option_feedback[i] ?? "").includes(w)));
      out.push(rec("wrong_feedback_names_key", naming.length ? "flag" : "pass", false, naming.length ? { options: naming.map(letter), key: keyText } : {}));
      const lines = [...v.option_feedback, v.correct_feedback].filter(Boolean);
      const unquoted = (l) => String(l).replace(/[“"][^”"]*[”"]/g, "");   // the play's own words may shout
      const loud = lines.filter((l) => /!/.test(unquoted(l)) || /^\s*(great|well done|excellent|awesome|amazing|perfect|brilliant|good job|nice)\b/i.test(l));
      out.push(rec("plain_voice", loud.length ? "flag" : "pass", false, loud.length ? { lines: loud } : {}));
    } else out.push(rec("feedback_each_wrong_option", it.kind === "rebuild_choice" ? "not_applicable" : "fail", true, { note: "per-option feedback is absent; only rebuild choices have no such contract" }));
    const len = v.options.map((o) => String(o).length);
    const longest = v.options.length > 2 && len[key] > Math.max(...len.filter((_, i) => i !== key));
    out.push(rec("key_is_longest", longest ? "flag" : "pass", false, { lengths: len }));
    out.push(rec("word_counts", "pass", false, { stem: norm(v.stem).split(" ").length, options: v.options.map((o) => norm(o).split(" ").length) }));
    quoteCheck([v.stem, ...v.options, ...(v.option_feedback || []), v.correct_feedback].filter(Boolean));
  }
  if (it.kind === "open_check") {
    const r = v.rubric || {}, crit = r.criteria || [];
    const gaps = crit.filter((c) => !String(c.requirement ?? "").trim()).map((c) => c.id);
    out.push(rec("rubric_complete", crit.length && !gaps.length ? "pass" : "fail", true, gaps.length ? { without_requirement: gaps } : { criteria: crit.length }));
    out.push(rec("reveal_present", String(r.reveal ?? "").trim() ? "pass" : "flag", false, {}));
    const noAccept = crit.filter((c) => !(c.accept || []).length).map((c) => c.id);
    out.push(rec("accept_examples", noAccept.length ? "flag" : "pass", false, noAccept.length ? { without_examples: noAccept } : {}));
    const missed = [];
    for (const c of crit) for (const a of c.accept || []) if ((c.keywords || []).length && !matchesKeywords(a, c.keywords)) missed.push({ criterion: c.id, answer: a });
    out.push(rec("accepted_answers_pass_keywords", missed.length ? "flag" : "pass", false, missed.length ? { missed } : {}));
    const giving = [];
    for (const c of crit) if (c.nudge && (c.keywords || []).length && matchesKeywords(c.nudge, c.keywords)) giving.push(c.id);
    out.push(rec("first_nudge_passes_keyword_filter", giving.length ? "flag" : "pass", false, giving.length ? { criteria: giving } : {}));
    quoteCheck([v.prompt, r.question, r.reveal, ...crit.flatMap((c) => [c.nudge, c.second_nudge, c.third_nudge, ...(c.evidence || []), ...(c.accept || [])])].filter(Boolean));
  }
  if (it.kind === "evidence_select") {
    const cand = v.candidates || [], dec = v.decoys || [], strong = v.strong || [];
    out.push(rec("evidence_options_present", cand.length && dec.length ? "pass" : "fail", true, { candidates: cand.length, decoys: dec.length }));
    const both = cand.filter((c) => dec.map(norm).includes(norm(c)));
    out.push(rec("candidates_and_decoys_apart", both.length ? "fail" : "pass", true, both.length ? { both } : {}));
    const notPlay = [...cand, ...dec, ...strong].filter((l) => !play.includes(norm(l)));
    out.push(rec("lines_are_the_play", notPlay.length ? "fail" : "pass", true, notPlay.length ? { not_found: notPlay } : { lines: cand.length + dec.length + strong.length }));
    const weak = cand.filter((c) => !strong.map(norm).includes(norm(c)));
    out.push(rec("candidates_are_strong", weak.length ? "flag" : "pass", false, weak.length ? { not_strong: weak } : {}));
  }
  if (it.kind === "classify") {
    const boxes = v.boxes || {}, wrong = [], counts = {};
    out.push(rec("classification_items_present", (v.items || []).length && Object.keys(boxes).length ? "pass" : "fail", true, { items: (v.items || []).length, boxes: Object.keys(boxes).length }));
    for (const w of v.items || []) {
      const b = boxes[w.to];
      if (!b || !(w.kind in b)) wrong.push(w.word);
      counts[`${w.to}.${w.kind}`] = (counts[`${w.to}.${w.kind}`] || 0) + 1;
    }
    out.push(rec("every_word_has_a_box", wrong.length ? "fail" : "pass", true, wrong.length ? { words: wrong } : {}));
    const off = [];
    for (const [who, b] of Object.entries(boxes)) for (const kind of ["is", "seems", "wanted"]) if (kind in b) {
      const slots = kind === "is" ? b.slots : b[`${kind}_slots`];
      if (slots !== (counts[`${who}.${kind}`] || 0)) off.push({ box: `${who}.${kind}`, slots, words: counts[`${who}.${kind}`] || 0 });
    }
    out.push(rec("slots_match_words", off.length ? "fail" : "pass", true, off.length ? { off } : {}));
  }
  if (it.kind === "open_prompt") {
    out.push(rec("reveal_present", String(v.reveal ?? "").trim() ? "pass" : "fail", true, {}));
    quoteCheck([v.prompt, v.hint, v.reveal].filter(Boolean));
  }
  return out;
}

/** The judge's questions for one item: bounded, one claim each, about the item's state. Each carries its expected answer. */
export function judgeQuestions(it) {
  const v = it.view, qs = [];
  const add = (id, instructions, expect, required) => qs.push({ q: noul(id, instructions), expect, required });
  const only = "Decide only from the words in seen_before, the lesson the student has been given, not from anything else you know about the play.";
  if (isChoice(it)) {
    const key = v.key[0];
    add("key_correct", `item.options.${letter(key)} is the keyed answer. Is it a correct answer to item.question? ${only}`, true, true);
    v.options.forEach((_, i) => { if (i !== key) add(`option_${letter(i)}_correct`, `Is item.options.${letter(i)} a correct answer to item.question? ${only}`, false, true); });
    add("answer_in_seen", `Does seen_before contain what a student needs to answer item.question correctly?`, true, true);
    // feedback that states something must be true; feedback that points ("Look at…", a question) must point at something there
    (v.option_feedback || []).forEach((f, i) => {
      if (!f) return;
      if (isPointer(f)) add(`feedback_${letter(i)}_points_to_the_text`, `item.feedback.${letter(i)} is shown to a student who chose item.options.${letter(i)}; it sends them back to the text. Is what it sends them to really in seen_before?`, true, true);
      else add(`feedback_${letter(i)}_true`, `item.feedback.${letter(i)} is shown to a student who chose item.options.${letter(i)}. Is everything it says true? ${only}`, true, true);
    });
    if (v.correct_feedback) add("correct_feedback_true", `Is everything item.correct_feedback says true? ${only}`, true, true);
    (v.option_feedback || []).forEach((f, i) => { if (f && i !== key) add(`feedback_${letter(i)}_gives_answer`, `Does item.feedback.${letter(i)} tell the student the correct answer itself, rather than where to look or why their choice is wrong?`, false, false); });
    // A model can't simulate not knowing, so it is not asked how tempting an option is, and on a well-known text it
    // can't tell what a student could rule out without it (it knows the play). It is asked what it can check: whether
    // a wrong option comes from the text's own world, so that only the text can rule it out.
    v.options.forEach((_, i) => { if (i !== key) add(`option_${letter(i)}_from_the_text`, `Does seen_before mention the person, place, event or idea that item.options.${letter(i)} is about?`, true, false); });
    add("serves_the_lesson", `Does item.question check something a student needs in order to answer learning_question, or to understand the text it is about?`, true, false);
  }
  if (it.kind === "open_check") {
    const r = v.rubric || {}, crit = r.criteria || [];
    if (String(r.reveal ?? "").trim()) crit.forEach((c, i) => add(`reveal_meets_${i + 1}`, `Does item.reveal meet item.criteria.${i + 1}?`, true, true));
    crit.forEach((c, i) => (c.accept || []).slice(0, 2).forEach((a, j) => add(`accepted_${i + 1}_${j + 1}_meets`, `Does item.accepted.${i + 1}_${j + 1} meet item.criteria.${i + 1}?`, true, true)));
    (r.misreadings || []).forEach((m, i) => add(`misreading_${i + 1}_passes`, `Would an answer of the kind item.misreadings.${i + 1} describes meet every requirement in item.criteria?`, false, true));
    add("answerable", `Could the intended student write an answer to item.prompt that meets item.criteria, using only seen_before?`, true, true);
    add("prompt_clear", `Does item.prompt make clear what the student has to write?`, true, false);
    crit.forEach((c, i) => [c.nudge, c.second_nudge].forEach((n, j) => { if (n) add(`nudge_${i + 1}_${j + 1}_gives_answer`, `item.nudges.${i + 1}_${j + 1} is a hint to a student whose answer missed item.criteria.${i + 1}. Does it give the answer itself, rather than where to look?`, false, false); }));
  }
  if (it.kind === "evidence_select") {
    (v.candidates || []).forEach((_, i) => add(`candidate_${i + 1}_supports`, `Does item.candidates.${i + 1}, in the scene in seen_before, support item.claim?`, true, true));
    (v.decoys || []).forEach((_, i) => add(`decoy_${i + 1}_supports`, `Does item.decoys.${i + 1}, in the scene in seen_before, support item.claim?`, false, true));
  }
  if (it.kind === "classify") {
    (v.items || []).forEach((w, i) => {
      const target = v.boxes[w.to]?.[w.kind];
      add(`word_${i + 1}_fits`, `Using only the wording a learner sees and seen_before, is item.words.${i + 1} defensibly placed under ${JSON.stringify(target)}? Do not use a teacher-only word meaning or a later correction.`, true, true);
      for (const [who, box] of Object.entries(v.boxes || {})) for (const kind of ["is", "seems", "wanted"]) {
        if (!(kind in box) || (who === w.to && kind === w.kind)) continue;
        add(`word_${i + 1}_${who}_${kind}_also_fits`, `Using only the wording a learner sees and seen_before, is item.words.${i + 1} also defensibly placed under ${JSON.stringify(box[kind])}? Do not narrow the question with a teacher-only meaning or later feedback.`, false, true);
      }
    });
  }
  if (it.kind === "open_prompt") {
    add("reveal_true", `Is everything item.reveal says true? ${only}`, true, true);
    add("answerable", `Could the intended student answer item.prompt well using only seen_before?`, true, true);
  }
  if (it.kind === "say_back" || it.kind === "word_web") add("answerable", `Could the intended student do what item.prompt asks using only seen_before?`, true, true);
  return qs;
}

/** The item as the judge sees it: the student's view, with options and feedback by letter. */
export function judgeItem(it) {
  const v = it.view, L = (arr) => Object.fromEntries((arr || []).map((x, i) => [letter(i), x]));
  if (isChoice(it)) return { question: v.stem, options: L(v.options), feedback: L(v.option_feedback), correct_feedback: v.correct_feedback ?? null };
  if (it.kind === "open_check") {
    const r = v.rubric || {}, crit = r.criteria || [];
    const accepted = {}, nudges = {};
    crit.forEach((c, i) => { (c.accept || []).slice(0, 2).forEach((a, j) => { accepted[`${i + 1}_${j + 1}`] = a; }); [c.nudge, c.second_nudge].forEach((n, j) => { if (n) nudges[`${i + 1}_${j + 1}`] = n; }); });
    return { prompt: v.prompt || r.question, criteria: Object.fromEntries(crit.map((c, i) => [i + 1, c.requirement])), reveal: r.reveal || null, accepted, nudges,
      misreadings: Object.fromEntries((r.misreadings || []).map((m, i) => [i + 1, m.looks_like])) };
  }
  if (it.kind === "evidence_select") return { claim: v.prompt, candidates: Object.fromEntries((v.candidates || []).map((c, i) => [i + 1, c])), decoys: Object.fromEntries((v.decoys || []).map((c, i) => [i + 1, c])) };
  if (it.kind === "classify") return { prompt: v.prompt, words: Object.fromEntries((v.items || []).map((w, i) => [i + 1, w.word])), destinations: Object.values(v.boxes || {}).flatMap((b) => [b.is, b.seems, b.wanted]).filter(Boolean) };
  if (it.kind === "open_prompt") return { prompt: v.prompt, hint: v.hint, reveal: v.reveal };
  return { prompt: Array.isArray(v.prompt) ? v.prompt.filter(Boolean).join(" ") : v.prompt };
}
