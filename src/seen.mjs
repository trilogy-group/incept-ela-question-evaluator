// What a student reads or hears, and what they have met before each item. The key set is the contract's: a string under
// one of these keys is shown to the student (scripts/extract_authored.py in the contract repository).
export const STUDENT = new Set(["q", "stem", "options", "text", "why", "yes", "after", "feedback", "line", "lines", "task", "question",
  "nudge", "second_nudge", "third_nudge", "reveal", "reply", "meaning", "goal", "mission", "answer", "close", "candidates", "decoys",
  "strong", "quotes", "stems", "checklist", "help", "narration", "title", "label", "words", "w", "lead", "hint", "ask", "repeat", "note",
  "say", "think", "sentence", "parts", "t", "explain_ask", "explain_hint", "explain_reveal", "rebut_ask", "rebut_hint", "rebut_reveal",
  "verdict_task", "starter", "starters", "chips", "tasks", "kicker", "cta", "rules", "scene", "who", "means", "context", "context_lines",
  "term", "how", "check", "visual"]);

/** Every student-facing string under a node, in document order. Play lines keep their speaker. */
export function studentText(node, key = null) {
  const out = [];
  const walk = (x, k) => {
    if (x == null) return;
    if (typeof x === "string") { if (k && STUDENT.has(k)) out.push(x); return; }
    if (Array.isArray(x)) { for (const v of x) walk(v, k); return; }
    if (typeof x === "object") {
      if (typeof x.line === "string" && "who" in x) { out.push(x.who ? `${x.who}: ${x.line}` : x.line); return; }
      if (typeof x.stage === "string") { out.push(x.stage); return; }
      for (const [kk, v] of Object.entries(x)) {
        if (["rubric", "rubrics", "criteria", "misreadings", "keywords", "accept", "evidence", "requirement", "looks_like", "captions", "cues"].includes(kk)) continue;
        walk(v, kk);
      }
    }
  };
  walk(node, key);
  return out;
}

/** The play's own lines the lesson shows anywhere: what a quotation must match. */
export function playLines(lesson) {
  const lines = [];
  const walk = (x) => {
    if (!x || typeof x !== "object") return;
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (x.kind === "script" && Array.isArray(x.lines)) for (const l of x.lines) if (typeof l.line === "string") lines.push(l.line);
    if (Array.isArray(x.scene)) for (const l of x.scene) if (l && typeof l.line === "string") lines.push(l.line);
    for (const v of Object.values(x)) walk(v);
  };
  walk(lesson.pages);
  return lines;
}

const pageIndex = (pointer) => Number(pointer.split("/")[2]);

/** What the student has met before an item: earlier pages, then what comes before it on its own page. */
export function seenBefore(lesson, item, setItems = []) {
  if (!Array.isArray(lesson?.pages) || !/^\/pages\/\d+\/nodes\/\d+(?:\/|$)/.test(item.pointer || "")) return [];
  const pi = pageIndex(item.pointer);
  if (!lesson.pages[pi]?.nodes?.[Number(item.pointer.split("/")[4])]) return [];
  const parts = [];
  // A question set replaces the lesson's authored tasks. Never treat omitted or later authored feedback as seen.
  // Feedback, model reveals and hints require a learner route; they are omitted from this conservative preview.
  const skip = new Set(["mcqs", "mcq", "rubric", "rubrics", "rebuild", "options", "feedback", "why", "yes", "correct_feedback", "option_feedback", "reveal", "nudge", "second_nudge", "third_nudge"]);
  const instruction = (x) => Array.isArray(x) ? x.map(instruction) : x && typeof x === "object"
    ? Object.fromEntries(Object.entries(x).filter(([k]) => !skip.has(k)).map(([k, v]) => [k, instruction(v)])) : x;
  const priorQuestions = (page) => setItems.filter((q) => q.page === page && q.order < item.order).sort((a, b) => a.order - b.order)
    .flatMap((q) => [q.view?.stem, q.view?.prompt, ...(q.view?.options || [])]).filter((x) => typeof x === "string");
  for (let i = 0; i < pi; i++) {
    const p = lesson.pages[i];
    if (p.extra && lesson.extras?.[p.extra] !== true) continue;
    const t = (p.nodes || []).flatMap((n) => studentText(instruction(n))).concat(priorQuestions(p.id));
    if (t.length) parts.push({ page: p.id, text: t.join("\n") });
  }
  const node = lesson.pages[pi].nodes[Number(item.pointer.split("/")[4])];
  const here = [];
  if (node.type === "unit_film") {
    const seg = Number(item.pointer.split("/")[6]);
    node.segments.forEach((s, si) => {
      if (si > seg) return;
      here.push(...[s.narration, s.visual ? `On screen: ${s.visual}` : null].filter(Boolean));
    });
    here.push(...priorQuestions(lesson.pages[pi].id));
  } else if (node.type === "reading") {
    for (const b of node.blocks) here.push(...studentText(b));
    here.push(...priorQuestions(lesson.pages[pi].id));
  } else if (node.type === "model" && item.kind === "rebuild_choice") {
    here.push(...studentText({ together: node.together, steps: node.steps, screens: node.screens, search: node.search, line: node.line, quote: node.quote }));
  } else if (node.type === "key_term") {
    // the term and its meaning are on screen before the task
    here.push([node.label, node.term, node.cls ? `(${node.cls})` : null].filter(Boolean).join(": "), node.meaning);
  } else {
    for (const k of ["goal", "mission", "line", "task", "question", "how", "help"]) if (typeof node[k] === "string") here.push(node[k]);
    if (Array.isArray(node.scene)) here.push(...studentText({ scene: node.scene }));
  }
  if (here.length) parts.push({ page: lesson.pages[pi].id, text: here.filter(Boolean).join("\n") });
  return parts;
}

export const asText = (parts) => parts.map((p) => `[${p.page}]\n${p.text}`).join("\n\n");
