import * as THREE from 'three';
import { CadBody } from '../models/cad-body.model';

/**
 * Builds a single binary STL file from one or more bodies' render triangulation (the same
 * `geometry` already used for shading/raycasting — not the finer Mesh View triangulation, which
 * would produce a needlessly large file for a format that's mesh-only anyway). Binary STL (not
 * ASCII) is used since it's roughly 5-6x smaller for the same geometry and is universally
 * supported by slicers/CAD tools that read STL.
 *
 * Unlike STEP export (`ExportService.exportStep`), STL needs no OCCT involvement and works for
 * every body regardless of origin (STEP-imported, sketch-extruded, primitive, or
 * fillet/chamfered) — STL is a pure mesh format, and every `CadBody` already carries a
 * ready-to-use Three.js `geometry` in memory. World-space coordinates are used (each body's
 * `mesh.matrixWorld` applied to its local-space positions) so multiple bodies combine correctly
 * into one file at their actual assembly positions, matching what STEP export's compound
 * (world-positioned solids) also produces.
 *
 * Binary STL layout: 80-byte header, 4-byte uint32 triangle count, then 50 bytes per triangle
 * (12 bytes normal + 3×12 bytes vertices + 2-byte attribute byte count, always 0 here).
 */
export function buildBinaryStl(bodies: CadBody[]): ArrayBuffer {
  let triangleCount = 0;
  for (const body of bodies) {
    const index = body.geometry.index;
    triangleCount += index ? index.count / 3 : body.geometry.attributes['position'].count / 3;
  }

  const headerSize = 80;
  const countSize = 4;
  const bytesPerTriangle = 50;
  const buffer = new ArrayBuffer(headerSize + countSize + triangleCount * bytesPerTriangle);
  const view = new DataView(buffer);

  // Header is left as zero bytes (no particular tool-identifying text needed); triangle count follows it.
  view.setUint32(headerSize, triangleCount, true);

  let offset = headerSize + countSize;
  const pA = new THREE.Vector3();
  const pB = new THREE.Vector3();
  const pC = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const edge1 = new THREE.Vector3();
  const edge2 = new THREE.Vector3();

  for (const body of bodies) {
    const geometry = body.geometry;
    const position = geometry.attributes['position'];
    const index = geometry.index;
    const triCount = index ? index.count / 3 : position.count / 3;
    const matrixWorld = body.mesh.matrixWorld;

    for (let t = 0; t < triCount; t++) {
      const i0 = index ? index.getX(t * 3) : t * 3;
      const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;

      pA.fromBufferAttribute(position, i0).applyMatrix4(matrixWorld);
      pB.fromBufferAttribute(position, i1).applyMatrix4(matrixWorld);
      pC.fromBufferAttribute(position, i2).applyMatrix4(matrixWorld);

      edge1.subVectors(pB, pA);
      edge2.subVectors(pC, pA);
      normal.crossVectors(edge1, edge2).normalize();

      view.setFloat32(offset, normal.x, true);
      view.setFloat32(offset + 4, normal.y, true);
      view.setFloat32(offset + 8, normal.z, true);
      view.setFloat32(offset + 12, pA.x, true);
      view.setFloat32(offset + 16, pA.y, true);
      view.setFloat32(offset + 20, pA.z, true);
      view.setFloat32(offset + 24, pB.x, true);
      view.setFloat32(offset + 28, pB.y, true);
      view.setFloat32(offset + 32, pB.z, true);
      view.setFloat32(offset + 36, pC.x, true);
      view.setFloat32(offset + 40, pC.y, true);
      view.setFloat32(offset + 44, pC.z, true);
      view.setUint16(offset + 48, 0, true);
      offset += bytesPerTriangle;
    }
  }

  return buffer;
}
