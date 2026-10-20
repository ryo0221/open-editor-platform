import { type ReactNode } from 'react';
import { type EditorState } from 'prosemirror-state';
import {
  Bold,
  Italic,
  Underline,
  Strikethrough,
  Code,
  Link,
  Highlighter,
  Plus,
  List,
  ListOrdered,
  ListChecks,
  IndentIncrease,
  IndentDecrease,
  Search,
  Download,
  ImagePlus,
} from 'lucide-react';
import {
  ReferenceTools,
  type ReferenceSurfaceProps,
} from '@editor-platform/artifact-references/react';
import { IconButton, Menu } from '@editor-platform/editor-ui';
import { type DocumentActions } from './view-actions';
import { type DocumentExportFormat } from './view-hooks';
import { hasDocumentMark, textStyleValue } from './view-model';
import { type ToolButton } from './view-parts';

export interface DocumentToolbarProps {
  engineState: EditorState | null;
  readOnly: boolean;
  selectedId?: string;
  references?: ReferenceSurfaceProps['references'];
  actions: DocumentActions;
  toolButton: ToolButton;
  findOpen: boolean;
  setFindOpen: (open: boolean) => void;
  setInsertOpen: (open: boolean) => void;
  exportMenu: ReactNode;
}

function TextStyleSelect({
  engineState,
  readOnly,
  textStyle,
}: {
  engineState: EditorState | null;
  readOnly: boolean;
  textStyle: DocumentActions['textStyle'];
}) {
  return (
    <select
      aria-label="Text style"
      disabled={readOnly}
      value={textStyleValue(engineState)}
      onChange={(e) => textStyle(e.target.value)}
    >
      <option value="paragraph">Paragraph</option>
      {[1, 2, 3, 4, 5, 6].map((n) => (
        <option key={n} value={`heading-${n}`}>
          Heading {n}
        </option>
      ))}
      <option value="code_block">Code</option>
    </select>
  );
}

function ImageUpload({
  readOnly,
  imageFile,
}: {
  readOnly: boolean;
  imageFile: DocumentActions['imageFile'];
}) {
  return (
    <label className="ep-upload" title="Insert image">
      <ImagePlus size={19} />
      <input
        type="file"
        aria-label="Document image file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        disabled={readOnly}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void imageFile(file);
          e.target.value = '';
        }}
      />
    </label>
  );
}

function MarkButtons({
  actions,
  toolButton,
  hasMark,
}: {
  actions: DocumentActions;
  toolButton: ToolButton;
  hasMark: (name: string) => boolean;
}) {
  const { mark } = actions;
  return (
    <>
      {toolButton('Bold', Bold, () => mark('bold'), hasMark('bold'))}
      {toolButton('Italic', Italic, () => mark('italic'), hasMark('italic'))}
      {toolButton('Underline', Underline, () => mark('underline'), hasMark('underline'))}
      <Menu label="More formatting">
        <div className="ep-inline">
          {toolButton('Strikethrough', Strikethrough, () => mark('strike'), hasMark('strike'))}
          {toolButton('Inline code', Code, () => mark('code'), hasMark('code'))}
          {toolButton(
            'Highlight',
            Highlighter,
            () => mark('highlight', { value: '#fff0a8' }),
            hasMark('highlight'),
          )}
          {toolButton('Link', Link, actions.openLink, hasMark('link'))}
        </div>
      </Menu>
    </>
  );
}

function ListButtons({
  actions,
  toolButton,
}: {
  actions: DocumentActions;
  toolButton: ToolButton;
}) {
  return (
    <>
      {toolButton('Bulleted list', List, actions.bulletList)}
      {toolButton('Numbered list', ListOrdered, actions.orderedList)}
      {toolButton('Checklist', ListChecks, actions.checklist)}
      <Menu label="Indentation">
        <div className="ep-inline">
          {toolButton('Indent', IndentIncrease, actions.indent)}
          {toolButton('Outdent', IndentDecrease, actions.outdent)}
        </div>
      </Menu>
    </>
  );
}

export function DocumentToolbar({
  engineState,
  readOnly,
  selectedId,
  references,
  actions,
  toolButton,
  findOpen,
  setFindOpen,
  setInsertOpen,
  exportMenu,
}: DocumentToolbarProps) {
  const hasMark = (name: string) => hasDocumentMark(engineState, name);
  return (
    <>
      <TextStyleSelect
        engineState={engineState}
        readOnly={readOnly}
        textStyle={actions.textStyle}
      />
      <MarkButtons actions={actions} toolButton={toolButton} hasMark={hasMark} />
      <ListButtons actions={actions} toolButton={toolButton} />
      <IconButton
        icon={Plus}
        label="Insert block"
        disabled={readOnly}
        onClick={() => setInsertOpen(true)}
      />
      <ReferenceTools
        identity={selectedId}
        resolver={references}
        readOnly={readOnly}
        insert={(reference, src, label) =>
          actions.insert('image', { reference, src, alt: label, width: 600 })
        }
      />
      <ImageUpload readOnly={readOnly} imageFile={actions.imageFile} />
      <IconButton icon={Search} label="Find and replace" onClick={() => setFindOpen(!findOpen)} />
      {exportMenu}
    </>
  );
}

export function DocumentExportMenu({
  docx,
  docxReason,
  exporting,
  printPreview,
  openDocx,
  exportFile,
}: {
  docx: boolean;
  docxReason?: string;
  exporting: boolean;
  printPreview: () => Promise<void>;
  openDocx: () => void;
  exportFile: (format: DocumentExportFormat) => Promise<void>;
}) {
  return (
    <Menu label="Export document" icon={Download}>
      <button onClick={() => void printPreview()}>Print preview</button>
      <button
        disabled={!docx}
        title={!docx ? (docxReason ?? 'Hostはこの形式の出力を提供していません。') : undefined}
        onClick={openDocx}
      >
        Export DOCX
      </button>
      <p>
        PDFの本文・表は検索/コピーできます。図・画像内の文字は画像です。Tagged
        PDFは未対応です。大きい画像は1ページへ縮小し、表は行または文字行で分割します。
      </p>
      {(['md', 'html', 'pdf'] as const).map((format) => (
        <button key={format} disabled={exporting} onClick={() => void exportFile(format)}>
          Export {format.toUpperCase()}
        </button>
      ))}
    </Menu>
  );
}
