import { requestJsonChatCompletion } from "../shared/ollama.ts";
import { safeParseJson } from "../shared/json.ts";
import { getProjectEnv } from "../env.ts";
import type { RetrievedChunk } from "../models/retrieval.models.ts";
import { buildNormalizeSearchQueryPrompt } from "../prompts/text.prompts.ts";
import { readRagRules } from "../shared/ragRules.ts";

export function lexicalSignal(query: string, text: string): number {
  const queryTerms = normalizeTerms(query);
  if (queryTerms.length === 0) {
    return 0;
  }

  const haystackTerms = new Set(tokenizeLoose(normalizeLexicalHaystack(text)));
  let hits = 0;
  for (const term of queryTerms) {
    if (haystackTerms.has(term)) {
      hits += 1;
    }
  }

  return hits / queryTerms.length;
}

export function normalizeLexicalHaystack(text: string): string {
  return stripExampleBoilerplate(text)
    .toLowerCase()
    .replace(/[^\p{L}0-9\s]/gu, " ")
    .split(/\s+/)
    .map((token) => canonicalizeToken(token))
    .filter(Boolean)
    .join(" ");
}

export function stripExampleBoilerplate(text: string): string {
  return text.replace(/^Example from section:[^\n]*\n+/i, "");
}

export function tokenizeLoose(text: string): string[] {
  return [...new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}0-9\s]/gu, " ")
      .split(/\s+/)
      .map((term) => canonicalizeToken(term))
      .filter((term) => term.length >= 2)
  )];
}

export function tokenizeQuestionForNormalization(text: string): string[] {
  return text.match(/@[\p{L}0-9_]+|[\p{L}0-9_.-]+|\s+|[^\s\p{L}0-9_.-]+/gu) ?? [text];
}

export function normalizeTerms(text: string): string[] {
  const stopWords = new Set(readRagRules().lexicalStopWords.map((term) => canonicalizeToken(term)));

  return [...new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}0-9\s]/gu, " ")
      .split(/\s+/)
      .map((term) => canonicalizeToken(term))
      .filter((term) => term.length >= 3 && !stopWords.has(term))
  )];
}

export function extractProtectedTerms(text: string): string[] {
  const ignoredTerms = new Set([
    ...readRagRules().lexicalStopWords,
    ...readRagRules().requiredTermIgnoredWords
  ].map((term) => canonicalizeToken(term)));
  const tokens = text.match(/@?[\p{L}0-9_.-]+/gu) ?? [];

  return [...new Set(
    tokens
      .filter((token) => /^\p{Lu}/u.test(token))
      .map((token) => canonicalizeToken(token.replace(/^@/, "")))
      .filter((token) => token.length >= 2 && !ignoredTerms.has(token))
  )];
}

export async function normalizeSearchQuery(
  question: string,
  options: { ollamaUrl: string; chatModel?: string }
): Promise<string> {
  const fallback = normalizeSearchQueryFallback(question);
  if (!options.chatModel) {
    return fallback;
  }

  const prompt = buildNormalizeSearchQueryPrompt(question);

  try {
    const rawResponse = await requestJsonChatCompletion(prompt, options.ollamaUrl, options.chatModel);
    const parsed = safeParseJson<{ normalized_question?: string }>(rawResponse);
    const normalized = parsed?.normalized_question?.trim();
    if (!normalized) {
      return fallback;
    }

    const normalizedFallback = normalizeSearchQueryFallback(normalized);
    return isSafeNormalizedQuery(question, normalizedFallback)
      ? normalizedFallback
      : fallback;
  } catch {
    return fallback;
  }
}

export function normalizeSearchQueryFallback(question: string): string {
  return tokenizeQuestionForNormalization(question)
    .map((token) => {
      if (!/[A-Za-z0-9@]/.test(token) || /^\s+$/.test(token)) {
        return token;
      }

      return applyAliasNormalization(token);
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

export function canonicalizeToken(token: string): string {
  const normalized = token
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
  if (!normalized) {
    return "";
  }

  if (normalized.endsWith("ies") && normalized.length > 4) {
    return `${normalized.slice(0, -3)}y`;
  }

  if (normalized.endsWith("ses") && normalized.length > 4) {
    return normalized.slice(0, -2);
  }

  if (normalized.endsWith("s") && !normalized.endsWith("ss") && normalized.length > 4) {
    return normalized.slice(0, -1);
  }

  return normalized;
}

export function extractRequiredTerms(question: string): string[] {
  const ragRules = readRagRules();
  const rawTokens = (question.match(/[\p{L}0-9_.-]+/gu) ?? [])
    .flatMap((token) => token.split(/[_.-]+/g).filter(Boolean));
  const syntaxTokens = question.match(/@[\p{L}0-9_]+/gu) ?? [];
  const ignoredTerms = new Set(ragRules.requiredTermIgnoredWords.map((term) => canonicalizeToken(term)));
  return [...new Set(
    [
      ...syntaxTokens.map((token) => token.slice(1)),
      ...rawTokens
    ]
      .map((token) => token.trim())
      .filter((token) => token.length >= 3)
      .filter((token) =>
        /[A-Z]/.test(token) ||
        /\d/.test(token) ||
        token.length >= 6 ||
        token.startsWith("ng") ||
        syntaxTokens.some((syntaxToken) => syntaxToken.slice(1).toLowerCase() === token.toLowerCase())
      )
      .map((token) => token.toLowerCase())
      .filter((token) => !ignoredTerms.has(token))
  )];
}

export function answerAddressesQuestion(question: string, answer: string, chunks: RetrievedChunk[]): boolean {
  const requiredTerms = extractRequiredTerms(question);
  const broadQuestion = isBroadDocumentationQuestion(question, requiredTerms);
  if (broadQuestion) {
    return true;
  }

  const questionTerms = normalizeTerms(question);
  const focusTerms = [...new Set([...requiredTerms, ...questionTerms])];
  if (focusTerms.length === 0) {
    return answer.trim().length > 0;
  }

  const answerTokens = tokenizeLoose(answer);
  const contextTokens = tokenizeLoose(
    chunks.map((chunk) => `${chunk.metadata?.heading ?? ""} ${chunk.document}`).join(" ")
  );

  const supportedFocusTerms = focusTerms.filter((term) => hasLooseTermMatch(term, contextTokens));
  if (supportedFocusTerms.length === 0) {
    return false;
  }

  return supportedFocusTerms.some((term) => hasLooseTermMatch(term, answerTokens));
}

export function hasSufficientContext(question: string, chunks: RetrievedChunk[]): boolean {
  if (chunks.length === 0) {
    return false;
  }

  const questionTerms = normalizeTerms(question);
  const requiredTerms = extractRequiredTerms(question);
  const broadQuestion = isBroadDocumentationQuestion(question, requiredTerms);
  const bestDistance = chunks[0]?.distance ?? Number.POSITIVE_INFINITY;
  const combinedContextTokens = tokenizeLoose(
    chunks.map((chunk) => `${chunk.metadata?.heading ?? ""} ${chunk.document}`).join(" ")
  );
  const env = getProjectEnv();

  if (questionTerms.length === 0 && requiredTerms.length === 0) {
    return broadQuestion && bestDistance <= env.answerBroadQuestionFallbackDistanceThreshold;
  }

  if (requiredTerms.length > 0) {
    const allRequiredTermsMatch = requiredTerms.every((term) => hasLooseTermMatch(term, combinedContextTokens));
    if (!allRequiredTermsMatch) {
      return false;
    }
  }

  const hasQuestionTermMatch = questionTerms.length === 0
    ? broadQuestion
    : questionTerms.some((term) => hasLooseTermMatch(term, combinedContextTokens));

  if (!hasQuestionTermMatch) {
    return broadQuestion && bestDistance <= env.answerBroadQuestionBestDistanceThreshold;
  }

  return chunks.some((chunk) => {
    const combinedText = `${chunk.metadata?.heading ?? ""} ${chunk.document}`;
    const overlap = lexicalSignal(question, combinedText);
    const distance = chunk.distance ?? Number.POSITIVE_INFINITY;
    return (
      overlap >= env.answerHasContextOverlapThreshold ||
      distance <= env.answerHasContextDistanceThreshold ||
      (broadQuestion && distance <= env.answerBroadQuestionFallbackDistanceThreshold)
    );
  });
}

export function isExampleSeekingQuery(question: string): boolean {
  const lowered = question.toLowerCase();
  return readRagRules().exampleQueryKeywords.some((pattern) => lowered.includes(pattern.toLowerCase()));
}

function applyAliasNormalization(value: string): string {
  const key = value.toLowerCase();
  return readRagRules().queryNormalizationAliases[key] ?? value;
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

function hasLooseTermMatch(term: string, textTokens: string[]): boolean {
  const normalizedTerm = term.toLowerCase();
  if (textTokens.includes(normalizedTerm)) {
    return true;
  }

  const maxDistance = normalizedTerm.length >= 7 ? 2 : 1;
  return textTokens.some((token) => editDistanceWithin(normalizedTerm, token, maxDistance));
}

function isBroadDocumentationQuestion(question: string, requiredTerms: string[]): boolean {
  const lowered = question.toLowerCase();
  if (requiredTerms.length > 0) {
    return false;
  }

  return readRagRules().broadQuestionKeywords.some((keyword) => lowered.includes(keyword.toLowerCase()));
}

function isSafeNormalizedQuery(originalQuestion: string, normalizedQuestion: string): boolean {
  const originalTerms = new Set(normalizeTerms(originalQuestion));
  const normalizedTerms = new Set(normalizeTerms(normalizedQuestion));
  const normalizedTokens = tokenizeLoose(normalizedQuestion);
  const protectedTerms = extractProtectedTerms(originalQuestion);

  if (originalTerms.size === 0 || normalizedTerms.size === 0) {
    return true;
  }

  const preservesProtectedTerms = protectedTerms.every((term) => normalizedTokens.includes(term));
  if (!preservesProtectedTerms) {
    return false;
  }

  const significantOriginalTerms = [...originalTerms].filter((term) => term.length >= 5 || /\d/.test(term));
  const preservesSignificantTerms = significantOriginalTerms.every((term) =>
    normalizedTerms.has(term) || normalizedTokens.some((token) => editDistanceWithin(term, token, term.length >= 7 ? 2 : 1))
  );
  if (!preservesSignificantTerms) {
    return false;
  }

  let overlap = 0;
  for (const term of originalTerms) {
    if (normalizedTerms.has(term)) {
      overlap += 1;
    }
  }

  const overlapRatio = overlap / originalTerms.size;
  const requiredTerms = extractRequiredTerms(originalQuestion);
  const requiredCoverage = requiredTerms.length === 0
    ? 1
    : requiredTerms.filter((term) => hasLooseTermMatch(term, normalizedTokens)).length / requiredTerms.length;

  return overlapRatio >= 0.5 && requiredCoverage >= 0.5;
}
