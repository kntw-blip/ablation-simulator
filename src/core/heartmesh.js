// Builds the ground-truth chamber meshes from SDFs
import { buildChambers, BOUNDS } from './anatomy.js';
import { sampleSDF, surfaceNets, filterMesh, largestComponent, smoothMesh } from './surfacenets.js';

export const CHAMBER_IDS = ['RA', 'LA', 'CS', 'RV', 'LV'];

export function buildHeartMeshes(h = 2.0) {
  const ch = buildChambers();
  const meshes = {};
  for (const id of CHAMBER_IDS) {
    const c = ch[id];
    // local bounds: sample a coarse grid to find extent
    const g = sampleSDF(c.sdf, BOUNDS.min, BOUNDS.max, h);
    let m = surfaceNets(g.values, g.dims, g.origin, g.h, 0);
    m = filterMesh(m, (p) => c.cuts.some((cut) => cut.test(p)));
    m = largestComponent(m);
    smoothMesh(m, 1, 0.3);
    meshes[id] = m;
  }
  // Union SDF of the blood pool (for catheter collision)
  const all = CHAMBER_IDS.map((id) => ch[id].sdf);
  const blood = (p) => {
    let d = Infinity;
    for (const f of all) { const v = f(p); if (v < d) d = v; }
    return d;
  };
  return { meshes, chambers: ch, blood };
}
