// Versioned scope only. Provider calls, sample gates and final verdicts belong to the evaluator.
import fs from "node:fs";
import crypto from "node:crypto";

const KINDS = ["film_mcq", "reading_mcq", "key_term_mcq", "rebuild_choice", "open_check", "open_prompt", "word_web", "evidence_select", "say_back", "classify"];
// This v1 contract prevents a wildcard or a misplaced family from silently broadening a named profile.
const PARTIAL = {
  classify: ["^word_[1-9][0-9]*_fits$", "^word_[1-9][0-9]*_[A-Za-z][A-Za-z0-9_]*_also_fits$"],
  open_check: ["^reveal_meets_[1-9][0-9]*$", "^accepted_[1-9][0-9]*_[1-9][0-9]*_meets$"]
};
const record = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const text = (x) => typeof x === "string" && x.trim().length > 0;
const sameSet = (xs, ys) => Array.isArray(xs) && xs.length === ys.length && new Set(xs).size === xs.length && xs.every((x) => ys.includes(x));
const ordered = (x) => Array.isArray(x) ? x.map(ordered) : record(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, ordered(x[k])])) : x;
const hash = (x) => crypto.createHash("sha256").update(JSON.stringify(ordered(x))).digest("hex");
const freeze = (x) => { if (x && typeof x === "object") { Object.values(x).forEach(freeze); Object.freeze(x); } return x; };
const invalid = () => { throw new TypeError("invalid judge profile"); };
const KEYS = ["schema_version", "id", "version", "status", "qualification", "observed_model_ids", "observed_models_scope", "source", "selection", "exclusions", "limitations"];

export function validateJudgeProfile(input) {
  if (!record(input) || Object.keys(input).some((k) => ![...KEYS, "sha256"].includes(k)) || KEYS.some((k) => !Object.hasOwn(input, k))) invalid();
  const qualified = input.id === "jev-qualified-v1";
  if (input.schema_version !== 1 || input.version !== 1 || !["jev-partial-v1", "jev-full-experimental", "jev-qualified-v1"].includes(input.id)
    || input.status !== (qualified ? "evidence-gated" : "development-only") || input.qualification !== false) invalid();
  if (!Array.isArray(input.observed_model_ids) || (!qualified && !input.observed_model_ids.length) || !input.observed_model_ids.every((id) => typeof id === "string" && /^jev-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id))
    || new Set(input.observed_model_ids).size !== input.observed_model_ids.length || input.observed_models_scope !== "reported service identity; not immutable revision") invalid();
  const source = input.source;
  if (qualified) {
    if (!record(source) || source.registry_id !== "B1000" || source.kind !== "qualification-policy" || source.independent_gold_labels !== 0 || !text(source.meaning)) invalid();
  } else if (!record(source) || source.registry_id !== "B0998" || source.kind !== "development-trials" || source.labelled_development_cases !== 16 || source.stress_controls !== 6
    || source.independent_gold_labels !== 0 || !record(source.full_reference) || source.full_reference.units !== 40 || source.full_reference.judge_criteria !== 543
    || source.full_reference.labelled_for_accuracy !== false || !text(source.meaning)) invalid();
  if (!text(input.exclusions) || !Array.isArray(input.limitations) || !input.limitations.length || !input.limitations.every(text)) invalid();
  const selection = input.selection;
  if (!record(selection) || !sameSet(Object.keys(selection), ["mode", "operations"])) invalid();
  if (input.id === "jev-partial-v1") {
    if (selection.mode !== "allowlist" || !record(selection.operations) || !sameSet(Object.keys(selection.operations), Object.keys(PARTIAL))) invalid();
    for (const [kind, patterns] of Object.entries(PARTIAL)) if (!sameSet(selection.operations[kind], patterns)) invalid();
  } else if (selection.mode !== "all" || !sameSet(selection.operations, KINDS)) invalid();
  const config = Object.fromEntries(KEYS.map((k) => [k, structuredClone(input[k])]));
  const sha256 = hash(config);
  if (input.sha256 !== undefined && input.sha256 !== sha256) invalid();
  return freeze({ ...config, sha256 });
}

let profiles;
export function getJudgeProfile(id = "jev-partial-v1") {
  if (!profiles) {
    const file = JSON.parse(fs.readFileSync(new URL("../criteria/jev-profile.json", import.meta.url), "utf8"));
    if (!record(file) || file.schema_version !== 1 || file.default_profile !== "jev-partial-v1" || !Array.isArray(file.profiles)
      || !sameSet(file.profiles.map((p) => p?.id), ["jev-partial-v1", "jev-full-experimental", "jev-qualified-v1"])) invalid();
    profiles = new Map(file.profiles.map((p) => { const profile = validateJudgeProfile(p); return [profile.id, profile]; }));
  }
  if (!profiles.has(id)) throw new TypeError("unknown judge profile");
  return profiles.get(id);
}

export function selectJudgeQuestions(profile, kind, questions) {
  const config = validateJudgeProfile(profile);
  if (!Array.isArray(questions)) throw new TypeError("judge questions must be an array");
  const operations = config.selection.operations;
  const operationAllowed = config.selection.mode === "all" ? operations.includes(kind) : Object.hasOwn(operations, kind);
  const patterns = operationAllowed && config.selection.mode === "allowlist" ? operations[kind].map((p) => new RegExp(p)) : [];
  const selected = [], excluded = [], seen = new Set();
  for (const question of questions) {
    const q = question?.q ?? question;
    if (!record(q) || !text(q.id) || seen.has(q.id)) throw new TypeError("invalid or duplicated judge question id");
    seen.add(q.id);
    let reason = null;
    if (!operationAllowed) reason = "operation_outside_profile";
    else if (config.selection.mode === "allowlist" && (!patterns.some((p) => p.test(q.id)) || /[\r\n]/.test(q.id))) reason = "criterion_outside_profile";
    if (reason) excluded.push({ question, criterion_id: q.id, reason });
    else selected.push(question);
  }
  return { selected, excluded };
}
