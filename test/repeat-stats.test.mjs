import test from "node:test";
import assert from "node:assert/strict";
import { repeatStatistics } from "../src/repeat-stats.mjs";

const check = (id, verdict, p_yes) => ({ id, method: "judge", required: true, expect: "yes", verdict, ...(p_yes === undefined ? {} : { p_yes }) });
const draw = (checks, more = []) => ({ items: [{ id: "item-a", checks }, ...more], set: [] });
const find = (stats, id) => stats.per_check.find((c) => c.item_id === "item-a" && c.check_id === id);

test("repeat statistics distinguish changed decisions, uncertainty and unavailable checks", () => {
  const stats = repeatStatistics([
    draw([check("key_correct", "pass", 0.9), check("answerable", "unavailable")]),
    draw([check("key_correct", "fail", 0.1), check("answerable", "unsure", 0.5)]),
    draw([check("key_correct", "unsure", 0.51), check("answerable", "unavailable")]),
  ]);
  const key = find(stats, "key_correct"), answerable = find(stats, "answerable");
  assert.deepEqual(key.observed_verdict_counts, { fail: 1, pass: 1, unsure: 1 });
  assert.deepEqual(key.draws_differing_from_first_observed, [2, 3]);
  assert.equal(key.verdict_varied, true); assert.equal(key.uncertain_observations, 1);
  assert.equal(answerable.unavailable_observations, 2); assert.equal(answerable.uncertain_observations, 1);
  assert.equal(key.p_yes.minimum, 0.1); assert.equal(key.p_yes.maximum, 0.9);
  assert.equal(stats.structure_complete, true); assert.equal(stats.summary.checks_with_differing_decisions, 2);
});

test("the same verdict with changing judge scores is reported separately", () => {
  const stats = repeatStatistics([draw([check("key_correct", "pass", 0.8)]), draw([check("key_correct", "pass", 0.95)])]);
  const key = find(stats, "key_correct");
  assert.equal(key.decision_stable, true); assert.equal(key.verdict_varied, false);
  assert.equal(key.same_decision_with_varying_p_yes, true); assert.deepEqual(key.draws_differing_from_first_observed, []);
  assert.equal(stats.summary.checks_with_same_decision_and_varying_p_yes, 1);
  assert.equal(key.p_yes.observations, 2); assert.equal(key.p_yes.distinct_values, 2);
});

test("missing checks stay structural gaps rather than fabricated unavailable verdicts", () => {
  const stats = repeatStatistics([draw([check("key_correct", "pass", 0.9)]), draw([])]);
  const key = find(stats, "key_correct");
  assert.equal(stats.structure_complete, false); assert.deepEqual(key.structure.missing_draws, [2]);
  assert.equal(key.decision_stable, false); assert.equal(key.unavailable_observations, 0);
  assert.deepEqual(key.observed_verdict_counts, { pass: 1 });
  assert.equal(stats.per_criterion[0].missing_observations, 1);
});

test("criterion summaries do not mistake different items' decisions for run variation", () => {
  const a = [check("answerable", "pass", 0.9)], b = { id: "item-b", checks: [check("answerable", "fail", 0.1)] };
  const stats = repeatStatistics([draw(a, [b]), draw(a, [b])]);
  const criterion = stats.per_criterion.find((c) => c.check_id === "answerable");
  assert.deepEqual(criterion.observed_verdict_counts, { pass: 2, fail: 2 });
  assert.equal(criterion.checks_with_differing_decisions, 0); assert.equal(criterion.structure_complete, true);
  assert.equal(criterion.p_yes_ranges.length, 2);
});

test("changed check shape and duplicate checks cannot count as complete repetitions", () => {
  const normal = check("key_correct", "pass", 0.9), optional = { ...normal, required: false };
  const changed = repeatStatistics([draw([normal]), draw([optional])]);
  assert.equal(find(changed, "key_correct").structure.check_shape_changed, true);
  assert.equal(changed.structure_complete, false); assert.equal(find(changed, "key_correct").decision_stable, false);
  const duplicate = repeatStatistics([draw([normal]), draw([normal, normal])]);
  assert.deepEqual(find(duplicate, "key_correct").structure.duplicate_draws, [2]); assert.equal(duplicate.structure_complete, false);
});

test("set checks are compared, null scores stay absent and input objects are untouched", () => {
  const draws = [draw([]), draw([])]; draws[0].set = [check("key_positions", "pass", null)]; draws[1].set = [check("key_positions", "flag", null)];
  const before = structuredClone(draws), stats = repeatStatistics(draws);
  assert.deepEqual(draws, before); assert.equal(stats.per_check[0].scope, "set");
  assert.equal(stats.per_check[0].p_yes, null); assert.equal(stats.per_check[0].verdict_varied, true);
  assert.equal(stats.summary.checks_with_differing_decisions, 1);
  assert.throws(() => repeatStatistics([]), /at least one draw/);
});
