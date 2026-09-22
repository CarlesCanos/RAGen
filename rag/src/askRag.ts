import { pathToFileURL } from 'node:url';
import { askRag } from './optimized/ask.ts';
import type { AskOptions } from './optimized/ask.ts';
export { askRag } from './optimized/ask.ts';

async function main() {
  const args = process.argv.slice(2);
  const options: AskOptions = { config: {} };
  const question: string[] = [];
  let metrics = false;
  let answerOnly = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--metrics') metrics = true;
    else if (arg === '--answer-only') answerOnly = true;
    else if (arg === '--no-cache') options.cache = false;
    else if (arg === '--show-prompt') metrics = true;
    else if (['--mode', '--language', '--chat-model', '--ollama-url', '--question', '--context'].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      if (arg === '--mode') {
        if (!['auto', 'fast', 'deep'].includes(value)) throw new Error('Invalid mode');
        options.mode = value as AskOptions['mode'];
      } else if (arg === '--language') options.language = value;
      else if (arg === '--question') question.push(value);
      else if (arg === '--chat-model') options.config!.model = value;
      else if (arg === '--ollama-url') options.config!.ollamaUrl = value.replace(/\/+$/, '');
      else { const context = Number(value); if (!Number.isInteger(context) || context < 2048) throw new Error('Invalid context'); options.config!.context = context; }
    } else if (arg.startsWith('--')) throw new Error(`Unknown option ${arg}`);
    else question.push(arg);
  }
  const result = await askRag(question.join(' '), options);
  console.log(result.answer);
  if (!answerOnly) console.log(JSON.stringify({ status: result.status, sources: result.sources }, null, 2));
  if (metrics) console.error(JSON.stringify(result.metrics));
  if (result.status === 'invalid' || result.status === 'truncated') process.exitCode = 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
