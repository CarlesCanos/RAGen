import { renderIntentSplitResponseFormat } from "../shared/intentContract.ts";

export function buildSplitAskIntentPrompt(rawQuestion: string): string {
  return [
    "Split a documentation RAG user request into two parts.",
    "1. retrieval_question: only what the system should search for in the docs.",
    "2. answer_instruction: how the answer should be written, formatted, transformed, or constrained.",
    "Move style requests such as brevity, verbosity, line count, bullets, examples, summaries, comparisons, tone, or output language into answer_instruction.",
    "Never include answer style words in retrieval_question. Phrases like 'very detailed explanation', 'explicacion muy detallada', 'explicación detallada', 'explain in detail', 'resume', or 'summary' belong only in answer_instruction.",
    "The requested response language is part of answer formatting, not part of retrieval.",
    "If the user asks for the answer in Spanish, Catalan, French, English, or any other language, keep the retrieval_question focused on what to search for, and place the language request inside answer_instruction.",
    "Keep retrieval_question semantically faithful to what the user wants to find.",
    "Do not correct, translate, expand, split, or replace words from the user request that start with an uppercase letter. Treat them as proper names or user-defined identifiers.",
    "If the user did not specify any answer formatting or output constraint, return answer_instruction with all fields set to null except include_examples=false.",
    "Return strict JSON only with exactly this shape:",
    renderIntentSplitResponseFormat(),
    "Do not return strings, arrays, or custom keys for answer_instruction.",
    "",
    `User request: ${rawQuestion}`
  ].join("\n");
}
