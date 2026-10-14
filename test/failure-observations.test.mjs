import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { decide, safeFailureCode } from "../src/typed/client.mjs";
import { noul } from "../src/typed/questions.mjs";
import { packetProjection } from "../src/packet.mjs";
import { reviewSideProjection } from "../src/side-review.mjs";

const question = (id) => noul(id, `Synthetic check ${id}`);
const response = (questions) => ({ model: "synthetic-model", answers: Object.fromEntries(questions.map((q) => [q.id, { noul: 1 }])) });
const provider = (ask) => ({ name: "synthetic-provider", model: "synthetic-model", ask });
const coded = (code, message = "private provider text") => Object.assign(new Error(message), { code });

test("partial provider failure retains its bounded code despite two usable samples", async () => {
  const log = [];
  const result = await decide({}, [question("one")], { samples: 3, log, provider: provider(async (_state, qs, { sample }) => {
    if (sample === 2) throw coded("HTTP_429");
    return response(qs);
  }) });
  assert.equal(result.answers.one.valid, 2);
  assert.equal(result.answers.one.unavailable, undefined);
  assert.equal(result.meta.logical_sample_calls, 3);
  assert.deepEqual(result.meta.failure_observations, [
    { phase: "initial", sample: 2, question_id: "one", source: "provider", code: "HTTP_429" }
  ]);
  assert.deepEqual(log[0].failure_observations, result.meta.failure_observations);
  assert.equal(JSON.stringify({ result, log }).includes("private provider text"), false);
});

test("an explicit provider error cannot pass through accompanying answers or expose its text", async () => {
  const log = [], secret = "private-error-object-sentinel";
  const result = await decide({}, [question("one")], { samples: 3, log,
    provider: provider(async (_state, qs) => ({ ...response(qs), error: secret })) });
  assert.equal(result.answers.one.unavailable, true);
  assert.equal(result.answers.one.valid, 0);
  assert.equal(result.meta.logical_sample_calls, 6);
  assert.ok(result.meta.failure_observations.every((row) => row.code === "UNAVAILABLE" && row.source === "provider"));
  assert.equal(JSON.stringify({ result, log }).includes(secret), false);
});

test("missing and invalid per-question answers retain only known validation reasons", async () => {
  const result = await decide({}, [question("one"), question("two")], { samples: 3, provider: provider(async (_state, qs, { sample }) => {
    if (sample === 0) return { model: "synthetic-model", answers: { one: { noul: 1 } } };
    if (sample === 1) return { model: "synthetic-model", answers: { one: { noul: 1 }, two: { noul: 2 } } };
    return response(qs);
  }) });
  assert.equal(result.answers.one.valid, 3);
  assert.equal(result.answers.two.valid, 1);
  assert.deepEqual(result.meta.failure_observations, [
    { phase: "initial", sample: 0, question_id: "two", source: "validation", code: "answer_missing" },
    { phase: "initial", sample: 1, question_id: "two", source: "validation", code: "probability_value" }
  ]);
  assert.equal(result.meta.serving_observations.every((row) => row.unavailable === false), true);
});

test("recovery retains initial and recovery failures even when the recovered answer is usable", async () => {
  let calls = 0;
  const result = await decide({}, [question("one")], { samples: 2, provider: provider(async (_state, qs) => {
    switch (calls++) {
      case 0: throw coded("TIMEOUT");
      case 1: return { model: "synthetic-model", answers: {} };
      case 2: throw coded("INVALID_JSON");
      default: return response(qs);
    }
  }) });
  assert.equal(result.meta.retried, 1);
  assert.equal(result.meta.logical_sample_calls, 4);
  assert.equal(result.answers.one.valid, 1);
  assert.deepEqual(result.meta.failure_observations, [
    { phase: "initial", sample: 0, question_id: "one", source: "provider", code: "TIMEOUT" },
    { phase: "initial", sample: 1, question_id: "one", source: "validation", code: "answer_missing" },
    { phase: "recovery", sample: 0, question_id: "one", source: "provider", code: "INVALID_JSON" }
  ]);
});

test("unknown exception details and code getters cannot reach aggregate or journal", async () => {
  const secret = ["sk", "-private-provider-credential-sentinel"].join("");
  const log = [];
  const result = await decide({}, [question("one")], { samples: 1, log, provider: provider(async () => {
    throw coded(secret, secret);
  }) });
  assert.equal(result.answers.one.valid, 0);
  assert.deepEqual(result.meta.failure_observations.map((row) => row.code), ["UNAVAILABLE", "UNAVAILABLE"]);
  assert.equal(JSON.stringify({ result, log }).includes(secret), false);
  assert.equal(safeFailureCode({ get code() { throw new Error(secret); } }), "UNAVAILABLE");
});

test("side wrapper preserves an allowlisted failure code without a provider message", async () => {
  const context = JSON.parse(fs.readFileSync(new URL("../fixtures/reference/lesson-context.json", import.meta.url)));
  const set = JSON.parse(fs.readFileSync(new URL("../fixtures/reference/question-set.json", import.meta.url)));
  const projected = packetProjection(context, { ...set, items: [set.items.find((item) => item.kind === "say_back")] });
  const model = "gemini-group/gemini-3.8-flash", secret = "PRIVATE_SIDE_PROVIDER_SENTINEL", log = [];
  const side = { name: "maat-gemini-flash", model, async ask(_state, questions, { sample }) {
    if (sample === 2) throw coded("HTTP_503", secret);
    return { model, answers: Object.fromEntries(questions.map((q) => [q.id, { noul: 1 }])) };
  } };
  const result = await reviewSideProjection(projected.context, projected.set, { provider: side, log });
  assert.equal(log.length, 1);
  assert.deepEqual(log[0].failure_observations, [
    { phase: "initial", sample: 2, question_id: "answerable", source: "provider", code: "HTTP_503" }
  ]);
  assert.equal(result.items[0].checks.find((check) => check.id === "answerable").verdict, "unavailable");
  assert.equal(JSON.stringify({ result, log }).includes(secret), false);
});
