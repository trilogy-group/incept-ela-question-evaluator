import test from "node:test";
import assert from "node:assert/strict";
import { atPointer, checkCorpusRow, checkCorpusRows } from "../src/corpus-checks.mjs";

const row = (native, kind = "mcq", role = "question") => ({ id: "synthetic", kind, role, native, occurrences: [{ source_id: "synthetic", context: "sample.json", pointer: "/questions/0", context_pointer: "" }] });
const checks = (result, id) => result.checks.filter((c) => c.check_id === id);
const status = (result, id) => checks(result, id).map((c) => c.status);
const declaration = (id, values, cardinality = "single", base = "identifier") => `<qti-response-declaration identifier="${id}" cardinality="${cardinality}" base-type="${base}"><qti-correct-response>${values.map((v) => `<qti-value>${v}</qti-value>`).join("")}</qti-correct-response></qti-response-declaration>`;
const choice = (id, text = id) => `<qti-simple-choice identifier="${id}">${text}</qti-simple-choice>`;
const interaction = (response, choices, attrs = "") => `<qti-choice-interaction response-identifier="${response}" ${attrs}>${choices.map((c) => choice(...c)).join("")}</qti-choice-interaction>`;
const xmlRow = (xml, kind = "multiple_choice") => row({ xml: `<qti-assessment-item>${xml}</qti-assessment-item>` }, kind);

test("every row preserves source IDs and occurrences without claiming quality", () => {
  const input = [row("Discuss the sentence", "oral_microtask", "guided_task"), row({ options: ["short", "other", "longer answer"], answer_index: 2 })];
  const snapshot = JSON.stringify(input), results = checkCorpusRows(input);
  assert.equal(results.length, 2);
  assert.deepEqual(results.map((r) => r.id), input.map((r) => r.id));
  assert.deepEqual(results[0].occurrences, input[0].occurrences);
  assert.equal(JSON.stringify(input), snapshot);
  for (const result of results) { assert.deepEqual(status(result, "semantic_quality"), ["unknown"]); assert.equal(result.coverage.academic_approval, false); }
  assert.deepEqual(status(results[0], "authored_answer_support"), ["not_applicable"]);
});

test("numeric keys reject booleans, fractions, duplicate indices and out-of-range answers", () => {
  for (const key of [true, 0.5, -1, 2]) assert.deepEqual(status(checkCorpusRow(row({ options: ["a", "b"], answer_index: key })), "key_indices_valid"), ["fail"]);
  assert.deepEqual(status(checkCorpusRow(row({ options: ["a", "b"], correct_indices: [0, 0] }, "msq")), "key_indices_valid"), ["fail"]);
  assert.deepEqual(status(checkCorpusRow(row({ sentences: ["first", "second"], correct_indices: [1] }, "hot_text")), "key_indices_valid"), ["pass"]);
});

test("single and multiple keys use the declared source format", () => {
  const native = { options: [{ id: "A", text: "one", key: true }, { id: "B", text: "two", key: true }], correct: ["A", "B"] };
  assert.deepEqual(status(checkCorpusRow(row(native, "multiple_choice")), "key_cardinality"), ["fail"]);
  assert.deepEqual(status(checkCorpusRow(row(native, "multiple_select")), "key_cardinality"), ["pass"]);
  assert.deepEqual(status(checkCorpusRow(row({ ...native, correct: ["missing"] }, "multiple_select")), "key_membership"), ["fail"]);
  assert.deepEqual(status(checkCorpusRow(row({ ...native, correct: ["A"] }, "multiple_select")), "key_flags_agree"), ["fail"]);
});

test("flattened source-export ID collisions do not establish question cardinality", () => {
  const native = { item_id: "compound", passage: "source", options: [{ id: "A", text: "first" }, { id: "A", text: "second" }], correct: ["A"] };
  const result = checkCorpusRow(row(native, "multiple_select"));
  assert.deepEqual(status(result, "option_ids_unique"), ["fail"]);
  assert.equal(checks(result, "option_ids_unique")[0].evidence.defect_scope, "source_export_representation");
  assert.deepEqual(status(result, "key_membership"), ["unknown"]);
  assert.deepEqual(status(result, "key_cardinality"), ["unknown"]);
});

test("option duplicates are literal checks and length cues are conditional flags", () => {
  const repeated = checkCorpusRow(row({ options: ["same words", " same  words "], answer_index: 0 }));
  assert.deepEqual(status(repeated, "option_texts_distinct"), ["fail"]);
  const longest = checkCorpusRow(row({ options: ["a", "b", "a longer phrase"], answer_index: 2 }));
  assert.deepEqual(status(longest, "key_position_and_length"), ["flag"]);
  assert.equal(longest.coverage.fail, 0);
});

test("unkeyed choices and open dynamic fields abstain", () => {
  const results = [
    checkCorpusRow(row({ options: ["one", "two"] })),
    checkCorpusRow(row({ options: [{ id: "A", text: "one" }], correct: [] }, "multiple_choice")),
    checkCorpusRow(row({ criteria: [{ id: "own-words", requirement: "Use your own words.", accept: [] }], reveal: "" }, "open_check")),
    checkCorpusRow(row({ choices: [{ text: "one", correct: false }] }, "multiple_choice")),
  ];
  for (const result of results) assert.equal(result.coverage.fail, 0);
  assert.deepEqual(status(results[2], "accepted_answers_shape"), ["unknown"]);
  assert.deepEqual(status(results[2], "reveal_present"), ["unknown"]);
});

test("JSON sequence key is an exact permutation, not a plausible order", () => {
  const correct = { items: ["alpha", "beta", "gamma"], correct_order: ["gamma", "alpha", "beta"] };
  assert.deepEqual(status(checkCorpusRow(row(correct, "sequence")), "sequence_key_permutation"), ["pass"]);
  assert.deepEqual(status(checkCorpusRow(row({ ...correct, correct_order: ["gamma", "alpha", "alpha"] }, "sequence")), "sequence_key_permutation"), ["fail"]);
  const identified = { options: [{ id: "a", text: "alpha" }, { id: "b", text: "beta" }], correct: ["b", "a"] };
  assert.deepEqual(status(checkCorpusRow(row(identified, "sequence")), "sequence_key_permutation"), ["pass"]);
});

test("literal match keys cover prompts but do not invent one-to-one constraints", () => {
  const native = { prompts: ["p1", "p2"], options: ["label", "unused"], correct_option_for_prompt: [0, 0] };
  assert.deepEqual(status(checkCorpusRow(row(native, "match")), "match_pair_membership"), ["pass"]);
  assert.deepEqual(status(checkCorpusRow(row({ ...native, correct_option_for_prompt: [0] }, "match")), "match_pair_membership"), ["fail"]);
  const exported = row({ options: [{ id: "P", text: "prompt" }, { id: "O", text: "option" }], correct: ["P X"] }, "matching");
  assert.deepEqual(status(checkCorpusRow(exported), "match_pair_membership"), ["fail"]);
});

test("cloze slots use local options or the shared bank", () => {
  const native = { bank: ["alpha", "beta"], segments: [{ kind: "blank", answer: "alpha" }, { kind: "blank", options: ["local"], answer: "beta" }, { kind: "blank", options: ["local"] }] };
  assert.deepEqual(status(checkCorpusRow(row(native, "cloze")), "slot_key_membership"), ["pass", "fail", "unknown"]);
  assert.deepEqual(status(checkCorpusRow(row({ options: ["alpha", "beta"], correct: ["alpha", "beta"] }, "cloze")), "slot_key_membership"), ["pass"]);
});

test("classifier destinations are strict but slot count disagreement is conditional", () => {
  const native = { boxes: { character: { is: "Character is", slots: 2 } }, words: [{ w: "brave", to: "character", kind: "is" }] };
  const result = checkCorpusRow(row(native, "classify"));
  assert.deepEqual(status(result, "classifier_destinations"), ["pass"]);
  assert.deepEqual(status(result, "classifier_declared_counts"), ["flag"]);
  assert.deepEqual(status(checkCorpusRow(row({ ...native, words: [{ w: "brave", to: "other", kind: "is" }] }, "classify")), "classifier_destinations"), ["fail"]);
});

test("rubric requirements and declared accepted fields are checked without scoring meaning", () => {
  const result = checkCorpusRow(row({ assessment: { criteria: [{ id: "one", requirement: "Name an event", accept: ["an event"] }], reveal: "An event occurs.", pass_threshold: 1 } }, "scr"));
  assert.deepEqual(status(result, "rubric_requirements"), ["pass"]);
  assert.deepEqual(status(result, "accepted_answers_shape"), ["pass"]);
  const invalid = checkCorpusRow(row({ criteria: [{ id: "one", accept: [42] }, { id: "one", requirement: "Explain" }], reveal: 42 }, "open_check"));
  assert.deepEqual(status(invalid, "rubric_requirements"), ["fail"]);
  assert.deepEqual(status(invalid, "criterion_ids_unique"), ["fail"]);
  assert.deepEqual(status(invalid, "accepted_answers_shape"), ["fail"]);
  assert.deepEqual(status(invalid, "reveal_present"), ["fail"]);
});

test("compound QTI scopes duplicate identifiers within separate interactions", () => {
  const source = declaration("A", ["C1"]) + declaration("B", ["C2"]) + interaction("A", [["C1", "one"], ["C2", "two"]]) + interaction("B", [["C1", "three"], ["C2", "four"]]);
  const result = checkCorpusRow(xmlRow(source, "ebsr"));
  assert.deepEqual(status(result, "option_ids_unique"), ["pass", "pass"]);
  assert.deepEqual(status(result, "key_membership"), ["pass", "pass"]);
  assert.equal(result.coverage.fail, 0);
});

test("QTI keys must belong to their bound interaction and obey declared cardinality", () => {
  const result = checkCorpusRow(xmlRow(declaration("R", ["C1", "C3"]) + interaction("R", [["C1", "one"], ["C2", "two"]], 'max-choices="2"')));
  assert.deepEqual(status(result, "qti_key_cardinality"), ["fail"]);
  assert.deepEqual(status(result, "key_membership"), ["fail"]);
  const badBinding = checkCorpusRow(xmlRow(declaration("R", ["C1"]) + interaction("other", [["C1", "one"]])));
  assert.deepEqual(status(badBinding, "qti_response_binding"), ["fail"]);
});

test("QTI default maximum is one and zero maximum is unlimited", () => {
  const source = declaration("R", ["C1", "C2"], "multiple");
  const choices = [["C1", "one"], ["C2", "two"]];
  assert.deepEqual(status(checkCorpusRow(xmlRow(source + interaction("R", choices))), "qti_selection_limit"), ["fail"]);
  assert.deepEqual(status(checkCorpusRow(xmlRow(source + interaction("R", choices, 'max-choices="0"'))), "qti_selection_limit"), ["pass"]);
});

test("QTI directed pairs check match sets and declared reuse limits", () => {
  const match = (max) => `<qti-match-interaction response-identifier="R" max-associations="2"><qti-simple-match-set><qti-simple-associable-choice identifier="P1" match-max="1">first</qti-simple-associable-choice><qti-simple-associable-choice identifier="P2" match-max="1">second</qti-simple-associable-choice></qti-simple-match-set><qti-simple-match-set><qti-simple-associable-choice identifier="O" match-max="${max}">destination</qti-simple-associable-choice></qti-simple-match-set></qti-match-interaction>`;
  const source = declaration("R", ["P1 O", "P2 O"], "multiple", "directedPair");
  const result = checkCorpusRow(xmlRow(source + match(1), "matching"));
  assert.deepEqual(status(result, "match_pair_membership"), ["pass"]);
  assert.deepEqual(status(result, "qti_match_reuse_limits"), ["fail"]);
  assert.deepEqual(status(checkCorpusRow(xmlRow(source + match(0), "matching")), "qti_match_reuse_limits"), ["pass"]);
  assert.deepEqual(status(checkCorpusRow(xmlRow(declaration("R", ["O P1"], "multiple", "directedPair") + match(2), "matching")), "match_pair_membership"), ["fail"]);
});

test("QTI order uses a complete permutation and ordered cardinality", () => {
  const order = `<qti-order-interaction response-identifier="R">${choice("a", "first")}${choice("b", "second")}</qti-order-interaction>`;
  assert.deepEqual(status(checkCorpusRow(xmlRow(declaration("R", ["b", "a"], "ordered") + order, "sequence")), "sequence_key_permutation"), ["pass"]);
  assert.deepEqual(status(checkCorpusRow(xmlRow(declaration("R", ["a", "a"], "ordered") + order, "sequence")), "sequence_key_permutation"), ["fail"]);
});

test("QTI inline slots bind to their own offered identifiers", () => {
  const source = declaration("R", ["option"]) + '<qti-inline-choice-interaction response-identifier="R"><qti-inline-choice identifier="option">word</qti-inline-choice></qti-inline-choice-interaction>';
  assert.deepEqual(status(checkCorpusRow(xmlRow(source, "inline_choice")), "key_membership"), ["pass"]);
});

test("quote comparison uses recovered stimulus and flags unmatched instructional quotes", () => {
  const source = { passage: "The owl crossed the quiet meadow.", stem: 'What does "crossed the quiet meadow" tell us?', options: ["one", "two"], answer_index: 0 };
  assert.deepEqual(status(checkCorpusRow(row(source)), "quotes_in_supplied_stimulus"), ["pass"]);
  assert.deepEqual(status(checkCorpusRow(row({ ...source, stem: 'What does "the hidden meaning here" tell us?' })), "quotes_in_supplied_stimulus"), ["flag"]);
  assert.deepEqual(status(checkCorpusRow(row({ quote_from: ["the quiet meadow"] }, "writing_blank")), "quotes_in_supplied_stimulus"), ["unknown"]);
});

test("context retrieval is bounded to explicit passages and XML stimulus references", () => {
  const input = row({ quote_from: ["owl crossed the meadow"] }, "writing_blank");
  const result = checkCorpusRow(input, { getContext: () => ({ unrelated: "owl crossed the meadow", pages: [{ nodes: [{ type: "passage", paragraphs: ["The owl crossed the meadow."] }] }] }) });
  assert.deepEqual(status(result, "quotes_in_supplied_stimulus"), ["pass"]);
  const falseSource = checkCorpusRow(input, { getContext: () => ({ answer: "owl crossed the meadow" }) });
  assert.deepEqual(status(falseSource, "quotes_in_supplied_stimulus"), ["unknown"]);
  const source = declaration("R", ["a"]) + '<qti-assessment-stimulus-ref identifier="s"/><qti-choice-interaction response-identifier="R"><qti-prompt>What does “owl &amp; fox together” mean?</qti-prompt>' + choice("a", "answer") + "</qti-choice-interaction>";
  const qti = checkCorpusRow(xmlRow(source), { getContext: () => ({ stimuli: { s: { xml: "<qti-assessment-stimulus><p>The owl &amp; fox together.</p></qti-assessment-stimulus>" } } }) });
  assert.deepEqual(status(qti, "quotes_in_supplied_stimulus"), ["pass"]);
});

test("unsupported XML and context errors abstain without I/O or thrown failures", () => {
  const malformed = checkCorpusRow(xmlRow("<qti-choice-interaction>"));
  assert.deepEqual(status(malformed, "qti_parse"), ["unknown"]);
  const entities = checkCorpusRow(row({ xml: '<!DOCTYPE item SYSTEM "remote"><qti-assessment-item/>' }));
  assert.deepEqual(status(entities, "qti_parse"), ["unknown"]);
  const result = checkCorpusRow(row({ quote_from: ["copy these exact words"] }), { getContext: () => { throw new Error("not available"); } });
  assert.deepEqual(status(result, "quotes_in_supplied_stimulus"), ["unknown"]);
  assert.equal(checks(result, "quotes_in_supplied_stimulus")[0].evidence.context_errors[0], "not available");
});

test("JSON pointers preserve escaped source names", () => {
  assert.equal(atPointer({ "a/b": { "c~d": "source" } }, "/a~1b/c~0d"), "source");
  assert.equal(atPointer({}, "/missing"), undefined);
  assert.throws(() => checkCorpusRows({}), TypeError);
});
