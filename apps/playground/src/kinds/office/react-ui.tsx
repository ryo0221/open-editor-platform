import { useMemo } from 'react';
import {
  ReactUiSurface,
  reactUiExportKinds,
  type ReactUiExportKind,
} from '@editor-platform/react-ui';
import type { ReactUiDocument } from '@editor-platform/react-ui-core';
import { referenceRegisteredRuntimeAdapter } from '../../../../react-ui-reference/src/generated-registry';
import {
  createReferenceDocument,
  referenceTextRevision,
  referenceEnvironmentRevision,
} from '../../../../react-ui-reference/src/catalog';
import { reactUiDefinition } from '../office';
import { hostKind } from '../host-kind';
import type { SurfaceHost } from '../surface-host';

const referenceReactExamples = [
  { name: 'Product page', document: createReferenceDocument('product') },
  { name: 'Contact form', document: createReferenceDocument('form') },
  { name: '製品ページ（日本語）', document: createReferenceDocument('product', 'ja') },
  { name: 'お問い合わせ（日本語）', document: createReferenceDocument('form', 'ja') },
  { name: 'Host tokens', document: createReferenceDocument('tokens') },
];

/** `?react-ui-exports=none` or a comma list (`tsx,composition`) stands in for a Host
 * without every export destination (#801). Absent, every export is shown. */
function playgroundReactUiExports(): false | ReactUiExportKind[] | undefined {
  const value = new URLSearchParams(location.search).get('react-ui-exports');
  if (value === null) return undefined;
  if (value === 'none') return false;
  return value
    .split(',')
    .filter((kind): kind is ReactUiExportKind => reactUiExportKinds.includes(kind as never));
}

function ReactUiHost({ host, content }: { host: SurfaceHost; content: ReactUiDocument }) {
  const exports = useMemo(playgroundReactUiExports, []);
  return (
    <ReactUiSurface
      exports={exports}
      screenReferences={[
        { namespace: 'reference-host', screenId: host.active.id, stateId: 'draft' },
      ]}
      content={content}
      readOnly={host.readOnly}
      execute={host.execute}
      select={host.select}
      selectedId={host.selection.addresses[0]?.elementId}
      runtime={referenceRegisteredRuntimeAdapter}
      examples={referenceReactExamples}
      revisions={[
        { component: referenceTextRevision, propMap: { text: 'content' }, slotMap: {} },
        { environment: referenceEnvironmentRevision, propMap: {}, slotMap: {} },
      ]}
      beforeExport={host.exportGuard}
    />
  );
}

export const reactUiSurface = hostKind(reactUiDefinition, { Surface: ReactUiHost });
