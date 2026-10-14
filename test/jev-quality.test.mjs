import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { splitPack, runDraw, summarize, liveProvider, discoverModels, modelIds, boundedAnswer } from "../scripts/test-jev.mjs";
import { validateAnswer } from "../src/typed/questions.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pack = () => ({ schema_version: 1, provenance: "synthetic plumbing only", source_pins: [], cases: [
  { id: "one", origin: { limitations: "not an academic label" }, state: { text: "A supplied test sentence." },
    questions: [{ id: "criterion", type: "noul", instructions: "Synthetic plumbing question." }],
    expected: { criterion: { outcome: "yes", rationale: "PRIVATE_EXPECTATION_SENTINEL" } } },
  { id: "two", state: { text: "Another supplied test sentence." },
    questions: [{ id: "criterion", type: "noul", instructions: "Synthetic plumbing question." }], expected: { criterion: { outcome: "no" } } }
] });

test("Jev casebook separates labels and rejects label-bearing provider state", () => {
  const p = pack(), split = splitPack(p);
  assert.equal(JSON.stringify(split.packet).includes("PRIVATE_EXPECTATION_SENTINEL"), false);
  assert.equal(JSON.stringify(split.labels).includes("PRIVATE_EXPECTATION_SENTINEL"), true);
  p.cases[0].state.nested = { expected: "yes" };
  assert.throws(() => splitPack(p), /labels_in_provider_packet/);
  const malformed = pack(); malformed.cases[0].expected = {};
  assert.throws(() => splitPack(malformed), /invalid_expected_label/);
});

test("Jev quality draws use three samples and report development errors and stability separately", async () => {
  const { packet, labels } = splitPack(pack()), raw = [], journal = [], draws = [];
  const values = [[0.9, 0.1], [0.1, 0.9], [0.5, 0.5]];
  let calls = 0;
  for (let d = 1; d <= 3; d++) {
    const provider = { name: "mock", model: "jev-latest", ask: async (state, questions, opts) => {
      calls++; assert.ok(opts.sample >= 0 && opts.sample < 3);
      assert.equal(JSON.stringify({ state, questions }).includes("PRIVATE_EXPECTATION_SENTINEL"), false);
      return { model: "jev-test.1", served_revision: "reported-fixture-revision", answers: { criterion: { noul: values[d - 1][state.text.startsWith("A supplied") ? 0 : 1] } } };
    } };
    draws.push(await runDraw(packet, { provider, draw: d, onRaw: (x) => raw.push(x), onJournal: (x) => journal.push(x) }));
  }
  assert.equal(calls, 18); assert.equal(raw.length, 18); assert.equal(journal.length, 6);
  const report = summarize(draws, labels, "jev-latest");
  assert.deepEqual({ matches: report.counts.matches, expected_yes_observed_no: report.counts.expected_yes_observed_no, expected_no_observed_yes: report.counts.expected_no_observed_yes, abstentions: report.counts.abstentions }, { matches: 2, expected_yes_observed_no: 1, expected_no_observed_yes: 1, abstentions: 2 });
  assert.equal(report.qualification, false); assert.equal(report.fixed_version_comparison.allowed, false);
  assert.deepEqual(report.returned_models, ["jev-test.1"]);
  assert.equal(report.criterion_stability[0].identical_outcomes, false);
  assert.equal(report.criterion_stability[0].probabilities_by_draw.length, 3);
  assert.ok(Math.abs(report.criterion_stability[0].numeric_min - 0.1) < 1e-9);
  assert.equal(JSON.stringify({ raw, journal }).includes("PRIVATE_EXPECTATION_SENTINEL"), false);
});

test("unavailable responses abstain with bounded diagnostics and all-invalid recovery is counted", async () => {
  const { packet, labels } = splitPack(pack()), raw = [], journal = [];
  const provider = { name: "mock", model: "jev-latest", ask: async () => { throw new Error("PRIVATE_PROVIDER_BODY_SENTINEL"); } };
  const draw = await runDraw(packet, { provider, onRaw: (x) => raw.push(x), onJournal: (x) => journal.push(x) });
  const report = summarize([draw], labels, "jev-latest");
  assert.equal(draw.logical_sample_calls, 12); assert.equal(report.counts.unavailable, 2); assert.equal(report.counts.abstentions, 2);
  assert.equal(report.counts.matches, 0);
  assert.equal(JSON.stringify({ raw, journal, draw, report }).includes("PRIVATE_PROVIDER_BODY_SENTINEL"), false);
  assert.ok(report.fixed_version_comparison.reasons.includes("missing_model_observation"));
});

test("mixed returned models and explicit request mismatches block fixed-version comparisons", async () => {
  const { packet, labels } = splitPack(pack()); let calls = 0;
  const provider = { name: "mock", model: "jev-requested.1", ask: async () => ({ model: ++calls % 2 ? "jev-test.1" : "jev-test.2", served_revision: `revision-${calls % 2}`, answers: { criterion: { noul: 0.9 } } }) };
  const draw = await runDraw(packet, { provider }), report = summarize([draw], labels, provider.model);
  for (const reason of ["mixed_returned_models", "requested_model_mismatch", "mixed_reported_revisions", "served_revision_not_independently_verified"]) assert.ok(report.fixed_version_comparison.reasons.includes(reason));
  assert.equal(report.qualification, false); assert.equal(report.fixed_version_comparison.allowed, false);
});

test("mocked live adapter retains bounded typed responses and does not invent an omitted served model", async () => {
  const apiKey = "synthetic-launch-fixture", p = pack(), questions = p.cases[0].questions;
  let called = 0;
  const provider = liveProvider({ apiKey, model: "jev-latest", fetchImpl: async (url, init) => {
    called++; assert.equal(init.headers.Authorization, `Bearer ${apiKey}`);
    assert.equal(JSON.parse(init.body).model, "jev-latest");
    return { ok: true, status: 200, json: async () => ({ answers: { criterion: { noul: 0.9, explanation: apiKey } }, private_echo: apiKey }) };
  } });
  const result = await provider.ask(p.cases[0].state, questions, { sample: 0 });
  assert.equal(called, 1); assert.equal(result.model, null); assert.deepEqual(result.answers.criterion, { noul: 0.9 });
  assert.equal(JSON.stringify(result).includes(apiKey), false);
  const score = { id: "s", type: "score", criteria: ["low", "high"] };
  assert.equal(validateAnswer(score, boundedAnswer(score, { score: 1, confidence: "PRIVATE_INVALID_SENTINEL" })).unavailable, true);
  assert.equal(validateAnswer(score, boundedAnswer(score, { score: 1, probabilities: "PRIVATE_INVALID_SENTINEL" })).unavailable, true);
});

test("model discovery uses only the injected transport and accepts advertised inventory shapes", async () => {
  for (const payload of [["jev-latest"], { data: [{ id: "jev-latest" }] }, { models: [{ name: "jev-latest" }] }]) assert.deepEqual(modelIds(payload), ["jev-latest"]);
  let calls = 0;
  const ids = await discoverModels({ apiKey: "synthetic-launch-fixture", fetchImpl: async (url) => {
    calls++; assert.equal(url, "https://api.typesafe.ai/v1/models"); return { ok: true, json: async () => ({ data: [{ id: "jev-latest" }, { id: "jev-preview" }] }) };
  } });
  assert.equal(calls, 1); assert.deepEqual(ids, ["jev-latest", "jev-preview"]);
});

test("default standalone CLI freezes a private offline plan without credentials or provider calls", () => {
  const dir = path.join(root, ".local", "B0998", `test-${crypto.randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    const cases = path.join(dir, "cases.json"), out = path.join(dir, "out"), guard = path.join(dir, "guard.mjs");
    fs.writeFileSync(cases, JSON.stringify(pack()), { mode: 0o600 });
    fs.writeFileSync(guard, "globalThis.fetch = () => { throw new Error('NETWORK_FORBIDDEN'); };\n", { mode: 0o600 });
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/(KEY|TOKEN|SECRET|PASSWORD)/i.test(k)));
    const child = spawnSync(process.execPath, ["--import", guard, path.join(root, "scripts/test-jev.mjs"), "--cases", cases, "--out", out], { encoding: "utf8", env });
    assert.equal(child.status, 0, child.stderr);
    const summary = JSON.parse(child.stdout); assert.equal(summary.model_calls, 0); assert.equal(summary.draws, 3); assert.equal(summary.samples, 3); assert.equal(summary.qualification, false);
    const frozen = fs.readFileSync(path.join(out, "packet.json"), "utf8"); assert.equal(frozen.includes("PRIVATE_EXPECTATION_SENTINEL"), false);
    const manifest = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"))); assert.match(manifest.runtime.runner_sha256, /^[a-f0-9]{64}$/);
    assert.equal(fs.statSync(path.join(out, "labels.json")).mode & 0o777, 0o600); assert.equal(fs.statSync(out).mode & 0o777, 0o700);
    assert.equal(fs.existsSync(path.join(out, "model-inventory.json")), false);
    const rerun = spawnSync(process.execPath, [path.join(root, "scripts/test-jev.mjs"), "--cases", cases, "--out", out], { encoding: "utf8", env });
    assert.notEqual(rerun.status, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("explicit CLI execution with an injected HTTP fixture uses separate full-draw processes and private journals", () => {
  const dir = path.join(root, ".local", "B0998", `test-${crypto.randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    const cases = path.join(dir, "cases.json"), out = path.join(dir, "out"), mock = path.join(dir, "mock.mjs");
    fs.writeFileSync(cases, JSON.stringify(pack()), { mode: 0o600 });
    fs.writeFileSync(mock, `globalThis.fetch = async (url, init) => {
      if (url.endsWith('/models')) return { ok: true, json: async () => ({ data: [{ id: 'jev-latest' }] }) };
      if (!url.endsWith('/systemone')) throw new Error('UNEXPECTED_URL');
      const request = JSON.parse(init.body);
      if (JSON.stringify(request).includes('PRIVATE_EXPECTATION_SENTINEL')) throw new Error('LABEL_LEAK');
      return { ok: true, status: 200, json: async () => ({ model: 'jev-mock.1', served_revision: 'reported-fixture-only',
        answers: Object.fromEntries(Object.keys(request.questions).map(id => [id, { noul: 0.9, prose: 'PRIVATE_PROVIDER_BODY_SENTINEL' }])) }) };
    };\n`, { mode: 0o600 });
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/(KEY|TOKEN|SECRET|PASSWORD)/i.test(k)));
    env.TYPESAFE_API_KEY = "synthetic-launch-fixture"; env.NODE_OPTIONS = `--import=${mock}`;
    const child = spawnSync(process.execPath, [path.join(root, "scripts/test-jev.mjs"), "--live", "--cases", cases, "--out", out], { encoding: "utf8", env });
    assert.equal(child.status, 0, child.stderr);
    const report = JSON.parse(fs.readFileSync(path.join(out, "report.json")));
    assert.equal(report.draws, 3); assert.equal(report.logical_sample_calls, 18); assert.equal(report.http_requests, 19);
    assert.equal(report.qualification, false); assert.equal(report.fixed_version_comparison.allowed, false);
    const pids = [];
    for (let i = 1; i <= 3; i++) {
      const draw = JSON.parse(fs.readFileSync(path.join(out, `draw-${i}`, "draw.json"))); pids.push(draw.pid);
      const raw = fs.readFileSync(path.join(out, `draw-${i}`, "raw-responses.jsonl"), "utf8");
      const journal = fs.readFileSync(path.join(out, `draw-${i}`, "journal.jsonl"), "utf8");
      assert.equal(raw.trim().split("\n").length, 6);
      for (const sentinel of ["PRIVATE_EXPECTATION_SENTINEL", "PRIVATE_PROVIDER_BODY_SENTINEL", "synthetic-launch-fixture"]) assert.equal((raw + journal).includes(sentinel), false);
    }
    assert.equal(new Set(pids).size, 3);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
