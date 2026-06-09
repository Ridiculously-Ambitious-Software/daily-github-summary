import type { AiSummary, RepoChangeSummary } from "./ai";
import type { ActivitySnapshot, BranchActivity, CommitItem, RepoActivity } from "./github";

interface DiscordEmbed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
}

interface DiscordPayload {
  content?: string;
  embeds?: DiscordEmbed[];
}

const COLOR_OVERVIEW = 0x5865f2; // Discord blurple
const COLOR_REPO = 0x2b2d31; // dark grey

const EMBED_DESCRIPTION_LIMIT = 4096;
const EMBED_FIELD_VALUE_LIMIT = 1024;
const EMBEDS_TOTAL_TEXT_LIMIT = 6000;
const TOTAL_EMBEDS_PER_MESSAGE = 10;

export async function postDigest(
  snapshot: ActivitySnapshot,
  summary: AiSummary,
  webhookUrl: string,
  dryRun: boolean,
): Promise<void> {
  const messages = buildMessages(snapshot, summary);
  if (dryRun) {
    console.log("--- DRY RUN: Discord payloads ---");
    for (const [i, msg] of messages.entries()) {
      console.log(`\nMessage ${i + 1}/${messages.length}:`);
      console.log(JSON.stringify(msg, null, 2));
    }
    return;
  }
  for (const msg of messages) {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(msg),
    });
    if (!res.ok) {
      throw new Error(`Discord webhook ${res.status}: ${await res.text()}`);
    }
    // Discord rate-limits webhooks; small spacing between messages.
    await new Promise((r) => setTimeout(r, 750));
  }
}

function buildMessages(
  snapshot: ActivitySnapshot,
  summary: AiSummary,
): DiscordPayload[] {
  const overview = buildOverviewEmbed(snapshot, summary);
  const repoSummaries = buildRepoSummaryMap(snapshot.organization, summary);
  const repoEmbeds = snapshot.repos.map((r) =>
    buildRepoEmbed(r, repoSummaries.get(r.repo)),
  );

  const messages: DiscordPayload[] = [];
  let batch: DiscordEmbed[] = [];
  let batchTextLength = 0;

  for (const embed of [overview, ...repoEmbeds]) {
    const embedTextLength = countEmbedText(embed);
    if (
      batch.length > 0 &&
      (batch.length >= TOTAL_EMBEDS_PER_MESSAGE ||
        batchTextLength + embedTextLength > EMBEDS_TOTAL_TEXT_LIMIT)
    ) {
      messages.push({ embeds: batch });
      batch = [];
      batchTextLength = 0;
    }

    batch.push(embed);
    batchTextLength += embedTextLength;
  }

  if (batch.length > 0) {
    messages.push({ embeds: batch });
  }

  return messages;
}

function countEmbedText(embed: DiscordEmbed): number {
  return (
    (embed.title?.length ?? 0) +
    (embed.description?.length ?? 0) +
    (embed.url?.length ?? 0)
  );
}

function buildOverviewEmbed(
  snapshot: ActivitySnapshot,
  summary: AiSummary,
): DiscordEmbed {
  const lines: string[] = [];
  lines.push(`**${escapeMd(summary.headline)}**`);
  lines.push("");
  if (summary.overview) {
    lines.push(summary.overview);
  }

  const description = truncate(lines.join("\n"), EMBED_DESCRIPTION_LIMIT);

  return {
    title: `${snapshot.organization} daily commit digest`,
    url: `https://github.com/${snapshot.organization}`,
    description,
    color: COLOR_OVERVIEW,
  };
}

function buildRepoEmbed(
  repo: RepoActivity,
  summary: RepoChangeSummary | undefined,
): DiscordEmbed {
  const repoShort = repo.repo.split("/")[1] ?? repo.repo;
  const sections: string[] = [];

  if (repo.commits.length > 0) {
    sections.push(formatMainBranch(repo, summary));
  }

  if (repo.branchActivity.length > 0) {
    sections.push(formatBranchActivity(repo.branchActivity, summary));
  }

  const description = truncate(sections.join("\n\n"), EMBED_DESCRIPTION_LIMIT);

  return {
    title: repoShort,
    url: repo.url,
    description,
    color: COLOR_REPO,
  };
}

function formatMainBranch(
  repo: RepoActivity,
  summary: RepoChangeSummary | undefined,
): string {
  const lines = ["**Main branch**"];
  if (summary?.mainBranchSummary) {
    lines.push(`• ${escapeMd(summary.mainBranchSummary)}`);
  }
  const link = formatCommitRangeLink(repo.url, repo.commits);
  if (link) {
    lines.push(`• ${link}`);
  }
  return truncate(lines.join("\n"), EMBED_FIELD_VALUE_LIMIT * 3);
}

function formatBranchActivity(
  branches: BranchActivity[],
  summary: RepoChangeSummary | undefined,
): string {
  const lines = ["**Other branches**"];
  const hasBranchCommits = branches.some((branch) => branch.commits.length > 0);
  if (hasBranchCommits && summary?.branchSummary) {
    lines.push(`• ${escapeMd(summary.branchSummary)}`);
  }
  for (const branch of branches) {
    const status =
      branch.status === "in_review"
        ? " - in review"
        : branch.status === "merged"
          ? " - merged"
          : "";
    const branchLabel = branch.url
      ? `[\`${escapeMd(branch.branch)}\`](${branch.url})`
      : `\`${escapeMd(branch.branch)}\``;
    lines.push(`• ${branchLabel}${status}`);
    const link = formatCommitRangeLink(`https://github.com/${branch.repo}`, branch.commits);
    if (link) {
      lines.push(`  - ${link}`);
    }
  }
  return truncate(lines.join("\n"), EMBED_FIELD_VALUE_LIMIT * 3);
}

function formatCommitRangeLink(repoUrl: string, commits: CommitItem[]): string | null {
  if (commits.length === 0) return null;
  if (commits.length === 1) {
    const commit = commits[0]!;
    return `[View commit](${commit.url})`;
  }

  const byOldestFirst = [...commits].sort((a, b) =>
    a.committedAt.localeCompare(b.committedAt),
  );
  const oldest = byOldestFirst[0]!;
  const newest = byOldestFirst[byOldestFirst.length - 1]!;
  const base = oldest.parentSha ?? oldest.sha;
  const compareUrl = `${repoUrl}/compare/${base}...${newest.sha}`;
  return `[View ${commits.length} commits](${compareUrl})`;
}

function buildRepoSummaryMap(
  organization: string,
  summary: AiSummary,
): Map<string, RepoChangeSummary> {
  const out = new Map<string, RepoChangeSummary>();
  for (const repoSummary of summary.repos) {
    out.set(repoSummary.repo, repoSummary);
    if (!repoSummary.repo.includes("/")) {
      out.set(`${organization}/${repoSummary.repo}`, repoSummary);
    }
  }
  return out;
}

function escapeMd(text: string): string {
  return text.replace(/([*_`~|\\])/g, "\\$1");
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "...";
}
