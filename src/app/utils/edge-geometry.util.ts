import * as THREE from 'three';
import { CadBodyEdge } from '../models/cad-body.model';
import { WorkerEdge } from '../workers/step-worker-messages.model';

/**
 * Unpacks each WorkerEdge's flat Float32Array polyline into THREE.Vector3 points, in the same
 * local (pre-`mesh.matrixWorld`) space the render triangulation's positions are already in.
 * Shared by every path that turns a WorkerTessellatedBody into a CadBody (StepLoaderService's
 * STEP-import/primitive-create paths, SketchService's feature-extrude/fillet-chamfer paths) —
 * same convention as other small pure conversions in this folder.
 */
export function toCadBodyEdges(edges: WorkerEdge[]): CadBodyEdge[] {
  return edges.map((e) => {
    const points: THREE.Vector3[] = [];
    for (let i = 0; i < e.points.length; i += 3) {
      points.push(new THREE.Vector3(e.points[i], e.points[i + 1], e.points[i + 2]));
    }
    return { index: e.index, points };
  });
}
