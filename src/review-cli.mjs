import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { preparePilot, reconcileReviews, scorePilot, pilotHash } from "./review-pilot.mjs";
import { KNOWLEDGE_BASELINE } from "./knowledge-baseline.mjs";
import { sha } from "./replay.mjs";

const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const arg = (argv, name, fallback) => { const i = argv.indexOf(`--${name}`); return i < 0 ? fallback : argv[i + 1]; };
const modelId = (value) => typeof value === "string" && /^[A-Za-z][A-Za-z0-9._:/-]{0,127}$/.test(value) && !/^(?:apk_|apikey_|sk-|AIza)/.test(value);
function privateOutput(root, supplied) {
  const target = path.resolve(root, supplied), relative = path.relative(root, target);
  if (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)
    && relative.split(path.sep)[0] !== ".local") throw new Error("review output inside this checkout must be under .local");
  let cursor = path.parse(target).root;
  for (const part of target.slice(cursor.length).split(path.sep)) {
    cursor = path.join(cursor, part);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error("review output must not use symlinks");
  }
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.mkdirSync(target, { mode: 0o700 });
  return target;
}

export async function runReviewCli({ root, configFile, config, argv = process.argv }) {
  const operation = arg(argv, "review");
  if (!["prepare", "reconcile", "score"].includes(operation)) throw new Error("review requires prepare, reconcile or score");
  const output = privateOutput(root, arg(argv, "out", path.join(".local/reviews", `pilot-${operation}-${crypto.randomUUID()}`)));
  const write = (name, value) => fs.writeFileSync(path.join(output, name), JSON.stringify(value, null, 1) + "\n", { mode: 0o600, flag: "wx" });
  const input = (name) => { const file = arg(argv, name); if (!file) throw new Error(`review requires --${name}`); return read(path.resolve(root, file)); };
  let result;
  try {
    if (operation === "prepare") {
      const manifestBytes = fs.readFileSync(path.join(root, "fixtures/reference/manifest.json"));
      const manifest = JSON.parse(manifestBytes);
      const requested = arg(argv, "review-model"), reported = arg(argv, "reported-model");
      if ((requested || reported) && (!modelId(requested) || !modelId(reported))) throw new Error("review model scope requires both model identifiers");
      const prepared = preparePilot(read(path.resolve(root, config.context)), read(path.resolve(root, config.question_set)), {
        baseline: { id: KNOWLEDGE_BASELINE.release, sha256: KNOWLEDGE_BASELINE.sha256 },
        source: { id: `authored-reference-${manifest.authored_source_commit.slice(0, 7)}`, sha256: sha(manifestBytes) },
        observations: read(path.join(root, "cases/reference-review.json")).cases,
        configFile, samples: config.samples, model: requested ? { provider: "jev", requested, reported } : null
      });
      write("bundle.json", prepared.bundle); write("review-a.json", prepared.sheets[0]); write("review-b.json", prepared.sheets[1]);
      write("provenance.json", prepared.provenance);
      result = { operation, status: "awaiting-human-review", ...prepared.bundle.counts, resolved_labels: 0,
        bundle_sha256: prepared.bundle.sha256, knowledge_baseline: KNOWLEDGE_BASELINE.release };
    } else if (operation === "reconcile") {
      const adjudication = arg(argv, "adjudication");
      const labels = reconcileReviews(input("bundle"), [input("review-a"), input("review-b")], adjudication ? read(path.resolve(root, adjudication)) : null);
      write("labels.json", labels);
      result = { operation, status: labels.counts.pending ? "labels-pending" : "pilot-labels-reconciled", ...labels.counts, labels_sha256: labels.labels_sha256 };
    } else {
      const bundle = input("bundle"), labels = input("labels"), files = arg(argv, "draws");
      if (!files) throw new Error("review score requires --draws with comma-separated report files");
      const draws = files.split(",").map((file) => {
        const report = read(path.resolve(root, file));
        return { report, report_sha256: pilotHash(report), labels_sha256: labels.labels_sha256 };
      });
      const scored = scorePilot(bundle, labels, draws); write("score.json", scored);
      result = { operation, status: "pilot-scored", ...scored.counts,
        accuracy: scored.counts.resolved_labels ? "pilot comparison only; independent academic qualification absent" : "unmeasured; human labels pending",
        score_sha256: scored.sha256 };
    }
    result = { ...result, qualification: "unqualified", independent_gold: false, held_out: false, model_calls: 0, out: path.relative(root, output) };
    write("run.json", result);
    return result;
  } catch {
    write("failure.json", { operation, status: "failed", reason: "invalid or changed private review inputs; details suppressed", model_calls: 0 });
    throw new Error("review failed; inspect private inputs and required arguments; details suppressed");
  }
}
