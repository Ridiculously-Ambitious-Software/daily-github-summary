# Daily GitHub Summary

A reusable externally scheduled GitHub digest runner. It reads default-branch
commits across a private GitHub organisation, uses PRs/issues as optional
background context, asks Claude for a concise per-repo summary, and posts the
result to Discord.

This repository is intended to be the neutral upstream that organisation-specific
repos fork from. Keep organisation names, organisation-specific prompt tweaks,
Discord webhooks, and GitHub tokens out of the shared upstream.

- **Commit-focused output** - PRs and issues are never listed in the post.
- **Optional PR/issue context** - titles and labels can help Claude understand why commits happened.
- **Per-repo summaries** - Claude describes roughly what changed in each active repo.
- **Fixed report contract** - the report always covers the last 24 hours, includes archived repos and forks unless blocked, and uses the hardcoded Anthropic model.
- **Fork-owned config** - each fork edits one YAML file with its organisation name, excluded repositories, and report tweaks.
- **External scheduler support** - cron-job.org triggers runs through GitHub's `repository_dispatch` API.

---

## How It Works

1. **`src/github.ts`** collects activity for the last 24 hours:
   - REST `repos.listForOrg` enumerates all organisation repos, including archived repos and forks.
   - `excludedRepositories` skips repos by repo name.
   - REST `repos.listCommits` fetches recent commits from each repo's default branch.
   - REST `search.issuesAndPullRequests` fetches recent PRs/issues as best-effort context.
2. **`src/ai.ts`** sends Claude a compact JSON snapshot containing repo names,
   commit subjects, commit bodies, authors, and hidden PR/issue context. Claude
   returns structured JSON: `headline`, `overview`, and one `repos[]` summary per
   active repo.
3. **`src/discord.ts`** builds one overview embed, then one embed per repo with:
   - rough change summary with any explicit rationale attached to the matching change
   - linked commit subjects for verification

Quiet days are silent. If the lookback window contains zero commits across the
org, the workflow exits before calling Claude or Discord.

---

## Recommended Fork Setup

Use this repo as the shared upstream. For each organisation, create a private
fork or deployment repo, then edit the fork directly.

In [dailySummaryOrganisationConfig.yml](dailySummaryOrganisationConfig.yml),
update:

- `organisationName` - the GitHub organisation to summarize.
- `excludedRepositories` - repo names to skip, without the organisation prefix.
- `customInstructions` - optional report-specific instructions for that organisation.

For example:

```yaml
organisationName: your-github-org
excludedRepositories:
  - internal-sandbox
  - archive-only
customInstructions: |
  Capitalize all repo names
```

### Actions Secrets

In each fork, add:

| Name | Value |
| --- | --- |
| `GH_READ_ONLY_ORGANISATION_PAT` | Read-only GitHub token scoped to the target org/repos |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `DISCORD_WEBHOOK_URL` | Discord incoming webhook URL |

For a fine-grained GitHub PAT, use repository read access for:

- **Metadata** - read-only
- **Contents** - read-only
- **Pull requests** - read-only, optional context
- **Issues** - read-only, optional context

---

## Scheduling With cron-job.org

cron-job.org should call the fork's `repository_dispatch` trigger. We avoid a
GitHub Actions `schedule` trigger because scheduled Actions can start late.

### 1. Create A GitHub Dispatch Token

Create a fine-grained GitHub PAT scoped only to the fork/deployment repo.

Repository permissions:

- **Metadata** - read-only, selected automatically
- **Contents** - read and write

GitHub requires `Contents: write` for the `repository_dispatch` endpoint.

### 2. Create The cron-job.org Job

In cron-job.org, create a new cron job with these request settings:

| Field | Value |
| --- | --- |
| URL | `https://api.github.com/repos/OWNER/REPO/dispatches` |
| Method | `POST` |
| Timezone | Your report timezone, for example `Europe/Amsterdam` |
| Schedule | The desired report time, for example every day at `08:00` |
| Save responses | Optional, useful while testing |

Replace `OWNER/REPO` with the private fork that contains `.github/workflows/daily-summary.yml`.

Add these request headers:

| Header | Value |
| --- | --- |
| `Authorization` | `Bearer YOUR_GITHUB_DISPATCH_TOKEN` |
| `Accept` | `application/vnd.github+json` |
| `X-GitHub-Api-Version` | `2026-03-10` |
| `Content-Type` | `application/json` |

Use this request body:

```json
{
  "event_type": "daily-summary",
  "client_payload": {
    "source": "cron-job.org",
    "request_id": "%cjo:uuid4%",
    "scheduled_at": "%cjo:unixtime%"
  }
}
```

cron-job.org substitutes `%cjo:uuid4%` and `%cjo:unixtime%` on each execution,
which makes the request easy to identify in logs.

GitHub returns `204 No Content` when the dispatch was accepted. The workflow run
then appears in the fork's Actions tab.