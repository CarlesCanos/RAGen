// Loaded only by the baseline harness. Observe responses without changing request behavior.
import { writeFileSync } from 'node:fs';
const originalFetch = globalThis.fetch;
const stages: unknown[] = [];
globalThis.fetch = async (input, init) => {
  const started = performance.now();
  const response = await originalFetch(input, init);
  if (String(input).includes('/api/chat')) {
    const payload = await response.clone().json() as Record<string, unknown>;
    stages.push({ ms: performance.now() - started, promptTokens: payload.prompt_eval_count,
      outputTokens: payload.eval_count, loadDuration: payload.load_duration, promptDuration: payload.prompt_eval_duration, generationDuration: payload.eval_duration });
  }
  return response;
};
process.on('exit', () => { if (process.env.RAG_TRACE_FILE) writeFileSync(process.env.RAG_TRACE_FILE, JSON.stringify(stages)); });
