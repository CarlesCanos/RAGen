# Changelog

All notable changes to RAGen are documented in this file.

## [1.0.0] - 2026-09-22

First stable release.

### Highlights

- One-command Windows setup through `START-RAG.cmd`, including the local runtime,
  Chroma, Ollama models, and the web interface.
- Independent RAG projects with their own documents, settings, indexes, models,
  caches, and saved conversations.
- Markdown, MDX, text, HTML, and PDF ingestion.
- Local question answering with Ollama, Qwen, EmbeddingGemma, and Chroma.
- Project-specific model management and index regeneration from the web interface.
- GPU out-of-memory recovery that retries the current request on CPU.
- Structured diagnostic logs with request correlation, timing, token counts, errors,
  and one-second memory sampling during inference.
- Loopback-only local services, verified Chroma downloads, restricted runtime paths,
  and standards-based HTML parsing.
- Automated Windows CI, CodeQL scanning, Dependabot updates, secret scanning, and
  push protection.

[1.0.0]: https://github.com/CarlesCanos/RAGen/releases/tag/v1.0.0
