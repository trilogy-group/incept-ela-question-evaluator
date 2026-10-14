import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadLaunchEnv, childLaunchEnv } from "../src/launch-env.mjs";

function withFixture(contents, check) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "launch-env-test-"));
  const file = path.join(dir, "synthetic.env");
  try {
    fs.writeFileSync(file, contents, { mode: 0o600 });
    return check(file, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("no explicit file returns a fresh copy of the supplied environment", () => {
  const base = { HOME: "/synthetic/home", PATH: "/synthetic/bin", TYPESAFE_MODEL: "jev-1.13.0" };
  const result = loadLaunchEnv(undefined, base);
  assert.deepEqual(result, base);
  assert.notEqual(result, base);
  result.TYPESAFE_MODEL = "changed";
  assert.equal(base.TYPESAFE_MODEL, "jev-1.13.0");
});

test("only approved keys are copied from an explicit file; comments, export and quotes are supported", () => {
  const contents = [
    "# synthetic file",
    "export MAAT_API_TOKEN='dashboard-token'",
    'TFY_API_KEY="gateway-token"',
    "TFY_INDIVIDUAL_TOKEN=individual-token",
    "TFY_GATEWAY_URL=https://tfy.example.test/path # comment",
    "GEMINI_FLASH_MODEL=gemini-primary/flash",
    'TYPESAFE_API_KEY="type\\"safe"',
    "TYPESAFE_MODEL='jev-1.13.0'",
    "HOME=/wrong/home",
    "PATH=/wrong/bin",
    "UNRELATED='unterminated",
    "garbage without an assignment"
  ].join("\n");
  withFixture(contents, (file) => {
    const base = { HOME: "/synthetic/home", PATH: "/synthetic/bin", PRESERVED: "yes" };
    const result = loadLaunchEnv(file, base);
    assert.deepEqual(result, {
      ...base,
      MAAT_API_TOKEN: "dashboard-token", TFY_API_KEY: "gateway-token", TFY_INDIVIDUAL_TOKEN: "individual-token",
      TFY_GATEWAY_URL: "https://tfy.example.test/path", GEMINI_FLASH_MODEL: "gemini-primary/flash",
      TYPESAFE_API_KEY: 'type"safe', TYPESAFE_MODEL: "jev-1.13.0"
    });
    assert.deepEqual(base, { HOME: "/synthetic/home", PATH: "/synthetic/bin", PRESERVED: "yes" });
  });
});

test("nonempty launch values already present in the supplied environment take precedence", () => {
  withFixture("TFY_API_KEY=file-token\nTYPESAFE_MODEL=jev-file\nTFY_GATEWAY_URL=https://file.example.test\nMAAT_API_TOKEN=file-dashboard\n", (file) => {
    const base = { TFY_API_KEY: "base-token", TYPESAFE_MODEL: "jev-base", TFY_GATEWAY_URL: "https://base.example.test", MAAT_API_TOKEN: "  " };
    const result = loadLaunchEnv(file, base);
    assert.equal(result.TFY_API_KEY, "base-token");
    assert.equal(result.TYPESAFE_MODEL, "jev-base");
    assert.equal(result.TFY_GATEWAY_URL, "https://base.example.test");
    assert.equal(result.MAAT_API_TOKEN, "file-dashboard");
  });
});

test("blank optional TFY entries stay unset so a MAAT launch token remains usable", () => {
  const contents = "MAAT_API_TOKEN='synthetic-dashboard'\nTFY_INDIVIDUAL_TOKEN=\nTFY_API_KEY=''\nTYPESAFE_API_KEY=\"\"\nTFY_GATEWAY_URL= # optional\n";
  withFixture(contents, (file) => {
    const result = loadLaunchEnv(file, {});
    assert.equal(result.MAAT_API_TOKEN, "synthetic-dashboard");
    for (const key of ["TFY_INDIVIDUAL_TOKEN", "TFY_API_KEY", "TYPESAFE_API_KEY", "TFY_GATEWAY_URL"]) {
      assert.equal(Object.hasOwn(result, key), false);
    }
    const withBase = loadLaunchEnv(file, { TFY_INDIVIDUAL_TOKEN: "existing-token" });
    assert.equal(withBase.TFY_INDIVIDUAL_TOKEN, "existing-token");
    assert.equal(withBase.MAAT_API_TOKEN, "synthetic-dashboard");
  });
});

test("shell-looking file values remain literal and never execute", () => {
  withFixture("", (file, dir) => {
    const marker = path.join(dir, "should-not-exist");
    const expression = `$(touch ${marker})`;
    fs.writeFileSync(file, `TFY_API_KEY=${expression}\n`, { mode: 0o600 });
    const result = loadLaunchEnv(file, {});
    assert.equal(result.TFY_API_KEY, expression);
    assert.equal(fs.existsSync(marker), false);
  });
});

test("ordinary CRLF assignments remain one-line values", () => {
  withFixture("export TFY_API_KEY='synthetic-token'\r\nTYPESAFE_MODEL=jev-1.13.0\r\n", (file) => {
    const result = loadLaunchEnv(file, {});
    assert.equal(result.TFY_API_KEY, "synthetic-token");
    assert.equal(result.TYPESAFE_MODEL, "jev-1.13.0");
  });
});

test("missing files and malformed approved values fail with generic diagnostics", () => {
  withFixture("", (file, dir) => {
    const missing = path.join(dir, "private-name.env");
    assert.throws(() => loadLaunchEnv(missing, {}), (error) => error.message === "launch environment file unavailable"
      && !error.message.includes(missing));
    const bad = [
      "TFY_API_KEY='unterminated",
      'TFY_API_KEY="closed" trailing',
      "TFY_API_KEY=value\\",
      "TFY_API_KEY='first\nsecond'",
      "TFY_API_KEY=one\rtwo",
      "TFY_API_KEY=one\u2028two",
      "export TFY_API_KEY without-equals"
    ];
    for (const [index, contents] of bad.entries()) {
      fs.writeFileSync(file, contents, { mode: 0o600 });
      assert.throws(() => loadLaunchEnv(file, {}), (error) => error.message === "invalid launch environment file"
        && !error.message.includes(file) && !error.message.includes(contents), `malformed synthetic case ${index}`);
    }
  });
});

test("child environment carries only portable runtime settings for an offline draw", () => {
  const portable = { PATH: "/synthetic/bin", LANG: "en_US.UTF-8", LC_ALL: "C", LC_CTYPE: "UTF-8", TZ: "UTC",
    TMPDIR: "/synthetic/tmp", TEMP: "/synthetic/temp", TMP: "/synthetic/tmp2", SystemRoot: "C:\\Synthetic", SYSTEMROOT: "C:\\SYNTHETIC" };
  const base = { ...portable, HOME: "/synthetic/home", NODE_OPTIONS: "--import=/synthetic/hook.mjs", AWS_SECRET_ACCESS_KEY: "synthetic-unrelated-secret",
    TYPESAFE_API_KEY: "synthetic-jev-key", MAAT_API_TOKEN: "synthetic-dashboard-key", TFY_API_KEY: "synthetic-tfy-key" };
  const child = childLaunchEnv(base);
  assert.deepEqual(child, portable);
  assert.notEqual(child, base);
  child.PATH = "changed";
  assert.equal(base.PATH, "/synthetic/bin");
});

test("child environment includes only credentials for the selected adapter routes", () => {
  const base = { PATH: "/synthetic/bin", NODE_OPTIONS: "--import=/synthetic/hook.mjs", HOME: "/synthetic/home",
    TYPESAFE_API_KEY: "synthetic-jev-key", TYPESAFE_MODEL: "jev-test",
    MAAT_API_TOKEN: "synthetic-dashboard-key", TFY_API_KEY: "synthetic-tfy-key",
    TFY_INDIVIDUAL_TOKEN: "synthetic-individual-key", TFY_GATEWAY_URL: "https://synthetic.example",
    GEMINI_FLASH_MODEL: "gemini-primary/gemini-3.8-flash", AWS_ACCESS_KEY_ID: "synthetic-unrelated-key" };
  const runtime = { PATH: "/synthetic/bin" };
  const jev = { TYPESAFE_API_KEY: base.TYPESAFE_API_KEY, TYPESAFE_MODEL: base.TYPESAFE_MODEL };
  const gemini = { MAAT_API_TOKEN: base.MAAT_API_TOKEN, TFY_API_KEY: base.TFY_API_KEY,
    TFY_INDIVIDUAL_TOKEN: base.TFY_INDIVIDUAL_TOKEN, TFY_GATEWAY_URL: base.TFY_GATEWAY_URL,
    GEMINI_FLASH_MODEL: base.GEMINI_FLASH_MODEL };
  assert.deepEqual(childLaunchEnv(base, { judge: "jev" }), { ...runtime, ...jev });
  assert.deepEqual(childLaunchEnv(base, { sideJudge: "gemini-flash" }), { ...runtime, ...gemini });
  assert.deepEqual(childLaunchEnv(base, { judge: "jev", sideJudge: "gemini-flash" }), { ...runtime, ...jev, ...gemini });
  for (const options of [{ judge: "jev" }, { sideJudge: "gemini-flash" }, { judge: "jev", sideJudge: "gemini-flash" }]) {
    const child = childLaunchEnv(base, options);
    for (const forbidden of ["NODE_OPTIONS", "HOME", "AWS_ACCESS_KEY_ID"]) assert.equal(Object.hasOwn(child, forbidden), false);
  }
});

test("child environment fails closed on unsupported adapters and ignores inherited or non-string values", () => {
  const base = Object.assign(Object.create({ TYPESAFE_API_KEY: "inherited-key", NODE_OPTIONS: "inherited-hook" }),
    { PATH: "/synthetic/bin", TYPESAFE_MODEL: "jev-test", TFY_API_KEY: 123 });
  assert.deepEqual(childLaunchEnv(base, { judge: "jev", sideJudge: "gemini-flash" }), { PATH: "/synthetic/bin", TYPESAFE_MODEL: "jev-test" });
  for (const options of [{ judge: "claude" }, { sideJudge: "gemini-pro" }, { judge: null }, { sideJudge: null }]) {
    assert.throws(() => childLaunchEnv({}, options), /invalid child launch environment/);
  }
  for (const invalid of [null, undefined, [], "env"]) assert.throws(() => childLaunchEnv(invalid), /invalid child launch environment/);
});
