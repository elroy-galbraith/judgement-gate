export interface Env {
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  JEV_API_KEY: string;
  MODE?: string;
  /** Review routing mode (`shadow` or enforce); defaults to MODE. */
  ROUTING_MODE?: string;
  JEV_MODEL?: string;
  JEV_API_URL?: string;
  JEV_TIMEOUT_MS?: string;
  GITHUB_API_URL?: string;
  CONFIDENCE_THRESHOLD?: string;
  CONFIG_REPO?: string;
  /** Workers Analytics Engine dataset. Optional: without it nothing is recorded. */
  ANALYTICS?: AnalyticsSink;
}

export interface AnalyticsSink {
  writeDataPoint(point: { indexes?: string[]; blobs?: string[]; doubles?: number[] }): void;
}

export type FetchFn = typeof fetch;

export interface PullRequestEvent {
  action: string;
  installation?: { id: number };
  repository: { name: string; owner: { login: string } };
  pull_request: {
    number: number;
    title: string;
    body: string | null;
    draft?: boolean;
    base: { ref: string };
    head: {
      sha: string;
      ref?: string;
      repo?: { name: string; owner: { login: string }; fork?: boolean } | null;
    };
  };
  changes?: { title?: unknown; body?: unknown; base?: unknown };
}

export interface MergeGroupEvent {
  action: string;
  installation?: { id: number };
  repository: { name: string; owner: { login: string } };
  merge_group: { head_sha: string; head_ref?: string; base_ref?: string };
}

export interface IssueCommentEvent {
  action: string;
  installation?: { id: number };
  repository: { name: string; owner: { login: string } };
  issue: { number: number; pull_request?: unknown };
  comment: { body: string; user: { type: string }; author_association?: string };
}

export interface ChangedFile {
  filename: string;
  status: string;
  /** Set by GitHub when status is "renamed" or "copied". */
  previous_filename?: string;
  patch?: string;
}

export interface PrContext {
  title: string;
  body: string;
  baseBranch: string;
  headSha: string;
  files: ChangedFile[];
  patchExtract: string;
  /** The extract leaves part of the diff out (see buildDiffExtract), so a verdict rests on a partial view. */
  diffTruncated?: boolean;
}

export interface JevResult {
  oneWayProb: number;
  additiveProb: number;
  reversalProb: number;
  classification: "TYPE_1_ONE_WAY_DOOR" | "TYPE_2_TWO_WAY_DOOR";
  classificationConfidence: number;
}

export type Verdict = {
  conclusion: "success" | "failure" | "neutral";
  summary: string;
  reason: string;
};

export interface JevQuestion {
  type: "noul" | "choice";
  instructions: string;
  criteria: Record<string, string>;
}

export type JevAnswers = Record<string, { noul?: number; choice?: string; confidence?: number }>;

export interface JudgementVerdict {
  conclusion: "success" | "failure";
  reason: string;
  summary: string;
  /** True when the judgement's trigger condition held, whether or not the PR then cleared it. */
  fired: boolean;
  signals?: string;
  /** Numbers for calibration logging only; never affects the verdict. */
  metrics?: { probability?: number; confidence?: number; cleared?: boolean };
  /** Set by a classifier judgement: the org-defined level it chose. Never PR or model text: always one of the configured level ids. */
  classification?: { level: string; confidence?: number };
}

export interface RemedyContext {
  owner: string;
  repo: string;
  headRef?: string;
}

/** Machine-readable ways to clear a failing judgement. Never contains PR or diff content. */
export type AgentSatisfiedBy =
  | { type: "pr_body_matches"; regex: string; flags?: string; template?: string }
  | { type: "pr_body_fields"; fields: string[]; template: string }
  | { type: "file_added"; glob: string; example_path?: string }
  /** The model must judge that the PR description gives a concrete answer to `question` (not n/a, none or tbd). */
  | { type: "answers"; question: string };

export interface AgentHint {
  threshold?: number;
  satisfied_by: AgentSatisfiedBy[];
  /** Concrete text an agent can paste (into the PR body or a new file). */
  suggested_template?: { target: "pr_body" | "file"; path?: string; content: string };
}

/** A named question for the model, a decision rule, and a remedy that teaches the author. */
export interface Judgement {
  id: string;
  name: string;
  /** Globs against changed filenames; omitted means the judgement always applies. */
  appliesTo?: string[];
  /** Changed files for which this returns true are not considered when deciding whether the judgement applies. */
  ignores?: (filename: string) => boolean;
  /** Send question keys without the `${id}.` prefix. Only the built-in one-way-door uses this, to keep its original Jev contract. */
  unprefixedKeys?: boolean;
  /** A classifier labels the PR and never fails it, so it never fires. Default: a yes/no judgement that can flag. */
  kind?: "classifier";
  /** A missing or malformed answer is dropped instead of degrading the judgement; `decide` must cope with absent answers. */
  optionalAnswers?: boolean;
  /** Every reason code `decide` can return. */
  reasons: string[];
  questions: Record<string, JevQuestion>;
  decide(answers: JevAnswers, pr: PrContext): JudgementVerdict;
  remedy(v: JudgementVerdict, rc: RemedyContext): { why: string; fix: string };
  /** Structured counterpart of the remedy, embedded in the comment for agents. */
  agent?(v: JudgementVerdict, rc: RemedyContext): AgentHint;
  /** Questions a reviewer will ask for this verdict; authored, static, may be empty. */
  probes?(v: JudgementVerdict): string[];
}
