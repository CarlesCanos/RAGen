import { spawnSync } from 'node:child_process';
import { getProjectEnv } from './env.ts';
import { readJson } from './optimized/storage.ts';
import { publishIndex } from './optimized/index.ts';
import { config } from './optimized/config.ts';
import type { ChunkManifest } from './models/chunk.models.ts';

const env = getProjectEnv();
const split = spawnSync(process.execPath, ['src/splitMarkdown.ts'], { stdio: 'inherit' });
if (split.status !== 0) throw new Error('Document splitting failed; active index unchanged');
const result = await publishIndex(await readJson<ChunkManifest>(env.chunksPath), config());
console.log(JSON.stringify({ index: result.snapshot.id, collection: result.snapshot.collection,
  chunks: result.snapshot.chunks.length, reused: result.reused, embedded: result.embedded }));
