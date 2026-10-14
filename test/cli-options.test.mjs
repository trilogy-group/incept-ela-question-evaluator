import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCliOptions, CLI_HELP } from "../src/cli-options.mjs";

const pin = "a".repeat(64);
test("help is an explicit pure route and default evaluation remains available", () => {
  assert.equal(parseCliOptions([]).route, "evaluate");
  for (const flag of ["--help", "-h"]) assert.equal(parseCliOptions([flag]).route, "help");
  assert.match(CLI_HELP, /node bin\/evaluate\.mjs/);
  assert.match(CLI_HELP, /--native-package/);
  assert.match(CLI_HELP, /--review reconcile/);
  assert.throws(() => parseCliOptions(["--help", "--out", "unused"]), /help must be used alone/);
});

test("public route commands, pins and development settings are compatible", () => {
  const examples = [
    [["--context", "context.json", "--set", "questions.json", "--out", "output"], "evaluate", null],
    [["--mode", "development", "--judge", "jev", "--profile", "jev-full-experimental", "--side-judge", "gemini-flash", "--env-file", "launch.env", "--strict-samples", "true", "--qualification", "qualification.json", "--trusted-reviewers", "reviewers.json"], "evaluate", null],
    [["--lesson-package", "finished", "--course-pin", pin, "--config", "config.lesson.json", "--out", "output"], "lesson", null],
    [["--lesson-package", "finished", "--mode", "development", "--judge", "jev", "--side-judge", "gemini-flash"], "lesson", null],
    [["--native-package", "finished", "--native-source-pin", pin, "--out", "output"], "native", null],
    [["--corpus", "collection", "--catalog-sha256", pin, "--mode", "development", "--judge", "jev", "--env-file", "launch.env"], "corpus", null],
    [["--golden-reference", "capture", "--reference-tier", "secondary", "--out", "output"], "golden-reference", null],
    [["--golden-check", "bundle", "--golden-pin", pin, "--assessment", "report.json", "--assessment-kind", "model-development", "--assessment-relation", "historical"], "golden-check", null],
    [["--review", "prepare", "--review-model", "jev-latest", "--reported-model", "jev-1.13.0", "--config", "config.json", "--out", "output"], "review", "prepare"],
    [["--review", "reconcile", "--bundle", "bundle.json", "--review-a", "a.json", "--review-b", "b.json", "--adjudication", "resolution.json"], "review", "reconcile"],
    [["--review", "score", "--bundle", "bundle.json", "--labels", "labels.json", "--draws", "draw-1.json,draw-2.json"], "review", "score"],
  ];
  for (const [argv, route, operation] of examples) { const parsed = parseCliOptions(argv); assert.equal(parsed.route, route); assert.equal(parsed.operation, operation); assert.deepEqual(parsed.argv, argv); assert.equal(parsed.internal, false); }
});

test("all existing fresh-process worker flags are accepted and their integrity inputs are required", () => {
  const shared = ["--config", "config.json", "--mode", "development", "--judge", "none", "--side-judge", "none", "--out", "worker-output"];
  const examples = [
    ["evaluate-worker", ["--worker-draw", "1", "--frozen-packet", "packet.json", "--expected-packet", pin, "--expected-runtime", pin, "--frozen-qualification", "qualification.json", "--expected-qualification", pin, "--frozen-trust", "trust.json", "--expected-trust", pin, "--expected-profile", pin, "--profile", "jev-partial-v1", "--strict-samples", "false"]],
    ["lesson-worker", ["--lesson-worker", "2", "--lesson-packet", "packet.json", "--expected-packet", pin, "--expected-runtime", pin, "--expected-protocol", pin]],
    ["corpus-worker", ["--corpus-worker", "3", "--corpus-packet", "packet.json", "--expected-corpus-packet", pin, "--expected-runtime", pin, "--expected-protocol", pin]],
  ];
  for (const [route, worker] of examples) {
    assert.equal(parseCliOptions([...worker, ...shared]).route, route);
    assert.equal(parseCliOptions([...worker, ...shared]).internal, true);
    const index = worker.indexOf("--expected-runtime"), missing = worker.filter((_, i) => i !== index && i !== index + 1);
    assert.throws(() => parseCliOptions([...missing, ...shared]), /requires --expected-runtime/);
  }
});

test("unknown, positional, duplicate, missing and mixed-route arguments cannot fall through", () => {
  for (const argv of [
    ["--typo", "synthetic"], ["position"], ["--corpus"], ["--corpus", "--out", "unused"],
    ["--out", "first", "--out", "second"], ["--judge", "none", "--judge", "jev"], ["--set", ""],
    ["--lesson-package", "finished", "--corpus", "collection"], ["--review", "prepare", "--corpus", "collection"],
    ["--native-package", "finished", "--golden-check", "bundle"], ["--lesson-package", "finished", "--lesson-worker", "1"],
    ["--worker-draw", "1", "--corpus-worker", "1"], ["--out=unused"],
  ]) assert.throws(() => parseCliOptions(argv), TypeError);
});

test("route-irrelevant critical pins, launch settings and review inputs are rejected", () => {
  for (const argv of [
    ["--course-pin", pin], ["--native-source-pin", pin], ["--catalog-sha256", pin], ["--expected-packet", pin],
    ["--lesson-package", "finished", "--profile", "jev-full-experimental"], ["--corpus", "collection", "--course-pin", pin],
    ["--native-package", "finished", "--config", "config.json"], ["--native-package", "finished", "--judge", "none"],
    ["--golden-reference", "capture", "--golden-pin", pin], ["--golden-check", "bundle", "--out", "unused"],
    ["--review", "prepare", "--bundle", "unused"], ["--review", "score", "--bundle", "bundle", "--labels", "labels", "--draws", "one", "--judge", "none"],
  ]) assert.throws(() => parseCliOptions(argv), /unsupported for this route/);
});

test("invalid values and incomplete operation dependencies report no provided values", () => {
  const secretLike = "PRIVATE_SYNTHETIC_VALUE_DO_NOT_ECHO";
  for (const argv of [
    ["--mode", secretLike], ["--out", "first", "--out", secretLike], ["--judge", secretLike],
    ["--strict-samples", secretLike], ["--native-package", "finished", "--native-source-pin", secretLike],
    ["--review", "prepare", "--review-model", secretLike], ["--review", "score", "--bundle", "b", "--labels", "l", "--draws", ","],
    ["--golden-check", "b", "--assessment", secretLike], ["--golden-check", "b", "--assessment-kind", "integration-test"],
    ["--mode", "qualified", "--profile", "jev-partial-v1"], ["--mode", "development", "--profile", "jev-qualified-v1"],
    ["--lesson-package", "finished", "--judge", "jev"], ["--corpus", "collection", "--side-judge", "gemini-flash"],
  ]) { try { parseCliOptions(argv); assert.fail("Expected rejection"); } catch (error) { assert.equal(error.message.includes(secretLike), false); assert.equal(error instanceof TypeError, true); } }
});

test("parsing preserves supplied path values, is immutable and performs no external lookup", () => {
  const argv = ["--context", "missing context.json", "--set", "missing set.json", "--out", "./-named-output", "--env-file", "absent launch.env"];
  const parsed = parseCliOptions(argv);
  assert.equal(parsed.flags.context, argv[1]); assert.equal(parsed.flags["env-file"], argv[7]);
  assert.equal(Object.isFrozen(parsed), true); assert.equal(Object.isFrozen(parsed.flags), true); assert.equal(Object.isFrozen(parsed.argv), true);
  argv[1] = "changed"; assert.equal(parsed.flags.context, "missing context.json"); assert.equal(parsed.argv[1], "missing context.json");
});

test("help parsing works in a fresh process with an empty environment", () => {
  const moduleUrl = new URL("../src/cli-options.mjs", import.meta.url).href;
  const code = `import { parseCliOptions, CLI_HELP } from ${JSON.stringify(moduleUrl)};
    const result = parseCliOptions(["--help"]);
    if (result.route !== "help") process.exit(1);
    process.stdout.write(CLI_HELP);`;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", code], { env: {}, encoding: "utf8" });
  assert.equal(child.status, 0); assert.equal(child.stderr, ""); assert.equal(child.stdout, CLI_HELP);
});

test("standalone help and malformed commands do not load config, adapters or source fixtures", t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "runner-help-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  for (const directory of ["bin", "src"]) fs.mkdirSync(path.join(temporary, directory));
  fs.copyFileSync(new URL("../bin/evaluate.mjs", import.meta.url), path.join(temporary, "bin/evaluate.mjs"));
  fs.copyFileSync(new URL("../src/cli-options.mjs", import.meta.url), path.join(temporary, "src/cli-options.mjs"));
  const run = argv => spawnSync(process.execPath, [path.join(temporary, "bin/evaluate.mjs"), ...argv],
    { env: {}, cwd: temporary, encoding: "utf8", timeout: 10000 });
  for (const argv of [["--help"], ["-h"]]) {
    const child = run(argv);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, CLI_HELP + "\n");
  }
  for (const argv of [["--corpus"], ["--unknown", "private-value"], ["--course-pin", pin], ["--review", "prepare", "--corpus", "collection"]]) {
    const child = run(argv);
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /TypeError: cli:/);
    assert.doesNotMatch(child.stderr, /ENOENT|ERR_MODULE_NOT_FOUND|private-value/);
  }
  assert.deepEqual(fs.readdirSync(temporary).sort(), ["bin", "src"]);
});

test("default runner rejects redirected output and tracked output before creating reports", t => {
  const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "runner-private-output-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const root = fileURLToPath(new URL("..", import.meta.url)), target = path.join(temporary, "target"), link = path.join(temporary, "redirect");
  fs.mkdirSync(target); fs.symlinkSync(target, link, "dir");
  const run = out => spawnSync(process.execPath, [path.join(root, "bin/evaluate.mjs"), "--out", out],
    { env: {}, cwd: temporary, encoding: "utf8", timeout: 10000 });
  const redirected = run(path.join(link, "report"));
  assert.notEqual(redirected.status, 0);
  assert.match(redirected.stderr, /output symlinks are unsupported/);
  assert.deepEqual(fs.readdirSync(target), []);
  const tracked = path.join(root, "evidence", path.basename(temporary)), refused = run(tracked);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /output must be private/);
  assert.equal(fs.existsSync(tracked), false);
});

test("a normal OS temporary output works with an empty launch environment", t => {
  const tempProbe = spawnSync(process.execPath, ["--input-type=module", "--eval", 'import os from "node:os"; process.stdout.write(os.tmpdir());'],
    { env: {}, encoding: "utf8", timeout: 10000 });
  assert.equal(tempProbe.status, 0, tempProbe.stderr);
  const temporary = fs.mkdtempSync(path.join(tempProbe.stdout, "runner-empty-env-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const root = fileURLToPath(new URL("..", import.meta.url));
  const child = spawnSync(process.execPath, [path.join(root, "bin/evaluate.mjs"), "--out", path.join(temporary, "output")],
    { cwd: temporary, env: {}, encoding: "utf8", timeout: 20000 });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.items, 40);
  assert.equal(result.model_calls, 0);
  assert.equal(result.qualified, false);
  assert.equal(result.identical_checks, true);
});
