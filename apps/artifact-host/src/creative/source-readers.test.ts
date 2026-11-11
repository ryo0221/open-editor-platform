import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('public native source validators run in a Node Host without loading React, a Surface or CSS', async () => {
  const result = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
      import { compareTimelineSavedFacets, compareCreativeSavedContent } from '@editor-platform/reference-artifact-host/creative/saved-comparison';
      if (typeof compareTimelineSavedFacets !== 'function' || typeof compareCreativeSavedContent !== 'function') throw Error('missing comparison exports');
      import { readCreativeMapping } from '@editor-platform/reference-artifact-host/creative/project';
      import { defaultCharacterColumns, projectCharacterCards, settingSourceCards } from '@editor-platform/reference-artifact-host/creative/source-readers';
      import { readWorldReference } from '@editor-platform/reference-artifact-host/creative/workspace/world-context';
      import { verifyNewReferences } from '@editor-platform/reference-artifact-host/creative/timeline/refs';
      import { TL1_COLUMNS, TL1_ROLES } from '@editor-platform/reference-artifact-host/creative/timeline/table';
      import { createArtifact, commitVersion } from '@editor-platform/artifact-core';
      import { createDocument } from '@editor-platform/document/model';
      const data = {schemaVersion:2, columns:Object.entries(defaultCharacterColumns).map(([field,id])=>({id,name:field,type:'text'})),
        rows:[{id:'native-row-1',values:Object.fromEntries(Object.entries(defaultCharacterColumns).map(([field,id])=>[id,field==='id'?'CH-01':field==='name'?'徳川家康':'']))}]};
      const before = JSON.stringify(data);
      const cards = projectCharacterCards(data);
      const doc = createDocument();
      doc.blocks = [{id:'lo-heading',type:'heading',level:1,text:'LO-01 関ケ原'}];
      const locations = settingSourceCards(doc);
      const a = await commitVersion(createArtifact('document','舞台',doc),null,'first');
      const v = a.versions[0];
      const ref = {id:'ref-1',role:'stage',artifactId:a.id,versionId:v.versionId,contentHash:v.contentHash,selector:{type:'document-blocks',blockIds:['lo-heading']}};
      const io = {artifacts:{get:async()=>a}};
      const view = await readWorldReference(io,ref,()=>true);
      let allowed = true;
      const revoked = await readWorldReference({artifacts:{get:async()=>{allowed=false;return a;}}},ref,()=>allowed);
      const checked = await verifyNewReferences({get:async()=>undefined},[],()=>true);
      const mapping = readCreativeMapping({schemaVersion:1,mode:'character',source:{artifactId:'native',versionId:'exact'},bindings:[]},'character');
      let refused = false;
      try { readCreativeMapping({...mapping,future:1},'character'); } catch { refused=true; }
      console.log(JSON.stringify({cards,locations,view,revoked,checked:checked.rows.length,refused,unchanged:before===JSON.stringify(data),
        schema:!!TL1_COLUMNS.length && !!TL1_ROLES.ledger,dom:typeof window!=='undefined'||typeof document!=='undefined'}));
    `,
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    metafile: true,
  });
  expect(
    Object.keys(result.metafile!.inputs).filter((p) =>
      /(?:react-dom|node_modules\/react\/|\.tsx$|\.css$)/.test(p),
    ),
  ).toEqual([]);
  const output = JSON.parse(
    execFileSync(process.execPath, ['--input-type=module'], {
      input: result.outputFiles[0].text,
      encoding: 'utf8',
    }),
  );
  expect(output.cards[0]).toMatchObject({
    id: 'CH-01',
    elementId: 'native-row-1',
    name: '徳川家康',
  });
  expect(output.locations[0]).toMatchObject({
    id: 'LO-01',
    elementId: 'lo-heading',
    name: '関ケ原',
  });
  expect(output.view).toMatchObject({ state: 'current', text: 'LO-01 関ケ原' });
  expect(output.revoked).toMatchObject({ state: 'forbidden' });
  expect(output.revoked).not.toHaveProperty('text');
  expect(output).toMatchObject({
    refused: true,
    checked: 0,
    unchanged: true,
    schema: true,
    dom: false,
  });
});
