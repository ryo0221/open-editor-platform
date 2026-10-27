import {
  canonicalJson,
  createArtifact,
  createArtifactIfAbsent,
  commitVersion,
  newId,
} from '@editor-platform/artifact-core';
import { isStructuredData } from '@editor-platform/structured-data/model';
import { isEstimate } from '@editor-platform/estimate-core';
import {
  initialWorkPublication,
  proposeWorkPublication,
  applyWorkPublication,
  type WorkPublicationHost,
  type WorkPublicationReceipt,
} from '@editor-platform/estimate/outputs';
import type { EstimatePort } from '@editor-platform/estimate';
import type { SurfaceHost } from './editor-surfaces';
import { createLocalSession, type StoredArtifact } from '../model';
import { storage, editedDraft } from './records';
interface Ledger {
  receipt?: WorkPublicationReceipt;
  pending?: { targetArtifactId: string; requestId: string; basisHash: string };
}
/** Reference Host receipt: independent from Estimate/Data native content and their Undo stacks. */
export function estimateWorkPublication(
  read: () => SurfaceHost,
  port: EstimatePort,
): WorkPublicationHost {
  const key = () => `ep-estimate-publication:${read().active.id}`;
  const ledger = (): Ledger => JSON.parse(localStorage.getItem(key()) ?? '{}');
  const write = (value: Ledger) => localStorage.setItem(key(), JSON.stringify(value));
  return {
    async prepare(calculation) {
      port.flush();
      const host = read(),
        sourceId = host.active.id,
        revision = port.revision(),
        generation = port.generation();
      const guard = () => {
        if (
          read().active.id !== sourceId ||
          !port.canEdit() ||
          !port.inputsReady() ||
          read().shared ||
          revision !== port.revision() ||
          generation !== port.generation()
        )
          throw Error('工程公開中に見積・入力・権限が変わりました。');
        for (const s of port.read().retainedSources)
          if (!port.canRead(s.pin)) throw Error('source-access-denied');
      };
      guard();
      const saved = host.savedRecords.current.get(sourceId);
      if (
        !saved?.versions.some(
          (v) =>
            isEstimate(v.content) &&
            v.content.calculations.some((c) => canonicalJson(c) === canonicalJson(calculation)),
        )
      )
        throw Error('見積を保存してから工程を公開してください。');
      const beforeLedger = ledger(),
        receipt = beforeLedger.receipt;
      if (receipt && receipt.sourceArtifactId !== sourceId)
        throw Error('publication-receipt-source-mismatch');
      if (receipt) {
        const previous = saved!.versions
          .flatMap((v) => (isEstimate(v.content) ? v.content.calculations : []))
          .find((c) => c.basisHash === receipt.basisHash);
        if (
          !previous ||
          canonicalJson(
            initialWorkPublication(sourceId, receipt.targetArtifactId, receipt.requestId, previous)
              .receipt.rows,
          ) !== canonicalJson(receipt.rows)
        )
          throw Error('publication-receipt-basis-mismatch');
      }
      if (beforeLedger.pending && beforeLedger.pending.basisHash !== calculation.basisHash)
        throw Error('前回の工程公開が未完了です。同じ計算で再試行してください。');
      const targetId =
        receipt?.targetArtifactId ??
        beforeLedger.pending?.targetArtifactId ??
        `estimate-work:${sourceId}`;
      if (!receipt && !beforeLedger.pending && (await storage.get(targetId)))
        throw Error('工程公開receiptがありません。既存Dataを推測して再同期しません。');
      guard();
      const requestId = beforeLedger.pending?.requestId ?? newId('work-publication');
      const target = host.recordsRef.current.find((a) => a.id === targetId),
        session = host.sessions.current.get(targetId);
      const current = session?.content ?? target?.draft.content;
      if (receipt && (!target || !current || !isStructuredData(current)))
        throw Error('公開先Dataまたはreceiptの対応がありません。推測して再作成しません。');
      const initial = initialWorkPublication(sourceId, targetId, requestId, calculation);
      const proposal =
        receipt && current && isStructuredData(current)
          ? proposeWorkPublication(current, receipt, calculation, requestId)
          : undefined;
      const expected = current && isStructuredData(current) ? structuredClone(current) : undefined;
      const targetRevision = session ? canonicalJson(session.revision) : undefined;
      return {
        targetArtifactId: targetId,
        changes: proposal
          ? proposal.changes.map((c) => `${c.kind}: ${c.taskId}`)
          : [`新規工程Data: ${initial.content.rows.length}行`],
        conflicts: proposal?.conflicts.map((c) => `${c.taskId} / ${c.fieldId}: ${c.reason}`) ?? [],
        async apply() {
          guard();
          if (canonicalJson(ledger()) !== canonicalJson(beforeLedger))
            throw Error('publication-receipt-changed');
          if (proposal?.conflicts.length) throw Error('publication-conflict');
          const live = read(),
            liveSession = live.sessions.current.get(targetId);
          if (
            expected &&
            (!liveSession ||
              canonicalJson(liveSession.content) !== canonicalJson(expected) ||
              (targetRevision !== undefined &&
                canonicalJson(liveSession.revision) !== targetRevision))
          )
            throw Error('stale-publication');
          write({
            ...beforeLedger,
            pending: { targetArtifactId: targetId, requestId, basisHash: calculation.basisHash },
          });
          try {
            if (proposal && expected && target && liveSession) {
              const command = applyWorkPublication(expected, proposal, () => {
                try {
                  guard();
                  return true;
                } catch {
                  return false;
                }
              });
              const draft = editedDraft(
                read().recordsRef.current.find((a) => a.id === targetId)!,
                proposal.content,
              );
              const committed = await commitVersion(
                draft,
                'local-user',
                'Estimate work publication',
              );
              guard();
              if (
                canonicalJson(liveSession.content) !== canonicalJson(expected) ||
                (targetRevision !== undefined &&
                  canonicalJson(liveSession.revision) !== targetRevision)
              )
                throw Error('stale-publication');
              if (canonicalJson(expected) !== canonicalJson(proposal.content))
                liveSession.execute({
                  ...command,
                  apply: (value) => {
                    if (!isStructuredData(value)) throw Error('Wrong publication domain');
                    return command.apply(value);
                  },
                });
              if (
                (await live.persist({ ...draft, ...committed, annotations: draft.annotations })) !==
                true
              )
                throw Error(
                  '見積保存済み・Dataは変更済みですが保存未完了です。同じ計算で再試行してください。',
                );
            } else {
              const created = await commitVersion(
                {
                  ...createArtifact('data', '見積から公開した工程', initial.content),
                  id: targetId,
                },
                'local-user',
                'Estimate work publication',
              );
              guard();
              const stored = await createArtifactIfAbsent(
                storage,
                { ...created, annotations: [] },
                canonicalJson(initial.content),
                (a) => canonicalJson(a.draft.content),
              );
              guard();
              if ((await live.persist(stored as StoredArtifact)) !== true)
                throw Error('Data作成済み・一覧への保存未完了です。同じ計算で再試行してください。');
              if (!live.sessions.current.has(targetId))
                live.sessions.current.set(targetId, createLocalSession(stored.draft.content));
            }
            guard();
            write({ receipt: proposal?.receipt ?? initial.receipt });
          } catch (error) {
            throw Error(`工程公開は未完了です。見積・DataのUndoは連動しません。${String(error)}`);
          }
        },
      };
    },
    openTarget() {
      const value = ledger(),
        id = value.receipt?.targetArtifactId ?? value.pending?.targetArtifactId;
      if (!id) throw Error('工程はまだ公開されていません。');
      read().activate(id);
    },
  };
}
