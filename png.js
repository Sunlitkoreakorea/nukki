// 직접 만드는 PNG 인코더 — 캔버스 toBlob은 내부적으로 alpha를 곱해 두었다가 풀어서
// 반투명 가장자리 색이 뭉개지므로, 계산한 RGBA를 그대로 담는다.

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc(c, b) {
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8);
  return c;
}

function chunk(type, data) {
  const head = new Uint8Array(8), tail = new Uint8Array(4);
  const dv = new DataView(head.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) head[4 + i] = type.charCodeAt(i);
  let c = crc(0xffffffff, head.subarray(4));
  c = (crc(c, data) ^ 0xffffffff) >>> 0;
  new DataView(tail.buffer).setUint32(0, c);
  return [head, data, tail];
}

export async function encodePNG(rgba, w, h) {
  const stride = w * 4, raw = new Uint8Array((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (stride + 1) + 1, s = y * stride;
    raw[o - 1] = 4; // Paeth
    if (y === 0) {
      for (let i = 0; i < 4; i++) raw[o + i] = rgba[i];
      for (let i = 4; i < stride; i++) raw[o + i] = (rgba[i] - rgba[i - 4]) & 255;
      continue;
    }
    const u = s - stride;
    for (let i = 0; i < 4; i++) raw[o + i] = (rgba[s + i] - rgba[u + i]) & 255;
    for (let i = 4; i < stride; i++) {
      const a = rgba[s + i - 4], b = rgba[u + i], c = rgba[u + i - 4];
      const pa = b > c ? b - c : c - b, pb = a > c ? a - c : c - a;
      const p2 = a + b - 2 * c, pc = p2 < 0 ? -p2 : p2;
      const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      raw[o + i] = (rgba[s + i] - pr) & 255;
    }
  }
  const z = new Uint8Array(await new Response(
    new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))
  ).arrayBuffer());
  const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h);
  ihdr[8] = 8; ihdr[9] = 6; // 8비트 RGBA
  return new Blob([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    ...chunk('IHDR', ihdr),
    ...chunk('sRGB', new Uint8Array([0])),
    ...chunk('IDAT', z),
    ...chunk('IEND', new Uint8Array(0)),
  ], { type: 'image/png' });
}
