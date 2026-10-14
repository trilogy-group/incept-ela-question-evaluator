import fs from "node:fs";
import crypto from "node:crypto";

const EXPECTED_SHA256 = "365c0a5a2a3f460aa6fb8d8f87cf8ed9949b8863ef5df44200ec6477e8d1f8e9";
const raw = fs.readFileSync(new URL("../fixtures/knowledge-baseline.json", import.meta.url));
const digest = crypto.createHash("sha256").update(raw).digest("hex");
if (digest !== EXPECTED_SHA256) throw new Error("shared knowledge baseline changed");
const baseline = JSON.parse(raw);
export const KNOWLEDGE_BASELINE = Object.freeze({
  release: baseline.release, sha256: digest, source_commit: baseline.source_commit,
  records_sha256: baseline.records_sha256, record_count: baseline.record_count,
  academic_qualification: baseline.academic_qualification,
  url: "https://github.com/trilogy-group/incept-ela-learning-truths/tree/knowledge-v1"
});
