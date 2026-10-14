import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { evaluate, criterionPacket } from "../src/evaluate.mjs";
import { judgeQuestions } from "../src/checks.mjs";
import { seenBefore, asText } from "../src/seen.mjs";
import { qualificationSigningPayload } from "../src/qualification.mjs";
import { packetProjection } from "../src/packet.mjs";
import { runtimeSnapshot, sha } from "../src/replay.mjs";
import { getJudgeProfile } from "../src/judge-profile.mjs";
import { GATES } from "../src/engine.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel)));
const context = read("fixtures/reference/lesson-context.json"), base = read("fixtures/reference/question-set.json");
const one = () => { const q = structuredClone(base); q.items = [q.items.find((i) => i.kind === "reading_mcq")]; return q; };
const reviewer = crypto.generateKeyPairSync("ed25519");
const trustedReviewers = { schema_version: 1, reviewers: [{ id: "synthetic-test-reviewer", public_key_pem: reviewer.publicKey.export({ type: "spki", format: "pem" }) }] };
const packetHash = (q) => {
  const p = packetProjection(context, q), item = p.set.items[0];
  const question = judgeQuestions(item).find((x) => x.q.id === "key_correct").q;
  return sha(JSON.stringify(criterionPacket(item, asText(seenBefore(p.context.native, item, p.set.items)), p.context.lesson.learning_question, {}, question)));
};
const syntheticRegistry = (q, patch = {}) => {
  const fingerprint = (value) => crypto.createHash("sha256").update(value).digest("hex");
  const cases = ["pass", "fail"].flatMap((expected) => Array.from({ length: 368 }, (_, i) => ({ input_sha256: fingerprint(`${expected}-${i}`), independence_group: `${expected}-${i}`, expected, draws: [expected, expected] })));
  cases[0].input_sha256 = packetHash(q);
  const certificate = { id: "synthetic-routing-fixture-not-real-qualification", operation: "reading_mcq", criterion_family: "key_correct", context_sha256: packetProjection(context, q).hashes.context_projection_sha256, runtime_sha256: runtimeSnapshot(root, path.join(root, "config.json")).sha256, profile_sha256: getJudgeProfile("jev-qualified-v1").sha256, samples: 3, gates_sha256: sha(JSON.stringify(GATES)), model: "jev-1.13.0", served_revision: "synthetic-reviewed-revision", revision_verified: true, expires_at: "2099-01-01T00:00:00.000Z", provenance: { independent_human_gold: true, held_out: true, predeclared_scope: true, independence_reviewed: true, review_receipt_sha256: fingerprint("synthetic-receipt"), holdout_sha256: fingerprint("synthetic-holdout") }, cases, ...patch };
  certificate.review_signature = { reviewer_id: "synthetic-test-reviewer", algorithm: "ed25519", value: crypto.sign(null, qualificationSigningPayload(certificate), reviewer.privateKey).toString("base64") };
  return { schema_version: 1, certificates: [certificate] };
};
const simulated = (revision = "synthetic-reviewed-revision") => {
  const calls = [];
  return { name: "jev", model: "jev-1.13.0", calls, async ask(state, questions) {
    calls.push({ state, questions });
    return { model: "jev-1.13.0", served_revision: revision, answers: Object.fromEntries(questions.map((q) => [q.id, { noul: 0.95 }])) };
  } };
};

test("default API makes zero provider calls without qualification, including providers disguised as test models", async () => {
  for (const name of ["jev", "fake", "simulated"]) {
    const provider = simulated(); provider.name = name;
    const rep = await evaluate(context, one(), { provider });
    assert.equal(provider.calls.length, 0); assert.equal(rep.evaluator.mode, "qualified");
    assert.equal(rep.judge_coverage.qualified_eligible_criteria, 0);
    assert.ok(rep.items[0].checks.filter((c) => c.method === "judge").every((c) => c.verdict === "unavailable" && !c.requested));
  }
  let launches = 0;
  await evaluate(context, base, { providerFactory: () => { launches++; throw new Error("must not launch"); } });
  assert.equal(launches, 0);
});

test("qualified routing can admit a certified family outside the narrower development profile", async () => {
  const q = one(), provider = simulated();
  const rep = await evaluate(context, q, { provider, trustedReviewers, qualification: syntheticRegistry(q) });
  assert.equal(provider.calls.length, 3);
  assert.ok(provider.calls.every((c) => c.questions.length === 1 && c.questions[0].id === "key_correct"));
  assert.deepEqual(Object.keys(provider.calls[0].state.item).sort(), ["options", "question"]);
  const key = rep.items[0].checks.find((c) => c.id === "key_correct");
  assert.equal(key.accuracy_qualification.eligible, true); assert.equal(key.verdict, "pass");
  assert.equal(rep.judge_coverage.qualified_eligible_criteria, 1);
  assert.ok(rep.items[0].checks.filter((c) => c.method === "judge" && c.id !== "key_correct").every((c) => c.verdict === "unavailable"));
  assert.equal(rep.items[0].status, "unsure"); assert.equal(rep.evaluator.qualification, "unqualified");
});

test("changed context, build, samples or fixed model excludes the entire certificate before provider launch", async () => {
  for (const patch of [{ context_sha256: "0".repeat(64) }, { runtime_sha256: "0".repeat(64) }, { samples: 2 }, { model: "jev-1.14.0" }]) {
    const q = one(), provider = simulated();
    const rep = await evaluate(context, q, { provider, trustedReviewers, qualification: syntheticRegistry(q, patch) });
    assert.equal(provider.calls.length, 0); assert.equal(rep.judge_coverage.qualified_eligible_criteria, 0);
  }
});

test("a missing or changed serving revision abstains even with confident complete answers", async () => {
  for (const revision of [null, "changed-revision"]) {
    const q = one(), provider = simulated(revision);
    const rep = await evaluate(context, q, { provider, trustedReviewers, qualification: syntheticRegistry(q) });
    const key = rep.items[0].checks.find((c) => c.id === "key_correct");
    assert.equal(key.verdict, "unavailable");
    assert.ok(key.gate.includes("serving_identity_does_not_match_certificate"));
  }
});

test("an altered question cannot inherit the reviewed question's qualification in the same lesson", async () => {
  const original = one(), qualification = syntheticRegistry(original), changed = structuredClone(original), provider = simulated();
  changed.items[0].view.stem = "A completely different question about this source?";
  const rep = await evaluate(context, changed, { provider, trustedReviewers, qualification });
  assert.equal(provider.calls.length, 0);
  assert.equal(rep.judge_coverage.qualified_eligible_criteria, 0);
});

test("untrusted evidence and wrong provider identity cannot unlock the default route", async () => {
  const q = one(), provider = simulated();
  await evaluate(context, q, { provider, qualification: syntheticRegistry(q) });
  assert.equal(provider.calls.length, 0);
  provider.name = "another-provider";
  await assert.rejects(evaluate(context, q, { provider, trustedReviewers, qualification: syntheticRegistry(q) }), /declared Jev provider/);
  assert.equal(provider.calls.length, 0);
});

test("confident disagreement with the reviewed label is discarded without putting that label in model inputs", async () => {
  const q = one(), qualification = syntheticRegistry(q), calls = [], log = [];
  const provider = { name: "jev", model: "jev-1.13.0", async ask(state, questions) {
    calls.push({ state, questions });
    return { model: "jev-1.13.0", served_revision: "synthetic-reviewed-revision", answers: { key_correct: { noul: 0.05 } } };
  } };
  const rep = await evaluate(context, q, { provider, trustedReviewers, qualification, log });
  const key = rep.items[0].checks.find((c) => c.id === "key_correct");
  assert.equal(key.verdict, "unavailable"); assert.ok(key.gate.includes("verdict_disagrees_with_verified_label"));
  assert.equal(JSON.stringify({ rep, log, calls }).includes("verified_expected_verdict"), false);
  assert.equal(JSON.stringify({ log, calls }).includes("synthetic-test-reviewer"), false);
  assert.equal(rep.evaluator.qualification, "unqualified");
});

test("default Jev CLI runs outside checkout with no credential when no family has qualified", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qualified-jev-run-"));
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(KEY|TOKEN|SECRET|PASSWORD)/i.test(key)));
    const child = spawnSync(process.execPath, [path.join(root, "bin/evaluate.mjs"), "--judge", "jev", "--out", path.join(tmp, "run")], { cwd: tmp, env, encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    const summary = JSON.parse(child.stdout.trim());
    assert.equal(summary.mode, "qualified"); assert.equal(summary.profile, "jev-qualified-v1");
    assert.equal(summary.judge_coverage.total_criteria, 543);
    assert.equal(summary.judge_coverage.qualified_eligible_criteria, 0);
    assert.equal(summary.logical_sample_calls, 0); assert.equal(summary.model_calls, 0);
    assert.deepEqual(summary.counts, { unsure: 40 });
    const report = JSON.parse(fs.readFileSync(path.join(tmp, "run", "report.json")));
    assert.equal(report.repeat.identical_checks, true);
    assert.ok(report.items.every((it) => it.judge === null));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
