import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareGolden, checkGolden, attachAssessment } from "../src/golden.mjs";
import { runGoldenCli } from "../src/golden-cli.mjs";
import { digest } from "../src/lesson-package.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "golden-test-")), capture = path.join(root, "capture"), bundle = path.join(root, "bundle");
  fs.mkdirSync(path.join(capture, "positive-reference"), { recursive: true }); fs.mkdirSync(path.join(capture, "repo"));
  const natives = [{ stem: "Which animal crossed the river?", options: ["Fox", "Hare"], correct: 0 },
    { words: [{ w: "Fox", to: "crosser" }], boxes: { crosser: {}, commentator: {} } },
    { criteria: [{ requirement: "Name the crossing animal and its action." }], question: "What happened?" }];
  const context = { pages: [{ id: "READ", nodes: natives }] }, bytes = JSON.stringify(context), sourceHash = digest(bytes), commit = "a".repeat(40);
  const views = [{ stem: natives[0].stem, options: natives[0].options, key: [0] }, { items: natives[1].words.map(row => ({ word: row.w, to: row.to })), boxes: natives[1].boxes }, { prompt: natives[2].question, rubric: natives[2] }];
  const rows = natives.map((native, i) => ({ kind: ["reading_mcq", "classify", "open_check"][i], role: "question", pointer: `/pages/0/nodes/${i}`,
    native, view: views[i], operation: `example-${i}`, extraction_order: i + 1, source_commit: commit, source_sha256: sourceHash }));
  const questions = rows.map(row => JSON.stringify(row)).join("\n") + "\n";
  fs.writeFileSync(path.join(capture, "repo/lesson.json"), bytes); fs.writeFileSync(path.join(capture, "positive-reference/questions.jsonl"), questions);
  fs.writeFileSync(path.join(capture, "positive-reference/manifest.json"), JSON.stringify({ questions: "positive-reference/questions.jsonl", questions_sha256: digest(questions),
    lesson_context: "repo/lesson.json", source_occurrences: rows.length, source: { commit, sha256: sourceHash, baseline: { designation: "user-designated positive reference" } } }));
  return { root, capture, bundle, rows, dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
}
test("golden preparation retains exact source bytes and creates distinct, demonstrated fault variants", () => {
  const f = fixture(); try {
    const before = fs.readFileSync(path.join(f.capture, "positive-reference/questions.jsonl"));
    const result = prepareGolden(f.capture, f.bundle); assert.equal(result.references, 3); assert.equal(result.controlled_variants, 4); assert.equal(result.model_calls, 0);
    assert.deepEqual(fs.readFileSync(path.join(f.bundle, "source/questions.jsonl")), before);
    assert.deepEqual(fs.readFileSync(path.join(f.capture, "positive-reference/questions.jsonl")), before);
    const variants = JSON.parse(fs.readFileSync(path.join(f.bundle, "controlled-variants.json")));
    assert.ok(variants.every(row => row.code_observation.checks.some(check => check.id === row.expected.check && check.verdict === "fail")));
    const plan = JSON.parse(fs.readFileSync(path.join(f.bundle, "assessment-plan.json")));
    assert.ok(plan.every(row => row.dimensions.every(dimension => dimension.verdict === null && dimension.status === "not_run")));
    assert.equal(result.qualified, false);
  } finally { f.dispose(); }
});
test("changed references and an incorrect external bundle pin fail integrity verification", () => {
  const f = fixture(); try {
    prepareGolden(f.capture, f.bundle);
    assert.throws(() => checkGolden(f.bundle, "b".repeat(64)), /external bundle pin/);
    fs.appendFileSync(path.join(f.bundle, "references.json"), " ");
    assert.throws(() => checkGolden(f.bundle), /immutable reference artifact/);
  } finally { f.dispose(); }
});
test("a secondary source stays below the default positive reference and does not inherit its designation", () => {
  const f = fixture(); try {
    const result = runGoldenCli({ root: f.root, argv: ["--golden-reference", f.capture, "--reference-tier", "secondary", "--out", ".local/golden/secondary"] });
    const manifest = JSON.parse(fs.readFileSync(path.join(result.root, "manifest.json")));
    assert.equal(result.tier, "secondary"); assert.equal(manifest.priority, 2);
    assert.match(manifest.designation, /not a default positive/);
    assert.ok(JSON.parse(fs.readFileSync(path.join(result.root, "assessment-plan.json"))).every(row => row.expected_baseline === "secondary reference candidate; no quality verdict"));
    assert.throws(() => runGoldenCli({ root: f.root, argv: ["--golden-check", result.root, "--reference-tier", "primary"] }), /do not use/);
  } finally { f.dispose(); }
});
test("assessment imports preserve original bytes, chain records and never promote a claimed approval", () => {
  const f = fixture(); try {
    const result = prepareGolden(f.capture, f.bundle), file = path.join(f.root, "run.json"), content = '{"qualified":true,"counts":{"pass":999}}\n'; fs.writeFileSync(file, content);
    const a = attachAssessment(f.bundle, file, { kind: "model-development", relation: "historical" });
    const b = attachAssessment(f.bundle, file, { kind: "source-review" });
    assert.equal(a.quality_approval, false); assert.equal(a.independent_labels_admitted, 0);
    assert.equal(checkGolden(f.bundle).assessment_records, 2);
    assert.equal(fs.readFileSync(path.join(f.bundle, a.artifact), "utf8"), content);
    assert.notEqual(a.assessment_id, b.assessment_id);
    fs.appendFileSync(path.join(f.bundle, a.artifact), " ");
    assert.throws(() => checkGolden(f.bundle), /assessment artifact changed/);
    assert.equal(result.qualified, false);
  } finally { f.dispose(); }
});
test("source-native preservation cannot hide a replaced normalized stem or swapped in-range key", () => {
  const f = fixture(); try {
    const file = path.join(f.capture, "positive-reference/questions.jsonl"), manifestFile = path.join(f.capture, "positive-reference/manifest.json");
    const rows = fs.readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
    rows[0].view.stem = "A replacement question that was never authored."; rows[0].view.key = [1];
    const bytes = rows.map(row => JSON.stringify(row)).join("\n") + "\n"; fs.writeFileSync(file, bytes);
    const manifest = JSON.parse(fs.readFileSync(manifestFile)); manifest.questions_sha256 = digest(bytes); fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    assert.throws(() => prepareGolden(f.capture, f.bundle), /normalized key/);
    assert.equal(fs.existsSync(f.bundle), false);
  } finally { f.dispose(); }
});
test("a genuine assessment receipt from another bundle cannot be transplanted under the primary manifest pin", () => {
  const f = fixture(); try {
    const primary = prepareGolden(f.capture, f.bundle), second = path.join(f.root, "second"); prepareGolden(f.capture, second, { tier: "secondary" });
    const file = path.join(f.root, "run.json"), secondCheck = checkGolden(second); fs.writeFileSync(file, JSON.stringify({ golden_manifest_sha256: secondCheck.manifest_sha256 }));
    const receipt = attachAssessment(second, file, { kind: "integration-test", relation: "same-reference" });
    for (const name of [receipt.artifact, `assessments/${receipt.assessment_id}.receipt.json`, "assessments/journal.jsonl"]) fs.copyFileSync(path.join(second, name), path.join(f.bundle, name));
    assert.throws(() => checkGolden(f.bundle, primary.manifest_sha256), /another bundle/);
  } finally { f.dispose(); }
});
test("same-reference claims require the exact bundle pin and unsafe artifacts cannot enter the journal", () => {
  const f = fixture(); try {
    const result = prepareGolden(f.capture, f.bundle), file = path.join(f.root, "run.json");
    fs.writeFileSync(file, '{"counts":{}}');
    assert.throws(() => attachAssessment(f.bundle, file, { kind: "integration-test", relation: "same-reference" }), /exact bundle pin/);
    fs.writeFileSync(file, JSON.stringify({ golden_manifest_sha256: result.manifest_sha256, counts: {} }));
    assert.equal(attachAssessment(f.bundle, file, { kind: "integration-test", relation: "same-reference" }).quality_approval, false);
    fs.writeFileSync(file, JSON.stringify({ credential: "apk_" + "x".repeat(25) }));
    assert.throws(() => attachAssessment(f.bundle, file, { kind: "manual-notes" }), /credential-shaped/);
    assert.equal(checkGolden(f.bundle).assessment_records, 1);
  } finally { f.dispose(); }
});
test("the same-runner branch uses copied bundle files and rejects model flags", () => {
  const f = fixture(); try {
    const result = runGoldenCli({ root: f.root, argv: ["--golden-reference", f.capture, "--out", ".local/golden/current"] });
    fs.rmSync(f.capture, { recursive: true });
    assert.equal(runGoldenCli({ root: f.root, argv: ["--golden-check", result.root] }).references, 3);
    const file = path.join(f.root, "run.json"); fs.writeFileSync(file, '{"counts":{}}');
    const attached = runGoldenCli({ root: f.root, argv: ["--golden-check", result.root, "--assessment", file, "--assessment-kind", "integration-test"] });
    assert.equal(attached.assessment_records, 1);
    assert.notEqual(attached.assessment_journal_sha256, result.assessment_journal_sha256);
    assert.throws(() => runGoldenCli({ root: f.root, argv: ["--golden-check", result.root, "--judge", "jev"] }), /unsupported/);
    assert.throws(() => runGoldenCli({ root: f.root, argv: ["--golden-check", result.root, "--mode", "development"] }), /unsupported/);
    assert.throws(() => runGoldenCli({ root: f.root, argv: ["--golden-check", result.root, "--out", "ignored"] }), /do not use/);
  } finally { f.dispose(); }
});
