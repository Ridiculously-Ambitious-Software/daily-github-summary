import Anthropic from "@anthropic-ai/sdk";
import type { ActivitySnapshot } from "./github";

const ANTHROPIC_MODEL = "claude-fable-5";

export interface RepoChangeSummary {
  repo: string;
  mainBranchSummary: string;
  branches: BranchChangeSummary[];
}

export interface BranchChangeSummary {
  branch: string;
  summary: string;
}

export interface AiSummary {
  headline: string;
  overview: string;
  repos: RepoChangeSummary[];
}

const SUMMARY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "overview", "repos"],
  properties: {
    headline: {
      type: "string",
      description: "Brief, broadest useful takeaway of the day.",
    },
    overview: {
      type: "string",
      description:
        "1-3 balanced sentences across all repos; honest if activity is light. Keep it broad — repo and branch detail belongs in the repo summaries. Only mention branch work if at least one repo has branchActivity.",
    },
    repos: {
      type: "array",
      description: "Exactly one item per repo in the input.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["repo", "mainBranchSummary", "branches"],
        properties: {
          repo: {
            type: "string",
            description:
              'The exact repo value from the input, e.g. "org/repo".',
          },
          mainBranchSummary: {
            type: "string",
            description:
              "1-3 readable sentences based only on `commits`; empty string if there are none. PRs/issues may only clarify ambiguous commit subjects.",
          },
          branches: {
            type: "array",
            description:
              "One item per `branchActivity` entry; empty when there are none.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["branch", "summary"],
              properties: {
                branch: {
                  type: "string",
                  description:
                    "The exact branch value from `branchActivity`.",
                },
                summary: {
                  type: "string",
                  description:
                    "1-3 readable sentences based only on that branch's commits.",
                },
              },
            },
          },
        },
      },
    },
  },
} as const;

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
        status: b.status,
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
    "You write the daily Discord digest of GitHub activity (main-branch commits and active branches) for a private engineering team.",
    "Write like a sharp colleague catching the team up: concrete and plain, lead with what actually changed and why, skip implementation noise, and be honest when a day is quiet.",
    "",
    "Your output is rendered into Discord embeds, so:",
    '- Each repo gets its own embed, with separate headings for main-branch work and each branch. Never write section labels like "main branch" or "other branches" in prose.',
    "- Branch lifecycle status (in review, merged) is shown in the branch heading. Do not restate it.",
    "- The `repo` and `branch` values you return are used as exact lookup keys — echo them verbatim from the input.",
    "",
    "Pull requests and issues are private context to help you interpret commit intent; never mention, count, or link them in the output.",
    "Ground every statement in the provided commits. Do not infer business intent, release readiness, or project status that is not in the data.",
  ].join("\n");

  const userPrompt = [
    "Summarize this activity snapshot into the daily digest.",
    customInstructions
      ? [
          "",
          "Organisation-specific report instructions:",
          customInstructions,
          "",
          "Apply these only where they do not conflict with your core instructions.",
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
    max_tokens: 4000,
    system,
    output_config: {
      format: { type: "json_schema", schema: SUMMARY_SCHEMA },
    },
    messages: [{ role: "user", content: userPrompt }],
  });

  return parseSummary(response);
}

function parseSummary(response: Anthropic.Message): AiSummary {
  if (response.stop_reason === "max_tokens") {
    throw new Error("AI summary was truncated; raise max_tokens.");
  }
  if (response.stop_reason === "refusal") {
    throw new Error("AI refused to produce a summary.");
  }
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  return JSON.parse(text) as AiSummary;
}
