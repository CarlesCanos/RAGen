# Hono Chat

The local web interface for the RAG engine in `../rag/`. Start it from the repository
root with `START-RAG.cmd`, or run only the interface with:

```powershell
npm.cmd run chat
```

The server listens on `http://127.0.0.1:8787` by default. It has no authentication and is
intended for local use only.

## Projects and conversations

The sidebar creates, selects, and removes projects. Each project has its own document
folder, model, settings, index, Chroma collection, cache, and conversation.

Generated data is stored unencrypted in `rag/.runtime/` and excluded from Git. The app
keeps the latest 20 messages for each project and restores them after switching projects,
refreshing the page, or restarting the server.

The conversation is cleared when you request it, regenerate the project index, or
remove the project. Removing a project never deletes its original document folder.

## Controls

- Open the selected document folder from the project toolbar.
- Regenerate the RAG after changing documents.
- Install or select a compatible Qwen 3.5 model per project.
- Edit validated RAG settings per project.

Queries and index rebuilds share a queue so the app cannot read an index while a new
version is being published. API bodies are limited to 64 KiB, and `/api/ask` accepts up
to 20 requests per minute for each running server process.

The page uses a nonce-based Content Security Policy, blocks framing, and renders dynamic
content as text. Internal chunk IDs are removed from displayed answers while source
metadata remains available.
