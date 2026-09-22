import path from 'node:path';
import { createChromaClient } from '../shared/chroma.ts';
import { fuse, searchBm25, terms } from './bm25.ts';
import type { SearchHit } from './bm25.ts';
import type { Config } from './config.ts';
import type { DocumentChunk, Snapshot } from './index.ts';
import { queryInput } from './index.ts';
import { embed } from './ollama.ts';
import { atomicJson, hash, optionalJson } from './storage.ts';
import type { TokenCounter } from './tokens.ts';
const chunkMaps = new WeakMap<Snapshot, Map<string, DocumentChunk>>();

export interface RetrievalMetric { embeddingCacheHit: boolean; embeddingMs: number; vectorMs: number; lexicalMs: number }
export async function retrieve(snapshot: Snapshot, question: string, cfg: Config, observe?: (metric: RetrievalMetric) => void): Promise<SearchHit[]> {
  const started = performance.now();
  const cacheFile = path.join(cfg.root, 'queries', `${hash({ query: question, embedding: snapshot.embedding })}.json`);
  let vector = await optionalJson<number[]>(cacheFile);
  const embeddingCacheHit = Boolean(vector);
  if (!vector) {
    [vector] = await embed(cfg, [queryInput(question)]);
    await atomicJson(cacheFile, vector);
  }
  if (vector.length !== snapshot.embedding.dimensions) throw new Error('Query embedding dimensions mismatch');
  const embeddingMs = performance.now() - started;
  const vectorStart = performance.now();
  const collection = await createChromaClient(cfg).getCollection({ name: snapshot.collection, embeddingFunction: undefined });
  if (collection.metadata?.index_id !== snapshot.id || collection.metadata?.digest !== snapshot.embedding.digest) throw new Error('Vector/lexical index revision mismatch');
  const result = await collection.query({ queryEmbeddings: [vector], nResults: Math.min(cfg.candidates, snapshot.chunks.length), include: ['distances'] });
  const vectorMs = performance.now() - vectorStart;
  const lexicalStart = performance.now();
  const lexical = searchBm25(snapshot.bm25, question, cfg.candidates);
  observe?.({ embeddingCacheHit, embeddingMs, vectorMs, lexicalMs: performance.now() - lexicalStart });
  return fuse([result.ids[0].map((id, i) => ({ id, score: -(result.distances?.[0]?.[i] ?? 0) })), lexical], cfg.rrf, cfg.candidates);
}
export function evidenceBlock(chunk: DocumentChunk): string {
  return `[${chunk.id}] Document: ${chunk.title}; Section: ${chunk.sectionPath.join(' > ')}\n${chunk.text}`;
}
export function selectContext(snapshot: Snapshot, hits: SearchHit[], question: string, cfg: Config, fits: (chunks: DocumentChunk[]) => boolean, counter: TokenCounter): DocumentChunk[] {
  let byId = chunkMaps.get(snapshot);
  if (!byId) { byId = new Map(snapshot.chunks.map(c => [c.id, c])); chunkMaps.set(snapshot, byId); }
  const selected: DocumentChunk[] = [];
  const texts = new Set<string>();
  // Explicit mixed letter/number identifiers are strong entity constraints (e.g. device IDs).
  // Prefer evidence matching them when present; never constrain vector/BM25 retrieval itself.
  const identifierTerms = (text: string) => terms(text).map(t => t.replace(/^[.-]+|[.-]+$/g, ''));
  const identifiers = identifierTerms(question).filter(t => /\p{L}/u.test(t) && /\p{N}/u.test(t));
  const anchored = identifiers.length ? hits.filter(h => {
    const chunk = byId!.get(h.id);
    const tokens = chunk ? new Set(identifierTerms(`${chunk.title} ${chunk.sectionPath.join(' ')} ${chunk.text}`)) : new Set<string>();
    return identifiers.some(id => tokens.has(id));
  }) : [];
  const contextHits = anchored.length ? anchored : hits;
  const add = (original: DocumentChunk) => {
    if (selected.some(c => c.id === original.id)) return false;
    const normalized = original.text.replace(/\s+/g, ' ').trim();
    if (texts.has(normalized)) return false;
    let chunk = original;
    if (!fits([...selected, chunk])) {
      // Prefer contiguous sentence windows around query terms, never synthetic summaries.
      const parts = original.text.split(/(?<=[.!?。])\s+|\n+/u);
      const queryTerms = new Set(terms(question));
      const ranked = parts.map((text, i) => ({ text, i, score: terms(text).filter(t => queryTerms.has(t)).length }))
        .sort((a, b) => b.score - a.score || a.i - b.i);
      const keep = new Set<number>();
      for (const part of ranked) {
        if (counter.count(part.text) > cfg.context / 2) continue;
        const proposed = [...keep, part.i].sort((a, b) => a - b).map(i => parts[i]).join('\n[…]\n');
        if (fits([...selected, { ...original, text: proposed }])) keep.add(part.i);
      }
      if (!keep.size) return false;
      chunk = { ...original, text: [...keep].sort((a, b) => a - b).map(i => parts[i]).join('\n[…]\n') };
    }
    selected.push(chunk); texts.add(normalized); return true;
  };
  for (const hit of contextHits) {
    if (selected.length >= cfg.chunks) break;
    const chunk = byId.get(hit.id);
    if (chunk) add(chunk);
  }
  let neighbors = 0;
  for (const chunk of [...selected]) {
    for (const id of [chunk.previousChunkId, chunk.nextChunkId]) {
      if (neighbors >= cfg.neighbors) break;
      const neighbor = id ? byId.get(id) : undefined;
      if (neighbor && neighbor.sourcePath === chunk.sourcePath &&
          terms(question).some(t => t.length > 3 && terms(neighbor.text).includes(t)) && add(neighbor)) neighbors++;
    }
  }
  return selected;
}
