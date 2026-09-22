import type { IntentAnswerInstructionPayload } from "../types/intent.types.ts";

export type AskIntent = {
  rawQuestion: string;
  retrievalQuestion: string;
  answerInstruction: string;
  answerInstructionPayload: Required<IntentAnswerInstructionPayload>;
  combinedIntent: string;
  llmSplitRawResponse?: string;
  llmSplitRetrievalQuestion?: string;
  llmSplitAnswerInstruction?: string;
  effectiveSplitJson?: string;
};
