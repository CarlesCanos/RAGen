import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const launcher = fileURLToPath(new URL('../../start-local-rag.sh', import.meta.url));

test('Linux launcher stops its process group and preserves an unrelated process', { skip: process.platform !== 'linux', timeout: 20000 }, async () => {
  const source = await readFile(launcher, 'utf8');
  const functions = ['wait_endpoint', 'start_owned', 'cleanup'].map(name => {
    const match = source.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'));
    assert.ok(match, `missing ${name}`);
    return match[0];
  }).join('\n');
  const script = `
set -Eeuo pipefail
runtime_root="$(mktemp -d)"
owned_pids=()
${functions}
endpoint() { return 0; }
wait_endpoint http://127.0.0.1:8000 fixture 1
setsid sleep 30 >/dev/null 2>&1 &
unrelated=$!
trap 'kill "$unrelated" 2>/dev/null || true; rm -rf -- "$runtime_root"' EXIT
start_owned fixture bash -c 'sleep 30 & wait'
owned=$started_pid
sleep 0.2
cleanup
if kill -0 -- "-$owned" 2>/dev/null; then echo 'owned group survived' >&2; exit 1; fi
kill -0 "$unrelated" || { echo 'unrelated process stopped' >&2; exit 1; }
echo 'owned group stopped; unrelated process survived'
`;
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /owned group stopped; unrelated process survived/);
});
