import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getProjectEnv } from "./env.ts";
import type { Chunk, EmbeddedChunk, EmbeddingManifest } from "./models/chunk.models.ts";
import type { EmbedCliArgs } from "./types/cli.types.ts";
import { readChunkManifest } from "./shared/manifests.ts";
import { requestEmbeddings } from "./shared/ollama.ts";
import { normalizeForJson } from "./shared/pathUtils.ts";

async function main(): Promise<void> {
  const cli = parseCliArgs(process.argv.slice(2));
  const inputPath = path.resolve(process.cwd(), cli.inputPath);
  const outputPath = path.resolve(
    process.cwd(),
    cli.outputPath ?? defaultOutputPath(inputPath)
  );

  const manifest = readChunkManifest(await readFile(inputPath, "utf8"));
  const embeddedChunks = await embedChunks(manifest.chunks, cli);

  const output: EmbeddingManifest = {
    generatedAt: new Date().toISOString(),
    sourceManifestPath: normalizeForJson(inputPath),
    sourceManifestGeneratedAt: manifest.generatedAt,
    inputPath: manifest.inputPath,
    fileCount: manifest.fileCount,
    chunkCount: manifest.chunkCount,
    embeddingCount: embeddedChunks.length,
    model: cli.model,
    baseUrl: cli.baseUrl,
    batchSize: cli.batchSize,
    dimensions: cli.dimensions,
    truncate: cli.truncate,
    files: manifest.files,
    chunks: embeddedChunks
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(output, null, 2), "utf8");

  console.log(
    `Created ${output.embeddingCount} embeddings with model ${cli.model} at ${outputPath}`
  );
}

function parseCliArgs(args: string[]): EmbedCliArgs {
  const env = getProjectEnv();
  const positional: string[] = [];
  let outputPath: string | undefined;
  let model = env.ollamaEmbedModel;
  let baseUrl = env.ollamaUrl;
  let batchSize = env.embedBatchSize;
  let truncate = true;
  let dimensions: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    if (arg === "--output" && next) {
      outputPath = next;
      index += 1;
      continue;
    }

    if (arg === "--model" && next) {
      model = next;
      index += 1;
      continue;
    }

    if (arg === "--base-url" && next) {
      baseUrl = next.replace(/\/+$/, "");
      index += 1;
      continue;
    }

    if (arg === "--batch-size" && next) {
      batchSize = Number(next);
      index += 1;
      continue;
    }

    if (arg === "--dimensions" && next) {
      dimensions = Number(next);
      index += 1;
      continue;
    }

    if (arg === "--truncate") {
      truncate = true;
      continue;
    }

    if (arg === "--no-truncate") {
      truncate = false;
      continue;
    }

    positional.push(arg);
  }

  if (!model.trim()) {
    throw new Error("--model cannot be empty.");
  }

  if (!Number.isFinite(batchSize) || batchSize <= 0) {
    throw new Error("--batch-size must be a positive number.");
  }

  if (dimensions !== undefined && (!Number.isFinite(dimensions) || dimensions <= 0)) {
    throw new Error("--dimensions must be a positive number.");
  }

  return {
    inputPath: positional[0] ?? env.chunksPath,
    outputPath: outputPath ?? env.embeddingsPath,
    model,
    baseUrl,
    batchSize,
    truncate,
    dimensions
  };
}

function defaultOutputPath(inputPath: string): string {
  const parsed = path.parse(inputPath);
  return path.join(parsed.dir, `${parsed.name}.embeddings.json`);
}

async function embedChunks(chunks: Chunk[], cli: EmbedCliArgs): Promise<EmbeddedChunk[]> {
  const embeddedChunks: EmbeddedChunk[] = [];

  for (let index = 0; index < chunks.length; index += cli.batchSize) {
    const batch = chunks.slice(index, index + cli.batchSize);
    const inputs = batch.map((chunk) => chunk.text);
    const embeddings = await requestEmbeddings(inputs, {
      baseUrl: cli.baseUrl,
      model: cli.model,
      truncate: cli.truncate,
      dimensions: cli.dimensions,
      unreachableMessage: `Could not reach Ollama at ${cli.baseUrl}. Make sure the Ollama app or server is running.`
    });

    if (embeddings.length !== batch.length) {
      throw new Error(
        `Ollama returned ${embeddings.length} embeddings for a batch of ${batch.length} chunks.`
      );
    }

    for (let batchIndex = 0; batchIndex < batch.length; batchIndex += 1) {
      embeddedChunks.push({
        ...batch[batchIndex],
        embedding: embeddings[batchIndex]
      });
    }

    console.log(
      `Embedded ${Math.min(index + batch.length, chunks.length)}/${chunks.length} chunks`
    );
  }

  return embeddedChunks;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
