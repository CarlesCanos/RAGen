import { Tokenizer } from '@huggingface/tokenizers';
import path from 'node:path';
import { readJson, hash } from './storage.ts';

export interface TokenCounter { count(text: string): number; chat(system: string, user: string, thinking: boolean): number }
const counters = new Map<string, TokenCounter>();
export async function loadCounter(directory: string): Promise<TokenCounter> {
  const provenance = await readJson<{ repository: string }>(path.join(directory, 'provenance.json'));
  const key = `${path.resolve(directory)}:${hash(provenance)}`;
  const cached = counters.get(key);
  if (cached) return cached;
  const tokenizer = new Tokenizer(await readJson(path.join(directory, 'tokenizer.json')), await readJson(path.join(directory, 'tokenizer_config.json')));
  const count = (text: string) => tokenizer.encode(text).ids.length;
  // Qwen text-only ChatML template for exactly system + user, no tools/history/images.
  // A safety allowance is reserved separately and measured against prompt_eval_count.
  const counter: TokenCounter = { count, chat: (system, user, thinking) => count(
    provenance.repository.startsWith('deepseek-ai/')
      ? `<｜begin▁of▁sentence｜>${system}<｜User｜>${user}<｜Assistant｜>${thinking ? '<think>\n' : ''}`
      : `<|im_start|>system\n${system}<|im_end|>\n<|im_start|>user\n${user}<|im_end|>\n<|im_start|>assistant\n<think>\n${thinking ? '' : '\n</think>\n\n'}`
  ) };
  if (counters.size >= 2) counters.delete(counters.keys().next().value!);
  counters.set(key, counter);
  return counter;
}
