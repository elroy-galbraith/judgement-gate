import type { FetchFn, JevAnswers, JevQuestion, Judgement, PrContext } from "./types";

export class JevTimeout extends Error {}

export interface JevConfig {
  apiKey: string;
  url: string;
  model: string;
  timeoutMs: number;
  /** Pause before the single retry; defaults to a short random jitter. Tests set it to 0. */
  retryDelayMs?: number;
}

export const questionKey = (j: Judgement, key: string) => (j.unprefixedKeys ? key : `${j.id}.${key}`);

export function buildRequest(ctx: PrContext, model: string, judgements: Judgement[]) {
  const questions: Record<string, JevQuestion> = {};
  for (const j of judgements) {
    for (const [key, q] of Object.entries(j.questions)) questions[questionKey(j, key)] = q;
  }
  return {
    model,
    state: {
      title: ctx.title,
      description: ctx.body,
      base_branch: ctx.baseBranch,
      changed_files: ctx.files.map((f) => `${f.status} ${f.filename}`),
      diff: ctx.patchExtract,
    },
    questions,
  };
}

/** Rate limits and server errors are worth one more try; anything else (a 400, a 401) would fail the same way again. */
const retryable = (status: number) => status === 429 || status >= 500;

/** Waits `ms`, or rejects early when `signal` aborts so a retry never outlives the overall timeout. */
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

/**
 * One retry, after a short jittered pause, on a 429, a 5xx or a network error. Both attempts and the pause share
 * the single `timeoutMs` budget, so a retry can never push the check past the time the gate already allows.
 */
async function post(cfg: JevConfig, body: string, fetchFn: FetchFn, signal: AbortSignal): Promise<Response> {
  const attempt = () =>
    fetchFn(cfg.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
      body,
      signal,
    });
  let first: Response | undefined;
  try {
    first = await attempt();
    if (!retryable(first.status)) return first;
  } catch (e) {
    if (signal.aborted) throw e;
  }
  await first?.body?.cancel().catch(() => undefined);
  await sleep(cfg.retryDelayMs ?? 100 + Math.random() * 150, signal);
  return attempt();
}

export type JevEvaluation =
  | { status: "ok"; answers: JevAnswers }
  | { status: "degraded"; invalidQuestions: string[] };

export async function evaluate(
  ctx: PrContext,
  judgements: Judgement[],
  cfg: JevConfig,
  fetchFn: FetchFn,
): Promise<Record<string, JevEvaluation>> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), cfg.timeoutMs);
  let res: Response;
  try {
    res = await post(cfg, JSON.stringify(buildRequest(ctx, cfg.model, judgements)), fetchFn, ctl.signal);
  } catch (e) {
    if (ctl.signal.aborted) throw new JevTimeout(`Jev did not respond within ${cfg.timeoutMs}ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`Jev -> ${res.status} ${await res.text()}`);
  const payload: unknown = await res.json();
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Jev response is not an object");
  const raw = (payload as { answers?: unknown }).answers ?? {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("Jev answers is not an object");
  const answers = raw as Record<string, JevAnswers[string]>;

  const out: Record<string, JevEvaluation> = {};
  for (const j of judgements) {
    const valid: JevAnswers = {};
    const invalidQuestions: string[] = [];
    for (const [key, q] of Object.entries(j.questions)) {
      const a = answers[questionKey(j, key)];
      const offered = q.type === "choice" ? offeredChoice(q, a?.choice) : undefined;
      const ok =
        q.type === "noul"
          ? typeof a?.noul === "number" && a.noul >= 0 && a.noul <= 1
          : offered !== undefined && (a.confidence === undefined || typeof a.confidence === "number");
      if (!ok) {
        if (j.optionalAnswers) continue;
        invalidQuestions.push(questionKey(j, key));
        continue;
      }
      // A choice is handed on as the offered key it names, so a stray case or space cannot slip past a strict compare.
      valid[key] = offered === undefined ? a : { ...a, choice: offered };
    }
    out[j.id] = invalidQuestions.length > 0 ? { status: "degraded", invalidQuestions } : { status: "ok", answers: valid };
  }
  return out;
}

/** The offered key a `choice` answer names, ignoring case and surrounding space, or undefined if it names none. */
function offeredChoice(q: JevQuestion, choice: unknown): string | undefined {
  if (typeof choice !== "string") return undefined;
  const wanted = choice.trim().toLowerCase();
  return Object.keys(q.criteria).find((k) => k.toLowerCase() === wanted);
}
