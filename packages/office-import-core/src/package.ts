/* eslint-disable no-control-regex -- Reject C0 characters in untrusted Office paths and URLs. */
import { readOfficeZip } from './zip';
import { attribute, children, namespaces as ns, parseOfficeXml, type XmlNode } from './xml';
import {
  checkImportAbort,
  hashImportBytes,
  ImportError,
  importLimits,
  type OfficeImportFormat,
} from './types';
export interface OfficeRelationship {
  id: string;
  type: string;
  target: string;
  external: boolean;
}
export interface OfficePackage {
  readonly sourceHash: string;
  readonly format: OfficeImportFormat;
  readonly mainPart: string;
  readonly parts: readonly string[];
  bytes(part: string): Uint8Array;
  xml(part: string): XmlNode;
  relationships(part: string): readonly OfficeRelationship[];
  relationship(part: string, id: string, type?: string): OfficeRelationship;
  related(part: string, type: string): string | undefined;
}
const relPrefix = `${ns.rel}/`;
export function resolvePart(part: string, target: string): string {
  if (!target || /[\\\u0000-\u0020?#]/.test(target) || /^[a-z][a-z0-9+.-]*:/i.test(target))
    throw new ImportError('INVALID_RELATIONSHIP', `${part}: invalid internal target`);
  let decoded: string;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    throw new ImportError('INVALID_RELATIONSHIP', part);
  }
  if (decoded !== target)
    throw new ImportError('PART_ENCODING', 'Percent-encoded part paths are outside this profile');
  const stack = target.startsWith('/') ? [] : part.split('/').slice(0, -1);
  for (const segment of target.replace(/^\//, '').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (!stack.length) throw new ImportError('PATH_TRAVERSAL', part);
      stack.pop();
    } else stack.push(segment);
  }
  return stack.join('/');
}
const yieldToEventLoop = () => new Promise((r) => setTimeout(r, 0));
function assertInspectionInput(input: { bytes: Uint8Array; format: OfficeImportFormat }) {
  if (!(input.bytes instanceof Uint8Array) || !['pptx', 'docx'].includes(input.format))
    throw new ImportError('SOURCE_FORMAT', 'Choose PPTX or DOCX');
  if (input.bytes.length > importLimits.compressedBytes)
    throw new ImportError('COMPRESSED_LIMIT', 'Office file exceeds 32 MiB');
}
const countXmlNodes = (n: XmlNode): number =>
  1 + n.children.reduce((sum, c) => sum + countXmlNodes(c), 0);
const isXmlPart = (part: string) => /\.(xml|rels)$/i.test(part) || part === '[Content_Types].xml';
interface XmlParseState {
  xml: Map<string, XmlNode>;
  totalNodes: number;
}
function addXmlPart(state: XmlParseState, part: string, data: Uint8Array) {
  const tree = parseOfficeXml(data, part);
  state.totalNodes += countXmlNodes(tree);
  if (state.totalNodes > importLimits.totalXmlNodes)
    throw new ImportError('XML_TOTAL_LIMIT', 'More than 1,000,000 XML elements');
  if (tree.uri.startsWith('http://purl.oclc.org/ooxml/'))
    throw new ImportError('STRICT_PROFILE_UNSUPPORTED', part);
  state.xml.set(part, tree);
}
function readContentTypes(types: XmlNode, files: ReadonlyMap<string, Uint8Array>) {
  if (types.uri !== ns.contentTypes || types.local !== 'Types')
    throw new ImportError('CONTENT_TYPES', 'Invalid content types root');
  const typeNames = new Map<string, string>();
  const defaults = new Map<string, string>();
  for (const n of types.children) {
    const mime = attribute(n, 'ContentType');
    if (n.uri !== ns.contentTypes || !mime)
      throw new ImportError('CONTENT_TYPES', 'Invalid content type');
    if (/macro|vba|oleObject|activex|ms-office\.active/i.test(mime))
      throw new ImportError('ACTIVE_CONTENT', mime);
    if (n.local === 'Override') addContentTypeOverride(n, mime, typeNames, files);
    else if (n.local === 'Default') addContentTypeDefault(n, mime, defaults);
    else throw new ImportError('CONTENT_TYPES', 'Unknown content-type declaration');
  }
  for (const part of files.keys())
    if (
      part !== '[Content_Types].xml' &&
      !typeNames.has(part) &&
      !defaults.has(part.split('.').at(-1)!.toLowerCase())
    )
      throw new ImportError('CONTENT_TYPES', `Unspecified part: ${part}`);
  return typeNames;
}
function addContentTypeOverride(
  n: XmlNode,
  mime: string,
  typeNames: Map<string, string>,
  files: ReadonlyMap<string, Uint8Array>,
) {
  const name = attribute(n, 'PartName');
  if (!name?.startsWith('/') || typeNames.has(name.slice(1)) || !files.has(name.slice(1)))
    throw new ImportError('CONTENT_TYPES', 'Invalid or duplicate content-type override');
  typeNames.set(name.slice(1), mime);
}
function addContentTypeDefault(n: XmlNode, mime: string, defaults: Map<string, string>) {
  const ext = attribute(n, 'Extension');
  if (!ext || defaults.has(ext.toLowerCase()))
    throw new ImportError('CONTENT_TYPES', 'Invalid or duplicate content-type default');
  defaults.set(ext.toLowerCase(), mime);
}
function relationshipOwner(part: string, files: ReadonlyMap<string, Uint8Array>) {
  const owner = part === '_rels/.rels' ? '' : part.replace(/(^|\/)_rels\/([^/]+)\.rels$/, '$1$2');
  if (owner === part || (owner && !files.has(owner)))
    throw new ImportError('INVALID_RELATIONSHIP', `Orphan relationship part: ${part}`);
  return owner;
}
function readRelationshipRow(
  n: XmlNode,
  part: string,
  owner: string,
  seen: Set<string>,
  files: ReadonlyMap<string, Uint8Array>,
): OfficeRelationship {
  const id = attribute(n, 'Id'),
    type = attribute(n, 'Type'),
    target = attribute(n, 'Target'),
    mode = attribute(n, 'TargetMode');
  if (
    n.uri !== ns.relationships ||
    n.local !== 'Relationship' ||
    !id ||
    !type ||
    !target ||
    seen.has(id) ||
    (mode && !['Internal', 'External'].includes(mode))
  )
    throw new ImportError('INVALID_RELATIONSHIP', part);
  seen.add(id);
  if (
    /\/(vbaProject|oleObject|package|control|attachedTemplate|externalLink|altChunk)$/i.test(type)
  )
    throw new ImportError('ACTIVE_CONTENT', `${part}: ${type}`);
  const external = mode === 'External';
  const resolved = external ? target : resolvePart(owner, target);
  if (!external && !files.has(resolved))
    throw new ImportError('MISSING_PART', `${part}: ${resolved}`);
  return { id, type, target: resolved, external };
}
function readRelationships(
  xml: ReadonlyMap<string, XmlNode>,
  files: ReadonlyMap<string, Uint8Array>,
) {
  const relations = new Map<string, OfficeRelationship[]>();
  for (const [part, tree] of xml)
    if (part.endsWith('.rels')) {
      if (tree.uri !== ns.relationships || tree.local !== 'Relationships')
        throw new ImportError('INVALID_RELATIONSHIP', part);
      const owner = relationshipOwner(part, files);
      const seen = new Set<string>(),
        rows: OfficeRelationship[] = [];
      for (const n of tree.children) rows.push(readRelationshipRow(n, part, owner, seen, files));
      relations.set(owner, rows);
    }
  return relations;
}
function createRelated(relations: ReadonlyMap<string, readonly OfficeRelationship[]>) {
  return (part: string, type: string) => {
    const rows = (relations.get(part) ?? []).filter((r) => r.type === relPrefix + type);
    if (rows.length > 1 || rows.some((r) => r.external))
      throw new ImportError('INVALID_RELATIONSHIP', `${part}: expected one internal ${type}`);
    return rows[0]?.target;
  };
}
function checkMainPart(
  format: OfficeImportFormat,
  mainPart: string | undefined,
  typeNames: ReadonlyMap<string, string>,
  getXml: (part: string) => XmlNode,
): string {
  if (!mainPart) throw new ImportError('SOURCE_FORMAT', 'Missing Office document relationship');
  const expected =
    format === 'pptx'
      ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'
      : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
  if (typeNames.get(mainPart) !== expected)
    throw new ImportError(
      'SOURCE_FORMAT',
      'Only transitional PPTX/DOCX documents are supported; templates and macro formats are excluded',
    );
  const root = getXml(mainPart);
  if (
    root.uri !== (format === 'pptx' ? ns.p : ns.w) ||
    root.local !== (format === 'pptx' ? 'presentation' : 'document')
  )
    throw new ImportError('SOURCE_FORMAT', 'Unexpected main document namespace');
  return mainPart;
}
export async function inspectOfficePackage(
  input: { bytes: Uint8Array; format: OfficeImportFormat },
  signal?: AbortSignal,
): Promise<OfficePackage> {
  assertInspectionInput(input);
  // Own the original before any await. Subsequent caller edits never change this inspection.
  const owned = input.bytes.slice(),
    format = input.format;
  const sourceHash = await hashImportBytes(owned);
  const files = await readOfficeZip(owned, signal),
    xml = new Map<string, XmlNode>();
  const bytes = (part: string) => {
    const b = files.get(part);
    if (!b) throw new ImportError('MISSING_PART', part);
    return b.slice();
  };
  const parsed: XmlParseState = { xml, totalNodes: 0 };
  for (const [part, data] of files) {
    if (isXmlPart(part)) {
      checkImportAbort(signal);
      addXmlPart(parsed, part, data);
      if (xml.size % 8 === 0) await yieldToEventLoop();
    }
  }
  const getXml = (part: string) => {
    const tree = xml.get(part);
    if (!tree) throw new ImportError('MISSING_XML_PART', part);
    return tree;
  };
  const typeNames = readContentTypes(getXml('[Content_Types].xml'), files);
  const relations = readRelationships(xml, files);
  const related = createRelated(relations);
  const mainPart = checkMainPart(format, related('', 'officeDocument'), typeNames, getXml);
  checkImportAbort(signal);
  return {
    sourceHash,
    format,
    mainPart,
    parts: [...files.keys()],
    bytes,
    xml: getXml,
    relationships: (part) => relations.get(part) ?? [],
    related,
    relationship(part, id, type) {
      const r = relations.get(part)?.find((r) => r.id === id);
      if (!r || (type && r.type !== relPrefix + type))
        throw new ImportError('INVALID_RELATIONSHIP', `${part}: unresolved ${id}`);
      return r;
    },
  };
}
export function validateDisplayLink(link: string): string {
  if (/[\u0000-\u0020]/.test(link)) throw new ImportError('INVALID_LINK', 'Unsafe hyperlink');
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new ImportError('INVALID_LINK', 'Invalid hyperlink');
  }
  if (!['https:', 'http:', 'mailto:'].includes(url.protocol) || url.username || url.password)
    throw new ImportError('INVALID_LINK', 'Only HTTP(S) and mailto display links are supported');
  return link;
}
export function requiredChild(root: XmlNode, local: string, uri: string, part: string) {
  const nodes = children(root, local, uri);
  if (nodes.length !== 1)
    throw new ImportError('INVALID_STRUCTURE', `${part}: expected one ${local}`);
  return nodes[0];
}
