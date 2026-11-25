// 화면: 사진 열기, 보기(확대/이동), 지우기/되살리기 붓, 배경, 저장.
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const TEST = new URLSearchParams(location.search).has('test');
// 아이폰/아이패드 사파리는 캔버스 한 장이 약 1,670만 화소까지만 된다
const IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const MAX_PX = IOS ? 16e6 : 50e6;

const worker = new Worker(new URL('./worker.js?v=2', import.meta.url), { type: 'module' });

const S = {
  caps: null, cached: false, mb: 0, ep: '',
  file: null, name: '', job: 0,
  img: null,            // { W, H, bitmap, out, orig, imgData, full, fctx }
  view: { s: 1, x: 0, y: 0, fit: 1, atFit: true },
  tool: 'move', brush: 60, bg: 'none', peek: false, space: false,
  busy: false, saving: false, cursor: null,
  undo: [], undoBytes: 0,
};

const view = $('#view');
const vctx = view.getContext('2d');
const checker = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 16;
  const x = c.getContext('2d');
  x.fillStyle = '#ffffff'; x.fillRect(0, 0, 16, 16);
  x.fillStyle = '#e4e4e7'; x.fillRect(0, 0, 8, 8); x.fillRect(8, 8, 8, 8);
  return vctx.createPattern(c, 'repeat');
})();

// ---------- 워커 ----------
let nextId = 1;
const waiters = new Map();
function call(msg, transfer) {
  const id = nextId++;
  msg.id = id;
  return new Promise((res, rej) => { waiters.set(id, { res, rej }); worker.postMessage(msg, transfer || []); });
}
let resultHook = null;

worker.onmessage = (e) => {
  const m = e.data;
  switch (m.type) {
    case 'caps': onCaps(m); break;
    case 'model':
      S.cached = true; S.ep = m.ep;
      break;
    case 'progress': if (m.id === S.job) onProgress(m); break;
    case 'warn': console.warn('[nukki worker]', m.message); (window.__nkWarn = window.__nkWarn || []).push(m.message); break;
    case 'result': if (m.id === S.job) onResult(m); break;
    case 'encoded': case 'opts': {
      const w = waiters.get(m.id); if (w) { waiters.delete(m.id); w.res(m.blob); } break;
    }
    case 'error': {
      const w = waiters.get(m.id);
      if (w) { waiters.delete(m.id); w.rej(new Error(m.message)); }
      else if (m.id === S.job) showError(m.message);
      break;
    }
  }
};
worker.onerror = (e) => { console.error(e); if (S.busy) showError('처리 도구를 불러오지 못했어요'); };
worker.postMessage({ type: 'caps' });

function onCaps(m) {
  S.caps = m.caps; S.cached = m.cached; S.mb = m.mb;
}
$('#newPhoto').onclick = () => $('#file').click();

// ---------- 사진 열기 ----------
async function openFile(file) {
  if (!file) return;
  if (file.type && !file.type.startsWith('image/')) { toast('사진 파일만 열 수 있어요'); return; }
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    toast(/heic|heif/i.test(file.type + file.name) ? 'HEIC는 이 브라우저에서 열 수 없어요. JPG로 바꿔서 올려 주세요' : '이 사진은 열 수 없어요');
    return;
  }
  closeImage();
  S.file = file;
  S.name = (file.name || 'image').replace(/\.[^.]+$/, '') || 'image';
  S.img = { W: bmp.width, H: bmp.height, bitmap: bmp };
  $('#home').hidden = true; $('#work').hidden = false; $('#back').hidden = false; $('#newPhoto').hidden = false;
  $('#zoom').hidden = false;
  $('#fileinfo').textContent = `${S.name}  ${bmp.width} × ${bmp.height}`;
  fitView(); draw();
  process();
}

function closeImage() {
  if (S.img && S.img.bitmap) S.img.bitmap.close();
  if (S.img && S.img.full) S.img.full.width = 0;
  S.img = null; S.job = 0; S.undo = []; S.undoBytes = 0; stroke = null; dirty = null;
  updateUndo();
}

function goHome() {
  closeImage(); S.file = null; S.busy = false;
  $('#home').hidden = false; $('#work').hidden = true; $('#back').hidden = true; $('#newPhoto').hidden = true;
  $('#tools').hidden = true; $('#busy').hidden = true; $('#zoom').hidden = true;
  $('#fileinfo').textContent = '';
  $('#file').value = '';
}
$('#back').onclick = goHome;

function process() {
  S.job = nextId++;
  S.busy = true;
  if (S.img.full) { S.img.full.width = 0; S.img.full = null; S.img.out = null; }
  S.undo = []; S.undoBytes = 0; updateUndo();
  $('#tools').hidden = true;
  setBusy('사진 여는 중', null);
  worker.postMessage({ type: 'run', id: S.job, file: S.file, maxPx: MAX_PX });
  draw();
}

const STAGES = { decode: '사진 여는 중', open: '모델 준비 중', infer: '배경 찾는 중', refine: '가장자리 다듬는 중' };
function onProgress(m) {
  if (m.stage === 'download') {
    const mb = (v) => Math.round(v / 1e6);
    setBusy(`모델 받는 중  ${mb(m.got)} / ${mb(m.total)}MB`, m.got / m.total);
  } else setBusy(STAGES[m.stage] || '처리 중', null);
}

function setBusy(text, frac) {
  $('#busy').hidden = false;
  $('.busy-card').classList.remove('err');
  $('#retry').hidden = true;
  $('#busytext').textContent = text;
  const bar = $('.bar');
  bar.hidden = false;
  bar.classList.toggle('indet', frac == null);
  $('#busybar').style.width = frac == null ? '' : (frac * 100).toFixed(1) + '%';
}

function showError(msg) {
  S.busy = true;
  $('#busy').hidden = false;
  $('.busy-card').classList.add('err');
  $('#busytext').textContent = msg || '처리하지 못했어요';
  $('.bar').hidden = true;
  $('#retry').hidden = false;
  draw();
}
$('#retry').onclick = () => S.file && process();

function onResult(m) {
  const I = S.img;
  const { W, H } = m;
  const out = new Uint8ClampedArray(m.out);
  const full = document.createElement('canvas');
  full.width = W; full.height = H;
  const fctx = full.getContext('2d');
  const imgData = new ImageData(out, W, H);
  fctx.putImageData(imgData, 0, 0);
  const resized = W !== I.W || H !== I.H;
  Object.assign(I, { W, H, out, orig: new Uint8ClampedArray(m.orig), imgData, full, fctx });
  S.busy = false;
  $('#busy').hidden = true; $('#tools').hidden = false;
  $('#fileinfo').textContent = `${S.name}  ${W} × ${H}`;
  if (m.scaled) toast(`사진이 너무 커서 ${Math.round(MAX_PX / 1e6)}00만 화소로 줄여서 처리했어요`);
  if (resized || S.view.atFit) fitView();
  if (TEST) console.log('[nukki]', JSON.stringify({ ms: m.ms, model: m.model, ep: m.ep, W, H }));
  if (resultHook) { const h = resultHook; resultHook = null; h(m); }
  draw();
}

// ---------- 보기 ----------
let raf = 0;
function requestDraw() {
  if (!raf) raf = requestAnimationFrame(() => { raf = 0; flushDirty(); draw(); });
}

function sizeCanvas() {
  const dpr = devicePixelRatio || 1;
  const w = Math.round(view.clientWidth * dpr), h = Math.round(view.clientHeight * dpr);
  if (view.width !== w || view.height !== h) { view.width = w; view.height = h; }
  return dpr;
}

function draw() {
  const dpr = sizeCanvas();
  vctx.setTransform(1, 0, 0, 1, 0, 0);
  vctx.clearRect(0, 0, view.width, view.height);
  const I = S.img;
  if (!I) return;
  vctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const { s, x, y } = S.view, w = I.W * s, h = I.H * s;
  vctx.imageSmoothingEnabled = s * dpr < 2.5;
  vctx.imageSmoothingQuality = 'high';
  if (S.peek || !I.full) {
    vctx.drawImage(I.bitmap, x, y, w, h);
  } else {
    vctx.fillStyle = S.bg === 'none' ? checker : S.bg;
    vctx.fillRect(x, y, w, h);
    vctx.drawImage(I.full, x, y, w, h);
  }
  if (S.busy) { vctx.fillStyle = 'rgba(243,243,241,.5)'; vctx.fillRect(x, y, w, h); }
  if (S.cursor && isBrush() && !S.busy && !S.space) {
    vctx.beginPath();
    vctx.arc(S.cursor.x, S.cursor.y, Math.max(1, S.brush / 2), 0, Math.PI * 2);
    vctx.lineWidth = 3; vctx.strokeStyle = 'rgba(0,0,0,.45)'; vctx.stroke();
    vctx.lineWidth = 1.25; vctx.strokeStyle = '#fff'; vctx.stroke();
  }
}

function fitView() {
  const I = S.img; if (!I) return;
  const cw = view.clientWidth, ch = view.clientHeight;
  const narrow = cw < 720;
  const top = 52, bottom = narrow ? 128 : 84;
  const aw = Math.max(50, cw - 32), ah = Math.max(50, ch - top - bottom);
  const s = Math.min(aw / I.W, ah / I.H, 2);
  S.view = { s, fit: s, x: (cw - I.W * s) / 2, y: top + (ah - I.H * s) / 2, atFit: true };
  zoomLabel();
}

function zoomAt(f, px, py) {
  const v = S.view;
  const ns = Math.min(32, Math.max(v.fit * 0.5, v.s * f));
  const k = ns / v.s;
  v.x = px - (px - v.x) * k; v.y = py - (py - v.y) * k; v.s = ns; v.atFit = false;
  zoomLabel(); requestDraw();
}
function zoomLabel() { $('#zoomFit').textContent = Math.round(S.view.s * 100) + '%'; }
$('#zoomIn').onclick = () => zoomAt(1.4, view.clientWidth / 2, view.clientHeight / 2);
$('#zoomOut').onclick = () => zoomAt(1 / 1.4, view.clientWidth / 2, view.clientHeight / 2);
$('#zoomFit').onclick = () => {
  if (S.view.atFit) zoomAt(1 / S.view.s, view.clientWidth / 2, view.clientHeight / 2);
  else { fitView(); requestDraw(); }
};
addEventListener('resize', () => { if (S.view.atFit) fitView(); requestDraw(); });

view.addEventListener('wheel', (e) => {
  if (!S.img) return;
  e.preventDefault();
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
  const dx = e.deltaX * unit, dy = e.deltaY * unit;
  const mouseWheel = !e.ctrlKey && dx === 0 && Math.abs(dy) >= 40 && Number.isInteger(dy);
  if (e.ctrlKey || mouseWheel) zoomAt(Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015)), e.offsetX, e.offsetY);
  else { S.view.x -= dx; S.view.y -= dy; S.view.atFit = false; requestDraw(); }
}, { passive: false });

// ---------- 도구 ----------
const isBrush = () => S.tool === 'erase' || S.tool === 'restore';
function setTool(t) {
  S.tool = t;
  $$('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
  $('#sizeBox').hidden = !isBrush();
  view.className = isBrush() ? 'brush' : 'move';
  requestDraw();
}
$$('[data-tool]').forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));
setTool('move');

$('#size').addEventListener('input', (e) => {
  S.brush = +e.target.value;
  S.cursor = { x: view.clientWidth / 2, y: view.clientHeight / 2 };
  requestDraw();
});

$$('#bgs .sw[data-bg]').forEach((b) => (b.onclick = () => setBg(b.dataset.bg, b)));
$('#bgcolor').addEventListener('input', (e) => {
  const lab = e.target.parentElement;
  lab.style.background = e.target.value;
  setBg(e.target.value, lab);
});
$('#bgcolor').addEventListener('click', (e) => setBg(e.target.value, e.target.parentElement));
function setBg(bg, el) {
  S.bg = bg;
  $$('#bgs .sw').forEach((s) => s.classList.toggle('on', s === el));
  $('#fmt').textContent = bg === 'none' ? 'PNG' : 'JPG';
  requestDraw();
}

const peek = $('#peek');
peek.addEventListener('pointerdown', (e) => { e.preventDefault(); S.peek = true; peek.classList.add('on'); requestDraw(); });
['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) =>
  peek.addEventListener(ev, () => { if (!S.peek) return; S.peek = false; peek.classList.remove('on'); requestDraw(); }));

// ---------- 붓 ----------
const TILE = 128, HARD = 0.5, UNDO_MAX = 400e6;
let stroke = null, dirty = null;

function tileFor(tx, ty) {
  const key = ty * 65536 + tx;
  let t = stroke.tiles.get(key);
  if (!t) {
    const I = S.img, x = tx * TILE, y = ty * TILE;
    const w = Math.min(TILE, I.W - x), h = Math.min(TILE, I.H - y);
    const snap = new Uint8ClampedArray(w * h * 4);
    for (let r = 0; r < h; r++) { const g = ((y + r) * I.W + x) * 4; snap.set(I.out.subarray(g, g + w * 4), r * w * 4); }
    t = { x, y, w, h, snap, wt: new Float32Array(w * h) };
    stroke.tiles.set(key, t);
  }
  return t;
}

function stampAt(cx, cy, R) {
  const I = S.img, W = I.W, out = I.out, orig = I.orig;
  const x0 = Math.max(0, Math.floor(cx - R)), x1 = Math.min(W - 1, Math.ceil(cx + R));
  const y0 = Math.max(0, Math.floor(cy - R)), y1 = Math.min(I.H - 1, Math.ceil(cy + R));
  if (x0 > x1 || y0 > y1) return;
  const inv = 1 / R, erase = stroke.mode === 'erase';
  for (let ty = Math.floor(y0 / TILE); ty <= Math.floor(y1 / TILE); ty++) {
    for (let tx = Math.floor(x0 / TILE); tx <= Math.floor(x1 / TILE); tx++) {
      const t = tileFor(tx, ty), snap = t.snap, wt = t.wt;
      const ax0 = Math.max(x0, t.x), ax1 = Math.min(x1, t.x + t.w - 1);
      const ay0 = Math.max(y0, t.y), ay1 = Math.min(y1, t.y + t.h - 1);
      for (let y = ay0; y <= ay1; y++) {
        const dy = (y + 0.5 - cy) * inv, dy2 = dy * dy;
        if (dy2 >= 1) continue;
        for (let x = ax0; x <= ax1; x++) {
          const dx = (x + 0.5 - cx) * inv, d2 = dx * dx + dy2;
          if (d2 >= 1) continue;
          const d = Math.sqrt(d2);
          let w = 1;
          if (d > HARD) { w = (1 - d) / (1 - HARD); w = w * w * (3 - 2 * w); }
          const li = (y - t.y) * t.w + (x - t.x);
          if (w <= wt[li]) continue;
          wt[li] = w;
          const si = li * 4, gi = (y * W + x) * 4, a0 = snap[si + 3] / 255;
          if (erase) {
            out[gi + 3] = snap[si + 3] * (1 - w);
          } else {
            const a = a0 + (1 - a0) * w, k0 = a0 * (1 - w) / a, k1 = w / a;
            out[gi] = snap[si] * k0 + orig[gi] * k1;
            out[gi + 1] = snap[si + 1] * k0 + orig[gi + 1] * k1;
            out[gi + 2] = snap[si + 2] * k0 + orig[gi + 2] * k1;
            out[gi + 3] = a * 255;
          }
        }
      }
    }
  }
  markDirty(x0, y0, x1, y1);
}

function toImage(sx, sy) { const v = S.view; return [(sx - v.x) / v.s, (sy - v.y) / v.s]; }

function strokeTo(sx, sy) {
  const [ix, iy] = toImage(sx, sy);
  const R = Math.max(0.5, S.brush / 2 / S.view.s);
  if (!stroke.last) { stampAt(ix, iy, R); stroke.last = [ix, iy]; return; }
  const [lx, ly] = stroke.last, dx = ix - lx, dy = iy - ly, dist = Math.hypot(dx, dy);
  const step = Math.max(0.5, R * 0.2);
  if (dist < step) return;
  const n = Math.floor(dist / step), ux = dx / dist * step, uy = dy / dist * step;
  for (let i = 1; i <= n; i++) stampAt(lx + ux * i, ly + uy * i, R);
  stroke.last = [lx + ux * n, ly + uy * n];
}

function markDirty(x0, y0, x1, y1) {
  if (!dirty) dirty = [x0, y0, x1, y1];
  else { dirty[0] = Math.min(dirty[0], x0); dirty[1] = Math.min(dirty[1], y0); dirty[2] = Math.max(dirty[2], x1); dirty[3] = Math.max(dirty[3], y1); }
  requestDraw();
}
function flushDirty() {
  if (!dirty || !S.img || !S.img.full) { dirty = null; return; }
  const [x0, y0, x1, y1] = dirty; dirty = null;
  S.img.fctx.putImageData(S.img.imgData, 0, 0, x0, y0, x1 - x0 + 1, y1 - y0 + 1);
}

function restoreTiles(list) {
  const I = S.img;
  for (const t of list) {
    for (let r = 0; r < t.h; r++) I.out.set(t.snap.subarray(r * t.w * 4, (r + 1) * t.w * 4), ((t.y + r) * I.W + t.x) * 4);
    markDirty(t.x, t.y, t.x + t.w - 1, t.y + t.h - 1);
  }
}

function endStroke(cancel) {
  if (!stroke) return;
  const tiles = [...stroke.tiles.values()];
  stroke = null;
  if (!tiles.length) return;
  if (cancel) { restoreTiles(tiles); return; }
  const entry = tiles.map(({ x, y, w, h, snap }) => ({ x, y, w, h, snap }));
  entry.bytes = entry.reduce((s, t) => s + t.snap.length, 0);
  S.undo.push(entry); S.undoBytes += entry.bytes;
  while (S.undoBytes > UNDO_MAX && S.undo.length > 1) S.undoBytes -= S.undo.shift().bytes;
  updateUndo();
}

function undo() {
  if (stroke || !S.img || !S.img.full) return;
  const e = S.undo.pop();
  if (!e) return;
  S.undoBytes -= e.bytes;
  restoreTiles(e);
  updateUndo();
}
function updateUndo() { $('#undo').disabled = !S.undo.length; }
$('#undo').onclick = undo;

// ---------- 포인터 ----------
const pts = new Map();
let gesture = null;

view.addEventListener('pointerdown', (e) => {
  if (!S.img) return;
  view.setPointerCapture(e.pointerId);
  pts.set(e.pointerId, [e.offsetX, e.offsetY]);
  if (pts.size === 2) {
    if (gesture && gesture.type === 'stroke') endStroke(true);
    const [a, b] = [...pts.values()];
    gesture = { type: 'pinch', d: Math.hypot(a[0] - b[0], a[1] - b[1]), c: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
    return;
  }
  if (pts.size > 2) return;
  const pan = e.button === 1 || e.button === 2 || S.space || !isBrush() || S.busy || !S.img.full;
  if (pan) {
    gesture = { type: 'pan', sx: e.offsetX, sy: e.offsetY, vx: S.view.x, vy: S.view.y };
    view.classList.add('panning');
  } else {
    gesture = { type: 'stroke' };
    stroke = { mode: S.tool, tiles: new Map(), last: null };
    strokeTo(e.offsetX, e.offsetY);
  }
});

view.addEventListener('pointermove', (e) => {
  S.cursor = e.pointerType === 'mouse' || e.pointerType === 'pen' ? { x: e.offsetX, y: e.offsetY } : null;
  if (pts.has(e.pointerId)) pts.set(e.pointerId, [e.offsetX, e.offsetY]);
  if (!gesture) { if (isBrush()) requestDraw(); return; }
  if (gesture.type === 'pan') {
    S.view.x = gesture.vx + e.offsetX - gesture.sx;
    S.view.y = gesture.vy + e.offsetY - gesture.sy;
    S.view.atFit = false;
  } else if (gesture.type === 'stroke' && stroke) {
    const list = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const c of (list.length ? list : [e])) strokeTo(c.offsetX, c.offsetY);
  } else if (gesture.type === 'pinch' && pts.size === 2) {
    const [a, b] = [...pts.values()];
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]), c = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    S.view.x += c[0] - gesture.c[0]; S.view.y += c[1] - gesture.c[1];
    zoomAt(d / gesture.d, c[0], c[1]);
    gesture.d = d; gesture.c = c;
  }
  requestDraw();
});

function pointerEnd(e) {
  if (!pts.has(e.pointerId)) return;
  pts.delete(e.pointerId);
  if (gesture && gesture.type === 'stroke') endStroke(false);
  if (pts.size === 0) { gesture = null; view.classList.remove('panning'); }
  else if (gesture && gesture.type === 'pinch') gesture = null;
}
view.addEventListener('pointerup', pointerEnd);
view.addEventListener('pointercancel', pointerEnd);
view.addEventListener('pointerleave', () => { S.cursor = null; requestDraw(); });
view.addEventListener('contextmenu', (e) => e.preventDefault());

// ---------- 키보드 ----------
addEventListener('keydown', (e) => {
  if (e.target.matches && e.target.matches('input:not([type=range])')) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); undo(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey || !S.img) return;
  if (e.key === ' ') { if (!S.space) { S.space = true; view.classList.add('move'); requestDraw(); } e.preventDefault(); }
  else if (k === 'v') setTool('move');
  else if (k === 'e') setTool('erase');
  else if (k === 'r') setTool('restore');
  else if (e.key === '[' || e.key === ']') {
    const v = Math.round(Math.min(300, Math.max(4, S.brush * (e.key === ']' ? 1.2 : 1 / 1.2))));
    S.brush = v; $('#size').value = v; requestDraw();
  }
});
addEventListener('keyup', (e) => {
  if (e.key === ' ') { S.space = false; view.className = isBrush() ? 'brush' : 'move'; requestDraw(); }
});

// ---------- 저장 ----------
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

async function save() {
  const I = S.img;
  if (!I || !I.full || S.saving) return;
  S.saving = true;
  const btn = $('#save'); btn.disabled = true;
  try {
    flushDirty();
    let blob, ext;
    if (S.bg === 'none') {
      const copy = I.out.slice();
      blob = await call({ type: 'encode', buffer: copy.buffer, W: I.W, H: I.H }, [copy.buffer]);
      ext = 'png';
    } else {
      const c = document.createElement('canvas'); c.width = I.W; c.height = I.H;
      const x = c.getContext('2d');
      x.fillStyle = S.bg; x.fillRect(0, 0, I.W, I.H); x.drawImage(I.full, 0, 0);
      blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.95));
      c.width = 0;
      ext = 'jpg';
    }
    if (!blob) throw new Error('blob');
    download(blob, `${S.name}-nukki.${ext}`);
  } catch (err) {
    console.error(err); toast('저장하지 못했어요');
  } finally {
    S.saving = false; btn.disabled = false;
  }
}
$('#save').onclick = save;

// ---------- 넣기: 고르기, 끌어 놓기, 붙여넣기 ----------
$('#file').addEventListener('change', (e) => openFile(e.target.files[0]));
let dragDepth = 0;
addEventListener('dragenter', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { dragDepth++; document.body.classList.add('dragging'); } });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
  const f = [...(e.dataTransfer?.files || [])].find((f) => f.type.startsWith('image/')) || e.dataTransfer?.files?.[0];
  if (f) openFile(f);
});
addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (!item) return;
  const f = item.getAsFile();
  if (f) openFile(new File([f], f.name && f.name !== 'image.png' ? f.name : 'paste.png', { type: f.type }));
});

// ---------- 알림 ----------
let toastTimer = 0;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3200);
}

// ---------- 시험용 ----------
if (TEST) {
  window.__nk = {
    S,
    async openUrl(url) {
      const b = await (await fetch(url)).blob();
      const name = url.split('/').pop().split('?')[0];
      const p = new Promise((r) => (resultHook = r));
      await openFile(new File([b], name, { type: b.type || 'image/jpeg' }));
      return p;
    },
    waitResult: () => new Promise((r) => (resultHook = r)),
    setOpts: (opts) => call({ type: 'opts', opts }),
    reprocess() { const p = new Promise((r) => (resultHook = r)); process(); return p; },
    stamp(mode, ix, iy, R) { stroke = { mode, tiles: new Map(), last: null }; stampAt(ix, iy, R); endStroke(false); flushDirty(); draw(); },
    undo, save, setTool, setBg: (bg) => setBg(bg, $(`#bgs [data-bg="${bg}"]`)), zoomAt, fitView, draw,
  };
  // 헤드리스 시험: ?test&auto=<사진 주소> → 결과를 서버 로그(/__log)로 보낸다
  const auto = new URLSearchParams(location.search).get('auto');
  if (auto) {
    const log = (o) => fetch('/__log?m=' + encodeURIComponent(JSON.stringify(o))).catch(() => {});
    log({ start: true, ua: navigator.userAgent.slice(-40) });
    window.__nk.openUrl(auto).then((m) => log({ ms: m.ms, ep: m.ep, W: m.W, H: m.H, warn: window.__nkWarn }))
      .catch((e) => log({ err: String(e) }));
    setInterval(() => log({ busy: $('#busytext').textContent, warn: window.__nkWarn }), 10000);
  }
}
