# Design and optimization

## Retrieval

The index combines two bounded retrieval paths:

- Chroma provides vector similarity with EmbeddingGemma.
- A persisted BM25 index provides lexical matching.
- Reciprocal Rank Fusion combines ranks without comparing incompatible score scales.
- Context selection adds useful neighboring chunks without exceeding `RAG_CONTEXT`.

Embeddings are cached by content, format, and model digest. Rebuilding an unchanged
corpus reuses them. Every successful build publishes a new collection and snapshot,
then atomically switches the active pointer.

## Generation

`fast` answers directly, `auto` detects complex questions, and `deep` always performs
bounded investigation. Model output must be valid JSON, report whether the evidence is
sufficient, and cite existing chunk IDs. Unsupported answers are neither shown nor
cached.

The answer cache key includes the question, index, model, configuration, tokenizer, and
prompt version. Errors and truncated or invalid answers are not cached.

## Budgets

Editable values are documented in `.env.example`:

- `RAG_CONTEXT`: total model context, minimum 2048.
- `RAG_CANDIDATES`: candidates retrieved by each search.
- `RAG_CONTEXT_CHUNKS`: main chunks sent to the model.
- `RAG_NEIGHBORS`: neighboring chunks allowed around selected evidence.
- `RAG_DIRECT_TOKENS` and `RAG_DEEP_TOKENS`: direct and complex answer output.
- `RAG_DECISION_TOKENS` and `RAG_VALIDATION_TOKENS`: planning and validation output.
- `RAG_TIMEOUT_MS` and `RAG_KEEP_ALIVE`: request deadline and Ollama model residency.

Token counting uses the tokenizer that matches the selected model and keeps a safety
margin. A missing or incompatible tokenizer causes an error instead of a silent estimate.

## Diagnostics

```powershell
npm.cmd run doctor
npm.cmd run ask -- "Your question" --metrics
```

`doctor` checks Ollama, model capabilities and context, EmbeddingGemma, Chroma, the
tokenizer, the active snapshot, and GPU residency. `--metrics` prints timing, search,
and token information.

`RAG_DEBUG=1` logs the full document context and raw model output. It can expose
sensitive information, so use it briefly and never share those logs.

## Verification

```powershell
npm.cmd run typecheck
npm.cmd test
$env:RAG_INTEGRATION='1'
node --test tests/integration.test.ts
Remove-Item Env:RAG_INTEGRATION
```

Live tests require Ollama, Chroma, the models, and an active index. See
[EVALUATION.md](EVALUATION.md) for retrieval and generation benchmarks.
