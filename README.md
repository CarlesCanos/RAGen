# RAGen Local

[![CI](https://github.com/CarlesCanos/RAGen/actions/workflows/ci.yml/badge.svg)](https://github.com/CarlesCanos/RAGen/actions/workflows/ci.yml)

A small local RAG for Windows. It indexes your document folders and answers questions
with Ollama, EmbeddingGemma, and Chroma. Each project keeps its own folder, model,
settings, index, and chat history.

## Install

Requirements: Windows 10 or 11, an internet connection for the first setup, and App
Installer with `winget`.

1. Clone or download this repository.
2. Double-click `START-RAG.cmd`.
3. Wait for the browser to open at `http://127.0.0.1:8787`.

The launcher installs missing tools, downloads the local models, builds the first
index, and starts the app. The first run can take several minutes. Later starts reuse
the installed tools, models, and indexes.

## Use

1. Add a project and choose a documentation folder.
2. Regenerate the RAG to index that folder.
3. Ask questions in the chat.

Markdown, MDX, text, HTML, and PDF files are supported. You can switch projects without
losing their conversations. Individual documents are limited to 64 MiB. The latest 20
messages are stored for each project.

Regenerating a project clears its chat after the new index is ready. Removing a project
deletes its local settings, index, and chat, but never deletes the source documents.

Press Enter in the launcher window to stop the processes it started.

## Local data and security

Generated data is stored unencrypted under `rag/.runtime/` and is excluded from Git.
Chroma and Ollama are restricted to loopback connections. The app listens on loopback by
default. It has no authentication and must not be exposed to a network without additional
security.

The launcher downloads Chroma's official standalone Rust executable into
`rag/.runtime/`, verifies its pinned SHA-256, and runs it only on loopback. Python is not
required for Chroma.

Do not enable `RAG_DEBUG=1` for sensitive documents. Debug logs can contain document
text and raw model output.

## Development

```powershell
npm.cmd ci
npm.cmd run launch
npm.cmd test
npm.cmd run typecheck
```

See [RAG engine](rag/README.md), [internal flow](rag/FLOW.md), and
[chat interface](hono-chat/README.md) for technical details.

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull
request, and use [SECURITY.md](SECURITY.md) to report vulnerabilities privately.

## License

[MIT](LICENSE)
