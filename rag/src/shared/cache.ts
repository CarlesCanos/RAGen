import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getProjectEnv } from "../env.ts";
import type {
  KnowledgeCache,
  QueryCache,
  QueryCacheEntry
} from "../models/cache.models.ts";
import type { ChunkManifest } from "../models/chunk.models.ts";
import { readChunkManifest } from "./manifests.ts";

const CACHE_VERSION = 1;

export function getCurrentSourceManifest(): ChunkManifest | null {
  const manifestPath = path.resolve(process.cwd(), getProjectEnv().chunksPath);
  if (!existsSync(manifestPath)) {
    return null;
  }

  try {
    return readChunkManifest(readFileSync(manifestPath, "utf8"));
  } catch {
    return null;
  }
}

export function readKnowledgeCache(): KnowledgeCache | null {
  const env = getProjectEnv();
  const cachePath = path.resolve(process.cwd(), env.knowledgeCachePath);
  const manifest = getCurrentSourceManifest();
  if (!manifest || !existsSync(cachePath)) {
    return null;
  }

  try {
    const cache = JSON.parse(readFileSync(cachePath, "utf8")) as KnowledgeCache;
    if (
      cache.version !== CACHE_VERSION ||
      cache.sourceManifestGeneratedAt !== manifest.generatedAt ||
      !Array.isArray(cache.entities)
    ) {
      return null;
    }

    return cache;
  } catch {
    return null;
  }
}

export function writeKnowledgeCache(cache: KnowledgeCache): void {
  writeJsonFile(getProjectEnv().knowledgeCachePath, cache);
}

export function readQueryCache(): QueryCache {
  const manifest = getCurrentSourceManifest();
  const emptyCache = createEmptyQueryCache(manifest?.generatedAt ?? "");
  const cachePath = path.resolve(process.cwd(), getProjectEnv().queryCachePath);
  if (!manifest || !existsSync(cachePath)) {
    return emptyCache;
  }

  try {
    const cache = JSON.parse(readFileSync(cachePath, "utf8")) as QueryCache;
    if (
      cache.version !== CACHE_VERSION ||
      cache.sourceManifestGeneratedAt !== manifest.generatedAt ||
      !Array.isArray(cache.entries)
    ) {
      return emptyCache;
    }

    return cache;
  } catch {
    return emptyCache;
  }
}

export function clearQueryCache(): void {
  const manifest = getCurrentSourceManifest();
  writeQueryCache(createEmptyQueryCache(manifest?.generatedAt ?? ""));
}

export function writeQueryCache(cache: QueryCache): void {
  writeJsonFile(getProjectEnv().queryCachePath, {
    ...cache,
    entries: deduplicateQueryCacheEntries(cache.entries)
  });
}

export function buildQueryCacheKey(input: {
  normalizedQuestion: string;
  answerInstruction: string;
  targetLanguage: string;
  chatModel?: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify({
      normalizedQuestion: normalizeCacheText(input.normalizedQuestion),
      answerInstruction: normalizeCacheText(input.answerInstruction),
      targetLanguage: normalizeCacheText(input.targetLanguage),
      chatModel: normalizeCacheText(input.chatModel ?? "")
    }))
    .digest("hex");
}

export function upsertQueryCacheEntry(entry: QueryCacheEntry): void {
  const cache = readQueryCache();
  writeQueryCache({
    ...cache,
    entries: [
      entry,
      ...cache.entries.filter((existing) => existing.key !== entry.key)
    ].slice(0, 200)
  });
}

function createEmptyQueryCache(sourceManifestGeneratedAt: string): QueryCache {
  return {
    version: CACHE_VERSION,
    generatedAt: new Date().toISOString(),
    sourceManifestGeneratedAt,
    entries: []
  };
}

function deduplicateQueryCacheEntries(entries: QueryCacheEntry[]): QueryCacheEntry[] {
  const byKey = new Map<string, QueryCacheEntry>();
  for (const entry of entries) {
    if (!byKey.has(entry.key)) {
      byKey.set(entry.key, entry);
    }
  }

  return [...byKey.values()];
}

function writeJsonFile(relativePath: string, value: unknown): void {
  const outputPath = path.resolve(process.cwd(), relativePath);
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function normalizeCacheText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}
