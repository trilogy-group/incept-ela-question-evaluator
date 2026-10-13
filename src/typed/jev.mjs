// TypeSafe Jev (System One) HTTP provider. Wire format per api.typesafe.ai/v1/systemone:
// POST {model, state, questions: {id: {type, instructions, criteria}}} -> {model, answers: {id: {...}}, usage}.
// Server-side credential only. Never logged.
import { rotateCriteria } from "./questions.mjs";
import { withRetry, HttpError, retryAfterMs } from "./retry.mjs";

export function createJevProvider({ apiKey, model = "jev-1.13.0", baseUrl = "https://api.typesafe.ai/v1/systemone", fetchImpl = globalThis.fetch, timeoutMs = 20000, attempts = 3, background = false, onRetry = null } = {}) {
  if (!apiKey) throw new Error("jev provider: TYPESAFE_API_KEY missing (export it at launch; never write it into the tree)");
  return {
    name: "jev",
    model,
    async ask(state, questions, { sample = 0 } = {}) {
      const body = {
        model,
        state,
        questions: Object.fromEntries(
          questions.map((q) => {
            const r = rotateCriteria(q, sample);
            const def = { type: r.type, instructions: r.instructions };
            if (r.criteria !== undefined) def.criteria = r.criteria;
            return [r.id, def];
          }),
        ),
      };
      return withRetry(async () => {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), timeoutMs);
        try {
          const res = await fetchImpl(baseUrl, {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: ctl.signal,
          });
          if (!res.ok) throw new HttpError(res.status, await res.text().catch(() => ""), retryAfterMs(res.headers));
          const json = await res.json();
          if (!json || typeof json.answers !== "object") throw new Error("jev invalid envelope");
          return { answers: json.answers, model: json.model ?? model, served_revision: typeof json.served_revision === "string" ? json.served_revision : null, usage: json.usage ?? null };
        } finally {
          clearTimeout(t);
        }
      }, { attempts, background, onRetry });
    },
  };
}
