// Deterministic checks of finished authored corpus fields. A pass is a field
// consistency result, never an academic or whole-question quality judgment.
export const CORPUS_CHECKS_VERSION = "authored-fields-v1";

const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const own = (v, k) => object(v) && Object.hasOwn(v, k);
const nonempty = (v) => typeof v === "string" && Boolean(v.trim());
const compact = (v) => String(v ?? "").replace(/\s+/gu, " ").trim();
const optionText = (v) => typeof v === "string" ? v : v?.text;
const duplicates = (values) => [...new Set(values.filter((v, i) => values.indexOf(v) !== i))];
const sameBag = (a, b) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);
const textArray = (v) => Array.isArray(v) && v.length > 0 && v.every(nonempty);

export function atPointer(value, pointer = "") {
  if (pointer === "") return value;
  if (typeof pointer !== "string" || !pointer.startsWith("/")) return undefined;
  for (const token of pointer.slice(1).split("/")) {
    const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return value;
}

function decodeXml(s) {
  return s.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (full, entity) => {
    if (entity[0] === "#") {
      const n = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : full;
    }
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[entity.toLowerCase()];
  });
}

// A deliberately limited XML reader, without entity resolution or external I/O.
// Unknown XML constructs abstain; QTI decisions never rely on the extracted view.
function xmlTree(xml) {
  if (typeof xml !== "string" || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("Unsupported XML declaration");
  const root = { name: "root", attrs: {}, children: [] }, stack = [root];
  const tokens = xml.match(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]*>|[^<]+/g) || [];
  for (const token of tokens) {
    if (token.startsWith("<!--") || token.startsWith("<?")) continue;
    if (token.startsWith("<![CDATA[")) { stack.at(-1).children.push(token.slice(9, -3)); continue; }
    if (token.startsWith("</")) {
      const name = token.slice(2, -1).trim();
      if (stack.length === 1 || stack.at(-1).name !== name) throw new Error("Unbalanced XML");
      stack.pop();
    } else if (token.startsWith("<")) {
      const match = /^<([\w:.-]+)([\s\S]*?)\/?\s*>$/.exec(token);
      if (!match) throw new Error("Unsupported XML element");
      const attrs = {};
      for (const a of match[2].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = decodeXml(a[2] ?? a[3]);
      const node = { name: match[1], attrs, children: [] };
      stack.at(-1).children.push(node);
      if (!/\/\s*>$/.test(token)) stack.push(node);
    } else stack.at(-1).children.push(decodeXml(token));
  }
  if (stack.length !== 1) throw new Error("Unclosed XML");
  return root;
}
const localName = (n) => n.name.split(":").at(-1);
function elements(node, name) {
  const out = [];
  for (const c of node.children) if (typeof c !== "string") {
    if (localName(c) === name) out.push(c);
    out.push(...elements(c, name));
  }
  return out;
}
function xmlText(node) { return node.children.map((c) => typeof c === "string" ? c : xmlText(c)).join(""); }

function collectStimulusNodes(value, output) {
  if (Array.isArray(value)) { value.forEach((v) => collectStimulusNodes(v, output)); return; }
  if (!object(value)) return;
  if (value.type === "passage" && Array.isArray(value.paragraphs)) {
    output.push(...value.paragraphs.filter(nonempty));
    return;
  }
  if (value.type === "reading" && Array.isArray(value.blocks)) {
    for (const block of value.blocks) {
      if (nonempty(block.text)) output.push(block.text);
      if (Array.isArray(block.lines)) output.push(...block.lines.map((line) => typeof line === "string" ? line : line?.line).filter(nonempty));
    }
    return;
  }
  for (const child of Object.values(value)) if (typeof child === "object") collectStimulusNodes(child, output);
}

function stimuliFor(row, getContext) {
  const stimuli = [];
  if (nonempty(row.native?.passage)) stimuli.push({ text: row.native.passage, field: "/native/passage", complete_native_passage: true });
  const errors = [];
  for (const occurrence of row.occurrences || []) {
    if (typeof getContext !== "function") continue;
    let context;
    try { context = getContext(occurrence); } catch (error) { errors.push(String(error.message || error)); continue; }
    if (!context) { errors.push(`Context unavailable: ${occurrence.context}`); continue; }
    if (row.native?.xml) {
      let ids = [];
      try { ids = elements(xmlTree(row.native.xml), "qti-assessment-stimulus-ref").map((node) => node.attrs.identifier); } catch { /* handled in QTI checks */ }
      for (const id of ids) {
        const entry = context.stimuli?.[id];
        if (nonempty(entry?.xml)) {
          try { stimuli.push({ text: xmlText(xmlTree(entry.xml)), field: `/stimuli/${id}/xml`, occurrence, complete_native_passage: true }); }
          catch { errors.push(`Stimulus XML unavailable: ${id}`); }
        } else errors.push(`Referenced stimulus unavailable: ${id}`);
      }
    } else {
      const scope = atPointer(context, occurrence.context_pointer);
      const text = [];
      if (Array.isArray(scope?.passage)) for (const section of scope.passage) if (Array.isArray(section.paras)) text.push(...section.paras.filter(nonempty));
      collectStimulusNodes(scope, text);
      // Animated page contexts identify the question's page, while reading is
      // held on other pages. Collect only explicit reading nodes from the packet.
      if (!text.length && String(occurrence.source_id).startsWith("animated-")) collectStimulusNodes(context.pages, text);
      if (text.length) stimuli.push({ text: text.join("\n"), field: occurrence.context_pointer || "", occurrence, complete_native_passage: false });
    }
  }
  return { stimuli, errors };
}

function textFields(value, prefix = "/native") {
  if (typeof value === "string") return [{ field: prefix, text: value }];
  if (Array.isArray(value)) return value.flatMap((child, i) => textFields(child, `${prefix}/${i}`));
  if (!object(value)) return [];
  return Object.entries(value).filter(([key]) => !/voiceover|audio|path|sha256|git_blob|xml|passage/.test(key))
    .flatMap(([key, child]) => textFields(child, `${prefix}/${key}`));
}

function quotedSpans(fields) {
  return fields.flatMap(({ field, text }) => [...text.matchAll(/“([^”\n]+)”|"([^"\n]+)"/gu)]
    .map((m) => ({ field, quote: m[1] ?? m[2] })).filter(({ quote }) => compact(quote).split(" ").length >= 3 && !/_{2,}|\[|\]|\.\.\.|…/.test(quote)));
}

function checkQuotes(row, add, getContext) {
  const native = row.native, explicit = [];
  if (object(native)) {
    for (const key of ["quote_from", "candidates", "decoys", "strong"]) if (Array.isArray(native[key])) {
      native[key].forEach((quote, i) => { if (nonempty(quote)) explicit.push({ field: `/native/${key}/${i}`, quote }); });
    }
  }
  let fields = textFields(native);
  if (nonempty(native?.xml)) {
    try {
      const tree = xmlTree(native.xml);
      fields = ["qti-prompt", "qti-simple-choice", "qti-hottext", "qti-inline-choice", "qti-simple-associable-choice"]
        .flatMap((name) => elements(tree, name).map((node, i) => ({ field: `/native/xml/${name}/${i}`, text: xmlText(node) })));
    } catch { /* Unsupported XML has its own unknown result. */ }
  }
  const spans = quotedSpans(fields);
  const quotes = [...explicit, ...spans];
  if (!quotes.length) { add("quotes_in_supplied_stimulus", "not_applicable", "/native", "No explicit quoted spans or copy fields to compare."); return; }
  const { stimuli, errors } = stimuliFor(row, getContext);
  if (!stimuli.length) { add("quotes_in_supplied_stimulus", "unknown", "/native", "No recoverable source stimulus for literal comparison.", { quotes: quotes.length, context_errors: errors }); return; }
  const texts = stimuli.map(({ text }) => compact(text));
  const missing = quotes.filter(({ quote }) => !texts.some((text) => text.includes(compact(quote))));
  add("quotes_in_supplied_stimulus", missing.length ? "flag" : "pass", "/native", missing.length
    ? "Quoted text is absent verbatim from the recovered stimulus. It may be an instructional label, alternative answer or partial source; source corruption is not established."
    : "Quoted text occurs verbatim in the recovered stimulus; learner exposure and attribution are unverified.",
  { compared: quotes.length, missing, whitespace_only_normalization: true, sources: stimuli.map(({ field, occurrence, complete_native_passage }) => ({ field, occurrence, complete_native_passage })), context_errors: errors });
}

function checkOptions(options, field, add, { idKey = "id", collisionScope = "authored_field" } = {}) {
  if (!Array.isArray(options)) { add("options_shape", "fail", field, "Declared options are not an array."); return { valid: false, ids: [], texts: [], collision: false }; }
  const texts = options.map(optionText);
  add("options_shape", !options.length ? "unknown" : texts.every(nonempty) ? "pass" : "fail", field, "Fixed options contain nonempty text; an empty table may be populated dynamically.", { count: options.length, invalid_indices: texts.map((s, i) => nonempty(s) ? null : i).filter((v) => v !== null) });
  const ids = options.map((o) => object(o) ? o[idKey] : undefined);
  if (ids.some((id) => id !== undefined)) {
    const missing = ids.map((id, i) => nonempty(id) ? null : i).filter((v) => v !== null);
    const repeated = duplicates(ids.filter((id) => id !== undefined));
    add("option_ids_unique", missing.length || repeated.length ? "fail" : "pass", field, "Identifiers are checked within the declared option list.", { duplicate_ids: repeated, missing_indices: missing, defect_scope: collisionScope });
  } else add("option_ids_unique", "not_applicable", field, "Options use positions or literal text instead of declared identifiers.");
  const repeated = duplicates(texts.filter(nonempty).map(compact));
  add("option_texts_distinct", repeated.length ? "fail" : "pass", field, "Literal duplicate option text only; semantic equivalence is unassessed.", { duplicate_texts: repeated, defect_scope: collisionScope });
  return { valid: options.length > 0 && texts.every(nonempty), ids, texts, collision: duplicates(ids.filter((id) => id !== undefined)).length > 0 };
}

function cue(options, keyedIndices, field, add) {
  const lengths = options.map((o) => compact(optionText(o)).length);
  const valid = keyedIndices.length === 1 && Number.isInteger(keyedIndices[0]) && keyedIndices[0] >= 0 && keyedIndices[0] < options.length;
  if (!valid || options.length < 3) { add("key_position_and_length", "not_applicable", field, "No resolved single key among at least three options."); return; }
  const key = keyedIndices[0], others = lengths.filter((_, i) => i !== key);
  const longest = lengths[key] > Math.max(...others);
  add("key_position_and_length", longest ? "flag" : "pass", field, "Unique longest key is a conditional cue for review, never a quality defect. Key position is instrumentation only.", { key_index: key, option_count: options.length, character_lengths: lengths, unique_longest_key: longest });
}

function indexedChoice(native, options, keyField, field, add, multiple = false) {
  checkOptions(options, field, add);
  if (!own(native, keyField)) { add("authored_key", "unknown", `/native/${keyField}`, "No declared answer; an intentionally formative activity is not malformed."); return; }
  const raw = native[keyField], values = multiple ? raw : [raw];
  const valid = Array.isArray(values) && values.length > 0 && values.every((i) => Number.isInteger(i) && i >= 0 && i < options.length) && !duplicates(values).length;
  add("key_indices_valid", valid ? "pass" : "fail", `/native/${keyField}`, "Declared numeric key indices must be integers in range, without duplicates.", { key: raw, option_count: options.length });
  if (valid) cue(options, values, field, add);
}

function keyedStrings(native, options, add, kind) {
  const exported = own(native, "item_id") && own(native, "passage");
  const checked = checkOptions(options, "/native/options", add, { collisionScope: exported ? "source_export_representation" : "authored_field" });
  if (!own(native, "correct")) { add("authored_key", "unknown", "/native/correct", "No declared answer."); return; }
  const keys = native.correct;
  if (Array.isArray(keys) && !keys.length) { add("authored_key", "unknown", "/native/correct", "Empty key may be intentionally formative; no answer is inferred."); return; }
  if (!textArray(keys)) { add("key_values_shape", "fail", "/native/correct", "Declared identifier key must be an array of nonempty strings."); return; }
  if (kind === "sequence" || native.type === "order") {
    add("sequence_key_permutation", checked.collision ? "unknown" : sameBag(keys, checked.ids) ? "pass" : "fail", "/native/correct", "An ordered key must use every declared option ID exactly once.", { key: keys, offered_ids: checked.ids });
    return;
  }
  if (kind === "matching" || native.type === "match") {
    const valid = keys.every((key) => key.trim().split(/\s+/).length === 2 && key.trim().split(/\s+/).every((id) => checked.ids.includes(id))) && !duplicates(keys).length;
    add("match_pair_membership", checked.collision ? "unknown" : valid ? "pass" : "fail", "/native/correct", "Both identifiers in each declared pair must exist. Export does not preserve match-set orientation or reuse limits.", { pairs: keys, offered_ids: checked.ids });
    add("match_set_constraints", "unknown", "/native/options", "The export lacks QTI match sets and per-choice reuse constraints.");
    return;
  }
  const single = kind === "multiple_choice" || kind === "hot_text";
  add("key_membership", checked.collision ? "unknown" : keys.every((id) => checked.ids.includes(id)) && !duplicates(keys).length ? "pass" : "fail", "/native/correct", checked.collision ? "Duplicate exported IDs obscure interaction boundaries; cannot resolve the intended answer uniquely." : "Declared key IDs occur in the offered list without duplicate key values.", { keys, offered_ids: checked.ids });
  add("key_cardinality", checked.collision ? "unknown" : single && keys.length !== 1 ? "fail" : "pass", "/native/correct", checked.collision ? "Flattened option collisions do not establish per-interaction cardinality." : single ? "This source format declares one answer." : "Multiple selection allows a nonempty key; no exact selection count is inferred from prose.", { count: keys.length });
  if (!checked.collision && options.every((o) => typeof o?.key === "boolean")) {
    const flags = options.filter((o) => o.key).map((o) => o.id);
    add("key_flags_agree", sameBag(keys, flags) ? "pass" : "fail", "/native/options", "Boolean key flags agree with the explicit key list.", { correct: keys, flagged: flags });
  }
  if (!checked.collision) cue(options, keys.map((id) => checked.ids.indexOf(id)), "/native/options", add);
}

function qtiChecks(row, add) {
  let tree;
  try { tree = xmlTree(row.native.xml); }
  catch (error) { add("qti_parse", "unknown", "/native/xml", error.message); return; }
  const declarations = elements(tree, "qti-response-declaration");
  const ids = declarations.map((d) => d.attrs.identifier);
  add("qti_response_ids_unique", duplicates(ids).length ? "fail" : "pass", "/native/xml", "Response declarations require distinct identifiers.", { duplicate_ids: duplicates(ids) });
  const names = ["qti-choice-interaction", "qti-hottext-interaction", "qti-order-interaction", "qti-match-interaction", "qti-inline-choice-interaction"];
  const interactions = names.flatMap((name) => elements(tree, name));
  if (!interactions.length) { add("qti_interaction_support", "unknown", "/native/xml", "No supported discrete response interaction. Formative text responses need a separate scoring contract."); return; }
  for (let i = 0; i < interactions.length; i++) {
    const interaction = interactions[i], name = localName(interaction), response = interaction.attrs["response-identifier"];
    const field = `/native/xml/interaction/${i}:${response}`;
    const declared = declarations.filter((d) => d.attrs.identifier === response);
    if (declared.length !== 1) { add("qti_response_binding", "fail", field, "Interaction must bind to exactly one declared response.", { response_identifier: response, declarations: declared.length }); continue; }
    const declaration = declared[0], correct = elements(declaration, "qti-correct-response");
    const values = correct.flatMap((node) => elements(node, "qti-value").map((v) => compact(xmlText(v))));
    const tag = name === "qti-hottext-interaction" ? "qti-hottext" : name === "qti-match-interaction" ? "qti-simple-associable-choice" : name === "qti-inline-choice-interaction" ? "qti-inline-choice" : "qti-simple-choice";
    const choices = elements(interaction, tag), offered = choices.map((c) => ({ identifier: c.attrs.identifier, text: compact(xmlText(c)) }));
    const checked = checkOptions(offered, field, add, { idKey: "identifier" });
    if (!values.length) { add("authored_key", "unknown", field, "No declared correct response; absence alone does not make a formative item malformed."); continue; }
    const cardinality = declaration.attrs.cardinality;
    add("qti_key_cardinality", cardinality === "single" ? values.length === 1 ? "pass" : "fail" : ["multiple", "ordered"].includes(cardinality) ? "pass" : "unknown", field, "Checks the authored QTI cardinality without interpreting the question's meaning.", { cardinality, values });
    const expectedBase = name === "qti-match-interaction" ? "directedPair" : "identifier";
    add("qti_response_base_type", declaration.attrs["base-type"] === expectedBase ? "pass" : "fail", field, "The response base type must fit the declared discrete interaction.", { declared: declaration.attrs["base-type"], expected: expectedBase });
    if (name === "qti-match-interaction") {
      const sets = elements(interaction, "qti-simple-match-set").map((set) => elements(set, tag).map((c) => c.attrs.identifier));
      if (sets.length !== 2) { add("qti_match_sets", "unknown", field, "Only a declared pair of match sets is supported.", { sets }); continue; }
      const pairs = values.map((value) => value.split(/\s+/));
      const bad = pairs.filter((pair) => pair.length !== 2 || !sets[0].includes(pair[0]) || !sets[1].includes(pair[1]));
      add("match_pair_membership", checked.collision || bad.length || duplicates(values).length ? "fail" : "pass", field, "Directed pair keys must belong to first and second match sets, in that order.", { invalid_pairs: bad, duplicate_pairs: duplicates(values) });
      const off = [];
      for (const choice of choices) {
        const used = pairs.filter((pair) => pair.includes(choice.attrs.identifier)).length;
        for (const [attribute, relation] of [["match-max", "max"], ["match-min", "min"]]) if (own(choice.attrs, attribute)) {
          const limit = Number(choice.attrs[attribute]);
          if (!Number.isInteger(limit) || limit < 0 || (relation === "max" && limit > 0 && used > limit) || (relation === "min" && used < limit)) off.push({ identifier: choice.attrs.identifier, attribute, limit, keyed_uses: used });
        }
      }
      add("qti_match_reuse_limits", off.length ? "fail" : "pass", field, "Checks only declared match-min/match-max constraints; zero maximum means unlimited.", { off });
    } else if (name === "qti-order-interaction") {
      add("sequence_key_permutation", checked.collision || !sameBag(values, checked.ids) ? "fail" : "pass", field, "Ordered QTI key is a permutation of the offered choice identifiers.", { values, offered_ids: checked.ids });
      if (cardinality !== "ordered") add("qti_order_cardinality", "fail", field, "Order interaction requires an ordered response declaration.", { cardinality });
    } else {
      add("key_membership", checked.collision || values.some((value) => !checked.ids.includes(value)) || duplicates(values).length ? "fail" : "pass", field, "Correct identifiers must belong to this interaction, not another interaction using the same labels.", { values, offered_ids: checked.ids });
      cue(offered, values.map((value) => checked.ids.indexOf(value)), field, add);
    }
    const maxAttr = name === "qti-match-interaction" ? "max-associations" : "max-choices";
    const minAttr = name === "qti-match-interaction" ? "min-associations" : "min-choices";
    for (const attribute of [minAttr, maxAttr]) if (own(interaction.attrs, attribute) || (attribute === maxAttr && name !== "qti-order-interaction" && name !== "qti-inline-choice-interaction")) {
      const limit = Number(interaction.attrs[attribute] ?? 1), max = attribute === maxAttr;
      const valid = Number.isInteger(limit) && limit >= 0 && (max ? limit === 0 || values.length <= limit : values.length >= limit);
      add("qti_selection_limit", valid ? "pass" : "fail", field, "Selection limits must admit the authored correct response; omitted maximum defaults to one and zero maximum means unlimited.", { attribute, limit, key_count: values.length, default_used: !own(interaction.attrs, attribute) });
    }
  }
}

function rubricChecks(native, add) {
  const rubrics = [];
  if (own(native, "criteria")) rubrics.push({ value: native, field: "/native" });
  if (own(native, "assessment")) rubrics.push({ value: native.assessment, field: "/native/assessment" });
  for (const { value, field } of rubrics) {
    if (!object(value)) { add("rubric_shape", "fail", field, "Declared assessment is not an object."); continue; }
    if (own(value, "criteria")) {
      const criteria = value.criteria;
      const valid = Array.isArray(criteria) && criteria.every((c) => object(c) && nonempty(c.requirement));
      add("rubric_requirements", Array.isArray(criteria) && !criteria.length ? "unknown" : valid ? "pass" : "fail", `${field}/criteria`, "Checks explicit criterion requirement fields; fulfillment and scoring meaning are unassessed.", { criteria_count: Array.isArray(criteria) ? criteria.length : null });
      if (Array.isArray(criteria)) {
        const ids = criteria.map((c) => c?.id).filter((id) => id !== undefined);
        add("criterion_ids_unique", duplicates(ids).length ? "fail" : "pass", `${field}/criteria`, "Declared criterion identifiers do not collide.", { duplicate_ids: duplicates(ids) });
        criteria.forEach((c, i) => { if (own(c, "accept")) add("accepted_answers_shape", Array.isArray(c.accept) && !c.accept.length ? "unknown" : textArray(c.accept) ? "pass" : "fail", `${field}/criteria/${i}/accept`, "Declared accepted examples are strings; empty lists may be dynamic or intentionally open, and correctness is unassessed."); });
        if (own(value, "pass_threshold")) add("rubric_threshold", Number.isInteger(value.pass_threshold) && value.pass_threshold > 0 && value.pass_threshold <= criteria.length ? "pass" : "flag", `${field}/pass_threshold`, "Threshold is compared to listed criteria only; weighting and runtime scoring are unverified.", { threshold: value.pass_threshold, criteria_count: criteria.length });
      }
    } else add("rubric_requirements", "unknown", field, "Assessment has no structured criteria; prose may supply the scoring guidance.");
    add("reveal_present", !own(value, "reveal") || value.reveal === "" || value.reveal === null ? "unknown" : nonempty(value.reveal) ? "pass" : "fail", `${field}/reveal`, "Reports the declared reveal field; absent or empty reveals may be supplied dynamically or intentionally omitted.");
  }
  if (!rubrics.length && own(native, "reveal")) add("reveal_present", native.reveal === "" || native.reveal === null ? "unknown" : nonempty(native.reveal) ? "pass" : "fail", "/native/reveal", "Declared reveal contains text; empty reveal is not a quality fault and meaning is unassessed.");
  for (const key of ["accept", "expects"]) if (own(native, key)) add("accepted_answers_shape", Array.isArray(native[key]) && !native[key].length ? "unknown" : textArray(native[key]) ? "pass" : "fail", `/native/${key}`, "Author's accepted or expected answer fields contain strings; empty lists and independent validity are unassessed.");
}

function jsonChecks(row, add) {
  const native = row.native;
  if (!object(native)) return;
  const kind = row.kind;
  if (Array.isArray(native.options) && own(native, "correct") && Array.isArray(native.correct) && native.options.some((o) => object(o) && own(o, "id"))) keyedStrings(native, native.options, add, kind);
  else if (own(native, "choices")) {
    const options = native.choices;
    checkOptions(options, "/native/choices", add);
    if (Array.isArray(options)) {
      const declared = options.every((o) => typeof o?.correct === "boolean"), keys = options.map((o, i) => o?.correct === true ? i : null).filter((i) => i !== null);
      add("key_flags_shape", declared ? "pass" : "fail", "/native/choices", "Each declared correct flag must be a boolean.");
      if (declared) {
        add("key_cardinality", !keys.length ? "unknown" : keys.length === 1 ? "pass" : "fail", "/native/choices", "This JSON choice format has one intended answer; no flagged answer is left unknown for formative use.", { keyed_indices: keys });
        cue(options, keys, "/native/choices", add);
      }
    }
  } else if (Array.isArray(native.options)) {
    const keyField = ["answer_index", "correct_indices", "correct_index"].find((key) => own(native, key));
    if (keyField) indexedChoice(native, native.options, keyField, "/native/options", add, keyField === "correct_indices");
    else if (Number.isInteger(native.correct) || Number.isInteger(native.answer)) indexedChoice(native, native.options, Number.isInteger(native.correct) ? "correct" : "answer", "/native/options", add);
    else if (own(native, "correct") || own(native, "answer")) {
      checkOptions(native.options, "/native/options", add);
      const field = own(native, "correct") ? "correct" : "answer", keys = Array.isArray(native[field]) ? native[field] : [native[field]], texts = native.options.map(optionText);
      add("slot_key_membership", textArray(keys) && keys.every((key) => texts.includes(key)) ? "pass" : "fail", `/native/${field}`, "Literal slot keys must be among the offered option texts.", { keys, offered: texts });
      cue(native.options, keys.map((key) => texts.indexOf(key)), "/native/options", add);
    } else if (!own(native, "correct_option_for_prompt")) { checkOptions(native.options, "/native/options", add); add("authored_key", "unknown", "/native", "Options have no declared intended answer."); }
  }
  for (const field of ["sentences", "first_lines"]) if (Array.isArray(native[field])) {
    const keyField = own(native, "correct_indices") ? "correct_indices" : own(native, "correct_index") ? "correct_index" : null;
    if (keyField) indexedChoice(native, native[field], keyField, `/native/${field}`, add, keyField === "correct_indices");
  }
  if (own(native, "correct_order")) {
    const valid = textArray(native.items) && textArray(native.correct_order) && sameBag(native.items, native.correct_order);
    if (Array.isArray(native.items)) checkOptions(native.items, "/native/items", add);
    add("sequence_key_permutation", valid ? "pass" : "fail", "/native/correct_order", "Literal sequence key must be a permutation of the offered items.", { key: native.correct_order, offered: native.items });
  }
  if (own(native, "correct_option_for_prompt")) {
    const options = native.options, prompts = native.prompts, keys = native.correct_option_for_prompt;
    if (Array.isArray(options)) checkOptions(options, "/native/options", add);
    const valid = Array.isArray(options) && Array.isArray(prompts) && Array.isArray(keys) && keys.length === prompts.length && keys.every((key) => Number.isInteger(key) && key >= 0 && key < options.length);
    add("match_pair_membership", valid ? "pass" : "fail", "/native/correct_option_for_prompt", "Each declared prompt has an in-range option index. No unrequested one-to-one mapping is assumed.", { key: keys, prompt_count: prompts?.length, option_count: options?.length });
  }
  if (Array.isArray(native.segments)) native.segments.forEach((segment, i) => {
    if (segment?.kind !== "blank") return;
    const options = segment.options ?? native.bank, field = `/native/segments/${i}`;
    if (!Array.isArray(options)) { add("slot_key_membership", "unknown", field, "Blank has no fixed offered options or bank."); return; }
    checkOptions(options, `${field}/options`, add);
    add("slot_key_membership", own(segment, "answer") ? nonempty(segment.answer) && options.includes(segment.answer) ? "pass" : "fail" : "unknown", `${field}/answer`, "Declared blank answer must occur in its local options or shared bank.", { answer: segment.answer, offered: options });
  });
  if (Array.isArray(native.statements)) {
    add("true_false_keys", native.statements.every((s) => nonempty(s.text) && ["true", "not_true"].includes(s.verdict)) ? "pass" : "fail", "/native/statements", "Checks the source's True / Not true declarations; factual truth is unassessed.");
  }
  if (kind === "classify") {
    if (!Array.isArray(native.words) || !object(native.boxes)) add("classifier_destinations", "unknown", "/native", "No fixed word and destination tables.");
    else {
      const invalid = native.words.filter((w) => !nonempty(w.w) || !object(native.boxes[w.to]) || !nonempty(native.boxes[w.to][w.kind]));
      add("classifier_destinations", invalid.length ? "fail" : "pass", "/native/words", "Every declared destination and category has an offered box label.", { invalid });
      const off = [];
      for (const [who, box] of Object.entries(native.boxes)) for (const category of ["is", "seems", "wanted"]) {
        const slotField = category === "is" ? "slots" : `${category}_slots`;
        if (!own(box, slotField)) continue;
        const count = native.words.filter((w) => w.to === who && w.kind === category).length;
        if (box[slotField] !== count) off.push({ destination: who, category, declared_slots: box[slotField], keyed_words: count });
      }
      add("classifier_declared_counts", off.length ? "flag" : "pass", "/native/boxes", "Declared slots compared with keyed words. A mismatch needs runtime evidence that slots mean an exact required count, rather than capacity.", { off });
    }
  }
  if (kind === "evidence_select" && Array.isArray(native.candidates) && Array.isArray(native.decoys)) {
    const overlap = native.candidates.filter((c) => native.decoys.includes(c));
    add("evidence_pools_disjoint", overlap.length ? "fail" : "pass", "/native", "Candidate and decoy pools have no literal overlap. Learner-visible selection and evidential relevance are unverified.", { overlap });
  }
  for (const part of ["part_a", "part_b"]) if (object(native[part])) jsonChecks({ ...row, native: native[part], kind: "ebsr_part" }, (id, status, field, detail, evidence) => add(id, status, field.replace("/native", `/native/${part}`), detail, evidence));
  rubricChecks(native, add);
}

export function checkCorpusRow(row, { getContext } = {}) {
  const checks = [];
  const add = (check_id, status, field, detail, evidence = {}) => checks.push({ check_id, status, field, detail, evidence });
  const source_format = typeof row.native?.xml === "string" ? "qti_xml" : Array.isArray(row.native) ? "authored_array" : object(row.native) ? "authored_json" : "authored_text";
  if (source_format === "qti_xml") qtiChecks(row, add); else jsonChecks(row, add);
  checkQuotes(row, add, getContext);
  const answerChecks = checks.filter((c) => !["quotes_in_supplied_stimulus", "key_position_and_length", "options_shape", "option_ids_unique", "option_texts_distinct"].includes(c.check_id));
  if (!answerChecks.length) add("authored_answer_support", row.role === "question" || row.role === "subcheck" ? "unknown" : "not_applicable", "/native", "No supported explicit answer contract. Source prompts, guided tasks, models, recall activities and scaffolds are not inferred to be malformed or independent mastery measures.");
  add("semantic_quality", "unknown", "/native", "Answer meaning, alternatives, pedagogy, learner exposure and whole-item quality are unassessed; no human labels or model calls are used.");
  const counts = Object.fromEntries(["pass", "fail", "flag", "unknown", "not_applicable"].map((status) => [status, checks.filter((c) => c.status === status).length]));
  return { id: row.id, kind: row.kind, role: row.role, occurrences: row.occurrences || [], source_format, checks, coverage: { ...counts, answer_contract_checked: answerChecks.some((c) => ["pass", "fail", "flag"].includes(c.status)), semantic_quality: "unknown", academic_approval: false } };
}

export function checkCorpusRows(rows, options = {}) {
  if (!Array.isArray(rows)) throw new TypeError("Corpus rows must be an array");
  return rows.map((row) => checkCorpusRow(row, options));
}
