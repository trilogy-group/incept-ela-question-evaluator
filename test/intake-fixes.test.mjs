import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { evaluate, evaluateProjection, markdown } from "../src/evaluate.mjs";
import { inputIssues, packetProjection, resolvePointer } from "../src/packet.mjs";
import { seenBefore, playLines } from "../src/seen.mjs";
import { createFakeProvider } from "../src/engine.mjs";

const context = JSON.parse(fs.readFileSync(new URL("../fixtures/reference/lesson-context.json", import.meta.url)));
const base = JSON.parse(fs.readFileSync(new URL("../fixtures/reference/question-set.json", import.meta.url)));
const clone = (x) => structuredClone(x);
const one = (kind = "reading_mcq") => { const q = clone(base); q.items = [q.items.find((it) => it.kind === kind)]; return q; };

test("required public metadata and item shapes reject malformed input before any judge call", async () => {
  const mutations = [
    (c) => { delete c.lesson.learning_question; }, (c) => { c.lesson.learning_question = {}; },
    (c) => { delete c.lesson.keywords; }, (c) => { c.lesson.keywords = {}; },
    (c) => { c.lesson = []; }, (c) => { c.lesson.title = 7; },
    (c) => { delete c.source; }, (c) => { c.source = []; },
    (_, q) => { delete q.source; }, (_, q) => { q.source = null; },
    (_, q) => { delete q.made_by; }, (_, q) => { q.made_by = []; },
    (_, q) => { q.made_by.kind = "unknown"; }, (_, q) => { q.made_by.note = []; },
    (c, q) => { c.lesson.id = q.lesson = 17; }, (c, q) => { c.lesson.id = q.lesson = " "; },
    (_, q) => { q.items[0].id = " "; }, (_, q) => { q.items[0].page = []; },
    (_, q) => { q.items[0].pointer = ""; }, (_, q) => { q.items[0].view = []; },
    (_, q) => { delete q.items[0].native; }, (_, q) => { q.items[0] = []; }
  ];
  for (const mutate of mutations) {
    const c = clone(context), q = one(); mutate(c, q);
    const provider = createFakeProvider(() => ({ noul: 0.95 }));
    const rep = await evaluate(c, q, { provider });
    assert.ok(rep.input_issues.length, mutate.toString());
    assert.deepEqual(rep.counts, { unsure: 1 }); assert.equal(provider.calls.length, 0);
    assert.equal(rep.transport.status, "rejected");
    assert.equal(rep.status, "unverified"); assert.equal(rep.evaluator.qualification, "unqualified");
    assert.equal(rep.items[0].checks[0].id, "input_contract");
  }
});

test("malformed-item reports preserve every input position without retaining rejected producer identities", async () => {
  const q = one(), identity = "PRIVATE_REJECTED_PRODUCER_SENTINEL";
  q.items[0].id = identity;
  q.items = [null, q.items[0], 17, identity, [], false, { id: identity }];
  const rep = await evaluate(context, q);
  assert.equal(rep.items.length, q.items.length); assert.deepEqual(rep.counts, { unsure: q.items.length });
  assert.deepEqual(rep.items.map((it) => it.input_position), [1, 2, 3, 4, 5, 6, 7]);
  assert.ok(rep.items.every((it) => it.status === "unsure" && it.checks[0].verdict === "unavailable"));
  assert.equal(JSON.stringify({ rep, markdown: markdown(rep) }).includes(identity), false);
  assert.equal(packetProjection(context, q).set.items.length, q.items.length);
});

test("unsupported legacy exposure layouts stay transport-valid and abstain before any judge call", async () => {
  const mutations = [
    ["reading_mcq", (c) => { c.native.pages[0] = null; }],
    ["reading_mcq", (c) => { c.native.pages[0].nodes = {}; }],
    ["reading_mcq", (c, it) => { c.native.pages[Number(it.pointer.split("/")[2])].nodes[0].blocks = {}; }],
    ["reading_mcq", (c, it) => { c.native.pages[Number(it.pointer.split("/")[2])].nodes[0].blocks = ["VISIBLE_SCALAR_BLOCK"]; }],
    ["film_mcq", (c, it) => { c.native.pages[Number(it.pointer.split("/")[2])].nodes[0].segments[0] = null; }],
    ["say_back", (c, it) => { resolvePointer(c.native, it.pointer).target.type = "future_experience"; it.native = clone(resolvePointer(c.native, it.pointer).target); }],
    ["say_back", (c, it) => {
      c.native.pages[Number(it.pointer.split("/")[2])].extra = "disabled_fixture_extra";
      c.native.extras.disabled_fixture_extra = false;
    }],
    ["reading_mcq", (c, it) => {
      const pi = Number(it.pointer.split("/")[2]);
      c.native.pages[pi].nodes[0].future_questions = [clone(it.native)];
      it.pointer = `/pages/${pi}/nodes/0/future_questions/0`;
    }]
  ];
  for (const [kind, mutate] of mutations) {
    const c = clone(context), q = one(kind); mutate(c, q.items[0]);
    assert.deepEqual(inputIssues(c, q), []);
    const provider = createFakeProvider(() => ({ noul: 0.95 }));
    const rep = await evaluate(c, q, { provider });
    assert.equal(rep.transport.status, "accepted"); assert.equal(rep.items[0].status, "unsure");
    assert.equal(rep.items[0].checks[0].id, "format_coverage"); assert.equal(rep.items[0].checks[0].verdict, "unavailable");
    assert.equal(provider.calls.length, 0); assert.deepEqual(seenBefore(c.native, q.items[0], q.items), []);
  }
  assert.deepEqual(playLines({ pages: [{ kind: "script", lines: [null, { line: "A supplied line." }] }] }), ["A supplied line."]);
});

test("nested learner source text survives projection while source attribution stays blinded", async () => {
  const c = clone(context), q = one(), identity = "PRIVATE_SOURCE_PRODUCER_SENTINEL";
  const text = "A public learning source says the actor hesitates.";
  c.native.pages[0].nodes[0].source = { text, lines: ["A second supplied line."] };
  const expected = packetProjection(c, q);
  c.native.pages[0].nodes[0].source = { ...c.native.pages[0].nodes[0].source,
    producer_id: identity, generator: identity, author: identity, name: identity, url: identity, note: identity,
    metadata: { text: identity } };
  const packet = packetProjection(c, q);
  assert.deepEqual(packet.hashes, expected.hashes);
  assert.equal(seenBefore(packet.context.native, packet.set.items[0], packet.set.items).some((p) => p.text.includes(text)), true);
  assert.deepEqual(packetProjection(packet.context, packet.set), packet);
  const log = [], rep = await evaluate(c, q, { provider: createFakeProvider(() => ({ noul: 0.5 })), log, profile: "jev-full-experimental" });
  assert.ok(JSON.stringify(log).includes(text));
  assert.equal(JSON.stringify({ packet, rep, log, markdown: markdown(rep) }).includes(identity), false);
  c.native.pages[0].nodes[0].source = { author: identity, note: identity };
  assert.deepEqual(packetProjection(c, q).hashes, packetProjection(context, q).hashes);
});

test("frozen projection replay validates its remaining shape without requiring removed provenance", async () => {
  const q = one(), packet = packetProjection(context, q);
  assert.ok((await evaluate(packet.context, packet.set)).input_issues.length);
  const raw = await evaluate(context, q), replay = await evaluateProjection(packet.context, packet.set);
  assert.deepEqual(replay, raw);
  packet.context.lesson.keywords = {};
  assert.ok((await evaluateProjection(packet.context, packet.set)).input_issues.includes("lesson keywords must be an array"));
});
