import { spawn } from 'node:child_process';
import path from 'node:path';
import { fixtures } from './evaluation/fixtures.ts';
import { config } from './optimized/config.ts';
import { api, embed, modelInfo } from './optimized/ollama.ts';
import { atomicJson, optionalJson, hash } from './optimized/storage.ts';
import { createChromaClient } from './shared/chroma.ts';
import { buildChromaMetadata } from './shared/manifests.ts';
import type { EmbeddingManifest } from './models/chunk.models.ts';
const args = process.argv.slice(2);
const value = (key: string, fallback: string) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const size = Number(value('--size', '100'));
const cfg = config(); cfg.model = value('--model', cfg.model);
const fixture = fixtures(size);
const directory = path.resolve(cfg.root, 'evaluation', `legacy-${size}`);
const embedding = await modelInfo(cfg, cfg.embedModel);
const model = await modelInfo(cfg, cfg.model);
const collectionName = `rag_legacy_eval_${hash({ size, embedding: embedding.digest }).slice(0, 20)}`;
const manifest: EmbeddingManifest = { ...fixture.manifest, sourceManifestPath: path.join(directory, 'chunks.json'), sourceManifestGeneratedAt: fixture.manifest.generatedAt,
  model: cfg.embedModel, baseUrl: cfg.ollamaUrl, batchSize: 16, dimensions: 768, truncate: false, embeddingCount: size, chunks: [] };
for (let start = 0; start < size; start += 16) {
  const batch = fixture.manifest.chunks.slice(start, start + 16);
  const file = path.join(directory, `raw-embeddings-${start}-${embedding.digest}.json`);
  const vectors = await optionalJson<number[][]>(file) ?? await embed(cfg, batch.map(c => c.text));
  await atomicJson(file, vectors);
  manifest.chunks.push(...batch.map((c, i) => ({ ...c, embedding: vectors[i] })));
}
const collection = await createChromaClient(cfg).getOrCreateCollection({ name: collectionName, embeddingFunction: null });
for (let start = 0; start < size; start += 100) {
  const batch = manifest.chunks.slice(start, start + 100);
  await collection.upsert({ ids: batch.map(c => c.id), embeddings: batch.map(c => c.embedding), documents: batch.map(c => c.text), metadatas: batch.map(c => buildChromaMetadata(c, manifest)) });
}
await atomicJson(path.join(directory, 'chunks.json'), fixture.manifest);
await atomicJson(path.join(directory, 'embeddings.json'), manifest);
const rows: unknown[] = [];
for (const item of fixture.cases.filter(item => !args.includes('--facts-only') || item.kind === 'fact').slice(0, Number(value('--limit', '40')))) {
  const started = performance.now();
  const trace = path.join(directory, `trace-${item.id}.json`);
  const result = await new Promise<{ answer: string; stderr: string; code: number | null }>(resolve => {
    const child = spawn(process.execPath, ['--import', './src/evaluation/traceLegacy.ts', 'src/askLegacy.ts', '--answer-only', '--chat-model', cfg.model, item.question], {
      env: { ...process.env, CHROMA_COLLECTION: collectionName, CHUNKS_PATH: path.join(directory, 'chunks.json'),
        EMBEDDINGS_PATH: path.join(directory, 'embeddings.json'), KNOWLEDGE_CACHE_PATH: path.join(directory, 'no-knowledge-cache.json'),
        QUERY_CACHE_PATH: path.join(directory, `cache-${Date.now()}-${item.id}.json`), RAG_TRACE_FILE: trace },
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 600000,
    });
    let answer = '', stderr = '';
    child.stdout.on('data', data => { answer += data; }); child.stderr.on('data', data => { stderr += data; });
    child.on('error', error => resolve({ answer, stderr: error.message, code: -1 }));
    child.on('close', code => resolve({ answer: answer.trim(), stderr, code }));
  });
  rows.push({ ...item, ...result, totalMs: performance.now() - started,
    expectedStringsPresent: item.kind !== 'absent' ? item.expected.every(s => result.answer.toLowerCase().includes(s.toLowerCase())) : null,
    stages: await optionalJson(trace) });
  console.error(`${rows.length}/${Math.min(40, Number(value('--limit', '40')))} ${item.id}: ${result.code}`);
  await atomicJson(path.join(directory, `report-${cfg.model.replaceAll(':', '-')}.json`), { config: cfg, model, embedding, size, rows, synthetic: true, residency: await api(cfg, 'ps') });
}
