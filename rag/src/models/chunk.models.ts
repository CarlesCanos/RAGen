export type ChunkKind = "text" | "code";

export type ChunkFile = {
  source: string;
  sourcePath: string;
  sourceType: string;
  chunkCount: number;
};

export type Chunk = {
  id: string;
  source: string;
  sourcePath: string;
  sourceType: string;
  heading: string;
  sectionPath?: string[];
  level: number;
  chunkIndex: number;
  totalChunks: number;
  charCount: number;
  wordCount: number;
  text: string;
  chunkKind: ChunkKind;
  hasCode: boolean;
  codeLanguage: string | null;
  fileOrder: number;
  sectionOrder: number;
  previousChunkId: string | null;
  nextChunkId: string | null;
  nearestTextChunkId: string | null;
  nearestTextDistance: number | null;
};

export type ChunkManifest = {
  generatedAt: string;
  inputPath: string;
  fileCount: number;
  chunkCount: number;
  files: ChunkFile[];
  chunks: Chunk[];
};

export type EmbeddedChunk = Chunk & {
  embedding: number[];
};

export type EmbeddingManifest = {
  generatedAt: string;
  sourceManifestPath: string;
  sourceManifestGeneratedAt: string;
  inputPath: string;
  fileCount: number;
  chunkCount: number;
  embeddingCount: number;
  model: string;
  baseUrl: string;
  batchSize: number;
  dimensions?: number;
  truncate: boolean;
  files: ChunkFile[];
  chunks: EmbeddedChunk[];
};

export type QueryMetadata = {
  source?: string;
  source_path?: string;
  source_type?: string;
  heading?: string;
  level?: number;
  chunk_index?: number;
  total_chunks?: number;
  char_count?: number;
  word_count?: number;
  embedding_model?: string;
  source_manifest_generated_at?: string;
  embedding_manifest_generated_at?: string;
  chunk_kind?: string;
  has_code?: boolean;
  code_language?: string | null;
  file_order?: number;
  section_order?: number;
  previous_chunk_id?: string | null;
  next_chunk_id?: string | null;
  nearest_text_chunk_id?: string | null;
  nearest_text_distance?: number | null;
};

export type ChromaMetadata = Required<
  Pick<
    QueryMetadata,
    | "source"
    | "source_path"
    | "source_type"
    | "heading"
    | "level"
    | "chunk_index"
    | "total_chunks"
    | "char_count"
    | "word_count"
    | "embedding_model"
    | "source_manifest_generated_at"
    | "embedding_manifest_generated_at"
    | "chunk_kind"
    | "has_code"
    | "code_language"
    | "file_order"
    | "section_order"
    | "previous_chunk_id"
    | "next_chunk_id"
    | "nearest_text_chunk_id"
    | "nearest_text_distance"
  >
>;
