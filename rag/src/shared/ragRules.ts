import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { getProjectEnv } from "../env.ts";
import type { RagRules } from "../models/rules.models.ts";

let cachedRules: RagRules | null = null;

export function readRagRules(): RagRules {
  if (cachedRules) {
    return cachedRules;
  }

  const rulesPath = path.resolve(process.cwd(), getProjectEnv().ragRulesPath);
  if (!existsSync(rulesPath)) {
    throw new Error(
      `RAG rules file not found at "${rulesPath}". Create the file or update RAG_RULES_PATH.`
    );
  }

  try {
    const parsed = JSON.parse(readFileSync(rulesPath, "utf8")) as unknown;
    cachedRules = parseRagRules(parsed, rulesPath);
    return cachedRules;
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }

    throw new Error(`Failed to read RAG rules from "${rulesPath}".`);
  }
}

function parseRagRules(value: unknown, rulesPath: string): RagRules {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`RAG rules file "${rulesPath}" must contain a JSON object.`);
  }

  const candidate = value as Record<string, unknown>;

  return {
    exampleQueryKeywords: parseStringList(candidate.exampleQueryKeywords, "exampleQueryKeywords", rulesPath),
    broadQuestionKeywords: parseStringList(candidate.broadQuestionKeywords, "broadQuestionKeywords", rulesPath),
    queryNormalizationAliases: parseStringMap(candidate.queryNormalizationAliases, "queryNormalizationAliases", rulesPath),
    lexicalStopWords: parseStringList(candidate.lexicalStopWords, "lexicalStopWords", rulesPath),
    requiredTermIgnoredWords: parseStringList(candidate.requiredTermIgnoredWords, "requiredTermIgnoredWords", rulesPath)
  };
}

function parseStringList(value: unknown, fieldName: string, rulesPath: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(
      `RAG rules field "${fieldName}" in "${rulesPath}" must be an array of strings.`
    );
  }

  const parsed = value
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);

  if (parsed.length === 0) {
    throw new Error(
      `RAG rules field "${fieldName}" in "${rulesPath}" must contain at least one string value.`
    );
  }

  return parsed;
}

function parseStringMap(value: unknown, fieldName: string, rulesPath: string): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `RAG rules field "${fieldName}" in "${rulesPath}" must be an object of string-to-string entries.`
    );
  }

  const entries = Object.entries(value)
    .filter((entry): entry is [string, string] =>
      typeof entry[0] === "string" &&
      typeof entry[1] === "string" &&
      entry[0].trim().length > 0 &&
      entry[1].trim().length > 0
    )
    .map(([key, value]) => [key.trim().toLowerCase(), value.trim()] as const);

  return Object.fromEntries(entries);
}
