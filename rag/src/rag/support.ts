import { getProjectEnv } from "../env.ts";
import type {
  RetrievedChunk,
  SupportChunkSelectionDecision
} from "../models/retrieval.models.ts";
import { buildSupportChunkSelectionPrompt } from "../prompts/support.prompts.ts";
import { safeParseJson } from "../shared/json.ts";
import { chunkToQueryMetadata, getChunkManifestEntries } from "../shared/manifests.ts";
import { requestJsonChatCompletion } from "../shared/ollama.ts";
import { rankChunk } from "./scoring.ts";
import {
  extractRequiredTerms,
  lexicalSignal,
  stripExampleBoilerplate,
  tokenizeLoose
} from "./text.ts";

export async function selectSupportChunks(
  retrievalQuestion: string,
  answerInstruction: string,
  rankedChunks: RetrievedChunk[],
  options: { ollamaUrl: string; chatModel?: string }
): Promise<RetrievedChunk[]> {
  if (rankedChunks.length === 0) {
    return [];
  }

  const env = getProjectEnv();
  const candidateChunks = rankedChunks.slice(0, env.askSupportSelectionCandidateCount);
  const fallbackChunks = selectSupportChunksFallback(retrievalQuestion, candidateChunks);

  if (!options.chatModel) {
    return fallbackChunks;
  }

  const prompt = buildSupportChunkSelectionPrompt(
    retrievalQuestion,
    answerInstruction,
    candidateChunks,
    env.askSupportSelectionMaxChunks,
    (chunk) => ({
      retrievalScore: rankChunk(chunk),
      supportScore: scoreSupportChunk(retrievalQuestion, chunk)
    }),
    stripExampleBoilerplate
  );

  try {
    const rawResponse = await requestJsonChatCompletion(
      prompt,
      options.ollamaUrl,
      options.chatModel
    );
    const parsed = safeParseJson<Partial<SupportChunkSelectionDecision>>(rawResponse);
    const selectedIds = Array.isArray(parsed?.selected_chunk_ids)
      ? parsed.selected_chunk_ids.filter((value): value is string => typeof value === "string")
      : [];
    const selectedSet = new Set(selectedIds);
    const selectedChunks = sortSupportChunks(
      retrievalQuestion,
      filterStrongSupportChunks(
        retrievalQuestion,
        candidateChunks.filter((chunk) => selectedSet.has(chunk.id))
      )
    );

    if (selectedChunks.length > 0) {
      const finalSelection = preferHigherScoringSupportSelection(
        retrievalQuestion,
        selectedChunks.slice(0, env.askSupportSelectionMaxChunks),
        fallbackChunks
      );
      return expandSupportChunksWithNeighbors(retrievalQuestion, finalSelection);
    }
  } catch {
    return expandSupportChunksWithNeighbors(retrievalQuestion, fallbackChunks);
  }

  return expandSupportChunksWithNeighbors(retrievalQuestion, fallbackChunks);
}

function selectSupportChunksFallback(
  retrievalQuestion: string,
  candidateChunks: RetrievedChunk[]
): RetrievedChunk[] {
  const env = getProjectEnv();
  const supportCandidates = filterStrongSupportChunks(retrievalQuestion, candidateChunks);
  const sortedChunks = sortSupportChunks(
    retrievalQuestion,
    supportCandidates.length > 0 ? supportCandidates : candidateChunks
  );
  const textChunks = sortedChunks.filter((chunk) => !chunk.metadata?.has_code);
  const codeChunks = sortedChunks.filter((chunk) => chunk.metadata?.has_code);
  const selected: RetrievedChunk[] = [];

  for (const chunk of textChunks) {
    if (selected.length >= env.askSupportSelectionMaxChunks) {
      break;
    }

    selected.push(chunk);
  }

  for (const chunk of codeChunks) {
    if (selected.length >= env.askSupportSelectionMaxChunks) {
      break;
    }

    if (selected.some((selectedChunk) => selectedChunk.metadata?.heading === chunk.metadata?.heading)) {
      selected.push(chunk);
      break;
    }
  }

  if (selected.length > 0) {
    return selected;
  }

  return sortedChunks.slice(0, env.askSupportSelectionMaxChunks);
}

function scoreSupportChunk(question: string, chunk: RetrievedChunk): number {
  const heading = chunk.metadata?.heading ?? "";
  const source = (chunk.metadata?.source_path ?? chunk.metadata?.source ?? "").replace(/[\\/_.-]+/g, " ");
  const text = `${heading} ${stripExampleBoilerplate(chunk.document)}`;
  const lexical = lexicalSignal(question, text);
  const headingLexical = lexicalSignal(question, heading);
  const sourceLexical = lexicalSignal(question, source);
  const baseRank = rankChunk(chunk);
  const codePenalty = chunk.metadata?.has_code ? 0.05 : 0;
  return baseRank + lexical + headingLexical * 0.6 + sourceLexical * 0.3 - codePenalty;
}

function sortSupportChunks(question: string, chunks: RetrievedChunk[]): RetrievedChunk[] {
  return [...chunks].sort((left, right) => scoreSupportChunk(question, right) - scoreSupportChunk(question, left));
}

function preferHigherScoringSupportSelection(
  question: string,
  llmSelection: RetrievedChunk[],
  fallbackSelection: RetrievedChunk[]
): RetrievedChunk[] {
  if (llmSelection.length === 0) {
    return fallbackSelection;
  }

  const llmAverageScore = averageSupportScore(question, llmSelection);
  const fallbackAverageScore = averageSupportScore(question, fallbackSelection);

  return llmAverageScore >= fallbackAverageScore ? llmSelection : fallbackSelection;
}

function averageSupportScore(question: string, chunks: RetrievedChunk[]): number {
  if (chunks.length === 0) {
    return Number.NEGATIVE_INFINITY;
  }

  const total = chunks.reduce((sum, chunk) => sum + scoreSupportChunk(question, chunk), 0);
  return total / chunks.length;
}

function expandSupportChunksWithNeighbors(
  question: string,
  selectedChunks: RetrievedChunk[]
): RetrievedChunk[] {
  const env = getProjectEnv();
  if (
    selectedChunks.length === 0 ||
    env.askSupportNeighborWindow <= 0 ||
    env.askSupportNeighborMaxChunks <= 0
  ) {
    return selectedChunks;
  }

  const manifestChunks = getChunkManifestEntries();
  const manifestById = new Map(manifestChunks.map((chunk) => [chunk.id, chunk]));
  const selectedIds = new Set(selectedChunks.map((chunk) => chunk.id));
  const neighborCandidates = new Map<string, { chunk: RetrievedChunk; score: number }>();

  for (const selectedChunk of selectedChunks) {
    const selectedManifestChunk = manifestById.get(selectedChunk.id);
    if (!selectedManifestChunk || !shouldInspectNeighbors(question, selectedChunk)) {
      continue;
    }

    for (const neighborId of getNeighborChunkIds(selectedManifestChunk.id, manifestById, env.askSupportNeighborWindow)) {
      if (selectedIds.has(neighborId) || neighborCandidates.has(neighborId)) {
        continue;
      }

      const neighborManifestChunk = manifestById.get(neighborId);
      if (!neighborManifestChunk) {
        continue;
      }

      const neighbor = {
        id: neighborManifestChunk.id,
        document: neighborManifestChunk.text,
        metadata: chunkToQueryMetadata(neighborManifestChunk),
        distance: null,
        searchQuery: question,
        lexicalScore: lexicalSignal(question, `${neighborManifestChunk.heading} ${neighborManifestChunk.text}`)
      } satisfies RetrievedChunk;
      const score = scoreNeighborChunk(question, selectedChunk, neighbor);

      if (score > 0) {
        neighborCandidates.set(neighbor.id, { chunk: neighbor, score });
      }
    }
  }

  const neighbors = [...neighborCandidates.values()]
    .sort((left, right) => right.score - left.score)
    .slice(0, env.askSupportNeighborMaxChunks)
    .map((candidate) => candidate.chunk);

  return sortByDocumentPosition(removeNearDuplicateSupportChunks([...selectedChunks, ...neighbors]));
}

function shouldInspectNeighbors(question: string, chunk: RetrievedChunk): boolean {
  return scoreSupportChunk(question, chunk) > 0;
}

function getNeighborChunkIds(
  chunkId: string,
  manifestById: Map<string, { previousChunkId: string | null; nextChunkId: string | null }>,
  window: number
): string[] {
  const ids: string[] = [];
  let previousId = manifestById.get(chunkId)?.previousChunkId ?? null;
  let nextId = manifestById.get(chunkId)?.nextChunkId ?? null;

  for (let distance = 0; distance < window; distance += 1) {
    if (previousId) {
      ids.push(previousId);
      previousId = manifestById.get(previousId)?.previousChunkId ?? null;
    }

    if (nextId) {
      ids.push(nextId);
      nextId = manifestById.get(nextId)?.nextChunkId ?? null;
    }
  }

  return ids;
}

function scoreNeighborChunk(question: string, anchor: RetrievedChunk, neighbor: RetrievedChunk): number {
  const sameSource = getChunkSource(anchor) === getChunkSource(neighbor);
  if (!sameSource) {
    return 0;
  }

  const text = `${neighbor.metadata?.heading ?? ""} ${stripExampleBoilerplate(neighbor.document)}`;
  const lexical = lexicalSignal(question, text);
  const requiredTerms = extractRequiredTerms(question);
  const tokens = tokenizeLoose(text);
  const requiredCoverage = requiredTerms.length === 0
    ? 0
    : requiredTerms.filter((term) => tokens.includes(term)).length / requiredTerms.length;

  return lexical + requiredCoverage;
}

function sortByDocumentPosition(chunks: RetrievedChunk[]): RetrievedChunk[] {
  return [...chunks].sort((left, right) => {
    const sourceCompare = getChunkSource(left).localeCompare(getChunkSource(right));
    if (sourceCompare !== 0) {
      return sourceCompare;
    }

    return getChunkIndex(left) - getChunkIndex(right);
  });
}

function removeNearDuplicateSupportChunks(chunks: RetrievedChunk[]): RetrievedChunk[] {
  const deduplicated: RetrievedChunk[] = [];

  for (const chunk of chunks) {
    const duplicate = deduplicated.some((existing) => {
      if (getChunkSource(existing) !== getChunkSource(chunk)) {
        return false;
      }

      const existingText = normalizeSupportText(existing.document);
      const chunkText = normalizeSupportText(chunk.document);
      return existingText === chunkText || existingText.includes(chunkText) || chunkText.includes(existingText);
    });

    if (!duplicate) {
      deduplicated.push(chunk);
    }
  }

  return deduplicated;
}

function normalizeSupportText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function getChunkSource(chunk: RetrievedChunk): string {
  return chunk.metadata?.source_path ?? chunk.metadata?.source ?? "";
}

function getChunkIndex(chunk: RetrievedChunk): number {
  return typeof chunk.metadata?.chunk_index === "number"
    ? chunk.metadata.chunk_index
    : Number.POSITIVE_INFINITY;
}

function filterStrongSupportChunks(question: string, chunks: RetrievedChunk[]): RetrievedChunk[] {
  const requiredTerms = extractRequiredTerms(question);
  if (requiredTerms.length === 0) {
    return chunks.filter((chunk) => lexicalSignal(question, `${chunk.metadata?.heading ?? ""} ${chunk.document}`) > 0);
  }

  return chunks.filter((chunk) => {
    const tokens = tokenizeLoose(`${chunk.metadata?.heading ?? ""} ${stripExampleBoilerplate(chunk.document)}`);
    return requiredTerms.some((term) => tokens.includes(term));
  });
}
