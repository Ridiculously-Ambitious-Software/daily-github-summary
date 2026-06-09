import { loadDailySummaryOrganisationConfig } from "./dailySummaryOrganisationConfig";
import { collectActivity, LOOKBACK_HOURS } from "./github";
import { summariseActivity } from "./ai";
import { postDigest } from "./discord";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

async function main(): Promise<void> {
  const config = loadDailySummaryOrganisationConfig();
  const githubPat = requireEnv("GH_READ_ONLY_ORGANISATION_PAT");
  const anthropicApiKey = requireEnv("ANTHROPIC_API_KEY");
  const discordWebhookUrl = requireEnv("DISCORD_WEBHOOK_URL");
  const dryRun = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";

  console.log(
    `[digest] org=${config.organization} window=${LOOKBACK_HOURS}h dryRun=${dryRun}`,
  );

  const snapshot = await collectActivity(config, githubPat);
  console.log(
    `[digest] collected: ${snapshot.totals.activeRepos} active repos, ` +
      `${snapshot.totals.commits} default-branch commits, ` +
      `${snapshot.totals.branchCommits} branch commits`,
  );

  if (snapshot.totals.activeRepos === 0) {
    console.log("[digest] no activity in window — skipping Discord post");
    return;
  }

  const summary = await summariseActivity(
    snapshot,
    anthropicApiKey,
    config.customInstructions,
  );
  console.log(`[digest] AI summary: ${summary.headline}`);

  await postDigest(snapshot, summary, discordWebhookUrl, dryRun);
  console.log("[digest] done");
}

main().catch((err) => {
  console.error("[digest] failed:", err);
  process.exit(1);
});
