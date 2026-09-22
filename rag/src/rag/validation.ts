import { requestChatCompletion, requestJsonChatCompletion } from "../shared/ollama.ts";
import { safeParseJson } from "../shared/json.ts";
import { getProjectEnv } from "../env.ts";
import type { RetrievedChunk, ValidationDecision } from "../models/retrieval.models.ts";
import { buildAnswerPrompt } from "../prompts/answer.prompts.ts";
import { buildValidateAnswerPrompt } from "../prompts/validation.prompts.ts";
import { buildSupplementalExample } from "./examples.ts";
import { localizeNoInfoAnswer } from "./language.ts";
import { resolveStructuredAnswer } from "./logic/ruleEngine.ts";
import { answerAddressesQuestion, normalizeTerms } from "./text.ts";

export async function validateAnswer(
  retrievalQuestion: string,
  answerInstruction: string,
  normalizedQuestion: string,
  chunks: RetrievedChunk[],
  draftAnswer: string,
  options: { ollamaUrl: string; chatModel?: string }
): Promise<string> {
  const combinedIntent = [retrievalQuestion, answerInstruction].filter(Boolean).join(" ");
  const structuredAnswer = resolveStructuredAnswer({
    question: retrievalQuestion,
    answerInstruction,
    chunks
  });

  if (structuredAnswer) {
    return appendExampleIfAvailable(structuredAnswer, combinedIntent, chunks);
  }

  const corrected = await requestValidatedCorrection(
    retrievalQuestion,
    answerInstruction,
    normalizedQuestion,
    draftAnswer,
    chunks,
    options
  );

  if (
    isNoInfoAnswer(corrected) &&
    isSafelySupportedDateAnswer(normalizedQuestion, draftAnswer, chunks) &&
    !containsInvalidCitationPlaceholder(draftAnswer)
  ) {
    return appendExampleIfAvailable(draftAnswer.trim(), combinedIntent, chunks);
  }

  if (isNoInfoAnswer(corrected)) {
    const supportedDateAnswer = buildSupportedMultiHopDateAnswer(
      retrievalQuestion,
      answerInstruction,
      chunks
    );
    if (supportedDateAnswer) {
      return appendExampleIfAvailable(supportedDateAnswer, combinedIntent, chunks);
    }
  }

  if (corrected && answerAddressesQuestion(normalizedQuestion, corrected, chunks)) {
    if (
      !isTooShortForRequestedDetail(answerInstruction, corrected, chunks) &&
      !containsInvalidCitationPlaceholder(corrected)
    ) {
      return appendExampleIfAvailable(corrected, combinedIntent, chunks);
    }

    const expandedDraft = await expandGroundedAnswer(
      retrievalQuestion,
      answerInstruction,
      corrected,
      chunks,
      options
    );

    if (
      expandedDraft &&
      expandedDraft !== corrected &&
      answerAddressesQuestion(normalizedQuestion, expandedDraft, chunks) &&
      !isTooShortForRequestedDetail(answerInstruction, expandedDraft, chunks) &&
      !containsInvalidCitationPlaceholder(expandedDraft)
    ) {
      return appendExampleIfAvailable(expandedDraft, combinedIntent, chunks);
    }

    const expanded = await requestValidatedCorrection(
      retrievalQuestion,
      answerInstruction,
      normalizedQuestion,
      expandedDraft,
      chunks,
      options
    );

    if (
      expanded &&
      answerAddressesQuestion(normalizedQuestion, expanded, chunks) &&
      !isTooShortForRequestedDetail(answerInstruction, expanded, chunks) &&
      !containsInvalidCitationPlaceholder(expanded)
    ) {
      return appendExampleIfAvailable(expanded, combinedIntent, chunks);
    }

    if (
      !isTooShortForRequestedDetail(answerInstruction, corrected, chunks) &&
      !containsInvalidCitationPlaceholder(corrected)
    ) {
      return appendExampleIfAvailable(corrected, combinedIntent, chunks);
    }
  }

  return localizeNoInfoAnswer(getProjectEnv().askNoInfoAnswer, answerInstruction);
}

function appendExampleIfAvailable(
  answer: string,
  question: string,
  chunks: RetrievedChunk[]
): string {
  const normalizedAnswer = normalizeChunkCitations(answer, chunks);
  const noInfoAnswer = getProjectEnv().askNoInfoAnswer.trim();
  if (!normalizedAnswer.trim() || normalizedAnswer.trim() === noInfoAnswer) {
    return normalizedAnswer;
  }

  const example = buildSupplementalExample(question, chunks);
  if (!example) {
    return normalizedAnswer;
  }

  if (normalizedAnswer.includes("Example from [")) {
    return normalizedAnswer;
  }

  return `${normalizedAnswer}\n\n${example}`;
}

function normalizeChunkCitations(answer: string, chunks: RetrievedChunk[]): string {
  const knownIds = new Set(chunks.map((chunk) => chunk.id));

  return answer.replace(/\[([^\]]+)\]/g, (fullMatch, rawId: string) => {
    const candidate = rawId.trim();
    if (knownIds.has(candidate)) {
      return fullMatch;
    }

    const suffixMatch = chunks.find((chunk) => chunk.id.endsWith(`:${candidate}`));
    if (suffixMatch) {
      return `[${suffixMatch.id}]`;
    }

    const candidateParts = candidate.split(":");
    const shortSuffix = candidateParts.slice(-2).join(":");
    const shortSuffixMatches = chunks.filter((chunk) => chunk.id.endsWith(`:${shortSuffix}`));
    if (shortSuffixMatches.length === 1) {
      return `[${shortSuffixMatches[0].id}]`;
    }

    return "";
  });
}

function isTooShortForRequestedDetail(
  answerInstruction: string,
  answer: string,
  chunks: RetrievedChunk[]
): boolean {
  const normalizedInstruction = answerInstruction.toLowerCase();
  const wordCount = countWords(answer);
  const paragraphCount = countParagraphs(answer);
  const contextWordCount = countWords(chunks.map((chunk) => chunk.document).join(" "));

  if (contextWordCount < 80) {
    return false;
  }

  if (/a lot of detail|very detailed|extensively|extendedly/.test(normalizedInstruction)) {
    return wordCount < 160 || paragraphCount < 2;
  }

  if (/\bdetail|detailed\b/.test(normalizedInstruction)) {
    return wordCount < 60;
  }

  return false;
}

function countParagraphs(value: string): number {
  return value
    .trim()
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .length;
}

function countWords(value: string): number {
  return value
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .length;
}

function isNoInfoAnswer(answer: string): boolean {
  const normalized = normalizeForSupportCheck(answer);
  return (
    normalized.includes("does not contain enough relevant information") ||
    normalized.includes("no contiene suficiente informacion") ||
    normalized.includes("no contiene informacion") ||
    normalized.includes("no hay informacion") ||
    normalized.includes("no se encuentra informacion") ||
    normalized.includes("no se encuentra en") ||
    normalized.includes("no proporciona informacion")
  );
}

function isSafelySupportedDateAnswer(
  question: string,
  answer: string,
  chunks: RetrievedChunk[]
): boolean {
  const answerYears = answer.match(/\b\d{3,4}\b/g) ?? [];
  if (answerYears.length === 0 || !answerAddressesQuestion(question, answer, chunks)) {
    return false;
  }

  const entityTerms = extractEntityTermsForDateQuestion(question);
  if (entityTerms.length === 0) {
    return false;
  }

  const context = chunks.map((chunk) => chunk.document).join("\n");
  const normalizedContext = normalizeForSupportCheck(context);
  const asksAboutDeath = /\b(?:murio|muerte|muerto|fallecio|fallecimiento|died|death|dead)\b/.test(
    normalizeForSupportCheck(question)
  );

  return answerYears.every((year) =>
    entityTerms.some((entityTerm) =>
      hasNearbyDateSupport(normalizedContext, entityTerm, year, asksAboutDeath)
    )
  );
}

function buildSupportedMultiHopDateAnswer(
  question: string,
  answerInstruction: string,
  chunks: RetrievedChunk[]
): string {
  const questionTerms = normalizeTerms(question);
  const asksAboutDeath = hasAnyNormalizedTerm(question, [
    "murio", "muerte", "muerto", "fallecio", "fallecimiento", "died", "death", "dead"
  ]);
  const asksAboutDate = hasAnyNormalizedTerm(question, ["ano", "anio", "year", "fecha", "date", "cuando", "when"]);
  if (!asksAboutDeath || !asksAboutDate) {
    return "";
  }

  const descriptorTerms = getDateQuestionDescriptorTerms(questionTerms);
  const entityMatch = findEntityMatchingDescriptors(descriptorTerms, chunks);
  if (!entityMatch) {
    return "";
  }

  const dateMatch = findDateForEntityDeath(entityMatch.entity, chunks);
  if (!dateMatch) {
    return "";
  }

  const citations = [...new Set([entityMatch.chunkId, dateMatch.chunkId])]
    .map((id) => `[${id}]`)
    .join(" ");
  const language = answerInstruction.toLowerCase().includes("spanish") ? "spanish" : "";
  if (language === "spanish") {
    return `${entityMatch.entity} murió el ${dateMatch.date}. ${citations}`;
  }

  return `${entityMatch.entity} died on ${dateMatch.date}. ${citations}`;
}

function findEntityMatchingDescriptors(
  descriptorTerms: string[],
  chunks: RetrievedChunk[]
): { entity: string; chunkId: string } | null {
  if (descriptorTerms.length === 0) {
    return null;
  }

  const candidates: Array<{ entity: string; chunkId: string; score: number }> = [];
  for (const chunk of chunks) {
    const tokens = tokenizeForSupport(chunk.document);
    const entity = descriptorTerms.find((term) => tokens.includes(term));
    if (!entity) {
      continue;
    }

    const descriptorHits = descriptorTerms.filter((term) => tokens.includes(term)).length;
    const deathBoost = hasAnyNormalizedTerm(chunk.document, ["muerto", "fallecido", "dead"]) ? 2 : 0;
    const score = descriptorHits * 3 + deathBoost;
    if (score > 0) {
      candidates.push({ entity, chunkId: chunk.id, score });
    }
  }

  return candidates.sort((left, right) => right.score - left.score).at(0) ?? null;
}

function findDateForEntityDeath(
  entity: string,
  chunks: RetrievedChunk[]
): { date: string; chunkId: string } | null {
  const normalizedEntity = normalizeForSupportCheck(entity);

  for (const chunk of chunks) {
    const normalizedDocument = normalizeForSupportCheck(chunk.document);
    let searchFrom = 0;

    while (searchFrom < normalizedDocument.length) {
      const entityIndex = normalizedDocument.indexOf(normalizedEntity, searchFrom);
      if (entityIndex === -1) {
        break;
      }

      const windowStart = Math.max(0, entityIndex - 120);
      const windowEnd = Math.min(chunk.document.length, entityIndex + 180);
      const rawWindow = chunk.document.slice(windowStart, windowEnd);
      const normalizedWindow = normalizeForSupportCheck(rawWindow);
      if (hasAnyNormalizedTerm(normalizedWindow, ["muerte", "murio", "muerto", "fallecio", "fallecimiento", "death", "died", "dead"])) {
        const date = extractDateAfterEventSignal(rawWindow) || extractDateFromText(rawWindow);
        if (date) {
          return { date, chunkId: chunk.id };
        }
      }

      searchFrom = entityIndex + normalizedEntity.length;
    }
  }

  return null;
}

function getDateQuestionDescriptorTerms(questionTerms: string[]): string[] {
  const ignored = new Set([
    "ano", "anio", "year", "fecha", "date", "cuando", "when", "que", "what",
    "murio", "muerte", "muerto", "fallecio", "fallecimiento", "died", "death", "dead"
  ]);

  return questionTerms.filter((term) => term.length >= 3 && !ignored.has(term));
}

function extractDateAfterEventSignal(text: string): string {
  const normalized = normalizeForSupportCheck(text);
  const eventMatch = normalized.match(/\b(?:muerte|murio|muerto|fallecio|fallecimiento|death|died|dead)\b/);
  if (!eventMatch || eventMatch.index == null) {
    return "";
  }

  return extractDateFromText(text.slice(eventMatch.index));
}

function extractDateFromText(text: string): string {
  const dateMatch = text.match(/\b(?:\d{1,2}\s+de\s+[\p{L}]+,\s+)?\d{3,4}\s*[A-Z]{0,3}\b/u);
  return dateMatch?.[0]?.trim() ?? "";
}

function tokenizeForSupport(text: string): string[] {
  return normalizeForSupportCheck(text)
    .replace(/[^\p{L}0-9\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function hasAnyNormalizedTerm(text: string, terms: string[]): boolean {
  const tokens = tokenizeForSupport(text);
  return terms.some((term) => tokens.includes(normalizeForSupportCheck(term)));
}

function extractEntityTermsForDateQuestion(question: string): string[] {
  const ignored = new Set([
    "ano", "anio", "year", "fecha", "date", "cuando", "when", "que", "what",
    "murio", "muerte", "muerto", "fallecio", "fallecimiento", "died", "death", "dead"
  ]);

  return normalizeTerms(question).filter((term) => term.length >= 3 && !ignored.has(term));
}

function hasNearbyDateSupport(
  normalizedContext: string,
  entityTerm: string,
  year: string,
  requireDeathSignal: boolean
): boolean {
  let searchFrom = 0;
  while (searchFrom < normalizedContext.length) {
    const entityIndex = normalizedContext.indexOf(entityTerm, searchFrom);
    if (entityIndex === -1) {
      return false;
    }

    const windowStart = Math.max(0, entityIndex - 120);
    const windowEnd = Math.min(normalizedContext.length, entityIndex + 220);
    const window = normalizedContext.slice(windowStart, windowEnd);
    const hasYear = window.includes(year);
    const hasDeathSignal = !requireDeathSignal || /\b(?:murio|muerte|muerto|fallecio|fallecimiento|died|death|dead)\b/.test(window);

    if (hasYear && hasDeathSignal) {
      return true;
    }

    searchFrom = entityIndex + entityTerm.length;
  }

  return false;
}

function normalizeForSupportCheck(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

async function expandGroundedAnswer(
  retrievalQuestion: string,
  answerInstruction: string,
  currentAnswer: string,
  chunks: RetrievedChunk[],
  options: { ollamaUrl: string; chatModel?: string }
): Promise<string> {
  const strengthenedInstruction = buildExpandedInstruction(answerInstruction);
  const prompt = [
    buildAnswerPrompt(retrievalQuestion, strengthenedInstruction, chunks),
    "",
    "Current draft answer:",
    currentAnswer,
    "",
    "Rewrite the answer so it is fuller and more useful while staying strictly grounded in the retrieved context."
  ].join("\n");

  try {
    const expanded = await requestChatCompletion(
      prompt,
      options.ollamaUrl,
      options.chatModel ?? getProjectEnv().ollamaChatModel
    );

    const trimmed = expanded.trim();
    if (!trimmed) {
      return currentAnswer;
    }

    return isTooShortForRequestedDetail(answerInstruction, trimmed, chunks)
      ? currentAnswer
      : trimmed;
  } catch {
    return currentAnswer;
  }
}

function buildExpandedInstruction(answerInstruction: string): string {
  const normalizedInstruction = answerInstruction.trim();

  if (!normalizedInstruction) {
    return "explain in detail with multiple supported points";
  }

  if (/a lot of detail|very detailed|extensively|extendedly/i.test(normalizedInstruction)) {
    return `${normalizedInstruction}, use multiple paragraphs, include all major supported points`;
  }

  if (/\bdetail|detailed\b/i.test(normalizedInstruction)) {
    return `${normalizedInstruction}, use multiple paragraphs, include several supported details`;
  }

  return normalizedInstruction;
}

async function requestValidatedCorrection(
  retrievalQuestion: string,
  answerInstruction: string,
  normalizedQuestion: string,
  draftAnswer: string,
  chunks: RetrievedChunk[],
  options: { ollamaUrl: string; chatModel?: string }
): Promise<string> {
  const prompt = buildValidateAnswerPrompt(
    retrievalQuestion,
    answerInstruction,
    normalizedQuestion,
    draftAnswer,
    chunks,
    getProjectEnv().askControlledInferenceLevel
  );

  const rawResponse = await requestJsonChatCompletion(
    prompt,
    options.ollamaUrl,
    options.chatModel ?? getProjectEnv().ollamaChatModel
  );

  const parsed = safeParseJson<Partial<ValidationDecision>>(rawResponse);
  return typeof parsed?.corrected_answer === "string"
    ? parsed.corrected_answer.trim()
    : "";
}

function containsInvalidCitationPlaceholder(value: string): boolean {
  return /\[insert chunk id/i.test(value) || /\[source\s+\d+/i.test(value);
}
