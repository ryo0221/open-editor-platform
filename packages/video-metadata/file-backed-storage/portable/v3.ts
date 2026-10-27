/** Native Animation snapshots are inline exact-version content, not media originals or migration ancestry. */
import { assertFontInterpretationV3 } from '../../host-visual/fixed-font';
import { assertVideoContentV3, type VideoContentV3 } from '@editor-platform/video-core';
import {
  assertImageInterpretationV3,
  type VisualImportSetV3,
} from '../../host-visual/image-source';
import { prepareAnimationTimelineV3 } from '../../host-animation/timeline-v3';
import type { ProjectProfile } from './project';
import { v2Profile } from './v2';
export const v3Profile: ProjectProfile<VideoContentV3, VisualImportSetV3> = {
  validatePlan(plan) {
    if (plan?.profile === 'font-v3') assertFontInterpretationV3(plan);
    else if (plan?.profile === 'image-v3') assertImageInterpretationV3(plan);
    else v2Profile.validatePlan(plan);
  },
  validateSource(source, plan) {
    if (plan.profile === 'font-v3') {
      assertFontInterpretationV3(plan);
      if (
        !('kind' in source) ||
        source.kind !== 'font' ||
        source.fontProfile !== plan.fontProfile ||
        source.weight !== plan.weight
      )
        throw Error('Font interpretation/native mismatch');
      return;
    }
    if (plan.profile !== 'image-v3') {
      if ('kind' in source) throw Error('Image requires image interpretation');
      return v2Profile.validateSource(source, plan);
    }
    assertImageInterpretationV3(plan);
    if (
      !('kind' in source) ||
      source.kind !== 'image' ||
      source.mime !== plan.mime ||
      source.width !== plan.width ||
      source.height !== plan.height ||
      source.orientation !== plan.orientation
    )
      throw Error('Image interpretation/native mismatch');
  },
  format: 'video-file-zip64-candidate-v3',
  validateHistory(contents) {
    const identities = new Map<string, string>();
    for (const content of contents) assertVideoContentV3(content, identities);
  },
  assertContent(value): asserts value is VideoContentV3 {
    assertVideoContentV3(value);
    prepareAnimationTimelineV3(value);
  },
};
