import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { api, resolveModel, tokenizerProfile } from '../rag/src/optimized/ollama.ts';
import type { ModelInfo } from '../rag/src/optimized/ollama.ts';
import { config } from '../rag/src/optimized/config.ts';

const execFileAsync = promisify(execFile);
const ragRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../rag');

export type HardwareRating = 'green' | 'yellow' | 'red';
export interface HardwareInfo { gpu: string | null; vramBytes: number | null; ramBytes: number; detection: string }
export interface ModelView {
  name: string; label: string; sizeBytes: number; installed: boolean; selected: boolean;
  compatible: boolean; rating: HardwareRating; ratingLabel: string; reason: string;
  quantization?: string;
}
export interface InstallState { model: string; state: 'downloading' | 'complete' | 'error'; percent: number; status: string; error?: string }
export interface ModelsResponse { current: string; hardware: HardwareInfo; models: ModelView[] }
export interface ModelService {
  current(): string;
  list(selected?: string): Promise<ModelsResponse>;
  select(name: string, previous?: string): Promise<string>;
  install(name: string): Promise<InstallState>;
  installStatus(name: string): InstallState | undefined;
}

// Sizes and tags verified against the official Ollama registry. Keep this list
// deliberately small: every family here has a tokenizer/template profile in the RAG.
const catalog = [
  { name: 'qwen3.5:0.8b', label: 'Qwen 3.5 0.8B', sizeBytes: 1.0e9 },
  { name: 'qwen3.5:2b-q4_K_M', label: 'Qwen 3.5 2B Q4', sizeBytes: 1.9e9 },
  { name: 'qwen3.5:4b-q4_K_M', label: 'Qwen 3.5 4B Q4', sizeBytes: 3.4e9 },
  { name: 'qwen3.5:9b-q4_K_M', label: 'Qwen 3.5 9B Q4', sizeBytes: 6.6e9 },
  { name: 'qwen3.5:27b', label: 'Qwen 3.5 27B', sizeBytes: 17e9 },
] as const;

export function rateForHardware(sizeBytes: number, hardware: HardwareInfo): Pick<ModelView, 'rating' | 'ratingLabel' | 'reason'> {
  if (hardware.vramBytes && hardware.vramBytes > 0) {
    const ratio = sizeBytes / hardware.vramBytes;
    if (ratio <= 0.65) return { rating: 'green', ratingLabel: 'Recommended', reason: 'Fits in VRAM with room for context and cache.' };
    if (ratio <= 0.90) return { rating: 'yellow', ratingLabel: 'Acceptable', reason: 'Should fit, but leaves little room and may reduce speed.' };
    return { rating: 'red', ratingLabel: 'Not recommended', reason: 'Will likely use RAM/CPU or not fit fully in the GPU.' };
  }
  const ratio = sizeBytes / hardware.ramBytes;
  if (ratio <= 0.30) return { rating: 'yellow', ratingLabel: 'Acceptable', reason: 'VRAM could not be detected; it may run in RAM at a lower speed.' };
  return { rating: 'red', ratingLabel: 'Not recommended', reason: 'VRAM could not be detected, and the model uses a significant amount of RAM.' };
}

async function detectHardware(): Promise<HardwareInfo> {
  try {
    const { stdout } = await execFileAsync('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], { windowsHide: true, timeout: 5000 });
    const cards = stdout.trim().split(/\r?\n/).map(line => {
      const separator = line.lastIndexOf(',');
      return { name: line.slice(0, separator).trim(), mib: Number(line.slice(separator + 1).trim()) };
    }).filter(card => card.name && Number.isFinite(card.mib) && card.mib > 0).sort((a, b) => b.mib - a.mib);
    if (cards[0]) return { gpu: cards[0].name, vramBytes: cards[0].mib * 1024 * 1024, ramBytes: os.totalmem(), detection: 'nvidia-smi' };
  } catch { /* Fall back conservatively when NVIDIA tooling is unavailable. */ }
  return { gpu: null, vramBytes: null, ramBytes: os.totalmem(), detection: 'ram-only' };
}

function matchesCatalog(installed: ModelInfo, catalogName: string): boolean {
  const actual = installed.name.toLowerCase();
  const wanted = catalogName.toLowerCase();
  return actual === wanted || actual === `${wanted}:latest` || actual.startsWith(`${wanted}-`);
}

async function compatibleInstalled(models: ModelInfo[]): Promise<ModelInfo[]> {
  const cfg = config();
  const results = await Promise.all(models.map(async model => {
    if (model.details.family === 'gemma3') return undefined;
    try {
      const profile = await tokenizerProfile(cfg, model);
      await access(path.resolve(ragRoot, profile.directory, 'provenance.json'));
      return model;
    }
    catch { return undefined; }
  }));
  return results.filter((model): model is ModelInfo => Boolean(model));
}

export class LocalModelService implements ModelService {
  private selected = config().model;
  private hardware?: Promise<HardwareInfo>;
  private installs = new Map<string, InstallState>();

  current() { return this.selected; }

  async list(selected = this.selected): Promise<ModelsResponse> {
    const cfg = config();
    const [{ models: allInstalled }, hardware] = await Promise.all([
      api<{ models: ModelInfo[] }>(cfg, 'tags'),
      this.hardware ??= detectHardware(),
    ]);
    const installed = await compatibleInstalled(allInstalled);
    const selectedInfo = resolveModel(installed, selected);
    if (selectedInfo) selected = selectedInfo.name;
    const seen = new Set<string>();
    const views: ModelView[] = catalog.map(item => {
      const found = installed.find(model => matchesCatalog(model, item.name));
      if (found) seen.add(found.name.toLowerCase());
      const sizeBytes = found?.size || item.sizeBytes;
      return { name: found?.name || item.name, label: item.label, sizeBytes, installed: Boolean(found), selected: found?.name === selected,
        compatible: true, quantization: found?.details.quantization_level, ...rateForHardware(sizeBytes, hardware) };
    });
    for (const model of installed.filter(item => !seen.has(item.name.toLowerCase()))) {
      views.push({ name: model.name, label: model.name, sizeBytes: model.size, installed: true, selected: model.name === selected,
        compatible: true, quantization: model.details.quantization_level, ...rateForHardware(model.size, hardware) });
    }
    const order = { green: 0, yellow: 1, red: 2 } as const;
    views.sort((a, b) => Number(b.selected) - Number(a.selected) || order[a.rating] - order[b.rating] || a.sizeBytes - b.sizeBytes);
    return { current: selected, hardware, models: views };
  }

  async select(name: string, previousName = this.selected): Promise<string> {
    const cfg = config();
    const { models } = await api<{ models: ModelInfo[] }>(cfg, 'tags');
    const installed = await compatibleInstalled(models);
    const target = installed.find(model => model.name.toLowerCase() === name.toLowerCase());
    if (!target) throw new Error('The model is not installed or is not compatible with this RAG.');
    const previous = resolveModel(installed, previousName);
    if (previous && previous.name !== target.name) {
      await api(cfg, 'generate', { model: previous.name, prompt: '', stream: false, keep_alive: 0 }).catch(() => undefined);
    }
    this.selected = target.name;
    return this.selected;
  }

  async install(name: string): Promise<InstallState> {
    const item = catalog.find(entry => entry.name.toLowerCase() === name.toLowerCase());
    if (!item) throw new Error('That model is not in the compatible catalog.');
    const existing = this.installs.get(item.name);
    if (existing?.state === 'downloading') return existing;
    if ([...this.installs.values()].some(job => job.state === 'downloading')) throw new Error('Another model is already downloading.');
    const state: InstallState = { model: item.name, state: 'downloading', percent: 0, status: 'Starting download…' };
    this.installs.set(item.name, state);
    void this.pull(item.name, state);
    return state;
  }

  installStatus(name: string) { return this.installs.get(name); }

  private async pull(name: string, state: InstallState) {
    try {
      const cfg = config();
      const response = await fetch(`${cfg.ollamaUrl}/api/pull`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: name, stream: true }), signal: AbortSignal.timeout(60 * 60 * 1000) });
      if (!response.ok || !response.body) throw new Error(`Ollama returned HTTP ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      while (true) {
        const { value, done } = await reader.read();
        pending += decoder.decode(value, { stream: !done });
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as { status?: string; total?: number; completed?: number; error?: string };
          if (event.error) throw new Error(event.error);
          state.status = event.status || state.status;
          if (event.total && event.completed !== undefined) state.percent = Math.max(state.percent, Math.min(99, Math.round(event.completed / event.total * 100)));
        }
        if (done) break;
      }
      const tokenizer = path.join(ragRoot, 'output', 'tokenizer-qwen3.5', 'provenance.json');
      try { await access(tokenizer); }
      catch {
        state.status = 'Installing tokenizer…'; state.percent = 99;
        await execFileAsync(process.execPath, ['src/setupRag.ts', '--tokenizer-only'], {
          cwd: ragRoot, windowsHide: true, timeout: 10 * 60 * 1000, maxBuffer: 10 * 1024 * 1024,
        });
      }
      state.state = 'complete'; state.percent = 100; state.status = 'Installed';
    } catch (error) {
      state.state = 'error'; state.status = 'Error'; state.error = (error as Error).message;
    }
  }
}

export const localModels = new LocalModelService();
