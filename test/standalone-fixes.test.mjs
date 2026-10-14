import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { judgeFromEnv, decide, noul } from '../src/engine.mjs';
import { evaluate as evaluateDevelopment } from '../src/evaluate.mjs';
const evaluate = (context, set, options = {}) => evaluateDevelopment(context, set, { mode: 'development', ...options });
import { runtimeSnapshot } from '../src/replay.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel)));

test('optional Jev route imports locally and typed decisions use only the injected HTTP fixture', async () => {
  const savedFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body); requests.push({ url, body });
    assert.equal(opts.headers.Authorization, 'Bearer synthetic-test-credential');
    return { ok: true, json: async () => ({ model: 'simulated-wire-fixture', served_revision: 'simulated-revision', answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, { noul: 0.95 }])) }) };
  };
  try {
    const provider = await judgeFromEnv({ TYPESAFE_API_KEY: 'synthetic-test-credential' });
    assert.equal(requests.length, 0); // Lazy route creation performs no request.
    const log = [];
    const answer = await decide({ fixture_kind: 'simulated; not a model evaluation' }, [noul('wire_check', 'Fixture plumbing only.')], { provider, samples: 1, log });
    assert.equal(requests.length, 1); assert.equal(answer.answers.wire_check.pass, true);
    assert.equal(requests[0].body.model, 'jev-latest');
    assert.equal(log[0].model, 'simulated-wire-fixture');
    assert.equal(JSON.stringify(log).includes('synthetic-test-credential'), false);
  } finally { globalThis.fetch = savedFetch; }
});

test('the live launch model can be selected without treating its alias as a fixed revision', async () => {
  const provider = await judgeFromEnv({ TYPESAFE_API_KEY: 'synthetic-test-credential', TYPESAFE_MODEL: 'jev-preview' });
  assert.equal(provider.model, 'jev-preview');
});

test('malformed nested rubric arrays abstain without repair or judge calls', async () => {
  const context = read('fixtures/reference/lesson-context.json'), base = read('fixtures/reference/question-set.json');
  for (const field of ['accept', 'evidence', 'keywords', 'nudge']) {
    const q = structuredClone(base); q.items = [q.items.find((i) => i.kind === 'open_check')];
    q.items[0].view.rubric.criteria[0][field] = field === 'nudge' ? ['wrong-shape'] : 'wrong-shape';
    if (field === 'keywords') q.items[0].view.rubric.criteria[0][field] = [[123]];
    let calls = 0;
    const provider = { name: 'simulated', model: 'fixture', ask: async () => { calls++; throw new Error('must not be called'); } };
    const rep = await evaluate(context, q, { provider });
    assert.equal(rep.items[0].status, 'unsure'); assert.equal(calls, 0);
    assert.equal(rep.items[0].checks.find((c) => c.id === 'format_coverage').verdict, 'unavailable');
  }
});

test('runtime snapshot pins the Node build and host platform rather than code alone', () => {
  const snap = runtimeSnapshot(root, path.join(root, 'config.json'));
  assert.equal(snap.node_runtime.version, process.version);
  assert.equal(snap.node_runtime.platform, process.platform); assert.equal(snap.node_runtime.arch, process.arch);
  assert.match(snap.node_runtime.executable_sha256, /^[a-f0-9]{64}$/);
});

test('privacy checker works with no sibling checkout or Git repository and fails safely on bounded patterns', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evaluator-checker-'));
  try {
    const own = path.join(tmp, 'isolated', 'scripts'); fs.mkdirSync(own, { recursive: true });
    fs.copyFileSync(path.join(root, 'scripts/check.mjs'), path.join(own, 'check.mjs'));
    const doc = path.join(tmp, 'isolated', 'fixture.md'); fs.writeFileSync(doc, 'Ordinary source text.\n');
    const run = () => spawnSync(process.execPath, [path.join(own, 'check.mjs')], { cwd: tmp, encoding: 'utf8' });
    const pass = run(); assert.equal(pass.status, 0, pass.stderr);
    assert.match(pass.stdout, /no explicit name list supplied/);
    const home = ['', 'Users', 'fictional-identity', 'private-file'].join('/');
    const shapedValue = 'apk_' + 'X'.repeat(24); fs.writeFileSync(doc, home + '\n' + shapedValue);
    const fail = run(), diagnostic = fail.stdout + fail.stderr;
    assert.notEqual(fail.status, 0); assert.match(diagnostic, /literal home path/); assert.match(diagnostic, /credential-shaped value/);
    assert.equal(diagnostic.includes(shapedValue), false); assert.equal(diagnostic.includes(home), false);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
