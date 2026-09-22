# RAGen

[![CI](https://github.com/CarlesCanos/RAGen/actions/workflows/ci.yml/badge.svg)](https://github.com/CarlesCanos/RAGen/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A small local-first RAG for Windows. Choose one or more document folders, build an
independent RAG project for each one, and ask questions through a local web interface.
Answers are generated locally with Ollama, Qwen, EmbeddingGemma, and Chroma.

## Quick start

Requirements: Windows 10 or 11, an internet connection for the first setup, and App
Installer with `winget`.

1. Clone or download this repository.
2. Double-click `START-RAG.cmd`.
3. Wait for RAGen to open at `http://127.0.0.1:8787`.

The first start installs missing tools, downloads the required local models and runtime,
then prepares the initial index. Later starts reuse them.

## Use

1. Create a project and choose its document folder.
2. Select **Regenerate RAG** to index the folder.
3. Ask questions in the chat.

Each project has its own folder, model, settings, index, search collection, and saved
conversation. The interface supports Markdown, MDX, text, HTML, and PDF files. It keeps
the latest 20 messages per project, including after a page reload or server restart.

Regenerating an index or removing a project clears that project’s conversation. Removing
a project removes only RAGen’s generated local data, never the original documents.

Answers run one at a time because every project shares the same local model and hardware.
You can switch projects while an answer is running, but wait for it to finish before
asking another question.

## Settings

The **Settings** panel is project-specific. Hover over the `?` beside a setting to see
what it controls, expected values, and the practical effect of raising or lowering it.
Settings that affect document indexing show an option to regenerate the index.

The default answer language is English. Change `ASK_PREFERRED_LANGUAGE` in the project
settings to request another language.

## Local data and security

RAGen stores indexes, settings, caches, conversations, downloaded runtimes, and models
under `rag/.runtime/`. This data is unencrypted and excluded from Git. Do not place that
folder in a shared or backed-up location unless that is intentional.

The app, Chroma, and Ollama use loopback addresses only. The app has no authentication,
so do not expose it to your network or the internet without adding authentication and
network protections.

Chroma uses its official standalone Windows executable. The launcher downloads it into
`rag/.runtime/`, verifies its pinned SHA-256, and starts it on loopback only. Python is
not required for Chroma.

Keep `RAG_DEBUG=0` for normal use. Debug mode can write document context and raw model
output to the console.

Press Enter in the launcher window to stop the processes it started.

## Development

From the repository root:

```powershell
npm.cmd ci
npm.cmd run typecheck
npm.cmd test
npm.cmd run launch
```

See [RAG engine](rag/README.md), [chat interface](hono-chat/README.md), and
[CONTRIBUTING.md](CONTRIBUTING.md) for implementation and contribution details. Report
security issues through [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
