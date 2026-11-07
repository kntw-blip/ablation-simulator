// Fast Anatomical Mapping: voxel occupancy from catheter positions -> reconstructed shell; LAT / voltage points
import { BOUNDS } from './anatomy.js';
import { surfaceNets, smoothMesh, largestComponent } from './surfacenets.js';

export class FamMap {
  constructor(name, chamber, h = 2.0) {
    this.name = name; this.chamber = chamber; this.h = h;
    this.min = BOUNDS.min; this.max = BOUNDS.max;
    this.dims = [0, 1, 2].map((k) => Math.ceil((this.max[k] - this.min[k]) / h) + 1);
    this.occ = new Uint8Array(this.dims[0] * this.dims[1] * this.dims[2]);
    this.bb = null; // voxel bbox of occupancy
    this.points = [];
    this.mesh = null;
    this.dirty = false;
    this.version = 0;
    this.nVox = 0;
  }
  mark(p, r = 2.2) {
    const h = this.h, [nx, ny] = this.dims;
    const c = [0, 1, 2].map((k) => (p[k] - this.min[k]) / h);
    const rr = r / h;
    const x0 = Math.max(0, Math.floor(c[0] - rr)), x1 = Math.min(this.dims[0] - 1, Math.ceil(c[0] + rr));
    const y0 = Math.max(0, Math.floor(c[1] - rr)), y1 = Math.min(this.dims[1] - 1, Math.ceil(c[1] + rr));
    const z0 = Math.max(0, Math.floor(c[2] - rr)), z1 = Math.min(this.dims[2] - 1, Math.ceil(c[2] + rr));
    let added = 0;
    for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if ((x - c[0]) ** 2 + (y - c[1]) ** 2 + (z - c[2]) ** 2 > rr * rr) continue;
      const i = x + nx * (y + ny * z);
      if (!this.occ[i]) { this.occ[i] = 1; added++; }
    }
    if (added) {
      this.nVox += added;
      if (!this.bb) this.bb = [x0, y0, z0, x1, y1, z1];
      else { const b = this.bb; b[0] = Math.min(b[0], x0); b[1] = Math.min(b[1], y0); b[2] = Math.min(b[2], z0); b[3] = Math.max(b[3], x1); b[4] = Math.max(b[4], y1); b[5] = Math.max(b[5], z1); }
      this.dirty = true;
    }
    return added;
  }
  volumeMl() { return (this.nVox * this.h ** 3) / 1000; }
  rebuild() {
    this.dirty = false;
    if (!this.bb || this.nVox < 40) { this.mesh = null; this.version++; return; }
    const m = 2, [nx, ny] = this.dims, h = this.h;
    const b = this.bb;
    const x0 = Math.max(0, b[0] - m), y0 = Math.max(0, b[1] - m), z0 = Math.max(0, b[2] - m);
    const x1 = Math.min(this.dims[0] - 1, b[3] + m), y1 = Math.min(this.dims[1] - 1, b[4] + m), z1 = Math.min(this.dims[2] - 1, b[5] + m);
    const lx = x1 - x0 + 1, ly = y1 - y0 + 1, lz = z1 - z0 + 1;
    const v = new Float32Array(lx * ly * lz);
    // box blur (3x3x3) of occupancy -> field; inside negative
    for (let z = 0; z < lz; z++) for (let y = 0; y < ly; y++) for (let x = 0; x < lx; x++) {
      let s = 0, c = 0;
      for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = x0 + x + dx, Y = y0 + y + dy, Z = z0 + z + dz;
        if (X < 0 || Y < 0 || Z < 0 || X >= this.dims[0] || Y >= this.dims[1] || Z >= this.dims[2]) { c++; continue; }
        s += this.occ[X + nx * (Y + ny * Z)]; c++;
      }
      v[x + lx * (y + ly * z)] = 0.4 - s / c;
    }
    const origin = [this.min[0] + x0 * h, this.min[1] + y0 * h, this.min[2] + z0 * h];
    let mesh = surfaceNets(v, [lx, ly, lz], origin, h, 0);
    if (mesh.indices.length < 12) { this.mesh = null; this.version++; return; }
    mesh = largestComponent(mesh);
    smoothMesh(mesh, 3, 0.5);
    this.mesh = mesh;
    this.version++;
  }
  addPoint(pt) {
    // replace nearby point (within 1.2 mm)
    for (let k = this.points.length - 1; k >= Math.max(0, this.points.length - 400); k--) {
      const q = this.points[k];
      if ((q.pos[0] - pt.pos[0]) ** 2 + (q.pos[1] - pt.pos[1]) ** 2 + (q.pos[2] - pt.pos[2]) ** 2 < 1.44) { this.points[k] = pt; this.colorDirty = true; return; }
    }
    this.points.push(pt);
    this.colorDirty = true;
  }
  clearPoints() { this.points = []; this.colorDirty = true; }
  // per-vertex interpolated values for current mesh
  interpolate(fill = 9) {
    const mesh = this.mesh;
    if (!mesh) return null;
    const n = mesh.positions.length / 3, P = mesh.positions;
    const lat = new Float32Array(n).fill(NaN), volt = new Float32Array(n).fill(NaN);
    // hash points
    const cell = fill, map = new Map();
    const key = (x, y, z) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
    for (const pt of this.points) { const k = key(...pt.pos); if (!map.has(k)) map.set(k, []); map.get(k).push(pt); }
    for (let i = 0; i < n; i++) {
      const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
      const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
      let wl = 0, sl = 0, wv = 0, sv = 0;
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
        const arr = map.get(`${cx + a},${cy + b},${cz + c}`);
        if (!arr) continue;
        for (const pt of arr) {
          const d2 = (pt.pos[0] - x) ** 2 + (pt.pos[1] - y) ** 2 + (pt.pos[2] - z) ** 2;
          if (d2 > fill * fill) continue;
          const w = 1 / (d2 + 1.5) ** 1.5;
          if (pt.lat !== null && pt.lat !== undefined) { wl += w; sl += w * pt.lat; }
          wv += w; sv += w * Math.log(Math.max(0.01, pt.volt));
        }
      }
      if (wl > 0) lat[i] = sl / wl;
      if (wv > 0) volt[i] = Math.exp(sv / wv);
    }
    return { lat, volt };
  }
}

// colour scales
export function latColor(v, lo, hi) {
  if (!isFinite(v)) return null;
  const x = Math.min(1, Math.max(0, (v - lo) / (hi - lo || 1)));
  // red -> orange -> yellow -> green -> cyan -> blue -> purple
  const stops = [[0, [1, 0.1, 0.1]], [0.17, [1, 0.55, 0.05]], [0.33, [1, 0.95, 0.1]], [0.5, [0.2, 0.9, 0.25]], [0.67, [0.15, 0.85, 0.95]], [0.83, [0.2, 0.35, 1]], [1, [0.65, 0.2, 0.95]]];
  for (let k = 0; k < stops.length - 1; k++) {
    const [a, ca] = stops[k], [b, cb] = stops[k + 1];
    if (x <= b) { const f = (x - a) / (b - a); return [ca[0] + (cb[0] - ca[0]) * f, ca[1] + (cb[1] - ca[1]) * f, ca[2] + (cb[2] - ca[2]) * f]; }
  }
  return stops[stops.length - 1][1];
}
export function voltColor(v, lo, hi) {
  if (!isFinite(v)) return null;
  if (v < lo * 0.6) return [0.55, 0.55, 0.58]; // dense scar: grey
  if (v >= hi) return [0.65, 0.2, 0.95];
  return latColor(Math.log(v / lo) / Math.log(hi / lo), 0, 1.0);
}
