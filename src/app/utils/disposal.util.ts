import * as THREE from 'three';

export function disposeMaterial(material: THREE.Material | THREE.Material[]): void {
  const materials = Array.isArray(material) ? material : [material];
  for (const mat of materials) {
    for (const key of Object.keys(mat)) {
      const value = (mat as unknown as Record<string, unknown>)[key];
      if (value instanceof THREE.Texture) {
        value.dispose();
      }
    }
    mat.dispose();
  }
}

/**
 * Real bug fixed 2026-09-14: this only checked `instanceof THREE.Mesh || instanceof
 * THREE.LineSegments` — `FilletChamferRendererService`'s hover-preview line is a plain
 * `THREE.Line` (not `LineSegments`), so its geometry/material were never disposed at all,
 * leaking a fresh `BufferGeometry`+`LineBasicMaterial` (and their GPU buffers) on every single
 * pointermove while Fillet/Chamfer is active — `showHoverEdge` disposes-then-rebuilds a new line
 * on every hover event. `THREE.Line` extends the same base `Object3D` as `Mesh`/`LineSegments`
 * and exposes the identical `.geometry`/`.material` shape, so checking for it here (or,
 * equivalently, checking for `.geometry`/`.material` directly rather than enumerating every
 * THREE class that carries them) closes the leak without needing per-class special-casing.
 */
export function disposeObject3D(obj: THREE.Object3D): void {
  for (const child of [...obj.children]) {
    disposeObject3D(child);
  }
  if (obj instanceof THREE.Mesh || obj instanceof THREE.LineSegments || obj instanceof THREE.Line) {
    obj.geometry?.dispose();
    if (obj.material) {
      disposeMaterial(obj.material);
    }
  }
  obj.parent?.remove(obj);
}
