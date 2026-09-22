#!/usr/bin/env sh
set -eu

if ! command -v ollama >/dev/null 2>&1; then
  echo "ollama is not installed or not available in PATH." >&2
  exit 1
fi

MODELS_JSON="$(node ./src/getConfiguredOllamaModels.ts)"
CHAT_MODEL="$(printf '%s' "$MODELS_JSON" | sed -n 's/.*"chatModel":"\([^"]*\)".*/\1/p')"
EMBED_MODEL="$(printf '%s' "$MODELS_JSON" | sed -n 's/.*"embedModel":"\([^"]*\)".*/\1/p')"

if [ -z "$CHAT_MODEL" ] || [ -z "$EMBED_MODEL" ]; then
  echo "Could not resolve configured Ollama models from project env." >&2
  exit 1
fi

echo "Installing Ollama chat model: ${CHAT_MODEL}"
ollama pull "${CHAT_MODEL}"

echo "Installing Ollama embedding model: ${EMBED_MODEL}"
ollama pull "${EMBED_MODEL}"

echo "Ollama models installed successfully."
