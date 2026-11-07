// Electrogram / surface ECG synthesis from transmembrane potential gradients (graph-Laplacian current sources)
import { S as SC } from './anatomy.js';

export const BODY = {
  RA: [-170, 150, 0], LA: [170, 150, 0], LL: [40, -260, 0],
  V1: SC([-24, -4, 78]), V2: SC([22, -4, 80]), V3: SC([48, -18, 76]), V4: SC([70, -34, 66]), V5: SC([102, -36, 36]), V6: SC([122, -36, -6]),
};
export const ECG_LEADS = ['I', 'II', 'III', 'aVR', 'aVL', 'aVF', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6'];

const BUF = 16384; // ms of history

export class EGMEngine {
  constructor(T, S) {
    this.T = T; this.S = S;
    this.acc = new Float64Array(T.n);
    this.accR = new Float64Array(T.n);
    this.mark = new Int32Array(T.n);
    this.stamp = 1;
    this.electrodes = new Map(); // id -> {pos, kind}
    this.channels = []; // {key,label,a,b,type,color,gain,buf,hp:{y,x}}
    this.kIntra = 0.35; this.kBody = 2.2; this.limbGain = 3; this.bodyDecim = 8; this.icDecim = 2;
    this.tLast = 0;
    this.stimMarks = [];
    for (const [k, p] of Object.entries(BODY)) this.electrodes.set('B_' + k, { pos: p, kind: 'body', phi: 0, K: this.leadField(p) });
    this.ecg = {};
    for (const l of ECG_LEADS) this.ecg[l] = new Float32Array(BUF);
    this.ecgHP = Object.fromEntries(ECG_LEADS.map((l) => [l, { y: 0, x: 0, lp: 0 }]));
    this.noiseSeed = 1;
  }
  // Laplacian of the lead field: phi_e = sum_i Vm_i * K_e(i)
  leadField(p) {
    const T = this.T, n = T.n, P = T.pos;
    const Lf = new Float32Array(n), K = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const r = Math.hypot(P[i * 3] - p[0], P[i * 3 + 1] - p[1], P[i * 3 + 2] - p[2]);
      Lf[i] = T.gainB[i] / r;
    }
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = T.offs[i]; k < T.offs[i + 1]; k++) { const w = T.ew[k]; if (w) s += w * (Lf[T.nbr[k]] - Lf[i]); }
      K[i] = s;
    }
    return K;
  }
  bodyStep(t) {
    const T = this.T, S = this.S, n = T.n;
    const bodyE = this.bodyE || (this.bodyE = [...this.electrodes.values()].filter((e) => e.kind === 'body'));
    const prev = this.prevV || (this.prevV = new Float32Array(n));
    const full = true;
    if (full) {
      this.tFull = t;
      for (const e of bodyE) e.raw = 0;
      for (let i = 0; i < n; i++) {
        const v = S.vm(i, t);
        prev[i] = v;
        if (v !== 0) for (const e of bodyE) e.raw += v * e.K[i];
      }
    } else {
      const st = ++this.stamp, mark = this.mark;
      const span = t - this.tBody;
      const ms = Math.floor(t);
      const visit = (i) => {
        if (mark[i] === st) return;
        mark[i] = st;
        const v = S.vm(i, t), dv = v - prev[i];
        if (dv === 0) return;
        prev[i] = v;
        for (const e of bodyE) e.raw += dv * e.K[i];
      };
      for (let d = 0; d <= span + 5; d++) for (const i of S.buckets[(ms - d) & 4095]) visit(i);
      for (let d = 0; d <= span + 152; d++) for (const i of S.rbuckets[(ms - d) & 4095]) visit(i);
    }
    this.tBody = t;
    for (const e of bodyE) e.phi = e.raw * this.kBody;
  }
  setElectrode(id, pos, kind = 'intra') {
    let e = this.electrodes.get(id);
    if (!e) { e = { pos, kind, phi: 0 }; this.electrodes.set(id, e); this.groups = null; }
    e.pos = pos; e.kind = kind;
  }
  initBins() {
    const T = this.T, c = 10;
    const P = T.pos;
    let mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
    for (let i = 0; i < T.n; i++) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], P[i * 3 + k]); mx[k] = Math.max(mx[k], P[i * 3 + k]); }
    const dims = [0, 1, 2].map((k) => Math.floor((mx[k] - mn[k]) / c) + 1);
    const nc = dims[0] * dims[1] * dims[2];
    const B = { cellOf: new Int32Array(T.n), count: new Int32Array(nc), sum: new Float64Array(nc), start: new Int32Array(nc), fill: new Int32Array(nc), order: new Int32Array(T.n), touched: new Int32Array(nc), cx: new Float32Array(nc), cy: new Float32Array(nc), cz: new Float32Array(nc) };
    for (let i = 0; i < T.n; i++) {
      const x = Math.floor((P[i * 3] - mn[0]) / c), y = Math.floor((P[i * 3 + 1] - mn[1]) / c), z = Math.floor((P[i * 3 + 2] - mn[2]) / c);
      B.cellOf[i] = x + dims[0] * (y + dims[1] * z);
    }
    for (let z = 0; z < dims[2]; z++) for (let y = 0; y < dims[1]; y++) for (let x = 0; x < dims[0]; x++) {
      const b = x + dims[0] * (y + dims[1] * z);
      B.cx[b] = mn[0] + (x + 0.5) * c; B.cy[b] = mn[1] + (y + 0.5) * c; B.cz[b] = mn[2] + (z + 0.5) * c;
    }
    this.bins = B;
    return B;
  }
  buildGroups() {
    const m = new Map();
    for (const [id, e] of this.electrodes) {
      if (e.kind === 'body') continue;
      const g = id.split('_')[0];
      if (!m.has(g)) m.set(g, { list: [], center: [0, 0, 0], farR2: 0 });
      m.get(g).list.push(e);
    }
    this.groups = [...m.values()];
    this.updateGroups();
    return this.groups;
  }
  // call when electrodes moved
  updateGroups() {
    if (!this.groups) return;
    for (const g of this.groups) {
      const c = [0, 0, 0];
      for (const e of g.list) { c[0] += e.pos[0]; c[1] += e.pos[1]; c[2] += e.pos[2]; }
      c[0] /= g.list.length; c[1] /= g.list.length; c[2] /= g.list.length;
      let rad = 0;
      for (const e of g.list) rad = Math.max(rad, Math.hypot(e.pos[0] - c[0], e.pos[1] - c[1], e.pos[2] - c[2]));
      g.center = c; g.farR2 = (rad + 30) ** 2;
    }
  }
  removeElectrodes(prefix) { this.groups = null; for (const k of [...this.electrodes.keys()]) if (k.startsWith(prefix)) this.electrodes.delete(k); }
  setChannels(list) {
    const old = new Map(this.channels.map((c) => [c.key, c]));
    this.channels = list.map((c) => {
      const o = old.get(c.key);
      if (o) { Object.assign(o, c); return o; }
      return { ...c, buf: new Float32Array(BUF), hp: { y: 0, x: 0 } };
    });
  }

  // compute one millisecond
  step(t) {
    const T = this.T, S = this.S;
    const doBody = (Math.floor(t) % this.bodyDecim) === 0;
    const PR = this.prof; let _t = PR ? performance.now() : 0; const lap = (k) => { if (!PR) return; const n = performance.now(); PR[k] = (PR[k] || 0) + n - _t; _t = n; };
    if (doBody) this.bodyStep(t);
    if (Math.floor(t) % this.icDecim !== 0) { this.write(t); return; }
    const { up } = S.sets(t, false); lap('sets'); if (PR) PR.nUp = (PR.nUp || 0) + up.length;
    const acc = this.acc, accR = this.accR, mark = this.mark;
    const st = ++this.stamp;
    const touched = [];
    for (const i of up) mark[i] = st;
    const offs = T.offs, nbr = T.nbr, ew = T.ew;
    for (const i of up) {
      const vi = S.vm(i, t);
      for (let k = offs[i]; k < offs[i + 1]; k++) {
        const w = ew[k]; if (w === 0) continue;
        const j = nbr[k];
        if (mark[j] === st && j < i) continue;
        const vj = S.vm(j, t);
        if (vj === vi) continue;
        const d = w * (vj - vi);
        if (acc[i] === 0) touched.push(i);
        acc[i] += d;
        if (acc[j] === 0) touched.push(j);
        acc[j] -= d;
      }
    }
    lap('acc');
    lap('body');
    const srcI = [], srcV = [];
    for (const i of touched) if (acc[i] !== 0) { srcI.push(i); srcV.push(acc[i] * T.gain[i]); acc[i] = 0; }
    if (PR) PR.nSrc = (PR.nSrc || 0) + srcI.length;
    const P = T.pos;
    // spatial binning of sources (10 mm cells): far bins handled as aggregated point sources
    const B = this.bins || this.initBins();
    const ns = srcI.length;
    const btouch = B.touched; let nt = 0;
    for (let k = 0; k < ns; k++) {
      const i = srcI[k];
      const b = B.cellOf[i];
      if (B.count[b] === 0) { btouch[nt++] = b; B.sum[b] = 0; }
      B.count[b]++;
      B.sum[b] += srcV[k];
    }
    // counting sort into order[]
    let acc2 = 0;
    for (let m = 0; m < nt; m++) { const b = btouch[m]; B.start[b] = acc2; acc2 += B.count[b]; B.fill[b] = B.start[b]; }
    for (let k = 0; k < ns; k++) { const b = B.cellOf[srcI[k]]; B.order[B.fill[b]++] = k; }
    const groups = this.groups || this.buildGroups();
    for (const g of groups) {
      const c = g.center;
      let far = 0;
      let nn = 0;
      const near = this.nearBuf || (this.nearBuf = new Int32Array(T.n));
      const lim = g.farR2;
      for (let m = 0; m < nt; m++) {
        const b = btouch[m];
        const dx = B.cx[b] - c[0], dy = B.cy[b] - c[1], dz = B.cz[b] - c[2];
        const r2 = dx * dx + dy * dy + dz * dz;
        if (r2 > lim) far += B.sum[b] / Math.sqrt(r2);
        else for (let q = B.start[b], qe = B.start[b] + B.count[b]; q < qe; q++) near[nn++] = B.order[q];
      }
      for (const e of g.list) {
        const p = e.pos;
        let phi = far;
        for (let m = 0; m < nn; m++) {
          const k = near[m], i = srcI[k];
          const dx = P[i * 3] - p[0], dy = P[i * 3 + 1] - p[1], dz = P[i * 3 + 2] - p[2];
          const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
          phi += srcV[k] / (r < 1.1 ? 1.1 : r);
        }
        e.phi = phi * this.kIntra;
      }
    }
    for (let m = 0; m < nt; m++) B.count[btouch[m]] = 0;
    lap('groups');
    this.write(t);
    lap('write');
  }

  noise(a) { // cheap deterministic noise
    this.noiseSeed = (this.noiseSeed * 1103515245 + 12345) & 0x7fffffff;
    return ((this.noiseSeed / 0x7fffffff) - 0.5) * a;
  }

  write(t) {
    const idx = Math.floor(t) & (BUF - 1);
    const E = this.electrodes;
    const g = (k) => E.get('B_' + k).phi;
    const LG = this.limbGain;
    const ra = g('RA') * LG, la = g('LA') * LG, ll = g('LL') * LG;
    const wct = (ra + la + ll) / 3;
    const raw = {
      I: la - ra, II: ll - ra, III: ll - la,
      aVR: ra - (la + ll) / 2, aVL: la - (ra + ll) / 2, aVF: ll - (ra + la) / 2,
      V1: g('V1') - wct, V2: g('V2') - wct, V3: g('V3') - wct, V4: g('V4') - wct, V5: g('V5') - wct, V6: g('V6') - wct,
    };
    if (this.stOffset) {
      const u = t - this.S.ventBeatStart;
      if (u > 50 && u < 330) { const st = this.stOffset * Math.sin(((u - 50) / 280) * Math.PI) ** 0.5; raw.II += st; raw.III += st * 1.1; raw.aVF += st; raw.aVL -= st * 0.6; raw.I -= st * 0.3; }
    }
    for (const l of ECG_LEADS) {
      const h = this.ecgHP[l];
      const x = raw[l] + this.noise(0.012);
      const y = 0.9985 * (h.y + x - h.x); // ~0.25 Hz high-pass
      h.x = x; h.y = y;
      h.lp += 0.2 * (y - h.lp); // 2-pole low-pass (~35 Hz)
      h.lp2 = (h.lp2 || 0) + 0.2 * (h.lp - (h.lp2 || 0));
      this.ecg[l][idx] = h.lp2;
    }
    // intracardiac channels
    for (const c of this.channels) {
      const a = E.get(c.a);
      if (!a) { c.buf[idx] = 0; continue; }
      let x;
      if (c.type === 'bi') { const b = E.get(c.b); x = b ? a.phi - b.phi : 0; }
      else x = a.phi - (E.get('B_RA').phi + E.get('B_LA').phi + E.get('B_LL').phi) / 3 * (this.kIntra / this.kBody);
      x += this.noise(c.type === 'bi' ? 0.02 : 0.04);
      const alpha = c.type === 'bi' ? 0.84 : 0.99;
      const y = alpha * (c.hp.y + x - c.hp.x);
      c.hp.x = x; c.hp.y = y;
      c.buf[idx] = y;
    }
    this.tLast = t;
  }
}
export const EGM_BUF = BUF;
