// Event-driven excitation propagation on the tissue graph.
// Each node: excitable cell with restitution-dependent refractoriness and conduction slowing at short diastolic intervals.
import { CH, REG } from './tissue.js';

export const ORIGIN = { NONE: 0, SN: 1, STIM: 2, PVC: 3, PV: 4, JUNC: 5, ESC: 6, PAC: 7 };
const UP = 3, REPOL_MAX = 150, NB = 4096;

class Heap {
  constructor(cap = 1 << 16) { this.t = new Float64Array(cap); this.i = new Int32Array(cap); this.o = new Int16Array(cap); this.n = 0; }
  grow() { const c = this.t.length * 2; const t = new Float64Array(c), i = new Int32Array(c), o = new Int16Array(c); t.set(this.t); i.set(this.i); o.set(this.o); this.t = t; this.i = i; this.o = o; }
  push(t, i, o) {
    if (this.n >= this.t.length) this.grow();
    let k = this.n++;
    const T = this.t, I = this.i, O = this.o;
    while (k > 0) { const p = (k - 1) >> 1; if (T[p] <= t) break; T[k] = T[p]; I[k] = I[p]; O[k] = O[p]; k = p; }
    T[k] = t; I[k] = i; O[k] = o;
  }
  pop() { // returns index into scratch
    const T = this.t, I = this.i, O = this.o;
    this.rt = T[0]; this.ri = I[0]; this.ro = O[0];
    const n = --this.n;
    if (n > 0) {
      const t = T[n], i = I[n], o = O[n];
      let k = 0;
      for (;;) {
        let c = 2 * k + 1; if (c >= n) break;
        if (c + 1 < n && T[c + 1] < T[c]) c++;
        if (T[c] >= t) break;
        T[k] = T[c]; I[k] = I[c]; O[k] = O[c]; k = c;
      }
      T[k] = t; I[k] = i; O[k] = o;
    }
  }
  clear() { this.n = 0; }
}

export class Sim {
  constructor(T) {
    this.T = T;
    const n = T.n;
    this.t = 0;
    this.lastAct = new Float64Array(n).fill(-1e9);
    this.refrEnd = new Float64Array(n).fill(-1e9);
    this.apd = new Float32Array(n).fill(200);
    this.origin = new Int8Array(n);
    this.alive = new Uint8Array(T.excit);
    this.blockUntil = new Float64Array(n); // transient block (edema / cryo-mapping)
    this.concealUntil = new Float64Array(n);
    this.erpMul = new Float32Array(n).fill(1);
    this.repol = new Float32Array(n);
    this.apdOff = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const v = T.chamber[i] === CH.RV || T.chamber[i] === CH.LV;
      this.repol[i] = v ? 110 : 140;
      this.apdOff[i] = v ? (T.isEpi[i] ? -55 : 0) : -20;
    }
    this.heap = new Heap();
    this.buckets = Array.from({ length: NB }, () => []); // activation time buckets (ms)
    this.rbuckets = Array.from({ length: NB }, () => []); // repolarization-start buckets
    this.lastBucket = 0;
    this.isVent = new Uint8Array(n);
    for (let i = 0; i < n; i++) this.isVent[i] = T.chamber[i] === CH.RV || T.chamber[i] === CH.LV ? 1 : 0;
    this.lastVent = -1e9; this.ventBeatStart = -1e9; this.ventBeats = []; // [{t, origin}]
    this.lastAtrialBeat = -1e9; this.atrialBeats = [];
    this.pacemakers = [];
    this.scheduled = []; // [{t, fn}]
    this.iso = 1; // autonomic factor (isoproterenol >1)
    this.onBeat = null;
    this.cnBlockRisk = 0;
    this.junctional = 0; // >0 while heating slow-pathway region (junctional rhythm)
    this.lastJunc = -1e9;
    this.escapeOn = true;
  }

  // ---- core ----
  push(t, i, o) { this.heap.push(t, i, o); }
  stimNodes(nodes, t, o = ORIGIN.STIM) { for (const i of nodes) this.heap.push(t, i, o); }

  activate(i, t, o) {
    const T = this.T;
    const DI = t - this.refrEnd[i];
    const di = DI > 0 ? DI : 0;
    let e = T.erp[i] * this.erpMul[i] * (1 - T.restR[i] * Math.exp(-di / 80)) / (T.chamber[i] === CH.VIRT ? Math.sqrt(this.iso) : 1);
    if (this.avJitter && T.decr[i] > 0) e *= 0.75 + 0.5 * Math.random(); // irregular AV-nodal refractoriness during fibrillatory input
    const apd = e + 12 + this.apdOff[i];
    this.lastAct[i] = t; this.refrEnd[i] = t + e; this.apd[i] = apd; this.origin[i] = o;
    const ms = Math.floor(t);
    this.buckets[ms & (NB - 1)].push(i);
    this.rbuckets[Math.floor(t + apd) & (NB - 1)].push(i);
    if (this.isVent[i]) {
      if (t - this.lastVent > 160) { this.ventBeatStart = t; this.ventBeats.push({ t, o }); if (this.ventBeats.length > 64) this.ventBeats.shift(); this.onVentBeat && this.onVentBeat(t, o); }
      this.lastVent = t;
    }
    const offs = T.offs, nbr = T.nbr, ed = T.edelay, decr = T.decr, alive = this.alive, refr = this.refrEnd;
    for (let k = offs[i], ke = offs[i + 1]; k < ke; k++) {
      const j = nbr[k];
      if (!alive[j]) continue;
      const base = ed[k];
      const dij = t + base - refr[j];
      if (dij < -3 * base - 20) continue; // certainly refractory at arrival
      const dp = dij > 0 ? dij : 0;
      let f = 1 + 0.9 * Math.exp(-dp / 22);
      if (decr[j] > 0) f += (decr[j] * Math.exp(-dp / 110)) / this.iso;
      if (T.retroPen[j] && T.chamber[i] !== CH.VIRT) f *= 4; // slow retrograde Purkinje entry
      this.heap.push(t + base * f, j, o);
    }
  }

  // advance simulation to time tEnd (ms)
  run(tEnd) {
    const H = this.heap;
    while (this.t < tEnd) {
      const tn = Math.min(tEnd, Math.floor(this.t) + 1);
      this.tick(tn);
      while (H.n > 0 && H.t[0] <= tn) {
        H.pop();
        const ta = H.rt, j = H.ri;
        if (!this.alive[j] || this.blockUntil[j] > ta || ta - this.lastAct[j] < 1) continue;
        if (ta < this.refrEnd[j]) {
          // concealed conduction: a blocked impulse late in the refractory period prolongs AV-nodal refractoriness
          if (this.T.decr[j] > 0 && ta > this.lastAct[j] + 0.55 * (this.refrEnd[j] - this.lastAct[j]) && this.concealUntil[j] < ta) {
            this.refrEnd[j] += 18 + 30 * Math.random(); this.concealUntil[j] = ta + 25;
          }
          continue;
        }
        this.activate(j, ta, H.ro);
      }
      // clear bucket that will be reused
      const nb = (Math.floor(tn) + NB / 2) & (NB - 1);
      this.buckets[nb].length = 0; this.rbuckets[nb].length = 0;
      this.t = tn;
    }
  }

  // automaticity & scheduled events, called every ms
  tick(t) {
    for (const pm of this.pacemakers) pm.tick && pm.tick(this, t);
    if (this.scheduled.length) {
      const due = this.scheduled.filter((s) => s.t <= t);
      if (due.length) {
        this.scheduled = this.scheduled.filter((s) => s.t > t);
        for (const s of due) s.fn(t);
      }
    }
    const V = this.T.V;
    // junctional rhythm during slow-pathway heating
    if (this.junctional > 0 && this.alive[V.CN] && t - this.lastJunc > 650 && t - this.lastAct[V.CN] > 500) {
      this.lastJunc = t; this.push(t, V.CN, ORIGIN.JUNC);
    }
    if (this.escapeOn) {
      if (this.alive[V.CN] && this.alive[V.HIS] && t - this.lastAct[V.HIS] > 1500 && t - this.lastVent > 1500) this.push(t, V.CN, ORIGIN.ESC);
      else if (t - this.lastVent > 2000 && this.T.purk.length) this.push(t, this.T.purk[0], ORIGIN.ESC);
    }
  }

  schedule(t, fn) { this.scheduled.push({ t, fn }); }

  // nodes recently activated (upstroke window) and repolarizing at time t
  sets(t, needWide) {
    const up = [], wide = needWide ? [] : null;
    const ms = Math.floor(t);
    const D = needWide ? 40 : 15;
    const iv = this.isVent;
    for (let d = 0; d <= D; d++) {
      const b = this.buckets[(ms - d) & (NB - 1)];
      for (let k = 0; k < b.length; k++) {
        const i = b[k];
        const u = t - this.lastAct[i];
        if (u >= 0 && u <= 41) { if (needWide) wide.push(i); if (u <= UP + 1 || (iv[i] && u <= 15)) up.push(i); }
      }
    }
    if (needWide) {
      for (let d = 0; d <= REPOL_MAX; d++) {
        const b = this.rbuckets[(ms - d) & (NB - 1)];
        for (let k = 0; k < b.length; k++) { const i = b[k]; const u = t - this.lastAct[i] - this.apd[i]; if (u >= 0 && u <= this.repol[i]) wide.push(i); }
      }
    }
    return { up, wide };
  }
  vm(i, t) {
    const u = t - this.lastAct[i];
    if (u < 0) return 0;
    if (u < UP) return u / UP;
    const a = this.apd[i];
    if (u < a) return 1;
    const r = this.repol[i];
    if (u < a + r) { const x = (u - a) / r; return 1 - x * x * (3 - 2 * x); }
    return 0;
  }

  // ---- tissue modification ----
  kill(i) { this.alive[i] = 0; }
  isolatedFrom(sourceNodes, targetTest) {
    // BFS over alive and not-blocked nodes from sources; returns true if target not reachable
    const T = this.T, seen = new Uint8Array(T.n), q = [];
    for (const s of sourceNodes) if (this.alive[s] && this.blockUntil[s] <= this.t) { seen[s] = 1; q.push(s); }
    while (q.length) {
      const i = q.pop();
      if (targetTest(i)) return false;
      for (let k = T.offs[i]; k < T.offs[i + 1]; k++) {
        const j = T.nbr[k];
        if (!seen[j] && this.alive[j] && this.blockUntil[j] <= this.t) { seen[j] = 1; q.push(j); }
      }
    }
    return true;
  }
}

// ---- pacemakers ----
export function sinusNode(nodes, cl = 820) {
  return {
    kind: 'SN', nodes, cl, jitter: 0,
    tick(sim, t) {
      if (!this.enabled) return;
      let last = -1e9, any = false;
      for (const i of this.nodes) { if (sim.alive[i]) any = true; if (sim.lastAct[i] > last) last = sim.lastAct[i]; }
      if (!any) return;
      const cl = this.cl / sim.iso + this.jitter;
      if (t - last >= cl) { sim.stimNodes(this.nodes, t, ORIGIN.SN); this.jitter = (Math.random() - 0.5) * 30; }
    },
    enabled: true,
  };
}

export { REG };
