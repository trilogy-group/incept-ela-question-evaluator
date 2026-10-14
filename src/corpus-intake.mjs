// Finished authored corpus intake. This adapter never reads source repositories or calls a model.
// A covered row is an interpretable source operation, not a quality label or a learner outcome.
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { resolvePointer, layoutIssues, viewIssues } from "./packet.mjs";
import { seenBefore, studentText } from "./seen.mjs";

export const CORPUS_INTAKE_VERSION = "corpus-intake 0.1";
const object = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const string = (x) => typeof x === "string" && x.trim().length > 0;
const strings = (x) => Array.isArray(x) && x.every((v) => typeof v === "string");
const hash = (x, algorithm = "sha256") => crypto.createHash(algorithm).update(x).digest("hex");
const ordered = (x) => Array.isArray(x) ? x.map(ordered) : object(x)
  ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, ordered(x[k])])) : x;
const canonical = (x) => JSON.stringify(ordered(x));
const clone = (x) => JSON.parse(JSON.stringify(x));
const unique = (xs) => [...new Set(xs)];
const hex = (x, n = 64) => typeof x === "string" && new RegExp(`^[a-f0-9]{${n}}$`).test(x);
const fail = (reason) => { throw new Error(reason); };
const choiceKinds = new Set(["film_mcq", "reading_mcq", "key_term_mcq"]);
const animatedKinds = new Set([...choiceKinds, "open_check", "open_prompt", "word_web", "evidence_select", "say_back", "classify"]);

function checkedChoice(stem, options, key, feedback, correctFeedback) {
  if (!string(stem) || !strings(options) || options.length < 2 || options.some((x) => !string(x))) fail("choice stem or options are missing or unsupported");
  if (!Array.isArray(key) || key.length !== 1 || !Number.isInteger(key[0]) || key[0] < 0 || key[0] >= options.length) fail("authored key is not exactly one in-range choice");
  if (feedback !== undefined && (!Array.isArray(feedback) || feedback.length !== options.length || !feedback.every((x) => x === null || typeof x === "string"))) fail("feedback array does not align with source options");
  if (correctFeedback !== undefined && typeof correctFeedback !== "string") fail("correct feedback is not a string");
  return { stem, options: [...options], key: [...key], ...(feedback === undefined ? {} : { option_feedback: [...feedback] }),
    ...(correctFeedback === undefined ? {} : { correct_feedback: correctFeedback }) };
}

// XML is parsed as inert data. External entities, DTDs, malformed syntax and unsupported markup abstain.
function decodeXML(text) {
  return text.replace(/&([^;]+);/g, (_, entity) => {
    const known = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (Object.hasOwn(known, entity)) return known[entity];
    if (/^#(?:x[0-9a-f]+|\d+)$/i.test(entity)) {
      const n = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      if (n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff)) return String.fromCodePoint(n);
    }
    fail("unsupported XML entity");
  });
}
function parseXML(xml) {
  if (!string(xml) || /<!DOCTYPE|<!ENTITY|<!\[CDATA\[/i.test(xml)) fail("unsupported XML declaration or entity");
  const root = { name: "#document", attributes: {}, children: [] }, stack = [root];
  const tokens = xml.match(/<!--[^]*?-->|<\?[^]*?\?>|<[^>]*>|[^<]+/g) || [];
  if (tokens.join("") !== xml) fail("malformed XML");
  for (const token of tokens) {
    if (token.startsWith("<!--") || token.startsWith("<?")) continue;
    if (!token.startsWith("<")) { stack.at(-1).children.push(decodeXML(token)); continue; }
    const end = /^<\/([\w:-]+)\s*>$/.exec(token);
    if (end) { if (stack.length === 1 || stack.at(-1).name !== end[1]) fail("mismatched XML close tag"); stack.pop(); continue; }
    const start = /^<([\w:-]+)((?:\s+[\w:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>$/.exec(token);
    if (!start) fail("unsupported or malformed XML tag");
    const attributes = {};
    for (const m of start[2].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      if (Object.hasOwn(attributes, m[1])) fail("duplicate XML attribute");
      attributes[m[1]] = decodeXML(m[2] ?? m[3]);
    }
    const node = { name: start[1], attributes, children: [] };
    stack.at(-1).children.push(node); if (!start[3]) stack.push(node);
  }
  if (stack.length !== 1) fail("unclosed XML tag");
  const roots = root.children.filter(object);
  if (roots.length !== 1 || root.children.some((n) => typeof n === "string" && n.trim())) fail("XML has no unique root");
  return roots[0];
}
const children = (node, name) => node.children.filter((n) => object(n) && n.name === name);
const one = (node, name) => { const xs = children(node, name); if (xs.length !== 1) fail(`QTI requires exactly one ${name}`); return xs[0]; };
const walkXML = (node) => [node, ...node.children.filter(object).flatMap(walkXML)];
const plainMarkup = new Set(["p", "br", "span", "b", "strong", "i", "em", "u", "sub", "sup"]);
function learnerXML(node) {
  const render = (x) => {
    if (typeof x === "string") return x;
    if (!plainMarkup.has(x.name)) fail(`unsupported learner markup ${x.name}`);
    if (Object.keys(x.attributes).length) fail("learner markup visibility or attributes are unsupported");
    const t = x.children.map(render).join("");
    return ["p", "br"].includes(x.name) ? `${t}\n` : t;
  };
  return node.children.map(render).join("").trim();
}
function verifyMember(member) {
  if (!object(member) || !string(member.path) || !string(member.xml) || !hex(member.sha256) || !hex(member.git_blob, 40)) fail("QTI member provenance is incomplete");
  const bytes = Buffer.from(member.xml, "utf8");
  if (hash(bytes) !== member.sha256) fail(`QTI member SHA256 mismatch: ${member.path}`);
  if (hash(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]), "sha1") !== member.git_blob) fail(`QTI member Git blob mismatch: ${member.path}`);
  return { path: member.path, sha256: member.sha256, git_blob: member.git_blob, hashes_verified: true };
}
function qtiChoice(row, sourceContext) {
  if (row.kind !== "multiple_choice") fail("QTI operation is outside the single-choice pathway");
  const xml = parseXML(row.native.xml), all = walkXML(xml);
  if (xml.name !== "qti-assessment-item" || xml.attributes.adaptive !== "false" || xml.attributes["time-dependent"] !== "false") fail("adaptive or timed QTI operation is unsupported");
  const declaration = one(xml, "qti-response-declaration"), body = one(xml, "qti-item-body");
  if (declaration.attributes.cardinality !== "single" || declaration.attributes["base-type"] !== "identifier") fail("QTI response is not a single identifier");
  const interaction = one(body, "qti-choice-interaction");
  if (interaction.attributes["max-choices"] !== "1" || interaction.attributes["response-identifier"] !== declaration.attributes.identifier) fail("QTI interaction is not a single declared choice");
  const interactions = all.filter((n) => n.name.endsWith("-interaction"));
  if (interactions.length !== 1 || interactions[0] !== interaction) fail("QTI has multiple or hidden response operations");
  const processing = one(xml, "qti-response-processing");
  if (processing.attributes.template !== "https://purl.imsglobal.org/spec/qti/v3p0/rptemplates/match_correct" || processing.children.some((n) => object(n) || n.trim())) fail("QTI response processing is outside the exact-match template");
  const values = children(one(declaration, "qti-correct-response"), "qti-value");
  if (values.length !== 1) fail("QTI authored key is not single");
  const correctId = learnerXML(values[0]), choices = children(interaction, "qti-simple-choice");
  const ids = choices.map((n) => n.attributes.identifier);
  if (!ids.every(string) || new Set(ids).size !== ids.length) fail("QTI choice identifiers are missing or duplicated");
  if (!ids.includes(correctId)) fail("QTI authored key does not resolve");
  if (body.children.some((n) => object(n) && n !== interaction) || interaction.children.some((n) => object(n) && !["qti-prompt", "qti-simple-choice"].includes(n.name))) fail("QTI learner body has an unhandled instruction or operation");
  const allowedTags = new Set(["qti-assessment-item", "qti-response-declaration", "qti-correct-response", "qti-value", "qti-outcome-declaration", "qti-default-value", "qti-assessment-stimulus-ref", "qti-item-body", "qti-choice-interaction", "qti-prompt", "qti-simple-choice", "qti-response-processing", ...plainMarkup]);
  if (all.some((n) => !allowedTags.has(n.name))) fail("QTI contains unsupported declarations or hidden operations");
  const refs = children(xml, "qti-assessment-stimulus-ref");
  if (refs.length !== 1) fail("QTI requires one explicit stimulus reference");
  const ref = refs[0], member = sourceContext.stimuli?.[ref.attributes.identifier];
  if (!member || ref.attributes.href !== `stimuli/${ref.attributes.identifier}`) fail("QTI stimulus reference is missing or unresolved");
  const stimulusXML = parseXML(member.xml);
  if (stimulusXML.name !== "qti-assessment-stimulus" || stimulusXML.attributes.identifier !== ref.attributes.identifier) fail("QTI stimulus identity does not match its reference");
  const stimulusBody = one(stimulusXML, "qti-stimulus-body");
  if (stimulusXML.children.some((n) => object(n) && n !== stimulusBody)) fail("QTI stimulus has unsupported content outside its body");
  return { view: checkedChoice(learnerXML(one(interaction, "qti-prompt")), choices.map(learnerXML), [ids.indexOf(correctId)]),
    stimulus: [{ text: learnerXML(stimulusBody), ...(string(stimulusXML.attributes.title) ? { title: stimulusXML.attributes.title } : {}) }],
    authored_key: { status: "authored; not independently validated", indices: [ids.indexOf(correctId)], source_identifiers: [correctId] },
    identity: xml.attributes.identifier, stimulus_members: [verifyMember(member)],
    context_identity: ref.attributes.identifier, context_unresolved: ["QTI shuffle is declared; actual displayed order and timing are unverified"] };
}

// Only passive source text before the operation enters a solver context. Task solutions and routes are omitted.
const passiveTypes = new Set(["passage", "verse"]);
function passiveText(node) {
  if (node.type === "verse") {
    if (!string(node.title) || !strings(node.lines) || !node.lines.some(string)) fail("renderer verse requires an explicit title and string lines");
    // The retained verse format displays its title and ordered lines. Word definitions and voiceover are separate.
    return [node.title, ...node.lines].join("\n");
  }
  const out = [];
  if (typeof node.title === "string") out.push(node.title);
  // These are alternative serializations of the same displayed body, not separate exposures.
  if (strings(node.paragraphs)) out.push(...node.paragraphs);
  else if (strings(node.lines)) out.push(...node.lines);
  else if (typeof node.text === "string") out.push(node.text);
  if (typeof node.image_caption === "string") out.push(node.image_caption);
  if (object(node.glossary)) for (const [term, definition] of Object.entries(node.glossary)) if (typeof definition === "string") out.push(`${term}: ${definition}`);
  return out.join("\n");
}
function rendererContext(sourceContext, occurrence) {
  if (!/^\/units\/\d+\/lessons\/\d+$/.test(occurrence.context_pointer)) fail("renderer lesson context pointer is unsupported");
  const lesson = resolvePointer(sourceContext, occurrence.context_pointer).target;
  const suffix = occurrence.pointer.slice(occurrence.context_pointer.length);
  const match = /^\/pages\/(\d+)\/nodes\/(\d+)(?:\/|$)/.exec(suffix);
  if (!match || !Array.isArray(lesson?.pages)) fail("renderer operation is outside a lesson page");
  const pi = Number(match[1]), ni = Number(match[2]), stimulus = [];
  let passageAvailable = false;
  for (let p = 0; p <= pi; p++) {
    const page = lesson.pages[p];
    if (!object(page) || !Array.isArray(page.nodes)) fail("renderer page context is malformed");
    if (page.hidden === true) continue;
    for (let n = 0; n < page.nodes.length && (p < pi || n < ni); n++) {
      const node = page.nodes[n];
      if (object(node) && node.hidden !== true && passiveTypes.has(node.type)) {
        const text = passiveText(node); if (text) stimulus.push({ text });
        if (text) passageAvailable = true;
      }
    }
  }
  const ancestors = resolvePointer(sourceContext, occurrence.pointer).ancestors;
  const instruction = unique(ancestors.filter((n) => object(n) && n !== sourceContext && n !== lesson && !Array.isArray(n.pages))
    .flatMap((n) => [n.instruction, n.step_head, n.question, n.task, n.mission].filter((s) => typeof s === "string")));
  return { lesson, stimulus, instruction, passage_available: passageAvailable, identity: `${lesson.lessonId ?? occurrence.context_pointer}${suffix}` };
}
function hiddenOperation(ancestors, occurrence) {
  if (occurrence.context_status || occurrence.exposure_status) fail(`unresolved partial or alternative operation: ${occurrence.context_status ?? occurrence.exposure_status}`);
  if (ancestors.some((n) => object(n) && (n.hidden === true || n.disabled === true))) fail("operation or containing source node is hidden or disabled");
}
function normalizeNative(row, source, sourceContext, occurrence) {
  const n = row.native;
  switch (source.adapter) {
    case "renderer": {
      if (!["mcq", "video_mcq"].includes(row.kind) || !object(n) || (row.kind === "mcq" && (n.type !== "question" || n.bank_type !== "mcq"))) fail("renderer native operation is outside the single-choice pathway");
      if (Object.hasOwn(n, "hunt") || ["states", "parts", "responses", "statements", "blanks"].some((k) => Object.hasOwn(n, k))) fail("renderer choice contains an additional response operation");
      const context = rendererContext(sourceContext, occurrence);
      const view = checkedChoice(n.stem, n.options, [n.answer_index], n.feedback);
      return { kind: "reading_mcq", view, stimulus: context.stimulus, passage_available: context.passage_available, instruction: context.instruction, identity: context.identity, context_identity: context.lesson.lessonId ?? occurrence.context_pointer,
        authored_key: { status: "authored; not independently validated", indices: [...view.key] },
        context_unresolved: ["Only passive source text before the question is retained; scaffold routes, media binaries and learner histories are unavailable"] };
    }
    case "reading-export": {
      if (row.kind !== "multiple_choice" || n?.type !== "choice" || !Array.isArray(n.options) || !n.options.every((o) => object(o) && string(o.id) && typeof o.key === "boolean" && typeof o.text === "string")) fail("reading export operation is outside the single-choice pathway");
      const ids = n.options.map((o) => o.id);
      if (new Set(ids).size !== ids.length) fail("reading export duplicates choice identifiers; flattened multi-part operation is unsupported");
      if (!Array.isArray(n.correct) || n.correct.length !== 1 || !ids.includes(n.correct[0])) fail("reading export authored key is not a unique single choice");
      const key = [ids.indexOf(n.correct[0])], marked = n.options.flatMap((o, i) => o.key ? [i] : []);
      if (canonical(marked) !== canonical(key)) fail("reading export correct identifiers and option flags disagree");
      if (!string(n.passage)) fail("reading export passage is missing");
      return { kind: "reading_mcq", view: checkedChoice(n.stem, n.options.map((o) => o.text), key), stimulus: [{ text: n.passage }], instruction: [],
        identity: n.item_id, context_identity: n.lesson ?? hash(n.passage), authored_key: { status: "authored; not independently validated", indices: key, source_identifiers: [...n.correct] } };
    }
    case "alpha-read": {
      if (row.kind !== "multiple_choice" || n?.type !== "choice" || !Array.isArray(n.choices) || !n.choices.every((o) => object(o) && typeof o.correct === "boolean" && typeof o.text === "string")) fail("Alpha native operation is outside the single-choice pathway");
      if (!/^\/lessons\/\d+$/.test(occurrence.context_pointer) || !/^\/lessons\/\d+\/questions\/\d+$/.test(occurrence.pointer)) fail("Alpha native pointers are unsupported");
      const lesson = resolvePointer(sourceContext, occurrence.context_pointer).target;
      if (!Array.isArray(lesson?.passage) || !lesson.passage.every((p) => object(p) && strings(p.paras) && typeof p.section === "string")) fail("Alpha passage blocks are unsupported or missing");
      // Guiding questions receive only their matching passage section. Quiz questions receive the full passage.
      const blocks = n.section === "Quiz" ? lesson.passage : lesson.passage.filter((p) => p.section === n.section);
      if (!blocks.length) fail("Alpha question section has no matching source passage");
      const key = n.choices.flatMap((o, i) => o.correct ? [i] : []);
      return { kind: "reading_mcq", view: checkedChoice(n.prompt, n.choices.map((o) => o.text), key), stimulus: blocks.map((p) => ({ text: p.paras.join("\n"), section: p.section })), instruction: [],
        identity: `${lesson.resource ?? occurrence.context_pointer}/question-${occurrence.pointer.split("/").at(-1)}`, context_identity: lesson.resource ?? occurrence.context_pointer,
        authored_key: { status: "authored; not independently validated", indices: key },
        context_unresolved: ["Section association is preserved; visibility and timing of other sections are unverified"] };
    }
    case "qti-bundle": return { kind: "reading_mcq", instruction: [], ...qtiChoice(row, sourceContext) };
    case "animated": {
      if (!animatedKinds.has(row.kind) || !object(row.view)) fail(row.kind === "rebuild_choice" ? "animated rebuild is a multi-slot task; a slot is not an independent question" : "animated operation has no supported established view");
      const pageMatch = /^\/pages\/(\d+)\/nodes\/\d+(?:\/|$)/.exec(occurrence.pointer);
      const page = pageMatch && sourceContext.pages?.[Number(pageMatch[1])];
      const item = { id: row.id, page: page?.id, order: 1, kind: row.kind, pointer: occurrence.pointer, native: n, view: row.view };
      const issues = [...layoutIssues({ native: sourceContext }, item), ...viewIssues(item)];
      if (issues.length) fail(issues.join("; "));
      let view = clone(row.view), authoredKey = { status: "authored; not independently validated" };
      if (choiceKinds.has(row.kind)) {
        view = { ...view, ...checkedChoice(view.stem, view.options, view.key, view.option_feedback, view.correct_feedback) };
        const nativeOptions = n.options?.map((o) => typeof o === "string" ? o : o?.text);
        const nativeStem = n.stem ?? n.q ?? n.task, nativeKey = n.answer ?? n.correct;
        if (canonical(nativeOptions) !== canonical(view.options) || nativeStem !== view.stem || canonical([nativeKey]) !== canonical(view.key)) fail("animated established choice view differs from its native source");
        authoredKey.indices = [...view.key];
      } else if (row.kind === "classify") authoredKey.assignments = view.items.map(({ word, to, kind }) => ({ word, to, kind }));
      else if (row.kind === "evidence_select") authoredKey = { ...authoredKey, candidates: clone(view.candidates), decoys: clone(view.decoys), strong: clone(view.strong ?? []) };
      else if (row.kind === "say_back") authoredKey.expected = view.expected ?? null;
      else if (view.rubric) authoredKey.rubric = clone(view.rubric);
      else if (view.reveal !== undefined) authoredKey.reveal = view.reveal;
      const nodeMatch = /^\/pages\/(\d+)\/nodes\/(\d+)/.exec(occurrence.pointer);
      const node = nodeMatch && sourceContext.pages[Number(nodeMatch[1])].nodes[Number(nodeMatch[2])];
      // The passage diagnostic uses the current reading node, without preceding worked model tasks.
      const stimulus = row.kind === "reading_mcq" ? [{ text: studentText(node.blocks).join("\n") }]
        : seenBefore(sourceContext, item).map(({ text }) => ({ text }));
      return { kind: row.kind, view, authored_key: authoredKey, stimulus, instruction: [], identity: `${sourceContext.lessonId ?? "lesson"}/${occurrence.operation ?? occurrence.pointer}`, context_identity: `${sourceContext.lessonId ?? "lesson"}/${page?.id}/${node?.id}`,
        learning_question: typeof sourceContext.question === "string" ? sourceContext.question : null,
        context_unresolved: ["Existing native interpreter gives a conservative source preview; actual rendered, timed and conditional exposure remains unverified"] };
    }
    default: fail(`native family ${source.adapter ?? "unknown"} has no verified intake pathway`);
  }
}

function blindContext(normalized) {
  const { view: v, kind } = normalized;
  const base = { kind, instruction: normalized.instruction ?? [], stimulus: normalized.stimulus ?? [],
    learner_context_status: "unresolved", unresolved: unique(["Learner age, answer history and actual rendered/timed exposure are unavailable", ...(normalized.context_unresolved ?? [])]) };
  if (normalized.learning_question) base.learning_question = normalized.learning_question;
  if (choiceKinds.has(kind)) return { ...base, question: v.stem, options: v.options.map((text, i) => ({ id: `option-${i + 1}`, text })) };
  const prompt = typeof v.prompt === "string" ? v.prompt : strings(v.prompt) ? v.prompt.join("\n") : v.rubric?.question;
  if (!string(prompt)) fail("animated learner-visible prompt is missing");
  if (kind === "classify") return { ...base, question: prompt, words: v.items.map((w) => w.word), destinations: Object.values(v.boxes).flatMap((b) => [b.is, b.seems, b.wanted].filter((s) => typeof s === "string")) };
  if (kind === "evidence_select") return { ...base, question: prompt, options: [...v.candidates, ...v.decoys].map((text, i) => ({ id: `option-${i + 1}`, text })) };
  if (kind === "word_web") return { ...base, question: prompt, ...(typeof v.centre === "string" ? { centre: v.centre } : {}) };
  return { ...base, question: prompt };
}
function sourceProvenance(source, occurrence) {
  return { source_id: source.id, family: source.adapter, source_repository: source.repository ?? null, source_commit: source.commit ?? null,
    source_path: source.path, original_source_sha256: source.sha256, original_source_hash_status: "declared; original bytes were not inspected",
    context: source.context, context_sha256: source.context_sha256, context_hash_status: "verified retained bytes", pointer: occurrence.pointer,
    context_pointer: occurrence.context_pointer, ...(occurrence.operation ? { operation: occurrence.operation } : {}),
    ...(occurrence.member_path ? { member_path: occurrence.member_path, member_sha256: occurrence.member_sha256 } : {}), version_role: source.version_role ?? null };
}
function pilotDependencies(row, normalized) {
  if (!choiceKinds.has(normalized.kind)) return ["operation is outside the single-choice text diagnostic"];
  const stem = normalized.view.stem, reasons = [];
  if (["video_mcq", "film_mcq"].includes(row.kind)) reasons.push("video or film operation requires unverified timed media exposure");
  if (/\b(?:this question|question asking|question asks|the question will|word from the question|question we|question you|what you are looking for|what are we looking for|what are you looking for)\b/i.test(stem)) reasons.push("question refers to a target question whose learner-visible antecedent is unresolved");
  if (/\b(?:last lesson|previous lesson|earlier lesson|last time|yesterday)\b/i.test(stem)) reasons.push("question depends on an unavailable previous learner context");
  if (/\b(?:last row|table|chart|sentence frame|blank|gap|rebuild|finish the|complete the|picture|image|illustration|video|film|clip|on screen)\b/i.test(stem)) reasons.push("question depends on a visual, frame, table or media operation outside the text diagnostic");
  if (/\b(?:this sentence|this word|this line|these words|these lines|underlined|highlighted|glowing|above|below|here|there)\b/i.test(stem)) reasons.push("question has a deictic or marked-text dependency whose antecedent is unresolved");
  if (!normalized.stimulus?.some((s) => string(s.text)) || normalized.passage_available === false) reasons.push("no learner-visible source passage is available; instructional text alone is not a passage");
  if (normalized.kind === "key_term_mcq") reasons.push("key-term operation is outside the passage-only diagnostic");
  return unique(reasons);
}
function independenceGroup(source, normalized) {
  const lineage = source.upstream_course_id ? `course:${source.upstream_course_id}` : `${source.repository ?? source.adapter}/${source.path}`;
  return `cluster-${hash(`${lineage}/${normalized.identity}`).slice(0, 24)}`;
}
const rankSource = (p) => p.version_role === "current-main-at-intake" ? 0 : p.version_role === "current-staging-at-intake" ? 1 : 2;
const variantSort = (a, b) => rankSource(a.provenance[0]) - rankSource(b.provenance[0]) || a.provenance[0].source_id.localeCompare(b.provenance[0].source_id) || a.provenance[0].pointer.localeCompare(b.provenance[0].pointer);

/** Normalize one row from verified retained contexts. Throws for an unsupported occurrence. No source I/O. */
export function normalizeCorpusOccurrence(row, source, sourceContext, occurrence) {
  if (!object(row) || !string(row.id) || !object(source) || !object(occurrence) || occurrence.source_id !== source.id || occurrence.context !== source.context) fail("row occurrence and source provenance do not match");
  const resolved = resolvePointer(sourceContext, occurrence.pointer), context = resolvePointer(sourceContext, occurrence.context_pointer);
  if (!resolved.found || !context.found || !resolved.ancestors.includes(context.target)) fail("source or context pointer does not resolve to the operation");
  if (canonical(resolved.target) !== canonical(row.native)) fail("row native copy differs from its verified source pointer");
  hiddenOperation(resolved.ancestors, occurrence);
  if (source.adapter === "qti-bundle") {
    verifyMember(row.native);
    if (occurrence.member_path !== row.native.path || occurrence.member_sha256 !== row.native.sha256) fail("QTI occurrence member provenance differs from source member");
  }
  const normalized = normalizeNative(row, source, sourceContext, occurrence), solverContext = blindContext(normalized);
  const rowPrompt = typeof row.prompt === "string" ? row.prompt : strings(row.prompt) && row.prompt.length === 1 ? row.prompt[0] : null;
  if (choiceKinds.has(normalized.kind) && rowPrompt !== normalized.view.stem) fail("row prompt differs from its native source stem or has multiple parts");
  const provenance = sourceProvenance(source, occurrence), dependencies = pilotDependencies(row, normalized);
  if (normalized.stimulus_members) provenance.stimulus_members = normalized.stimulus_members;
  return { id: row.id, family: source.adapter, kind: row.kind, role: row.role, item: { id: row.id, kind: normalized.kind, view: normalized.view },
    solver_context: solverContext, authored_key: normalized.authored_key, provenance: [provenance],
    independence_group: independenceGroup(source, normalized), source_identity: normalized.identity,
    context_group: `context-${hash(`${source.upstream_course_id ?? source.repository ?? source.adapter}/${normalized.context_identity ?? normalized.identity}`).slice(0, 24)}`,
    challenge_sha256: hash(canonical({ question: solverContext.question, options: (solverContext.options ?? []).map((o) => o.text).sort(), stimulus: solverContext.stimulus.map((s) => s.text) })),
    passage_sha256: hash(canonical(solverContext.stimulus.map((s) => s.text))),
    scope: choiceKinds.has(normalized.kind) ? "derived source-text diagnostic; not a native lesson interpreter" : "established native development operation with conservative source preview",
    pilot_eligible: dependencies.length === 0, unresolved_dependencies: dependencies,
    limitations: ["Authored answers are not independent gold labels", "Coverage does not establish question quality or complete learner context"],
    solver_sha256: hash(canonical(solverContext)) };
}

/** Verify retained corpus files and QTI member bytes, then account for every row and source occurrence. */
export async function loadCorpus(directory, { expectedCatalogSha256 } = {}) {
  const root = await realpath(directory);
  const readRetained = async (relative) => {
    if (!/^(?:catalog\.json|browse\.json|questions\.jsonl|contexts\/[a-zA-Z0-9_-]+\.json)$/.test(relative)) fail(`unsupported retained corpus path: ${relative}`);
    const resolved = await realpath(path.join(root, relative));
    if (!resolved.startsWith(`${root}${path.sep}`)) fail("retained corpus symlink escapes its directory");
    return readFile(resolved);
  };
  const catalogBytes = await readRetained("catalog.json"), catalogHash = hash(catalogBytes), catalog = JSON.parse(catalogBytes);
  if (expectedCatalogSha256 !== undefined && (!hex(expectedCatalogSha256) || catalogHash !== expectedCatalogSha256)) fail("catalog SHA256 does not match the external pin");
  if (!object(catalog.files) || !Array.isArray(catalog.sources) || !object(catalog.counts) || !hex(catalog.files["questions.jsonl"])) fail("corpus catalog is incomplete");
  const verifiedFiles = {}, fileBytes = new Map();
  // No source repository, source configuration or credential path is read from catalog metadata.
  for (const [relative, expected] of Object.entries(catalog.files)) {
    if (!hex(expected)) fail(`invalid retained file hash: ${relative}`);
    const bytes = await readRetained(relative), actual = hash(bytes);
    if (actual !== expected) fail(`retained file SHA256 mismatch: ${relative}`);
    verifiedFiles[relative] = actual; fileBytes.set(relative, bytes);
  }
  const sourceMap = new Map(), contexts = new Map();
  for (const source of catalog.sources) {
    if (!object(source) || !string(source.id) || sourceMap.has(source.id) || !string(source.adapter) || !hex(source.sha256) || !hex(source.context_sha256)
      || verifiedFiles[source.context] !== source.context_sha256 || !Number.isInteger(source.occurrences) || source.occurrences < 0) fail("source catalog provenance or count is invalid");
    const context = JSON.parse(fileBytes.get(source.context));
    sourceMap.set(source.id, source); contexts.set(source.id, context);
    if (source.adapter === "qti-bundle") {
      if (!Array.isArray(context.items) || !object(context.stimuli)) fail("QTI bundle shape is unsupported");
      for (const member of [...context.items, ...Object.values(context.stimuli)]) verifyMember(member);
    }
  }
  const rows = fileBytes.get("questions.jsonl").toString("utf8").split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
  const covered = [], excluded = [], ids = new Set(), bySource = Object.fromEntries(catalog.sources.map((s) => [s.id, { total: 0, covered: 0, excluded: 0 }]));
  const byKind = {}, byRole = {}, byFamily = {};
  for (const row of rows) {
    if (!object(row) || !string(row.id) || ids.has(row.id) || !Array.isArray(row.occurrences) || !row.occurrences.length) fail("corpus row identity or occurrences are invalid");
    ids.add(row.id); byKind[row.kind] = (byKind[row.kind] ?? 0) + 1; byRole[row.role] = (byRole[row.role] ?? 0) + 1;
    const variants = [], rejected = [];
    for (const occurrence of row.occurrences) {
      const source = sourceMap.get(occurrence.source_id);
      if (!source) fail(`corpus row refers to an unknown source: ${occurrence.source_id}`);
      bySource[source.id].total++;
      try { variants.push(normalizeCorpusOccurrence(row, source, contexts.get(source.id), occurrence)); bySource[source.id].covered++; }
      catch (error) { rejected.push({ reason: error.message, provenance: sourceProvenance(source, occurrence) }); bySource[source.id].excluded++; }
    }
    if (variants.length) {
      variants.sort(variantSort);
      const primary = variants[0];
      covered.push({ ...primary, provenance: variants.flatMap((v) => v.provenance), variants, excluded_occurrences: rejected });
      byFamily[primary.family] = (byFamily[primary.family] ?? 0) + 1;
    } else excluded.push({ id: row.id, kind: row.kind, role: row.role, reasons: unique(rejected.map((r) => r.reason)), occurrences: rejected });
  }
  const occurrenceTotal = Object.values(bySource).reduce((n, x) => n + x.total, 0);
  if (rows.length !== catalog.counts.unique_examples || occurrenceTotal !== catalog.counts.source_occurrences || sourceMap.size !== catalog.counts.source_snapshots
    || canonical(byKind) !== canonical(catalog.counts.by_kind) || canonical(byRole) !== canonical(catalog.counts.by_role)) fail("corpus row, role, kind, occurrence or source totals do not reconcile with the catalog");
  for (const source of catalog.sources) if (bySource[source.id].total !== source.occurrences) fail(`source occurrence count does not reconcile: ${source.id}`);
  return { version: CORPUS_INTAKE_VERSION, hashes: { catalog_sha256: catalogHash, external_catalog_pin_verified: expectedCatalogSha256 !== undefined, files: verifiedFiles },
    // Mechanical tooling may inspect these already verified authored bytes. Never send them to a solver.
    raw_rows: rows, getContext: (occurrence) => {
      const source = sourceMap.get(occurrence?.source_id);
      if (!source || occurrence.context !== source.context) fail("context lookup does not match verified source provenance");
      return contexts.get(source.id);
    },
    covered, excluded, counts: { rows: rows.length, covered: covered.length, excluded: excluded.length, occurrences: occurrenceTotal,
      covered_occurrences: Object.values(bySource).reduce((n, x) => n + x.covered, 0), excluded_occurrences: Object.values(bySource).reduce((n, x) => n + x.excluded, 0),
      sources: sourceMap.size, by_source: bySource, by_kind: byKind, covered_by_family: byFamily },
    sources: catalog.sources.map((s) => ({ id: s.id, adapter: s.adapter, commit: s.commit ?? null, path: s.path, sha256: s.sha256,
      context: s.context, context_sha256: s.context_sha256, original_source_hash_status: "declared; original bytes were not inspected", context_hash_status: "verified retained bytes", omissions: clone(s.omissions ?? []) })),
    limitations: ["Catalog hashes verify retained byte integrity; without an external catalog pin they do not authenticate the catalog", "Original pre-redaction source bytes were not inspected",
      "Corpus rows, repeated source IDs, guided tasks and version variants are not independent mastery or accuracy measurements", "Coverage and source-only model signals remain academically unqualified"] };
}

/** Deterministic bounded plan; source/version, challenge and passage duplicates remain clustered. */
export function planRepresentativeScope(intake, { perStratum = 8, maxCandidates = 48, families, choiceOnly = true,
  pilotOnly = true, currentOnly = true, onePerContext = true, stratumFor } = {}) {
  if (!Number.isInteger(perStratum) || perStratum < 1 || !Number.isInteger(maxCandidates) || maxCandidates < 1) fail("representative limits must be positive integers");
  const sourceStratum = (candidate) => {
    if (candidate.family === "renderer") return `renderer/${/grade-(\d+)/.exec(candidate.provenance[0].source_path)?.[1] ?? "unknown-grade"}`;
    if (["reading-export", "qti-bundle"].includes(candidate.family)) return "reading-source-and-qti";
    return candidate.family === "animated" ? `animated/${candidate.kind}` : candidate.family;
  };
  const strata = new Map(), filtered = [];
  for (const sourceCandidate of [...intake.covered].sort((a, b) => a.id.localeCompare(b.id))) {
    if (families && !families.includes(sourceCandidate.family)) continue;
    const candidate = sourceCandidate;
    const stratum = stratumFor ? stratumFor(candidate) : sourceStratum(candidate);
    if (choiceOnly && !choiceKinds.has(candidate.item.kind)) { filtered.push({ id: candidate.id, stratum, reasons: ["not a single-choice operation"] }); continue; }
    if (choiceOnly && candidate.family === "animated" && candidate.kind !== "reading_mcq") { filtered.push({ id: candidate.id, stratum, reasons: ["animated non-passage choice is outside the text diagnostic"] }); continue; }
    if (!strata.has(stratum)) strata.set(stratum, []);
    const reasons = [];
    if (choiceOnly && !choiceKinds.has(candidate.item.kind)) reasons.push("not a single-choice operation");
    if (pilotOnly && !candidate.pilot_eligible) reasons.push(...candidate.unresolved_dependencies);
    if (currentOnly && ["renderer", "animated"].includes(candidate.family) && !candidate.variants?.some((v) => v.provenance[0].version_role === "current-main-at-intake")) reasons.push("no current-main source occurrence");
    if (reasons.length) { filtered.push({ id: candidate.id, stratum, reasons: unique(reasons) }); continue; }
    strata.get(stratum).push(candidate);
  }
  const selected = [], groups = new Set(), challenges = new Set(), contexts = new Set(), passages = new Set(), summaries = [];
  for (const [stratum, candidates] of [...strata].sort(([a], [b]) => a.localeCompare(b))) {
    let count = 0, duplicateSkips = 0;
    for (const c of candidates) {
      if (selected.length >= maxCandidates || count >= perStratum) break;
      if (groups.has(c.independence_group) || challenges.has(c.challenge_sha256) || (onePerContext && (contexts.has(c.context_group) || passages.has(c.passage_sha256)))) { duplicateSkips++; continue; }
      selected.push(c); groups.add(c.independence_group); challenges.add(c.challenge_sha256); contexts.add(c.context_group); passages.add(c.passage_sha256); count++;
    }
    summaries.push({ stratum, eligible_rows: candidates.length, selected: count, requested: perStratum, shortage: Math.max(0, perStratum - count), duplicate_skips: duplicateSkips });
  }
  return { version: CORPUS_INTAKE_VERSION, selected, strata: summaries, filtered, selected_rows: selected.length, selected_clusters: groups.size,
    selected_context_clusters: contexts.size, independence_status: "not established; lineage, equivalent challenge and context grouping avoid repeated source/version evidence",
    purpose: "bounded derived source-text development diagnostic; no invented gold or curriculum and no academic qualification" };
}
