import path from 'node:path';
import { fixtures } from './evaluation/fixtures.ts';
import { config } from './optimized/config.ts';
import { activeSnapshot, publishIndex, enrich } from './optimized/index.ts';
import { buildBm25, searchBm25 } from './optimized/bm25.ts';
import { retrieve } from './optimized/retrieve.ts';
import type { RetrievalMetric } from './optimized/retrieve.ts';
import { askRag } from './optimized/ask.ts';
import { atomicJson, optionalJson } from './optimized/storage.ts';
import { api, modelInfo, tokenizerProfile } from './optimized/ollama.ts';

const args = process.argv.slice(2);
const value = (flag: string, fallback: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback;
const size = Number(value('--size', '100'));
const limit = Number(value('--limit', '40'));
if (!Number.isInteger(size) || size < 36 || !Number.isInteger(limit) || limit < 1) throw new Error('Invalid size/limit');
const lexicalOnly = args.includes('--lexical-only');
const retrievalOnly = args.includes('--retrieval-only') || lexicalOnly;
const base = config();
const cfg = { ...base, root: path.join(base.root, 'evaluation', String(size)), collection: 'rag_evaluation', model: value('--model', base.model), context: Number(value('--context', String(base.context))) };
if (!retrievalOnly && cfg.tokenizerDir === 'auto') cfg.tokenizerDir = (await tokenizerProfile(cfg, await modelInfo(cfg, cfg.model))).directory;
cfg.tokenizerDir = value('--tokenizer-dir', cfg.tokenizerDir);
const fixture = fixtures(size);
const indexStart = performance.now();
let snapshot;
if (!lexicalOnly) {
  const existing = await optionalJson(path.join(cfg.root, 'active.json'));
  snapshot = existing && !args.includes('--rebuild') ? await activeSnapshot(cfg) : (await publishIndex(fixture.manifest, cfg)).snapshot;
}
const bm25 = snapshot?.bm25 ?? buildBm25(enrich(fixture.manifest.chunks).map(c => ({ id: c.id, text: `${c.title} ${c.sectionPath.join(' ')} ${c.text}` })));
const indexMs = performance.now() - indexStart;
const rows: Array<Record<string, unknown>> = [];
const cases = (args.includes('--facts-only') ? fixture.cases.filter(c => c.kind === 'fact') : fixture.cases)
  .filter(c => !args.includes('--case') || c.id === value('--case', '')).slice(0, limit);
if (!cases.length) throw new Error('No matching evaluation cases');
const warmup = args.includes('--warmup') && !retrievalOnly ? await api(cfg, 'generate', {
  model: cfg.model, prompt: '', stream: false, keep_alive: cfg.keepAlive, options: { num_ctx: cfg.context },
}) : null;
const initialResidency = lexicalOnly ? null : await api(cfg, 'ps');
for (const item of cases) {
  const start = performance.now();
  try {
    let retrievalDetail: RetrievalMetric | undefined;
    const result = retrievalOnly ? undefined : await askRag(item.question, { config: cfg, cache: false, mode: 'auto' });
    const hits = result ? (result.metrics.searches[0]?.ids ?? []).map(id => ({ id, score: 0 }))
      : lexicalOnly ? searchBm25(bm25, item.question, 20) : await retrieve(snapshot!, item.question, cfg, detail => { retrievalDetail = detail; });
    if (result) retrievalDetail = result.metrics.searches[0]?.detail;
    const retrievalMs = result ? result.metrics.searches[0]?.ms ?? 0 : performance.now() - start;
    const ranks = item.evidence.map(id => hits.findIndex(h => h.id === id) + 1);
    rows.push({ id: item.id, kind: item.kind, question: item.question, expected: item.expected, evidence: item.evidence,
      recall20: ranks.length ? ranks.filter(r => r > 0).length / ranks.length : null,
      reciprocalRank: ranks.length ? 1 / Math.min(...ranks.filter(r => r > 0), Infinity) : null,
      retrievalMs, retrievalDetail, result,
      // Automated checks are proxies; factual fidelity requires reviewing the answer and evidence.
      expectedStringsPresent: result && item.kind !== 'absent' ? item.expected.every(s => result.answer.toLowerCase().includes(s.toLowerCase())) : null,
      abstained: result ? result.status === 'insufficient' : null,
    });
    console.error(`${rows.length}/${cases.length} ${item.id}: recall=${rows.at(-1)?.recall20}; ${result?.status ?? 'retrieval only'}`);
  } catch (error) {
    rows.push({ id: item.id, error: (error as Error).message });
    console.error(`${item.id}: ${(error as Error).message}`);
  }
  // Checkpoint long evaluations so interrupted runs remain reviewable.
  await atomicJson(path.join(cfg.root, `progress-${cfg.model.replaceAll(':', '-')}.json`), rows);
}
const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)] ?? 0;
const times = rows.map(r => Number((r.result as { metrics?: { totalMs: number } })?.metrics?.totalMs ?? r.retrievalMs)).filter(Number.isFinite);
const results = rows.flatMap(r => r.result ? [r.result as Awaited<ReturnType<typeof askRag>>] : []);
const stages = results.flatMap(r => r.metrics.stages);
const residency = lexicalOnly ? null : await api<{ models: Array<{ name: string; size: number; size_vram: number }> }>(cfg, 'ps');
const residentModel = residency?.models.find(m => m.name.toLowerCase() === cfg.model.toLowerCase());
const report = { generatedAt: new Date().toISOString(), synthetic: true,
  limitation: 'Synthetic varied fixtures; not a substitute for representative user data. expectedStringsPresent is not a factual fidelity score. Global evidence recall is a sample, not coverage of all documents.',
  config: cfg, lexicalOnly, retrievalOnly, size, indexMs, warmup,
  generationGpuResident: retrievalOnly ? null : Boolean(residentModel && residentModel.size_vram >= residentModel.size),
  summary: { count: rows.length, errors: rows.filter(r => r.error).length,
    invalidOrTruncated: rows.filter(r => ['invalid', 'truncated'].includes((r.result as { status?: string })?.status ?? '')).length,
    factualPass: rows.filter(r => r.kind === 'fact' && r.expectedStringsPresent === true).length,
    factualCount: rows.filter(r => r.kind === 'fact').length,
    absentAbstentions: rows.filter(r => r.kind === 'absent' && r.abstained === true).length,
    absentCount: rows.filter(r => r.kind === 'absent').length,
    llmCalls: stages.length,
    inputTokens: stages.reduce((n, s) => n + s.inputTokens, 0),
    outputTokens: stages.reduce((n, s) => n + s.outputTokens, 0),
    queryEmbeddingCacheHits: results.flatMap(r => r.metrics.searches).filter(s => s.detail?.embeddingCacheHit).length
      + rows.filter(r => !r.result && (r.retrievalDetail as RetrievalMetric)?.embeddingCacheHit).length,
    recall20: mean(rows.filter(r => typeof r.recall20 === 'number').map(r => Number(r.recall20))),
    mrr: mean(rows.filter(r => typeof r.reciprocalRank === 'number').map(r => Number(r.reciprocalRank))),
    medianMs: percentile(times, 0.5), p95Ms: percentile(times, 0.95) },
  memory: process.memoryUsage(), initialResidency, residency, rows };
const tag = value('--tag', '');
if (!/^[a-zA-Z0-9_-]*$/.test(tag)) throw new Error('Invalid report tag');
const file = path.join(cfg.root, `report-${lexicalOnly ? 'bm25' : retrievalOnly ? 'hybrid' : cfg.model.replaceAll(':', '-')}-${cfg.context}${tag ? '-' + tag : ''}.json`);
await atomicJson(file, report);
console.log(JSON.stringify({ file, ...report.summary }, null, 2));
if (report.summary.errors || report.summary.invalidOrTruncated) process.exitCode = 1;
