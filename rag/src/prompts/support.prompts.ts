import type { RetrievedChunk } from "../models/retrieval.models.ts";

export function buildSupportChunkSelectionPrompt(
  retrievalQuestion: string,
  answerInstruction: string,
  candidateChunks: RetrievedChunk[],
  maxChunks: number,
  getScores: (chunk: RetrievedChunk) => { retrievalScore: number; supportScore: number },
  stripExampleBoilerplate: (text: string) => string
): string {
  const prompt = [
    "You are selecting the best retrieved chunks to support a documentation answer.",
    "Choose the chunks that provide the most important, non-redundant explanatory context for the user's question.",
    "Prefer explanatory text chunks over code chunks when both say the same thing.",
    "Include a code chunk only if it directly adds important context or clarification.",
    `Select at most ${maxChunks} chunk IDs.`,
    "Return strict JSON only with keys: selected_chunk_ids, reason.",
    "",
    `Retrieval question: ${retrievalQuestion}`,
    `Answer instruction: ${answerInstruction || "(none)"}`,
    "",
    "Candidate chunks:"
  ];

  for (const chunk of candidateChunks) {
    const preview = stripExampleBoilerplate(chunk.document).replace(/\s+/g, " ").slice(0, 260);
    const { retrievalScore, supportScore } = getScores(chunk);
    prompt.push(
      [
        `Chunk ID: ${chunk.id}`,
        `Heading: ${chunk.metadata?.heading ?? "(none)"}`,
        `Code: ${chunk.metadata?.has_code ? `yes${chunk.metadata.code_language ? ` (${chunk.metadata.code_language})` : ""}` : "no"}`,
        `Distance: ${chunk.distance == null ? "n/a" : chunk.distance.toFixed(6)}`,
        `Retrieval score: ${retrievalScore.toFixed(6)}`,
        `Support score: ${supportScore.toFixed(6)}`,
        `Preview: ${preview}`
      ].join("\n")
    );
    prompt.push("");
  }

  return prompt.join("\n");
}
