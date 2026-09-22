import type { RetrievedChunk } from "./retrieval.models.ts";

export type StructuredAnswerResolverInput = {
  question: string;
  answerInstruction: string;
  chunks: RetrievedChunk[];
};

export type EntityRelation = {
  entity: string;
  label: string;
};

export type EntityBlock = {
  entityName: string;
  chunkId: string;
  source: string;
  content: string;
  relations: EntityRelation[];
};

export type RelationAnswerTemplates = {
  spanish: {
    singular: string;
    plural: string;
  };
  english: {
    singular: string;
    plural: string;
  };
};

export type StructuredRelationRule = {
  id: string;
  questionTerms: string[];
  relationTerms: string[];
  templates: RelationAnswerTemplates;
};
