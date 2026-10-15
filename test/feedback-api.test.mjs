import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { collectFeedback, persistFeedback, validateFeedbackOutput } from "../src/feedback-api.mjs";

const key = "iaf_live_" + "a".repeat(32);
const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const empty = field => ({ [field]: [], has_more: false, next_cursor: null });
const invariants = (version = 1, status = "published") => ({ id: id(100 + version), version, status, invariants: [], evidence: [] });
const item = extras => ({ id: id(2), report_id: id(1), body: "The answer is not supported.\nKeep the second sentence.", status: "verified", dev_note: "Author disagrees", fix_summary: "Changed the key", ...extras });
function mock(routes = {}) {
  const calls = [];
  const fetchImpl = async (address, options) => {
    const url = new URL(address); calls.push({ url, options });
    const route = routes[`${url.pathname}${url.search}`] ?? routes[url.pathname];
    if (typeof route === "function") return route(url, options);
    if (route) return response(route);
    if (url.pathname === "/api/v1/reports") return response(empty("reports"));
    if (url.pathname === "/api/v1/items") return response(empty("items"));
    if (url.pathname === "/api/v1/invariant-sets") return response({ sets: [] });
    if (url.pathname === "/api/v1/invariants") return response(invariants());
    return response({ error: "not visible" }, 404);
  };
  return { fetchImpl, calls };
}
const capture = (fixture, extra = {}) => collectFeedback({ key, fetchImpl: fixture.fetchImpl, ...extra });

test("feedback GET walk uses opaque cursors and retains original source judgments without gold promotion", async () => {
  const cursor = "opaque cursor+/=", rows = [item(), item({ id: id(3), status: "wont_fix" })];
  const fixture = mock({
    "/api/v1/reports": { reports: [{ id: id(1), status: "submitted", item_count: 2 }], has_more: false, next_cursor: null },
    "/api/v1/items": url => response(url.searchParams.has("cursor") ? { items: [rows[1]], has_more: false, next_cursor: null }
      : { items: [rows[0]], has_more: true, next_cursor: cursor }),
    [`/api/v1/reports/${id(1)}`]: { report: { id: id(1), status: "submitted" }, items: rows },
    "/api/v1/invariant-sets": { sets: [{ id: id(101), version: 1, status: "superseded" }, { id: id(102), version: 2, status: "draft" }] },
    "/api/v1/invariants": url => response(invariants(Number(url.searchParams.get("version") ?? 1), url.searchParams.get("version") === "2" ? "draft" : "superseded")),
  });
  const result = await capture(fixture);
  assert.equal(result.required_complete, true); assert.equal(result.quality_qualified, false); assert.equal(result.independent_academic_labels, 0);
  const detail = result.responses.find(row => row.route.endsWith(id(1))).data;
  assert.deepEqual(detail.items, rows); assert.equal(detail.report.status, "submitted");
  assert.equal(fixture.calls.find(call => call.url.searchParams.has("cursor")).url.searchParams.get("cursor"), cursor);
  assert.ok(fixture.calls.every(call => call.url.origin === "https://feedback.inceptapi.com" && call.options.method === "GET" && call.options.redirect === "error"));
  assert.ok(fixture.calls.every(call => !call.url.pathname.includes("/reports/current") && !call.url.pathname.includes("/keys")));
  assert.equal(result.responses.filter(row => row.query.version !== undefined).length, 2);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(key));
  assert.ok(result.responses.every(row => !Object.hasOwn(row.query, "cursor")));
});

test("feedback snapshots redact screenshots, embedded signed URLs and credentials but retain plain reviewer prose", async t => {
  const signed = "https://storage.googleapis.com/private/image.png?X-Goog-Signature=private-signature";
  const fixture = mock({ "/api/v1/items": { items: [item({ screenshot_url: signed, fix_screenshot_url: signed,
    screenshot_data_url: "data:image/png;base64,QUJD", body: `Exact wording. ${signed} ${key}`, dev_note: "Bearer server-secret",
    nested: { note: "data:image/png;base64,QUJD", access_token: "private-access-token", key: "invariant-stable-key", [key]: "value under a private property name" } })], has_more: false, next_cursor: null } });
  const result = await capture(fixture), temporary = fs.mkdtempSync(path.join(os.tmpdir(), "feedback-reader-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const out = path.join(temporary, "private", "capture"); persistFeedback(result, out, { privateRoot: path.join(temporary, "private") });
  const retained = fs.readdirSync(out).map(name => fs.readFileSync(path.join(out, name), "utf8")).join("\n");
  assert.doesNotMatch(retained, /private-signature|server-secret|QUJD|private-access-token/); assert.ok(!retained.includes(key));
  assert.match(retained, /invariant-stable-key/);
  assert.match(retained, /Exact wording/); assert.match(retained, /Changed the key/); assert.match(retained, /verified/);
  assert.equal(fs.statSync(out).mode & 0o777, 0o700);
  for (const name of fs.readdirSync(out)) assert.equal(fs.statSync(path.join(out, name)).mode & 0o777, 0o600);
  assert.throws(() => persistFeedback(result, out, { privateRoot: path.join(temporary, "private") }), /already exists/);
});

test("feedback never follows redirected credentials and retains no raw provider error", async () => {
  const fixture = mock({ "/api/v1/reports": async (_url, options) => { assert.equal(options.redirect, "error"); throw new Error(`provider echoes ${key}`); } });
  const result = await capture(fixture);
  assert.equal(result.required_complete, false); assert.equal(result.responses[0].state, "request-or-response-error");
  assert.ok(!JSON.stringify(result).includes(key)); assert.doesNotMatch(JSON.stringify(result), /provider echoes/);
  assert.equal(fixture.calls.filter(call => call.url.pathname === "/api/v1/reports").length, 1);
});

test("feedback treats HTTP redirect responses as incomplete, not as successful data", async () => {
  const fixture = mock({ "/api/v1/reports": () => new Response(null, { status: 302, headers: { location: "https://unrelated.example/" } }) });
  const result = await capture(fixture); assert.equal(result.required_complete, false); assert.equal(result.responses[0].http_status, 302);
  assert.ok(fixture.calls.every(call => call.url.hostname === "feedback.inceptapi.com"));
});

test("feedback visibility restrictions do not become evidence of absence", async () => {
  const fixture = mock({ "/api/v1/reports": () => response({}, 403), "/api/checklist": () => response({}, 404) });
  const result = await capture(fixture, { includeChecklist: true });
  assert.equal(result.required_complete, false); assert.equal(result.responses[0].state, "not-found-or-not-visible");
  assert.match(result.access_scope, /do not prove absence/);
  const optional = await capture(mock(), { includeChecklist: true });
  assert.equal(optional.required_complete, true); assert.ok(optional.responses.filter(row => !row.required).every(row => row.state === "not-found-or-not-visible"));
});

test("feedback stops new requests after an unauthorized response without storing its error body", async () => {
  const fixture = mock({ "/api/v1/reports": () => response({ error: `echo ${key}` }, 401) });
  const result = await capture(fixture); assert.equal(fixture.calls.length, 1); assert.equal(result.required_complete, false);
  assert.ok(result.responses.slice(1).every(row => row.state === "not-requested-after-unauthorized")); assert.ok(!JSON.stringify(result).includes(key));
});

test("feedback detects repeated cursors, duplicate rows and exhausted page bounds", async () => {
  const repeated = mock({ "/api/v1/reports": { reports: [], has_more: true, next_cursor: "same" } });
  assert.equal((await capture(repeated)).collections[0].reason, "repeated-cursor");
  const exhausted = mock({ "/api/v1/reports": { reports: [], has_more: true, next_cursor: "new" } });
  assert.equal((await capture(exhausted, { maxPages: 1 })).collections[0].reason, "page-limit");
  const duplicates = mock({ "/api/v1/items": { items: [item(), item()], has_more: false, next_cursor: null } });
  assert.equal((await capture(duplicates)).collections[1].reason, "repeated-row-identity");
});

test("feedback rejects malformed pagination and mismatching source version identities", async () => {
  const malformed = mock({ "/api/v1/items": { items: [], has_more: false, next_cursor: "must be null" } });
  assert.equal((await capture(malformed)).collections[1].reason, "invalid-pagination");
  const wrong = mock({ "/api/v1/invariant-sets": { sets: [{ id: id(102), version: 2 }] } });
  const result = await capture(wrong); assert.equal(result.required_complete, false);
  assert.equal(result.responses.find(row => row.query.version === 2).state, "invalid-invariant-set");
});

test("feedback bounds body sizes and rejects invalid JSON without retaining raw text", async () => {
  const large = mock({ "/api/v1/reports": () => new Response("x".repeat(101)) });
  assert.equal((await capture(large, { maxResponseBytes: 100 })).responses[0].state, "request-or-response-error");
  const invalid = mock({ "/api/v1/reports": () => new Response(`not-json ${key}`) });
  const result = await capture(invalid); assert.equal(result.responses[0].state, "invalid-json"); assert.ok(!JSON.stringify(result).includes(key));
  const total = mock(), limited = await capture(total, { maxTotalBytes: 1 });
  assert.equal(limited.required_complete, false); assert.equal(limited.responses[0].state, "total-byte-limit"); assert.equal(total.calls.length, 1);
});

test("feedback preserves partial readable snapshots when a required route is unavailable", async t => {
  const fixture = mock({ "/api/v1/items": () => response({}, 503) }); const result = await capture(fixture);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "feedback-partial-")); t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const summary = persistFeedback(result, path.join(temporary, "capture"), { privateRoot: temporary });
  assert.equal(summary.required_complete, false); assert.equal(summary.retained_files, 4);
  assert.equal(result.responses.find(row => row.route === "/api/v1/items").http_status, 503);
});

test("feedback output preflight refuses existing paths, symlink redirects and nonprivate destinations", t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "feedback-output-")); t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const base = path.join(temporary, "private"); fs.mkdirSync(base); fs.symlinkSync(temporary, path.join(base, "redirect"));
  assert.throws(() => validateFeedbackOutput(base, { privateRoot: base }), /private child/);
  assert.throws(() => validateFeedbackOutput(path.join(base, "redirect", "capture"), { privateRoot: base }), /unsafe/);
  assert.throws(() => validateFeedbackOutput(path.join(temporary, "outside"), { privateRoot: base }), /private child/);
  const output = path.join(base, "new", "capture"); assert.equal(validateFeedbackOutput(output, { privateRoot: base }), output); assert.equal(fs.existsSync(output), false);
});

test("feedback CLI help runs with an empty environment and invalid options never expose launch values", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), script = path.join(root, "scripts", "read-feedback.mjs");
  const help = spawnSync(process.execPath, [script, "--help"], { env: {}, encoding: "utf8" });
  assert.equal(help.status, 0); assert.match(help.stdout, /Read-only/); assert.equal(help.stderr, "");
  const bad = spawnSync(process.execPath, [script, "--base-url", `https://example.test/${key}`], { env: { FEEDBACK_KEY: key }, encoding: "utf8" });
  assert.equal(bad.status, 1); assert.ok(!(bad.stdout + bad.stderr).includes(key));
});

test("feedback CLI preserves an incomplete capture and exits nonzero using only mocked GETs", t => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), script = path.join(root, "scripts", "read-feedback.mjs");
  const directory = fs.mkdtempSync(path.join(root, ".local", "feedback-cli-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, "capture");
  const code = `globalThis.fetch = async (_url, options) => { if (options.method !== "GET" || options.redirect !== "error") throw Error(); return new Response("{}", {status:503}); }; process.argv = [process.execPath, ${JSON.stringify(script)}, "--out", ${JSON.stringify(output)}]; await import(${JSON.stringify(new URL("../scripts/read-feedback.mjs", import.meta.url).href)});`;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env: { FEEDBACK_KEY: key }, encoding: "utf8" });
  assert.equal(run.status, 2); assert.equal(run.stderr, ""); assert.equal(JSON.parse(run.stdout).required_complete, false);
  const receipt = JSON.parse(fs.readFileSync(path.join(output, "receipt.json"), "utf8"));
  assert.equal(receipt.required_complete, false); assert.ok(receipt.responses.every(row => row.http_status === 503));
});

test("feedback detects tied-timestamp items omitted from exhausted item lists and retains the detail union", async () => {
  const timestamp = "2026-09-02T04:25:46.537Z", first = item({ created_at: timestamp }), omitted = item({ id: id(3), created_at: timestamp, status: "fixed" });
  const fixture = mock({
    "/api/v1/reports": { reports: [{ id: id(1), item_count: 2 }], has_more: false, next_cursor: null },
    "/api/v1/items": { items: [first], has_more: false, next_cursor: null },
    [`/api/v1/reports/${id(1)}`]: { report: { id: id(1) }, items: [first, omitted] },
  });
  const result = await capture(fixture);
  assert.ok(result.collections.every(row => row.state === "complete-caller-visible-pagination"));
  assert.equal(result.required_complete, false); assert.equal(result.reconciliation.cross_endpoint_consistent, false);
  assert.deepEqual(result.reconciliation.missing_from_item_list, [id(3)]); assert.equal(result.reconciliation.union_unique, 2);
  assert.deepEqual(result.reconciled_items.find(row => row.id === id(3)).item, omitted);
  assert.equal(result.reconciled_items.find(row => row.id === id(3)).selected_source, "report-detail");
  assert.equal(result.independent_academic_labels, 0); assert.equal(result.quality_qualified, false);
});

test("feedback retains source count and content disagreements rather than silently choosing a verdict", async () => {
  const fixture = mock({
    "/api/v1/reports": { reports: [{ id: id(1), item_count: 2 }], has_more: false, next_cursor: null },
    "/api/v1/items": { items: [item()], has_more: false, next_cursor: null },
    [`/api/v1/reports/${id(1)}`]: { report: { id: id(1) }, items: [item({ status: "open", body: "Later source text" })] },
  });
  const result = await capture(fixture);
  assert.equal(result.required_complete, false); assert.equal(result.reconciliation.report_item_count_mismatches.length, 1);
  assert.deepEqual(result.reconciliation.content_disagreements[0].fields.sort(), ["body", "status"]);
  assert.equal(result.reconciled_items[0].item.body, "Later source text");
});
