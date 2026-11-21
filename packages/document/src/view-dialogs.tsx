import { lazy, Suspense } from 'react';
import { Dialog, useWording } from '@editor-platform/editor-ui';
import { rubyLimits, safeLink, type BlockType, type DocumentContent } from './model';
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
  const t = useWording();
  return (
    <div className="ep-find">
      <input
        aria-label="Find text"
        value={finder.search}
        onChange={(e) => finder.changeSearch(e.target.value)}
      />
      <span>{t('{0} matches', matches.length)}</span>
      <button disabled={!matches.length} onClick={() => finder.find(matchIndex + 1)}>
        {t('Next match')}
      </button>
      <input
        aria-label="Replacement text"
        value={finder.replace}
        onChange={(e) => finder.setReplace(e.target.value)}
      />
      <button disabled={readOnly || !matches.length} onClick={() => finder.replaceMatches(false)}>
        {t('Replace')}
      </button>
      <button disabled={readOnly || !matches.length} onClick={() => finder.replaceMatches(true)}>
        {t('Replace all')}
      </button>
      <button onClick={() => finder.setFindOpen(false)}>{t('Close find')}</button>
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
  const t = useWording();
  return (
    <Suspense fallback={<p role="status">{t('Loading DOCX export…')}</p>}>
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
  const t = useWording();
  return (
    <Dialog title="Document print preview" onClose={onClose}>
      <p>
        {printPages
          ? t('{0} pages · Same pagination as exported PDF', printPages.length)
          : t('Rendering print pages…')}
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
  const t = useWording();
  return (
    <Dialog title="Insert document block" onClose={onClose}>
      <div className="ep-block-picker">
        {Object.entries(blockLabels).map(([type, label]) => (
          <button key={type} onClick={() => insert(type as BlockType)}>
            {t(label)}
          </button>
        ))}
      </div>
    </Dialog>
  );
}

export function RubyDialog({
  ruby,
  setRuby,
  actions,
}: {
  ruby: string;
  setRuby: (reading: string) => void;
  actions: DocumentActions;
}) {
  const reading = ruby.trim();
  return (
    <Dialog title="ルビ" onClose={actions.closeRuby}>
      <label>
        読み
        <input
          aria-label="ルビの読み"
          value={ruby}
          maxLength={rubyLimits.text}
          onChange={(e) => setRuby(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && reading && !e.nativeEvent.isComposing)
              actions.setRuby(reading);
          }}
        />
      </label>
      <button disabled={!reading} onClick={() => actions.setRuby(reading)}>
        ルビを付ける
      </button>
      <button onClick={() => actions.setRuby(null)}>ルビを外す</button>
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
  const t = useWording();
  return (
    <Dialog title="Edit link" onClose={actions.closeLink}>
      <label>
        {t('Link URL')}
        <input aria-label="Link URL" value={link} onChange={(e) => setLink(e.target.value)} />
      </label>
      <button disabled={!safeLink(link)} onClick={() => actions.setLink(link)}>
        {t('Apply link')}
      </button>
      <button onClick={() => actions.setLink(null)}>{t('Remove link')}</button>
    </Dialog>
  );
}
