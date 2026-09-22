export function buildTranslateAnswerPrompt(
  answer: string,
  targetLanguage: string,
  sourceTopic?: string
): string {
  return [
    `Translate the following RAG answer into ${targetLanguage}.`,
    sourceTopic ? `Original answer topic: ${sourceTopic}` : "",
    "Translate faithfully and literally enough that no domain term changes meaning.",
    "The translated answer must preserve the exact subject of the original answer topic.",
    "If a topic keyword is misspelled or unusual, keep it close to the original instead of replacing it with a different known entity.",
    "Preserve meaning, formatting, numbered lists, bullet lists, code blocks, technical terms, and chunk IDs exactly.",
    "Do not replace specific plants, foods, tools, component names, route names, medical terms, or technical terms with nearby alternatives.",
    "Do not turn a generic category into a more specific thing. For example, translate generic 'greens' as generic leafy greens, not as spinach.",
    "Keep the translated answer about the original answer topic.",
    "Do not summarize, shorten, expand, reinterpret, or improve the answer.",
    "Do not add new facts.",
    "Do not remove citations.",
    "Return only the translated answer.",
    "",
    "Answer:",
    answer
  ].join("\n");
}
