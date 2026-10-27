import {
  BimIfcImportError,
  bimIfcImportLimits,
  readIfc,
  type BimIfcImportOptions,
  type BimIfcImportReport,
  type BimIfcImportResult,
} from '@editor-platform/bim-ifc';
export type { BimIfcImportReport, BimIfcPartSource } from '@editor-platform/bim-ifc';
import { Dialog } from '@editor-platform/editor-ui';
import './style.css';

/**
 * Importing an IFC file as a new building (docs/cad/r2c-architecture.md, IFC; R2c-U5, R2c-6):
 * the supported part becomes editable elements, and anything that would be lost is listed for
 * the user to confirm before the Host makes the Artifact. Hosts own the file picker and the new
 * Artifact; this reads the file and shows the report.
 */

/**
 * Reads an `.ifc` file. Refusals throw an Error whose message names the code and entities.
 * Elements without their follow relations (another program's file) are shown to the user like
 * a loss: they import, but stay put when a level or grid moves.
 */
export async function readBimIfcFile(
  file: Blob,
  options: BimIfcImportOptions = {},
): Promise<BimIfcImportResult> {
  if (file.size > bimIfcImportLimits.bytes) throw new Error('ifc-too-large');
  const bytes = new Uint8Array(await file.arrayBuffer());
  let result: BimIfcImportResult;
  try {
    result = readIfc(bytes, options);
  } catch (error) {
    if (error instanceof BimIfcImportError) throw new Error(error.message);
    throw error;
  }
  if (result.status === 'imported' && result.report.withoutFollow && !options.acceptLoss)
    return { status: 'needs-confirmation', report: result.report };
  return result;
}

/** Whether a file name is an IFC file's. */
export const isBimIfcFileName = (name: string) => /\.ifc$/i.test(name);

/** Losses shown one by one; the summary counts all of them. */
const listed = 50;

/** The loss report of an import that waits for the user. */
export function BimIfcLossDialog({
  fileName,
  report,
  onImport,
  onCancel,
}: {
  fileName: string;
  report: BimIfcImportReport;
  onImport(): void;
  onCancel(): void;
}) {
  return (
    <Dialog title="Import IFC" onClose={onCancel}>
      <div className="bim-ifc-report" data-testid="bim-ifc-report">
        {report.losses.length ? (
          <p>
            Some of <strong>{fileName}</strong> cannot be imported. Import the supported part as a
            new building?
          </p>
        ) : (
          <p>
            <strong>{fileName}</strong> has no follow relations: its elements stay where they are
            when a level or grid moves. Import it as a new building?
          </p>
        )}
        <ul>
          <li>Restored with their constraints: {report.restored}</li>
          <li>Imported at fixed heights and positions (no constraints): {report.withoutFollow}</li>
        </ul>
        {report.losses.length > 0 && (
          <>
            <table>
              <caption>Not imported</caption>
              <thead>
                <tr>
                  <th scope="col">Entity</th>
                  <th scope="col">Reason</th>
                  <th scope="col">Count</th>
                </tr>
              </thead>
              <tbody>
                {report.summary.map((s) => (
                  <tr key={`${s.entity}\u0000${s.reason}`}>
                    <td>{s.entity}</td>
                    <td>{s.reason}</td>
                    <td>{s.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <details>
              <summary>Entities ({report.losses.length})</summary>
              <ul>
                {report.losses.slice(0, listed).map((l, i) => (
                  <li key={i}>
                    {l.entity}
                    {l.name ? ` “${l.name}”` : ''}
                    {l.globalId ? ` ${l.globalId}` : ''} — {l.reason}
                  </li>
                ))}
                {report.losses.length > listed && <li>… {report.losses.length - listed} more</li>}
              </ul>
            </details>
          </>
        )}
        <div className="bim-ifc-actions">
          <button className="bim-button" onClick={onCancel}>
            Cancel
          </button>
          <button className="bim-button bim-primary" onClick={onImport}>
            {report.losses.length ? 'Import supported part' : 'Import'}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
