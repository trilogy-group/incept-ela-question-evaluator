// Private report observations only. This module never emits checks, verdicts, prompts or source-attribution judgments.
import crypto from "node:crypto";

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const list = value => Array.isArray(value) ? value : [];
const sha = text => crypto.createHash("sha256").update(text).digest("hex");
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const letter = value => typeof value === "string" && /[\p{L}\p{N}]/u.test(value);
const pointerPart = value => String(value).replace(/~/g, "~0").replace(/\//g, "~1");
const typography = value => value.normalize("NFC").replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"').replace(/[\s\u00a0]+/g, " ").trim();
const words = value => typography(value).toLowerCase().match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu) ?? [];
const elision = (text, index) => /^(?:tis|twas|twere|twill|em|cause|gainst|neath|fore|round|bout|til)\b/i.test(text.slice(index + 1));

function spansIn(text) {
  const spans = [], notes = [];
  let open = null;
  for (let index = 0; index < text.length; index++) {
    const mark = text[index], single = ["'", "‘", "’"].includes(mark), double = ['"', "“", "”"].includes(mark);
    if (!single && !double) continue;
    if (single && letter(text[index - 1]) && letter(text[index + 1])) continue;
    if (!open) {
      if (single && (letter(text[index - 1]) || elision(text, index))) { notes.push({ index, kind: "apostrophe_or_elision" }); continue; }
      if (["’", "”"].includes(mark)) { notes.push({ index, kind: "unpaired_closing_mark" }); continue; }
      open = { index, single, mark }; continue;
    }
    if (single !== open.single || ["‘", "“"].includes(mark)) continue;
    if (single && elision(text, index) && /\s/.test(text[index - 1] ?? "")) continue;
    const raw = text.slice(open.index + 1, index);
    const ambiguity = single && /s$/i.test(raw) && /^\s+[\p{L}]/u.test(text.slice(index + 1)) && /['’]/.test(text.slice(index + 1))
      ? "possible_plural_possessive_or_closing_quote" : null;
    spans.push({ start: open.index, end: index + 1, offset_unit: "UTF-16 code units", delimiter: open.mark, raw, ambiguity });
    open = null;
  }
  if (open) notes.push({ index: open.index, kind: "unclosed_quoted_span" });
  return { spans, notes };
}

function literalPosition(source, span) {
  let index = source.indexOf(span);
  while (index >= 0) {
    if ((!letter(span[0]) || !letter(source[index - 1])) && (!letter(span.at(-1)) || !letter(source[index + span.length]))) return index;
    index = source.indexOf(span, index + 1);
  }
  return -1;
}
function wordPosition(source, span, start = 0) {
  if (!span.length) return -1;
  for (let index = start; index <= source.length - span.length; index++) if (span.every((word, offset) => source[index + offset] === word)) return index;
  return -1;
}
function framing(text, span) {
  const prefix = text.slice(Math.max(0, span.start - 160), span.start), sentence = prefix.split(/[.!?]\s+/).at(-1);
  if (/\b(?:in other words|paraphras\w*|means|might say|imagine|as if)\b/i.test(sentence)) return "interpretive_or_hypothetical_frame";
  if (/\b(?:does not|doesn't|never|did not|didn't)\s+(?:say|state|write|declare)\s*(?:that\s*)?$/i.test(prefix)) return "negated_frame";
  if (/\?\s*$/.test(text)) return "question_frame";
  if (/\b(?:word|term|label|button|heading)\s*$/i.test(prefix)
    || /^\s*(?:use|choose|select|write|label)\b/i.test(text) && /\b(?:labels|headings|buttons|planning)\b/i.test(text)) return "label_or_term_frame";
  if (/\b(?:says?|states?|declares?|writes?)\s*(?:that\s*)?,?\s*$/i.test(prefix)) return "attribution_cue_in_candidate_only";
  return "undetermined";
}
function compare(span, source) {
  if (!span.raw.trim()) return { class: "empty_quoted_span", comparison_performed: false };
  if (span.ambiguity) return { class: "delimiter_ambiguous", comparison_performed: false };
  if (typeof source !== "string" || !source.trim()) return { class: "source_unavailable", comparison_performed: false };
  if (/_{2,}|\[[^\]]*blank[^\]]*\]/i.test(span.raw)) return { class: "template_markers_present", comparison_performed: false };
  const rawPosition = literalPosition(source, span.raw);
  if (/\.\.\.|…/.test(span.raw)) {
    const segments = span.raw.split(/\.\.\.|…/).map(words).filter(segment => segment.length), positions = [];
    const sourceWords = words(source);
    let cursor = 0;
    for (const segment of segments) { const position = wordPosition(sourceWords, segment, cursor); positions.push(position); if (position < 0) break; cursor = position + segment.length; }
    return { class: segments.length > 0 && positions.length === segments.length && positions.every(position => position >= 0)
      ? "ellipsis_segments_found_in_order" : "ellipsis_segments_not_found_in_order", comparison_performed: true, segments, word_positions: positions,
    literal_span_position: rawPosition, omitted_meaning: "undetermined", segment_adjacency: "undetermined" };
  }
  if (rawPosition >= 0) return { class: "raw_source_span_found", comparison_performed: true, source_position: rawPosition, source_offset_unit: "UTF-16 code units" };
  const normalizedPosition = literalPosition(typography(source), typography(span.raw));
  if (normalizedPosition >= 0) return { class: "typography_normalized_source_span_found", comparison_performed: true,
    normalization: "NFC, quote/apostrophe glyphs and whitespace only; not byte equality" };
  const spanWords = words(span.raw), position = wordPosition(words(source), spanWords);
  if (!spanWords.length) return { class: "no_word_sequence", comparison_performed: false };
  return { class: position >= 0 ? "word_sequence_found_with_other_differences" : "word_sequence_absent_from_supplied_text", comparison_performed: true,
    words: spanWords, source_word_position: position, normalization: "Case folded word sequences retain internal apostrophes; punctuation/meaning are not certified" };
}

function feedbackFields(view, itemIndex) {
  const fields = [], skipped = [], base = `/items/${itemIndex}/view`, add = (pointer, role, value) => {
    if (typeof value === "string") fields.push({ pointer, role, text: value });
    else if (value !== undefined && value !== null) skipped.push({ pointer, role, reason: "Non-string feedback requires an explicit text interpreter" });
  };
  if (Array.isArray(view.option_feedback)) view.option_feedback.forEach((text, index) => add(`${base}/option_feedback/${index}`, "candidate_option_feedback", text));
  if (object(view.entry_feedback)) for (const [entry, text] of Object.entries(view.entry_feedback)) add(`${base}/entry_feedback/${pointerPart(entry)}`, "candidate_entry_feedback", text);
  add(`${base}/correct_feedback`, "candidate_correct_feedback", view.correct_feedback);
  add(`${base}/feedback`, "candidate_general_feedback", view.feedback);
  return { fields, skipped };
}
function matchingCase(item, plan) {
  const matches = list(plan.cases).flatMap((candidate, index) => candidate?.order === item.order ? [{ candidate, index }] : []);
  if (matches.length !== 1) return { candidate: null, index: null, status: "declared_order_missing_or_ambiguous" };
  const found = matches[0];
  if (Array.isArray(plan.expectations)) {
    const expectations = plan.expectations.filter(row => row?.original_item_id === item.id && row.order === item.order);
    if (expectations.length !== 1 || expectations[0].id !== found.candidate.id) return { candidate: null, index: null, status: "declared_identity_mismatch" };
  }
  return { ...found, status: Array.isArray(plan.expectations) ? "declared_order_and_identity_match" : "declared_order_match_only" };
}

export function prepareQuoteDiagnostics(pkg, plan) {
  const records = [], skippedFields = [];
  for (const [itemIndex, item] of list(pkg?.set?.items).entries()) {
    const paired = matchingCase(item, plan ?? {}), source = paired.candidate?.editorial?.seen_before;
    const extracted = feedbackFields(object(item.view) ? item.view : {}, itemIndex);
    skippedFields.push(...extracted.skipped);
    for (const field of extracted.fields) {
      const parsed = spansIn(field.text);
      records.push({ opaque_item_id: typeof paired.candidate?.id === "string" ? paired.candidate.id : null, item_order: item.order,
        candidate: { file: "question-set.json", field_pointer: field.pointer, role: field.role, text_sha256: sha(field.text) },
        source: { file: "solver-packet.json", field_pointer: paired.index === null ? null : `/cases/${paired.index}/editorial/seen_before`,
          text_sha256: typeof source === "string" ? sha(source) : null, availability: typeof source === "string" && source.trim() ? "supplied_text" : "unavailable",
          pairing: paired.status, role: "declared_passive_text_preview; may include instructions and worked teaching as well as primary text",
          completeness: "Bounded to this supplied preview; complete work, media, conditional exposure and served view are unverified" },
        spans: parsed.spans.map(span => {
          const comparison = compare(span, source), context = framing(field.text, span);
          return { ...span, context_observation: context, comparison, quotation_intent: "undetermined", speaker_fidelity: "undetermined", semantic_truth: "undetermined",
            review_signal: comparison.class === "word_sequence_absent_from_supplied_text" && !["label_or_term_frame", "interpretive_or_hypothetical_frame", "negated_frame", "question_frame"].includes(context)
              ? "quoted_span_absent_requires_role_and_source_review" : "none_from_this_diagnostic" };
        }), parser_notes: parsed.notes });
    }
  }
  const fileNames = ["course-request.json", "course-source-packet.json", "lesson-context.json", "question-set.json"];
  const originalSource = pkg?.source?.source, sourcePin = originalSource?.sha256_source_bytes ?? originalSource?.sha256;
  return { version: 1, id: "feedback-quote-diagnostics-v1", scope: "Candidate feedback strings against matching supplied text; report observations only",
    provenance: { package_file_sha256: Object.fromEntries(fileNames.filter(file => hash(pkg?.hashes?.[file])).map(file => [file, pkg.hashes[file]])),
      plan_input: Object.fromEntries(["context_projection_sha256", "set_projection_sha256"].filter(key => hash(plan?.input?.[key])).map(key => [key, plan.input[key]])),
      original_source_sha256: hash(sourcePin) ? sourcePin : null,
      original_source_commit: typeof originalSource?.commit === "string" && /^[a-f0-9]{7,40}$/.test(originalSource.commit) ? originalSource.commit : null,
      source_provenance_status: "Supplied package pins/declarations; external source comparison and served exposure not established" },
    records, skipped_feedback_fields: skippedFields,
    counts: { feedback_fields: records.length, quoted_spans: records.reduce((count, record) => count + record.spans.length, 0),
      unavailable_source_fields: records.filter(record => record.source.availability === "unavailable").length },
    academic_quality: "unmeasured", qualification: false,
    limits: ["Quoted punctuation or says-that wording does not prove verbatim intent or source attribution.",
      "Absence from this supplied text does not prove absence from the complete work or establish a wrong quotation.",
      "Word/typography/ellipsis observations do not certify punctuation, speaker, omitted meaning, proposition truth or learner outcomes."] };
}
