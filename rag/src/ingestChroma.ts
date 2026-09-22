import path from "node:path";
import { readFile } from "node:fs/promises";
import { getProjectEnv } from "./env.ts";
import type { IngestCliArgs } from "./types/cli.types.ts";
import { createChromaClient, assertChromaAvailable } from "./shared/chroma.ts";
import { buildChromaMetadata, readEmbeddingManifest } from "./shared/manifests.ts";

async function main(): Promise<void> {
  const cli = parseCliArgs(process.argv.slice(2));
  const inputPath = path.resolve(process.cwd(), cli.inputPath);
  const manifest = readEmbeddingManifest(await readFile(inputPath, "utf8"));
  const client = createChromaClient(cli);

  await assertChromaAvailable(
    client,
    cli,
    "Start a local Chroma server first."
  );

  if (cli.resetCollection) {
    await client.deleteCollection({ name: cli.collectionName }).catch(() => undefined);
  }

  const collection = await client.getOrCreateCollection({
    name: cli.collectionName,
    embeddingFunction: null,
    metadata: {
      embedding_model: manifest.model,
      source_manifest_path: manifest.sourceManifestPath,
      input_path: manifest.inputPath
    }
  });

  for (let index = 0; index < manifest.chunks.length; index += cli.batchSize) {
    const batch = manifest.chunks.slice(index, index + cli.batchSize);

    await collection.upsert({
      ids: batch.map((chunk) => chunk.id),
      embeddings: batch.map((chunk) => chunk.embedding),
      documents: batch.map((chunk) => chunk.text),
      metadatas: batch.map((chunk) => buildChromaMetadata(chunk, manifest))
    });

    console.log(
      `Stored ${Math.min(index + batch.length, manifest.chunks.length)}/${manifest.chunks.length} chunks in Chroma`
    );
  }

  console.log(
    `Collection "${cli.collectionName}" is ready in Chroma with ${manifest.chunks.length} chunk(s).`
  );
}

function parseCliArgs(args: string[]): IngestCliArgs {
  const env = getProjectEnv();
  const positional: string[] = [];
  let collectionName = env.chromaCollection;
  let batchSize = env.chromaIngestBatchSize;
  let host = env.chromaHost;
  let port = env.chromaPort;
  let ssl = env.chromaSsl;
  let database: string | undefined;
  let tenant: string | undefined;
  let resetCollection = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    if (arg === "--collection" && next) {
      collectionName = next;
      index += 1;
      continue;
    }

    if (arg === "--batch-size" && next) {
      batchSize = Number(next);
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

    if (arg === "--reset-collection") {
      resetCollection = true;
      continue;
    }

    positional.push(arg);
  }

  if (!Number.isFinite(batchSize) || batchSize <= 0) {
    throw new Error("--batch-size must be a positive number.");
  }

  if (!Number.isFinite(port) || port <= 0) {
    throw new Error("--port must be a positive number.");
  }

  return {
    inputPath: positional[0] ?? env.embeddingsPath,
    collectionName,
    batchSize,
    host,
    port,
    ssl,
    database,
    tenant,
    resetCollection
  };
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
