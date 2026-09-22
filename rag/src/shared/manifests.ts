import { readFileSync } from "node:fs";
import path from "node:path";
import { getProjectEnv } from "../env.ts";
import type {
  ChromaMetadata,
  Chunk,
  ChunkManifest,
  EmbeddingManifest,
  QueryMetadata
} from "../models/chunk.models.ts";

let cachedChunkManifestEntries: Chunk[] | null = null;

export function readChunkManifest(rawJson: string): ChunkManifest {
  const parsed = JSON.parse(rawJson) as Partial<ChunkManifest>;

  if (!parsed || !Array.isArray(parsed.chunks) || !Array.isArray(parsed.files)) {
    throw new Error("Input file is not a valid chunk manifest.");
  }

  return {
    generatedAt: String(parsed.generatedAt ?? ""),
    inputPath: String(parsed.inputPath ?? ""),
    fileCount: Number(parsed.fileCount ?? parsed.files.length),
    chunkCount: Number(parsed.chunkCount ?? parsed.chunks.length),
    files: parsed.files.map((file) => ({
      source: String(file.source),
      sourcePath: String(file.sourcePath),
      sourceType: String(file.sourceType ?? "markdown"),
      chunkCount: Number(file.chunkCount)
    })),
    chunks: parsed.chunks.map((chunk) => ({
      id: String(chunk.id),
      source: String(chunk.source),
      sourcePath: String(chunk.sourcePath),
      sourceType: String(chunk.sourceType ?? "markdown"),
      heading: String(chunk.heading),
      level: Number(chunk.level),
      chunkIndex: Number(chunk.chunkIndex),
      totalChunks: Number(chunk.totalChunks),
      charCount: Number(chunk.charCount),
      wordCount: Number(chunk.wordCount),
      text: String(chunk.text),
      chunkKind: chunk.chunkKind === "code" ? "code" : "text",
      hasCode: Boolean(chunk.hasCode),
      codeLanguage: chunk.codeLanguage == null ? null : String(chunk.codeLanguage),
      fileOrder: Number(chunk.fileOrder ?? 0),
      sectionOrder: Number(chunk.sectionOrder ?? 0),
      previousChunkId: chunk.previousChunkId == null ? null : String(chunk.previousChunkId),
      nextChunkId: chunk.nextChunkId == null ? null : String(chunk.nextChunkId),
      nearestTextChunkId: chunk.nearestTextChunkId == null ? null : String(chunk.nearestTextChunkId),
      nearestTextDistance: chunk.nearestTextDistance == null ? null : Number(chunk.nearestTextDistance)
    }))
  };
}

export function readEmbeddingManifest(rawJson: string): EmbeddingManifest {
  const parsed = JSON.parse(rawJson) as Partial<EmbeddingManifest>;

  if (!parsed || !Array.isArray(parsed.chunks) || !Array.isArray(parsed.files)) {
    throw new Error("Input file is not a valid embedding manifest.");
  }

  return {
    generatedAt: String(parsed.generatedAt ?? ""),
    sourceManifestPath: String(parsed.sourceManifestPath ?? ""),
    sourceManifestGeneratedAt: String(parsed.sourceManifestGeneratedAt ?? ""),
    inputPath: String(parsed.inputPath ?? ""),
    fileCount: Number(parsed.fileCount ?? parsed.files.length),
    chunkCount: Number(parsed.chunkCount ?? parsed.chunks.length),
    embeddingCount: Number(parsed.embeddingCount ?? parsed.chunks.length),
    model: String(parsed.model ?? ""),
    baseUrl: String(parsed.baseUrl ?? ""),
    batchSize: Number(parsed.batchSize ?? 0),
    dimensions: parsed.dimensions === undefined ? undefined : Number(parsed.dimensions),
    truncate: Boolean(parsed.truncate),
    files: parsed.files.map((file) => ({
      source: String(file.source),
      sourcePath: String(file.sourcePath),
      sourceType: String(file.sourceType ?? "markdown"),
      chunkCount: Number(file.chunkCount)
    })),
    chunks: parsed.chunks.map((chunk) => ({
      id: String(chunk.id),
      source: String(chunk.source),
      sourcePath: String(chunk.sourcePath),
      sourceType: String(chunk.sourceType ?? "markdown"),
      heading: String(chunk.heading),
      level: Number(chunk.level),
      chunkIndex: Number(chunk.chunkIndex),
      totalChunks: Number(chunk.totalChunks),
      charCount: Number(chunk.charCount),
      wordCount: Number(chunk.wordCount),
      text: String(chunk.text),
      embedding: Array.isArray(chunk.embedding) ? chunk.embedding.map((value) => Number(value)) : [],
      chunkKind: chunk.chunkKind === "code" ? "code" : "text",
      hasCode: Boolean(chunk.hasCode),
      codeLanguage: chunk.codeLanguage == null ? null : String(chunk.codeLanguage),
      fileOrder: Number(chunk.fileOrder ?? 0),
      sectionOrder: Number(chunk.sectionOrder ?? 0),
      previousChunkId: chunk.previousChunkId == null ? null : String(chunk.previousChunkId),
      nextChunkId: chunk.nextChunkId == null ? null : String(chunk.nextChunkId),
      nearestTextChunkId: chunk.nearestTextChunkId == null ? null : String(chunk.nearestTextChunkId),
      nearestTextDistance: chunk.nearestTextDistance == null ? null : Number(chunk.nearestTextDistance)
    }))
  };
}

export function getChunkManifestEntries(): Chunk[] {
  if (cachedChunkManifestEntries) {
    return cachedChunkManifestEntries;
  }

  const env = getProjectEnv();
  const manifestPath = path.resolve(process.cwd(), env.chunksPath);

  try {
    const manifest = readChunkManifest(readFileSync(manifestPath, "utf8"));
    cachedChunkManifestEntries = manifest.chunks;
  } catch {
    cachedChunkManifestEntries = [];
  }

  return cachedChunkManifestEntries;
}

export function chunkToQueryMetadata(chunk: Chunk): QueryMetadata {
  return {
    source: chunk.source,
    source_path: chunk.sourcePath,
    source_type: chunk.sourceType,
    heading: chunk.heading,
    level: chunk.level,
    chunk_index: chunk.chunkIndex,
    total_chunks: chunk.totalChunks,
    char_count: chunk.charCount,
    word_count: chunk.wordCount,
    chunk_kind: chunk.chunkKind,
    has_code: chunk.hasCode,
    code_language: chunk.codeLanguage ?? null,
    file_order: chunk.fileOrder,
    section_order: chunk.sectionOrder,
    previous_chunk_id: chunk.previousChunkId ?? null,
    next_chunk_id: chunk.nextChunkId ?? null,
    nearest_text_chunk_id: chunk.nearestTextChunkId ?? null,
    nearest_text_distance: chunk.nearestTextDistance ?? null
  };
}

export function buildChromaMetadata(
  chunk: Chunk,
  manifest: Pick<EmbeddingManifest, "generatedAt" | "model" | "sourceManifestGeneratedAt">
): ChromaMetadata {
  return {
    source: chunk.source,
    source_path: chunk.sourcePath,
    source_type: chunk.sourceType,
    heading: chunk.heading,
    level: chunk.level,
    chunk_index: chunk.chunkIndex,
    total_chunks: chunk.totalChunks,
    char_count: chunk.charCount,
    word_count: chunk.wordCount,
    embedding_model: manifest.model,
    source_manifest_generated_at: manifest.sourceManifestGeneratedAt,
    embedding_manifest_generated_at: manifest.generatedAt,
    chunk_kind: chunk.chunkKind,
    has_code: chunk.hasCode,
    code_language: chunk.codeLanguage,
    file_order: chunk.fileOrder,
    section_order: chunk.sectionOrder,
    previous_chunk_id: chunk.previousChunkId,
    next_chunk_id: chunk.nextChunkId,
    nearest_text_chunk_id: chunk.nearestTextChunkId,
    nearest_text_distance: chunk.nearestTextDistance
  };
}
