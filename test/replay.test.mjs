import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { compareDraws, runtimeSnapshot } from "../src/replay.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = (id, pid) => ({ execution: { invocation_id: id, pid, packet_sha256: "packet", runtime_sha256: "runtime", logical_sample_calls: 0 }, input: {}, items: [], set: [] });

test("repeat comparison rejects copied records and changed packet or runtime", () => {
  const a = fixture("one", 1), b = fixture("two", 2);
  assert.equal(compareDraws([a, b], "packet", "runtime", "offline-only").qualified, false);
  assert.throws(() => compareDraws([a, structuredClone(a)], "packet", "runtime", "offline-only"), /copied/);
  b.execution.packet_sha256 = "changed";
  assert.throws(() => compareDraws([a, b], "packet", "runtime", "offline-only"), /mismatch/);
  b.execution.packet_sha256 = "packet"; b.execution.runtime_sha256 = "changed";
  assert.throws(() => compareDraws([a, b], "packet", "runtime", "offline-only"), /mismatch/);
});

test("changing frozen learning-record bytes invalidates the recorded runtime", t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-learning-records-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  for (const directory of ["src", "criteria", "contracts", "bin", "fixtures"]) fs.mkdirSync(path.join(temporary, directory));
  fs.writeFileSync(path.join(temporary, "bin/evaluate.mjs"), "// isolated runtime-fingerprint fixture\n");
  fs.copyFileSync(path.join(root, "fixtures/knowledge-baseline.json"), path.join(temporary, "fixtures/knowledge-baseline.json"));
  const sourceRecords = path.join(temporary, "fixtures/criterion-source-records.json");
  fs.copyFileSync(path.join(root, "fixtures/criterion-source-records.json"), sourceRecords);
  const config = path.join(temporary, "config.json"); fs.writeFileSync(config, "{}\n");
  const before = runtimeSnapshot(temporary, config);
  fs.appendFileSync(sourceRecords, "\n");
  const after = runtimeSnapshot(temporary, config);
  assert.notEqual(before.sha256, after.sha256);
  assert.notEqual(before.files.find(row => row.path === "fixtures/criterion-source-records.json").sha256,
    after.files.find(row => row.path === "fixtures/criterion-source-records.json").sha256);
  assert.deepEqual(before.config, after.config);
  assert.deepEqual(before.node_runtime, after.node_runtime);
});

test("standalone default repeats in separate processes from another cwd without external engine or judge", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "question-replay-"));
  try {
    const out = path.join(tmp, "review");
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/(KEY|TOKEN|SECRET|PASSWORD)/i.test(k)));
    env.ENGINE_DIR = path.join(tmp, "nonexistent-engine"); env.TYPESAFE_API_KEY = "non-secret-test-fixture";
    const child = spawnSync(process.execPath, [path.join(root, "bin/evaluate.mjs"), "--out", out], { cwd: tmp, env, encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    const summary = JSON.parse(child.stdout); assert.equal(summary.model_calls, 0); assert.equal(summary.repeats, 2); assert.equal(summary.qualified, false);
    const one = JSON.parse(fs.readFileSync(path.join(out, "draw-1/report.json")));
    const two = JSON.parse(fs.readFileSync(path.join(out, "draw-2/report.json")));
    assert.notEqual(one.execution.pid, two.execution.pid); assert.notEqual(one.execution.invocation_id, two.execution.invocation_id);
    assert.equal(one.execution.packet_sha256, two.execution.packet_sha256); assert.equal(one.evaluator.judge, null);
    assert.equal(fs.statSync(path.join(out, "packet.json")).mode & 0o777, 0o600);
    assert.equal(fs.statSync(out).mode & 0o777, 0o700);
    assert.equal(JSON.stringify(one).includes("non-secret-test-fixture"), false);
    const again = spawnSync(process.execPath, [path.join(root, "bin/evaluate.mjs"), "--out", out], { cwd: tmp, env, encoding: "utf8" });
    assert.notEqual(again.status, 0); assert.equal(fs.readFileSync(path.join(out, "draw-1/report.json"), "utf8"), JSON.stringify(one, null, 1) + "\n");
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
