// Pure argument validation. No files, environment values, credentials or adapters are read here.
export const CLI_HELP = `Usage: node bin/evaluate.mjs [options]

Offline reference:  [--context FILE] [--set FILE] [--out DIR]
Text lesson:       --lesson-package DIR [--course-pin SHA256]
Native activities: --native-package DIR [--native-source-pin SHA256]
Collected examples: --corpus DIR [--catalog-sha256 SHA256]
Golden reference:  --golden-reference DIR [--reference-tier primary|secondary]
Golden check:      --golden-check DIR [--golden-pin SHA256]
Review forms:      --review prepare [--review-model ID --reported-model ID]
Reconcile reviews: --review reconcile --bundle FILE --review-a FILE --review-b FILE
Score review:      --review score --bundle FILE --labels FILE --draws FILE,FILE

Reference/text/native/corpus options: --config FILE --out DIR --mode qualified|development
                    --judge none|jev --side-judge none|gemini-flash
                    --env-file FILE
Default reference evaluation also accepts --profile jev-qualified-v1|jev-partial-v1|jev-full-experimental,
--strict-samples true|false, --qualification FILE and --trusted-reviewers FILE.
Text/native/corpus model trials require --mode development. Native offline intake and golden preparation make no model calls.
Golden assessment import: --assessment FILE --assessment-kind KIND [--assessment-relation RELATION]
Use one primary route. Route-specific options and pins cannot be silently ignored.
--help or -h shows this text without reading files or running an evaluation.
Internal worker options are reserved for frozen fresh-process replay.
`;

const sets = {
  evaluate: ["config", "context", "set", "out", "judge", "side-judge", "env-file", "mode", "profile", "strict-samples", "qualification", "trusted-reviewers"],
  "evaluate-worker": ["config", "out", "judge", "side-judge", "mode", "profile", "strict-samples", "worker-draw", "frozen-packet", "expected-packet", "expected-runtime", "expected-profile", "frozen-qualification", "expected-qualification", "frozen-trust", "expected-trust"],
  lesson: ["lesson-package", "course-pin", "config", "out", "judge", "side-judge", "mode", "env-file"],
  "lesson-worker": ["lesson-worker", "lesson-packet", "expected-packet", "expected-runtime", "expected-protocol", "config", "out", "judge", "side-judge", "mode"],
  corpus: ["corpus", "catalog-sha256", "config", "out", "judge", "side-judge", "mode", "env-file"],
  "corpus-worker": ["corpus-worker", "corpus-packet", "expected-corpus-packet", "expected-runtime", "expected-protocol", "config", "out", "judge", "side-judge", "mode"],
  native: ["native-package", "native-source-pin", "out", "config", "judge", "side-judge", "mode", "env-file"],
  "golden-reference": ["golden-reference", "reference-tier", "out"],
  "golden-check": ["golden-check", "golden-pin", "assessment", "assessment-kind", "assessment-relation"],
  "review-prepare": ["review", "config", "out", "review-model", "reported-model"],
  "review-reconcile": ["review", "config", "out", "bundle", "review-a", "review-b", "adjudication"],
  "review-score": ["review", "config", "out", "bundle", "labels", "draws"],
};
const selectors = { "native-package": "native", "golden-reference": "golden-reference", "golden-check": "golden-check",
  "lesson-package": "lesson", "corpus": "corpus", "review": "review", "worker-draw": "evaluate-worker", "lesson-worker": "lesson-worker", "corpus-worker": "corpus-worker" };
const known = new Set(Object.values(sets).flat());
const pins = new Set(["course-pin", "native-source-pin", "catalog-sha256", "golden-pin", "expected-packet", "expected-runtime", "expected-profile", "expected-qualification", "expected-trust", "expected-protocol", "expected-corpus-packet"]);
const enums = {
  judge: ["none", "jev"], "side-judge": ["none", "gemini-flash"], mode: ["qualified", "development"],
  profile: ["jev-qualified-v1", "jev-partial-v1", "jev-full-experimental"], "strict-samples": ["true", "false"],
  "reference-tier": ["primary", "secondary"], review: ["prepare", "reconcile", "score"],
  "assessment-kind": ["integration-test", "source-review", "model-development", "human-review", "generator-context-coverage", "manual-notes"],
  "assessment-relation": ["same-reference", "related-diagnostic", "historical", "generated-candidate"],
};
const required = {
  "evaluate-worker": ["frozen-packet", "expected-packet", "expected-runtime", "expected-profile", "frozen-qualification", "expected-qualification", "frozen-trust", "expected-trust", "out"],
  "lesson-worker": ["lesson-packet", "expected-packet", "expected-runtime", "expected-protocol", "out"],
  "corpus-worker": ["corpus-packet", "expected-corpus-packet", "expected-runtime", "expected-protocol", "out"],
  "review-reconcile": ["bundle", "review-a", "review-b"], "review-score": ["bundle", "labels", "draws"],
};
const fail = message => { throw new TypeError(`cli: ${message}`); };
const modelId = value => /^[A-Za-z][A-Za-z0-9._:/-]{0,127}$/.test(value) && !/^(?:apk_|apikey_|sk-|AIza)/.test(value);

export function parseCliOptions(argv = []) {
  if (!Array.isArray(argv) || !argv.every(value => typeof value === "string")) fail("arguments must be strings");
  if (argv.includes("--help") || argv.includes("-h")) {
    if (argv.length !== 1) fail("help must be used alone");
    return Object.freeze({ route: "help", operation: null, internal: false, help: true, flags: Object.freeze({}), argv: Object.freeze(["--help"]) });
  }
  const flags = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    if (!name.startsWith("--") || !known.has(name.slice(2))) fail("unsupported argument");
    const key = name.slice(2);
    if (Object.hasOwn(flags, key)) fail(`duplicate --${key}`);
    const value = argv[index + 1];
    if (typeof value !== "string" || !value.trim() || value.startsWith("--") || value === "-h") fail(`missing value for --${key}`);
    flags[key] = value;
  }
  const selected = Object.keys(selectors).filter(key => Object.hasOwn(flags, key));
  if (selected.length > 1) fail("conflicting primary routes");
  const route = selected.length ? selectors[selected[0]] : "evaluate";
  for (const [key, values] of Object.entries(enums)) if (Object.hasOwn(flags, key) && !values.includes(flags[key])) fail(`unsupported value for --${key}`);
  const operation = route === "review" ? flags.review : null, scope = route === "review" ? `review-${operation}` : route;
  const allowed = new Set(sets[scope]);
  for (const key of Object.keys(flags)) if (!allowed.has(key)) fail(`--${key} is unsupported for this route`);
  for (const key of required[scope] ?? []) if (!Object.hasOwn(flags, key)) fail(`this route requires --${key}`);
  for (const key of pins) if (Object.hasOwn(flags, key) && !/^[a-f0-9]{64}$/.test(flags[key])) fail(`invalid hash for --${key}`);
  for (const key of ["worker-draw", "lesson-worker", "corpus-worker"]) if (Object.hasOwn(flags, key)
    && (!/^\d+$/.test(flags[key]) || !Number.isSafeInteger(Number(flags[key])) || Number(flags[key]) < 1)) fail(`invalid draw for --${key}`);
  if (route === "evaluate" || route === "evaluate-worker") {
    const mode = flags.mode ?? "qualified", profile = flags.profile ?? (mode === "qualified" ? "jev-qualified-v1" : "jev-partial-v1");
    if ((mode === "qualified") !== (profile === "jev-qualified-v1")) fail("profile does not match evaluation mode");
  }
  if (["lesson", "lesson-worker", "native", "corpus", "corpus-worker"].includes(route)
    && ((flags.judge ?? "none") !== "none" || (flags["side-judge"] ?? "none") !== "none") && (flags.mode ?? "qualified") !== "development")
    fail("this route requires explicit development mode for model trials");
  if (scope === "review-prepare") {
    const requested = flags["review-model"], reported = flags["reported-model"];
    if ((requested !== undefined || reported !== undefined) && (!requested || !reported || !modelId(requested) || !modelId(reported))) fail("review model scope requires both valid identifiers");
  }
  if (scope === "review-score" && flags.draws.split(",").some(file => !file.trim())) fail("draw list contains an empty entry");
  if (route === "golden-check") {
    if (Object.hasOwn(flags, "assessment") && !Object.hasOwn(flags, "assessment-kind")) fail("assessment import requires --assessment-kind");
    if (!Object.hasOwn(flags, "assessment") && (Object.hasOwn(flags, "assessment-kind") || Object.hasOwn(flags, "assessment-relation"))) fail("assessment metadata requires --assessment");
  }
  return Object.freeze({ route, operation, internal: route.endsWith("-worker"), help: false, flags: Object.freeze(flags), argv: Object.freeze([...argv]) });
}
