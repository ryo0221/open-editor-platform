import { createArtifact, type Artifact, type StorageAdapter } from '@editor-platform/artifact-core';
import { command, type EditorCommand } from '@editor-platform/editor-core';
import {
  ArtifactEditor,
  loadHostArtifact,
  type EditorHostAdapter,
} from '@editor-platform/editor-host';
import {
  createDeck,
  isDeck,
  hasSlideAnimations,
  exportSlideSvg,
  type SlideContent,
} from '@editor-platform/slide/model';
import {
  createWhiteboard,
  isWhiteboard,
  exportWhiteboardSvg,
  type WhiteboardContent,
} from '@editor-platform/whiteboard/model';
import {
  createDesign,
  isDesign,
  makeDesignElement,
  type DesignContent,
} from '@editor-platform/design/model';
import {
  createData,
  isStructuredData as isData,
  exportCsv,
  type StructuredData,
} from '@editor-platform/structured-data/model';
import {
  f02Plate,
  isCadDocument,
  type CadDocument,
  type CadKernelProfile,
} from '@editor-platform/cad-core';
import { sealReactEnvironment, type ReactRuntimeResolution } from '@editor-platform/react-ui-core';
import { exportDesignReact } from '@editor-platform/design-react-core';
export interface CodeContent {
  schemaVersion: 1;
  domain: 'host-code';
  fileId: string;
  filename: string;
  source: string;
}
export type HostContent =
  | SlideContent
  | WhiteboardContent
  | DesignContent
  | StructuredData
  | CodeContent
  | CadDocument;
export const isCode = (v: unknown): v is CodeContent => {
  if (!v || typeof v !== 'object') return false;
  const c = v as Partial<CodeContent>;
  return (
    c.schemaVersion === 1 &&
    c.domain === 'host-code' &&
    typeof c.fileId === 'string' &&
    /^[\w-]{1,128}$/.test(c.fileId) &&
    typeof c.filename === 'string' &&
    /^[\w-]+\.tsx$/.test(c.filename) &&
    typeof c.source === 'string' &&
    c.source.length <= 150000
  );
};
export function codeSource(source: string): EditorCommand<CodeContent> {
  return command('host-code.source', 'Edit TSX source', (c) => ({ ...c, source }), {
    origin: 'local',
    transactionId: crypto.randomUUID(),
    mergeKey: 'host-code.source',
  });
}
export const nativeEnvironment = sealReactEnvironment({
  schemaVersion: 1,
  ref: { id: 'artifact-host', version: '1.0.0' },
  reactVersion: '19.1.1',
  dependencies: [],
  providerOrder: [],
  stylePolicy: 'allow-literals',
  tokenVariables: {},
});
export const nativeResolution: ReactRuntimeResolution = {
  environment: nativeEnvironment.ref,
  components: [],
  dependencies: [],
};
export function productDesign(title = 'Your product'): DesignContent {
  const native = (
    id: string,
    type: 'frame' | 'text',
    tag: 'main' | 'h1' | 'p',
    text = '',
    parentId?: string,
  ) => ({
    ...makeDesignElement(type),
    id,
    name: id,
    text,
    fill: type === 'text' ? '#153b35' : '#f7f8f4',
    bounds: { x: 0, y: 0, width: 800, height: type === 'text' ? 80 : 600 },
    ...(parentId ? { parentId } : {}),
    web: { tag },
    sizing: 'fill' as const,
  });
  const frame = native('product-page', 'frame', 'main');
  return {
    ...createDesign(),
    elements: [
      {
        ...frame,
        layout: { direction: 'column', gap: 24, padding: 36, align: 'start', sizing: 'hug' },
      },
      native('product-heading', 'text', 'h1', title, frame.id),
      native(
        'product-description',
        'text',
        'p',
        'Edit this native Design page and reuse its generated React in your app.',
        frame.id,
      ),
    ],
    web: {
      schemaVersion: 1,
      environment: nativeEnvironment,
      registrations: [],
      inputs: {},
      callbacks: {},
      fixture: {},
      breakpoints: [{ id: 'desktop', minWidth: 800 }],
      pages: [{ frameId: frame.id, symbol: 'ProductPage', path: '/' }],
    },
  };
}
/** This reference Host provides static SVG export and saved-page previews. */
export const isStaticSlide = (value: unknown): value is SlideContent =>
  isDeck(value) && !hasSlideAnimations(value);
export const hostAdapters: Record<string, EditorHostAdapter<HostContent>> = {
  slide: {
    kind: 'slide',
    validate: isStaticSlide,
    capabilities: {
      undo: true,
      nativeJson: true,
      formats: ['svg'],
      preview: 'none',
      shared: false,
    },
    async export(_format, c) {
      if (!isStaticSlide(c)) throw Error('このHostは Animation を含む Slide に対応していません。');
      return c.slides.map((s) => ({ filename: s.id + '.svg', text: exportSlideSvg(c, s) }));
    },
  },
  whiteboard: {
    kind: 'whiteboard',
    validate: isWhiteboard,
    capabilities: {
      undo: true,
      nativeJson: true,
      formats: ['svg'],
      preview: 'none',
      shared: false,
    },
    async export(_format, c) {
      if (!isWhiteboard(c)) throw Error('Not Whiteboard');
      return exportWhiteboardSvg(c);
    },
  },
  design: {
    kind: 'design',
    validate: isDesign,
    capabilities: {
      undo: true,
      nativeJson: true,
      formats: ['react'],
      preview: 'host-isolated',
      shared: false,
    },
    async export(_format, c) {
      if (!isDesign(c)) throw Error('Not Design');
      return exportDesignReact(c, nativeResolution);
    },
  },
  code: {
    kind: 'code',
    validate: isCode,
    capabilities: {
      undo: true,
      nativeJson: true,
      formats: ['tsx'],
      preview: 'host-isolated',
      shared: false,
    },
    async export(_format, c) {
      if (!isCode(c)) throw Error('Not Code');
      return c.source;
    },
  },
  cad: {
    kind: 'cad',
    validate: isCadDocument,
    // PNG comes from the Surface viewport (exact evaluated shape); no headless renderer here.
    capabilities: {
      undo: true,
      nativeJson: true,
      formats: [],
      preview: 'none',
      shared: false,
    },
  },
  data: {
    kind: 'data',
    validate: isData,
    capabilities: {
      undo: true,
      nativeJson: true,
      formats: ['csv'],
      preview: 'none',
      shared: false,
    },
    async export(_format, c) {
      if (!isData(c)) throw Error('Not Data');
      return exportCsv(c);
    },
  },
};
export function domainExecute<T extends HostContent>(
  host: ArtifactEditor<HostContent>,
  valid: (v: unknown) => v is T,
) {
  return (cmd: EditorCommand<T>): void => {
    host.execute({
      ...cmd,
      apply: (c) => {
        if (!valid(c)) throw Error('Wrong domain command');
        return cmd.apply(c);
      },
    });
  };
}
export function referenceArtifacts(): Artifact<HostContent>[] {
  const seeds: [string, string, HostContent][] = [
    ['slide', 'Presentation', createDeck()],
    ['whiteboard', 'Canvas', createWhiteboard()],
    ['design', 'Product page', productDesign()],
    [
      'code',
      'React source',
      {
        schemaVersion: 1,
        domain: 'host-code',
        fileId: 'main',
        filename: 'Example.tsx',
        source:
          "import React from 'react';\nexport default function Example(){return <h1>Hello from your app</h1>;}",
      },
    ],
    ['data', 'Records / Kanban', createData()],
  ];
  return seeds.map(([kind, name, content]) => ({
    ...createArtifact(kind, name, content),
    id: 'reference-' + kind,
  }));
}
/** A parametric plate sample, offered only when the Host supplies a kernel build. */
export function cadSample(
  kernel: Pick<CadKernelProfile, 'id' | 'buildHash'>,
): Artifact<HostContent> {
  const plate = f02Plate();
  return {
    ...createArtifact('cad', '3D part', {
      ...plate,
      kernelProfile: { ...plate.kernelProfile, ...kernel },
    }),
    id: 'reference-cad',
  };
}
/** Explicit browser-local adapter. It neither infers access nor promises server durability. */
export class BrowserArtifactStorage implements StorageAdapter<Artifact<HostContent>> {
  constructor(
    private readonly storage: Storage,
    private readonly prefix = 'ep-artifact-host:',
  ) {}
  async list() {
    const records: Artifact<HostContent>[] = [];
    for (let i = 0; i < this.storage.length; i++) {
      const key = this.storage.key(i);
      if (key?.startsWith(this.prefix)) {
        const record = await this.get(key.slice(this.prefix.length));
        if (record) records.push(record);
      }
    }
    return records;
  }
  async get(id: string) {
    const text = this.storage.getItem(this.prefix + id);
    if (!text) return undefined;
    const raw: unknown = JSON.parse(text);
    const kind = raw && typeof raw === 'object' && 'kind' in raw ? String(raw.kind) : '';
    const adapter = hostAdapters[kind];
    if (!adapter) throw Error('Unsupported saved artifact kind');
    const artifact = await loadHostArtifact(text, adapter);
    if (artifact.id !== id) throw Error('Stored artifact ID mismatch');
    return artifact;
  }
  async put(artifact: Artifact<HostContent>) {
    this.storage.setItem(this.prefix + artifact.id, JSON.stringify(artifact));
  }
  async remove(id: string) {
    this.storage.removeItem(this.prefix + id);
  }
}
