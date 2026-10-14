export type FileTextEncoding = 'auto' | 'utf-8' | 'utf-16le' | 'utf-16be' | 'shift_jis';
/** BOM detection is deterministic; unmarked text never silently guesses a legacy encoding. */
export function decodeFileText(
  bytes: Uint8Array,
  name: string,
  encoding: FileTextEncoding = 'auto',
): string {
  const bom =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? 'utf-16le'
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? 'utf-16be'
        : bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
          ? 'utf-8'
          : undefined;
  const selected = encoding === 'auto' ? (bom ?? 'utf-8') : encoding;
  try {
    return new TextDecoder(selected, { fatal: true }).decode(bytes);
  } catch {
    throw new Error(
      `${name}を${selected}として読み込めません。BOM付きUTF-16LE/BE、UTF-8、またはShift-JISを選び直すか、テキストエディタでUTF-8に変換してください。現在の原本と注釈は変更していません。`,
    );
  }
}
