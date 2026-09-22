import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/optimized/config.ts';
import { chat } from '../src/optimized/ollama.ts';
import { selectContext } from '../src/optimized/retrieve.ts';
import { buildBm25 } from '../src/optimized/bm25.ts';
import { enrich } from '../src/optimized/index.ts';
import { fixtures } from '../src/evaluation/fixtures.ts';
import type { Snapshot } from '../src/optimized/index.ts';
import type { StageMetric } from '../src/optimized/ollama.ts';

test('context packing stays within budget, skips duplicates and can select evidence at end', () => {
  const chunks = enrich(fixtures(100).manifest.chunks);
  chunks[0].text = 'Irrelevant filler sentence. '.repeat(50) + 'Authorization is KEY-END.';
  const snapshot: Snapshot = { schema: 2, id: 'test', collection: 'test', createdAt: '', embedding: { model: '', digest: '', format: '', dimensions: 768 }, chunks, bm25: buildBm25([]) };
  const counter = { count: (text: string) => text.split(/\s+/).length, chat: () => 0 };
  const fits = (cs: typeof chunks) => cs.reduce((n, c) => n + counter.count(c.text), 0) <= 30;
  const result = selectContext(snapshot, [{ id: chunks[0].id, score: 1 }], 'Authorization KEY-END', { ...config(), neighbors: 0 }, fits, counter);
  assert.ok(fits(result));
  assert.match(result[0].text, /KEY-END/);
});
test('identifier anchoring ignores sentence punctuation while preserving internal separators', () => {
  const chunks = enrich(fixtures(100).manifest.chunks);
  chunks[0].text = 'Device AX-17.4: approved.';
  chunks[1].text = 'Device AX-18.4: rejected.';
  const snapshot: Snapshot = { schema: 2, id: 'test', collection: 'test', createdAt: '', embedding: { model: '', digest: '', format: '', dimensions: 768 }, chunks, bm25: buildBm25([]) };
  const result = selectContext(snapshot, [{ id: chunks[1].id, score: 2 }, { id: chunks[0].id, score: 1 }], 'Describe AX-17.4.', { ...config(), neighbors: 0 }, () => true, { count: () => 1, chat: () => 1 });
  assert.deepEqual(result.map(c => c.id), [chunks[0].id]);
});
test('transport never exposes thinking; records truncation and does not retry HTTP errors', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  const stages: StageMetric[] = [];
  try {
    globalThis.fetch = async () => { calls++; return Response.json({ message: { thinking: 'private draft' }, done_reason: 'length', eval_count: 512 }); };
    const result = await chat(config(), 'test', 'system', 'user', 512, true, stages);
    assert.equal(result.content, ''); assert.equal(result.truncated, true); assert.equal(stages[0].outputTokens, 512);
    globalThis.fetch = async () => { calls++; return new Response('unavailable', { status: 503 }); };
    await assert.rejects(chat(config(), 'test', '', '', 10, false, stages), /503/);
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});

test('transport applies a deadline, context/output budgets and never retries a timeout', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async (_url, init) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      assert.equal(body.options.num_ctx, 4096);
      assert.equal(body.options.num_predict, 256);
      assert.equal(body.think, false);
      assert.ok(init?.signal);
      throw new DOMException('timeout', 'TimeoutError');
    };
    await assert.rejects(chat({ ...config(), timeout: 20 }, 'plan', '', '', 256, false, [], true), { name: 'TimeoutError' });
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});
