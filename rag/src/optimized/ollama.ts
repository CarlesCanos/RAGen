import type { Config } from './config.ts';
import { assertLoopbackHttpUrl } from '../shared/network.ts';

export interface ModelInfo { name: string; digest: string; size: number; details: { family: string; quantization_level: string } }
const profiles = new Map<string, { repository: string; directory: string }>();
export async function tokenizerProfile(cfg: Config, model: ModelInfo): Promise<{ repository: string; directory: string }> {
  const key = `${cfg.ollamaUrl}:${model.digest}`;
  const cached = profiles.get(key);
  if (cached) return cached;
  let profile;
  if (['qwen3_5', 'qwen35'].includes(model.details.family)) {
    profile = { repository: 'Qwen/Qwen3.5-4B', directory: 'output/tokenizer-qwen3.5' };
  } else throw new Error('Install and register a compatible tokenizer/template before using this model');
  if (profiles.size >= 8) profiles.delete(profiles.keys().next().value!);
  profiles.set(key, profile);
  return profile;
}
export interface StageMetric { stage: string; ms: number; inputTokens: number; outputTokens: number; loadMs: number; promptMs: number; generationMs: number; doneReason?: string }
export async function api<T>(cfg: Pick<Config, 'ollamaUrl' | 'timeout'>, endpoint: string, body?: unknown): Promise<T> {
  assertLoopbackHttpUrl(cfg.ollamaUrl, 'OLLAMA_URL');
  const response = await fetch(`${cfg.ollamaUrl}/api/${endpoint}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(cfg.timeout),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`Ollama ${endpoint}: HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return await response.json() as T;
}
export async function modelInfo(cfg: Pick<Config, 'ollamaUrl' | 'timeout'>, name: string): Promise<ModelInfo> {
  const { models } = await api<{ models: ModelInfo[] }>(cfg, 'tags');
  const found = resolveModel(models, name);
  if (!found) throw new Error(`Model ${name} is not installed. Run npm run setup:rag first.`);
  return found;
}
export function resolveModel(models: ModelInfo[], requested: string): ModelInfo | undefined {
  const name = requested.toLowerCase();
  const exact = models.find(model => model.name.toLowerCase() === name || model.name.toLowerCase() === `${name}:latest`);
  if (exact) return exact;
  // Some native Ollama packages expose the quantization as a tag suffix. Accept it
  // only when unambiguous; never choose silently between multiple quantizations.
  const variants = models.filter(model => model.name.toLowerCase().startsWith(`${name}-`));
  if (variants.length > 1) throw new Error(`Model ${requested} is ambiguous: ${variants.map(model => model.name).join(', ')}`);
  return variants[0];
}
export async function embed(cfg: Config, input: string[]): Promise<number[][]> {
  const result = await api<{ embeddings: number[][] }>(cfg, 'embed', {
    model: cfg.embedModel, input, truncate: false, keep_alive: cfg.keepAlive,
  });
  if (result.embeddings?.length !== input.length || result.embeddings.some(e => !e.length || e.some(v => !Number.isFinite(v)))) {
    throw new Error('Invalid embedding response');
  }
  return result.embeddings;
}
export interface ChatResult { content: string; truncated: boolean; reasoning?: string; outputTokens: number }
export async function chat(cfg: Config, stage: string, system: string, prompt: string, tokens: number, think: boolean, metrics: StageMetric[], json = false, allowedIds: string[] = []): Promise<ChatResult> {
  const start = performance.now();
  const response = await api<{
    message?: { content?: string; thinking?: string }; done_reason?: string;
    prompt_eval_count?: number; eval_count?: number; load_duration?: number;
    prompt_eval_duration?: number; eval_duration?: number;
  }>(cfg, 'chat', {
    model: cfg.model, stream: false, think, keep_alive: cfg.keepAlive,
    options: { temperature: cfg.temperature, num_ctx: cfg.context, num_predict: tokens },
    ...(json ? { format: stage === 'plan'
      ? { type: 'object', properties: { queries: { type: 'array', maxItems: 2, items: { type: 'string' } } }, required: ['queries'], additionalProperties: false }
      : { type: 'object', properties: { answer: { type: 'string' }, sufficient: { type: 'boolean' }, citations: { type: 'array', items: { type: 'string', ...(allowedIds.length ? { enum: allowedIds } : {}) } } }, required: ['answer', 'sufficient', 'citations'], additionalProperties: false }
    } : {}),
    messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
  });
  metrics.push({ stage, ms: performance.now() - start, inputTokens: response.prompt_eval_count ?? 0,
    outputTokens: response.eval_count ?? 0, loadMs: (response.load_duration ?? 0) / 1e6,
    promptMs: (response.prompt_eval_duration ?? 0) / 1e6, generationMs: (response.eval_duration ?? 0) / 1e6,
    doneReason: response.done_reason });
  // Deliberately never fall back to message.thinking.
  if (process.env.RAG_DEBUG === '1') console.error(JSON.stringify({ stage, content: response.message?.content, doneReason: response.done_reason }));
  return { content: response.message?.content?.trim() ?? '', truncated: response.done_reason === 'length',
    reasoning: think ? response.message?.thinking : undefined, outputTokens: response.eval_count ?? tokens };
}
