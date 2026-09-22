import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { getProjectEnv } from "./env.ts";
import type { Chunk, ChunkManifest } from "./models/chunk.models.ts";
import type { LoadedDocument } from "./models/document.models.ts";
import type { SplitCliArgs, SplitOptions } from "./types/cli.types.ts";
import type { Block, Section } from "./types/splitter.types.ts";
import { loadDocument } from "./shared/documentLoader.ts";
import { normalizeForJson } from "./shared/pathUtils.ts";

const ATX_HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const CODE_FENCE = /^```([a-zA-Z0-9_-]+)?\s*$/;

async function main(): Promise<void> {
  const cli = parseCliArgs(process.argv.slice(2));
  const resolvedInput = path.resolve(process.cwd(), cli.inputPath);
  const inputStats = await stat(resolvedInput);
  const sourceFiles = inputStats.isDirectory()
    ? await collectSourceFiles(resolvedInput)
    : [resolvedInput];

  if (sourceFiles.length === 0) {
    throw new Error(`No supported documentation files found at ${resolvedInput}`);
  }

  const manifest = await buildManifest(resolvedInput, sourceFiles, cli.options);
  const outputPath = path.resolve(
    process.cwd(),
    cli.outputPath ?? defaultOutputPath(resolvedInput, inputStats.isDirectory())
  );

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(manifest, null, 2), "utf8");

  console.log(
    `Created ${manifest.chunkCount} semantic chunks from ${manifest.fileCount} file(s) at ${outputPath}`
  );
}

function parseCliArgs(args: string[]): SplitCliArgs {
  const env = getProjectEnv();
  const positional: string[] = [];
  const options: SplitOptions = {
    targetChars: env.splitTargetChars,
    maxChars: env.splitMaxChars,
    overlapChars: env.splitOverlapChars
  };
  let outputPath: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    if (arg === "--output" && next) {
      outputPath = next;
      index += 1;
      continue;
    }

    if (arg === "--target-chars" && next) {
      options.targetChars = Number(next);
      index += 1;
      continue;
    }

    if (arg === "--max-chars" && next) {
      options.maxChars = Number(next);
      index += 1;
      continue;
    }

    if (arg === "--overlap-chars" && next) {
      options.overlapChars = Number(next);
      index += 1;
      continue;
    }

    positional.push(arg);
  }

  if (
    !Number.isFinite(options.targetChars) ||
    !Number.isFinite(options.maxChars) ||
    !Number.isFinite(options.overlapChars)
  ) {
    throw new Error("Chunk size arguments must be numeric.");
  }

  if (options.targetChars <= 0 || options.maxChars <= 0 || options.overlapChars < 0) {
    throw new Error("Chunk size arguments must be positive, and overlap cannot be negative.");
  }

  if (options.targetChars > options.maxChars) {
    throw new Error("--target-chars cannot be greater than --max-chars.");
  }

  return {
    inputPath: positional[0] ?? env.docsDir,
    outputPath: outputPath ?? env.chunksPath,
    options
  };
}

function defaultOutputPath(inputPath: string, isDirectory: boolean): string {
  if (isDirectory) {
    return path.join("output", "chunks.json");
  }

  const parsed = path.parse(inputPath);
  return path.join("output", `${parsed.name}.chunks.json`);
}

async function collectSourceFiles(rootPath: string): Promise<string[]> {
  const docsExtensions = new Set(getProjectEnv().docsExtensions.map((extension) => extension.toLowerCase()));
  const entries = await readdir(rootPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "output" || entry.name.startsWith(".")) {
      continue;
    }

    const fullPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectSourceFiles(fullPath)));
      continue;
    }

    if (entry.isFile() && docsExtensions.has(path.extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}

async function buildManifest(
  rootInputPath: string,
  sourceFiles: string[],
  options: SplitOptions
): Promise<ChunkManifest> {
  const chunks: Chunk[] = [];
  const files: ChunkManifest["files"] = [];

  for (const filePath of sourceFiles) {
    const document = await loadDocument(filePath);
    const sections = extractSectionsFromDocument(document, filePath);
    const sourcePath = normalizeForJson(path.relative(rootInputPath, filePath) || path.basename(filePath));
    const fileChunks = sectionsToChunks(
      path.basename(filePath),
      sourcePath,
      document.format,
      sections,
      options
    );

    files.push({
      source: path.basename(filePath),
      sourcePath,
      sourceType: document.format,
      chunkCount: fileChunks.length
    });

    chunks.push(...fileChunks);
  }

  return {
    generatedAt: new Date().toISOString(),
    inputPath: normalizeForJson(rootInputPath),
    fileCount: files.length,
    chunkCount: chunks.length,
    files,
    chunks
  };
}

function extractSectionsFromDocument(document: LoadedDocument, filePath: string): Section[] {
  if (document.format === "markdown") {
    return extractMarkdownSections(document.text);
  }

  return extractPlainSections(document.text, path.parse(filePath).name);
}

function extractMarkdownSections(markdown: string): Section[] {
  const lines = markdown.split("\n");
  const sections: Section[] = [];
  let hierarchy: Array<{ level: number; heading: string }> = [];
  const sectionPath = (level: number, heading: string): string[] => {
    hierarchy = hierarchy.filter(item => item.level < level);
    hierarchy.push({ level, heading });
    return hierarchy.map(item => item.heading);
  };
  let current: Section = {
    heading: "Introduction",
    level: 1,
    blocks: []
  };

  const pushCurrent = (): void => {
    const blocks = normalizeBlocks(current.blocks);
    if (blocks.length === 0) {
      return;
    }

    sections.push({
      heading: current.heading,
      level: current.level,
      sectionPath: current.sectionPath ?? [current.heading],
      blocks
    });
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trimEnd();
    const trimmed = line.trim();
    const nextLine = lines[index + 1]?.trim() ?? "";

    const atxMatch = trimmed.match(ATX_HEADING);
    if (atxMatch) {
      pushCurrent();
      current = {
        heading: atxMatch[2].trim(),
        level: atxMatch[1].length,
        sectionPath: sectionPath(atxMatch[1].length, atxMatch[2].trim()),
        blocks: []
      };
      continue;
    }

    if (trimmed && /^[-=]{3,}$/.test(nextLine)) {
      pushCurrent();
      current = {
        heading: trimmed,
        level: nextLine.startsWith("=") ? 1 : 2,
        sectionPath: sectionPath(nextLine.startsWith("=") ? 1 : 2, trimmed),
        blocks: []
      };
      index += 1;
      continue;
    }

    current.blocks.push(...parseLineAsBlocks(lines, index));
    if (CODE_FENCE.test(trimmed)) {
      const endIndex = consumeCodeFence(lines, index);
      index = endIndex;
    }
  }

  pushCurrent();
  return sections;
}

function extractPlainSections(text: string, fileName: string): Section[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return [];
  }

  return [{
    heading: humanizeFileName(fileName),
    level: 1,
    blocks: normalizeBlocks([{ kind: "text", text: normalized }])
  }];
}

function parseLineAsBlocks(lines: string[], index: number): Block[] {
  const trimmed = lines[index].trimEnd();
  const fenceMatch = trimmed.trim().match(CODE_FENCE);
  if (!fenceMatch) {
    return [{ kind: "text", text: trimmed }];
  }

  const language = fenceMatch[1]?.trim() || null;
  const codeLines: string[] = [];
  let cursor = index + 1;

  while (cursor < lines.length && !CODE_FENCE.test(lines[cursor].trim())) {
    codeLines.push(lines[cursor].replace(/\r$/, ""));
    cursor += 1;
  }

  return [{
    kind: "code",
    language,
    text: codeLines.join("\n").trimEnd()
  }];
}

function consumeCodeFence(lines: string[], startIndex: number): number {
  let cursor = startIndex + 1;
  while (cursor < lines.length && !CODE_FENCE.test(lines[cursor].trim())) {
    cursor += 1;
  }

  return Math.min(cursor, lines.length - 1);
}

function normalizeBlocks(blocks: Block[]): Block[] {
  const normalized: Block[] = [];
  const textBuffer: string[] = [];

  const flushText = (): void => {
    const paragraphs = splitIntoParagraphs(textBuffer.join("\n").trim());
    for (const paragraph of paragraphs) {
      const cleanedParagraph = cleanTextNoise(paragraph);
      if (cleanedParagraph) {
        normalized.push({ kind: "text", text: cleanedParagraph });
      }
    }
    textBuffer.length = 0;
  };

  for (const block of blocks) {
    if (block.kind === "code") {
      flushText();
      if (block.text.trim()) {
        normalized.push(block);
      }
      continue;
    }

    textBuffer.push(block.text);
  }

  flushText();
  return normalized;
}

function cleanTextNoise(text: string): string {
  return text
    .replace(/\uFFFD/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/[-_=*~]{3,}\s*([\p{L}][\p{L}0-9 "'()/:,.]{1,80}?)\s*[-_=*~]{3,}/gu, "\n$1\n")
    .replace(/^[ \t]*[-_=*~]{3,}[ \t]*$/gm, " ")
    .replace(/[-_=*~]{6,}/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitIntoParagraphs(content: string): string[] {
  if (!content) {
    return [];
  }

  return content
    .split(/\n\s*\n/g)
    .map((paragraph) => paragraph.replace(/\n+/g, " ").trim())
    .filter(Boolean);
}

function humanizeFileName(fileName: string): string {
  return fileName
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase()) || "Document";
}

function sectionsToChunks(
  source: string,
  sourcePath: string,
  sourceType: string,
  sections: Section[],
  options: SplitOptions
): Chunk[] {
  const chunks: Chunk[] = [];
  let fileOrder = 0;

  for (const [sectionIndex, section] of sections.entries()) {
    const sectionChunks: Chunk[] = [];
    const codeBlocks = section.blocks.filter((block): block is Extract<Block, { kind: "code" }> => block.kind === "code");
    const textBlocks = section.blocks.filter((block): block is Extract<Block, { kind: "text" }> => block.kind === "text");

    if (textBlocks.length > 0) {
      const units = textBlocks.flatMap((paragraph) =>
        splitOversizedParagraph(paragraph.text, options.maxChars)
      );

      const textChunks = packUnitsIntoChunks(units, options).map((text, chunkIndex, all) => ({
        id: buildChunkId(sourcePath, section.heading, sectionIndex, chunkIndex, "text"),
        source,
        sourcePath,
        sourceType,
        heading: section.heading,
        level: section.level,
        chunkIndex,
        totalChunks: all.length + codeBlocks.length,
        charCount: text.length,
        wordCount: countWords(text),
        text,
        chunkKind: "text" as const,
        hasCode: false,
        codeLanguage: null,
        fileOrder: fileOrder + sectionChunks.length,
        sectionOrder: sectionChunks.length,
        previousChunkId: null,
        nextChunkId: null,
        nearestTextChunkId: null,
        nearestTextDistance: null
      }));

      sectionChunks.push(...textChunks);
    }

    for (let codeIndex = 0; codeIndex < codeBlocks.length; codeIndex += 1) {
      const codeBlock = codeBlocks[codeIndex];
      const text = buildCodeChunkText(section.heading, codeBlock.text, codeBlock.language);
      sectionChunks.push({
        id: buildChunkId(sourcePath, section.heading, sectionIndex, codeIndex, "code"),
        source,
        sourcePath,
        sourceType,
        heading: section.heading,
        level: section.level,
        chunkIndex: codeIndex,
        totalChunks: codeBlocks.length,
        charCount: text.length,
        wordCount: countWords(text),
        text,
        chunkKind: "code",
        hasCode: true,
        codeLanguage: codeBlock.language,
        fileOrder: fileOrder + sectionChunks.length,
        sectionOrder: sectionChunks.length,
        previousChunkId: null,
        nextChunkId: null,
        nearestTextChunkId: null,
        nearestTextDistance: null
      });
    }

    annotateSectionChunkLinks(sectionChunks);
    for (const chunk of sectionChunks) chunk.sectionPath = section.sectionPath ?? [section.heading];
    chunks.push(...sectionChunks);
    fileOrder += sectionChunks.length;
  }

  annotateFileChunkLinks(chunks);
  return chunks;
}

function annotateSectionChunkLinks(sectionChunks: Chunk[]): void {
  const textChunks = sectionChunks.filter((chunk) => chunk.chunkKind === "text");

  for (let index = 0; index < sectionChunks.length; index += 1) {
    const chunk = sectionChunks[index];
    chunk.sectionOrder = index;

    if (chunk.chunkKind === "text") {
      chunk.nearestTextChunkId = chunk.id;
      chunk.nearestTextDistance = 0;
      continue;
    }

    const nearest = findNearestTextChunk(sectionChunks, textChunks, index);
    chunk.nearestTextChunkId = nearest?.id ?? null;
    chunk.nearestTextDistance = nearest ? Math.abs(nearest.sectionOrder - index) : null;
  }
}

function annotateFileChunkLinks(chunks: Chunk[]): void {
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    chunk.fileOrder = index;
    chunk.previousChunkId = chunks[index - 1]?.id ?? null;
    chunk.nextChunkId = chunks[index + 1]?.id ?? null;

    if (chunk.chunkKind === "text") {
      chunk.nearestTextChunkId = chunk.id;
      chunk.nearestTextDistance = 0;
      continue;
    }

    if (!chunk.nearestTextChunkId) {
      const textChunks = chunks.filter((candidate) => candidate.chunkKind === "text");
      const nearest = findNearestTextChunk(chunks, textChunks, index);
      chunk.nearestTextChunkId = nearest?.id ?? null;
      chunk.nearestTextDistance = nearest ? Math.abs(nearest.fileOrder - index) : null;
    }
  }
}

function findNearestTextChunk(chunks: Chunk[], textChunks: Chunk[], index: number): Chunk | null {
  if (textChunks.length === 0) {
    return null;
  }

  const current = chunks[index];
  let best: Chunk | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const candidate of textChunks) {
    const currentOrder = current.fileOrder ?? current.sectionOrder;
    const candidateOrder = candidate.fileOrder ?? candidate.sectionOrder;
    const distance = Math.abs(candidateOrder - currentOrder);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }

  return best;
}

function buildCodeChunkText(heading: string, code: string, language: string | null): string {
  const fence = language ? `\`\`\`${language}` : "```";
  return [
    `Example from section: ${heading}`,
    "",
    fence,
    code,
    "```"
  ].join("\n");
}

function splitOversizedParagraph(paragraph: string, maxChars: number): string[] {
  if (paragraph.length <= maxChars) {
    return [paragraph];
  }

  const sentences = splitIntoSentences(paragraph);
  if (sentences.length <= 1) {
    return splitByWords(paragraph, maxChars);
  }

  const parts: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    const candidate = current ? `${current} ${sentence}` : sentence;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }

    if (current) {
      parts.push(current);
    }

    if (sentence.length <= maxChars) {
      current = sentence;
      continue;
    }

    const splitSentence = splitByWords(sentence, maxChars);
    parts.push(...splitSentence.slice(0, -1));
    current = splitSentence.at(-1) ?? "";
  }

  if (current) {
    parts.push(current);
  }

  return parts;
}

function splitIntoSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?]["']?)\s+(?=[A-Z0-9"'(\[])/g)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function splitByWords(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const parts: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }

    if (current) {
      parts.push(current);
    }

    current = word;
  }

  if (current) {
    parts.push(current);
  }

  return parts;
}

function packUnitsIntoChunks(units: string[], options: SplitOptions): string[] {
  const chunks: string[] = [];
  let currentUnits: string[] = [];
  let currentLength = 0;

  for (const unit of units) {
    const separatorLength = currentUnits.length === 0 ? 0 : 2;
    const nextLength = currentLength + separatorLength + unit.length;

    if (currentUnits.length > 0 && nextLength > options.targetChars) {
      chunks.push(currentUnits.join("\n\n"));
      currentUnits = buildOverlapUnits(currentUnits, options.overlapChars);
      currentLength = currentUnits.join("\n\n").length;
    }

    const adjustedLength = currentUnits.length === 0 ? unit.length : currentLength + 2 + unit.length;
    if (currentUnits.length > 0 && adjustedLength > options.maxChars) {
      chunks.push(currentUnits.join("\n\n"));
      currentUnits = [];
      currentLength = 0;
    }

    currentUnits.push(unit);
    currentLength = currentUnits.join("\n\n").length;
  }

  if (currentUnits.length > 0) {
    chunks.push(currentUnits.join("\n\n"));
  }

  return chunks.filter(Boolean);
}

function buildOverlapUnits(units: string[], overlapChars: number): string[] {
  if (overlapChars === 0 || units.length === 0) {
    return [];
  }

  const overlap: string[] = [];
  let total = 0;

  for (let index = units.length - 1; index >= 0; index -= 1) {
    const unit = units[index];
    total += (overlap.length === 0 ? 0 : 2) + unit.length;
    overlap.unshift(unit);

    if (total >= overlapChars) {
      break;
    }
  }

  return overlap;
}

function buildChunkId(
  sourcePath: string,
  heading: string,
  sectionIndex: number,
  chunkIndex: number,
  kind: "text" | "code"
): string {
  const sourcePart = sourcePath
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9/]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/^-+|-+$/g, "");

  const headingPart = heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return `${sourcePart}:${sectionIndex + 1}-${headingPart || "section"}:${kind}:${chunkIndex + 1}`;
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
