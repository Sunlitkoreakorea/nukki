// 모델 받기/캐시, 추론, 가장자리 다듬기, PNG 만들기를 화면과 따로 돌리는 워커.
import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/ort.webgpu.min.mjs';
import { refine } from './refine.js?v=1';
import { encodePNG } from './png.js?v=1';
import { patchDoubleToFloat } from './onnx-patch.js?v=1';

ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/';
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(8, navigator.hardwareConcurrency || 4) : 1;
ort.env.logLevel = 'error';

// BEN2 Base (MIT, PramaLLC) — 1024 입력, 출력은 이미 sigmoid를 거친 0~1 마스크.
// BiRefNet ONNX는 7×7 변형 합성곱이 411MB 버퍼를 만들어 노트북/폰 GPU 한도(256MB)를 넘어서 쓰지 않는다.
const MODELS = {
  ben2: {
    url: 'https://huggingface.co/PramaLLC/BEN2/resolve/e48a20765fb421d19dcdb0bf3cc61e802ca5ec8f/BEN2_Base.onnx',
    bytes: 222_932_053, norm: true, sigmoid: false, patch: 'double',
  },
};
const MODEL = 'ben2';
const CACHE = 'nukki-models-v1';
const SIZE = 1024;
const MAX_PX = 50e6;
const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];

let caps = null;
let session = null, sessionEp = null, loading = null;
const testOpts = {}; // dev 시험용 refine 옵션 덮어쓰기
const post = (m, t) => self.postMessage(m, t || []);

let capsP = null;
function detect() {
  // 동시에 불려도 GPU 확인은 한 번만, 끝난 값을 같이 기다린다
  return capsP || (capsP = (async () => {
    const c = { gpu: false, f16: false, adapter: '' };
    try {
      if (self.navigator.gpu) {
        const ad = await navigator.gpu.requestAdapter();
        if (ad) {
          c.gpu = true;
          c.f16 = ad.features.has('shader-f16');
          const info = ad.info || {};
          c.adapter = [info.vendor, info.architecture, info.description].filter(Boolean).join(' ');
        }
      }
    } catch { /* WebGPU 없음 */ }
    caps = c;
    return c;
  })());
}

async function isCached() {
  try { return !!(await (await caches.open(CACHE)).match(MODELS[MODEL].url)); } catch { return false; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 받다가 끊기면 받은 데까지 이어서(Range) 다시 받는다.
async function fetchModel(onProgress) {
  const { url, bytes } = MODELS[MODEL];
  let cache = null;
  try { cache = await caches.open(CACHE); } catch { /* 캐시 못 씀 */ }
  if (cache) {
    const hit = await cache.match(url);
    if (hit) return new Uint8Array(await hit.arrayBuffer());
  }
  let buf = null, got = 0, total = bytes, last = 0, fails = 0;
  for (;;) {
    try {
      const res = await fetch(url, got ? { headers: { Range: `bytes=${got}-` } } : undefined);
      if (got && res.status !== 206) got = 0; // 이어받기를 안 받아 주면 처음부터
      if (!res.ok) throw new Error('HTTP ' + res.status);
      if (!buf) {
        total = +res.headers.get('content-length') || bytes;
        buf = new Uint8Array(total);
      }
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (got + value.length > buf.length) {
          const bigger = new Uint8Array(Math.max(buf.length * 1.25, got + value.length) | 0);
          bigger.set(buf.subarray(0, got)); buf = bigger;
        }
        buf.set(value, got); got += value.length; fails = 0;
        const now = performance.now();
        if (now - last > 120) { last = now; onProgress(got, total); }
      }
      break;
    } catch (err) {
      post({ type: 'warn', message: 'download: ' + String((err && err.message) || err) + ' at ' + got });
      if (++fails > 5) throw new Error('모델을 받다가 연결이 끊겼어요. 다시 시도해 주세요');
      await sleep(800 * fails);
    }
  }
  if (got !== buf.length) buf = buf.slice(0, got);
  onProgress(got, got);
  if (cache) {
    try {
      await cache.put(url, new Response(buf, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(got) } }));
    } catch (err) {
      // 저장 공간이 모자라면 다음에 다시 받음
      post({ type: 'warn', message: 'cache put: ' + (err && err.name) + ' ' + (err && err.message) });
    }
  }
  return buf;
}

const loadMs = {};
async function loadBytes(id) {
  let t = performance.now();
  let bytes = await fetchModel((got, total) => post({ type: 'progress', id, stage: 'download', got, total }));
  loadMs.fetch = Math.round(performance.now() - t); t = performance.now();
  post({ type: 'progress', id, stage: 'open' });
  if (MODELS[MODEL].patch === 'double') bytes = patchDoubleToFloat(bytes).bytes;
  loadMs.patch = Math.round(performance.now() - t);
  return bytes;
}
async function createSession(bytes, ep) {
  const t = performance.now();
  const s = await ort.InferenceSession.create(bytes, { executionProviders: [ep], graphOptimizationLevel: 'all' });
  loadMs.create = Math.round(performance.now() - t);
  return s;
}

async function ensureSession(id, forceEp) {
  await detect();
  const want = forceEp || (caps.gpu ? 'webgpu' : 'wasm');
  if (session && sessionEp === want) return;
  if (loading) { await loading.catch(() => {}); if (session && sessionEp === want) return; }
  loading = (async () => {
    if (session) { try { await session.release(); } catch {} session = null; sessionEp = null; }
    // 받기 실패는 그대로 오류로 (GPU 문제로 오해해 CPU로 넘어가지 않게)
    const bytes = await loadBytes(id);
    try {
      session = await createSession(bytes, want); sessionEp = want;
    } catch (err) {
      if (want !== 'webgpu') throw err;
      console.warn('WebGPU 실패, CPU로 전환', err);
      post({ type: 'warn', message: 'session: ' + String((err && err.message) || err) });
      caps.gpu = false;
      session = await createSession(await loadBytes(id), 'wasm'); sessionEp = 'wasm';
    }
    post({ type: 'model', ep: sessionEp });
  })();
  try { await loading; } finally { loading = null; }
}

function fromHalf(h) {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
  if (e === 0) return s * m * 5.960464477539063e-8;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * Math.pow(2, e - 15);
}

function makeInput(low) {
  const n = SIZE * SIZE, data = new Float32Array(3 * n), norm = MODELS[MODEL].norm;
  for (let c = 0; c < 3; c++) {
    const m = norm ? MEAN[c] : 0, s = norm ? STD[c] : 1, off = c * n;
    for (let i = 0, j = c; i < n; i++, j += 4) data[off + i] = (low[j] / 255 - m) / s;
  }
  return new ort.Tensor('float32', data, [1, 3, SIZE, SIZE]);
}

function readMask(t) {
  const d = t.data, n = SIZE * SIZE, m = new Float32Array(n);
  const half = d instanceof Uint16Array, sig = MODELS[MODEL].sigmoid;
  for (let i = 0; i < n; i++) {
    let v = half ? fromHalf(d[i]) : Number(d[i]);
    if (sig) v = 1 / (1 + Math.exp(-v));
    m[i] = v < 0 ? 0 : v > 1 ? 1 : (v === v ? v : 0);
  }
  return m;
}

async function infer(low, id) {
  const input = makeInput(low);
  try {
    const out = await session.run({ [session.inputNames[0]]: input });
    return readMask(out[session.outputNames[0]]);
  } catch (err) {
    if (sessionEp !== 'webgpu') throw err;
    console.warn('GPU 추론 실패, CPU로 다시', err);
    post({ type: 'warn', message: 'run: ' + String((err && err.message) || err) });
    caps.gpu = false;
    await ensureSession(id, 'wasm');
    post({ type: 'progress', id, stage: 'infer' });
    const out = await session.run({ [session.inputNames[0]]: input });
    return readMask(out[session.outputNames[0]]);
  }
}

async function run({ id, file, maxPx }) {
  const MAXP = maxPx || MAX_PX;
  const T = { start: performance.now() };
  post({ type: 'progress', id, stage: 'decode' });
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image', premultiplyAlpha: 'none' });
  let W = bmp.width, H = bmp.height, scaled = false;
  if (W * H > MAXP) {
    const k = Math.sqrt(MAXP / (W * H));
    W = Math.max(1, Math.round(W * k)); H = Math.max(1, Math.round(H * k)); scaled = true;
  }
  const fc = new OffscreenCanvas(W, H);
  const fx = fc.getContext('2d', { willReadFrequently: true });
  fx.imageSmoothingQuality = 'high';
  fx.drawImage(bmp, 0, 0, W, H);
  const rgba = fx.getImageData(0, 0, W, H).data;
  fc.width = fc.height = 1;
  // 원래 투명한 사진이면 흰색에 합성해 두고 원래 alpha는 따로 기억
  let inA = null;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] < 255) { inA = new Uint8Array(W * H); break; }
  if (inA) {
    for (let i = 0, j = 0; i < inA.length; i++, j += 4) {
      const a = rgba[j + 3]; inA[i] = a;
      if (a < 255) {
        const k = a / 255, w = 255 * (1 - k);
        rgba[j] = rgba[j] * k + w; rgba[j + 1] = rgba[j + 1] * k + w; rgba[j + 2] = rgba[j + 2] * k + w; rgba[j + 3] = 255;
      }
    }
  }
  const mc = new OffscreenCanvas(SIZE, SIZE);
  const mx = mc.getContext('2d', { willReadFrequently: true });
  mx.fillStyle = '#fff'; mx.fillRect(0, 0, SIZE, SIZE);
  mx.imageSmoothingQuality = 'high';
  mx.drawImage(bmp, 0, 0, SIZE, SIZE);
  const low = mx.getImageData(0, 0, SIZE, SIZE).data;
  bmp.close();
  T.decoded = performance.now();

  await ensureSession(id);
  T.loaded = performance.now();
  post({ type: 'progress', id, stage: 'infer' });
  const mask = await infer(low, id);
  T.inferred = performance.now();

  post({ type: 'progress', id, stage: 'refine' });
  const { out } = refine({ rgba, W, H, mask, mw: SIZE, mh: SIZE, low, opts: testOpts });
  if (inA) for (let i = 0; i < inA.length; i++) if (inA[i] < 255) out[i * 4 + 3] = out[i * 4 + 3] * inA[i] / 255;
  T.refined = performance.now();

  const ms = {
    decode: Math.round(T.decoded - T.start), load: Math.round(T.loaded - T.decoded),
    infer: Math.round(T.inferred - T.loaded), refine: Math.round(T.refined - T.inferred), ...loadMs,
  };
  const msg = { type: 'result', id, W, H, scaled, orig: rgba.buffer, out: out.buffer, ms, ep: sessionEp };
  const tr = [rgba.buffer, out.buffer];
  if (testOpts.keepMask) { msg.mask = mask.buffer; msg.low = low.buffer; tr.push(mask.buffer, low.buffer); }
  post(msg, tr);
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'caps') {
      await detect();
      post({ type: 'caps', caps, cached: await isCached(), mb: Math.round(MODELS[MODEL].bytes / 1e6) });
    } else if (m.type === 'run') {
      await run(m);
    } else if (m.type === 'encode') {
      const blob = await encodePNG(new Uint8ClampedArray(m.buffer), m.W, m.H);
      post({ type: 'encoded', id: m.id, blob });
    } else if (m.type === 'opts') {
      Object.assign(testOpts, m.opts);
      if (m.opts.norm !== undefined) MODELS[MODEL].norm = m.opts.norm;
      post({ type: 'opts', id: m.id });
    }
  } catch (err) {
    console.error(err);
    post({ type: 'error', id: m.id, message: String((err && err.message) || err) });
  }
};
