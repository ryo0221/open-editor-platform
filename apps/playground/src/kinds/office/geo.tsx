import type { EditorCommand, EditorSession } from '@editor-platform/editor-core';
import { geoKind } from '@editor-platform/geo-inspector/kind';
import { editedDraft } from '../../app/records';
import { GeoSurface } from '../../geo/surface';
import type { Content } from '../../model';
import { hostKind } from '../host-kind';
import { latestRecord, type SurfaceHost } from '../surface-host';

function GeoHost({ host }: { host: SurfaceHost }) {
  const { active, savedRecords, readOnly } = host;
  return (
    <GeoSurface
      artifact={active}
      session={host.session as EditorSession<Content>}
      inputs={host.inputs}
      readOnly={readOnly}
      records={[...savedRecords.current.values()]}
      saved={() => {
        const a = savedRecords.current.get(active.id);
        if (!a) throw Error('Geo artifact not saved');
        return a;
      }}
      execute={(cmd, resources, dataInputs) => {
        if (readOnly) return false;
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

export const geoSurface = hostKind(geoKind, { Surface: GeoHost, session: 'local' });
