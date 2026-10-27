import { describe, expect, it } from 'vitest';
import { createMockTableHost } from '@editor-platform/structured-data/mock-host';
import { createSourceReader, type SourceReadState } from './reader';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup() {
  const mock = createMockTableHost();
  const states: SourceReadState<{ handle: string }, { generation: string }>[] = [];
  const reader = createSourceReader(
    {
      listSources: (s) => mock.read.listSources(s),
      read: (sourceHandle, s) => mock.read.readTable({ sourceHandle }, s),
      watch: mock.read.watch,
    },
    (state) => states.push(state),
  );
  return { mock, reader, states };
}

describe('external source reader', () => {
  it('lists sources, reads the selected one and keeps nothing after a failure', async () => {
    const { mock, reader } = setup();
    await flush();
    expect(reader.state().selected).toBe('mock-sheet-1');
    await reader.read();
    expect(reader.state()).toMatchObject({ status: 'ready', read: { generation: '1' } });
    mock.controls.failReads(true);
    await reader.read();
    expect(reader.state()).toMatchObject({ status: 'failed', read: undefined });
  });

  it('never shows a late answer from before a revocation', async () => {
    const { mock, reader } = setup();
    await flush();
    mock.controls.holdReads(true);
    const pending = reader.read();
    mock.controls.switchAccount();
    mock.controls.releaseReads();
    await pending;
    await flush();
    expect(reader.state()).toMatchObject({
      status: 'idle',
      read: undefined,
      selected: 'mock-sheet-2',
    });
    expect(reader.state().message).toMatch(/discarded/);
  });

  it('reads again after a change notice only when a result was shown', async () => {
    const { mock, reader } = setup();
    await flush();
    mock.controls.changeSource();
    expect(mock.controls.calls.read).toBe(0);
    await reader.read();
    mock.controls.changeSource();
    await flush();
    expect(mock.controls.calls.read).toBe(2);
    expect(reader.state()).toMatchObject({
      status: 'ready',
      message: expect.stringMatching(/changed/),
    });
  });

  it('drops an older read when a newer one is asked for', async () => {
    const { mock, reader } = setup();
    await flush();
    mock.controls.holdReads(true);
    const first = reader.read();
    mock.controls.holdReads(false);
    await reader.read();
    const shown = reader.state().read;
    mock.controls.releaseReads();
    await first;
    expect(reader.state().read).toBe(shown);
  });
});
