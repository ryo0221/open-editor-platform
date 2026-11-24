import { fictionMapKind } from '@editor-platform/fiction-map/kind';
import { PlaygroundFictionMap } from '../../fiction-map/host';
import { hostKind } from '../host-kind';
import { verifyFictionMapArtifact } from '@editor-platform/fiction-map/host';
import {
  undoFictionMap,
  redoFictionMap,
  type FictionMapContent,
  type FictionMapSession,
} from '@editor-platform/fiction-map/model';

export const fictionMapSurface = hostKind(fictionMapKind, {
  Surface: PlaygroundFictionMap,
  hooks: {
    history({ session, direction, pending, canEdit }) {
      if (pending.dirty || pending.composing)
        return { refused: 'Apply or cancel Fiction Map input before history.' };
      const step = (direction === 'undo' ? undoFictionMap : redoFictionMap)(
        session as unknown as FictionMapSession,
        canEdit,
      );
      if (!step.ok) return { refused: step.diagnostic.code };
      if (!step.value.changed) return { unchanged: true };
      return { content: step.value.content as FictionMapContent };
    },
    beforeVersion: verifyFictionMapArtifact,
    nativeReuse: () => false,
  },
});
