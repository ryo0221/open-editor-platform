import { createRoot } from 'react-dom/client';
import { HostApp } from './HostApp';
import { BrowserArtifactStorage, referenceArtifacts } from './model';
import type { HostAccessAdapter, HostAccessMetadata } from '@editor-platform/editor-host';
declare const __ARTIFACT_PREVIEW_DOCUMENT__: string;
let scope: HostAccessMetadata['scope'] | 'unknown' = 'unknown',
  revision = 0;
const listeners = new Set<() => void>();
const adapter: HostAccessAdapter = {
  async read() {
    const snapshot =
      scope === 'unknown'
        ? undefined
        : {
            scope,
            revision,
            expiresAt: Date.now() + 1500,
            source: 'trusted reference Host fixture',
          };
    await new Promise((r) => setTimeout(r, 100));
    return snapshot;
  },
  subscribe(invalidate) {
    listeners.add(invalidate);
    return () => {
      listeners.delete(invalidate);
    };
  },
};
const storage = new BrowserArtifactStorage(localStorage, 'access-fixture:'),
  samples = referenceArtifacts();
createRoot(document.getElementById('root')!).render(
  <>
    <p>共有表示のfixtureです。実際のSiteの共有設定は変更しません。</p>
    <label>
      Host scope fixture
      <select
        aria-label="Host scope fixture"
        defaultValue="unknown"
        onChange={(e) => {
          scope = e.target.value as typeof scope;
          revision++;
          for (const notify of listeners) notify();
        }}
      >
        {['unknown', 'owner-only', 'public', 'link', 'restricted'].map((v) => (
          <option key={v}>{v}</option>
        ))}
      </select>
    </label>
    <HostApp
      samples={samples}
      storage={storage}
      accessAdapter={adapter}
      previewDocument={__ARTIFACT_PREVIEW_DOCUMENT__}
    />
  </>,
);
