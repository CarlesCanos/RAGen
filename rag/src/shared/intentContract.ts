import type {
  IntentAnswerInstructionPayload,
  IntentSplitResponse
} from "../types/intent.types.ts";

const DETAIL_LEVEL_VALUES = ["brief", "normal", "detailed", "very_detailed"] as const;
const OUTPUT_FORMAT_VALUES = ["plain_text", "bullet_list", "step_by_step"] as const;

export const INTENT_SPLIT_RESPONSE_FORMAT = {
  retrieval_question: "string",
  answer_instruction: {
    detail_level: "brief | normal | detailed | very_detailed | null",
    include_examples: "boolean | null",
    max_lines: "number | null",
    output_format: "plain_text | bullet_list | step_by_step | null",
    output_language: "string | null",
    tone: "string | null"
  }
} as const;

export function renderIntentSplitResponseFormat(): string {
  return JSON.stringify(INTENT_SPLIT_RESPONSE_FORMAT, null, 2);
}

export function parseIntentSplitResponse(value: unknown): IntentSplitResponse | null {
  if (!isObject(value)) {
    return null;
  }

  if (!hasExactKeys(value, ["retrieval_question", "answer_instruction"])) {
    return null;
  }

  const retrievalQuestion = typeof value.retrieval_question === "string"
    ? value.retrieval_question
    : null;
  const answerInstruction = parseIntentAnswerInstruction(value.answer_instruction);

  if (retrievalQuestion === null || answerInstruction === null) {
    return null;
  }

  return {
    retrieval_question: retrievalQuestion,
    answer_instruction: answerInstruction
  };
}

function parseIntentAnswerInstruction(value: unknown): IntentAnswerInstructionPayload | null {
  if (!isObject(value)) {
    return null;
  }

  if (!hasExactKeys(value, ["detail_level", "include_examples", "max_lines", "output_format", "output_language", "tone"])) {
    return null;
  }

  const detailLevel = value.detail_level;
  const includeExamples = value.include_examples;
  const maxLines = value.max_lines;
  const outputFormat = value.output_format;
  const outputLanguage = value.output_language;
  const tone = value.tone;

  if (!isNullableEnum(detailLevel, DETAIL_LEVEL_VALUES)) {
    return null;
  }

  if (!(includeExamples === null || typeof includeExamples === "boolean")) {
    return null;
  }

  if (!(maxLines === null || (typeof maxLines === "number" && Number.isFinite(maxLines) && maxLines > 0))) {
    return null;
  }

  if (!isNullableEnum(outputFormat, OUTPUT_FORMAT_VALUES)) {
    return null;
  }

  if (!(outputLanguage === null || typeof outputLanguage === "string")) {
    return null;
  }

  if (!(tone === null || typeof tone === "string")) {
    return null;
  }

  return {
    detail_level: detailLevel,
    include_examples: includeExamples,
    max_lines: maxLines,
    output_format: outputFormat,
    output_language: outputLanguage,
    tone
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableEnum<T extends readonly string[]>(
  value: unknown,
  allowedValues: T
): value is T[number] | null {
  return value === null || (typeof value === "string" && allowedValues.includes(value));
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: string[]): boolean {
  const actualKeys = Object.keys(value).sort();
  const normalizedExpectedKeys = [...expectedKeys].sort();

  if (actualKeys.length !== normalizedExpectedKeys.length) {
    return false;
  }

  return actualKeys.every((key, index) => key === normalizedExpectedKeys[index]);
}
