#!/usr/bin/env bash
set -Eeuo pipefail
rag_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
chroma="$rag_root/.runtime/chroma/chroma-linux"
[[ -x "$chroma" ]] || { printf 'The private Chroma runtime is missing. Run bash START-RAG.sh once.\n' >&2; exit 1; }
exec "$chroma" run --path "$rag_root/.chroma" --host 127.0.0.1 --port 8000
