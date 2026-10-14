import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runner = path.join(root, "bin/evaluate.mjs");
const localRoot = path.join(root, ".local/B1003");
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const mode = (file) => fs.statSync(file).mode & 0o777;

function fixture(t) {
  fs.mkdirSync(localRoot, { recursive: true, mode: 0o700 });
  const dir = fs.mkdtempSync(path.join(localRoot, "review-cli-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cwd = path.join(dir, "another-cwd");
  fs.mkdirSync(cwd, { mode: 0o700 });
  const run = (...args) => spawnSync(process.execPath, [runner, ...args], {
    cwd, env: {}, encoding: "utf8", timeout: 30000
  });
  const successful = (...args) => {
    const result = run(...args);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  return { dir, cwd, run, successful };
}

function protectedTree(dir) {
  assert.equal(mode(dir), 0o700, `review directory permissions: ${dir}`);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) protectedTree(file);
    else assert.equal(mode(file), 0o600, `review file permissions: ${file}`);
  }
}

test("standalone private review stays unmeasured with blank sheets and two offline full draws", (t) => {
  const { dir, cwd, successful } = fixture(t);
  assert.notEqual(cwd, root);
  const prepDir = path.join(dir, "prepared");
  const prep = successful("--review", "prepare", "--out", prepDir);
  assert.equal(prep.operation, "prepare");
  assert.equal(prep.qualification, "unqualified");
  assert.equal(prep.model_calls, 0);
  assert.equal(prep.criteria, 125);
  assert.equal(prep.units, 13);
  assert.equal(prep.resolved_labels, 0);
  const bundleFile = path.join(prepDir, "bundle.json");
  const reviewA = path.join(prepDir, "review-a.json");
  const reviewB = path.join(prepDir, "review-b.json");
  const bundle = read(bundleFile);
  assert.equal(bundle.model, null);
  assert.equal(bundle.entries.length, 125);
  for (const file of [reviewA, reviewB]) {
    const sheet = read(file);
    assert.equal(sheet.rows.length, 125);
    assert.equal(sheet.reviewer_alias, null);
    assert.equal(sheet.independent_review_declared, false);
    assert.ok(sheet.rows.every((row) => row.verdict === null && row.rationale === null));
  }
  protectedTree(prepDir);

  const labelsDir = path.join(dir, "reconciled");
  const reconciliation = successful("--review", "reconcile", "--bundle", bundleFile,
    "--review-a", reviewA, "--review-b", reviewB, "--out", labelsDir);
  assert.equal(reconciliation.status, "labels-pending");
  assert.equal(reconciliation.resolved, 0);
  assert.equal(reconciliation.pending, 125);
  const labelsFile = path.join(labelsDir, "labels.json");
  assert.ok(read(labelsFile).labels.every((row) => row.verdict === null));
  protectedTree(labelsDir);

  const evaluationDir = path.join(dir, "offline-evaluation");
  const evaluated = successful("--mode", "development", "--out", evaluationDir);
  assert.equal(evaluated.mode, "development");
  assert.equal(evaluated.repeats, 2);
  assert.equal(evaluated.model_calls, 0);
  assert.equal(evaluated.logical_sample_calls, 0);
  const drawFiles = [1, 2].map((n) => path.join(evaluationDir, `draw-${n}/report.json`));
  const draws = drawFiles.map(read);
  assert.equal(new Set(draws.map((draw) => draw.execution.pid)).size, 2);
  assert.equal(new Set(draws.map((draw) => draw.execution.packet_sha256)).size, 1);
  assert.equal(new Set(draws.map((draw) => draw.execution.runtime_sha256)).size, 1);
  assert.equal(draws[0].execution.packet_sha256, bundle.bindings.packet_sha256);
  assert.equal(draws[0].execution.runtime_sha256, bundle.bindings.runtime_sha256);
  assert.equal(draws[0].execution.profile_sha256, bundle.bindings.profile_sha256);
  protectedTree(evaluationDir);

  const scoreDir = path.join(dir, "scored");
  const scored = successful("--review", "score", "--bundle", bundleFile, "--labels", labelsFile,
    "--draws", drawFiles.join(","), "--out", scoreDir);
  assert.equal(scored.qualification, "unqualified");
  assert.equal(scored.independent_gold, false);
  assert.equal(scored.model_calls, 0);
  assert.match(scored.accuracy, /^unmeasured/);
  const score = read(path.join(scoreDir, "score.json"));
  assert.deepEqual(score.counts, {
    distinct_criteria: 125, distinct_units: 13, resolved_labels: 0,
    pending_labels: 125, draws: 2, varied_criteria: 0
  });
  assert.equal(score.qualification, "unqualified");
  assert.equal(score.independent_gold, false);
  assert.equal(score.held_out, false);
  assert.ok(score.draws.every((draw) => draw.counts.labelled_criteria === 0));
  protectedTree(scoreDir);
});

test("review outputs reject tracked and non-.local checkout paths", (t) => {
  const { dir, run } = fixture(t);
  const name = `review-cli-forbidden-${path.basename(dir)}`;
  for (const forbidden of [
    path.join(root, "test", name),
    path.join(root, name)
  ]) {
    assert.equal(fs.existsSync(forbidden), false);
    const result = run("--review", "prepare", "--out", forbidden);
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(forbidden), false);
  }
});
