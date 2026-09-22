import * as THREE from 'three';
import { angleAtVertexDeg, fitCircle, measurePlanes } from './measure-geometry.util';

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

function circlePoints(center: THREE.Vector3, radius: number, normal: THREE.Vector3, count: number, sweep = Math.PI * 2): THREE.Vector3[] {
  const n = normal.clone().normalize();
  const u = Math.abs(n.x) < 0.9 ? V(1, 0, 0).cross(n).normalize() : V(0, 1, 0).cross(n).normalize();
  const v = n.clone().cross(u);
  return Array.from({ length: count }, (_, i) => {
    const t = (i / (count - 1)) * sweep;
    return center.clone().add(u.clone().multiplyScalar(radius * Math.cos(t))).add(v.clone().multiplyScalar(radius * Math.sin(t)));
  });
}

describe('measure-geometry.util', () => {
  describe('angleAtVertexDeg', () => {
    it('right angle', () => expect(angleAtVertexDeg(V(10, 0, 0), V(0, 0, 0), V(0, 10, 0))).toBeCloseTo(90, 9));
    it('straight line is 180°', () => expect(angleAtVertexDeg(V(-5, 0, 0), V(0, 0, 0), V(5, 0, 0))).toBeCloseTo(180, 9));
    it('45° in 3D', () => expect(angleAtVertexDeg(V(1, 0, 0), V(0, 0, 0), V(1, 0, 1))).toBeCloseTo(45, 9));
    it('coincident point gives null', () => expect(angleAtVertexDeg(V(0, 0, 0), V(0, 0, 0), V(1, 0, 0))).toBeNull());
  });

  describe('measurePlanes', () => {
    it('parallel planes report the perpendicular distance, ignoring in-plane offset', () => {
      const r = measurePlanes({ origin: V(0, 0, 0), normal: V(0, 0, 1) }, { origin: V(30, 12, 50), normal: V(0, 0, -1) });
      expect(r.parallel).toBeTrue();
      expect(r.distance).toBeCloseTo(50, 9);
      expect(r.angleDeg).toBeCloseTo(0, 6);
    });
    it('perpendicular planes report 90°', () => {
      const r = measurePlanes({ origin: V(0, 0, 0), normal: V(0, 0, 1) }, { origin: V(0, 0, 0), normal: V(1, 0, 0) });
      expect(r.parallel).toBeFalse();
      expect(r.angleDeg).toBeCloseTo(90, 9);
    });
    it('reports the acute angle regardless of which way the normals face', () => {
      const n = V(0, Math.sin(Math.PI / 6), Math.cos(Math.PI / 6));
      const r = measurePlanes({ origin: V(0, 0, 0), normal: V(0, 0, 1) }, { origin: V(0, 0, 0), normal: n.clone().negate() });
      expect(r.angleDeg).toBeCloseTo(30, 6);
    });
  });

  describe('fitCircle', () => {
    it('recovers radius, centre and normal of a full circle (12 samples, as edges are sampled)', () => {
      const c = V(10, -5, 30);
      const fit = fitCircle(circlePoints(c, 12.5, V(0, 0, 1), 12))!;
      expect(fit.radius).toBeCloseTo(12.5, 9);
      expect(fit.center.distanceTo(c)).toBeLessThan(1e-9);
      expect(Math.abs(fit.normal.z)).toBeCloseTo(1, 9);
    });
    it('works for a tilted circle', () => {
      const c = V(-20, 40, 5);
      const fit = fitCircle(circlePoints(c, 7, V(1, 2, 3), 12))!;
      expect(fit.radius).toBeCloseTo(7, 9);
      expect(fit.center.distanceTo(c)).toBeLessThan(1e-9);
    });
    it('works for a half arc', () => {
      const c = V(0, 0, 0);
      const fit = fitCircle(circlePoints(c, 25, V(0, 0, 1), 12, Math.PI), 0.005)!;
      expect(fit.radius).toBeCloseTo(25, 9);
      expect(fit.center.length()).toBeLessThan(1e-9);
    });
    it('rejects a straight line', () => {
      expect(fitCircle(Array.from({ length: 12 }, (_, i) => V(i * 3, 0, 0)))).toBeNull();
    });
    it('rejects a non-circular closed curve (an ellipse)', () => {
      const pts = Array.from({ length: 12 }, (_, i) => V(30 * Math.cos((i / 12) * 2 * Math.PI), 10 * Math.sin((i / 12) * 2 * Math.PI), 0));
      expect(fitCircle(pts)).toBeNull();
    });
    it('rejects too few points', () => {
      expect(fitCircle([V(0, 0, 0), V(1, 0, 0)])).toBeNull();
    });
  });
});
