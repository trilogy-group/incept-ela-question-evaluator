import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel)));
const sha = (rel) => crypto.createHash("sha256").update(fs.readFileSync(path.join(root, rel))).digest("hex");

test("public fixture, schemas and frozen runtime match their recorded local hashes", () => {
  for (const name of ["fixtures/reference/manifest.json", "src/typed/manifest.json"]) for (const f of read(name).files) assert.equal(sha(f.path), f.sha256, f.path);
});

test("source observations are pinned development evidence and carry no independent gold claim", () => {
  const m = read("fixtures/source-reviews/manifest.json");
  assert.equal(sha(`fixtures/source-reviews/${m.path}`), m.sha256);
  assert.equal(m.independent_gold_labels, 0); assert.match(m.use, /NOT independently adjudicated gold/);
  const r = read("fixtures/source-reviews/reference-review.json"); assert.equal(r.scope.extracted_units, 40); assert.equal(r.findings.length, 14);
  assert.ok(r.findings.some((f) => f.id === "R11" && f.kind === "conditional_delivery_limit"));
});

test("the 14 development case labels retain their source claims and limits without manufacturing gold", () => {
  const book = read("cases/reference-review.json"), raw = read(book.source_review);
  const findings = new Map(raw.findings.map((f) => [f.id, f]));
  assert.equal(book.cases.length, 14); assert.equal(book.independent_human_gold_labels, 0);
  assert.equal(new Set(book.cases.map((c) => c.id)).size, 14);
  for (const c of book.cases) {
    const f = findings.get(c.source_finding); assert.ok(f);
    assert.equal(c.claim, f.claim); assert.equal(c.scope_limitations, f.limits); assert.deepEqual(c.criteria.source_card_ids, f.criteria);
    assert.equal(c.label.independent_human_gold, false); assert.equal(c.label.whole_item_approval, false);
    assert.ok(c.conditional_expected_outcome.condition); assert.equal(c.conditional_expected_outcome.unmet_condition, 'not_verified');
  }
  const registry = read('criteria/criteria.json');
  for (const check of [...registry.checks, ...registry.set]) {
    assert.ok(check.learnings.length > 0); assert.equal(check.record_links.length, check.learnings.length);
    check.learnings.forEach((id, i) => assert.equal(check.record_links[i], `https://github.com/trilogy-group/incept-ela-learning-truths/blob/main/learnings/${id}.json`));
  }
});
