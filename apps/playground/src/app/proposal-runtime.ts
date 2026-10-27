import {
  command,
  withCommandReads,
  type EditorCommand,
  type ExternalOperationRequest,
  type ProposalDiffAdapter,
  type ProposedCommands,
} from '@editor-platform/editor-core';
import { documentProposalDiff, isDocument } from '@editor-platform/document';
import {
  dataProposalDiff,
  defaultView,
  isStructuredData,
  moveDates,
  setCell,
  utcDay,
  type StructuredData,
} from '@editor-platform/structured-data';
import { isWhiteboard, transformNodes, whiteboardProposalDiff } from '@editor-platform/whiteboard';
import { mockExternalRuntime, type Content } from '../model';

/** Domains whose proposals the Playground reviews as semantic changes. */
export function proposalAdapter(content: Content): ProposalDiffAdapter<Content> | undefined {
  const adapter = isDocument(content)
    ? documentProposalDiff
    : isStructuredData(content)
      ? dataProposalDiff
      : isWhiteboard(content)
        ? whiteboardProposalDiff
        : undefined;
  return adapter as ProposalDiffAdapter<Content> | undefined;
}
export const proposalSupported = (content: Content | undefined) =>
  !!content && !!proposalAdapter(content);

const reading = <T>(c: EditorCommand<T>, ids: string[]) =>
  withCommandReads(c, { content: ids }) as EditorCommand<Content>;

function dataCommands(data: StructuredData, rowId: string): EditorCommand<StructuredData>[] {
  const row = data.rows.find((r) => r.id === rowId)!;
  const commands: EditorCommand<StructuredData>[] = [];
  const status = data.columns.find((c) => c.type === 'select' && c.options?.length && !c.readOnly);
  if (status) {
    const options = status.options!,
      next = options[(options.indexOf(String(row.values[status.id] ?? '')) + 1) % options.length];
    commands.push(setCell(row.id, status.id, next));
  }
  const timeline = (data.views?.find((v) => v.projection === 'Timeline') ?? defaultView(data))
    .timeline;
  const start = utcDay(String(row.values[timeline.start] ?? '')),
    end = utcDay(String(row.values[timeline.end] ?? ''));
  const writable = (id: string) =>
    data.columns.some((c) => c.id === id && c.type === 'date' && !c.readOnly);
  if (
    timeline.start !== timeline.end &&
    writable(timeline.start) &&
    writable(timeline.end) &&
    start !== null &&
    end !== null
  )
    commands.push(moveDates(data, row.id, timeline, start + 7, end + 7));
  if (!commands.length) throw new Error('This record has no status or period to change');
  return commands;
}

/**
 * The Host's deterministic runtime. Document: uppercase the selection. Data: advance the
 * selected record's status and move its period a week. Whiteboard: move the selection.
 */
export function mockProposal(
  request: ExternalOperationRequest,
  content: Content,
): ProposedCommands<Content> {
  const ids = request.selection?.addresses.map((a) => a.elementId) ?? [];
  const proposal = (summary: string, commands: EditorCommand<Content>[]) => ({
    id: crypto.randomUUID(),
    baseLocalRevision: request.liveRevision,
    reads: { target: request.artifact, references: [] },
    source: 'Playground deterministic runtime',
    summary,
    commands,
  });
  if (isDocument(content)) {
    const value = mockExternalRuntime(request, content);
    return {
      ...value,
      reads: { target: request.artifact, references: [] },
      commands: value.commands.map((c) => reading(c, ids)),
    };
  }
  if (isStructuredData(content)) {
    const rowId = ids.find((id) => content.rows.some((r) => r.id === id)) ?? content.rows[0]?.id;
    if (!rowId) throw new Error('Add a record first');
    return proposal(
      'Advance the record status and move its period by one week.',
      dataCommands(content, rowId).map((c) => reading(c, [rowId])),
    );
  }
  if (isWhiteboard(content)) {
    const nodes = ids.filter((id) => content.nodes.some((n) => n.id === id));
    if (!nodes.length) throw new Error('Select a whiteboard item first');
    return proposal('Move the selected items 80 px right and 40 px down.', [
      reading(transformNodes(nodes, { dx: 80, dy: 40, dw: 0, dh: 0 }), nodes),
    ]);
  }
  return proposal('Unsupported editor', [command('external.none', 'No change', (c) => c)]);
}
