import { config } from './optimized/config.ts';
import { activeSnapshot } from './optimized/index.ts';
import { modelInfo, tokenizerProfile } from './optimized/ollama.ts';
import { loadCounter } from './optimized/tokens.ts';
import { createChromaClient } from './shared/chroma.ts';

const cfg = config();
const snapshot = await activeSnapshot(cfg);
const embedding = await modelInfo(cfg, cfg.embedModel);
if (embedding.digest !== snapshot.embedding.digest) {
  throw new Error('The embedding model changed; the active index must be rebuilt.');
}

const collection = await createChromaClient(cfg).getCollection({
  name: snapshot.collection,
  embeddingFunction: undefined,
});
if (collection.metadata?.index_id !== snapshot.id || collection.metadata?.digest !== snapshot.embedding.digest) {
  throw new Error('The Chroma collection does not match the active snapshot.');
}
if (await collection.count() !== snapshot.chunks.length) {
  throw new Error('The Chroma collection is incomplete.');
}

const model = await modelInfo(cfg, cfg.model);
const tokenizer = await tokenizerProfile(cfg, model);
await loadCounter(tokenizer.directory);

console.log(JSON.stringify({
  ok: true,
  index: snapshot.id,
  chunks: snapshot.chunks.length,
  collection: snapshot.collection,
  model: model.name,
  embedding: embedding.name,
}));
