#!/usr/bin/env node
import { collectFeedback, persistFeedback, validateFeedbackOutput } from "../src/feedback-api.mjs";

const help = "Usage: node scripts/read-feedback.mjs --out .local/feedback/NEW [--checklist true]\nRequires FEEDBACK_KEY in the launch environment.\nRead-only, caller-visible feedback snapshot. No models or inferred academic labels.\n";
try {
  const args = process.argv.slice(2);
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) process.stdout.write(help);
  else {
    const flags = {};
    for (let i = 0; i < args.length; i += 2) {
      if (!["--out", "--checklist"].includes(args[i]) || Object.hasOwn(flags, args[i]) || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error();
      flags[args[i]] = args[i + 1];
    }
    if (!flags["--out"] || (flags["--checklist"] !== undefined && flags["--checklist"] !== "true")) throw new Error();
    validateFeedbackOutput(flags["--out"]);
    const capture = await collectFeedback({ key: process.env.FEEDBACK_KEY, includeChecklist: flags["--checklist"] === "true" });
    const result = persistFeedback(capture, flags["--out"]);
    process.stdout.write(`${JSON.stringify(result)}\n`); process.exitCode = result.required_complete ? 0 : 2;
  }
} catch {
  process.stderr.write("feedback: reader failed; check arguments, launch credential and private output path\n"); process.exitCode = 1;
}
