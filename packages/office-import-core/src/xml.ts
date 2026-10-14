import { SaxesParser } from 'saxes';
import { ImportError, importLimits } from './types';
export const namespaces = {
  contentTypes: 'http://schemas.openxmlformats.org/package/2006/content-types',
  relationships: 'http://schemas.openxmlformats.org/package/2006/relationships',
  rel: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
  mc: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
} as const;
export interface XmlNode {
  part: string;
  local: string;
  uri: string;
  path: string;
  attributes: { local: string; uri: string; value: string }[];
  children: XmlNode[];
  text: string;
}
export function attribute(node: XmlNode | undefined, name: string, uri = '') {
  return node?.attributes.find((a) => a.local === name && a.uri === uri)?.value;
}
export function children(node: XmlNode | undefined, name: string, uri: string): XmlNode[] {
  return node?.children.filter((n) => n.local === name && n.uri === uri) ?? [];
}
export function child(node: XmlNode | undefined, name: string, uri: string) {
  return children(node, name, uri)[0];
}
export function descendants(node: XmlNode | undefined, name: string, uri: string): XmlNode[] {
  if (!node) return [];
  return [
    ...(node.local === name && node.uri === uri ? [node] : []),
    ...node.children.flatMap((n) => descendants(n, name, uri)),
  ];
}
export function parseOfficeXml(bytes: Uint8Array, part: string): XmlNode {
  if (bytes.length > importLimits.xmlBytes) throw new ImportError('XML_LIMIT', part);
  let source: string;
  try {
    const encoding =
      bytes[0] === 0xff && bytes[1] === 0xfe
        ? 'utf-16le'
        : bytes[0] === 0xfe && bytes[1] === 0xff
          ? 'utf-16be'
          : 'utf-8';
    source = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    const declaration = source.match(/^\s*<\?xml\s+[^?]*encoding=["']([^"']+)/i)?.[1];
    if (declaration && !/^utf-(8|16|16le|16be)$/i.test(declaration))
      throw Error('Only UTF-8 or BOM-marked UTF-16 XML is supported');
  } catch (e) {
    throw new ImportError('XML_ENCODING', `${part}: ${String(e)}`);
  }
  const parser = new SaxesParser({ xmlns: true });
  const stack: XmlNode[] = [];
  const siblingCounts = new WeakMap<XmlNode, Map<string, number>>();
  let root: XmlNode | undefined,
    count = 0;
  parser.on('error', (e) => {
    throw new ImportError('INVALID_XML', `${part}: ${e.message}`);
  });
  parser.on('doctype', () => {
    throw new ImportError('DTD_BLOCKED', part);
  });
  parser.on('processinginstruction', () => {
    throw new ImportError('XML_PROCESSING_INSTRUCTION', part);
  });
  let attributeCount = 0;
  parser.on('opentagstart', () => {
    attributeCount = 0;
  });
  parser.on('attribute', (a) => {
    if (
      ++attributeCount > 256 ||
      a.name.length > 256 ||
      (a.name.startsWith('xmlns') && a.value.length > 2048)
    )
      throw new ImportError('XML_ATTRIBUTE_LIMIT', part);
  });
  parser.on('opentag', (tag) => {
    if (tag.local.length > 128 || tag.uri.length > 2048)
      throw new ImportError('XML_NAME_LIMIT', part);
    if (++count > importLimits.xmlNodes || stack.length >= importLimits.xmlDepth)
      throw new ImportError('XML_TREE_LIMIT', part);
    const parent = stack.at(-1);
    // Paths count all siblings with the same local name so different namespaces
    // cannot alias one source address. Namespace validity is checked separately.
    const key = tag.local;
    const counts = parent ? siblingCounts.get(parent)! : new Map<string, number>();
    const siblings = counts.get(key) ?? 0;
    counts.set(key, siblings + 1);
    const node: XmlNode = {
      part,
      local: tag.local,
      uri: tag.uri,
      path: `${parent?.path ?? ''}/${tag.local}[${siblings + 1}]`,
      attributes: Object.values(tag.attributes).map((a) => ({
        local: a.local,
        uri: a.uri,
        value: a.value,
      })),
      children: [],
      text: '',
    };
    if (node.attributes.length > 256) throw new ImportError('XML_ATTRIBUTE_LIMIT', part);
    if (parent) parent.children.push(node);
    else root = node;
    siblingCounts.set(node, new Map());
    stack.push(node);
  });
  const text = (value: string) => {
    const n = stack.at(-1);
    if (n) n.text += value;
  };
  parser.on('text', text);
  parser.on('cdata', text);
  parser.on('closetag', () => {
    stack.pop();
  });
  for (let at = 0; at < source.length; at += 4096) parser.write(source.slice(at, at + 4096));
  parser.close();
  if (!root) throw new ImportError('INVALID_XML', `${part}: empty document`);
  return root;
}
