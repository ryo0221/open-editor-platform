import {
  attribute,
  descendants,
  namespaces as ns,
  ImportError,
  validateDisplayLink,
  type XmlNode,
} from '@editor-platform/office-import-core';
import type { DocumentBlock, InlineSpan } from '@editor-platform/document/model';
import { ws, wa, address, property, type DocumentImportContext } from './context';
import { WordStyles } from './styles';
import { WordNumbering, type WordList } from './numbering';
import { WordImages } from './images';
export interface ParsedParagraph {
  blocks: DocumentBlock[];
  list?: WordList;
  number?: number;
  source: XmlNode;
}
export class WordParagraphs {
  private bookmarks = new Set<string>();
  constructor(
    private context: DocumentImportContext,
    private styles: WordStyles,
    private numbering: WordNumbering,
    private images: WordImages,
  ) {
    for (const bookmark of descendants(
      context.pkg.xml(context.pkg.mainPart),
      'bookmarkStart',
      ns.w,
    )) {
      const name = wa(bookmark, 'name');
      if (name) {
        if (this.bookmarks.has(name)) throw new ImportError('DUPLICATE_BOOKMARK', name);
        this.bookmarks.add(name);
      }
    }
  }
  async parse(p: XmlNode, cell = false): Promise<ParsedParagraph> {
    const { builder, pkg, id, mapping } = this.context;
    if (descendants(p, 'fldChar', ns.w).length || descendants(p, 'instrText', ns.w).length) {
      builder.unsupported(
        'COMPLEX_FIELD',
        address(p),
        'This paragraph contains a complex Word field. Exclusion removes the entire paragraph; field instructions are never evaluated.',
      );
      return { blocks: [], source: p };
    }
    const resolved = this.styles.paragraph(p),
      properties = this.styles.blockProperties(resolved.properties);
    let list = this.numbering.resolve(resolved.properties);
    const number = list ? this.numbering.next(list) : undefined;
    if (cell && list) {
      builder.unsupported(
        'CELL_LIST',
        address(p),
        'The native table cell supports paragraphs, not nested lists. Exclusion removes automatic numbering and keeps the paragraph text.',
      );
      list = undefined;
    }
    const section = property(resolved.properties, 'sectPr');
    if (section)
      builder.unsupported(
        'MULTIPLE_SECTIONS',
        address(section),
        'An intermediate Word section is not retained. Exclusion flows its text under the final document page settings.',
      );
    const blocks: DocumentBlock[] = [],
      runs: InlineSpan[] = [];
    const flush = (force = false) => {
      if (!runs.length && !force) return;
      const rich = runs.splice(0),
        block: DocumentBlock = {
          id: id('paragraph'),
          ...properties,
          text: rich.map((r) => r.text).join(''),
          rich,
        };
      blocks.push(block);
      mapping.push({ source: address(p), nativeIds: [block.id] });
    };
    const append = (span: InlineSpan) => {
      if (!span.text) return;
      const previous = runs.at(-1);
      if (
        previous &&
        JSON.stringify({ ...previous, text: '' }) === JSON.stringify({ ...span, text: '' })
      )
        previous.text += span.text;
      else runs.push(span);
    };
    const walk = async (node: XmlNode, link?: string): Promise<void> => {
      for (const n of node.children) {
        if (n.uri !== ns.w) {
          builder.unsupported(
            'INLINE_NAMESPACE',
            address(n),
            'Unknown inline namespace. Exclusion removes this element and its content.',
          );
          continue;
        }
        if (n.local === 'r') {
          const marks = this.styles.marks(resolved.runProperties, n);
          for (const c of n.children) {
            if (c.uri !== ns.w) {
              builder.unsupported(
                'RUN_CHILD_NAMESPACE',
                address(c),
                'Unknown run content. Exclusion removes it.',
              );
              continue;
            }
            if (c.local === 'rPr') continue;
            if (c.local === 't') append({ ...marks, text: c.text, ...(link ? { link } : {}) });
            else if (c.local === 'tab') append({ ...marks, text: '\t', ...(link ? { link } : {}) });
            else if (c.local === 'br' || c.local === 'cr') {
              if (wa(c, 'type') && wa(c, 'type') !== 'textWrapping')
                builder.add(
                  'PAGE_BREAK',
                  'approximation',
                  address(c),
                  'Office page/column break becomes a native line break; pagination flows naturally.',
                  true,
                );
              append({ ...marks, text: '\n', ...(link ? { link } : {}) });
            } else if (c.local === 'noBreakHyphen')
              append({ ...marks, text: '‑', ...(link ? { link } : {}) });
            else if (c.local === 'softHyphen')
              append({ ...marks, text: '\u00ad', ...(link ? { link } : {}) });
            else if (c.local === 'drawing') {
              if (cell) {
                builder.unsupported(
                  'CELL_IMAGE',
                  address(c),
                  'Native cells do not embed images. Explicit exclusion removes this picture.',
                );
                continue;
              }
              const image = await this.images.drawing(c);
              if (image) {
                flush();
                blocks.push(image);
                builder.add(
                  'IMAGE_FLOW',
                  'approximation',
                  address(c),
                  'In-flow picture becomes its own native image block. Surrounding text order remains, with native block spacing.',
                  true,
                );
              }
            } else if (c.local === 'commentReference')
              builder.add(
                'COMMENT_EXCLUDED',
                'excluded',
                address(c),
                'Office comments and actor information are excluded.',
              );
            else if (c.local === 'lastRenderedPageBreak')
              builder.add(
                'PAGINATION_CACHE_EXCLUDED',
                'excluded',
                address(c),
                'Stored pagination cache is excluded; native layout reflows.',
              );
            else if (c.local === 'footnoteReference' || c.local === 'endnoteReference') {
              const kind = c.local === 'footnoteReference' ? 'footnotes' : 'endnotes',
                part = pkg.related(pkg.mainPart, kind),
                ref = wa(c, 'id');
              if (
                !part ||
                !ws(pkg.xml(part), kind === 'footnotes' ? 'footnote' : 'endnote').some(
                  (n) => wa(n, 'id') === ref,
                )
              )
                throw new ImportError('UNRESOLVED_NOTE', `${c.part}${c.path}`);
              builder.unsupported(
                'NOTE_REFERENCE',
                address(c),
                'Footnote/endnote marker and note body are not imported. Explicit exclusion removes this note.',
              );
            } else
              builder.unsupported(
                'INLINE_UNSUPPORTED',
                address(c),
                `Unsupported ${c.local}. Exclusion removes this element and its content.`,
              );
          }
        } else if (n.local === 'hyperlink') {
          const relation = attribute(n, 'id', ns.rel),
            anchor = wa(n, 'anchor');
          let href: string | undefined;
          if (relation) {
            const r = pkg.relationship(n.part, relation, 'hyperlink');
            if (!r.external)
              throw new ImportError('INVALID_LINK', 'Word hyperlink relationship must be external');
            href = validateDisplayLink(r.target);
          }
          if (anchor) {
            if (!relation && !this.bookmarks.has(anchor))
              throw new ImportError('UNRESOLVED_BOOKMARK', anchor);
            builder.add(
              'INTERNAL_LINK',
              'approximation',
              address(n),
              'Bookmark destinations are not native Document anchors; displayed text remains without an internal link.',
              true,
            );
            if (relation)
              builder.add(
                'LINK_FRAGMENT',
                'approximation',
                address(n),
                'External link fragment is omitted; the validated document URL remains.',
                true,
              );
          }
          await walk(n, href);
        } else if (
          [
            'bookmarkStart',
            'bookmarkEnd',
            'commentRangeStart',
            'commentRangeEnd',
            'proofErr',
            'permStart',
            'permEnd',
          ].includes(n.local)
        )
          builder.add(
            'ANNOTATION_EXCLUDED',
            'excluded',
            address(n),
            'Office bookmark/comment/proofing/access metadata is not copied.',
          );
        else if (n.local !== 'pPr')
          builder.unsupported(
            'PARAGRAPH_CHILD',
            address(n),
            `Unsupported ${n.local}. Explicit exclusion removes this element and its displayed content.`,
          );
      }
    };
    await walk(p);
    flush(!blocks.length);
    if (list && (blocks.length !== 1 || blocks[0].type === 'image')) {
      builder.unsupported(
        'LIST_MIXED_CONTENT',
        address(p),
        'A numbered paragraph with embedded images cannot remain one native item. Exclusion removes numbering while preserving the displayed text/image order.',
      );
      list = undefined;
    }
    for (const block of blocks)
      if (block.type !== 'image')
        builder.add(
          'NATIVE_PARAGRAPH',
          'native',
          address(p),
          'Text, semantic outline level and supported inline marks remain editable.',
        );
    return { blocks, list, number, source: p };
  }
}
