/**
 * The texture part of a body's Appearance (#662): `geometry-view`'s editor over the body's set.
 * New images are stored with the Host first, then named by one edit (`adoptTextures`).
 */
import { TextureEditor } from '@editor-platform/geometry-view';
import type { CadBody } from '@editor-platform/cad-core';
import type { CadController } from './controller';

export function TextureSection({
  body,
  controller,
  readOnly,
}: {
  body: CadBody;
  controller: CadController;
  readOnly: boolean;
}) {
  return (
    <TextureEditor
      set={body.appearance.textures}
      readOnly={readOnly}
      canAdd={controller.canTexture}
      testId="cad-texture"
      onChange={(textures) => {
        const { textures: _old, ...look } = body.appearance;
        void controller.run({
          type: 'setAppearance',
          bodyId: body.id,
          appearance: textures ? { ...look, textures } : look,
        });
      }}
      onAdd={(files, set) => controller.adoptTextures(body.id, files, set)}
    />
  );
}
