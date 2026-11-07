// Headless end-to-end check: each scenario is inducible, terminated by the correct ablation, and non-inducible afterwards.
import { Session } from '../src/core/session.js';
import { lerp, dist, sub, mul } from '../src/core/vec.js';

function rfAt(ss, p, sec = 30, W = 35, cf = 15) {
  const { T, abl } = ss, cath = ss.cath.ABL;
  const i = ss.hash.nearest(p, 6).i;
  const n = [T.normal[i * 3], T.normal[i * 3 + 1], T.normal[i * 3 + 2]];
  cath.tip = sub(T.P(i), mul(n, 1.0)); cath.cf = cf; cath.contact = true;
  abl.rf.power = W; abl.startFocal(cath);
  for (let k = 0; k < sec / 0.02; k++) abl.stepFocal(cath, 0.02);
  abl.stopFocal(cath);
}
function waitTachy(ss, maxS) {
  for (let k = 0; k < maxS && !(ss.tachy() || (ss.key === 'PAF' && ss.st.pvpm.af)); k++) ss.advance(1000);
  return ss.tachy() || (ss.key === 'PAF' && ss.st.pvpm.af);
}
const results = [];
for (const key of ['AFL', 'AVNRT', 'WPW', 'PVC', 'PAF']) {
  const ss = new Session(key);
  const { T, S, abl } = ss;
  ss.advance(1500);
  ss.induce();
  const induced = key === 'PVC' ? true : waitTachy(ss, 60);
  if (key === 'AFL') { const [a, b] = T.lm.cti; const n = Math.ceil(dist(a, b) / 4) + 2; for (let k = -1; k <= n; k++) rfAt(ss, lerp(a, b, k / n)); }
  if (key === 'AVNRT') rfAt(ss, lerp(T.lm.spRA, T.lm.csOs, 0.35), 30, 30);
  if (key === 'WPW') rfAt(ss, T.lm.mvLat, 30, 30);
  if (key === 'PVC') rfAt(ss, T.lm.rvotFocus, 40, 35);
  if (key === 'PAF') {
    ss.setDevice('CRYO_BALLOON');
    for (const v of ['LSPV', 'RSPV', 'LIPV', 'RIPV']) { abl.pv.target = v; abl.pv.depth = 3; abl.startPV(); for (let k = 0; k < 180 / 0.02; k++) { abl.stepPV(0.02); if (k % 50 === 0) S.run(S.t + 1); } abl.stopPV(); }
  }
  const success = ss.successStatus().ok;
  ss.advance(5000);
  const terminated = !ss.tachy() && !(key === 'PAF' && ss.st.pvpm.af);
  ss.induce();
  const reinduced = key === 'PVC' ? false : waitTachy(ss, 45);
  const ok = induced && success && terminated && !reinduced && !abl.comp.size;
  results.push({ key, induced, success, terminated, reinduced, complications: [...abl.comp].join(',') || '-', ok });
}
console.table(results);
if (results.some((r) => !r.ok)) { console.error('Scenario test FAILED'); process.exit(1); }
console.log('All scenarios OK');
