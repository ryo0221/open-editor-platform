import { canonicalJson } from '@editor-platform/artifact-core';
import { FileSurface, isFile, remapFileAnnotation } from '@editor-platform/review-surfaces';
import { fileKind } from '@editor-platform/review-surfaces/kind';
import { storage } from '../../app/records';
import { createLocalSession, makeArtifact } from '../../model';
import { hostKind, type HostSurfaceProps, type KindContent } from '../host-kind';
import { latestRecord } from '../surface-host';
import { downloadFile } from '../../model';

function FileHost({ host, content }: HostSurfaceProps<KindContent<typeof fileKind>>) {
  const { active, readOnly } = host;
  return (
    <FileSurface
      onViewSettingsChange={(patch) => host.editPrivateSettings(active.id, patch)}
      viewSettings={
        host.templateViewSettings[active.id] as {
          fit?: 'page' | 'width' | 'actual';
          zoom?: number;
        }
      }
      content={content}
      onSelectionClear={() => host.selectNow([])}
      onOpenAsNew={async (source) => {
        if (readOnly || host.sharedSession || !host.flushInputs())
          throw new Error('現在は新しい成果物を作成できません。入力・権限を確認してください。');
        const artifact = makeArtifact(
          'file',
          host.records.filter((record) => record.kind === 'file').length + 1,
        );
        artifact.name = source.name;
        artifact.draft.content = source;
        const stored = await storage.putIfAbsent(artifact);
        host.sessions.current.set(stored.id, createLocalSession(stored.draft.content));
        host.persist(stored);
        host.activate(stored.id);
      }}
      onRemapAnnotation={(id, fileId, region) => {
        if (readOnly) return;
        const latest = latestRecord(host)!;
        if (
          !isFile(latest.draft.content) ||
          latest.draft.content.id !== fileId ||
          !host.selection.addresses.some(
            (address) =>
              address.elementId === fileId &&
              canonicalJson(address.region) === canonicalJson(region),
          )
        ) {
          host.setError('現在の原本で対象を選び直してください。');
          return;
        }
        try {
          host.persist({
            ...latest,
            annotations: latest.annotations.map((annotation) =>
              annotation.id === id
                ? remapFileAnnotation(annotation, {
                    artifactId: active.id,
                    elementId: fileId,
                    region,
                  })
                : annotation,
            ),
          });
        } catch (error) {
          host.setError(String(error instanceof Error ? error.message : error));
        }
      }}
      readOnly={readOnly || !!host.sharedSession}
      execute={host.execute}
      select={host.select}
      annotations={active.annotations}
      focusAddress={host.revealAddress}
    />
  );
}

export const fileSurface = hostKind(fileKind, {
  Surface: FileHost,
  hooks: { exports: { download: downloadFile } },
});
