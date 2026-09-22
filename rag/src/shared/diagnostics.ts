import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { freemem, totalmem } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const diagnosticsDirectory = fileURLToPath(new URL('../../.runtime/logs/', import.meta.url));
// Separate files prevent the chat server and indexing process from racing rotation.
export const diagnosticsFile = path.join(diagnosticsDirectory, `rag-${process.pid}.jsonl`);
const context = new AsyncLocalStorage<{ requestId: string; debug: boolean }>();
let writes: Promise<void> = Promise.resolve();
let warned = false;

export function withDiagnostics<T>(debug: boolean, operation: () => Promise<T>): Promise<T> {
  return context.run({ requestId: randomUUID(), debug }, operation);
}

export function debugEnabled(): boolean {
  return context.getStore()?.debug ?? process.env.RAG_DEBUG === '1';
}

export function errorDetails(error: unknown, depth = 0): unknown {
  if (!(error instanceof Error)) return { message: String(error) };
  return { name: error.name, message: error.message, stack: error.stack,
    code: (error as NodeJS.ErrnoException).code,
    ...(error.cause && depth < 3 ? { cause: errorDetails(error.cause, depth + 1) } : {}) };
}

export async function memorySnapshot() {
  const memory = { process: process.memoryUsage(), system: { totalBytes: totalmem(), freeBytes: freemem() } };
  try {
    const { stdout } = await execFileAsync('nvidia-smi', [
      '--query-gpu=index,name,memory.total,memory.used,memory.free,utilization.gpu', '--format=csv,noheader,nounits',
    ], { windowsHide: true, timeout: 2000, maxBuffer: 64 * 1024 });
    const number = (value: string) => Number.isFinite(Number(value)) ? Number(value) : null;
    const gpus = stdout.trim().split(/\r?\n/).filter(Boolean).map(line => {
      const [index, name, total, used, free, utilization] = line.split(',').map(s => s.trim());
      return { index: number(index), name, totalMiB: number(total), usedMiB: number(used), freeMiB: number(free), utilizationPercent: number(utilization) };
    });
    return { ...memory, gpus };
  } catch (error) {
    return { ...memory, gpuUnavailable: (error as NodeJS.ErrnoException).code ?? 'nvidia-smi unavailable' };
  }
}

export async function trace(event: string, fields: Record<string, unknown> = {}, memory = false): Promise<void> {
  try {
    const entry = { ...fields, time: new Date().toISOString(), pid: process.pid,
      requestId: context.getStore()?.requestId, event,
      ...(memory ? { memory: await memorySnapshot() } : {}) };
    const line = JSON.stringify(entry) + '\n';
    const job = writes.then(async () => {
      await mkdir(diagnosticsDirectory, { recursive: true });
      const size = await stat(diagnosticsFile).then(s => s.size).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return 0;
      });
      if (size && size + Buffer.byteLength(line) > 5 * 1024 * 1024) {
        await rm(`${diagnosticsFile}.1`, { force: true });
        await rename(diagnosticsFile, `${diagnosticsFile}.1`);
      }
      await appendFile(diagnosticsFile, line, 'utf8');
    });
    writes = job.catch(() => undefined);
    await job;
  } catch (error) {
    // Diagnostics must never turn a successful query into a failed query.
    if (!warned) { warned = true; console.warn('[rag] Could not write diagnostic log:', (error as Error).message); }
  }
}
