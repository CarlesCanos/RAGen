# Temporary proposal: deployable RAGen HTTP API

> **REMOVE BEFORE MERGING INTO `main`.** This file is a working proposal for the
> `feat/rag-embedding` branch. Delete it after the design has been reviewed and its
> decisions have been incorporated into the implementation and permanent documentation.
> The filename intentionally repeats this requirement.

## Goal

Keep one RAG engine with two independent ways to run it:

| Mode | Audience | Entry point | Exposed functions |
| --- | --- | --- | --- |
| Desktop | Person using RAGen on Windows or native Linux | Existing `START-RAG.cmd`, `START-RAG.sh`, and `hono-chat/server.ts` | Full chat UI, project management, settings, indexing controls |
| Service | Backend of a separately hosted website | New API-only server | Authenticated questions and health checks |

The website owns its chat UI and sends HTTP requests from **its backend** to RAGen.
RAGen may run on an on-premises server, VM, container, or Kubernetes pod. The browser
calls the website backend; it never needs direct access to RAGen. A deployment needs
network reachability between the two backends, through HTTPS or a private connection.

## Recommended initial scope

- One published document corpus per service instance. Deploy another instance for a
  different corpus. Do not accept a caller-provided local project ID, index path, or
  model URL in the public request.
- Single-turn answers, matching the current engine. Previous chat messages may be
  displayed by the website, but they do not yet affect a new answer. Conversation-aware
  follow-ups are a separate engine change described below.
- One service replica initially. The current index and cache are filesystem-based,
  and the current HTTP server's request coordination is in process memory.
- Keep Ollama and Chroma on the RAGen host or in the same pod for the first deployment.
  Their current clients require loopback addresses. The website-to-RAGen API connection
  is independent of that internal restriction.

## Work required in this repository

1. **Add a separate API workspace and entry point.** Create `rag-api/app.ts` and
   `rag-api/server.ts`, register the workspace and scripts in the root `package.json`,
   and update `package-lock.json`. Keep `hono-chat/server.ts` and both desktop launchers
   as the default desktop path. The new server imports `askRag` from
   `rag/src/optimized/ask.ts`; it does not import or mount the existing UI routes.
2. **Define a versioned HTTP contract.** Start with `POST /v1/ask`,
   `GET /health/live`, and `GET /health/ready`. Validate JSON, question length, mode,
   content type, and body size. Return only public answer fields and stable error codes.
   Never return internal configuration, raw model diagnostics, document paths, or
   settings. Decide whether the public `answer` retains inline citation markers;
   document that choice and keep structured `sources` in the response.
3. **Authenticate and authorize the caller.** Require a server-side credential on
   `/v1/ask`, ideally one credential per website integration so it can be rotated or
   revoked independently. Store credentials in deployment secrets, not in the repo or
   browser. Bind the credential to the service's configured corpus. Use HTTPS for
   remote calls; a reverse proxy or VPN can terminate/provide the secure connection.
   The existing fixed `X-Local-RAG: 1` header is not authentication. Do not expose the
   full desktop/admin listener through the API gateway.
4. **Make service configuration explicit.** Add API bind host/port and authentication
   settings. Keep RAG settings such as `DOCS_DIR`, `RAG_INDEX_DIR`,
   `CHROMA_COLLECTION`, `OLLAMA_URL`, and model selection server-controlled. On an
   on-premises host the API may bind to loopback behind a reverse proxy; in a pod it
   must bind to an address reachable by its internal Service. Leave Ollama and Chroma
   bound to loopback when they run alongside RAGen.
5. **Provide noninteractive setup and startup.** Do not use the desktop launcher's
   browser-opening and press-Enter lifecycle for a long-running service. Document or
   add commands that install dependencies, prepare models/tokenizer, index documents,
   run `check:ready`, and start only the API under a process supervisor. Container
   packaging can run those same commands; it is a deployment option, not a different
   API or engine.
6. **Persist the right data.** The service needs its source documents, active RAG
   index and answer cache, Chroma database, Ollama models, and tokenizer across
   restarts. On-premises these can be host directories; containers need persistent
   volumes. Reindex explicitly after document changes. Do not expose regeneration as
   part of the public question API.
7. **Handle capacity and failure clearly.** Replace the current process-wide
   one-question `409` behavior with a documented bounded queue or a deliberate busy
   response with `Retry-After`. Apply per-credential rate limits, set request and
   upstream timeouts for slow inference, and make `/health/ready` check the model,
   tokenizer, index, and Chroma collection rather than only the HTTP process.
8. **Test both entry points.** Preserve the existing Windows/Linux desktop tests.
   Add API tests for authentication, input limits, allowed routes, safe responses,
   readiness, concurrent requests, and restart/persistence behavior. Run type-checking
   and tests for the new workspace in CI. Add a smoke test in which a separate backend
   sends a request over HTTP to the API.
9. **Document both modes.** Keep the current quick start as the desktop path. Add
   permanent API contract, on-premises deployment, and container deployment guides.
   Document how the website backend stores its credential, sends requests, handles
   busy/timeouts, and displays sources.

## Proposed API contract

```http
POST /v1/ask HTTP/1.1
Authorization: Bearer <server-side-credential>
Content-Type: application/json

{"question":"What does the handbook say about backups?","mode":"auto"}
```

```json
{
  "answer": "Backups are described in the operations section.",
  "status": "answered",
  "sources": [{ "id": "...", "source": "handbook.md", "heading": "Backups" }],
  "requestId": "..."
}
```

The website backend would expose its own chat endpoint to its browser, call this API,
and return only the fields its UI needs. Service credentials must never be included
in JavaScript sent to the browser or in query strings. CORS is unnecessary for this
backend-to-backend request path.

## Conversation-aware follow-ups: separate decision

Today `askRag(question, options)` has no conversation-history input. Saved messages
restore the desktop UI but are not included in retrieval or the model prompt. If the
deployed chatbot must understand follow-up questions, add a bounded and validated
history input to the engine and API, isolate it per website visitor, account for it in
the token budget, and include it in answer-cache keys. The website can own visitor
sessions and send recent turns; RAGen should not expose one shared project
conversation to all visitors. This should be designed and tested before claiming
multi-turn support.

## Acceptance criteria

- Existing Windows and Linux desktop launchers and full UI still work as before.
- Service mode starts without opening a browser and serves no UI/admin routes.
- A remote website backend can authenticate and receive an answer through a stable
  HTTP contract without knowing RAGen's filesystem or deployment type.
- Unauthorized requests cannot query documents; one integration cannot select
  another corpus.
- The service remains usable after a process restart without downloading models or
  rebuilding an unchanged index.
- Concurrent use, readiness, timeouts, and errors have defined behavior.

## Branch cleanup

- [ ] Resolve the service scope and conversation-history decision.
- [ ] Implement and document the approved design.
- [ ] **Delete this proposal file before merging `feat/rag-embedding` into `main`.**
