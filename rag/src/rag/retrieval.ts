import { ChromaClient } from "chromadb";
import { getProjectEnv } from "../env.ts";
import type { QueryMetadata } from "../models/chunk.models.ts";
import type {
  RetrievedChunk,
  SearchPlanDecision,
  SearchPlanOption,
  RetrievalRewriteDecision,
  SearchAttempt
} from "../models/retrieval.models.ts";
import type { RagSearchOptions } from "../types/rag.types.ts";
import {
  buildRetryQueryDecisionPrompt,
  buildSearchPlanPrompt
} from "../prompts/retrieval.prompts.ts";
import { readKnowledgeCache } from "../shared/cache.ts";
import { safeParseJson } from "../shared/json.ts";
import { chunkToQueryMetadata, getChunkManifestEntries } from "../shared/manifests.ts";
import { requestEmbeddings, requestJsonChatCompletion } from "../shared/ollama.ts";
import { augmentWithRelatedExamples } from "./examples.ts";
import { rankChunk } from "./scoring.ts";
import {
  canonicalizeToken,
  extractRequiredTerms,
  extractProtectedTerms,
  lexicalSignal,
  normalizeSearchQuery,
  normalizeTerms,
  tokenizeLoose
} from "./text.ts";

export async function runSearchAttempts(
  collection: Awaited<ReturnType<ChromaClient["getCollection"]>>,
  options: RagSearchOptions
): Promise<SearchAttempt[]> {
  const attempts: SearchAttempt[] = [];
  const plannedOptions = await planSearchQueries(options.question, options);
  const normalizedOriginalQuestion = plannedOptions[0]?.query ?? await normalizeSearchQuery(options.question, options);
  let queuedOptions = plannedOptions.length > 0
    ? [...plannedOptions]
    : [{
      query: normalizedOriginalQuestion,
      reason: normalizedOriginalQuestion === options.question
        ? "Original user question."
        : `Normalized user question from "${options.question}".`
    }];
  let currentQuery = queuedOptions[0]?.query ?? options.question;
  let currentReason = queuedOptions[0]?.reason ?? "Original user question.";
  let researchHops = 0;

  for (let attemptIndex = 0; attemptIndex < options.maxSearchAttempts; attemptIndex += 1) {
    const chunks = await retrieveChunks(collection, currentQuery, options);
    attempts.push({
      query: currentQuery,
      reason: currentReason,
      chunks
    });

    if (attemptIndex === options.maxSearchAttempts - 1) {
      break;
    }

    if (queuedOptions.length > 1) {
      queuedOptions = queuedOptions.slice(1);
      const nextPlanned = queuedOptions[0];
      if (nextPlanned && !hasAttemptedQuery(attempts, nextPlanned.query)) {
        currentQuery = nextPlanned.query;
        currentReason = nextPlanned.reason;
        continue;
      }
    }

    const researchQuery = buildInvestigativeQuery(options.question, attempts);
    if (
      researchHops < getProjectEnv().askIntelligence &&
      researchQuery &&
      !hasAttemptedQuery(attempts, researchQuery)
    ) {
      researchHops += 1;
      currentQuery = await normalizeSearchQuery(researchQuery, options);
      currentReason = currentQuery === researchQuery
        ? "Investigative hop from related chunks."
        : `Investigative hop from related chunks. Normalized to "${currentQuery}".`;
      continue;
    }

    const rewrite = await decideRetryQuery(options.question, attempts, options);
    if (!rewrite.retry || !rewrite.query.trim() || rewrite.query.trim() === currentQuery.trim()) {
      break;
    }

    const rewrittenQuery = isSafeRetryQuery(options.question, rewrite.query.trim())
      ? rewrite.query.trim()
      : buildFallbackRetryQuery(options.question);
    currentQuery = await normalizeSearchQuery(rewrittenQuery, options);
    currentReason = currentQuery === rewrittenQuery
      ? (rewrite.reason || "Model reformulated the search query.")
      : `${rewrite.reason || "Model reformulated the search query."} Normalized to "${currentQuery}".`;
  }

  return attempts;
}

async function planSearchQueries(
  originalQuestion: string,
  options: Pick<RagSearchOptions, "ollamaUrl" | "chatModel" | "maxSearchAttempts">
): Promise<SearchPlanOption[]> {
  const normalizedOriginal = await normalizeSearchQuery(originalQuestion, options);
  const fallbackOption: SearchPlanOption = {
    query: normalizedOriginal,
    reason: normalizedOriginal === originalQuestion
      ? "Original user question."
      : `Normalized user question from "${originalQuestion}".`
  };

  if (!options.chatModel || getProjectEnv().askIntelligence <= 0) {
    return deduplicatePlannedOptions([
      fallbackOption,
      ...buildSemanticSearchHypotheses(originalQuestion)
    ]).slice(0, options.maxSearchAttempts);
  }

  const maxOptions = Math.max(1, Math.min(options.maxSearchAttempts, getProjectEnv().askIntelligence + 1));
  const prompt = buildSearchPlanPrompt(originalQuestion, maxOptions);

  try {
    const rawResponse = await requestJsonChatCompletion(
      prompt,
      options.ollamaUrl,
      options.chatModel
    );
    const parsed = safeParseJson<Partial<SearchPlanDecision>>(rawResponse);
    const plannedOptions = Array.isArray(parsed?.options)
      ? parsed.options
        .filter((option): option is SearchPlanOption =>
          typeof option?.query === "string" &&
          typeof option?.reason === "string"
        )
        .map((option) => ({
          query: option.query.trim(),
          reason: option.reason.trim()
        }))
        .filter((option) => option.query.length > 0 && option.reason.length > 0)
      : [];

    const normalizedPlannedOptions: SearchPlanOption[] = [];
    for (const option of plannedOptions) {
      const safeQuery = isSafeRetryQuery(originalQuestion, option.query)
        ? option.query
        : originalQuestion;
      const normalizedQuery = await normalizeSearchQuery(safeQuery, options);
      if (!normalizedQuery) {
        continue;
      }

      normalizedPlannedOptions.push({
        query: normalizedQuery,
        reason: normalizedQuery === option.query
          ? `Search hypothesis: ${option.reason}`
          : `Search hypothesis: ${option.reason} Normalized to "${normalizedQuery}".`
      });
    }

    const deduplicated = deduplicatePlannedOptions([
      fallbackOption,
      ...buildSemanticSearchHypotheses(originalQuestion),
      ...normalizedPlannedOptions
    ]);
    return deduplicated.slice(0, maxOptions);
  } catch {
    return deduplicatePlannedOptions([
      fallbackOption,
      ...buildSemanticSearchHypotheses(originalQuestion)
    ]).slice(0, options.maxSearchAttempts);
  }
}

function buildSemanticSearchHypotheses(originalQuestion: string): SearchPlanOption[] {
  const protectedTerms = extractProtectedTerms(originalQuestion);
  if (protectedTerms.length === 0) {
    return [];
  }

  const tokens = tokenizeLoose(originalQuestion);
  const entityPhrase = protectedTerms.join(" ");
  const options: SearchPlanOption[] = [];

  if (hasAnyToken(tokens, ["father", "mother", "parent", "parents", "padre", "madre", "padres", "progenitor", "progenitores"])) {
    for (const relationTerm of ["hija", "hijo", "daughter", "son", "child", "children"]) {
      options.push({
        query: `${entityPhrase} ${relationTerm}`,
        reason: `Semantic relationship hypothesis using inverse family labels such as "${relationTerm}".`
      });
    }
  }

  if (hasAnyToken(tokens, ["child", "children", "son", "daughter", "hijo", "hijos", "hija", "hijas"])) {
    for (const relationTerm of ["hija", "hijo", "daughter", "son", "child"]) {
      options.push({
        query: `${entityPhrase} ${relationTerm}`,
        reason: `Semantic relationship hypothesis using family label "${relationTerm}".`
      });
    }
  }

  return options;
}

function hasAnyToken(tokens: string[], candidates: string[]): boolean {
  return candidates.some((candidate) => tokens.includes(canonicalizeToken(candidate)));
}

function deduplicatePlannedOptions(options: SearchPlanOption[]): SearchPlanOption[] {
  const seen = new Set<string>();
  const deduplicated: SearchPlanOption[] = [];

  for (const option of options) {
    const key = option.query.trim().toLowerCase();
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduplicated.push(option);
  }

  return deduplicated;
}

function hasAttemptedQuery(attempts: SearchAttempt[], query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  return attempts.some((attempt) => attempt.query.trim().toLowerCase() === normalizedQuery);
}

function buildInvestigativeQuery(originalQuestion: string, attempts: SearchAttempt[]): string {
  const questionTerms = normalizeTerms(originalQuestion);
  const descriptorTerms = getInvestigativeDescriptorTerms(questionTerms);
  if (descriptorTerms.length === 0) {
    return "";
  }

  const targetTerms = getInvestigativeTargetTerms(questionTerms);
  const cachedQuery = buildKnowledgeCacheInvestigativeQuery(descriptorTerms, targetTerms);
  if (cachedQuery) {
    return cachedQuery;
  }

  const chunksToInspect = [
    ...attempts.flatMap((attempt) => attempt.chunks),
    ...findManifestChunksForDescriptors(originalQuestion, descriptorTerms, 8)
  ];
  const bestEntity = findBestEntityCandidate(originalQuestion, descriptorTerms, chunksToInspect);
  if (!bestEntity) {
    return "";
  }

  return [...new Set([bestEntity, ...targetTerms])].join(" ");
}

function buildKnowledgeCacheInvestigativeQuery(
  descriptorTerms: string[],
  targetTerms: string[]
): string {
  const cache = readKnowledgeCache();
  if (!cache) {
    return "";
  }

  const candidates = cache.entities
    .map((entity) => {
      const searchableText = [
        entity.name,
        ...entity.aliases,
        ...entity.facts.map((fact) => `${fact.type} ${fact.value}`),
        ...entity.relations.map((relation) => `${relation.type} ${relation.target}`),
        ...entity.events.map((event) => `${event.label} ${event.date}`)
      ].join(" ");
      const tokens = tokenizeLoose(searchableText);
      const descriptorHits = descriptorTerms.filter((term) => tokens.includes(term)).length;
      const hasTargetEvent = targetTerms.length === 0 || targetTerms.some((term) =>
        entity.events.some((event) => tokenizeLoose(`${event.label} ${event.date}`).includes(term))
      );

      return {
        entityName: entity.name,
        score: descriptorHits + (hasTargetEvent ? 1 : 0)
      };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score);

  const bestCandidate = candidates[0];
  if (!bestCandidate) {
    return "";
  }

  return [...new Set([bestCandidate.entityName, ...targetTerms])].join(" ");
}

function findManifestChunksForDescriptors(
  originalQuestion: string,
  descriptorTerms: string[],
  limit: number
): RetrievedChunk[] {
  const manifestChunks = getChunkManifestEntries();
  const queryTerms = normalizeTerms(originalQuestion);

  return manifestChunks
    .map((chunk) => {
      const text = `${chunk.heading} ${chunk.text}`;
      const tokens = tokenizeLoose(text);
      const descriptorHits = descriptorTerms.filter((term) => tokens.includes(term)).length;
      const queryHits = queryTerms.filter((term) => tokens.includes(term)).length;
      const score = descriptorHits * 2 + queryHits;

      return {
        chunk,
        score
      };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ chunk }) => ({
      id: chunk.id,
      document: chunk.text,
      metadata: chunkToQueryMetadata(chunk),
      distance: null,
      searchQuery: originalQuestion,
      lexicalScore: lexicalSignal(originalQuestion, `${chunk.heading} ${chunk.text}`)
    } satisfies RetrievedChunk));
}

function findBestEntityCandidate(
  originalQuestion: string,
  descriptorTerms: string[],
  chunks: RetrievedChunk[]
): string {
  const candidate = descriptorTerms
    .find((term) => chunks.some((chunk) => tokenizeLoose(chunk.document).includes(term)))
    ?? descriptorTerms[0]
    ?? "";
  if (!candidate) {
    return "";
  }

  return candidate;
}

function getInvestigativeDescriptorTerms(questionTerms: string[]): string[] {
  const targetTerms = new Set(getInvestigativeTargetTerms(questionTerms));
  const genericTerms = new Set([
    "ano", "anio", "year", "fecha", "date", "cuando", "when", "que", "what",
    "murio", "muerte", "muerto", "fallecio", "fallecimiento", "died", "death", "dead"
  ]);

  return questionTerms.filter((term) => !targetTerms.has(term) && !genericTerms.has(term));
}

function getInvestigativeTargetTerms(questionTerms: string[]): string[] {
  const targetTerms = new Set<string>();
  if (questionTerms.some((term) => ["murio", "muerte", "muerto", "fallecio", "fallecimiento", "died", "death", "dead"].includes(term))) {
    targetTerms.add("muerte");
  }

  if (questionTerms.some((term) => ["ano", "anio", "year", "fecha", "date", "cuando", "when"].includes(term))) {
    targetTerms.add("fecha");
  }

  return [...targetTerms];
}

function hasAnyTerm(text: string, terms: string[]): boolean {
  const tokens = tokenizeLoose(text);
  return terms.some((term) => tokens.includes(term));
}

function isSafeRetryQuery(originalQuestion: string, retryQuery: string): boolean {
  const protectedTerms = extractProtectedTerms(originalQuestion);
  if (protectedTerms.length === 0) {
    return true;
  }

  const retryTokens = tokenizeLoose(retryQuery);
  return protectedTerms.every((term) => retryTokens.includes(term));
}

export function selectBestChunks(attempts: SearchAttempt[]): RetrievedChunk[] {
  const merged = new Map<string, RetrievedChunk>();

  for (const attempt of attempts) {
    for (const chunk of attempt.chunks) {
      const existing = merged.get(chunk.id);
      if (!existing) {
        merged.set(chunk.id, chunk);
        continue;
      }

      const existingDistance = existing.distance ?? Number.POSITIVE_INFINITY;
      const nextDistance = chunk.distance ?? Number.POSITIVE_INFINITY;
      if (nextDistance < existingDistance) {
        merged.set(chunk.id, chunk);
      }
    }
  }

  const rankedChunks = [...merged.values()].sort((left, right) => {
    const leftScore = rankChunk(left);
    const rightScore = rankChunk(right);
    return rightScore - leftScore;
  });

  return deduplicateRetrievedChunks(rankedChunks);
}

export function limitContext(chunks: RetrievedChunk[], maxContextChars: number): RetrievedChunk[] {
  const selected: RetrievedChunk[] = [];
  let totalChars = 0;

  for (const chunk of chunks) {
    if (selected.length > 0 && totalChars + chunk.document.length > maxContextChars) {
      break;
    }

    selected.push(chunk);
    totalChars += chunk.document.length;
  }

  return selected;
}

export function buildContextChunks(
  question: string,
  rankedChunks: RetrievedChunk[],
  maxContextChars: number
): RetrievedChunk[] {
  return limitContext(prioritizeContextChunks(question, rankedChunks), maxContextChars);
}

function prioritizeContextChunks(question: string, rankedChunks: RetrievedChunk[]): RetrievedChunk[] {
  const merged = new Map<string, RetrievedChunk>();

  for (const chunk of rankedChunks) {
    merged.set(chunk.id, chunk);
  }

  for (const chunk of augmentWithRelatedExamples(question, rankedChunks)) {
    if (!merged.has(chunk.id)) {
      merged.set(chunk.id, chunk);
    }
  }

  return [...merged.values()];
}

async function retrieveChunks(
  collection: Awaited<ReturnType<ChromaClient["getCollection"]>>,
  searchQuery: string,
  options: RagSearchOptions
): Promise<RetrievedChunk[]> {
  const [queryEmbedding] = await requestEmbeddings([searchQuery], {
    baseUrl: options.ollamaUrl,
    model: options.embedModel
  });

  if (!queryEmbedding) {
    throw new Error("Ollama did not return an embedding for the query.");
  }

  const queryResult = await collection.query<QueryMetadata>({
    queryEmbeddings: [queryEmbedding],
    nResults: options.topK,
    include: ["documents", "metadatas", "distances"]
  });

  const vectorChunks = flattenFirstQueryResult(queryResult, searchQuery);
  const lexicalChunks = retrieveLexicalChunks(searchQuery, options.topK);
  return mergeRetrievedChunks(vectorChunks, lexicalChunks, options.topK);
}

async function decideRetryQuery(
  originalQuestion: string,
  attempts: SearchAttempt[],
  options: Pick<RagSearchOptions, "ollamaUrl" | "chatModel">
): Promise<RetrievalRewriteDecision> {
  const lastAttempt = attempts.at(-1);
  if (!lastAttempt) {
    return { retry: false, reason: "No retrieval attempts available.", query: originalQuestion };
  }

  const weakRetrieval = isWeakRetrieval(lastAttempt);
  const prompt = buildRetryQueryDecisionPrompt(originalQuestion, attempts, weakRetrieval);

  const rawResponse = await requestJsonChatCompletion(
    prompt,
    options.ollamaUrl,
    options.chatModel ?? getProjectEnv().ollamaChatModel
  );
  const parsed = safeParseJson<Partial<RetrievalRewriteDecision>>(rawResponse);
  const fallbackQuery = buildFallbackRetryQuery(originalQuestion);
  const parsedQuery = typeof parsed?.query === "string" ? parsed.query.trim() : "";
  const selectedQuery = parsedQuery || fallbackQuery;
  const parsedRetry = Boolean(parsed?.retry);

  if (weakRetrieval) {
    return {
      retry: true,
      reason: typeof parsed?.reason === "string"
        ? parsed.reason
        : "First retrieval looked weak, so a second query was generated automatically.",
      query: selectedQuery || fallbackQuery
    };
  }

  return {
    retry: parsedRetry,
    reason: typeof parsed?.reason === "string" ? parsed.reason : "Model suggested a second retrieval attempt.",
    query: selectedQuery || originalQuestion
  };
}

function flattenFirstQueryResult(result: {
  ids: string[][];
  documents?: (string | null)[][];
  metadatas?: (QueryMetadata | null)[][];
  distances?: (number | null)[][];
}, searchQuery: string): RetrievedChunk[] {
  const ids = result.ids?.[0] ?? [];
  const documents = result.documents?.[0] ?? [];
  const metadatas = result.metadatas?.[0] ?? [];
  const distances = result.distances?.[0] ?? [];

  return ids.map((id, index) => ({
    id,
    document: documents[index] ?? "",
    metadata: metadatas[index] ?? null,
    distance: typeof distances[index] === "number" ? distances[index] : null,
    searchQuery
  }));
}

function retrieveLexicalChunks(searchQuery: string, topK: number): RetrievedChunk[] {
  const env = getProjectEnv();
  const manifestChunks = getChunkManifestEntries();
  const queryTerms = normalizeTerms(searchQuery);
  const requiredTerms = extractRequiredTerms(searchQuery);

  return manifestChunks
    .map((chunk) => {
      const combinedText = `${chunk.heading ?? ""} ${chunk.text}`;
      const loweredCombined = combinedText.toLowerCase();
      const lexicalScore = lexicalSignal(searchQuery, combinedText);
      const requiredScore = requiredTerms.length === 0
        ? 0
        : requiredTerms.filter((term) => loweredCombined.includes(term)).length / requiredTerms.length;
      const headingBoost = queryTerms.some((term) => (chunk.heading ?? "").toLowerCase().includes(term))
        ? env.retrievalLexicalHeadingBoost
        : 0;
      const exactPhraseBoost = loweredCombined.includes(searchQuery.toLowerCase())
        ? env.retrievalLexicalExactPhraseBoost
        : 0;
      const score = lexicalScore + requiredScore * env.retrievalLexicalRequiredWeight + headingBoost + exactPhraseBoost;

      return {
        id: chunk.id,
        document: chunk.text,
        metadata: chunkToQueryMetadata(chunk),
        distance: score > 0 ? Math.max(env.retrievalDistanceFloor, 1 - Math.min(score, env.retrievalDistanceCap)) : null,
        searchQuery,
        lexicalScore: score
      } satisfies RetrievedChunk;
    })
    .filter((chunk) => (chunk.lexicalScore ?? 0) >= env.retrievalLexicalMinScore)
    .sort((left, right) => (right.lexicalScore ?? 0) - (left.lexicalScore ?? 0))
    .slice(0, topK);
}

function mergeRetrievedChunks(
  vectorChunks: RetrievedChunk[],
  lexicalChunks: RetrievedChunk[],
  topK: number
): RetrievedChunk[] {
  const merged = new Map<string, RetrievedChunk>();

  for (const chunk of [...vectorChunks, ...lexicalChunks]) {
    const existing = merged.get(chunk.id);
    if (!existing) {
      merged.set(chunk.id, chunk);
      continue;
    }

    const existingDistance = existing.distance ?? Number.POSITIVE_INFINITY;
    const nextDistance = chunk.distance ?? Number.POSITIVE_INFINITY;
    if (nextDistance < existingDistance) {
      merged.set(chunk.id, chunk);
    }
  }

  const rankedChunks = [...merged.values()]
    .sort((left, right) => rankChunk(right) - rankChunk(left))
    .slice(0, topK * 2);

  return deduplicateRetrievedChunks(rankedChunks).slice(0, topK);
}

function isWeakRetrieval(attempt: SearchAttempt): boolean {
  const env = getProjectEnv();
  if (attempt.chunks.length === 0) {
    return true;
  }

  const bestDistance = attempt.chunks[0]?.distance ?? Number.POSITIVE_INFINITY;
  const averageLexical = attempt.chunks
    .slice(0, 5)
    .reduce((sum, chunk) => sum + lexicalSignal(attempt.query, `${chunk.metadata?.heading ?? ""} ${chunk.document}`), 0) /
    Math.min(attempt.chunks.length, 5);

  return (
    bestDistance > env.weakRetrievalBestDistanceThreshold ||
    averageLexical < env.weakRetrievalAverageLexicalThreshold
  );
}

function buildFallbackRetryQuery(question: string): string {
  const terms = normalizeTerms(question);

  return terms.join(" ");
}

function deduplicateRetrievedChunks(chunks: RetrievedChunk[]): RetrievedChunk[] {
  const deduplicated: RetrievedChunk[] = [];

  for (const chunk of chunks) {
    const duplicate = deduplicated.some((existing) => isNearDuplicateChunk(existing, chunk));
    if (!duplicate) {
      deduplicated.push(chunk);
    }
  }

  return deduplicated;
}

function isNearDuplicateChunk(left: RetrievedChunk, right: RetrievedChunk): boolean {
  const leftSource = left.metadata?.source_path ?? left.metadata?.source ?? "";
  const rightSource = right.metadata?.source_path ?? right.metadata?.source ?? "";
  if (leftSource !== rightSource) {
    return false;
  }

  const leftHeading = left.metadata?.heading ?? "";
  const rightHeading = right.metadata?.heading ?? "";
  if (leftHeading !== rightHeading) {
    return false;
  }

  const leftNormalized = normalizeChunkDocument(left.document);
  const rightNormalized = normalizeChunkDocument(right.document);
  if (!leftNormalized || !rightNormalized) {
    return false;
  }

  if (leftNormalized === rightNormalized) {
    return true;
  }

  const shorter = leftNormalized.length <= rightNormalized.length ? leftNormalized : rightNormalized;
  const longer = shorter === leftNormalized ? rightNormalized : leftNormalized;
  if (shorter.length >= 120 && longer.includes(shorter)) {
    return true;
  }

  const similarity = computeTokenJaccard(leftNormalized, rightNormalized);
  return similarity >= 0.82;
}

function normalizeChunkDocument(document: string): string {
  return document.replace(/\s+/g, " ").trim().toLowerCase();
}

function computeTokenJaccard(left: string, right: string): number {
  const leftTokens = new Set(tokenizeLoose(left));
  const rightTokens = new Set(tokenizeLoose(right));
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      intersection += 1;
    }
  }

  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union === 0 ? 0 : intersection / union;
}
