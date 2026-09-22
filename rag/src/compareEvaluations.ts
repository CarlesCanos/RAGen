import { readJson } from './optimized/storage.ts';

interface Row {
  id: string; kind: string; question: string; expectedStringsPresent: boolean | null;
  totalMs?: number; code?: number; error?: string; stages?: unknown[];
  result?: { status: string; metrics: { totalMs: number; stages: unknown[] } };
}
interface Report { size: number; config: { model: string }; rows: Row[] }
const [baselineFile, optimizedFile] = process.argv.slice(2);
if (!baselineFile || !optimizedFile) throw new Error('Usage: node src/compareEvaluations.ts BASELINE.json OPTIMIZED.json');
const baseline = await readJson<Report>(baselineFile);
const optimized = await readJson<Report>(optimizedFile);
if (baseline.size !== optimized.size) throw new Error('Compare equal corpus sizes');
const pairs = baseline.rows.filter(r => r.kind === 'fact').map(old => {
  const current = optimized.rows.find(r => r.id === old.id && r.question === old.question);
  if (!current) throw new Error(`Missing matching question: ${old.id}`);
  return { old, current };
});
if (!pairs.length) throw new Error('No factual questions to compare');
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
const describe = (rows: Row[]) => {
  const times = rows.map(r => r.result?.metrics.totalMs ?? r.totalMs ?? NaN).filter(Number.isFinite);
  return { count: rows.length, factualPass: rows.filter(r => r.expectedStringsPresent).length,
    failures: rows.filter(r => r.error || (r.code !== undefined && r.code !== 0) || ['invalid', 'truncated'].includes(r.result?.status ?? '')).map(r => r.id),
    medianMs: percentile(times, 0.5), p95Ms: percentile(times, 0.95),
    calls: rows.reduce((sum, r) => sum + (r.result?.metrics.stages ?? r.stages ?? []).length, 0) };
};
const regressions = pairs.filter(p => p.old.expectedStringsPresent && !p.current.expectedStringsPresent).map(p => p.old.id);
const output = { baseline: { model: baseline.config.model, ...describe(pairs.map(p => p.old)) },
  optimized: { model: optimized.config.model, ...describe(pairs.map(p => p.current)) }, regressions,
  limitation: 'Factual synthetic subset only. String matches are not semantic fidelity; review responses and GPU residency separately.' };
console.log(JSON.stringify(output, null, 2));
if (regressions.length || output.optimized.failures.length || output.baseline.failures.length) process.exitCode = 1;
