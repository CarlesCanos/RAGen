import { ChromaClient } from "chromadb";
import type { ChromaConnectionOptions } from "../types/chroma.types.ts";
import { isLoopbackHost } from './network.ts';

export { isLoopbackHost } from './network.ts';

export function createChromaClient(options: ChromaConnectionOptions): ChromaClient {
  if (!isLoopbackHost(options.host)) {
    throw new Error(`CHROMA_HOST must be a loopback address; received "${options.host}".`);
  }
  return new ChromaClient({
    host: options.host,
    port: options.port,
    ssl: options.ssl,
    ...(options.database ? { database: options.database } : {}),
    ...(options.tenant ? { tenant: options.tenant } : {})
  });
}

export async function assertChromaAvailable(
  client: ChromaClient,
  options: ChromaConnectionOptions,
  guidance: string
): Promise<void> {
  await client.heartbeat().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const details = guidance.trim() ? `${guidance.trim()} ` : "";
    throw new Error(
      `Could not reach Chroma at ${options.ssl ? "https" : "http"}://${options.host}:${options.port}. ${details}Original error: ${message}`
    );
  });
}
