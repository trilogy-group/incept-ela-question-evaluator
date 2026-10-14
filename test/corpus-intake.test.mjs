import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { loadCorpus, normalizeCorpusOccurrence, planRepresentativeScope } from "../src/corpus-intake.mjs";

const sha = (x, algorithm = "sha256") => crypto.createHash(algorithm).update(x).digest("hex");
const digest = (x) => sha(JSON.stringify(x));
const source = (adapter, id = adapter, overrides = {}) => ({ id, adapter, path: `${adapter}.json`, repository: "development/source", sha256: "a".repeat(64),
  context: `contexts/${id}.json`, context_sha256: "b".repeat(64), version_role: "current-main-at-intake", ...overrides });
const row = (kind, native, occurrence, prompt = native.stem ?? native.prompt, overrides = {}) => ({ id: digest({ kind, native, prompt, ...overrides }), kind, native, prompt,
  role: "question", intended_answer_status: "author material; not independently validated", quality_label: null, occurrences: [occurrence], ...overrides });
const occurrence = (s, pointer, contextPointer) => ({ source_id: s.id, context: s.context, pointer, context_pointer: contextPointer });
const renderer = (stem = "Which animal crossed the river?", extras = {}) => {
  const s = source("renderer", "reading-main-grade-3", { path: "public/lesson-json/grade-3.json" });
  const n = { type: "question", bank_type: "mcq", stem, options: ["Fox", "Hare"], answer_index: 0, feedback: ["Authored correct feedback", "Authored wrong feedback"], ...extras };
  const context = { units: [{ lessons: [{ lessonId: "lesson-1", pages: [{ id: "p1", nodes: [
    { type: "passage", paragraphs: ["The fox crossed the river.", "The fox crossed the river."], text: "Alternate serialized paragraph", producer: "private maker" }, n] }] }] }] };
  const o = occurrence(s, "/units/0/lessons/0/pages/0/nodes/1", "/units/0/lessons/0");
  return { s, n, context, o, r: row("mcq", n, o) };
};
const member = (xml, memberPath) => { const b = Buffer.from(xml); return { xml, path: memberPath, sha256: sha(b), git_blob: sha(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b]), "sha1") }; };
function qti({ cardinality = "single", options = ["ChoiceA", "ChoiceB"], markup = "", image = false } = {}) {
  const s = source("qti-bundle", "qti", { upstream_course_id: "shared-course" });
  const xml = `<qti-assessment-item identifier="shared-item" adaptive="false" time-dependent="false"><qti-response-declaration identifier="RESPONSE" cardinality="${cardinality}" base-type="identifier"><qti-correct-response><qti-value>ChoiceB</qti-value></qti-correct-response></qti-response-declaration><qti-assessment-stimulus-ref identifier="passage" href="stimuli/passage"/><qti-item-body><qti-choice-interaction response-identifier="RESPONSE" max-choices="1"><qti-prompt>What does &#x27;swift&#x27; mean?</qti-prompt>${options.map((id, i) => `<qti-simple-choice identifier="${id}">${i === 0 ? "Slow" : "Fast"}</qti-simple-choice>`).join("")}</qti-choice-interaction></qti-item-body><qti-response-processing template="https://purl.imsglobal.org/spec/qti/v3p0/rptemplates/match_correct"/></qti-assessment-item>`;
  const n = member(xml, "items/shared-item.xml"), stimulus = member(`<qti-assessment-stimulus identifier="passage" title="The river"><qti-stimulus-body><p${markup}>The swift fox was fast.${image ? '<img src="image.jpg"/>' : ""}</p></qti-stimulus-body></qti-assessment-stimulus>`, "stimuli/passage.xml");
  const context = { items: [n], stimuli: { passage: stimulus } }, o = { ...occurrence(s, "/items/0", ""), member_path: n.path, member_sha256: n.sha256 };
  return { s, n, context, o, r: row("multiple_choice", n, o, ["What does 'swift' mean?"]) };
}
const normalize = ({ r, s, context, o }) => normalizeCorpusOccurrence(r, s, context, o);
async function fixture(t, data) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "corpus-intake-test-"));
  t.after(() => rm(directory, { recursive: true, force: true })); await mkdir(path.join(directory, "contexts"));
  const files = {}, sources = [], rows = [];
  for (const d of data) {
    const bytes = JSON.stringify(d.context); await writeFile(path.join(directory, d.s.context), bytes);
    files[d.s.context] = sha(bytes); sources.push({ ...d.s, context_sha256: sha(bytes), occurrences: d.r.occurrences.length, omissions: [] }); rows.push(d.r);
  }
  const questionBytes = rows.map((r) => JSON.stringify(r)).join("\n") + "\n"; await writeFile(path.join(directory, "questions.jsonl"), questionBytes); files["questions.jsonl"] = sha(questionBytes);
  const counts = { unique_examples: rows.length, source_occurrences: rows.reduce((n, r) => n + r.occurrences.length, 0), source_snapshots: sources.length,
    by_kind: {}, by_role: {} };
  for (const r of rows) { counts.by_kind[r.kind] = (counts.by_kind[r.kind] ?? 0) + 1; counts.by_role[r.role] = (counts.by_role[r.role] ?? 0) + 1; }
  const catalog = { files, sources, counts }, bytes = JSON.stringify(catalog); await writeFile(path.join(directory, "catalog.json"), bytes);
  return { directory, catalog, catalog_sha256: sha(bytes) };
}

test("renderer preserves passage repetitions and keeps authored key and feedback outside solver context", () => {
  const c = normalize(renderer()); assert.equal(c.item.view.key[0], 0); assert.deepEqual(c.authored_key.indices, [0]);
  assert.equal(c.solver_context.stimulus[0].text, "The fox crossed the river.\nThe fox crossed the river.");
  assert.deepEqual(c.solver_context.options, [{ id: "option-1", text: "Fox" }, { id: "option-2", text: "Hare" }]);
  assert.equal(c.solver_context.learner_context_status, "unresolved");
  assert.doesNotMatch(JSON.stringify(c.solver_context), /private maker|Authored|answer_index|feedback|correct|rubric|provenance/);
  assert.equal(c.pilot_eligible, true); assert.match(c.scope, /not a native lesson interpreter/);
});

test("finished corpus hashes, row totals and occurrence totals reconcile", async (t) => {
  const f = await fixture(t, [renderer(), qti()]); const result = await loadCorpus(f.directory, { expectedCatalogSha256: f.catalog_sha256 });
  assert.equal(result.counts.rows, 2); assert.equal(result.counts.covered, 2); assert.equal(result.counts.excluded, 0);
  assert.equal(result.counts.occurrences, 2); assert.equal(result.counts.covered_occurrences, 2);
  assert.equal(result.hashes.external_catalog_pin_verified, true); assert.match(result.sources[0].original_source_hash_status, /original bytes were not inspected/);
  assert.equal(result.covered[1].provenance[0].stimulus_members[0].hashes_verified, true);
});

test("changed retained bytes and an incorrect external catalog pin fail closed", async (t) => {
  const d = renderer(), f = await fixture(t, [d]);
  await assert.rejects(loadCorpus(f.directory, { expectedCatalogSha256: "0".repeat(64) }), /external pin/);
  await writeFile(path.join(f.directory, d.s.context), JSON.stringify({ changed: true }));
  await assert.rejects(loadCorpus(f.directory), /retained file SHA256 mismatch/);
});

test("catalog count mismatches fail; invalid row pointers remain accounted exclusions", async (t) => {
  const d = renderer(); d.r.occurrences[0].pointer = "/units/0/lessons/0/pages/0/nodes/99";
  const f = await fixture(t, [d]); const result = await loadCorpus(f.directory);
  assert.equal(result.counts.covered, 0); assert.equal(result.counts.excluded, 1); assert.equal(result.counts.excluded_occurrences, 1);
  assert.match(result.excluded[0].reasons[0], /pointer does not resolve/);
  f.catalog.counts.unique_examples = 2; await writeFile(path.join(f.directory, "catalog.json"), JSON.stringify(f.catalog));
  await assert.rejects(loadCorpus(f.directory), /do not reconcile/);
});

test("catalog cannot route intake into arbitrary paths", async (t) => {
  const f = await fixture(t, [renderer()]); f.catalog.files["../outside.json"] = "a".repeat(64);
  await writeFile(path.join(f.directory, "catalog.json"), JSON.stringify(f.catalog));
  await assert.rejects(loadCorpus(f.directory), /unsupported retained corpus path/);
});

test("QTI binds exact member bytes, stimulus reference and one authored identifier", () => {
  const d = qti(), c = normalize(d); assert.equal(c.solver_context.question, "What does 'swift' mean?");
  assert.equal(c.solver_context.stimulus[0].text, "The swift fox was fast."); assert.deepEqual(c.authored_key.indices, [1]);
  assert.deepEqual(c.authored_key.source_identifiers, ["ChoiceB"]); assert.match(c.source_identity, /shared-item/);
  d.r.prompt.push("Another prompt"); assert.throws(() => normalize(d), /multiple parts/);
});

test("QTI rejects multi-response, duplicate identifiers, missing media and hidden markup", () => {
  assert.throws(() => normalize(qti({ cardinality: "multiple" })), /not a single identifier/);
  assert.throws(() => normalize(qti({ options: ["ChoiceB", "ChoiceB"] })), /duplicated/);
  assert.throws(() => normalize(qti({ image: true })), /unsupported learner markup img/);
  assert.throws(() => normalize(qti({ markup: ' style="display:none"' })), /visibility or attributes/);
});

test("QTI member SHA256 and Git blob are checked for all members, including excluded operations", async (t) => {
  const d = qti(); d.r.kind = "multiple_select"; d.context.stimuli.passage.xml += " ";
  const f = await fixture(t, [d]); await assert.rejects(loadCorpus(f.directory), /QTI member SHA256 mismatch/);
  d.context.stimuli.passage.sha256 = sha(d.context.stimuli.passage.xml);
  const f2 = await fixture(t, [d]); await assert.rejects(loadCorpus(f2.directory), /QTI member Git blob mismatch/);
});

test("reading export never resolves duplicated IDs or conflicting flags by taking a first match", () => {
  const s = source("reading-export", "export", { upstream_course_id: "shared-course" });
  const n = { type: "choice", item_id: "shared-item", lesson: "lesson", stem: "Which is fast?", passage: "The fox is fast.", correct: ["A"],
    options: [{ id: "A", text: "Fox", key: true }, { id: "A", text: "Hare", key: false }] };
  const context = { items: [n] }, o = occurrence(s, "/items/0", "/items/0"), r = row("multiple_choice", n, o);
  assert.throws(() => normalize({ s, context, o, r }), /duplicates choice identifiers/);
  n.options[1].id = "B"; n.options[1].key = true;
  assert.throws(() => normalize({ s, context, o, r }), /flags disagree/);
});

test("renderer hides alternative operations and excludes unresolved dependencies from a text pilot", () => {
  assert.throws(() => normalize(renderer(undefined, { hidden: true })), /hidden/);
  assert.throws(() => normalize(renderer(undefined, { hunt: { correct_index: 0 } })), /additional response/);
  for (const stem of ["What is this question asking you to do?", "Tap what you are looking for.", "Finish the last row.", "Think about the cave in the last lesson."]) {
    const c = normalize(renderer(stem)); assert.equal(c.pilot_eligible, false); assert.ok(c.unresolved_dependencies.length);
  }
  const d = renderer(); d.context.units[0].lessons[0].pages[0].nodes[0] = { type: "text", text: "Generic skill instruction" };
  const c = normalize(d); assert.equal(c.pilot_eligible, false); assert.match(c.unresolved_dependencies.join(" "), /instructional text alone/);
});

test("Alpha guidance keeps only its explicit passage section and Quiz preserves the full passage", () => {
  const s = source("alpha-read", "alpha"), n = { type: "choice", prompt: "What is fast?", section: "Guiding 1", choices: [{ text: "Fox", correct: true }, { text: "Hare", correct: false }] };
  const context = { lessons: [{ resource: "article", passage: [{ section: "Guiding 1", paras: ["Fox is fast."] }, { section: "Guiding 2", paras: ["Later text."] }], questions: [n] }] };
  const o = occurrence(s, "/lessons/0/questions/0", "/lessons/0"), r = row("multiple_choice", n, o);
  const c = normalize({ s, n, context, o, r }); assert.deepEqual(c.solver_context.stimulus.map((x) => x.text), ["Fox is fast."]);
  n.section = "Quiz"; assert.equal(normalize({ s, n, context, o, r }).solver_context.stimulus.length, 2);
  n.choices[1].correct = true; assert.throws(() => normalize({ s, n, context, o, r }), /exactly one/);
});

test("animated reading uses its own passage blocks and excludes alternate/slot operations", () => {
  const s = source("animated", "animated-current"), n = { q: "Who crossed?", correct: 0, options: [{ text: "Fox" }, { text: "Hare", why: "Private feedback" }] };
  const context = { lessonId: "animated-lesson", question: "How does the character change?", pages: [
    { id: "model", nodes: [{ type: "model", reveal: "Private model answer" }] },
    { id: "reading-1", nodes: [{ type: "reading", id: "read", blocks: [{ kind: "para", text: "Fox crossed." }], mcqs: [n], rubric: { reveal: "Private rubric reveal" } }] }
  ] };
  const o = occurrence(s, "/pages/1/nodes/0/mcqs/0", "/pages/1"), r = row("reading_mcq", n, o, n.q, { view: { stem: n.q, options: ["Fox", "Hare"], key: [0] } });
  const c = normalize({ s, n, context, o, r }); assert.deepEqual(c.solver_context.stimulus, [{ text: "Fox crossed." }]);
  assert.doesNotMatch(JSON.stringify(c.solver_context), /Private|rubric|reveal|why/);
  o.exposure_status = "retained written alternative"; assert.throws(() => normalize({ s, n, context, o, r }), /alternative/); delete o.exposure_status;
  r.kind = "rebuild_choice"; assert.throws(() => normalize({ s, n, context, o, r }), /multi-slot/);
});

test("planner chooses current main, clusters lineage/identical challenges and reports shortages", async (t) => {
  const d = renderer(), s2 = { ...d.s, id: "reading-staging-grade-3", context: "contexts/reading-staging-grade-3.json", version_role: "current-staging-at-intake" };
  const o2 = occurrence(s2, d.o.pointer, d.o.context_pointer); d.r.occurrences.unshift(o2);
  const f = await fixture(t, [d]);
  const bytes = JSON.stringify(d.context); await writeFile(path.join(f.directory, s2.context), bytes); f.catalog.files[s2.context] = sha(bytes);
  f.catalog.sources.push({ ...s2, context_sha256: sha(bytes), occurrences: 1, omissions: [] }); f.catalog.sources[0].occurrences = 1;
  f.catalog.counts.source_snapshots = 2; await writeFile(path.join(f.directory, "catalog.json"), JSON.stringify(f.catalog));
  const intake = await loadCorpus(f.directory); assert.equal(intake.covered[0].variants[0].provenance[0].source_id, "reading-main-grade-3");
  const c = intake.covered[0], duplicate = { ...c, id: "different-id", independence_group: "different-lineage", context_group: "different-context", passage_sha256: "different-passage" };
  const plan = planRepresentativeScope({ covered: [duplicate, c] }, { perStratum: 8 });
  assert.equal(plan.selected.length, 1); assert.equal(plan.strata[0].shortage, 7); assert.match(plan.independence_status, /not established/);
});

test("matching reading export and QTI IDs share lineage even when versions differ", () => {
  const q = normalize(qti()), s = source("reading-export", "export", { upstream_course_id: "shared-course" });
  const n = { type: "choice", item_id: "shared-item", lesson: "lesson", stem: "Different source version?", passage: "A different passage.", correct: ["A"], options: [{ id: "A", text: "Yes", key: true }, { id: "B", text: "No", key: false }] };
  const context = { items: [n] }, o = occurrence(s, "/items/0", "/items/0"), e = normalize({ s, n, context, o, r: row("multiple_choice", n, o) });
  assert.equal(e.independence_group, q.independence_group); assert.notEqual(e.challenge_sha256, q.challenge_sha256);
  const plan = planRepresentativeScope({ covered: [e, q] }, { currentOnly: false }); assert.equal(plan.selected.length, 1);
});
