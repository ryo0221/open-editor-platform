/** Deterministic mock Hosts for external tables and work items: tests and the reference Host
 * only. Synthetic data: no network, no credentials, no real people or repositories. They prove
 * Editor reactions, not provider behavior; real connections belong in a real Host. */
import type {
  ExternalSourceNotice,
  TableRead,
  TableReadPort,
  TableSourceInfo,
  WorkItem,
  WorkItemReadPort,
  WorkItemSourceInfo,
  WorkItemsRead,
} from './host';

/** Test controls. A real Host has none of these. */
export interface MockSourceControls {
  /** false: the read stops part-way and says so. */
  setComplete(complete: boolean): void;
  failReads(fail: boolean): void;
  /** Hold the next reads until released, to deliver them late. */
  holdReads(hold: boolean): void;
  releaseReads(): void;
  /** The provider changed: later reads return the edited content. */
  changeSource(): void;
  switchAccount(): void;
  readonly calls: { list: number; read: number };
}

/** Account, edition and delivery state shared by both mocks. */
function mockConnection(prefix: string) {
  const state = { complete: true, fail: false, hold: false, account: 1, edition: 1 };
  const calls = { list: 0, read: 0 };
  const held: (() => void)[] = [];
  const watchers = new Set<(notice: ExternalSourceNotice) => void>();
  const notify = (notice: ExternalSourceNotice) => watchers.forEach((w) => w(notice));
  const handle = () => `${prefix}-${state.account}`;
  return {
    state,
    calls,
    handle,
    /** Answers a read the way the Host would, late when held. */
    deliver<T>(sourceHandle: string, signal: AbortSignal, respond: (generation: string) => T) {
      calls.read++;
      // Checked when asked: a held read answers late with the generation it started in.
      const generation = String(state.account),
        connected = sourceHandle === handle();
      return new Promise<T>((resolve, reject) => {
        const finish = () =>
          signal.aborted
            ? reject(new DOMException('Aborted', 'AbortError'))
            : !connected
              ? reject(new Error('This source is no longer connected.'))
              : state.fail
                ? reject(new Error('The source could not be read.'))
                : resolve(respond(generation));
        if (state.hold) held.push(finish);
        else queueMicrotask(finish);
      });
    },
    watch(listener: (notice: ExternalSourceNotice) => void) {
      watchers.add(listener);
      return () => void watchers.delete(listener);
    },
    controls: {
      setComplete: (value) => void (state.complete = value),
      failReads: (value) => void (state.fail = value),
      holdReads: (value) => void (state.hold = value),
      releaseReads: () => held.splice(0).forEach((finish) => finish()),
      changeSource() {
        state.edition++;
        notify({ kind: 'changed', sourceHandle: handle() });
      },
      switchAccount() {
        state.account++;
        notify({ kind: 'revoked' });
      },
      calls,
    } satisfies MockSourceControls,
  };
}

export interface MockTableHost {
  read: TableReadPort;
  controls: MockSourceControls;
}

const tableRows = (edition: number): TableRead['rows'] => [
  ['Item', 'Owner', 'Budget', 'Approved', 'Due (serial)'],
  ['Survey (synthetic)', 'Team A', 1200, true, 46322],
  ['Pilot <script>x</script> (synthetic)', 'Team B', edition === 1 ? 800 : 950, false, 46350],
  ['Report (synthetic)', null, null, null, null],
  ['Review (synthetic)', 'Team A', 300, true, 46400],
];

export function createMockTableHost(): MockTableHost {
  const connection = mockConnection('mock-sheet');
  const { state } = connection;
  const sources = (): TableSourceInfo[] => [
    {
      handle: connection.handle(),
      label: 'Project budget (synthetic)',
      provider: 'Mock spreadsheet',
      account: `account ${state.account} (synthetic)`,
      range: 'Budget!A1:E20',
    },
  ];
  return {
    read: {
      async listSources() {
        connection.calls.list++;
        return sources();
      },
      readTable({ sourceHandle }, signal) {
        return connection.deliver(sourceHandle, signal, (generation): TableRead => {
          const rows = tableRows(state.edition);
          const shown = state.complete ? rows : rows.slice(0, 3);
          return {
            sourceHandle,
            generation,
            resolvedRange: state.complete ? 'Budget!A1:E5' : 'Budget!A1:E3',
            valueRender: 'unformatted',
            complete: state.complete,
            rows: structuredClone(shown),
            columnCount: 5,
            fetchedAt: Date.UTC(2026, 9, 26, 0, state.edition),
          };
        });
      },
      watch: connection.watch,
    },
    controls: connection.controls,
  };
}

export interface MockWorkItemHost {
  read: WorkItemReadPort;
  controls: MockSourceControls;
}

const item = (value: Partial<WorkItem> & Pick<WorkItem, 'kind' | 'id' | 'number' | 'title'>) =>
  ({
    state: 'open',
    stateReason: null,
    draft: false,
    url: null,
    author: 'author-a',
    labels: [],
    labelsComplete: true,
    assignees: [],
    assigneesComplete: true,
    milestone: null,
    createdAt: '2026-10-20T01:00:00Z',
    updatedAt: '2026-10-22T01:00:00Z',
    closedAt: null,
    mergedAt: null,
    ...value,
  }) satisfies WorkItem;

const workItems = (edition: number): WorkItem[] => [
  item({
    kind: 'issue',
    id: 'I_1',
    number: 1,
    title: 'Import fails on empty rows (synthetic)',
    labels: [{ name: 'bug', color: 'd73a4a' }],
    assignees: ['member-a'],
    milestone: { title: 'R1 (synthetic)', dueOn: '2026-11-30T00:00:00Z' },
    url: 'https://github.com/example/synthetic/issues/1',
  }),
  item({
    kind: 'pullRequest',
    id: 'PR_2',
    number: 2,
    title: 'Pad short rows <img src=x> (synthetic)',
    state: edition === 1 ? 'open' : 'merged',
    mergedAt: edition === 1 ? null : '2026-10-26T00:01:00Z',
    closedAt: edition === 1 ? null : '2026-10-26T00:01:00Z',
    draft: edition === 1,
    labels: Array.from({ length: 20 }, (_, i) => ({ name: `area-${i + 1}`, color: 'cccccc' })),
    labelsComplete: false,
  }),
  item({
    kind: 'issue',
    id: 'I_3',
    number: 3,
    title: 'Old question (synthetic)',
    state: 'closed',
    stateReason: 'notPlanned',
    closedAt: '2026-10-21T01:00:00Z',
    author: null,
  }),
  item({
    kind: 'issue',
    id: 'I_4',
    number: 4,
    title: 'Document the range format (synthetic)',
    assignees: ['member-a', 'member-b'],
  }),
];

export function createMockWorkItemHost(): MockWorkItemHost {
  const connection = mockConnection('mock-repo');
  const { state } = connection;
  const sources = (): WorkItemSourceInfo[] => [
    {
      handle: connection.handle(),
      label: 'Synthetic repository',
      provider: 'Mock GitHub',
      account: `installation ${state.account} (synthetic)`,
      container: 'example/synthetic',
    },
  ];
  return {
    read: {
      async listSources() {
        connection.calls.list++;
        return sources();
      },
      readWorkItems({ sourceHandle }, signal) {
        return connection.deliver(sourceHandle, signal, (generation): WorkItemsRead => {
          const items = workItems(state.edition);
          return {
            sourceHandle,
            generation,
            container: 'example/synthetic',
            complete: state.complete,
            fetchedAt: Date.UTC(2026, 9, 26, 0, state.edition),
            fullReconciledAt: Date.UTC(2026, 9, 26, 0, 0),
            items: structuredClone(state.complete ? items : items.slice(0, 2)),
          };
        });
      },
      watch: connection.watch,
    },
    controls: connection.controls,
  };
}
