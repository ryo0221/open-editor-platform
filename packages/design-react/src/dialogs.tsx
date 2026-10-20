import { zipSync, strToU8 } from 'fflate';
import type { DesignContent } from '@editor-platform/design/model';
import type { ReactRuntimeAdapter, ReactUiDiagnostic } from '@editor-platform/react-ui-core';
import type {
  DesignReactBundle,
  reviewDesignReceiptRegeneration,
  reviewDesignReactDocumentRegeneration,
} from '@editor-platform/design-react-core';
import { DesignReactPreview } from './preview';

// Overlays of the Design React surface. The surface owns state and every action.

export interface PendingRegeneration {
  id: string;
  sourceHash: string;
  plan: ReturnType<typeof reviewDesignReactDocumentRegeneration>;
}

/** Export failure with shortcuts to the native element or publication each diagnostic names. */
export function ExportErrorAlert({
  content,
  error,
  diagnostics,
  dismiss,
  focusElement,
  configurePublication,
}: {
  content: DesignContent;
  error: string;
  diagnostics: ReactUiDiagnostic[];
  dismiss: () => void;
  focusElement: (id: string) => void;
  configurePublication: (id: string) => void;
}) {
  return (
    <div role="alert" className="surface-error">
      {error}
      {diagnostics.map((diagnostic, index) => {
        const element = content.elements.find((element) => element.id === diagnostic.path);
        const component = content.components.find(
          (component) =>
            component.id === element?.componentId ||
            diagnostic.path === component.id ||
            diagnostic.path.startsWith(component.id + '/'),
        );
        return (
          <div key={index}>
            {diagnostic.code}: {diagnostic.message}
            {element && !component && (
              <button onClick={() => focusElement(element.id)}>
                Edit HTML semantics {element.name}
              </button>
            )}
            {component && (
              <button onClick={() => configurePublication(component.id)}>
                Configure React publication {component.name}
              </button>
            )}
          </div>
        );
      })}
      <button onClick={dismiss}>Dismiss</button>
    </div>
  );
}

export function PreviewDialog({
  content,
  rootId,
  runtime,
  width,
  setWidth,
  mode,
  setMode,
  close,
}: {
  content: DesignContent;
  rootId: string;
  runtime: ReactRuntimeAdapter;
  width: number;
  setWidth: (width: number) => void;
  mode: 'edit' | 'interact';
  setMode: (mode: 'edit' | 'interact') => void;
  close: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-label="Design React preview"
      className="design-react-dialog"
      style={{
        position: 'fixed',
        inset: 20,
        zIndex: 1000,
        background: 'white',
        padding: 16,
        overflow: 'auto',
      }}
    >
      <button onClick={close}>Close preview</button>
      <label>
        Width
        <select
          aria-label="Design React preview width"
          value={width}
          onChange={(e) => setWidth(Number(e.target.value))}
        >
          {[390, 1024, 1400].map((w) => (
            <option key={w}>{w}</option>
          ))}
        </select>
      </label>
      <button onClick={() => setMode(mode === 'edit' ? 'interact' : 'edit')}>
        {mode === 'edit' ? 'Interact with React' : 'Edit preview'}
      </button>
      <DesignReactPreview
        content={content}
        rootIds={[rootId]}
        runtime={runtime}
        width={width}
        height={700}
        mode={mode}
      />
    </div>
  );
}

const reviewDialogStyle = {
  position: 'fixed',
  inset: '10%',
  zIndex: 1001,
  background: 'white',
  padding: 24,
  overflow: 'auto',
} as const;

export function ExportReviewDialog({
  content,
  review,
  changes,
  readOnly,
  accept,
  download,
  close,
}: {
  content: DesignContent;
  review: DesignReactBundle;
  changes: ReturnType<typeof reviewDesignReceiptRegeneration> | undefined;
  readOnly?: boolean;
  accept: () => void;
  download: () => void;
  close: () => void;
}) {
  return (
    <div role="dialog" aria-label="Review Design React export" style={reviewDialogStyle}>
      <h2>Review Design React export</h2>
      <p>
        Source {review.sourceHash} · {review.ownership}
      </p>
      <pre>{JSON.stringify(changes?.changes ?? Object.keys(review.files), null, 2)}</pre>
      {review.diagnostics.map((d) => (
        <p key={d.path + d.code}>{d.message}</p>
      ))}
      <button disabled={readOnly} onClick={accept}>
        Accept reviewed conversion
      </button>
      <button
        disabled={
          content.web?.accepted?.fingerprint !== review.fingerprint ||
          content.web?.accepted?.sourceHash !== review.sourceHash
        }
        onClick={download}
      >
        Download React bundle
      </button>
      <button onClick={close}>Close export review</button>
    </div>
  );
}

/** Zips the reviewed generated files with the pinned dependency material and downloads it. */
export function downloadDesignReactBundle(
  review: DesignReactBundle,
  material: { path: string; bytes: Uint8Array }[],
) {
  const files: Record<string, Uint8Array> = Object.fromEntries(
    Object.entries(review.files).map(([path, value]) => [path, strToU8(value)]),
  );
  for (const file of material) files[file.path] = file.bytes;
  const bytes = zipSync(files);
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/zip' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'design-react.zip';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function RegenerationDialog({
  regeneration,
  readOnly,
  accept,
  close,
}: {
  regeneration: PendingRegeneration;
  readOnly?: boolean;
  accept: () => void;
  close: () => void;
}) {
  return (
    <div role="dialog" aria-label="Review React UI regeneration" style={reviewDialogStyle}>
      <h2>Review React UI regeneration</h2>
      <p>
        Source {regeneration.sourceHash} · Target {regeneration.plan.target}
      </p>
      <p>
        Independent React UI edits are retained. Shared changes require the target's authority
        session.
      </p>
      <pre>
        {JSON.stringify(
          regeneration.plan.conflicts.length
            ? regeneration.plan.conflicts
            : regeneration.plan.document,
          null,
          2,
        )}
      </pre>
      <button disabled={readOnly || regeneration.plan.conflicts.length > 0} onClick={accept}>
        Accept React UI regeneration
      </button>
      <button onClick={close}>Close regeneration review</button>
    </div>
  );
}
