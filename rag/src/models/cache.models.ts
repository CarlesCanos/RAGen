export type KnowledgeFact = {
  type: string;
  value: string;
  sourceChunkId: string;
};

export type KnowledgeRelation = {
  type: string;
  target: string;
  sourceChunkId: string;
};

export type KnowledgeEvent = {
  label: string;
  date: string;
  sourceChunkId: string;
};

export type KnowledgeEntity = {
  name: string;
  aliases: string[];
  sourceChunkIds: string[];
  facts: KnowledgeFact[];
  relations: KnowledgeRelation[];
  events: KnowledgeEvent[];
};

export type KnowledgeCache = {
  version: number;
  generatedAt: string;
  sourceManifestGeneratedAt: string;
  sourceManifestPath: string;
  entities: KnowledgeEntity[];
};

export type QueryCacheEntry = {
  key: string;
  normalizedQuestion: string;
  answerInstruction: string;
  targetLanguage: string;
  chatModel?: string;
  answer: string;
  sourceChunkIds: string[];
  createdAt: string;
};

export type QueryCache = {
  version: number;
  generatedAt: string;
  sourceManifestGeneratedAt: string;
  entries: QueryCacheEntry[];
};
