import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { evaluate } from "../src/evaluate.mjs";
import { createFakeProvider, judgeFromEnv } from "../src/engine.mjs";
import { createJevProvider } from "../src/typed/jev.mjs";
import { compareDraws } from "../src/replay.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const context = JSON.parse(fs.readFileSync(path.join(root, "fixtures/reference/lesson-context.json")));
const base = JSON.parse(fs.readFileSync(path.join(root, "fixtures/reference/question-set.json")));
const one = (kind) => { const q = structuredClone(base); q.items = [q.items.find((it) => it.kind === kind)]; return q; };
const checks = (rep) => rep.items.flatMap((it) => it.checks.filter((c) => c.method === "judge"));
const answer = (q) => ({ noul: q.id.endsWith("_also_fits") ? 0.05 : 0.95 });

test("partial integration calls only selected claims and retains every excluded criterion as unavailable", async () => {
  const provider = createFakeProvider(answer), log = [];
  const rep = await evaluate(context, base, { provider, samples: 3, log });
  assert.equal(rep.judge_coverage.total_criteria, 543);
  assert.equal(rep.judge_coverage.requested_criteria, 125);
  assert.equal(rep.judge_coverage.outside_profile, 418);
  assert.equal(rep.judge_coverage.returned_usable_criteria, 125);
  assert.equal(rep.judge_coverage.unavailable_criteria, 418);
  assert.equal(provider.calls.length, 39); assert.equal(log.length, 13);
  const called = log.flatMap((r) => r.questions);
  assert.equal(called.length, 125);
  assert.ok(called.every((q) => /^(word_[1-9][0-9]*_(fits|.+_also_fits)|reveal_meets_[1-9][0-9]*|accepted_[1-9][0-9]*_[1-9][0-9]*_meets)$/.test(q.id)));
  assert.ok(checks(rep).filter((c) => c.scope === "outside_profile").every((c) => !c.requested && c.verdict === "unavailable"));
  for (const row of log) {
    assert.deepEqual(Object.keys(row.state).sort(), ["item", "seen_before"]);
    assert.equal(Object.hasOwn(row.state.item, "nudges"), false);
    assert.equal(Object.hasOwn(row.state.item, "misreadings"), false);
    assert.equal(Object.hasOwn(row.state.item, "feedback"), false);
    assert.equal(Object.hasOwn(row.state.item, "correct_feedback"), false);
  }
  assert.ok(rep.items.every((it) => it.checks.find((c) => c.id === "learner_exposure_complete").verdict === "unavailable"));
  assert.equal(rep.status, "unverified"); assert.equal(rep.evaluator.qualification, "unqualified");
  assert.deepEqual(rep.counts, { unsure: 40 });
});

test("valid but excluded operations make zero calls even when a live-shaped provider is supplied", async () => {
  for (const kind of ["reading_mcq", "evidence_select", "open_prompt", "word_web", "say_back"]) {
    const provider = createFakeProvider(answer);
    const rep = await evaluate(context, one(kind), { provider });
    assert.equal(provider.calls.length, 0, kind);
    assert.equal(rep.items[0].judge, null);
    assert.ok(checks(rep).length > 0);
    assert.ok(checks(rep).every((c) => c.verdict === "unavailable" && c.scope === "outside_profile"));
  }
});

test("a confident surviving sample cannot pass when another requested sample failed", async () => {
  const provider = { name: "simulated", model: "fixture", async ask(_state, questions, { sample }) {
    if (sample === 1) throw new Error("simulated unavailable sample");
    return { model: "fixture", answers: Object.fromEntries(questions.map((q) => [q.id, answer(q)])) };
  } };
  const rep = await evaluate(context, one("open_check"), { provider, samples: 3 });
  assert.ok(checks(rep).filter((c) => c.requested).every((c) => c.valid === 2 && c.verdict === "unavailable" && c.gate.includes("incomplete_sample_set")));
  assert.equal(rep.judge_coverage.returned_usable_criteria, 0);
});

test("missing, mixed or unexercised reported Jev identities cannot yield usable partial judgments", async () => {
  for (const models of [[null, null, null], ["jev-1.13.0", "jev-1.14.0", "jev-1.13.0"], ["jev-1.14.0", "jev-1.14.0", "jev-1.14.0"]]) {
    const provider = { name: "jev", model: "jev-latest", async ask(_state, questions, { sample }) {
      return { model: models[sample], answers: Object.fromEntries(questions.map((q) => [q.id, answer(q)])) };
    } };
    const rep = await evaluate(context, one("open_check"), { provider, samples: 3 });
    assert.ok(checks(rep).filter((c) => c.requested).every((c) => c.verdict === "unavailable"));
    assert.ok(rep.items[0].judge.serving_issues.length > 0);
    assert.equal(rep.judge_coverage.returned_usable_criteria, 0);
  }
});

test("HTTP adapter preserves missing serving identity rather than copying an explicitly requested version", async () => {
  const provider = createJevProvider({ apiKey: "synthetic-test-credential", model: "jev-1.13.0", fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body);
    return { ok: true, json: async () => ({ answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, { noul: 0.95 }])) }) };
  } });
  const rep = await evaluate(context, one("open_check"), { provider, samples: 3 });
  assert.ok(rep.items[0].judge.serving_observations.every((o) => o.model === null));
  assert.ok(rep.items[0].judge.serving_issues.includes("reported_model_missing"));
  assert.ok(checks(rep).filter((c) => c.requested).every((c) => c.verdict === "unavailable"));
});

test("live adapter suppresses raw provider diagnostics before a failure can reach the journal", async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 400, headers: { get: () => null }, text: async () => "PRIVATE_PROVIDER_BODY_SENTINEL" });
  try {
    const provider = await judgeFromEnv({ TYPESAFE_API_KEY: "synthetic-test-credential" }), log = [];
    const rep = await evaluate(context, one("open_check"), { provider, samples: 1, log });
    assert.ok(checks(rep).filter((c) => c.requested).every((c) => c.verdict === "unavailable"));
    const artifact = JSON.stringify({ rep, log });
    assert.equal(artifact.includes("PRIVATE_PROVIDER_BODY_SENTINEL"), false);
    assert.equal(artifact.includes("synthetic-test-credential"), false);
    assert.match(artifact, /provider details suppressed/);
  } finally { globalThis.fetch = saved; }
});

test("repeat study rejects a substituted judge profile even when packet and runtime identities match", () => {
  const make = (n, profile) => ({ evaluator: { judge_profile: { sha256: profile } }, input: {}, items: [], set: [], execution: { invocation_id: `draw-${n}`, pid: n, packet_sha256: "packet", runtime_sha256: "runtime", profile_sha256: profile, logical_sample_calls: 0 } });
  assert.throws(() => compareDraws([make(1, "one"), make(2, "two")], "packet", "runtime", "offline-only"), /profile mismatch/);
  const missing = make(1, "one"); delete missing.evaluator;
  assert.throws(() => compareDraws([missing, make(2, "two")], "packet", "runtime", "offline-only"), /profile missing/);
});

test("equal verdicts with different serving or sample failure causes are not reported as identical checks", () => {
  const make = (n, gate, valid) => ({ input: {}, items: [{ id: "fixture", status: "unsure", checks: [{ id: "fixture_check", method: "judge", required: true, verdict: "unavailable", p_yes: 0.95, gate, valid, scope: "selected", requested: true }] }], set: [], execution: { invocation_id: `draw-${n}`, pid: n, packet_sha256: "packet", runtime_sha256: "runtime", logical_sample_calls: 3 } });
  const a = make(1, ["reported_model_missing"], 3), b = make(2, ["incomplete_sample_set"], 1);
  const rep = compareDraws([a, b], "packet", "runtime", "explicit-jev");
  assert.equal(rep.identical_checks, false);
});

test("standalone default stays offline outside the checkout and freezes its partial profile across fresh processes", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "partial-jev-run-"));
  try {
    const out = path.join(tmp, "run");
    const child = spawnSync(process.execPath, [path.join(root, "bin/evaluate.mjs"), "--out", out], { cwd: tmp, encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    const printed = JSON.parse(child.stdout.trim());
    assert.equal(printed.model_calls, 0); assert.equal(printed.logical_sample_calls, 0);
    assert.equal(printed.profile, "jev-partial-v1"); assert.equal(printed.qualified, false);
    const read = (rel) => JSON.parse(fs.readFileSync(path.join(out, rel)));
    const manifest = read("manifest.json"), report = read("report.json"), repeat = read("repeat.json");
    assert.equal(manifest.judge_profile.sha256, report.evaluator.judge_profile.sha256);
    assert.equal(repeat.judge_profile_sha256, manifest.judge_profile.sha256);
    assert.equal(repeat.identical_checks, true); assert.equal(repeat.separate_local_process_records, true);
    assert.equal(report.judge_coverage.selected_by_profile, 125); assert.equal(report.judge_coverage.requested_criteria, 0);
    assert.equal(report.judge_coverage.unavailable_criteria, 543);
    assert.notEqual(read("draw-1/report.json").execution.pid, read("draw-2/report.json").execution.pid);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
