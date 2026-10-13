// Deterministic scripted judge for tests and dry runs. `rules(question, state)` returns a raw answer.
// It proves plumbing (wire, validation, gates, director), never judgment quality.
export function createFakeProvider(rules, { name = "fake", model = "fake-0" } = {}) {
  const calls = [];
  return {
    name, model, calls,
    async ask(state, questions, opts = {}) {
      calls.push({ state, questions, opts });
      const answers = {};
      for (const q of questions) answers[q.id] = rules(q, state, opts);
      return { answers, model, usage: null };
    },
  };
}

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
const words = (s) => norm(s).split(" ").filter((w) => w.length > 2);
const overlap = (a, b) => { const B = new Set(words(b)); const A = words(a); return A.length ? A.filter((w) => B.has(w)).length / A.length : 0; };

/** Heuristic rules that stand in for a judge in offline tests. */
export function heuristicRules(q, state) {
  const yes = (p) => ({ noul: p });
  const pick = (key, conf = 0.9) => { const ks = Object.keys(q.criteria); const probs = Object.fromEntries(ks.map((k) => [k, k === key ? conf : (1 - conf) / (ks.length - 1)])); return { choice: key, probabilities: probs, confidence: conf }; };
  switch (q.id.replace(/_\d+$/, "")) {
    case "stem_is_question": { const s = String(state.stem ?? ""); const frag = /(\.\.\.|…|_{2,}|\b(a|an|the|is|are|was|were|to|of)\s*[.…]*\s*$)/i.test(s.trim()); return yes(frag ? 0.1 : /\?\s*$/.test(s) || /^(tap|choose|pick|tell|type|find|which|what|why|how|who|where|when)\b/i.test(s.trim()) ? 0.95 : 0.4); }
    case "yes_no_stem": return yes(/^(is|are|was|were|do|does|did|can|could|will|would|should|has|have)\b/i.test(String(state.stem ?? "").trim()) ? 0.9 : 0.05);
    case "evidence_supports": return yes(state.authored_hint === true ? 0.92 : state.authored_hint === false ? 0.08 : overlap(state.question, state.sentence) > 0.3 ? 0.7 : 0.3);
    case "criterion_met": return yes(overlap(state.criterion, state.student_text) > 0.15 || (state.grounding ?? []).some((g) => overlap(g, state.student_text) > 0.4) ? 0.9 : 0.1);
    case "full_sentence": return yes(words(state.student_text).length >= 4 ? 0.9 : 0.1);
    case "addresses_grader": return yes(/\b(grader|ignore|answer yes|mark (this|me) correct)\b/i.test(String(state.student_text ?? "")) ? 0.95 : 0.02);
    case "student_stuck": return yes(state.idle_ticks >= 2 ? 0.9 : 0.1);
    case "voice_line": { const ks = Object.keys(q.criteria); return pick(ks[0], 0.8); }
    case "near_miss_present": return yes(0.8);
    case "answerable_blind": return yes(0.2);
    case "feedback_teaches": return yes(0.85);
    case "rubric_leaks": return yes((state.grounding ?? []).some((g) => (state.criteria ?? []).some((c) => overlap(g, c) > 0.6)) ? 0.9 : 0.1);
    case "silent_reason_real": return yes(/placeholder|tbd|todo|^\s*$/i.test(String(state.reason ?? "")) ? 0.05 : 0.9);
    case "taught_word_cashed": return yes((state.taught_words ?? []).some((w) => norm(state.page_text).includes(norm(w))) ? 0.85 : 0.1);
    case "check_kind": return pick(/why|think|feel|mean|because/i.test(String(state.stem ?? "")) ? "inference" : "literal_retrieval", 0.75);
    case "g3_level": return { score: 2, probabilities: { 1: 0.1, 2: 0.8, 3: 0.1 }, confidence: 0.8 };
    default: { if (q.type === "noul") return yes(0.5); if (q.type === "choice") return pick(Object.keys(q.criteria)[0], 0.5); return { score: 1, confidence: 0.5 }; }
  }
}

/** Oracle judge for loop tests: answers evidence questions from the level's own authored keys (by sentence text),
 *  so the loop's agreement metric is exercised end to end. Everything else falls back to the heuristics. */
export function oracleRules(level) {
  const support = new Map();
  for (const b of level.beats) for (const n of b.nodes) {
    if (n.bank_type === "hot_text") n.sentences.forEach((s, i) => support.set(s, n.correct_indices.includes(i)));
    if (n.type === "dialogue" && n.evidence) n.evidence.sentences.forEach((s, i) => support.set(s, n.evidence.correct_index === i));
  }
  return (q, state, opts) => {
    if (q.id === "evidence_supports" && support.has(state.sentence)) return { noul: support.get(state.sentence) ? 0.93 : 0.07 };
    if (q.id === "rubric_score") { const n = String(state.student_text ?? "").split(" ").length; const k = n >= 8 ? 3 : n >= 4 ? 2 : 1; return { score: k, probabilities: { 1: k === 1 ? 0.8 : 0.1, 2: k === 2 ? 0.8 : 0.1, 3: k === 3 ? 0.8 : 0.1 }, confidence: 0.85 }; }
    if (q.id.startsWith("criterion_met") && state.blanks) { const bid = (q.instructions.match(/blank "([^"]+)"/) || [])[1]; const t = state.student_text?.[bid] ?? ""; return { noul: String(t).split(" ").length >= 4 ? 0.9 : 0.1 }; }
    return heuristicRules(q, state, opts);
  };
}
