import { readFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { getProjectEnv } from "../env.ts";
import type { LoadedDocument } from "../models/document.models.ts";

const execFileAsync = promisify(execFile);

type PdfTextItem = {
  str?: string;
  hasEOL?: boolean;
};

export async function loadDocument(filePath: string): Promise<LoadedDocument> {
  const extension = path.extname(filePath).toLowerCase();

  if (isMarkdownExtension(extension)) {
    const rawText = await readFile(filePath, "utf8");
    return {
      format: "markdown",
      text: preprocessMarkdown(rawText)
    };
  }

  if (extension === ".txt") {
    const rawText = await readFile(filePath, "utf8");
    return {
      format: "text",
      text: normalizePlainText(rawText)
    };
  }

  if (extension === ".html" || extension === ".htm") {
    const rawText = await readFile(filePath, "utf8");
    return {
      format: "html",
      text: preprocessHtml(rawText)
    };
  }

  if (extension === ".pdf") {
    return {
      format: "pdf",
      text: await extractPdfText(filePath)
    };
  }

  const rawText = await readFile(filePath, "utf8");
  return {
    format: "text",
    text: normalizePlainText(rawText)
  };
}

function isMarkdownExtension(extension: string): boolean {
  return [".md", ".mdx", ".markdown"].includes(extension);
}

function preprocessMarkdown(markdown: string): string {
  return stripFrontmatter(markdown.replace(/\r\n/g, "\n").trim()).trim();
}

function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith("---\n")) {
    return markdown;
  }

  const endIndex = markdown.indexOf("\n---\n", 4);
  if (endIndex === -1) {
    return markdown;
  }

  return markdown.slice(endIndex + 5);
}

function normalizePlainText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\t/g, "  ")
    .trim();
}

function preprocessHtml(html: string): string {
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");
  const withBlockBreaks = withoutScripts
    .replace(/<\/(p|div|section|article|main|aside|header|footer|nav|li|ul|ol|table|tr|td|th|h[1-6]|pre|code)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n");
  const withoutTags = withBlockBreaks.replace(/<[^>]+>/g, " ");
  const decoded = decodeHtmlEntities(withoutTags);

  return decoded
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'");
}

async function extractPdfText(filePath: string): Promise<string> {
  try {
    return await extractPdfTextWithPdfJs(filePath);
  } catch (pdfJsError: unknown) {
    try {
      return await extractPdfTextWithPdftotext(filePath);
    } catch (pdftotextError: unknown) {
      const pdfJsMessage = pdfJsError instanceof Error ? pdfJsError.message : String(pdfJsError);
      const pdftotextMessage = pdftotextError instanceof Error ? pdftotextError.message : String(pdftotextError);

      throw new Error(
        `Could not extract text from PDF "${path.basename(filePath)}". ` +
        `PDF.js error: ${pdfJsMessage}. pdftotext fallback error: ${pdftotextMessage}`
      );
    }
  }
}

async function extractPdfTextWithPdfJs(filePath: string): Promise<string> {
  const fileBuffer = await readFile(filePath);
  const pdfOptions = {
    data: new Uint8Array(fileBuffer),
    disableFontFace: true,
    enableScripting: false,
    isEvalSupported: false,
    useSystemFonts: true
  };
  const loadingTask = getDocument(pdfOptions);

  const pdf = await loadingTask.promise;
  const pages: string[] = [];

  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const textItems = textContent.items as PdfTextItem[];
      const pageText = textItems
        .map((item) => {
          const text = item.str ?? "";
          return item.hasEOL ? `${text}\n` : text;
        })
        .join(" ")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n[ \t]+/g, "\n")
        .trim();

      if (pageText) {
        pages.push(pageText);
      }
    }
  } finally {
    await loadingTask.destroy();
  }

  const normalized = normalizePlainText(pages.join("\n\n"));
  if (!normalized) {
    throw new Error("PDF.js returned no text.");
  }

  return normalized;
}

async function extractPdfTextWithPdftotext(filePath: string): Promise<string> {
  const pdfToTextBin = getProjectEnv().pdfToTextBin;

  try {
    const { stdout } = await execFileAsync(pdfToTextBin, [filePath, "-"], {
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024
    });

    const normalized = normalizePlainText(stdout);
    if (!normalized) {
      throw new Error("The PDF extractor returned no text.");
    }

    return normalized;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Install a local pdftotext-compatible binary or configure PDF_TO_TEXT_BIN. Original error: ${message}`
    );
  }
}
