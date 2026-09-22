import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ProjectEnv } from "./types/env.types.ts";

let cachedEnv: ProjectEnv | null = null;

export function resetProjectEnvCache(): void {
  cachedEnv = null;
}

export function getProjectEnv(): ProjectEnv {
  if (cachedEnv) {
    return cachedEnv;
  }

  const envExamplePath = path.resolve(process.cwd(), ".env.example");
  const envPath = path.resolve(process.cwd(), ".env");

  loadDotEnvFile(envPath);
  loadDotEnvFile(envExamplePath);

  cachedEnv = {
    docsDir: process.env.DOCS_DIR?.trim() || "./docs",
    docsExtensions: parseList(
      process.env.DOCS_EXTENSIONS,
      [".md", ".mdx", ".markdown", ".txt", ".html", ".htm", ".pdf"]
    ),
    chunksPath: process.env.CHUNKS_PATH?.trim() || "output/chunks.json",
    pdfToTextBin: process.env.PDF_TO_TEXT_BIN?.trim() || "pdftotext",
    chromaCollection: process.env.CHROMA_COLLECTION?.trim() || "local_rag_docs",
    chromaHost: process.env.CHROMA_HOST?.trim() || "localhost",
    chromaPort: parseNumber(process.env.CHROMA_PORT, 8000),
    chromaSsl: parseBoolean(process.env.CHROMA_SSL, false),
    ollamaUrl: process.env.OLLAMA_URL?.trim().replace(/\/+$/, "") || "http://127.0.0.1:11434",
    ollamaEmbedModel: process.env.OLLAMA_EMBED_MODEL?.trim() || "embeddinggemma",
    ollamaTemperature: parseNumber(process.env.OLLAMA_TEMPERATURE, 0),
    splitTargetChars: parseNumber(process.env.SPLIT_TARGET_CHARS, 1200),
    splitMaxChars: parseNumber(process.env.SPLIT_MAX_CHARS, 1600),
    splitOverlapChars: parseNumber(process.env.SPLIT_OVERLAP_CHARS, 220),
  };

  return cachedEnv;
}

function loadDotEnvFile(envPath: string): void {
  if (!existsSync(envPath)) {
    return;
  }

  const contents = readFileSync(envPath, "utf8");
  for (const rawLine of contents.split(/\r?\n/g)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const rawValue = line.slice(separatorIndex + 1).trim();
    const value = stripWrappingQuotes(rawValue);

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function stripWrappingQuotes(value: string): string {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }

  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }

  return fallback;
}

function parseList(value: string | undefined, fallback: string[]): string[] {
  if (value === undefined) {
    return [...fallback];
  }

  const parsed = value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

  return parsed.length > 0 ? parsed : [...fallback];
}
