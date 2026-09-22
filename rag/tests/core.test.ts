import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { buildBm25, searchBm25, fuse } from '../src/optimized/bm25.ts';
import { enrich, documentInput, queryInput } from '../src/optimized/index.ts';
import { parseAnswer, parseModelJson, complexQuestion, NO_INFORMATION } from '../src/optimized/ask.ts';
import { atomicJson, readJson, hash } from '../src/optimized/storage.ts';
import { fixtures } from '../src/evaluation/fixtures.ts';
import { resolveModel, type ModelInfo } from '../src/optimized/ollama.ts';
import { createChromaClient, isLoopbackHost } from '../src/shared/chroma.ts';

test('Chroma clients are restricted to loopback', () => {
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('192.168.1.10'), false);
  assert.throws(
    () => createChromaClient({ host: '192.168.1.10', port: 8000, ssl: false }),
    /loopback/
  );
});

test('BM25 uses postings, handles Unicode, unknown terms and prototype names', () => {
  const index = buildBm25([{ id: 'a', text: 'válvula Álamo presión' }, { id: 'b', text: 'constructor prototype valve' }]);
  assert.equal(searchBm25(index, 'Álamo')[0].id, 'a');
  assert.equal(searchBm25(index, 'constructor')[0].id, 'b');
  assert.deepEqual(searchBm25(index, 'missing'), []);
  assert.deepEqual(searchBm25(index, 'toString'), []);
  assert.throws(() => buildBm25([{ id: 'x', text: 'one' }, { id: 'x', text: 'two' }]));
});
test('Ollama model tags accept one explicit quantization suffix but reject ambiguity', () => {
  const model = (name: string): ModelInfo => ({ name, digest: name, size: 1, details: { family: 'qwen35', quantization_level: 'Q4_K_M' } });
  assert.equal(resolveModel([model('qwen3.5:4b-q4_K_M')], 'qwen3.5:4b')?.name, 'qwen3.5:4b-q4_K_M');
  assert.equal(resolveModel([model('qwen3.5:4b')], 'qwen3.5:4b')?.name, 'qwen3.5:4b');
  assert.throws(() => resolveModel([model('qwen3.5:4b-q4_K_M'), model('qwen3.5:4b-q8_0')], 'qwen3.5:4b'), /ambiguous/);
});
test('RRF uses ranks, not incompatible score magnitudes; repeated IDs do not inflate score', () => {
  const hits = fuse([[{ id: 'a', score: 0.01 }, { id: 'b', score: 0 }], [{ id: 'b', score: 100 }, { id: 'a', score: 9 }]]);
  assert.equal(hits[0].score, hits[1].score);
  assert.equal(fuse([[{ id: 'a', score: 1 }, { id: 'a', score: 2 }]])[0].score, 1 / 61);
});
test('example-independent evidence keeps identity and only accepts real citations', () => {
  const chunks = enrich(fixtures(100).manifest.chunks);
  assert.match(documentInput(chunks[0]), /^title: /);
  assert.equal(queryInput('Project-Z'), 'task: search result | query: Project-Z');
  assert.throws(() => parseAnswer('{"answer":"Invented [absent]","sufficient":true}', chunks));
  assert.throws(() => parseAnswer('{"answer":"No citations","sufficient":true}', chunks));
  assert.throws(() => parseAnswer('bad json', chunks));
  assert.equal(parseAnswer(JSON.stringify({ answer: `Supported [${chunks[0].id}]`, sufficient: true }), chunks).sufficient, true);
  const wrapped = '```json\n' + JSON.stringify({ answer: `Supported [chunk-id: ${chunks[0].id}]`, sufficient: true, citations: [chunks[0].id] }) + '\n```';
  assert.equal(parseAnswer(wrapped, chunks).answer, `Supported [${chunks[0].id}]`);
  assert.throws(() => parseAnswer(JSON.stringify({ answer: 'Invented [chunk-id: missing]', sufficient: true }), chunks));
  assert.throws(() => parseModelJson('untrusted preamble {"queries":[]}'));
  assert.deepEqual(parseModelJson('```json\n{"queries":[]}\n```'), { queries: [] });
});
test('atomic snapshots remain readable; cache keys change with model/index/config', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rag-storage-'));
  try {
    const file = path.join(dir, 'pointer.json');
    await atomicJson(file, { active: 'old' });
    await atomicJson(file, { active: 'new', previous: 'old' });
    assert.deepEqual(await readJson(file), { active: 'new', previous: 'old' });
    assert.notEqual(hash({ model: 'a', index: 1 }), hash({ model: 'a', index: 2 }));
  } finally { await rm(dir, { recursive: true }); }
});
test('configuration: process environment overrides .env which overrides example', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rag-env-'));
  try {
    await writeFile(path.join(dir, '.env.example'), 'OLLAMA_CHAT_MODEL=example\nCHROMA_PORT=8001\n');
    await writeFile(path.join(dir, '.env'), 'OLLAMA_CHAT_MODEL=local\n');
    const source = `import {getProjectEnv} from ${JSON.stringify(pathToFileURL(path.resolve('src/env.ts')).href)}; console.log(JSON.stringify(getProjectEnv()));`;
    const base = { ...process.env }; delete base.OLLAMA_CHAT_MODEL; delete base.CHROMA_PORT;
    const run = (env: NodeJS.ProcessEnv) => JSON.parse(spawnSync(process.execPath, ['--input-type=module', '-e', source], { cwd: dir, env, encoding: 'utf8' }).stdout);
    assert.equal(run(base).ollamaChatModel, 'local');
    assert.equal(run(base).chromaPort, 8001);
    assert.equal(run({ ...base, OLLAMA_CHAT_MODEL: 'process' }).ollamaChatModel, 'process');
  } finally { await rm(dir, { recursive: true }); }
});

test('semantic splitter preserves heading-only ancestors and distinct repeated sections', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rag-headings-'));
  try {
    const input = path.join(dir, 'manual.md');
    const output = path.join(dir, 'chunks.json');
    await writeFile(input, '# Manual\n## Group A\n### Settings\nFirst specification.\n## Group B\n### Settings\nSecond specification.\n');
    const result = spawnSync(process.execPath, ['src/splitMarkdown.ts', input, '--output', output], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    const manifest = await readJson<{ chunks: Array<{ id: string; sectionPath: string[] }> }>(output);
    assert.deepEqual(manifest.chunks.map(c => c.sectionPath), [['Manual', 'Group A', 'Settings'], ['Manual', 'Group B', 'Settings']]);
    assert.equal(new Set(manifest.chunks.map(c => c.id)).size, 2);
  } finally { await rm(dir, { recursive: true }); }
});

test('recommendations request reasoning without topic-specific rules', () => {
  assert.equal(complexQuestion('En quien deberia confiar de todos los personajes?'), true);
  assert.equal(complexQuestion('Qué proveedor recomiendas?'), true);
  assert.equal(complexQuestion('Which option should I choose?'), true);
  assert.equal(complexQuestion('1+1 ?'), false);
});
test('insufficient evidence always has the exact requested response without irrelevant citations', () => {
  for (const answer of ['No sé.', 'Una explicación innecesaria [invented]']) {
    assert.deepEqual(parseAnswer(JSON.stringify({ answer, sufficient: false, citations: ['invented'] }), []),
      { answer: NO_INFORMATION, sufficient: false });
  }
  assert.equal(NO_INFORMATION, 'No hay informacion referente a este tema en los documentos');
});
