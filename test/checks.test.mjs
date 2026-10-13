// Planted faults: every required code check must catch the fault it exists for, and pass the authored item it is shown.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate } from "../src/evaluate.mjs";
import { createFakeProvider } from "../src/engine.mjs";

const EX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/reference");
const context = JSON.parse(fs.readFileSync(path.join(EX, "lesson-context.json"), "utf8"));
const base = JSON.parse(fs.readFileSync(path.join(EX, "question-set.json"), "utf8"));
const clone = (x) => JSON.parse(JSON.stringify(x));
const verdict = (rep, id, check) => rep.items.find((i) => i.pointer === base.items.find((b) => b.id === id).pointer).checks.find((c) => c.id === check)?.verdict;
const one = (id, mutate) => { const q = clone(base); q.items = q.items.filter((i) => i.id === id); mutate(q.items[0]); return q; };

test("the authored set passes every required code check", async () => {
  const rep = await evaluate(context, base);
  assert.deepEqual(rep.counts, { unsure: base.items.length });
  assert.equal(rep.status, "unverified");
  assert.equal(rep.items.every((i) => i.checks.filter((c) => c.method === "code" && c.required).every((c) => ["pass", "not_applicable"].includes(c.verdict))), true);
});

test("a misquoted line of the play fails quotes_exact", async () => {
  const q = one("reading-3/mcq-2", (it) => { it.view.stem = "What does “I am not what I seem” tell us about Iago?"; });
  assert.equal(verdict(await evaluate(context, q), "reading-3/mcq-2", "quotes_exact"), "fail");
});

test("a frame in quotation marks is not taken for the play's words", async () => {
  const q = one("reading-3/mcq-2", (it) => { it.view.option_feedback[0] = "Try the frame “…when he says ___”."; });
  assert.notEqual(verdict(await evaluate(context, q), "reading-3/mcq-2", "quotes_exact"), "fail");
});

test("a second keyed option or a key out of range fails one_key", async () => {
  assert.equal(verdict(await evaluate(context, one("reading-1/mcq-1", (it) => { it.view.key = [1, 3]; })), "reading-1/mcq-1", "one_key"), "fail");
  assert.equal(verdict(await evaluate(context, one("reading-1/mcq-1", (it) => { it.view.key = [7]; })), "reading-1/mcq-1", "one_key"), "fail");
});

test("a wrong option without feedback fails feedback_each_wrong_option", async () => {
  const q = one("unit-video/segment-3-check-1", (it) => { it.view.option_feedback[0] = ""; });
  assert.equal(verdict(await evaluate(context, q), "unit-video/segment-3-check-1", "feedback_each_wrong_option"), "fail");
});

test("a decoy that is also a candidate fails, and a line not in the play fails", async () => {
  const q = one("dose-1/select", (it) => { it.view.decoys.push(it.view.candidates[0]); it.view.candidates.push("I am the most loyal man in Venice."); });
  const rep = await evaluate(context, q);
  assert.equal(verdict(rep, "dose-1/select", "candidates_and_decoys_apart"), "fail");
  assert.equal(verdict(rep, "dose-1/select", "lines_are_the_play"), "fail");
});

test("a word pinned to a box its character lacks fails", async () => {
  const q = one("words-1/pin", (it) => { it.view.items[0].kind = "seems"; it.view.items[0].to = "roderigo"; });
  assert.equal(verdict(await evaluate(context, q), "words-1/pin", "every_word_has_a_box"), "fail");
});

test("the judge's verdicts follow its answers: unsure never passes, a confident wrong answer fails the item", async () => {
  const sure = (p) => createFakeProvider(() => ({ noul: p }));
  const q = one("reading-1/mcq-1", () => {});
  const yes = await evaluate(context, q, { provider: sure(0.95), samples: 2 });
  assert.equal(verdict(yes, "reading-1/mcq-1", "key_correct"), "pass");
  assert.equal(verdict(yes, "reading-1/mcq-1", "option_A_correct"), "fail");   // the fake says yes to every option
  assert.equal(yes.items[0].status, "fails");
  const unsure = await evaluate(context, q, { provider: sure(0.52), samples: 2 });
  assert.equal(verdict(unsure, "reading-1/mcq-1", "key_correct"), "unsure");
  assert.equal(unsure.items[0].status, "unsure");
});
