import { analysisKind } from '@editor-platform/analysis/kind';
import { PlaygroundAnalysis } from '../../app/analysis-host';
import { hostKind } from '../host-kind';

export const analysisSurface = hostKind(analysisKind, {
  Surface: PlaygroundAnalysis,
  hooks: {
    comments: false,
  },
});
