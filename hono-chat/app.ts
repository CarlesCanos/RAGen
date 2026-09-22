import { randomBytes, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { askRag } from '../rag/src/optimized/ask.ts';
import type { AskOptions, AskResult } from '../rag/src/optimized/ask.ts';
import { renderChatPage } from './page.ts';
import { localModels } from './models.ts';
import type { ModelService } from './models.ts';
import { localSettings } from './settings.ts';
import { localProjects, projectEnvironment, projectRagConfig } from './projects.ts';
import type { Project, ProjectService } from './projects.ts';

type Ask = (question: string, options?: AskOptions) => Promise<AskResult>;
export interface Maintenance {
  openDocuments: (project?: Project) => Promise<void> | void;
  regenerate: (project?: Project) => Promise<Record<string, unknown>>;
}
export interface Settings {
  list(overrides?: Record<string, string>): Promise<unknown>;
  apply(input: Record<string, unknown>, options?: { values?: Record<string, string>; persist?: boolean }): Promise<{ reindexRequired: boolean; values?: Record<string, string> }>;
}
const modes = new Set(['auto', 'fast', 'deep']);
const here = path.dirname(fileURLToPath(import.meta.url));
const ragRoot = path.resolve(here, '../rag');
const execFileAsync = promisify(execFile);
const API_BODY_LIMIT_BYTES = 64 * 1024;
const ASK_RATE_LIMIT = 20;
const ASK_RATE_WINDOW_MS = 60_000;

function fixedWindowRateLimit(limit: number, windowMs: number): MiddlewareHandler {
  let windowStartedAt = Date.now();
  let requests = 0;
  return async (c, next) => {
    const now = Date.now();
    if (now - windowStartedAt >= windowMs) {
      windowStartedAt = now;
      requests = 0;
    }
    if (requests >= limit) {
      c.header('Retry-After', String(Math.max(1, Math.ceil((windowMs - (now - windowStartedAt)) / 1000))));
      return c.json({ error: 'Demasiadas solicitudes. Inténtalo de nuevo en unos segundos.' }, 429);
    }
    requests += 1;
    await next();
  };
}

export const localMaintenance: Maintenance = {
  openDocuments(project) {
    if (process.platform !== 'win32') throw new Error('Abrir la carpeta automáticamente solo está configurado para Windows.');
    spawn('explorer.exe', [project?.docsPath ?? path.join(ragRoot, 'docs')], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
  },
  async regenerate(project) {
    const { stdout } = await execFileAsync(process.execPath, ['src/prepareRag.ts'], {
      cwd: ragRoot, env: project ? projectEnvironment(project) : process.env,
      windowsHide: true, timeout: 30 * 60 * 1000, maxBuffer: 10 * 1024 * 1024,
    });
    for (const line of stdout.trim().split(/\r?\n/).reverse()) {
      try {
        const summary = JSON.parse(line) as Record<string, unknown>;
        if (summary && typeof summary === 'object') return summary;
      } catch { /* Progress lines are intentionally ignored. */ }
    }
    return { message: 'Índice regenerado.' };
  },
};

export function answerWithoutInlineCitations(answer: string, sources: AskResult['sources']): string {
  let clean = answer;
  for (const source of sources) clean = clean.replaceAll(`[${source.id}]`, '');
  return clean
    .split('\n')
    .map(line => line.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+([,.;:!?])/g, '$1').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function serialQueue() {
  let tail: Promise<void> = Promise.resolve();
  return <T>(job: () => Promise<T>): Promise<T> => {
    const result = tail.then(job, job);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
}

export function createApp(runAsk: Ask = askRag, maintenance: Maintenance = localMaintenance, models: ModelService = localModels, settings: Settings = localSettings, projects: ProjectService = localProjects) {
  const app = new Hono();
  const enqueue = serialQueue();
  const projectFor = async (id: unknown) => typeof id === 'string' && id ? projects.get(id) : undefined;
  const pendingRequests = new Map<string, Map<string, string>>();

  app.use('*', async (c, next) => {
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Frame-Options', 'DENY');
    await next();
  });
  app.use('/api/*', bodyLimit({
    maxSize: API_BODY_LIMIT_BYTES,
    onError: c => c.json({ error: 'La solicitud supera el límite de 64 KiB.' }, 413),
  }));
  app.use('/api/ask', fixedWindowRateLimit(ASK_RATE_LIMIT, ASK_RATE_WINDOW_MS));

  app.get('/', c => {
    const nonce = randomBytes(18).toString('base64');
    c.header('Cache-Control', 'no-store');
    c.header('Content-Security-Policy', `default-src 'self'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'`);
    return c.html(renderChatPage({ model: models.current(), nonce }));
  });

  app.get('/api/health', c => c.json({ ok: true, model: models.current() }));

  app.get('/api/projects', async c => {
    try { return c.json({ projects: await projects.list() }); }
    catch (error) { console.error('[hono-chat] projects list', error); return c.json({ error: 'No se pudieron cargar los proyectos.' }, 500); }
  });

  app.post('/api/projects', async c => {
    if (c.req.header('X-Local-RAG') !== '1') return c.json({ error: 'Petición local no válida.' }, 403);
    const body = await c.req.json<{ name?: unknown; docsPath?: unknown }>().catch(() => undefined);
    if (!body || typeof body.name !== 'string' || typeof body.docsPath !== 'string') return c.json({ error: 'Nombre y carpeta son obligatorios.' }, 400);
    try { return c.json({ project: await projects.create({ name: body.name, docsPath: body.docsPath }) }, 201); }
    catch (error) { return c.json({ error: (error as Error).message }, 400); }
  });

  app.delete('/api/projects/:id', async c => {
    if (c.req.header('X-Local-RAG') !== '1') return c.json({ error: 'Petición local no válida.' }, 403);
    try { const id = c.req.param('id'); pendingRequests.delete(id); await projects.remove(id); return c.json({ ok: true }); }
    catch (error) { return c.json({ error: (error as Error).message }, 400); }
  });

  app.get('/api/projects/:id/messages', async c => {
    c.header('Cache-Control', 'no-store');
    if (!projects.getMessages) return c.json({ messages: [], pending: [] });
    try {
      const id = c.req.param('id');
      const pending = [...(pendingRequests.get(id)?.entries() ?? [])].map(([requestId, question]) => ({ requestId, question }));
      return c.json({ messages: await projects.getMessages(id), pending });
    }
    catch (error) { return c.json({ error: (error as Error).message }, 404); }
  });

  app.delete('/api/projects/:id/messages', async c => {
    if (c.req.header('X-Local-RAG') !== '1') return c.json({ error: 'Petición local no válida.' }, 403);
    try {
      const id = c.req.param('id');
      pendingRequests.delete(id);
      await projects.clearMessages?.(id);
      return c.json({ ok: true });
    } catch (error) { return c.json({ error: (error as Error).message }, 400); }
  });

  app.post('/api/folders/select', async c => {
    if (c.req.header('X-Local-RAG') !== '1') return c.json({ error: 'Petición local no válida.' }, 403);
    if (process.platform !== 'win32') return c.json({ error: 'El selector nativo de carpetas solo está disponible en Windows.' }, 501);
    const command = "Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description = 'Selecciona la carpeta de documentos'; $dialog.ShowNewFolderButton = $true; if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Write-Output $dialog.SelectedPath }";
    try {
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-STA', '-Command', command], { windowsHide: false, timeout: 10 * 60 * 1000 });
      const selectedPath = stdout.trim();
      return selectedPath ? c.json({ path: selectedPath }) : c.json({ cancelled: true });
    } catch (error) { console.error('[hono-chat] folder picker', error); return c.json({ error: 'No se pudo abrir el selector de carpetas.' }, 500); }
  });

  app.get('/api/models', async c => {
    try {
      const project = await projectFor(c.req.query('projectId'));
      return c.json(await models.list(project?.model));
    }
    catch (error) { console.error('[hono-chat] models', error); return c.json({ error: 'No se pudo consultar Ollama ni detectar el hardware.' }, 503); }
  });

  app.get('/api/settings', async c => {
    try {
      const project = await projectFor(c.req.query('projectId'));
      const overrides = project ? { ...project.settings, DOCS_DIR: project.docsPath, RAG_CHAT_MODEL: project.model } : undefined;
      return c.json({ settings: await settings.list(overrides) });
    }
    catch (error) { console.error('[hono-chat] settings list', error); return c.json({ error: 'No se pudieron cargar los ajustes.' }, 500); }
  });

  app.post('/api/settings', async c => {
    if (c.req.header('X-Local-RAG') !== '1') return c.json({ error: 'Petición local no válida.' }, 403);
    const body = await c.req.json<{ settings?: unknown; regenerate?: unknown; projectId?: unknown }>().catch(() => undefined);
    if (!body || !body.settings || typeof body.settings !== 'object' || Array.isArray(body.settings) || typeof body.regenerate !== 'boolean') return c.json({ error: 'Ajustes no válidos.' }, 400);
    try {
      const project = await projectFor(body.projectId);
      const result = await enqueue(async () => {
        const input = { ...(body.settings as Record<string, unknown>) };
        for (const key of ['DOCS_DIR', 'RAG_CHAT_MODEL', 'RAG_INDEX_DIR', 'CHUNKS_PATH', 'EMBEDDINGS_PATH', 'KNOWLEDGE_CACHE_PATH', 'QUERY_CACHE_PATH', 'CHROMA_COLLECTION']) delete input[key];
        const applied = await settings.apply(input, project ? { values: project.settings, persist: false } : undefined);
        if (project) await projects.setSettings(project.id, applied.values ?? Object.fromEntries(Object.entries(input).filter((entry): entry is [string, string] => typeof entry[1] === 'string')));
        const refreshed = project ? await projects.get(project.id) : undefined;
        const summary = applied.reindexRequired && body.regenerate ? await maintenance.regenerate(refreshed) : undefined;
        if (summary && refreshed) { pendingRequests.delete(refreshed.id); await projects.clearMessages?.(refreshed.id); }
        return { ...applied, summary };
      });
      const { values: _values, ...publicResult } = result;
      return c.json({ ok: true, ...publicResult });
    } catch (error) {
      console.error('[hono-chat] settings apply', error);
      return c.json({ error: (error as Error).message || 'No se pudieron aplicar los ajustes.' }, 400);
    }
  });

  app.post('/api/models/select', async c => {
    if (c.req.header('X-Local-RAG') !== '1') return c.json({ error: 'Petición local no válida.' }, 403);
    const body = await c.req.json<{ model?: unknown; projectId?: unknown }>().catch(() => undefined);
    if (!body || typeof body.model !== 'string') return c.json({ error: 'Modelo no válido.' }, 400);
    const requestedModel = body.model;
    try {
      const project = await projectFor(body.projectId);
      const model = await enqueue(() => models.select(requestedModel, project?.model));
      if (project) await projects.setModel(project.id, model);
      return c.json({ ok: true, model });
    } catch (error) { return c.json({ error: (error as Error).message }, 400); }
  });

  app.post('/api/models/install', async c => {
    if (c.req.header('X-Local-RAG') !== '1') return c.json({ error: 'Petición local no válida.' }, 403);
    const body = await c.req.json<{ model?: unknown }>().catch(() => undefined);
    if (!body || typeof body.model !== 'string') return c.json({ error: 'Modelo no válido.' }, 400);
    try { return c.json({ ok: true, job: await models.install(body.model) }, 202); }
    catch (error) { return c.json({ error: (error as Error).message }, 400); }
  });

  app.get('/api/models/install/status', c => {
    const name = c.req.query('model');
    if (!name) return c.json({ error: 'Falta el modelo.' }, 400);
    const job = models.installStatus(name);
    return job ? c.json({ job }) : c.json({ error: 'Descarga no encontrada.' }, 404);
  });

  app.post('/api/documents/open', async c => {
    if (c.req.header('X-Local-RAG') !== '1') return c.json({ error: 'Petición local no válida.' }, 403);
    try {
      const body = await c.req.json<{ projectId?: unknown }>().catch((): { projectId?: unknown } => ({}));
      await maintenance.openDocuments(await projectFor(body.projectId));
      return c.json({ ok: true });
    } catch (error) {
      console.error('[hono-chat] open documents', error);
      return c.json({ error: 'No se pudo abrir la carpeta de documentos.' }, 500);
    }
  });

  app.post('/api/rag/regenerate', async c => {
    if (c.req.header('X-Local-RAG') !== '1') return c.json({ error: 'Petición local no válida.' }, 403);
    try {
      const body = await c.req.json<{ projectId?: unknown }>().catch((): { projectId?: unknown } => ({}));
      const project = await projectFor(body.projectId);
      const summary = await enqueue(() => maintenance.regenerate(project));
      if (project) { pendingRequests.delete(project.id); await projects.clearMessages?.(project.id); }
      return c.json({ ok: true, summary });
    } catch (error) {
      console.error('[hono-chat] regenerate', error);
      return c.json({ error: 'No se pudo regenerar el RAG. Revisa la consola del servidor.' }, 500);
    }
  });

  app.post('/api/ask', async c => {
    let body: unknown;
    try { body = await c.req.json(); }
    catch { return c.json({ error: 'El cuerpo debe ser JSON válido.' }, 400); }
    if (!body || typeof body !== 'object') return c.json({ error: 'Petición inválida.' }, 400);
    const input = body as { question?: unknown; mode?: unknown; projectId?: unknown };
    const question = typeof input.question === 'string' ? input.question.trim() : '';
    const mode = typeof input.mode === 'string' ? input.mode : 'auto';
    if (!question) return c.json({ error: 'Escribe una pregunta.' }, 400);
    if (question.length > 4000) return c.json({ error: 'La pregunta supera los 4000 caracteres.' }, 400);
    if (!modes.has(mode)) return c.json({ error: 'Modo no válido.' }, 400);

    try {
      const project = await projectFor(input.projectId);
      const requestId = project ? randomUUID() : undefined;
      if (project && requestId) {
        const projectPending = pendingRequests.get(project.id) ?? new Map<string, string>();
        projectPending.set(requestId, question);
        pendingRequests.set(project.id, projectPending);
      }
      try {
        const result = await enqueue(() => runAsk(question, { mode: mode as AskOptions['mode'], config: project ? projectRagConfig(project) : { model: models.current() } }));
        const answer = answerWithoutInlineCitations(result.answer, result.sources);
        const meta = { cacheHit: result.metrics.cacheHit, totalMs: Math.round(result.metrics.totalMs) };
        if (project && requestId && pendingRequests.get(project.id)?.has(requestId)) await projects.addMessages?.(project.id, [
          { role: 'user', text: question },
          { role: 'assistant', text: answer, sources: result.sources, meta },
        ]);
        return c.json({ answer, status: result.status, sources: result.sources, meta });
      } finally {
        if (project && requestId) {
          const projectPending = pendingRequests.get(project.id);
          projectPending?.delete(requestId);
          if (!projectPending?.size) pendingRequests.delete(project.id);
        }
      }
    } catch (error) {
      console.error('[hono-chat]', error);
      return c.json({ error: 'No se pudo consultar el RAG local. Revisa Ollama, Chroma y el índice.' }, 503);
    }
  });

  app.notFound(c => c.json({ error: 'Ruta no encontrada.' }, 404));
  return app;
}

export const app = createApp();
