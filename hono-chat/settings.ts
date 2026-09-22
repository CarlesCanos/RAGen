import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetProjectEnvCache } from '../rag/src/env.ts';
import { isLoopbackHost } from '../rag/src/shared/chroma.ts';

const ragRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../rag');
const examplePath = path.join(ragRoot, '.env.example');
const envPath = path.join(ragRoot, '.env');
const numeric = new Set([
  'RAG_CONTEXT', 'RAG_TIMEOUT_MS', 'RAG_CANDIDATES', 'RAG_RRF_K', 'RAG_CONTEXT_CHUNKS', 'RAG_NEIGHBORS',
  'RAG_DIRECT_TOKENS', 'RAG_DEEP_TOKENS', 'RAG_DECISION_TOKENS', 'RAG_VALIDATION_TOKENS', 'OLLAMA_TEMPERATURE',
  'EMBED_BATCH_SIZE', 'CHROMA_PORT', 'CHROMA_INGEST_BATCH_SIZE', 'SPLIT_TARGET_CHARS', 'SPLIT_MAX_CHARS',
  'SPLIT_OVERLAP_CHARS', 'ASK_TOP_K', 'ASK_MAX_CONTEXT_CHARS', 'ASK_MAX_SEARCH_ATTEMPTS', 'ASK_INTELLIGENCE',
  'ASK_SUPPORT_SELECTION_CANDIDATE_COUNT', 'ASK_SUPPORT_SELECTION_MAX_CHUNKS', 'ASK_SUPPORT_NEIGHBOR_WINDOW',
  'ASK_SUPPORT_NEIGHBOR_MAX_CHUNKS', 'RETRIEVAL_LEXICAL_REQUIRED_WEIGHT', 'RETRIEVAL_LEXICAL_HEADING_BOOST',
  'RETRIEVAL_LEXICAL_EXACT_PHRASE_BOOST', 'RETRIEVAL_LEXICAL_MIN_SCORE', 'RETRIEVAL_DISTANCE_FLOOR',
  'RETRIEVAL_DISTANCE_CAP', 'WEAK_RETRIEVAL_BEST_DISTANCE_THRESHOLD', 'WEAK_RETRIEVAL_AVERAGE_LEXICAL_THRESHOLD',
  'ANSWER_BROAD_QUESTION_BEST_DISTANCE_THRESHOLD', 'ANSWER_HAS_CONTEXT_DISTANCE_THRESHOLD', 'ANSWER_HAS_CONTEXT_OVERLAP_THRESHOLD',
  'ANSWER_BROAD_QUESTION_FALLBACK_DISTANCE_THRESHOLD', 'RANKING_KEYWORD_WEIGHT', 'RANKING_CODE_EXAMPLE_BONUS',
  'RANKING_TEXT_EXAMPLE_BONUS', 'RANKING_HTML_BONUS', 'RANKING_INTRINSIC_PROXIMITY_BASE', 'RANKING_INTRINSIC_PROXIMITY_DECAY',
  'EXAMPLE_BEST_FIT_THRESHOLD', 'EXAMPLE_EXACT_HEADING_THRESHOLD', 'EXAMPLE_EXACT_HEADING_BOOST', 'EXAMPLE_HEADING_WEIGHT',
  'EXAMPLE_CONTENT_WEIGHT', 'EXAMPLE_REQUIRED_COVERAGE_WEIGHT', 'EXAMPLE_BASE_RANK_WEIGHT', 'EXAMPLE_SIBLING_SUPPORT_WEIGHT',
  'EXAMPLE_SAME_FILE_SUPPORT_WEIGHT', 'EXAMPLE_ANCHOR_MIN_SCORE', 'EXAMPLE_ANCHOR_MIN_HEADING_SCORE',
  'EXAMPLE_HEADING_MATCH_WEIGHT', 'EXAMPLE_SAME_HEADING_BOOST', 'EXAMPLE_NEAREST_TEXT_BOOST', 'EXAMPLE_SAME_FILE_BOOST',
  'EXAMPLE_FILE_DISTANCE_BASE_BOOST', 'EXAMPLE_FILE_DISTANCE_DECAY',
]);
const booleans = new Set(['CHROMA_SSL']);
const reindexKeys = new Set(['DOCS_DIR', 'DOCS_EXTENSIONS', 'PDF_TO_TEXT_BIN', 'OLLAMA_URL', 'OLLAMA_EMBED_MODEL', 'CHROMA_COLLECTION', 'CHROMA_HOST', 'CHROMA_PORT', 'CHROMA_SSL', 'RAG_INDEX_DIR', 'SPLIT_TARGET_CHARS', 'SPLIT_MAX_CHARS', 'SPLIT_OVERLAP_CHARS', 'EMBED_BATCH_SIZE', 'CHROMA_INGEST_BATCH_SIZE']);

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

export interface Setting { key: string; value: string; defaultValue: string; description: string; section: string; type: 'number' | 'boolean' | 'select' | 'text'; options?: string[] }
export interface ApplyOptions { values?: Record<string, string>; persist?: boolean }

function parse(content: string): Array<Omit<Setting, 'value'>> {
  let section = 'General'; let notes: string[] = []; const settings: Array<Omit<Setting, 'value'>> = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    const heading = /^#\s+(.+?)\s*$/.exec(line);
    if (heading && !/^#\s*=+/.test(line)) { section = heading[1]; notes = []; continue; }
    if (line.startsWith('#')) { notes.push(line.replace(/^#\s?/, '')); continue; }
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) { if (line) notes = []; continue; }
    const key = match[1]; const defaultValue = match[2];
    const select = key === 'ASK_CONTROLLED_INFERENCE_LEVEL' ? ['strict', 'low', 'medium', 'high'] : undefined;
    settings.push({ key, defaultValue, description: notes.join(' ').trim(), section, type: select ? 'select' : booleans.has(key) ? 'boolean' : numeric.has(key) ? 'number' : 'text', options: select });
    notes = [];
  }
  return settings;
}

function values(content: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const raw of content.split(/\r?\n/)) { const match = /^\s*([A-Z][A-Z0-9_]*)=(.*)$/.exec(raw); if (match) result.set(match[1], match[2]); }
  return result;
}

export class SettingsService {
  private mutationTail: Promise<void> = Promise.resolve();

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  async list(overrides: Record<string, string> = {}): Promise<Setting[]> {
    const [example, local] = await Promise.all([readFile(examplePath, 'utf8'), readFile(envPath, 'utf8').catch(() => '')]);
    const saved = values(local);
    return parse(example).map(setting => ({ ...setting, value: overrides[setting.key] ?? saved.get(setting.key) ?? process.env[setting.key] ?? setting.defaultValue }));
  }

  async apply(input: Record<string, unknown>, options: ApplyOptions = {}): Promise<{ reindexRequired: boolean; values: Record<string, string> }> {
    const current = await this.list(options.values); const allowed = new Map(current.map(setting => [setting.key, setting]));
    const updates = new Map<string, string>();
    for (const [key, raw] of Object.entries(input)) {
      const setting = allowed.get(key); if (!setting || typeof raw !== 'string') throw new Error(`Ajuste no válido: ${key}`);
      const value = raw.trim(); if (value.includes('\n') || value.includes('\r')) throw new Error(`El ajuste ${key} no puede contener saltos de línea.`);
      if (setting.type === 'number' && (!value || !Number.isFinite(Number(value)))) throw new Error(`${key} debe ser un número válido.`);
      if (setting.type === 'boolean' && !['true', 'false'].includes(value.toLowerCase())) throw new Error(`${key} debe ser true o false.`);
      if (setting.options && !setting.options.includes(value)) throw new Error(`${key} tiene un valor no permitido.`);
      if (key === 'CHROMA_HOST' && !isLoopbackHost(value)) throw new Error('CHROMA_HOST debe ser localhost o una dirección de loopback.');
      updates.set(key, value);
    }
    if (!updates.size) throw new Error('No se recibieron ajustes.');
    const normalized = Object.fromEntries(updates);
    const result = { reindexRequired: [...updates.keys()].some(key => reindexKeys.has(key)), values: normalized };
    if (options.persist === false) return result;
    return this.mutate(async () => {
      const before = await readFile(envPath, 'utf8').catch(() => '');
      const existing = values(before); let changed = false;
      for (const [key, value] of updates) { if (existing.get(key) !== value) changed = true; existing.set(key, value); process.env[key] = value; }
      if (changed) {
        const lines = before ? before.split(/\r?\n/) : [];
        const written = new Set<string>();
        const next = lines.map(line => { const match = /^\s*([A-Z][A-Z0-9_]*)=/.exec(line); if (!match || !updates.has(match[1])) return line; written.add(match[1]); return `${match[1]}=${updates.get(match[1])}`; });
        for (const [key, value] of updates) if (!written.has(key)) next.push(`${key}=${value}`);
        await atomicWrite(envPath, `${next.join('\r\n').replace(/\r?\n*$/, '')}\r\n`);
      }
      resetProjectEnvCache();
      return result;
    });
  }
}

export const localSettings = new SettingsService();
