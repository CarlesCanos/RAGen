import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { config } from '../src/optimized/config.ts';
import { chat } from '../src/optimized/ollama.ts';
import { diagnosticsFile, trace, withDiagnostics } from '../src/shared/diagnostics.ts';

test('logs correlate requests and only include full prompts/responses in debug mode', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ message: { content: 'private-response' }, eval_count: 1 }));
  await withDiagnostics(false, () => chat(config(), 'answer', 'private-system', 'private-prompt', 10, false, []));
  await withDiagnostics(true, () => chat(config(), 'answer', 'debug-system', 'debug-prompt', 10, false, []));
  const contents = await readFile(diagnosticsFile, 'utf8');
  const entries = contents.trim().split('\n').map(line => JSON.parse(line));
  const requests = entries.filter(entry => entry.event === 'ollama.request');
  assert.equal(requests.length, 2);
  assert.notEqual(requests[0].requestId, requests[1].requestId);
  const normal = entries.filter(entry => entry.requestId === requests[0].requestId);
  assert.doesNotMatch(JSON.stringify(normal), /private-prompt|private-system|private-response/);
  assert.equal(requests[1].body.messages[1].content, 'debug-prompt');
  assert.ok(requests[0].memory.system.totalBytes > 0);
  assert.ok(requests[0].memory.process.rss > 0);
  assert.ok(entries.some(entry => entry.event === 'ollama.response' && entry.requestId === requests[1].requestId && entry.body.message.content === 'private-response'));
});

test('failed logging never fails the caller', async () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  await assert.doesNotReject(trace('test.circular', circular));
});
