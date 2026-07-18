/**
 * Document ingestion for extractor-docs (docs/03 §4.2): PDF, Markdown/text
 * and docx are parsed OUTSIDE the agent into a common DocumentSection shape.
 * Locators keep doc_id + section (and page for PDFs), so every evidence can
 * point back to the exact place in the source document.
 */

import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';

import { slugify } from '@untacit/core';

export interface DocumentSection {
  doc_id: string;
  title: string;
  section: string;
  /** 1-based page number — present for paginated sources (PDF). */
  page?: number;
  text: string;
}

// ---------------------------------------------------------------------------
// Markdown / plain text
// ---------------------------------------------------------------------------

/** Split a markdown document into sections by headings (## and deeper count as section boundaries). */
export function segmentMarkdown(docId: string, title: string, markdown: string): DocumentSection[] {
  const lines = markdown.split('\n');
  const sections: DocumentSection[] = [];
  let currentHeading = 'introducción';
  let sectionNumber = 0;
  let buffer: string[] = [];

  const flush = () => {
    const text = buffer.join('\n').trim();
    if (text.length > 0) {
      sections.push({ doc_id: docId, title, section: `${sectionNumber}. ${currentHeading}`, text });
    }
    buffer = [];
  };

  for (const line of lines) {
    const heading = /^#{1,4}\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      sectionNumber++;
      currentHeading = heading[1]!.trim();
    } else {
      buffer.push(line);
    }
  }
  flush();
  return sections;
}

// ---------------------------------------------------------------------------
// PDF (pdfjs-dist) — one section per page, locator carries the page number
// ---------------------------------------------------------------------------

/** Minimal shape of the pdfjs text-content items we consume. */
interface PdfTextItem {
  str?: string;
  hasEOL?: boolean;
}

export async function segmentPdf(
  docId: string,
  title: string | undefined,
  data: Uint8Array,
): Promise<DocumentSection[]> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // pdfjs mutates/transfers the buffer; hand it a copy.
  const loadingTask = getDocument({
    data: new Uint8Array(data),
    useSystemFonts: true,
  });
  try {
    const doc = await loadingTask.promise;
    const metadata = await doc.getMetadata().catch(() => undefined);
    const info = metadata?.info as { Title?: unknown } | undefined;
    const docTitle =
      title ??
      (typeof info?.Title === 'string' && info.Title.trim().length > 0 ? info.Title.trim() : docId);

    const sections: DocumentSection[] = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = (content.items as PdfTextItem[])
        .map((item) => (item.str ?? '') + (item.hasEOL ? '\n' : ' '))
        .join('')
        .replace(/[ \t]+/g, ' ')
        .replace(/[ \t]*\n[ \t]*/g, '\n')
        .trim();
      if (text.length === 0) continue;
      sections.push({
        doc_id: docId,
        title: docTitle,
        section: `página ${pageNumber}`,
        page: pageNumber,
        text,
      });
    }
    return sections;
  } finally {
    await loadingTask.destroy();
  }
}

// ---------------------------------------------------------------------------
// docx (mammoth) — headings preserved, then reuse the markdown segmentation
// ---------------------------------------------------------------------------

const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => HTML_ENTITIES[m] ?? m);
}

/**
 * Reduce mammoth's semantic HTML to markdown-ish text: h1–h4 become #
 * headings (so segmentMarkdown can split by them), h5/h6 become their own
 * lines (segmentMarkdown ignores deeper levels), paragraphs and list items
 * become lines, everything else is stripped. Good enough for prose manuals;
 * tables degrade to their cell text. Known limitation: original paragraph
 * text that itself starts with "# " reads as a heading downstream.
 */
export function htmlToMarkdownish(html: string): string {
  return decodeEntities(
    html
      .replace(/<h([1-4])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level: string, inner: string) => {
        const text = inner.replace(/<[^>]+>/g, '').trim();
        return `\n${'#'.repeat(Number(level))} ${text}\n`;
      })
      // h5/h6: keep the text but give it its own line so it never glues
      // onto the neighboring paragraph.
      .replace(/<\/?h[1-6][^>]*>/gi, '\n')
      .replace(/<li[^>]*>/gi, '\n- ')
      .replace(/<\/(p|li|ul|ol|table|tr)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(td|th)>/gi, ' ')
      .replace(/<[^>]+>/g, ''),
  );
}

export async function segmentDocx(
  docId: string,
  title: string | undefined,
  buffer: Buffer,
): Promise<DocumentSection[]> {
  const mammoth = await import('mammoth');
  const { value: html } = await mammoth.convertToHtml({ buffer });
  const markdown = htmlToMarkdownish(html);
  const firstHeading = /^#{1,4}\s+(.*)$/m.exec(markdown)?.[1]?.trim();
  return segmentMarkdown(docId, title ?? firstHeading ?? docId, markdown);
}

// ---------------------------------------------------------------------------
// File dispatch
// ---------------------------------------------------------------------------

export interface LoadDocumentOptions {
  /** Stable document id; defaults to the slugified file name (no extension). */
  docId?: string;
  /** Human title; defaults per format (PDF metadata, first docx heading, first md heading). */
  title?: string;
}

/** Default doc_id for a file: slugified base name without extension. */
export function slugifyDocId(filePath: string): string {
  return slugify(basename(filePath, extname(filePath)));
}

/**
 * Load one source document into sections by file extension:
 * .md/.markdown/.txt → heading segmentation; .pdf → one section per page;
 * .docx → headings via mammoth. Anything else is an explicit error.
 */
export async function loadDocumentSections(
  filePath: string,
  opts: LoadDocumentOptions = {},
): Promise<DocumentSection[]> {
  const ext = extname(filePath).toLowerCase();
  const docId = opts.docId ?? slugifyDocId(filePath);
  switch (ext) {
    case '.md':
    case '.markdown':
    case '.txt': {
      const markdown = readFileSync(filePath, 'utf8');
      const firstHeading = /^#{1,4}\s+(.*)$/m.exec(markdown)?.[1]?.trim();
      return segmentMarkdown(docId, opts.title ?? firstHeading ?? docId, markdown);
    }
    case '.pdf':
      return segmentPdf(docId, opts.title, readFileSync(filePath));
    case '.docx':
      return segmentDocx(docId, opts.title, readFileSync(filePath));
    default:
      throw new Error(
        `Unsupported document format "${ext}" (${filePath}) — supported: .md, .markdown, .txt, .pdf, .docx`,
      );
  }
}
