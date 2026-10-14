import fontkit from '@pdf-lib/fontkit';
import {
  PDFDocument,
  beginText,
  endText,
  setFontAndSize,
  setTextMatrix,
  showText,
  setTextRenderingMode,
  TextRenderingMode,
  type PDFPage,
  type PDFFont,
} from 'pdf-lib';
/** Display is rasterized; this retained Unicode line supplies search/copy at the same position. */
export interface PrintedTextLine {
  text: string;
  x: number;
  y: number;
  size: number;
  width: number;
  order: number;
}
const fixedFile = 'NotoSansCJKjp-Regular.otf';
const fixedHash = '828bf816295d2f293f5f25f09777b3be53ff981df1ec1d7a57cc66f12b50ab55';
let cached: Promise<Uint8Array> | undefined;
// The invisible search/copy layer uses glyphs for control whitespace, as the page renderer does.
const textLayerText = (text: string) => text.replace(/[\t\r\n\f\v]/g, ' ');
async function fixedFont(): Promise<Uint8Array> {
  cached ??= (async () => {
    const response = await fetch(`/office-fonts/${fixedFile}`, {
      credentials: 'omit',
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok || !response.body)
      throw new Error(
        '検索可能PDFに必要な固定日本語フォントを読み込めません。Hostのoffice-fonts配布を確認してください。',
      );
    const chunks: Uint8Array[] = [];
    let length = 0;
    const reader = response.body.getReader();
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.length;
        if (length > 24 * 1024 * 1024) throw new Error('Fixed PDF font exceeds 24 MB');
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    if (digest !== fixedHash) throw new Error('Fixed PDF font hash mismatch');
    return bytes;
  })().catch((error) => {
    cached = undefined;
    throw error;
  });
  return cached;
}
export async function preparePdfTextFont(pdf: PDFDocument, lines: PrintedTextLine[][]) {
  pdf.registerFontkit(fontkit);
  const bytes = await fixedFont();
  const font = await pdf.embedFont(bytes, { subset: true });
  const supported = new Set(font.getCharacterSet());
  const missing = [
    ...new Set(
      lines
        .flat()
        .flatMap((line) => [...textLayerText(line.text)])
        .filter((char) => !supported.has(char.codePointAt(0)!)),
    ),
  ];
  if (missing.length)
    throw new Error(
      `検索可能PDFの固定フォントに未対応の文字があります: ${missing.slice(0, 12).join(' ')}。文字または出力方式を確認してください。`,
    );
  return font;
}
export function addPdfText(page: PDFPage, font: PDFFont, height: number, lines: PrintedTextLine[]) {
  const key = page.node.newFontDictionary('EPText', font.ref);
  // Content stream order is native block order and table row/cell/line order, independent of paint order.
  for (const line of [...lines].sort((a, b) => a.order - b.order)) {
    const text = textLayerText(line.text);
    if (!text || !line.width) continue;
    const size = line.size * 0.75;
    const width = font.widthOfTextAtSize(text, size);
    page.pushOperators(
      beginText(),
      setFontAndSize(key, size),
      setTextRenderingMode(TextRenderingMode.Invisible),
      setTextMatrix((line.width * 0.75) / width, 0, 0, 1, line.x * 0.75, (height - line.y) * 0.75),
      showText(font.encodeText(text)),
      endText(),
    );
  }
}
