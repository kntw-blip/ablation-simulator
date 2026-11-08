// Catheter kinematics (sheath + advance/rotate/deflect), wall contact, electrodes
import { add, sub, mul, dot, norm, cross, len, lerp, rotAxis, perp, clamp, dist } from './vec.js';
import { L, S } from './anatomy.js';

export const CATH_DEFS = {
  ABL: { name: 'アブレーションカテ (4極・CFセンサー)', short: 'ABL', color: 0xf2f2f2, steer: true, poles: 4 },
  MAP: { name: '多極マッピングカテ (20極・星形)', short: 'MAP', color: 0x5ad1ff, steer: true, poles: 20 },
  HRA: { name: 'HRA 4極', short: 'HRA', color: 0xffb347, poles: 4 },
  HALO: { name: 'Halo 20極（三尖弁輪）', short: 'Halo', color: 0xff8ad8, poles: 20 },
  HIS: { name: 'His 4極', short: 'HIS', color: 0xffe066, poles: 4 },
  RVA: { name: 'RV 4極', short: 'RV', color: 0x9be37a, poles: 4 },
  CS: { name: 'CS 10極', short: 'CS', color: 0xd18cff, poles: 10 },
};

export function accessPresets(T) {
  const LAc = S([12, 2, -26]);
  return {
    RA: { label: 'IVC→右房', tip: S([-29, -18, -12]), dir: norm([0.05, 1, 0.35]) },
    RV: { label: '右房→右室（三尖弁越え）', tip: add(L.TV.c, mul(L.TV.n, -6)), dir: norm(sub(T.lm.rvApex, add(L.TV.c, mul(L.TV.n, -6)))) },
    LA: { label: '経中隔→左房', tip: add(T.lm.fossaLA, mul(norm(sub(LAc, T.lm.fossaLA)), 3)), dir: norm(sub(LAc, T.lm.fossaLA)) },
    LV: { label: '左房→左室（僧帽弁越え）', tip: add(L.MV.c, mul(L.MV.n, -8)), dir: L.MV.n },
  };
}

const R_CATH = 1.3; // mm (7Fr ~ 2.3mm diameter)

// Tap-to-target catheter: the tip travels to a wall point chosen on the 3D map; contact force is set by the operator.
export class SteerableCatheter {
  constructor(type, heart, T) {
    this.type = type; this.def = CATH_DEFS[type];
    this.blood = heart.blood; this.T = T;
    this.presets = accessPresets(T);
    this.cf = 0; this.contact = false;
    this.cfSet = type === 'ABL' ? 12 : 0;
    this.floating = false;
    this.locked = false; // cryo adhesion
    this.electrodes = [];
    this.shaft = [];
    this.move = null;
    this.setAccess('RA');
    const start = add(this.sheathTip, mul(this.sheathDir, 22));
    this.tip = this.constrain(start, 4);
    this.wall = null; this.nrm = null;
    this.update(0);
  }
  setAccess(key) {
    this.access = key;
    const p = this.presets[key];
    this.sheathTip = p.tip; this.sheathDir = p.dir;
  }
  grad(p) {
    const h = 0.4, f = this.blood;
    return norm([f([p[0] + h, p[1], p[2]]) - f([p[0] - h, p[1], p[2]]), f([p[0], p[1] + h, p[2]]) - f([p[0], p[1] - h, p[2]]), f([p[0], p[1], p[2] + h]) - f([p[0], p[1], p[2] - h])]);
  }
  // keep a point at least `margin` inside the blood pool
  constrain(p, margin = R_CATH) {
    let q = p;
    for (let it = 0; it < 4; it++) {
      const d = this.blood(q);
      if (d <= -margin) break;
      q = sub(q, mul(this.grad(q), d + margin));
    }
    return q;
  }
  // move a point onto the iso-surface at -offset (from either side)
  snap(p, offset = 0) {
    let q = p;
    for (let it = 0; it < 6; it++) {
      const d = this.blood(q) + offset;
      if (Math.abs(d) < 0.05) break;
      q = sub(q, mul(this.grad(q), d));
    }
    return q;
  }
  // operator chose a wall point (and the chamber it belongs to)
  setTarget(point, chamber) {
    if (this.locked) return false;
    if (chamber && chamber !== this.chamberOfAccess()) this.setAccess(chamber === 'LA' ? 'LA' : chamber === 'LV' ? 'LV' : chamber === 'RV' ? 'RV' : 'RA');
    const wall = this.snap(point, 0);
    const nrm = this.grad(wall);
    const from = this.tip.slice();
    this.move = { from, to: wall, nrm, t0: performance.now(), dur: 250 + 9 * dist(from, wall) };
    this.floating = false;
    return true;
  }
  chamberOfAccess() { return this.access; }
  nudge(v) { // v: world-space displacement (mm), tangent to wall
    if (this.locked || !this.wall) return;
    const p = this.snap(add(this.wall, v), 0);
    this.wall = p; this.nrm = this.grad(p);
  }
  act(a, k = 1) {
    if (this.locked) return;
    if (a === 'push') this.cfSet = clamp(this.cfSet + 0.6 * k, 0, 90);
    if (a === 'pull') this.cfSet = clamp(this.cfSet - 0.6 * k, 0, 90);
  }
  setFloat(f) { this.floating = f; }
  update(tms) {
    if (this.locked) { this.cf = this.cfSet; return; }
    let moving = false;
    if (this.move) {
      const m = this.move;
      const f = Math.min(1, (performance.now() - m.t0) / m.dur);
      const e = f * f * (3 - 2 * f);
      // travel through the blood pool, lifting off the wall in mid-course
      const lift = Math.sin(Math.PI * e) * 6;
      const mid = lerp(m.from, m.to, e);
      this.tip = this.constrain(add(mid, mul(m.nrm, -lift)), 2.5 * Math.sin(Math.PI * e) + 0.6);
      moving = f < 1;
      if (!moving) { this.wall = m.to; this.nrm = m.nrm; this.move = null; }
    }
    if (!moving && this.wall) {
      const off = this.floating ? 5 : 0.7;
      this.tip = sub(this.wall, mul(this.nrm, off));
    }
    const beat = 0.82 + 0.18 * Math.sin((tms / 820) * 2 * Math.PI) + 0.06 * Math.sin(tms / 3700);
    this.cf = moving || this.floating || !this.wall ? 0 : this.cfSet * beat;
    this.contact = this.cf > 2.5;
    this.buildShaft();
    this.computeElectrodes();
  }
  buildShaft() {
    const P0 = this.sheathTip, P3 = this.tip;
    const L = dist(P0, P3);
    const appr = this.nrm && !this.move ? norm(add(mul(this.nrm, 0.75), mul(norm(sub(P3, P0)), 0.25))) : norm(sub(P3, P0));
    const P1 = add(P0, mul(this.sheathDir, L * 0.45));
    const P2 = sub(P3, mul(appr, Math.min(25, L * 0.35)));
    const pts = [];
    const n = 22;
    for (let k = 0; k <= n; k++) {
      const t = k / n, u = 1 - t;
      const p = [0, 1, 2].map((i) => u * u * u * P0[i] + 3 * u * u * t * P1[i] + 3 * u * t * t * P2[i] + t * t * t * P3[i]);
      pts.push(k === n ? p : this.constrain(p, 1.4));
    }
    this.shaft = pts;
    this.tipDir = norm(sub(pts[n], pts[n - 2]));
    this.wallNormal = this.contact ? this.nrm : null;
  }
  pointBack(s) {
    const pts = this.shaft;
    let acc = 0;
    for (let i = pts.length - 1; i > 0; i--) {
      const seg = dist(pts[i], pts[i - 1]);
      if (acc + seg >= s) return lerp(pts[i], pts[i - 1], (s - acc) / (seg || 1));
      acc += seg;
    }
    return pts[0];
  }
  computeElectrodes() {
    if (this.type === 'ABL') {
      this.electrodes = [1.75, 5.5, 8.5, 11.5].map((s, k) => ({ id: `ABL_${k + 1}`, pos: this.pointBack(s), len: k === 0 ? 3.5 : 1 }));
      for (const e of this.electrodes) e.contact = this.blood(e.pos) > -2.4;
      this.electrodes[0].contact = this.contact;
    } else {
      // star-shaped multipolar: splines spread over the wall around the hub
      const n = this.nrm && !this.move && !this.floating ? this.nrm : null;
      const d = n ? mul(n, -1) : this.tipDir;
      const u = perp(d), v = cross(d, u);
      const els = [];
      for (let sp = 0; sp < 5; sp++) {
        const th = (sp * 2 * Math.PI) / 5 + (this.spin || 0);
        const rad = add(mul(u, Math.cos(th)), mul(v, Math.sin(th)));
        for (let k = 0; k < 4; k++) {
          const rho = 3.5 + k * 3.8;
          let p = add(this.tip, mul(rad, rho));
          let c = false;
          if (n) { const q = this.snap(p, 0.9); if (dist(q, p) < 8) { p = q; c = true; } else p = this.constrain(p, 1); }
          else p = this.constrain(p, 1);
          els.push({ id: `MAP_${sp * 4 + k + 1}`, pos: p, contact: c, spline: sp });
        }
      }
      this.electrodes = els;
    }
  }
}

// ---------- Fixed diagnostic catheters ----------
function csPoint(s) { // arc length s from CS os along CS centreline
  const P = L.CSpath;
  let acc = 0;
  for (let i = 0; i < P.length - 1; i++) {
    const l = dist(P[i], P[i + 1]);
    if (acc + l >= s) return lerp(P[i], P[i + 1], (s - acc) / l);
    acc += l;
  }
  return P[P.length - 1];
}

export class FixedCatheter {
  constructor(type, heart, T) {
    this.type = type; this.def = CATH_DEFS[type]; this.T = T; this.blood = heart.blood;
    this.depth = 55; // CS insertion depth (mm)
    this.site = type === 'RVA' ? 'apex' : type === 'HRA' ? 'high' : 'default';
    this.cf = 0; this.contact = true;
    this.update(0);
  }
  update() {
    const key = `${this.site}|${this.depth}`;
    if (this._key === key) return;
    this._key = key;
    const T = this.T, lm = T.lm;
    const ivc = S([-29, -30, -12]), raMid = S([-28, -4, -2]);
    const inward = (i, mm) => { const p = T.P(i); const n = [T.normal[i * 3], T.normal[i * 3 + 1], T.normal[i * 3 + 2]]; return sub(p, mul(n, mm)); };
    let els = [], path = [];
    if (this.type === 'HRA') {
      const notCTI = (i) => T.excit[i] && T.region[i] !== 6 && T.region[i] !== 3 && T.region[i] !== 2;
      const target = {
        high: add(lm.sn, S([-2, -6, 4])),
        lowlat: lerp(lm.tvInf, S([-46, -4, 8]), 0.28),
        raa: S([-19, 19, 20]),
        sept: lerp(lm.hisRA, lm.bachRA, 0.55),
      }[this.site] || lm.sn;
      const c = T.nearest('RA', target, notCTI);
      const nn = [T.normal[c * 3], T.normal[c * 3 + 1], T.normal[c * 3 + 2]];
      const n0 = inward(c, 1.2);
      const up = [0, 1, 0];
      const t = norm(sub(up, mul(nn, dot(up, nn))));
      els = [0, 5, 10, 15].map((o) => this.constrainIn(add(n0, mul(t, o))));
      path = [ivc, raMid, ...els.slice().reverse()];
    } else if (this.type === 'HALO') {
      const c0 = L.TV.c, n = L.TV.n, u = perp(n), w = cross(n, u);
      const ang = (p) => { const d = sub(p, c0); return Math.atan2(dot(d, w), dot(d, u)); };
      const ring = T.rings.tvRA;
      const R = ring.reduce((a, i) => a + len(sub(sub(T.P(i), c0), mul(n, dot(sub(T.P(i), c0), n)))), 0) / ring.length;
      const aI = ang(lm.tvInf), aH = ang(lm.hisRA), aC = ang(lm.csOs);
      const wrap = (x) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      // go from the isthmus (distal) to the high septum (proximal) the way that avoids the CS ostium
      let dir = 1, span = wrap(aH - aI);
      if (wrap(aC - aI) < span) { dir = -1; span = 2 * Math.PI - span; }
      const pts = [];
      for (let k = 0; k < 10; k++) for (let j = 0; j < 2; j++) {
        const a = aI + dir * (span * (0.08 + 0.86 * (k / 9)) + j * (2 / R));
        const radial = add(mul(u, Math.cos(a)), mul(w, Math.sin(a)));
        const guess = add(add(c0, mul(radial, R + 7)), mul(n, -4));
        pts.push(this.snap(guess, 1.2));
      }
      els = pts;
      path = [ivc, raMid, ...els.slice().reverse()];    } else if (this.type === 'HIS') {
      const h = lm.hisRA;
      const into = L.TV.n;
      els = [3, -1, -5, -9].map((o) => this.constrainIn(add(h, mul(into, o))));
      path = [ivc, raMid, add(h, mul(into, -16)), ...els.slice().reverse()];
    } else if (this.type === 'RVA') {
      const target = this.site === 'sept' ? lerp(lm.rvApex, lm.hisRA, 0.45) : this.site === 'rvot' ? T.lm.rvotFocus : lm.rvApex;
      const c = T.nearest('RV', target);
      const tip = inward(c, 1.2);
      const back = norm(sub(add(L.TV.c, mul(L.TV.n, 10)), tip));
      els = [0, 5, 10, 15].map((o) => { const q = this.constrainIn(add(tip, mul(back, o))); const nn = T.nearest('RV', q); const w = T.P(nn); const d = dist(q, w); return d > 2 ? lerp(q, w, (d - 1.3) / d) : q; });
      path = [ivc, raMid, add(L.TV.c, mul(L.TV.n, -4)), add(L.TV.c, mul(L.TV.n, 12)), ...els.slice().reverse()];
    } else if (this.type === 'CS') {
      const offs = [0, 2, 10, 12, 20, 22, 30, 32, 40, 42];
      els = offs.map((o) => {
        const c = csPoint(Math.max(1, this.depth - o));
        const n = T.nearest('CS', c);
        const w = T.P(n);
        const d = dist(c, w);
        return d > 2.0 ? lerp(c, w, (d - 1.2) / d) : c; // electrode lies against the CS wall
      });
      path = [ivc, raMid, sub(L.CSpath[0], S([3, -2, -6])), ...els.slice().reverse()];
    }
    this.electrodes = els.map((p, k) => ({ id: `${this.type}_${k + 1}`, pos: p, contact: true }));
    this.shaft = path;
    this.tip = els[0];
  }
  snap(p, offset) { // onto the blood-pool surface, `offset` mm inside
    let q = p;
    const f = this.blood, h = 0.4;
    for (let it = 0; it < 8; it++) {
      const d = f(q) + offset;
      if (Math.abs(d) < 0.05) break;
      const g = norm([f([q[0] + h, q[1], q[2]]) - f([q[0] - h, q[1], q[2]]), f([q[0], q[1] + h, q[2]]) - f([q[0], q[1] - h, q[2]]), f([q[0], q[1], q[2] + h]) - f([q[0], q[1], q[2] - h])]);
      q = sub(q, mul(g, d));
    }
    return q;
  }
  constrainIn(p) {
    let q = p;
    for (let it = 0; it < 3; it++) {
      const d = this.blood(q);
      if (d <= -1.0) break;
      const h = 0.4, f = this.blood;
      const g = norm([f([q[0] + h, q[1], q[2]]) - f([q[0] - h, q[1], q[2]]), f([q[0], q[1] + h, q[2]]) - f([q[0], q[1] - h, q[2]]), f([q[0], q[1], q[2] + h]) - f([q[0], q[1], q[2] - h])]);
      q = sub(q, mul(g, d + 1.0));
    }
    return q;
  }
  act(a) {
    if (this.type === 'CS') {
      if (a === 'adv') this.depth = clamp(this.depth + 1, 42, 85);
      if (a === 'ret') this.depth = clamp(this.depth - 1, 42, 85);
    }
  }
}

export function channelDefs(cath) {
  const t = cath.type, c = [];
  const col = '#' + cath.def.color.toString(16).padStart(6, '0');
  if (t === 'HRA') c.push({ key: 'HRA12', label: 'HRA d', a: 'HRA_1', b: 'HRA_2' }, { key: 'HRA34', label: 'HRA p', a: 'HRA_3', b: 'HRA_4' });
  if (t === 'HALO') for (let k = 9; k >= 0; k--) c.push({ key: `HALO${2 * k + 1}`, label: `Halo ${2 * k + 1}-${2 * k + 2}`, a: `HALO_${2 * k + 1}`, b: `HALO_${2 * k + 2}` });
  if (t === 'HIS') c.push({ key: 'HIS12', label: 'His d', a: 'HIS_1', b: 'HIS_2' }, { key: 'HIS23', label: 'His m', a: 'HIS_2', b: 'HIS_3' }, { key: 'HIS34', label: 'His p', a: 'HIS_3', b: 'HIS_4' });
  if (t === 'RVA') c.push({ key: 'RV12', label: 'RV d', a: 'RVA_1', b: 'RVA_2' });
  if (t === 'CS') for (let k = 4; k >= 0; k--) c.push({ key: `CS${2 * k + 1}${2 * k + 2}`, label: `CS ${2 * k + 1}-${2 * k + 2}`, a: `CS_${2 * k + 1}`, b: `CS_${2 * k + 2}` });
  if (t === 'ABL') c.push({ key: 'ABLd', label: 'ABL d', a: 'ABL_1', b: 'ABL_2' }, { key: 'ABLp', label: 'ABL p', a: 'ABL_3', b: 'ABL_4' }, { key: 'ABLu', label: 'ABL uni', a: 'ABL_1', type: 'uni' });
  if (t === 'MAP') for (let sp = 0; sp < 5; sp++) for (let k = 0; k < 2; k++) {
    const a = sp * 4 + k * 2 + 1;
    c.push({ key: `MAP${a}`, label: `MAP ${String.fromCharCode(65 + sp)}${k * 2 + 1}-${k * 2 + 2}`, a: `MAP_${a}`, b: `MAP_${a + 1}` });
  }
  const g = t === 'HALO' ? 1.7 : t === 'CS' ? 1.4 : 1;
  return c.map((x) => ({ type: 'bi', color: col, gain: g, cath: t, ...x }));
}
