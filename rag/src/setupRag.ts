import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from './optimized/config.ts';
import { api, modelInfo } from './optimized/ollama.ts';
import { atomicJson, hash } from './optimized/storage.ts';

const cfg = config();
for (const model of process.argv.includes('--tokenizer-only') ? [] : [cfg.model, cfg.embedModel]) {
  console.error(`Installing/verifying ${model} (existing models are retained)...`);
  await api({ ...cfg, timeout: 3600000 }, 'pull', { model, stream: false });
}
if (cfg.tokenizerDir === 'auto') cfg.tokenizerDir = 'output/tokenizer-qwen3.5';
const repository = 'Qwen/Qwen3.5-4B';
const revision = '851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a';
await mkdir(cfg.tokenizerDir, { recursive: true });
const files: Record<string, string> = {};
for (const file of ['tokenizer.json', 'tokenizer_config.json', 'chat_template.jinja']) {
  const response = await fetch(`https://huggingface.co/${repository}/resolve/${revision}/${file}`, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Tokenizer ${file}: ${response.status}`);
  const data = await response.text();
  await writeFile(path.join(cfg.tokenizerDir, file), data);
  files[file] = hash(data);
}
await atomicJson(path.join(cfg.tokenizerDir, 'provenance.json'), { repository, revision, files });
if (!process.argv.includes('--tokenizer-only')) await atomicJson(path.join(cfg.root, 'models.json'), {
  installedAt: new Date().toISOString(), ollama: await api(cfg, 'version'),
  chat: await modelInfo(cfg, cfg.model), embedding: await modelInfo(cfg, cfg.embedModel), tokenizer: { repository, revision },
});
console.error('Models and tokenizer ready. Run npm run doctor, then npm run prepare-rag.');
