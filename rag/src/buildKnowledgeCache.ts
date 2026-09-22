import { getProjectEnv } from "./env.ts";
import type {
  KnowledgeCache,
  KnowledgeEntity,
  KnowledgeEvent,
  KnowledgeFact,
  KnowledgeRelation
} from "./models/cache.models.ts";
import { getCurrentSourceManifest, writeKnowledgeCache } from "./shared/cache.ts";

function main(): void {
  const manifest = getCurrentSourceManifest();
  if (!manifest) {
    throw new Error(`Could not read chunk manifest at ${getProjectEnv().chunksPath}. Run split first.`);
  }

  const entitiesByName = new Map<string, KnowledgeEntity>();
  for (const chunk of manifest.chunks) {
    for (const block of splitEntityBlocks(chunk.text)) {
      const name = extractEntityName(block);
      if (!name) {
        continue;
      }

      const entity = getOrCreateEntity(entitiesByName, name);
      addUnique(entity.sourceChunkIds, chunk.id);
      for (const fact of extractFacts(block, chunk.id)) {
        addFact(entity.facts, fact);
      }
      for (const relation of extractRelations(block, chunk.id)) {
        addRelation(entity.relations, relation);
      }
    }

    for (const event of extractEvents(chunk.text, chunk.id)) {
      const entityName = inferEntityFromEventLabel(event.label);
      if (!entityName) {
        continue;
      }

      const entity = getOrCreateEntity(entitiesByName, entityName);
      addUnique(entity.sourceChunkIds, chunk.id);
      addEvent(entity.events, event);
    }
  }

  const cache: KnowledgeCache = {
    version: 1,
    generatedAt: new Date().toISOString(),
    sourceManifestGeneratedAt: manifest.generatedAt,
    sourceManifestPath: getProjectEnv().chunksPath,
    entities: [...entitiesByName.values()].sort((left, right) => left.name.localeCompare(right.name))
  };

  writeKnowledgeCache(cache);
  console.log(`Created knowledge cache with ${cache.entities.length} entities at ${getProjectEnv().knowledgeCachePath}`);
}

function getOrCreateEntity(entitiesByName: Map<string, KnowledgeEntity>, name: string): KnowledgeEntity {
  const key = normalizeEntityName(name);
  const existing = entitiesByName.get(key);
  if (existing) {
    return existing;
  }

  const entity: KnowledgeEntity = {
    name,
    aliases: [],
    sourceChunkIds: [],
    facts: [],
    relations: [],
    events: []
  };
  entitiesByName.set(key, entity);
  return entity;
}

function splitEntityBlocks(text: string): string[] {
  const markers = [...text.matchAll(/\b(?:Nombre|Name)\s*:\s*/gi)].map((match) => match.index ?? 0);
  if (markers.length === 0) {
    return [];
  }

  return markers.map((start, index) => {
    const end = markers[index + 1] ?? text.length;
    return text.slice(start, end);
  });
}

function extractEntityName(block: string): string {
  const match = block.match(/\b(?:Nombre|Name)\s*:\s*([^:\n]+?)(?:\s+(?:T[ií]tulo|Title)\s*:|\n|$)/i);
  const name = match?.[1]?.trim().replace(/\s+/g, " ") ?? "";
  return name && name !== "?" ? name : "";
}

function extractFacts(block: string, sourceChunkId: string): KnowledgeFact[] {
  const factPatterns: Array<{ type: string; pattern: RegExp }> = [
    { type: "title", pattern: /\b(?:T[ií]tulo|Title)\s*:\s*([^:\n]+?)(?=\s+(?:Caracter[ií]sticas|Description|Descripci[oó]n|Conexiones|Relations|Relaciones|Background|Estado|Status)\b|\n|$)/i },
    { type: "status", pattern: /\b(?:Estado|Status)\s*:\s*([^:\n]+?)(?=\s+(?:Descripci[oó]n|Description|Conexiones|Relations|Relaciones|Background)\b|\n|$)/i },
    { type: "location", pattern: /\b(?:Localizaci[oó]n|Location)\s*:\s*([^:\n]+?)(?=\s+(?:Descripci[oó]n|Description|Conexiones|Relations|Relaciones|Background)\b|\n|$)/i },
    { type: "class", pattern: /\b(?:Clase|Class)\s*:\s*([^:\n]+?)(?=\s+(?:Subclase|Subclass|Conexiones|Relations|Relaciones|Background)\b|\n|$)/i }
  ];

  return factPatterns
    .map(({ type, pattern }) => {
      const value = pattern.exec(block)?.[1]?.trim().replace(/\s+/g, " ") ?? "";
      return value && value !== "?" ? { type, value, sourceChunkId } : null;
    })
    .filter((fact): fact is KnowledgeFact => fact !== null);
}

function extractRelations(block: string, sourceChunkId: string): KnowledgeRelation[] {
  const relationSection = block.match(/\b(?:Relaciones|Relations)\b([\s\S]*?)(?=\b(?:Modificaciones|Background|Descripci[oó]n|Description|Conexiones|Connections|Nombre|Name)\b|$)/i)?.[1] ?? "";
  if (!relationSection.trim()) {
    return [];
  }

  const relations: KnowledgeRelation[] = [];
  const relationPattern = /([\p{Lu}][^:\n]{1,80})\s*:\s*([^:\n]+?)(?=\s+[\p{Lu}][^:\n]{1,80}\s*:|\n|$)/gu;
  for (const match of relationSection.matchAll(relationPattern)) {
    const target = match[1]?.trim().replace(/\s+/g, " ") ?? "";
    const type = match[2]?.trim().replace(/\s+/g, " ") ?? "";
    if (target && type && target !== "?" && type !== "?") {
      relations.push({ type, target, sourceChunkId });
    }
  }

  return relations;
}

function extractEvents(text: string, sourceChunkId: string): KnowledgeEvent[] {
  const events: KnowledgeEvent[] = [];
  const eventPattern = /\b(?:Nombre|Name)\s+(?:Nombre|Name)\s*:\s*([^:\n]+?)\s+(?:Descripci[oó]n|Description)\s+(?:Fecha|Date)\s*:\s*([^:\n]+?)(?=\s+(?:Nombre|Name)\s+(?:Nombre|Name)\s*:|\n|$)/giu;
  for (const match of text.matchAll(eventPattern)) {
    const label = match[1]?.trim().replace(/\s+/g, " ") ?? "";
    const date = match[2]?.trim().replace(/\s+/g, " ") ?? "";
    if (label && date) {
      events.push({ label, date, sourceChunkId });
    }
  }

  return events;
}

function inferEntityFromEventLabel(label: string): string {
  const match = label.match(/\b(?:de|of)\s+(.+)$/i);
  const inferred = match?.[1]?.trim().replace(/\s+/g, " ") ?? "";
  return inferred && inferred !== "?" ? inferred : "";
}

function addFact(facts: KnowledgeFact[], fact: KnowledgeFact): void {
  if (!facts.some((existing) => existing.type === fact.type && existing.value === fact.value && existing.sourceChunkId === fact.sourceChunkId)) {
    facts.push(fact);
  }
}

function addRelation(relations: KnowledgeRelation[], relation: KnowledgeRelation): void {
  if (!relations.some((existing) => existing.type === relation.type && existing.target === relation.target && existing.sourceChunkId === relation.sourceChunkId)) {
    relations.push(relation);
  }
}

function addEvent(events: KnowledgeEvent[], event: KnowledgeEvent): void {
  if (!events.some((existing) => existing.label === event.label && existing.date === event.date && existing.sourceChunkId === event.sourceChunkId)) {
    events.push(event);
  }
}

function addUnique(values: string[], value: string): void {
  if (!values.includes(value)) {
    values.push(value);
  }
}

function normalizeEntityName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

main();
