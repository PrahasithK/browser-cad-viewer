import * as THREE from 'three';
import { PlaneRef } from '../workers/step-worker-messages.model';

const IDENTITY = new THREE.Matrix4();

/**
 * Face planes are picked from the tessellation in WORLD space, but the kernel holds a body's solid
 * in its ORIGINAL frame: a Move/Rotate gizmo drag only changes the Three.js mesh transform. A plane
 * sent to the kernel for a cut/fuse against that body must therefore be expressed in the body's own
 * frame, otherwise the tool solid lands where the body used to be and the operation silently does
 * nothing. Sketch points are plane-local (u, v), so only the plane frame needs converting.
 *
 * Exact for rigid transforms (move/rotate/uniform scale). Datum planes and unmoved bodies pass
 * through untouched, so their results stay bit-identical.
 */
export function planeRefInBodyFrame(planeRef: PlaneRef, mesh: THREE.Object3D): PlaneRef {
  if (planeRef.kind !== 'face') return planeRef;

  mesh.updateWorldMatrix(true, false);
  if (mesh.matrixWorld.equals(IDENTITY)) return planeRef;

  const inverse = mesh.matrixWorld.clone().invert();
  const origin = new THREE.Vector3(...planeRef.origin).applyMatrix4(inverse);
  const normal = new THREE.Vector3(...planeRef.normal).transformDirection(inverse);
  const uAxis = new THREE.Vector3(...planeRef.uAxis).transformDirection(inverse);

  return {
    kind: 'face',
    origin: [origin.x, origin.y, origin.z],
    normal: [normal.x, normal.y, normal.z],
    uAxis: [uAxis.x, uAxis.y, uAxis.z]
  };
}
