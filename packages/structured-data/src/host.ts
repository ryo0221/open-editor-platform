/** Host ports for reading external tables and work items into Structured Data
 * (docs/external-sources/editor-host-contract.md). Types and pure helpers only. The Host
 * resolves principals, permissions and providers; handles are not proof of permission, and
 * nothing read here enters native Data content unless a person imports it explicitly. */

export interface ExternalSourceNotice {
  kind: 'changed' | 'revoked';
  sourceHandle?: string;
}

/** One cell as the provider gave it. Dates stay provider values; the Editor types them. */
export type ExternalCellValue = string | number | boolean | null;

export interface TableSourceInfo {
  /** Opaque Host handle for one registered (spreadsheet, range) of the current principal. */
  handle: string;
  label: string;
  provider: string;
  account: string;
  /** The registered range as plain text, e.g. "Budget!A1:D20". */
  range: string;
}
export interface TableRead {
  sourceHandle: string;
  /** Connection generation; a read from an older generation is never shown. */
  generation: string;
  /** The range the provider resolved and returned. */
  resolvedRange: string;
  /** formatted: provider display strings, which depend on its locale. */
  valueRender: 'unformatted' | 'formatted';
  /** false when the Host cut rows at its limit. Rows past the cut are unknown, not empty. */
  complete: boolean;
  /** Row-major, each row padded to `columnCount` with null. */
  rows: ExternalCellValue[][];
  columnCount: number;
  fetchedAt: number;
}
export interface TableReadPort {
  listSources(signal: AbortSignal): Promise<TableSourceInfo[]>;
  readTable(request: { sourceHandle: string }, signal: AbortSignal): Promise<TableRead>;
  /** Change or revocation signals only; never content or commands. */
  watch?(notify: (notice: ExternalSourceNotice) => void): () => void;
}

export interface WorkItemSourceInfo {
  /** Opaque Host handle for one repository or project the current principal may read. */
  handle: string;
  label: string;
  provider: string;
  account: string;
  /** Owner/name when listed. A rename changes it; the handle stays bound to the same resource. */
  container: string;
}
/** One issue or pull request as read at `fetchedAt`: a copy, not a past version. */
export interface WorkItem {
  kind: 'issue' | 'pullRequest';
  id: string;
  number: number;
  /** Untrusted plain text. */
  title: string;
  state: 'open' | 'closed' | 'merged';
  stateReason: 'completed' | 'notPlanned' | 'reopened' | 'duplicate' | null;
  draft: boolean;
  /** Shown as text. The Editor never fetches or opens it on its own. */
  url: string | null;
  author: string | null;
  labels: { name: string; color: string }[];
  /** false when the Host's limit left labels out. */
  labelsComplete: boolean;
  assignees: string[];
  assigneesComplete: boolean;
  milestone: { title: string; dueOn: string | null } | null;
  /** ISO 8601 provider times. */
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
}
export interface WorkItemsRead {
  sourceHandle: string;
  /** Connection generation; a read from an older generation is never shown. */
  generation: string;
  container: string;
  /** false when a page failed or a rate limit stopped the read. Missing items are unknown. */
  complete: boolean;
  fetchedAt: number;
  /** Deletions and transfers are reflected only up to this time. */
  fullReconciledAt: number;
  items: WorkItem[];
}
export interface WorkItemReadPort {
  listSources(signal: AbortSignal): Promise<WorkItemSourceInfo[]>;
  readWorkItems(request: { sourceHandle: string }, signal: AbortSignal): Promise<WorkItemsRead>;
  /** Change or revocation signals only; never content or commands. */
  watch?(notify: (notice: ExternalSourceNotice) => void): () => void;
}
