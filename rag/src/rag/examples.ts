import { chunkToQueryMetadata, getChunkManifestEntries } from "../shared/manifests.ts";
import { getProjectEnv } from "../env.ts";
import type { Chunk } from "../models/chunk.models.ts";
import type { RetrievedChunk } from "../models/retrieval.models.ts";
import { rankChunk } from "./scoring.ts";
import {
  extractRequiredTerms,
  lexicalSignal,
  stripExampleBoilerplate,
  tokenizeLoose
} from "./text.ts";

export function augmentWithRelatedExamples(question: string, chunks: RetrievedChunk[]): RetrievedChunk[] {
  if (chunks.length === 0) {
    return chunks;
  }

  const merged = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  const manifestChunks = getChunkManifestEntries();
  const informationalChunks = chunks
    .filter((chunk) => !chunk.metadata?.has_code)
    .sort((left, right) => rankChunk(right) - rankChunk(left))
    .slice(0, 3);

  for (const infoChunk of informationalChunks) {
    const sourcePath = infoChunk.metadata?.source_path ?? infoChunk.metadata?.source;
    const heading = infoChunk.metadata?.heading;
    if (!sourcePath || !heading) {
      continue;
    }

    const linkedExamples = manifestChunks
      .filter((chunk) =>
        chunk.hasCode &&
        chunk.sourcePath === sourcePath &&
        chunk.heading === heading
      )
      .map((chunk) => manifestChunkToRetrievedChunk(chunk, question))
      .sort((left, right) => scoreExampleLink(right, infoChunk, question) - scoreExampleLink(left, infoChunk, question));

    const bestLinkedExample = linkedExamples[0];
    if (bestLinkedExample) {
      merged.set(bestLinkedExample.id, bestLinkedExample);
    }
  }

  return [...merged.values()].sort((left, right) => rankChunk(right) - rankChunk(left));
}

export function findBestExampleChunk(question: string, chunks: RetrievedChunk[]): RetrievedChunk | null {
  const bestSelectedCodeChunk = selectBestFitExampleChunk(question, chunks);
  if (bestSelectedCodeChunk) {
    return bestSelectedCodeChunk;
  }

  const sectionLinkedCodeChunk = findSectionLinkedExample(question, chunks);
  return sectionLinkedCodeChunk;
}

export function buildSupplementalExample(question: string, chunks: RetrievedChunk[]): string | null {
  const bestExampleChunk = findBestExampleChunk(question, chunks);
  if (!bestExampleChunk) {
    return null;
  }

  return [
    `Example from [${bestExampleChunk.id}]:`,
    "",
    bestExampleChunk.document
  ].join("\n");
}

export function manifestChunkToRetrievedChunk(chunk: Chunk, searchQuery: string): RetrievedChunk {
  const env = getProjectEnv();
  const combinedText = `${chunk.heading ?? ""} ${chunk.text}`;
  const score = lexicalSignal(searchQuery, combinedText);

  return {
    id: chunk.id,
    document: chunk.text,
    metadata: chunkToQueryMetadata(chunk),
    distance: score > 0 ? Math.max(env.retrievalDistanceFloor, 1 - Math.min(score, env.retrievalDistanceCap)) : null,
    searchQuery
  };
}

function selectBestFitExampleChunk(question: string, chunks: RetrievedChunk[]): RetrievedChunk | null {
  const env = getProjectEnv();
  const scoredCodeChunks = chunks
    .filter((chunk) => chunk.metadata?.has_code)
    .map((chunk) => ({
      chunk,
      score: scoreSelectedChunkFit(question, chunk, chunks)
    }))
    .sort((left, right) => right.score - left.score);

  const best = scoredCodeChunks[0];
  if (!best || best.score < env.exampleBestFitThreshold) {
    return null;
  }

  return best.chunk;
}

function scoreSelectedChunkFit(
  question: string,
  candidate: RetrievedChunk,
  selectedChunks: RetrievedChunk[]
): number {
  const env = getProjectEnv();
  const headingScore = lexicalSignal(question, candidate.metadata?.heading ?? "");
  const contentScore = lexicalSignal(question, stripExampleBoilerplate(candidate.document));
  const baseRank = rankChunk(candidate);
  const requiredTerms = extractRequiredTerms(question);
  const candidateTokens = tokenizeLoose(`${candidate.metadata?.heading ?? ""} ${stripExampleBoilerplate(candidate.document)}`);
  const requiredCoverage = requiredTerms.length === 0
    ? 0
    : requiredTerms.filter((term) => hasLooseTermMatch(term, candidateTokens)).length / requiredTerms.length;
  const relatedSupport = scoreRelatedSupport(candidate, selectedChunks, question);
  const exactHeadingMatch = headingScore >= env.exampleExactHeadingThreshold ? env.exampleExactHeadingBoost : 0;

  return (
    headingScore * env.exampleHeadingWeight +
    contentScore * env.exampleContentWeight +
    requiredCoverage * env.exampleRequiredCoverageWeight +
    relatedSupport +
    exactHeadingMatch +
    baseRank * env.exampleBaseRankWeight
  );
}

function scoreRelatedSupport(candidate: RetrievedChunk, selectedChunks: RetrievedChunk[], question: string): number {
  const env = getProjectEnv();
  const sourcePath = candidate.metadata?.source_path ?? candidate.metadata?.source;
  const heading = candidate.metadata?.heading;
  if (!sourcePath || !heading) {
    return 0;
  }

  const siblingTextChunks = selectedChunks.filter((chunk) =>
    !chunk.metadata?.has_code &&
    (chunk.metadata?.source_path ?? chunk.metadata?.source) === sourcePath &&
    chunk.metadata?.heading === heading
  );

  const siblingTextSupport = siblingTextChunks.length === 0
    ? 0
    : Math.max(...siblingTextChunks.map((chunk) =>
        lexicalSignal(question, `${chunk.metadata?.heading ?? ""} ${chunk.document}`)
      ));

  const sameFileSupport = selectedChunks
    .filter((chunk) =>
      !chunk.metadata?.has_code &&
      (chunk.metadata?.source_path ?? chunk.metadata?.source) === sourcePath
    )
    .map((chunk) => scoreExampleLink(candidate, chunk, question));

  const bestSameFileSupport = sameFileSupport.length === 0 ? 0 : Math.max(...sameFileSupport) * env.exampleSameFileSupportWeight;

  return siblingTextSupport * env.exampleSiblingSupportWeight + bestSameFileSupport;
}

function findSectionLinkedExample(question: string, chunks: RetrievedChunk[]): RetrievedChunk | null {
  const env = getProjectEnv();
  const informationalAnchors = chunks
    .filter((chunk) => !chunk.metadata?.has_code)
    .map((chunk) => ({
      chunk,
      score: lexicalSignal(question, `${chunk.metadata?.heading ?? ""} ${stripExampleBoilerplate(chunk.document)}`),
      headingScore: lexicalSignal(question, chunk.metadata?.heading ?? "")
    }))
    .sort((left, right) => {
      if (right.headingScore !== left.headingScore) {
        return right.headingScore - left.headingScore;
      }

      return right.score - left.score;
    });

  for (const entry of informationalAnchors) {
    const sourcePath = entry.chunk.metadata?.source_path ?? entry.chunk.metadata?.source;
    const heading = entry.chunk.metadata?.heading;
    if (!sourcePath || !heading) {
      continue;
    }

    const siblingCodeChunks = chunks
      .filter((chunk) =>
        chunk.metadata?.has_code &&
        (chunk.metadata?.source_path ?? chunk.metadata?.source) === sourcePath &&
        chunk.metadata?.heading === heading
      )
      .sort((left, right) =>
        scoreExampleLink(right, entry.chunk, question) - scoreExampleLink(left, entry.chunk, question)
      );

    const bestSibling = siblingCodeChunks[0];
    if (
      bestSibling &&
      (
        entry.score >= env.exampleAnchorMinScore ||
        entry.headingScore >= env.exampleAnchorMinHeadingScore ||
        entry.chunk.metadata?.has_code
      )
    ) {
      return bestSibling;
    }
  }

  return null;
}

function scoreExampleLink(exampleChunk: RetrievedChunk, anchorChunk: RetrievedChunk, question: string): number {
  const env = getProjectEnv();
  const baseRank = rankChunk(exampleChunk);
  const headingMatch = lexicalSignal(question, exampleChunk.metadata?.heading ?? "");
  const sameHeading = exampleChunk.metadata?.heading === anchorChunk.metadata?.heading ? env.exampleSameHeadingBoost : 0;
  const sameNearestText = exampleChunk.metadata?.nearest_text_chunk_id != null &&
    exampleChunk.metadata.nearest_text_chunk_id === anchorChunk.id
    ? env.exampleNearestTextBoost
    : 0;
  const sameFile = (
    (exampleChunk.metadata?.source_path ?? exampleChunk.metadata?.source) ===
    (anchorChunk.metadata?.source_path ?? anchorChunk.metadata?.source)
  ) ? env.exampleSameFileBoost : 0;
  const fileDistance = (
    exampleChunk.metadata?.file_order != null &&
    anchorChunk.metadata?.file_order != null
  )
    ? Math.abs(exampleChunk.metadata.file_order - anchorChunk.metadata.file_order)
    : null;
  const distanceBoost = fileDistance == null
    ? 0
    : Math.max(0, env.exampleFileDistanceBaseBoost - fileDistance * env.exampleFileDistanceDecay);

  return baseRank + headingMatch * env.exampleHeadingMatchWeight + sameHeading + sameNearestText + sameFile + distanceBoost;
}

function hasLooseTermMatch(term: string, textTokens: string[]): boolean {
  const normalizedTerm = term.toLowerCase();
  if (textTokens.includes(normalizedTerm)) {
    return true;
  }

  const maxDistance = normalizedTerm.length >= 7 ? 2 : 1;
  return textTokens.some((token) => editDistanceWithin(normalizedTerm, token, maxDistance));
}

function editDistanceWithin(left: string, right: string, maxDistance: number): boolean {
  return computeEditDistance(left, right, maxDistance) <= maxDistance;
}

function computeEditDistance(left: string, right: string, maxDistance = Number.POSITIVE_INFINITY): number {
  if (left === right) {
    return 0;
  }

  if (Math.abs(left.length - right.length) > maxDistance) {
    return maxDistance + 1;
  }

  const rows = left.length + 1;
  const cols = right.length + 1;
  const dp: number[][] = Array.from({ length: rows }, () => Array<number>(cols).fill(0));

  for (let i = 0; i < rows; i += 1) {
    dp[i][0] = i;
  }

  for (let j = 0; j < cols; j += 1) {
    dp[0][j] = j;
  }

  for (let i = 1; i < rows; i += 1) {
    let rowMin = Number.POSITIVE_INFINITY;

    for (let j = 1; j < cols; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );

      if (
        i > 1 &&
        j > 1 &&
        left[i - 1] === right[j - 2] &&
        left[i - 2] === right[j - 1]
      ) {
        dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1);
      }

      rowMin = Math.min(rowMin, dp[i][j]);
    }

    if (rowMin > maxDistance) {
      return maxDistance + 1;
    }
  }

  return dp[left.length][right.length];
}
