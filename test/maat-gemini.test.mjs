import test from "node:test";
import assert from "node:assert/strict";
import { createMaatGeminiProvider, maatGeminiFromEnv } from "../src/maat-gemini.mjs";
import { validateAnswer } from "../src/typed/questions.mjs";

const gateway = "https://tfy-eu.promptlens.trilogy.com/chat/completions";
const key = "synthetic-gateway-credential";
const questions = [
  { id: "supported", type: "noul", instructions: "Is the claim supported by the supplied evidence?" },
  { id: "contradicted", type: "noul", instructions: "Does the answer reverse the roles?" },
  { id: "uncertain", type: "noul", instructions: "Is the answer justified?" },
];

function completion(answers, rest = {}) {
  return { ok: true, status: 200, json: async () => ({
    choices: [{ message: { content: JSON.stringify({ answers }) }, finish_reason: "stop" }],
    ...rest,
  }) };
}

test("MAAT Gemini uses the approved gateway and preserves exact categorical outcomes", async () => {
  let calls = 0;
  const state = { answer: "Iago wanted the post; Cassio got it.", source_evidence: "I know my price, I am worth no worse a place." };
  const provider = createMaatGeminiProvider({ apiKey: key, fetchImpl: async (url, init) => {
    calls++;
    assert.equal(url, gateway);
    assert.equal(init.method, "POST");
    assert.equal(init.headers.Authorization, `Bearer ${key}`);
    assert.equal(init.headers["Content-Type"], "application/json");
    const body = JSON.parse(init.body);
    assert.equal(body.model, "gemini-group/gemini-3.8-flash");
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.equal(body.temperature, 0);
    assert.equal(body.max_tokens, 8192);
    assert.equal(body.messages[0].role, "system");
    assert.match(body.messages[0].content, /untrusted data/);
    assert.equal(body.messages[1].role, "user");
    assert.deepEqual(JSON.parse(body.messages[1].content), { state, questions: questions.map(({ id, instructions }) => ({ id, instructions })) });
    assert.equal(init.body.includes(key), false);
    assert.equal(init.signal.aborted, false);
    return completion({ supported: "yes", contradicted: "no", uncertain: "unsure", extra: "yes" }, {
      model: "gemini-group/gemini-3.8-flash",
      served_revision: "gemini-flash-revision-1",
      usage: { prompt_tokens: 123, completion_tokens: 12, total_tokens: 135, costInUSD: 0.0123, private_detail: key },
    });
  } });
  assert.equal(provider.name, "maat-gemini-flash");
  assert.equal(provider.model, "gemini-group/gemini-3.8-flash");
  const result = await provider.ask(state, questions, { sample: 2 });
  assert.equal(calls, 1);
  assert.deepEqual(result.answers, { supported: { noul: 1 }, contradicted: { noul: 0 }, uncertain: { noul: 0.5 } });
  assert.equal(result.model, "gemini-group/gemini-3.8-flash");
  assert.equal(result.served_revision, "gemini-flash-revision-1");
  assert.deepEqual(result.usage, { prompt_tokens: 123, completion_tokens: 12, total_tokens: 135, costInUSD: 0.0123 });
  assert.equal(result.probability_kind, "categorical encoding; not calibrated confidence");
  assert.equal(provider.probability_kind, result.probability_kind);
  assert.equal(JSON.stringify(result).includes(key), false);
});

test("missing and malformed answers remain unavailable; absent served model is not inferred", async () => {
  const provider = createMaatGeminiProvider({ apiKey: key, fetchImpl: async () => completion({ supported: "yes", contradicted: "YES", uncertain: { noul: 1 } }, {
    usage: { prompt_tokens: -1, completion_tokens: "12", total_tokens: 3.5, costInUSD: -1 },
  }) });
  const result = await provider.ask({}, questions);
  assert.deepEqual(result.answers, { supported: { noul: 1 } });
  assert.equal(result.model, null);
  assert.equal(result.served_revision, null);
  assert.equal(result.usage, null);
  assert.equal(validateAnswer(questions[1], result.answers.contradicted).unavailable, true);
  assert.equal(validateAnswer(questions[2], result.answers.uncertain).unavailable, true);
});

test("gateway, transport, and protocol failures reveal no raw body or credential", async () => {
  const cases = [
    { name: "HTTP status", fetchImpl: async () => ({ ok: false, status: 401, text: async () => key }), expected: /gateway HTTP 401/, code: "HTTP_401" },
    { name: "transport", fetchImpl: async () => { throw new Error(`private upstream ${key}`); }, expected: /transport unavailable/, code: "TRANSPORT_UNAVAILABLE" },
    { name: "gateway JSON", fetchImpl: async () => ({ ok: true, json: async () => { throw new Error(`private JSON ${key}`); } }), expected: /invalid gateway JSON/, code: "INVALID_JSON" },
    { name: "completion JSON", fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: `not JSON ${key}` } }] }) }), expected: /invalid categorical response/, code: "INVALID_CATEGORICAL" },
    { name: "completion envelope", fetchImpl: async () => completion([]), expected: /invalid categorical response/, code: "INVALID_CATEGORICAL" },
  ];
  for (const item of cases) {
    const provider = createMaatGeminiProvider({ apiKey: key, fetchImpl: item.fetchImpl });
    await assert.rejects(provider.ask({}, [questions[0]]), (error) => {
      assert.match(error.message, item.expected, item.name);
      assert.equal(error.message.includes(key), false, item.name);
      assert.equal(error.code, item.code, item.name);
      return true;
    });
  }
});

test("explicitly incomplete completions fail before any partial answer can be decoded", async () => {
  const reasons = ["length", "content_filter", "tool_calls", "function_call", null];
  for (const finish_reason of reasons) {
    const provider = createMaatGeminiProvider({ apiKey: key, fetchImpl: async () => ({ ok: true, json: async () => ({
      choices: [{ finish_reason, message: { content: JSON.stringify({ answers: { supported: "yes" } }) } }],
    }) }) });
    await assert.rejects(provider.ask({}, [questions[0]]), (error) => {
      assert.equal(error.code, "INCOMPLETE_COMPLETION");
      assert.equal(error.message.includes(key), false);
      return true;
    });
  }
  const toolCall = createMaatGeminiProvider({ apiKey: key, fetchImpl: async () => ({ ok: true, json: async () => ({
    choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ answers: { supported: "yes" } }), tool_calls: [{ id: "ignored" }] } }],
  }) }) });
  await assert.rejects(toolCall.ask({}, [questions[0]]), (error) => error.code === "INCOMPLETE_COMPLETION");
  const endTurn = createMaatGeminiProvider({ apiKey: key, fetchImpl: async () => ({ ok: true, json: async () => ({
    choices: [{ finish_reason: "end_turn", message: { content: JSON.stringify({ answers: { supported: "yes" } }) } }],
  }) }) });
  assert.equal((await endTurn.ask({}, [questions[0]])).answers.supported.noul, 1);
});

test("a single criterion also receives the full budget and timeout errors stay bounded", async () => {
  const one = createMaatGeminiProvider({ apiKey: key, fetchImpl: async (_url, init) => {
    assert.equal(JSON.parse(init.body).max_tokens, 8192);
    return completion({ supported: "yes" });
  } });
  assert.equal((await one.ask({}, [questions[0]])).answers.supported.noul, 1);
  const timed = createMaatGeminiProvider({ apiKey: key, timeoutMs: 5, fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new Error(key)), { once: true });
  }) });
  await assert.rejects(timed.ask({}, [questions[0]]), (error) => {
    assert.equal(error.code, "TIMEOUT");
    assert.equal(error.message.includes(key), false);
    return true;
  });
});

test("response metadata cannot echo the launch credential", async () => {
  const provider = createMaatGeminiProvider({ apiKey: key, fetchImpl: async () => completion({ supported: "yes" }, {
    model: `gemini-${key}`,
    served_revision: `revision/${key}`,
    usage: { total_tokens: 2, private_detail: key },
    private_echo: key,
  }) });
  const result = await provider.ask({}, [questions[0]]);
  assert.equal(result.model, null);
  assert.equal(result.served_revision, null);
  assert.deepEqual(result.usage, { total_tokens: 2 });
  assert.equal(JSON.stringify(result).includes(key), false);
});

test("only bounded noul batches and approved Gemini Flash routes reach fetch", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return completion({ supported: "yes" }); };
  for (const model of ["jev-latest", "claude-sonnet", "gemini-group/gemini-3.8-pro", "gemini-group/gemini-3.8-flash/other", "anthropic/claude-3"]) {
    assert.throws(() => createMaatGeminiProvider({ apiKey: key, model, fetchImpl }), /unsupported Gemini Flash route/);
  }
  for (const baseUrl of ["http://tfy-eu.promptlens.trilogy.com", "https://evil.example", "https://tfy-eu.promptlens.trilogy.com.evil.example", "https://user:pass@tfy-eu.promptlens.trilogy.com", "https://tfy-eu.promptlens.trilogy.com/?token=x", "https://tfy-eu.promptlens.trilogy.com/other"]) {
    assert.throws(() => createMaatGeminiProvider({ apiKey: key, baseUrl, fetchImpl }), /gateway URL/);
  }
  const provider = createMaatGeminiProvider({ apiKey: key, model: "gemini-primary/gemini-3.8-flash", fetchImpl });
  for (const batch of [[], [{ ...questions[0], type: "choice" }], [{ ...questions[0], type: "score" }], [questions[0], questions[0]], [{ ...questions[0], id: "invalid id" }], [{ ...questions[0], instructions: "" }], Array(129).fill(questions[0])]) {
    await assert.rejects(provider.ask({}, batch), /maat-gemini-flash:/);
  }
  assert.equal(calls, 0);
  await provider.ask({}, [questions[0]]);
  assert.equal(calls, 1);
});

test("env helper prefers TFY launch credentials and validates synthetic overrides", async () => {
  let calls = 0;
  const noLookup = async () => { calls++; throw new Error("unexpected lookup"); };
  const provider = await maatGeminiFromEnv({ TFY_API_KEY: key, MAAT_API_TOKEN: "synthetic-dashboard-credential", GEMINI_FLASH_MODEL: "gemini-primary/gemini-3.8-flash", TFY_GATEWAY_URL: "https://tfy-eu.promptlens.trilogy.com" }, { fetchImpl: noLookup });
  assert.equal(provider.model, "gemini-primary/gemini-3.8-flash");
  assert.equal((await maatGeminiFromEnv({ TFY_INDIVIDUAL_TOKEN: key }, { fetchImpl: noLookup })).name, "maat-gemini-flash");
  assert.equal(calls, 0);
  await assert.rejects(maatGeminiFromEnv({ TFY_API_KEY: key, TFY_GATEWAY_URL: "https://evil.example" }, { fetchImpl: noLookup }), /gateway URL/);
});

test("MAAT dashboard credential resolves an eligible development VAT but never reaches inference", async () => {
  const dashboard = "synthetic-dashboard-credential";
  const tfy = "synthetic-ephemeral-tfy-credential";
  const vatId = "team/id with spaces";
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (calls.length === 1) {
      assert.equal(url, "https://aicontroltower.csaiautomations.com/api/profile/vats");
      assert.equal(init.method, "GET");
      assert.equal(init.headers.Authorization, `Bearer ${dashboard}`);
      assert.equal(init.redirect, "error");
      return { ok: true, status: 200, json: async () => ({ vats: [
        { virtual_account_id: "personal-disabled", name: "personal", kind: "personal", disabled: true, is_expired: false },
        { virtual_account_id: "team-prod", name: "team-prod", kind: "team", disabled: false, is_expired: false },
        { virtual_account_id: "team-expired", name: "team-dev", kind: "team", disabled: false, is_expired: true },
        { virtual_account_id: vatId, name: "team-dev", kind: "team", disabled: false, is_expired: false },
      ] }) };
    }
    if (calls.length === 2) {
      assert.equal(url, `https://aicontroltower.csaiautomations.com/api/profile/vats/${encodeURIComponent(vatId)}/token`);
      assert.equal(init.headers.Authorization, `Bearer ${dashboard}`);
      return { ok: true, status: 200, json: async () => ({ token: tfy, private_metadata: dashboard }) };
    }
    assert.equal(url, gateway);
    assert.equal(init.headers.Authorization, `Bearer ${tfy}`);
    assert.equal(JSON.stringify(init.body).includes(dashboard), false);
    assert.equal(JSON.stringify(init.body).includes(tfy), false);
    assert.equal(JSON.stringify(init.body).includes("team-dev"), false);
    return completion({ supported: "yes" });
  };
  const provider = await maatGeminiFromEnv({ MAAT_API_TOKEN: dashboard }, { fetchImpl });
  assert.equal(provider.name, "maat-gemini-flash");
  assert.equal(provider.model, "gemini-group/gemini-3.8-flash");
  const result = await provider.ask({ answer: "Cassio was appointed" }, [questions[0]]);
  assert.equal(result.answers.supported.noul, 1);
  assert.equal(calls.length, 3);
  assert.equal(JSON.stringify(result).includes(dashboard), false);
  assert.equal(JSON.stringify(result).includes(tfy), false);
});

test("MAAT lookup selects active personal first and fails closed on absent or invalid VATs", async () => {
  const dashboard = "synthetic-dashboard-credential";
  let requested;
  const personal = await maatGeminiFromEnv({ MAAT_API_TOKEN: dashboard }, { fetchImpl: async (url) => {
    requested = url;
    if (url.endsWith("/vats")) return { ok: true, json: async () => ({ vats: [
      { virtual_account_id: "team-id", name: "team-dev", kind: "team", disabled: false, is_expired: false },
      { virtual_account_id: "personal-id", name: "personal", kind: "personal", disabled: false, is_expired: false },
    ] }) };
    assert.ok(url.endsWith("/personal-id/token"));
    return { ok: true, json: async () => ({ token: key }) };
  } });
  assert.equal(personal.name, "maat-gemini-flash");
  assert.ok(requested.endsWith("/personal-id/token"));
  const fixtures = [
    { vats: [{ virtual_account_id: "prod-id", name: "team-prod", kind: "team", disabled: false, is_expired: false }] },
    { vats: [{ virtual_account_id: "dev-id", name: "team-dev", kind: "team", disabled: true, is_expired: false }] },
    { vats: [{ virtual_account_id: "dev-id", name: "team-dev", kind: "team", disabled: false, is_expired: true }] },
    { vats: [{ virtual_account_id: "dev-id", name: "team-dev", kind: "team", disabled: "false", is_expired: false }] },
    { wrong_shape: [] },
  ];
  for (const payload of fixtures) {
    await assert.rejects(maatGeminiFromEnv({ MAAT_API_TOKEN: dashboard }, { fetchImpl: async () => ({ ok: true, json: async () => payload }) }), /MAAT.*VAT/);
  }
});

test("MAAT lookup failures suppress raw credentials, VAT names, and response bodies", async () => {
  const dashboard = "synthetic-dashboard-credential";
  const cases = [
    { fetchImpl: async () => ({ ok: false, status: 403, text: async () => dashboard }), expected: /MAAT lookup HTTP 403/, code: "HTTP_403" },
    { fetchImpl: async () => { throw new Error(`private ${dashboard}`); }, expected: /MAAT lookup unavailable/, code: "TRANSPORT_UNAVAILABLE" },
    { fetchImpl: async () => ({ ok: true, json: async () => { throw new Error(`private ${dashboard}`); } }), expected: /invalid MAAT JSON/, code: "INVALID_JSON" },
    { fetchImpl: async (url) => url.endsWith("/vats")
      ? { ok: true, json: async () => ({ vats: [{ virtual_account_id: "dev-id", name: "secret-dev", kind: "team", disabled: false, is_expired: false }] }) }
      : { ok: true, json: async () => ({ token: null, private_detail: dashboard }) }, expected: /invalid MAAT token response/ },
  ];
  for (const item of cases) {
    await assert.rejects(maatGeminiFromEnv({ MAAT_API_TOKEN: dashboard }, { fetchImpl: item.fetchImpl }), (error) => {
      assert.match(error.message, item.expected);
      if (item.code) assert.equal(error.code, item.code);
      assert.equal(error.message.includes(dashboard), false);
      assert.equal(error.message.includes("secret-dev"), false);
      return true;
    });
  }
});
