import type { AiSummary, RepoChangeSummary } from "./ai";
import type { ActivitySnapshot, RepoActivity } from "./github";

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
  const firstBatch: DiscordEmbed[] = [overview];

  let i = 0;
  while (i < repoEmbeds.length && firstBatch.length < TOTAL_EMBEDS_PER_MESSAGE) {
    firstBatch.push(repoEmbeds[i]!);
    i++;
  }
  messages.push({ embeds: firstBatch });

  while (i < repoEmbeds.length) {
    const batch = repoEmbeds.slice(i, i + TOTAL_EMBEDS_PER_MESSAGE);
    messages.push({ embeds: batch });
    i += TOTAL_EMBEDS_PER_MESSAGE;
  }

  return messages;
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

  if (summary?.summary) {
    sections.push(formatSection("Rough change", [escapeMd(summary.summary)]));
  }

  sections.push(
    formatSection(
      "Commits",
      repo.commits.map(
        (c) =>
          `[\`${c.shortSha}\`](${c.url}) ${escapeMd(truncate(c.subject, 90))} - \`${c.author}\``,
      ),
    ),
  );

  const description = truncate(sections.join("\n\n"), EMBED_DESCRIPTION_LIMIT);

  return {
    title: repoShort,
    url: repo.url,
    description,
    color: COLOR_REPO,
  };
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

function formatSection(heading: string, items: string[]): string {
  const lines = [`**${heading}**`];
  for (const item of items) lines.push(`• ${item}`);
  return truncate(lines.join("\n"), EMBED_FIELD_VALUE_LIMIT * 3);
}

function escapeMd(text: string): string {
  return text.replace(/([*_`~|\\])/g, "\\$1");
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "...";
}
