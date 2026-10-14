import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { reviewSideProjection, compareSide } from "../src/side-review.mjs";
import { packetProjection } from "../src/packet.mjs";
import { createFakeProvider } from "../src/engine.mjs";

const context = JSON.parse(fs.readFileSync(new URL("../fixtures/reference/lesson-context.json", import.meta.url)));
const set = JSON.parse(fs.readFileSync(new URL("../fixtures/reference/question-set.json", import.meta.url)));
const model = "gemini-group/gemini-3.8-flash";
const fake = (answer = () => ({ noul: 1 })) => createFakeProvider(answer, { name: "maat-gemini-flash", model });
const packet = (kind) => packetProjection(context, kind ? { ...set, items: [set.items.find((item) => item.kind === kind)] } : set);
const judgeChecks = (report) => report.items.flatMap((item) => item.checks.filter((check) => check.method === "judge"));
const input = { context_projection_sha256: "a".repeat(64), set_projection_sha256: "b".repeat(64) };
const report = (rows = []) => ({ input: { ...input }, items: rows.map(([item, checks]) => ({ id: item,
  checks: checks.map(([id, verdict, method = "judge"]) => ({ id, verdict, method })) })) });

test("side review covers all supported families and keeps primary verdicts, qualification and labels outside state", async () => {
  const p = packet(), provider = fake(), log = [];
  const sentinel = "PRIVATE_PRIMARY_REVIEW_SENTINEL";
  const result = await reviewSideProjection(p.context, p.set, { provider, log,
    primary: { verdict: sentinel }, qualification: { private_label: sentinel }, labels: [sentinel] });
  assert.equal(provider.calls.length, 120); assert.equal(log.length, 40);
  assert.equal(result.judge_coverage.total_criteria, 543); assert.equal(result.judge_coverage.requested_criteria, 543);
  assert.equal(result.judge_coverage.outside_profile, 0); assert.equal(result.evaluator.judge_profile.id, "jev-full-experimental");
  for (const id of ["key_correct", "candidate_1_supports", "decoy_1_supports", "word_1_fits", "reveal_meets_1", "misreading_1_passes", "answerable"]) {
    assert.ok(provider.calls.some((call) => call.questions.some((q) => q.id === id)), id);
  }
  assert.equal(JSON.stringify(provider.calls).includes(sentinel), false);
  assert.equal(JSON.stringify(log).includes(sentinel), false);
  assert.equal(result.evaluator.role, "side"); assert.equal(result.evaluator.accuracy, "unmeasured");
  assert.equal(result.evaluator.qualification, "unqualified"); assert.equal(result.status, "unverified");
  assert.equal(result.evaluator.categorical_encoding, "yes=1/no=0/unsure=.5; not calibrated confidence");
  assert.ok(result.items.every((item) => item.checks.find((c) => c.id === "learner_exposure_complete").verdict === "unavailable"));
  assert.deepEqual(result.input, p.hashes);
});

test("side provider construction is lazy, independent and rejects Jev or model substitution", async () => {
  const p = packet("say_back"); let factories = 0;
  const provider = fake();
  await reviewSideProjection(p.context, p.set, { model, providerFactory: async (...args) => { assert.deepEqual(args, []); factories++; return provider; } });
  assert.equal(factories, 1); assert.equal(provider.calls.length, 3);
  const bad = structuredClone(p.set); bad.items[0].order = 0;
  const rejected = await reviewSideProjection(p.context, bad, { model, providerFactory: () => { throw new Error("must stay lazy"); } });
  assert.equal(rejected.transport.status, "rejected");
  for (const options of [
    { provider: { ...fake(), name: "jev" } },
    { providerFactory: () => ({ ...fake(), name: "jev" }), model },
    { provider: fake(), model: "other-model" },
    { providerFactory: () => ({ ...fake(), model: "other-model" }), model }
  ]) await assert.rejects(reviewSideProjection(p.context, p.set, options), /declared MAAT Gemini Flash provider/);
});

test("categorical unsure in any draw cannot become a decisive side verdict or agreement", async () => {
  const p = packet("say_back");
  for (const draws of [[0.5, 0.5, 1], [1, 1, 0.5], [0.5, 0.5, 0.5]]) {
    const provider = fake((_q, _s, { sample }) => ({ noul: draws[sample] }));
    const result = await reviewSideProjection(p.context, p.set, { provider });
    assert.ok(judgeChecks(result).every((c) => c.verdict === "unsure" && c.gate.includes("categorical_draw_unsure")));
    assert.ok(judgeChecks(result).every((c) => c.agreement === null));
    assert.equal(result.judge_agreement, null);
    assert.equal(result.items[0].status, "unsure");
    const primary = structuredClone(result);
    primary.items[0].checks.filter((c) => c.method === "judge").forEach((c) => { c.verdict = "pass"; });
    const comparison = compareSide(primary, result);
    assert.equal(comparison.counts.comparable_pairs, 0); assert.equal(comparison.agreement_rate, null);
    assert.equal(comparison.counts.side_unsure, 1);
  }
});

test("unsure categorical draws preserve other required failures and suppress provider error details", async () => {
  const p = packet("reading_mcq");
  const provider = fake((q, _s, { sample }) => ({ noul: q.id === "key_correct" ? 0 : q.id === "answer_in_seen" && sample === 0 ? 0.5 : 1 }));
  const result = await reviewSideProjection(p.context, p.set, { provider });
  assert.equal(judgeChecks(result).find((c) => c.id === "key_correct").verdict, "fail");
  assert.equal(judgeChecks(result).find((c) => c.id === "answer_in_seen").verdict, "unsure");
  assert.equal(judgeChecks(result).find((c) => c.id === "answer_in_seen").agreement, null);
  const decisive = judgeChecks(result).length - 1;
  assert.deepEqual(result.judge_agreement, { judgements: decisive, unanimous: decisive, mean: 1 });
  assert.equal(result.items[0].status, "fails");
  const log = [], failure = fake(); failure.ask = async () => { throw new Error("PRIVATE_PROVIDER_ERROR_SENTINEL"); };
  const unavailable = await reviewSideProjection(p.context, p.set, { provider: failure, log });
  assert.ok(judgeChecks(unavailable).every((c) => c.verdict === "unavailable"));
  assert.equal(unavailable.judge_agreement, null);
  assert.equal(JSON.stringify({ unavailable, log }).includes("PRIVATE_PROVIDER_ERROR_SENTINEL"), false);
});

test("side agreement excludes unavailable judgments even when surviving samples agree", async () => {
  const p = packet("say_back");
  const provider = fake((_q, _state, { sample }) => {
    if (sample === 2) throw new Error("simulated unavailable draw");
    return { noul: 1 };
  });
  const result = await reviewSideProjection(p.context, p.set, { provider });
  assert.ok(judgeChecks(result).every((c) => c.verdict === "unavailable" && c.valid === 2 && c.agreement === 1));
  assert.equal(result.judge_agreement, null);
});

test("comparison keys item plus criterion, normalizes flags and never changes primary verdicts", () => {
  const primary = report([["one", [["same", "pass"], ["optional", "flag"]]], ["two", [["same", "fail"], ["code", "pass", "code"]]]]);
  const side = report([["two", [["same", "pass"], ["code", "pass", "code"]]], ["one", [["optional", "fail"], ["same", "pass"]]]]);
  const before = structuredClone(primary), result = compareSide(primary, side);
  assert.equal(result.counts.comparable_pairs, 3); assert.equal(result.counts.agreements, 2); assert.equal(result.counts.disagreements, 1);
  assert.deepEqual(result.disagreements, [{ item_id: "two", criterion_id: "same", primary_verdict: "fail", side_verdict: "pass" }]);
  assert.equal(result.agreement_rate, 2 / 3); assert.deepEqual(primary, before);
  assert.equal(result.primary_overridden, false); assert.equal(result.qualified, false); assert.equal(result.accuracy, "unmeasured");
});

test("missing, unsure and unavailable judgments are counted separately and never imply perfect agreement", async () => {
  const primary = report([["one", [["a", "unsure"], ["b", "pass"], ["only-primary", "unavailable"]]]]);
  const side = report([["one", [["a", "pass"], ["b", "unavailable"], ["only-side", "unsure"]]]]);
  const result = compareSide(primary, side);
  assert.equal(result.counts.comparable_pairs, 0); assert.equal(result.agreement_rate, null);
  assert.equal(result.counts.matched_pairs, 2); assert.equal(result.counts.excluded_pairs, 2);
  assert.equal(result.counts.primary_only, 1); assert.equal(result.counts.side_only, 1);
  assert.equal(result.counts.primary_unsure, 1); assert.equal(result.counts.primary_unavailable, 1);
  assert.equal(result.counts.side_unsure, 1); assert.equal(result.counts.side_unavailable, 1);
  assert.equal(compareSide(report(), report()).agreement_rate, null);
  const p = packet("say_back"), offline = await reviewSideProjection(p.context, p.set);
  assert.equal(offline.evaluator.judge, null); assert.ok(judgeChecks(offline).every((c) => c.verdict === "unavailable"));
});

test("comparison rejects changed projected inputs and ambiguous report keys", () => {
  const primary = report([["one", [["a", "pass"]]]]);
  for (const key of Object.keys(input)) {
    const changed = structuredClone(primary); changed.input[key] = "c".repeat(64);
    assert.throws(() => compareSide(primary, changed), /input hash mismatch/);
    delete changed.input[key]; assert.throws(() => compareSide(primary, changed), /input hash mismatch/);
  }
  assert.throws(() => compareSide(primary, report([["one", [["a", "pass"], ["a", "fail"]]]])), /duplicate comparison criterion/);
  assert.throws(() => compareSide(primary, report([["one", [["a", "pass"]]], ["one", [["b", "pass"]]]])), /duplicate comparison item/);
});
