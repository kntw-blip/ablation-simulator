// Spatial hash for fast neighbour queries on tissue nodes
export class SpatialHash {
  constructor(pos, idxList, cell = 4) {
    this.pos = pos; this.cell = cell; this.map = new Map();
    for (const i of idxList) {
      const k = this.key(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
      let a = this.map.get(k);
      if (!a) { a = []; this.map.set(k, a); }
      a.push(i);
    }
  }
  key(x, y, z) { const c = this.cell; return `${Math.floor(x / c)},${Math.floor(y / c)},${Math.floor(z / c)}`; }
  query(p, r, out = []) {
    const c = this.cell, P = this.pos, r2 = r * r;
    const x0 = Math.floor((p[0] - r) / c), x1 = Math.floor((p[0] + r) / c);
    const y0 = Math.floor((p[1] - r) / c), y1 = Math.floor((p[1] + r) / c);
    const z0 = Math.floor((p[2] - r) / c), z1 = Math.floor((p[2] + r) / c);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
      const a = this.map.get(`${x},${y},${z}`);
      if (!a) continue;
      for (const i of a) {
        const dx = P[i * 3] - p[0], dy = P[i * 3 + 1] - p[1], dz = P[i * 3 + 2] - p[2];
        if (dx * dx + dy * dy + dz * dz <= r2) out.push(i);
      }
    }
    return out;
  }
  nearest(p, rmax = 12) {
    let r = this.cell;
    while (r <= rmax) {
      const c = this.query(p, r);
      if (c.length) {
        let best = -1, bd = Infinity; const P = this.pos;
        for (const i of c) { const d = (P[i * 3] - p[0]) ** 2 + (P[i * 3 + 1] - p[1]) ** 2 + (P[i * 3 + 2] - p[2]) ** 2; if (d < bd) { bd = d; best = i; } }
        return { i: best, d: Math.sqrt(bd) };
      }
      r *= 2;
    }
    return { i: -1, d: Infinity };
  }
}
