import Anthropic from "@anthropic-ai/sdk";
import type { ActivitySnapshot } from "./github";

const ANTHROPIC_MODEL = "claude-opus-4-7";

export interface RepoChangeSummary {
  repo: string;
  mainBranchSummary: string;
  branchSummary: string;
}

export interface AiSummary {
  headline: string;
  overview: string;
  repos: RepoChangeSummary[];
}

export async function summariseActivity(
  snapshot: ActivitySnapshot,
  apiKey: string,
  customInstructions: string,
): Promise<AiSummary> {
  const client = new Anthropic({ apiKey });

  const compact = {
    organization: snapshot.organization,
    window: { since: snapshot.since, until: snapshot.until },
    totals: snapshot.totals,
    repos: snapshot.repos.map((r) => ({
      repo: r.repo,
      commits: r.commits.map((c) => ({
        sha: c.shortSha,
        subject: c.subject,
        body: c.body,
        author: c.author,
      })),
      branchActivity: r.branchActivity.map((b) => ({
        branch: b.branch,
        openedPullRequestToday: b.openedPullRequestToday,
        commits: b.commits.map((c) => ({
          sha: c.shortSha,
          subject: c.subject,
          body: c.body,
          author: c.author,
        })),
      })),
      context: {
        pullRequests: r.context.pullRequests.map((p) => ({
          n: p.number,
          title: p.title,
          state: p.state,
          signals: p.signals,
          labels: p.labels,
        })),
        issues: r.context.issues.map((i) => ({
          n: i.number,
          title: i.title,
          state: i.state,
          signals: i.signals,
          labels: i.labels,
        })),
      },
    })),
  };

  const system = [
    "You prepare a concise daily Discord digest from default-branch commits in private GitHub repos.",
    "Write for engineers: concrete, plain, and careful about uncertainty.",
    "Summarize what was roughly added or changed per repo, using commits as the only reportable source of work.",
    "The Discord UI separates main-branch work from other branch work; do not repeat those section labels in prose.",
    "branchActivity.openedPullRequestToday only means that branch entered review during the report window.",
    "Pull requests and issues are private context to help interpret commit intent; do not list them, link them, count them, or cite their numbers.",
    "When a reason is explicit, attach it directly to the related change instead of writing a separate reason.",
    "Do not infer business intent or project status that is not present in the provided data.",
    "Avoid release-state or merge-readiness wording unless it appears in the commit text.",
    "Return ONLY valid JSON matching the schema. No prose before or after.",
  ].join(" ");

  const userPrompt = [
    "Produce a JSON object with this exact shape:",
    "{",
    '  "headline": string,         // brief, broadest useful takeaway',
    '  "overview": string,         // 1-2 sentences across all repos; honest if activity is light',
    '  "repos": [',
    "    {",
    '      "repo": string,         // exactly one repo value from the input, e.g. "org/repo"',
    '      "mainBranchSummary": string, // short summary of `commits`; empty string if there are none',
    '      "branchSummary": string      // short summary of all `branchActivity`; empty string if there is none',
    "    }",
    "  ]",
    "}",
    "",
    "Rules:",
    "- Include one `repos` item for every repo in the input.",
    "- Do not invent items not present in the data.",
    "- Base `mainBranchSummary` only on `commits`; PRs/issues may only clarify ambiguous commit subjects.",
    "- Base `branchSummary` only on `branchActivity` commits.",
    "- If a repo has no `branchActivity`, `branchSummary` must be an empty string.",
    "- Do not mention branch work in `headline` or `overview` unless at least one repo has non-empty `branchActivity`.",
    "- In `branchSummary`, mention review status only when `openedPullRequestToday` is true.",
    "- Do not mention PRs, issues, PR/issue numbers, links, or issue-tracker status in the output.",
    "- Do not prefix summaries with `main branch`, `default branch`, `other branches`, or similar section labels.",
    "- Prefer the concrete change over naming the author.",
    "- If commits look like maintenance, fixes, cleanup, or dependency work, say that plainly.",
    "- If multiple changes have different reasons, keep each reason next to its matching change.",
    "- If a reason is implicit, vague, or absent even after looking at context, omit the reason.",
    customInstructions
      ? [
          "",
          "Organisation-specific report instructions:",
          customInstructions,
          "",
          "Apply these instructions only when they do not conflict with the schema and rules above.",
        ].join("\n")
      : "",
    "",
    "Activity snapshot:",
    "```json",
    JSON.stringify(compact),
    "```",
  ].join("\n");

  const response = await client.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 1800,
    system,
    messages: [{ role: "user", content: userPrompt }],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  return parseSummary(text);
}

function parseSummary(text: string): AiSummary {
  const jsonText = extractJson(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(
      `AI did not return valid JSON: ${(err as Error).message}\n---\n${text}`,
    );
  }
  const obj = parsed as Partial<AiSummary>;
  return {
    headline: typeof obj.headline === "string" ? obj.headline : "Daily commits",
    overview: typeof obj.overview === "string" ? obj.overview : "",
    repos: Array.isArray(obj.repos)
      ? obj.repos.filter(isRepoChangeSummary)
      : [],
  };
}

function isRepoChangeSummary(value: unknown): value is RepoChangeSummary {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<RepoChangeSummary>;
  return (
    typeof item.repo === "string" &&
    typeof item.mainBranchSummary === "string" &&
    typeof item.branchSummary === "string"
  );
}

function extractJson(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence && fence[1]) return fence[1].trim();
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    return text.slice(first, last + 1);
  }
  return text;
}
