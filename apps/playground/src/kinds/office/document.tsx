import { useEffect, useState, type ComponentProps } from 'react';
import { DocumentSurface, type DocumentContent } from '@editor-platform/document';
import { documentKind } from '@editor-platform/document/kind';
import { composeDocumentSequence } from '@editor-platform/document/sequence';
import type { EditorCommand } from '@editor-platform/editor-core';
import {
  novelNotationRules,
  readNovelChapters,
  readNovelGoal,
  readNovelWorkspace,
  writeNovelGoal,
  writeNovelWorkspace,
} from '../../app/novel-workspace';
import type { Content } from '../../model';
import { hostKind, type HostSurfaceProps, type KindContent } from '../host-kind';
import type { SurfaceHost } from '../surface-host';

function DocumentHost({ host, content }: HostSurfaceProps<KindContent<typeof documentKind>>) {
  const { active, sharedSession, sharedPreview, revealAddress } = host;
  const novel = useNovel(host);
  return (
    <DocumentSurface
      {...novel}
      references={sharedSession ? undefined : host.references}
      focusReferenceId={revealAddress?.elementId}
      textEngine={sharedPreview ? undefined : sharedSession?.text('text')}
      content={content}
      readOnly={host.readOnly}
      execute={host.execute}
      select={host.select}
      selectedId={host.selection.addresses[0]?.elementId}
      annotations={active.annotations}
      focusAddress={revealAddress}
    />
  );
}

/** Novel demo chapters open in the novel workspace; ordinary Documents keep their chrome. */
function useNovel(host: SurfaceHost): Partial<ComponentProps<typeof DocumentSurface>> {
  const { active, records } = host;
  const chapterIds = host.shared ? undefined : readNovelChapters(active.id);
  const [choice, setChoice] = useState<{ id: string; workspace: 'document' | 'novel' }>();
  const workspace = choice?.id === active.id ? choice.workspace : readNovelWorkspace(active.id);
  // The character goal is Host view state per chapter, like the workspace choice.
  const [goalChoice, setGoalChoice] = useState<{ id: string; goal: number | undefined }>();
  const goal = goalChoice?.id === active.id ? goalChoice.goal : readNovelGoal(active.id);
  // 通読 composes the saved version of every chapter in the Host's order; drafts stay out.
  const chapters = chapterIds?.map((id) => records.find((r) => r.id === id));
  const savedKey = chapters?.map((c) => `${c?.id}@${c?.draft.baseVersionId}`).join(',');
  const [reading, setReading] = useState<{
    key: string;
    content?: DocumentContent;
    problem?: string;
  }>();
  useEffect(() => {
    if (!chapters || !savedKey || workspace !== 'novel') return;
    let live = true;
    const missing = chapters.findIndex((c) => !c?.draft.baseVersionId);
    if (missing >= 0) {
      setReading({
        key: savedKey,
        problem: `通読を作れません: 第${missing + 1}章が見つからないか、保存されていません。`,
      });
      return;
    }
    composeDocumentSequence(
      chapters.map((c) => ({
        artifact: c as import('@editor-platform/artifact-core').Artifact<DocumentContent>,
        versionId: c!.draft.baseVersionId!,
      })),
      { references: host.references },
    ).then(
      (result) =>
        live &&
        setReading(
          result.content
            ? { key: savedKey, content: result.content }
            : {
                key: savedKey,
                problem: `通読を作れません: ${result.manifest.diagnostics
                  .filter((d) => d.severity === 'error')
                  .map((d) => d.message)
                  .join(' / ')}`,
              },
        ),
      (error) => live && setReading({ key: savedKey, problem: `通読を作れません: ${error}` }),
    );
    return () => {
      live = false;
    };
    // savedKey names every input that changes the read-through.
  }, [savedKey, workspace, host.references]);
  if (!chapterIds) return {};
  const current = reading?.key === savedKey ? reading : undefined;
  return {
    workspace,
    onWorkspaceRequest: (next) => {
      setChoice({ id: active.id, workspace: next });
      writeNovelWorkspace(active.id, next);
    },
    novel: {
      notationRules: novelNotationRules,
      goal,
      onGoalChange: (next) => {
        setGoalChoice({ id: active.id, goal: next });
        writeNovelGoal(active.id, next);
      },
      ...(current?.content
        ? {
            reading: {
              content: current.content,
              label: `保存した${chapterIds.length}章を章順に結合した通読です。`,
            },
          }
        : { readingUnavailable: current?.problem ?? '通読を準備しています。' }),
      onNotationProposal: ({ command, findings }) => {
        const session = host.sessions.current.get(active.id);
        if (!session || !active.draft.baseVersionId || !host.flushInputs()) return;
        host.reviewProposal({
          id: crypto.randomUUID(),
          baseLocalRevision: session.revision,
          reads: {
            target: { artifactId: active.id, versionId: active.draft.baseVersionId },
            references: [],
          },
          source: 'Playground notation dictionary',
          summary: `表記の直し（${findings.length}件）`,
          commands: [command as EditorCommand<Content>],
        });
      },
    },
  };
}

export const documentSurface = hostKind(documentKind, {
  Surface: DocumentHost,
  // A shared preview is its own Surface, so leaving it restores the confirmed text.
  surfaceKey: ({ active, sharedPreview }) =>
    sharedPreview ? `preview:${sharedPreview.id}:${sharedPreview.preview.token}` : active.id,
  hooks: { exports: { documentText: true } },
});
