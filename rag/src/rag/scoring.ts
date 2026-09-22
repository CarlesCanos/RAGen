import { getProjectEnv } from "../env.ts";
import type { RetrievedChunk } from "../models/retrieval.models.ts";
import { extractRequiredTerms, isExampleSeekingQuery, lexicalSignal, stripExampleBoilerplate, tokenizeLoose } from "./text.ts";

export function rankChunk(chunk: RetrievedChunk): number {
  const env = getProjectEnv();
  const distanceScore = chunk.distance === null ? 0 : -chunk.distance;
  const heading = chunk.metadata?.heading ?? "";
  const source = (chunk.metadata?.source_path ?? chunk.metadata?.source ?? "").replace(/[\\/_.-]+/g, " ");
  const body = stripExampleBoilerplate(chunk.document);
  const keywordScore = lexicalSignal(chunk.searchQuery, `${heading} ${body}`);
  const headingScore = lexicalSignal(chunk.searchQuery, heading);
  const sourceScore = lexicalSignal(chunk.searchQuery, source);
  const requiredCoverageScore = getRequiredCoverageScore(chunk.searchQuery, `${heading} ${source} ${body}`);
  const exampleScore = isExampleSeekingQuery(chunk.searchQuery)
    ? (chunk.metadata?.has_code ? env.rankingCodeExampleBonus : env.rankingTextExampleBonus)
    : 0;
  const languageScore = isExampleSeekingQuery(chunk.searchQuery) && chunk.metadata?.code_language === "html"
    ? env.rankingHtmlBonus
    : 0;
  const proximityScore = getIntrinsicProximityScore(chunk);
  return (
    distanceScore +
    keywordScore * env.rankingKeywordWeight +
    headingScore * env.retrievalLexicalHeadingBoost +
    sourceScore * (env.retrievalLexicalHeadingBoost / 2) +
    requiredCoverageScore * env.retrievalLexicalRequiredWeight +
    exampleScore +
    languageScore +
    proximityScore
  );
}

export function getIntrinsicProximityScore(chunk: RetrievedChunk): number {
  const env = getProjectEnv();
  if (!chunk.metadata?.has_code) {
    return 0;
  }

  const distance = chunk.metadata.nearest_text_distance;
  if (distance == null) {
    return 0;
  }

  if (distance === 0) {
    return env.rankingIntrinsicProximityBase;
  }

  return Math.max(0, env.rankingIntrinsicProximityBase - distance * env.rankingIntrinsicProximityDecay);
}

function getRequiredCoverageScore(question: string, text: string): number {
  const requiredTerms = extractRequiredTerms(question);
  if (requiredTerms.length === 0) {
    return 0;
  }

  const tokens = tokenizeLoose(text);
  const matchedCount = requiredTerms.filter((term) => tokens.includes(term)).length;
  return matchedCount / requiredTerms.length;
}
