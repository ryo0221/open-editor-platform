import { fictionMapKind } from '@editor-platform/fiction-map/kind';
import { PlaygroundFictionMap } from '../../fiction-map/host';
import { hostKind } from '../host-kind';

export const fictionMapSurface = hostKind(fictionMapKind, {
  Surface: PlaygroundFictionMap,
  session: 'local',
});
