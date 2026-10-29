import type { FetchFn, JevAnswers, JevQuestion, Judgement, PrContext } from "./types";

export class JevTimeout extends Error {}

export interface JevConfig {
  apiKey: string;
  url: string;
  model: string;
  timeoutMs: number;
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
    res = await fetchFn(cfg.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(buildRequest(ctx, cfg.model, judgements)),
      signal: ctl.signal,
    });
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
      const ok =
        q.type === "noul"
          ? typeof a?.noul === "number" && a.noul >= 0 && a.noul <= 1
          : typeof a?.choice === "string" && a.choice !== "" && (a.confidence === undefined || typeof a.confidence === "number");
      if (!ok) {
        if (j.optionalAnswers) continue;
        invalidQuestions.push(questionKey(j, key));
        continue;
      }
      valid[key] = a;
    }
    out[j.id] = invalidQuestions.length > 0 ? { status: "degraded", invalidQuestions } : { status: "ok", answers: valid };
  }
  return out;
}
