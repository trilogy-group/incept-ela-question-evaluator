import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runner = path.join(root, "bin/evaluate.mjs");
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const privateMode = (file) => fs.statSync(file).mode & 0o777;

// All answers below are synthetic author intent for plumbing tests, never academic labels.
function fixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "corpus-cli-test-")));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const corpus = path.join(directory, "retained"), cwd = path.join(directory, "another-cwd");
  fs.mkdirSync(path.join(corpus, "contexts"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(cwd, { mode: 0o700 });
  const choices = [
    { type: "choice", prompt: "According to the passage, which animal crossed the river?", section: "Guiding 1",
      choices: [{ text: "Fox", correct: true, why: "PRIVATE_FEEDBACK_SENTINEL" }, { text: "Hare", correct: false }],
      producer: "PRIVATE_PRODUCER_SENTINEL", rubric: { reveal: "PRIVATE_REVEAL_SENTINEL" } },
    { type: "choice", prompt: "According to the passage, where did the hare sleep?", section: "Guiding 1",
      choices: [{ text: "Near the river", correct: false }, { text: "Near the hill", correct: true }] },
    { type: "spoken", prompt: "Say the animal's name.", expected: "PRIVATE_EXPECTED_SENTINEL" }
  ];
  const context = { lessons: [
    { resource: "synthetic-lesson-1", passage: [{ section: "Guiding 1", paras: ["The fox crossed the river."] }], questions: [choices[0]] },
    { resource: "synthetic-lesson-2", passage: [{ section: "Guiding 1", paras: ["A hare slept near the hill."] }], questions: [choices[1], choices[2]] }
  ] };
  const contextName = "contexts/alpha-synthetic.json", contextBytes = JSON.stringify(context);
  const source = { id: "alpha-synthetic", adapter: "alpha-read", path: "finished-authored-course.json", repository: "development/source-fixture",
    commit: "1".repeat(40), sha256: "2".repeat(64), context: contextName, context_sha256: sha(contextBytes),
    occurrences: 3, omissions: [], version_role: "historical source fixture", authorship: "PRIVATE_AUTHOR_SENTINEL" };
  const rows = choices.map((native, index) => ({ id: `synthetic-row-${index + 1}`, kind: index < 2 ? "multiple_choice" : "spoken_response",
    native, prompt: native.prompt, role: "question", quality_label: null, intended_answer_status: "synthetic author intent; unvalidated",
    occurrences: [{ source_id: source.id, context: contextName, context_pointer: `/lessons/${index === 0 ? 0 : 1}`,
      pointer: index === 0 ? "/lessons/0/questions/0" : `/lessons/1/questions/${index - 1}` }] }));
  const rowBytes = rows.map(row => JSON.stringify(row)).join("\n") + "\n";
  fs.writeFileSync(path.join(corpus, contextName), contextBytes, { mode: 0o600 });
  fs.writeFileSync(path.join(corpus, "questions.jsonl"), rowBytes, { mode: 0o600 });
  const catalog = { sources: [source], files: { [contextName]: sha(contextBytes), "questions.jsonl": sha(rowBytes) },
    counts: { unique_examples: 3, source_occurrences: 3, source_snapshots: 1, by_kind: { multiple_choice: 2, spoken_response: 1 }, by_role: { question: 3 } } };
  const catalogBytes = JSON.stringify(catalog); fs.writeFileSync(path.join(corpus, "catalog.json"), catalogBytes, { mode: 0o600 });
  const attemptedFetch = path.join(directory, "unexpected-network-attempt.json"), guard = path.join(directory, "network-guard.mjs");
  fs.writeFileSync(guard, `import fs from "node:fs";\nglobalThis.fetch = () => { fs.writeFileSync(${JSON.stringify(attemptedFetch)}, "network attempted"); throw new Error("NETWORK_FORBIDDEN"); };\n`, { mode: 0o600 });
  const run = (...args) => spawnSync(process.execPath, ["--import", guard, "--", runner, "--corpus", corpus,
    "--catalog-sha256", sha(catalogBytes), ...args], { cwd, env: {}, encoding: "utf8", timeout: 30000 });
  return { directory, corpus, run, attemptedFetch, catalog_sha256: sha(catalogBytes) };
}

function assertPrivateTree(directory) {
  assert.equal(privateMode(directory), 0o700);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) assertPrivateTree(file);
    else assert.equal(privateMode(file), 0o600);
  }
}

test("standalone corpus CLI records every source row and selects a private key-blind offline pilot", (t) => {
  const f = fixture(t), out = path.join(f.directory, "offline-output"), child = f.run("--out", out);
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout), report = read(path.join(out, "report.json")), plan = read(path.join(out, "plan.json"));
  const packet = read(path.join(out, "solver-packet.json")), keys = read(path.join(out, "source-keys.json"));
  const fields = read(path.join(out, "field-checks.json")), manifest = read(path.join(out, "manifest.json"));
  assert.equal(result.model_calls, 0); assert.equal(report.model_calls, 0); assert.equal(result.qualification, false);
  assert.equal(report.academic_accuracy, "unmeasured"); assert.equal(manifest.mode, "offline"); assert.equal(manifest.independent_gold_labels, 0);
  assert.equal(manifest.corpus_catalog_sha256, f.catalog_sha256); assert.equal(plan.corpus_input.external_catalog_pin_verified, true);
  assert.equal(plan.counts.rows, 3); assert.equal(plan.counts.occurrences, 3); assert.equal(plan.counts.covered, 2); assert.equal(plan.counts.excluded, 1);
  assert.equal(fields.rows.length, 3); assert.equal(fields.summary.rows, 3); assert.equal(fields.summary.source_occurrences, 3);
  assert.equal(result.selected_cases, 2); assert.equal(plan.selected_rows, 2); assert.equal(packet.cases.length, 2);
  assert.equal(keys.expectations.length, 2); assert.deepEqual(keys.expectations.map(row => row.authored_key), [[0], [1]]);
  assert.ok(keys.expectations.every(row => Array.isArray(row.authored_key) && row.authored_key.length === 1 && Number.isInteger(row.authored_key[0])));
  assert.ok(keys.expectations.every(row => row.source_key_status === "unvalidated author intent; not academic gold"));
  assert.equal(plan.coverage_exclusions.length, 1); assert.equal(plan.coverage_exclusions[0].id, "synthetic-row-3");
  for (const candidate of packet.cases) {
    assert.deepEqual(Object.keys(candidate).sort(), ["id", "solver_context"]);
    const solver = candidate.solver_context;
    assert.deepEqual(Object.keys(solver).sort(), ["options", "passages", "question"]);
    assert.equal(typeof solver.question, "string"); assert.ok(solver.passages.every(text => typeof text === "string"));
    assert.ok(solver.options.every(text => typeof text === "string")); assert.equal(solver.options.length, 2);
  }
  const serializedSolver = JSON.stringify(packet);
  assert.doesNotMatch(serializedSolver, /PRIVATE_|authored_key|correct|rubric|reveal|feedback|producer|provenance|expected|synthetic-row/);
  assert.equal(manifest.packet_sha256, sha(fs.readFileSync(path.join(out, "solver-packet.json"))));
  assert.equal(manifest.source_keys_sha256, sha(fs.readFileSync(path.join(out, "source-keys.json"))));
  assert.equal(fs.existsSync(f.attemptedFetch), false); assert.equal(fs.existsSync(path.join(out, "draw-1")), false);
  assertPrivateTree(out);
});

test("corpus model providers require explicit development mode before launch credentials are considered", (t) => {
  const f = fixture(t);
  for (const providerArgs of [["--judge", "jev"], ["--side-judge", "gemini-flash"]]) {
    const out = path.join(f.directory, `rejected-${providerArgs[0].slice(2)}`);
    const child = f.run(...providerArgs, "--env-file", path.join(f.directory, "deliberately-absent-launch-file"), "--out", out);
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /requires explicit development mode/);
    assert.doesNotMatch(child.stderr, /ENOENT|missing.*(?:credential|key)|deliberately-absent-launch-file/);
    assert.equal(fs.existsSync(out), false); assert.equal(fs.existsSync(f.attemptedFetch), false);
  }
});

test("corpus CLI rejects a public checkout output path before creating it", (t) => {
  const f = fixture(t), out = path.join(root, "test", `corpus-cli-forbidden-${crypto.randomUUID()}`);
  assert.equal(fs.existsSync(out), false);
  const child = f.run("--out", out);
  assert.notEqual(child.status, 0); assert.match(child.stderr, /outputs inside the checkout must be private/);
  assert.equal(fs.existsSync(out), false); assert.equal(fs.existsSync(f.attemptedFetch), false);
});
