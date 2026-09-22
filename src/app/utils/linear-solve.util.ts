/** Dense Gaussian elimination with partial pivoting. Solves A x = b for a square system. */
export function solveLinearSystem(matrix: number[][], vector: number[]): number[] {
  const n = vector.length;
  const a = matrix.map((row) => row.slice());
  const b = vector.slice();

  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    let maxVal = Math.abs(a[col][col]);
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(a[r][col]) > maxVal) {
        maxVal = Math.abs(a[r][col]);
        pivotRow = r;
      }
    }
    if (maxVal < 1e-12) {
      throw new Error(`Singular matrix at column ${col} — the structure likely has an unrestrained mechanism`);
    }
    if (pivotRow !== col) {
      [a[col], a[pivotRow]] = [a[pivotRow], a[col]];
      [b[col], b[pivotRow]] = [b[pivotRow], b[col]];
    }
    for (let r = col + 1; r < n; r++) {
      const factor = a[r][col] / a[col][col];
      if (factor === 0) continue;
      for (let c = col; c < n; c++) a[r][c] -= factor * a[col][c];
      b[r] -= factor * b[col];
    }
  }

  const x = new Array(n).fill(0);
  for (let row = n - 1; row >= 0; row--) {
    let sum = b[row];
    for (let c = row + 1; c < n; c++) sum -= a[row][c] * x[c];
    x[row] = sum / a[row][row];
  }
  return x;
}

export function zerosMatrix(rows: number, cols: number): number[][] {
  return Array.from({ length: rows }, () => new Array(cols).fill(0));
}

export function matMul(a: number[][], b: number[][]): number[][] {
  const n = a.length;
  const m = b[0].length;
  const k = b.length;
  const c = zerosMatrix(n, m);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      let sum = 0;
      for (let p = 0; p < k; p++) sum += a[i][p] * b[p][j];
      c[i][j] = sum;
    }
  }
  return c;
}

export function transpose(a: number[][]): number[][] {
  const n = a.length;
  const m = a[0].length;
  const t = zerosMatrix(m, n);
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) t[j][i] = a[i][j];
  return t;
}

export function matVec(a: number[][], v: number[]): number[] {
  return a.map((row) => row.reduce((sum, value, j) => sum + value * v[j], 0));
}
