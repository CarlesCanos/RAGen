import path from 'node:path';
import { config } from './optimized/config.ts';
import { api, modelInfo, tokenizerProfile } from './optimized/ollama.ts';
import { activeSnapshot } from './optimized/index.ts';
import { loadCounter } from './optimized/tokens.ts';
import { createChromaClient } from './shared/chroma.ts';
import { atomicJson } from './optimized/storage.ts';
const cfg = config();
const report: Record<string, unknown> = { time: new Date().toISOString(), config: cfg };
let failed = false;
async function check(name: string, operation: () => Promise<unknown>) {
  try { report[name] = await operation(); }
  catch (error) { report[name] = { error: (error as Error).message }; failed = true; }
}
await check('ollama', () => api(cfg, 'version'));
await check('model', () => modelInfo(cfg, cfg.model));
await check('modelCapabilities', async () => {
  const info = await api<{ model_info?: Record<string, unknown>; capabilities?: string[] }>(cfg, 'show', { model: cfg.model });
  const contextLimits = Object.entries(info.model_info ?? {}).filter(([key]) => key.endsWith('.context_length'));
  if (contextLimits.some(([, limit]) => typeof limit === 'number' && cfg.context > limit)) failed = true;
  return { requestedContext: cfg.context, contextLimits, capabilities: info.capabilities };
});
await check('embedding', () => modelInfo(cfg, cfg.embedModel));
await check('chroma', () => createChromaClient(cfg).heartbeat());
await check('tokenizer', async () => {
  if (cfg.tokenizerDir === 'auto') cfg.tokenizerDir = (await tokenizerProfile(cfg, await modelInfo(cfg, cfg.model))).directory;
  return { sampleTokens: (await loadCounter(cfg.tokenizerDir)).count('Texto de prueba / test text.') };
});
await check('index', async () => { const snapshot = await activeSnapshot(cfg); return { id: snapshot.id, chunks: snapshot.chunks.length, embedding: snapshot.embedding }; });
await check('gpu', async () => {
  const result = await api<{ models: Array<{ name: string; size: number; size_vram: number; context_length: number }> }>(cfg, 'ps');
  const model = result.models.find(m => m.name.toLowerCase() === cfg.model.toLowerCase());
  if (!model) return { status: 'not-loaded', performanceValidated: false, message: 'Run a question before validating GPU residency', loaded: result.models };
  if (model.size_vram === 0) { failed = true; return { status: 'CPU', ...model }; }
  return { status: model.size_vram >= model.size ? 'GPU' : 'partial-GPU', contextMatches: model.context_length === cfg.context, ...model };
});
report.memory = process.memoryUsage();
await atomicJson(path.join(cfg.root, 'doctor.json'), report);
console.log(JSON.stringify(report, null, 2));
if (failed) process.exitCode = 1;
