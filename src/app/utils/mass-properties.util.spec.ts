import * as THREE from 'three';
import { computeMassProperties, inertiaKgMm2, massKg, principalMoments } from './mass-properties.util';

const IDENTITY = new THREE.Matrix4();

function rel(actual: number, expected: number): number {
  return Math.abs(actual - expected) / Math.max(Math.abs(expected), 1e-12);
}

/** A non-indexed BoxGeometry is a closed, consistently wound mesh, like a body's tessellation. */
function box(w: number, h: number, d: number): THREE.BufferGeometry {
  return new THREE.BoxGeometry(w, h, d);
}

describe('mass-properties.util', () => {
  it('box: exact volume, centroid and inertia', () => {
    const w = 100, h = 50, d = 20;
    const p = computeMassProperties(box(w, h, d), IDENTITY)!;
    expect(rel(p.volume, w * h * d)).toBeLessThan(1e-9);
    expect(p.centroid.length()).toBeLessThan(1e-9);
    // I_xx per unit density = V (h² + d²) / 12, and so on.
    const V = w * h * d;
    expect(rel(p.inertia.xx, (V * (h * h + d * d)) / 12)).toBeLessThan(1e-9);
    expect(rel(p.inertia.yy, (V * (w * w + d * d)) / 12)).toBeLessThan(1e-9);
    expect(rel(p.inertia.zz, (V * (w * w + h * h)) / 12)).toBeLessThan(1e-9);
    expect(Math.abs(p.inertia.xy)).toBeLessThan(1e-6);
  });

  it('steel box mass: 100 x 50 x 20 mm at 7850 kg/m³ is 0.785 kg', () => {
    const p = computeMassProperties(box(100, 50, 20), IDENTITY)!;
    expect(rel(massKg(p.volume, 7850), 0.785)).toBeLessThan(1e-9);
    // Cube of side a: I = m a² / 6 about its centre.
    const cube = computeMassProperties(box(50, 50, 50), IDENTITY)!;
    const m = massKg(cube.volume, 7850);
    expect(rel(inertiaKgMm2(cube.inertia.xx, 7850), (m * 50 * 50) / 6)).toBeLessThan(1e-9);
  });

  it('follows the world matrix: a translated body reports its new centroid', () => {
    const m = new THREE.Matrix4().makeTranslation(400, -30, 250);
    const p = computeMassProperties(box(10, 20, 30), m)!;
    expect(p.centroid.distanceTo(new THREE.Vector3(400, -30, 250))).toBeLessThan(1e-6);
    // Inertia about the centroid is unchanged by a translation.
    const q = computeMassProperties(box(10, 20, 30), IDENTITY)!;
    expect(rel(p.inertia.xx, q.inertia.xx)).toBeLessThan(1e-9);
  });

  it('precise far from the origin', () => {
    const m = new THREE.Matrix4().makeTranslation(1e6, 1e6, 1e6);
    const p = computeMassProperties(box(10, 20, 30), m)!;
    expect(rel(p.volume, 6000)).toBeLessThan(1e-6);
    expect(rel(p.inertia.xx, (6000 * (20 * 20 + 30 * 30)) / 12)).toBeLessThan(1e-4);
  });

  it('a mirrored (negative-determinant) matrix still gives positive volume', () => {
    const m = new THREE.Matrix4().makeScale(-1, 1, 1);
    const p = computeMassProperties(box(10, 20, 30), m)!;
    expect(rel(p.volume, 6000)).toBeLessThan(1e-9);
  });

  it('rotating a box 90° about Z swaps its x and y moments and keeps the products at zero', () => {
    const m = new THREE.Matrix4().makeRotationZ(Math.PI / 2);
    const p = computeMassProperties(box(100, 50, 20), m)!;
    const q = computeMassProperties(box(100, 50, 20), IDENTITY)!;
    expect(rel(p.inertia.xx, q.inertia.yy)).toBeLessThan(1e-9);
    expect(rel(p.inertia.yy, q.inertia.xx)).toBeLessThan(1e-9);
    expect(Math.abs(p.inertia.xy)).toBeLessThan(1e-6);
  });

  it('a sphere approaches 2/5 m r² and 4/3 π r³ as the tessellation refines', () => {
    const r = 25;
    const p = computeMassProperties(new THREE.SphereGeometry(r, 96, 64), IDENTITY)!;
    const V = (4 / 3) * Math.PI * r ** 3;
    expect(rel(p.volume, V)).toBeLessThan(0.01);
    expect(rel(p.inertia.xx, (2 / 5) * V * r * r)).toBeLessThan(0.02);
  });

  it('scales to a supplied reference volume', () => {
    const g = box(10, 10, 10);
    const exact = computeMassProperties(g, IDENTITY)!;
    const scaled = computeMassProperties(g, IDENTITY, 2000)!;
    expect(scaled.volume).toBe(2000);
    expect(rel(scaled.inertia.xx, exact.inertia.xx * 2)).toBeLessThan(1e-9);
  });

  it('principal moments of a tilted body match the untilted ones', () => {
    const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(0.4, 0.9, -0.3));
    const p = computeMassProperties(box(100, 50, 20), m)!;
    const q = computeMassProperties(box(100, 50, 20), IDENTITY)!;
    const expected = [q.inertia.xx, q.inertia.yy, q.inertia.zz].sort((x, y) => x - y);
    p.principal.forEach((v, i) => expect(rel(v, expected[i])).toBeLessThan(1e-9));
  });

  it('principalMoments handles a diagonal tensor', () => {
    expect(principalMoments({ xx: 3, yy: 1, zz: 2, xy: 0, xz: 0, yz: 0 })).toEqual([1, 2, 3]);
  });

  it('returns null for an empty mesh', () => {
    expect(computeMassProperties(new THREE.BufferGeometry(), IDENTITY)).toBeNull();
  });
});
