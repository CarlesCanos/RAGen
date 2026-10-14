# RAGen

[![CI](https://github.com/CarlesCanos/RAGen/actions/workflows/ci.yml/badge.svg)](https://github.com/CarlesCanos/RAGen/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A local-first tool for asking questions about your documents. Choose a document folder,
build a searchable index, and ask questions in a local web interface. You can create
multiple projects, each with its own documents and index. RAGen uses Ollama with Qwen
to answer, EmbeddingGemma to index documents, and Chroma to search them.

## Demo

See RAGen launch, open its local interface, and answer a question about indexed documents:

![Demo of RAGen from launch to the first document question](assets/ragen-workflow.gif)

## Quick start

Download the ZIP from the [RAGen repository](https://github.com/CarlesCanos/RAGen)
and extract it, or clone it with Git:

```text
git clone https://github.com/CarlesCanos/RAGen.git
```

Keep the full repository folder: the launcher uses files inside it. You need an
internet connection for the first run and a browser to use the interface. You do not
need to install Python or Docker.

### Windows 10 or 11

1. Make sure **App Installer** is available so `winget` works. In PowerShell, run
   `winget --version` to check. If the command is missing, install or update
   **App Installer** from the Microsoft Store.
2. Open the repository folder in File Explorer and double-click `START-RAG.cmd`.
   You can also run `.\START-RAG.cmd` from PowerShell in that folder.
3. Keep the launcher window open. When it says **RAGen is ready**, use the browser
   window it opens, or visit the address printed in the window (by default,
   <http://127.0.0.1:8787>).

The launcher installs Node.js and Ollama through `winget` if needed, installs the
project's npm packages, downloads the models and Chroma runtime, and prepares the
initial document index. The first run can take a while. Later runs reuse the downloads.

### Linux (x86_64)

1. Make sure `bash`, `curl`, `tar`, `sha256sum`, and `setsid` are available. On
   Ubuntu or Debian, you can install them with:

   ```bash
   sudo apt-get update
   sudo apt-get install -y bash curl tar coreutils util-linux
   ```

2. Open a terminal in the repository folder and start RAGen:

   ```bash
   bash START-RAG.sh
   ```

3. Keep the terminal open. When it says **RAGen is ready**, use the browser it
   opens, or visit the address printed in the terminal (by default,
   <http://127.0.0.1:8787>). On a Linux system without a desktop browser, open
   that address in a browser on the same computer.

The launcher downloads Node.js if needed, installs the npm packages, installs Ollama
and `zstd` if needed, downloads the models and Chroma runtime, and prepares the
initial document index. It may ask for your `sudo` password while installing system
packages. Later runs reuse the downloads.

The bundled Chroma executable supports x86_64 Linux. On Linux ARM64, RAGen can run
only if a compatible Chroma server is already running on the configured local address.

On either platform, press **Enter** in the launcher window or terminal to stop the
services it started.

### Optional: WSL2 on a Windows computer

On Windows with WSL, use WSL2. Check with `wsl --list --verbose` in PowerShell; if
Ubuntu is on version 1, convert it with `wsl --set-version Ubuntu 2` before running
RAGen. Make a separate clone inside the WSL Linux filesystem (for example, in your
Linux home directory), then follow the Linux steps above. Using one checkout for
both Windows and WSL makes `node_modules` switch platforms on each start. If WSL
has no Linux folder picker, enter an absolute document path in the chat.

## Use

1. Create a project and choose the folder containing your documents.
2. Select **Regenerate RAG** to index the documents in that folder.
3. Ask a question in the chat.

If the initial document folder is empty, the launcher creates a `GET-STARTED.md`
sample document so you can try RAGen immediately. You can remove it after adding
your own documents.

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

On Linux:

```bash
tail -n 30 -f "$(ls -t rag/.runtime/logs/*.jsonl | head -n 1)"
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

Chroma uses its official standalone Windows or x86_64 Linux executable. The launcher
downloads the matching executable into `rag/.runtime/`, verifies its pinned SHA-256,
and starts it on loopback only. Python is not required for Chroma.

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

For development, use Node.js 22.18 or later. Run these commands from the
repository root. On Windows (PowerShell):

```powershell
npm.cmd ci
npm.cmd run typecheck
npm.cmd test
npm.cmd run launch
```

On Linux:

```bash
npm ci
npm run typecheck
npm test
npm run launch
```

The Linux bootstrap command `bash START-RAG.sh` also works before Node.js is
installed.

See [RAG engine](rag/README.md), [chat interface](hono-chat/README.md),
[CONTRIBUTING.md](CONTRIBUTING.md), and [CHANGELOG.md](CHANGELOG.md) for implementation,
contribution, and release details. Report security issues through
[SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
