// The Artifact Host's office Surfaces. They load eagerly; Estimate's CAD/BIM reading arrives as
// an argument from kinds/surfaces.tsx so this list never imports engineering code.
import type { GeometryQuantitySources } from '@editor-platform/calculation-core';
import type { ArtifactEditor } from '@editor-platform/editor-host';
import { analysisKind } from '@editor-platform/analysis/kind';
import { estimateKind } from '@editor-platform/estimate/kind';
import { fictionMapKind } from '@editor-platform/fiction-map/kind';
import { FictionMapArtifactSurface } from '@editor-platform/fiction-map/artifact-surface';
import '@editor-platform/fiction-map/styles.css';
import {
  undoFictionMap,
  redoFictionMap,
  type FictionMapSession,
  type FictionMapContent,
} from '@editor-platform/fiction-map/model';
import { slideKind } from '@editor-platform/slide/kind';
import { whiteboardKind } from '@editor-platform/whiteboard/kind';
import { WhiteboardSurface } from '@editor-platform/whiteboard';
import { isWhiteboard } from '@editor-platform/whiteboard/model';
import { dataKind } from '@editor-platform/structured-data/kind';
import { DataSurface } from '@editor-platform/structured-data';
import { isStructuredData } from '@editor-platform/structured-data/model';
import { domainExecute } from '../../model';
import { isStaticSlide } from '../../content';
import { codeKind } from '../code';
import { artifactSurface } from '../surface-kind';
import { ArtifactAnalysis } from './analysis';
import { ArtifactEstimate } from './estimate';
import { SlideView, SavedSlidePreview } from './slide';
import { designSurface } from './design';
import { CodeView } from './code';

export interface OfficeSurfaceConnections {
  /** CAD/BIM quantity reading for Estimate, from the Host's engineering connection. */
  estimateGeometry: GeometryQuantitySources | undefined;
}

export function officeSurfaces({ estimateGeometry }: OfficeSurfaceConnections) {
  return [
    artifactSurface(fictionMapKind, {
      opens: 'any',
      Surface: ({ host, env }) => (
        <FictionMapArtifactSurface
          host={host as unknown as ArtifactEditor<FictionMapContent>}
          onError={env.onError}
        />
      ),
      history(host, direction) {
        const session = host as unknown as FictionMapSession;
        const r = (direction === 'undo' ? undoFictionMap : redoFictionMap)(
          session,
          () => !host.readOnly,
        );
        if (!r.ok) throw Error(r.diagnostic.code);
      },
    }),
    artifactSurface(estimateKind, {
      opens: 'any',
      Surface: ({ host, env }) => (
        <ArtifactEstimate
          host={host}
          artifacts={env.artifacts}
          storage={env.storage}
          onCreated={env.onCreated}
          geometry={estimateGeometry}
        />
      ),
    }),
    artifactSurface(analysisKind, {
      opens: 'any',
      Surface: ({ host, env }) => (
        <ArtifactAnalysis
          host={host}
          artifacts={env.artifacts}
          storage={env.storage}
          onCreated={env.onCreated}
        />
      ),
    }),
    artifactSurface(slideKind, {
      // This Host opens static decks only (no animation or embedded Artifacts).
      accepts: isStaticSlide,
      Surface: SlideView,
      ListPreview: SavedSlidePreview,
    }),
    artifactSurface(whiteboardKind, {
      Surface: ({ host, content, readOnly, env }) => (
        <WhiteboardSurface
          content={content}
          readOnly={readOnly}
          execute={domainExecute(host, isWhiteboard)}
          select={env.select}
          layout={env.layout}
        />
      ),
    }),
    designSurface,
    artifactSurface(codeKind, {
      Surface: ({ host, env }) =>
        env.codeSurface ? (
          env.codeSurface(host)
        ) : (
          <CodeView host={host} previewDocument={env.previewDocument} />
        ),
      surfaceClass: ({ codeSurface }) =>
        codeSurface ? 'host-surface host-custom-code' : 'host-surface',
    }),
    artifactSurface(dataKind, {
      // The current schema only; older readable data is upgraded elsewhere.
      accepts: isStructuredData,
      Surface: ({ host, content, readOnly, env }) => (
        <DataSurface
          content={content}
          readOnly={readOnly}
          execute={domainExecute(host, isStructuredData)}
          select={(id, region) => env.select([id], region)}
          layout={env.layout}
        />
      ),
    }),
  ];
}
