import { parseFalsePositive, record } from "./analytics";
import { aggregate, type JudgementResult } from "./aggregate";
import { loadGateConfig } from "./config";
import { renderComment, renderRoutingComment } from "./comment";
import { verifySignature } from "./crypto";
import { assembleContext, GitHubClient, installationToken } from "./github";
import { evaluate } from "./jev";
import { appliesToFiles } from "./glob";
import { DEFAULT_LABEL, evaluateRouting, type RoutingResult, type RoutingSetup } from "./routing";
import type { ChangedFile, Env, Judgement, FetchFn, IssueCommentEvent, PullRequestEvent, Verdict } from "./types";

const ACTIONS = new Set(["opened", "synchronize", "reopened", "edited", "ready_for_review"]);

export interface Deps {
  fetchFn: FetchFn;
  waitUntil: (p: Promise<unknown>) => void;
}

export async function handleWebhook(req: Request, env: Env, deps: Deps): Promise<Response> {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const body = await req.text();
  if (!(await verifySignature(env.GITHUB_WEBHOOK_SECRET, body, req.headers.get("X-Hub-Signature-256")))) {
    return new Response("invalid signature", { status: 401 });
  }
  const event = req.headers.get("X-GitHub-Event");
  if (event === "ping") return new Response("pong");
  if (event === "issue_comment") return handleIssueComment(JSON.parse(body) as IssueCommentEvent, env);
  if (event !== "pull_request") return new Response("ignored", { status: 202 });

  const ev = JSON.parse(body) as PullRequestEvent;
  if (!ACTIONS.has(ev.action) || !ev.installation) return new Response("ignored", { status: 202 });
  if (ev.pull_request.draft) return new Response("draft ignored", { status: 202 });
  // `edited` only matters when the title or body changed (not a base-branch retarget).
  if (ev.action === "edited" && !ev.changes?.title && !ev.changes?.body) return new Response("ignored", { status: 202 });

  // Ack immediately; do the work after the response so GitHub's 10s webhook timeout never bites.
  deps.waitUntil(processPullRequest(ev, env, deps.fetchFn).catch((e) => console.error("judgement-gate failed", e)));
  return new Response("accepted", { status: 202 });
}

/** A human replying `/judgement-gate false-positive <id>` on a PR is logged as feedback. No GitHub calls are made. */
function handleIssueComment(ev: IssueCommentEvent, env: Env): Response {
  if (ev.action !== "created" || !ev.issue.pull_request || ev.comment.user.type === "Bot") return new Response("ignored", { status: 202 });
  const id = parseFalsePositive(ev.comment.body);
  if (!id) return new Response("ignored", { status: 202 });
  record(env.ANALYTICS, {
    event: "feedback",
    repo: `${ev.repository.owner.login}/${ev.repository.name}`,
    pr: ev.issue.number,
    judgement: id,
    mode: env.MODE ?? "shadow",
    outcome: "false_positive",
    association: ev.comment.author_association ?? "",
  });
  return new Response("recorded", { status: 202 });
}

const asNote = (text: string) => (text ? `\n\n${text}` : "");

interface RoutingTarget {
  gh: GitHubClient;
  env: Env;
  owner: string;
  repo: string;
  pr: number;
  routingMode: string;
}

/**
 * Evaluate routing, record it, add the label for `human` in enforce routing mode, and return the check-summary text
 * with the result (absent if evaluation failed). `results === null` means the audit was degraded.
 * Never throws: routing must not change the check, so every failure becomes a line of text.
 */
async function publishRouting(
  setup: RoutingSetup,
  results: JudgementResult[] | null,
  files: ChangedFile[],
  t: RoutingTarget,
): Promise<{ text: string; routing?: RoutingResult }> {
  let routing: RoutingResult | undefined;
  try {
    routing = evaluateRouting(setup, results, files);
    const reasons = routing.reasons.join("; ");
    record(t.env.ANALYTICS, {
      event: "routing",
      repo: `${t.owner}/${t.repo}`,
      pr: t.pr,
      judgement: "",
      mode: t.routingMode,
      outcome: routing.route,
      reason: reasons.slice(0, 256),
    });
    if (routing.route === "agent") return { text: "Review routing: agent", routing };
    if (routing.route === "unavailable") return { text: `Review routing: unavailable (${routing.reasons[0] ?? "unknown"})`, routing };
    const shown = results === null ? `${reasons}; judgement rules skipped (audit degraded)` : reasons;
    if (t.routingMode === "shadow") return { text: `[Shadow] Review routing: would have routed to a human (${shown})`, routing };
    const line = `Review routing: human (${shown})`;
    try {
      await t.gh.addLabels(t.owner, t.repo, t.pr, [routing.label]);
    } catch (e) {
      console.error("judgement-gate label failed", e);
      return { text: `${line}\n\n_Could not add the review label: ${(e as Error).message}_`, routing };
    }
    return { text: line, routing };
  } catch (e) {
    console.error("judgement-gate routing failed", e);
    return { text: "", routing };
  }
}

export async function processPullRequest(ev: PullRequestEvent, env: Env, fetchFn: FetchFn): Promise<Verdict> {
  const owner = ev.repository.owner.login;
  const repo = ev.repository.name;
  const pr = ev.pull_request.number;
  const started = Date.now();
  const repoName = `${owner}/${repo}`;
  const mode = env.MODE ?? "shadow";
  const routingMode = env.ROUTING_MODE ?? env.MODE ?? "shadow";
  let evaluated: Judgement[] = [];
  // Outside the try so the degraded path can still apply model-independent routing rules.
  let routingSetup: RoutingSetup | undefined;
  // Set once routing has been published, so a late failure (e.g. completing the check) never labels twice.
  let routingNote: string | undefined;
  const token = await installationToken(env, ev.installation!.id, fetchFn);
  const gh = new GitHubClient(token, fetchFn, env.GITHUB_API_URL);

  // Immediate visual feedback in parallel with context fetch.
  const [check, files] = await Promise.all([gh.createCheckRun(owner, repo, ev.pull_request.head.sha), gh.listFiles(owner, repo, pr)]);

  let configNote = "";
  const routingTarget: RoutingTarget = { gh, env, owner, repo, pr, routingMode };
  try {
    const ctx = assembleContext(ev, files);
    const { judgements: all, routing: setup, note } = await loadGateConfig(gh, owner, env);
    routingSetup = setup;
    if (note) configNote = `\n\n_${note}_`;
    const applicable = all.filter((j) => appliesToFiles(j.appliesTo, files));
    evaluated = applicable;

    let results: JudgementResult[] = [];
    let latencyMs = 0;
    if (applicable.length > 0) {
      const jevStart = Date.now();
      const answers = await evaluate(
        ctx,
        applicable,
        {
          apiKey: env.JEV_API_KEY,
          url: env.JEV_API_URL ?? "https://openrouter.ai/api/alpha/decisions",
          model: env.JEV_MODEL ?? "typesafe/jev-1.14",
          timeoutMs: Number(env.JEV_TIMEOUT_MS ?? 2500),
        },
        fetchFn,
      );
      latencyMs = Date.now() - jevStart;
      results = applicable.map((judgement) => ({ judgement, verdict: judgement.decide(answers[judgement.id], ctx) }));
    }
    const verdict = aggregate(results);
    for (const { judgement, verdict: v } of results) {
      record(env.ANALYTICS, {
        event: "evaluation",
        repo: repoName,
        pr,
        judgement: judgement.id,
        mode,
        outcome: v.conclusion === "failure" ? "flagged" : v.metrics?.cleared ? "cleared" : "passed",
        reason: v.reason,
        probability: v.metrics?.probability,
        confidence: v.metrics?.confidence,
        level: v.classification?.level,
        latencyMs,
      });
    }
    const shadow = mode === "shadow";

    // Routing is advisory: it never feeds `aggregate` or the check conclusion.
    const published = await publishRouting(setup, results, files, routingTarget);
    const routing = published.routing;
    routingNote = asNote(published.text);

    // The comment is best-effort: failing to post it must not hide a verdict we already computed.
    // One comment per PR: remediation, human routing, or an update-only passing note.
    let commentNote = "";
    const failing = results.filter((r) => r.verdict.conclusion === "failure");
    const head = ev.pull_request.head;
    const headRepo = head.repo === undefined ? ev.repository : head.repo;
    const rc = {
      owner: headRepo?.owner.login ?? owner,
      repo: headRepo?.name ?? repo,
      headRef: headRepo ? head.ref : undefined,
    };
    const routedToHuman = failing.length === 0 && routing?.route === "human";
    try {
      const body = routedToHuman ? renderRoutingComment(routing!, rc, mode, routingMode, results) : renderComment(failing, rc, mode, routing, results, routingMode);
      await gh.upsertComment(owner, repo, pr, body, { createIfMissing: failing.length > 0 || routedToHuman });
    } catch (e) {
      console.error("judgement-gate comment failed", e);
      commentNote = `\n\n_Could not post the ${routedToHuman ? "routing" : failing.length > 0 ? "remediation" : "passing"} comment: ${(e as Error).message}_`;
    }
    // A classifier's summary is its name and level, so the line shows the level alone.
    const lines = results.map((r) => {
      const shown = r.judgement.kind === "classifier" ? (r.verdict.classification?.level ?? "no level reported") : r.verdict.summary;
      return `- ${r.verdict.conclusion === "success" ? "pass" : "FAIL"}: ${r.judgement.name} (${shown})`;
    });
    const detail = lines.length > 0 ? `${verdict.summary}\n\n${lines.join("\n")}` : verdict.summary;
    await gh.completeCheckRun(
      owner,
      repo,
      check.id,
      shadow ? "success" : verdict.conclusion,
      shadow ? `[Shadow] ${verdict.summary}` : verdict.summary,
      (shadow ? `Shadow mode: would have concluded **${verdict.conclusion}**.\n\n${detail}` : detail) + routingNote + configNote + commentNote,
    );
    return verdict;
  } catch (e) {
    for (const j of evaluated.length > 0 ? evaluated : [{ id: "" }]) {
      record(env.ANALYTICS, {
        event: "evaluation",
        repo: repoName,
        pr,
        judgement: j.id,
        mode,
        outcome: "degraded",
        reason: "degraded",
        latencyMs: Date.now() - started,
      });
    }
    // Without verdicts only model-independent rules (files, config_error) can route; judgement rules are skipped.
    if (routingNote === undefined) {
      const fallbackSetup: RoutingSetup = routingSetup ?? { status: "unavailable", message: "audit degraded", label: DEFAULT_LABEL };
      routingNote = asNote((await publishRouting(fallbackSetup, null, files, routingTarget)).text);
    }
    // Fail open: never block hotfixes on an audit outage (Jev timeout, 5xx, malformed answer).
    await gh.completeCheckRun(
      owner,
      repo,
      check.id,
      "neutral",
      "[Audit Degraded]",
      `Evaluation unavailable: ${(e as Error).message}${routingNote}${configNote}`,
    );
    return { conclusion: "neutral", reason: "degraded", summary: "[Audit Degraded]" };
  }
}
