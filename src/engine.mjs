// Frozen typed decision layer, versioned locally. Offline execution has no external checkout or credential need.
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { safeFailureCode } from "./typed/client.mjs";
export { decide } from "./typed/client.mjs";
export { noul, choice, GATES } from "./typed/questions.mjs";
export { createFakeProvider } from "./typed/fake.mjs";
export const ENGINE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ENGINE_SNAPSHOT = JSON.parse(fs.readFileSync(path.join(ENGINE_DIR, "typed/manifest.json"), "utf8"));

// A credential is consumed only by an explicitly requested live adapter. It is never logged or persisted.
export async function judgeFromEnv(env = process.env) {
  if (!env.TYPESAFE_API_KEY) throw new Error("explicit Jev execution requires a launch credential");
  const { createJevProvider } = await import("./typed/jev.mjs");
  const provider = createJevProvider({ apiKey: env.TYPESAFE_API_KEY, model: env.TYPESAFE_MODEL || "jev-latest" });
  return { ...provider, async ask(...args) {
    try { return await provider.ask(...args); }
    catch (error) {
      const sanitized = new Error("Jev request unavailable; provider details suppressed");
      sanitized.code = safeFailureCode(error);
      throw sanitized;
    }
  } };
}
