import { appJwt } from "./crypto";
import type { ChangedFile, Env, FetchFn, PrContext, PullRequestEvent } from "./types";

export const CHECK_NAME = "judgement-gate";
export const COMMENT_MARKER = "<!-- judgement-gate -->";
const PATCH_BUDGET = 50 * 1024;

// Highest priority first: migrations, config, manifests, core models.
const PRIORITY: RegExp[] = [
  /(^|\/)(migrations?|db\/migrate|alembic|prisma)\//i,
  /\.sql$/i,
  /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|go\.mod|Cargo\.toml|requirements.*\.txt|pyproject\.toml|Gemfile)$/i,
  /\.(tf|tfvars|ya?ml|toml)$|(^|\/)(Dockerfile|wrangler\.toml|\.github\/)/i,
  /(^|\/)(models?|schema|entities|domain|auth)\b/i,
];

function rank(name: string): number {
  const i = PRIORITY.findIndex((re) => re.test(name));
  return i === -1 ? PRIORITY.length : i;
}

export function buildPatchExtract(files: ChangedFile[], budget = PATCH_BUDGET): string {
  let out = "";
  for (const f of [...files].sort((a, b) => rank(a.filename) - rank(b.filename))) {
    if (!f.patch) continue;
    const chunk = `--- ${f.filename} (${f.status})\n${f.patch}\n`;
    if (out.length + chunk.length > budget) {
      out += chunk.slice(0, Math.max(0, budget - out.length));
      break;
    }
    out += chunk;
  }
  return out;
}

export class GitHubClient {
  private base: string;
  constructor(
    private token: string,
    private fetchFn: FetchFn,
    base = "https://api.github.com",
  ) {
    this.base = base.replace(/\/$/, "");
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchFn(`${this.base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "judgement-gate",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`GitHub ${method} ${path} -> ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  /** Raw file text from the repo's default branch (no `ref`), or null when it does not exist. */
  async getFileContents(owner: string, repo: string, path: string): Promise<string | null> {
    const res = await this.fetchFn(`${this.base}/repos/${owner}/${repo}/contents/${path}`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github.raw+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "judgement-gate",
      },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub GET ${path} -> ${res.status} ${await res.text()}`);
    return res.text();
  }

  /**
   * Put the gate's check on `headSha` in progress: reopen the run this app already made for that
   * commit, or create one. Edits and redeliveries on one commit then share a single check (issue #3).
   */
  async startCheckRun(owner: string, repo: string, headSha: string, appId: string): Promise<{ id: number }> {
    const output = { title: "Evaluating change", summary: "Classifying blast radius..." };
    const existing = await this.findCheckRun(owner, repo, headSha, appId);
    if (existing) {
      await this.req("PATCH", `/repos/${owner}/${repo}/check-runs/${existing.id}`, { status: "in_progress", output });
      return existing;
    }
    return this.req<{ id: number }>("POST", `/repos/${owner}/${repo}/check-runs`, {
      name: CHECK_NAME,
      head_sha: headSha,
      status: "in_progress",
      output,
    });
  }

  /**
   * The newest gate check run on this commit that belongs to this app, or null. A failed lookup also
   * yields null: a duplicate check is better than no check, because the check can be required.
   */
  private async findCheckRun(owner: string, repo: string, headSha: string, appId: string): Promise<{ id: number } | null> {
    try {
      const { check_runs } = await this.req<{ check_runs: { id: number; app?: { id?: number; client_id?: string } | null }[] }>(
        "GET",
        `/repos/${owner}/${repo}/commits/${headSha}/check-runs?check_name=${encodeURIComponent(CHECK_NAME)}&filter=latest`,
      );
      // The app id in config may be the numeric id or the client id; GitHub reports both on the run.
      const ours = check_runs.filter((r) => String(r.app?.id) === appId || r.app?.client_id === appId);
      return ours.sort((a, b) => b.id - a.id)[0] ?? null;
    } catch {
      return null;
    }
  }

  /** Create a check run that is already completed, so it is never visible as in progress. */
  reportCheckRun(owner: string, repo: string, headSha: string, conclusion: "success" | "failure" | "neutral", title: string, summary: string) {
    return this.req("POST", `/repos/${owner}/${repo}/check-runs`, {
      name: CHECK_NAME,
      head_sha: headSha,
      status: "completed",
      conclusion,
      output: { title, summary },
    });
  }

  completeCheckRun(
    owner: string,
    repo: string,
    id: number,
    conclusion: "success" | "failure" | "neutral",
    title: string,
    summary: string,
  ) {
    return this.req("PATCH", `/repos/${owner}/${repo}/check-runs/${id}`, {
      status: "completed",
      conclusion,
      output: { title, summary },
    });
  }

  async listFiles(owner: string, repo: string, pr: number): Promise<ChangedFile[]> {
    const all: ChangedFile[] = [];
    for (let page = 1; page <= 10; page++) {
      const batch = await this.req<ChangedFile[]>("GET", `/repos/${owner}/${repo}/pulls/${pr}/files?per_page=100&page=${page}`);
      all.push(...batch);
      if (batch.length < 100) break;
    }
    return all;
  }

  /** Add labels to a PR. GitHub treats an already-present label as a no-op. The gate never removes labels. */
  async addLabels(owner: string, repo: string, pr: number, labels: string[]): Promise<void> {
    await this.req("POST", `/repos/${owner}/${repo}/issues/${pr}/labels`, { labels });
  }

  /** Upsert the single bot comment, found by its hidden marker. Passing notes only update an existing comment. */
  async upsertComment(
    owner: string,
    repo: string,
    pr: number,
    body: string,
    { createIfMissing = true } = {},
  ): Promise<"created" | "updated" | "skipped"> {
    const comments = await this.req<{ id: number; body: string }[]>("GET", `/repos/${owner}/${repo}/issues/${pr}/comments?per_page=100`);
    const existing = comments.find((c) => c.body.includes(COMMENT_MARKER));
    if (existing) {
      if (existing.body !== body) await this.req("PATCH", `/repos/${owner}/${repo}/issues/comments/${existing.id}`, { body });
      return "updated";
    }
    if (!createIfMissing) return "skipped";
    await this.req("POST", `/repos/${owner}/${repo}/issues/${pr}/comments`, { body });
    return "created";
  }
}

const TOKEN_SAFETY_MARGIN_MS = 5 * 60 * 1000;
const DEFAULT_TOKEN_TTL_MS = 60 * 60 * 1000;

interface CachedInstallationToken {
  token: string;
  expiresAt: number;
}

const installationTokenCache = new Map<number, CachedInstallationToken>();

export function clearInstallationTokenCache(): void {
  installationTokenCache.clear();
}

export async function installationToken(env: Env, installationId: number, fetchFn: FetchFn, now = Date.now()): Promise<string> {
  const cached = installationTokenCache.get(installationId);
  if (cached && cached.expiresAt - TOKEN_SAFETY_MARGIN_MS > now) {
    return cached.token;
  }
  const jwt = await appJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
  const base = (env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");
  const res = await fetchFn(`${base}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json", "User-Agent": "judgement-gate" },
  });
  if (!res.ok) throw new Error(`installation token -> ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { token: string; expires_at?: string };
  const parsedExpiry = data.expires_at ? Date.parse(data.expires_at) : NaN;
  const expiresAt = Number.isFinite(parsedExpiry) ? parsedExpiry : now + DEFAULT_TOKEN_TTL_MS;
  if (expiresAt - TOKEN_SAFETY_MARGIN_MS > now) {
    installationTokenCache.set(installationId, { token: data.token, expiresAt });
  } else {
    installationTokenCache.delete(installationId);
  }
  return data.token;
}

export function assembleContext(ev: PullRequestEvent, files: ChangedFile[]): PrContext {
  const pr = ev.pull_request;
  return {
    title: pr.title,
    body: pr.body ?? "",
    baseBranch: pr.base.ref,
    headSha: pr.head.sha,
    files,
    patchExtract: buildPatchExtract(files),
  };
}
