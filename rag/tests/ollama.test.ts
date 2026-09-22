import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/optimized/config.ts';
import { api, chat, embed, OllamaError, type StageMetric } from '../src/optimized/ollama.ts';

test('GPU OOM retries once on CPU, preserving prompts/options and reusing CPU for later stages', async t => {
  const requests: Array<Record<string, any>> = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    return requests.length === 1
      ? Response.json({ error: 'CUDA error: out of memory' }, { status: 500 })
      : Response.json({ message: { content: 'answer' }, eval_count: 2 });
  });
  const cfg = config();
  const stages: StageMetric[] = [];
  await chat(cfg, 'answer', 'system', 'question', 42, false, stages, true, ['doc:1']);
  await chat(cfg, 'validate', 'system', 'question', 32, false, stages);
  assert.equal(requests.length, 3);
  assert.equal(requests[0].options.num_gpu, undefined);
  assert.equal(requests[1].options.num_gpu, 0);
  assert.equal(requests[2].options.num_gpu, 0);
  assert.equal(requests[1].options.num_predict, 42);
  assert.deepEqual(requests[1].messages, requests[0].messages);
  assert.deepEqual(requests[1].format, requests[0].format);
  assert.ok(stages.every(stage => stage.cpuFallback));
});

test('CPU failure is propagated without an unbounded retry', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return Response.json({ error: 'CUDA error: out of memory' }, { status: 500 });
  });
  await assert.rejects(embed(config(), ['test']), (error: unknown) => error instanceof OllamaError && error.code === 'gpu-memory');
  assert.equal(calls, 2);
});

test('other HTTP errors are not retried or exposed verbatim to the UI', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return Response.json({ error: 'private diagnostic' }, { status: 500 });
  });
  await assert.rejects(embed(config(), ['test']), (error: unknown) => {
    assert.ok(error instanceof OllamaError);
    assert.equal(error.code, 'http');
    assert.match(error.message, /private diagnostic/);
    assert.doesNotMatch(error.publicMessage, /private diagnostic/);
    return true;
  });
  assert.equal(calls, 1);
});

test('timeouts and connection failures have actionable messages', async t => {
  const mock = t.mock.method(globalThis, 'fetch', async () => { throw new DOMException('timeout', 'TimeoutError'); });
  await assert.rejects(api(config(), 'tags'), (error: unknown) => error instanceof OllamaError && /RAG_TIMEOUT_MS/.test(error.publicMessage));
  mock.mock.mockImplementation(async () => { throw new TypeError('fetch failed'); });
  await assert.rejects(api(config(), 'tags'), (error: unknown) => error instanceof OllamaError && error.code === 'unavailable');
});
