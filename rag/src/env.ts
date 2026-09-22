import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ProjectEnv } from "./types/env.types.ts";

let cachedEnv: ProjectEnv | null = null;

/** Clears the derived environment after the local settings screen applies changes. */
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
      process.env.DOCS_EXTENSIONS ?? process.env.MARKDOWN_EXTENSIONS,
      [".md", ".mdx", ".markdown", ".txt", ".html", ".htm", ".pdf"]
    ),
    chunksPath: process.env.CHUNKS_PATH?.trim() || "output/chunks.json",
    embeddingsPath: process.env.EMBEDDINGS_PATH?.trim() || "output/chunks.embeddings.json",
    knowledgeCachePath: process.env.KNOWLEDGE_CACHE_PATH?.trim() || "output/knowledge-cache.json",
    queryCachePath: process.env.QUERY_CACHE_PATH?.trim() || "output/query-cache.json",
    ragRulesPath: process.env.RAG_RULES_PATH?.trim() || "config/rag-rules.json",
    pdfToTextBin: process.env.PDF_TO_TEXT_BIN?.trim() || "pdftotext",
    chromaCollection: process.env.CHROMA_COLLECTION?.trim() || "local_rag_docs",
    chromaHost: process.env.CHROMA_HOST?.trim() || "localhost",
    chromaPort: parseNumber(process.env.CHROMA_PORT, 8000),
    chromaSsl: parseBoolean(process.env.CHROMA_SSL, false),
    ollamaUrl: process.env.OLLAMA_URL?.trim().replace(/\/+$/, "") || "http://127.0.0.1:11434",
    ollamaEmbedModel: process.env.OLLAMA_EMBED_MODEL?.trim() || "embeddinggemma",
    ollamaChatModel: process.env.OLLAMA_CHAT_MODEL?.trim() || "llama3.2:3b",
    ollamaTemperature: parseNumber(process.env.OLLAMA_TEMPERATURE, 0),
    splitTargetChars: parseNumber(process.env.SPLIT_TARGET_CHARS, 1200),
    splitMaxChars: parseNumber(process.env.SPLIT_MAX_CHARS, 1600),
    splitOverlapChars: parseNumber(process.env.SPLIT_OVERLAP_CHARS, 220),
    embedBatchSize: parseNumber(process.env.EMBED_BATCH_SIZE, 32),
    chromaIngestBatchSize: parseNumber(process.env.CHROMA_INGEST_BATCH_SIZE, 100),
    askTopK: parseNumber(process.env.ASK_TOP_K, 5),
    askMaxContextChars: parseNumber(process.env.ASK_MAX_CONTEXT_CHARS, 7000),
    askMaxSearchAttempts: parseNumber(process.env.ASK_MAX_SEARCH_ATTEMPTS, 3),
    askIntelligence: Math.max(0, Math.floor(parseNumber(process.env.ASK_INTELLIGENCE, 1))),
    askSupportSelectionCandidateCount: parseNumber(process.env.ASK_SUPPORT_SELECTION_CANDIDATE_COUNT, 8),
    askSupportSelectionMaxChunks: parseNumber(process.env.ASK_SUPPORT_SELECTION_MAX_CHUNKS, 4),
    askSupportNeighborWindow: parseNumber(process.env.ASK_SUPPORT_NEIGHBOR_WINDOW, 2),
    askSupportNeighborMaxChunks: parseNumber(process.env.ASK_SUPPORT_NEIGHBOR_MAX_CHUNKS, 3),
    askNoInfoAnswer: process.env.ASK_NO_INFO_ANSWER?.trim()
      || "The documentation does not contain enough relevant information to answer that question.",
    askDefaultAnswerInstruction: process.env.ASK_DEFAULT_ANSWER_INSTRUCTION?.trim()
      || "explain in detail",
    askPreferredLanguage: process.env.ASK_PREFERRED_LANGUAGE?.trim() || "English",
    askControlledInferenceLevel: parseControlledInferenceLevel(process.env.ASK_CONTROLLED_INFERENCE_LEVEL),
    retrievalLexicalRequiredWeight: parseNumber(process.env.RETRIEVAL_LEXICAL_REQUIRED_WEIGHT, 0.6),
    retrievalLexicalHeadingBoost: parseNumber(process.env.RETRIEVAL_LEXICAL_HEADING_BOOST, 0.2),
    retrievalLexicalExactPhraseBoost: parseNumber(process.env.RETRIEVAL_LEXICAL_EXACT_PHRASE_BOOST, 0.25),
    retrievalLexicalMinScore: parseNumber(process.env.RETRIEVAL_LEXICAL_MIN_SCORE, 0.2),
    retrievalDistanceFloor: parseNumber(process.env.RETRIEVAL_DISTANCE_FLOOR, 0.2),
    retrievalDistanceCap: parseNumber(process.env.RETRIEVAL_DISTANCE_CAP, 1.2),
    weakRetrievalBestDistanceThreshold: parseNumber(process.env.WEAK_RETRIEVAL_BEST_DISTANCE_THRESHOLD, 0.95),
    weakRetrievalAverageLexicalThreshold: parseNumber(process.env.WEAK_RETRIEVAL_AVERAGE_LEXICAL_THRESHOLD, 0.2),
    rankingKeywordWeight: parseNumber(process.env.RANKING_KEYWORD_WEIGHT, 0.15),
    rankingCodeExampleBonus: parseNumber(process.env.RANKING_CODE_EXAMPLE_BONUS, 0.08),
    rankingTextExampleBonus: parseNumber(process.env.RANKING_TEXT_EXAMPLE_BONUS, 0.04),
    rankingHtmlBonus: parseNumber(process.env.RANKING_HTML_BONUS, 0.08),
    rankingIntrinsicProximityBase: parseNumber(process.env.RANKING_INTRINSIC_PROXIMITY_BASE, 0.18),
    rankingIntrinsicProximityDecay: parseNumber(process.env.RANKING_INTRINSIC_PROXIMITY_DECAY, 0.05),
    exampleBestFitThreshold: parseNumber(process.env.EXAMPLE_BEST_FIT_THRESHOLD, 0.75),
    exampleExactHeadingThreshold: parseNumber(process.env.EXAMPLE_EXACT_HEADING_THRESHOLD, 0.5),
    exampleExactHeadingBoost: parseNumber(process.env.EXAMPLE_EXACT_HEADING_BOOST, 0.6),
    exampleHeadingWeight: parseNumber(process.env.EXAMPLE_HEADING_WEIGHT, 1.6),
    exampleContentWeight: parseNumber(process.env.EXAMPLE_CONTENT_WEIGHT, 1.1),
    exampleRequiredCoverageWeight: parseNumber(process.env.EXAMPLE_REQUIRED_COVERAGE_WEIGHT, 1.4),
    exampleBaseRankWeight: parseNumber(process.env.EXAMPLE_BASE_RANK_WEIGHT, 0.2),
    exampleSiblingSupportWeight: parseNumber(process.env.EXAMPLE_SIBLING_SUPPORT_WEIGHT, 1.2),
    exampleSameFileSupportWeight: parseNumber(process.env.EXAMPLE_SAME_FILE_SUPPORT_WEIGHT, 0.25),
    exampleAnchorMinScore: parseNumber(process.env.EXAMPLE_ANCHOR_MIN_SCORE, 0.2),
    exampleAnchorMinHeadingScore: parseNumber(process.env.EXAMPLE_ANCHOR_MIN_HEADING_SCORE, 0.2),
    exampleHeadingMatchWeight: parseNumber(process.env.EXAMPLE_HEADING_MATCH_WEIGHT, 0.4),
    exampleSameHeadingBoost: parseNumber(process.env.EXAMPLE_SAME_HEADING_BOOST, 0.5),
    exampleNearestTextBoost: parseNumber(process.env.EXAMPLE_NEAREST_TEXT_BOOST, 0.8),
    exampleSameFileBoost: parseNumber(process.env.EXAMPLE_SAME_FILE_BOOST, 0.15),
    exampleFileDistanceBaseBoost: parseNumber(process.env.EXAMPLE_FILE_DISTANCE_BASE_BOOST, 0.4),
    exampleFileDistanceDecay: parseNumber(process.env.EXAMPLE_FILE_DISTANCE_DECAY, 0.12),
    answerBroadQuestionBestDistanceThreshold: parseNumber(
      process.env.ANSWER_BROAD_QUESTION_BEST_DISTANCE_THRESHOLD,
      0.95
    ),
    answerHasContextDistanceThreshold: parseNumber(process.env.ANSWER_HAS_CONTEXT_DISTANCE_THRESHOLD, 0.9),
    answerHasContextOverlapThreshold: parseNumber(process.env.ANSWER_HAS_CONTEXT_OVERLAP_THRESHOLD, 0.2),
    answerBroadQuestionFallbackDistanceThreshold: parseNumber(
      process.env.ANSWER_BROAD_QUESTION_FALLBACK_DISTANCE_THRESHOLD,
      1
    )
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

function parseControlledInferenceLevel(
  value: string | undefined
): "strict" | "low" | "medium" | "high" {
  const normalized = value?.trim().toLowerCase();

  if (normalized === "low" || normalized === "medium" || normalized === "high" || normalized === "strict") {
    return normalized;
  }

  return "strict";
}
