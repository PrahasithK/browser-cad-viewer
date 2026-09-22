/**
 * Extracts the ordered boundary loop of a single face's region within a body's triangle mesh.
 * An edge appearing in exactly one triangle of that face's subset is a boundary edge; boundary
 * edges chain into one (or more, for a holed face) closed cycles because OCCT triangulates each
 * face with consistent winding. Returns the longest cycle as an ordered array of [x,y,z] points;
 * warns (doesn't throw) if more than one cycle is found — holed faces are a known v1 limitation.
 */
export function extractBoundaryLoop(
  positions: Float32Array,
  indices: Uint32Array,
  faceIdMap: Uint32Array,
  faceIndex: number
): [number, number, number][] | null {
  const edgeCount = new Map<string, number>();
  const edgeDir = new Map<string, [number, number]>();

  const numTris = indices.length / 3;
  for (let t = 0; t < numTris; t++) {
    if (faceIdMap[t] !== faceIndex) continue;
    const a = indices[t * 3];
    const b = indices[t * 3 + 1];
    const c = indices[t * 3 + 2];
    for (const [u, v] of [
      [a, b],
      [b, c],
      [c, a]
    ] as [number, number][]) {
      const key = u < v ? `${u}_${v}` : `${v}_${u}`;
      edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1);
      if (!edgeDir.has(key)) edgeDir.set(key, [u, v]);
    }
  }

  const nextMap = new Map<number, number>();
  for (const [key, count] of edgeCount) {
    if (count === 1) {
      const [u, v] = edgeDir.get(key)!;
      nextMap.set(u, v);
    }
  }

  const visited = new Set<number>();
  const cycles: number[][] = [];
  for (const start of nextMap.keys()) {
    if (visited.has(start)) continue;
    const cycle: number[] = [];
    let current = start;
    let guard = 0;
    while (!visited.has(current) && guard < nextMap.size + 1) {
      visited.add(current);
      cycle.push(current);
      const next = nextMap.get(current);
      guard++;
      if (next === undefined) break;
      current = next;
    }
    if (current === start && cycle.length > 0) cycles.push(cycle);
  }

  if (cycles.length === 0) return null;
  if (cycles.length > 1) {
    // eslint-disable-next-line no-console
    console.warn(`[mesh-boundary] face ${faceIndex} has ${cycles.length} boundary cycles (likely a hole); using the longest`);
  }
  cycles.sort((a, b) => b.length - a.length);

  return cycles[0].map((idx) => [positions[idx * 3], positions[idx * 3 + 1], positions[idx * 3 + 2]]);
}
