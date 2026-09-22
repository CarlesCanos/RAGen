import { requestJsonChatCompletion } from "../shared/ollama.ts";
import { safeParseJson } from "../shared/json.ts";
import { parseIntentSplitResponse } from "../shared/intentContract.ts";
import type { AskIntent } from "../models/intent.models.ts";
import { buildSplitAskIntentPrompt } from "../prompts/intent.prompts.ts";
import { getProjectEnv } from "../env.ts";
import { extractProtectedTerms, normalizeTerms, tokenizeLoose } from "./text.ts";
import type {
  IntentAnswerInstructionPayload,
} from "../types/intent.types.ts";

export async function splitAskIntent(
  rawQuestion: string,
  options: { ollamaUrl: string; chatModel?: string }
): Promise<AskIntent> {
  const fallback = fallbackSplitAskIntent(rawQuestion);
  const userExplicitlyRequestedFormat = hasExplicitAnswerInstruction(rawQuestion);
  if (!options.chatModel) {
    return fallback;
  }

  const prompt = buildSplitAskIntentPrompt(rawQuestion);

  try {
    const rawResponse = await requestJsonChatCompletion(prompt, options.ollamaUrl, options.chatModel);
    const parsedJson = safeParseJson<unknown>(rawResponse);
    const parsed = parseIntentSplitResponse(parsedJson);
    const fallbackRetrievalQuestion = fallback.retrievalQuestion || rawQuestion;
    const retrievalQuestionCandidate = refineRetrievalQuestion(parsed?.retrieval_question);
    const retrievalQuestion = isSafeIntentRetrievalQuestion(rawQuestion, retrievalQuestionCandidate)
      ? retrievalQuestionCandidate
      : fallbackRetrievalQuestion;
    const answerInstructionPayload = buildDefaultedAnswerInstructionPayload(
      parsed?.answer_instruction,
      rawQuestion,
      userExplicitlyRequestedFormat
    );
    const answerInstruction = userExplicitlyRequestedFormat
      ? sanitizeAnswerInstruction(answerInstructionPayload, rawQuestion)
      : "";

    if (!retrievalQuestion) {
      return fallback;
    }

    return buildIntent(rawQuestion, retrievalQuestion, answerInstruction, {
      llmSplitRawResponse: rawResponse,
      llmSplitRetrievalQuestion: typeof parsed?.retrieval_question === "string"
        ? parsed.retrieval_question
        : undefined,
      llmSplitAnswerInstruction: serializeRawAnswerInstruction(parsed?.answer_instruction),
      effectiveSplitJson: serializeEffectiveSplitJson(retrievalQuestion, answerInstructionPayload)
    });
  } catch {
    return fallback;
  }
}

function fallbackSplitAskIntent(rawQuestion: string): AskIntent {
  const trimmed = rawQuestion.trim();
  if (!trimmed) {
    return buildIntent(rawQuestion, "", "");
  }

  const leadingInstructionMatch = matchLeadingInstruction(trimmed);
  if (leadingInstructionMatch) {
    return buildIntent(rawQuestion, leadingInstructionMatch.retrievalQuestion, leadingInstructionMatch.answerInstruction);
  }

  const separatorMatch = trimmed.match(/^(.*?)\s+(?:\+|\|\||=>|->)\s+(.*)$/);
  if (separatorMatch) {
    return buildIntent(rawQuestion, separatorMatch[1], separatorMatch[2]);
  }

  const questionTailMatch = trimmed.match(/^(.+?\?)\s+(.+)$/);
  if (questionTailMatch && looksLikeAnswerInstruction(questionTailMatch[2])) {
    return buildIntent(rawQuestion, questionTailMatch[1], questionTailMatch[2]);
  }

  const punctuationTailMatch = trimmed.match(/^(.+?)[,;:]\s*(.+)$/);
  if (punctuationTailMatch && looksLikeAnswerInstruction(punctuationTailMatch[2])) {
    return buildIntent(rawQuestion, punctuationTailMatch[1], punctuationTailMatch[2]);
  }

  return buildIntent(rawQuestion, trimmed, "");
}

function matchLeadingInstruction(
  value: string
): { retrievalQuestion: string; answerInstruction: string } | null {
  const normalized = value.replace(/\s+/g, " ").trim();
  const patterns = [
    /^(explain\s+step\s+by\s+step)\s+(.+)$/i,
    /^(describe\s+step\s+by\s+step)\s+(.+)$/i,
    /^(list\s+step\s+by\s+step)\s+(.+)$/i,
    /^(explain(?:\s+in\s+(?:a lot of\s+detail|detail))?)\s+(.+)$/i,
    /^(describe(?:\s+in\s+(?:a lot of\s+detail|detail))?)\s+(.+)$/i,
    /^(summarize|briefly explain|explain briefly|list|compare)\s+(.+)$/i
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (!match) {
      continue;
    }

    const answerInstruction = match[1]?.trim() ?? "";
    const retrievalQuestion = match[2]?.trim() ?? "";
    if (!answerInstruction || !retrievalQuestion || !looksLikeQuestionBody(retrievalQuestion)) {
      continue;
    }

    return { retrievalQuestion, answerInstruction };
  }

  return null;
}

function buildIntent(
  rawQuestion: string,
  retrievalQuestion: string,
  answerInstruction: string,
  debug?: Pick<AskIntent, "llmSplitRawResponse" | "llmSplitRetrievalQuestion" | "llmSplitAnswerInstruction" | "effectiveSplitJson">
): AskIntent {
  const cleanRetrievalQuestion = refineRetrievalQuestion(retrievalQuestion);
  const cleanAnswerInstruction = enforceExplicitFormattingFromQuestion(
    sanitizeIntentPart(answerInstruction),
    rawQuestion
  );
  const answerInstructionPayload = buildDefaultedAnswerInstructionPayload(
    parseAnswerInstructionString(cleanAnswerInstruction),
    rawQuestion,
    Boolean(cleanAnswerInstruction)
  );

  return {
    rawQuestion: rawQuestion.trim(),
    retrievalQuestion: cleanRetrievalQuestion || rawQuestion.trim(),
    answerInstruction: cleanAnswerInstruction,
    answerInstructionPayload,
    combinedIntent: [cleanRetrievalQuestion || rawQuestion.trim(), cleanAnswerInstruction]
      .filter(Boolean)
      .join(" | "),
    ...debug
  };
}

function looksLikeAnswerInstruction(value: string): boolean {
  return /^(explain|summarize|respond|answer|describe|compare|list|give|write|show|keep|format|expand|verbose|in\s+\d+\s+lines?|explica|explicar|explicacion|explicación|resume|resumir|resumen|detallad[ao]s?|breve|lista|formato)/i.test(
    value.trim()
  );
}

function looksLikeQuestionBody(value: string): boolean {
  return /^(what|how|why|when|where|which|who|can|could|should|does|do|is|are|tell me|give me|que|qué|quien|quién|como|cómo|cuando|cuándo|donde|dónde|cual|cuál|dime|dame)\b/i.test(
    value.trim()
  );
}

function hasExplicitAnswerInstruction(rawQuestion: string): boolean {
  const trimmed = rawQuestion.trim();
  if (!trimmed) {
    return false;
  }

  if (containsFormattingSignal(trimmed)) {
    return true;
  }

  const separatorMatch = trimmed.match(/^(.*?)\s+(?:\+|\|\||=>|->)\s+(.*)$/);
  if (separatorMatch) {
    return looksLikeAnswerInstruction(separatorMatch[2]);
  }

  const questionTailMatch = trimmed.match(/^(.+?\?)\s+(.+)$/);
  if (questionTailMatch && looksLikeAnswerInstruction(questionTailMatch[2])) {
    return true;
  }

  const punctuationTailMatch = trimmed.match(/^(.+?)[,;:]\s*(.+)$/);
  if (punctuationTailMatch && looksLikeAnswerInstruction(punctuationTailMatch[2])) {
    return true;
  }

  return false;
}

function containsFormattingSignal(value: string): boolean {
  return /\b(explain|summarize|summary|detailed|detail|briefly|brief|step by step|bullet points?|bullets?|numbered|list|in \d+ lines?|compare|spanish|english|french|german|italian|portuguese|catalan|explica|explicar|explicacion|explicación|detallada|detallado|detalladamente|resumen|resume|breve|lista|español|inglés|ingles|francés|frances|alemán|aleman|italiano|portugués|portugues|catalán|catalan)\b/i.test(
    value
  );
}

function sanitizeIntentPart(value: string | null | undefined): string {
  if (typeof value !== "string") {
    return "";
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized || /^(null|undefined|none)$/i.test(normalized)) {
    return "";
  }

  return normalized;
}

function sanitizeRetrievalQuestion(value: string | null | undefined): string {
  const sanitized = sanitizeIntentPart(value);
  if (!sanitized) {
    return "";
  }

  return sanitized
    .replace(/\b(?:answer|respond|translate)\s+in\s+(spanish|english|french|german|italian|portuguese|catalan)\b/gi, "")
    .replace(/\b(?:in|en)\s+(spanish|english|french|german|italian|portuguese|catalan|español|inglés|ingles|francés|frances|alemán|aleman|italiano|portugués|portugues|catalán|catalan)\b/gi, "")
    .replace(/\s*(?:,|;|:|-|—)?\s*(?:with\s+(?:a\s+)?(?:very\s+)?detailed\s+explanation|very\s+detailed\s+explanation|detailed\s+explanation|explain\s+in\s+(?:a\s+lot\s+of\s+)?detail)\s*$/gi, "")
    .replace(/\s*(?:,|;|:|-|—)?\s*(?:explicaci[oó]n\s+(?:muy\s+)?detallada|explica(?:r)?\s+(?:muy\s+)?detallad[ao]|explica(?:r)?\s+en\s+detalle|muy\s+detallad[ao])\s*$/gi, "")
    .replace(/\binclude\s+details\s+in\b/gi, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([?.!,;:])/g, "$1")
    .trim();
}

function sanitizeAnswerInstruction(
  value: IntentAnswerInstructionPayload | null | undefined,
  rawQuestion = ""
): string {
  const sanitized = sanitizeIntentPart(convertStructuredAnswerInstruction(value, rawQuestion));
  if (!sanitized) {
    return "";
  }

  return sanitized
    .replace(/\bextendedly\b/gi, "extensively")
    .replace(/\s+/g, " ")
    .trim();
}

function buildDefaultedAnswerInstructionPayload(
  value: IntentAnswerInstructionPayload | null | undefined,
  rawQuestion: string,
  userExplicitlyRequestedFormat: boolean
): Required<IntentAnswerInstructionPayload> {
  const env = getProjectEnv();
  const parsedDefaultDetailLevel = parseDefaultDetailLevel(env.askDefaultAnswerInstruction);
  const explicitLanguage = extractRequestedLanguage(rawQuestion);
  const outputLanguage = typeof value?.output_language === "string" && !/^(null|none|undefined)$/i.test(value.output_language.trim())
    ? value.output_language.trim()
    : "";

  return {
    detail_level: value?.detail_level ?? parsedDefaultDetailLevel,
    include_examples: value?.include_examples ?? false,
    max_lines: value?.max_lines ?? 100,
    output_format: value?.output_format ?? "plain_text",
    output_language: explicitLanguage || outputLanguage || env.askPreferredLanguage,
    tone: value?.tone ?? "neutral"
  };
}

function parseDefaultDetailLevel(defaultInstruction: string): Required<IntentAnswerInstructionPayload>["detail_level"] {
  const normalized = defaultInstruction.toLowerCase();

  if (/a lot of detail|very detailed|extensively|extendedly/.test(normalized)) {
    return "very_detailed";
  }

  if (/detail|detailed/.test(normalized)) {
    return "detailed";
  }

  if (/brief|short|summary/.test(normalized)) {
    return "brief";
  }

  return "normal";
}

function parseAnswerInstructionString(answerInstruction: string): IntentAnswerInstructionPayload {
  const normalized = answerInstruction.toLowerCase();

  return {
    detail_level: /a lot of detail|very detailed|extensively|extendedly/.test(normalized)
      ? "very_detailed"
      : /\bdetail|detailed\b/.test(normalized)
        ? "detailed"
        : /brief|summary/.test(normalized)
          ? "brief"
          : null,
    include_examples: /example|examples|snippet|sample/.test(normalized) ? true : null,
    max_lines: null,
    output_format: /step-by-step|step by step/.test(normalized)
      ? "step_by_step"
      : /bullet|bullets/.test(normalized)
        ? "bullet_list"
        : null,
    output_language: extractInstructionLanguage(answerInstruction) || null,
    tone: null
  };
}

function extractInstructionLanguage(answerInstruction: string): string {
  const match = answerInstruction.match(/\banswer in\s+([a-zA-Z]+(?:\s+[a-zA-Z]+)*)/i);
  return match?.[1]?.trim() ?? "";
}

function serializeEffectiveSplitJson(
  retrievalQuestion: string,
  answerInstructionPayload: Required<IntentAnswerInstructionPayload>
): string {
  return JSON.stringify({
    retrieval_question: retrievalQuestion,
    answer_instruction: answerInstructionPayload
  }, null, 2);
}

function isSafeIntentRetrievalQuestion(rawQuestion: string, retrievalQuestion: string): boolean {
  const rawCore = getQuestionCoreForSafety(rawQuestion);
  const originalTerms = normalizeTerms(rawCore);
  const retrievalTokens = tokenizeLoose(retrievalQuestion);
  const protectedTerms = extractProtectedTerms(rawCore);

  if (originalTerms.length === 0 || retrievalTokens.length === 0) {
    return true;
  }

  const preservesProtectedTerms = protectedTerms.every((term) => retrievalTokens.includes(term));
  if (!preservesProtectedTerms) {
    return false;
  }

  const importantOriginalTerms = originalTerms.filter((term) => term.length >= 3);
  if (importantOriginalTerms.length === 0) {
    return true;
  }

  return importantOriginalTerms.every((term) => retrievalTokens.includes(term));
}

function getQuestionCoreForSafety(rawQuestion: string): string {
  const trimmed = rawQuestion.trim();
  const punctuationTailMatch = trimmed.match(/^(.+?)[,;:]\s*(.+)$/);
  if (punctuationTailMatch && looksLikeAnswerInstruction(punctuationTailMatch[2])) {
    return punctuationTailMatch[1];
  }

  const questionTailMatch = trimmed.match(/^(.+?\?)\s+(.+)$/);
  if (questionTailMatch && looksLikeAnswerInstruction(questionTailMatch[2])) {
    return questionTailMatch[1];
  }

  return trimmed;
}

function enforceExplicitFormattingFromQuestion(currentInstruction: string, rawQuestion: string): string {
  const loweredQuestion = rawQuestion.toLowerCase();
  const instructions = currentInstruction
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const hasInstruction = (pattern: RegExp): boolean => instructions.some((instruction) => pattern.test(instruction));
  const explicitLanguage = extractRequestedLanguage(rawQuestion);

  if (/\bstep by step\b/.test(loweredQuestion) && !hasInstruction(/\bstep-by-step\b|\bstep by step\b|\bnumbered list\b/)) {
    instructions.push("answer as a numbered step-by-step list");
  } else if (/\bnumbered\b|\bnumbered list\b/.test(loweredQuestion) && !hasInstruction(/\bnumbered list\b/)) {
    instructions.push("answer as a numbered list");
  } else if (/\bbullet points?\b|\bbullets?\b|\blist\b/.test(loweredQuestion) && !hasInstruction(/\bbullet list\b|\bbullet points\b/)) {
    instructions.push("answer as a bullet list");
  }

  if (/\ba lot of detail\b|\bvery detailed\b|\bextensively\b|\bextendedly\b|\bextended\b|\bexplicaci[oó]n\s+muy\s+(?:detallada|extendida)\b|\bmuy\s+(?:detallad[ao]|extendid[ao])\b/.test(loweredQuestion)) {
    if (!hasInstruction(/\ba lot of detail\b/)) {
      instructions.unshift("explain in a lot of detail");
    }
  } else if (/\bin detail\b|\bdetailed\b|\bdetail\b|\bexplicaci[oó]n\s+(?:detallada|extendida)\b|\bdetallad[ao]\b|\bextendid[ao]\b|\ben detalle\b/.test(loweredQuestion) && !hasInstruction(/\bin detail\b|\bdetailed\b/)) {
    instructions.unshift("explain in detail");
  }

  if (explicitLanguage && !hasInstruction(/\banswer in\b|\brespond in\b/)) {
    instructions.push(`answer in ${explicitLanguage}`);
  }

  return [...new Set(instructions)].join(", ");
}

function convertStructuredAnswerInstruction(
  value: IntentAnswerInstructionPayload | null | undefined,
  rawQuestion: string
): string {
  if (!value) {
    return "";
  }

  const instructions: string[] = [];
  const detailLevel = typeof value.detail_level === "string" ? value.detail_level.trim().toLowerCase() : "";
  const outputFormat = typeof value.output_format === "string" ? value.output_format.trim().toLowerCase() : "";
  const loweredQuestion = rawQuestion.toLowerCase();
  const explicitVeryDetailedRequest = /\ba lot of detail\b|\bvery detailed\b|\bextensively\b|\bextendedly\b|\bextended\b|\bexplicaci[oó]n\s+muy\s+(?:detallada|extendida)\b|\bmuy\s+(?:detallad[ao]|extendid[ao])\b/.test(
    loweredQuestion
  );
  const explicitDetailedRequest = explicitVeryDetailedRequest || /\bin detail\b|\bdetailed\b|\bexplicaci[oó]n\s+(?:detallada|extendida)\b|\bdetallad[ao]\b|\bextendid[ao]\b|\ben detalle\b/.test(loweredQuestion);
  const explicitStepByStepRequest = /\bstep by step\b/.test(loweredQuestion);
  const explicitBulletRequest = /\bbullet points?\b|\bbullets?\b/.test(loweredQuestion);
  const explicitNumberedRequest = /\bnumbered\b|\bnumbered list\b/.test(loweredQuestion);
  const explicitListRequest = /\blist\b/.test(loweredQuestion);
  const preserveTone = /\btone\b/.test(loweredQuestion);
  const explicitLanguage = extractRequestedLanguage(rawQuestion);
  const preserveLineCount = /\blines?\b/.test(loweredQuestion);
  const preserveExample = /\bexample|examples|snippet|sample\b/.test(loweredQuestion);
  const outputLanguage = typeof value.output_language === "string" && !/^(null|none|undefined)$/i.test(value.output_language.trim())
    ? value.output_language.trim()
    : "";
  const tone = preserveTone && typeof value.tone === "string" ? value.tone.trim() : "";

  if (explicitVeryDetailedRequest || detailLevel === "very_detailed") {
    instructions.push("explain in a lot of detail");
  } else if (explicitDetailedRequest || detailLevel === "detailed") {
    instructions.push("explain in detail");
  } else if (detailLevel === "brief") {
    instructions.push("brief summary");
  } else if (detailLevel === "normal") {
    instructions.push("explain clearly");
  }

  if (tone) {
    instructions.push(`use a ${tone} tone`);
  }

  if (explicitLanguage) {
    instructions.push(`answer in ${explicitLanguage}`);
  } else if (outputLanguage) {
    instructions.push(`answer in ${outputLanguage}`);
  }

  if (explicitStepByStepRequest || outputFormat === "step_by_step") {
    instructions.push("answer as a numbered step-by-step list");
  } else if (explicitNumberedRequest) {
    instructions.push("answer as a numbered list");
  } else if (explicitBulletRequest || explicitListRequest || outputFormat === "bullet_list") {
    instructions.push("answer as a bullet list");
  } else if (outputFormat === "plain_text" && instructions.length === 0) {
    instructions.push("plain text");
  }

  if (preserveExample && value.include_examples === true) {
    instructions.push("include an example");
  }

  const lineCount = typeof value.max_lines === "number" ? value.max_lines : null;
  if (preserveLineCount && lineCount != null && Number.isFinite(lineCount) && lineCount > 0) {
    instructions.push(`answer in ${lineCount} lines`);
  }

  return instructions.join(", ");
}

function serializeRawAnswerInstruction(
  value: IntentAnswerInstructionPayload | null | undefined
): string | undefined {
  if (!value) {
    return undefined;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function extractRequestedLanguage(value: string): string {
  const matchers: Array<{ pattern: RegExp; language: string }> = [
    { pattern: /\b(?:in|answer in|respond in|translate to)\s+spanish\b/i, language: "Spanish" },
    { pattern: /\b(?:in|answer in|respond in|translate to)\s+english\b/i, language: "English" },
    { pattern: /\b(?:in|answer in|respond in|translate to)\s+french\b/i, language: "French" },
    { pattern: /\b(?:in|answer in|respond in|translate to)\s+german\b/i, language: "German" },
    { pattern: /\b(?:in|answer in|respond in|translate to)\s+italian\b/i, language: "Italian" },
    { pattern: /\b(?:in|answer in|respond in|translate to)\s+portuguese\b/i, language: "Portuguese" },
    { pattern: /\b(?:in|answer in|respond in|translate to)\s+catalan\b/i, language: "Catalan" },
    { pattern: /\ben español\b/i, language: "Spanish" },
    { pattern: /\ben inglés\b|\ben ingles\b/i, language: "English" },
    { pattern: /\ben francés\b|\ben frances\b/i, language: "French" },
    { pattern: /\ben alemán\b|\ben aleman\b/i, language: "German" },
    { pattern: /\ben italiano\b/i, language: "Italian" },
    { pattern: /\ben portugués\b|\ben portugues\b/i, language: "Portuguese" },
    { pattern: /\ben catalán\b|\ben catalan\b/i, language: "Catalan" }
  ];

  for (const matcher of matchers) {
    if (matcher.pattern.test(value)) {
      return matcher.language;
    }
  }

  return "";
}

function refineRetrievalQuestion(value: string | null | undefined): string {
  const sanitized = sanitizeRetrievalQuestion(value);
  if (!sanitized) {
    return "";
  }

  const cleaned = sanitized
    .replace(/\b(?:provide|include|give)\s+(?:an?\s+)?(?:extended|extensive|detailed|detail(?:ed)?)\s+(?:explanation|answer|response)\b/gi, "")
    .replace(/\s*(?:,|;|:|-|—)?\s*(?:with\s+(?:a\s+)?(?:very\s+)?detailed\s+explanation|very\s+detailed\s+explanation|detailed\s+explanation|explain\s+in\s+(?:a\s+lot\s+of\s+)?detail)\s*$/gi, "")
    .replace(/\s*(?:,|;|:|-|—)?\s*(?:explicaci[oó]n\s+(?:muy\s+)?detallada|explica(?:r)?\s+(?:muy\s+)?detallad[ao]|explica(?:r)?\s+en\s+detalle|muy\s+detallad[ao])\s*$/gi, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([?.!,;:])/g, "$1")
    .replace(/\?+/g, "")
    .trim();
  return cleaned;
}
