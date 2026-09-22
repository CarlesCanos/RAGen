import { getProjectEnv } from "./env.ts";
import type { ChromaCollectionCliArgs } from "./types/cli.types.ts";
import { assertChromaAvailable, createChromaClient } from "./shared/chroma.ts";

async function main(): Promise<void> {
  const cli = parseCliArgs(process.argv.slice(2));
  const client = createChromaClient(cli);

  await assertChromaAvailable(
    client,
    cli,
    "Start a local Chroma server first."
  );

  await client.deleteCollection({ name: cli.collectionName }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not delete collection "${cli.collectionName}". Original error: ${message}`);
  });

  console.log(`Deleted Chroma collection "${cli.collectionName}".`);
}

function parseCliArgs(args: string[]): ChromaCollectionCliArgs {
  const env = getProjectEnv();
  const positional: string[] = [];
  let collectionName = env.chromaCollection;
  let host = env.chromaHost;
  let port = env.chromaPort;
  let ssl = env.chromaSsl;
  let database: string | undefined;
  let tenant: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    if (arg === "--collection" && next) {
      collectionName = next;
      index += 1;
      continue;
    }

    if (arg === "--host" && next) {
      host = next;
      index += 1;
      continue;
    }

    if (arg === "--port" && next) {
      port = Number(next);
      index += 1;
      continue;
    }

    if (arg === "--database" && next) {
      database = next;
      index += 1;
      continue;
    }

    if (arg === "--tenant" && next) {
      tenant = next;
      index += 1;
      continue;
    }

    if (arg === "--ssl") {
      ssl = true;
      continue;
    }

    positional.push(arg);
  }

  if (positional[0]) {
    collectionName = positional[0];
  }

  if (!Number.isFinite(port) || port <= 0) {
    throw new Error("--port must be a positive number.");
  }

  return {
    collectionName,
    host,
    port,
    ssl,
    database,
    tenant
  };
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
