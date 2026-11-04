import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Points,
  ShaderMaterial,
} from 'three';
import type { overlayGeometry } from './mesh-edit';

/**
 * The cage drawn over a part in mesh edit mode (C3e): every edge, the vertices (selected ones
 * orange), the selected edges and faces. Drawn on top of everything (X-ray), as picking counts
 * hidden elements too.
 */
export function cageOverlay(geometry: ReturnType<typeof overlayGeometry>, matrix: number[]): Group {
  const group = new Group();
  group.matrixAutoUpdate = false;
  group.matrix.copy(new Matrix4().fromArray(matrix));
  const lines = new BufferGeometry();
  lines.setAttribute('position', new BufferAttribute(geometry.lines, 3));
  const onTop = { depthTest: false, depthWrite: false, transparent: true };
  group.add(
    new LineSegments(lines, new LineBasicMaterial({ color: '#1d2939', opacity: 0.75, ...onTop })),
  );
  // C4: seams (where the UVs are cut) in red, under the selection.
  if (geometry.seamLines.length) {
    const seam = new BufferGeometry();
    seam.setAttribute('position', new BufferAttribute(geometry.seamLines, 3));
    group.add(new LineSegments(seam, new LineBasicMaterial({ color: '#d92d20', ...onTop })));
  }
  if (geometry.selectedLines.length) {
    const sel = new BufferGeometry();
    sel.setAttribute('position', new BufferAttribute(geometry.selectedLines, 3));
    group.add(new LineSegments(sel, new LineBasicMaterial({ color: '#f97316', ...onTop })));
  }
  if (geometry.selectedTriangles.length) {
    const tri = new BufferGeometry();
    tri.setAttribute('position', new BufferAttribute(geometry.selectedTriangles, 3));
    group.add(
      new Mesh(
        tri,
        new MeshBasicMaterial({ color: '#f97316', opacity: 0.3, side: DoubleSide, ...onTop }),
      ),
    );
  }
  const points = new BufferGeometry();
  points.setAttribute('position', new BufferAttribute(geometry.points, 3));
  points.setAttribute('selected', new BufferAttribute(geometry.pointSelected, 1));
  group.add(
    new Points(
      points,
      new ShaderMaterial({
        ...onTop,
        vertexShader: `attribute float selected; varying float vSelected;
          void main() { vSelected = selected; gl_PointSize = selected > 0.5 ? 9.0 : 6.0;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `varying float vSelected;
          void main() { gl_FragColor = vSelected > 0.5 ? vec4(0.976, 0.451, 0.086, 1.0) : vec4(0.11, 0.16, 0.22, 1.0); }`,
      }),
    ),
  );
  for (const o of group.children) o.renderOrder = 10;
  return group;
}

export function disposeOverlay(group: Group) {
  group.traverse((o) => {
    const m = o as Partial<Mesh>;
    m.geometry?.dispose();
    const mat = m.material;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else mat?.dispose();
  });
}
