import type { MutableRefObject } from 'react';
import { canonicalJson } from '@editor-platform/artifact-core';
import { isDesignWithPaths, type DesignPageReviewHost } from '@editor-platform/design';
import { designPageProposalCommand } from '@editor-platform/design/page-proposals';
import type { EditorCommand } from '@editor-platform/editor-core';
import type { Content } from '../model';
import type { SurfaceHost } from './editor-surfaces';

/** The normal Host keeps authority/session reads live across preview and submission. */
export function designPageReviewHost(
  latest: MutableRefObject<SurfaceHost>,
  artifactId: string,
): DesignPageReviewHost {
  const current = () => {
    const host = latest.current;
    const session = host.sessions.current.get(artifactId);
    const record = host.recordsRef.current.find((r) => r.id === artifactId);
    const content = session?.content;
    if (!session || !record || !isDesignWithPaths(content))
      throw Error('Design draft is unavailable');
    return {
      artifactId,
      versionId: record.draft.baseVersionId,
      revision: session.revision,
      content,
      readOnly: host.readOnly || host.busy || host.shared || host.active.id !== artifactId,
      readReference(id: string) {
        const saved = host.savedRecords.current.get(id);
        const draft = host.sessions.current.get(id);
        if (!saved || !draft || host.loadErrors[id]) return { status: 'missing' as const };
        const version = saved.versions.find((v) => v.versionId === saved.draft.baseVersionId);
        if (!version || canonicalJson(draft.content) !== canonicalJson(version.content))
          return { status: 'changed' as const };
        return { status: 'available' as const, versionId: version.versionId };
      },
    };
  };
  return {
    current,
    flushInputs() {
      if (!latest.current.flushInputs()) throw Error('Finish or cancel pending input first');
    },
    accept(plan) {
      if (!latest.current.flushInputs()) throw Error('Finish or cancel pending input first');
      const cmd = designPageProposalCommand(plan, current);
      if (!latest.current.execute(cmd as EditorCommand<Content>))
        throw Error('Page proposal was not applied');
    },
  };
}
