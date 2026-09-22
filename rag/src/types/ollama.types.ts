export type OllamaEmbedResponse = {
  embeddings?: number[][];
  error?: string;
};

export type OllamaChatResponse = {
  message?: {
    role?: string;
    content?: string;
    thinking?: string;
  };
  error?: string;
};

export type EmbedRequestOptions = {
  baseUrl: string;
  model: string;
  truncate?: boolean;
  dimensions?: number;
  unreachableMessage?: string;
};

export type ChatRequestOptions = {
  ollamaUrl: string;
  model: string;
  systemPrompt: string;
  prompt: string;
  format?: "json";
  temperature?: number;
};
