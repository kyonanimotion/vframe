// 動画の書き出し（直し06）：WebCodecs の VideoEncoder で H.264 にして、MP4 にまとめる。
// どのブラウザで作っても、ふつうの動画の形にそろえる：
//  ・H.264（High → Main → Baseline の順に、使えるもの）・yuv420p
//  ・ふつうの範囲（tv／limited）・色のラベルは BT.709（原色・転送・行列の3つとも）
//  ・30コマ/秒で一定（コマ i の時刻は i/30 秒）
// キャンバスの色（sRGB）を、こちらで BT.709 の YUV（ふつうの範囲）に直してから渡す（ブラウザ任せにしない）。
// 色のラベルは、MP4 の colr の箱と、H.264 の SPS（VUI）の両方に書く（ブラウザの書いたラベルを上書きする）。

export const FPS = 30;
const CS = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false };

export function webcodecsOk() {
  return typeof window.VideoEncoder === 'function' && typeof window.VideoFrame === 'function';
}

// 大きさに合う H.264 のレベル（1コマのマクロブロック数で決める）
function levelHex(w, h) {
  const mbs = Math.ceil(w / 16) * Math.ceil(h / 16);
  if (mbs <= 8192) return '28';   // 4.0（1080×1920・1920×1080・1080×1080）
  if (mbs <= 8704) return '2a';   // 4.2
  if (mbs <= 22080) return '32';  // 5.0
  return '33';
}

// 使える設定を探す → { config, profile } | null
export async function findConfig(w, h, bitrate) {
  if (!webcodecsOk()) return null;
  const lv = levelHex(w, h);
  const cands = [['avc1.6400' + lv, 'High'], ['avc1.4d00' + lv, 'Main'], ['avc1.42e0' + lv, 'Baseline']];
  for (const [codec, profile] of cands) {
    const config = { codec, width: w, height: h, bitrate, framerate: FPS, bitrateMode: 'variable', latencyMode: 'quality', avc: { format: 'avc' } };
    try {
      const r = await VideoEncoder.isConfigSupported(config);
      if (r && r.supported) return { config: r.config || config, profile };
    } catch (e) { /* 次へ */ }
    // bitrateMode を受け付けないブラウザ向け
    try {
      const c2 = { ...config }; delete c2.bitrateMode;
      const r = await VideoEncoder.isConfigSupported(c2);
      if (r && r.supported) return { config: r.config || c2, profile };
    } catch (e) { /* 次へ */ }
  }
  return null;
}

// ---------- sRGB のキャンバス → I420（BT.709・ふつうの範囲） ----------
// WebGL で変換して readPixels で受け取る（I420 の並びそのままの形で出す）。使えないときは JS で計算する。
const YUV_VS = `attribute vec2 p; void main(){ gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;
const YUV_FS = `precision highp float;
uniform sampler2D t; uniform vec2 sz;  // sz = (W, H)
float Y(vec3 c){ return (16.0 + 219.0 * dot(c, vec3(0.2126, 0.7152, 0.0722))) / 255.0; }
float U(vec3 c){ float y = dot(c, vec3(0.2126, 0.7152, 0.0722)); return (128.0 + 224.0 * (c.b - y) / 1.8556) / 255.0; }
float V(vec3 c){ float y = dot(c, vec3(0.2126, 0.7152, 0.0722)); return (128.0 + 224.0 * (c.r - y) / 1.5748) / 255.0; }
float byteAt(float r, float b){
  // r：出力の行（readPixels の行＝I420 の W バイトずつの行）、b：その行の中のバイトの位置（0〜W-1）
  if (r < sz.y) return Y(texture2D(t, vec2(b + 0.5, r + 0.5) / sz).rgb);
  float q = r - sz.y; float hw = sz.x * 0.5; float qh = sz.y * 0.25;
  bool isV = q >= qh; if (isV) q -= qh;
  float uy = q * 2.0 + (b >= hw ? 1.0 : 0.0); float ux = b >= hw ? b - hw : b;
  // 2×2 の真ん中（4つの画素の角）を線形で取る＝4つの平均
  vec3 c = texture2D(t, vec2(ux * 2.0 + 1.0, uy * 2.0 + 1.0) / sz).rgb;
  return isV ? V(c) : U(c);
}
void main(){
  float r = floor(gl_FragCoord.y); float b = floor(gl_FragCoord.x) * 4.0;
  gl_FragColor = vec4(byteAt(r, b), byteAt(r, b + 1.0), byteAt(r, b + 2.0), byteAt(r, b + 3.0));
}`;

class GLYuv {
  constructor(w, h) {
    this.w = w; this.h = h;
    this.canvas = document.createElement('canvas');
    this.canvas.width = w / 4; this.canvas.height = h * 3 / 2;
    const gl = this.canvas.getContext('webgl', { alpha: true, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false }); // 4バイト目も使うので alpha: true
    if (!gl) throw new Error('webgl');
    const hp = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
    if (!hp || hp.precision < 23) throw new Error('highp');
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, YUV_VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, YUV_FS));
    gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link');
    gl.useProgram(p);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(p, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.uniform1i(gl.getUniformLocation(p, 't'), 0);
    gl.uniform2f(gl.getUniformLocation(p, 'sz'), w, h);
    gl.viewport(0, 0, w / 4, h * 3 / 2);
    this.gl = gl;
  }
  convert(src, out) {
    const gl = this.gl;
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.readPixels(0, 0, this.w / 4, this.h * 3 / 2, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  }
}

function cpuYuv(src, w, h, out) {
  const c = cpuYuv.c || (cpuYuv.c = document.createElement('canvas'));
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const x = c.getContext('2d', { willReadFrequently: true });
  x.clearRect(0, 0, w, h); x.drawImage(src, 0, 0);
  const d = x.getImageData(0, 0, w, h).data;
  const yp = out, up = w * h, vp = up + (w / 2) * (h / 2);
  for (let i = 0, n = w * h; i < n; i++) {
    const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
    yp[i] = Math.round(16 + 219 * (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255);
  }
  for (let y = 0; y < h / 2; y++) {
    for (let x2 = 0; x2 < w / 2; x2++) {
      let r = 0, g = 0, b = 0;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) { const i = ((y * 2 + dy) * w + x2 * 2 + dx) * 4; r += d[i]; g += d[i + 1]; b += d[i + 2]; }
      r /= 4; g /= 4; b /= 4;
      const yy = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      out[up + y * (w / 2) + x2] = Math.round(128 + 224 * (b - yy) / 1.8556 / 255);
      out[vp + y * (w / 2) + x2] = Math.round(128 + 224 * (r - yy) / 1.5748 / 255);
    }
  }
  return out;
}

// ---------- 書き出し ----------
// rec = await Mp4Rec.start(W, H)；rec.add(canvas)（呼ぶたびに次のコマ）；blob = await rec.finish()
export class Mp4Rec {
  static async start(w, h) {
    const bitrate = Math.round(Math.min(12e6, Math.max(4e6, 10e6 * (w * h) / (1080 * 1920))));
    const found = await findConfig(w, h, bitrate);
    if (!found) return null;
    const r = new Mp4Rec(w, h, found);
    try { r.enc.configure(found.config); } catch (e) { return null; }
    return r;
  }
  constructor(w, h, found) {
    this.w = w; this.h = h; this.profile = found.profile; this.codec = found.config.codec;
    this.bitrate = found.config.bitrate;
    this.samples = []; this.desc = null; this.err = null; this.n = 0;
    this.buf = new Uint8Array(w * h * 3 / 2);
    this.yuvWay = 'cpu';
    if (w % 4 === 0 && h % 4 === 0) { try { this.gly = new GLYuv(w, h); this.yuvWay = 'gl'; } catch (e) { this.gly = null; } }
    this.enc = new VideoEncoder({
      output: (chunk, meta) => {
        const d = new Uint8Array(chunk.byteLength); chunk.copyTo(d);
        this.samples.push({ data: d, ts: chunk.timestamp, key: chunk.type === 'key' });
        if (meta && meta.decoderConfig && meta.decoderConfig.description && !this.desc) {
          const ds = meta.decoderConfig.description;
          this.desc = ds instanceof ArrayBuffer ? new Uint8Array(ds.slice(0)) : new Uint8Array(ds.buffer.slice(ds.byteOffset, ds.byteOffset + ds.byteLength));
        }
      },
      error: (e) => { this.err = e; },
    });
  }
  get queue() { return this.enc.encodeQueueSize; }
  // キャンバスの今の絵を、次のコマとして入れる
  add(src) {
    if (this.err) throw this.err;
    const i = this.n++;
    if (this.gly) this.gly.convert(src, this.buf); else cpuYuv(src, this.w, this.h, this.buf);
    const f = new VideoFrame(this.buf, {
      format: 'I420', codedWidth: this.w, codedHeight: this.h,
      timestamp: Math.round(i * 1e6 / FPS), duration: Math.round(1e6 / FPS), colorSpace: CS,
    });
    try { this.enc.encode(f, { keyFrame: i % (FPS * 2) === 0 }); } finally { f.close(); }
  }
  async finish() {
    await this.enc.flush();
    try { this.enc.close(); } catch (e) { /* もう閉じている */ }
    if (this.err) throw this.err;
    return new Blob([buildMp4(this)], { type: 'video/mp4' });
  }
  cancel() { try { this.enc.close(); } catch (e) { /* なし */ } }
}

// ---------- H.264 の中身（SPS に色のラベルを書く） ----------
function unescapeRbsp(b) {
  const o = []; let z = 0;
  for (let i = 0; i < b.length; i++) {
    if (z >= 2 && b[i] === 3) { z = 0; continue; }
    o.push(b[i]); z = b[i] === 0 ? z + 1 : 0;
  }
  return new Uint8Array(o);
}
function escapeRbsp(b) {
  const o = []; let z = 0;
  for (let i = 0; i < b.length; i++) {
    if (z >= 2 && b[i] <= 3) { o.push(3); z = 0; }
    o.push(b[i]); z = b[i] === 0 ? z + 1 : 0;
  }
  return new Uint8Array(o);
}
class BR {
  constructor(b) { this.b = b; this.p = 0; }
  u(n) { let v = 0; for (let i = 0; i < n; i++) { v = v * 2 + ((this.b[this.p >> 3] >> (7 - (this.p & 7))) & 1); this.p++; } return v; }
  ue() { let z = 0; while (this.u(1) === 0) { z++; if (z > 31) throw new Error('ue'); } return (2 ** z - 1) + this.u(z); }
  se() { const k = this.ue(); return k & 1 ? (k + 1) / 2 : -k / 2; }
}
class BW {
  constructor() { this.a = []; this.cur = 0; this.n = 0; }
  u(n, v) { for (let i = n - 1; i >= 0; i--) { this.cur = (this.cur << 1) | (Math.floor(v / 2 ** i) & 1); this.n++; if (this.n === 8) { this.a.push(this.cur); this.cur = 0; this.n = 0; } } }
  ue(v) { const x = v + 1; const len = Math.floor(Math.log2(x)); this.u(len, 0); this.u(len + 1, x); }
  bytes() { return new Uint8Array(this.a); }
}

// SPS（NAL の頭の1バイトつき）の VUI に、BT.709・ふつうの範囲を書く。30コマ一定の時間の情報も無ければ足す
export function patchSps(nal) {
  const rb = unescapeRbsp(nal.subarray(1));
  const r = new BR(rb);
  const prof = r.u(8); r.u(8); r.u(8); r.ue();
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(prof)) {
    const cf = r.ue(); if (cf === 3) r.u(1);
    r.ue(); r.ue(); r.u(1);
    if (r.u(1)) {
      for (let i = 0; i < (cf === 3 ? 12 : 8); i++) {
        if (r.u(1)) { let last = 8, next = 8; const size = i < 6 ? 16 : 64; for (let j = 0; j < size; j++) { if (next !== 0) { next = (last + r.se() + 256) % 256; } last = next === 0 ? last : next; } }
      }
    }
  }
  r.ue();
  const poc = r.ue();
  if (poc === 0) r.ue(); else if (poc === 1) { r.u(1); r.se(); r.se(); const n = r.ue(); for (let i = 0; i < n; i++) r.se(); }
  r.ue(); r.u(1); r.ue(); r.ue();
  if (!r.u(1)) r.u(1);
  r.u(1);
  if (r.u(1)) { r.ue(); r.ue(); r.ue(); r.ue(); }
  const vuiPos = r.p;
  // 最後の 1（終わりの印）の位置
  let last = rb.length - 1; while (last >= 0 && rb[last] === 0) last--;
  if (last < 0) throw new Error('sps');
  let stop = last * 8 + 7; while (!((rb[last] >> (7 - (stop & 7))) & 1)) stop--;

  const w = new BW();
  const copy = (from, to) => { const rr = new BR(rb); rr.p = from; for (let i = from; i < to; i++) w.u(1, rr.u(1)); };
  copy(0, vuiPos);
  const hasVui = r.u(1);
  w.u(1, 1);
  const writeSignal = () => { w.u(1, 1); w.u(3, 5); w.u(1, 0); w.u(1, 1); w.u(8, 1); w.u(8, 1); w.u(8, 1); };
  if (hasVui) {
    const a0 = r.p;
    if (r.u(1)) { if (r.u(8) === 255) { r.u(16); r.u(16); } }
    if (r.u(1)) r.u(1);
    copy(a0, r.p);
    if (r.u(1)) { r.u(3); r.u(1); if (r.u(1)) { r.u(8); r.u(8); r.u(8); } }
    writeSignal();
    copy(r.p, stop);
  } else {
    w.u(1, 0); w.u(1, 0);           // 画素の形・オーバースキャン：なし
    writeSignal();
    w.u(1, 0);                      // 色の位置：なし
    w.u(1, 1); w.u(32, 1); w.u(32, FPS * 2); w.u(1, 1); // 時間の情報：30コマ/秒・一定
    w.u(1, 0); w.u(1, 0); w.u(1, 0); w.u(1, 0);
  }
  w.u(1, 1); while (w.n !== 0) w.u(1, 0);
  const out = escapeRbsp(w.bytes());
  const res = new Uint8Array(out.length + 1); res[0] = nal[0]; res.set(out, 1);
  return res;
}

// avcC を読む → { lenSize, sps[], pps[], head(5バイト), tail }
function readAvcC(d) {
  let p = 5; const lenSize = (d[4] & 3) + 1;
  const ns = d[p++] & 31; const sps = [];
  for (let i = 0; i < ns; i++) { const l = (d[p] << 8) | d[p + 1]; sps.push(d.subarray(p + 2, p + 2 + l)); p += 2 + l; }
  const np = d[p++]; const pps = [];
  for (let i = 0; i < np; i++) { const l = (d[p] << 8) | d[p + 1]; pps.push(d.subarray(p + 2, p + 2 + l)); p += 2 + l; }
  return { lenSize, sps, pps, head: d.subarray(0, 5), tail: d.subarray(p) };
}
function writeAvcC(a) {
  const parts = [a.head, Uint8Array.of(0xe0 | a.sps.length)];
  for (const s of a.sps) parts.push(Uint8Array.of(s.length >> 8, s.length & 255), s);
  parts.push(Uint8Array.of(a.pps.length));
  for (const s of a.pps) parts.push(Uint8Array.of(s.length >> 8, s.length & 255), s);
  parts.push(a.tail);
  return cat(parts);
}
// Annex B（00 00 01 で区切る）→ NAL の配列
function splitAnnexB(d) {
  const out = []; let i = 0, start = -1;
  while (i + 2 < d.length) {
    if (d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 1) {
      if (start >= 0) { let e = i; while (e > start && d[e - 1] === 0) e--; out.push(d.subarray(start, e)); }
      start = i + 3; i += 3;
    } else i++;
  }
  if (start >= 0) out.push(d.subarray(start));
  return out;
}
function cat(parts) {
  let n = 0; for (const p of parts) n += p.length;
  const o = new Uint8Array(n); let k = 0;
  for (const p of parts) { o.set(p, k); k += p.length; }
  return o;
}

// コマの中の NAL を、長さつきの形にそろえ、SPS があれば書き換え、avcC 用の SPS・PPS を集める
function normalize(rec) {
  let avcc = rec.desc && rec.desc.length > 6 && rec.desc[0] === 1 ? readAvcC(rec.desc) : null;
  const lenSize = avcc ? avcc.lenSize : 4;
  const spsSeen = [], ppsSeen = [];
  const samples = rec.samples.map((s) => {
    let nals;
    const d = s.data;
    // description（avcC）があるときは長さつきの形、無いときは Annex B（WebCodecs の決まり）
    if (!avcc) nals = splitAnnexB(d);
    else { nals = []; let p = 0; while (p + lenSize <= d.length) { let l = 0; for (let i = 0; i < lenSize; i++) l = l * 256 + d[p + i]; nals.push(d.subarray(p + lenSize, p + lenSize + l)); p += lenSize + l; } }
    const keep = [];
    for (let n of nals) {
      const t = n[0] & 31;
      if (t === 9) continue;                  // 区切りの印は要らない
      if (t === 7) { n = patchSps(n); if (!spsSeen.length) spsSeen.push(n); }
      if (t === 8 && !ppsSeen.length) ppsSeen.push(n);
      keep.push(n);
    }
    const parts = [];
    for (const n of keep) { const l = n.length; parts.push(Uint8Array.of(l >>> 24, (l >> 16) & 255, (l >> 8) & 255, l & 255), n); }
    return { data: cat(parts), ts: s.ts, key: s.key };
  });
  if (avcc) avcc = { ...avcc, lenSize: 4, head: Uint8Array.of(avcc.head[0], avcc.head[1], avcc.head[2], avcc.head[3], 0xff), sps: avcc.sps.map(patchSps) };
  else {
    if (!spsSeen.length || !ppsSeen.length) throw new Error('SPS/PPS なし');
    const s = spsSeen[0];
    avcc = { lenSize: 4, head: Uint8Array.of(1, s[1], s[2], s[3], 0xff), sps: spsSeen, pps: ppsSeen, tail: new Uint8Array(0) };
  }
  return { avcC: writeAvcC(avcc), samples };
}

// ---------- MP4 の箱 ----------
const enc = new TextEncoder();
function u32(v) { return Uint8Array.of(v >>> 24, (v >> 16) & 255, (v >> 8) & 255, v & 255); }
function u16(v) { return Uint8Array.of((v >> 8) & 255, v & 255); }
function box(type, ...parts) { const body = cat(parts.flat()); return cat([u32(body.length + 8), enc.encode(type), body]); }
function fbox(type, ver, flags, ...parts) { return box(type, Uint8Array.of(ver, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255), ...parts); }
const MATRIX = cat([u32(0x10000), u32(0), u32(0), u32(0), u32(0x10000), u32(0), u32(0), u32(0), u32(0x40000000)]);

export function buildMp4(rec) {
  const { avcC, samples } = normalize(rec);
  // 出てきた順（デコードの順）。時刻は i/30 秒にそろえる（B フレームがあるときは表示の順で振る）
  const TS = FPS * 1000, DUR = 1000;
  const order = samples.map((s, i) => ({ i, ts: s.ts })).sort((a, b) => a.ts - b.ts);
  const pts = new Array(samples.length);
  order.forEach((o, k) => { pts[o.i] = k * DUR; });
  let shift = 0;
  samples.forEach((s, i) => { shift = Math.max(shift, i * DUR - pts[i]); });
  const ctts = samples.map((s, i) => pts[i] + shift - i * DUR);
  const needCtts = ctts.some((c) => c !== 0);
  const n = samples.length, dur = n * DUR;
  const w = rec.w, h = rec.h;

  const avc1 = box('avc1',
    new Uint8Array(6), u16(1), new Uint8Array(16), u16(w), u16(h), u32(0x480000), u32(0x480000), u32(0), u16(1),
    new Uint8Array(32), u16(0x18), u16(0xffff),
    box('avcC', avcC),
    box('colr', enc.encode('nclx'), u16(1), u16(1), u16(1), Uint8Array.of(0)), // BT.709・ふつうの範囲
    box('pasp', u32(1), u32(1)));
  const stts = fbox('stts', 0, 0, u32(1), u32(n), u32(DUR));
  const stss = fbox('stss', 0, 0, u32(samples.filter((s) => s.key).length), ...samples.map((s, i) => (s.key ? u32(i + 1) : null)).filter(Boolean));
  const stsc = fbox('stsc', 0, 0, u32(1), u32(1), u32(1), u32(1));
  const stsz = fbox('stsz', 0, 0, u32(0), u32(n), ...samples.map((s) => u32(s.data.length)));
  const cttsBox = needCtts ? [fbox('ctts', 0, 0, u32(n), ...samples.map((s, i) => cat([u32(1), u32(ctts[i])])))] : [];
  const mk = (offsets) => {
    const stco = fbox('stco', 0, 0, u32(n), ...offsets.map(u32));
    const stbl = box('stbl', fbox('stsd', 0, 0, u32(1), avc1), stts, ...cttsBox, stss, stsc, stsz, stco);
    const minf = box('minf', fbox('vmhd', 0, 1, new Uint8Array(8)), box('dinf', fbox('dref', 0, 0, u32(1), fbox('url ', 0, 1))), stbl);
    const mdia = box('mdia',
      fbox('mdhd', 0, 0, u32(0), u32(0), u32(TS), u32(dur), u16(0x55c4), u16(0)),
      fbox('hdlr', 0, 0, u32(0), enc.encode('vide'), new Uint8Array(12), enc.encode('VideoHandler\0')),
      minf);
    const mvdur = Math.round(dur / TS * 1000);
    const edts = shift ? [box('edts', fbox('elst', 0, 0, u32(1), u32(mvdur), u32(shift), u32(0x10000)))] : [];
    const trak = box('trak',
      fbox('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(mvdur), new Uint8Array(8), u16(0), u16(0), u16(0), u16(0), MATRIX, u32(w * 65536), u32(h * 65536)),
      ...edts, mdia);
    return box('moov',
      fbox('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(mvdur), u32(0x10000), u16(0x100), new Uint8Array(10), MATRIX, new Uint8Array(24), u32(2)),
      trak);
  };
  const ftyp = box('ftyp', enc.encode('isom'), u32(0x200), enc.encode('isomiso2avc1mp41'));
  // 箱の大きさは中身の位置によらないので、一度作って長さを測ってから位置を入れる
  const moov0 = mk(new Array(n).fill(0));
  let off = ftyp.length + moov0.length + 8;
  const offsets = samples.map((s) => { const o = off; off += s.data.length; return o; });
  const moov = mk(offsets);
  let mdatLen = 8; for (const s of samples) mdatLen += s.data.length;
  return cat([ftyp, moov, u32(mdatLen), enc.encode('mdat'), ...samples.map((s) => s.data)]);
}
