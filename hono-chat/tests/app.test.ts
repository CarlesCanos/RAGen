import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { answerWithoutInlineCitations, createApp } from '../app.ts';
import type { Maintenance } from '../app.ts';
import type { AskOptions, AskResult } from '../../rag/src/optimized/ask.ts';
import { rateForHardware } from '../models.ts';
import type { ModelService } from '../models.ts';
import type { Settings } from '../app.ts';
import { latestMessages, projectFiles } from '../projects.ts';
import type { ConversationMessage, Project, ProjectService } from '../projects.ts';
import { SettingsService } from '../settings.ts';

const result: AskResult = {
  answer: 'Respuesta local [doc:1]', status: 'answered',
  sources: [{ id: 'doc:1', source: 'manual.md', heading: 'Prueba' }],
  metrics: { cacheHit: false, totalMs: 1234, searches: [], stages: [], model: 'digest', index: 'snapshot' },
};
const fixtureDocsPath = path.resolve('tests', 'fixtures', 'docs');

test('Hono chat renders SSR safely and exposes local health', async () => {
  const app = createApp(async () => result);
  const page = await app.request('/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') ?? '', /text\/html/);
  assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  const html = await page.text();
  assert.match(html, /RAGen/);
  assert.match(html, /id="project-list"/);
  assert.match(html, /Documents/);
  assert.match(html, /Regenerate RAG/);
  assert.doesNotMatch(html, /__(?:NONCE|STYLES|SCRIPT|MODEL)__/);
  const health = await app.request('/api/health');
  assert.equal(health.status, 200);
  assert.equal((await health.json() as { ok: boolean }).ok, true);
});

test('Hono chat validates input and returns only public answer metadata', async () => {
  const asked: string[] = [];
  const app = createApp(async question => { asked.push(question); return result; });
  const empty = await app.request('/api/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: ' ' }) });
  assert.equal(empty.status, 400);
  const response = await app.request('/api/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: '  prueba  ', mode: 'auto' }) });
  assert.equal(response.status, 200);
  const body = await response.json() as { answer: string; sources: unknown[]; meta: { totalMs: number }; metrics?: unknown };
  assert.deepEqual(asked, ['prueba']);
  assert.equal(body.answer, 'Respuesta local');
  assert.doesNotMatch(body.answer, /doc:1/);
  assert.equal(body.sources.length, 1);
  assert.equal(body.meta.totalMs, 1234);
  assert.equal(body.metrics, undefined);
});

test('API rejects oversized bodies and rate-limits repeated questions', async () => {
  const oversizedApp = createApp(async () => result);
  const oversized = await oversizedApp.request('/api/ask', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'x'.repeat(65 * 1024) }),
  });
  assert.equal(oversized.status, 413);

  const limitedApp = createApp(async () => result);
  const request = () => limitedApp.request('/api/ask', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'prueba' }),
  });
  for (let index = 0; index < 20; index++) assert.equal((await request()).status, 200);
  const limited = await request();
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
});

test('chat presentation removes only known citations and keeps source metadata', () => {
  const answer = 'Primera afirmación [doc:1].\n\nOtra referencia [desconocida]. [doc:1]';
  assert.equal(answerWithoutInlineCitations(answer, result.sources), 'Primera afirmación.\n\nOtra referencia [desconocida].');
  assert.equal(result.sources[0].id, 'doc:1');
});

test('document and regeneration actions require a local header and preserve metadata', async () => {
  let opened = 0;
  let regenerated = 0;
  const maintenance: Maintenance = {
    openDocuments() { opened++; },
    async regenerate() { regenerated++; return { chunks: 42, embedded: 3 }; },
  };
  const app = createApp(async () => result, maintenance);
  assert.equal((await app.request('/api/documents/open', { method: 'POST' })).status, 403);
  const headers = { 'X-Local-RAG': '1' };
  assert.equal((await app.request('/api/documents/open', { method: 'POST', headers })).status, 200);
  const rebuilt = await app.request('/api/rag/regenerate', { method: 'POST', headers });
  assert.equal(rebuilt.status, 200);
  assert.deepEqual(await rebuilt.json(), { ok: true, summary: { chunks: 42, embedded: 3 } });
  assert.equal(opened, 1);
  assert.equal(regenerated, 1);
});

test('hardware ratings are dynamic and conservative without detected VRAM', () => {
  const gpu = { gpu: 'Test GPU', vramBytes: 8e9, ramBytes: 32e9, detection: 'test' };
  assert.equal(rateForHardware(3.4e9, gpu).rating, 'green');
  assert.equal(rateForHardware(6.6e9, gpu).rating, 'yellow');
  assert.equal(rateForHardware(9e9, gpu).rating, 'red');
  assert.equal(rateForHardware(3.4e9, { ...gpu, gpu: null, vramBytes: null }).rating, 'yellow');
});

test('model manager routes list, install and select without rebuilding the RAG', async () => {
  let selected = 'qwen3.5:4b';
  const models: ModelService = {
    current: () => selected,
    async list() { return { current: selected, hardware: { gpu: 'GPU', vramBytes: 8e9, ramBytes: 16e9, detection: 'test' }, models: [] }; },
    async select(name) { selected = name; return selected; },
    async install(name) { return { model: name, state: 'downloading', percent: 0, status: 'Starting download' }; },
    installStatus(name) { return { model: name, state: 'complete', percent: 100, status: 'Installed' }; },
  };
  const maintenance: Maintenance = { openDocuments() {}, async regenerate() { return {}; } };
  const app = createApp(async () => result, maintenance, models);
  assert.equal((await app.request('/api/models')).status, 200);
  const headers = { 'X-Local-RAG': '1', 'Content-Type': 'application/json' };
  const selectedResponse = await app.request('/api/models/select', { method: 'POST', headers, body: JSON.stringify({ model: 'qwen3.5:9b' }) });
  assert.deepEqual(await selectedResponse.json(), { ok: true, model: 'qwen3.5:9b' });
  const installResponse = await app.request('/api/models/install', { method: 'POST', headers, body: JSON.stringify({ model: 'qwen3.5:2b' }) });
  assert.equal(installResponse.status, 202);
  assert.equal((await app.request('/api/models/install/status?model=qwen3.5%3A2b')).status, 200);
});

test('settings routes are local-only and regenerate when an index setting changes', async () => {
  let regenerated = 0;
  let received: Record<string, unknown> | undefined;
  const maintenance: Maintenance = { openDocuments() {}, async regenerate() { regenerated++; return { chunks: 7 }; } };
  const settings: Settings = {
    async list() { return [{ key: 'RAG_DIRECT_TOKENS', value: '512' }]; },
    async apply(input) { received = input; return { reindexRequired: true }; },
  };
  const app = createApp(async () => result, maintenance, undefined, settings);
  assert.deepEqual(await (await app.request('/api/settings')).json(), { settings: [{ key: 'RAG_DIRECT_TOKENS', value: '512' }] });
  assert.equal((await app.request('/api/settings', { method: 'POST' })).status, 403);
  const response = await app.request('/api/settings', {
    method: 'POST', headers: { 'X-Local-RAG': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings: { RAG_DIRECT_TOKENS: '768' }, regenerate: true }),
  });
  assert.deepEqual(await response.json(), { ok: true, reindexRequired: true, summary: { chunks: 7 } });
  assert.deepEqual(received, { RAG_DIRECT_TOKENS: '768' });
  assert.equal(regenerated, 1);
});

test('settings reject non-loopback local-service endpoints', async () => {
  const settings = new SettingsService();
  await assert.rejects(
    settings.apply({ CHROMA_HOST: '192.168.1.10' }, { persist: false }),
    /loopback/
  );
  await assert.rejects(
    settings.apply({ OLLAMA_URL: 'https://example.com' }, { persist: false }),
    /local/
  );
});

test('project routes isolate model, settings, index and maintenance context', async () => {
  const project: Project = {
    id: 'project-one', name: 'Manual', docsPath: fixtureDocsPath, model: 'qwen3.5:2b-q4_K_M',
    settings: { RAG_CONTEXT: '8192' }, createdAt: new Date(0).toISOString(),
  };
  let storedMessages: ConversationMessage[] = [];
  const projectService: ProjectService = {
    async list() { return [{ ...project, settings: { ...project.settings } }]; },
    async get(id) { assert.equal(id, project.id); return { ...project, settings: { ...project.settings } }; },
    async create() { return project; },
    async remove() {},
    async setModel(_id, model) { project.model = model; return project; },
    async setSettings(_id, values) { project.settings = { ...project.settings, ...values }; return project; },
    async getMessages() { return storedMessages; },
    async addMessages(_id, messages) {
      storedMessages = latestMessages([...storedMessages, ...messages.map((message, index) => ({ ...message, id: String(index), createdAt: new Date(0).toISOString() }))]);
      return storedMessages;
    },
    async clearMessages() { storedMessages = []; },
  };
  let askedConfig: AskOptions['config'];
  let regeneratedProject: Project | undefined;
  const maintenance: Maintenance = {
    openDocuments(received) { regeneratedProject = received; },
    async regenerate(received) { regeneratedProject = received; return { chunks: 3 }; },
  };
  const models: ModelService = {
    current: () => 'test-model',
    async list(selected) { return { current: selected ?? 'test-model', hardware: { gpu: null, vramBytes: null, ramBytes: 1, detection: 'test' }, models: [] }; },
    async select(name) { return name; },
    async install(name) { return { model: name, state: 'complete', percent: 100, status: 'ok' }; },
    installStatus() { return undefined; },
  };
  const app = createApp(async (_question, options) => { askedConfig = options?.config; return result; }, maintenance, models, undefined, projectService);
  const headers = { 'X-Local-RAG': '1', 'Content-Type': 'application/json' };

  const projectsResponse = await app.request('/api/projects');
  assert.equal((await projectsResponse.json() as { projects: Project[] }).projects[0].name, 'Manual');
  await app.request('/api/ask', { method: 'POST', headers, body: JSON.stringify({ projectId: project.id, question: 'hola', mode: 'fast' }) });
  assert.equal(askedConfig?.model, project.model);
  assert.equal(askedConfig?.context, 8192);
  assert.match(String(askedConfig?.root), /project-one[\\/]index$/);
  assert.deepEqual(storedMessages.map(message => message.role), ['user', 'assistant']);
  const history = await app.request(`/api/projects/${project.id}/messages`);
  assert.equal(history.headers.get('cache-control'), 'no-store');
  assert.equal((await history.json() as { messages: ConversationMessage[] }).messages.length, 2);

  await app.request('/api/rag/regenerate', { method: 'POST', headers, body: JSON.stringify({ projectId: project.id }) });
  assert.equal(regeneratedProject?.id, project.id);
  assert.equal(storedMessages.length, 0);
  storedMessages = [{ id: 'again', role: 'user', text: 'otra', createdAt: new Date(0).toISOString() }];
  assert.equal((await app.request(`/api/projects/${project.id}/messages`, { method: 'DELETE' })).status, 403);
  assert.equal((await app.request(`/api/projects/${project.id}/messages`, { method: 'DELETE', headers })).status, 200);
  assert.equal(storedMessages.length, 0);
  await app.request('/api/models/select', { method: 'POST', headers, body: JSON.stringify({ projectId: project.id, model: 'qwen3.5:9b-q4_K_M' }) });
  assert.equal(project.model, 'qwen3.5:9b-q4_K_M');
});

test('project conversations retain only the latest 20 messages', () => {
  assert.deepEqual(latestMessages(Array.from({ length: 25 }, (_, index) => index)), Array.from({ length: 20 }, (_, index) => index + 5));
});

test('project storage rejects identifiers that could escape the runtime folder', () => {
  const project: Project = { id: '../outside', name: 'Invalid', docsPath: fixtureDocsPath, model: 'qwen3.5:2b-q4_K_M', settings: {}, createdAt: new Date(0).toISOString() };
  assert.throws(() => projectFiles(project), /Invalid project identifier/);
});

test('a project reports an in-progress answer until it is persisted', async () => {
  const project: Project = { id: 'pending-project', name: 'Pending', docsPath: fixtureDocsPath, model: 'qwen3.5:2b-q4_K_M', settings: {}, createdAt: new Date(0).toISOString() };
  let stored: ConversationMessage[] = [];
  const projects: ProjectService = {
    async list() { return [project]; }, async get() { return project; }, async create() { return project; }, async remove() {},
    async setModel() { return project; }, async setSettings() { return project; }, async getMessages() { return stored; },
    async addMessages(_id, messages) { stored = messages.map((message, index) => ({ ...message, id: String(index), createdAt: new Date(0).toISOString() })); return stored; },
    async clearMessages() { stored = []; },
  };
  let release!: (value: AskResult) => void;
  let markStarted!: () => void;
  const waiting = new Promise<AskResult>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const app = createApp(async () => { markStarted(); return waiting; }, undefined, undefined, undefined, projects);
  const response = app.request('/api/ask', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: project.id, question: '¿Sigue pensando?', mode: 'auto' }),
  });
  await started;
  const concurrent = await app.request('/api/ask', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: project.id, question: 'Second question', mode: 'auto' }),
  });
  assert.equal(concurrent.status, 409);
  const during = await (await app.request(`/api/projects/${project.id}/messages`)).json() as { pending: Array<{ question: string }>; messages: ConversationMessage[] };
  assert.equal(during.messages.length, 0);
  assert.equal(during.pending[0].question, '¿Sigue pensando?');
  release(result);
  assert.equal((await response).status, 200);
  const after = await (await app.request(`/api/projects/${project.id}/messages`)).json() as { pending: unknown[]; messages: ConversationMessage[] };
  assert.equal(after.pending.length, 0);
  assert.deepEqual(after.messages.map(message => message.role), ['user', 'assistant']);
});
