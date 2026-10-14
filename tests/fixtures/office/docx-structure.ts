import { unzipSync, strFromU8 } from 'fflate';

/** Normalize generated relationship IDs/codec-dependent media filenames, not text/format. */
export function docxStructure(bytes: Uint8Array) {
  const files = unzipSync(bytes);
  const relationships = new Map<string, string>();
  const rels = strFromU8(files['word/_rels/document.xml.rels']);
  for (const match of rels.matchAll(/<Relationship\b[^>]*\/>/g)) {
    const attr = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(match[0])?.[1];
    const id = attr('Id'),
      type = attr('Type'),
      target = attr('Target');
    if (!id || !type || !target) throw Error('Malformed generated relationship');
    relationships.set(id, type.endsWith('/image') ? 'embedded-image' : `${type}/${target}`);
  }
  return {
    document: strFromU8(files['word/document.xml']).replace(
      /r:(id|embed|link)="([^"]+)"/g,
      (_match, attr: string, id: string) => {
        const value = relationships.get(id);
        if (!value) throw Error('Missing relationship');
        return `r:${attr}="${value}"`;
      },
    ),
    styles: strFromU8(files['word/styles.xml']),
    numbering: strFromU8(files['word/numbering.xml']),
  };
}
