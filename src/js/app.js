import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { Mannequin, BONE_DEFS, BONE_NAMES, IK_CHAINS } from './mannequin.js';
import { LineArtRenderer } from './lineart.js';
import { PRESETS } from './poses.js';

const D2R = Math.PI / 180;
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const bridge = window.bodyFactory || null;

// AI is the main workspace; the existing editor supplies optional pose references.
$('#studio-input-footer').before($('#sec-ai'));
$('#studio-input-footer').append($('#btn-generate'), $('#ai-status'));
$('#studio-settings').append($('#btn-settings'));
document.body.append($('#toast'));
function openPoseEditor() {
  document.body.dataset.workspace = 'pose';
  resize(); state.dirty = state.previewDirty = true;
  setView('front');
}
function returnToStudio() {
  document.body.dataset.workspace = 'studio';
  $('#ai-use-pose').checked = true;
  state.previewDirty = true;
  window.dispatchEvent(new Event('pose-reference-changed'));
}
$('#btn-pose-editor').addEventListener('click', openPoseEditor);
$('#btn-back-studio').addEventListener('click', returnToStudio);

// ---------------- Core setup ----------------
const canvas = $('#stage');
const viewport = $('#viewport');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: false });
renderer.autoClear = false;
renderer.setClearColor(0xffffff, 1);

let mannequin = new Mannequin();
const figures = [mannequin];
mannequin.gender = 'female';
let activeFigure = 0;
const art = new LineArtRenderer(renderer, mannequin);
art.figures = figures;

const camera = new THREE.PerspectiveCamera(28, 1, 0.05, 100);
camera.position.set(0, 1.05, 4.4);
const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 0.88, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.minDistance = 0.8;
controls.maxDistance = 14;
controls.update();

// overlay scene (grid + gizmo), depth-tested against the figure
const overlay = new THREE.Scene();
const grid = new THREE.GridHelper(6, 24, 0xc9d3e2, 0xe6ebf2);
grid.material.transparent = true;
grid.material.opacity = 0.9;
overlay.add(grid);

const gizmo = new TransformControls(camera, canvas);
gizmo.setMode('rotate');
gizmo.setSpace('local');
gizmo.setSize(0.75);
overlay.add(gizmo.getHelper());
// translate mode drags this proxy; the pose follows it via IK (or moves the whole figure)
const handle = new THREE.Object3D();
overlay.add(handle);
const dragStart = { handle: new THREE.Vector3(), root: new THREE.Vector3() };
function placeHandle() {
  if (state.selected) mannequin.bones[state.selected].getWorldPosition(handle.position);
  handle.updateMatrixWorld(true);
}

const state = {
  selected: null,
  autoGround: true,
  limits: true,
  dirty: true,
  previewDirty: true,
  tween: null,
  camTween: null,
};

// ---------------- Resize ----------------
function resize() {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  if (!w || !h) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(dpr);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  art.setSize(Math.floor(w * dpr), Math.floor(h * dpr));
  state.dirty = true;
}
new ResizeObserver(resize).observe(viewport);
resize();

// ---------------- History ----------------
const history = { stack: [], index: -1 };
function snapshot() { return JSON.stringify(figures.map(m => ({ pose: m.getPose(), shape: m.shape, gender: m.gender, position: m.group.position.toArray() }))); }
function restoreSnapshot(text) {
  const saved = JSON.parse(text);
  setFigureCount(saved.length, false);
  saved.forEach((item, i) => {
    figures[i].setPose(item.pose); figures[i].setShape(item.shape);
    figures[i].gender = item.gender; figures[i].group.position.fromArray(item.position);
  });
  activateFigure(Math.min(activeFigure, figures.length - 1));
}
function pushHistory() {
  const s = snapshot();
  if (history.stack[history.index] === s) return;
  history.stack = history.stack.slice(0, history.index + 1);
  history.stack.push(s);
  if (history.stack.length > 200) history.stack.shift();
  history.index = history.stack.length - 1;
  updateUndoButtons();
  state.previewDirty = true;
}
function undo() {
  if (history.index <= 0) return;
  history.index--;
  restoreSnapshot(history.stack[history.index]);
  afterPoseChange(false);
  updateUndoButtons();
}
function redo() {
  if (history.index >= history.stack.length - 1) return;
  history.index++;
  restoreSnapshot(history.stack[history.index]);
  afterPoseChange(false);
  updateUndoButtons();
}
function updateUndoButtons() {
  $('#btn-undo').disabled = history.index <= 0;
  $('#btn-redo').disabled = history.index >= history.stack.length - 1;
}

function afterPoseChange(push = true) {
  if (state.autoGround) mannequin.snapToGround();
  if (!gizmo.dragging) placeHandle();
  syncSliders();
  state.dirty = true;
  state.previewDirty = true;
  if (push) pushHistory();
  saveSettings();
}

// ---------------- Pose tween ----------------
function animateToPose(pose, duration = 420) {
  const from = {};
  const to = {};
  const tmp = new THREE.Object3D();
  tmp.rotation.order = 'ZXY';
  for (const n of BONE_NAMES) {
    from[n] = mannequin.bones[n].quaternion.clone();
    const v = (pose.bones && pose.bones[n]) || [0, 0, 0];
    tmp.rotation.order = mannequin.bones[n].rotation.order;
    tmp.rotation.set(v[0] * D2R, (v[1] || 0) * D2R, (v[2] || 0) * D2R);
    to[n] = tmp.quaternion.clone();
  }
  const rootFrom = mannequin.bones.root.position.clone();
  // compute the target ground height
  const saved = mannequin.getPose();
  mannequin.setPose(pose);
  if (state.autoGround) mannequin.snapToGround();
  const rootTo = mannequin.bones.root.position.clone();
  mannequin.setPose(saved);
  state.tween = { from, to, rootFrom, rootTo, t0: performance.now(), duration, pose };
}
function stepTween(now) {
  const tw = state.tween;
  if (!tw) return;
  let t = Math.min(1, (now - tw.t0) / tw.duration);
  const e = 1 - Math.pow(1 - t, 3);
  for (const n of BONE_NAMES) mannequin.bones[n].quaternion.slerpQuaternions(tw.from[n], tw.to[n], e);
  mannequin.bones.root.position.lerpVectors(tw.rootFrom, tw.rootTo, e);
  mannequin.group.updateMatrixWorld(true);
  if (state.autoGround) mannequin.snapToGround();
  state.dirty = true;
  if (t >= 1) {
    state.tween = null;
    mannequin.setPose(tw.pose);
    afterPoseChange(true);
  }
}

// ---------------- Selection ----------------
const boneSelect = $('#bone-select');
boneSelect.innerHTML = '<option value="">— 未选择 —</option>' +
  BONE_NAMES.map((n) => `<option value="${n}">${BONE_DEFS[n].label}</option>`).join('');

function selectBone(name, partId = null) {
  state.selected = name || null;
  boneSelect.value = name || '';
  if (name) {
    const part = partId != null ? mannequin.parts.find((p) => p.userData.id === partId)
      : mannequin.parts.find((p) => p.userData.bone === name);
    art.selId = part ? part.userData.id : -1;
    $('#hud-selection').classList.add('selected');
    $('#hud-sel-name').textContent = `已选择：${BONE_DEFS[name].label}`;
  } else {
    art.selId = -1;
    $('#hud-selection').classList.remove('selected');
    $('#hud-sel-name').textContent = '点击人偶身体部位以选择关节';
  }
  updateGizmoMode();
  syncSliders();
  state.dirty = true;
}
boneSelect.addEventListener('change', () => selectBone(boneSelect.value));

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
function pick(ev) {
  const rect = canvas.getBoundingClientRect();
  ndc.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects(figures.flatMap(m => m.parts.filter(p => p.visible)), false);
  return hits.length ? hits[0].object : null;
}
let downPos = null;
canvas.addEventListener('pointerdown', (e) => { downPos = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener('pointerup', (e) => {
  if (!downPos || gizmo.dragging) { downPos = null; return; }
  const moved = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y);
  downPos = null;
  if (moved > 4 || e.button !== 0) return;
  if (gizmo.axis) return; // clicked on the gizmo
  const hit = pick(e);
  if (hit) { activateFigure(figures.findIndex(m => m.parts.includes(hit))); selectBone(hit.userData.bone, hit.userData.id); }
  else selectBone(null);
});
canvas.addEventListener('pointermove', (e) => {
  if (e.buttons) return;
  const hit = pick(e);
  const id = hit ? hit.userData.id : -1;
  if (id !== art.hoverId) { art.hoverId = id; state.dirty = true; canvas.style.cursor = hit ? 'pointer' : 'default'; }
});
canvas.addEventListener('pointerleave', () => { art.hoverId = -1; state.dirty = true; });

gizmo.addEventListener('dragging-changed', (e) => {
  controls.enabled = !e.value;
  if (e.value) {
    dragStart.handle.copy(handle.position);
    dragStart.root.copy(mannequin.bones.root.position);
  } else {
    afterPoseChange(true);
    if (gizmo.mode === 'translate') placeHandle();
  }
});
gizmo.addEventListener('objectChange', () => {
  const sel = state.selected;
  if (!sel) return;
  if (gizmo.mode === 'rotate') {
    if (state.limits) mannequin.clampBone(sel);
    mannequin.group.updateMatrixWorld(true);
    if (state.autoGround) mannequin.snapToGround();
  } else if (IK_CHAINS[sel]) {
    mannequin.solveIK(sel, handle.position, { limits: state.limits });
  } else {
    mannequin.bones.root.position.copy(dragStart.root).add(handle.position).sub(dragStart.handle);
    mannequin.group.updateMatrixWorld(true);
  }
  syncSliders();
  state.dirty = true;
});
gizmo.addEventListener('change', () => { state.dirty = true; });
controls.addEventListener('change', () => { state.dirty = true; });

function updateGizmoMode() {
  const mode = $('#gizmo-mode .seg.active').dataset.mode;
  const sel = state.selected;
  gizmo.setMode(mode);
  gizmo.setSpace(mode === 'translate' ? 'world' : 'local');
  gizmo.showY = !(mode === 'translate' && state.autoGround && !IK_CHAINS[sel]);
  if (!sel) gizmo.detach();
  else if (mode === 'translate') { placeHandle(); gizmo.attach(handle); }
  else gizmo.attach(mannequin.bones[sel]);
}
$$('#gizmo-mode .seg').forEach((b) => b.addEventListener('click', () => setGizmoMode(b.dataset.mode)));
function setGizmoMode(mode) {
  $$('#gizmo-mode .seg').forEach((x) => x.classList.toggle('active', x.dataset.mode === mode));
  updateGizmoMode();
  state.dirty = true;
}

// ---------------- Joint sliders ----------------
const rotInputs = ['x', 'y', 'z'].map((a) => ({ a, input: $(`#rot-${a}`), out: $(`#rot-${a}-val`) }));
function setRangeFill(input) {
  const p = ((input.value - input.min) / (input.max - input.min)) * 100;
  input.style.setProperty('--p', p + '%');
}
function syncSliders() {
  const name = state.selected;
  $('#joint-sliders').classList.toggle('disabled', !name);
  if (!name) return;
  const def = BONE_DEFS[name];
  const r = mannequin.bones[name].rotation;
  rotInputs.forEach(({ a, input, out }, i) => {
    const lim = state.limits ? def.limits[i] : [-180, 180];
    input.min = lim[0]; input.max = lim[1];
    input.disabled = lim[0] === lim[1];
    const deg = r[a] / D2R;
    input.value = deg;
    out.textContent = `${Math.round(deg)}°`;
    setRangeFill(input);
  });
}
rotInputs.forEach(({ a, input, out }) => {
  input.addEventListener('input', () => {
    if (!state.selected) return;
    mannequin.bones[state.selected].rotation[a] = input.value * D2R;
    out.textContent = `${Math.round(input.value)}°`;
    setRangeFill(input);
    mannequin.group.updateMatrixWorld(true);
    if (state.autoGround) mannequin.snapToGround();
    state.dirty = true;
  });
  input.addEventListener('change', () => afterPoseChange(true));
});
$('#btn-joint-reset').addEventListener('click', () => {
  if (!state.selected) return;
  mannequin.bones[state.selected].rotation.set(0, 0, 0);
  afterPoseChange(true);
});

// ---------------- Toolbar ----------------
$('#btn-undo').addEventListener('click', undo);
$('#btn-redo').addEventListener('click', redo);
$('#btn-reset').addEventListener('click', () => animateToPose(PRESETS[0].pose));
$('#btn-mirror').addEventListener('click', () => {
  const saved = mannequin.getPose();
  mannequin.mirrorPose();
  const target = mannequin.getPose();
  mannequin.setPose(saved);
  animateToPose(target, 380);
});
$('#btn-random').addEventListener('click', () => {
  const saved = mannequin.getPose();
  mannequin.randomPose(0.5);
  const target = mannequin.getPose();
  mannequin.setPose(saved);
  animateToPose(target, 500);
});
$('#btn-ground').addEventListener('click', (e) => {
  state.autoGround = !state.autoGround;
  e.currentTarget.classList.toggle('active', state.autoGround);
  if (state.autoGround) afterPoseChange(true);
  updateGizmoMode();
});
$('#btn-limits').addEventListener('click', (e) => {
  state.limits = !state.limits;
  e.currentTarget.classList.toggle('active', state.limits);
  syncSliders();
});

// ---------------- Camera views ----------------
function figureCenter() {
  const box = new THREE.Box3();
  for (const figure of figures) for (const m of figure.parts) box.expandByObject(m);
  return box.getCenter(new THREE.Vector3());
}
function setView(view) {
  const c = figureCenter();
  const bounds = new THREE.Box3();
  figures.forEach(m => m.parts.forEach(part => bounds.expandByObject(part)));
  const radius = bounds.getBoundingSphere(new THREE.Sphere()).radius;
  const halfFov = Math.min(camera.fov * D2R / 2, Math.atan(Math.tan(camera.fov * D2R / 2) * camera.aspect));
  const dist = Math.max(3.2, radius / Math.sin(halfFov) * 1.08, camera.position.distanceTo(controls.target));
  const dirs = {
    front: [0, 0.05, 1], three: [0.72, 0.12, 0.72], side: [1, 0.05, 0],
    back: [0, 0.05, -1], top: [0, 1.6, 0.9], low: [0, -0.45, 1],
  };
  const d = new THREE.Vector3(...dirs[view]).normalize().multiplyScalar(dist);
  state.camTween = {
    fromPos: camera.position.clone(), fromTarget: controls.target.clone(),
    toPos: c.clone().add(d), toTarget: c, t0: performance.now(), duration: 500,
  };
  $$('#views .seg').forEach((x) => x.classList.toggle('active', x.dataset.view === view));
}
$$('#views .seg').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
controls.addEventListener('start', () => { if (!state.camTween) $$('#views .seg').forEach((x) => x.classList.remove('active')); });
function stepCamTween(now) {
  const tw = state.camTween;
  if (!tw) return;
  const t = Math.min(1, (now - tw.t0) / tw.duration);
  const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  // interpolate on a sphere around the target for nicer arcs
  const tgt = tw.fromTarget.clone().lerp(tw.toTarget, e);
  const a = tw.fromPos.clone().sub(tw.fromTarget);
  const b = tw.toPos.clone().sub(tw.toTarget);
  const len = THREE.MathUtils.lerp(a.length(), b.length(), e);
  const dir = a.normalize().lerp(b.normalize(), e);
  if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
  camera.position.copy(tgt).add(dir.normalize().multiplyScalar(len));
  controls.target.copy(tgt);
  controls.update();
  state.dirty = true;
  if (t >= 1) state.camTween = null;
}

// ---------------- Body shape ----------------
const SHAPES = {
  female: { bust: 1, hips: 1, waist: 1, shoulders: 1, muscle: 1, headSize: 1 },
  male: { bust: 0, hips: 0.82, waist: 1.25, shoulders: 1.2, muscle: 1.18, headSize: 0.95 },
  slim: { bust: 0.7, hips: 0.9, waist: 0.88, shoulders: 0.95, muscle: 0.85, headSize: 1 },
  curvy: { bust: 1.45, hips: 1.25, waist: 1.02, shoulders: 1, muscle: 1.12, headSize: 1 },
};
const shapeKeys = ['bust', 'hips', 'waist', 'shoulders', 'muscle', 'headSize'];
function applyShape(shape, updateInputs = true) {
  mannequin.setShape(shape);
  if (updateInputs) {
    for (const k of shapeKeys) {
      const el = $(`#shape-${k}`);
      el.value = mannequin.shape[k];
      el.nextElementSibling.textContent = Math.round(mannequin.shape[k] * 100) + '%';
      setRangeFill(el);
    }
  }
  if (state.autoGround) mannequin.snapToGround();
  state.dirty = true; state.previewDirty = true;
  scheduleThumbs();
  saveSettings();
}
for (const k of shapeKeys) {
  const el = $(`#shape-${k}`);
  el.addEventListener('change', () => pushHistory());
  el.addEventListener('input', () => {
    el.nextElementSibling.textContent = Math.round(el.value * 100) + '%';
    setRangeFill(el);
    applyShape({ [k]: parseFloat(el.value) }, false);
  });
}
$$('.chip[data-body]').forEach((c) => c.addEventListener('click', () => {
  if (['female', 'male'].includes(c.dataset.body)) { mannequin.gender = c.dataset.body; $('#figure-gender').value = mannequin.gender; }
  applyShape(SHAPES[c.dataset.body]); pushHistory();
}));
$('#btn-body-reset').addEventListener('click', () => { applyShape(SHAPES[mannequin.gender]); pushHistory(); });

// ---------------- Multiple figures ----------------
function syncFigureUI() {
  $('#figure-count').value = figures.length;
  const select = $('#figure-select');
  select.replaceChildren(...figures.map((m, i) => new Option(`人偶 ${i + 1}`, i)));
  select.value = activeFigure;
  $('#figure-gender').value = mannequin.gender;
  for (const k of shapeKeys) {
    const el = $(`#shape-${k}`); el.value = mannequin.shape[k];
    el.nextElementSibling.textContent = Math.round(mannequin.shape[k] * 100) + '%'; setRangeFill(el);
  }
}
function activateFigure(index) {
  if (index < 0 || index >= figures.length) return;
  state.tween = null; activeFigure = index; mannequin = figures[index];
  art.mannequin = mannequin; selectBone(null); syncFigureUI();
}
function setFigureCount(count, record = true) {
  count = Math.max(1, Math.min(5, Number(count)));
  state.tween = null; gizmo.detach();
  while (figures.length < count) {
    const m = new Mannequin(); m.gender = 'female'; m.setPose(PRESETS[0].pose); m.snapToGround();
    art.addFigure(m, figures.length * 100); figures.push(m);
  }
  while (figures.length > count) {
    const m = figures.pop(); art.scene.remove(m.group);
    m.group.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); });
  }
  figures.forEach((m, i) => { m.group.position.x = (i - (count - 1) / 2) * 0.85; });
  activateFigure(Math.min(activeFigure, count - 1));
  state.dirty = state.previewDirty = true;
  if (record) { pushHistory(); saveSettings(); setView('front'); }
}
$('#figure-count').addEventListener('change', e => setFigureCount(e.target.value));
$('#figure-select').addEventListener('change', e => activateFigure(Number(e.target.value)));
$('#figure-gender').addEventListener('change', e => {
  mannequin.gender = e.target.value; applyShape(SHAPES[mannequin.gender]); pushHistory();
});
syncFigureUI();

// ---------------- Style ----------------
function bindRange(id, fmt, fn) {
  const el = $(id);
  const update = () => { el.nextElementSibling.textContent = fmt(parseFloat(el.value)); setRangeFill(el); };
  el.addEventListener('input', () => { fn(parseFloat(el.value)); update(); state.dirty = true; state.previewDirty = true; saveSettings(); });
  el._update = update;
  update();
  return el;
}
bindRange('#style-line', (v) => v.toFixed(1), (v) => { art.style.lineWidth = v; scheduleThumbs(); });
bindRange('#style-shade', (v) => Math.round(v * 100) + '%', (v) => { art.style.shade = v; scheduleThumbs(); });
bindRange('#cam-fov', (v) => v + '°', (v) => {
  // keep the framing roughly constant while changing perspective
  const oldF = Math.tan((camera.fov * D2R) / 2);
  const newF = Math.tan((v * D2R) / 2);
  const off = camera.position.clone().sub(controls.target).multiplyScalar(oldF / newF);
  camera.position.copy(controls.target).add(off);
  camera.fov = v; camera.updateProjectionMatrix();
  controls.maxDistance = 14 * (oldF / newF) * (controls.maxDistance / 14);
  controls.update();
});
$('#style-line-color').addEventListener('input', (e) => { art.style.lineColor = e.target.value; state.dirty = state.previewDirty = true; scheduleThumbs(); saveSettings(); });
$('#style-fill-color').addEventListener('input', (e) => { art.style.fillColor = e.target.value; state.dirty = state.previewDirty = true; scheduleThumbs(); saveSettings(); });
$('#style-bg-color').addEventListener('input', (e) => {
  art.style.bgColor = e.target.value; viewport.style.background = e.target.value;
  state.dirty = state.previewDirty = true; scheduleThumbs(); saveSettings();
});
$('#style-toon').addEventListener('change', (e) => { art.style.toon = e.target.checked; state.dirty = state.previewDirty = true; scheduleThumbs(); saveSettings(); });
$('#style-gender').addEventListener('change', e => { art.style.genderColor = e.target.checked; state.dirty = state.previewDirty = true; scheduleThumbs(); saveSettings(); });
$('#style-grid').addEventListener('change', (e) => { grid.visible = e.target.checked; state.dirty = true; saveSettings(); });

// ---------------- Export ----------------
function parseSize() {
  const v = $('#exp-size').value;
  if (v.includes('x')) { const [w, h] = v.split('x').map(Number); return { w, h }; }
  return { w: Number(v), h: Number(v) };
}
function composeExport(width, height, { forPreview = false } = {}) {
  const transparent = $('#exp-transparent').checked;
  const cnv = art.renderImage(camera, {
    width, height,
    padding: parseFloat($('#exp-pad').value),
    transparent,
  });
  const ctx = cnv.getContext('2d');
  const S = Math.min(width, height);
  if ($('#exp-border').checked) {
    ctx.strokeStyle = '#d7e1ee';
    ctx.lineWidth = Math.max(2, S * 0.004);
    const o = ctx.lineWidth / 2;
    ctx.strokeRect(o, o, width - ctx.lineWidth, height - ctx.lineWidth);
  }
  if ($('#exp-badge').checked) {
    const n = String($('#exp-number').value || 1);
    const r = S * 0.046;
    const cx = S * 0.035 + r, cy = S * 0.035 + r;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = '#4aa3ff'; ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = `700 ${Math.round(r * (n.length > 2 ? 0.85 : 1.1))}px Inter, "Noto Sans SC", sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(n, cx, cy + r * 0.05);
  }
  return cnv;
}
function updatePreview() {
  const { w, h } = parseSize();
  const k = 512 / Math.max(w, h);
  const pw = Math.round(w * k), ph = Math.round(h * k);
  const src = composeExport(pw, ph, { forPreview: true });
  const pv = $('#preview');
  pv.width = pw; pv.height = ph;
  pv.parentElement.style.aspectRatio = `${w} / ${h}`;
  pv.getContext('2d').drawImage(src, 0, 0);
  state.previewDirty = false;
}
async function doExport() {
  const { w, h } = parseSize();
  const cnv = composeExport(w, h);
  const dataURL = cnv.toDataURL('image/png');
  const num = $('#exp-number').value || 1;
  const name = `pose_${String(num).padStart(2, '0')}.png`;
  let ok = false;
  if (bridge) {
    const res = await bridge.saveImage(dataURL, name);
    ok = res.ok;
    if (ok) toast(`已导出：${res.filePath.split(/[\\/]/).pop()}`);
  } else {
    const a = document.createElement('a');
    a.href = dataURL; a.download = name; a.click();
    ok = true; toast(`已导出：${name}`);
  }
  if (ok && $('#exp-autoinc').checked) {
    $('#exp-number').value = Number(num) + 1;
    state.previewDirty = true;
  }
}
$('#btn-export').addEventListener('click', doExport);
$('#btn-export-top').addEventListener('click', doExport);
['#exp-size', '#exp-pad', '#exp-badge', '#exp-number', '#exp-border', '#exp-transparent'].forEach((id) =>
  $(id).addEventListener('input', () => { state.previewDirty = true; saveSettings(); }));
setRangeFill($('#exp-pad'));
$('#exp-pad').addEventListener('input', (e) => setRangeFill(e.target));

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

// ---------------- Pose library ----------------
function makeThumb(pose) {
  const saved = mannequin.getPose();
  const visibility = figures.map(m => m.group.visible);
  figures.forEach(m => { m.group.visible = m === mannequin; });
  mannequin.setPose(pose);
  mannequin.snapToGround();
  // thumbnails always use a 3/4-ish front camera
  const cam = new THREE.PerspectiveCamera(28, 1, 0.05, 100);
  const c = figureCenter();
  cam.position.copy(c).add(new THREE.Vector3(0.9, 0.35, 3.6));
  cam.lookAt(c);
  cam.updateMatrixWorld();
  const cnv = art.renderImage(cam, { width: 220, height: 220, padding: 0.05, lineScale: 0.75 });
  mannequin.setPose(saved);
  figures.forEach((m, i) => { m.group.visible = visibility[i]; });
  return cnv.toDataURL('image/png');
}

function poseCard(label, pose, { index = null, thumb = null, onDelete = null, delay = 0 } = {}) {
  const card = document.createElement('div');
  card.className = 'pose-card' + (thumb ? '' : ' loading');
  card.style.animationDelay = `${delay}ms`;
  card.innerHTML = `<img alt="${label}" />${index != null ? `<span class="num">${index}</span>` : ''}<span class="label">${label}</span>`;
  const img = card.querySelector('img');
  if (thumb) img.src = thumb;
  card.addEventListener('click', (e) => {
    if (e.target.closest('.del')) return;
    animateToPose(pose);
  });
  if (onDelete) {
    const del = document.createElement('button');
    del.className = 'del'; del.textContent = '✕'; del.title = '删除';
    del.addEventListener('click', onDelete);
    card.appendChild(del);
  }
  card._setThumb = (src) => { img.src = src; card.classList.remove('loading'); };
  card._pose = pose;
  return card;
}

const presetGrid = $('#preset-grid');
const presetCards = PRESETS.map((p, i) => {
  const c = poseCard(p.name, p.pose, { index: i + 1, delay: i * 25 });
  presetGrid.appendChild(c);
  return c;
});

let thumbTimer = null;
function scheduleThumbs(delay = 500) {
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(renderThumbs, delay);
}
function renderThumbs() {
  // render progressively to keep the UI responsive
  const cards = [...presetCards, ...$$('#mine-grid .pose-card')];
  let i = 0;
  const step = () => {
    const end = Math.min(cards.length, i + 3);
    for (; i < end; i++) cards[i]._setThumb(makeThumb(cards[i]._pose));
    if (i < cards.length) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// my poses (localStorage)
const MINE_KEY = 'bodyfactory.poses';
function loadMine() { try { return JSON.parse(localStorage.getItem(MINE_KEY)) || []; } catch { return []; } }
function saveMine(list) { localStorage.setItem(MINE_KEY, JSON.stringify(list)); }
function renderMine() {
  const list = loadMine();
  const g = $('#mine-grid');
  g.innerHTML = '';
  list.forEach((item, i) => {
    const c = poseCard(item.name, item.pose, {
      thumb: makeThumb(item.pose), delay: i * 20,
      onDelete: () => { const l = loadMine(); l.splice(i, 1); saveMine(l); renderMine(); },
    });
    g.appendChild(c);
  });
  $('#mine-count').textContent = list.length;
  $('#mine-empty').classList.toggle('hidden', list.length > 0);
}
$('#btn-save-pose').addEventListener('click', () => {
  const list = loadMine();
  list.unshift({ name: `姿势 ${list.length + 1}`, pose: mannequin.getPose() });
  saveMine(list);
  renderMine();
  toast('已保存到「我的姿势」');
});
$$('.tab').forEach((t) => t.addEventListener('click', () => {
  $$('.tab').forEach((x) => x.classList.toggle('active', x === t));
  $('#tab-presets').classList.toggle('hidden', t.dataset.tab !== 'presets');
  $('#tab-mine').classList.toggle('hidden', t.dataset.tab !== 'mine');
}));

// JSON import/export
$('#btn-export-json').addEventListener('click', async () => {
  const data = JSON.stringify({ app: 'BodyFactory', version: 2, figures: JSON.parse(snapshot()), shape: mannequin.shape, pose: mannequin.getPose(), library: loadMine() }, null, 2);
  if (bridge) {
    const r = await bridge.saveJSON(data, 'bodyfactory_poses.json');
    if (r.ok) toast('姿势已导出');
  } else {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
    a.download = 'bodyfactory_poses.json'; a.click();
  }
});
function importJSON(text) {
  try {
    const obj = JSON.parse(text);
    if (obj.library) { saveMine([...obj.library, ...loadMine()]); renderMine(); }
    if (obj.figures?.length) { restoreSnapshot(JSON.stringify(obj.figures)); afterPoseChange(true); saveSettings(); }
    else if (obj.shape) applyShape(obj.shape);
    const pose = obj.pose || (obj.bones ? obj : null);
    if (pose && !obj.figures) animateToPose(pose);
    toast('导入成功');
  } catch (err) { toast('导入失败：文件格式不正确'); }
}
$('#btn-import').addEventListener('click', async () => {
  if (bridge) { const r = await bridge.openJSON(); if (r.ok) importJSON(r.data); }
  else $('#file-input').click();
});
$('#file-input').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (f) importJSON(await f.text()); e.target.value = '';
});

// ---------------- Settings persistence ----------------
const SET_KEY = 'bodyfactory.settings';
let settingsTimer;
function saveSettings() {
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => {
    localStorage.setItem(SET_KEY, JSON.stringify({
      style: art.style, shape: mannequin.shape, figures: JSON.parse(snapshot()), grid: grid.visible,
      exp: {
        size: $('#exp-size').value, pad: $('#exp-pad').value, badge: $('#exp-badge').checked,
        number: $('#exp-number').value, autoinc: $('#exp-autoinc').checked,
        border: $('#exp-border').checked, transparent: $('#exp-transparent').checked,
      },
    }));
  }, 300);
}
function loadSettings() {
  let s; try { s = JSON.parse(localStorage.getItem(SET_KEY)); } catch { s = null; }
  if (!s) return;
  if (s.style) {
    Object.assign(art.style, s.style);
    $('#style-line').value = art.style.lineWidth; $('#style-line')._update();
    $('#style-shade').value = art.style.shade; $('#style-shade')._update();
    $('#style-line-color').value = art.style.lineColor;
    $('#style-fill-color').value = art.style.fillColor;
    $('#style-bg-color').value = art.style.bgColor;
    viewport.style.background = art.style.bgColor;
    $('#style-toon').checked = !!art.style.toon;
    $('#style-gender').checked = !!art.style.genderColor;
  }
  if (s.figures?.length) restoreSnapshot(JSON.stringify(s.figures));
  else if (s.shape) mannequin.setShape(s.shape);
  if (s.grid === false) { grid.visible = false; $('#style-grid').checked = false; }
  if (s.exp) {
    $('#exp-size').value = s.exp.size; $('#exp-pad').value = s.exp.pad; setRangeFill($('#exp-pad'));
    $('#exp-badge').checked = s.exp.badge; $('#exp-number').value = s.exp.number;
    $('#exp-autoinc').checked = s.exp.autoinc; $('#exp-border').checked = s.exp.border;
    $('#exp-transparent').checked = s.exp.transparent;
  }
}

// ---------------- Keyboard ----------------
window.addEventListener('keydown', (e) => {
  if (document.body.dataset.workspace !== 'pose') return;
  if (e.target.matches('input, textarea, select') || e.target.isContentEditable || document.querySelector('dialog[open]')) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
  else if (mod && e.key.toLowerCase() === 'e') { e.preventDefault(); doExport(); }
  else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); $('#btn-save-pose').click(); }
  else if (mod) return;
  else if (e.key === 'Escape') selectBone(null);
  else if (e.key === 'r' || e.key === 'R') setGizmoMode('rotate');
  else if (e.key === 't' || e.key === 'T') setGizmoMode('translate');
  else if (e.key === 'm' || e.key === 'M') $('#btn-mirror').click();
  else if (e.key === '1') setView('front');
  else if (e.key === '2') setView('three');
  else if (e.key === '3') setView('side');
  else if (e.key === '4') setView('back');
});

// ---------------- Render loop ----------------
let lastPreview = 0;
function frame(now) {
  requestAnimationFrame(frame);
  stepTween(now);
  stepCamTween(now);
  if (controls.update()) state.dirty = true;
  if (state.dirty && document.body.dataset.workspace === 'pose') {
    renderer.setRenderTarget(null);
    art.render(camera, null, { pixelScale: renderer.getPixelRatio() });
    renderer.render(overlay, camera);
    state.dirty = false;
  }
  if (state.previewDirty && !state.tween && !gizmo.dragging && now - lastPreview > 250) {
    lastPreview = now;
    updatePreview();
    $('#studio-pose-preview').src = $('#preview').toDataURL('image/png');
    $('#studio-pose-count').textContent = `${figures.length} 个人偶` ;
  }
}

// ---------------- Boot ----------------
loadSettings();
applyShape(mannequin.shape);
if (!localStorage.getItem(SET_KEY)) mannequin.setPose(PRESETS[0].pose);
mannequin.snapToGround();
pushHistory();
syncSliders();
renderMine();
scheduleThumbs(50);
setView('front');
requestAnimationFrame(frame);
window.__bf = { get mannequin() { return mannequin; }, figures, setFigureCount, activateFigure, snapshot, openPoseEditor, returnToStudio, art, camera, controls, animateToPose, PRESETS, setView, selectBone };

import { setupAI } from './ai.js';
setupAI({
  poseImage: () => {
    const { w, h } = parseSize(), padding = Number($('#exp-pad').value);
    const image = art.renderImage(camera, { width: w, height: h, padding });
    const projection = camera.clone(); art.frameCamera(projection, padding, w / h);
    const ctx = image.getContext('2d'), radius = Math.min(w, h) * 0.018;
    figures.forEach((m, i) => {
      const point = m.bones.head.getWorldPosition(new THREE.Vector3()).project(projection);
      const x = (point.x + 1) / 2 * w, y = (1 - point.y) / 2 * h;
      ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fillStyle = '#4aa3ff'; ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = `bold ${radius * 1.4}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(i + 1), x, y);
    });
    return image.toDataURL('image/png');
  },
  characters: () => figures.map((m, i) => ({ id: i + 1, gender: m.gender, shape: m.shape, pose: m.getPose() })),
  toast,
});
