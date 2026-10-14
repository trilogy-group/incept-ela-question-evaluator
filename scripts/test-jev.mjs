#!/usr/bin/env node
// Private development casebook runner. Offline by default; --live consumes only a launch credential.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { decide } from "../src/engine.mjs";
import { createJevProvider } from "../src/typed/jev.mjs";
import { GATES } from "../src/typed/questions.mjs";
import { runtimeSnapshot, sha } from "../src/replay.mjs";

const script = fileURLToPath(import.meta.url), root = path.resolve(path.dirname(script), "..");
const SAMPLES = 3, MODELS_URL = "https://api.typesafe.ai/v1/models";
const record = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const str = (x) => typeof x === "string" && x.trim().length > 0;
const finite = (x) => typeof x === "number" && Number.isFinite(x);
const fail = (code) => { throw new Error(code); };
const json = (x) => JSON.stringify(x, null, 1) + "\n";
const write = (dir, name, x) => fs.writeFileSync(path.join(dir, name), json(x), { mode: 0o600, flag: "wx" });
const append = (file, x) => fs.appendFileSync(file, JSON.stringify(x) + "\n", { mode: 0o600 });
const LABEL_KEYS = new Set(["expected", "labels", "gold", "rationale", "origin", "source_finding"]);
const hasLabels = (x) => Array.isArray(x) ? x.some(hasLabels) : record(x) && Object.entries(x).some(([k, v]) => LABEL_KEYS.has(k) || hasLabels(v));

export function splitPack(pack) {
  if (!record(pack) || pack.schema_version !== 1 || !Array.isArray(pack.cases) || !pack.cases.length || pack.cases.length > 100) fail("invalid_casebook");
  const ids = new Set();
  for (const c of pack.cases) {
    if (!record(c) || !str(c.id) || ids.has(c.id) || !record(c.state) || !Array.isArray(c.questions) || !c.questions.length || c.questions.length > 64 || !record(c.expected)) fail("invalid_case");
    ids.add(c.id);
    if (hasLabels(c.state) || hasLabels(c.questions)) fail("labels_in_provider_packet");
    const qs = new Set();
    for (const q of c.questions) {
      if (!record(q) || !str(q.id) || qs.has(q.id) || !str(q.instructions) || !["noul", "choice", "score"].includes(q.type)) fail("invalid_question");
      if (Object.keys(q).some((k) => !["id", "type", "instructions", "criteria"].includes(k))) fail("unexpected_question_field");
      qs.add(q.id);
      if (q.type === "choice" && (!record(q.criteria) || Object.keys(q.criteria).length < 2 || Object.keys(q.criteria).length > 255 || !Object.values(q.criteria).every(str))) fail("invalid_choice");
      if (q.type === "score" && (!Array.isArray(q.criteria) || q.criteria.length < 2 || q.criteria.length > 10 || !q.criteria.every(str))) fail("invalid_score");
      const e = c.expected[q.id];
      if (!record(e) || !["yes", "no", "unsure", "choice-label", "score-range"].includes(e.outcome)) fail("invalid_expected_label");
      if (["yes", "no"].includes(e.outcome) && q.type !== "noul") fail("label_type_mismatch");
      if (e.outcome === "choice-label" && (q.type !== "choice" || !Object.hasOwn(q.criteria, e.target))) fail("label_type_mismatch");
      if (e.outcome === "score-range" && (q.type !== "score" || !Array.isArray(e.target) || e.target.length !== 2 || !e.target.every(finite) || e.target[0] < 1 || e.target[1] > q.criteria.length || e.target[0] > e.target[1])) fail("label_type_mismatch");
    }
    if (Object.keys(c.expected).some((id) => !qs.has(id))) fail("unknown_expected_question");
  }
  const packet = { schema_version: 1, cases: pack.cases.map(({ id, state, questions }) => ({ id, state, questions })) };
  const labels = { schema_version: 1, provenance: pack.provenance ?? null, source_pins: pack.source_pins ?? null,
    cases: pack.cases.map(({ id, origin, expected }) => ({ id, origin: origin ?? null, expected })) };
  return { packet, labels };
}

// Preserve the typed numeric response, not arbitrary provider prose, echoed secrets or error bodies.
export function boundedAnswer(q, raw) {
  if (!record(raw)) return null;
  const num = (v) => finite(v) ? v : null;
  if (q.type === "noul") return { noul: num(raw.noul) };
  const out = q.type === "choice" ? { choice: typeof raw.choice === "string" && Object.hasOwn(q.criteria, raw.choice) ? raw.choice : null, confidence: num(raw.confidence) }
    : { score: num(raw.score), ...(raw.confidence === undefined ? {} : { confidence: finite(raw.confidence) ? raw.confidence : "invalid" }) };
  if (raw.probabilities !== undefined) {
    if (Array.isArray(raw.probabilities) && q.type === "score") out.probabilities = raw.probabilities.slice(0, q.criteria.length + 1).map(num);
    else if (record(raw.probabilities)) {
      const keys = q.type === "choice" ? Object.keys(q.criteria) : Array.from({ length: q.criteria.length + 1 }, (_, i) => String(i));
      out.probabilities = Object.fromEntries(Object.entries(raw.probabilities).filter(([k]) => keys.includes(k)).map(([k, v]) => [k, num(v)]));
      if (Object.keys(raw.probabilities).some((k) => !keys.includes(k))) out.probabilities.__unexpected_key__ = null;
    } else out.probabilities = { __invalid_shape__: null };
  }
  return out;
}

const safeModel = (x, secret = "") => typeof x === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(x)
  && !(secret && x.includes(secret)) && !/^(?:apk_|sk-|AIza)/.test(x) ? x : null;
export function modelIds(payload) {
  const entries = Array.isArray(payload) ? payload : payload?.data ?? payload?.models;
  if (!Array.isArray(entries)) fail("invalid_model_inventory");
  return [...new Set(entries.map((x) => safeModel(typeof x === "string" ? x : x?.id ?? x?.name)).filter(Boolean))];
}

export async function discoverModels({ apiKey, fetchImpl = globalThis.fetch }) {
  if (!apiKey) fail("launch_credential_missing");
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const response = await fetchImpl(MODELS_URL, { headers: { Authorization: `Bearer ${apiKey}` }, signal: ctl.signal });
    if (!response.ok) fail("model_inventory_unavailable");
    return modelIds(await response.json()).filter((id) => !id.includes(apiKey));
  } catch { fail("model_inventory_unavailable"); }
  finally { clearTimeout(timer); }
}

export function liveProvider({ apiKey, model, fetchImpl = globalThis.fetch, onHttp = () => {} }) {
  if (!apiKey) fail("launch_credential_missing");
  return { name: "jev", model, async ask(state, questions, opts) {
    let observedModel = null, revision = null;
    const provider = createJevProvider({ apiKey, model, fetchImpl: async (url, init) => {
      onHttp();
      const response = await fetchImpl(url, init);
      return { ok: response.ok, status: response.status, headers: response.headers, text: async () => "",
        json: async () => {
          const raw = await response.json();
          observedModel = safeModel(raw?.model, apiKey); revision = safeModel(raw?.served_revision, apiKey);
          return { model: observedModel, served_revision: revision,
            answers: Object.fromEntries(questions.map((q) => [q.id, boundedAnswer(q, raw?.answers?.[q.id])])) };
        } };
    } });
    try {
      const result = await provider.ask(state, questions, opts);
      // The frozen provider falls back to the request alias when the response omits model. Undo that fallback.
      return { ...result, model: observedModel, served_revision: revision };
    } catch { throw new Error("provider_unavailable"); }
  } };
}

function outcome(q, answer) {
  if (!answer || answer.unavailable) return "unavailable";
  if (!answer.pass) return "unsure";
  return q.type === "noul" ? (answer.value >= 0.5 ? "yes" : "no") : answer.value;
}

export async function runDraw(packet, { provider, draw = 1, onRaw = () => {}, onJournal = () => {} } = {}) {
  const rows = [], observations = [];
  let calls = 0;
  for (const c of packet.cases) {
    const recorded = { name: provider.name, model: provider.model, async ask(state, questions, opts) {
      const call = ++calls;
      try {
        const response = await provider.ask(state, questions, opts);
        const obs = { draw, case_id: c.id, call, sample: opts.sample, model: safeModel(response.model), reported_served_revision: safeModel(response.served_revision), unavailable: false };
        observations.push(obs);
        const answers = Object.fromEntries(questions.map((q) => [q.id, boundedAnswer(q, response.answers?.[q.id])]));
        onRaw({ ...obs, answers });
        return { answers, model: obs.model, served_revision: obs.reported_served_revision };
      } catch {
        const obs = { draw, case_id: c.id, call, sample: opts.sample, model: null, reported_served_revision: null, unavailable: true };
        observations.push(obs); onRaw({ ...obs, error: "provider_unavailable" });
        throw new Error("provider_unavailable");
      }
    } };
    const log = [], result = await decide(c.state, c.questions, { provider: recorded, samples: SAMPLES, tag: c.id, log });
    onJournal({ event: "case_draw", draw, ...log[0] });
    for (const q of c.questions) rows.push({ case_id: c.id, question_id: q.id, type: q.type, outcome: outcome(q, result.answers[q.id]), answer: result.answers[q.id] });
  }
  return { draw, invocation_id: crypto.randomUUID(), pid: process.pid, rows, observations, logical_sample_calls: calls, qualification: false };
}

export function summarize(draws, labels, requestedModel) {
  const expected = new Map(labels.cases.flatMap((c) => Object.entries(c.expected).map(([id, e]) => [`${c.id}\0${id}`, e])));
  const counts = { comparisons: 0, matches: 0, expected_yes_observed_no: 0, expected_no_observed_yes: 0, other_mismatches: 0, abstentions: 0, unavailable: 0, expected_abstentions: 0, unexpected_decisions: 0, conditional_comparisons: 0 };
  const byCriterion = new Map();
  for (const d of draws) for (const row of d.rows) {
    const key = `${row.case_id}\0${row.question_id}`, e = expected.get(key);
    if (!e) fail("missing_frozen_label");
    counts.comparisons++; if (e.conditional) counts.conditional_comparisons++;
    const abstain = ["unsure", "unavailable"].includes(row.outcome);
    if (abstain) counts.abstentions++;
    if (row.outcome === "unavailable") counts.unavailable++;
    if (e.outcome === "unsure") {
      counts.expected_abstentions++;
      if (row.outcome === "unsure") counts.matches++;
      else if (!abstain) counts.unexpected_decisions++;
    } else if (!abstain) {
      const match = e.outcome === "choice-label" ? row.outcome === e.target : e.outcome === "score-range" ? finite(row.outcome) && row.outcome >= e.target[0] && row.outcome <= e.target[1] : row.outcome === e.outcome;
      if (match) counts.matches++;
      else if (e.outcome === "yes" && row.outcome === "no") counts.expected_yes_observed_no++;
      else if (e.outcome === "no" && row.outcome === "yes") counts.expected_no_observed_yes++;
      else counts.other_mismatches++;
    }
    const a = byCriterion.get(key) ?? []; a.push({ draw: d.draw, ...row }); byCriterion.set(key, a);
  }
  const observations = draws.flatMap((d) => d.observations), served = [...new Set(observations.map((o) => o.model).filter(Boolean))];
  const revisions = [...new Set(observations.map((o) => o.reported_served_revision).filter(Boolean))];
  const reasons = [];
  if (!observations.length || observations.some((o) => !o.model || o.unavailable)) reasons.push("missing_model_observation");
  if (served.length > 1) reasons.push("mixed_returned_models");
  if (!["jev-latest", "jev-preview"].includes(requestedModel) && served.some((id) => id !== requestedModel)) reasons.push("requested_model_mismatch");
  if (revisions.length > 1) reasons.push("mixed_reported_revisions");
  reasons.push("served_revision_not_independently_verified");
  const stability = [...byCriterion.values()].map((rows) => {
    const values = rows.map((r) => r.answer.value).filter(finite);
    return { case_id: rows[0].case_id, question_id: rows[0].question_id, observations: rows.length,
      complete: rows.length === draws.length, outcomes: rows.map((r) => r.outcome), identical_outcomes: new Set(rows.map((r) => r.outcome)).size === 1,
      numeric_min: values.length ? Math.min(...values) : null, numeric_max: values.length ? Math.max(...values) : null,
      probabilities_by_draw: rows.map((r) => ({ draw: r.draw, probabilities: r.answer.probabilities, valid_samples: r.answer.valid, sample_agreement: r.answer.agreement })) };
  });
  return { qualification: false, status: "development_observations_only", counts,
    count_meaning: "Counts name expected and observed directions explicitly; yes can describe quality or a defect depending on the criterion. Abstentions are separate. These are development labels, not independent academic gold.",
    requested_model: requestedModel, returned_models: served, reported_served_revisions: revisions,
    fixed_version_comparison: { allowed: false, reasons }, criterion_stability: stability,
    meaning: "Observed full-draw variation only. Within-call sample agreement is neither correctness nor independent repeatability. No accuracy or qualification claim.",
    draws: draws.length, samples_per_case_draw: SAMPLES, logical_sample_calls: draws.reduce((n, d) => n + d.logical_sample_calls, 0) };
}

function privatePath(value) {
  const file = path.resolve(root, value), base = path.join(root, ".local");
  if (!file.startsWith(base + path.sep)) fail("private_path_required");
  let cursor = file;
  while (cursor.startsWith(base)) {
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) fail("private_path_symlink");
    if (cursor === base) break;
    cursor = path.dirname(cursor);
  }
  return file;
}
function runtime() {
  const evaluator = runtimeSnapshot(root, path.join(root, "config.json"));
  const value = { evaluator, runner_sha256: sha(fs.readFileSync(script)) };
  return { ...value, sha256: sha(JSON.stringify(value)) };
}
function args(argv) {
  const o = { live: false, cases: ".local/B0998/quality-cases.json", model: "jev-latest", draws: 3 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (["--live", "--help"].includes(k)) o[k.slice(2)] = true;
    else if (["--cases", "--model", "--draws", "--out", "--worker", "--manifest"].includes(k) && argv[i + 1]) o[k.slice(2)] = argv[++i];
    else fail("invalid_arguments");
  }
  o.draws = Number(o.draws);
  if (!Number.isInteger(o.draws) || o.draws < 2 || o.draws > 10 || !safeModel(o.model)) fail("invalid_run_settings");
  return o;
}

export async function main(argv = process.argv.slice(2)) {
  const o = args(argv);
  if (o.help) { console.log("node scripts/test-jev.mjs [--cases .local/B0998/quality-cases.json] [--model jev-latest] [--draws 3] [--out .local/B0998/runs/name] [--live]\nDefault: offline plan, zero provider calls. --live requires a launch TYPESAFE_API_KEY. Three samples per case per draw; always unqualified."); return; }
  if (o.worker) {
    if (!o.live) fail("worker_requires_live");
    const out = privatePath(o.out), manifest = JSON.parse(fs.readFileSync(privatePath(o.manifest), "utf8"));
    const packetBytes = fs.readFileSync(path.join(path.dirname(privatePath(o.manifest)), "packet.json"));
    if (sha(packetBytes) !== manifest.packet_sha256 || runtime().sha256 !== manifest.runtime.sha256 || o.model !== manifest.model) fail("frozen_inputs_changed");
    fs.mkdirSync(out, { mode: 0o700 });
    const journal = path.join(out, "journal.jsonl"), raw = path.join(out, "raw-responses.jsonl");
    fs.writeFileSync(journal, "", { mode: 0o600, flag: "wx" }); fs.writeFileSync(raw, "", { mode: 0o600, flag: "wx" });
    let http = 0;
    const provider = liveProvider({ apiKey: process.env.TYPESAFE_API_KEY, model: o.model, onHttp: () => http++ });
    const result = await runDraw(JSON.parse(packetBytes), { provider, draw: Number(o.worker), onRaw: (row) => append(raw, row), onJournal: (row) => append(journal, row) });
    if (runtime().sha256 !== manifest.runtime.sha256) fail("runtime_changed");
    write(out, "draw.json", { ...result, http_requests: http, packet_sha256: manifest.packet_sha256, runtime_sha256: manifest.runtime.sha256 });
    return;
  }
  const caseBytes = fs.readFileSync(privatePath(o.cases)), pack = JSON.parse(caseBytes), { packet, labels } = splitPack(pack);
  const out = privatePath(o.out ?? `.local/B0998/runs/jev-${new Date().toISOString().replace(/[^0-9TZ]/g, "")}-${crypto.randomUUID().slice(0, 8)}`);
  fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 }); fs.mkdirSync(out, { mode: 0o700 });
  write(out, "packet.json", packet); write(out, "labels.json", labels);
  const manifest = { schema_version: 1, qualification: false, execution: o.live ? "live" : "offline-plan", model: o.model, samples: SAMPLES, draws: o.draws, gates: GATES,
    source_casebook_sha256: sha(caseBytes), packet_sha256: sha(fs.readFileSync(path.join(out, "packet.json"))), labels_sha256: sha(fs.readFileSync(path.join(out, "labels.json"))), runtime: runtime() };
  write(out, "manifest.json", manifest);
  const planned = { cases: packet.cases.length, criteria: packet.cases.reduce((n, c) => n + c.questions.length, 0), draws: o.draws, samples: SAMPLES,
    minimum_sample_calls: packet.cases.length * o.draws * SAMPLES, retry_note: "Typed all-invalid recovery and transport retries may add calls.", qualification: false };
  if (!o.live) { write(out, "plan.json", { ...planned, model_calls: 0 }); console.log(JSON.stringify({ ...planned, execution: "offline-plan", model_calls: 0, out: path.relative(root, out) })); return; }
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) fail("launch_credential_missing");
  const inventory = await discoverModels({ apiKey }); write(out, "model-inventory.json", { at: new Date().toISOString(), ids: inventory });
  if (!inventory.includes(o.model)) fail("requested_model_not_advertised");
  const journal = path.join(out, "journal.jsonl"); fs.writeFileSync(journal, "", { mode: 0o600, flag: "wx" });
  const draws = [];
  for (let i = 1; i <= o.draws; i++) {
    append(journal, { event: "draw_started", draw: i, at: new Date().toISOString() });
    const dir = path.join(out, `draw-${i}`);
    const child = spawnSync(process.execPath, [script, "--live", "--worker", String(i), "--manifest", path.join(out, "manifest.json"), "--model", o.model, "--out", dir], { encoding: "utf8", env: process.env });
    if (child.status !== 0) { append(journal, { event: "draw_failed", draw: i, qualification: false }); fail("draw_failed_private_artifacts_retained"); }
    const draw = JSON.parse(fs.readFileSync(path.join(dir, "draw.json"), "utf8"));
    if (draw.packet_sha256 !== manifest.packet_sha256 || draw.runtime_sha256 !== manifest.runtime.sha256 || draws.some((d) => d.pid === draw.pid || d.invocation_id === draw.invocation_id)) fail("draw_identity_or_hash_mismatch");
    draws.push(draw); append(journal, { event: "draw_completed", draw: i, logical_sample_calls: draw.logical_sample_calls, http_requests: draw.http_requests });
  }
  if (runtime().sha256 !== manifest.runtime.sha256 || sha(fs.readFileSync(path.join(out, "packet.json"))) !== manifest.packet_sha256 || sha(fs.readFileSync(path.join(out, "labels.json"))) !== manifest.labels_sha256) fail("frozen_inputs_changed");
  const report = summarize(draws, labels, o.model);
  write(out, "report.json", { ...report, packet_sha256: manifest.packet_sha256, labels_sha256: manifest.labels_sha256, runtime_sha256: manifest.runtime.sha256, separate_local_process_records: true,
    http_requests: 1 + draws.reduce((n, d) => n + d.http_requests, 0), inventory_requests: 1 });
  console.log(JSON.stringify({ execution: "live", ...planned, completed_draws: draws.length, counts: report.counts, returned_models: report.returned_models,
    fixed_version_comparison: report.fixed_version_comparison, logical_sample_calls: report.logical_sample_calls, out: path.relative(root, out) }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) main().catch(() => { console.error("Jev quality run unavailable; no qualification. Inspect private bounded artifacts if created."); process.exitCode = 1; });
