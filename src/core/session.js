// Session: ties scenario, catheters, EGM, mapping, stimulation and ablation together (no DOM)
import { createScenario, SCENARIOS, pvIsolationStatus, ctiBlocked, apBlocked, spBlocked, pvcEliminated } from './scenarios.js';
import { EGMEngine, ECG_LEADS } from './egm.js';
import { SpatialHash } from './grid.js';
import { SteerableCatheter, FixedCatheter, channelDefs, CATH_DEFS } from './catheter.js';
import { FamMap } from './fam.js';
import { Ablation, DEVICES } from './ablation.js';
import { ORIGIN } from './sim.js';
import { CH, REG, PV_NAMES } from './tissue.js';
import { dist, add, mul } from './vec.js';

export const PACE_SITES = {
  HRA12: { label: 'HRA d', cath: 'HRA', e: 'HRA_1' },
  HALO12: { label: 'Halo 1-2', cath: 'HALO', e: 'HALO_1' },
  HALO1920: { label: 'Halo 19-20', cath: 'HALO', e: 'HALO_19' },
  CS910: { label: 'CS 9-10', cath: 'CS', e: 'CS_9' },
  CS12: { label: 'CS 1-2', cath: 'CS', e: 'CS_1' },
  RV12: { label: 'RV d', cath: 'RVA', e: 'RVA_1' },
  ABLd: { label: 'ABL d', cath: 'ABL', e: 'ABL_1' },
};

export class Session {
  constructor(key, opts = {}) {
    this.key = key;
    this.def = SCENARIOS[key];
    const st = createScenario(key, opts.seed || 7);
    this.st = st;
    const T = (this.T = st.T), S = (this.S = st.S);
    this.E = new EGMEngine(T, S);
    const endo = [];
    for (let i = 0; i < T.nMesh; i++) endo.push(i);
    this.hash = new SpatialHash(T.pos, endo, 4);
    this.LAnodes = endo.filter((i) => T.chamber[i] === CH.LA);
    this.logs = [];
    this.alerts = [];
    this.listeners = {};
    this.abl = new Ablation({
      T, S, st, hash: this.hash, LAnodes: this.LAnodes,
      log: (m, l) => this.log(m, l), alert: (m, l) => this.alert(m, l),
      pvIso: () => pvIsolationStatus(st),
    });
    this.cath = {};
    this.inserted = new Set();
    for (const k of ['HRA', 'HALO', 'HIS', 'RVA', 'CS']) this.cath[k] = new FixedCatheter(k, T.heart, T);
    this.cath.ABL = new SteerableCatheter('ABL', T.heart, T);
    this.cath.MAP = new SteerableCatheter('MAP', T.heart, T);
    this.maps = {};
    this.activeMap = null;
    this.famOn = false; this.acqOn = false;
    this.refMode = key === 'PVC' ? 'QRS' : 'CS';
    this.pvcOnly = key === 'PVC';
    this.lastRef = -1e9; this.pendingAcq = null;
    this.pace = { site: 'CS910', cl: 600, on: false, next: 0, out: 10, lastStim: -1e9, train: null };
    this.ppi = null;
    this.stims = []; // stim times for display
    this.paceMap = null; this.pvcTemplate = null;
    this.time = 0;
    this.t0Real = 0;
    this.status = {};
    // default catheters
    for (const k of opts.catheters || ['HRA', 'HIS', 'RVA', 'CS', 'ABL']) this.insert(k);
    this.log(`シナリオ開始：${this.def.name}`, 'info');
    if (key === 'PVC') S.onVentBeatOrig = S.onVentBeat;
    this.hookBeats();
  }

  on(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
  emit(ev, x) { for (const f of this.listeners[ev] || []) f(x); }
  log(msg, level = 'info') { const e = { t: this.S.t, msg, level }; this.logs.push(e); if (this.logs.length > 300) this.logs.shift(); this.emit('log', e); }
  alert(msg, level = 'warn') { this.log(msg, level); this.emit('alert', { msg, level }); }

  hookBeats() {
    const S = this.S, prev = S.onVentBeat;
    S.onVentBeat = (t, o) => {
      prev && prev(t, o);
      if (o === ORIGIN.PVC && !this.pvcTemplate) S.schedule(t + 160, () => { this.pvcTemplate = this.captureQRS(t); });
      if (o === ORIGIN.STIM && this.pace.site === 'ABLd' && this.key === 'PVC' && this.pvcTemplate) {
        const ts = this.pace.lastStim;
        S.schedule(t + 160, () => { const q = this.captureQRS(ts + 2); this.paceMap = { score: corrQRS(q, this.pvcTemplate), t: S.t }; this.emit('pacemap', this.paceMap); });
      }
    };
  }
  captureQRS(t0) {
    const out = {};
    for (const l of ECG_LEADS) { const a = []; for (let k = -10; k < 140; k += 2) a.push(this.E.ecg[l][Math.floor(t0 + k) & 16383]); out[l] = a; }
    return out;
  }

  insert(k) {
    this.inserted.add(k);
    this.refreshChannels();
    this.log(`${CATH_DEFS[k].name} を挿入`, 'info');
  }
  remove(k) {
    this.inserted.delete(k);
    this.E.removeElectrodes(k + '_');
    this.refreshChannels();
  }
  refreshChannels() {
    const order = ['HRA', 'HALO', 'HIS', 'CS', 'RVA', 'ABL', 'MAP'];
    const list = [];
    for (const k of order) if (this.inserted.has(k)) list.push(...channelDefs(this.cath[k]));
    this.channelList = list;
    this.E.removeElectrodes('PV_');
    this.E.setChannels(list.concat(this.pvChannels()));
    this.updateCatheters(true);
  }
  pvChannels() {
    const dev = this.abl.device;
    if (!(this.inserted.has('ABL') && DEVICES[dev].kind === 'pv')) return [];
    const ch = [];
    for (let k = 0; k < 5; k++) ch.push({ key: `PV${k}`, label: `PV ${2 * k + 1}-${2 * k + 2}`, a: `PV_${2 * k + 1}`, b: `PV_${2 * k + 2}`, type: 'bi', color: '#7fe0c0', gain: 1, cath: 'PV' });
    return ch;
  }
  setDevice(dev) {
    this.abl.stopFocal(this.cath.ABL); this.abl.stopPV();
    this.abl.device = dev;
    if (DEVICES[dev].kind === 'pv' && this.cath.ABL.access !== 'LA') { this.cath.ABL.setAccess('LA'); }
    this.refreshChannels();
    this.log(`デバイス変更：${DEVICES[dev].name}`, 'info');
  }

  // ---- catheter update (per frame) ----
  updateCatheters(force) {
    const t = this.S.t;
    for (const k of this.inserted) {
      const c = this.cath[k];
      if (k === 'ABL' && DEVICES[this.abl.device].kind === 'pv') { this.updatePVDevice(); continue; }
      c.update(t);
      for (const e of c.electrodes) this.E.setElectrode(e.id, e.pos);
    }
    this.E.updateGroups();
    if (this.famOn && this.activeMap) this.famMark();
  }
  updatePVDevice() {
    const g = this.abl.pvGeom(this.T);
    const v = g.v;
    // circular mapping catheter inside vein (10 poles)
    const els = [];
    const depth = 14, r = v.r * 0.75;
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * 2 * Math.PI;
      els.push({ id: `PV_${k + 1}`, pos: add(add(v.o, mul(v.d, depth + k * 0.3)), add(mul(g.u, r * Math.cos(a)), mul(g.w, r * Math.sin(a)))) });
    }
    for (const e of els) this.E.setElectrode(e.id, e.pos);
    this.pvDevice = { g, els };
    const c = this.cath.ABL;
    c.electrodes = [];
    c.tip = add(v.o, mul(v.d, this.abl.pv.depth));
    c.cf = 0;
  }
  famMark() {
    const m = this.maps[this.activeMap];
    for (const k of ['ABL', 'MAP']) {
      if (!this.inserted.has(k)) continue;
      const c = this.cath[k];
      if (k === 'ABL' && DEVICES[this.abl.device].kind === 'pv') continue;
      m.mark(c.tip, 2.6);
      for (const e of c.electrodes) m.mark(e.pos, 2.0);
      const sh = c.shaft || [];
      for (let i = Math.max(0, sh.length - 10); i < sh.length; i++) m.mark(sh[i], 2.0);
    }
  }
  newMap(name, chamber) {
    this.maps[name] = new FamMap(name, chamber);
    this.activeMap = name;
    this.log(`マップ作成：${name}`, 'info');
    return this.maps[name];
  }
  autoFam(name, chamber, n = 2500) {
    // demo: sweep near walls of the chosen chamber
    const m = this.maps[name] || this.newMap(name, chamber);
    const T = this.T;
    const nodes = [];
    for (let i = 0; i < T.nMesh; i++) if (T.chamber[i] === CH[chamber] && T.region[i] !== REG.VEIN) nodes.push(i);
    for (let k = 0; k < n; k++) {
      const i = nodes[Math.floor(Math.random() * nodes.length)];
      const p = T.P(i), nn = [T.normal[i * 3], T.normal[i * 3 + 1], T.normal[i * 3 + 2]];
      m.mark(add(p, mul(nn, -(2.6 + Math.random() * 2))), 2.6);
    }
    m.rebuild();
    return m;
  }

  // ---- mapping acquisition ----
  refNodeTime() {
    const S = this.S;
    if (this.refMode === 'QRS') return { t: S.ventBeatStart, o: S.ventBeats.length ? S.ventBeats[S.ventBeats.length - 1].o : 0 };
    const cs = this.cath.CS.electrodes[8];
    if (!cs) return { t: -1e9 };
    if (!this.refNode || this.refNodeFor !== this.cath.CS.depth) { this.refNode = this.nearestAtrialNode(cs.pos); this.refNodeFor = this.cath.CS.depth; }
    return { t: S.lastAct[this.refNode], o: S.origin[this.refNode] };
  }
  nearestAtrialNode(p) {
    const T = this.T;
    let best = -1, bd = 1e9;
    for (const i of this.hash.query(p, 14)) { if (T.chamber[i] > 2 || !T.excit[i]) continue; const d = dist(T.P(i), p); if (d < bd) { bd = d; best = i; } }
    return best;
  }
  acquire(tRef) {
    const m = this.maps[this.activeMap];
    if (!m) return 0;
    const T = this.T, S = this.S, abl = this.abl;
    let n = 0;
    const woiPre = this.woiPre || 220;
    for (const k of ['MAP', 'ABL']) {
      if (!this.inserted.has(k)) continue;
      if (k === 'ABL' && DEVICES[abl.device].kind === 'pv') continue;
      const c = this.cath[k];
      for (const e of c.electrodes) {
        if (k === 'ABL' && e.id !== 'ABL_1') continue;
        if (!e.contact && !(k === 'ABL' && c.cf > 3)) continue;
        const nr = this.hash.nearest(e.pos, 4);
        if (nr.i < 0 || nr.d > 3.2) continue;
        const i = nr.i;
        let lat = S.lastAct[i] - tRef;
        const dead = !S.alive[i] || !T.excit[i];
        if (dead || lat < -woiPre || S.lastAct[i] < tRef - 1500) lat = null;
        const blocked = S.blockUntil[i] > S.t;
        let volt = T.amp[i] * abl.ampF[i] * (blocked ? 0.35 : 1) * (0.85 + Math.random() * 0.3);
        if (dead) volt = Math.min(volt, 0.03 + Math.random() * 0.06);
        m.addPoint({ pos: T.P(i), lat, volt, t: S.t, src: k, node: i });
        n++;
      }
    }
    if (n) this.emit('points', n);
    return n;
  }

  // ---- stimulation ----
  stimAt(siteKey, t, quiet) {
    const s = PACE_SITES[siteKey];
    if (!s || !this.inserted.has(s.cath)) return false;
    const e = this.cath[s.cath].electrodes.find((x) => x.id === s.e);
    if (!e) return false;
    const nodes = this.hash.query(e.pos, 3.6).filter((i) => this.T.excit[i]);
    let extra = [];
    if (s.cath === 'CS') { const n = this.nearestAtrialNode(e.pos); if (n >= 0) extra = this.hash.query(this.T.P(n), 3); }
    const all = nodes.concat(extra);
    if (s.cath === 'ABL' && this.cath.ABL.cf < 2 && !nodes.length) return false;
    this.S.stimNodes(all, t, ORIGIN.STIM);
    this.stims.push(t); if (this.stims.length > 200) this.stims.shift();
    this.pace.lastStim = t;
    this.pace.lastSite = siteKey;
    return all.length > 0;
  }
  startPacing(site, cl) { this.pace.on = true; this.pace.site = site; this.pace.cl = cl; this.pace.next = this.S.t + 10; this.ppi = null; this.log(`連続ペーシング ${PACE_SITES[site].label} CL ${cl} ms`, 'info'); }
  stopPacing() {
    if (!this.pace.on) return;
    this.pace.on = false;
    this.log('ペーシング停止', 'info');
    // post-pacing interval at pacing site
    const s = PACE_SITES[this.pace.site];
    const e = this.cath[s.cath]?.electrodes.find((x) => x.id === s.e);
    if (e) {
      const node = this.hash.nearest(e.pos, 5).i;
      if (node >= 0) {
        const last = this.pace.lastStim;
        this.S.schedule(last + 900, () => {
          const a = this.S.lastAct[node];
          if (a > last + 30) { this.ppi = a - last; this.emit('ppi', this.ppi); }
        });
      }
    }
  }
  programmed(site, s1, n, extras) {
    // S1 x n followed by extrastimuli (array of coupling intervals)
    let t = this.S.t + 20;
    const times = [];
    for (let k = 0; k < n; k++) { times.push(t); t += s1; }
    t -= s1;
    for (const x of extras) { t += x; times.push(t); }
    for (const tt of times) this.S.schedule(tt, (now) => this.stimAt(site, now));
    this.log(`プログラム刺激 ${PACE_SITES[site].label}: S1 ${s1}×${n}${extras.map((x, i) => ` S${i + 2} ${x}`).join('')}`, 'info');
    return times[times.length - 1];
  }
  burst(site, cl, n) {
    let t = this.S.t + 20;
    for (let k = 0; k < n; k++) { this.S.schedule(t, (now) => this.stimAt(site, now)); t += cl; }
    this.log(`バースト刺激 ${PACE_SITES[site].label} CL ${cl} ×${n}`, 'info');
    return t;
  }
  setIso(on) { this.S.iso = on ? 1.45 : 1; this.log(on ? 'イソプロテレノール投与' : 'イソプロテレノール中止', 'info'); }
  // Recommended induction (runs over sim time; uses scenario protocol)
  induce() {
    const key = this.key, S = this.S;
    if (key === 'PAF') {
      this.setIso(true);
      const t = this.burst('CS910', 180, 15);
      S.schedule(t + 50, () => { this.st.startAF(); this.setIso(false); });
      return;
    }
    if (key === 'PVC') { this.setIso(true); return; }
    const p = this.def.induce;
    let t = S.t + 20;
    const site = p.site === 'HRA' ? 'HRA12' : 'CS910';
    const tries = p.s2;
    // chain S1S2 trials until tachycardia is present
    const runTrial = (k) => {
      if (k >= tries.length || this.tachy()) return;
      const last = this.programmed(site, p.s1, 8, [tries[k]]);
      S.schedule(last + 1800, () => { if (!this.tachy()) runTrial(k + 1); else this.log('頻拍が誘発されました', 'ok'); });
    };
    runTrial(0);
    void t;
  }

  // ---- rhythm assessment ----
  tachy() {
    const S = this.S;
    const vb = S.ventBeats.slice(-5);
    const vcl = vb.length > 3 ? (vb[vb.length - 1].t - vb[0].t) / (vb.length - 1) : 1e9;
    if (this.key === 'AFL' || this.key === 'PAF') {
      const n = this.refNode >= 0 ? this.refNode : this.nearestAtrialNode(this.T.lm.csOs);
      return this.atrialCL() < 330 && S.t - S.lastAct[n] < 400;
    }
    return vcl < 450 && S.t - S.lastVent < 600 && !this.pace.on;
  }
  atrialCL() {
    // track activations of an RA lateral node
    return this._acl || 1e9;
  }
  trackAtrial() {
    const T = this.T, S = this.S;
    if (this._an === undefined) this._an = T.nearest('RA', T.lm.csOs, (i) => T.excit[i] && T.region[i] !== REG.CTI);
    const a = S.lastAct[this._an];
    if (a !== this._al) {
      if (this._al !== undefined && a - this._al < 2000) { this._aIv = this._aIv || []; this._aIv.push(a - this._al); if (this._aIv.length > 6) this._aIv.shift(); }
      this._al = a;
    }
    const iv = this._aIv || [];
    this._acl = iv.length >= 4 && S.t - a < 600 ? iv.reduce((x, y) => x + y, 0) / iv.length : 1e9;
  }
  rhythmLabel() {
    const S = this.S, key = this.key;
    const vb = S.ventBeats.slice(-6);
    const rr = vb.length > 2 ? (vb[vb.length - 1].t - vb[0].t) / (vb.length - 1) : 0;
    const hr = rr ? Math.round(60000 / rr) : 0;
    let label = '洞調律';
    if (this.pace.on) label = 'ペーシング中';
    else if (key === 'PAF' && this.st.pvpm.af && this.atrialCL() < 300) label = '心房細動';
    else if (key === 'AFL' && this.atrialCL() < 330) label = `心房粗動 (CL ${Math.round(this.atrialCL())} ms)`;
    else if ((key === 'AVNRT' || key === 'WPW') && this.tachy()) label = `${key === 'AVNRT' ? 'AVNRT' : 'ORT'} (CL ${Math.round(rr)} ms)`;
    else if (this.atrialCL() < 330) label = `心房頻拍／粗動 (CL ${Math.round(this.atrialCL())} ms)`;
    if (this.abl.comp.has('AVB')) label += '・完全房室ブロック';
    const pvcs = vb.filter((b) => b.o === ORIGIN.PVC).length;
    if (key === 'PVC' && pvcs) label += `・PVC`;
    if (key === 'AVNRT' && S.junctional) label += '・接合部調律';
    return { label, hr };
  }
  successStatus() {
    const st = this.st;
    switch (this.key) {
      case 'AFL': return { ok: ctiBlocked(st), text: ctiBlocked(st) ? 'CTIブロックライン完成' : 'CTI伝導あり' };
      case 'PAF': { const s = pvIsolationStatus(st); const n = Object.values(s).filter(Boolean).length; return { ok: n === 4, text: `PV隔離 ${n}/4 (${PV_NAMES.map((k) => `${k}:${s[k] ? '✓' : '×'}`).join(' ')})`, detail: s }; }
      case 'AVNRT': return { ok: spBlocked(st), text: spBlocked(st) ? '遅伝導路 焼灼済み' : '遅伝導路 残存' };
      case 'WPW': return { ok: apBlocked(st), text: apBlocked(st) ? '副伝導路 離断' : '副伝導路 伝導あり' };
      case 'PVC': return { ok: pvcEliminated(st), text: pvcEliminated(st) ? 'PVC起源 焼灼済み' : 'PVC起源 残存' };
    }
    return { ok: false, text: '' };
  }
  // final evaluation (shown only when the operator ends the procedure)
  evaluate() {
    const S = this.S;
    const now = this.successStatus();
    const saved = S.blockUntil.slice();
    S.blockUntil.fill(0);
    const durable = this.successStatus();
    S.blockUntil.set(saved);
    let transient = 0;
    for (let i = 0; i < this.T.n; i++) if (saved[i] > S.t && S.alive[i]) transient++;
    return { now, durable, transient, tachy: this.tachy(), comp: [...this.abl.comp], tti: this.abl.pv.tti };
  }
  waitEdema() {
    const S = this.S;
    let n = 0;
    for (let i = 0; i < this.T.n; i++) if (S.blockUntil[i] > S.t && S.alive[i]) { S.blockUntil[i] = S.t; n++; }
    // PV foci that lost isolation resume
    this.log(`待機（20分経過）：浮腫による一過性ブロックが ${n} 箇所で回復`, 'info');
    return n;
  }

  // ---- main advance (ms of simulation) ----
  advance(ms) {
    const S = this.S, E = this.E;
    const end = S.t + ms;
    while (S.t < end) {
      const t = Math.floor(S.t) + 1;
      if (this.pace.on && t >= this.pace.next) { this.stimAt(this.pace.site, t); this.pace.next = t + this.pace.cl; }
      S.run(t);
      E.step(t);
      if (this.st.stElev && t < this.st.stElev) E.stOffset = 0.25; else E.stOffset = 0;
      if (t % 20 === 0) this.slow(0.02);
      // mapping acquisition on reference beat
      if (this.acqOn) {
        const r = this.refNodeTime();
        if (r.t > this.lastRef + 120) {
          this.lastRef = r.t;
          if (!this.pvcOnly || r.o === ORIGIN.PVC) this.pendingAcq = r.t + (this.woiPost || 140);
        }
        if (this.pendingAcq && t >= this.pendingAcq) { this.acquire(this.pendingAcq - (this.woiPost || 140)); this.pendingAcq = null; }
      }
    }
  }
  slow(dt) {
    const abl = this.abl;
    const dev = this.abl.device;
    if (DEVICES[dev].kind === 'focal') abl.stepFocal(this.cath.ABL, dt);
    else abl.stepPV(dt);
    abl.cool(dt);
    this.trackAtrial();
    // PV foci: isolation bookkeeping, AF termination
    if (this.key === 'PAF' && Math.floor(this.S.t) % 500 === 0) {
      const iso = pvIsolationStatus(this.st);
      for (const v of Object.values(this.st.pv)) {
        if (iso[v.name] && !v.isolated) { v.isolated = true; }
        else if (!iso[v.name] && v.isolated) v.isolated = false;
      }
      const drivers = Object.values(this.st.pv).filter((v) => v.firing && !v.isolated);
      if (this.st.pvpm.af && !drivers.length) { this.st.pvpm.af = false; this.log('AF停止（ドライバー消失）', 'ok'); }
      // latent focus emerges once the main drivers are isolated (if AF re-induced)
      if (Object.values(this.st.pv).filter((v) => v.active).every((v) => v.isolated)) for (const v of Object.values(this.st.pv)) if (v.latent) v.activated = true;
    }
    // CF overload
    const c = this.cath.ABL;
    if (this.inserted.has('ABL') && c.cf > 75) { this.cfHigh = (this.cfHigh || 0) + dt; if (this.cfHigh > 2.5) this.abl.complication('PERF', '心穿孔・心タンポナーデ：過大な接触圧（>75g）が持続しました'); }
    else this.cfHigh = 0;
  }
}

function corrQRS(a, b) {
  let s = 0, n = 0;
  for (const l of ECG_LEADS) {
    const x = a[l], y = b[l];
    const mx = x.reduce((p, q) => p + q, 0) / x.length, my = y.reduce((p, q) => p + q, 0) / y.length;
    let sxy = 0, sxx = 0, syy = 0;
    for (let k = 0; k < x.length; k++) { sxy += (x[k] - mx) * (y[k] - my); sxx += (x[k] - mx) ** 2; syy += (y[k] - my) ** 2; }
    s += sxy / Math.sqrt(sxx * syy + 1e-9); n++;
  }
  return Math.max(0, (s / n) * 100);
}
export { DEVICES, ECG_LEADS, PV_NAMES };
