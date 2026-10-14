import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inputIssues } from "../src/packet.mjs";
import { digest } from "../src/lesson-package.mjs";
import { courseSeen, prepareTextLesson, runTextLessonDraw, summarizeTextLesson, textLessonReviewPacket } from "../src/text-lesson.mjs";

const protocol = JSON.parse(fs.readFileSync(new URL("../criteria/corpus-choice-probe.json", import.meta.url)));

test("an empty classification fails structural checks and cannot agree vacuously with its author key", () => {
  const pkg = fixture(), item = pkg.set.items[2];
  item.view.entries = []; item.view.categories = []; item.view.mapping = {}; item.view.entry_feedback = {};
  pkg.context.native.pages[1].question_slots[2] = { id: "author-slot-3", type: "classify", ...structuredClone(item.view) };
  item.native = structuredClone(pkg.context.native.pages[1].question_slots[2]);
  assert.deepEqual(inputIssues(pkg.context, pkg.set), []);
  const plan = prepareTextLesson(pkg), row = plan.fields.find(row => row.original_item_id === item.id), id = row.id;
  assert.equal(row.checks.find(check => check.id === "entries_present").verdict, "fail");
  assert.equal(row.checks.find(check => check.id === "categories_present").verdict, "fail");
  const draw = { results: [{ id, providers: { primary: { blind: { checks: [{ id: "answerable", verdict: "yes" }, { id: "clear", verdict: "yes" }] }, editorial: { checks: [] } } } }] };
  const summary = summarizeTextLesson([draw, draw], plan), result = summary.items.find(row => row.item_id === item.id);
  assert.equal(result.models.primary.outcomes[0].code_fields_valid, false);
  assert.equal(result.models.primary.outcomes[0].author_key_agreement, null);
  assert.equal(result.academic_approval, false);
});

// Arbitrary public transport data; these are integration checks, not academic labels.
function fixture() {
  const river = "The fox crossed the river.";
  const scholar = "The hare described the fox as a scholar.";
  const field = "The fox never led a squadron in the field.";
  const context = {
    contract: "lesson-context 0.1", source: {},
    lesson: { id: "fixture-text", title: "PRIVATE_COURSE_TITLE", learning_question: "PRIVATE_COURSE_QUESTION", keywords: [] },
    native: { metadata: { text: "PRIVATE_COURSE_METADATA" }, pages: [
      { id: "ORIENT", nodes: [{ type: "instruction", text: "Read the supplied passage before responding.",
        learning_question: "What does the narrator report?", key_term: { term: "squadron", meaning: "a group of soldiers" } }], question_slots: [] },
      { id: "READ", nodes: [
        { type: "reading", blocks: [{ kind: "script", lines: [
          { who: "Narrator", line: river }, { who: "Narrator", line: scholar }, { who: "Narrator", line: field }
        ] }] },
        { type: "instruction", text: "Use only the supplied lines.",
          keywords: [{ word: "directly", meaning: "explicitly in the words" }],
          glossary: [{ term: "scholar", note: "someone who studies" }] },
        { type: "worked_instruction", line: "The owl stayed home.", quote: "stayed",
          steps: [{ stem: "Which word gives the action?", sentence: "The word stayed gives the action.", think: "Check the exact wording." }] }
      ], question_slots: [] },
      { id: "LATER", nodes: [{ type: "reading", blocks: [{ lines: ["PRIVATE_FUTURE_TEXT"] }] }], question_slots: [] }
    ] }
  };
  const views = [
    { stem: "According to the narrator, who crossed the river?", options: ["Fox", "Hare"], key: [0],
      option_feedback: ["PRIVATE_OPTION_FEEDBACK", "PRIVATE_OPTION_FEEDBACK"], correct_feedback: "PRIVATE_CORRECT_FEEDBACK" },
    { prompt: "Select the line that most directly states the fox's lack of field experience.", claim: "PRIVATE_BROADER_METADATA_CLAIM",
      candidates: [scholar, field], key: [1], selection_rule: "Select exactly one candidate.",
      option_feedback: ["PRIVATE_EVIDENCE_FEEDBACK", "PRIVATE_EVIDENCE_FEEDBACK"], correct_feedback: "PRIVATE_CORRECT_FEEDBACK" },
    { prompt: "Match each animal to its role in the passage.",
      categories: [{ id: "PRIVATE_CATEGORY_CROSSER", label: "River crosser", description: "The animal reported to cross the river." },
        { id: "PRIVATE_CATEGORY_COMMENTATOR", label: "Commentator", description: "The animal describing another animal." }],
      entries: [{ id: "PRIVATE_ENTRY_FOX", text: "Fox" }, { id: "PRIVATE_ENTRY_HARE", text: "Hare" }],
      mapping: { PRIVATE_ENTRY_FOX: "PRIVATE_CATEGORY_CROSSER", PRIVATE_ENTRY_HARE: "PRIVATE_CATEGORY_COMMENTATOR" },
      entry_feedback: { PRIVATE_ENTRY_FOX: "PRIVATE_ENTRY_FEEDBACK", PRIVATE_ENTRY_HARE: "PRIVATE_ENTRY_FEEDBACK" },
      correct_feedback: "PRIVATE_CORRECT_FEEDBACK" },
    { prompt: "Quote one line and explain what it states about the fox.", sample_answer: "PRIVATE_SAMPLE_RESPONSE",
      feedback: "PRIVATE_OPEN_FEEDBACK", rubric: { criteria: [{ id: "quote", requirement: "PRIVATE_RUBRIC_REQUIREMENT" }] } }
  ];
  const kinds = ["reading_mcq", "evidence_select", "classify", "open_check"];
  const set = { contract: "question-set 0.1", source: {}, lesson: context.lesson.id, made_by: { kind: "authored" }, items: [] };
  for (const [index, view] of views.entries()) {
    const native = { id: `author-slot-${index + 1}`, type: kinds[index], ...structuredClone(view) };
    context.native.pages[1].question_slots.push(native);
    set.items.push({ id: `author-item-${index + 1}`, page: "READ", order: index + 1, kind: kinds[index],
      pointer: `/pages/1/question_slots/${index}`, native: structuredClone(native), view,
      alignment: { target_refs: ["target"], role: "independent-response-check" },
      source_anchors: index === 0 ? [{ source_ref: "source", quote: river, field_ref: "/view/options/0", relation: "supports" }] : [] });
  }
  const request = { course_context: { core_knowledge: [{ id: "target", claim: "PRIVATE_TARGET_CLAIM", performance: "PRIVATE_TARGET_PERFORMANCE" }] },
    sequence_blueprint: views.map(() => ({ role: "independent-response-check", support: "PRIVATE_PLANNED_SUPPORT" })) };
  return { request, source: {}, context, set };
}

const forbidden = new Set(["key", "answer", "mapping", "option_feedback", "entry_feedback", "correct_feedback", "feedback", "rubric", "sample_answer",
  "claim", "source_anchors", "source_bindings", "producer", "made_by", "metadata"]);
function assertBlind(value) {
  if (Array.isArray(value)) return value.forEach(assertBlind);
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert.equal(forbidden.has(key), false, `author field leaked: ${key}`);
    assertBlind(child);
  }
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE_/);
}

function provider(probability = id => id === "option_B" || id === "entry_1_B" || id === "entry_2_A" ? 0 : 1) {
  return { name: "gemini-flash", model: "test-alias", async ask(state, questions, { sample }) {
    if (Object.hasOwn(state, "question")) assertBlind(state);
    return { model: "gemini-3.8-flash", answers: Object.fromEntries(questions.map(question => [question.id,
      { noul: probability(question.id, sample, state) }])) };
  } };
}

test("public question-slot pointers prepare a blind packet without changing the author candidate order", () => {
  const pkg = fixture(), plan = prepareTextLesson(pkg);
  assert.deepEqual(inputIssues(pkg.context, pkg.set), []);
  assert.deepEqual(plan.cases.map(item => item.kind), ["reading_mcq", "evidence_select", "classify", "open_check"]);
  for (const item of plan.cases) assertBlind(item.blind);
  const review = textLessonReviewPacket(plan);
  assertBlind(review);
  assert.equal(review.source_key_feedback_and_rubric_withheld, true);
  assert.equal(review.items[0].learner_view.question, pkg.set.items[0].view.stem);
  assert.deepEqual(review.items[1].learner_view.options, { A: pkg.set.items[1].view.candidates[0], B: pkg.set.items[1].view.candidates[1] });
  assert.ok(review.items.every(item => Object.values(item.review).every(value => value === null)));
  assert.deepEqual(plan.expectations[0].key, [0]);
});

test("visible source and instruction precede the task while future pages and course metadata stay withheld", () => {
  const pkg = fixture();
  pkg.context.native.pages[1].nodes[0].blocks.push({ metadata: { text: "PRIVATE_BLOCK_METADATA", note: "PRIVATE_BLOCK_NOTE" } });
  const seen = courseSeen(pkg.context, pkg.set.items[0]);
  for (const expected of ["Read the supplied passage", "What does the narrator report?", "squadron: a group of soldiers",
    "Narrator: The fox crossed the river.", "Use only the supplied lines.", "directly: explicitly in the words", "scholar: someone who studies",
    "The owl stayed home.", "Which word gives the action?", "Check the exact wording."]) assert.ok(seen.includes(expected), expected);
  assert.doesNotMatch(seen, /PRIVATE_/);
  assertBlind(prepareTextLesson(pkg).cases[0].blind);
});

test("evidence probes judge the exact most-direct prompt and retain its visible selection rule", () => {
  const pkg = fixture(), evidence = prepareTextLesson(pkg).cases[1];
  assert.equal(evidence.blind.question, pkg.set.items[1].view.prompt);
  assert.equal(evidence.blind.selection_rule, "Select exactly one candidate.");
  assert.doesNotMatch(JSON.stringify(evidence.blind), /BROADER_METADATA_CLAIM/);
  for (const question of evidence.blind_questions.filter(question => question.id.startsWith("option_"))) {
    assert.match(JSON.stringify(question), /EXACTLY as written/);
    assert.match(JSON.stringify(question), /most-direct\/best/);
    assert.match(JSON.stringify(question), /actual prompt, not a broader metadata claim/);
  }
  pkg.set.items[1].view.claim = "A changed, broader author interpretation.";
  assert.deepEqual(prepareTextLesson(pkg).cases[1].blind, evidence.blind);
});

test("classification presents category descriptions while its intended mapping stays in parent expectations", () => {
  const plan = prepareTextLesson(fixture()), classification = plan.cases[2];
  assert.deepEqual(classification.blind.entries, { E1: "Fox", E2: "Hare" });
  assert.deepEqual(classification.blind.categories, {
    A: { label: "River crosser", description: "The animal reported to cross the river." },
    B: { label: "Commentator", description: "The animal describing another animal." }
  });
  assert.deepEqual(plan.expectations[2].mapping, [0, 1]);
  assertBlind(classification.blind);
  assert.equal(Object.hasOwn(classification.editorial, "mapping"), false);
  assert.equal(Object.hasOwn(classification.editorial.task, "mapping"), false);
  assert.deepEqual(classification.blind_questions.filter(question => question.id.startsWith("entry_")).map(question => question.id),
    ["entry_1_A", "entry_1_B", "entry_2_A", "entry_2_B"]);
});

test("source bindings resolve the declared item field and reject absent or unresolved field references", () => {
  const pkg = fixture(), item = pkg.set.items[0], plan = prepareTextLesson(pkg);
  assert.deepEqual(plan.cases[0].editorial.bindings[0], {
    quote: "The fox crossed the river.", claimed_relation: "supports", candidate_field: "Fox"
  });
  assert.equal(plan.fields[0].checks.find(check => check.id === "binding_1_field_exists").verdict, "pass");
  for (const fieldRef of [undefined, "/view/options/9"]) {
    item.source_anchors[0].field_ref = fieldRef;
    const invalid = prepareTextLesson(pkg);
    assert.equal(invalid.fields[0].checks.find(check => check.id === "binding_1_field_exists").verdict, "fail");
    assert.equal(invalid.cases[0].editorial.bindings[0].candidate_field, null);
  }
});

test("one uncertain or conflicting sample vetoes blind author-key agreement in the text route", async () => {
  const plan = prepareTextLesson(fixture());
  for (const probabilities of [[1, 1, 0.5], [1, 1, 0]]) {
    const results = await runTextLessonDraw([plan.cases[0]], { side: provider((id, sample) => id === "option_A" ? probabilities[sample] : id === "option_B" ? 0 : 1),
      protocol, samples: 3, draw: 1 });
    const check = results[0].providers.side.blind.checks.find(check => check.id === "option_A");
    assert.equal(check.verdict, "unsure");
    assert.deepEqual(check.samples.map(sample => sample.p_yes), probabilities);
    assert.ok(check.reasons.includes(probabilities[2] === 0.5 ? "a_sample_abstained" : "samples_disagree"));
    const summary = summarizeTextLesson([{ draw: 1, results }], plan);
    assert.equal(summary.items[0].models.side.outcomes[0].decisive_blind_checks, false);
    assert.equal(summary.items[0].models.side.outcomes[0].author_key_agreement, null);
  }
});

test("repeated positive mock signals retain post-probe key and mapping comparisons without academic approval", async () => {
  const plan = prepareTextLesson(fixture()), cases = [plan.cases[0], plan.cases[2]];
  const first = await runTextLessonDraw(cases, { side: provider(), protocol, samples: 3, draw: 1 });
  const second = await runTextLessonDraw(cases, { side: provider(), protocol, samples: 3, draw: 2 });
  const summary = summarizeTextLesson([{ draw: 1, results: first }, { draw: 2, results: second }], plan);
  for (const index of [0, 2]) {
    const result = summary.items[index];
    assert.equal(result.models.side.repeated_verdicts_identical, true);
    assert.deepEqual(result.models.side.outcomes.map(outcome => outcome.author_key_agreement), [true, true]);
    assert.equal(result.academic_approval, false);
  }
  assert.equal(summary.independent_gold_labels, 0);
  assert.equal(summary.qualified, false);
  assert.equal(plan.qualification, false);
  assert.match(summary.meaning, /unvalidated author-key/);
});

test("a standalone lesson CLI records pinned offline evidence and rejects qualified model review before launch", t => {
  const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const standalone = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "text-lesson-cli-")));
  t.after(() => fs.rmSync(standalone, { recursive: true, force: true }));
  for (const directory of ["src", "criteria", "contracts", "bin"]) fs.cpSync(path.join(repository, directory), path.join(standalone, directory), { recursive: true });
  fs.mkdirSync(path.join(standalone, "fixtures"));
  for (const file of ["fixtures/knowledge-baseline.json", "config.lesson.json"]) fs.copyFileSync(path.join(repository, file), path.join(standalone, file));
  const finished = path.join(standalone, ".local", "finished");
  fs.mkdirSync(finished, { recursive: true });
  const pkg = fixture(), sourceText = pkg.context.native.pages[1].nodes[0].blocks[0].lines.map(line => line.line).join("\n");
  pkg.request.course_context.source_assets = [{ id: "source", text: sourceText }];
  pkg.request.course_context.content_keys = [{ id: "content" }];
  pkg.request.course_context.pairing_tables = [{ id: "pairs", pairs: [{ id: "pair" }] }];
  pkg.request.course_context.lesson_plan = { phases: [
    { id: "ORIENT", after: [] }, { id: "READ", after: ["ORIENT"] }, { id: "LATER", after: ["READ"] }
  ] };
  pkg.source = { assets: structuredClone(pkg.request.course_context.source_assets) };
  for (const [index, item] of pkg.set.items.entries()) {
    Object.assign(item.alignment, { phase_ref: "READ", source_refs: ["source"], content_key_refs: ["content"], pair_refs: ["pair"], support: "PRIVATE_PLANNED_SUPPORT" });
    pkg.request.sequence_blueprint[index] = { ...pkg.request.sequence_blueprint[index], formats: [item.kind], alignment: structuredClone(item.alignment) };
    if (!item.source_anchors.length) item.source_anchors.push({ source_ref: "source", quote: "The fox crossed the river.", field_ref: "/view/prompt", relation: "limits" });
  }
  const hashes = {};
  for (const [name, value] of [["course-request.json", pkg.request], ["course-source-packet.json", pkg.source], ["lesson-context.json", pkg.context], ["question-set.json", pkg.set]]) {
    const bytes = JSON.stringify(value) + "\n";
    fs.writeFileSync(path.join(finished, name), bytes);
    hashes[name] = digest(bytes);
  }
  const attemptedFetch = path.join(standalone, ".local", "unexpected-fetch");
  const guard = path.join(standalone, ".local", "network-guard.mjs");
  fs.writeFileSync(guard, `import fs from "node:fs";\nglobalThis.fetch = () => { fs.writeFileSync(${JSON.stringify(attemptedFetch)}, "attempted"); throw new Error("NETWORK_FORBIDDEN"); };\n`);
  const run = (...args) => spawnSync(process.execPath, ["--import", guard, "--", path.join(standalone, "bin", "evaluate.mjs"),
    "--lesson-package", finished, "--course-pin", hashes["course-request.json"], "--config", "config.lesson.json", ...args],
  { cwd: standalone, env: {}, encoding: "utf8", timeout: 30000 });
  const child = run("--out", ".local/test");
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout), out = path.join(standalone, ".local", "test");
  const read = name => JSON.parse(fs.readFileSync(path.join(out, name), "utf8"));
  const manifest = read("manifest.json"), report = read("report.json"), audit = read("lesson-audit.json"), review = read("review-packet.json");
  assert.equal(result.items, 4);
  assert.equal(result.model_calls, 0);
  assert.equal(result.qualified, false);
  assert.equal(report.model_calls, 0);
  assert.equal(report.mode, "offline");
  assert.equal(report.qualified, false);
  assert.equal(manifest.independent_gold_labels, 0);
  assert.equal(manifest.pinned_served_revision_verified, false);
  assert.equal(manifest.external_course_pin_verified, true);
  assert.equal(audit.external_course_pin_verified, true);
  assert.deepEqual(manifest.lesson_input_hashes, hashes);
  assert.deepEqual(audit.input_hashes, hashes);
  assert.equal(manifest.runtime.config.sha256, digest(fs.readFileSync(path.join(standalone, "config.lesson.json"))));
  assert.ok(manifest.runtime.files.some(file => file.path === "src/text-lesson.mjs"));
  assert.equal(manifest.packet_sha256, digest(fs.readFileSync(path.join(out, "solver-packet.json"))));
  assert.equal(manifest.author_fields_sha256, digest(fs.readFileSync(path.join(out, "author-fields.json"))));
  assert.equal(audit.status, "structural_alignment_checked");
  assert.equal(audit.academic_approval, false);
  assert.equal(audit.fields.length, 4);
  assert.ok(audit.fields.every(item => item.checks.every(check => check.verdict === "pass")));
  assert.equal(review.source_key_feedback_and_rubric_withheld, true);
  assertBlind(review);
  assert.deepEqual(review.items[2].learner_view.entries, { E1: "Fox", E2: "Hare" });
  assert.equal(review.items[2].learner_view.categories.A.description, "The animal reported to cross the river.");
  assertBlind(read("review-a.json"));
  assertBlind(read("review-b.json"));
  const reader = fs.readFileSync(path.join(out, "lesson.txt"), "utf8");
  assert.match(reader, /Categories: A: River crosser \(The animal reported to cross the river\.\)/);
  assert.match(reader, /E1\. Fox/);
  assert.match(reader, /E2\. Hare/);
  assert.match(reader, /Intended mapping:/);
  assert.equal(fs.existsSync(path.join(out, "draw-1")), false);
  assert.equal(fs.existsSync(attemptedFetch), false);
  for (const providerArgs of [["--judge", "jev"], ["--side-judge", "gemini-flash"]]) {
    const rejected = `.local/rejected-${providerArgs[0].slice(2)}`;
    const refusal = run(...providerArgs, "--mode", "qualified", "--env-file", path.join(standalone, "absent-launch-file"), "--out", rejected);
    assert.notEqual(refusal.status, 0);
    assert.match(refusal.stderr, /requires explicit development mode; no scope is qualified/);
    assert.doesNotMatch(refusal.stderr, /ENOENT|credential|API_KEY|NETWORK_FORBIDDEN/);
    assert.equal(fs.existsSync(path.join(standalone, rejected)), false);
    assert.equal(fs.existsSync(attemptedFetch), false);
  }
});
