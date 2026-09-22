import { serve } from '@hono/node-server';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep all relative RAG paths scoped to the sibling RAG project.
const here = path.dirname(fileURLToPath(import.meta.url));
process.chdir(path.resolve(here, '../rag'));
const { app } = await import('./app.ts');
const { diagnosticsFile } = await import('../rag/src/shared/diagnostics.ts');

const hostname = process.env.RAG_UI_HOST?.trim() || '127.0.0.1';
const rawPort = Number(process.env.RAG_UI_PORT || 8787);
if (!Number.isInteger(rawPort) || rawPort < 1 || rawPort > 65535) throw new Error('RAG_UI_PORT must be a valid port');

const server = serve({ fetch: app.fetch, hostname, port: rawPort }, info => {
  console.log(`Local RAG Chat: http://${hostname}:${info.port}`);
  console.log(`Diagnostic log: ${diagnosticsFile}`);
  console.log('Press Ctrl+C to stop it.');
});

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') console.error(`Port ${rawPort} is already in use. Set another with RAG_UI_PORT.`);
  else console.error('Could not start Local RAG Chat:', error.message);
  process.exitCode = 1;
});
