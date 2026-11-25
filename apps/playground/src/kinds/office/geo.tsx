import { useEditorDraftPort } from '../editor-draft-port';
import type { GeoDocument } from '@editor-platform/geo-core';
import type { EditorCommand } from '@editor-platform/editor-core';
import { geoKind } from '@editor-platform/geo-inspector/kind';
import { editedDraft } from '../../app/records';
import { GeoSurface } from '../../geo/surface';
import type { Content } from '../../model';
import { hostKind } from '../host-kind';
import { latestRecord, type SurfaceHost } from '../surface-host';
import { validateGeoRecord } from '../../geo/resources';

function GeoHost({ host }: { host: SurfaceHost }) {
  const { active, savedRecords, readOnly } = host;
  const session = useEditorDraftPort<GeoDocument>(host);
  return (
    <GeoSurface
      artifact={active}
      session={session}
      shared={host.shared}
      guardExport={host.exportGuard}
      inputs={host.inputs}
      readOnly={readOnly}
      records={[...savedRecords.current.values()]}
      saved={() => {
        const a = host.shared ? active : savedRecords.current.get(active.id);
        if (!a) throw Error('Geo artifact not saved');
        return a;
      }}
      execute={(cmd, resources, dataInputs) => {
        if (readOnly) return false;
        if (host.shared) {
          if (resources?.length || dataInputs?.length) {
            host.setError('共同編集中は元データや他の成果物を読み込めません。');
            return false;
          }
          return host.execute(cmd);
        }
        try {
          const s = host.sessions.current.get(active.id)!,
            a = latestRecord(host)!;
          const next = s.executeView(cmd as EditorCommand<Content>);
          host.persist({
            ...editedDraft(a, next),
            ...(resources ? { geoResources: resources } : {}),
            ...(dataInputs ? { geoDataInputs: dataInputs } : {}),
          });
          return true;
        } catch (e) {
          host.setError(String(e));
          return false;
        }
      }}
      history={host.history}
      save={host.saveVersion}
    />
  );
}

export const geoSurface = hostKind(geoKind, {
  Surface: GeoHost,
  hooks: {
    beforeVersion: validateGeoRecord,
    // Geo resource admission keeps strict identity checks on every version.
    strictCapture: true,
    comments: false,
  },
});
