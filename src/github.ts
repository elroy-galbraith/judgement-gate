import { appJwt } from "./crypto";
import { isSafePath } from "./safe-paths";
import type { ChangedFile, Env, FetchFn, PrContext, PullRequestEvent } from "./types";

export const CHECK_NAME = "judgement-gate";
export const COMMENT_MARKER = "<!-- judgement-gate -->";
const LIST_FILES_PAGE_SIZE = 100;
const LIST_FILES_PAGES = 10;
/** `listFiles` stops here. A list this long may be cut off, so what it leaves out is unknown. */
export const LIST_FILES_LIMIT = LIST_FILES_PAGE_SIZE * LIST_FILES_PAGES;
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

/** A file's share of the budget below this is too little to show anything useful, so the lowest-priority files are left out instead. */
const MIN_FILE_SHARE = 1024;
const CUT_MARKER = "\n[diff cut here]\n";

export interface DiffExtract {
  text: string;
  /**
   * Part of the diff is missing from `text`: a file was cut short or left out. Docs, images and lockfiles do not count
   * (see `isSafePath`): they cannot make a change hard to undo, and a big lockfile would otherwise flag every bump.
   */
  truncated: boolean;
}

/** The largest cap such that giving every size at most that much stays within `budget`; Infinity if all of them fit. */
function fairShare(sizes: number[], budget: number): number {
  const sorted = [...sizes].sort((a, b) => a - b);
  let left = budget;
  for (let i = 0; i < sorted.length; i++) {
    const n = sorted.length - i;
    if (sorted[i] * n > left) return Math.floor(left / n);
    left -= sorted[i];
  }
  return Infinity;
}

function cutShort(chunk: string, cap: number): string {
  const head = chunk.slice(0, Math.max(0, cap - CUT_MARKER.length));
  const newline = head.lastIndexOf("\n");
  return (newline >= 0 ? head.slice(0, newline + 1) : `${head}\n`) + CUT_MARKER.slice(1);
}

interface Fitted {
  parts: string[];
  used: number;
  cut: number;
  omitted: number;
}

/**
 * Fit `chunks` (highest priority first) into `budget`. Whole if they fit. Otherwise every file gets an equal share
 * (small files keep all of theirs, and what they leave goes to the big ones), and if the share would be under
 * MIN_FILE_SHARE the lowest-priority files are left out. `keepOne` shows the first file even then.
 */
function fit(chunks: string[], budget: number, keepOne: boolean): Fitted {
  const used = (parts: string[]) => parts.reduce((n, c) => n + c.length, 0);
  if (used(chunks) <= budget) return { parts: chunks, used: used(chunks), cut: 0, omitted: 0 };
  const sizes = chunks.map((c) => c.length);
  // The share only shrinks as files are added, so bisect for the most files that each still get a useful share.
  let lo = keepOne ? 1 : 0;
  let hi = chunks.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fairShare(sizes.slice(0, mid), budget) >= MIN_FILE_SHARE) lo = mid;
    else hi = mid - 1;
  }
  const cap = fairShare(sizes.slice(0, lo), budget);
  let cut = 0;
  const parts = chunks.slice(0, lo).map((c) => {
    if (c.length <= cap) return c;
    cut++;
    return cutShort(c, cap);
  });
  return { parts, used: used(parts), cut, omitted: chunks.length - lo };
}

/** Docs, images and lockfiles. A rename counts only if both names are, as in `appliesToFiles`. */
const isSafeFile = (f: ChangedFile) => isSafePath(f.filename) && (f.previous_filename === undefined || isSafePath(f.previous_filename));

/**
 * The diff the model reads. Files go in priority order (migrations first), with docs, images and lockfiles last: they
 * get only what the rest leaves over, and being cut never makes the diff `truncated`. When everything fits it is sent
 * whole. Otherwise see `fit`. A file cut short is marked, and so is the diff, because the model must not take what it
 * did not see for safe. `budget` limits the diff itself; the notice is extra.
 */
export function buildDiffExtract(files: ChangedFile[], budget = PATCH_BUDGET): DiffExtract {
  const withPatch = [...files].sort((a, b) => rank(a.filename) - rank(b.filename)).filter((f) => f.patch);
  const chunk = (f: ChangedFile) => `--- ${f.filename} (${f.status})\n${f.patch}\n`;
  const main = fit(withPatch.filter((f) => !isSafeFile(f)).map(chunk), budget, true);
  const rest = fit(withPatch.filter(isSafeFile).map(chunk), Math.max(0, budget - main.used), false);
  const truncated = main.cut + main.omitted > 0;
  const restMissing = rest.cut + rest.omitted;
  let notice = "";
  if (truncated) {
    notice = `[Diff truncated: ${main.cut + rest.cut} file(s) cut short, ${main.omitted + rest.omitted} file(s) not shown. Part of this change was not available to read. Do not assume the missing part is safe.]\n`;
  } else if (restMissing > 0) {
    notice = `[Diff truncated: ${restMissing} doc, image or lockfile diff(s) were cut short or left out. Every other file is shown in full.]\n`;
  }
  return { text: [...main.parts, ...rest.parts].join("") + notice, truncated };
}

/** Only the text of the extract; see buildDiffExtract. */
export function buildPatchExtract(files: ChangedFile[], budget = PATCH_BUDGET): string {
  return buildDiffExtract(files, budget).text;
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
    for (let page = 1; page <= LIST_FILES_PAGES; page++) {
      const batch = await this.req<ChangedFile[]>("GET", `/repos/${owner}/${repo}/pulls/${pr}/files?per_page=${LIST_FILES_PAGE_SIZE}&page=${page}`);
      all.push(...batch);
      if (batch.length < LIST_FILES_PAGE_SIZE) break;
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
  const extract = buildDiffExtract(files);
  return {
    title: pr.title,
    body: pr.body ?? "",
    baseBranch: pr.base.ref,
    headSha: pr.head.sha,
    files,
    patchExtract: extract.text,
    diffTruncated: extract.truncated,
  };
}
