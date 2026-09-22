import { serve } from '@hono/node-server';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep all relative RAG paths scoped to the sibling RAG project.
const here = path.dirname(fileURLToPath(import.meta.url));
process.chdir(path.resolve(here, '../rag'));
const { app } = await import('./app.ts');

const hostname = process.env.RAG_UI_HOST?.trim() || '127.0.0.1';
const rawPort = Number(process.env.RAG_UI_PORT || 8787);
if (!Number.isInteger(rawPort) || rawPort < 1 || rawPort > 65535) throw new Error('RAG_UI_PORT debe ser un puerto válido');

const server = serve({ fetch: app.fetch, hostname, port: rawPort }, info => {
  console.log(`Local RAG Chat: http://${hostname}:${info.port}`);
  console.log('Pulsa Ctrl+C para detenerlo.');
});

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') console.error(`El puerto ${rawPort} ya está ocupado. Define otro con RAG_UI_PORT.`);
  else console.error('No se pudo iniciar Local RAG Chat:', error.message);
  process.exitCode = 1;
});
