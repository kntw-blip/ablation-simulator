// Three.js 3D mapping view
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CHAMBER_IDS } from '../core/heartmesh.js';
import { latColor, voltColor } from '../core/fam.js';
import { CH } from '../core/tissue.js';
import { add, mul, perp, cross, norm } from '../core/vec.js';
import { DEVICES } from '../core/ablation.js';

const VIEWS = {
  AP: [0, 0, 1], PA: [0, 0, -1], LAO: [0.71, 0, 0.71], RAO: [-0.5, 0, 0.87], LL: [1, 0, 0], RL: [-1, 0, 0], INF: [0, -1, 0.05], SUP: [0, 1, 0.05],
};

export class View3D {
  constructor(container, session) {
    this.el = container;
    this.ss = session;
    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true }));
    r.setPixelRatio(Math.min(2, window.devicePixelRatio));
    r.setClearColor(0x0b0f14);
    container.appendChild(r.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, 1, 1, 3000);
    this.controls = new OrbitControls(this.camera, r.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.center = new THREE.Vector3(-4, -10, -4);
    this.controls.target.copy(this.center);
    this.scene.add(new THREE.HemisphereLight(0xdde8ff, 0x202430, 0.9));
    this.key = new THREE.DirectionalLight(0xffffff, 1.1);
    this.scene.add(this.key);
    this.opts = { anatomy: true, truthProp: false, mapMode: 'shell', points: false, tags: true, latRange: null, voltLo: 0.5, voltHi: 1.5, xray: false };
    this.setView('AP');
    this.buildTruth();
    this.famGroup = new THREE.Group(); this.scene.add(this.famGroup);
    this.cathGroup = new THREE.Group(); this.scene.add(this.cathGroup);
    this.tagGroup = new THREE.Group(); this.scene.add(this.tagGroup);
    this.pointsObj = null;
    this.famMeshes = new Map();
    this.cathObjs = {};
    this.tagCount = -1;
    this.propPhase = 0;
    this.resize();
    new ResizeObserver(() => this.resize()).observe(container);
    // tap / click on a wall -> pick
    this.raycaster = new THREE.Raycaster();
    let down = null;
    r.domElement.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
    r.domElement.addEventListener('pointerup', (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y), dt = performance.now() - down.t;
      down = null;
      if (moved < 7 && dt < 600) this.pick(e);
    });
  }
  resize() {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
  setView(v) {
    const d = VIEWS[v];
    const dist = 235;
    this.camera.position.set(this.center.x + d[0] * dist, this.center.y + d[1] * dist, this.center.z + d[2] * dist);
    this.camera.up.set(0, 1, 0);
    if (v === 'INF' || v === 'SUP') this.camera.up.set(0, 0, 1);
    this.controls.target.copy(this.center);
    this.camera.lookAt(this.center);
    this.controls.update();
  }

  // ground-truth anatomy (hidden "answer" geometry; shown as guide)
  buildTruth() {
    const T = this.ss.T;
    this.truth = {};
    const grp = (this.truthGroup = new THREE.Group());
    for (const id of CHAMBER_IDS) {
      const m = T.heart.meshes[id];
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
      g.setIndex(new THREE.BufferAttribute(m.indices, 1));
      const n = m.positions.length / 3, off = T.offset[id];
      const nrm = new Float32Array(n * 3);
      for (let k = 0; k < n; k++) { nrm[k * 3] = T.normal[(off + k) * 3]; nrm[k * 3 + 1] = T.normal[(off + k) * 3 + 1]; nrm[k * 3 + 2] = T.normal[(off + k) * 3 + 2]; }
      g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
      const col = new Float32Array(n * 3).fill(0.6);
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      const mat = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false });
      const mesh = new THREE.Mesh(g, mat);
      mesh.renderOrder = 1;
      grp.add(mesh);
      this.truth[id] = { mesh, off, n, col };
    }
    this.scene.add(grp);
    this.colorTruth(true);
  }
  colorTruth(force) {
    const T = this.ss.T, S = this.ss.S;
    const prop = this.opts.truthProp;
    if (!prop && !force && !this._truthWasProp) return;
    this._truthWasProp = prop;
    const base = { RA: [0.55, 0.62, 0.78], LA: [0.78, 0.62, 0.55], CS: [0.75, 0.75, 0.5], RV: [0.55, 0.72, 0.6], LV: [0.72, 0.56, 0.72] };
    const t = S.t;
    for (const id of CHAMBER_IDS) {
      const { off, n, col, mesh } = this.truth[id];
      const b = base[id];
      for (let k = 0; k < n; k++) {
        const i = off + k;
        let c = b;
        if (!S.alive[i]) c = [0.35, 0.35, 0.38];
        if (prop && S.alive[i]) {
          const u = t - S.lastAct[i];
          if (u >= 0 && u < 40) c = [1, 1 - u / 60, 0.3 - u / 200];
          else if (u >= 40 && u < S.apd[i]) c = [0.95, 0.35 + 0.2 * (1 - u / S.apd[i]), 0.2];
        }
        if (S.blockUntil[i] > t && S.alive[i]) c = [0.5, 0.45, 0.9];
        col[k * 3] = c[0]; col[k * 3 + 1] = c[1]; col[k * 3 + 2] = c[2];
      }
      mesh.geometry.attributes.color.needsUpdate = true;
      mesh.material.opacity = prop ? 0.85 : this.opts.xray ? 0.32 : 0.16;
      mesh.material.depthWrite = prop;
    }
  }

  // ---- FAM ----
  syncFam() {
    const ss = this.ss;
    for (const [name, m] of Object.entries(ss.maps)) {
      let o = this.famMeshes.get(name);
      if (!o) {
        const mat = new THREE.MeshPhongMaterial({ vertexColors: true, side: THREE.DoubleSide, shininess: 30, specular: 0x222222, transparent: true, opacity: 1 });
        const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
        mesh.renderOrder = 2;
        this.famGroup.add(mesh);
        o = { mesh, version: -1, colorVer: -1 };
        this.famMeshes.set(name, o);
      }
      o.mesh.visible = name === ss.activeMap || this.opts.showAllMaps;
      if (o.version !== m.version && m.mesh) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(m.mesh.positions, 3));
        g.setIndex(new THREE.BufferAttribute(m.mesh.indices, 1));
        g.computeVertexNormals();
        g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(m.mesh.positions.length).fill(0.7), 3));
        o.mesh.geometry.dispose();
        o.mesh.geometry = g;
        o.version = m.version;
        o.interp = null;
        if (!o.centered && name === ss.activeMap) {
          o.centered = true;
          g.computeBoundingSphere();
          const c = g.boundingSphere.center;
          const off = this.camera.position.clone().sub(this.controls.target);
          this.center.copy(c);
          this.controls.target.copy(c);
          this.camera.position.copy(c).add(off.setLength(Math.max(140, g.boundingSphere.radius * 4.2)));
        }
        m.colorDirty = true;
      }
    }
  }
  colorFam(force) {
    const ss = this.ss;
    const m = ss.maps[ss.activeMap];
    if (!m || !m.mesh) return;
    const o = this.famMeshes.get(m.name);
    if (!o || !o.mesh.geometry.attributes.color) return;
    const mode = this.opts.mapMode;
    if (m.colorDirty || !o.interp) { o.interp = m.interpolate(this.opts.fill || 9); m.colorDirty = false; force = true; }
    if (!force && mode !== 'prop') return;
    const col = o.mesh.geometry.attributes.color.array;
    const { lat, volt } = o.interp;
    const n = lat.length;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) if (isFinite(lat[i])) { lo = Math.min(lo, lat[i]); hi = Math.max(hi, lat[i]); }
    if (this.opts.latRange) [lo, hi] = this.opts.latRange;
    this.latLo = lo; this.latHi = hi;
    const grey = [0.72, 0.72, 0.74];
    if (mode === 'prop') this.propPhase = (this.propPhase + 4) % Math.max(1, hi - lo + 60);
    for (let i = 0; i < n; i++) {
      let c = null;
      if (mode === 'lat' || mode === 'prop') c = latColor(lat[i], lo, hi);
      if (mode === 'volt') c = voltColor(volt[i], this.opts.voltLo, this.opts.voltHi);
      if (mode === 'prop' && isFinite(lat[i])) {
        const ph = lo + this.propPhase - 30;
        const dlt = ph - lat[i];
        const k = dlt >= 0 && dlt < 22 ? 1 - dlt / 22 : 0;
        c = [0.25 + 0.75 * k, 0.12 + 0.6 * k, 0.15 + 0.2 * k];
      }
      if (!c) c = grey;
      col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
    }
    o.mesh.geometry.attributes.color.needsUpdate = true;
    o.mesh.material.opacity = this.opts.famOpacity ?? 1;
    o.mesh.material.depthWrite = (this.opts.famOpacity ?? 1) > 0.95;
    this.syncPoints(m, lo, hi);
  }
  syncPoints(m, lo, hi) {
    if (this.pointsObj) { this.scene.remove(this.pointsObj); this.pointsObj.geometry.dispose(); this.pointsObj = null; }
    if (!this.opts.points || !m.points.length) return;
    const pos = new Float32Array(m.points.length * 3), col = new Float32Array(m.points.length * 3);
    m.points.forEach((p, k) => {
      pos.set(p.pos, k * 3);
      const c = (this.opts.mapMode === 'volt' ? voltColor(p.volt, this.opts.voltLo, this.opts.voltHi) : latColor(p.lat, lo, hi)) || [1, 1, 1];
      col.set(c, k * 3);
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.pointsObj = new THREE.Points(g, new THREE.PointsMaterial({ size: 2.2, vertexColors: true, sizeAttenuation: true }));
    this.pointsObj.renderOrder = 4;
    this.scene.add(this.pointsObj);
  }

  // ---- catheters ----
  syncCatheters() {
    const ss = this.ss;
    for (const k of ['HRA', 'HALO', 'HIS', 'RVA', 'CS', 'ABL', 'MAP']) {
      const show = ss.inserted.has(k);
      let o = this.cathObjs[k];
      if (!o) {
        o = { group: new THREE.Group(), shaft: null, els: [] };
        this.cathGroup.add(o.group);
        this.cathObjs[k] = o;
      }
      o.group.visible = show;
      if (!show) continue;
      const c = ss.cath[k];
      const pvDev = k === 'ABL' && DEVICES[ss.abl.device].kind === 'pv';
      const color = new THREE.Color(c.def.color);
      // shaft
      let pts = (c.shaft || []).map((p) => new THREE.Vector3(...p));
      if (pvDev) pts = this.pvDevicePath();
      if (pts.length >= 2) {
        const curve = new THREE.CatmullRomCurve3(pts);
        const geo = new THREE.TubeGeometry(curve, Math.max(8, pts.length * 2), k === 'ABL' ? 1.2 : 0.9, 8, false);
        if (!o.shaft) { o.shaft = new THREE.Mesh(geo, new THREE.MeshPhongMaterial({ color: 0x8a96a8, shininess: 60, depthTest: false, transparent: true, opacity: 0.92 })); o.shaft.renderOrder = 5; o.group.add(o.shaft); }
        else { o.shaft.geometry.dispose(); o.shaft.geometry = geo; }
      }
      // electrodes
      const els = pvDev ? (ss.pvDevice?.els || []) : c.electrodes;
      while (o.els.length < els.length) {
        const m = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshPhongMaterial({ color, emissive: color.clone().multiplyScalar(0.25), shininess: 90, depthTest: false, transparent: true }));
        m.renderOrder = 6;
        o.group.add(m); o.els.push(m);
      }
      o.els.forEach((m, idx) => {
        const e = els[idx];
        m.visible = !!e;
        if (!e) return;
        m.position.set(...e.pos);
        const big = k === 'ABL' && idx === 0;
        m.scale.setScalar(big ? 1.75 : k === 'MAP' ? 0.75 : 1.05);
        if (k === 'MAP') m.material.color.set(e.contact ? 0xffffff : c.def.color);
      });
      if (k === 'ABL') this.syncDevice(o, c);
      if (k === 'MAP') this.syncSplines(o, c);
    }
  }
  pvDevicePath() {
    const ss = this.ss;
    const g = ss.abl.pvGeom(ss.T);
    const fos = ss.T.lm.fossaLA;
    const back = add(g.center, mul(g.tiltDir, -18));
    return [new THREE.Vector3(...add(fos, [0, 0, 6])), new THREE.Vector3(...fos), new THREE.Vector3(...back), new THREE.Vector3(...g.center)];
  }
  syncDevice(o, c) {
    const ss = this.ss, dev = ss.abl.device;
    if (!o.dev) { o.dev = new THREE.Group(); o.group.add(o.dev); }
    o.dev.clear();
    if (dev === 'CRYO_BALLOON') {
      const g = ss.abl.pvGeom(ss.T);
      const temp = ss.abl.pv.temp;
      const frosty = temp < 0 ? Math.min(1, -temp / 50) : 0;
      const ball = new THREE.Mesh(new THREE.SphereGeometry(14, 32, 20), new THREE.MeshPhongMaterial({ color: new THREE.Color().setRGB(0.55 + 0.4 * frosty, 0.75 + 0.2 * frosty, 1), transparent: true, opacity: 0.42, shininess: 100, depthWrite: false, depthTest: false }));
      ball.position.set(...g.center);
      ball.renderOrder = 7;
      o.dev.add(ball);
    } else if (dev === 'PFA_PV') {
      const g = ss.abl.pvGeom(ss.T), p = ss.abl.pv;
      const flower = p.form === 'flower';
      const ax = g.tiltDir, u = perp(ax), w = cross(ax, u);
      const R = flower ? 15.5 : 10;
      for (let k = 0; k < 5; k++) {
        const a = ((p.rot + k * 72) * Math.PI) / 180;
        const rad = add(mul(u, Math.cos(a)), mul(w, Math.sin(a)));
        const pts = [];
        for (let s = 0; s <= 12; s++) {
          const f = s / 12;
          const r = flower ? R * Math.sin(Math.PI * Math.min(1, f * 1.2)) : R * Math.sin(Math.PI * f);
          const along = flower ? 22 * f - 22 * f * f : 26 * f - 8;
          pts.push(new THREE.Vector3(...add(add(g.center, mul(ax, along + 4)), mul(rad, r))));
        }
        const tube = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, 0.6, 6), new THREE.MeshPhongMaterial({ color: 0x7fe0c0, emissive: 0x113322, depthTest: false, transparent: true }));
        tube.renderOrder = 7;
        o.dev.add(tube);
      }
    }
  }
  syncSplines(o, c) {
    if (!o.spl) { o.spl = new THREE.Group(); o.group.add(o.spl); }
    o.spl.clear();
    for (let sp = 0; sp < 5; sp++) {
      const pts = [new THREE.Vector3(...c.tip)];
      for (const e of c.electrodes) if (e.spline === sp) pts.push(new THREE.Vector3(...e.pos));
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x5ad1ff, depthTest: false, transparent: true }));
      line.renderOrder = 6;
      o.spl.add(line);
    }
  }

  // ---- ablation tags ----
  syncTags() {
    const tags = this.ss.abl.tags;
    this.tagGroup.visible = this.opts.tags;
    if (tags.length === this.tagCount) return;
    this.tagCount = tags.length;
    this.tagGroup.clear();
    for (const t of tags) {
      if (t.ring) {
        const tor = new THREE.Mesh(new THREE.TorusGeometry(t.ring.r, 1.3, 8, 40), new THREE.MeshPhongMaterial({ color: t.energy === 'PFA' ? 0x37e0c8 : 0x6fb6ff, transparent: true, opacity: 0.8 }));
        tor.position.set(...(t.ring.form ? t.pos : t.ring.o));
        tor.lookAt(new THREE.Vector3(...add(tor.position.toArray(), t.ring.d)));
        this.tagGroup.add(tor);
        continue;
      }
      let color = 0xffffff;
      if (t.energy === 'RF') color = t.index >= 450 ? 0xff2a4a : t.index >= 350 ? 0xff7aa8 : 0xffd2e2;
      if (t.energy === 'CRYO') color = 0x6fb6ff;
      if (t.energy === 'PFA') color = 0x37e0c8;
      const s = new THREE.Mesh(new THREE.SphereGeometry(2.6, 14, 10), new THREE.MeshPhongMaterial({ color, emissive: new THREE.Color(color).multiplyScalar(0.3) }));
      s.position.set(...t.pos);
      s.renderOrder = 8;
      this.tagGroup.add(s);
    }
  }

  pick(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const ss = this.ss;
    const fam = this.famMeshes.get(ss.activeMap);
    let hit = null, famHit = false;
    if (fam && fam.mesh.visible && fam.mesh.geometry.attributes.position) { hit = this.raycaster.intersectObject(fam.mesh, false)[0]; famHit = !!hit; }
    if (!hit) {
      // beyond the current shell: extend towards the (hidden) true wall of the mapped chamber
      const m = ss.maps[ss.activeMap];
      const ids = m ? [m.chamber] : ['RA', 'LA', 'RV', 'LV'];
      hit = this.raycaster.intersectObjects(ids.map((id) => this.truth[id].mesh), false)[0];
    }
    if (!hit) return;
    const p = [hit.point.x, hit.point.y, hit.point.z];
    const nr = ss.hash.nearest(p, 16);
    const names = ['RA', 'LA', 'CS', 'RV', 'LV'];
    let ch = nr.i >= 0 ? names[ss.T.chamber[nr.i]] : null;
    if (ch === 'CS') ch = 'RA';
    if (ss.maps[ss.activeMap]) ch = ss.maps[ss.activeMap].chamber; // the map belongs to one chamber
    void famHit;
    this.onPick && this.onPick(p, ch);
    // brief marker
    if (!this.pickMark) { this.pickMark = new THREE.Mesh(new THREE.RingGeometry(2.2, 3, 24), new THREE.MeshBasicMaterial({ color: 0x33d1ff, side: THREE.DoubleSide, depthTest: false, transparent: true })); this.pickMark.renderOrder = 9; this.scene.add(this.pickMark); }
    this.pickMark.position.copy(hit.point);
    if (hit.face) this.pickMark.lookAt(hit.point.clone().add(hit.face.normal));
    this.pickMark.visible = true; this.pickT = performance.now();
  }

  render() {
    if (this.pickMark && this.pickMark.visible && performance.now() - this.pickT > 900) this.pickMark.visible = false;
    const ss = this.ss;
    this.truthGroup.visible = this.opts.anatomy || this.opts.truthProp;
    this.colorTruth(false);
    this.syncFam();
    this.colorFam(false);
    this.syncCatheters();
    this.syncTags();
    this.key.position.copy(this.camera.position).add(new THREE.Vector3(40, 80, 0));
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    void ss;
  }
}
export { VIEWS };
