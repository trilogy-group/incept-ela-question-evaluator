// One retry wrapper for every outbound call, rather than ad-hoc retries per provider.
// Found by the harvested code bank: we had none, and ignored a server-supplied Retry-After.
// Rules: retry only what is worth retrying (429 and 5xx, and transport errors), honour Retry-After when the server
// sends one, cap the attempts, and never retry a call the caller has already abandoned.
export const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

export class HttpError extends Error {
  constructor(status, body, retryAfterMs) { super(`http ${status}`); this.name = "HttpError"; this.status = status; this.body = body; this.retryAfterMs = retryAfterMs ?? null; }
}

export function retryAfterMs(headers) {
  const raw = headers?.get?.("retry-after");
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(raw);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : null;
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(new Error("aborted"));
  const t = setTimeout(resolve, ms);
  signal?.addEventListener?.("abort", () => { clearTimeout(t); reject(new Error("aborted")); }, { once: true });
});

/** Run `attempt(n)` with bounded retries. Background work passes `background: true` and never retries. */
export async function withRetry(attempt, { attempts = 3, baseMs = 400, maxDelayMs = 8000, background = false, signal = null, onRetry = null, sleepImpl = sleep } = {}) {
  const budget = background ? 1 : Math.max(1, attempts);
  let last;
  for (let n = 0; n < budget; n++) {
    try { return await attempt(n); }
    catch (e) {
      last = e;
      if (signal?.aborted) throw e;
      const status = e instanceof HttpError ? e.status : null;
      const worthRetrying = status === null ? /network|socket|ECONN|timeout|fetch failed/i.test(String(e?.message)) : RETRYABLE_STATUS.has(status);
      if (!worthRetrying || n === budget - 1) throw e;
      const server = e instanceof HttpError ? e.retryAfterMs : null;
      const delay = Math.min(maxDelayMs, server ?? baseMs * 2 ** n);
      if (onRetry) onRetry({ attempt: n + 1, of: budget, delay, status, serverAsked: server != null });
      await sleepImpl(delay, signal);
    }
  }
  throw last;
}
