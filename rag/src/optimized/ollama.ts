import type { Config } from './config.ts';
import { assertLoopbackHttpUrl } from '../shared/network.ts';
import { debugEnabled, errorDetails, trace } from '../shared/diagnostics.ts';

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
export class OllamaError extends Error {
  readonly code: 'gpu-memory' | 'http' | 'unavailable' | 'timeout';
  readonly publicMessage: string;
  constructor(message: string, code: OllamaError['code'], publicMessage: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OllamaError';
    this.code = code;
    this.publicMessage = publicMessage;
  }
}

export interface StageMetric { stage: string; ms: number; inputTokens: number; outputTokens: number; loadMs: number; promptMs: number; generationMs: number; doneReason?: string; cpuFallback?: boolean }
export async function api<T>(cfg: Pick<Config, 'ollamaUrl' | 'timeout'>, endpoint: string, body?: unknown): Promise<T> {
  assertLoopbackHttpUrl(cfg.ollamaUrl, 'OLLAMA_URL');
  const start = performance.now();
  const signal = AbortSignal.timeout(cfg.timeout);
  try {
    const response = await fetch(`${cfg.ollamaUrl}/api/${endpoint}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' }, signal,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      const gpuMemory = response.status >= 500 && /(?:CUDA|GPU|VRAM).*out of memory|out of memory.*(?:CUDA|GPU|VRAM)/i.test(detail);
      throw new OllamaError(`Ollama ${endpoint}: HTTP ${response.status}: ${detail}`, gpuMemory ? 'gpu-memory' : 'http',
        gpuMemory ? 'Ollama ran out of GPU memory. Close GPU-heavy applications or select a smaller model and try again.'
          : `Ollama could not complete the ${endpoint} request (HTTP ${response.status}). Check the Ollama server log and selected model.`);
    }
    return await response.json() as T;
  } catch (error) {
    const timedOut = signal.aborted || (error instanceof Error && error.name === 'TimeoutError');
    await trace('ollama.error', { endpoint, elapsedMs: performance.now() - start, error: errorDetails(error) }, true);
    if (error instanceof OllamaError) throw error;
    if (timedOut) {
      throw new OllamaError(`Ollama ${endpoint} timed out after ${cfg.timeout} ms`, 'timeout',
        `Ollama took longer than ${cfg.timeout / 1000} seconds. Try a smaller model or increase RAG_TIMEOUT_MS in Settings.`, { cause: error });
    }
    throw new OllamaError(`Ollama ${endpoint} request failed`, 'unavailable',
      'Could not communicate with Ollama. Check that Ollama is running, then try again.', { cause: error });
  }
}

// Scoped to a single query/build config: later stages reuse CPU after a GPU OOM,
// while a new question can try the GPU again when memory has become available.
const cpuModels = new WeakMap<Config, Set<string>>();
async function inference<T>(cfg: Config, endpoint: 'chat' | 'embed', body: { model: string; options?: Record<string, unknown>; [key: string]: unknown }): Promise<T> {
  const attempt = async (cpu: boolean) => {
    const request = cpu ? { ...body, options: { ...body.options, num_gpu: 0 } } : body;
    const start = performance.now();
    await trace('ollama.request', { endpoint, model: body.model, cpuFallback: cpu, options: request.options,
      ...(debugEnabled() ? { body: request } : {}) }, true);
    // Sample while Ollama runs as well as before/after, to catch allocation spikes.
    let sampling = false;
    const timer = setInterval(() => {
      if (sampling) return;
      sampling = true;
      void trace('ollama.memory', { endpoint, model: body.model, elapsedMs: performance.now() - start }, true)
        .finally(() => { sampling = false; });
    }, 1000);
    timer.unref();
    try {
      const response = await api<T>(cfg, endpoint, request);
      await trace('ollama.response', { endpoint, model: body.model, elapsedMs: performance.now() - start,
        ...(debugEnabled() && endpoint === 'chat' ? { body: response } : {}) }, true);
      return response;
    } finally { clearInterval(timer); }
  };
  const onCpu = () => attempt(true);
  if (cpuModels.get(cfg)?.has(body.model)) return onCpu();
  try { return await attempt(false); }
  catch (error) {
    if (!(error instanceof OllamaError) || error.code !== 'gpu-memory') throw error;
    const models = cpuModels.get(cfg) ?? new Set<string>();
    models.add(body.model);
    cpuModels.set(cfg, models);
    console.warn('[rag] Ollama exhausted GPU memory; retrying on CPU. Generation may take longer.');
    await trace('ollama.cpu_fallback', { endpoint, model: body.model, reason: error.message });
    return onCpu();
  }
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
  const result = await inference<{ embeddings: number[][] }>(cfg, 'embed', {
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
  await trace('generation.start', { stage, model: cfg.model, tokens, think, json, promptChars: prompt.length, systemChars: system.length });
  const response = await inference<{
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
    doneReason: response.done_reason,
    ...(cpuModels.get(cfg)?.has(cfg.model) ? { cpuFallback: true } : {}) });
  // Deliberately never fall back to message.thinking.
  await trace('generation.end', { ...metrics.at(-1) });
  return { content: response.message?.content?.trim() ?? '', truncated: response.done_reason === 'length',
    reasoning: think ? response.message?.thinking : undefined, outputTokens: response.eval_count ?? tokens };
}
