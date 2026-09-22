import type { RetrievedChunk } from "../models/retrieval.models.ts";
import { extractRequestedLanguageFromInstruction } from "../rag/language.ts";
import { buildRetrievedContext } from "./context.prompts.ts";

export function buildValidateAnswerPrompt(
  retrievalQuestion: string,
  answerInstruction: string,
  normalizedQuestion: string,
  draftAnswer: string,
  chunks: RetrievedChunk[],
  controlledInferenceLevel: "strict" | "low" | "medium" | "high"
): string {
  const context = buildRetrievedContext(retrievalQuestion, chunks, false);

  const lengthRules = buildValidationLengthRules(answerInstruction);
  const inferenceRules = buildControlledInferenceRules(controlledInferenceLevel);

  return [
    "Validate a RAG answer against the retrieved context.",
    "Return strict JSON only with keys: valid, corrected_answer, reason.",
    "Rules:",
    "- Keep only claims directly supported by the retrieved context.",
    "- For questions about a specific named entity, reject claims where the retrieved context attaches that attribute to a different nearby entity.",
    "- Do not allow descriptions, equipment, relationships, roles, or actions to be transferred between adjacent people/items in the same chunk.",
    "- Remove inferred relationship start dates, ages, durations, titles, surnames, or causes unless the retrieved context states them clearly.",
    "- For a named entity answer, remove any attribute, motive, evaluation, role, location, equipment, or background detail unless the retrieved text clearly links it to that named entity.",
    "- Controlled inference must never override named-entity attribution. Entity attribution is always strict.",
    "- Remove invented examples, URLs, code, route paths, or citations.",
    "- If the answer is not fully supported, rewrite it into the safest supported answer.",
    "- If the question asks for multiple supported aspects, do not collapse the answer to only one aspect.",
    "- If a draft omits a requested aspect that is clearly supported by the retrieved context, expand the corrected answer to include that aspect.",
    "- Multi-hop support is valid when one chunk identifies an entity by role/title/description and another chunk gives the requested fact about that same entity.",
    "- Do not reject an answer only because the role/title and the requested date/fact are in different chunks, as long as both chunks clearly refer to the same entity.",
    "- If the context does not support the answer, corrected_answer must say that the retrieved context does not provide enough information.",
    "- Only use exact chunk IDs that appear in the retrieved context.",
    "- Preserve the requested answer style or formatting instruction when it does not conflict with factual grounding.",
    ...inferenceRules,
    ...lengthRules,
    "",
    `Retrieval question: ${retrievalQuestion}`,
    `Answer instruction: ${answerInstruction || "(none)"}`,
    `Normalized retrieval question: ${normalizedQuestion}`,
    "",
    "Draft answer:",
    draftAnswer,
    "",
    "Retrieved context:",
    context
  ].join("\n");
}

function buildControlledInferenceRules(
  level: "strict" | "low" | "medium" | "high"
): string[] {
  if (level === "high") {
    return [
      "- Controlled inference level: high.",
      "- You may combine multiple chunks to reconstruct a useful answer even when some intermediate steps are implied rather than explicitly written.",
      "- Do not invent external facts, but you may fill small local gaps when the surrounding context strongly supports the conclusion.",
      "- Prefer a useful grounded answer over saying there is not enough information when the core procedure or explanation can be reconstructed from the retrieved context."
    ];
  }

  if (level === "medium") {
    return [
      "- Controlled inference level: medium.",
      "- You may cautiously synthesize facts from multiple chunks and bridge minor implicit transitions when they are strongly suggested by the retrieved context.",
      "- Do not invent new entities, tools, steps, or claims that are not locally supported.",
      "- If the main idea is supported but a few small transitions are missing, prefer a careful grounded answer over saying there is not enough information."
    ];
  }

  if (level === "low") {
    return [
      "- Controlled inference level: low.",
      "- You may smooth wording and connect directly adjacent facts, but do not add substantive new steps or claims.",
      "- If the answer depends on missing procedural content, be conservative."
    ];
  }

  return [
    "- Controlled inference level: strict.",
    "- Do not fill gaps, reconstruct missing steps, or infer unstated claims beyond what is directly supported by the retrieved context."
  ];
}

function buildValidationLengthRules(answerInstruction: string): string[] {
  const normalizedInstruction = answerInstruction.toLowerCase();
  const requestedLanguage = extractRequestedLanguageFromInstruction(answerInstruction);
  const requiresStepByStepList = /numbered step-by-step list|step-by-step list|step by step/.test(normalizedInstruction);
  const requiresNumberedList = requiresStepByStepList || /numbered list/.test(normalizedInstruction);
  const requiresBulletList = !requiresNumberedList && /bullet list|bullet points?/.test(normalizedInstruction);
  const requiresVeryDetailedAnswer = /a lot of detail|very detailed|extensively|extendedly/.test(normalizedInstruction);
  const requiresDetailedAnswer = requiresVeryDetailedAnswer || /\bdetail|detailed\b/.test(normalizedInstruction);
  const formattingRules: string[] = [];

  if (requestedLanguage) {
    formattingRules.push(
      `- Preserve the requested output language: the corrected answer must be fully written in ${requestedLanguage}.`,
      "- Keep chunk IDs and citations unchanged."
    );
  }

  if (requiresStepByStepList) {
    formattingRules.push(
      "- Preserve the step-by-step format as a numbered list using `1.`, `2.`, `3.`.",
      "- Do not return paragraphs when the requested format is a step-by-step list."
    );
  } else if (requiresNumberedList) {
    formattingRules.push("- Preserve the numbered-list format using `1.`, `2.`, `3.`.");
  } else if (requiresBulletList) {
    formattingRules.push("- Preserve the bullet-list format using `-` for each item.");
  }

  if (requiresVeryDetailedAnswer) {
    return [
      ...formattingRules,
      "- The corrected answer must be materially detailed, not just a short definition.",
      "- When the context supports multiple paragraphs, preserve a multi-paragraph answer instead of compressing it into one paragraph.",
      "- When the context supports it, include multiple supported points such as what it is, how it works, notable components, types, and practical considerations.",
      "- Reject one-sentence answers as insufficient unless the retrieved context itself is only one sentence long."
    ];
  }

  if (requiresDetailedAnswer) {
    return [
      ...formattingRules,
      "- The corrected answer must be more than a short definition when the retrieved context contains additional relevant support.",
      "- Prefer at least two supported ideas or facts instead of a single sentence."
    ];
  }

  return formattingRules;
}
