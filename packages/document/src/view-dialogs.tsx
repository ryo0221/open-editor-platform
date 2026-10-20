import { lazy, Suspense } from 'react';
import { Dialog } from '@editor-platform/editor-ui';
import { safeLink, type BlockType, type DocumentContent } from './model';
import { type DocumentActions } from './view-actions';
import { type useFindReplace } from './view-hooks';
import { blockLabels } from './view-model';

const DocumentDocxDialog = lazy(() =>
  import('@editor-platform/office-export-ui/document').then((module) => ({
    default: module.DocumentDocxDialog,
  })),
);

export function DocumentFindBar({
  finder,
  readOnly,
}: {
  finder: ReturnType<typeof useFindReplace>;
  readOnly: boolean;
}) {
  const { matches, matchIndex } = finder;
  return (
    <div className="ep-find">
      <input
        aria-label="Find text"
        value={finder.search}
        onChange={(e) => finder.changeSearch(e.target.value)}
      />
      <span>{matches.length} matches</span>
      <button disabled={!matches.length} onClick={() => finder.find(matchIndex + 1)}>
        Next match
      </button>
      <input
        aria-label="Replacement text"
        value={finder.replace}
        onChange={(e) => finder.setReplace(e.target.value)}
      />
      <button disabled={readOnly || !matches.length} onClick={() => finder.replaceMatches(false)}>
        Replace
      </button>
      <button disabled={readOnly || !matches.length} onClick={() => finder.replaceMatches(true)}>
        Replace all
      </button>
      <button onClick={() => finder.setFindOpen(false)}>Close find</button>
    </div>
  );
}

export function DocumentDocxExport({
  content,
  onClose,
  onNavigate,
}: {
  content: DocumentContent;
  onClose: () => void;
  onNavigate: (blockId: string) => void;
}) {
  return (
    <Suspense fallback={<p role="status">Loading DOCX export…</p>}>
      <DocumentDocxDialog
        content={content}
        onClose={onClose}
        onNavigate={(address) => {
          if (!address.blockId) return;
          onNavigate(address.blockId);
        }}
      />
    </Suspense>
  );
}

export function PrintPreviewDialog({
  printPages,
  onClose,
}: {
  printPages: string[] | null;
  onClose: () => void;
}) {
  return (
    <Dialog title="Document print preview" onClose={onClose}>
      <p>
        {printPages
          ? `${printPages.length} pages · Same pagination as exported PDF`
          : 'Rendering print pages…'}
      </p>
      <div className="ep-print-pages">
        {printPages?.map((src, i) => (
          <img key={i} src={src} alt={`Print page ${i + 1}`} />
        ))}
      </div>
    </Dialog>
  );
}

export function InsertBlockDialog({
  onClose,
  insert,
}: {
  onClose: () => void;
  insert: DocumentActions['insert'];
}) {
  return (
    <Dialog title="Insert document block" onClose={onClose}>
      <div className="ep-block-picker">
        {Object.entries(blockLabels).map(([type, label]) => (
          <button key={type} onClick={() => insert(type as BlockType)}>
            {label}
          </button>
        ))}
      </div>
    </Dialog>
  );
}

export function LinkDialog({
  link,
  setLink,
  actions,
}: {
  link: string;
  setLink: (href: string) => void;
  actions: DocumentActions;
}) {
  return (
    <Dialog title="Edit link" onClose={actions.closeLink}>
      <label>
        Link URL
        <input aria-label="Link URL" value={link} onChange={(e) => setLink(e.target.value)} />
      </label>
      <button disabled={!safeLink(link)} onClick={() => actions.setLink(link)}>
        Apply link
      </button>
      <button onClick={() => actions.setLink(null)}>Remove link</button>
    </Dialog>
  );
}
