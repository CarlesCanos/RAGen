# Changelog

All notable changes to RAGen are documented in this file.

## Unreleased

## [1.2.0] - 2026-10-12

### Highlights

- Added a native Linux launcher that installs missing Node.js, Ollama, dependencies,
  models, tokenizer, and the verified Chroma runtime, then starts the local app.
- Added Linux folder selection and opening, with manual path entry for headless
  desktops and checks on both Windows and Ubuntu in CI.
- Updated the manual Chroma start commands to honor the configured host and port.

## [1.1.0] - 2026-10-12

### Highlights

- Split project settings into Technical and Visual tabs.
- Added per-project controls for the chat background, user and agent bubbles,
  chat text, agent name, font size, line spacing, character spacing, and extra
  spacing after line breaks.
- Added live previews and a way to restore the default appearance. Visual
  preferences are stored with each project's local data and do not rebuild the
  RAG index. Existing projects use the default appearance until customized.
- Updated dependencies and the CI setup action since v1.0.0.

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

[1.2.0]: https://github.com/CarlesCanos/RAGen/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/CarlesCanos/RAGen/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/CarlesCanos/RAGen/releases/tag/v1.0.0
