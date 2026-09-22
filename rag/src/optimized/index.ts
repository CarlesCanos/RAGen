import { mkdir, open, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Chunk, ChunkManifest } from '../models/chunk.models.ts';
import { createChromaClient } from '../shared/chroma.ts';
import type { Config } from './config.ts';
import { buildBm25 } from './bm25.ts';
import type { Bm25 } from './bm25.ts';
import { embed, modelInfo } from './ollama.ts';
import { atomicJson, hash, optionalJson, readJson } from './storage.ts';

export interface DocumentChunk extends Chunk { title: string; sectionPath: string[] }
export interface Snapshot {
  schema: 2; id: string; collection: string; createdAt: string;
  embedding: { model: string; digest: string; format: string; dimensions: number };
  chunks: DocumentChunk[]; bm25: Bm25;
}
export interface Pointer { active: string; previous?: string }
export const embeddingFormat = 'embeddinggemma-retrieval-v1';
const snapshots = new Map<string, Snapshot>();
export function enrich(chunks: Chunk[]): DocumentChunk[] {
  const headings = new Map<string, Array<{ level: number; text: string }>>();
  const previous = new Map<string, string>();
  return chunks.map(chunk => {
    let stack = headings.get(chunk.sourcePath) ?? [];
    const section = `${chunk.level}:${chunk.heading}`;
    if (previous.get(chunk.sourcePath) !== section) {
      stack = stack.filter(h => h.level < chunk.level);
      stack.push({ level: chunk.level, text: chunk.heading });
      headings.set(chunk.sourcePath, stack);
      previous.set(chunk.sourcePath, section);
    }
    return { ...chunk, title: path.basename(chunk.sourcePath), sectionPath: chunk.sectionPath ?? stack.map(h => h.text) };
  });
}
export function documentInput(chunk: DocumentChunk): string {
  return `title: ${chunk.title} | ${chunk.sectionPath.join(' > ')} | text: ${chunk.text}`;
}
export function queryInput(query: string): string { return `task: search result | query: ${query}`; }
export async function activeSnapshot(cfg: Config): Promise<Snapshot> {
  const pointer = await readJson<Pointer>(path.join(cfg.root, 'active.json')).catch(() => { throw new Error('No active RAG index. Run npm run prepare-rag.'); });
  if (!/^[a-f0-9-]+$/.test(pointer.active)) throw new Error('Invalid index pointer');
  const cacheKey = `${path.resolve(cfg.root)}:${pointer.active}`;
  const cached = snapshots.get(cacheKey);
  if (cached) return cached;
  const snapshot = await readJson<Snapshot>(path.join(cfg.root, 'snapshots', `${pointer.active}.json`));
  if (snapshot.schema !== 2 || snapshot.id !== pointer.active || snapshot.bm25.version !== 1 || snapshot.bm25.count !== snapshot.chunks.length || snapshot.embedding.format !== embeddingFormat) throw new Error('Incompatible index snapshot; rebuild with npm run prepare-rag');
  if (snapshots.size >= 4) snapshots.delete(snapshots.keys().next().value!);
  snapshots.set(cacheKey, snapshot);
  return snapshot;
}
export async function publishIndex(manifest: ChunkManifest, cfg: Config): Promise<{ snapshot: Snapshot; reused: number; embedded: number }> {
  await mkdir(cfg.root, { recursive: true });
  const lockPath = path.join(cfg.root, 'prepare.lock');
  const lock = await open(lockPath, 'wx').catch(() => { throw new Error(`Index build already running (or stale lock): ${lockPath}`); });
  try {
    const info = await modelInfo(cfg, cfg.embedModel);
    if (!info.name.toLowerCase().startsWith('embeddinggemma')) throw new Error('This index format requires EmbeddingGemma. Changing model requires a new input formatter.');
    const chunks = enrich(manifest.chunks);
    const bm25 = buildBm25(chunks.map(c => ({ id: c.id, text: `${c.title} ${c.sectionPath.join(' ')} ${c.text}` })));
    if (!chunks.length) throw new Error('Refusing to publish an empty corpus');
    const embeddings: number[][] = [];
    let reused = 0;
    const batchSize = 16;
    for (let start = 0; start < chunks.length; start += batchSize) {
      const batch = chunks.slice(start, start + batchSize);
      const inputs = batch.map(documentInput);
      const keys = inputs.map(text => hash({ text, digest: info.digest, format: embeddingFormat, dimensions: 768 }));
      const cached = await Promise.all(keys.map(key => optionalJson<number[]>(path.join(cfg.root, 'embeddings', `${key}.json`))));
      const missing = inputs.filter((_, i) => !cached[i]);
      const generated = missing.length ? await embed(cfg, missing) : [];
      let cursor = 0;
      for (let i = 0; i < batch.length; i++) {
        const vector = cached[i] ?? generated[cursor++];
        if (cached[i]) reused++;
        if (!vector || vector.length !== 768 || vector.some(v => !Number.isFinite(v))) throw new Error('Embedding dimension or values mismatch');
        embeddings.push(vector);
        if (!cached[i]) await atomicJson(path.join(cfg.root, 'embeddings', `${keys[i]}.json`), vector);
      }
      console.error(`Embeddings ${Math.min(start + batchSize, chunks.length)}/${chunks.length}; reused ${reused}`);
    }
    const id = randomUUID();
    const client = createChromaClient(cfg);
    // New immutable collection means removed/changed chunks cannot leak from the prior revision.
    const collectionName = `${cfg.collection.slice(0, 45)}_${id.replaceAll('-', '')}`;
    const collection = await client.createCollection({ name: collectionName, embeddingFunction: null,
      metadata: { schema: 2, digest: info.digest, format: embeddingFormat, index_id: id },
    });
    for (let start = 0; start < chunks.length; start += 100) {
      const batch = chunks.slice(start, start + 100);
      await collection.add({ ids: batch.map(c => c.id), embeddings: embeddings.slice(start, start + batch.length),
        documents: batch.map(c => c.text), metadatas: batch.map(c => ({ source: c.sourcePath, heading: c.heading })) });
    }
    if (await collection.count() !== chunks.length) throw new Error('Collection count mismatch: active index unchanged');
    const snapshot: Snapshot = { schema: 2, id, collection: collectionName, createdAt: new Date().toISOString(),
      embedding: { model: cfg.embedModel, digest: info.digest, format: embeddingFormat, dimensions: 768 }, chunks, bm25 };
    await atomicJson(path.join(cfg.root, 'snapshots', `${id}.json`), snapshot);
    const old = await optionalJson<Pointer>(path.join(cfg.root, 'active.json'));
    await atomicJson(path.join(cfg.root, 'active.json'), { active: id, previous: old?.active });
    return { snapshot, reused, embedded: chunks.length - reused };
  } finally {
    await lock.close();
    await rm(lockPath);
  }
}
