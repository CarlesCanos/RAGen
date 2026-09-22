export function buildNormalizeSearchQueryPrompt(question: string): string {
  return [
    "Normalize a user search query for documentation retrieval.",
    "Fix typos, spacing, simple singular/plural mismatches, and syntax tokens like @for when obvious.",
    "Do not change the user's intent.",
    "Do not replace ordinary verbs with different words.",
    "Do not split proper names, character names, product names, file names, code identifiers, or unknown single-token entities into multiple words.",
    "Do not correct, translate, expand, split, or replace words from the user query that start with an uppercase letter. Treat them as proper names or user-defined identifiers.",
    "If an unknown name appears as one token in the user query, preserve it as one token unless the user clearly separated it.",
    "Prefer the closest wording that would likely appear in technical docs.",
    "Return strict JSON only with keys: normalized_question, changed, reason.",
    "",
    `Query: ${question}`
  ].join("\n");
}
