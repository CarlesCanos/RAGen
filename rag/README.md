# Local RAG engine

This is the document engine used by `../hono-chat/`. It splits documents, creates local
embeddings with EmbeddingGemma, builds a hybrid BM25 and Chroma index, and generates
grounded answers with a Qwen 3.5 model served by Ollama.

## Setup

The recommended setup is `../START-RAG.cmd`. It creates the private Chroma runtime,
installs locked dependencies, starts local services, downloads required models, and
prepares the first index.

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

`RAG_DEBUG=1` logs document context and raw model output. Do not use it with sensitive
documents or shared logs.

## Chroma dependencies

`requirements-chroma.txt` contains the direct requirement.
`requirements-chroma.lock.txt` pins the full dependency tree with hashes.

```powershell
rag\.runtime\chroma-venv\Scripts\python.exe -m piptools compile --generate-hashes --allow-unsafe --resolver=backtracking --output-file rag\requirements-chroma.lock.txt rag\requirements-chroma.txt
```

The launcher uses Chroma's Rust server through `chroma run` and restricts it to loopback.
CVE-2026-45829 affects the Python FastAPI backend, which this project does not start.
The private environment isolates Python dependencies, but does not restrict process
access to the Windows file system.

See [FLOW.md](FLOW.md), [OPTIMIZATION.md](OPTIMIZATION.md), and
[EVALUATION.md](EVALUATION.md) for implementation details.
