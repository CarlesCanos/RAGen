# RAG flow

## Indexing

`npm run prepare-rag` runs this pipeline:

```text
DOCS_DIR
  -> recursive discovery of supported files
  -> text extraction and semantic chunking
  -> local BM25 index
  -> reuse or generation of EmbeddingGemma vectors
  -> new immutable Chroma collection
  -> complete JSON snapshot
  -> atomic switch of the active pointer
```

The active index does not change if a step fails. A `prepare.lock` file prevents two
index builds from running together. Embeddings are keyed by a hash and reused when the
text, model, and format have not changed.

Main files:

- [src/prepareRag.ts](src/prepareRag.ts): indexing entry point.
- [src/splitMarkdown.ts](src/splitMarkdown.ts): document loading and chunking.
- [src/optimized/index.ts](src/optimized/index.ts): embeddings, Chroma, and publishing.
- [src/optimized/storage.ts](src/optimized/storage.ts): atomic storage and hashes.

## Querying

The web interface and `npm run ask` call `askRag()`:

```text
question
  -> normalization and validation
  -> active snapshot loading
  -> model and tokenizer checks
  -> exact answer cache lookup
  -> Chroma vector search and local BM25 search
  -> RRF fusion and token-aware context selection
  -> optional investigation
  -> structured answer generation with citations
  -> citation and sufficiency validation
  -> validated answer cache
```

`fast` uses the direct path. `auto` investigates complex requests, and `deep` always
uses bounded investigation. Retrieved content is treated as untrusted data. Only
citations that match selected chunks are accepted.

Main files:

- [src/askRag.ts](src/askRag.ts): CLI and public entry point.
- [src/optimized/ask.ts](src/optimized/ask.ts): orchestration and validation.
- [src/optimized/retrieve.ts](src/optimized/retrieve.ts): retrieval and context packing.
- [src/optimized/bm25.ts](src/optimized/bm25.ts): lexical index.
- [src/optimized/ollama.ts](src/optimized/ollama.ts): local model calls.
- [src/optimized/tokens.ts](src/optimized/tokens.ts): context budgeting.

## Project isolation

The interface builds a project-specific configuration before indexing or querying.
Each project has separate files under `rag/.runtime/projects/<id>/`, its own Chroma
collection, and its own model and settings.

Queries and rebuilds are serialized so a query cannot read an index while a new version
is being published. A successful rebuild clears that project's conversation.
