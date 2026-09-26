import type { PDFDocumentProxy } from 'pdfjs-dist';

export type page_reference = number | { num: number; gen: number };

/** A one-based page and, when the destination names one, the PDF-space point to bring into view. */
export interface pdf_target { page: number; left?: number; top?: number }

export function page_reference(value: unknown): page_reference | undefined {
  if (Number.isSafeInteger(value) && (value as number) >= 0) return value as number;
  if (!value || typeof value !== 'object') return undefined;
  const { num, gen } = value as Record<string, unknown>;
  return Number.isSafeInteger(num) && (num as number) > 0 && Number.isSafeInteger(gen) && (gen as number) >= 0
    ? { num: num as number, gen: gen as number } : undefined;
}

function coordinate(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Resolves a named or explicit destination from PDF data without trusting its shape.
 * XYZ, FitH, FitBH and FitR keep their position; other fits open the page top, and the reader keeps its zoom. */
export async function resolve_destination(pdf: PDFDocumentProxy, destination: unknown): Promise<pdf_target | undefined> {
  let explicit = destination;
  if (typeof destination === 'string') {
    if (!destination || destination.length > 8192) return undefined;
    explicit = await pdf.getDestination(destination);
  }
  if (!Array.isArray(explicit)) return undefined;
  const reference = page_reference(explicit[0]);
  if (reference === undefined) return undefined;
  const index = typeof reference === 'number' ? reference : await pdf.getPageIndex(reference);
  if (!Number.isSafeInteger(index) || index < 0 || index >= pdf.numPages) return undefined;
  const fit = (explicit[1] as { name?: unknown } | undefined)?.name;
  const target: pdf_target = { page: index + 1 };
  const left = fit === 'XYZ' || fit === 'FitR' ? coordinate(explicit[2]) : undefined;
  const top = fit === 'XYZ' ? coordinate(explicit[3]) : fit === 'FitH' || fit === 'FitBH' ? coordinate(explicit[2])
    : fit === 'FitR' ? coordinate(explicit[5]) : undefined;
  if (left !== undefined) target.left = left;
  if (top !== undefined) target.top = top;
  return target;
}
