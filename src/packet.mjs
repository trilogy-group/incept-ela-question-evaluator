// Public input projection. Producer identity and provenance stay outside evaluator state and reports.
import crypto from "node:crypto";

const DROP = new Set(["source", "made_by", "producer", "producer_id", "generator", "generator_id", "generated_by", "metadata", "provenance", "quality_status"]);
const clean = (x) => Array.isArray(x) ? x.map(clean) : x && typeof x === "object"
  ? Object.fromEntries(Object.entries(x).filter(([k]) => !DROP.has(k)).map(([k, v]) => [k, clean(v)])) : x;
const sha = (x) => crypto.createHash("sha256").update(JSON.stringify(x)).digest("hex");
const KINDS = new Set(["film_mcq", "reading_mcq", "key_term_mcq", "rebuild_choice", "open_check", "open_prompt", "word_web", "evidence_select", "say_back", "classify"]);
const choices = new Set(["film_mcq", "reading_mcq", "key_term_mcq", "rebuild_choice"]);

export function packetProjection(context, set) {
  const ctx = { contract: context?.contract, lesson: clean(context?.lesson), native: clean(context?.native) };
  const q = { contract: set?.contract, lesson: set?.lesson, items: (Array.isArray(set?.items) ? set.items : []).filter((it) => it && typeof it === "object").map((it) => {
    const item = { page: it.page, order: it.order, kind: it.kind, pointer: it.pointer, view: clean(it.view), native: clean(it.native),
      ...(it.adapter_extension === undefined ? {} : { adapter_extension: clean(it.adapter_extension) }),
      ...(it.native_format === undefined ? {} : { native_format: clean(it.native_format) }),
      ...(it.public_native_format === undefined ? {} : { public_native_format: clean(it.public_native_format) }) };
    return { id: `item-${sha(item).slice(0, 16)}`, ...item };
  }) };
  return { context: ctx, set: q, hashes: { context_projection_sha256: sha(ctx), set_projection_sha256: sha(q) } };
}

// Validate public shape and alignment before code can index native arrays. Unsupported formats remain unverified.
export function inputIssues(context, set) {
  const issues = [];
  if (context?.contract !== "lesson-context 0.1" || set?.contract !== "question-set 0.1") issues.push("unsupported contract version");
  if (!context?.lesson?.id || set?.lesson !== context.lesson.id) issues.push("lesson ids do not match");
  if (!context?.native || typeof context.native !== "object" || Array.isArray(context.native)) issues.push("lesson native payload is missing");
  if (!Array.isArray(set?.items) || !set.items.length) issues.push("question set is empty or missing");
  const orders = new Set(), ids = new Set();
  for (const item of Array.isArray(set?.items) ? set.items : []) {
    if (!item || typeof item !== "object") { issues.push("item is not an object"); continue; }
    if (!Number.isInteger(item.order) || item.order < 1 || orders.has(item.order)) issues.push("item order is invalid or duplicated");
    orders.add(item.order);
    if (typeof item.id !== "string" || !item.id || ids.has(item.id)) issues.push("item id is missing or duplicated");
    ids.add(item.id);
    if (!KINDS.has(item.kind)) issues.push("unsupported format");
    const resolved = resolvePointer(context?.native, item.pointer);
    const page = Array.isArray(context?.native?.pages) ? context.native.pages.find((p) => p?.id === item.page)
      : resolved.ancestors.find((p) => p && typeof p === "object" && p !== context?.native && p.id === item.page);
    if (!resolved.found) issues.push("item pointer does not resolve");
    if (!page || !resolved.ancestors.includes(page)) issues.push("item page or pointer does not match its lesson");
    if (resolved.found && canonical(resolved.target) !== canonical(item.native)) issues.push("item native copy differs from the pointer target");
    if (!item.view || typeof item.view !== "object" || Array.isArray(item.view)) issues.push("item view is missing");
    if (choices.has(item.kind) && (!Array.isArray(item.view?.options) || item.view.options.length < 2 || !Array.isArray(item.view?.key))) issues.push("choice requires options and a key array");
  }
  return [...new Set(issues)];
}

export const supportedKind = (kind) => KINDS.has(kind);

const ordered = (x) => x && typeof x === "object" ? Array.isArray(x) ? x.map(ordered)
  : Object.fromEntries(Object.keys(x).sort().map((k) => [k, ordered(x[k])])) : x;
const canonical = (x) => JSON.stringify(ordered(x));

export function resolvePointer(root, pointer) {
  if (typeof pointer !== "string" || (pointer !== "" && !pointer.startsWith("/")) || /~(?:[^01]|$)/.test(pointer)) return { found: false, ancestors: [] };
  let target = root; const ancestors = [root];
  for (const part of pointer === "" ? [] : pointer.slice(1).split("/").map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"))) {
    if (target == null || typeof target !== "object" || !Object.hasOwn(target, part)) return { found: false, ancestors };
    target = target[part]; ancestors.push(target);
  }
  return { found: true, target, ancestors };
}

export function layoutIssues(context, item) {
  // Transport pointers are generic. A legacy layout is a separate interpreter capability, not schema validity.
  const m = /^\/pages\/(\d+)\/nodes\/(\d+)(?:\/|$)/.exec(item.pointer || "");
  if (!m || !context.native.pages?.[Number(m[1])]?.nodes?.[Number(m[2])]) return ["native page layout has no verified learner-exposure interpreter"];
  return [];
}

export function viewIssues(item) {
  const v = item.view || {};
  if (choices.has(item.kind) && (typeof v.stem !== "string" || !v.options?.every((s) => typeof s === "string") || (v.option_feedback !== undefined && !Array.isArray(v.option_feedback)))) return ["unsupported choice view variant"];
  if (item.kind === "classify" && (!Array.isArray(v.items) || !v.boxes || typeof v.boxes !== "object" || Array.isArray(v.boxes)
    || !Object.values(v.boxes).every((b) => b && typeof b === "object" && !Array.isArray(b))
    || !v.items.every((w) => w && typeof w.word === "string" && typeof w.to === "string" && ["is", "seems", "wanted"].includes(w.kind)))) return ["unsupported classification view variant"];
  if (item.kind === "evidence_select" && (!["candidates", "decoys"].every((k) => Array.isArray(v[k]) && v[k].every((s) => typeof s === "string")) || (v.strong !== undefined && !Array.isArray(v.strong)))) return ["unsupported evidence selection view variant"];
  if (item.kind === "open_check" && (!v.rubric || !Array.isArray(v.rubric.criteria) || !v.rubric.criteria.every((c) => c && typeof c === "object"
    && ["accept", "evidence"].every((k) => c[k] === undefined || (Array.isArray(c[k]) && c[k].every((s) => typeof s === "string")))
    && (c.keywords === undefined || (Array.isArray(c.keywords) && c.keywords.every((g) => typeof g === "string" || (Array.isArray(g) && g.every((s) => typeof s === "string")))))
    && ["nudge", "second_nudge", "third_nudge"].every((k) => c[k] === undefined || typeof c[k] === "string"))
    || (v.rubric.misreadings !== undefined && (!Array.isArray(v.rubric.misreadings) || !v.rubric.misreadings.every((m) => m && typeof m.looks_like === "string"))))) return ["unsupported open response rubric variant"];
  return [];
}
