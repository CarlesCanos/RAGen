import type { RetrievedChunk } from "../models/retrieval.models.ts";
import { extractRequestedLanguageFromInstruction } from "../rag/language.ts";
import { buildRetrievedContext } from "./context.prompts.ts";

export function buildAnswerPrompt(
  retrievalQuestion: string,
  effectiveInstruction: string,
  chunks: RetrievedChunk[]
): string {
  const context = buildRetrievedContext(retrievalQuestion, chunks, true);

  const responseRequirements = buildResponseRequirements(effectiveInstruction);

  return [
    "Use the following retrieved context to answer the question.",
    "If the answer is not supported by the context, say you do not know.",
    "Synthesize the answer from all relevant retrieved chunks, not only the first matching chunk.",
    "Prefer combining complementary context when multiple chunks add meaningful support.",
    "If the question asks for multiple aspects joined by words like `and` or `y`, answer each supported aspect instead of choosing only one.",
    "For questions like `who is X and what are X's relationships`, include both the supported identity/background and the supported relationships.",
    "For multi-hop questions, combine chunks when one chunk identifies an entity by role/title/description and another chunk gives the requested fact about that same entity.",
    "If chunk A says `X` has the requested role/title/description, and chunk B says the requested event/date/fact for `X`, use both chunks together.",
    "If the question asks about a specific entity, person, component, route, tool, or named item, only assign attributes that are explicitly attached to that same entity.",
    "Do not transfer descriptions, equipment, relationships, roles, or actions from nearby entities in the same chunk.",
    "Do not infer relationship start dates, ages, durations, titles, surnames, or causes unless the retrieved context states them clearly.",
    "Cite supporting chunk IDs inline using the exact chunk IDs shown in the retrieved context.",
    "Follow the response instruction after you determine the answer from the retrieved context.",
    ...responseRequirements,
    "",
    "Retrieval question:",
    retrievalQuestion,
    "",
    "Response instruction:",
    effectiveInstruction,
    "",
    "Retrieved context:",
    context
  ].join("\n");
}

function buildResponseRequirements(effectiveInstruction: string): string[] {
  const normalizedInstruction = effectiveInstruction.toLowerCase();
  const requestedLanguage = extractRequestedLanguageFromInstruction(effectiveInstruction);
  const requiresStepByStepList = /numbered step-by-step list|step-by-step list|step by step/.test(normalizedInstruction);
  const requiresNumberedList = requiresStepByStepList || /numbered list/.test(normalizedInstruction);
  const requiresBulletList = !requiresNumberedList && /bullet list|bullet points?/.test(normalizedInstruction);
  const requiresListFormat = requiresStepByStepList || requiresNumberedList || requiresBulletList;
  const requiresVeryDetailedAnswer = /a lot of detail|very detailed|extensively|extendedly/.test(normalizedInstruction);
  const requiresDetailedAnswer = requiresVeryDetailedAnswer || /\bdetail|detailed\b/.test(normalizedInstruction);
  const formattingRules: string[] = [];

  if (requestedLanguage) {
    formattingRules.push(
      `Write the full answer in ${requestedLanguage}, even if the retrieved context is in a different language.`,
      "Do not translate chunk IDs or citations."
    );
  }

  if (requiresStepByStepList) {
    formattingRules.push(
      "Format the answer as a numbered list using `1.`, `2.`, `3.`.",
      "Each item should be a concrete step."
    );
  } else if (requiresNumberedList) {
    formattingRules.push("Format the answer as a numbered list using `1.`, `2.`, `3.`.");
  } else if (requiresBulletList) {
    formattingRules.push("Format the answer as a bullet list using `-` for each item.");
  }

  if (requiresVeryDetailedAnswer) {
    return [
      ...formattingRules,
      requiresListFormat
        ? "Because the response instruction asks for a lot of detail, make the list comprehensive and include multiple well-developed items."
        : "Because the response instruction asks for a lot of detail, write a thorough answer with multiple paragraphs.",
      "Use as much relevant context as the retrieved chunks support.",
      "Do not stop after a one-sentence definition if the context contains mechanism, components, types, steps, examples, or caveats."
    ];
  }

  if (requiresDetailedAnswer) {
    return [
      ...formattingRules,
      requiresListFormat
        ? "Because the response instruction asks for detail, make the list informative and include several supported items."
        : "Because the response instruction asks for detail, write at least two well-developed paragraphs when the context supports it.",
      "Go beyond a short definition and include the most important supported details from the retrieved chunks."
    ];
  }

  return formattingRules;
}
