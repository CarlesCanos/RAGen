import type { SearchAttempt } from "../models/retrieval.models.ts";

export function buildSearchPlanPrompt(
  originalQuestion: string,
  maxOptions: number
): string {
  return [
    "You are planning search strategies for a local RAG retriever.",
    "Think about different plausible ways the answer could appear in the documents, then propose search queries.",
    `Return at most ${maxOptions} search options.`,
    "Use concise queries focused on words likely to exist verbatim in the documents.",
    "Preserve proper names and user-provided identifiers exactly when they start with uppercase letters.",
    "When useful, consider alternative search angles such as:",
    "- inverse relationships such as child -> parent or child -> mother/father",
    "- role/title indirections such as ex-director -> person name",
    "- event-to-entity pivots such as death event -> entity or vice versa",
    "- aliases, abbreviations, or nearby section labels likely to appear in semi-structured docs",
    "Do not invent external facts.",
    "Return strict JSON only with this shape:",
    '{"options":[{"query":"string","reason":"string"}]}',
    "",
    `Original question: ${originalQuestion}`
  ].join("\n");
}

export function buildRetryQueryDecisionPrompt(
  originalQuestion: string,
  attempts: SearchAttempt[],
  weakRetrieval: boolean
): string {
  const lastAttempt = attempts.at(-1);
  const prompt = [
    "You improve search queries for a local RAG retriever.",
    "Decide whether the previous retrieval seems mismatched for the user's question.",
    "If it seems weak, produce one better search query focused on terms likely to appear in the document.",
    "Prefer concrete nouns, chapter/topic terms, quotes, event names, or nearby phrasing from the question.",
    "Do not correct, translate, expand, split, or replace words from the original question that start with an uppercase letter. Treat them as proper names or user-defined identifiers.",
    "Return strict JSON only with keys: retry, reason, query.",
    "",
    `Original question: ${originalQuestion}`,
    `Last search query: ${lastAttempt?.query ?? ""}`,
    `Weak retrieval heuristic: ${weakRetrieval ? "yes" : "no"}`,
    "",
    "Retrieved chunk summaries:"
  ];

  for (const chunk of (lastAttempt?.chunks ?? []).slice(0, 5)) {
    const heading = chunk.metadata?.heading ?? "(none)";
    const preview = chunk.document.replace(/\s+/g, " ").slice(0, 180);
    prompt.push(`- ${chunk.id} | ${heading} | ${preview}`);
  }

  return prompt.join("\n");
}
