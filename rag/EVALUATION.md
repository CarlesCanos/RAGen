# Evaluation

The evaluator uses synthetic fixtures that are separate from real project documents and
collections. It catches retrieval, generation, and performance regressions. It does not
replace testing with documents that represent real use.

## Commands

Run from `rag/`:

```powershell
npm.cmd run evaluate -- --size 2000 --lexical-only
npm.cmd run evaluate -- --size 10000 --retrieval-only
npm.cmd run evaluate -- --size 2000
```

Options:

- `--size N` sets the synthetic corpus size. The minimum is 36.
- `--limit N` limits the number of cases.
- `--case ID` runs one case.
- `--facts-only` runs only factual questions.
- `--lexical-only` measures BM25 without Chroma or generation.
- `--retrieval-only` measures hybrid retrieval without answer generation.
- `--rebuild` rebuilds the evaluation collection.
- `--model NAME` and `--context N` override the model and context size.
- `--warmup` loads the model before measurement.
- `--tag NAME` adds a safe label to the report.

## Results

Reports are written to `RAG_INDEX_DIR/evaluation/<size>/` and include:

- evidence recall at 20 and MRR;
- median and p95 latency;
- errors, truncation, and invalid answers;
- correct abstentions for unanswerable cases;
- calls, tokens, and timing for each stage;
- memory use and model residency.

`expectedStringsPresent` only checks expected strings. It does not prove semantic
accuracy. Review answers, citations, and abstentions manually. Global questions sample
the available evidence and do not guarantee complete corpus coverage.

Do not build project indexes while running generation benchmarks. For fair comparisons,
change one variable at a time and keep the corpus, model, and warmup process unchanged.
