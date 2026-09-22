import type { EntityBlock, EntityRelation } from "../../models/logic.models.ts";
import type { RetrievedChunk } from "../../models/retrieval.models.ts";
import { canonicalizeToken } from "../text.ts";

const RELATION_SECTION_LABELS = ["relationships", "relaciones"];
const SECTION_BOUNDARY_LABELS = [
  "name",
  "nombre",
  "background",
  "pasado",
  "actualidad",
  "description",
  "descripcion",
  "descripciÃ³n",
  "connections",
  "conexiones",
  "modifications",
  "modificaciones",
  "physical characteristics",
  "caracteristicas fisicas",
  "caracterÃ­sticas fÃ­sicas"
];

export function extractEntityBlocks(chunks: RetrievedChunk[]): EntityBlock[] {
  const blocks: EntityBlock[] = [];

  for (const chunk of chunks) {
    if (chunk.metadata?.has_code) {
      continue;
    }

    blocks.push(...extractEntityBlocksFromChunk(chunk));
  }

  return blocks;
}

function extractEntityBlocksFromChunk(chunk: RetrievedChunk): EntityBlock[] {
  const compactText = compactWhitespace(chunk.document);
  const entitySpans = findEntitySpans(compactText);
  const blocks: EntityBlock[] = [];

  for (const span of entitySpans) {
    const blockText = compactText.slice(span.start, span.end).trim();
    const entityName = extractEntityName(blockText);
    if (!entityName) {
      continue;
    }

    const relations = extractRelations(blockText);
    blocks.push({
      entityName,
      chunkId: chunk.id,
      source: chunk.metadata?.source_path ?? chunk.metadata?.source ?? "",
      content: blockText,
      relations
    });
  }

  return blocks;
}

function findEntitySpans(text: string): Array<{ start: number; end: number }> {
  const matches = [...text.matchAll(/\b(?:Nombre|Name):\s*/gu)];
  if (matches.length === 0) {
    return [];
  }

  return matches.map((match, index) => ({
    start: match.index ?? 0,
    end: index + 1 < matches.length ? (matches[index + 1].index ?? text.length) : text.length
  }));
}

function extractEntityName(blockText: string): string {
  const labelMatch = blockText.match(/\b(?:Nombre|Name):\s*/u);
  if (!labelMatch || labelMatch.index == null) {
    return "";
  }

  const afterLabel = blockText.slice(labelMatch.index + labelMatch[0].length);
  const boundary = findFirstBoundaryIndex(afterLabel, SECTION_BOUNDARY_LABELS);
  const rawName = (boundary === -1 ? afterLabel : afterLabel.slice(0, boundary)).trim();
  return cleanEntityName(rawName);
}

function extractRelations(blockText: string): EntityRelation[] {
  const relationStart = findFirstBoundaryIndex(blockText, RELATION_SECTION_LABELS);
  if (relationStart === -1) {
    return [];
  }

  const sectionStartLabel = findMatchedLabel(blockText.slice(relationStart), RELATION_SECTION_LABELS);
  if (!sectionStartLabel) {
    return [];
  }

  const afterSectionLabel = blockText
    .slice(relationStart + sectionStartLabel.length)
    .trim();
  const boundary = findFirstBoundaryIndex(afterSectionLabel, SECTION_BOUNDARY_LABELS.filter((label) =>
    !RELATION_SECTION_LABELS.includes(label)
  ));
  const relationText = (boundary === -1 ? afterSectionLabel : afterSectionLabel.slice(0, boundary)).trim();
  if (!relationText) {
    return [];
  }

  const relations: EntityRelation[] = [];
  const entryPattern = /([^\s:][^:]{0,80}?):\s*([^:]{1,40}?)(?=\s+[^\s:][^:]{0,80}:\s|$)/gu;

  for (const match of relationText.matchAll(entryPattern)) {
    const entity = cleanEntityName(match[1] ?? "");
    const label = cleanRelationLabel(match[2] ?? "");
    if (!entity || !label) {
      continue;
    }

    relations.push({ entity, label });
  }

  return relations;
}

function cleanEntityName(value: string): string {
  return value
    .replace(/\b(?:Titulo|TÃ­tulo|Title):.*$/u, "")
    .replace(/\b(?:Caracteristicas|CaracterÃ­sticas|Description|Descripcion|DescripciÃ³n|Conexiones|Connections|Relaciones|Relationships|Background|Pasado|Actualidad)\b.*$/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanRelationLabel(value: string): string {
  return value
    .replace(/\b(?:Nombre|Name|Background|Pasado|Actualidad|Descripcion|DescripciÃ³n|Description|Conexiones|Connections)\b.*$/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

function findFirstBoundaryIndex(text: string, labels: string[]): number {
  const lowered = canonicalizeForLookup(text);
  const indexes = labels
    .map((label) => lowered.indexOf(canonicalizeForLookup(label)))
    .filter((index) => index >= 0);

  return indexes.length === 0 ? -1 : Math.min(...indexes);
}

function findMatchedLabel(text: string, labels: string[]): string {
  const lowered = canonicalizeForLookup(text);
  const match = labels.find((label) => lowered.startsWith(canonicalizeForLookup(label)));
  return match ?? "";
}

function canonicalizeForLookup(value: string): string {
  return canonicalizeToken(value).replace(/\s+/g, " ").trim();
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
