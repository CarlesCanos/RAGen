import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../rag/src/optimized/config.ts';
import type { Config } from '../rag/src/optimized/config.ts';
import { getProjectEnv } from '../rag/src/env.ts';

const ragRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../rag');
const runtimeRoot = path.join(ragRoot, '.runtime');
const projectsPath = path.join(runtimeRoot, 'projects.json');
export const MAX_CONVERSATION_MESSAGES = 20;

export function latestMessages<T>(messages: T[]): T[] {
  return messages.slice(-MAX_CONVERSATION_MESSAGES);
}

export interface Project {
  id: string;
  name: string;
  docsPath: string;
  model: string;
  settings: Record<string, string>;
  createdAt: string;
}

export interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  sources?: Array<{ id: string; source: string; heading: string }>;
  meta?: { cacheHit: boolean; totalMs: number };
  createdAt: string;
}

const projectIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const settingKeyPattern = /^[A-Z][A-Z0-9_]*$/;

async function atomicWrite(file: string, contents: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, 'utf8');
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateProject(value: unknown, index: number): Project {
  if (!isRecord(value)) throw new Error(`El proyecto ${index + 1} no es un objeto válido.`);
  const { id, name, docsPath, model, settings, createdAt } = value;
  if (typeof id !== 'string' || !projectIdPattern.test(id)) throw new Error(`El proyecto ${index + 1} tiene un identificador no válido.`);
  if (typeof name !== 'string' || !name.trim() || name.length > 80) throw new Error(`El proyecto ${id} tiene un nombre no válido.`);
  if (typeof docsPath !== 'string' || !path.isAbsolute(docsPath)) throw new Error(`El proyecto ${id} tiene una ruta de documentos no válida.`);
  if (typeof model !== 'string' || !model.trim() || model.length > 200) throw new Error(`El proyecto ${id} tiene un modelo no válido.`);
  if (!isRecord(settings)) throw new Error(`El proyecto ${id} tiene ajustes no válidos.`);
  const validatedSettings: Record<string, string> = {};
  for (const [key, settingValue] of Object.entries(settings)) {
    if (!settingKeyPattern.test(key) || typeof settingValue !== 'string' || settingValue.length > 4096 || /[\r\n]/.test(settingValue)) {
      throw new Error(`El proyecto ${id} contiene un ajuste no válido: ${key}.`);
    }
    validatedSettings[key] = settingValue;
  }
  if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) throw new Error(`El proyecto ${id} tiene una fecha no válida.`);
  return { id, name: name.trim(), docsPath, model: model.trim(), settings: validatedSettings, createdAt };
}

function assertProjectId(id: string): void {
  if (!projectIdPattern.test(id)) throw new Error('Identificador de proyecto no válido.');
}

export interface ProjectService {
  list(): Promise<Project[]>;
  get(id: string): Promise<Project>;
  create(input: { name: string; docsPath: string }): Promise<Project>;
  remove(id: string): Promise<void>;
  setModel(id: string, model: string): Promise<Project>;
  setSettings(id: string, settings: Record<string, string>): Promise<Project>;
  getMessages?(id: string): Promise<ConversationMessage[]>;
  addMessages?(id: string, messages: Array<Omit<ConversationMessage, 'id' | 'createdAt'>>): Promise<ConversationMessage[]>;
  clearMessages?(id: string): Promise<void>;
}

function safeProject(project: Project): Project {
  return { ...project, settings: { ...project.settings } };
}

export function projectFiles(project: Project) {
  assertProjectId(project.id);
  const root = path.join(runtimeRoot, 'projects', project.id);
  return {
    root,
    chunks: path.join(root, 'chunks.json'),
    embeddings: path.join(root, 'chunks.embeddings.json'),
    knowledge: path.join(root, 'knowledge-cache.json'),
    queryCache: path.join(root, 'query-cache.json'),
    conversation: path.join(root, 'conversation.json'),
    index: path.join(root, 'index'),
    collection: `local_rag_${project.id.replace(/-/g, '_')}`,
  };
}

export function projectEnvironment(project: Project): NodeJS.ProcessEnv {
  const files = projectFiles(project);
  return {
    ...process.env,
    ...project.settings,
    DOCS_DIR: project.docsPath,
    RAG_CHAT_MODEL: project.model,
    CHUNKS_PATH: files.chunks,
    EMBEDDINGS_PATH: files.embeddings,
    KNOWLEDGE_CACHE_PATH: files.knowledge,
    QUERY_CACHE_PATH: files.queryCache,
    RAG_INDEX_DIR: files.index,
    CHROMA_COLLECTION: files.collection,
  };
}

export function projectRagConfig(project: Project): Partial<Config> {
  const base = config();
  const env = projectEnvironment(project);
  const integer = (key: string, fallback: number, min = 1) => {
    const parsed = Number(env[key] ?? fallback);
    if (!Number.isInteger(parsed) || parsed < min) throw new Error(`${key} debe ser un entero mayor o igual que ${min}.`);
    return parsed;
  };
  const number = (key: string, fallback: number) => {
    const parsed = Number(env[key] ?? fallback);
    if (!Number.isFinite(parsed)) throw new Error(`${key} debe ser un número válido.`);
    return parsed;
  };
  const files = projectFiles(project);
  return {
    ...base,
    ollamaUrl: env.OLLAMA_URL?.trim().replace(/\/+$/, '') || base.ollamaUrl,
    model: project.model,
    embedModel: env.OLLAMA_EMBED_MODEL?.trim() || base.embedModel,
    language: env.ASK_PREFERRED_LANGUAGE?.trim() || base.language,
    host: env.CHROMA_HOST?.trim() || base.host,
    port: integer('CHROMA_PORT', base.port),
    ssl: /^(true|1|yes)$/i.test(env.CHROMA_SSL ?? String(base.ssl)),
    collection: files.collection,
    root: files.index,
    tokenizerDir: env.RAG_TOKENIZER_DIR?.trim() || base.tokenizerDir,
    context: integer('RAG_CONTEXT', base.context, 2048),
    timeout: integer('RAG_TIMEOUT_MS', base.timeout),
    candidates: integer('RAG_CANDIDATES', base.candidates),
    rrf: integer('RAG_RRF_K', base.rrf),
    chunks: integer('RAG_CONTEXT_CHUNKS', base.chunks),
    neighbors: integer('RAG_NEIGHBORS', base.neighbors, 0),
    keepAlive: env.RAG_KEEP_ALIVE?.trim() || base.keepAlive,
    temperature: number('OLLAMA_TEMPERATURE', base.temperature),
    directTokens: integer('RAG_DIRECT_TOKENS', base.directTokens),
    deepTokens: integer('RAG_DEEP_TOKENS', base.deepTokens),
    decisionTokens: integer('RAG_DECISION_TOKENS', base.decisionTokens),
    validationTokens: integer('RAG_VALIDATION_TOKENS', base.validationTokens),
  };
}

export class LocalProjectService implements ProjectService {
  private projects?: Project[];
  private loading?: Promise<Project[]>;
  private mutationTail: Promise<void> = Promise.resolve();

  private load(): Promise<Project[]> {
    if (this.projects) return Promise.resolve(this.projects);
    if (!this.loading) {
      const loading = this.loadFromDisk();
      this.loading = loading;
      void loading.catch(() => { if (this.loading === loading) this.loading = undefined; });
    }
    return this.loading;
  }

  private async loadFromDisk(): Promise<Project[]> {
    await mkdir(runtimeRoot, { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(projectsPath, 'utf8')) as unknown;
      if (!Array.isArray(parsed)) throw new Error('El archivo de proyectos no contiene una lista.');
      const validated = parsed.map(validateProject);
      if (new Set(validated.map(project => project.id)).size !== validated.length) throw new Error('El archivo de proyectos contiene identificadores duplicados.');
      this.projects = validated;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const env = getProjectEnv();
      const initial = [{
        id: randomUUID(),
        name: 'Default',
        docsPath: path.resolve(ragRoot, env.docsDir),
        model: config().model,
        settings: {},
        createdAt: new Date().toISOString(),
      }];
      await this.save(initial);
      this.projects = initial;
    }
    return this.projects;
  }

  private async save(projects: Project[]) {
    await atomicWrite(projectsPath, `${JSON.stringify(projects, null, 2)}\n`);
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  async list() { return (await this.load()).map(safeProject); }

  async get(id: string) {
    const project = (await this.load()).find(item => item.id === id);
    if (!project) throw new Error('Proyecto no encontrado.');
    return safeProject(project);
  }

  async create(input: { name: string; docsPath: string }) {
    const name = input.name.trim();
    if (!name || name.length > 80) throw new Error('El nombre del proyecto debe tener entre 1 y 80 caracteres.');
    const docsPath = path.resolve(input.docsPath.trim());
    if (!(await stat(docsPath).catch(() => undefined))?.isDirectory()) throw new Error('La carpeta de documentos no existe o no es accesible.');
    return this.mutate(async () => {
      const projects = await this.load();
      const project: Project = { id: randomUUID(), name, docsPath, model: config().model, settings: {}, createdAt: new Date().toISOString() };
      const next = [...projects, project];
      await this.save(next);
      this.projects = next;
      return safeProject(project);
    });
  }

  async remove(id: string) {
    return this.mutate(async () => {
      const projects = await this.load();
      if (projects.length === 1) throw new Error('Debe existir al menos un proyecto.');
      const removed = projects.find(item => item.id === id);
      if (!removed) throw new Error('Proyecto no encontrado.');
      const next = projects.filter(item => item.id !== id);
      await this.save(next);
      this.projects = next;
      const projectRoot = path.resolve(projectFiles(removed).root);
      const allowedRoot = `${path.resolve(runtimeRoot, 'projects')}${path.sep}`;
      if (projectRoot.startsWith(allowedRoot)) await rm(projectRoot, { recursive: true, force: true });
    });
  }

  async setModel(id: string, model: string) {
    return this.mutate(async () => {
      const projects = await this.load();
      const project = projects.find(item => item.id === id);
      if (!project) throw new Error('Proyecto no encontrado.');
      const updated = { ...project, model };
      const next = projects.map(item => item.id === id ? updated : item);
      await this.save(next);
      this.projects = next;
      return safeProject(updated);
    });
  }

  async setSettings(id: string, settings: Record<string, string>) {
    return this.mutate(async () => {
      const projects = await this.load();
      const project = projects.find(item => item.id === id);
      if (!project) throw new Error('Proyecto no encontrado.');
      const updated = { ...project, settings: { ...project.settings, ...settings } };
      const next = projects.map(item => item.id === id ? updated : item);
      await this.save(next);
      this.projects = next;
      return safeProject(updated);
    });
  }

  async getMessages(id: string): Promise<ConversationMessage[]> {
    const project = await this.get(id);
    try {
      const parsed = JSON.parse(await readFile(projectFiles(project).conversation, 'utf8')) as unknown;
      return Array.isArray(parsed) ? latestMessages(parsed as ConversationMessage[]) : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async addMessages(id: string, messages: Array<Omit<ConversationMessage, 'id' | 'createdAt'>>) {
    return this.mutate(async () => {
      const project = await this.get(id);
      const existing = await this.getMessages(id);
      const now = new Date().toISOString();
      const next = latestMessages([...existing, ...messages.map(message => ({ ...message, id: randomUUID(), createdAt: now }))]);
      await atomicWrite(projectFiles(project).conversation, `${JSON.stringify(next, null, 2)}\n`);
      return next;
    });
  }

  async clearMessages(id: string) {
    return this.mutate(async () => {
      const project = await this.get(id);
      await rm(projectFiles(project).conversation, { force: true });
    });
  }
}

export const localProjects = new LocalProjectService();
