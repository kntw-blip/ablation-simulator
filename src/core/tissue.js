// Electrophysiological tissue model: nodes (mesh vertices + virtual conduction-system nodes) and edges
import { buildHeartMeshes, CHAMBER_IDS } from './heartmesh.js';
import { L, S } from './anatomy.js';
import { add, sub, mul, dot, norm, dist, len, lerp, polyDist, segDist, rng, cross } from './vec.js';

export const REG = {
  RA: 1, CT: 2, CTI: 3, SVC: 5, RAA: 7, KOCH: 8,
  LA: 10, PV: 11, LAA: 12, POST: 13, MI: 14,
  CS: 20, RV: 30, RVOT: 31, RVSEPT: 32, LV: 40, LVSEPT: 41,
  VEIN: 50, VIRT: 60,
};
export const REG_NAME = Object.fromEntries(Object.entries(REG).map(([k, v]) => [v, k]));
export const CH = { RA: 0, LA: 1, CS: 2, RV: 3, LV: 4, VIRT: 5 };
export const PV_NAMES = ['LSPV', 'LIPV', 'RSPV', 'RIPV'];

function boundaryVerts(mesh) {
  const I = mesh.indices;
  const cnt = new Map();
  for (let t = 0; t < I.length; t += 3)
    for (let e = 0; e < 3; e++) {
      const a = I[t + e], b = I[t + ((e + 1) % 3)];
      const k = a < b ? a * 1e6 + b : b * 1e6 + a;
      cnt.set(k, (cnt.get(k) || 0) + 1);
    }
  const s = new Set();
  for (const [k, c] of cnt) if (c === 1) { s.add(Math.floor(k / 1e6)); s.add(k % 1e6); }
  return s;
}

/**
 * Build the tissue for a scenario.
 * opts.scenario: 'AFL' | 'PAF' | 'AVNRT' | 'WPW' | 'PVC'
 */
export function buildTissue(opts = {}) {
  const scenario = opts.scenario || 'AFL';
  const R = rng(opts.seed || 7);
  const heart = buildHeartMeshes(opts.h || 2.0);
  const { meshes, chambers } = heart;

  // ---- collect nodes ----
  const posArr = [], chArr = [], offset = {};
  let n = 0;
  for (const id of CHAMBER_IDS) {
    offset[id] = n;
    const P = meshes[id].positions;
    for (let i = 0; i < P.length; i += 3) { posArr.push(P[i], P[i + 1], P[i + 2]); chArr.push(CH[id]); }
    n += P.length / 3;
  }
  const nMesh = n;
  const P = (i) => [posArr[i * 3], posArr[i * 3 + 1], posArr[i * 3 + 2]];
  const meshNodes = (cid) => { const o = offset[cid]; const m = meshes[cid].positions.length / 3; return Array.from({ length: m }, (_, k) => o + k); };
  const nearest = (cid, p, filt) => {
    let best = -1, bd = Infinity;
    for (const i of meshNodes(cid)) { if (filt && !filt(i)) continue; const d = dist(P(i), p); if (d < bd) { bd = d; best = i; } }
    return best;
  };
  const within = (cid, p, r) => meshNodes(cid).filter((i) => dist(P(i), p) < r);

  // ---- rings (valve annuli) ----
  const ring = (cid, valve) => {
    const b = boundaryVerts(meshes[cid]);
    const out = [];
    for (const v of b) {
      const p = P(offset[cid] + v);
      const d = sub(p, valve.c);
      const h = Math.abs(dot(d, valve.n));
      const rad = len(sub(d, mul(valve.n, dot(d, valve.n))));
      if (h < 5 && rad < valve.r + 8) out.push(offset[cid] + v);
    }
    return out;
  };
  const tvRA = ring('RA', L.TV), mvLA = ring('LA', L.MV), tvRV = ring('RV', L.TV), mvLV = ring('LV', L.MV);
  const pick = (list, p) => list.reduce((b, i) => (dist(P(i), p) < dist(P(b), p) ? i : b), list[0]);

  // ---- landmarks ----
  const lm = {};
  lm.csOs = L.CSpath[0];
  lm.hisRA = P(pick(tvRA, S([-2, -2, 4])));
  lm.spRA = P(pick(tvRA, lm.csOs));
  lm.tvInf = P(pick(tvRA, add(L.TV.c, S([-6, -20, -4]))));
  lm.ivcLip = P(nearest('RA', S([-27, -18, -1])));
  lm.cti = [lm.tvInf, lm.ivcLip];
  lm.ct = [[-34, 40, -6], [-40, 24, -3], [-47, 8, -4], [-46, -6, -6], [-39, -16, -6], [-34, -26, -8]].map(S);
  lm.sn = P(nearest('RA', S([-38, 20, 6])));
  lm.fossaRA = P(nearest('RA', S([-8, -2, -12])));
  lm.fossaLA = P(nearest('LA', S([-8, -2, -22])));
  lm.bachRA = P(nearest('RA', S([-18, 18, 10])));
  lm.bachLA = P(nearest('LA', S([2, 16, -14])));
  lm.mvLat = P(pick(mvLA, add(L.MV.c, S([16, 6, -6]))));
  lm.mvLatLV = P(pick(mvLV, lm.mvLat));
  lm.rvApex = P(nearest('RV', S([24, -50, 32])));
  lm.lvApex = P(nearest('LV', chambers.lvApex));
  lm.rvotFocus = P(nearest('RV', S([6, 2, 22])));
  lm.koch = [lm.hisRA, lm.csOs];
  lm.esophagus = [[6, 40, -48], [8, 10, -47], [10, -10, -47], [12, -40, -45]].map(S);
  lm.phrenicR = [[-40, 50, -2], [-42, 30, -4], [-22, 14, -42], [-46, 0, -10], [-44, -30, -10]].map(S);
  lm.phrenicR = [[-40, 50, -4], [-38, 30, -18], [-24, 12, -44], [-30, -8, -40], [-42, -30, -14]].map(S);
  lm.pv = {};
  for (const name of PV_NAMES) lm.pv[name] = { ...L.PV[name] };

  // ---- per-node properties ----
  const reg = new Uint8Array(n);
  const pvId = new Int8Array(n).fill(-1);
  const sleeve = new Float32Array(n); // depth into PV (mm)
  for (let i = 0; i < nMesh; i++) {
    const p = P(i), c = chArr[i];
    let r = 0;
    if (c === CH.RA) {
      r = REG.RA;
      const sv = segDist(p, L.SVC.a, L.SVC.b)[0];
      if (p[1] > 17 * 1.2 && sv < 16) r = p[1] > 34 * 1.2 ? REG.VEIN : REG.SVC;
      const iv = segDist(p, L.IVC.a, L.IVC.b)[0];
      if (p[1] < -17 * 1.2 && iv < 17) r = REG.VEIN;
      if (r === REG.RA && segDist(p, S([-27, 12, 8]), S([-16, 20, 22]))[0] < 11 && p[2] > 6) r = REG.RAA;
      if (r !== REG.VEIN && segDist(p, lm.cti[0], lm.cti[1])[0] < 11 && p[1] < -5) r = REG.CTI;
      if (r !== REG.VEIN && segDist(p, lm.koch[0], lm.koch[1])[0] < 6) r = REG.KOCH;
      if (polyDist(p, lm.ct).d < 2.7) r = REG.CT;
    } else if (c === CH.LA) {
      r = REG.LA;
      for (let k = 0; k < 4; k++) {
        const v = L.PV[PV_NAMES[k]];
        const d = sub(p, v.o);
        const h = dot(d, v.d);
        const rad = len(sub(d, mul(v.d, h)));
        if (h > -2 && rad < v.r + 5) { r = h > 20 ? REG.VEIN : REG.PV; pvId[i] = k; sleeve[i] = h; }
      }
      if (r === REG.LA) {
        if (segDist(p, S([26, 6, -18]), S([37, 11, -6]))[0] < 10 || segDist(p, S([37, 11, -6]), S([39, 4, 4]))[0] < 8) r = REG.LAA;
        else if (p[2] < -36 * 1.2) r = REG.POST;
        else if (segDist(p, add(L.PV.LIPV.o, S([0, -6, 2])), lm.mvLat)[0] < 6) r = REG.MI;
      }
    } else if (c === CH.CS) {
      const pd = polyDist(p, L.CSpath);
      let arc = 0;
      for (let k = 0; k < pd.seg; k++) arc += dist(L.CSpath[k], L.CSpath[k + 1]);
      arc += pd.t * dist(L.CSpath[pd.seg], L.CSpath[pd.seg + 1]);
      r = arc > 62 ? REG.VEIN : REG.CS;
      sleeve[i] = arc;
    } else if (c === CH.RV) {
      r = p[1] > -7 ? REG.RVOT : REG.RV;
      if (chambers.LV.sdf(p) < 13) r = REG.RVSEPT;
    } else if (c === CH.LV) {
      r = chambers.RV.sdf(p) < 13 ? REG.LVSEPT : REG.LV;
    }
    reg[i] = r;
  }

  // ---- outward normals of endocardial nodes ----
  const nrmArr = [];
  for (let i = 0; i < nMesh; i++) {
    const sd = chambers[CHAMBER_IDS[chArr[i]]].sdf, p = P(i), h = 0.5;
    nrmArr.push(norm([sd([p[0] + h, p[1], p[2]]) - sd([p[0] - h, p[1], p[2]]), sd([p[0], p[1] + h, p[2]]) - sd([p[0], p[1] - h, p[2]]), sd([p[0], p[1], p[2] + h]) - sd([p[0], p[1], p[2] - h])]));
  }
  // ---- epicardial layer for ventricular free walls (transmural activation) ----
  const epiOf = new Int32Array(nMesh).fill(-1);
  const VTH = { [REG.RV]: 4.5, [REG.RVOT]: 4.5, [REG.LV]: 10 };
  const epiTwin = [], regX = Array.from(reg), pvX = Array.from(pvId), slX = Array.from(sleeve);
  for (let i = 0; i < nMesh; i++) {
    const th = VTH[reg[i]];
    if (!th) continue;
    const p = P(i), g = nrmArr[i];
    epiOf[i] = nMesh + epiTwin.length;
    epiTwin.push(i);
    nrmArr.push(g);
    regX.push(reg[i]); pvX.push(-1); slX.push(0);
    posArr.push(p[0] + g[0] * th, p[1] + g[1] * th, p[2] + g[2] * th);
    chArr.push(chArr[i]);
  }
  const nBase = nMesh + epiTwin.length;

  // ---- virtual conduction-system nodes ----
  const vpos = [], vreg = [], vname = [];
  const addV = (name, p) => { vpos.push(p); vname.push(name); return nBase + vpos.length - 1; };
  const tvn = L.TV.n;
  const kochDir = norm(sub(lm.csOs, lm.hisRA));
  const cnPos = add(lerp(lm.hisRA, lm.csOs, 0.12), mul(tvn, -2));
  const fpIns = lerp(lm.hisRA, lm.csOs, 0.18);
  const spIns = lerp(lm.spRA, lm.csOs, 0.35);
  const V = {};
  const dual = scenario === 'AVNRT';
  V.FP = [0, 1, 2, 3].map((k) => addV('FP' + k, lerp(fpIns, cnPos, k / 4)));
  V.SP = dual || opts.spAlways ? [0, 1, 2, 3, 4, 5].map((k) => addV('SP' + k, add(lerp(spIns, cnPos, k / 6), mul(tvn, 1.5)))) : [];
  V.CN = addV('CN', cnPos);
  V.HIS = addV('HIS', add(lm.hisRA, mul(tvn, 4)));
  V.RBB = [addV('RBB0', lerp(add(lm.hisRA, mul(tvn, 8)), lm.rvApex, 0.35)), addV('RBB1', lerp(add(lm.hisRA, mul(tvn, 8)), lm.rvApex, 0.75))];
  const lvSeptMid = P(nearest('LV', lerp(lm.hisRA, lm.lvApex, 0.35), (i) => reg[i] === REG.LVSEPT));
  V.LBB = [addV('LBB0', lerp(add(lm.hisRA, mul(tvn, 6)), lvSeptMid, 0.6))];
  V.AP = [];
  if (scenario === 'WPW') {
    V.AP = [addV('AP0', lerp(lm.mvLat, lm.mvLatLV, 0.2)), addV('AP1', lerp(lm.mvLat, lm.mvLatLV, 0.8))];
  }
  const nTot = nBase + vpos.length;
  for (const p of vpos) posArr.push(...p);
  const pos = new Float32Array(posArr);
  const chamber = new Uint8Array(nTot);
  chamber.set(chArr);
  for (let i = nBase; i < nTot; i++) chamber[i] = CH.VIRT;
  const region = new Uint8Array(nTot); region.set(regX); for (let i = nBase; i < nTot; i++) region[i] = REG.VIRT;
  const pvIdx = new Int8Array(nTot).fill(-1); pvIdx.set(pvX);
  const sleeveD = new Float32Array(nTot); sleeveD.set(slX);
  const isEpi = new Uint8Array(nTot); for (let i = nMesh; i < nBase; i++) isEpi[i] = 1;

  // ---- electrophysiological parameters ----
  const cv = new Float32Array(nTot), erp = new Float32Array(nTot), thick = new Float32Array(nTot);
  const amp = new Float32Array(nTot), gain = new Float32Array(nTot), excit = new Uint8Array(nTot);
  const decr = new Float32Array(nTot); // decremental strength
  const restR = new Float32Array(nTot).fill(0.4); // ERP restitution strength
  for (let i = 0; i < nTot; i++) {
    const r = region[i];
    let c = chArr[i] === CH.RA ? 0.42 : 0.8, e = chArr[i] === CH.RA ? 185 : 200, t = 2, a = 2.5 + R() * 1.5, ex = 1;
    switch (r) {
      case REG.CT: c = 0; ex = 0; t = 5; a = 2.5; break;
      case REG.CTI: c = 0.55; t = 3.5; a = 2.2 + R(); break;
      case REG.SVC: c = 0.6; t = 1.5; a = 1.2 + R() * 0.6; break;
      case REG.RAA: t = 1.5; break;
      case REG.KOCH: c = 0.6; t = 3; a = 1.5 + R(); break;
      case REG.PV: c = 0.6; e = 175; t = Math.max(0.9, 1.8 - sleeveD[i] * 0.04); a = Math.max(0.3, 1.8 - sleeveD[i] * 0.06) + R() * 0.4; break;
      case REG.LAA: t = 1.5; a = 3 + R(); break;
      case REG.POST: t = 2.2; break;
      case REG.MI: t = 3.5; c = 0.75; break;
      case REG.CS: c = 0.7; t = 1.5; a = 1 + R() * 0.8; break;
      case REG.RV: case REG.RVOT: c = 0.7; e = 270; t = 4.5; a = 4 + R() * 3; break;
      case REG.RVSEPT: c = 0.7; e = 270; t = 9; a = 5 + R() * 3; break;
      case REG.LV: case REG.LVSEPT: c = 0.7; e = 270; t = 10; a = 6 + R() * 4; break;
      case REG.VEIN: c = 0; ex = 0; t = 0.5; a = 0.03 + R() * 0.05; break;
      case REG.VIRT: c = 1; e = 280; t = 0; a = 0; break;
    }
    cv[i] = c; erp[i] = e; thick[i] = t; amp[i] = a; excit[i] = ex;
    gain[i] = r === REG.VIRT ? 0 : chamber[i] === CH.RV || chamber[i] === CH.LV ? 7 : t * 0.8;
  }
  const retroPen = new Uint8Array(nTot);
  retroPen[V.LBB[0]] = 1; retroPen[V.RBB[1]] = 1;
  const gainB = new Float32Array(nTot);
  for (let i = 0; i < nTot; i++) gainB[i] = chamber[i] === CH.RV || chamber[i] === CH.LV ? 3 : gain[i] * 3.5;
  const vi = (name) => nMesh + vname.indexOf(name);
  // conduction system parameters
  for (const k of V.FP) { erp[k] = dual ? 360 : scenario === 'WPW' ? 260 : scenario === 'PAF' ? 340 : 300; decr[k] = 1.6; restR[k] = 0.25; }
  for (const k of V.SP) { erp[k] = 270; decr[k] = 1.2; restR[k] = 0.25; }
  erp[V.CN] = 250; decr[V.CN] = 1.0; restR[V.CN] = 0.25;
  erp[V.HIS] = 300; gain[V.HIS] = 1.2; amp[V.HIS] = 0.3;
  for (const k of [...V.RBB, ...V.LBB]) { erp[k] = 300; gain[k] = 0.3; }
  for (const k of V.AP) { erp[k] = 320; restR[k] = 0.15; }
  void vi;

  // scenario-specific substrate
  const focus = {};
  if (scenario === 'AFL') {
    // longer refractoriness band at the septal CTI (enables unidirectional block on CS-os pacing)
    const ctiDir = norm(sub(lm.cti[1], lm.cti[0]));
    const mid = lerp(lm.cti[0], lm.cti[1], 0.5);
    let u = sub(lm.csOs, mid);
    u = norm(sub(u, mul(ctiDir, dot(u, ctiDir))));
    const bandCenter = add(mid, mul(u, 5));
    for (let i = 0; i < nMesh; i++) {
      if (chamber[i] !== CH.RA || !excit[i]) continue;
      const d = sub(P(i), bandCenter);
      if (Math.abs(dot(d, u)) < 3.5 && len(d) < 26 && P(i)[1] < bandCenter[1] + 10) { erp[i] = 235; restR[i] = 0.1; region[i] = REG.CTI; }
    }
    lm.ctiBand = bandCenter;
  }
  if (scenario === 'PAF') {
    // spatially heterogeneous refractoriness + patchy fibrosis (substrate for fibrillatory conduction)
    const atrial = [];
    for (let i = 0; i < nMesh; i++) if (chamber[i] === CH.LA || chamber[i] === CH.RA) atrial.push(i);
    const centers = Array.from({ length: 40 }, () => [P(atrial[Math.floor(R() * atrial.length)]), 0.8 + R() * 0.45]);
    for (const i of atrial) {
      let w = 0, m = 0;
      for (const [c, f] of centers) { const d = dist(P(i), c); const k = Math.exp(-(d * d) / 150); w += k; m += k * f; }
      const mult = w > 0.05 ? m / w : 1;
      erp[i] *= chamber[i] === CH.LA ? mult : 0.5 + 0.5 * mult;
      cv[i] *= 0.85 + R() * 0.3;
      if (chamber[i] === CH.LA && region[i] !== REG.PV && R() < 0.035) { excit[i] = 0; amp[i] = 0.2 + R() * 0.3; }
    }
  }
  if (scenario === 'PVC') {
    focus.pvc = { pos: lm.rvotFocus, nodes: within('RV', lm.rvotFocus, 3.5), depth: 2.5 };
  }
  if (scenario === 'PAF') {
    focus.pv = {};
    for (let k = 0; k < 4; k++) {
      const v = L.PV[PV_NAMES[k]];
      const fp = add(v.o, mul(v.d, 10));
      const nodes = meshNodes('LA').filter((i) => pvIdx[i] === k && Math.abs(sleeveD[i] - 10) < 2.5);
      // a small patch on one side of the vein
      const ref = nodes.length ? P(nodes[0]) : fp;
      focus.pv[PV_NAMES[k]] = { nodes: nodes.filter((i) => dist(P(i), ref) < 4.5), pos: ref };
    }
  }
  focus.sn = within('RA', lm.sn, 4);

  // ---- edges ----
  const adj = Array.from({ length: nTot }, () => []);
  const link = (a, b, delay) => { adj[a].push([b, delay]); adj[b].push([a, delay]); };
  const seen = new Set();
  for (const id of CHAMBER_IDS) {
    const o = offset[id], I = meshes[id].indices;
    for (let t = 0; t < I.length; t += 3)
      for (let e = 0; e < 3; e++) {
        const a = o + I[t + e], b = o + I[t + ((e + 1) % 3)];
        const key = a < b ? a * 1e6 + b : b * 1e6 + a;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!excit[a] || !excit[b]) continue;
        const ce = 2 / (1 / cv[a] + 1 / cv[b]);
        link(a, b, dist(P(a), P(b)) / ce);
        if (epiOf[a] >= 0 && epiOf[b] >= 0) link(epiOf[a], epiOf[b], dist(P(epiOf[a]), P(epiOf[b])) / ce);
      }
  }
  for (const i of epiTwin) link(i, epiOf[i], dist(P(i), P(epiOf[i])) / 0.45); // transmural
  // inter-chamber links
  const linkSets = (A, B, maxD, cvl, maxPer = 3) => {
    for (const a of A) {
      const cand = B.map((b) => [b, dist(P(a), P(b))]).filter((x) => x[1] < maxD && excit[x[0]]).sort((x, y) => x[1] - y[1]).slice(0, maxPer);
      for (const [b, d] of cand) if (excit[a]) link(a, b, d / cvl);
    }
  };
  linkSets(within('RA', lm.bachRA, 5), within('LA', lm.bachLA, 5), 40, 1.6, 2); // Bachmann
  linkSets(within('RA', lm.fossaRA, 4), within('LA', lm.fossaLA, 4), 30, 1.0, 1); // posterior septal
  const csN = meshNodes('CS').filter((i) => region[i] === REG.CS);
  linkSets(csN.filter((i) => sleeveD[i] < 8), meshNodes('RA'), 7, 0.6, 2);
  linkSets(csN.filter((i) => sleeveD[i] > 10 && sleeveD[i] < 50 && R() < 0.25), meshNodes('LA'), 9, 0.5, 1);
  // ventricular septum (transmural coupling)
  linkSets(meshNodes('RV').filter((i) => region[i] === REG.RVSEPT && R() < 0.5), meshNodes('LV').filter((i) => region[i] === REG.LVSEPT), 22, 0.5, 1);

  // conduction system
  const chain = (arr, total) => { for (let k = 0; k < arr.length - 1; k++) link(arr[k], arr[k + 1], total / (arr.length - 1)); };
  const ins = (node, cid, p, r, delay) => { for (const m of within(cid, p, r)) if (excit[m]) link(node, m, delay); };
  ins(V.FP[0], 'RA', fpIns, 4, 6);
  chain(V.FP, 36); link(V.FP[V.FP.length - 1], V.CN, 10);
  if (V.SP.length) {
    ins(V.SP[0], 'RA', spIns, 4, 6);
    chain(V.SP, 120); link(V.SP[V.SP.length - 1], V.CN, 15);
  }
  link(V.CN, V.HIS, 22);
  link(V.HIS, V.RBB[0], 20); link(V.RBB[0], V.RBB[1], 10);
  link(V.HIS, V.LBB[0], 18);
  // Purkinje terminals
  const lvN = meshNodes('LV'), rvN = meshNodes('RV');
  const lvAx = norm(sub(chambers.lvApex, chambers.lvBase));
  const lvFrac = (i) => dot(sub(P(i), chambers.lvBase), lvAx) / dist(chambers.lvApex, chambers.lvBase);
  const purk = [];
  for (const i of lvN) if (lvFrac(i) > 0.25 && R() < 0.04) { link(V.LBB[0], i, 8 + dist(P(V.LBB[0]), P(i)) / 2.2); purk.push(i); }
  for (const i of rvN) if (region[i] !== REG.RVOT && dist(P(i), lm.rvApex) < 30 && R() < 0.07) { link(V.RBB[1], i, 6 + dist(P(V.RBB[1]), P(i)) / 2.2); purk.push(i); }
  // accessory pathway
  if (V.AP.length) {
    ins(V.AP[0], 'LA', lm.mvLat, 4, 4);
    link(V.AP[0], V.AP[1], 6);
    ins(V.AP[1], 'LV', lm.mvLatLV, 5, 4);
  }

  // CSR
  const offs = new Int32Array(nTot + 1);
  for (let i = 0; i < nTot; i++) offs[i + 1] = offs[i] + adj[i].length;
  const nbr = new Int32Array(offs[nTot]), edelay = new Float32Array(offs[nTot]), ew = new Float32Array(offs[nTot]);
  for (let i = 0; i < nTot; i++) {
    let k = offs[i];
    for (const [j, d] of adj[i]) {
      nbr[k] = j; edelay[k] = d;
      const dd = dist(P(i), P(j));
      const tm = (i < nMesh && epiOf[i] === j) || (j < nMesh && epiOf[j] === i);
      ew[k] = chamber[i] === chamber[j] && chamber[i] !== CH.VIRT ? (tm ? 3 : 1) / Math.max(dd, 0.8) : 0; // electrical coupling for EGM laplacian
      k++;
    }
  }

  // vertex normals (outward) from SDF
  const normal = new Float32Array(nTot * 3);
  for (let i = 0; i < nBase; i++) normal.set(nrmArr[i], i * 3);

  return {
    scenario, heart, n: nTot, nMesh, nBase, isEpi, epiOf, offset, pos, normal, chamber, region, pvIdx, sleeve: sleeveD,
    cv, erp, thick, amp, gain, gainB, excit, decr, restR, retroPen,
    offs, nbr, edelay, ew,
    V, vname, lm, focus, purk,
    rings: { tvRA, mvLA, tvRV, mvLV },
    P, within, nearest, meshNodes,
  };
}
void cross;
