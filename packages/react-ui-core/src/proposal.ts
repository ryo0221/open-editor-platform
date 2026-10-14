import { canonicalJson, deepFreeze, clone } from '@editor-platform/artifact-core';
import { reuseHash } from '@editor-platform/reuse-core';
import { checkData, object, fields, array, hash, finite, reject } from './data';
import { loadReactUiDocument } from './document';
import { inspectReactUiDocument } from './preflight';
import { validateReactComponent, reactComponentKey } from './registration';
import type {
  ReactScreenProposal,
  ReactScreenshotAdapter,
  ReactRegistrationSourceAdapter,
  ReactRegistrationCandidate,
} from './adapters';
import { reactScreenProposalWidths } from './adapters';
import { reactUiLimits, type ReactUiDiagnostic, type ReactUiDocument } from './types';

/** Generic discovery boundary; reading candidates never adopts them into a document/catalog. */
export function readReactRegistrationCandidates(
  raw: unknown,
): Awaited<ReturnType<ReactRegistrationSourceAdapter['readCandidates']>> {
  checkData(raw);
  const source = object(raw, '$.source');
  fields(source, ['sourceRevision', 'candidates'], [], '$.source');
  if (
    typeof source.sourceRevision !== 'string' ||
    !source.sourceRevision.length ||
    source.sourceRevision.length > 512
  )
    reject(
      'source-revision',
      '$.source.sourceRevision',
      'A bounded exact source revision is required',
    );
  const candidates: ReactRegistrationCandidate[] = [],
    diagnostics: ReactUiDiagnostic[] = [];
  const seen = new Set<string>();
  array(source.candidates, '$.source.candidates', 128).forEach((raw, index) => {
    try {
      const component = validateReactComponent(raw),
        key = reactComponentKey(component.ref);
      if (seen.has(key)) throw new Error('Duplicate component version candidate');
      seen.add(key);
      candidates.push({
        kind: 'react-registration-candidate',
        sourceRevision: source.sourceRevision as string,
        review: 'unreviewed',
        proposed: component,
      });
    } catch (error) {
      diagnostics.push({
        code: 'registration-candidate',
        severity: 'error',
        path: `$.source.candidates[${index}]`,
        message: String(error).slice(0, 1024),
        recovery:
          'Correct or omit this candidate; Host/human review and exact runtime resolution are required before adoption.',
      });
    }
  });
  return { sourceRevision: source.sourceRevision, candidates, diagnostics };
}

/** JSON-only proposal: available without a screenshot/runtime adapter or TSX export. */
export function createReactScreenProposal(
  document: ReactUiDocument,
  externalReferences: ReactScreenProposal['externalReferences'],
): ReactScreenProposal {
  return validateReactScreenProposal({
    schemaVersion: 1,
    composition: document,
    externalReferences,
    screenshotWidths: reactScreenProposalWidths,
    screenshots: [],
  });
}
export function serializeReactScreenProposal(proposal: ReactScreenProposal): string {
  return canonicalJson(validateReactScreenProposal(proposal));
}
export function parseReactScreenProposal(text: string): ReactScreenProposal {
  if (new TextEncoder().encode(text).length > reactUiLimits.bytes)
    reject('data-limit', '$', 'Proposal JSON exceeds byte budget');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    reject('data-json', '$', 'Invalid screen proposal JSON');
  }
  return validateReactScreenProposal(value);
}
export function validateReactScreenProposal(raw: unknown): ReactScreenProposal {
  checkData(raw);
  const proposal = object(raw, '$.proposal');
  fields(
    proposal,
    ['schemaVersion', 'composition', 'externalReferences', 'screenshotWidths', 'screenshots'],
    [],
    '$.proposal',
  );
  if (proposal.schemaVersion !== 1)
    reject('proposal-version', '$.schemaVersion', 'Unsupported screen proposal version');
  if (canonicalJson(proposal.screenshotWidths) !== canonicalJson(reactScreenProposalWidths))
    reject('proposal-widths', '$.screenshotWidths', 'Expected fixed 390/1024/1400px widths');
  const document = loadReactUiDocument(proposal.composition);
  const inspection = inspectReactUiDocument(document);
  if (inspection.diagnostics.length)
    reject(
      'proposal-composition',
      '$.composition',
      'Resolve composition diagnostics before proposal export',
    );
  const externalReferences = proposal.externalReferences;
  checkData(externalReferences);
  for (const [index, raw] of array(externalReferences, '$.externalReferences', 128).entries()) {
    const reference = object(raw, `$.externalReferences[${index}]`);
    fields(reference, ['namespace', 'screenId'], ['stateId'], '$.externalReferences');
    for (const [key, value] of Object.entries(reference))
      if (typeof value !== 'string' || !value.length || value.length > 512)
        reject(
          'external-reference',
          `$.externalReferences[${index}].${key}`,
          'External identifiers are bounded opaque strings',
        );
  }
  const references = clone(externalReferences) as ReactScreenProposal['externalReferences'];
  if (!references.length)
    reject('external-reference', '$.externalReferences', 'Host must attach a screen reference');
  const screenshots = array(proposal.screenshots, '$.screenshots', 3);
  if (screenshots.length !== 0 && screenshots.length !== reactScreenProposalWidths.length)
    reject(
      'proposal-widths',
      '$.screenshots',
      'Attach no images or capture each of 390/1024/1400px once',
    );
  const widths = new Set<number>();
  for (const [index, raw] of screenshots.entries()) {
    const path = `$.screenshots[${index}]`,
      shot = object(raw, path);
    fields(shot, ['width', 'height', 'path', 'hash', 'fixtureHash', 'environmentHash'], [], path);
    finite(shot.width, path + '.width', 390, 1400, true);
    finite(shot.height, path + '.height', 1, 7680, true);
    if (!reactScreenProposalWidths.some((width) => width === shot.width) || widths.has(shot.width))
      reject('proposal-widths', path, 'Capture each supported width once');
    widths.add(shot.width);
    if (
      typeof shot.path !== 'string' ||
      shot.path.length > 512 ||
      !/^[A-Za-z0-9_./-]+\.png$/.test(shot.path) ||
      shot.path.startsWith('/') ||
      shot.path.split('/').some((part) => !part || part === '.' || part === '..')
    )
      reject('proposal-path', path + '.path', 'Expected a relative PNG artifact path');
    for (const key of ['hash', 'fixtureHash', 'environmentHash']) hash(shot[key], path + '.' + key);
    if (
      shot.fixtureHash !== reuseHash(document.fixture) ||
      shot.environmentHash !== document.environment.ref.hash
    )
      reject(
        'proposal-basis',
        path,
        'Screenshot fixture/environment differs from this composition',
      );
  }
  return deepFreeze({
    schemaVersion: 1,
    composition: document,
    externalReferences: references,
    screenshotWidths: reactScreenProposalWidths,
    screenshots: clone(proposal.screenshots) as ReactScreenProposal['screenshots'],
  });
}

/** Host capture attaches evidence to the already usable, validated JSON proposal. */
export async function prepareReactScreenProposal(request: {
  document: ReactUiDocument;
  externalReferences: ReactScreenProposal['externalReferences'];
  capture: ReactScreenshotAdapter;
  signal: AbortSignal;
}): Promise<ReactScreenProposal> {
  const proposal = createReactScreenProposal(request.document, request.externalReferences);
  if (request.signal.aborted) throw new Error('Capture aborted');
  const result = await request.capture.capture({
    document: clone(proposal.composition),
    widths: reactScreenProposalWidths,
    signal: request.signal,
  });
  if (request.signal.aborted) throw new Error('Capture aborted');
  if (result.diagnostics.length)
    reject(
      'proposal-capture',
      '$.screenshots',
      result.diagnostics.map((d) => d.message).join('; '),
    );
  if (!result.screenshots.length)
    reject('proposal-capture', '$.screenshots', 'Capture returned no screenshots');
  return validateReactScreenProposal({ ...proposal, screenshots: result.screenshots });
}
