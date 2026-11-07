import './style.css';
import { Session, PACE_SITES, DEVICES } from './core/session.js';
import { SCENARIOS } from './core/scenarios.js';
import { PV_NAMES } from './core/tissue.js';
import { View3D } from './ui/view3d.js';
import { EGMView } from './ui/egmview.js';
import { ECG_LEADS } from './core/egm.js';
import { latColor } from './core/fam.js';
import { polyDist } from './core/vec.js';

const $ = (s) => document.querySelector(s);
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style') el.style.cssText = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
const fmtT = (ms) => { const s = Math.floor(ms / 1000); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

const state = { ss: null, view: null, egm: null, speed: 1, paused: false, tab: 'cath', steer: 'ABL', held: new Map(), lastUi: 0, lastRebuild: 0, rfHold: false };

// ---------------- scenario picker ----------------
function showPicker(first) {
  const m = $('#modal');
  m.innerHTML = '';
  m.append(h('div', { class: 'picker' },
    h('h2', {}, '不整脈を選択'),
    h('p', { class: 'lead' }, 'カテーテルで心腔内をなぞって3Dジオメトリーを作成（FAM）し、心内心電図と興奮伝播マップで回路・起源を同定して、RF／クライオ／パルスフィールドで治療します。', h('br'), '操作：右下の操作パッドまたはキーボード（W/S 前進・後退、A/D 回転、Q/E 屈曲・戻し、Space 通電）。3D表示はドラッグで回転、ホイールでズーム。'),
    h('div', { class: 'cards' }, ...Object.entries(SCENARIOS).map(([k, d]) => h('button', { class: 'card', onclick: () => start(k) },
      h('div', { class: 'tag' }, d.short), h('h3', {}, d.name), h('p', {}, d.desc), h('div', { class: 'goal' }, '目標：', d.goal)))),
    first ? null : h('div', { style: 'margin-top:14px;text-align:right' }, h('button', { class: 'btn', onclick: () => m.classList.add('hidden') }, '閉じる')),
  ));
  m.classList.remove('hidden');
}

async function start(key) {
  $('#modal').classList.add('hidden');
  const L = $('#loading');
  L.classList.remove('hidden');
  $('#loadingText').textContent = `${SCENARIOS[key].name}：心臓モデルと伝導系を構築中…`;
  await new Promise((r) => setTimeout(r, 40));
  if (state.view) { state.view.renderer.dispose(); $('#view3d').innerHTML = ''; }
  const ss = new Session(key);
  state.ss = ss;
  state.view = new View3D($('#view3d'), ss);
  state.egm = new EGMView($('#egm'), ss);
  state.steer = 'ABL';
  state.view.setView(ss.def.defaultMap === 'LA' ? 'PA' : ss.def.defaultMap === 'RV' ? 'RAO' : 'LAO');
  ss.on('alert', (a) => toast(a.msg, a.level));
  ss.on('log', () => { if (state.tab === 'log') renderPanel(); });
  ss.on('ppi', () => renderPanel());
  ss.on('pacemap', () => renderPanel());
  ss.advance(1200);
  $('#scnName').textContent = SCENARIOS[key].name;
  buildViewbar(); buildPad(); buildEgmBar(); buildTabs(); buildSpeed();
  renderPanel();
  L.classList.add('hidden');
  toast(`目標：${SCENARIOS[key].goal}`, 'ok', 7000);
}

// ---------------- toasts ----------------
function toast(msg, level = 'info', ms = 5000) {
  const el = h('div', { class: `toast ${level}` }, msg);
  $('#toasts').append(el);
  setTimeout(() => el.remove(), ms);
  while ($('#toasts').children.length > 4) $('#toasts').firstChild.remove();
}

// ---------------- top bar ----------------
function buildSpeed() {
  const el = $('#speed');
  el.innerHTML = '';
  const opts = [['⏸', 0], ['0.25×', 0.25], ['0.5×', 0.5], ['1×', 1], ['2×', 2]];
  for (const [l, v] of opts) el.append(h('button', { class: (v === 0 ? state.paused : !state.paused && state.speed === v) ? 'on' : '', onclick: () => { if (v === 0) state.paused = !state.paused; else { state.speed = v; state.paused = false; } buildSpeed(); } }, l));
}
$('#btnNew').addEventListener('click', () => showPicker(false));

// ---------------- 3D view bar ----------------
function seg(items, cur, onPick) {
  return h('div', { class: 'seg' }, ...items.map(([v, l]) => h('button', { class: v === cur ? 'on' : '', onclick: () => onPick(v) }, l)));
}
function buildViewbar() {
  const vb = $('#viewbar');
  const V = state.view;
  vb.innerHTML = '';
  vb.append(seg([['AP', 'AP'], ['LAO', 'LAO'], ['RAO', 'RAO'], ['PA', 'PA'], ['LL', 'LL'], ['INF', '下']], null, (v) => V.setView(v)));
  vb.append(seg([['shell', '形状'], ['lat', 'LAT'], ['volt', '電位'], ['prop', '伝播']], V.opts.mapMode, (v) => { V.opts.mapMode = v; const m = state.ss.maps[state.ss.activeMap]; if (m) m.colorDirty = true; buildViewbar(); }));
  vb.append(h('div', { class: 'seg' },
    h('button', { class: V.opts.anatomy ? 'on' : '', title: '正解の解剖を半透明表示', onclick: () => { V.opts.anatomy = !V.opts.anatomy; buildViewbar(); } }, '解剖ガイド'),
    h('button', { class: V.opts.truthProp ? 'on' : '', title: '真の興奮伝播（学習用）', onclick: () => { V.opts.truthProp = !V.opts.truthProp; V.colorTruth(true); buildViewbar(); } }, '真の伝播'),
    h('button', { class: V.opts.tags ? 'on' : '', onclick: () => { V.opts.tags = !V.opts.tags; buildViewbar(); } }, 'タグ'),
  ));
}
function updateColorbar() {
  const V = state.view, el = $('#colorbar');
  const mode = V.opts.mapMode;
  const m = state.ss.maps[state.ss.activeMap];
  if (!m || mode === 'shell' || !m.points.length) { el.innerHTML = ''; return; }
  if (mode === 'volt') {
    el.innerHTML = `<div>バイポーラ電位 (mV)</div><div class="bar" style="background:linear-gradient(90deg,#8c8c94 0 8%,#ff1a1a 8%,#ff8c0d,#fff21a,#33e640,#26d9f2,#3359ff,#a633f2)"></div><div class="ends"><span>${V.opts.voltLo}</span><span>${V.opts.voltHi}</span></div>`;
  } else {
    const stops = [0, 0.17, 0.33, 0.5, 0.67, 0.83, 1].map((x) => { const c = latColor(x, 0, 1); return `rgb(${c.map((v) => Math.round(v * 255)).join(',')})`; });
    el.innerHTML = `<div>LAT (ms, 基準=${state.ss.refMode === 'QRS' ? 'QRS onset' : 'CS 9-10'})</div><div class="bar" style="background:linear-gradient(90deg,${stops.join(',')})"></div><div class="ends"><span>${isFinite(V.latLo) ? Math.round(V.latLo) : '-'}</span><span>${isFinite(V.latHi) ? Math.round(V.latHi) : '-'}</span></div>`;
  }
}

// ---------------- steering pad ----------------
const PAD = [
  ['flex', '屈曲\nQ'], ['adv', '前進\nW'], ['rel', '戻し\nE'],
  ['ccw', '反時計\nA'], ['ret', '後退\nS'], ['cw', '時計\nD'],
  ['srot', 'シース\n回転 Z'], ['stilt', 'シース\n傾け R'], ['energy', '通電\nSpace'],
];
function buildPad() {
  const el = $('#pad');
  el.innerHTML = '';
  const ss = state.ss;
  const opts = ['ABL', 'MAP'].filter((k) => ss.inserted.has(k));
  el.append(h('div', { class: 't' }, h('span', {}, '操作対象'), h('select', { onchange: (e) => { state.steer = e.target.value; } }, ...opts.map((k) => h('option', { value: k, selected: state.steer === k ? true : null }, k === 'ABL' ? `ABL（${DEVICES[ss.abl.device].name.split('（')[0]}）` : 'MAP 多極')))));
  for (const [a, l] of PAD) {
    const b = h('button', { 'data-a': a }, ...l.split('\n').flatMap((x, i) => (i ? [h('br'), x] : [x])));
    const down = (e) => { e.preventDefault(); if (a === 'energy') { energyToggle(); return; } state.held.set(a, 1); b.classList.add('hold'); };
    const up = () => { state.held.delete(a); b.classList.remove('hold'); };
    b.addEventListener('pointerdown', down);
    b.addEventListener('pointerup', up); b.addEventListener('pointerleave', up); b.addEventListener('pointercancel', up);
    el.append(b);
  }
  el.append(h('div', { class: 'val', id: 'padval' }, ''));
}
const KEYMAP = { KeyW: 'adv', KeyS: 'ret', KeyA: 'ccw', KeyD: 'cw', KeyQ: 'flex', KeyE: 'rel', KeyZ: 'srot', KeyX: 'srot-', KeyR: 'stilt', KeyF: 'stilt-' };
window.addEventListener('keydown', (e) => {
  if (!state.ss || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) energyToggle(); return; }
  const a = KEYMAP[e.code];
  if (a) { state.held.set(a, 1); e.preventDefault(); }
});
window.addEventListener('keyup', (e) => { const a = KEYMAP[e.code]; if (a) state.held.delete(a); });

function applyHeld(dtms) {
  const ss = state.ss;
  if (!state.held.size) return;
  const k = dtms / 16;
  const pvDev = state.steer === 'ABL' && DEVICES[ss.abl.device].kind === 'pv';
  for (const [a] of state.held) {
    const neg = a.endsWith('-');
    const act = neg ? a.slice(0, -1) : a;
    if (pvDev) {
      const p = ss.abl.pv;
      if (p.on && ss.abl.device === 'CRYO_BALLOON') continue;
      if (act === 'adv') p.depth = Math.min(10, p.depth + 0.12 * k);
      if (act === 'ret') p.depth = Math.max(-6, p.depth - 0.12 * k);
      if (act === 'flex') p.tiltA = Math.min(30, p.tiltA + 0.5 * k);
      if (act === 'rel') p.tiltA = Math.max(-30, p.tiltA - 0.5 * k);
      if (act === 'cw') p.tiltB = Math.min(30, p.tiltB + 0.5 * k);
      if (act === 'ccw') p.tiltB = Math.max(-30, p.tiltB - 0.5 * k);
      continue;
    }
    const c = ss.cath[state.steer];
    if (!c || !ss.inserted.has(state.steer)) continue;
    c.act(act, neg ? -k : k);
  }
}

function energyToggle() {
  const ss = state.ss, abl = ss.abl, dev = abl.device;
  if (!ss.inserted.has('ABL')) return;
  if (dev === 'RF' || dev === 'CRYO_FOCAL') {
    if (abl.rf.on || abl.cryo.on) abl.stopFocal(ss.cath.ABL); else abl.startFocal(ss.cath.ABL);
  } else if (dev === 'PFA_FOCAL') abl.startFocal(ss.cath.ABL);
  else if (dev === 'CRYO_BALLOON') { if (abl.pv.on) abl.stopPV(); else abl.startPV(); }
  else if (dev === 'PFA_PV') abl.startPV();
  renderPanel();
}

// ---------------- EGM bar ----------------
function buildEgmBar() {
  const el = $('#egmbar'), E = state.egm;
  el.innerHTML = '';
  el.append(h('span', {}, '表示幅'), seg([[1500, '1.5s'], [2500, '2.5s'], [4000, '4s'], [8000, '8s']], E.window, (v) => { E.window = v; buildEgmBar(); }));
  el.append(h('span', {}, '体表'), seg([['5', '5誘導'], ['12', '12誘導'], ['0', 'なし']], E.surface.length === 12 ? '12' : E.surface.length === 0 ? '0' : '5', (v) => { E.surface = v === '12' ? ECG_LEADS.slice() : v === '0' ? [] : ['I', 'II', 'aVF', 'V1', 'V6']; buildEgmBar(); }));
  el.append(h('span', {}, 'ゲイン'), h('button', { class: 'btn', onclick: () => { E.gainIC /= 1.4; } }, '−'), h('button', { class: 'btn', onclick: () => { E.gainIC *= 1.4; } }, '＋'));
  el.append(h('button', { class: 'btn' + (E.frozen ? ' on' : ''), onclick: () => { E.frozen = !E.frozen; E.tFrozen = Math.floor(state.ss.S.t) - 1; buildEgmBar(); } }, E.frozen ? '再開' : 'フリーズ'));
  el.append(h('span', { class: 'help' }, 'クリック2回でキャリパー計測'));
}

// ---------------- side tabs ----------------
const TABS = [['cath', 'カテ'], ['map', 'マップ'], ['abl', '焼灼'], ['stim', '刺激'], ['log', '記録']];
function buildTabs() {
  const el = $('#tabs');
  el.innerHTML = '';
  for (const [k, l] of TABS) el.append(h('button', { class: state.tab === k ? 'on' : '', onclick: () => { state.tab = k; buildTabs(); renderPanel(); } }, l));
}
function renderPanel() {
  const p = $('#panel');
  const scroll = p.scrollTop;
  p.innerHTML = '';
  const f = { cath: panelCath, map: panelMap, abl: panelAbl, stim: panelStim, log: panelLog }[state.tab];
  p.append(...f());
  p.scrollTop = scroll;
  updateLive();
}
const sec = (title, ...kids) => h('div', { class: 'sec' }, h('h4', {}, title), ...kids);
const row = (...kids) => h('div', { class: 'row' }, ...kids);
const chk = (label, val, on) => h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: val, onchange: (e) => on(e.target.checked) }), label);

function panelCath() {
  const ss = state.ss;
  const out = [];
  const item = (k, extra) => row(
    h('button', { class: 'btn' + (ss.inserted.has(k) ? ' on' : ''), style: 'min-width:150px;text-align:left', onclick: () => { ss.inserted.has(k) ? ss.remove(k) : ss.insert(k); buildPad(); renderPanel(); } }, (ss.inserted.has(k) ? '✓ ' : '+ ') + ss.cath[k].def.name),
    extra || null);
  out.push(sec('診断カテーテル（標準位置に留置）',
    item('HRA'), item('HIS'),
    item('RVA', h('select', { onchange: (e) => { ss.cath.RVA.site = e.target.value; } }, ...[['apex', '心尖部'], ['sept', '中隔'], ['rvot', '流出路']].map(([v, l]) => h('option', { value: v, selected: ss.cath.RVA.site === v ? true : null }, l)))),
    item('CS', h('span', {}, h('button', { class: 'btn', onclick: () => ss.cath.CS.act('ret') }, '引く'), ' ', h('button', { class: 'btn', onclick: () => ss.cath.CS.act('adv') }, '進める'))),
  ));
  const acc = (k) => h('select', { onchange: (e) => { ss.cath[k].setAccess(e.target.value); } }, ...Object.entries(ss.cath[k].presets).map(([v, p]) => h('option', { value: v, selected: ss.cath[k].access === v ? true : null }, p.label)));
  out.push(sec('操作カテーテル',
    item('ABL'), row(h('label', {}, 'アクセス'), acc('ABL')),
    item('MAP'), row(h('label', {}, 'アクセス'), acc('MAP')),
    h('div', { class: 'help' }, '左房・左室へは経中隔アクセスを選択します。シース先端から前進(W/S)、回転(A/D)、屈曲(Q/E)で操作し、シース自体の向きは Z/X（回転）、R/F（傾け）で変えられます。壁に押し付けると接触圧(CF)が上がります。'),
  ));
  out.push(sec('ヒント',
    h('div', { class: 'help' }, '1. 「マップ」タブで新規マップを作り、FAM記録をONにしてカテーテルで心腔内をくまなくなぞる', h('br'), '2. ポイント自動取得をONにし、頻拍中または洞調律でLAT/電位を取得', h('br'), '3. 「刺激」タブで誘発 → 「焼灼」タブで治療 → 再誘発で効果判定'),
  ));
  return out;
}

function panelMap() {
  const ss = state.ss, V = state.view;
  const out = [];
  const names = Object.keys(ss.maps);
  let newCh = ss.def.defaultMap;
  out.push(sec('マップ',
    names.length ? row(h('label', {}, '表示中'), h('select', { onchange: (e) => { ss.activeMap = e.target.value; renderPanel(); } }, ...names.map((n) => h('option', { value: n, selected: n === ss.activeMap ? true : null }, n)))) : h('div', { class: 'note' }, 'まだマップがありません。'),
    row(h('label', {}, '新規'), h('select', { onchange: (e) => { newCh = e.target.value; } }, ...['RA', 'LA', 'RV', 'LV'].map((c) => h('option', { value: c, selected: c === newCh ? true : null }, { RA: '右房', LA: '左房', RV: '右室', LV: '左室' }[c]))),
      h('button', { class: 'btn pri', onclick: () => { const n = `${newCh}-${names.length + 1}`; ss.newMap(n, newCh); ss.famOn = true; ss.acqOn = true; renderPanel(); } }, '作成')),
  ));
  const m = ss.maps[ss.activeMap];
  if (m) {
    out.push(sec('ジオメトリー作成（FAM）',
      row(h('button', { class: 'btn rec' + (ss.famOn ? ' on' : ''), onclick: () => { ss.famOn = !ss.famOn; renderPanel(); } }, ss.famOn ? '● FAM記録中' : '○ FAM記録'),
        h('button', { class: 'btn', title: 'デモ用：自動で心腔内をスイープ', onclick: () => { ss.autoFam(m.name, m.chamber); renderPanel(); } }, '自動FAM（デモ）')),
      h('div', { class: 'kv' }, h('span', {}, '容積'), h('span', { 'data-live': 'vol' }, `${m.volumeMl().toFixed(0)} ml`), h('span', {}, '点数'), h('span', { 'data-live': 'pts' }, `${m.points.length}`)),
      row(h('label', {}, '不透明度'), h('input', { type: 'range', min: 0.3, max: 1, step: 0.05, value: V.opts.famOpacity ?? 1, oninput: (e) => { V.opts.famOpacity = +e.target.value; m.colorDirty = true; } })),
      row(h('button', { class: 'btn', onclick: () => { if (confirm('このマップの形状と点を削除しますか？')) { delete ss.maps[m.name]; state.view.famMeshes.get(m.name)?.mesh.removeFromParent(); state.view.famMeshes.delete(m.name); ss.activeMap = Object.keys(ss.maps)[0] || null; renderPanel(); } } }, 'マップ削除')),
    ));
    out.push(sec('ポイント取得（LAT・電位）',
      row(h('button', { class: 'btn' + (ss.acqOn ? ' on' : ''), onclick: () => { ss.acqOn = !ss.acqOn; renderPanel(); } }, ss.acqOn ? '自動取得 ON' : '自動取得 OFF'),
        h('button', { class: 'btn', onclick: () => { m.clearPoints(); renderPanel(); } }, '点をクリア')),
      row(h('label', {}, '基準'), seg([['CS', 'CS 9-10'], ['QRS', 'QRS onset']], ss.refMode, (v) => { ss.refMode = v; renderPanel(); })),
      row(h('label', {}, 'WOI'), h('span', { class: 'note' }, '基準の'), h('input', { type: 'number', value: ss.woiPre || 220, onchange: (e) => { ss.woiPre = +e.target.value; } }), h('span', { class: 'note' }, 'ms前〜'), h('input', { type: 'number', value: ss.woiPost || 140, onchange: (e) => { ss.woiPost = +e.target.value; } }), h('span', { class: 'note' }, 'ms後')),
      chk('PVC（異所性心室興奮）のみ取得', ss.pvcOnly, (v) => { ss.pvcOnly = v; }),
      chk('取得点を表示', V.opts.points, (v) => { V.opts.points = v; m.colorDirty = true; }),
      row(h('label', {}, '電位域'), h('input', { type: 'number', step: 0.05, value: V.opts.voltLo, onchange: (e) => { V.opts.voltLo = +e.target.value; m.colorDirty = true; } }), '〜', h('input', { type: 'number', step: 0.1, value: V.opts.voltHi, onchange: (e) => { V.opts.voltHi = +e.target.value; m.colorDirty = true; } }), 'mV'),
      h('div', { class: 'help' }, '接触している電極（MAPの白い電極、ABL先端）から1拍ごとに取得します。頻拍の回路同定はWOIを周期長に合わせ、色がすべての周期をカバーする（early meets late）かを確認します。'),
    ));
  }
  out.push(sec('表示', chk('解剖ガイド（正解形状）を表示', V.opts.anatomy, (v) => { V.opts.anatomy = v; buildViewbar(); }), chk('解剖ガイドを濃く', V.opts.xray, (v) => { V.opts.xray = v; V.colorTruth(true); }), chk('全マップを同時表示', V.opts.showAllMaps, (v) => { V.opts.showAllMaps = v; })));
  return out;
}

function panelAbl() {
  const ss = state.ss, abl = ss.abl, dev = abl.device;
  const out = [];
  out.push(sec('エネルギー／デバイス',
    row(h('select', { class: 'grow', onchange: (e) => { ss.setDevice(e.target.value); buildPad(); renderPanel(); } }, ...Object.entries(DEVICES).map(([k, d]) => h('option', { value: k, selected: k === dev ? true : null }, d.name)))),
    DEVICES[dev].kind === 'pv' ? h('div', { class: 'help' }, '肺静脈用デバイスは経中隔で左房に挿入されます。操作パッド：前進/後退＝押し付け/引き、屈曲/戻し・時計/反時計＝向き（傾き）調整。') : null,
  ));
  if (dev === 'RF') {
    const r = abl.rf;
    out.push(sec('RF（イリゲーション）',
      row(h('label', {}, '出力'), h('input', { type: 'range', min: 20, max: 50, step: 5, value: r.power, oninput: (e) => { r.power = +e.target.value; e.target.nextSibling.textContent = `${r.power} W`; } }), h('span', { style: 'min-width:44px' }, `${r.power} W`)),
      row(seg([[30, '30W'], [35, '35W'], [40, '40W'], [50, '50W（HPSD）']], r.power, (v) => { r.power = v; renderPanel(); })),
      h('button', { class: 'btn energy rf' + (r.on ? ' on' : ''), 'data-live': 'rfbtn', onclick: energyToggle }, r.on ? '■ 通電停止 (Space)' : '▶ 通電開始 (Space)'),
      h('div', { class: 'help' }, '焼灼指標（≒推定焼灼深度×100）：CTI 450–550、左房前壁 400–500、後壁 300–400 程度が目安。接触圧 10–30 g を保ちます。'),
    ));
  } else if (dev === 'CRYO_FOCAL') {
    const c = abl.cryo;
    out.push(sec('フォーカル・クライオ',
      row(h('label', {}, 'モード'), seg([['map', 'クライオマッピング −30℃'], ['abl', 'アブレーション −75℃']], c.mode, (v) => { c.mode = v; renderPanel(); })),
      h('button', { class: 'btn energy cryo' + (c.on ? ' on' : ''), 'data-live': 'cryobtn', onclick: energyToggle }, c.on ? '■ 冷凍停止' : '▶ 冷凍開始'),
      h('div', { class: 'help' }, 'クライオマッピング（−30℃）は可逆的。房室伝導や頻拍停止を確認してからアブレーションへ移行できます。冷凍中はカテーテルが組織に固着します。'),
    ));
  } else if (dev === 'PFA_FOCAL') {
    out.push(sec('フォーカルPFA',
      h('button', { class: 'btn energy', onclick: energyToggle }, '⚡ 照射（Space）'),
      h('div', { class: 'help' }, '組織選択的（食道・横隔神経に比較的安全）。下壁・僧帽弁輪峡部付近では冠動脈攣縮に注意。'),
    ));
  } else {
    const p = abl.pv, g = abl.pvGeom(ss.T);
    out.push(sec(dev === 'CRYO_BALLOON' ? 'クライオバルーン' : 'PFA（肺静脈用）',
      row(h('label', {}, '標的静脈'), seg(PV_NAMES.map((n) => [n, n]), p.target, (v) => { if (p.on) return; p.target = v; p.depth = 2; p.tiltA = 0; p.tiltB = 0; renderPanel(); })),
      dev === 'PFA_PV' ? row(h('label', {}, '形状'), seg([['basket', 'バスケット'], ['flower', 'フラワー']], p.form, (v) => { p.form = v; renderPanel(); }), h('button', { class: 'btn', onclick: () => { p.rot = (p.rot + 36) % 360; renderPanel(); } }, `回転 36°（現在${p.rot}°）`)) : null,
      h('div', { class: 'kv' }, h('span', {}, '位置'), h('span', { 'data-live': 'pvpos' }, ''), h('span', {}, dev === 'CRYO_BALLOON' ? '造影' : '接触'), h('span', { 'data-live': 'pvgrade' }, '')),
      dev === 'CRYO_BALLOON'
        ? h('div', {}, h('button', { class: 'btn energy cryo' + (p.on ? ' on' : ''), 'data-live': 'balbtn', onclick: energyToggle }, p.on ? '■ 冷凍停止' : '▶ 冷凍開始（180秒）'), row(h('button', { class: 'btn danger grow', onclick: () => { abl.stopPV(true); renderPanel(); } }, 'ダブルストップ')))
        : h('button', { class: 'btn energy', onclick: energyToggle }, '⚡ 照射'),
      dev === 'CRYO_BALLOON' ? h('div', { class: 'help' }, '右側静脈では上大静脈から横隔神経ペーシングを行いCMAPを監視します（自動）。CMAPが30%以上低下したら直ちにダブルストップ。') : h('div', { class: 'help' }, `照射回数：${p.target} ${p.apps[p.target] || 0}回／合計 ${p.total}回。バスケット2回＋回転、フラワー2回などを組み合わせ、隙間を残さないようにします。`),
    ));
  }
  out.push(sec('効果判定・待機',
    row(h('button', { class: 'btn', onclick: () => { ss.waitEdema(); renderPanel(); } }, '⏱ 20分待機（浮腫の回復）'), h('button', { class: 'btn', onclick: () => { state.tab = 'stim'; buildTabs(); renderPanel(); } }, '再誘発へ')),
    h('div', { class: 'help' }, '非貫壁性の焼灼は浮腫による一過性ブロックを作るだけで、待機後に再伝導します。'),
  ));
  out.push(sec('安全モニター', h('div', { class: 'kv' },
    h('span', {}, '食道温'), h('span', { 'data-live': 'eso' }, ''),
    h('span', {}, 'CMAP'), h('span', { 'data-live': 'cmap' }, ''),
    h('span', {}, '合併症'), h('span', { 'data-live': 'comp' }, ''),
  ), row(h('button', { class: 'btn', onclick: () => phrenicTest() }, '横隔神経ペーシング（高出力）'))));
  return out;
}
function phrenicTest() {
  const ss = state.ss;
  const tip = ss.cath.ABL.tip;
  const d = polyDist(tip, ss.T.lm.phrenicR).d;
  if (d < 7) toast('横隔膜の収縮あり：横隔神経を捕捉しています。この部位での焼灼は避けてください', 'warn');
  else toast('横隔神経の捕捉なし', 'ok');
}

function panelStim() {
  const ss = state.ss;
  const P = (state.stimP = state.stimP || { site: ss.def.induce?.site === 'HRA' ? 'HRA12' : 'CS910', cl: 500, s1: 600, n: 8, s2: 300, s3: 0, bcl: 250, bn: 15 });
  const out = [];
  const siteSel = h('select', { onchange: (e) => { P.site = e.target.value; } }, ...Object.entries(PACE_SITES).map(([k, s]) => h('option', { value: k, selected: k === P.site ? true : null, disabled: !ss.inserted.has(s.cath) ? true : null }, s.label)));
  const num = (key, step = 10) => h('input', { type: 'number', step, value: P[key], onchange: (e) => { P[key] = +e.target.value; } });
  out.push(sec('誘発（推奨プロトコル）',
    h('div', { class: 'goalbox' }, ss.def.desc),
    row(h('button', { class: 'btn pri grow', onclick: () => { ss.induce(); toast('誘発プロトコルを開始しました（数十秒かかることがあります）', 'info'); } }, '▶ 推奨プロトコルで誘発'),
      h('button', { class: 'btn' + (ss.S.iso > 1 ? ' on' : ''), onclick: () => { ss.setIso(!(ss.S.iso > 1)); renderPanel(); } }, 'イソプロテレノール')),
  ));
  out.push(sec('刺激装置',
    row(h('label', {}, '刺激部位'), siteSel),
    row(h('label', {}, '連続'), 'CL', num('cl'), 'ms', ss.pace.on ? h('button', { class: 'btn on', onclick: () => { ss.stopPacing(); renderPanel(); } }, '停止') : h('button', { class: 'btn', onclick: () => { ss.startPacing(P.site, P.cl); renderPanel(); } }, '開始')),
    row(h('label', {}, '期外刺激'), 'S1', num('s1'), '×', num('n', 1)),
    row(h('label', {}, ''), 'S2', num('s2'), 'S3', num('s3'), h('button', { class: 'btn', onclick: () => ss.programmed(P.site, P.s1, P.n, [P.s2, P.s3].filter((x) => x > 0)) }, '実行')),
    row(h('label', {}, 'バースト'), 'CL', num('bcl'), '×', num('bn', 1), h('button', { class: 'btn', onclick: () => ss.burst(P.site, P.bcl, P.bn) }, '実行')),
  ));
  const res = [];
  if (ss.ppi) res.push(h('span', {}, 'PPI'), h('span', {}, `${Math.round(ss.ppi)} ms${ss.tclAtPace ? `（PPI−TCL ${Math.round(ss.ppi - ss.tclAtPace)} ms）` : ''}`));
  if (ss.paceMap) res.push(h('span', {}, 'ペースマップ'), h('span', {}, `一致率 ${ss.paceMap.score.toFixed(0)} %`));
  if (ss.key === 'PVC' && !ss.pvcTemplate) res.push(h('span', {}, 'PVCテンプレート'), h('span', {}, '未取得（PVC出現待ち）'));
  out.push(sec('計測', res.length ? h('div', { class: 'kv' }, ...res) : h('div', { class: 'note' }, '頻拍中にABLから頻拍周期より20–30 ms短いCLで連続ペーシングし停止すると、PPI（エントレインメント後の復元周期）を自動計測します。PVCでは、ABLからのペーシングでPVCとの12誘導一致率（ペースマップ）を表示します。')));
  return out;
}

function panelLog() {
  const ss = state.ss, abl = ss.abl;
  const st = ss.successStatus();
  const out = [];
  out.push(sec('治療目標', h('div', { class: 'goalbox' }, ss.def.goal), h('div', { class: 'row', style: `color:${st.ok ? 'var(--ok)' : 'var(--warn)'};font-weight:600` }, st.ok ? '✓ ' : '… ', st.text)));
  const rf = abl.tags.filter((t) => t.energy === 'RF');
  out.push(sec('サマリー', h('div', { class: 'kv' },
    h('span', {}, '経過時間'), h('span', {}, fmtT(ss.S.t)),
    h('span', {}, 'RF焼灼'), h('span', {}, `${rf.length} 点・合計 ${rf.reduce((a, t) => a + (t.t || 0), 0).toFixed(0)} 秒`),
    h('span', {}, 'クライオ/PFA'), h('span', {}, `${abl.tags.filter((t) => t.energy === 'CRYO').length} / ${abl.pv.total} 回`),
    h('span', {}, '合併症'), h('span', {}, abl.comp.size ? [...abl.comp].join(', ') : 'なし'),
  )));
  out.push(sec('ログ', h('div', { class: 'log' }, ...ss.logs.slice().reverse().slice(0, 120).map((l) => h('div', { class: l.level }, h('span', { class: 't' }, fmtT(l.t)), l.msg)))));
  return out;
}

// ---------------- live fields (updated in place; panels are not rebuilt) ----------------
function updateLive() {
  const ss = state.ss, abl = ss.abl, m = ss.maps[ss.activeMap];
  for (const el of document.querySelectorAll('#panel [data-live]')) {
    const k = el.dataset.live;
    let v = null;
    if (k === 'vol' && m) v = `${m.volumeMl().toFixed(0)} ml`;
    else if (k === 'pts' && m) v = `${m.points.length}`;
    else if (k === 'eso') v = `${abl.eso.toFixed(1)} ℃（最高 ${abl.esoMax.toFixed(1)}）`;
    else if (k === 'cmap') v = `${abl.pv.cmap.toFixed(0)} %`;
    else if (k === 'comp') v = abl.comp.size ? `${abl.comp.size} 件（記録タブ）` : 'なし';
    else if (k === 'pvpos') { const p = abl.pv; v = `押し込み ${p.depth.toFixed(1)} mm・傾き ${p.tiltA.toFixed(0)}/${p.tiltB.toFixed(0)}°`; }
    else if (k === 'pvgrade') { const g = abl.pvGeom(ss.T).grade; v = `グレード ${g}/4 ${g === 4 ? '（完全閉塞）' : g === 3 ? '（わずかなリーク）' : '（リークあり：位置調整を）'}`; }
    else if (k === 'rfbtn') { el.classList.toggle('on', abl.rf.on); v = abl.rf.on ? '■ 通電停止 (Space)' : '▶ 通電開始 (Space)'; }
    else if (k === 'cryobtn') { el.classList.toggle('on', abl.cryo.on); v = abl.cryo.on ? '■ 冷凍停止' : '▶ 冷凍開始'; }
    else if (k === 'balbtn') { el.classList.toggle('on', abl.pv.on); v = abl.pv.on ? '■ 冷凍停止' : '▶ 冷凍開始（180秒）'; }
    if (v !== null && el.textContent !== v) el.textContent = v;
  }
}

// ---------------- HUD / status ----------------
function updateHud() {
  const ss = state.ss, abl = ss.abl, c = ss.cath.ABL, dev = abl.device;
  const el = $('#hud');
  if (!ss.inserted.has('ABL')) { el.innerHTML = ''; return; }
  let s = '';
  if (DEVICES[dev].kind === 'focal') {
    const cls = c.cf < 5 ? 'cf-lo' : c.cf > 45 ? 'cf-hi' : 'cf-ok';
    s += `<div>接触圧 <span class="big ${cls}">${c.cf.toFixed(0)}</span> g</div>`;
    if (dev === 'RF') {
      const r = abl.rf;
      s += `<div>${r.on ? '<b style="color:var(--rf)">● RF ON</b>' : 'RF OFF'} ${r.power} W ${r.on ? (r.t).toFixed(1) + ' s' : ''}</div>`;
      s += `<div>Z ${r.imp.toFixed(0)} Ω  ΔZ ${(r.imp0 - r.imp).toFixed(0)}</div>`;
      if (r.cur) s += `<div>焼灼指標 <b>${Math.round(r.cur.depth * 100)}</b>（深度 ${r.cur.depth.toFixed(1)} mm）</div>`;
    } else if (dev === 'CRYO_FOCAL') s += `<div>温度 <b style="color:var(--cryo)">${abl.cryo.temp.toFixed(0)} ℃</b> ${abl.cryo.on ? abl.cryo.t.toFixed(0) + ' s' : ''}${c.locked ? ' 固着' : ''}</div>`;
    else s += `<div>PFA 合計 ${abl.pv.total} 回</div>`;
  } else {
    const p = abl.pv, g = abl.pvGeom(ss.T);
    s += `<div>${p.target}  グレード <b>${g.grade}</b>/4</div>`;
    if (dev === 'CRYO_BALLOON') s += `<div>温度 <b style="color:var(--cryo)">${p.temp.toFixed(0)} ℃</b> ${p.on ? p.t.toFixed(0) + ' s' : ''} ${p.tti ? 'TTI ' + p.tti.toFixed(0) + 's' : ''}</div><div>CMAP ${p.cmap.toFixed(0)} %</div>`;
    else s += `<div>${p.form === 'flower' ? 'フラワー' : 'バスケット'} 回転${p.rot}°  照射 ${p.apps[p.target] || 0}</div>`;
  }
  s += `<div style="color:${abl.eso > 39 || abl.eso < 25 ? 'var(--bad)' : 'var(--mut)'}">食道温 ${abl.eso.toFixed(1)} ℃</div>`;
  el.innerHTML = s;
  const pv = $('#padval');
  if (pv) {
    const st = state.steer, cc = ss.cath[st];
    pv.textContent = DEVICES[dev].kind === 'pv' && st === 'ABL' ? `押込${abl.pv.depth.toFixed(1)} 傾${abl.pv.tiltA.toFixed(0)}/${abl.pv.tiltB.toFixed(0)}` : cc && cc.adv !== undefined ? `前進${cc.adv.toFixed(0)}mm 回転${cc.rot.toFixed(0)}° 屈曲${Math.round(cc.defl * 100)}%` : '';
  }
}
function updateStatus() {
  const ss = state.ss;
  const r = ss.rhythmLabel();
  const b = $('#rhythm');
  b.textContent = r.label;
  b.classList.toggle('tachy', r.label !== '洞調律' && !r.label.startsWith('洞調律'));
  const rt = state.paused ? '' : (state.rt ?? 1) < state.speed * 0.92 ? `  実時間比 ×${(state.rt ?? 1).toFixed(2)}` : '';
  $('#hr').textContent = `HR ${r.hr || '--'}  ${fmtT(ss.S.t)}${rt}`;
  const st = ss.successStatus();
  const sEl = $('#success');
  sEl.textContent = st.text;
  sEl.classList.toggle('ok', st.ok);
}

// ---------------- main loop ----------------
let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const ss = state.ss;
  if (!ss) return;
  const dt = Math.min(100, now - last);
  last = now;
  if (!state.paused) {
    applyHeld(dt);
    const target = dt * state.speed;
    const t0 = performance.now();
    let done = 0;
    while (done < target && performance.now() - t0 < 26) { const step = Math.min(5, target - done); ss.advance(step); done += step; }
    state.rt = 0.9 * (state.rt ?? 1) + 0.1 * (target > 0 ? done / dt : 0);
    if (ss.pace.on && !ss.tclAtPaceSet) { ss.tclAtPace = ss.atrialCL() < 1e8 ? ss.atrialCL() : null; ss.tclAtPaceSet = true; }
    if (!ss.pace.on) ss.tclAtPaceSet = false;
  }
  ss.updateCatheters();
  const m = ss.maps[ss.activeMap];
  if (m && m.dirty && now - state.lastRebuild > 400) { m.rebuild(); state.lastRebuild = now; }
  state.view.render();
  state.egm.draw();
  if (now - state.lastUi > 250) {
    state.lastUi = now;
    updateHud(); updateStatus(); updateColorbar();
    updateLive();
  }
}
requestAnimationFrame(frame);
showPicker(true);
window.__app = state;
