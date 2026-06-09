# Daily GitHub Summary

A reusable externally scheduled GitHub digest runner. It reads default-branch
commits and changed non-default branches across a private GitHub organisation,
uses PRs/issues as optional background context, asks Claude for a concise
per-repo summary, and posts the result to Discord.

This repository is intended to be the neutral upstream that organisation-specific
private deployment repos copy from. Keep organisation names,
organisation-specific prompt tweaks, Discord webhooks, and GitHub tokens out of
the shared upstream.

Original upstream repo:
[Ridiculously-Ambitious-Software/daily-github-summary](https://github.com/Ridiculously-Ambitious-Software/daily-github-summary)

- **Commit-focused output** - PRs and issues are signals only; they are never listed in the post.
- **Branch activity** - changed non-default branches are shown separately from main branch work.
- **Lifecycle-aware branches** - branches started and merged in the same window are left to the main branch section; older branch work merged during the window can be marked as merged.
- **Optional PR/issue context** - titles and labels can help Claude understand why commits happened.
- **Per-repo summaries** - Claude describes roughly what changed in each active repo.
- **Fixed report contract** - the report always covers the last 24 hours, includes archived repos and forks unless blocked, and uses the hardcoded Anthropic model.
- **Deployment-repo-owned config** - each private deployment repo edits one YAML file with its organisation name, excluded repositories, and report tweaks.
- **External scheduler support** - cron-job.org triggers runs through GitHub's `repository_dispatch` API.

---

## How It Works

1. **`src/github.ts`** collects activity for the last 24 hours:
   - REST `repos.listForOrg` enumerates all organisation repos, including archived repos and forks.
   - `excludedRepositories` skips repos by repo name.
   - REST `repos.listCommits` fetches recent commits from each repo's default branch.
   - REST `repos.listBranches` and `repos.compareCommitsWithBasehead` find
     existing non-default branches with branch-only commits in the same window.
   - REST `pulls.list` detects branch lifecycle signals. Branches that entered
     review during the window are marked as in review; older branches merged
     during the window can be marked as merged. Branches started and merged
     inside the same window are left to the main branch section.
   - REST `search.issuesAndPullRequests` fetches recent PRs/issues as best-effort context.
2. **`src/ai.ts`** sends Claude a compact JSON snapshot containing repo names,
   default-branch commit subjects, branch commit subjects, commit bodies,
   authors, and hidden PR/issue context. Claude returns structured JSON:
   `headline`, `overview`, and one `repos[]` summary per active repo.
3. **`src/discord.ts`** builds one overview embed, then one embed per repo with:
   - a main branch section with a short summary and linked commit subjects
   - one other branches section with a short summary and linked branch commit subjects

Quiet days are silent. If the lookback window contains zero default-branch
commits and zero branch activity across the org, the workflow exits before
calling Claude or Discord.

---

## Recommended Private Deployment Setup

GitHub does not allow a private fork of a public repository. Use this repo as
the shared upstream, then create an empty private deployment repo for each
organisation. The private repo keeps its own config and secrets, while still
remembering this public repo as `upstream`.

### Step 1: Create The Private Deployment Repo

Create a new **private** GitHub repository in the organisation that should
receive the digest.

Suggested repository settings:

| Field | Value |
| --- | --- |
| Repository name | `daily-github-summary` |
| Description | `Private deployment config for the daily GitHub summary digest.` |
| Visibility | Private |
| Initialize with README | No |
| Add .gitignore | No |
| Choose a license | No |

The repository must be empty because the setup script below pushes this upstream
repo into it.

### Step 2: Configure Environment Variables

#### Create The Organisation Read-Only PAT

Create this token from the GitHub account that should own the organisation-wide
read access.

1. Open [GitHub's fine-grained token creation page](https://github.com/settings/personal-access-tokens/new).
2. Set **Token name** to `daily-github-summary-read-[ORGANISATION]`.
3. Set **Description** to `Allows the daily summary workflow to read organisation activity`.
4. Set **Expiration** to **No expiration**.
5. Under **Resource owner**, select the GitHub organisation being reported on.
6. Under **Repository access**, choose **All repositories**. This lets the digest
   include new organisation repos without updating the token.
7. Under **Repository permissions**, set:
   - **Contents** - read-only
   - **Pull requests** - read-only
   - **Issues** - read-only
   - **Metadata** - read-only, selected automatically
8. Leave every other permission as **No access**.
9. Click **Generate token**.
10. Copy the token immediately. GitHub will not show it again.

If the organisation does not appear under **Resource owner**, make sure you are
signed in with an account that belongs to the organisation and that the
organisation allows fine-grained PATs.

#### Add The GitHub Actions Secrets

Configure the runtime environment variables as GitHub Actions secrets. In the
private deployment repo, go to **Settings -> Secrets and variables -> Actions ->
New repository secret** and add:

| Name | Value |
| --- | --- |
| `GH_READ_ONLY_ORGANISATION_PAT` | The `daily-github-summary-read-[ORGANISATION]` token |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `DISCORD_WEBHOOK_URL` | Discord incoming webhook URL |

### Step 3: Run The Setup Script

Open a terminal in an empty local folder and paste these lines directly into the
terminal. Do not save them as a separate script file.

```sh
set -euo pipefail

PUBLIC_REPO="https://github.com/Ridiculously-Ambitious-Software/daily-github-summary.git"

printf "Private GitHub repo URL: "
read -r PRIVATE_REPO_URL

git clone "$PUBLIC_REPO" .
git remote rename origin upstream
git remote add origin "$PRIVATE_REPO_URL"

OWNER_REPO="${PRIVATE_REPO_URL#git@github.com:}"
OWNER_REPO="${OWNER_REPO#https://github.com/}"
OWNER_REPO="${OWNER_REPO#http://github.com/}"
TARGET_ORG="${OWNER_REPO%%/*}"

perl -0pi -e "s/^organisationName:.*/organisationName: $TARGET_ORG/m" dailySummaryOrganisationConfig.yml

git add dailySummaryOrganisationConfig.yml
git commit -m "Configure daily summary for $TARGET_ORG"
git push -u origin "$(git branch --show-current)"
```

The private repo URL can be either HTTPS, like
`https://github.com/your-github-org/daily-github-summary.git`, or SSH, like
`git@github.com:your-github-org/daily-github-summary.git`. The commands leave
`origin` pointing at the private deployment repo and `upstream` pointing at this
public shared repo.

In [dailySummaryOrganisationConfig.yml](dailySummaryOrganisationConfig.yml),
the pasted commands set `organisationName` from the private repo URL. Then
update:

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

### Step 4: Schedule The Run With cron-job.org

cron-job.org should call the private deployment repo's `repository_dispatch`
trigger. We avoid a GitHub Actions `schedule` trigger because scheduled Actions
can start late.

#### Allow A Non-Expiring Organisation PAT

Do this once as an organisation owner:

1. Go to GitHub.
2. Open your organisation.
3. Go to **Settings**.
4. In the left sidebar, open **Personal access tokens**.
5. Open **Settings**.
6. Select **Fine-grained tokens**.
7. Find **Set maximum lifetimes for personal access tokens**.
8. Disable the requirement that fine-grained PATs must expire.
9. Save.

#### Create A GitHub Dispatch Token

Create a fine-grained GitHub PAT that can only trigger the private deployment
repo.

1. Open [GitHub's fine-grained token creation page](https://github.com/settings/personal-access-tokens/new).
2. Set **Token name** to `daily-github-summary-dispatch`.
3. Set **Description** to `Allows cron-job.org to trigger the daily summary workflow`.
4. Set **Expiration** to **No expiration**.
5. Under **Resource owner**, select the GitHub org that owns the private deployment repo.
6. Under **Repository access**, choose **Only select repositories**.
7. Select only the private deployment repo.
8. Under **Repository permissions**, set:
   - **Contents** - read and write
   - **Metadata** - read-only, selected automatically
9. Leave every other permission as **No access**.
10. Click **Generate token**.
11. Copy the token immediately. GitHub will not show it again.

GitHub requires `Contents: write` for the `repository_dispatch` endpoint. Use
this token only for the cron-job.org `Authorization` request header below.

#### Create The cron-job.org Job

In cron-job.org, create a new cron job with these request settings:

| Field | Value |
| --- | --- |
| URL | `https://api.github.com/repos/OWNER/REPO/dispatches` |
| Method | `POST` |
| Timezone | Your report timezone, for example `Europe/Amsterdam` |
| Schedule | The desired report time, for example every day at `08:00` |
| Save responses | Optional, useful while testing |

Replace `OWNER/REPO` with the private deployment repo that contains
`.github/workflows/daily-summary.yml`.

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
then appears in the private deployment repo's Actions tab.
