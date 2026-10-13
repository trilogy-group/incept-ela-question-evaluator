// Descriptive full-run variation. These observations do not establish correctness or qualification.
const count = (values) => Object.fromEntries([...new Set(values)].sort().map((v) => [v, values.filter((x) => x === v).length]));
const shape = (check) => JSON.stringify([check.method ?? null, check.required ?? null, check.expect ?? null]);
const probability = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

function probabilityRange(checks) {
  const values = checks.map((c) => c.p_yes).filter(probability);
  if (!values.length) return null;
  const minimum = Math.min(...values), maximum = Math.max(...values);
  return { observations: values.length, minimum, maximum, range: maximum - minimum, distinct_values: new Set(values).size };
}

export function repeatStatistics(draws) {
  if (!Array.isArray(draws) || !draws.length) throw new TypeError("repeat statistics need at least one draw");
  const records = new Map();
  const add = (scope, itemId, checks, draw) => {
    if (!Array.isArray(checks)) throw new TypeError("draw checks must be arrays");
    for (const check of checks) {
      if (!check || typeof check.id !== "string" || !check.id) throw new TypeError("draw check needs an id");
      const key = JSON.stringify([scope, itemId, check.id]);
      if (!records.has(key)) records.set(key, { scope, item_id: itemId, check_id: check.id, rows: Array.from({ length: draws.length }, () => []) });
      records.get(key).rows[draw].push(check);
    }
  };
  draws.forEach((draw, index) => {
    if (!draw || !Array.isArray(draw.items) || !Array.isArray(draw.set)) throw new TypeError("draw must contain item and set arrays");
    for (const item of draw.items) {
      if (!item || typeof item.id !== "string" || !item.id) throw new TypeError("draw item needs an id");
      add("item", item.id, item.checks, index);
    }
    add("set", null, draw.set, index);
  });
  const perCheck = [...records.values()].sort((a, b) => JSON.stringify([a.scope, a.item_id, a.check_id]).localeCompare(JSON.stringify([b.scope, b.item_id, b.check_id]))).map((record) => {
    const all = record.rows.flat(), valid = all.filter((c) => typeof c.verdict === "string" && c.verdict);
    const verdicts = valid.map((c) => c.verdict), first = valid[0]?.verdict;
    const missing = record.rows.flatMap((rows, i) => rows.length ? [] : [i + 1]);
    const duplicated = record.rows.flatMap((rows, i) => rows.length > 1 ? [i + 1] : []);
    const changedShape = new Set(all.map(shape)).size > 1;
    const structureComplete = !missing.length && !duplicated.length && !changedShape && valid.length === all.length;
    const differing = record.rows.flatMap((rows, i) => rows.length === 1 && typeof rows[0].verdict === "string" && rows[0].verdict !== first ? [i + 1] : []);
    const pYes = probabilityRange(all), varied = new Set(verdicts).size > 1;
    const stable = structureComplete && !varied;
    return {
      scope: record.scope, item_id: record.item_id, check_id: record.check_id,
      observations: all.length, observed_verdict_counts: count(verdicts), verdict_varied: varied,
      draws_differing_from_first_observed: differing, uncertain_observations: verdicts.filter((v) => v === "unsure").length,
      unavailable_observations: verdicts.filter((v) => v === "unavailable").length,
      p_yes: pYes, decision_stable: stable, same_decision_with_varying_p_yes: stable && Boolean(pYes && pYes.range > 0),
      structure: { complete: structureComplete, missing_draws: missing, duplicate_draws: duplicated, check_shape_changed: changedShape, missing_verdicts: all.length - valid.length },
    };
  });
  const criteria = [...new Set(perCheck.map((c) => c.check_id))].sort().map((id) => {
    const checks = perCheck.filter((c) => c.check_id === id);
    const observedVerdicts = {};
    for (const check of checks) for (const [verdict, n] of Object.entries(check.observed_verdict_counts)) observedVerdicts[verdict] = (observedVerdicts[verdict] || 0) + n;
    return {
      check_id: id, checks_observed: checks.length, observations: checks.reduce((n, c) => n + c.observations, 0),
      observed_verdict_counts: observedVerdicts,
      checks_with_differing_decisions: checks.filter((c) => c.verdict_varied).length,
      draws_differing_from_first_observed: [...new Set(checks.flatMap((c) => c.draws_differing_from_first_observed))].sort((a, b) => a - b),
      uncertain_observations: checks.reduce((n, c) => n + c.uncertain_observations, 0),
      unavailable_observations: checks.reduce((n, c) => n + c.unavailable_observations, 0),
      checks_with_same_decision_and_varying_p_yes: checks.filter((c) => c.same_decision_with_varying_p_yes).length,
      p_yes_ranges: checks.filter((c) => c.p_yes).map((c) => ({ scope: c.scope, item_id: c.item_id, ...c.p_yes })),
      structure_complete: checks.every((c) => c.structure.complete),
      missing_observations: checks.reduce((n, c) => n + c.structure.missing_draws.length, 0),
    };
  });
  return {
    version: 1, draws: draws.length, structure_complete: perCheck.every((c) => c.structure.complete),
    per_check: perCheck, per_criterion: criteria,
    summary: {
      checks_observed: perCheck.length, checks_with_differing_decisions: perCheck.filter((c) => c.verdict_varied).length,
      checks_with_same_decision_and_varying_p_yes: perCheck.filter((c) => c.same_decision_with_varying_p_yes).length,
      checks_with_incomplete_structure: perCheck.filter((c) => !c.structure.complete).length,
    },
    meaning: "descriptive variation across full runs; probabilities are reported judge scores, not measured accuracy",
  };
}
