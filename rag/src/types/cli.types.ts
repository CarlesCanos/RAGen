export type SplitOptions = {
  targetChars: number;
  maxChars: number;
  overlapChars: number;
};

export type SplitCliArgs = {
  inputPath: string;
  outputPath?: string;
  options: SplitOptions;
};

export type EmbedCliArgs = {
  inputPath: string;
  outputPath?: string;
  model: string;
  baseUrl: string;
  batchSize: number;
  truncate: boolean;
  dimensions?: number;
};

export type ChromaConnectionCliArgs = {
  host: string;
  port: number;
  ssl: boolean;
  database?: string;
  tenant?: string;
};

export type IngestCliArgs = ChromaConnectionCliArgs & {
  inputPath: string;
  collectionName: string;
  batchSize: number;
  resetCollection: boolean;
};

export type ChromaCollectionCliArgs = ChromaConnectionCliArgs & {
  collectionName: string;
};

export type AskCliArgs = ChromaConnectionCliArgs & {
  question: string;
  collectionName: string;
  ollamaUrl: string;
  embedModel: string;
  chatModel?: string;
  topK: number;
  maxContextChars: number;
  showPrompt: boolean;
  answerOnly: boolean;
  maxSearchAttempts: number;
};
