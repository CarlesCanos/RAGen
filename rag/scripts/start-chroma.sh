#!/usr/bin/env bash
set -Eeuo pipefail
rag_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
chroma="$rag_root/.runtime/chroma/chroma-linux"
[[ -x "$chroma" ]] || { printf 'The private Chroma runtime is missing. Run bash START-RAG.sh once.\n' >&2; exit 1; }
setting() {
  local name="$1" default="$2" file line value
  if [[ -n "${!name:-}" ]]; then printf '%s' "${!name}"; return; fi
  for file in "$rag_root/.env" "$rag_root/.env.example"; do
    [[ -f "$file" ]] || continue
    while IFS= read -r line || [[ -n "$line" ]]; do
      if [[ "$line" =~ ^[[:space:]]*${name}[[:space:]]*=[[:space:]]*(.*)$ ]]; then
        value="${BASH_REMATCH[1]}"
        value="${value%$'\r'}"
        value="${value#\"}"; value="${value%\"}"
        value="${value#\'}"; value="${value%\'}"
        printf '%s' "$value"
        return
      fi
    done < "$file"
  done
  printf '%s' "$default"
}
chroma_host="$(setting CHROMA_HOST localhost)"
chroma_port="$(setting CHROMA_PORT 8000)"
[[ "$chroma_host" == localhost || "$chroma_host" == 127.0.0.1 ]] || { printf 'CHROMA_HOST must be localhost or 127.0.0.1.\n' >&2; exit 1; }
[[ "$chroma_port" =~ ^[0-9]{1,5}$ ]] && (( 10#$chroma_port > 0 && 10#$chroma_port <= 65535 )) || { printf 'CHROMA_PORT must be a valid port.\n' >&2; exit 1; }
exec "$chroma" run --path "$rag_root/.chroma" --host "$chroma_host" --port "$chroma_port"
