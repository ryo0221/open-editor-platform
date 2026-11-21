import { createFictionMap } from '@editor-platform/fiction-map/model';
import { createEstimate } from '@editor-platform/estimate-core';
import { createAnalysis } from '@editor-platform/analysis-core';
import { createArtifact, type Artifact, type StorageAdapter } from '@editor-platform/artifact-core';
import type { EditorCommand } from '@editor-platform/editor-core';
import { ArtifactEditor } from '@editor-platform/editor-host';
import { createDeck } from '@editor-platform/slide/model';
import { createWhiteboard } from '@editor-platform/whiteboard/model';
import { createDesign, makeDesignElement, type DesignContent } from '@editor-platform/design/model';
import { createData } from '@editor-platform/structured-data/model';
import { f02Plate, type CadKernelProfile } from '@editor-platform/cad-core';
import { f31BoxBuilding } from '@editor-platform/bim-core';
export {
  isCode,
  codeSource,
  nativeEnvironment,
  nativeResolution,
  isStaticSlide,
  type CodeContent,
  type HostContent,
} from './content';
import { nativeEnvironment, type HostContent } from './content';
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
/** The Host adapter of each kind (kinds/index.ts, from the shared definitions). */
export { hostAdapters } from './kinds';
import { hostAdapters, readNativeArtifact } from './kinds';
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
    ['estimate', '見積・積算', createEstimate()],
    ['analysis', '計算・分析ノート', createAnalysis()],
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
    ['fiction-map', 'Fiction Map', createFictionMap()],
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
/** A one-room building (F31), offered like the CAD sample only when the Host supplies a kernel. */
export function bimSample(): Artifact<HostContent> {
  return { ...createArtifact('bim', 'Building', f31BoxBuilding()), id: 'reference-bim' };
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
    const artifact = await readNativeArtifact(kind, text);
    if (artifact.id !== id) throw Error('Stored artifact ID mismatch');
    return artifact;
  }
  async put(artifact: Artifact<HostContent>) {
    this.storage.setItem(this.prefix + artifact.id, JSON.stringify(artifact));
  }
  async putIfAbsent(artifact: Artifact<HostContent>) {
    const key = this.prefix + artifact.id;
    if (!this.storage.getItem(key)) this.storage.setItem(key, JSON.stringify(artifact));
    return (await this.get(artifact.id))!;
  }
  async remove(id: string) {
    this.storage.removeItem(this.prefix + id);
  }
}
