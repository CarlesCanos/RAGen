import { getProjectEnv } from "../env.ts";
import type { RetrievedChunk, SearchAttempt } from "../models/retrieval.models.ts";
import { buildAnswerPrompt } from "../prompts/answer.prompts.ts";

export function buildPrompt(
  retrievalQuestion: string,
  answerInstruction: string,
  chunks: RetrievedChunk[]
): string {
  const effectiveInstruction = answerInstruction.trim() || getProjectEnv().askDefaultAnswerInstruction;
  return buildAnswerPrompt(retrievalQuestion, effectiveInstruction, chunks);
}

export function printRetrievedChunks(chunks: RetrievedChunk[]): void {
  console.log("\n=== Retrieved Chunks ===\n");

  if (chunks.length === 0) {
    console.log("No chunks retrieved.");
    return;
  }

  for (const chunk of chunks) {
    const source = chunk.metadata?.source_path ?? chunk.metadata?.source ?? "unknown";
    const heading = chunk.metadata?.heading ?? "(none)";
    const distance = chunk.distance === null ? "n/a" : chunk.distance.toFixed(6);
    const codeInfo = chunk.metadata?.has_code
      ? ` | code=${chunk.metadata.code_language ?? "yes"}`
      : "";

    console.log(`[${chunk.id}] ${source} | ${heading}${codeInfo} | distance=${distance}`);
  }
}

export function printSearchAttempts(attempts: SearchAttempt[]): void {
  if (attempts.length <= 1) {
    return;
  }

  console.log("\n=== Search Attempts ===\n");
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];
    console.log(`Attempt ${index + 1}: ${attempt.query}`);
    console.log(`Reason: ${attempt.reason}`);
  }
}

export function printParsedIntent(
  retrievalQuestion: string,
  answerInstruction: string,
  debug?: {
    llmSplitRawResponse?: string;
    llmSplitRetrievalQuestion?: string;
    llmSplitAnswerInstruction?: string;
    effectiveSplitJson?: string;
    generationAnswerInstruction?: string;
    targetLanguage?: string;
  }
): void {
  if (!answerInstruction.trim() && !debug?.llmSplitRawResponse?.trim()) {
    return;
  }

  console.log("\n=== Parsed Intent ===\n");
  if (debug?.llmSplitRawResponse?.trim()) {
    console.log("LLM raw JSON:");
    console.log(debug.llmSplitRawResponse.trim());
    console.log("");
    console.log(`LLM retrieval_question: ${debug.llmSplitRetrievalQuestion ?? "(empty)"}`);
    console.log(`LLM answer_instruction: ${debug.llmSplitAnswerInstruction ?? "(empty)"}`);
    console.log("");
  }
  if (debug?.effectiveSplitJson?.trim()) {
    console.log("Effective JSON with defaults:");
    console.log(debug.effectiveSplitJson.trim());
    console.log("");
  }
  console.log(`Retrieve: ${retrievalQuestion}`);
  console.log(`Answer style: ${answerInstruction || getProjectEnv().askDefaultAnswerInstruction}`);
  if (debug?.generationAnswerInstruction || debug?.targetLanguage) {
    console.log(`Generation style: ${debug.generationAnswerInstruction || "(default)"}`);
    console.log(`Final language: ${debug.targetLanguage || "English"}`);
  }
}
