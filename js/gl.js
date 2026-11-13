// WebGL で 1 枚の透過画像を作る部品。
//  mode 1：Kyon の並べた MP4 → 「手前の色」×「手前の透け具合」
//  mode 2：背景の色を抜く（キャラ・手前の動画）。抜く色・抜き具合・ふちのなじませを選べる
//  mode 3：そのまま（透明のある動画。直し10）
// 結果は premultiplied のキャンバスなので、そのまま 2D の drawImage で重ねられる。
//
// 背景の色の抜き方：色を「色み」（Cb・Cr）だけで見て、抜く色の向きにどれだけ寄っているかで決める。
//  明るさは見ないので、撮影の明るさがむらでも抜ける（OBS のクロマキーと同じ考え方）。
//  寄り具合 k = 抜く色の向きへの長さ − 0.5 × 横へのずれ。k が sim を超えたら消え始め、sim + smo で消える。
//  ふちに残る色（こぼれ）は、抜く色にいちばん強い色の成分を、ほかの成分の高さまで下げる。
//  抜く色に近い所に加えて、抜ける所のとなり（ふち）も下げる（直し06：緑かぶりの打ち消し。つまみで弱められる）。

const VS = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main(){
  v_uv = a_pos;
  gl_Position = vec4(a_pos.x * 2.0 - 1.0, 1.0 - a_pos.y * 2.0, 0.0, 1.0);
}`;

// 精度は highp が使えれば highp（iPhone の mediump は 16 ビットで、パソコンと結果がずれやすい：直し06）
const FS_BODY = `
uniform sampler2D u_tex;
uniform vec4 u_c;      // 色を取る範囲（0〜1）
uniform vec4 u_a;      // 透け具合を取る範囲（0〜1）
uniform float u_mode;  // 1 = 並べたMP4, 2 = 背景の色を抜く, 3 = そのまま（透明のある動画）
uniform vec2 u_dir;    // 抜く色の色みの向き（長さ 1）
uniform float u_sim;   // 消え始める寄り具合
uniform float u_smo;   // ふちのなじませ（消えきるまでの幅）
uniform vec3 u_spill;  // こぼれを抑える色の成分（緑なら (0,1,0)。無いときは 0）
uniform float u_desp;  // 緑かぶりの打ち消し（0〜1）
uniform float u_desp2; // それより強く（0〜1。ふちを広く見て、抜く色に近い所も平均まで下げる：直し07）
uniform vec2 u_px;     // 元の動画の 1 画素（0〜1 の座標で）
varying vec2 v_uv;
float keyK(vec3 c){
  vec2 p = vec2(-0.1687 * c.r - 0.3313 * c.g + 0.5 * c.b, 0.5 * c.r - 0.4187 * c.g - 0.0813 * c.b);
  float along = dot(p, u_dir);
  float side = abs(p.x * u_dir.y - p.y * u_dir.x);
  return along - 0.5 * side;                           // 抜く色への寄り具合
}
void main(){
  vec2 uv = u_c.xy + v_uv * u_c.zw;
  vec4 t0 = texture2D(u_tex, uv);
  vec3 c = t0.rgb;
  float a;
  if (u_mode > 2.5) {
    // mode 3：透明のある動画（透過 WebM）を、そのまま通す（直し10：Android で 2D に描くと止まって見えたときの代わり）
    a = t0.a;
  } else if (u_mode < 1.5) {
    float m = texture2D(u_tex, u_a.xy + v_uv * u_a.zw).g;
    // 圧縮で黒・白がわずかにずれるので、端だけ少し締める
    a = clamp((m - 0.012) / (0.988 - 0.012), 0.0, 1.0);
  } else {
    float k = keyK(c);
    a = 1.0 - smoothstep(u_sim, u_sim + u_smo, k);
    // ふち：まわり（2画素先・8方向）に抜ける所があるか。動画の色の間引き（4:2:0）で、ふちの色は
    //  ブラウザごとに少しずつ違う（iPhone ではふちに緑が残りやすい）ので、ふちはまとめて緑かぶりを打ち消す
    // 1画素先と2画素先（強めたときは 4画素先まで）の両方を見る。幅2〜3画素の小さな穴（首と髪の間など）で、
    //  2画素先だけを見ると穴の向こう側を見てしまい、穴のまわりに緑の輪が残ることがあった（直し08：iPhone の静止画）
    float kn = -1.0;
    for (int i = 0; i < 2; i++) {
      vec2 d = u_px * (i == 0 ? 1.0 : 2.0 + 2.0 * u_desp2);
      kn = max(kn, keyK(texture2D(u_tex, uv + vec2(d.x, 0.0)).rgb));
      kn = max(kn, keyK(texture2D(u_tex, uv - vec2(d.x, 0.0)).rgb));
      kn = max(kn, keyK(texture2D(u_tex, uv + vec2(0.0, d.y)).rgb));
      kn = max(kn, keyK(texture2D(u_tex, uv - vec2(0.0, d.y)).rgb));
      kn = max(kn, keyK(texture2D(u_tex, uv + d).rgb));
      kn = max(kn, keyK(texture2D(u_tex, uv - d).rgb));
      kn = max(kn, keyK(texture2D(u_tex, uv + vec2(d.x, -d.y)).rgb));
      kn = max(kn, keyK(texture2D(u_tex, uv + vec2(-d.x, d.y)).rgb));
    }
    float edge = smoothstep(u_sim, u_sim + u_smo, kn);
    // ふちに残る色を抑える：抜く色に近い所と、ふち（抜ける所のとなり）だけ。つまみで弱められる
    float near = smoothstep(u_sim - 0.15, u_sim, k);
    float s = max(near, edge) * u_desp * step(0.5, dot(u_spill, vec3(1.0)));
    vec3 o = c * (vec3(1.0) - u_spill);
    float om = max(max(o.r, o.g), o.b);
    float dom = dot(c, u_spill);
    // ふちは「ほかの2色の平均」まで下げる（オレンジと緑が混ざったオリーブ色も消える）。抜く色に近い所は「ほかの大きい方」まで
    float oavg = dot(o, vec3(1.0)) * 0.5;
    float lim = min(dom, mix(om + 0.02, min(om, oavg), max(edge, near * u_desp2)));
    c = o + u_spill * mix(dom, lim, s);
  }
  gl_FragColor = vec4(c * a, a);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
  return s;
}

// 色み（Cb・Cr）
export function chroma(rgb) {
  const [r, g, b] = rgb;
  return [-0.1687 * r - 0.3313 * g + 0.5 * b, 0.5 * r - 0.4187 * g - 0.0813 * b];
}

// つまみの値（0〜100）と、シェーダーに渡す数の対応
//  抜き具合：大きいほど似た色まで消す（sim を下げる）。ふちのなじませ：大きいほどふちがやわらか
//  初期値（77・28）は、前の「緑の背景を抜く」とほぼ同じ見え方（緑のとき）
export const KEY_DEFAULT = { amount: 77, soft: 28, desp: 100, sim: 0.30 - 0.77 * 0.30, smo: 0.01 + 0.28 * 0.25 };
export function simFromAmount(v) { return 0.30 - (v / 100) * 0.30; }
export function smoFromSoft(v) { return 0.01 + (v / 100) * 0.25; }

// 抜く色（0〜1 の RGB）→ シェーダーに渡す形。色みが薄すぎるときは null
export function keyParams(rgb, sim, smo) {
  const [x, y] = chroma(rgb);
  const len = Math.hypot(x, y);
  if (len < 0.04) return null;
  const mx = Math.max(...rgb);
  const i = rgb.indexOf(mx);
  const others = rgb.filter((_, j) => j !== i);
  const spill = [0, 0, 0];
  if (mx - Math.max(...others) > 0.08) spill[i] = 1; // その色がはっきり強いときだけ、こぼれを抑える
  return { dir: [x / len, y / len], sim, smo, spill, desp: 1 };
}

export function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl') || c.getContext('experimental-webgl'));
  } catch (e) { return false; }
}

export class GLProc {
  constructor() {
    this.canvas = document.createElement('canvas');
    const opt = { alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: false, depth: false, stencil: false };
    const gl = this.canvas.getContext('webgl', opt) || this.canvas.getContext('experimental-webgl', opt);
    if (!gl) throw new Error('WebGL が使えません');
    this.gl = gl;
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VS));
    const hp = gl.getShaderPrecisionFormat && gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
    this.precision = hp && hp.precision > 0 ? 'highp' : 'mediump';
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, `precision ${this.precision} float;
` + FS_BODY));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link');
    gl.useProgram(p);
    this.u = {
      c: gl.getUniformLocation(p, 'u_c'),
      a: gl.getUniformLocation(p, 'u_a'),
      mode: gl.getUniformLocation(p, 'u_mode'),
      tex: gl.getUniformLocation(p, 'u_tex'),
      dir: gl.getUniformLocation(p, 'u_dir'),
      sim: gl.getUniformLocation(p, 'u_sim'),
      smo: gl.getUniformLocation(p, 'u_smo'),
      spill: gl.getUniformLocation(p, 'u_spill'),
      desp: gl.getUniformLocation(p, 'u_desp'),
      desp2: gl.getUniformLocation(p, 'u_desp2'),
      px: gl.getUniformLocation(p, 'u_px'),
    };
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(p, 'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.uniform1i(this.u.tex, 0);
  }

  // el：video か image。srcW/srcH：el の大きさ。rect / alphaRect：el の中の範囲（px）
  // outW/outH：結果の大きさ。mode：1 か 2
  // key（mode 2）：{ dir:[x,y], sim, smo, spill:[r,g,b] }（keyParams で作る）
  render(el, srcW, srcH, rect, alphaRect, mode, outW, outH, key) {
    const gl = this.gl;
    if (this.canvas.width !== outW || this.canvas.height !== outH) {
      this.canvas.width = outW;
      this.canvas.height = outH;
    }
    gl.viewport(0, 0, outW, outH);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, el);
    gl.uniform4f(this.u.c, rect.x / srcW, rect.y / srcH, rect.w / srcW, rect.h / srcH);
    const ar = alphaRect || rect;
    gl.uniform4f(this.u.a, ar.x / srcW, ar.y / srcH, ar.w / srcW, ar.h / srcH);
    gl.uniform1f(this.u.mode, mode);
    const k = key || keyParams([0, 1, 0], KEY_DEFAULT.sim, KEY_DEFAULT.smo);
    gl.uniform2f(this.u.dir, k.dir[0], k.dir[1]);
    gl.uniform1f(this.u.sim, k.sim);
    gl.uniform1f(this.u.smo, k.smo);
    gl.uniform3f(this.u.spill, k.spill[0], k.spill[1], k.spill[2]);
    gl.uniform1f(this.u.desp, k.desp ?? 1);
    gl.uniform1f(this.u.desp2, k.desp2 ?? 0);
    gl.uniform2f(this.u.px, 1 / srcW, 1 / srcH);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    return this.canvas;
  }
}
