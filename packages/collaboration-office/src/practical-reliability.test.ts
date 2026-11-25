import { expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import {
  Authority,
  FaultAdapter,
  initial,
  localAdapter,
  type Principal,
  type Operation,
} from '@editor-platform/collaboration-core';
import {
  setCell,
  cellValue,
  validateData,
  type StructuredData,
} from '@editor-platform/structured-data';
import { SharedEditorSession, type EditorHostAdapter } from './editor-session';
import { dataEditorCodec } from './editor-transactions';

const person = (actorId: string): Principal => ({
  actorId,
  clientId: actorId,
  sessionId: actorId,
  writable: true,
  scopes: ['*'],
});
const input = (): StructuredData => ({
  schemaVersion: 2,
  columns: [
    { id: 'name', name: '課題', type: 'text', required: true },
    { id: 'mine', name: '件数', type: 'number' },
    { id: 'peer', name: '人Bの確認', type: 'text' },
    { id: 'double', name: '合計', type: 'formula', formula: '[mine] * 2' },
    { id: 'link', name: '関連', type: 'relation' },
  ],
  rows: Array.from({ length: 10 }, (_, i) => ({
    id: `row${i}`,
    values: { name: `課題 ${i}`, mine: 0, peer: '', link: `row${(i + 1) % 10}` },
  })),
});

for (const seed of [23, 41, 20261004])
  it(`QL seeded continued editing and recovery: ${seed}`, async () => {
    let random = seed;
    const next = (max: number) => {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      return random % max;
    };
    const authority = new Authority(
      dataEditorCodec,
      initial('seeded-ledger', dataEditorCodec, input()),
    );
    const actors = { A: person('A'), B: person('B') };
    const connect = async (
      actor: 'A' | 'B',
      checkpoint?: ReturnType<SharedEditorSession<StructuredData>['checkpoint']>,
    ) => {
      const base = localAdapter(authority, actors[actor]),
        faults = new FaultAdapter(base);
      const adapter = Object.assign(faults, {
        versions: async () => [],
        undo: async (id: string, redo?: boolean) => authority.undo(actors[actor], id, redo),
      }) as unknown as EditorHostAdapter<StructuredData>;
      const session = new SharedEditorSession(dataEditorCodec, adapter);
      if (checkpoint) session.resume(checkpoint);
      await session.open();
      return { session, faults, adapter };
    };
    let a = await connect('A');
    const b = await connect('B');
    const expectedMine = Array(10).fill(0) as number[],
      expectedPeer = Array(10).fill('') as string[];
    const events: Operation[] = [];
    const stop = authority.subscribe((e) => events.push(e.operation));
    const trace: unknown[] = [];
    let outcome = 'failed';
    const check = async () => {
      await a.session.sync();
      await b.session.sync();
      const state = authority.snapshot().content;
      expect(state.rows.map((r) => r.values.mine)).toEqual(expectedMine);
      expect(state.rows.map((r) => r.values.peer)).toEqual(expectedPeer);
      expect(state.rows.map((r) => r.values.link)).toEqual(input().rows.map((r) => r.values.link));
      expect(validateData(state)).toEqual([]);
      expect(state.rows.map((r) => cellValue(state, r, state.columns[3]))).toEqual(
        expectedMine.map((v) => v * 2),
      );
      expect(new Set(state.rows.map((r) => r.id)).size).toBe(10);
      expect(a.session.content).toEqual(state);
      expect(b.session.content).toEqual(state);
      expect(new Set(events.map((e) => e.operationId)).size).toBe(events.length);
      expect(authority.snapshot().revision).toBe(events.length);
    };
    try {
      for (let step = 0; step < 24; step++) {
        const row = next(10),
          peerRow = next(10),
          value = 1 + next(999),
          mode = step % 6;
        const before = expectedMine[row];
        trace.push({
          step,
          row,
          peerRow,
          value,
          mode: [
            'normal',
            'lost-ack',
            'offline',
            'duplicate-reordered-events',
            'held-submit',
            'checkpoint-resume',
          ][mode],
          before,
        });
        a.faults.dropAck = mode === 1;
        a.faults.duplicate = mode === 3;
        a.faults.hold = mode === 3;
        if (mode === 2 || mode === 5) a.faults.connected = false;
        let release: (() => void) | undefined;
        let reached: (() => void) | undefined;
        const submitting = new Promise<void>((resolve) => {
          reached = resolve;
        });
        const submit = a.adapter.submit.bind(a.adapter);
        if (mode === 4)
          a.adapter.submit = async (op) => {
            reached!();
            await new Promise<void>((resolve) => {
              release = resolve;
            });
            return submit(op);
          };
        a.session.execute(setCell(`row${row}`, 'mine', value));
        if (mode === 4) await submitting;
        else await a.session.flush();
        expectedPeer[peerRow] = `人B ${seed}/${step}`;
        b.session.execute(setCell(`row${peerRow}`, 'peer', expectedPeer[peerRow]));
        await b.session.flush();
        if (mode === 5) {
          let checkpoint!: ReturnType<typeof a.session.checkpoint>;
          a.session.suspend((value) => {
            checkpoint = JSON.parse(JSON.stringify(value));
          });
          expect(a.session.client.status).toBe('closed');
          a = await connect('A', checkpoint);
        } else {
          release?.();
          if (mode === 4) {
            await a.session.flush();
            a.adapter.submit = submit;
          }
          a.faults.connected = true;
          if (mode === 3) {
            a.faults.hold = false;
            a.faults.flush(true);
          }
        }
        await a.session.reconnect();
        expectedMine[row] = value;
        await check();
        a.session.execute(setCell(`row${row}`, 'mine', value + 1000));
        await a.session.flush();
        await Promise.all([a.session.history('undo'), a.session.history('undo')]);
        expectedMine[row] = before;
        await check();
        await Promise.all([a.session.history('redo'), a.session.history('redo')]);
        expectedMine[row] = value + 1000;
        await check();
        trace.push({
          step,
          expectedMine: [...expectedMine],
          expectedPeer: [...expectedPeer],
          acceptedRevision: authority.snapshot().revision,
        });
      }
      outcome = 'passed';
    } finally {
      stop();
      a.session.suspend(() => {});
      b.session.suspend(() => {});
      await mkdir('test-results-reliability', { recursive: true });
      await writeFile(
        `test-results-reliability/seed-${seed}.json`,
        JSON.stringify(
          {
            seed,
            outcome,
            trace,
            accepted: events.map((e) => ({
              actor: e.actorId,
              id: e.operationId,
              actions: e.actions,
            })),
          },
          null,
          2,
        ),
      );
    }
  });
