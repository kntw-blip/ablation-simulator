// Scrolling electrogram / ECG recorder (canvas)
import { ECG_LEADS } from '../core/egm.js';

const BUF = 16384;
export class EGMView {
  constructor(canvas, session) {
    this.cv = canvas; this.ctx = canvas.getContext('2d');
    this.ss = session;
    this.window = 2500; // ms visible
    this.surface = ['I', 'II', 'aVF', 'V1', 'V6'];
    this.gainECG = 1; this.gainIC = 1;
    this.rowH = 26;
    this.cal = []; // caliper times
    this.frozen = false; this.tFrozen = 0;
    canvas.addEventListener('click', (e) => this.onClick(e));
  }
  rows() {
    const r = this.surface.map((l) => ({ kind: 'ecg', label: l, key: l, color: '#e8eef5' }));
    for (const c of this.ss.E.channels) r.push({ kind: 'ic', label: c.label, key: c.key, color: c.color, ch: c });
    return r;
  }
  layout() {
    const rows = this.rows();
    const parent = this.cv.parentElement;
    const w = parent.clientWidth;
    const availH = parent.clientHeight;
    this.rowH = Math.max(18, Math.min(34, Math.floor((availH - 22) / rows.length)));
    const h = Math.max(availH, rows.length * this.rowH + 22);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (this.cv.width !== Math.floor(w * dpr) || this.cv.height !== Math.floor(h * dpr)) {
      this.cv.width = Math.floor(w * dpr); this.cv.height = Math.floor(h * dpr);
      this.cv.style.width = w + 'px'; this.cv.style.height = h + 'px';
    }
    this.dpr = dpr; this.W = w; this.H = h;
    return rows;
  }
  onClick(e) {
    const rect = this.cv.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const lw = 64;
    if (x < lw) return;
    const t = this.tNow - this.window + ((x - lw) / (this.W - lw)) * this.window;
    if (this.cal.length >= 2) this.cal = [];
    this.cal.push(t);
  }
  draw() {
    const ss = this.ss, ctx = this.ctx;
    const rows = this.layout();
    const dpr = this.dpr, W = this.W, H = this.H;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#05080b';
    ctx.fillRect(0, 0, W, H);
    const lw = 64, pw = W - lw;
    const tNow = this.frozen ? this.tFrozen : Math.floor(ss.S.t) - 1;
    this.tNow = tNow;
    const t0 = tNow - this.window;
    const msPerPx = this.window / pw;
    // grid every 200 ms / 40 ms
    ctx.lineWidth = 1;
    for (let t = Math.ceil(t0 / 40) * 40; t < tNow; t += 40) {
      const x = lw + (t - t0) / msPerPx;
      ctx.strokeStyle = t % 200 === 0 ? 'rgba(80,110,140,0.32)' : 'rgba(60,80,100,0.12)';
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    // stim markers
    ctx.strokeStyle = 'rgba(255,220,80,0.35)';
    for (const s of ss.stims) {
      if (s < t0 || s > tNow) continue;
      const x = lw + (s - t0) / msPerPx;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    const E = ss.E;
    rows.forEach((r, k) => {
      const yc = 14 + k * this.rowH + this.rowH / 2;
      ctx.fillStyle = r.kind === 'ecg' ? '#9fb3c8' : r.color;
      ctx.font = '11px ui-monospace, Menlo, monospace';
      ctx.fillText(r.label, 6, yc + 4);
      const buf = r.kind === 'ecg' ? E.ecg[r.key] : r.ch.buf;
      const g = r.kind === 'ecg' ? 16 * this.gainECG : (r.ch.type === 'uni' ? 7 : 9) * this.gainIC * (r.ch.gain || 1);
      const lim = this.rowH * 0.62;
      ctx.strokeStyle = r.kind === 'ecg' ? '#d9e4ee' : r.color;
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      for (let x = 0; x < pw; x++) {
        const ta = Math.floor(t0 + x * msPerPx), tb = Math.floor(t0 + (x + 1) * msPerPx);
        let mn = Infinity, mx = -Infinity;
        for (let t = ta; t <= Math.max(ta, tb - 1); t++) { const v = buf[t & (BUF - 1)]; if (v < mn) mn = v; if (v > mx) mx = v; }
        const y1 = yc - Math.max(-lim, Math.min(lim, mx * g)), y2 = yc - Math.max(-lim, Math.min(lim, mn * g));
        if (x === 0) ctx.moveTo(lw + x, y1);
        ctx.lineTo(lw + x, y1); ctx.lineTo(lw + x, y2);
      }
      ctx.stroke();
    });
    // header scale
    ctx.fillStyle = '#6f8396';
    ctx.font = '10px ui-monospace, Menlo, monospace';
    ctx.fillText(`${Math.round((pw / this.window) * 1000 / 3.78)} mm/s相当  ${this.frozen ? '■ 停止中' : ''}`, lw + 4, 10);
    // calipers
    if (this.cal.length) {
      ctx.strokeStyle = '#5ef0ff'; ctx.lineWidth = 1;
      const xs = this.cal.map((t) => lw + (t - t0) / msPerPx);
      for (const x of xs) { ctx.beginPath(); ctx.moveTo(x, 12); ctx.lineTo(x, H); ctx.stroke(); }
      if (xs.length === 2) {
        ctx.fillStyle = '#5ef0ff'; ctx.font = 'bold 12px ui-monospace, Menlo, monospace';
        ctx.fillText(`${Math.abs(Math.round(this.cal[1] - this.cal[0]))} ms`, (xs[0] + xs[1]) / 2 - 18, 11);
      }
    }
  }
}
export { ECG_LEADS };
