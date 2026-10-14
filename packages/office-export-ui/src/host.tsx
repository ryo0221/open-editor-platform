import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  EditorExportGuardContext,
  EditorUncommittedInputContext,
  EditorOfficeCapabilitiesContext,
} from '@editor-platform/editor-ui';
import type { CaptureBasis } from '@editor-platform/export-core';

export interface OfficeExportSource {
  content: unknown;
  basis: CaptureBasis;
  name: string;
}
export interface OfficeExportHostPolicy {
  formats?: { pptx?: boolean; docx?: boolean; reason?: string };
  /** Synchronous: read the confirmed content and revision together, after checking Host policy. */
  capture(): OfficeExportSource;
  /** Host-served fixed font manifest; all faces must pass the manifest hash checks. */
  fontManifestUrl?: string;
  codeFontManifestUrl?: string;
  /** Trusted CSP-restricted Mermaid DOM renderer page, served by the Host. */
  mermaidFrameUrl?: string;
}
export const OfficeExportContext = createContext<OfficeExportHostPolicy | undefined>(undefined);

/** A small lifecycle boundary; no Office encoder, content model or organization policy. */
export function OfficeExportHost({
  capture,
  fontManifestUrl = '/office-fonts/manifest.json',
  codeFontManifestUrl = '/office-fonts/mono-manifest.json',
  mermaidFrameUrl = '/office-mermaid.html',
  guard: hostGuard,
  formats,
  children,
}: OfficeExportHostPolicy & { guard?: () => void; children: ReactNode }) {
  const inheritedGuard = useContext(EditorExportGuardContext);
  const guard = hostGuard ?? inheritedGuard;
  const current = useRef({ capture, guard });
  current.current = { capture, guard };
  const composition = useRef({ active: false, sequence: 0 });
  const [privateInputs] = useState(() => new Set<object>());
  useEffect(() => {
    const start = () => {
      composition.current = { active: true, sequence: composition.current.sequence + 1 };
    };
    const end = () => {
      const sequence = composition.current.sequence;
      // Bubble after the text engine's handler, then let its queued DOM flush complete.
      queueMicrotask(() => {
        if (sequence === composition.current.sequence) composition.current.active = false;
      });
    };
    document.addEventListener('compositionstart', start, true);
    document.addEventListener('compositionend', end);
    return () => {
      document.removeEventListener('compositionstart', start, true);
      document.removeEventListener('compositionend', end);
    };
  }, []);
  const policy = useMemo<OfficeExportHostPolicy>(
    () => ({
      capture() {
        if (composition.current.active)
          throw Error(
            'Finish text composition before preparing an Office export. Your input is retained.',
          );
        if (privateInputs.size)
          throw Error(
            'Finish local text editing before preparing an Office export. Your input is retained.',
          );
        current.current.guard?.();
        return current.current.capture();
      },
      fontManifestUrl,
      codeFontManifestUrl,
      mermaidFrameUrl,
    }),
    [fontManifestUrl, codeFontManifestUrl, mermaidFrameUrl, privateInputs],
  );
  return (
    <EditorExportGuardContext.Provider value={guard}>
      <EditorUncommittedInputContext.Provider value={privateInputs}>
        <EditorOfficeCapabilitiesContext.Provider
          value={{
            pptx: formats?.pptx ?? true,
            docx: formats?.docx ?? true,
            reason: formats?.reason,
          }}
        >
          <OfficeExportContext.Provider value={policy}>{children}</OfficeExportContext.Provider>
        </EditorOfficeCapabilitiesContext.Provider>
      </EditorUncommittedInputContext.Provider>
    </EditorExportGuardContext.Provider>
  );
}
