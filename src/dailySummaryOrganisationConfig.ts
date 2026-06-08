import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

export interface DailySummaryOrganisationConfig {
  organization: string;
  customInstructions: string;
  excludedRepositories: string[];
}

const FILE = "dailySummaryOrganisationConfig.yml";
const CONFIG_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  FILE,
);

export function loadDailySummaryOrganisationConfig(): DailySummaryOrganisationConfig {
  const parsed = parse(readFileSync(CONFIG_PATH, "utf8")) ?? {};
  const known = ["organisationName", "customInstructions", "excludedRepositories"];
  const unknown = Object.keys(parsed).filter((key) => !known.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${FILE}: unknown keys: ${unknown.join(", ")}`);
  }

  const organization = (parsed.organisationName ?? "").trim();
  if (!organization) {
    throw new Error(`${FILE}: \`organisationName\` is required`);
  }

  return {
    organization,
    customInstructions: (parsed.customInstructions ?? "").trim(),
    excludedRepositories: readExcludedRepositories(parsed.excludedRepositories),
  };
}

function readExcludedRepositories(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${FILE}: \`excludedRepositories\` must be a list`);
  }

  const repositories = value.map((repo) => String(repo).trim()).filter(Boolean);
  const invalid = repositories.filter((repo) => repo.includes("/"));
  if (invalid.length > 0) {
    throw new Error(
      `${FILE}: \`excludedRepositories\` must use repo names only, without \`org/\`: ${invalid.join(", ")}`,
    );
  }
  return repositories;
}
