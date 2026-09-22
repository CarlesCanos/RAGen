export type IntentAnswerInstructionPayload = {
  detail_level?: "brief" | "normal" | "detailed" | "very_detailed" | null;
  include_examples?: boolean | null;
  max_lines?: number | null;
  output_format?: "plain_text" | "bullet_list" | "step_by_step" | null;
  output_language?: string | null;
  tone?: string | null;
};

export type IntentSplitResponse = {
  retrieval_question?: string;
  answer_instruction?: IntentAnswerInstructionPayload | null;
};
