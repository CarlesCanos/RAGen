#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
rag_root="$repo_root/rag"
runtime_root="$rag_root/.runtime"
no_browser=false
exit_after_ready=false
skip_prepare=false
skip_install=false
owned_pids=()

for option in "$@"; do
  case "$option" in
    --no-browser) no_browser=true ;;
    --exit-after-ready) exit_after_ready=true ;;
    --skip-prepare) skip_prepare=true ;;
    --skip-install) skip_install=true ;;
    *) printf 'Unknown option: %s\n' "$option" >&2; exit 2 ;;
  esac
done

die() { printf '\nERROR: %s\nRun bash START-RAG.sh again after fixing the problem.\n' "$*" >&2; exit 1; }
step() { printf '\n[%s/7] %s\n' "$1" "$2"; }
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
endpoint() { curl --silent --show-error --fail --max-time 3 --output /dev/null "$1" 2>/dev/null; }
wait_endpoint() {
  local url="$1" service="$2" seconds="$3" pid="${4:-}"
  local deadline=$((SECONDS + seconds))
  until endpoint "$url"; do
    if [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null; then die "$service stopped during startup. Check $runtime_root/logs/$service.log"; fi
    (( SECONDS < deadline )) || die "$service did not respond at $url after $seconds seconds. Check $runtime_root/logs/$service.log"
    sleep 0.5
  done
}
start_owned() {
  local name="$1"; shift
  mkdir -p "$runtime_root/logs"
  setsid "$@" >"$runtime_root/logs/$name.log" 2>&1 &
  started_pid=$!
  owned_pids+=("$started_pid")
}
cleanup() {
  local i pid attempt
  for ((i=${#owned_pids[@]}-1; i>=0; i--)); do
    pid="${owned_pids[i]}"
    kill -TERM -- "-$pid" 2>/dev/null || true
    for ((attempt=0; attempt<50; attempt++)); do
      kill -0 -- "-$pid" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 -- "-$pid" 2>/dev/null; then kill -KILL -- "-$pid" 2>/dev/null || true; fi
    wait "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

[[ "$(uname -s)" == Linux ]] || die 'This launcher requires Linux. On Windows use START-RAG.cmd.'
kernel_release="$(uname -r)"
if [[ "${kernel_release,,}" == *microsoft* && "${kernel_release,,}" != *wsl2* ]]; then
  die 'Ollama requires WSL2. From Windows PowerShell, check wsl --list --verbose and convert your distro with wsl --set-version <distribution> 2.'
fi
for required in curl tar sha256sum setsid; do command -v "$required" >/dev/null || die "The basic Linux tool '$required' is required."; done
[[ -f "$rag_root/package.json" && -f "$repo_root/hono-chat/server.ts" ]] || die 'The RAGen project files were not found.'
mkdir -p "$runtime_root"

printf '\nRAGen - automatic setup and startup\nThe first run can take a while because of downloads.\n'
step 1 'Checking Node.js and npm...'
node_version_valid() {
  local version major minor
  version="$("$1" --version 2>/dev/null || true)"
  [[ "$version" =~ ^v([0-9]+)\.([0-9]+)\. ]] || return 1
  major="${BASH_REMATCH[1]}"; minor="${BASH_REMATCH[2]}"
  (( major > 22 || (major == 22 && minor >= 18) ))
}
node_bin="$(command -v node || true)"
if [[ -z "$node_bin" ]] || ! node_version_valid "$node_bin"; then
  node_version='22.23.3'
  case "$(uname -m)" in
    x86_64|amd64) node_arch=x64; node_hash='1084aa36196bba4c3a5e69a1ee388a6e4ff729dad09445fbcd434b28fe3c24af' ;;
    aarch64|arm64) node_arch=arm64; node_hash='5ced2d48d1d7198739b7f86804de0171aefb6823b684b12341d3321afc3cb0b2' ;;
    *) die "Unsupported Linux architecture: $(uname -m). Use x86_64 or arm64." ;;
  esac
  node_home="$runtime_root/node/node-v${node_version}-linux-${node_arch}"
  node_bin="$node_home/bin/node"
  if [[ ! -x "$node_bin" ]]; then
    $skip_install && die 'Node.js is missing and automatic installation is disabled (--skip-install).'
    printf '      Downloading Node.js %s...\n' "$node_version"
    mkdir -p "$runtime_root/node"
    archive="$(mktemp "$runtime_root/node/node.XXXXXXXX.tar.gz")"
    trap 'rm -f -- "${archive:-}"; cleanup' EXIT
    curl --fail --location --show-error --silent "https://nodejs.org/dist/v${node_version}/node-v${node_version}-linux-${node_arch}.tar.gz" --output "$archive"
    printf '%s  %s\n' "$node_hash" "$archive" | sha256sum --check --status || die 'The Node.js download failed SHA-256 verification.'
    tar -xzf "$archive" -C "$runtime_root/node"
    rm -f -- "$archive"; archive=''
    trap cleanup EXIT
  fi
  [[ -x "$node_bin" ]] || die 'Node.js extraction did not create the executable.'
  export PATH="$(dirname "$node_bin"):$PATH"
fi
node_version_valid "$node_bin" || die 'Node.js 22.18 or later is required.'
npm_bin="$(command -v npm || true)"
[[ -n "$npm_bin" ]] || die 'npm was not found with Node.js.'
printf '      Node.js %s\n' "$("$node_bin" --version)"

step 2 'Checking project dependencies...'
lock_hash="$(sha256sum "$repo_root/package-lock.json" | cut -d ' ' -f 1)"
marker="$repo_root/node_modules/.ragen-lock.sha256"
expected_marker="linux-$(uname -m):$lock_hash"
if [[ -f "$marker" && "$(cat "$marker")" == "$expected_marker" && -f "$repo_root/node_modules/hono/package.json" && -f "$repo_root/node_modules/chromadb/package.json" ]]; then
  printf '      npm dependencies are already prepared.\n'
else
  $skip_install && die 'npm dependencies are missing and automatic installation is disabled (--skip-install).'
  (cd "$repo_root" && "$npm_bin" ci --no-audit --no-fund) || die 'npm ci failed while installing project dependencies.'
  printf '%s\n' "$expected_marker" > "$marker"
fi

ollama_url="$(setting OLLAMA_URL 'http://127.0.0.1:11434')"
ollama_url="${ollama_url%/}"
[[ "$ollama_url" =~ ^https?://(localhost|127\.0\.0\.1|\[::1\])(:[0-9]+)?$ ]] || die 'OLLAMA_URL must be a local HTTP URL.'
export OLLAMA_HOST="$ollama_url"
step 3 'Checking Ollama and local models...'
ollama_bin="$(command -v ollama || true)"
if [[ -z "$ollama_bin" ]]; then
  $skip_install && die 'Ollama is missing and automatic installation is disabled (--skip-install).'
  if ! command -v zstd >/dev/null; then
    printf '      Installing zstd, required by the Ollama Linux package...\n'
    if (( EUID == 0 )); then admin=()
    elif command -v sudo >/dev/null; then admin=(sudo)
    else die 'Ollama requires zstd and administrator access. Install zstd and sudo, then retry.'
    fi
    if command -v apt-get >/dev/null; then
      "${admin[@]}" apt-get update && "${admin[@]}" apt-get install -y zstd || die 'Could not install zstd with apt-get.'
    elif command -v dnf >/dev/null; then
      "${admin[@]}" dnf install -y zstd || die 'Could not install zstd with dnf.'
    elif command -v zypper >/dev/null; then
      "${admin[@]}" zypper --non-interactive install zstd || die 'Could not install zstd with zypper.'
    elif command -v pacman >/dev/null; then
      "${admin[@]}" pacman -S --noconfirm zstd || die 'Could not install zstd with pacman.'
    else
      die 'Install the zstd package with your Linux package manager, then retry.'
    fi
  fi
  printf '      Installing Ollama with its official Linux installer (sudo may ask for your password)...\n'
  installer="$(mktemp "$runtime_root/ollama-install.XXXXXXXX.sh")"
  trap 'rm -f -- "${installer:-}"; cleanup' EXIT
  curl --fail --location --show-error --silent https://ollama.com/install.sh --output "$installer"
  sh "$installer"
  rm -f -- "$installer"; installer=''
  trap cleanup EXIT
  hash -r
  ollama_bin="$(command -v ollama || true)"
fi
[[ -n "$ollama_bin" ]] || die 'Ollama installation finished, but the ollama command was not found.'
if ! endpoint "$ollama_url/api/tags"; then
  start_owned ollama "$ollama_bin" serve
  wait_endpoint "$ollama_url/api/tags" Ollama 60 "$started_pid"
else
  printf '      Ollama is already available.\n'
fi
ensure_model() {
  local model="$1"
  if curl --silent --show-error --fail --max-time 10 --output /dev/null \
    --header 'Content-Type: application/json' --data "$("$node_bin" -e 'console.log(JSON.stringify({model:process.argv[1]}))' "$model")" \
    "$ollama_url/api/show" 2>/dev/null; then
    printf '      Model available: %s\n' "$model"
  else
    $skip_install && die "Model $model is missing and automatic installation is disabled (--skip-install)."
    printf '      Downloading model %s (this may take several minutes)...\n' "$model"
    "$ollama_bin" pull "$model"
  fi
}
chat_model="$(setting RAG_CHAT_MODEL 'qwen3.5:4b-q4_K_M')"
embed_model="$(setting OLLAMA_EMBED_MODEL embeddinggemma)"
ensure_model "$chat_model"
[[ "$embed_model" == "$chat_model" ]] || ensure_model "$embed_model"
tokenizer_root="$rag_root/output/tokenizer-qwen3.5"
tokenizer_ready=true
for file in tokenizer.json tokenizer_config.json chat_template.jinja provenance.json; do [[ -f "$tokenizer_root/$file" ]] || tokenizer_ready=false; done
if ! $tokenizer_ready; then
  $skip_install && die 'The Qwen tokenizer is missing and automatic installation is disabled (--skip-install).'
  (cd "$rag_root" && "$node_bin" src/setupRag.ts --tokenizer-only)
fi
for file in tokenizer.json tokenizer_config.json chat_template.jinja provenance.json; do [[ -f "$tokenizer_root/$file" ]] || die "The tokenizer download did not create $file."; done

step 4 'Checking the Chroma server...'
chroma_host="$(setting CHROMA_HOST localhost)"
chroma_port="$(setting CHROMA_PORT 8000)"
[[ "$chroma_host" == localhost || "$chroma_host" == 127.0.0.1 ]] || die 'CHROMA_HOST must be localhost or 127.0.0.1.'
[[ "$chroma_port" =~ ^[0-9]{1,5}$ ]] && (( 10#$chroma_port > 0 && 10#$chroma_port <= 65535 )) || die 'CHROMA_PORT must be a valid port.'
chroma_url="http://${chroma_host}:${chroma_port}"
if ! endpoint "$chroma_url/api/v2/heartbeat"; then
  chroma="$runtime_root/chroma/chroma-linux"
  chroma_hash='807e8ed0ef9e37a00905bedaa58ca540df734b7cbc51497a67bc5ea3cbd58d5d'
  if [[ ! -f "$chroma" ]] || ! printf '%s  %s\n' "$chroma_hash" "$chroma" | sha256sum --check --status; then
    $skip_install && die 'The Chroma runtime is missing or invalid and automatic installation is disabled (--skip-install).'
    [[ "$(uname -m)" == x86_64 || "$(uname -m)" == amd64 ]] || die 'The pinned Chroma Linux binary is available only for x86_64.'
    mkdir -p "$(dirname "$chroma")"
    download="$(mktemp "$runtime_root/chroma/chroma.XXXXXXXX.download")"
    trap 'rm -f -- "${download:-}"; cleanup' EXIT
    printf '      Downloading and verifying Chroma cli-1.4.4...\n'
    curl --fail --location --show-error --silent 'https://github.com/chroma-core/chroma/releases/download/cli-1.4.4/chroma-linux' --output "$download"
    printf '%s  %s\n' "$chroma_hash" "$download" | sha256sum --check --status || die 'The Chroma download failed SHA-256 verification.'
    chmod 755 "$download"
    mv -f -- "$download" "$chroma"; download=''
    trap cleanup EXIT
  fi
  mkdir -p "$rag_root/.chroma"
  start_owned chroma "$chroma" run --path "$rag_root/.chroma" --host "$chroma_host" --port "$chroma_port"
  wait_endpoint "$chroma_url/api/v2/heartbeat" Chroma 60 "$started_pid"
else
  printf '      Chroma is already available.\n'
fi

step 5 'Validating the RAG index...'
docs_dir="$(setting DOCS_DIR ./docs)"
[[ "$docs_dir" == /* ]] || docs_dir="$rag_root/$docs_dir"
mkdir -p "$docs_dir"
if [[ -z "$(find "$docs_dir" -type f \( -iname '*.md' -o -iname '*.mdx' -o -iname '*.markdown' -o -iname '*.txt' -o -iname '*.html' -o -iname '*.htm' -o -iname '*.pdf' \) -print -quit)" ]]; then
  cat > "$docs_dir/GET-STARTED.md" <<'EOF'
# Welcome to RAGen

This starter document confirms that the installation is working correctly.

To use your own documents, open the folder from the chat's **Documents** button, add
supported files, and select **Regenerate RAG**. You can remove this file afterward.
EOF
  printf '      Created %s/GET-STARTED.md because the document folder was empty.\n' "$docs_dir"
fi
if $skip_prepare; then
  printf '      Preparation skipped by parameter.\n'
elif (cd "$rag_root" && "$node_bin" src/checkReady.ts); then
  printf '      Index and collection verified.\n'
else
  printf '      Preparing the index...\n'
  (cd "$rag_root" && "$node_bin" src/prepareRag.ts && "$node_bin" src/checkReady.ts) || die 'RAG preparation or final verification failed.'
fi

ui_host="$(setting RAG_UI_HOST 127.0.0.1)"
ui_port="$(setting RAG_UI_PORT 8787)"
[[ "$ui_port" =~ ^[0-9]{1,5}$ ]] && (( 10#$ui_port > 0 && 10#$ui_port <= 65535 )) || die 'RAG_UI_PORT must be a valid port.'
browser_host="$ui_host"
[[ "$browser_host" == 0.0.0.0 || "$browser_host" == :: ]] && browser_host=127.0.0.1
ui_url="http://${browser_host}:${ui_port}"
export RAG_UI_HOST="$ui_host" RAG_UI_PORT="$ui_port"
step 6 'Starting Hono Chat...'
if ! endpoint "$ui_url/api/health"; then
  start_owned hono-chat "$node_bin" "$repo_root/hono-chat/server.ts"
  wait_endpoint "$ui_url/api/health" hono-chat 30 "$started_pid"
else
  printf '      Hono Chat is already available.\n'
fi

step 7 'RAGen is ready.'
printf '      %s\n' "$ui_url"
if ! $no_browser; then
  if command -v xdg-open >/dev/null && [[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]]; then xdg-open "$ui_url" >/dev/null 2>&1 &
  elif command -v wslview >/dev/null; then wslview "$ui_url" >/dev/null 2>&1 &
  elif command -v explorer.exe >/dev/null; then explorer.exe "$ui_url" >/dev/null 2>&1 &
  else printf '      Open this address in your browser.\n'; fi
fi
if ! $exit_after_ready; then
  printf '\nPress Enter to stop the services started by this launcher.'
  read -r _ || true
fi
