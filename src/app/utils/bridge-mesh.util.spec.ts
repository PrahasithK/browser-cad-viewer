import { buildBridgeMesh } from './bridge-mesh.util';
import { extractBoundaryLoop } from './mesh-boundary.util';

function almostEqual(a: number, b: number, tol: number): boolean {
  return Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
}

function connectorLength(positions: Float32Array, n = 24): number {
  // Row 0 = loop A, last row = aligned loop B; sum |A[i] - lastRow[i]|.
  const rows = positions.length / 3 / n - 1;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const a = [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
    const bOff = rows * n + i;
    const b = [positions[bOff * 3], positions[bOff * 3 + 1], positions[bOff * 3 + 2]];
    sum += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  }
  return sum;
}

describe('mesh-boundary.util (Phase 0 validation, ported)', () => {
  it('extracts the 8-vertex outer ring of a 3x3 triangulated grid', () => {
    const positions: number[] = [];
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) positions.push(x, y, 0);
    const idx = (x: number, y: number) => y * 3 + x;
    const indices: number[] = [];
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 2; x++) {
        const v00 = idx(x, y), v10 = idx(x + 1, y), v01 = idx(x, y + 1), v11 = idx(x + 1, y + 1);
        indices.push(v00, v10, v11, v00, v11, v01);
      }
    }
    const faceIdMap = new Array(indices.length / 3).fill(0);
    const loop = extractBoundaryLoop(new Float32Array(positions), new Uint32Array(indices), new Uint32Array(faceIdMap), 0);
    expect(loop?.length).toBe(8);
  });
});

describe('bridge-mesh.util (Phase 0 validation, ported)', () => {
  it('case 1: parallel unit squares, matching winding — connector length equals gap distance × N', () => {
    const loopA: [number, number, number][] = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];
    const loopB: [number, number, number][] = [[0, 0, 2], [1, 0, 2], [1, 1, 2], [0, 1, 2]];
    const result = buildBridgeMesh(loopA, loopB, 4);
    expect(almostEqual(connectorLength(result.positions), 24 * 2, 0.01)).toBeTrue();
    expect(result.crossingWarnings).toBe(0);
  });

  it('case 2: same squares with a rotated loop-B start index — result is start-point-invariant', () => {
    const loopA: [number, number, number][] = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];
    const loopB1: [number, number, number][] = [[0, 0, 2], [1, 0, 2], [1, 1, 2], [0, 1, 2]];
    const loopB2: [number, number, number][] = [[1, 1, 2], [0, 1, 2], [0, 0, 2], [1, 0, 2]];
    const r1 = buildBridgeMesh(loopA, loopB1, 4);
    const r2 = buildBridgeMesh(loopA, loopB2, 4);
    expect(almostEqual(connectorLength(r1.positions), connectorLength(r2.positions), 0.01)).toBeTrue();
  });

  it('case 3: square vs hexagon — no degenerate triangles, exact triangle count', () => {
    const loopA: [number, number, number][] = [[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0]];
    const hex: [number, number, number][] = [];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      hex.push([1 + 0.6 * Math.cos(a), 1 + 0.6 * Math.sin(a), 3]);
    }
    const density = 5;
    const result = buildBridgeMesh(loopA, hex, density);
    expect(result.indices.length / 3).toBe(density * 24 * 2);

    let degenerate = 0;
    for (let t = 0; t < result.indices.length / 3; t++) {
      const i0 = result.indices[t * 3] * 3, i1 = result.indices[t * 3 + 1] * 3, i2 = result.indices[t * 3 + 2] * 3;
      const p0 = [result.positions[i0], result.positions[i0 + 1], result.positions[i0 + 2]];
      const p1 = [result.positions[i1], result.positions[i1 + 1], result.positions[i1 + 2]];
      const p2 = [result.positions[i2], result.positions[i2 + 1], result.positions[i2 + 2]];
      const e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
      const e2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
      const cx = e1[1] * e2[2] - e1[2] * e2[1];
      const cy = e1[2] * e2[0] - e1[0] * e2[2];
      const cz = e1[0] * e2[1] - e1[1] * e2[0];
      const area = Math.hypot(cx, cy, cz) / 2;
      if (area < 1e-9) degenerate++;
    }
    expect(degenerate).toBe(0);
  });

  it('case 5: loop B wound opposite to loop A — auto-correction converges to the same untwisted result', () => {
    const loopA: [number, number, number][] = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];
    const loopBSame: [number, number, number][] = [[0, 0, 2], [1, 0, 2], [1, 1, 2], [0, 1, 2]];
    const loopBOpposite = loopBSame.slice().reverse() as [number, number, number][];

    const rSame = buildBridgeMesh(loopA, loopBSame, 4);
    const rOpposite = buildBridgeMesh(loopA, loopBOpposite, 4);

    expect(almostEqual(connectorLength(rSame.positions), connectorLength(rOpposite.positions), 0.01)).toBeTrue();
    expect(rOpposite.crossingWarnings).toBe(0);
  });
});
