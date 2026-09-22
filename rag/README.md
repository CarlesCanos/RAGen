# Local RAG engine

This is the document engine used by `../hono-chat/`. It splits documents, creates local
embeddings with EmbeddingGemma, builds a hybrid BM25 and Chroma index, and generates
grounded answers with a Qwen 3.5 model served by Ollama.

## Setup

The recommended setup is `../START-RAG.cmd`. It downloads and verifies the standalone
Chroma runtime, installs locked dependencies, starts local services, downloads required
models, and prepares the first index.

Manual commands from the repository root:

```powershell
npm.cmd ci
npm.cmd run start:chroma
npm.cmd run prepare-rag
npm.cmd run ask -- "Your question"
npm.cmd run doctor
```

`start:chroma` only uses the private runtime created under `rag/.runtime/`.

## Configuration

Available settings are documented in `.env.example`. A local `.env` can override the
defaults and is excluded from Git. Settings changed in the web interface are stored per
project instead of changing the global file.

Main values:

```dotenv
DOCS_DIR=./docs
DOCS_EXTENSIONS=.md,.mdx,.markdown,.txt,.html,.htm,.pdf
PDF_TO_TEXT_BIN=pdftotext
OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_EMBED_MODEL=embeddinggemma
RAG_CHAT_MODEL=qwen3.5:4b-q4_K_M
CHROMA_HOST=localhost
CHROMA_PORT=8000
CHROMA_SSL=false
```

PDF.js handles PDFs first with scripting and dynamic evaluation disabled. If extraction
fails, the engine uses the `pdftotext` compatible program set in `PDF_TO_TEXT_BIN`.

## Index and query

`prepare-rag` scans `DOCS_DIR`, creates chunks, reuses valid embeddings, publishes a new
immutable Chroma collection, and switches the active snapshot only after every step
succeeds.

```powershell
npm.cmd run prepare-rag
npm.cmd run ask -- "Summarize the procedure"
npm.cmd run ask -- "Compare the alternatives" --mode deep --metrics
```

Query modes:

- `fast` performs direct retrieval and answering.
- `auto` adds investigation when a question looks complex.
- `deep` always uses bounded planning and investigation.

Answers must be supported by retrieved chunks. When the evidence is insufficient, the
engine says so instead of filling gaps with general model knowledge.

## Local data

Each project stores its chunks, caches, snapshots, collection details, and conversation
under `rag/.runtime/projects/<id>/`. This content is plain text, excluded from Git, and
removed with the project. Source documents are never removed.

Diagnostic JSONL files live in `.runtime/logs/rag-<pid>.jsonl`. They record memory,
timings, request IDs and errors, with GPU samples every second during inference.
`RAG_DEBUG=1` also saves full prompts, document context and raw model output. The UI
applies this setting per project. Logs persist independently of project deletion;
each process rotates its file at roughly 5 MiB and keeps one previous file.
See the root README for instructions to follow a log.

## Chroma runtime

The launcher downloads the official standalone Windows executable from Chroma's GitHub
release into `rag/.runtime/chroma/`. Its version and SHA-256 are pinned in
`../start-local-rag.ps1`, and the launcher verifies the file before every start. Chroma
and Ollama are restricted to loopback connections.

See [FLOW.md](FLOW.md), [OPTIMIZATION.md](OPTIMIZATION.md), and
[EVALUATION.md](EVALUATION.md) for implementation details.
