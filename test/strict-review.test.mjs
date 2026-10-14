import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { packetProjection, resolvePointer } from "../src/packet.mjs";
import { reviewStrictProjection } from "../src/strict-review.mjs";

const context = JSON.parse(fs.readFileSync(new URL("../fixtures/reference/lesson-context.json", import.meta.url)));
const sourceSet = JSON.parse(fs.readFileSync(new URL("../fixtures/reference/question-set.json", import.meta.url)));
const projected = () => packetProjection(context, { ...sourceSet, items: [sourceSet.items.find(item => item.kind === "say_back")] });
const options = { mode: "development", profile: "jev-full-experimental", samples: 3 };
const response = (questions, probability, model) => ({ model, answers: Object.fromEntries(questions.map(q => [q.id, { noul: probability }])) });
const mock = (probabilities, { name = "jev", model = "jev-1.13.0" } = {}) => {
  const calls = [];
  return { name, model, calls, async ask(state, questions, { sample }) {
    calls.push({ state: structuredClone(state), questions: structuredClone(questions), sample });
    return response(questions, probabilities[sample], model);
  } };
};
const answerable = report => report.items[0].checks.find(check => check.id === "answerable");
const review = async (provider, extra = {}) => {
  const packet = projected();
  return reviewStrictProjection(packet.context, packet.set, { ...options, provider, ...extra });
};

test("unanimous decisive draws remain usable development checks without academic approval", async () => {
  const provider = mock([1, 1, 1]), report = await review(provider), check = answerable(report);
  assert.equal(provider.calls.length, 3);
  assert.equal(check.verdict, "pass");
  assert.deepEqual(check.individual_samples.map(sample => sample.category), ["yes", "yes", "yes"]);
  assert.equal(report.status, "unverified");
  assert.equal(report.evaluator.qualification, "unqualified");
  assert.equal(report.evaluator.accuracy, "unmeasured");
});

test("yes, yes, no cannot become an approval by averaging the three probabilities", async () => {
  const provider = mock([1, 1, 0]), report = await review(provider), check = answerable(report);
  assert.equal(check.p_yes, 0.667); // The old aggregate would support yes; the disagreement still vetoes it.
  assert.equal(check.verdict, "unsure");
  assert.ok(check.gate.includes("samples_disagree"));
  assert.deepEqual(check.individual_samples.map(sample => sample.category), ["yes", "yes", "no"]);
  assert.notEqual(report.items[0].status, "checks_passed_unqualified");
});

test("one Jev draw at .51 or .41 vetoes an otherwise decisive affirmative aggregate", async () => {
  for (const probability of [.51, .41]) {
    const provider = mock([1, 1, probability]), report = await review(provider), check = answerable(report);
    assert.ok(check.p_yes > .8);
    assert.equal(check.verdict, "unsure");
    assert.ok(check.gate.includes("a_sample_abstained"));
    assert.equal(check.individual_samples[2].category, "unsure");
    assert.equal(check.individual_samples[2].p_yes, probability);
    assert.notEqual(report.items[0].status, "checks_passed_unqualified");
  }
});

test("one Gemini categorical unsure draw at .5 vetoes the side review", async () => {
  const provider = mock([1, 1, .5], { name: "maat-gemini-flash", model: "gemini-group/gemini-3.8-flash" });
  const report = await review(provider, { role: "side" }), check = answerable(report);
  assert.equal(report.evaluator.role, "side");
  assert.equal(check.verdict, "unsure");
  assert.ok(check.gate.includes("a_sample_abstained"));
  assert.deepEqual(check.individual_samples.map(sample => sample.category), ["yes", "yes", "unsure"]);
});

test("an initial transport failure stays unavailable after all retry draws recover", async () => {
  const model = "jev-1.13.0", journal = [];
  let calls = 0;
  const provider = { name: "jev", model, async ask(_state, questions) {
    if (calls++ < 3) throw Object.assign(new Error("PRIVATE_TRANSPORT_BODY_SENTINEL"), { code: "TIMEOUT" });
    return response(questions, 1, model);
  } };
  const report = await review(provider, { log: journal }), check = answerable(report);
  assert.equal(calls, 6);
  assert.equal(journal[0].retried, 1);
  assert.equal(journal[0].logical_sample_calls, 6);
  assert.equal(check.valid, 3);
  assert.equal(check.p_yes, 1);
  assert.equal(check.verdict, "unavailable");
  assert.ok(check.gate.includes("an_attempt_unavailable"));
  assert.deepEqual(check.individual_samples.map(sample => sample.category), ["unavailable", "unavailable", "unavailable", "yes", "yes", "yes"]);
  assert.ok(check.individual_samples.slice(0, 3).every(sample => sample.code === "TIMEOUT"));
  assert.doesNotMatch(JSON.stringify({ report, journal }), /PRIVATE_TRANSPORT_BODY_SENTINEL/);
});

test("provider exception messages and unrecognized secret-shaped codes never enter reports or journals", async () => {
  const secret = ["sk", "-strict-private-sentinel"].join(""), journal = [];
  const provider = { name: "jev", model: "jev-1.13.0", async ask() {
    throw Object.assign(new Error(`PRIVATE_EXCEPTION_MESSAGE ${secret}`), { code: secret });
  } };
  const report = await review(provider, { log: journal }), check = answerable(report);
  assert.equal(check.verdict, "unavailable");
  assert.ok(check.individual_samples.every(sample => sample.code === "UNAVAILABLE"));
  assert.equal(JSON.stringify({ report, journal }).includes(secret), false);
  assert.doesNotMatch(JSON.stringify({ report, journal }), /PRIVATE_EXCEPTION_MESSAGE/);
});

test("provider factory failures suppress private messages while retaining a bounded failure code", async () => {
  const packet = projected(), secret = "PRIVATE_FACTORY_FAILURE_SENTINEL";
  await assert.rejects(reviewStrictProjection(packet.context, packet.set, {
    ...options, model: "jev-1.13.0", providerFactory: async () => {
      throw Object.assign(new Error(secret), { code: "HTTP_503" });
    }
  }), error => {
    assert.equal(error.code, "HTTP_503");
    assert.equal(String(error.message).includes(secret), false);
    assert.equal(String(error.stack).includes(secret), false);
    return true;
  });
});

test("producer metadata and original task identity are stripped before strict provider requests", async () => {
  const ctx = structuredClone(context), set = structuredClone(sourceSet), identity = "PRIVATE_STRICT_PRODUCER_SENTINEL";
  set.items = [set.items.find(item => item.kind === "say_back")];
  set.made_by = { kind: "generated", note: identity };
  set.source = { generator: identity };
  set.items[0].id = identity;
  set.items[0].view.producer_id = identity;
  set.items[0].native.metadata = { generator: identity };
  ctx.source = { generator: identity };
  ctx.native.metadata = { generator: identity };
  resolvePointer(ctx.native, set.items[0].pointer).target.metadata = { generator: identity };
  const packet = packetProjection(ctx, set), clean = projected(), provider = mock([1, 1, 1]), journal = [];
  assert.deepEqual(packet.hashes, clean.hashes);
  const report = await reviewStrictProjection(packet.context, packet.set, { ...options, provider, log: journal });
  assert.equal(provider.calls.length, 3);
  assert.equal(JSON.stringify({ requests: provider.calls, report, journal }).includes(identity), false);
  assert.ok(provider.calls.every(call => call.questions.some(question => question.id === "answerable")));
});

test("strict offline review makes no provider calls and leaves semantic criteria unavailable", async () => {
  const journal = [], packet = projected();
  const report = await reviewStrictProjection(packet.context, packet.set, { ...options, provider: null, log: journal });
  assert.equal(journal.length, 0);
  assert.equal(report.evaluator.judge, null);
  assert.equal(answerable(report).requested, false);
  assert.equal(answerable(report).verdict, "unavailable");
  assert.equal(report.items[0].status, "unsure");
});
