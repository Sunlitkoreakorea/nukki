// 누끼 가장자리 다듬기 — DOM 없이 배열 계산만 한다 (worker.js, dev/ 시험에서 같이 씀).
//
// 1) 빠른 유도 필터(색 안내): 모델 마스크(1024 격자)와 같은 격자의 축소 사진으로
//    a(3)·b 계수를 구하고, 계수만 원본 해상도로 늘려 alpha = a·I + b 를 원본 픽셀에서 계산한다.
//    → 1024에서 나온 마스크라도 머리카락 같은 가는 경계가 원본 해상도 사진을 따라간다.
// 2) 블러 융합 전경색 추정(Forte & Pitié 2021, 2단계): 가장자리 반투명 픽셀에 섞인
//    배경색을 빼서 다른 배경에 얹어도 테두리 색이 번지지 않게 한다.

// 가장자리에서 실제 칸 수로 나누는 상자 평균. out/tmp는 재사용 가능.
export function boxMean(src, w, h, r, out, tmp) {
  out = out || new Float32Array(w * h);
  if (r < 1) { if (out !== src) out.set(src); return out; }
  tmp = tmp || new Float32Array(w * h);
  for (let y = 0, row = 0; y < h; y++, row += w) {
    let s = 0;
    const lim = Math.min(r, w - 1);
    for (let x = 0; x <= lim; x++) s += src[row + x];
    for (let x = 0; x < w; x++) {
      const lo = x - r, hi = x + r;
      tmp[row + x] = s / ((hi < w ? hi : w - 1) - (lo > 0 ? lo : 0) + 1);
      if (hi + 1 < w) s += src[row + hi + 1];
      if (lo >= 0) s -= src[row + lo];
    }
  }
  const col = new Float64Array(w);
  const lim = Math.min(r, h - 1);
  for (let y = 0; y <= lim; y++) { const row = y * w; for (let x = 0; x < w; x++) col[x] += tmp[row + x]; }
  for (let y = 0; y < h; y++) {
    const lo = y - r, hi = y + r;
    const inv = 1 / ((hi < h ? hi : h - 1) - (lo > 0 ? lo : 0) + 1), row = y * w;
    for (let x = 0; x < w; x++) out[row + x] = col[x] * inv;
    if (hi + 1 < h) { const r2 = (hi + 1) * w; for (let x = 0; x < w; x++) col[x] += tmp[r2 + x]; }
    if (lo >= 0) { const r2 = lo * w; for (let x = 0; x < w; x++) col[x] -= tmp[r2 + x]; }
  }
  return out;
}

// 색 안내 유도 필터 계수 (He et al.). R,G,B,p 는 0~1 Float32 평면.
export function guidedCoeffs(R, G, B, p, w, h, r, eps) {
  const n = w * h, tmp = new Float32Array(n), prod = new Float32Array(n);
  const mean = (src) => boxMean(src, w, h, r, new Float32Array(n), tmp);
  const pm = (A, C) => { for (let i = 0; i < n; i++) prod[i] = A[i] * C[i]; return mean(prod); };
  const mR = mean(R), mG = mean(G), mB = mean(B), mP = mean(p);
  const mRp = pm(R, p), mGp = pm(G, p), mBp = pm(B, p);
  const mRR = pm(R, R), mRG = pm(R, G), mRB = pm(R, B), mGG = pm(G, G), mGB = pm(G, B), mBB = pm(B, B);
  const aR = new Float32Array(n), aG = new Float32Array(n), aB = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r_ = mR[i], g_ = mG[i], b_ = mB[i], p_ = mP[i];
    const cR = mRp[i] - r_ * p_, cG = mGp[i] - g_ * p_, cB = mBp[i] - b_ * p_;
    const s11 = mRR[i] - r_ * r_ + eps, s12 = mRG[i] - r_ * g_, s13 = mRB[i] - r_ * b_;
    const s22 = mGG[i] - g_ * g_ + eps, s23 = mGB[i] - g_ * b_, s33 = mBB[i] - b_ * b_ + eps;
    const i11 = s22 * s33 - s23 * s23, i12 = s13 * s23 - s12 * s33, i13 = s12 * s23 - s13 * s22;
    const i22 = s11 * s33 - s13 * s13, i23 = s12 * s13 - s11 * s23, i33 = s11 * s22 - s12 * s12;
    const id = 1 / (s11 * i11 + s12 * i12 + s13 * i13);
    const ar = (cR * i11 + cG * i12 + cB * i13) * id;
    const ag = (cR * i12 + cG * i22 + cB * i23) * id;
    const ab = (cR * i13 + cG * i23 + cB * i33) * id;
    aR[i] = ar; aG[i] = ag; aB[i] = ab; b[i] = p_ - ar * r_ - ag * g_ - ab * b_;
  }
  return { aR: mean(aR), aG: mean(aG), aB: mean(aB), b: mean(b) };
}

// 원본 축(N칸) → 작은 격자 축(n칸) 쌍선형 표.
function axisMap(N, n) {
  const i0 = new Int32Array(N), i1 = new Int32Array(N), f = new Float32Array(N), sc = n / N;
  for (let x = 0; x < N; x++) {
    let u = (x + 0.5) * sc - 0.5;
    if (u < 0) u = 0; else if (u > n - 1) u = n - 1;
    const a = Math.floor(u);
    i0[x] = a; i1[x] = a + 1 < n ? a + 1 : n - 1; f[x] = u - a;
  }
  return { i0, i1, f };
}

// 작은 격자의 여러 평면을 원본의 y줄 하나로 늘린다. rows[k]는 길이 W.
function sampleRow(planes, lw, ax, ay, y, rows, tmpRow) {
  const y0 = ay.i0[y] * lw, y1 = ay.i1[y] * lw, fy = ay.f[y], gy = 1 - fy;
  const { i0, i1, f } = ax, W = i0.length;
  for (let k = 0; k < planes.length; k++) {
    const P = planes[k], out = rows[k];
    for (let x = 0; x < lw; x++) tmpRow[x] = P[y0 + x] * gy + P[y1 + x] * fy;
    for (let x = 0; x < W; x++) { const fx = f[x]; out[x] = tmpRow[i0[x]] * (1 - fx) + tmpRow[i1[x]] * fx; }
  }
}

export const DEFAULTS = {
  gfR: 4,        // 유도 필터 반경 (1024 격자 칸) — 8부터 단단한 경계에 잡티
  gfEps: 1e-5,   // 유도 필터 정규화 — 작을수록 사진 경계(잔머리)를 더 따라감
  gfMix: 1,      // 1 = 유도 필터 결과, 0 = 마스크 그대로 늘림
  lo: 0.01,      // 이보다 옅은 alpha는 0 (배경 잔상 제거)
  hi: 0.98,      // 이보다 진한 alpha는 1
  fgR1: 48,      // 전경색 1단계 반경 (1024 격자)
  fgR2: 0,       // 전경색 2단계 반경 (원본 px, 0이면 해상도에 맞춰 자동)
  decon: true,   // 전경색 추정(배경색 빼기) 켜기
};

// rgba: 원본 W×H RGBA(Uint8ClampedArray, 배경 없는 사진은 흰색에 합성된 상태)
// mask: mw×mh Float32 0~1, low: 같은 격자의 축소 사진 RGBA
// 반환: out RGBA (rgb = 전경색, a = alpha), alpha(Uint8Array)
export function refine({ rgba, W, H, mask, mw, mh, low, opts = {}, onStep }) {
  const o = { ...DEFAULTS, ...opts };
  const n = mw * mh;
  const R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) { R[i] = low[j] / 255; G[i] = low[j + 1] / 255; B[i] = low[j + 2] / 255; }

  // 1. 유도 필터 계수 (작은 격자)
  const { aR, aG, aB, b } = guidedCoeffs(R, G, B, mask, mw, mh, o.gfR, o.gfEps);
  const span = o.hi - o.lo;
  const remap = (v) => { v = (v - o.lo) / span; return v < 0 ? 0 : v > 1 ? 1 : v; };

  // 1단계 전경/배경 평균색 (작은 격자에서 큰 반경)
  let planes2 = null;
  if (o.decon) {
    const q = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const g = aR[i] * R[i] + aG[i] * G[i] + aB[i] * B[i] + b[i];
      q[i] = remap(o.gfMix * g + (1 - o.gfMix) * mask[i]);
    }
    const tmp = new Float32Array(n), prod = new Float32Array(n);
    const A = boxMean(q, mw, mh, o.fgR1, new Float32Array(n), tmp);
    const fgbg = (C) => {
      for (let i = 0; i < n; i++) prod[i] = C[i] * q[i];
      const F = boxMean(prod, mw, mh, o.fgR1, new Float32Array(n), tmp);
      for (let i = 0; i < n; i++) prod[i] = C[i] * (1 - q[i]);
      const Bk = boxMean(prod, mw, mh, o.fgR1, new Float32Array(n), tmp);
      for (let i = 0; i < n; i++) { F[i] /= A[i] + 1e-5; Bk[i] /= 1 - A[i] + 1e-5; }
      return [F, Bk];
    };
    const [FR, BR] = fgbg(R), [FG, BG] = fgbg(G), [FB, BB] = fgbg(B);
    planes2 = [FR, FG, FB, BR, BG, BB];
  }
  onStep && onStep('alpha');

  // 2. 원본 해상도 alpha
  const ax = axisMap(W, mw), ay = axisMap(H, mh);
  const alpha = new Uint8Array(W * H);
  const rows = [0, 1, 2, 3, 4].map(() => new Float32Array(W)), tmpRow = new Float32Array(mw);
  const pl = [aR, aG, aB, b, mask];
  for (let y = 0; y < H; y++) {
    sampleRow(pl, mw, ax, ay, y, rows, tmpRow);
    const [rr, rg, rb, rbb, rm] = rows, base = y * W;
    for (let x = 0; x < W; x++) {
      const j = (base + x) * 4;
      const g = rr[x] * rgba[j] / 255 + rg[x] * rgba[j + 1] / 255 + rb[x] * rgba[j + 2] / 255 + rbb[x];
      alpha[base + x] = Math.round(remap(o.gfMix * g + (1 - o.gfMix) * rm[x]) * 255);
    }
  }
  onStep && onStep('color');

  // 3. 전경색 (2단계는 원본 해상도에서 줄 묶음 단위로)
  const out = new Uint8ClampedArray(W * H * 4);
  if (!planes2) {
    for (let i = 0, j = 0; i < W * H; i++, j += 4) {
      const a = alpha[i];
      if (a) { out[j] = rgba[j]; out[j + 1] = rgba[j + 1]; out[j + 2] = rgba[j + 2]; out[j + 3] = a; }
    }
    return { out, alpha };
  }
  const r2 = o.fgR2 || Math.max(3, Math.round(6 * Math.max(W, H) / 1500));
  foreground2(rgba, alpha, W, H, planes2, mw, ax, ay, r2, out);
  return { out, alpha };
}

function foreground2(rgba, alpha, W, H, planes, lw, ax, ay, r, out) {
  const S = 96, P = S + 2 * r;
  const NP = 7; // F·a (3), a, B·(1-a) (3)
  const buf = Array.from({ length: NP }, () => new Float32Array(P * W));
  const rows = Array.from({ length: 6 }, () => new Float32Array(W)), tmpRow = new Float32Array(lw);
  const hrow = new Float32Array(W);
  const col = Array.from({ length: NP }, () => new Float64Array(W));
  const inv255 = 1 / 255;

  for (let y0 = 0; y0 < H; y0 += S) {
    const y1 = Math.min(H, y0 + S);
    const ys = Math.max(0, y0 - r), ye = Math.min(H, y1 + r);
    // 이 묶음에 반투명 픽셀이 없으면 계산 생략
    let need = false;
    for (let i = y0 * W, e = y1 * W; i < e; i++) { const a = alpha[i]; if (a > 0 && a < 255) { need = true; break; } }
    if (!need) {
      for (let i = y0 * W, e = y1 * W; i < e; i++) {
        const a = alpha[i];
        if (a) { const j = i * 4; out[j] = rgba[j]; out[j + 1] = rgba[j + 1]; out[j + 2] = rgba[j + 2]; out[j + 3] = 255; }
      }
      continue;
    }
    // 1) 각 줄: F1 = bF + a(I - a bF - (1-a) bB), 평면 채우고 가로 상자 평균
    for (let yy = ys; yy < ye; yy++) {
      sampleRow(planes, lw, ax, ay, yy, rows, tmpRow);
      const [fr, fg, fb, br, bg, bb] = rows, off = (yy - ys) * W, base = yy * W;
      const p0 = buf[0], p1 = buf[1], p2 = buf[2], p3 = buf[3], p4 = buf[4], p5 = buf[5], p6 = buf[6];
      for (let x = 0; x < W; x++) {
        const a = alpha[base + x] * inv255, j = (base + x) * 4, na = 1 - a, k = off + x;
        let F;
        F = fr[x] + a * (rgba[j] * inv255 - a * fr[x] - na * br[x]); F = F < 0 ? 0 : F > 1 ? 1 : F; p0[k] = F * a;
        F = fg[x] + a * (rgba[j + 1] * inv255 - a * fg[x] - na * bg[x]); F = F < 0 ? 0 : F > 1 ? 1 : F; p1[k] = F * a;
        F = fb[x] + a * (rgba[j + 2] * inv255 - a * fb[x] - na * bb[x]); F = F < 0 ? 0 : F > 1 ? 1 : F; p2[k] = F * a;
        p3[k] = a; p4[k] = br[x] * na; p5[k] = bg[x] * na; p6[k] = bb[x] * na;
      }
      for (let c = 0; c < NP; c++) {
        const p = buf[c];
        let s = 0;
        const lim = Math.min(r, W - 1);
        for (let x = 0; x <= lim; x++) s += p[off + x];
        for (let x = 0; x < W; x++) {
          const lo = x - r, hi = x + r;
          hrow[x] = s / ((hi < W ? hi : W - 1) - (lo > 0 ? lo : 0) + 1);
          if (hi + 1 < W) s += p[off + hi + 1];
          if (lo >= 0) s -= p[off + lo];
        }
        p.set(hrow, off);
      }
    }
    // 2) 세로 상자 평균을 밀면서 최종 전경색
    for (let c = 0; c < NP; c++) col[c].fill(0);
    const firstLo = Math.max(0, y0 - r), firstHi = Math.min(H - 1, y0 + r);
    for (let yy = firstLo; yy <= firstHi; yy++) {
      const off = (yy - ys) * W;
      for (let c = 0; c < NP; c++) { const p = buf[c], cc = col[c]; for (let x = 0; x < W; x++) cc[x] += p[off + x]; }
    }
    for (let y = y0; y < y1; y++) {
      const lo = y - r, hi = y + r;
      const inv = 1 / ((hi < H ? hi : H - 1) - (lo > 0 ? lo : 0) + 1), base = y * W;
      const c0 = col[0], c1 = col[1], c2 = col[2], c3 = col[3], c4 = col[4], c5 = col[5], c6 = col[6];
      for (let x = 0; x < W; x++) {
        const i = base + x, j = i * 4, a8 = alpha[i];
        if (a8 === 0) continue;
        if (a8 === 255) { out[j] = rgba[j]; out[j + 1] = rgba[j + 1]; out[j + 2] = rgba[j + 2]; out[j + 3] = 255; continue; }
        const a = a8 * inv255, na = 1 - a;
        const A = c3[x] * inv, fa = 1 / (A + 1e-5), ba = 1 / (1 - A + 1e-5);
        const fR = c0[x] * inv * fa, fG = c1[x] * inv * fa, fB = c2[x] * inv * fa;
        const bR = c4[x] * inv * ba, bG = c5[x] * inv * ba, bB = c6[x] * inv * ba;
        out[j] = (fR + a * (rgba[j] * inv255 - a * fR - na * bR)) * 255;
        out[j + 1] = (fG + a * (rgba[j + 1] * inv255 - a * fG - na * bG)) * 255;
        out[j + 2] = (fB + a * (rgba[j + 2] * inv255 - a * fB - na * bB)) * 255;
        out[j + 3] = a8;
      }
      if (y + 1 >= y1) break;
      if (hi + 1 < H) {
        const off = (hi + 1 - ys) * W;
        for (let c = 0; c < NP; c++) { const p = buf[c], cc = col[c]; for (let x = 0; x < W; x++) cc[x] += p[off + x]; }
      }
      if (lo >= 0) {
        const off = (lo - ys) * W;
        for (let c = 0; c < NP; c++) { const p = buf[c], cc = col[c]; for (let x = 0; x < W; x++) cc[x] -= p[off + x]; }
      }
    }
  }
}
