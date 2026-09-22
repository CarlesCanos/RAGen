export type RagSearchOptions = {
  question: string;
  ollamaUrl: string;
  embedModel: string;
  chatModel?: string;
  topK: number;
  maxSearchAttempts: number;
};
