import fs from 'fs';
import path from 'path';
import type { LLMContentPart, LLMProvider } from './types';

const UPLOADS_DIR = path.join(__dirname, '../../../uploads/files');

/** Convert a local file to LLM content parts, using vision when supported. */
export async function prepareFileContent(
  filename: string,
  mimeType: string,
  provider: LLMProvider
): Promise<LLMContentPart[]> {
  const filePath = path.join(UPLOADS_DIR, filename);

  if (mimeType === 'message/rfc822' || filename.toLowerCase().endsWith('.eml')) {
    return processEml(filePath, provider);
  }

  if (mimeType === 'application/pdf') {
    return processPdf(filePath, provider);
  }

  if (mimeType.startsWith('image/')) {
    return processImage(filePath, mimeType, provider);
  }

  // Plain text and everything else — read as UTF-8
  return processText(filePath);
}

async function processPdf(filePath: string, provider: LLMProvider): Promise<LLMContentPart[]> {
  if (provider.supportsVision()) {
    return pdfToImageParts(filePath);
  }
  return pdfToTextParts(filePath);
}

async function processImage(filePath: string, mimeType: string, provider: LLMProvider): Promise<LLMContentPart[]> {
  if (provider.supportsVision()) {
    const data = fs.readFileSync(filePath).toString('base64');
    return [{
      type: 'image',
      source: { type: 'base64', media_type: mimeType, data },
    }];
  }
  // Non-vision provider: OCR
  return imageToTextParts(filePath);
}

async function processText(filePath: string): Promise<LLMContentPart[]> {
  const text = fs.readFileSync(filePath, 'utf-8');
  return [{ type: 'text', text }];
}

async function processEml(filePath: string, provider: LLMProvider): Promise<LLMContentPart[]> {
  const { simpleParser } = await import('mailparser');
  const raw = fs.readFileSync(filePath);
  const parsed = await simpleParser(raw);

  const parts: LLMContentPart[] = [];

  const body = parsed.text ?? parsed.html ?? '';
  if (body) {
    const cleanText = typeof body === 'string' ? stripHtmlTags(body) : '';
    if (cleanText.trim()) {
      parts.push({ type: 'text', text: cleanText });
    }
  }

  // Process inline attachments that could contain reservation info
  if (parsed.attachments) {
    for (const att of parsed.attachments) {
      if (att.contentType === 'application/pdf' && att.content) {
        const tmpPath = path.join(UPLOADS_DIR, `_tmp_${Date.now()}.pdf`);
        fs.writeFileSync(tmpPath, att.content);
        try {
          const attParts = await processPdf(tmpPath, provider);
          parts.push(...attParts);
        } finally {
          fs.rmSync(tmpPath, { force: true });
        }
      } else if (att.contentType.startsWith('image/') && att.content) {
        const tmpPath = path.join(UPLOADS_DIR, `_tmp_${Date.now()}`);
        fs.writeFileSync(tmpPath, att.content);
        try {
          const attParts = await processImage(tmpPath, att.contentType, provider);
          parts.push(...attParts);
        } finally {
          fs.rmSync(tmpPath, { force: true });
        }
      }
    }
  }

  return parts.length > 0 ? parts : [{ type: 'text', text: 'No readable content found.' }];
}

async function pdfToTextParts(filePath: string): Promise<LLMContentPart[]> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PDFParse } = require('pdf-parse') as { PDFParse: new (opts: { data: Buffer }) => { getText(): Promise<{ text: string }> } };
  const buffer = fs.readFileSync(filePath);
  const data = await new PDFParse({ data: buffer }).getText();
  const text = data.text.trim();
  return [{ type: 'text', text: text || 'No text content extracted from PDF.' }];
}

async function pdfToImageParts(filePath: string): Promise<LLMContentPart[]> {
  // For vision-capable providers, convert PDF pages to images
  // We use pdf-parse as a fallback here since pdf2pic requires additional native deps (GraphicsMagick/Ghostscript)
  // If those are available, this could be enhanced; for now fall through to text extraction
  try {
    // pdf2pic is an optional dependency; dynamically required so startup doesn't fail if missing
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { fromPath } = require('pdf2pic') as { fromPath: (path: string, opts: object) => { bulk: (pages: number, opts: object) => Promise<Array<{ base64?: string }>> } };
    const converter = fromPath(filePath, {
      density: 150,
      saveFilename: `_llm_pdf_${Date.now()}`,
      savePath: UPLOADS_DIR,
      format: 'jpeg',
      width: 1200,
      height: 1600,
    });

    const result = await converter.bulk(-1, { responseType: 'base64' });
    const parts: LLMContentPart[] = result
      .filter((r) => r.base64)
      .map((r) => ({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: r.base64 as string },
      }));

    if (parts.length > 0) return parts;
  } catch {
    // pdf2pic not available or conversion failed — fall back to text extraction
  }

  return pdfToTextParts(filePath);
}

async function imageToTextParts(filePath: string): Promise<LLMContentPart[]> {
  try {
    const Tesseract = await import('tesseract.js');
    const { data } = await Tesseract.recognize(filePath, 'eng');
    return [{ type: 'text', text: data.text.trim() || 'No text found in image.' }];
  } catch (err) {
    return [{ type: 'text', text: `Image OCR failed: ${(err as Error).message}` }];
  }
}

function stripHtmlTags(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
