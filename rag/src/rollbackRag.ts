import path from 'node:path';
import { open, rm } from 'node:fs/promises';
import { config } from './optimized/config.ts';
import { readJson, atomicJson } from './optimized/storage.ts';
import type { Pointer, Snapshot } from './optimized/index.ts';
import { createChromaClient } from './shared/chroma.ts';
const cfg = config();
const lockPath = path.join(cfg.root, 'prepare.lock');
const lock = await open(lockPath, 'wx').catch(() => { throw new Error('Index publication/rollback is already running (or lock is stale)'); });
try {
const pointer = await readJson<Pointer>(path.join(cfg.root, 'active.json'));
if (!pointer.previous) throw new Error('No previous snapshot');
if (![pointer.active, pointer.previous].every(id => /^[a-f0-9-]+$/.test(id))) throw new Error('Invalid index pointer');
const snapshot = await readJson<Snapshot>(path.join(cfg.root, 'snapshots', `${pointer.previous}.json`));
if (snapshot.schema !== 2 || snapshot.id !== pointer.previous || snapshot.bm25.count !== snapshot.chunks.length) throw new Error('Incompatible previous snapshot');
const collection = await createChromaClient(cfg).getCollection({ name: snapshot.collection, embeddingFunction: undefined });
if (collection.metadata?.index_id !== snapshot.id || collection.metadata?.digest !== snapshot.embedding.digest) throw new Error('Previous vector/lexical index mismatch');
if (await collection.count() !== snapshot.chunks.length) throw new Error('Previous index incomplete');
await atomicJson(path.join(cfg.root, 'active.json'), { active: pointer.previous, previous: pointer.active });
console.log(`Restored index ${pointer.previous}`);
} finally { await lock.close(); await rm(lockPath); }
