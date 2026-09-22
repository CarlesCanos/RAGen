import type { Chunk, ChunkManifest } from '../models/chunk.models.ts';
export interface Case { id: string; kind: 'fact' | 'synthesis' | 'comparison' | 'absent' | 'global'; question: string; evidence: string[]; expected: string[] }
export function fixtures(size: number): { manifest: ChunkManifest; cases: Case[] } {
  const chunks: Chunk[] = [];
  const cases: Case[] = [];
  const domains = ['archivo', 'riego', 'transporte', 'laboratorio', 'energía', 'biblioteca', 'almacén', 'museo', 'comunicaciones', 'taller'];
  const add = (id: string, source: string, heading: string, text: string) => {
    chunks.push({ id, source, sourcePath: source, sourceType: 'markdown', heading, level: 2, chunkIndex: 0,
      totalChunks: 1, charCount: text.length, wordCount: text.split(/\s+/).length, text, chunkKind: 'text', hasCode: false,
      codeLanguage: null, fileOrder: chunks.length, sectionOrder: 0, previousChunkId: null, nextChunkId: null,
      nearestTextChunkId: id, nearestTextDistance: 0 });
  };
  for (let i = 0; i < 10; i++) {
    const project = `Proyecto Nébula-${i + 17}`;
    const id = `nebula-${i}-protocol`, linked = `nebula-${i}-timing`;
    const value = `CLAVE-${173 + i * 13}`;
    add(id, `nebula-${i}.md`, `${project} / ${domains[i]} / protocolo`,
      `Documento ficticio de evaluación. ${project} gestiona ${domains[i]}. Se revisan equipos y se archivan incidencias. La sala de reuniones no almacena materiales. Los registros antiguos no fijan el protocolo vigente. La clave vigente de autorización es ${value}. El procedimiento consta de la revisión inicial y la transferencia final descritas en la sección de tiempos.`);
    add(linked, `nebula-${i}.md`, `${project} / tiempos`,
      i % 2 === 0 ? `${project}: initial review takes ${i + 3} minutes; final transfer takes ${i + 5} minutes. Both stages are sequential. No parallel execution.`
        : `${project}: la revisión inicial dura ${i + 3} minutos y la transferencia final ${i + 5} minutos. Las dos etapas son consecutivas.`);
    cases.push({ id: `fact-${i}`, kind: 'fact', question: `¿Cuál es la clave vigente de autorización de ${project}?`, evidence: [id], expected: [value] });
    cases.push({ id: `synthesis-${i}`, kind: 'synthesis', question: `Relaciona la clave de autorización y el tiempo total de las dos etapas consecutivas de ${project}.`, evidence: [id, linked], expected: [value, String(2 * i + 8)] });
  }
  for (let i = 0; i < 8; i++) {
    const name = `Sistema Delta-${i + 41}`;
    const old = `delta-${i}-old`, current = `delta-${i}-current`;
    add(old, `delta-${i}-2023.md`, `${name} versión 2023`, `${name}: capacidad máxima ${100 + i} unidades. Responsable Alex del equipo norte. Esta versión dejó de estar vigente en enero de 2025.`);
    add(current, `delta-${i}-2025.md`, `${name} versión 2025`, `${name}: desde enero de 2025 la capacidad máxima es ${150 + i} unidades. Alex del equipo sur es responsable; es una persona distinta de Alex del equipo norte.`);
    cases.push({ id: `compare-${i}`, kind: 'comparison', question: `Compara las capacidades de ${name} en las versiones 2023 y 2025 e indica cuál está vigente.`, evidence: [old, current], expected: [String(100 + i), String(150 + i), '2025'] });
    cases.push({ id: `absent-${i}`, kind: 'absent', question: `¿Cuál es el presupuesto anual aprobado en euros de ${name}?`, evidence: [], expected: [] });
  }
  for (let i = 0; i < 4; i++) {
    const questions = [
      'Resume globalmente los cambios de capacidad de todos los sistemas Delta a partir de 2025.',
      '¿Qué tendencias comparten todos los sistemas Delta desde 2025? Indica las limitaciones de la evidencia.',
      'Compare capacity changes across all Delta systems in 2025. Answer in English and state the scope of your evidence.',
      '¿Permiten los documentos recuperados asegurar que todos los sistemas Delta aumentaron su capacidad en 2025? Distingue la muestra de una revisión exhaustiva.',
    ];
    cases.push({ id: `global-${i}`, kind: 'global', question: questions[i], evidence: ['delta-0-old', 'delta-0-current'], expected: ['2025'] });
  }
  if (size < chunks.length) throw new Error(`Corpus requires at least ${chunks.length} chunks`);
  for (let i = chunks.length; i < size; i++) {
    const project = `Sector ${i % 37}-${Math.floor(i / 37)}`;
    const domain = domains[i % domains.length];
    const texts = [
      `${project}: inventario de ${domain}. El lote ${i * 19} contiene ${i % 83 + 9} unidades. La revisión del ${i % 28 + 1} de mayo registró embalajes de color ${['azul', 'verde', 'ocre'][i % 3]}.`,
      `${project} / ${domain}: los registros de autorización históricos se conservan ${i % 17 + 2} meses. Esta nota no establece claves vigentes de otros proyectos ni presupuestos anuales.`,
      `${project}: maintenance of ${domain} equipment uses sequence ${i % 53}. Transfer and inspection schedules depend on batch ${i * 7}. This record applies only to this sector.`,
      `${project}: versión ${2010 + i % 14}, capacidad ${i % 91 + 20} cajas. El responsable Alex coordina ${domain} en esta ubicación exclusivamente.`,
      `${project}: la temperatura de ensayo fue ${i % 30 + 5} grados. Se observaron ${i % 11} interrupciones. El acta ${i * 23} describe una medida experimental, no un límite operativo.`,
    ];
    add(`distractor-${i}`, `sector-${i}.md`, `${domain} / ${project}`, texts[i % texts.length]);
  }
  const counts = new Map<string, number>();
  for (const chunk of chunks) counts.set(chunk.source, (counts.get(chunk.source) ?? 0) + 1);
  const files = [...counts].map(([source, chunkCount]) => ({ source, sourcePath: source, sourceType: 'markdown', chunkCount }));
  return { manifest: { generatedAt: '2026-01-01T00:00:00.000Z', inputPath: 'synthetic-fixtures', fileCount: files.length, chunkCount: chunks.length, files, chunks }, cases };
}
