# RAGen

[![CI](https://github.com/CarlesCanos/RAGen/actions/workflows/ci.yml/badge.svg)](https://github.com/CarlesCanos/RAGen/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A small local-first RAG for Windows and Linux. Choose one or more document folders,
build an independent RAG project for each one, and ask questions through a local web interface.
Answers are generated locally with Ollama, Qwen, EmbeddingGemma, and Chroma.

## Quick start

Requirements: Windows 10 or 11 with App Installer (`winget`), or 64-bit x86 Linux
(such as Ubuntu) with `bash`, `curl`, `tar`, `sha256sum`, and `setsid`. An internet
connection is needed for the first setup. Linux ARM64 can run the app with an
existing Chroma server, but the bundled Chroma download is currently x86_64 only.

1. Clone or download this repository.
2. On Windows, double-click `START-RAG.cmd`. On Linux, run `bash START-RAG.sh` in a terminal.
3. Wait for RAGen to open at `http://127.0.0.1:8787`. If the browser does not open,
   visit that address yourself.

The first start installs missing tools, downloads the required local models and runtime,
then prepares the initial index. Later starts reuse them. Linux may request your sudo
password while installing `zstd` and Ollama. Close RAGen by pressing Enter in the
launcher terminal.

On Windows with WSL, use WSL2. Check with `wsl --list --verbose` in PowerShell; if
Ubuntu is on version 1, convert it with `wsl --set-version Ubuntu 2` before running
RAGen. Use a separate Linux clone inside WSL (for example, under your
Linux home directory), then run `bash START-RAG.sh` there. Sharing one checkout between
Windows and WSL makes `node_modules` change platforms on each start. WSL without a
Linux desktop folder picker lets you enter an absolute document path in the chat.

![RAGen workflow: launching START-RAG.cmd, opening the local interface, and sending the first question](assets/ragen-workflow.gif)

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

If Ollama runs out of GPU memory, RAGen retries that model on the CPU for the
current question. This can be slower. Close GPU-heavy applications or select a
smaller model to reduce memory pressure. If a request times out, increase
`RAG_TIMEOUT_MS` in the project's **Settings**. Ollama failures now show a specific
error in the chat; full diagnostic details are saved in the local logs.

## Troubleshooting logs

Logs are saved as `rag/.runtime/logs/rag-<pid>.jsonl` (one JSON event per line).
They include request IDs, model settings, generation timings, token counts, errors
with stack traces, and CPU fallback attempts. Memory snapshots include Node memory,
system RAM, and NVIDIA GPU memory/utilization when `nvidia-smi` is available. During
inference, memory is sampled every second; very short spikes may still be missed.

For full questions, retrieved context, exact Ollama prompts, and raw model responses,
set **RAG_DEBUG** to `1` in the project's **Settings**, then repeat the question.
Set it back to `0` afterward. Debug logs contain your document content. Logs stay
local and are excluded from Git. Each process keeps a roughly 5 MiB current file
and one rotated `.jsonl.1` file; files from older runs remain until you remove them.

To follow the newest log from the repository root:

```powershell
$ragLog = Get-ChildItem .\rag\.runtime\logs\*.jsonl | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Get-Content -LiteralPath $ragLog.FullName -Tail 30 -Wait
```

## Settings

The **Settings** panel is project-specific. Hover over the `?` beside a setting to see
what it controls, expected values, and the practical effect of raising or lowering it.
Settings that affect document indexing show an option to regenerate the index.

The **Technical** tab contains the RAG settings. The **Visual** tab lets you change the
chat background, user and agent bubble colors, text and agent name colors, line spacing,
extra space after line breaks, character spacing, and font size. Visual changes are saved per project and do not
require regenerating the index.

The default answer language is English. Change `ASK_PREFERRED_LANGUAGE` in the project
settings to request another language.

## Local data and security

RAGen stores indexes, settings, caches, conversations, and downloaded runtimes under
`rag/.runtime/`. Ollama stores downloaded models in its own model directory. This data
is unencrypted and excluded from Git when kept in RAGen's runtime folder. Do not place
either store in a shared or backed-up location unless that is intentional.

The launchers use loopback addresses by default. The app has no authentication, so do
not expose it to your network or the internet without adding authentication and network
protections. Configure any pre-existing Ollama or Chroma service for local access too.

Chroma uses its official standalone Windows or Linux executable. The launcher downloads
the matching executable into `rag/.runtime/`, verifies its pinned SHA-256, and starts
it on loopback only. Python is not required for Chroma.

Keep `RAG_DEBUG=0` for normal use. Debug mode saves document context and raw model
output in the diagnostic logs, which remain after removing a project.

Press Enter in the launcher window or terminal to stop the processes it started, including
their child processes such as Ollama model workers. Services that were already
running before the launcher started are left running. On Linux, Ollama's installer may
also create a persistent system service; that service remains running after RAGen closes.

On Windows startup, the launcher also removes leftover workers from the same Ollama
installation when their parent process has exited. Workers with a live parent
are kept. If Windows prevents inspecting or stopping a worker, the launcher
prints a warning and continues.

## Development

From the repository root with Node.js 22.18 or later. On Windows use `npm.cmd`;
on Linux use `npm`:

```powershell
npm.cmd ci
npm.cmd run typecheck
npm.cmd test
npm.cmd run launch
```

The equivalent Linux commands are `npm ci`, `npm run typecheck`, `npm test`, and
`npm run launch`. The bootstrap command `bash START-RAG.sh` also works before Node.js
is installed.

See [RAG engine](rag/README.md), [chat interface](hono-chat/README.md),
[CONTRIBUTING.md](CONTRIBUTING.md), and [CHANGELOG.md](CHANGELOG.md) for implementation,
contribution, and release details. Report security issues through
[SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
