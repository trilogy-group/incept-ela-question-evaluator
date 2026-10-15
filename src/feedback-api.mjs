// Caller-visible feedback snapshots. No write routes, model calls or inferred quality labels.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ORIGIN = "https://feedback.inceptapi.com";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uuid = value => typeof value === "string" && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const fail = message => { throw new TypeError(`feedback: ${message}`); };

function allowedRoute(route) {
  return ["/api/v1/reports", "/api/v1/items", "/api/v1/invariants", "/api/v1/invariant-sets", "/api/checklist", "/api/checklist/versions"].includes(route)
    || /^\/api\/v1\/reports\/[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(route)
    || /^\/api\/checklist\/versions\/[1-9]\d*$/.test(route);
}

function sanitizer(key) {
  const counts = { launch_credentials: 0, credential_strings: 0, credential_fields: 0, signed_urls: 0, screenshot_fields: 0, screenshot_data: 0 };
  const replace = (text, expression, label, replacement) => text.replace(expression, () => { counts[label]++; return replacement; });
  function clean(value, field = "", depth = 0) {
    if (depth > 100) fail("response nesting exceeds limit");
    if (/^(?:fix_)?screenshot_(?:url|data_url)$/i.test(field) && value !== null) {
      counts.screenshot_fields++; return "[redacted screenshot URL or data]";
    }
    if (/^(?:authorization|(?:api|access|refresh|auth)_?(?:key|token)|password|secret)$/i.test(field) && value !== null) {
      counts.credential_fields++; return "[redacted credential field]";
    }
    if (Array.isArray(value)) return value.map(row => clean(row, "", depth + 1));
    if (object(value)) return Object.fromEntries(Object.entries(value).map(([name, row]) => [clean(name, "", depth + 1), clean(row, name, depth + 1)]));
    if (typeof value !== "string") return value;
    let result = value.split(key).join("[redacted launch credential]");
    counts.launch_credentials += value.split(key).length - 1;
    result = replace(result, /\b(?:iaf_live_[A-Za-z0-9]{32}|apk_[A-Za-z0-9]{20,}|apikey_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{30,})\b/g, "credential_strings", "[redacted credential]");
    result = replace(result, /\bBearer\s+[^\s"'<>]+/gi, "credential_strings", "Bearer [redacted credential]");
    result = replace(result, /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, "screenshot_data", "[redacted screenshot data]");
    return result.replace(/https?:\/\/[^\s<>"']+/gi, urlText => {
      try {
        const url = new URL(urlText);
        if (url.username || url.password || [...url.searchParams.keys()].some(name => /^(?:x-goog-|x-amz-)|^(?:signature|sig|token|access_token|api_key|key)$/i.test(name))) {
          counts.signed_urls++; return "[redacted signed or credential URL]";
        }
      } catch { /* Retain ordinary reviewer wording that is not a parseable URL. */ }
      return urlText;
    });
  }
  return { clean, counts };
}

async function boundedBody(response, limit) {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > limit) fail("response exceeds byte limit");
  if (!response.body) return "";
  const reader = response.body.getReader(), chunks = []; let bytes = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > limit) { await reader.cancel(); fail("response exceeds byte limit"); }
      chunks.push(Buffer.from(next.value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}

/** Requests only fixed-origin GET routes. Source text remains untrusted source material. */
export async function collectFeedback({ key, fetchImpl = globalThis.fetch, includeChecklist = false,
  maxPages = 1000, maxRows = 200000, timeoutMs = 30000, maxResponseBytes = 16 * 1024 * 1024, maxTotalBytes = 256 * 1024 * 1024 } = {}) {
  if (typeof key !== "string" || !/^iaf_live_[A-Za-z0-9]{32}$/.test(key)) fail("FEEDBACK_KEY is missing or invalid");
  if (typeof fetchImpl !== "function" || typeof includeChecklist !== "boolean") fail("invalid reader options");
  for (const [name, value, ceiling] of [["maxPages", maxPages, 10000], ["maxRows", maxRows, 1000000], ["timeoutMs", timeoutMs, 60000], ["maxResponseBytes", maxResponseBytes, 64 * 1024 * 1024], ["maxTotalBytes", maxTotalBytes, 1024 * 1024 * 1024]])
    if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) fail(`invalid ${name}`);
  const { clean, counts } = sanitizer(key), responses = [], collections = [];
  let totalRows = 0, totalBytes = 0, unauthorized = false, byteBudgetExhausted = false;
  async function request(route, query = {}, required = true) {
    if (!allowedRoute(route)) fail("route is not read-allowlisted");
    const entry = { sequence: responses.length + 1, method: "GET", route, required,
      query: Object.fromEntries(Object.entries(query).filter(([name]) => name !== "cursor")),
      cursor_sha256: query.cursor ? sha(query.cursor) : null, observed_at: new Date().toISOString() };
    responses.push(entry);
    if (unauthorized) { entry.state = "not-requested-after-unauthorized"; return entry; }
    if (byteBudgetExhausted) { entry.state = "not-requested-after-byte-limit"; return entry; }
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const url = new URL(route, ORIGIN);
      for (const [name, value] of Object.entries(query)) url.searchParams.set(name, String(value));
      const response = await fetchImpl(url.href, { method: "GET", headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }, redirect: "error", signal: controller.signal });
      entry.http_status = response.status;
      if (response.status === 401) unauthorized = true;
      if (response.status === 403 || response.status === 404) { entry.state = "not-found-or-not-visible"; return entry; }
      if (!response.ok) { entry.state = "http-error"; return entry; }
      if (response.redirected || (response.url && new URL(response.url).origin !== ORIGIN)) { entry.state = "unexpected-redirect"; return entry; }
      const body = await boundedBody(response, maxResponseBytes);
      entry.response_sha256 = sha(body); entry.response_bytes = Buffer.byteLength(body);
      totalBytes += entry.response_bytes;
      if (totalBytes > maxTotalBytes) { byteBudgetExhausted = true; entry.state = "total-byte-limit"; return entry; }
      let value;
      try { value = JSON.parse(body); } catch { entry.state = "invalid-json"; return entry; }
      if (!object(value)) { entry.state = "invalid-response-shape"; return entry; }
      entry.data = clean(value); entry.sanitized_sha256 = sha(json(entry.data)); entry.state = "read";
    } catch { entry.state = controller.signal.aborted ? "timeout" : "request-or-response-error"; }
    finally { clearTimeout(timer); }
    return entry;
  }
  async function paginate(route, field) {
    const collection = { route, required: true, pages: 0, rows: 0, state: "incomplete" }, rows = [], seenCursors = new Set(), seenIds = new Set();
    collections.push(collection); let cursor;
    for (let page = 0; page < maxPages; page++) {
      const entry = await request(route, { limit: 200, ...(cursor ? { cursor } : {}) }); collection.pages++;
      if (entry.state !== "read") { collection.reason = entry.state; return rows; }
      const data = entry.data;
      if (!Array.isArray(data[field]) || data[field].length > 200 || typeof data.has_more !== "boolean"
        || (data.has_more ? typeof data.next_cursor !== "string" || !data.next_cursor || data.next_cursor.length > 4096 : data.next_cursor !== null)) {
        entry.state = "invalid-pagination"; collection.reason = entry.state; return rows;
      }
      if (data[field].some(row => !object(row) || !uuid(row.id))) { entry.state = "invalid-row-identity"; collection.reason = entry.state; return rows; }
      for (const row of data[field]) {
        if (seenIds.has(row.id)) { collection.reason = "repeated-row-identity"; return rows; }
        if (++totalRows > maxRows) { collection.reason = "row-limit"; return rows; }
        seenIds.add(row.id); rows.push(row); collection.rows++;
      }
      if (!data.has_more) { collection.state = "complete-caller-visible-pagination"; return rows; }
      if (seenCursors.has(data.next_cursor)) { collection.reason = "repeated-cursor"; return rows; }
      seenCursors.add(data.next_cursor); cursor = data.next_cursor;
    }
    collection.reason = "page-limit"; return rows;
  }
  const reports = await paginate("/api/v1/reports", "reports");
  const itemList = await paginate("/api/v1/items", "items");
  const sets = await request("/api/v1/invariant-sets");
  function verifyInvariants(entry, version) {
    if (entry.state === "read" && (!uuid(entry.data.id) || !Number.isSafeInteger(entry.data.version) || entry.data.version < 1
      || (version !== undefined && entry.data.version !== version) || !["published", "superseded", "draft"].includes(entry.data.status)
      || !Array.isArray(entry.data.invariants) || !Array.isArray(entry.data.evidence))) entry.state = "invalid-invariant-set";
    return entry;
  }
  verifyInvariants(await request("/api/v1/invariants"));
  if (sets.state === "read") {
    if (!Array.isArray(sets.data.sets) || sets.data.sets.length > maxRows
      || sets.data.sets.some(row => !object(row) || !uuid(row.id) || !Number.isSafeInteger(row.version) || row.version < 1)
      || new Set(sets.data.sets.map(row => row.version)).size !== sets.data.sets.length) sets.state = "invalid-invariant-version-list";
    else for (const row of sets.data.sets) verifyInvariants(await request("/api/v1/invariants", { version: row.version }), row.version);
  }
  for (const row of reports) {
    const entry = await request(`/api/v1/reports/${row.id}`);
    if (entry.state === "read" && (!object(entry.data.report) || entry.data.report.id !== row.id || !Array.isArray(entry.data.items)
      || entry.data.items.some(item => !object(item) || !uuid(item.id) || item.report_id !== row.id)
      || new Set(entry.data.items.map(item => item.id)).size !== entry.data.items.length)) entry.state = "invalid-report-detail";
  }
  const listed = new Map(itemList.map(row => [row.id, row])), details = new Map(), countMismatches = [], repeatedDetailIds = [];
  for (const row of reports) {
    const entry = responses.find(candidate => candidate.route === `/api/v1/reports/${row.id}` && candidate.state === "read");
    if (!entry) continue;
    if (!Number.isSafeInteger(row.item_count) || row.item_count !== entry.data.items.length)
      countMismatches.push({ report_id: row.id, listed_item_count: row.item_count ?? null, detail_item_count: entry.data.items.length });
    for (const item of entry.data.items) {
      if (details.has(item.id)) repeatedDetailIds.push(item.id);
      else details.set(item.id, { item, response_sequence: entry.sequence });
    }
  }
  const missingFromList = [...details.keys()].filter(id => !listed.has(id)), missingFromDetails = [...listed.keys()].filter(id => !details.has(id));
  const stable = value => Array.isArray(value) ? value.map(stable) : object(value)
    ? Object.fromEntries(Object.keys(value).sort().map(name => [name, stable(value[name])])) : value;
  const disagreements = [];
  for (const [id, listItem] of listed) {
    const detailItem = details.get(id)?.item; if (!detailItem) continue;
    const fields = Object.keys(listItem).filter(name => Object.hasOwn(detailItem, name) && !/screenshot_(?:url|data_url)$/i.test(name)
      && JSON.stringify(stable(listItem[name])) !== JSON.stringify(stable(detailItem[name])));
    if (fields.length) disagreements.push({ item_id: id, fields });
  }
  const reconciliation = { item_list_unique: listed.size, report_detail_unique: details.size,
    missing_from_item_list: missingFromList, missing_from_report_details: missingFromDetails,
    repeated_detail_item_ids: repeatedDetailIds, report_item_count_mismatches: countMismatches, content_disagreements: disagreements,
    cross_endpoint_consistent: !(missingFromList.length || missingFromDetails.length || repeatedDetailIds.length || countMismatches.length || disagreements.length),
    comparison_scope: "Shared fields only; expiring screenshot URLs excluded. Sequential reads can differ; this does not identify the cause.",
    union_selection: "Prefer the separately retained report-detail observation when available; this is a source choice, not an academic judgment." };
  const reconciledItems = [...new Set([...listed.keys(), ...details.keys()])].map(id => ({ id,
    from_item_list: listed.has(id), report_detail_response_sequence: details.get(id)?.response_sequence ?? null,
    selected_source: details.has(id) ? "report-detail" : "item-list", item: details.get(id)?.item ?? listed.get(id) }));
  reconciliation.union_unique = reconciledItems.length;
  if (includeChecklist) {
    await request("/api/checklist", {}, false);
    const versions = await request("/api/checklist/versions", {}, false);
    if (versions.state === "read") {
      if (!Array.isArray(versions.data.versions) || versions.data.versions.length > maxRows
        || versions.data.versions.some(row => !object(row) || !Number.isSafeInteger(row.version) || row.version < 1)
        || new Set(versions.data.versions.map(row => row.version)).size !== versions.data.versions.length) versions.state = "invalid-checklist-version-list";
      else for (const row of versions.data.versions) await request(`/api/checklist/versions/${row.version}`, {}, false);
    }
  }
  const requiredComplete = collections.every(row => row.state === "complete-caller-visible-pagination")
    && responses.filter(row => row.required).every(row => row.state === "read") && reconciliation.cross_endpoint_consistent;
  return { contract: "course-feedback-capture/0.1", captured_at: new Date().toISOString(), origin: ORIGIN,
    required_complete: requiredComplete, collections, responses, redactions: counts, reconciliation, reconciled_items: reconciledItems,
    bounds: { max_pages_per_list: maxPages, max_list_rows: maxRows, request_timeout_ms: timeoutMs, max_response_bytes: maxResponseBytes,
      max_total_response_bytes: maxTotalBytes, observed_response_bytes: totalBytes },
    access_scope: "Caller-visible rows only. Omitted internal or other-reviewer rows are unknown; 403/404 do not prove absence.",
    consistency: "Sequential live reads, not an atomic server snapshot. Source status and versions are retained as observed.",
    evidence_status: "Reviewer reports and published/draft invariants are source evidence; triage/fixed/verified never creates an independent academic label.",
    independent_academic_labels: 0, quality_qualified: false, model_calls: 0 };
}

/** Retains only sanitized JSON under a fresh private child directory; never overwrites. */
export function persistFeedback(capture, output, { privateRoot = path.join(ROOT, ".local") } = {}) {
  if (!object(capture) || capture.contract !== "course-feedback-capture/0.1" || !Array.isArray(capture.responses)) fail("invalid capture");
  const base = path.resolve(privateRoot), out = validateFeedbackOutput(output, { privateRoot });
  let current = path.parse(base).root;
  for (const part of path.relative(current, out).split(path.sep)) {
    current = path.join(current, part);
    if (fs.existsSync(current)) {
      const stat = fs.lstatSync(current);
      // System temporary-directory aliases are allowed only before the private root.
      if (!stat.isDirectory() && !(stat.isSymbolicLink() && !current.startsWith(base))) fail("output ancestor is unsafe");
      if (current === out) fail("output already exists");
    } else fs.mkdirSync(current, { mode: 0o700 });
  }
  const files = [];
  for (const entry of capture.responses) {
    if (!Object.hasOwn(entry, "data")) continue;
    const name = `response-${String(entry.sequence).padStart(6, "0")}.json`, bytes = json(entry.data);
    fs.writeFileSync(path.join(out, name), bytes, { flag: "wx", mode: 0o600 });
    files.push({ path: name, sha256: sha(bytes), sequence: entry.sequence });
  }
  const unionBytes = json(capture.reconciled_items);
  fs.writeFileSync(path.join(out, "reconciled-items.json"), unionBytes, { flag: "wx", mode: 0o600 });
  files.push({ path: "reconciled-items.json", sha256: sha(unionBytes), role: "source-observation-union; not academic labels" });
  const { reconciled_items, ...metadata } = capture;
  const receipt = { ...metadata, responses: capture.responses.map(({ data, ...entry }) => entry), files };
  const bytes = json(receipt); fs.writeFileSync(path.join(out, "receipt.json"), bytes, { flag: "wx", mode: 0o600 });
  return { required_complete: capture.required_complete, response_count: capture.responses.length,
    retained_files: files.length, receipt_sha256: sha(bytes), quality_qualified: false, independent_academic_labels: 0 };
}

/** Preflight without reading credentials, making requests or creating directories. */
export function validateFeedbackOutput(output, { privateRoot = path.join(ROOT, ".local") } = {}) {
  if (typeof output !== "string" || !output) fail("invalid output path");
  const base = path.resolve(privateRoot), out = path.resolve(output);
  if (!out.startsWith(`${base}${path.sep}`)) fail("output must be a new private child directory");
  let current = path.parse(base).root;
  for (const part of path.relative(current, out).split(path.sep)) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) continue;
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() && !(stat.isSymbolicLink() && !current.startsWith(base))) fail("output ancestor is unsafe");
    if (current === out) fail("output already exists");
  }
  return out;
}
