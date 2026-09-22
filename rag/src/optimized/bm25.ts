export interface SearchHit { id: string; score: number }
export interface Bm25 {
  version: 1;
  lengths: Record<string, number>;
  postings: Record<string, Array<[string, number]>>;
  count: number;
  averageLength: number;
}
export function terms(text: string): string[] {
  return text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}_@.-]+/gu) ?? [];
}
export function buildBm25(documents: Array<{ id: string; text: string }>): Bm25 {
  const lengths: Record<string, number> = Object.create(null);
  const postings: Bm25['postings'] = Object.create(null);
  let total = 0;
  for (const document of documents) {
    if (Object.hasOwn(lengths, document.id)) throw new Error(`Duplicate chunk: ${document.id}`);
    const tokens = terms(document.text);
    lengths[document.id] = tokens.length;
    total += tokens.length;
    const frequencies = new Map<string, number>();
    for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    for (const [token, frequency] of frequencies) (postings[token] ??= []).push([document.id, frequency]);
  }
  return { version: 1, lengths, postings, count: documents.length, averageLength: total / Math.max(1, documents.length) };
}
export function searchBm25(index: Bm25, query: string, limit = 20): SearchHit[] {
  const scores = new Map<string, number>();
  for (const token of new Set(terms(query))) {
    const posting = Object.hasOwn(index.postings, token) ? index.postings[token] : [];
    const idf = Math.log(1 + (index.count - posting.length + 0.5) / (posting.length + 0.5));
    for (const [id, tf] of posting) {
      const denominator = tf + 1.2 * (0.25 + 0.75 * index.lengths[id] / (index.averageLength || 1));
      scores.set(id, (scores.get(id) ?? 0) + idf * tf * 2.2 / denominator);
    }
  }
  return [...scores].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
}
export function fuse(lists: SearchHit[][], k = 60, limit = 20): SearchHit[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    const seen = new Set<string>();
    list.forEach(({ id }, rank) => {
      if (!seen.has(id)) scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1));
      seen.add(id);
    });
  }
  return [...scores].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
}
