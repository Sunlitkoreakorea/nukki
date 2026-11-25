// ONNX 파일을 브라우저에서 고치는 작은 protobuf 수정기.
// 웹용 ONNX Runtime에는 double(64비트) 연산 커널이 없어서, 모델 안의 double 계산을 float32로 바꾼다.
// 가중치(initializer) 같은 큰 덩어리는 해석하지 않고 바이트 그대로 복사한다.

function readVarint(b, p) {
  let x = 0, s = 1, c;
  do { c = b[p++]; x += (c & 0x7f) * s; s *= 128; } while (c & 0x80);
  return [x, p];
}

function fields(b, start, end) {
  const out = [];
  let p = start;
  while (p < end) {
    const h = p;
    let key, v = 0, vs, ve;
    [key, p] = readVarint(b, p);
    const f = Math.floor(key / 8), wt = key & 7;
    if (wt === 0) { [v, p] = readVarint(b, p); vs = h; ve = p; }
    else if (wt === 2) { let len; [len, p] = readVarint(b, p); vs = p; ve = p + len; p = ve; }
    else if (wt === 1) { vs = p; p += 8; ve = p; }
    else if (wt === 5) { vs = p; p += 4; ve = p; }
    else throw new Error('protobuf wire type ' + wt);
    out.push({ f, wt, h, vs, ve, v, end: p });
  }
  return out;
}

function varint(n) {
  const a = [];
  while (n >= 128) { a.push((n % 128) | 128); n = Math.floor(n / 128); }
  a.push(n);
  return new Uint8Array(a);
}
const total = (parts) => parts.reduce((s, x) => s + x.length, 0);
const lenField = (f, parts) => [varint(f * 8 + 2), varint(total(parts)), ...parts];
const str = (b, x) => new TextDecoder().decode(b.subarray(x.vs, x.ve));

const DOUBLE = 11, FLOAT = 1;

// TensorProto(double) → TensorProto(float, raw_data)
function tensorToFloat(b, t) {
  const fs = fields(b, t.vs, t.ve);
  const dt = fs.find((x) => x.f === 2);
  if (!dt || dt.v !== DOUBLE) return null;
  let vals = [];
  for (const x of fs) {
    if (x.f === 9) {
      const dv = new DataView(b.buffer, b.byteOffset + x.vs, x.ve - x.vs);
      for (let i = 0; i + 8 <= dv.byteLength; i += 8) vals.push(dv.getFloat64(i, true));
    } else if (x.f === 10) {
      const dv = new DataView(b.buffer, b.byteOffset + x.vs, x.ve - x.vs);
      for (let i = 0; i + 8 <= dv.byteLength; i += 8) vals.push(dv.getFloat64(i, true));
    }
  }
  const raw = new Uint8Array(new Float32Array(vals).buffer);
  const parts = [];
  for (const x of fs) {
    if (x.f === 1 || x.f === 8) parts.push(b.subarray(x.h, x.end)); // dims, name
  }
  parts.push(varint(2 * 8), varint(FLOAT));
  parts.push(...lenField(9, [raw]));
  return parts;
}

function patchNode(b, node, stats) {
  const fs = fields(b, node.vs, node.ve);
  const opF = fs.find((x) => x.f === 4);
  const op = opF ? str(b, opF) : '';
  if (op !== 'Cast' && op !== 'Constant') return null;
  let changed = false;
  const parts = [];
  for (const x of fs) {
    if (x.f !== 5) { parts.push(b.subarray(x.h, x.end)); continue; }
    const af = fields(b, x.vs, x.ve);
    const nameF = af.find((y) => y.f === 1);
    const name = nameF ? str(b, nameF) : '';
    if (op === 'Cast' && name === 'to') {
      const iF = af.find((y) => y.f === 3);
      if (iF && iF.v === DOUBLE) {
        const ap = [];
        for (const y of af) ap.push(y === iF ? new Uint8Array([3 * 8, FLOAT]) : b.subarray(y.h, y.end));
        parts.push(...lenField(5, ap)); changed = true; stats.cast++; continue;
      }
    }
    if (op === 'Constant' && name === 'value') {
      const tF = af.find((y) => y.f === 5);
      const nt = tF && tensorToFloat(b, tF);
      if (nt) {
        const ap = [];
        for (const y of af) { if (y === tF) ap.push(...lenField(5, nt)); else ap.push(b.subarray(y.h, y.end)); }
        parts.push(...lenField(5, ap)); changed = true; stats.constant++; continue;
      }
    }
    parts.push(b.subarray(x.h, x.end));
  }
  return changed ? lenField(1, parts) : null;
}

export function patchDoubleToFloat(bytes) {
  const b = bytes;
  const stats = { cast: 0, constant: 0, init: 0, valueInfo: 0 };
  const top = fields(b, 0, b.length);
  const out = [];
  for (const m of top) {
    if (m.f !== 7) { out.push(b.subarray(m.h, m.end)); continue; }
    const gparts = [];
    for (const g of fields(b, m.vs, m.ve)) {
      if (g.f === 1) {
        const p = patchNode(b, g, stats);
        if (p) gparts.push(...p); else gparts.push(b.subarray(g.h, g.end));
      } else if (g.f === 5) {
        const nt = tensorToFloat(b, g);
        if (nt) { gparts.push(...lenField(5, nt)); stats.init++; } else gparts.push(b.subarray(g.h, g.end));
      } else if (g.f === 13) {
        stats.valueInfo++; // 형 추론 힌트는 버린다 (ORT가 다시 추론)
      } else gparts.push(b.subarray(g.h, g.end));
    }
    out.push(...lenField(7, gparts));
  }
  const res = new Uint8Array(total(out));
  let o = 0;
  for (const p of out) { res.set(p, o); o += p.length; }
  return { bytes: res, stats };
}
