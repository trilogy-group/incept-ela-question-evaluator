import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { prepareQuoteDiagnostics } from "../src/quote-diagnostics.mjs";

const sha = text => crypto.createHash("sha256").update(text).digest("hex");
function fixture(feedback, source = "RAVEN: Not all nests are empty.") {
  return { pkg: { hashes: { "question-set.json": "a".repeat(64), "lesson-context.json": "b".repeat(64), "ignored/private": "c".repeat(64) },
    source: { source: { commit: "d".repeat(40), sha256_source_bytes: "e".repeat(64) } },
    set: { items: [{ id: "author-item", order: 1, view: { feedback } }] } },
  plan: { input: { context_projection_sha256: "f".repeat(64), set_projection_sha256: "1".repeat(64) },
    cases: [{ id: "opaque-item", order: 1, editorial: { seen_before: source } }],
    expectations: [{ id: "opaque-item", order: 1, original_item_id: "author-item" }] } };
}
const observe = (text, source) => { const { pkg, plan } = fixture(text, source); return prepareQuoteDiagnostics(pkg, plan); };
const first = report => report.records[0].spans[0];

test("a single-quoted attributed feedback span can be absent without a wrong-quote or item verdict", () => {
  // Synthetic analogue of an attribution followed by a changed source sentence; no retained candidate text is published.
  const text = "The raven explicitly says that 'all nests are not empty,' showing there is room.";
  const report = observe(text), span = first(report);
  assert.equal(span.raw, "all nests are not empty,");
  assert.equal(text.slice(span.start + 1, span.end - 1), span.raw);
  assert.equal(span.comparison.class, "word_sequence_absent_from_supplied_text");
  assert.equal(span.review_signal, "quoted_span_absent_requires_role_and_source_review");
  for (const key of ["quotation_intent", "speaker_fidelity", "semantic_truth"]) assert.equal(span[key], "undetermined");
  assert.equal(report.qualification, false);
  assert.equal(Object.hasOwn(span, "verdict"), false);
  assert.equal(Object.hasOwn(span, "required"), false);
  assert.equal(Object.hasOwn(report, "checks"), false);
});

test("literal, typography and word-sequence observations remain separate", () => {
  assert.equal(first(observe("The raven says 'Don't wait.'", "Don't wait.")).comparison.class, "raw_source_span_found");
  assert.equal(first(observe("The raven says ‘Don’t wait.’", "Don't wait.")).comparison.class, "typography_normalized_source_span_found");
  const punctuation = first(observe("The raven says 'Not all nests—are empty.'"));
  assert.equal(punctuation.comparison.class, "word_sequence_found_with_other_differences");
  assert.equal(punctuation.quotation_intent, "undetermined");
  assert.equal(first(observe("The raven says 'spark'.", "A sparkle appeared.")).comparison.class, "word_sequence_absent_from_supplied_text");
});

test("empty and whitespace-only quoted spans do not count as source matches", () => {
  for (const text of ["The raven says ''.", 'The raven says "   ".']) {
    for (const source of ["A supplied sentence.", null]) {
      const span = first(observe(text, source));
      assert.equal(span.comparison.class, "empty_quoted_span");
      assert.equal(span.comparison.comparison_performed, false);
      assert.equal(span.review_signal, "none_from_this_diagnostic");
    }
  }
});

test("apostrophes, labels, paraphrases, negation and questions do not become wrong-quote judgments", () => {
  assert.equal(observe("The raven's nest isn't empty.").counts.quoted_spans, 0);
  assert.equal(observe("The raven’s nest isn’t empty.").counts.quoted_spans, 0);
  assert.equal(observe("'Twas rainy.").counts.quoted_spans, 0);
  for (const [text, context] of [
    ["Use 'claim' and 'reason' as planning labels.", "label_or_term_frame"],
    ["The word 'claim' is a label.", "label_or_term_frame"],
    ["In other words, the raven says 'there is room'.", "interpretive_or_hypothetical_frame"],
    ["The raven does not say 'no nests are empty'.", "negated_frame"],
    ["Does the raven say 'no nests are empty'?", "question_frame"],
  ]) {
    for (const span of observe(text).records[0].spans) { assert.equal(span.context_observation, context); assert.equal(span.review_signal, "none_from_this_diagnostic"); assert.equal(span.quotation_intent, "undetermined"); }
  }
});

test("ellipsis compares retained segments in order while omission meaning and adjacency stay undetermined", () => {
  const forward = first(observe("The raven says 'Not all ... are empty.'"));
  assert.equal(forward.comparison.class, "ellipsis_segments_found_in_order");
  assert.equal(forward.comparison.omitted_meaning, "undetermined");
  assert.equal(forward.comparison.segment_adjacency, "undetermined");
  assert.equal(first(observe("The raven says 'are empty ... Not all'.")).comparison.class, "ellipsis_segments_not_found_in_order");
  assert.equal(first(observe("The raven says 'Not all [blank] are empty'.")).comparison.class, "template_markers_present");
});

test("ambiguous or unclosed delimiters and missing source remain non-failing observations", () => {
  const ambiguous = first(observe("The raven says 'The birds' nests are empty'.", "The birds' nests are empty."));
  assert.equal(ambiguous.comparison.class, "delimiter_ambiguous");
  assert.equal(ambiguous.comparison.comparison_performed, false);
  const unclosed = observe("The raven says 'the nest is empty.");
  assert.equal(unclosed.counts.quoted_spans, 0);
  assert.equal(unclosed.records[0].parser_notes[0].kind, "unclosed_quoted_span");
  for (const source of [null, ""]) {
    const span = first(observe("The raven says 'Not all nests are empty.'", source));
    assert.equal(span.comparison.class, "source_unavailable");
    assert.equal(span.review_signal, "none_from_this_diagnostic");
  }
});

test("only feedback strings are inspected; source pointers, opaque IDs and hash pins are preserved", () => {
  const { pkg, plan } = fixture("General 'Not all nests are empty.'");
  const view = pkg.set.items[0].view;
  view.option_feedback = ["Option 'Not all nests are empty.'"];
  view.correct_feedback = "Correct 'Not all nests are empty.'";
  view.entry_feedback = { "ENTRY/A~B": "Entry 'Not all nests are empty.'" };
  for (const field of ["stem", "options", "key", "rubric", "sample_answer", "hidden_teacher_field"]) Object.defineProperty(view, field, { get() { throw new Error("Non-feedback field was inspected"); } });
  Object.defineProperty(plan.cases[0], "blind", { get() { throw new Error("Blind packet was inspected"); } });
  const report = prepareQuoteDiagnostics(pkg, plan);
  assert.equal(report.records.length, 4);
  assert.ok(report.records.every(record => record.opaque_item_id === "opaque-item"));
  assert.deepEqual(report.records.map(record => record.candidate.field_pointer), ["/items/0/view/option_feedback/0", "/items/0/view/entry_feedback/ENTRY~1A~0B", "/items/0/view/correct_feedback", "/items/0/view/feedback"]);
  assert.ok(report.records.every(record => record.source.field_pointer === "/cases/0/editorial/seen_before"));
  assert.equal(report.records[0].source.text_sha256, sha(plan.cases[0].editorial.seen_before));
  assert.equal(report.records[0].candidate.text_sha256, sha(view.option_feedback[0]));
  assert.equal(report.provenance.original_source_sha256, "e".repeat(64));
  assert.equal(Object.hasOwn(report.provenance.package_file_sha256, "ignored/private"), false);
});

test("reordered prepared cases bind by declared identity/order and mismatches become unavailable source", () => {
  const { pkg, plan } = fixture("Quoted 'Not all nests are empty.'");
  pkg.set.items.push({ id: "second-author", order: 2, view: { feedback: "Second 'The eggs hatched.'" } });
  plan.cases.unshift({ id: "second-opaque", order: 2, editorial: { seen_before: "The eggs hatched." } });
  plan.expectations.push({ id: "second-opaque", order: 2, original_item_id: "second-author" });
  const matched = prepareQuoteDiagnostics(pkg, plan);
  assert.equal(matched.records[0].opaque_item_id, "opaque-item");
  assert.equal(matched.records[0].source.field_pointer, "/cases/1/editorial/seen_before");
  assert.equal(matched.records[1].opaque_item_id, "second-opaque");
  plan.expectations[0].original_item_id = "different-author";
  const mismatched = prepareQuoteDiagnostics(pkg, plan).records[0];
  assert.equal(mismatched.opaque_item_id, null);
  assert.equal(mismatched.source.pairing, "declared_identity_mismatch");
  assert.equal(mismatched.spans[0].comparison.class, "source_unavailable");
});

test("report preparation is deterministic, does not mutate inputs, and does not traverse general feedback objects", () => {
  const { pkg, plan } = fixture({ hidden_branch: "No declared text interpreter for this object" });
  const before = structuredClone({ pkg, plan });
  const a = prepareQuoteDiagnostics(pkg, plan), b = prepareQuoteDiagnostics(pkg, plan);
  assert.deepEqual(a, b);
  assert.deepEqual({ pkg, plan }, before);
  assert.equal(a.records.length, 0);
  assert.equal(a.skipped_feedback_fields[0].pointer, "/items/0/view/feedback");
});
