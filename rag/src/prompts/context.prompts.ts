import type { RetrievedChunk } from "../models/retrieval.models.ts";
import { extractRequiredTerms } from "../rag/text.ts";

export function buildRetrievedContext(
  retrievalQuestion: string,
  chunks: RetrievedChunk[],
  includeDistance: boolean
): string {
  if (chunks.length === 0) {
    return includeDistance ? "No relevant context was retrieved." : "No retrieved context.";
  }

  return chunks
    .map((chunk, index) => {
      const heading = chunk.metadata?.heading ? `Heading: ${chunk.metadata.heading}` : "Heading: (none)";
      const source = chunk.metadata?.source_path ?? chunk.metadata?.source ?? "unknown";
      const codeInfo = chunk.metadata?.has_code
        ? `Code: yes${chunk.metadata.code_language ? ` (${chunk.metadata.code_language})` : ""}`
        : "Code: no";
      const distance = chunk.distance === null ? "n/a" : chunk.distance.toFixed(6);
      const lines = [
        `Source ${index + 1}`,
        `Chunk ID: ${chunk.id}`
      ];

      if (includeDistance) {
        lines.push(`File: ${source}`, heading, codeInfo, `Distance: ${distance}`);
      } else {
        lines.push(heading);
      }

      lines.push("Content:", focusDocumentForQuestion(retrievalQuestion, chunk.document));
      return lines.join("\n");
    })
    .join("\n\n---\n\n");
}

function focusDocumentForQuestion(retrievalQuestion: string, document: string): string {
  const focusTerms = extractRequiredTerms(retrievalQuestion).filter((term) => term.length >= 4);
  if (focusTerms.length === 0 || document.length <= 1400) {
    return document;
  }

  const lowerDocument = document.toLowerCase();
  const matchingTerm = focusTerms.find((term) => lowerDocument.includes(term.toLowerCase()));
  if (!matchingTerm) {
    return document;
  }

  const matchIndex = lowerDocument.indexOf(matchingTerm.toLowerCase());
  const start = Math.max(0, matchIndex - 220);
  const end = Math.min(document.length, matchIndex + 1200);
  const prefix = start > 0 ? "[Excerpt starts near the requested entity]\n" : "";
  const suffix = end < document.length ? "\n[Excerpt ends]" : "";

  return `${prefix}${document.slice(start, end).trim()}${suffix}`;
}
