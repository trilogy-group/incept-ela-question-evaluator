import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { prepareGolden, checkGolden, attachAssessment } from "./golden.mjs";

export function runGoldenCli({ root, argv = process.argv.slice(2) }) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i], value = argv[i + 1];
    if (!["--golden-reference", "--golden-check", "--golden-pin", "--reference-tier", "--assessment", "--assessment-kind", "--assessment-relation", "--out"].includes(name)
      || Object.hasOwn(flags, name) || typeof value !== "string" || value.startsWith("--")) throw new Error("golden: unsupported or incomplete argument");
    flags[name] = value;
  }
  if (Boolean(flags["--golden-reference"]) === Boolean(flags["--golden-check"])) throw new Error("golden: choose preparation or bundle check");
  if (flags["--golden-reference"] && (flags["--assessment"] || flags["--assessment-kind"] || flags["--assessment-relation"] || flags["--golden-pin"]))
    throw new Error("golden: attach assessments after preparation");
  if (flags["--golden-check"] && (flags["--out"] || flags["--reference-tier"])) throw new Error("golden: bundle checks do not use --out or --reference-tier");
  let result;
  if (flags["--golden-reference"]) {
    const out = path.resolve(root, flags["--out"] ?? path.join(".local/golden", crypto.randomUUID()));
    if (!out.startsWith(path.join(root, ".local") + path.sep)) throw new Error("golden: preparation output must be private within this checkout");
    let cursor = root;
    for (const part of path.relative(root, out).split(path.sep)) {
      cursor = path.join(cursor, part);
      if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error("golden: output symlinks are unsupported");
    }
    result = prepareGolden(path.resolve(flags["--golden-reference"]), out, { tier: flags["--reference-tier"] ?? "primary" });
  } else {
    result = checkGolden(path.resolve(flags["--golden-check"]), flags["--golden-pin"]);
    if (flags["--assessment"]) {
      const attached = attachAssessment(result.root, path.resolve(flags["--assessment"]),
        { kind: flags["--assessment-kind"], relation: flags["--assessment-relation"] ?? "related-diagnostic" });
      result = { ...checkGolden(result.root, flags["--golden-pin"]), attached };
    }
    else if (flags["--assessment-kind"] || flags["--assessment-relation"]) throw new Error("golden: assessment metadata needs an artifact");
  }
  return result;
}
