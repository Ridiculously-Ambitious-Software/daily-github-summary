import { Octokit } from "@octokit/rest";
import { RequestError } from "@octokit/request-error";
import type { DailySummaryOrganisationConfig } from "./dailySummaryOrganisationConfig";

export const LOOKBACK_HOURS = 24;

export interface CommitItem {
  repo: string;
  sha: string;
  shortSha: string;
  subject: string;
  body: string;
  url: string;
  author: string;
  committedAt: string;
}

export interface BranchActivity {
  repo: string;
  branch: string;
  url: string;
  commits: CommitItem[];
  openedPullRequestToday: boolean;
  pullRequestUrl: string | null;
}

export interface ContextItem {
  repo: string;
  kind: "pull_request" | "issue";
  number: number;
  title: string;
  state: string;
  url: string;
  author: string;
  labels: string[];
  signals: string[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface RepoContext {
  pullRequests: ContextItem[];
  issues: ContextItem[];
}

export interface RepoActivity {
  repo: string;
  url: string;
  commits: CommitItem[];
  branchActivity: BranchActivity[];
  context: RepoContext;
}

export interface ActivitySnapshot {
  organization: string;
  since: string;
  until: string;
  repos: RepoActivity[];
  totals: {
    commits: number;
    branchCommits: number;
    activeBranches: number;
    activeRepos: number;
  };
}

interface OrgRepo {
  name: string;
  defaultBranch: string;
}

interface BranchNode {
  name: string;
}

interface PullRequestBranchSignal {
  branch: string;
  url: string;
  createdAt: string;
}

interface SearchContextNode {
  number: number;
  title: string;
  html_url: string;
  state: string;
  repository_url: string;
  user?: { login?: string } | null;
  labels?: ({ name?: string } | string)[];
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
}

interface ContextSearchSpec {
  kind: "pull_request" | "issue";
  signal: string;
  query: string;
}

const COMMIT_FETCH_SAFETY_LIMIT = 500;
const CONTEXT_SEARCH_SAFETY_LIMIT = 500;
const BRANCH_FETCH_SAFETY_LIMIT = 300;
const BRANCH_COMMIT_FETCH_SAFETY_LIMIT = 100;
const PAGE_SIZE = 100;

export async function collectActivity(
  config: DailySummaryOrganisationConfig,
  token: string,
): Promise<ActivitySnapshot> {
  const rest = new Octokit({ auth: token });

  const until = new Date();
  const since = new Date(until.getTime() - LOOKBACK_HOURS * 60 * 60 * 1000);
  const sinceIso = since.toISOString();
  const untilIso = until.toISOString();
  const isExcluded = createExcludedRepositoryMatcher(config);

  const [repos, contextByRepo] = await Promise.all([
    listOrgRepos(rest, config),
    fetchContextByRepo(rest, config, sinceIso, isExcluded),
  ]);
  const commitsByRepo = await fetchCommitsForRepos(
    rest,
    config.organization,
    repos.filter((r) => !isExcluded(`${config.organization}/${r.name}`)),
    sinceIso,
    untilIso,
  );
  const branchActivityByRepo = await fetchBranchActivityForRepos(
    rest,
    config.organization,
    repos.filter((r) => !isExcluded(`${config.organization}/${r.name}`)),
    sinceIso,
  );

  const activeRepos: RepoActivity[] = [];
  const activeRepoNames = new Set([
    ...commitsByRepo.keys(),
    ...branchActivityByRepo.keys(),
  ]);
  for (const repo of activeRepoNames) {
    const commits = commitsByRepo.get(repo) ?? [];
    const branchActivity = branchActivityByRepo.get(repo) ?? [];
    if (commits.length === 0 && branchActivity.length === 0) continue;
    activeRepos.push({
      repo,
      url: `https://github.com/${repo}`,
      commits,
      branchActivity,
      context: contextByRepo.get(repo) ?? emptyRepoContext(),
    });
  }

  const sortedRepos = activeRepos.sort((a, b) => {
    const aActivity =
      a.commits.length + a.branchActivity.reduce((sum, b) => sum + b.commits.length, 0);
    const bActivity =
      b.commits.length + b.branchActivity.reduce((sum, b) => sum + b.commits.length, 0);
    return bActivity - aActivity || a.repo.localeCompare(b.repo);
  });

  return {
    organization: config.organization,
    since: sinceIso,
    until: untilIso,
    repos: sortedRepos,
    totals: {
      commits: sortedRepos.reduce((sum, r) => sum + r.commits.length, 0),
      branchCommits: sortedRepos.reduce(
        (sum, r) =>
          sum + r.branchActivity.reduce((branchSum, b) => branchSum + b.commits.length, 0),
        0,
      ),
      activeBranches: sortedRepos.reduce((sum, r) => sum + r.branchActivity.length, 0),
      activeRepos: sortedRepos.length,
    },
  };
}

async function listOrgRepos(rest: Octokit, config: DailySummaryOrganisationConfig): Promise<OrgRepo[]> {
  const repos = await rest.paginate(rest.repos.listForOrg, {
    org: config.organization,
    type: "all",
    sort: "pushed",
    per_page: 100,
  });

  const out: OrgRepo[] = [];
  for (const repo of repos) {
    const defaultBranch = repo.default_branch;
    if (!defaultBranch) continue;
    out.push({
      name: repo.name,
      defaultBranch,
    });
  }
  return out;
}

async function fetchContextByRepo(
  rest: Octokit,
  config: DailySummaryOrganisationConfig,
  sinceIso: string,
  isExcluded: (nameWithOwner: string) => boolean,
): Promise<Map<string, RepoContext>> {
  const specs: ContextSearchSpec[] = [
    {
      kind: "pull_request",
      signal: "merged",
      query: `org:${config.organization} is:pr merged:>=${sinceIso}`,
    },
    {
      kind: "pull_request",
      signal: "opened",
      query: `org:${config.organization} is:pr created:>=${sinceIso}`,
    },
    {
      kind: "pull_request",
      signal: "updated",
      query: `org:${config.organization} is:pr is:open updated:>=${sinceIso} -created:>=${sinceIso}`,
    },
    {
      kind: "issue",
      signal: "opened",
      query: `org:${config.organization} is:issue created:>=${sinceIso}`,
    },
    {
      kind: "issue",
      signal: "closed",
      query: `org:${config.organization} is:issue closed:>=${sinceIso}`,
    },
  ];

  const searchResults = await Promise.all(
    specs.map((spec) => searchContextItems(rest, spec, isExcluded)),
  );

  const byKey = new Map<string, ContextItem>();
  for (const items of searchResults) {
    for (const item of items) {
      const key = `${item.kind}:${item.repo}:${item.number}`;
      const existing = byKey.get(key);
      if (existing) {
        for (const signal of item.signals) {
          if (!existing.signals.includes(signal)) existing.signals.push(signal);
        }
        continue;
      }
      byKey.set(key, item);
    }
  }

  const byRepo = new Map<string, RepoContext>();
  for (const item of byKey.values()) {
    const context = byRepo.get(item.repo) ?? emptyRepoContext();
    if (item.kind === "pull_request") {
      context.pullRequests.push(item);
    } else {
      context.issues.push(item);
    }
    byRepo.set(item.repo, context);
  }

  const byMostRecent = (a: ContextItem, b: ContextItem) =>
    b.updatedAt.localeCompare(a.updatedAt) || b.number - a.number;
  for (const context of byRepo.values()) {
    context.pullRequests.sort(byMostRecent);
    context.issues.sort(byMostRecent);
  }

  return byRepo;
}

async function searchContextItems(
  rest: Octokit,
  spec: ContextSearchSpec,
  isExcluded: (nameWithOwner: string) => boolean,
): Promise<ContextItem[]> {
  const out: ContextItem[] = [];
  let page = 1;
  try {
    while (out.length < CONTEXT_SEARCH_SAFETY_LIMIT) {
      const res = await rest.search.issuesAndPullRequests({
        q: spec.query,
        sort: "updated",
        order: "desc",
        per_page: PAGE_SIZE,
        page,
      });
      const items = (res.data.items as SearchContextNode[])
        .map((item) => toContextItem(item, spec))
        .filter((item): item is ContextItem => Boolean(item))
        .filter((item) => !isExcluded(item.repo));
      out.push(...items);
      if (res.data.items.length < PAGE_SIZE) break;
      page++;
    }
    return out.slice(0, CONTEXT_SEARCH_SAFETY_LIMIT);
  } catch (err) {
    console.warn(
      `context search failed for ${spec.signal} ${spec.kind}s:`,
      (err as Error).message,
    );
    return out;
  }
}

function createExcludedRepositoryMatcher(
  config: DailySummaryOrganisationConfig,
): (nameWithOwner: string) => boolean {
  const excludedRepositories = new Set(
    config.excludedRepositories.map((repo) => repo.toLowerCase()),
  );
  return (nameWithOwner: string) => {
    const repoOnly = nameWithOwner.toLowerCase().split("/")[1] ?? nameWithOwner;
    return excludedRepositories.has(repoOnly);
  };
}

function toContextItem(
  item: SearchContextNode,
  spec: ContextSearchSpec,
): ContextItem | null {
  const marker = "/repos/";
  const markerIndex = item.repository_url.indexOf(marker);
  if (markerIndex === -1) return null;
  const repo = item.repository_url.slice(markerIndex + marker.length);
  return {
    repo,
    kind: spec.kind,
    number: item.number,
    title: item.title,
    state: item.state,
    url: item.html_url,
    author: item.user?.login ?? "ghost",
    labels: (item.labels ?? [])
      .map((label) => (typeof label === "string" ? label : label.name))
      .filter((label): label is string => Boolean(label))
      .slice(0, 10),
    signals: [spec.signal],
    createdAt: item.created_at ?? "",
    updatedAt: item.updated_at ?? "",
    closedAt: item.closed_at ?? null,
  };
}

async function fetchCommitsForRepos(
  rest: Octokit,
  org: string,
  repos: OrgRepo[],
  sinceIso: string,
  untilIso: string,
): Promise<Map<string, CommitItem[]>> {
  const out = new Map<string, CommitItem[]>();
  const concurrency = 6;
  let i = 0;

  async function worker() {
    while (i < repos.length) {
      const idx = i++;
      const repo = repos[idx];
      if (!repo) continue;
      try {
        const items = await fetchCommitsForRepo(
          rest,
          org,
          repo,
          sinceIso,
          untilIso,
        );
        out.set(`${org}/${repo.name}`, items);
      } catch (err) {
        if (err instanceof RequestError && (err.status === 404 || err.status === 409)) {
          // 409 = empty repo, 404 = no access; skip silently.
          continue;
        }
        console.warn(`commit fetch failed for ${repo.name}:`, (err as Error).message);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return out;
}

async function fetchCommitsForRepo(
  rest: Octokit,
  org: string,
  repo: OrgRepo,
  sinceIso: string,
  untilIso: string,
): Promise<CommitItem[]> {
  const out: CommitItem[] = [];
  let page = 1;

  while (out.length < COMMIT_FETCH_SAFETY_LIMIT) {
    const res = await rest.repos.listCommits({
      owner: org,
      repo: repo.name,
      sha: repo.defaultBranch,
      since: sinceIso,
      until: untilIso,
      per_page: PAGE_SIZE,
      page,
    });
    out.push(...res.data.map((c) => toCommitItem(`${org}/${repo.name}`, c, sinceIso)));
    if (res.data.length < PAGE_SIZE) break;
    page++;
  }

  return out.slice(0, COMMIT_FETCH_SAFETY_LIMIT);
}

async function fetchBranchActivityForRepos(
  rest: Octokit,
  org: string,
  repos: OrgRepo[],
  sinceIso: string,
): Promise<Map<string, BranchActivity[]>> {
  const out = new Map<string, BranchActivity[]>();
  const concurrency = 4;
  let i = 0;

  async function worker() {
    while (i < repos.length) {
      const idx = i++;
      const repo = repos[idx];
      if (!repo) continue;
      try {
        const activity = await fetchBranchActivityForRepo(rest, org, repo, sinceIso);
        if (activity.length > 0) out.set(`${org}/${repo.name}`, activity);
      } catch (err) {
        if (err instanceof RequestError && (err.status === 404 || err.status === 409)) {
          continue;
        }
        console.warn(`branch activity fetch failed for ${repo.name}:`, (err as Error).message);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return out;
}

async function fetchBranchActivityForRepo(
  rest: Octokit,
  org: string,
  repo: OrgRepo,
  sinceIso: string,
): Promise<BranchActivity[]> {
  const [branches, openedPullRequestsByBranch] = await Promise.all([
    listBranches(rest, org, repo),
    listOpenedPullRequestsByBranch(rest, org, repo, sinceIso),
  ]);

  const out: BranchActivity[] = [];
  for (const branch of branches) {
    if (branch.name === repo.defaultBranch) continue;
    let commits: CommitItem[];
    try {
      commits = await fetchRecentBranchOnlyCommits(rest, org, repo, branch.name, sinceIso);
    } catch (err) {
      console.warn(
        `branch compare failed for ${repo.name}/${branch.name}:`,
        (err as Error).message,
      );
      continue;
    }
    if (commits.length === 0) continue;
    const pullRequest = openedPullRequestsByBranch.get(branch.name);
    out.push({
      repo: `${org}/${repo.name}`,
      branch: branch.name,
      url: `https://github.com/${org}/${repo.name}/tree/${encodeBranchPath(branch.name)}`,
      commits,
      openedPullRequestToday: Boolean(pullRequest),
      pullRequestUrl: pullRequest?.url ?? null,
    });
  }

  return out.sort((a, b) => {
    const aLatest = a.commits[0]?.committedAt ?? "";
    const bLatest = b.commits[0]?.committedAt ?? "";
    return bLatest.localeCompare(aLatest) || a.branch.localeCompare(b.branch);
  });
}

function encodeBranchPath(branch: string): string {
  return branch.split("/").map(encodeURIComponent).join("/");
}

async function listBranches(
  rest: Octokit,
  org: string,
  repo: OrgRepo,
): Promise<BranchNode[]> {
  const out: BranchNode[] = [];
  let page = 1;

  while (out.length < BRANCH_FETCH_SAFETY_LIMIT) {
    const res = await rest.repos.listBranches({
      owner: org,
      repo: repo.name,
      per_page: PAGE_SIZE,
      page,
    });
    out.push(...res.data.map((branch) => ({ name: branch.name })));
    if (res.data.length < PAGE_SIZE) break;
    page++;
  }

  return out.slice(0, BRANCH_FETCH_SAFETY_LIMIT);
}

async function listOpenedPullRequestsByBranch(
  rest: Octokit,
  org: string,
  repo: OrgRepo,
  sinceIso: string,
): Promise<Map<string, PullRequestBranchSignal>> {
  const pulls = await rest.paginate(rest.pulls.list, {
    owner: org,
    repo: repo.name,
    state: "open",
    sort: "created",
    direction: "desc",
    per_page: PAGE_SIZE,
  });

  const sinceMs = Date.parse(sinceIso);
  const byBranch = new Map<string, PullRequestBranchSignal>();
  for (const pull of pulls) {
    const createdAt = pull.created_at ?? "";
    if (Date.parse(createdAt) < sinceMs) continue;
    if (pull.head.repo?.full_name !== `${org}/${repo.name}`) continue;
    byBranch.set(pull.head.ref, {
      branch: pull.head.ref,
      url: pull.html_url,
      createdAt,
    });
  }
  return byBranch;
}

async function fetchRecentBranchOnlyCommits(
  rest: Octokit,
  org: string,
  repo: OrgRepo,
  branch: string,
  sinceIso: string,
): Promise<CommitItem[]> {
  const res = await rest.repos.compareCommitsWithBasehead({
    owner: org,
    repo: repo.name,
    basehead: `${repo.defaultBranch}...${branch}`,
    per_page: BRANCH_COMMIT_FETCH_SAFETY_LIMIT,
  });

  const sinceMs = Date.parse(sinceIso);
  return res.data.commits
    .map((commit) => toCommitItem(`${org}/${repo.name}`, commit, sinceIso))
    .filter((commit) => Date.parse(commit.committedAt) >= sinceMs)
    .sort((a, b) => b.committedAt.localeCompare(a.committedAt))
    .slice(0, BRANCH_COMMIT_FETCH_SAFETY_LIMIT);
}

function toCommitItem(
  repo: string,
  c: Awaited<ReturnType<Octokit["repos"]["listCommits"]>>["data"][number],
  fallbackDate: string,
): CommitItem {
  const rawMessage = c.commit.message ?? "";
  const [rawSubject = "", ...bodyLines] = rawMessage.split("\n");
  const body = bodyLines.join("\n").trim();
  const trimmedSubject = rawSubject.trim();
  // Merge commits carry no useful subject; fall back to the first body line.
  const mergeBodySubject = /^Merge pull request #\d+/i.test(trimmedSubject)
    ? body.split("\n").map((line) => line.trim()).find(Boolean)
    : undefined;
  const subject =
    mergeBodySubject?.slice(0, 200) ||
    trimmedSubject.slice(0, 200) ||
    "(no commit message)";
  return {
    repo,
    sha: c.sha,
    shortSha: c.sha.slice(0, 7),
    subject,
    body: body.slice(0, 1000),
    url: c.html_url,
    author:
      c.author?.login ??
      c.commit.author?.name ??
      c.commit.author?.email ??
      "unknown",
    committedAt: c.commit.committer?.date ?? c.commit.author?.date ?? fallbackDate,
  };
}

function emptyRepoContext(): RepoContext {
  return {
    pullRequests: [],
    issues: [],
  };
}
