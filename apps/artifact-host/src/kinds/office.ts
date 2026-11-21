// The Artifact Host's office kinds, in the order it lists them. Each shared definition comes from
// its package's `./kind`; Host connections to engineering code (Estimate's CAD/BIM check) arrive
// as arguments from kinds/index.ts.
import type { Artifact } from '@editor-platform/artifact-core';
import type { KindDefinition } from '@editor-platform/artifact-kinds';
import { analysisKind } from '@editor-platform/analysis/kind';
import { verifyAnalysisArtifact } from '@editor-platform/analysis/host';
import { designKind } from '@editor-platform/design/kind';
import { exportDesignReact } from '@editor-platform/design-react-core';
import { isDesignWithPaths } from '@editor-platform/design/model';
import { estimateKind } from '@editor-platform/estimate/kind';
import { fictionMapHostAdapter, parseFictionMapArtifact } from '@editor-platform/fiction-map/host';
import { fictionMapKind } from '@editor-platform/fiction-map/kind';
import { slideKind } from '@editor-platform/slide/kind';
import { exportSlideSvg } from '@editor-platform/slide/model';
import { dataKind } from '@editor-platform/structured-data/kind';
import { exportCsv, isStructuredData } from '@editor-platform/structured-data/model';
import { whiteboardKind } from '@editor-platform/whiteboard/kind';
import { exportWhiteboardSvg, isWhiteboard } from '@editor-platform/whiteboard/model';
import { isCode, isStaticSlide, nativeResolution, type HostContent } from '../content';
import { artifactKind } from './artifact-kind';
import { codeKind } from './code';

/** The typed definitions, in list order (kinds/surfaces.tsx checks each has one Surface). */
export const officeDefinitions: readonly KindDefinition<unknown>[] = [
  fictionMapKind,
  estimateKind,
  analysisKind,
  slideKind,
  whiteboardKind,
  designKind,
  codeKind,
  dataKind,
];

export interface OfficeConnections {
  /** Checks an Estimate's CAD/BIM quantities before it is stored or loaded. */
  verifyEstimate(artifact: Artifact<unknown>): Promise<void>;
}

const local = { undo: true, nativeJson: true, shared: false } as const;

export function officeKinds({ verifyEstimate }: OfficeConnections) {
  const { kind: _kind, validate: _validate, ...fictionMap } = fictionMapHostAdapter;
  return [
    artifactKind(fictionMapKind, {
      adapter: fictionMap,
      parseNative: (text) => parseFictionMapArtifact(text) as Promise<Artifact<HostContent>>,
    }),
    artifactKind(estimateKind, {
      label: '見積・積算',
      adapter: {
        preflight: verifyEstimate,
        capabilities: { ...local, formats: [], preview: 'none', proposals: true },
      },
    }),
    artifactKind(analysisKind, {
      label: '計算・分析ノート',
      adapter: {
        preflight: verifyAnalysisArtifact,
        capabilities: { ...local, formats: [], preview: 'none', proposals: true },
      },
    }),
    artifactKind(slideKind, {
      label: 'Slide',
      // This reference Host provides static SVG export and saved-page previews only.
      accepts: isStaticSlide,
      adapter: {
        capabilities: { ...local, formats: ['svg'], preview: 'none' },
        async export(_format, c) {
          if (!isStaticSlide(c))
            throw Error('このHostは Animation を含む Slide に対応していません。');
          return c.slides.map((s) => ({ filename: s.id + '.svg', text: exportSlideSvg(c, s) }));
        },
      },
    }),
    artifactKind(whiteboardKind, {
      label: 'Whiteboard',
      adapter: {
        capabilities: { ...local, formats: ['svg'], preview: 'none' },
        async export(_format, c) {
          if (!isWhiteboard(c)) throw Error('Not Whiteboard');
          return exportWhiteboardSvg(c);
        },
      },
    }),
    artifactKind(designKind, {
      label: 'React / Design',
      adapter: {
        capabilities: { ...local, formats: ['react'], preview: 'host-isolated' },
        async export(_format, c) {
          if (!isDesignWithPaths(c)) throw Error('Not Design');
          return exportDesignReact(c, nativeResolution);
        },
      },
    }),
    artifactKind(codeKind, {
      label: 'Code (Host拡張)',
      adapter: {
        capabilities: { ...local, formats: ['tsx'], preview: 'host-isolated' },
        async export(_format, c) {
          if (!isCode(c)) throw Error('Not Code');
          return c.source;
        },
      },
    }),
    artifactKind(dataKind, {
      label: 'Data / Kanban',
      // Older readable schemas are not opened here; this Host edits the current one.
      accepts: isStructuredData,
      adapter: {
        capabilities: { ...local, formats: ['csv'], preview: 'none' },
        async export(_format, c) {
          if (!isStructuredData(c)) throw Error('Not Data');
          return exportCsv(c);
        },
      },
    }),
  ];
}
