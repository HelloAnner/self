import type { NormalizedBlock } from "../../domains/ingestion/index.ts";
import { buildNormalizedDocument } from "./document-builder.ts";
import { installPdfTextExtractionPolyfills } from "./pdf-runtime-polyfills.ts";

type TextItem = { str?: unknown; hasEOL?: unknown };

export async function parsePdf(input: {
  logicalPath: string;
  mediaType: string;
  bytes: Uint8Array;
}) {
  installPdfTextExtractionPolyfills();
  const pdfjs = await loadPdfJs();
  const loading = pdfjs.getDocument({
    data: input.bytes,
    useWorkerFetch: false,
    useSystemFonts: true,
    verbosity: 0,
  });
  const pdf = await loading.promise;
  const blocks: NormalizedBlock[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      let text = "";
      for (const raw of content.items as TextItem[]) {
        if (typeof raw.str !== "string") continue;
        text += `${raw.str}${raw.hasEOL ? "\n" : " "}`;
      }
      const normalized = text
        .replace(/[ \t]+\n/gu, "\n")
        .replace(/[ \t]{2,}/gu, " ")
        .trim();
      if (!normalized) continue;
      blocks.push({
        kind: "paragraph",
        text: normalized,
        heading_path: [`Page ${pageNumber}`],
        source_start_line: pageNumber,
        source_end_line: pageNumber,
        metadata: { page: String(pageNumber) },
      });
    }
    const metadata = await pdf.getMetadata().catch(() => null);
    const info = metadata?.info as { Title?: unknown } | undefined;
    return buildNormalizedDocument({
      logicalPath: input.logicalPath,
      mediaType: input.mediaType,
      parserId: "pdfjs",
      title: typeof info?.Title === "string" ? info.Title : input.logicalPath,
      blocks,
      metadata: { page_count: pdf.numPages },
    });
  } finally {
    await loading.destroy();
  }
}

async function loadPdfJs() {
  const warn = console.warn;
  console.warn = (...values: unknown[]) => {
    if (!String(values[0] ?? "").includes("@napi-rs/canvas")) warn(...values);
  };
  try {
    // Text extraction does not render; the optional native Canvas warning is not actionable here.
    await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
    return await import("pdfjs-dist/legacy/build/pdf.mjs");
  } finally {
    console.warn = warn;
  }
}
