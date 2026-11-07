// Naive Surface Nets isosurface extraction. values: Float32Array (nx*ny*nz), index = x + nx*(y + ny*z)
// Inside is value < iso. Returns { positions: Float32Array, indices: Uint32Array }
const CUBE_EDGES = [
  [0, 1], [2, 3], [4, 5], [6, 7], // x edges
  [0, 2], [1, 3], [4, 6], [5, 7], // y edges
  [0, 4], [1, 5], [2, 6], [3, 7], // z edges
];
const CORNER = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];

export function surfaceNets(values, dims, origin, h, iso = 0) {
  const [nx, ny, nz] = dims;
  const cellIndex = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const pos = [];
  const cv = new Float32Array(8);
  const cidx = (x, y, z) => x + (nx - 1) * (y + (ny - 1) * z);
  for (let z = 0; z < nz - 1; z++)
    for (let y = 0; y < ny - 1; y++)
      for (let x = 0; x < nx - 1; x++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const o = CORNER[c];
          const v = values[x + o[0] + nx * (y + o[1] + ny * (z + o[2]))] - iso;
          cv[c] = v;
          if (v < 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;
        let sx = 0, sy = 0, sz = 0, cnt = 0;
        for (const [a, b] of CUBE_EDGES) {
          const va = cv[a], vb = cv[b];
          if ((va < 0) === (vb < 0)) continue;
          const t = va / (va - vb);
          const A = CORNER[a], B = CORNER[b];
          sx += A[0] + (B[0] - A[0]) * t;
          sy += A[1] + (B[1] - A[1]) * t;
          sz += A[2] + (B[2] - A[2]) * t;
          cnt++;
        }
        cellIndex[cidx(x, y, z)] = pos.length / 3;
        pos.push(origin[0] + (x + sx / cnt) * h, origin[1] + (y + sy / cnt) * h, origin[2] + (z + sz / cnt) * h);
      }
  const tris = [];
  const val = (x, y, z) => values[x + nx * (y + ny * z)] - iso;
  for (let z = 1; z < nz - 1; z++)
    for (let y = 1; y < ny - 1; y++)
      for (let x = 1; x < nx - 1; x++) {
        const v0 = val(x, y, z);
        const in0 = v0 < 0;
        // x-edge (x,y,z)-(x+1,y,z): cells sharing it: (x, y-1..y, z-1..z)
        if (x < nx - 1) {
          const in1 = val(x + 1, y, z) < 0;
          if (in0 !== in1) quad(tris, cellIndex, cidx(x, y - 1, z - 1), cidx(x, y, z - 1), cidx(x, y, z), cidx(x, y - 1, z), in0);
        }
        if (y < ny - 1) {
          const in1 = val(x, y + 1, z) < 0;
          if (in0 !== in1) quad(tris, cellIndex, cidx(x - 1, y, z - 1), cidx(x - 1, y, z), cidx(x, y, z), cidx(x, y, z - 1), in0);
        }
        if (z < nz - 1) {
          const in1 = val(x, y, z + 1) < 0;
          if (in0 !== in1) quad(tris, cellIndex, cidx(x - 1, y - 1, z), cidx(x, y - 1, z), cidx(x, y, z), cidx(x - 1, y, z), in0);
        }
      }
  return { positions: new Float32Array(pos), indices: new Uint32Array(tris) };
}
function quad(tris, ci, a, b, c, d, flip) {
  const A = ci[a], B = ci[b], C = ci[c], D = ci[d];
  if (A < 0 || B < 0 || C < 0 || D < 0) return;
  if (flip) tris.push(A, B, C, A, C, D);
  else tris.push(A, C, B, A, D, C);
}

// Remove triangles failing predicate(centroid) and compact vertices
export function filterMesh(mesh, removeFn) {
  const P = mesh.positions, I = mesh.indices;
  const keep = [];
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const cen = [(P[a] + P[b] + P[c]) / 3, (P[a + 1] + P[b + 1] + P[c + 1]) / 3, (P[a + 2] + P[b + 2] + P[c + 2]) / 3];
    if (!removeFn(cen)) keep.push(I[t], I[t + 1], I[t + 2]);
  }
  return compact(P, keep);
}
export function compact(P, tri) {
  const map = new Int32Array(P.length / 3).fill(-1);
  const np = [];
  const ni = new Uint32Array(tri.length);
  for (let i = 0; i < tri.length; i++) {
    const v = tri[i];
    if (map[v] < 0) { map[v] = np.length / 3; np.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]); }
    ni[i] = map[v];
  }
  return { positions: new Float32Array(np), indices: ni };
}

// keep only the largest connected component
export function largestComponent(mesh) {
  const n = mesh.positions.length / 3, I = mesh.indices;
  const parent = new Int32Array(n).map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let t = 0; t < I.length; t += 3) {
    const a = find(I[t]), b = find(I[t + 1]), c = find(I[t + 2]);
    parent[b] = a; parent[find(c)] = a;
  }
  const cnt = new Map();
  for (let i = 0; i < n; i++) { const r = find(i); cnt.set(r, (cnt.get(r) || 0) + 1); }
  let best = -1, bc = -1;
  for (const [r, c] of cnt) if (c > bc) { bc = c; best = r; }
  const keep = [];
  for (let t = 0; t < I.length; t += 3) if (find(I[t]) === best) keep.push(I[t], I[t + 1], I[t + 2]);
  return compact(mesh.positions, keep);
}

// Laplacian smoothing of positions (in place), optionally restricted
export function smoothMesh(mesh, iters = 2, lambda = 0.5) {
  const n = mesh.positions.length / 3, I = mesh.indices, P = mesh.positions;
  const acc = new Float32Array(n * 3), deg = new Float32Array(n);
  for (let it = 0; it < iters; it++) {
    acc.fill(0); deg.fill(0);
    for (let t = 0; t < I.length; t += 3)
      for (let e = 0; e < 3; e++) {
        const a = I[t + e], b = I[t + ((e + 1) % 3)];
        for (let k = 0; k < 3; k++) { acc[a * 3 + k] += P[b * 3 + k]; acc[b * 3 + k] += P[a * 3 + k]; }
        deg[a]++; deg[b]++;
      }
    for (let i = 0; i < n; i++) if (deg[i] > 0) for (let k = 0; k < 3; k++) P[i * 3 + k] += lambda * (acc[i * 3 + k] / deg[i] - P[i * 3 + k]);
  }
  return mesh;
}

export function sampleSDF(sdf, bmin, bmax, h) {
  const dims = [0, 1, 2].map((k) => Math.ceil((bmax[k] - bmin[k]) / h) + 1);
  const [nx, ny, nz] = dims;
  const v = new Float32Array(nx * ny * nz);
  const p = [0, 0, 0];
  let i = 0;
  for (let z = 0; z < nz; z++) {
    p[2] = bmin[2] + z * h;
    for (let y = 0; y < ny; y++) {
      p[1] = bmin[1] + y * h;
      for (let x = 0; x < nx; x++) { p[0] = bmin[0] + x * h; v[i++] = sdf(p); }
    }
  }
  return { values: v, dims, origin: bmin.slice(), h };
}
