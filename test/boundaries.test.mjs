import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate, markdown } from "../src/evaluate.mjs";
import { packetProjection, resolvePointer } from "../src/packet.mjs";
import { seenBefore } from "../src/seen.mjs";
import { createFakeProvider } from "../src/engine.mjs";
import { judgeItem, judgeQuestions } from "../src/checks.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const context = JSON.parse(fs.readFileSync(path.join(root, "fixtures/reference/lesson-context.json")));
const base = JSON.parse(fs.readFileSync(path.join(root, "fixtures/reference/question-set.json")));
const clone = (x) => structuredClone(x);
const one = (kind) => { const q = clone(base); q.items = [q.items.find((i) => i.kind === kind)]; return q; };

test("code-only execution enumerates missing semantics instead of passing a wrong question", async () => {
  const q = one("reading_mcq"); q.items[0].view.stem = "Which option describes a chemistry experiment?";
  const rep = await evaluate(context, q);
  assert.equal(rep.items[0].status, "unsure");
  assert.equal(rep.items[0].checks.find((c) => c.id === "key_correct").verdict, "unavailable");
  assert.equal(rep.evaluator.qualification, "unqualified");
});

test("an unknown format, empty set, lesson mismatch and page mismatch never produce a pass", async () => {
  const mutations = [(q) => q.items[0].kind = "future_format", (q) => q.items = [], (q) => q.lesson = "other_lesson", (q) => q.items[0].page = "other_page"];
  for (const mutate of mutations) {
    const q = one("reading_mcq"); mutate(q); const rep = await evaluate(context, q);
    assert.equal(rep.status, "unverified"); assert.ok(rep.input_issues.length); assert.equal(rep.counts.ready, undefined);
  }
});

test("fractional keys fail and absent feedback cannot disappear as not applicable", async () => {
  const fractional = one("reading_mcq"); fractional.items[0].view.key = [1.5];
  const first = await evaluate(context, fractional); assert.equal(first.items[0].checks.find((c) => c.id === "one_key").verdict, "fail");
  const missing = one("reading_mcq"); delete missing.items[0].view.option_feedback;
  const second = await evaluate(context, missing); assert.equal(second.items[0].checks.find((c) => c.id === "feedback_each_wrong_option").verdict, "fail");
});

test("empty evidence and classification tasks cannot pass by vacuity", async () => {
  const provider = createFakeProvider(() => ({ noul: 0.95 }));
  for (const kind of ["classify", "evidence_select"]) {
    const q = one(kind); for (const key of ["items", "candidates", "decoys", "strong"]) if (key in q.items[0].view) q.items[0].view[key] = [];
    if (kind === "classify") q.items[0].view.boxes = {};
    assert.equal((await evaluate(context, q, { provider })).items[0].status, "fails");
  }
});

test("word web and say back require semantics, not advisory-only coverage", async () => {
  for (const kind of ["word_web", "say_back"]) {
    const rep = await evaluate(context, one(kind));
    assert.equal(rep.items[0].checks.find((c) => c.id === "answerable").required, true);
    assert.equal(rep.items[0].status, "unsure");
  }
});

test("producer metadata and item identities do not reach hashes, reports or judge state", async () => {
  const q = one("reading_mcq"), other = clone(q), ctx = clone(context);
  const identity = "PRIVATE_PRODUCER_SENTINEL";
  other.made_by = { kind: "generated", note: identity }; other.source = { generator: identity }; other.items[0].id = identity;
  other.items[0].native.metadata = { generator: identity }; other.items[0].view.producer_id = identity;
  ctx.source = { generator: identity }; ctx.native.metadata = { generator: identity };
  resolvePointer(ctx.native, other.items[0].pointer).target.metadata = { generator: identity };
  assert.deepEqual(packetProjection(context, q).hashes, packetProjection(ctx, other).hashes);
  const log = [], rep = await evaluate(ctx, other, { provider: createFakeProvider(() => ({ noul: 0.5 })), log, profile: "jev-full-experimental" });
  assert.ok(log.length > 0);
  assert.equal(JSON.stringify({ rep, log, markdown: markdown(rep) }).includes(identity), false);
});

test("disabled optional pages and later native feedback are omitted from earlier exposure", () => {
  const ctx = clone(context); const item = base.items.find((i) => i.id === "reading-1/mcq-1");
  ctx.native.extras.shelf = false; ctx.native.pages[2].nodes[0] = { type: "shelf", text: "OPTIONAL_SENTINEL" };
  assert.equal(seenBefore(ctx.native, item, base.items).some((p) => p.text.includes("OPTIONAL_SENTINEL")), false);
  const q = one("reading_mcq"); q.items[0] = clone(base.items.find((i) => i.id === "reading-1/mcq-2")); q.items[0].order = 1;
  ctx.native.pages[6].nodes[0].mcqs[0].yes = "LATER_FEEDBACK_SENTINEL";
  assert.equal(seenBefore(ctx.native, q.items[0], q.items).some((p) => p.text.includes("LATER_FEEDBACK_SENTINEL")), false);
});

test("serving revision absence is explicit and sample agreement is not labelled accuracy", async () => {
  const rep = await evaluate(context, one("open_check"), { provider: createFakeProvider(() => ({ noul: 0.95 })), samples: 3 });
  assert.equal(rep.items[0].judge.served_revision, null); assert.equal(rep.items[0].judge.revision_verified, false);
  assert.match(markdown(rep), /not independent repeatability or accuracy/);
  assert.equal(rep.items[0].status, "unsure"); // Exact exposure remains unverified, even unanimous judgments.
});

test("classification checks alternate destinations without revealing a hidden teacher-only meaning", () => {
  const item = one("classify").items[0], angry = item.view.items.findIndex((w) => w.word === "angry");
  assert.ok(angry >= 0); assert.match(item.view.items[angry].meaning, /Roderigo/);
  const state = judgeItem(item); assert.equal(state.words[angry + 1], "angry"); assert.equal(JSON.stringify(state).includes(item.view.items[angry].meaning), false);
  const qs = judgeQuestions(item);
  assert.ok(qs.some((q) => q.q.id === `word_${angry + 1}_iago_is_also_fits` && q.required && !q.expect));
});

test("unfamiliar classification variants abstain instead of using word-pin field assumptions", async () => {
  const q = one("classify"); q.items[0].view = { prompt: "Sort the facts", groups: ["fact", "opinion"], entries: [] };
  const rep = await evaluate(context, q); assert.equal(rep.items[0].status, "unsure");
  assert.equal(rep.items[0].checks.find((c) => c.id === "format_coverage").verdict, "unavailable");
});

test("generic public pointers and adapter operations survive transport but do not gain semantic coverage", async () => {
  const c = clone(context), q = one("classify"), native = { id: "public-question", type: "evidence-sorting", stem: "Sort the source statements.", payload: { categories: ["observed", "inferred"] } };
  c.native = { id: "public-lesson", pages: [{ id: "phase-one", questions: [native] }] };
  q.items[0] = { id: "public-question", page: "phase-one", order: 1, kind: "classify", pointer: "/pages/0/questions/0", view: { prompt: native.stem, categories: native.payload.categories }, native: clone(native), adapter_extension: { version: "public-adapter/0.1", operation: "evidence-sorting" }, public_native_format: "evidence-sorting" };
  q.quality_status = { approved: true };
  const projected = packetProjection(c, q);
  assert.equal(projected.set.items[0].adapter_extension.operation, "evidence-sorting");
  assert.equal(projected.set.items[0].public_native_format, "evidence-sorting");
  assert.equal(projected.set.quality_status, undefined);
  const provider = createFakeProvider(() => ({ noul: 0.95 }));
  const rep = await evaluate(c, q, { provider });
  assert.equal(rep.transport.status, "accepted"); assert.equal(rep.items[0].status, "unsure"); assert.equal(provider.calls.length, 0);
  assert.equal(rep.items[0].checks.find((x) => x.id === "format_coverage").verdict, "unavailable");
  assert.deepEqual(seenBefore(c.native, q.items[0], q.items), []);
  const mismatched = clone(q); mismatched.items[0].native.stem = "Different native payload";
  assert.ok((await evaluate(c, mismatched)).input_issues.includes("item native copy differs from the pointer target"));
  const wrongPage = clone(q); wrongPage.items[0].page = "another-phase";
  assert.ok((await evaluate(c, wrongPage)).input_issues.includes("item page or pointer does not match its lesson"));
});

test("pointer-based alignment accepts unfamiliar containers and escaped property names", async () => {
  const c = clone(context), q = one("say_back"), native = { id: "public-response", task: "Explain the source." };
  c.native = { phases: { "phase/one": { id: "phase-one", cards: [native] } } };
  q.items[0] = { id: "public-response", page: "phase-one", order: 1, kind: "say_back", pointer: "/phases/phase~1one/cards/0", view: { prompt: native.task }, native: clone(native) };
  const rep = await evaluate(c, q); assert.equal(rep.transport.status, "accepted"); assert.equal(rep.items[0].status, "unsure");
});
