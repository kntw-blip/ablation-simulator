// Ablation energy sources (RF, cryo focal/balloon, PFA focal/PV) and complications
import { REG, CH, PV_NAMES } from './tissue.js';
import { add, sub, mul, dot, norm, dist, len, polyDist, clamp, perp, cross } from './vec.js';

export const DEVICES = {
  RF: { name: 'RF（イリゲーション）', kind: 'focal', energy: 'RF' },
  CRYO_FOCAL: { name: 'フォーカル・クライオ', kind: 'focal', energy: 'CRYO' },
  PFA_FOCAL: { name: 'フォーカルPFA', kind: 'focal', energy: 'PFA' },
  CRYO_BALLOON: { name: 'クライオバルーン 28mm', kind: 'pv', energy: 'CRYO' },
  PFA_PV: { name: 'PFAカテ (5スプライン 31mm)', kind: 'pv', energy: 'PFA' },
};

// virtual node depth required for elimination (mm)
const VDEPTH = { FP: 2.5, SP: 1.6, CN: 3.2, HIS: 4.0, AP: 2.6, RBB: 6, LBB: 7 };

export class Ablation {
  constructor(ctx) {
    this.ctx = ctx; // {T, S, st, hash, log(msg, level), alert(msg, level)}
    const T = ctx.T;
    this.device = 'RF';
    this.ampF = new Float32Array(T.n).fill(1);
    this.lesionDepth = new Float32Array(T.n);
    this.rf = { power: 35, on: false, t: 0, imp0: 108 + Math.random() * 12, imp: 115, temp: 37, cur: null, popRisk: 0 };
    this.cryo = { mode: 'abl', on: false, t: 0, temp: 37 };
    this.pv = { target: 'LSPV', depth: 2, tiltA: 0, tiltB: 0, rot: 0, form: 'flower', on: false, t: 0, temp: 37, cmap: 100, tti: null, apps: {}, total: 0 };
    this.tags = [];
    this.eso = 36.8; this.esoMax = 36.8;
    this.comp = new Set();
    this.vnode = [];
    for (let i = T.nBase; i < T.n; i++) {
      const nm = T.vname[i - T.nBase];
      const key = Object.keys(VDEPTH).find((k) => nm.startsWith(k));
      this.vnode.push({ i, name: nm, depth: key ? VDEPTH[key] : 3 });
    }
    this.hfCount = 0;
  }
  log(m, l) { this.ctx.log(m, l); }
  complication(key, msg) {
    if (this.comp.has(key)) return;
    this.comp.add(key);
    this.ctx.alert(msg, 'danger');
  }

  // ---- tissue effect ----
  lesion(center, radius, depth, opts = {}) {
    const { T, S } = this.ctx;
    const now = S.t;
    const nodes = this.ctx.hash.query(center, radius);
    const focus = T.focus.pvc ? new Set(T.focus.pvc.nodes) : null;
    for (const i of nodes) {
      const d = dist(T.P(i), center);
      const f = Math.sqrt(Math.max(0, 1 - (d / radius) ** 2));
      const ld = depth * f;
      if (ld <= this.lesionDepth[i]) continue;
      this.lesionDepth[i] = ld;
      const vent = T.chamber[i] === CH.RV || T.chamber[i] === CH.LV;
      const th = vent ? (focus && focus.has(i) ? T.focus.pvc.depth : 2.0) : T.thick[i];
      if (opts.reversible) {
        if (ld > 0.3 * th) S.blockUntil[i] = Math.max(S.blockUntil[i], now + opts.reversible);
        continue;
      }
      this.ampF[i] = Math.min(this.ampF[i], Math.max(0.03, 1 - 0.95 * Math.min(1, ld / th)));
      if (ld >= th) S.kill(i);
      else if (ld >= 0.45 * th) S.blockUntil[i] = Math.max(S.blockUntil[i], now + (90 + 150 * (ld / th)) * 1000 * (opts.pfa ? 0.6 : 1));
      if (vent && T.epiOf[i] >= 0) {
        const e = T.epiOf[i];
        if (ld >= T.thick[i]) S.kill(e);
      }
    }
    // conduction-system virtual nodes
    for (const v of this.vnode) {
      const d = dist(T.P(v.i), center);
      if (d > radius + 1) continue;
      const ld = depth * Math.sqrt(Math.max(0, 1 - (d / (radius + 1)) ** 2));
      if (opts.reversible) { if (ld > v.depth * 0.5) S.blockUntil[v.i] = Math.max(S.blockUntil[v.i], now + opts.reversible); continue; }
      if (ld >= v.depth) {
        if (S.alive[v.i]) { S.kill(v.i); this.onVirtualKilled(v); }
      } else if (ld > v.depth * 0.5) S.blockUntil[v.i] = Math.max(S.blockUntil[v.i], now + 60000);
    }
  }
  onVirtualKilled(v) {
    const n = v.name;
    if (n === 'CN' || n === 'HIS') this.complication('AVB', '完全房室ブロック：His束近傍の焼灼により房室伝導が途絶しました（ペースメーカ植込みが必要）');
    else if (n.startsWith('FP')) this.log('速伝導路の傷害（PR延長）', 'warn');
    else if (n.startsWith('SP')) this.log('遅伝導路が焼灼されました', 'ok');
    else if (n.startsWith('AP')) this.log('副伝導路が焼灼されました', 'ok');
  }
  // heating near slow pathway produces junctional rhythm; near compact node -> warn
  heatEffects(pos, radius) {
    const { T, S } = this.ctx;
    let junc = false;
    for (const v of this.vnode) {
      const d = dist(T.P(v.i), pos);
      if (v.name.startsWith('SP') && d < radius + 5) junc = true;
      if ((v.name === 'CN' || v.name === 'HIS' || v.name.startsWith('FP')) && d < radius + 4 && S.alive[v.i]) {
        if (!this.nearAVNwarn || S.t - this.nearAVNwarn > 4000) { this.nearAVNwarn = S.t; this.ctx.alert('His束/速伝導路の近傍です。房室ブロックに注意してください', 'warn'); }
      }
    }
    S.junctional = junc ? 1 : 0;
  }

  // ---- RF / focal energy ----
  startFocal(cath) {
    const dev = this.device;
    if (dev === 'RF') { const r = this.rf; r.on = true; r.t = 0; r.cur = null; r.imp = r.imp0; this.log(`RF通電開始 ${r.power}W`, 'info'); }
    else if (dev === 'CRYO_FOCAL') { const c = this.cryo; c.on = true; c.t = 0; this.log(`クライオ開始（${c.mode === 'map' ? 'クライオマッピング −30℃' : 'アブレーション −75℃'}）`, 'info'); }
    else if (dev === 'PFA_FOCAL') this.pfaFocal(cath);
  }
  stopFocal(cath) {
    if (this.rf.on) { this.finishRFLesion(); this.rf.on = false; this.ctx.S.junctional = 0; this.log(`RF停止 (${this.rf.t.toFixed(1)} s)`, 'info'); }
    if (this.cryo.on) {
      this.cryo.on = false;
      if (this.cryo.mode === 'map' || this.cryo.t < 30) this.log('クライオ停止（解凍）', 'info');
      else { this.tags.push({ pos: cath.tip.slice(), index: Math.round(this.cryo.depth * 100), depth: this.cryo.depth, energy: 'CRYO' }); this.log(`クライオ停止 ${this.cryo.t.toFixed(0)} s`, 'info'); }
      this.ctx.S.junctional = 0;
    }
  }
  finishRFLesion() {
    const c = this.rf.cur;
    if (c && c.t > 2.5) this.tags.push({ pos: c.pos.slice(), index: Math.round(c.depth * 100), depth: c.depth, energy: 'RF', t: c.t, cf: c.cfSum / Math.max(1, c.n) });
    this.rf.cur = null;
  }
  stepFocal(cath, dt) { // dt in s
    const { S, T } = this.ctx;
    if (this.rf.on) {
      const r = this.rf;
      r.t += dt;
      const P = r.power, cf = cath.cf;
      const contact = cf > 3;
      if (!r.cur || dist(r.cur.pos, cath.tip) > 2.5) { this.finishRFLesion(); r.cur = { pos: cath.tip.slice(), depth: 0, t: 0, cfSum: 0, n: 0 }; }
      const c = r.cur;
      c.t += dt; c.cfSum += cf; c.n++;
      const cfF = contact ? Math.min(1.35, Math.pow(cf / 15, 0.55)) : 0.12;
      const Dmax = 0.6 + 4.6 * Math.pow(P / 35, 0.85) * cfF;
      const tau = 14 * (35 / P);
      c.depth += ((Dmax - c.depth) / tau) * dt;
      const rad = 2.2 + 0.55 * c.depth + (P >= 45 ? 0.6 : 0);
      if (contact) this.lesion(c.pos, rad, c.depth);
      this.heatEffects(c.pos, rad);
      r.imp = r.imp0 - 13 * Math.min(1, c.depth / 4.5) * (contact ? 1 : 0.2) + Math.sin(S.t / 140) * 1.2;
      r.temp = 36 + 6 * (contact ? Math.min(1, cf / 20) : 0.2) + (P - 30) * 0.12;
      r.index = c.depth * 100;
      // steam pop
      if (P >= 40 && cf >= 35 && c.t > 12 && Math.random() < 0.035 * dt * (cf / 35) * (P / 40) * 10) {
        this.ctx.alert('スチームポップ！ 通電を中止してください', 'danger');
        r.imp += 25;
        if (Math.random() < 0.35) this.complication('TAMP', '心タンポナーデ：スチームポップに伴う心穿孔。心嚢穿刺が必要です');
        this.stopFocal(cath);
      }
      this.thermalSideEffects(c.pos, P, dt);
    }
    if (this.cryo.on) {
      const c = this.cryo;
      c.t += dt;
      const target = c.mode === 'map' ? -30 : cath.cf > 3 ? -76 : -55;
      c.temp = target + (37 - target) * Math.exp(-c.t / 6);
      cath.locked = c.temp < -20;
      if (c.mode === 'map') {
        if (c.temp < -25) this.lesion(cath.tip, 4, 3, { reversible: 4000 });
        c.depth = 0;
      } else {
        c.depth = (cath.cf > 3 ? 5.0 : 2.2) * (1 - Math.exp(-c.t / 75));
        if (c.temp < -40) this.lesion(cath.tip, 2.8 + 0.4 * c.depth, c.depth);
        if (c.temp < -40) this.lesion(cath.tip, 4.5, 3.5, { reversible: 3000 });
      }
      this.heatEffects(cath.tip, 3.5);
      this.coldSideEffects(cath.tip, c.temp, dt, false);
    } else if (this.cryo.temp < 36.5) {
      this.cryo.temp += (37 - this.cryo.temp) * Math.min(1, dt / 4);
      cath.locked = this.cryo.temp < -20;
    }
  }
  pfaFocal(cath) {
    const { S } = this.ctx;
    if (cath.cf < 2 && !cath.contact) { this.log('PFA：組織への近接が不十分です（焼灼効果なし）', 'warn'); }
    const depth = cath.cf > 2 ? 4.4 : 2.0;
    this.lesion(cath.tip, 4.6, depth, { pfa: true });
    this.tags.push({ pos: cath.tip.slice(), index: Math.round(depth * 100), depth, energy: 'PFA' });
    this.pv.total++;
    this.log(`PFA照射（フォーカル） #${this.pv.total}`, 'info');
    // coronary spasm near CTI / mitral isthmus
    const T = this.ctx.T;
    const hit = this.ctx.hash.query(cath.tip, 5).some((i) => T.region[i] === REG.CTI || T.region[i] === REG.MI);
    if (hit && Math.random() < 0.45) this.ctx.alert('冠動脈攣縮：下壁誘導でST上昇。ニトログリセリン冠注を検討', 'danger'), this.ctx.st.stElev = S.t + 45000;
    this.heatEffects(cath.tip, 4.6);
    this.hemolysisCheck();
  }
  hemolysisCheck() {
    if (this.pv.total > 60) this.complication('HEMO', '溶血：PFA照射回数が多く、溶血・急性腎障害のリスクがあります（補液を）');
  }
  thermalSideEffects(pos, P, dt) {
    const { T } = this.ctx;
    const de = polyDist(pos, T.lm.esophagus).d;
    if (de < 18) this.eso += dt * 0.03 * P * Math.exp(-(de - 4) / 3.2);
    this.esoMax = Math.max(this.esoMax, this.eso);
    if (this.eso > 39 && (!this.esoWarn || this.ctx.S.t - this.esoWarn > 5000)) { this.esoWarn = this.ctx.S.t; this.ctx.alert(`食道温上昇 ${this.eso.toFixed(1)}℃：通電を中止してください`, 'warn'); }
    if (this.eso > 41.5) this.complication('ESO', '食道傷害（左房食道瘻のリスク）：食道温が41℃を超えました');
    const dp = polyDist(pos, T.lm.phrenicR).d;
    if (dp < 5) { this.pnHeat = (this.pnHeat || 0) + dt; if (this.pnHeat > 6) this.complication('PNP', '右横隔神経麻痺：横隔神経近傍の焼灼'); }
    // PV stenosis
    const i = this.ctx.hash.nearest(pos, 6).i;
    if (i >= 0 && T.region[i] === REG.PV && T.sleeve[i] > 7 && this.rf.cur && this.rf.cur.depth > 4) this.complication('PVS', '肺静脈狭窄のリスク：肺静脈内（遠位）での高エネルギー焼灼');
  }
  coldSideEffects(pos, temp, dt) {
    const { T } = this.ctx;
    const de = polyDist(pos, T.lm.esophagus).d;
    if (de < 18 && temp < -20) this.eso -= dt * 0.06 * (-temp / 40) * Math.exp(-(de - 4) / 4);
  }
  cool(dt) {
    this.eso += (36.8 - this.eso) * Math.min(1, dt * 0.06);
  }

  // ---- PV devices (balloon / PFA) ----
  pvGeom(T) {
    const v = T.lm.pv[this.pv.target];
    const tilt = [this.pv.tiltA, this.pv.tiltB];
    const tiltMag = Math.hypot(tilt[0], tilt[1]);
    const u = perp(v.d), w = cross(v.d, u);
    const leakAng = Math.atan2(-tilt[1], -tilt[0]);
    const grade = clamp(Math.round(4 - Math.abs(this.pv.depth - 3) / 2.2 - tiltMag / 9), 1, 4);
    const tiltDir = norm(add(v.d, add(mul(u, Math.tan((tilt[0] * Math.PI) / 180)), mul(w, Math.tan((tilt[1] * Math.PI) / 180)))));
    return { v, u, w, leakAng, grade, tiltDir, center: add(v.o, mul(v.d, this.pv.depth - (this.device === 'CRYO_BALLOON' ? 12 : 10))) };
  }
  ringNodes(T, hc, hw, extra = 14) {
    const g = this.pvGeom(T);
    const out = [];
    for (const i of this.ctx.LAnodes) {
      const d = sub(T.P(i), g.v.o);
      const h = dot(d, g.v.d);
      if (h < hc - hw || h > hc + hw) continue;
      const r = sub(d, mul(g.v.d, h));
      if (len(r) > g.v.r + extra) continue;
      const ang = Math.atan2(dot(r, g.w), dot(r, g.u));
      out.push({ i, ang });
    }
    return { g, out };
  }
  startPV() {
    if (this.device === 'CRYO_BALLOON') {
      const p = this.pv;
      p.on = true; p.t = 0; p.tti = null; p.wasIso = this.ctx.pvIso()[p.target];
      const g = this.pvGeom(this.ctx.T);
      this.log(`クライオバルーン冷凍開始：${p.target}（閉塞グレード ${g.grade}）`, 'info');
      p.dose = new Map();
    } else if (this.device === 'PFA_PV') this.pfaPV();
  }
  stopPV(double = false) {
    const p = this.pv;
    if (!p.on) return;
    p.on = false;
    this.log(`冷凍終了 ${p.t.toFixed(0)} s${double ? '（ダブルストップ）' : ''}・最低温度 ${p.nadir?.toFixed(0) ?? '-'}℃${p.tti ? `・TTI ${p.tti.toFixed(0)} s` : ''}`, 'info');
    const T = this.ctx.T, g = this.pvGeom(T);
    this.tags.push({ pos: add(g.v.o, mul(g.v.d, p.depth * 0.5)), index: Math.round((-(p.nadir || 0)) * 10), energy: 'CRYO', ring: { o: g.v.o, d: g.v.d, r: g.v.r + 3 } });
  }
  stepPV(dt) {
    const p = this.pv, { T, S } = this.ctx;
    if (!p.on) { if (p.temp < 36) p.temp += (37 - p.temp) * Math.min(1, dt / 6); if (p.cmap < 100 && !this.comp.has('PNP')) p.cmap = Math.min(100, p.cmap + dt * 0.5); return; }
    p.t += dt;
    const g = this.pvGeom(T);
    const target = { 4: -52, 3: -45, 2: -35, 1: -27 }[g.grade];
    p.temp = target + (37 - target) * Math.exp(-p.t / 18);
    p.nadir = Math.min(p.nadir ?? 37, p.temp);
    const hc = -1.5 + 0.55 * p.depth;
    const { out } = this.ringNodes(T, hc, 2.6, 12);
    for (const { i, ang } of out) {
      const leak = (4 - g.grade) * 7 * (1 + Math.cos(ang - g.leakAng)) / 2;
      const tl = p.temp + leak;
      if (tl < -20) {
        const dose = (p.dose.get(i) || 0) + ((-20 - tl) / 25 / 38) * dt;
        p.dose.set(i, dose);
        const th = T.thick[i];
        const ld = Math.min(5, dose * 3.2);
        if (ld > this.lesionDepth[i]) {
          this.lesionDepth[i] = ld;
          this.ampF[i] = Math.min(this.ampF[i], Math.max(0.03, 1 - 0.95 * Math.min(1, ld / th)));
          if (ld >= th) S.kill(i);
          else if (ld >= 0.45 * th) S.blockUntil[i] = Math.max(S.blockUntil[i], S.t + 150000);
        }
      }
      if (tl < -36) S.blockUntil[i] = Math.max(S.blockUntil[i], S.t + 2500); // frozen tissue does not conduct
    }
    if (!p.tti && !p.wasIso && Math.floor(p.t) !== Math.floor(p.t - dt) && this.ctx.pvIso()[p.target]) { p.tti = p.t; this.log(`隔離確認（TTI ${p.t.toFixed(0)} s）`, 'ok'); }
    // phrenic nerve (right veins)
    if (p.target === 'RSPV' || p.target === 'RIPV') {
      const risk = (p.target === 'RSPV' ? 1 : 0.5) * Math.max(0, p.depth - 2) / 4;
      if (p.temp < -30) p.cmap = Math.max(0, p.cmap - dt * 0.45 * risk * (-p.temp / 45));
      if (p.cmap < 70 && (!this.cmapWarn || S.t - this.cmapWarn > 5000)) { this.cmapWarn = S.t; this.ctx.alert(`CMAP低下 ${p.cmap.toFixed(0)}%：ダブルストップで直ちに中止！`, 'danger'); }
      if (p.cmap < 45) this.complication('PNP', '右横隔神経麻痺（クライオバルーン）');
    }
    if (p.target === 'LIPV' || p.target === 'RIPV') this.eso -= dt * 0.045 * (-Math.min(0, p.temp) / 45) * (p.target === 'LIPV' ? 1 : 0.6);
    if (this.eso < 25 && (!this.esoWarn || S.t - this.esoWarn > 5000)) { this.esoWarn = S.t; this.ctx.alert(`食道温低下 ${this.eso.toFixed(1)}℃：冷凍終了を検討`, 'warn'); }
    if (this.eso < 15) this.complication('ESO', '食道傷害リスク：食道温が15℃未満');
    if (p.t >= (p.maxT || 180)) this.stopPV();
  }
  pfaPV() {
    const p = this.pv, { T, S } = this.ctx;
    const g = this.pvGeom(T);
    const flower = p.form === 'flower';
    const hc = flower ? -2.2 + 0.3 * p.depth : 0.2 + 0.5 * p.depth;
    const { out } = this.ringNodes(T, hc, flower ? 3.2 : 2.6, flower ? 16 : 11);
    const rot = (p.rot * Math.PI) / 180;
    let n = 0;
    for (const { i, ang } of out) {
      const q = 1 - (4 - g.grade) * 0.22 * (1 + Math.cos(ang - g.leakAng)) / 2;
      let cover = flower;
      if (!flower) for (let k = 0; k < 5; k++) { let da = Math.abs(((ang - rot - (k * 2 * Math.PI) / 5 + 3 * Math.PI) % (2 * Math.PI)) - Math.PI); if (da < 0.3) cover = true; }
      if (!cover) continue;
      n++;
      if (q > 0.62) { S.kill(i); this.lesionDepth[i] = 4; this.ampF[i] = 0.04; }
      else { S.blockUntil[i] = Math.max(S.blockUntil[i], S.t + 120000); this.ampF[i] = Math.min(this.ampF[i], 0.5); }
    }
    p.apps[p.target] = (p.apps[p.target] || 0) + 1;
    p.total++;
    this.tags.push({ pos: add(g.v.o, mul(g.v.d, hc)), index: 400, energy: 'PFA', ring: { o: add(g.v.o, mul(g.v.d, hc)), d: g.v.d, r: g.v.r + (flower ? 5 : 2), form: p.form, rot: p.rot } });
    this.log(`PFA照射 ${p.target}（${flower ? 'フラワー' : 'バスケット'}・回転${p.rot}°・閉塞/接触 ${g.grade}）`, 'info');
    this.hemolysisCheck();
  }
}
