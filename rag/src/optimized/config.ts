import { getProjectEnv } from '../env.ts';
import { assertLoopbackHttpUrl } from '../shared/network.ts';

export type Mode = 'auto' | 'fast' | 'deep';
export function config() {
  const env = getProjectEnv();
  assertLoopbackHttpUrl(env.ollamaUrl, 'OLLAMA_URL');
  const number = (key: string, fallback: number, min = 1) => {
    const value = Number(process.env[key] ?? fallback);
    if (!Number.isInteger(value) || value < min) throw new Error(`${key} must be an integer >= ${min}`);
    return value;
  };
  return {
    ollamaUrl: env.ollamaUrl, model: process.env.RAG_CHAT_MODEL || 'qwen3.5:4b-q4_K_M',
    embedModel: env.ollamaEmbedModel, language: process.env.ASK_PREFERRED_LANGUAGE?.trim() || 'Spanish',
    host: env.chromaHost, port: env.chromaPort, ssl: env.chromaSsl,
    collection: env.chromaCollection, root: process.env.RAG_INDEX_DIR || 'output/rag-v2',
    tokenizerDir: process.env.RAG_TOKENIZER_DIR || 'auto',
    context: number('RAG_CONTEXT', 4096, 2048), timeout: number('RAG_TIMEOUT_MS', 120000),
    candidates: number('RAG_CANDIDATES', 20), rrf: number('RAG_RRF_K', 60),
    chunks: number('RAG_CONTEXT_CHUNKS', 4), neighbors: number('RAG_NEIGHBORS', 2, 0),
    keepAlive: process.env.RAG_KEEP_ALIVE || '10m', temperature: env.ollamaTemperature,
    directTokens: number('RAG_DIRECT_TOKENS', 512), deepTokens: number('RAG_DEEP_TOKENS', 1024),
    decisionTokens: number('RAG_DECISION_TOKENS', 256), validationTokens: number('RAG_VALIDATION_TOKENS', 512),
  };
}
export type Config = ReturnType<typeof config>;
