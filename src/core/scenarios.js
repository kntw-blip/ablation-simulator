// Scenario definitions: substrate, automaticity, induction protocols, success criteria
import { buildTissue, REG, CH, PV_NAMES } from './tissue.js';
import { Sim, sinusNode, ORIGIN } from './sim.js';

export const SCENARIOS = {
  AFL: {
    name: '通常型心房粗動（CTI依存）',
    short: 'AFL',
    desc: '三尖弁輪を反時計回りに旋回するマクロリエントリー。CS入口部からのS1S2またはバースト刺激で誘発されます。',
    goal: 'CTI（三尖弁輪〜下大静脈）に貫壁性の線状焼灼を作り、双方向性ブロックを確認する',
    induce: { site: 'CS9-10', s1: 600, s2: [240, 230, 220, 210, 200, 190], burst: [240, 220, 200] },
    defaultMap: 'RA',
  },
  PAF: {
    name: '発作性心房細動（肺静脈起源）',
    short: 'PAF',
    desc: '肺静脈スリーブ内の異所性興奮がトリガー・ドライバーとなるAF。洞調律中にもPV起源の心房期外収縮が出現します。',
    goal: '4本の肺静脈を電気的に隔離（入口・出口ブロック）する',
    induce: { iso: true, site: 'CS9-10', burst: [200, 180, 160] },
    defaultMap: 'LA',
  },
  AVNRT: {
    name: '房室結節リエントリー性頻拍（slow-fast）',
    short: 'AVNRT',
    desc: '二重房室結節伝導路。早期刺激で速伝導路がブロックされ、遅伝導路を下行・速伝導路を上行して頻拍化します。',
    goal: 'Koch三角下部（CS入口部と三尖弁輪の間）で遅伝導路を焼灼する。His近傍の焼灼は房室ブロックの危険',
    induce: { site: 'HRA', s1: 600, s2: [400, 380, 360, 340, 320, 300, 280, 260] },
    defaultMap: 'RA',
  },
  WPW: {
    name: 'WPW症候群（左側副伝導路）',
    short: 'WPW',
    desc: '僧帽弁輪側壁の顕性副伝導路。洞調律でδ波、心房早期刺激で順方向性房室回帰性頻拍（ORT）が誘発されます。',
    goal: '僧帽弁輪上の副伝導路付着部（最早期心室興奮／最早期逆行性心房興奮部位）を焼灼し、δ波消失を確認',
    induce: { site: 'HRA', s1: 600, s2: [340, 320, 300, 280, 260] },
    defaultMap: 'LA',
  },
  PVC: {
    name: '心室期外収縮（右室流出路起源）',
    short: 'PVC',
    desc: '右室流出路中隔側起源の特発性PVC（三段脈）。左脚ブロック型・下方軸を呈します。',
    goal: 'PVC時の最早期興奮部位（およびペースマップ一致部位）を焼灼し、PVCを消失させる',
    induce: { iso: true },
    defaultMap: 'RV',
  },
};

export function createScenario(key, seed = 7) {
  const T = buildTissue({ scenario: key, seed });
  const S = new Sim(T);
  const sn = sinusNode(T.focus.sn, 820);
  S.pacemakers.push(sn);
  const st = { key, def: SCENARIOS[key], T, S, sn, events: [] };

  if (key === 'PVC') {
    const f = T.focus.pvc;
    const pm = {
      kind: 'PVC', every: 3, coupling: 470, count: 0, enabled: true,
      tick() {},
    };
    S.onVentBeat = (t, o) => {
      if (o === ORIGIN.PVC || !pm.enabled) return;
      pm.count++;
      const every = S.iso > 1.2 ? 2 : pm.every;
      if (pm.count % every === 0) S.schedule(t + pm.coupling / Math.sqrt(S.iso), (tt) => S.stimNodes(f.nodes, tt, ORIGIN.PVC));
    };
    S.pacemakers.push(pm);
    st.pvc = pm;
  }

  if (key === 'PAF') {
    // choose driver vein(s)
    const drivers = ['LSPV', 'RSPV'];
    const latent = ['LIPV'];
    st.pv = {};
    for (const name of PV_NAMES) {
      const f = T.focus.pv[name];
      st.pv[name] = {
        name, nodes: f.nodes, active: drivers.includes(name), latent: latent.includes(name), firing: false,
        cl: 130, next: 0, isolated: false, pacEvery: 0,
      };
    }
    const pm = {
      kind: 'PV', af: false, lastPac: 0,
      tick(sim, t) {
        for (const v of Object.values(st.pv)) {
          const alive = v.nodes.some((i) => sim.alive[i]);
          if (!alive) continue;
          if (v.firing) {
            const cl = v.isolated ? 1400 : v.cl;
            if (t >= v.next) {
              sim.stimNodes(v.nodes, t, ORIGIN.PV);
              v.next = t + cl * (0.85 + Math.random() * 0.3) / Math.sqrt(sim.iso);
            }
          }
        }
        // occasional PACs from active vein during sinus rhythm
        if (!this.af && t - this.lastPac > 5200 + Math.random() * 3000) {
          this.lastPac = t;
          const v = Object.values(st.pv).find((x) => x.active && !x.isolated && x.nodes.some((i) => sim.alive[i]));
          if (v) sim.stimNodes(v.nodes, t, ORIGIN.PV);
        }
      },
    };
    S.pacemakers.push(pm);
    S.avJitter = true;
    st.pvpm = pm;
    st.startAF = () => {
      pm.af = true;
      const now = S.t;
      for (const v of Object.values(st.pv)) if ((v.active || (v.latent && v.activated)) && !v.isolated) { v.firing = true; v.next = now + Math.random() * 100; }
      st.events.push({ t: now, msg: 'AF誘発' });
    };
    st.stopAF = () => { pm.af = false; for (const v of Object.values(st.pv)) if (!v.isolated) v.firing = false; };
  }
  return st;
}

// --- Assessment helpers ---
export function pvIsolationStatus(st) {
  const { T, S } = st;
  const res = {};
  for (let k = 0; k < 4; k++) {
    const name = PV_NAMES[k];
    // sources: sleeve nodes deep in vein (> 6mm); target: LA body nodes (not PV)
    const src = [];
    for (let i = 0; i < T.nMesh; i++) if (T.pvIdx[i] === k && T.region[i] === REG.PV && T.sleeve[i] > 7) src.push(i);
    res[name] = S.isolatedFrom(src, (i) => T.chamber[i] === CH.LA && T.region[i] !== REG.PV && T.region[i] !== REG.VEIN);
  }
  return res;
}

export function ctiBlocked(st) {
  const { T, S } = st;
  // is lateral CTI reachable from septal side through the isthmus (without going around)?
  // Approximate: remove all RA nodes not in CTI region, test connectivity within the CTI strip
  const med = T.nearest('RA', T.lm.csOs, (i) => T.region[i] === REG.CTI);
  const lat = T.nearest('RA', T.lm.tvInf, (i) => T.region[i] === REG.CTI);
  const seen = new Uint8Array(T.n), q = [med];
  seen[med] = 1;
  while (q.length) {
    const i = q.pop();
    if (i === lat) return false;
    for (let k = T.offs[i]; k < T.offs[i + 1]; k++) {
      const j = T.nbr[k];
      if (!seen[j] && T.region[j] === REG.CTI && S.alive[j] && S.blockUntil[j] <= S.t) { seen[j] = 1; q.push(j); }
    }
  }
  return true;
}

export function apBlocked(st) {
  const { T, S } = st;
  return !T.V.AP.length || T.V.AP.some((i) => !S.alive[i]);
}
export function spBlocked(st) {
  const { T, S } = st;
  return !T.V.SP.length || T.V.SP.some((i) => !S.alive[i]);
}
export function pvcEliminated(st) {
  const { T, S } = st;
  return !T.focus.pvc.nodes.some((i) => S.alive[i]);
}
