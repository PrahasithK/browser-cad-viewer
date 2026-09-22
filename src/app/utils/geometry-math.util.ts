import * as THREE from 'three';

export function boxUnion(boxes: THREE.Box3[]): THREE.Box3 {
  const union = new THREE.Box3();
  for (const box of boxes) {
    union.union(box);
  }
  return union;
}

export function computeCentroid(boxes: THREE.Box3[]): THREE.Vector3 {
  const union = boxUnion(boxes);
  const center = new THREE.Vector3();
  union.getCenter(center);
  return center;
}

export function radialDirection(bodyCenter: THREE.Vector3, assemblyCenter: THREE.Vector3): THREE.Vector3 {
  const dir = bodyCenter.clone().sub(assemblyCenter);
  if (dir.lengthSq() < 1e-10) {
    return new THREE.Vector3(0, 0, 1);
  }
  return dir.normalize();
}
