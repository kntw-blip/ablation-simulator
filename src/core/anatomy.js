// Ground-truth cardiac anatomy defined by signed distance functions (mm).
// Coordinate system (patient): +x = patient LEFT, +y = SUPERIOR, +z = ANTERIOR.
import { add, sub, mul, dot, norm, len, clamp, lerp, cross } from './vec.js';

// ---------- SDF primitives ----------
function roundCone(a, b, ra, rb) {
  const ab = sub(b, a);
  const L2 = dot(ab, ab);
  return (p) => {
    const t = clamp(dot(sub(p, a), ab) / L2, 0, 1);
    const q = [a[0] + ab[0] * t - p[0], a[1] + ab[1] * t - p[1], a[2] + ab[2] * t - p[2]];
    return Math.hypot(q[0], q[1], q[2]) - (ra + (rb - ra) * t);
  };
}
function ellipsoid(c, axes, radii) {
  // axes: three orthonormal vectors
  const rmin = Math.min(...radii);
  return (p) => {
    const d = sub(p, c);
    const x = dot(d, axes[0]) / radii[0], y = dot(d, axes[1]) / radii[1], z = dot(d, axes[2]) / radii[2];
    return (Math.hypot(x, y, z) - 1) * rmin;
  };
}
function tube(pts, r0, r1) {
  const segs = [];
  const n = pts.length - 1;
  for (let i = 0; i < n; i++) segs.push(roundCone(pts[i], pts[i + 1], r0 + (r1 - r0) * (i / n), r0 + (r1 - r0) * ((i + 1) / n)));
  return (p) => {
    let d = Infinity;
    for (const s of segs) { const v = s(p); if (v < d) d = v; }
    return d;
  };
}
function smin(a, b, k) {
  const h = clamp(0.5 + (0.5 * (b - a)) / k, 0, 1);
  return b + (a - b) * h - k * h * (1 - h);
}
function unionS(fns, k) {
  return (p) => {
    let d = fns[0](p);
    for (let i = 1; i < fns.length; i++) d = smin(d, fns[i](p), k);
    return d;
  };
}
function frame(u) {
  u = norm(u);
  const a = Math.abs(u[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const v = norm(cross(a, u));
  const w = cross(u, v);
  return [u, v, w];
}
const I3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

// ---------- Landmark geometry (initial guesses; projected later) ----------
const L0 = {
  // valves: center, normal (pointing from atrium into ventricle), radius
  TV: { c: [-11, -9, 17], n: norm([0.55, -0.45, 0.7]), r: 15 },
  MV: { c: [16, -14, -12], n: norm([0.35, -0.6, 0.72]), r: 15 },
  PulmV: { c: [16, 18, 26], n: norm([0.1, 0.8, -0.55]), r: 11 },
  // pulmonary veins: ostium point and axis (pointing distally out of LA)
  PV: {
    LSPV: { o: [27, 14, -33], d: norm([0.7, 0.55, -0.45]), r: 8.5, len: 26 },
    LIPV: { o: [29, -9, -35], d: norm([0.7, -0.45, -0.55]), r: 7.5, len: 24 },
    RSPV: { o: [-3, 14, -36], d: norm([-0.55, 0.55, -0.62]), r: 9, len: 26 },
    RIPV: { o: [-3, -9, -38], d: norm([-0.5, -0.45, -0.72]), r: 8, len: 24 },
  },
  SVC: { a: [-30, 16, -6], b: [-30, 58, -8], r: 9.5 },
  IVC: { a: [-29, -14, -13], b: [-29, -52, -12], r: 11.5 },
  CSpath: [[-15, -17, -8], [-6, -20, -16], [6, -19, -22], [18, -17, -22], [28, -13, -17], [35, -8, -8], [38, -4, 2]],
};

// global anatomical scale (adult heart size)
export const SC = 1.2;
export const S = (p) => [p[0] * SC, p[1] * SC, p[2] * SC];
const scaleL = (o) => {
  const r = {};
  for (const [k, v] of Object.entries(o)) {
    if (Array.isArray(v) && typeof v[0] === 'number') r[k] = (k === 'n' || k === 'd') ? v.slice() : S(v);
    else if (Array.isArray(v)) r[k] = v.map((q) => S(q));
    else if (typeof v === 'number') r[k] = v * SC;
    else r[k] = scaleL(v);
  }
  return r;
};
export const L = scaleL(L0);

// ---------- Chamber SDFs ----------
function buildChambers0() {
  const RA = unionS([
    ellipsoid([-28, 0, 0], I3, [20, 23, 20]),
    roundCone(L0.SVC.a, L0.SVC.b, L0.SVC.r, L0.SVC.r),
    roundCone(L0.IVC.a, L0.IVC.b, L0.IVC.r, L0.IVC.r),
    roundCone([-27, 12, 8], [-16, 20, 22], 10, 6.5), // RAA
    roundCone([-26, -4, 2], add(L0.TV.c, mul(L0.TV.n, 4)), 15, 15.5), // vestibule towards TV
  ], 7);

  const pvs = Object.values(L0.PV).map((v) => roundCone(sub(v.o, mul(v.d, 5)), add(v.o, mul(v.d, v.len)), v.r + 1, v.r * 0.85));
  const LA = unionS([
    ellipsoid([12, 2, -26], I3, [23, 17, 16]),
    ...pvs,
    roundCone([26, 6, -18], [37, 11, -6], 8, 6), // LAA neck
    roundCone([37, 11, -6], [39, 4, 4], 6, 4.5), // LAA tip
    roundCone([13, -4, -22], add(L0.MV.c, mul(L0.MV.n, 4)), 14, 15.5), // vestibule towards MV
  ], 7);

  const CS = tube(L0.CSpath, 5, 3);

  // ventricles
  const lvBase = [19, -16, -5], lvApex = [42, -60, 22];
  const lvU = norm(sub(lvApex, lvBase));
  const LV = unionS([
    ellipsoid(lerp(lvBase, lvApex, 0.5), frame(lvU), [33, 22, 22]),
    roundCone(sub(L0.MV.c, mul(L0.MV.n, 4)), lvBase, 15.5, 18),
    roundCone(lvBase, [8, -4, 0], 14, 11), // LVOT
  ], 8);
  const u = lvU;
  // orient RV crescent: thin axis towards LV (septum)
  const toAnt = norm([-0.6, 0.15, 0.78]);
  const thin = norm(sub(toAnt, mul(u, dot(toAnt, u))));
  const wide = cross(u, thin);
  const RV = unionS([
    ellipsoid([8, -32, 30], [u, thin, wide], [30, 11, 25]),
    roundCone(sub(L0.TV.c, mul(L0.TV.n, 4)), [0, -24, 26], 15.5, 13), // inflow
    roundCone([6, -22, 32], [14, 6, 32], 13, 11.5), // RVOT
    roundCone([14, 6, 32], add(L0.PulmV.c, mul(L0.PulmV.n, 6)), 11.5, 11), // to pulmonic valve
  ], 8);

  return {
    RA: { sdf: RA, cuts: [cutPlane(sub(L0.CSpath[0], mul(norm(sub(L0.CSpath[1], L0.CSpath[0])), 2)), norm(sub(L0.CSpath[1], L0.CSpath[0])), 5.5), cutPlane(L0.TV.c, L0.TV.n, 18), cutPlane(add(L0.SVC.b, [0, -6, 0]), [0, 1, 0], 14), cutPlane(add(L0.IVC.b, [0, 6, 0]), [0, -1, 0], 16)] },
    LA: {
      sdf: LA,
      cuts: [cutPlane(L0.MV.c, L0.MV.n, 18), ...Object.values(L0.PV).map((v) => cutPlane(add(v.o, mul(v.d, v.len - 4)), v.d, v.r + 4))],
    },
    CS: { sdf: CS, cuts: [cutPlane(lerp(L0.CSpath[0], L0.CSpath[1], 0.15), norm(sub(L0.CSpath[0], L0.CSpath[1])), 8), cutPlane(lerp(L0.CSpath[5], L0.CSpath[6], 0.6), norm(sub(L0.CSpath[6], L0.CSpath[5])), 7)] },
    RV: { sdf: RV, cuts: [cutPlane(L0.TV.c, mul(L0.TV.n, -1), 18), cutPlane(L0.PulmV.c, L0.PulmV.n, 14)] },
    LV: { sdf: LV, cuts: [cutPlane(L0.MV.c, mul(L0.MV.n, -1), 18)] },
    lvBase, lvApex,
  };
}

export function buildChambers() {
  const c = buildChambers0();
  const wrap = (f) => (p) => SC * f([p[0] / SC, p[1] / SC, p[2] / SC]);
  const out = { lvBase: S(c.lvBase), lvApex: S(c.lvApex) };
  for (const id of ['RA', 'LA', 'CS', 'RV', 'LV']) {
    out[id] = { sdf: wrap(c[id].sdf), cuts: c[id].cuts.map((ct) => ({ test: (p) => ct.test([p[0] / SC, p[1] / SC, p[2] / SC]) })) };
  }
  return out;
}

// A cut removes surface where (p-c)·n > 0 and radial distance < r
function cutPlane(c, n, r) {
  n = norm(n);
  return { c, n, r, test: (p) => {
    const d = sub(p, c);
    const h = dot(d, n);
    if (h < 0) return false;
    const rad = len(sub(d, mul(n, h)));
    return rad < r;
  } };
}

// gradient-based projection onto the zero level set
export function projectToSurface(sdf, p, iters = 12) {
  let q = p.slice();
  for (let i = 0; i < iters; i++) {
    const d = sdf(q);
    const g = gradient(sdf, q);
    q = sub(q, mul(g, d));
    if (Math.abs(d) < 0.01) break;
  }
  return q;
}
export function gradient(sdf, p, h = 0.5) {
  const gx = sdf([p[0] + h, p[1], p[2]]) - sdf([p[0] - h, p[1], p[2]]);
  const gy = sdf([p[0], p[1] + h, p[2]]) - sdf([p[0], p[1] - h, p[2]]);
  const gz = sdf([p[0], p[1], p[2] + h]) - sdf([p[0], p[1], p[2] - h]);
  return norm([gx, gy, gz]);
}

export const BOUNDS = { min: S([-62, -80, -66]), max: S([66, 66, 56]) };
