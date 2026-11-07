// Catheter kinematics (sheath + advance/rotate/deflect), wall contact, electrodes
import { add, sub, mul, dot, norm, cross, len, lerp, rotAxis, perp, clamp, dist } from './vec.js';
import { L, S } from './anatomy.js';

export const CATH_DEFS = {
  ABL: { name: 'アブレーションカテ (4極・CFセンサー)', short: 'ABL', color: 0xf2f2f2, steer: true, poles: 4 },
  MAP: { name: '多極マッピングカテ (20極・星形)', short: 'MAP', color: 0x5ad1ff, steer: true, poles: 20 },
  HRA: { name: 'HRA 4極', short: 'HRA', color: 0xffb347, poles: 4 },
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

export class SteerableCatheter {
  constructor(type, heart, T) {
    this.type = type; this.def = CATH_DEFS[type];
    this.blood = heart.blood; this.T = T;
    this.presets = accessPresets(T);
    this.setAccess('RA');
    this.cf = 0; this.contact = false;
    this.locked = false; // cryo adhesion
    this.electrodes = [];
    this.shaft = [];
    this.update(0);
  }
  setAccess(key) {
    this.access = key;
    const p = this.presets[key];
    this.sheathTip = p.tip; this.sheathDir = p.dir;
    this.adv = key === 'RA' ? 25 : 18; this.rot = 0; this.defl = 0;
  }
  // free-space centerline
  centerline() {
    const Ld = 45, step = 2;
    const d = this.sheathDir;
    const b0 = perp(d);
    const b = rotAxis(b0, d, (this.rot * Math.PI) / 180);
    const kappa = this.defl / 13; // 1/mm
    const Ls = Math.max(0, this.adv - Ld), Lc = Math.min(this.adv, Ld);
    const pts = [];
    for (let s = 0; s <= Ls; s += step) pts.push(add(this.sheathTip, mul(d, s)));
    const base = add(this.sheathTip, mul(d, Ls));
    const nC = Math.max(1, Math.ceil(Lc / step));
    for (let k = 1; k <= nC; k++) {
      const s = (Lc * k) / nC;
      let p;
      if (kappa < 1e-4) p = add(base, mul(d, s));
      else p = add(add(base, mul(d, Math.sin(kappa * s) / kappa)), mul(b, (1 - Math.cos(kappa * s)) / kappa));
      pts.push(p);
    }
    if (pts.length < 2) pts.push(add(this.sheathTip, mul(d, 0.5)));
    return pts;
  }
  grad(p) {
    const h = 0.4, f = this.blood;
    return norm([f([p[0] + h, p[1], p[2]]) - f([p[0] - h, p[1], p[2]]), f([p[0], p[1] + h, p[2]]) - f([p[0], p[1] - h, p[2]]), f([p[0], p[1], p[2] + h]) - f([p[0], p[1], p[2] - h])]);
  }
  constrain(p, margin = R_CATH) {
    let q = p;
    for (let it = 0; it < 3; it++) {
      const d = this.blood(q);
      if (d <= -margin) break;
      q = sub(q, mul(this.grad(q), d + margin));
    }
    return q;
  }
  update(tms) {
    if (this.locked) return;
    const free = this.centerline();
    const tipFree = free[free.length - 1];
    const dFree = this.blood(tipFree) + R_CATH;
    // cardiac motion: modulate penetration
    const beat = 0.8 + 0.2 * Math.sin((tms / 820) * 2 * Math.PI) + 0.06 * Math.sin(tms / 3700);
    const pen = Math.max(0, dFree) * beat;
    this.cf = clamp(pen * 6.5, 0, 120);
    this.contact = this.cf > 2.5;
    // constrain shaft points
    const pts = free.map((p) => this.constrain(p));
    // keep tip touching wall when penetrating
    this.shaft = pts;
    const tip = pts[pts.length - 1];
    const prev = pts[Math.max(0, pts.length - 3)];
    this.tip = tip;
    this.tipDir = norm(sub(tip, prev));
    this.wallNormal = this.contact ? this.grad(tip) : null;
    this.computeElectrodes();
  }
  pointBack(s) { // point at arc length s back from the tip along shaft
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
    const id = this.type;
    if (id === 'ABL') {
      this.electrodes = [1.75, 5.5, 8.5, 11.5].map((s, k) => ({ id: `ABL_${k + 1}`, pos: this.pointBack(s), len: k === 0 ? 3.5 : 1 }));
    } else if (id === 'MAP') {
      const d = this.tipDir, u = perp(d), v = cross(d, u);
      const els = [];
      for (let sp = 0; sp < 5; sp++) {
        const th = (sp * 2 * Math.PI) / 5 + (this.rot * Math.PI) / 180;
        const rad = add(mul(u, Math.cos(th)), mul(v, Math.sin(th)));
        for (let k = 0; k < 4; k++) {
          const rho = 3.5 + k * 3.8;
          let p = add(add(this.tip, mul(rad, rho)), mul(d, -0.25 * rho + 1.5));
          const dd = this.blood(p);
          let c = false;
          if (dd > -1.0) { p = this.constrain(p, 0.9); c = true; }
          els.push({ id: `MAP_${sp * 4 + k + 1}`, pos: p, contact: c || this.blood(p) > -2.2, spline: sp });
        }
      }
      this.electrodes = els;
    }
    for (const e of this.electrodes) if (e.contact === undefined) e.contact = this.blood(e.pos) > -2.4;
  }
  // input actions
  act(a, k = 1) {
    if (this.locked) return;
    switch (a) {
      case 'adv': this.adv = clamp(this.adv + 0.38 * k, 0, 140); break;
      case 'ret': this.adv = clamp(this.adv - 0.38 * k, 0, 140); break;
      case 'cw': this.rot = (this.rot + 1.3 * k + 360) % 360; break;
      case 'ccw': this.rot = (this.rot - 1.3 * k + 360) % 360; break;
      case 'flex': this.defl = clamp(this.defl + 0.014 * k, 0, 1); break;
      case 'rel': this.defl = clamp(this.defl - 0.014 * k, 0, 1); break;
      case 'stilt': this.sheathDir = norm(rotAxis(this.sheathDir, perp([0, 1, 0.001]), 0.008 * k)); break;
      case 'srot': this.sheathDir = norm(rotAxis(this.sheathDir, [0, 1, 0], 0.012 * k)); break;
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
    this.site = type === 'RVA' ? 'apex' : 'default';
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
      const c = T.nearest('RA', add(lm.sn, S([-2, -6, 4])));
      const n0 = inward(c, 1.2);
      const t = norm(cross([T.normal[c * 3], T.normal[c * 3 + 1], T.normal[c * 3 + 2]], [0, 0, 1]));
      els = [0, 5, 10, 15].map((o) => this.constrainIn(add(n0, mul(t, -o + 6))));
      path = [ivc, raMid, ...els.slice().reverse()];
    } else if (this.type === 'HIS') {
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
  if (t === 'HIS') c.push({ key: 'HIS12', label: 'His d', a: 'HIS_1', b: 'HIS_2' }, { key: 'HIS23', label: 'His m', a: 'HIS_2', b: 'HIS_3' }, { key: 'HIS34', label: 'His p', a: 'HIS_3', b: 'HIS_4' });
  if (t === 'RVA') c.push({ key: 'RV12', label: 'RV d', a: 'RVA_1', b: 'RVA_2' });
  if (t === 'CS') for (let k = 4; k >= 0; k--) c.push({ key: `CS${2 * k + 1}${2 * k + 2}`, label: `CS ${2 * k + 1}-${2 * k + 2}`, a: `CS_${2 * k + 1}`, b: `CS_${2 * k + 2}` });
  if (t === 'ABL') c.push({ key: 'ABLd', label: 'ABL d', a: 'ABL_1', b: 'ABL_2' }, { key: 'ABLp', label: 'ABL p', a: 'ABL_3', b: 'ABL_4' }, { key: 'ABLu', label: 'ABL uni', a: 'ABL_1', type: 'uni' });
  if (t === 'MAP') for (let sp = 0; sp < 5; sp++) for (let k = 0; k < 2; k++) {
    const a = sp * 4 + k * 2 + 1;
    c.push({ key: `MAP${a}`, label: `MAP ${String.fromCharCode(65 + sp)}${k * 2 + 1}-${k * 2 + 2}`, a: `MAP_${a}`, b: `MAP_${a + 1}` });
  }
  return c.map((x) => ({ type: 'bi', color: col, gain: 1, cath: t, ...x }));
}
