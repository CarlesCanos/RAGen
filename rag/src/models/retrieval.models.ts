import type { QueryMetadata } from "./chunk.models.ts";

export type RetrievedChunk = {
  id: string;
  document: string;
  metadata: QueryMetadata | null;
  distance: number | null;
  searchQuery: string;
  lexicalScore?: number;
};

export type SearchAttempt = {
  query: string;
  reason: string;
  chunks: RetrievedChunk[];
};

export type RetrievalRewriteDecision = {
  retry: boolean;
  reason: string;
  query: string;
};

export type SearchPlanOption = {
  query: string;
  reason: string;
};

export type SearchPlanDecision = {
  options: SearchPlanOption[];
};

export type ValidationDecision = {
  valid: boolean;
  corrected_answer: string;
  reason: string;
};

export type SupportChunkSelectionDecision = {
  selected_chunk_ids: string[];
  reason: string;
};
