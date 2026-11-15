// Vフレメーカー
// フレーム（いちばん手前）→ キャラ（まんなか）→ 背景（いちばんうしろ）の3つを1枚のキャンバスに重ね、PNG と MP4 に書き出す。
// 選んだファイルは URL.createObjectURL でその場で読むだけ。どこにも送らない・保存しない。
// ?v= の数字は index.html と同じにする（scripts\bump_version.py で一度に変えられる）
import { MATERIALS, BOOTH_SHOP, ORIENTS } from './materials/materials.js?v=20261115';
import { GLProc, webglAvailable, keyParams, KEY_DEFAULT, simFromAmount, smoFromSoft } from './js/gl.js?v=20261115';
import { Mp4Rec, FPS, findConfig } from './js/mp4rec.js?v=20261115';

const $ = (id) => document.getElementById(id);
const cv = $('cv');
const ctx = cv.getContext('2d');
const holder = $('holder');
const isTouch = matchMedia('(pointer: coarse)').matches;

const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
const MAX_REC_SEC = 15;
// Kyon の動フレの形
//  full ：背景｜手前の色｜手前の透け具合（前の形。縦 3240x1920／横 1920x3240）
//  frame：手前の色｜手前の透け具合（これからの形。縦 2160x1920／横 1920x2160／3:4 2160x1440〈直し09〉）
const KYON_FORMS = [
  { form: 'full', o: 'v', w: 3240, h: 1920, axis: 'x', n: 3 },
  { form: 'full', o: 'h', w: 1920, h: 3240, axis: 'y', n: 3 },
  { form: 'frame', o: 'v', w: 2160, h: 1920, axis: 'x', n: 2 },
  { form: 'frame', o: 'h', w: 1920, h: 2160, axis: 'y', n: 2 },
  { form: 'frame', o: '34', w: 2160, h: 1440, axis: 'x', n: 2 },
];
const SLOT_NAME = { fg: 'フレーム', ch: 'キャラ', bg: '背景' };
const BG_FROM_PACK_MSG = 'この素材は背景つきなので、背景の枠にも入りました（外すと別の背景に変えられます）';

// ---------- 状態 ----------
let W = 1080, H = 1440;
let ratio = '3:4';                // 選んだ向き（手持ちのフレーム・背景が無いとき）。直し09 から 3:4 が基本
cv.width = W; cv.height = H;      // index.html の canvas の大きさと食い違わないように
const slots = { fg: null, ch: null, bg: null };
const trialCache = new Map();     // パス → Promise<blob の URL>
const ch = { x: 540, y: 720, s: 1, flip: false };
let chMoved = false;
let recording = false;
let lastOut = null;               // { blob, name, kind }
let pick = null;                  // スポイトで抜く色を選んでいるレイヤー

let procCh = null, procFg = null, glError = '';
try {
  if (webglAvailable()) { procCh = new GLProc(); procFg = new GLProc(); }
  else glError = 'WebGL なし';
} catch (e) { glError = String(e && e.message || e); }

// ---------- 小さな道具 ----------
const statusEl = $('status');
const pvMsg = $('pvMsg');
// ③ の欄と、プレビューの下（どのタブでも見える所）の両方に出す
function say(msg, warn = false) {
  statusEl.textContent = msg; statusEl.classList.toggle('warn', warn);
  pvMsg.textContent = msg; pvMsg.classList.toggle('warn', warn);
}
// その枠の下にも残す一言（直し10。プレビューの下の文は2行で切れるので、枠にも全部出す）。buttons：[[文字, 押したとき]]
function note(slot, msg, buttons = [], sayIt = true) {
  if (sayIt) say(msg, true);
  const el = $(`note-${slot}`);
  if (!el) return;
  el.textContent = '';
  const s = document.createElement('span'); s.textContent = msg; el.appendChild(s);
  for (const [label, fn] of buttons) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn ghost mini'; b.textContent = label;
    b.addEventListener('click', () => { clearNote(slot); fn(); });
    el.appendChild(b);
  }
  el.hidden = false;
}
function clearNote(slot) { const el = $(`note-${slot}`); if (el) { el.hidden = true; el.textContent = ''; } }

function extOf(name) { const m = /\.([a-z0-9]+)$/i.exec(name || ''); return m ? m[1].toLowerCase() : ''; }
function kindOf(file) {
  const t = file.type || '';
  if (t.startsWith('image/')) return 'image';
  if (t.startsWith('video/')) return 'video';
  const e = extOf(file.name);
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'heic', 'heif', 'avif'].includes(e)) return 'image';
  if (['mp4', 'mov', 'm4v', 'webm'].includes(e)) return 'video';
  return null;
}

// ---------- 読み込めなかったときの理由と文言 ----------
//  net：通信がうまくいかなかった（公開したあとはネット、ローカルではパソコンの中のサーバー）
//  missing：素材のファイルが見つからない（404 など）／decode：ファイルの形が読めない
// ローカル：このパソコン（ローカルで開く）か、家の中のアドレス（スマホで確かめる：直し04）
const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
  || /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(location.hostname);
function fail(kind, detail) { const e = new Error(detail || kind); e.kind = kind; return e; }
const MSG = {
  net: isLocal
    ? '通信がうまくいきませんでした。パソコンの黒い窓（ローカルで開く・スマホで確かめる）が開いたままか確かめて、もう一度選んでください。'
    : '通信がうまくいきませんでした。もう一度選んでください。',
  trial: '素材を読み込めませんでした。ページを読み直して（Ctrl＋F5／スマホは更新）、もう一度選んでください。',
  format: 'このファイルは読み込めませんでした。PNG・JPG・MP4・WebM を選んでください。',
  bigVideo: '動画が大きすぎます（200MBまで）。短く切るか、小さくしてから入れてください。',
  bigImage: '画像が大きすぎます（縦・横とも8000ピクセルまで）。小さくしてから入れてください。',
  // 直し10：その形のファイルを入れたときだけ出す一言
  webkitWebm: 'iPhone・Mac の Safari では、透過 WebM の透明が使えません。透明の PNG を使うか、パソコンの Chrome・Edge で作ってください。',
  gif: 'GIF は使えません。透明の PNG か、動かしたいときは WebM・MP4 を使ってください。',
  animWebp: '動く WebP は、止まった画像として入ります。',
  opaqueFrame: '透明の所がない画像です。背景の枠に入れますか？',
  hevc: 'この動画の形（HEVC／H.265 など）は、このブラウザでは読めません。Chrome で開くか、H.264 の MP4 に書き出してください。',
  mov: '透過 MOV（ProRes）は使えません。WebM（VP9）か PNG に書き出してください。',
  keyInFrame: 'キャラの動画なら、キャラの枠に入れてください。',
  webmFrozen: 'この端末では、この透過 WebM が動きません（止まった画像として入ります）。動かしたいときは、パソコンの Chrome・Edge で作ってください。',
};

// ---------- ファイルの形を見分ける（直し10） ----------
// Safari（WebKit）か。iPhone・iPad はどのブラウザも中身は WebKit
const UA = navigator.userAgent;
const isAppleMobile = /iPhone|iPad|iPod/.test(UA) || (/Macintosh/.test(UA) && navigator.maxTouchPoints > 1);
const isWebKit = isAppleMobile || (/AppleWebKit/.test(UA) && !/Chrome|Chromium|CriOS|Edg|OPR|Android/.test(UA));
const isGif = (f) => f.type === 'image/gif' || extOf(f.name) === 'gif';
const isWebm = (f) => f.type === 'video/webm' || extOf(f.name) === 'webm';
const isWebp = (f) => f.type === 'image/webp' || extOf(f.name) === 'webp';
async function headBytes(f, n) { return new Uint8Array(await f.slice(0, n).arrayBuffer()); }
// WebM に透明（AlphaMode = 1）が入っているか → true / false
async function webmHasAlpha(f) {
  try {
    const b = await headBytes(f, 512 * 1024);
    for (let i = 0; i + 3 < b.length; i++) if (b[i] === 0x53 && b[i + 1] === 0xC0 && b[i + 2] === 0x81 && b[i + 3] === 0x01) return true;
  } catch (e) { /* 分からないときは透明なしとみなす */ }
  return false;
}
// 動く WebP か（VP8X の「アニメーション」の印）
async function isAnimatedWebp(f) {
  try {
    const b = await headBytes(f, 32);
    const s = (i, n) => String.fromCharCode(...b.slice(i, i + n));
    return s(0, 4) === 'RIFF' && s(8, 4) === 'WEBP' && s(12, 4) === 'VP8X' && (b[20] & 0x02) !== 0;
  } catch (e) { return false; }
}
// MP4・MOV の中の動画の形（stsd の4文字：avc1・hvc1・apch など）。moov が後ろにあるファイルも、箱の頭だけ読んで探す
const PRORES = ['apch', 'apcn', 'apcs', 'apco', 'ap4h', 'ap4x', 'aprh', 'aprn'];
const HEVC = ['hvc1', 'hev1', 'dvh1', 'dvhe'];
async function movieCodecs(f) {
  const out = [];
  try {
    let pos = 0;
    for (let n = 0; n < 200 && pos + 8 <= f.size; n++) {
      const h = new DataView(await f.slice(pos, pos + 16).arrayBuffer());
      let size = h.getUint32(0);
      const type = String.fromCharCode(h.getUint8(4), h.getUint8(5), h.getUint8(6), h.getUint8(7));
      if (size === 1 && h.byteLength >= 16) size = h.getUint32(8) * 4294967296 + h.getUint32(12);
      else if (size === 0) size = f.size - pos;
      if (type === 'moov') {
        const m = new Uint8Array(await f.slice(pos, pos + Math.min(size, 32 * 1024 * 1024)).arrayBuffer());
        for (let i = 0; i + 20 <= m.length; i++) {
          if (m[i] === 0x73 && m[i + 1] === 0x74 && m[i + 2] === 0x73 && m[i + 3] === 0x64) { // 'stsd'
            out.push(String.fromCharCode(m[i + 16], m[i + 17], m[i + 18], m[i + 19]));
          }
        }
        break;
      }
      if (size < 8) break;
      pos += size;
    }
  } catch (e) { /* 分からない */ }
  return out;
}
function canPlayHevc() {
  const t = 'video/mp4; codecs="hvc1.1.6.L93.B0"';
  try { if (window.MediaSource && MediaSource.isTypeSupported(t)) return true; } catch (e) { /* なし */ }
  try { return !!document.createElement('video').canPlayType(t); } catch (e) { return false; }
}
// 動画が読めなかったとき（.mp4・.mov）の一言：中の形が分かればそれで、分からなければ拡張子で
async function videoFailMsg(f) {
  const e = extOf(f.name);
  if (!['mp4', 'mov', 'm4v'].includes(e)) return MSG.format;
  const cs = await movieCodecs(f);
  if (cs.some((c) => PRORES.includes(c))) return MSG.mov;
  if (cs.some((c) => HEVC.includes(c))) return MSG.hevc;
  return e === 'mov' ? MSG.mov : MSG.hevc;
}
const MAX_IMAGE_SIDE = 8000;
const LOAD_TIMEOUT_MS = 20000;

function loadImage(url) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.decoding = 'async';
    im.onload = () => res(im);
    im.onerror = () => rej(fail('decode', 'image'));
    im.src = url;
  });
}

function loadVideo(url) {
  return new Promise((res, rej) => {
    const v = document.createElement('video');
    v.muted = true; v.defaultMuted = true; v.loop = true; v.playsInline = true;
    v.setAttribute('playsinline', ''); v.setAttribute('muted', '');
    v.preload = 'auto';
    let done = false;
    v.addEventListener('loadeddata', () => { if (done) return; done = true; clearTimeout(t); v.play().catch(() => {}); res(v); }, { once: true });
    v.addEventListener('error', () => { if (done) return; done = true; clearTimeout(t); v.remove(); rej(fail('decode', 'video')); }, { once: true });
    // いつまでも読み終わらない形（一部の MOV など）は、読めないものとして扱う
    const t = setTimeout(() => { if (done) return; done = true; v.removeAttribute('src'); v.load(); v.remove(); rej(fail('decode', 'video timeout')); }, LOAD_TIMEOUT_MS);
    holder.appendChild(v);
    v.src = url;
    v.load();
  });
}

// 中身の大きさ（パックは1コマの大きさ）
function elSize(el) {
  if (el instanceof HTMLVideoElement) return [el.videoWidth, el.videoHeight];
  return [el.naturalWidth, el.naturalHeight];
}

// Kyon の動フレの形かどうか → { ...KYON_FORMS の1つ, ask } | null
function kyonForm(w, h) {
  const exact = KYON_FORMS.find((f) => f.w === w && f.h === h);
  if (exact) return { ...exact, ask: false };
  const near = KYON_FORMS.find((f) => Math.abs((w / h) / (f.w / f.h) - 1) < 0.01);
  return near ? { ...near, ask: true } : null;
}

// 動画を axis の向きに n 等分したときの i 番目の範囲
function paneRect(el, axis, n, i) {
  const [vw, vh] = elSize(el);
  const pw = axis === 'x' ? vw / n : vw, ph = axis === 'y' ? vh / n : vh;
  return axis === 'x' ? { x: pw * i, y: 0, w: pw, h: ph } : { x: 0, y: ph * i, w: pw, h: ph };
}

// レイヤー：{ type, name, el, w, h, rect, alphaRect, still, stillUrl, keyable, key, ks, trial, msg, urls, shared }
//  type：'image' | 'video' | 'alpha2'（色｜透け具合）| 'pack'（背景｜色｜透け具合）
//  key：背景の色を抜くか。ks：抜き方 { preset:'green'|'blue'|'pick', rgb:[0〜1], amount, soft }
//  trial：お試しの素材のとき { id, o }（URL はキャッシュで使い回すので消さない）
const KEY_PRESET = { green: [0, 1, 0], blue: [0, 0, 1] };
const newKeySet = () => ({ preset: 'green', rgb: KEY_PRESET.green, amount: KEY_DEFAULT.amount, soft: KEY_DEFAULT.soft, desp: KEY_DEFAULT.desp });
// 背景の色を抜けるのは動画と、透明を持てない画像（JPG など）。透明つきの PNG・WebP・GIF は出さない
const canHaveAlpha = (name) => ['png', 'webp', 'gif', 'avif'].includes(extOf(name));
function plainLayer(el, name, type, urls) {
  const [w, h] = elSize(el);
  return { type, name, el, w, h, rect: { x: 0, y: 0, w, h }, alphaRect: null, still: null,
    keyable: type === 'video' || (type === 'image' && !canHaveAlpha(name)), key: false, ks: newKeySet(),
    trial: null, msg: '', urls };
}
function keyOf(L) {
  const ks = L.ks;
  const k = keyParams(ks.rgb, simFromAmount(ks.amount), smoFromSoft(ks.soft)) || keyParams(KEY_PRESET.green, simFromAmount(ks.amount), smoFromSoft(ks.soft));
  // 緑かぶりの打ち消し（直し06）。つまみは 0〜200 で、真ん中の 100 がふつう（直し07）。100 より右は、ふちを広く・強く打ち消す
  const dv = ks.desp ?? KEY_DEFAULT.desp;
  k.desp = Math.min(dv, 100) / 100; k.desp2 = Math.max(0, dv - 100) / 100;
  return k;
}
function alphaLayer(video, axis, name, urls) {
  const c = paneRect(video, axis, 2, 0);
  return { type: 'alpha2', name, el: video, w: c.w, h: c.h, rect: c, alphaRect: paneRect(video, axis, 2, 1),
    still: null, keyable: false, key: false, trial: null, msg: '', urls };
}
function packLayers(video, axis, name, urls) {
  const shared = { urls, count: 2 };
  const r = (i) => paneRect(video, axis, 3, i);
  const base = { type: 'pack', name, el: video, w: r(0).w, h: r(0).h, still: null, keyable: false, key: false, trial: null, msg: '', shared, urls: [] };
  return {
    bg: { ...base, rect: r(0), alphaRect: null, msg: BG_FROM_PACK_MSG },
    fg: { ...base, rect: r(1), alphaRect: r(2) },
  };
}

function release(layer) {
  if (!layer) return;
  let urls = [...(layer.urls || []), ...(layer.stillUrl ? [layer.stillUrl] : [])];
  let dropEl = true;
  if (layer.shared) {
    layer.shared.count -= 1;
    if (layer.shared.count > 0) dropEl = false;
    else urls = urls.concat(layer.shared.urls);
  }
  if (dropEl && layer.el instanceof HTMLVideoElement) {
    layer.el.pause(); layer.el.removeAttribute('src'); layer.el.load(); layer.el.remove();
  }
  if (!layer.trial) urls.forEach((u) => URL.revokeObjectURL(u));
}

function setSlot(name, layer) {
  if (pick && pick === slots[name]) stopPick();
  release(slots[name]);
  slots[name] = layer;
}
const isMine = (L) => !!(L && !L.trial); // 手持ちの素材か

// ---------- 画面の大きさ ----------
function sizeForRatio(ar) {
  const near = (a, b) => Math.abs(a / b - 1) < 0.01;
  if (near(ar, 3 / 4)) return [1080, 1440]; // 1024x1365 など、ぴったりでない 3:4 も
  if (near(ar, 9 / 16)) return [1080, 1920];
  if (near(ar, 16 / 9)) return [1920, 1080];
  if (near(ar, 1)) return [1080, 1080];
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  return ar < 1 ? [even(1920 * ar), 1920] : [1920, even(1920 / ar)];
}
function ratioLabel() {
  if (W === 1080 && H === 1920) return '9x16';
  if (W === 1920 && H === 1080) return '16x9';
  if (W === 1080 && H === 1080) return '1x1';
  return `${W}x${H}`; // 3:4 は 1080x1440（直し09：画素数で書く）
}
function ratioName() {
  const l = ratioLabel();
  if (l === '9x16') return '縦 9:16';
  if (l === '16x9') return '横 16:9';
  if (l === '1x1') return '正方形 1:1';
  if (W === 1080 && H === 1440) return '3:4';
  return H > W ? '縦長' : W > H ? '横長' : '正方形';
}

// 画面の大きさを何で決めているか：'frame' | 'bg' | 'trial' | 'choice'
function sizeSource() {
  if (isMine(slots.fg)) return 'frame';
  if (isMine(slots.bg)) return 'bg';
  if ((slots.fg && slots.fg.trial) || (slots.bg && slots.bg.trial)) return 'trial';
  return 'choice';
}
// お試しのフレーム・背景に使う向き
// 縦長は、3:4 と 9:16 のどちらに近いかで選ぶ（正方形・4:5 などは 3:4 版）
const PORTRAIT_34 = (3 / 4 + 9 / 16) / 2;
function trialOrient() { return W > H ? 'h' : W / H >= PORTRAIT_34 ? '34' : 'v'; }
function ratioOfSize() { return W > H ? '16:9' : W === H ? '1:1' : W / H >= PORTRAIT_34 ? '3:4' : '9:16'; }

let lastSrc = 'choice';
function updateSize() {
  const src = sizeSource();
  // 手持ちのフレーム・背景を外したときは、それまでの向きを引き継ぐ
  if ((lastSrc === 'frame' || lastSrc === 'bg') && (src === 'trial' || src === 'choice')) {
    ratio = ratioOfSize();
  }
  lastSrc = src;
  if (src === 'trial' && ratio === '1:1') ratio = '3:4'; // お試しの素材は 3:4・縦・横だけ
  let nw, nh;
  if (src === 'frame') [nw, nh] = sizeForRatio(slots.fg.w / slots.fg.h);
  else if (src === 'bg') [nw, nh] = sizeForRatio(slots.bg.w / slots.bg.h);
  else { const [a, b] = ratio.split(':').map(Number); [nw, nh] = sizeForRatio(a / b); }
  if (nw !== W || nh !== H) {
    const rx = ch.x / W, ry = ch.y / H, rs = ch.s / H;
    W = nw; H = nh; cv.width = W; cv.height = H;
    ch.x = rx * W; ch.y = ry * H; ch.s = rs * H;
  }
  fitStage();
  // お試しのフレーム・背景を、画面の向きに合う版に入れ替える
  const o = trialOrient();
  for (const k of ['fg', 'bg']) {
    const L = slots[k];
    if (L && L.trial && L.trial.o !== o) {
      const m = MATERIALS[k].find((x) => x.id === L.trial.id);
      if (m) putTrial(k, m, o);
    }
  }
}

// プレビューを、プレビューの箱に収まるいちばん大きい大きさにする（縦長の画面でも横長の画面でも）
function fitStage() {
  const box = fsOpen ? $('fsBox') : $('stageBox');
  const cs = getComputedStyle(box); // 箱の余白（全画面の箱は上下に余白がある）は除く
  const bw = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const bh = box.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  if (!bw || !bh) return;
  const s = Math.min(bw / W, bh / H);
  const st = $('stage');
  st.style.width = `${Math.floor(W * s)}px`;
  st.style.height = `${Math.floor(H * s)}px`;
}
let fsOpen = false; // 全画面で合わせる（直し06）を開いているか
if (window.ResizeObserver) { const ro = new ResizeObserver(fitStage); ro.observe($('stageBox')); ro.observe($('fsBox')); }
else window.addEventListener('resize', fitStage);

const WHY = {
  frame: 'フレームに合わせています',
  bg: '背景に合わせています',
  trial: 'お試しの素材の向き',
  choice: '選んだ向き（何も入っていないとき）',
};
function updateOrientUI() {
  const src = sizeSource();
  $('sizeNow').textContent = `いまの画面：${ratioName()}（${W}×${H}）・${WHY[src]}`;
  $('pvSize').textContent = `${ratioName()}（${W}×${H}）・${WHY[src]}`;
  const row = $('orientRow');
  const why = $('orientWhy');
  if (src === 'frame' || src === 'bg') {
    row.hidden = true;
    why.hidden = false;
    why.textContent = `手持ちの${src === 'frame' ? 'フレーム' : '背景'}が入っているので、向きはそれに合わせています。変えたいときは、その素材を外してください。`;
    return;
  }
  row.hidden = false;
  why.hidden = true;
  row.querySelectorAll('button').forEach((b) => {
    const r = b.dataset.ratio;
    b.hidden = src === 'trial' && r === '1:1';
    b.setAttribute('aria-pressed', String(r === ratio));
    b.disabled = recording;
  });
}

$('orientRow').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-ratio]');
  if (!b || recording) return;
  ratio = b.dataset.ratio;
  updateSize();
  if (slots.ch && !chMoved) resetChar();
  refreshUI();
});

// ---------- キャラの位置 ----------
function resetChar() {
  const L = slots.ch;
  if (!L) return;
  ch.s = H / L.h;            // 画面の高さに合わせて
  ch.x = W / 2; ch.y = H / 2; // 真ん中
  ch.flip = false;
}
function zoomAt(px, py, f) {
  if (!slots.ch) return;
  const base = H / slots.ch.h;
  const ns = Math.min(base * 20, Math.max(base * 0.05, ch.s * f));
  const k = ns / ch.s;
  ch.x = px + (ch.x - px) * k; ch.y = py + (ch.y - py) * k; ch.s = ns;
}

// ---------- 描く ----------
function cover(sw, sh) {
  const s = Math.max(W / sw, H / sh);
  const dw = sw * s, dh = sh * s;
  return [(W - dw) / 2, (H - dh) / 2, dw, dh];
}

// レイヤーを描ける形にする → { img, sx, sy, sw, sh } | null
function sourceOf(L, still, proc) {
  if (still && L.still) return { img: L.still, sx: 0, sy: 0, sw: L.still.naturalWidth, sh: L.still.naturalHeight };
  const el = L.el;
  if (el instanceof HTMLVideoElement && el.readyState < 2) return null;
  const [ew, eh] = elSize(el);
  if (!ew || !eh) return null;
  // スポイトで色を選んでいる間は、抜く前の姿を見せる
  const needGL = L.alphaRect || (L.keyable && L.key && pick !== L && rawView !== L);
  if (needGL && proc) {
    let ow = Math.round(L.rect.w), oh = Math.round(L.rect.h);
    const cap = 1920 / Math.max(ow, oh);
    if (cap < 1) { ow = Math.round(ow * cap); oh = Math.round(oh * cap); }
    const c = proc.render(el, ew, eh, L.rect, L.alphaRect, L.alphaRect ? 1 : 2, ow, oh, L.alphaRect ? null : keyOf(L));
    return { img: c, sx: 0, sy: 0, sw: ow, sh: oh };
  }
  if (needGL && !proc) return L.alphaRect ? null : { img: el, sx: 0, sy: 0, sw: ew, sh: eh };
  // 透過 WebM が止まって見える端末（Android の Chrome）向けの、別の描き方（直し10。watchFrozen が切り替える）
  if (L.drawWay === 1 && el instanceof HTMLVideoElement) {
    try {
      const f = new VideoFrame(el);
      const c = L.vfCanvas || (L.vfCanvas = document.createElement('canvas'));
      if (c.width !== ew || c.height !== eh) { c.width = ew; c.height = eh; }
      const x = c.getContext('2d');
      x.clearRect(0, 0, ew, eh); x.drawImage(f, 0, 0, ew, eh); f.close();
      return { img: c, sx: L.rect.x, sy: L.rect.y, sw: L.rect.w, sh: L.rect.h };
    } catch (e) { /* ふつうの描き方で */ }
  }
  if (L.drawWay === 2 && proc && el instanceof HTMLVideoElement) {
    let ow = Math.round(L.rect.w), oh = Math.round(L.rect.h);
    const cap = 1920 / Math.max(ow, oh);
    if (cap < 1) { ow = Math.round(ow * cap); oh = Math.round(oh * cap); }
    return { img: proc.render(el, ew, eh, L.rect, null, 3, ow, oh, null), sx: 0, sy: 0, sw: ow, sh: oh };
  }
  return { img: el, sx: L.rect.x, sy: L.rect.y, sw: L.rect.w, sh: L.rect.h };
}

// ---------- 透過 WebM が止まって見えないかの見張り（直し10） ----------
// Android の Chrome で、透過 WebM（VP9 の透明つき）が、時計は進んでいるのに1コマ目のまま描かれた。
//  時計が 2.5 秒進んでも絵が変わらなければ、ふつう → VideoFrame → WebGL の順に描き方を替える。
//  どれでも変わらなければ、止まった画像として使ってもらう一言を出す。MP4（Kyon の動フレなど）は見張らない
const DRAW_WAY_NAME = ['ふつう', 'VideoFrame', 'WebGL'];
const probe = document.createElement('canvas'); probe.width = 48; probe.height = 64;
const probeCtx = probe.getContext('2d', { willReadFrequently: true });
const procOf = (k) => (k === 'fg' ? procFg : k === 'ch' ? procCh : null);
function probeHash(L, proc) {
  const s = sourceOf(L, false, proc);
  if (!s) return null;
  probeCtx.clearRect(0, 0, 48, 64);
  probeCtx.drawImage(s.img, s.sx, s.sy, s.sw, s.sh, 0, 0, 48, 64);
  const d = probeCtx.getImageData(0, 0, 48, 64).data;
  let h = 0;
  for (let i = 0; i < d.length; i++) h = (Math.imul(h, 31) + d[i]) | 0;
  return h;
}
function nextDrawWay(L, proc) {
  for (let w = (L.drawWay || 0) + 1; w < DRAW_WAY_NAME.length; w++) {
    if (w === 1 && typeof VideoFrame === 'function') return w;
    if (w === 2 && proc) return w;
  }
  return -1;
}
function watchFrozen() {
  if (recording || makingPng || document.hidden) return;
  for (const k of ['fg', 'ch', 'bg']) {
    const L = slots[k];
    if (!L || !L.watch || L.watch.done) continue;
    const v = L.el, w = L.watch;
    if (v.paused || v.readyState < 2 || !(v.duration > 0.6)) continue;
    if (L.key) continue; // 色を抜いているときは、もともと WebGL で描いている
    const proc = procOf(k);
    let h;
    try { h = probeHash(L, proc); } catch (e) { w.done = true; continue; }
    if (h === null) continue;
    const t = v.currentTime;
    if (w.h === undefined) { w.h = h; w.t = t; continue; }
    let dt = t - w.t; if (dt < 0) dt += v.duration; w.t = t;
    if (dt < 0.01) { if (++w.stuck % 6 === 0) v.play().catch(() => {}); continue; } // 時計が止まっていたら、再生し直す
    if (h !== w.h) { w.h = h; if (++w.changes >= 2) { w.done = true; diag(); } continue; } // 動いている
    w.still += dt;
    if (w.still < 2.5) continue;
    // 時計は進んでいるのに絵が変わらない → 次の描き方を試す
    w.still = 0; w.h = undefined; w.changes = 0;
    const next = nextDrawWay(L, proc);
    if (next < 0) { w.done = true; L.drawWay = 0; L.frozen = true; note(k, MSG.webmFrozen); }
    else L.drawWay = next;
    diag();
  }
}
setInterval(watchFrozen, 500);

function drawFull(L, still, proc) {
  const s = sourceOf(L, still, proc);
  if (!s) return;
  const [dx, dy, dw, dh] = cover(s.sw, s.sh);
  ctx.drawImage(s.img, s.sx, s.sy, s.sw, s.sh, dx, dy, dw, dh);
}

function drawChar(still) {
  const L = slots.ch;
  if (!L) return;
  const s = sourceOf(L, still, procCh);
  if (!s) return;
  ctx.save();
  ctx.translate(ch.x, ch.y);
  ctx.scale(ch.flip ? -ch.s : ch.s, ch.s);
  // 元の大きさ（L.w × L.h）で、中心を基準に描く
  ctx.drawImage(s.img, s.sx, s.sy, s.sw, s.sh, -L.w / 2, -L.h / 2, L.w, L.h);
  ctx.restore();
}

function render(still = false, forVideo = false) {
  ctx.clearRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (slots.bg) drawFull(slots.bg, still, null);
  else if (forVideo) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H); }
  drawChar(still);
  if (slots.fg) drawFull(slots.fg, still, procFg);
}

function loop() {
  render(false, recording);
  if (loupeAt) drawLoupe();
  requestAnimationFrame(loop);
}

// ---------- お試しの素材 ----------
// 同じサイトから fetch して blob: の URL にしてから使う（読み終われば機内モードでも最後まで作れる）
function fetchCached(path, onBytes) {
  if (trialCache.has(path)) { onBytes && onBytes(1, 1); return trialCache.get(path); }
  const p = (async () => {
    // パスには ?v= の版の数字が付いている（materials.js）。素材を差し替えたら数字を変える
    let r;
    try { r = await fetch(path); } catch (e) { throw fail('net', `${path}: ${e.message}`); }
    if (!r.ok) throw fail('missing', `${path}: ${r.status}`);
    const total = Number(r.headers.get('content-length')) || 0;
    const type = r.headers.get('content-type') || '';
    if (!r.body || !r.body.getReader) { const b = await r.blob(); onBytes && onBytes(b.size, b.size); return URL.createObjectURL(b); }
    const reader = r.body.getReader();
    const parts = []; let got = 0;
    for (;;) {
      let done, value;
      try { ({ done, value } = await reader.read()); } catch (e) { throw fail('net', `${path}: ${e.message}`); }
      if (done) break;
      parts.push(value); got += value.length; onBytes && onBytes(got, total);
    }
    return URL.createObjectURL(new Blob(parts, { type }));
  })();
  p.catch(() => trialCache.delete(path));
  trialCache.set(path, p);
  return p;
}

// お試しの素材を入れるときの向き
function wantedTrialOrient() {
  const src = sizeSource();
  if (src === 'frame' || src === 'bg') return trialOrient();
  return ratio === '16:9' ? 'h' : ratio === '9:16' ? 'v' : '34';
}

const trialToken = { fg: 0, ch: 0, bg: 0 };
async function putTrial(slot, m, o) {
  if (recording) return;
  const spec = m[o] || m.v;
  // 緑の背景のままの素材は、色を抜けない端末（WebGL なし）では緑の四角のままになるので入れない
  if (spec.key && !procCh) { say('この端末では背景の色を抜けないため、お試しのキャラは使えません。背景が透明なPNGの立ち絵を「手持ちを選ぶ」で入れてください。', true); return; }
  const tok = ++trialToken[slot];
  const loading = $('loading');
  loading.hidden = false; loading.textContent = '素材を読み込んでいます…';
  say(`「${m.name}」を読み込んでいます…`);
  // 押したボタンにも、読み込み中と出す
  const btn = document.querySelector(`.mat[data-slot="${slot}"][data-id="${m.id}"]`);
  const small = btn && btn.querySelector('small');
  document.querySelectorAll(`.mat[data-slot="${slot}"]`).forEach((b) => { b.classList.remove('busy'); const s = b.querySelector('small'); if (s) s.textContent = b.dataset.note || ''; });
  if (btn) { btn.classList.add('busy'); small.textContent = '読み込み中…'; }
  const got = new Map(), tot = new Map();
  let over = false; // 失敗したら、もう一方のファイルの進み具合で文言を上書きしない
  const tick = (path) => (g, t) => {
    got.set(path, g); tot.set(path, t || g);
    if (over || tok !== trialToken[slot]) return;
    const G = [...got.values()].reduce((a, b) => a + b, 0), T = [...tot.values()].reduce((a, b) => a + b, 0);
    const msg = T ? `素材を読み込んでいます…（${Math.min(99, Math.floor((G / T) * 100))}％）` : '素材を読み込んでいます…';
    loading.textContent = msg; say(msg);
  };
  try {
    // still が無い素材（緑の背景のままのキャラ）は、動画のそのときのコマから静止画を作る
    const [vu, su] = await Promise.all([fetchCached(spec.video, tick(spec.video)), spec.still ? fetchCached(spec.still, tick(spec.still)) : null]);
    if (tok !== trialToken[slot]) return;
    const still = su ? await loadImage(su) : null;
    const v = await loadVideo(vu);
    if (tok !== trialToken[slot] || recording) { v.pause(); v.remove(); return; }
    const L = spec.type === 'alpha2' ? alphaLayer(v, spec.axis, m.name, []) : plainLayer(v, m.name, 'video', []);
    L.keyable = false; L.still = still; L.trial = { id: m.id, o };
    // 緑や青の背景のままの素材：「背景の色を抜く」を入れた状態で置く（使う人が自分の動画を抜くときの見本）
    if (spec.key) {
      L.keyable = true; L.key = true;
      L.ks = { preset: spec.key.preset, rgb: KEY_PRESET[spec.key.preset], amount: spec.key.amount ?? KEY_DEFAULT.amount, soft: spec.key.soft ?? KEY_DEFAULT.soft, desp: spec.key.desp ?? KEY_DEFAULT.desp };
    }
    setSlot(slot, L);
    clearNote(slot);
    if (slot === 'ch') { chMoved = false; resetChar(); }
    else { updateSize(); if (slots.ch && !chMoved) resetChar(); }
    refreshUI();
    say(`${SLOT_NAME[slot]}の枠に「${m.name}」を入れました`);
    // 向きを変えても機内モードのまま作れるように、もう一方の向きも読んでおく
    for (const oo of ORIENTS) {
      const other = oo !== o && m[oo];
      if (other) { fetchCached(other.video).catch(() => {}); if (other.still) fetchCached(other.still).catch(() => {}); }
    }
  } catch (e) {
    over = true;
    if (tok === trialToken[slot]) {
      say(e && e.kind === 'net' ? MSG.net : MSG.trial, true);
      lastErr = `${m.id}: ${e && e.kind || '?'} ${e && e.message || e}`;
      diag();
    }
  } finally {
    if (tok === trialToken[slot]) {
      loading.hidden = true;
      if (btn) { btn.classList.remove('busy'); small.textContent = m.note || ''; }
    }
  }
}

function buildTrialButtons() {
  for (const k of ['fg', 'ch', 'bg']) {
    const box = $(`trial-${k}`);
    for (const m of MATERIALS[k] || []) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'mat'; b.dataset.id = m.id; b.dataset.slot = k; b.dataset.note = m.note || '';
      b.setAttribute('aria-pressed', 'false');
      const im = document.createElement('img');
      im.src = m.thumb; im.alt = ''; im.loading = 'eager'; im.width = 40; im.height = 71; // 先読み（直し08）のため、サムネもすぐ読む
      const sp = document.createElement('span');
      const t = document.createElement('b'); t.textContent = m.name;
      const s = document.createElement('small'); s.textContent = m.note || '';
      sp.append(t, s);
      b.append(im, sp);
      b.addEventListener('click', () => putTrial(k, m, k === 'ch' ? 'v' : wantedTrialOrient()));
      box.appendChild(b);
    }
  }
  $('boothLink').href = BOOTH_SHOP;
}

// ---------- お試しの素材の先読み（直し08） ----------
// ページを開いたら、お試しの3つ（縦・横とも）を先に読み込んでおく。読み終われば、そのあとは機内モードでも
// お試しの素材で最後まで作れる（fetchCached が blob: にしてしまっておく）。読み込み中のボタンは「準備中…」で押せない
function trialFiles(m) {
  const out = [];
  for (const o of ORIENTS) { const sp = m[o]; if (!sp) continue; out.push(sp.video); if (sp.still) out.push(sp.still); }
  return [...new Set(out)];
}
let trialPrep = 'loading'; // 'loading' | 'ready' | 'failed'
async function preloadTrials() {
  const got = new Map(), tot = new Map();
  let lastSay = 0;
  const tick = (path) => (g, t) => {
    got.set(path, g); tot.set(path, t || g);
    if (trialPrep !== 'loading' || performance.now() - lastSay < 200) return;
    lastSay = performance.now();
    const G = [...got.values()].reduce((a, b) => a + b, 0), T = [...tot.values()].reduce((a, b) => a + b, 0);
    if (!pvMsg.classList.contains('warn')) pvMsg.textContent = `お試しの素材を準備中…${T ? `（${Math.min(99, Math.floor((G / T) * 100))}％）` : ''}`;
  };
  const jobs = [];
  for (const k of ['fg', 'ch', 'bg']) {
    for (const m of MATERIALS[k] || []) {
      const btn = document.querySelector(`.mat[data-slot="${k}"][data-id="${m.id}"]`);
      const small = btn && btn.querySelector('small');
      if (btn) { btn.dataset.prep = '1'; btn.disabled = true; small.textContent = '準備中…'; }
      const files = trialFiles(m);
      jobs.push(Promise.all(files.map((f) => fetchCached(f, tick(f)))).then(
        () => 'ok',
        (e) => { lastErr = `先読み ${m.id}: ${e && e.kind || '?'} ${e && e.message || e}`; return 'ng'; },
      ).then((r) => {
        if (btn) { delete btn.dataset.prep; btn.disabled = recording; small.textContent = m.note || ''; }
        return r;
      }));
    }
  }
  if (!pvMsg.classList.contains('warn')) pvMsg.textContent = 'お試しの素材を準備中…';
  const res = await Promise.all(jobs);
  trialPrep = res.every((r) => r === 'ok') ? 'ready' : 'failed';
  if (!pvMsg.classList.contains('warn') && !slots.fg && !slots.ch && !slots.bg) {
    if (trialPrep === 'ready') say('お試しの素材の準備ができました。ここからは機内モードにしても最後まで作れます。');
    else say('お試しの素材の一部を準備できませんでした。通信がつながっているときに、ページを読み直してください（手持ちの素材は使えます）。', true);
  }
  diag();
}

// ---------- 手持ちのファイル ----------
// 200MB を超える動画：先に読める形かを見てから、文を選ぶ（直し10：透過 MOV は「大きすぎ」ではなく「使えません」）
async function tooBig(slot, f) {
  if (kindOf(f) !== 'video' || f.size <= MAX_VIDEO_BYTES) return false;
  const cs = ['mp4', 'mov', 'm4v'].includes(extOf(f.name)) ? await movieCodecs(f) : [];
  if (cs.some((c) => PRORES.includes(c))) note(slot, MSG.mov);
  else if (cs.some((c) => HEVC.includes(c)) && !canPlayHevc()) note(slot, MSG.hevc);
  else note(slot, MSG.bigVideo);
  return true;
}

async function addFiles(slot, fileList) {
  if (recording) return;
  clearNote(slot);
  let files = [...fileList].filter((f) => kindOf(f));
  if (!files.length) { note(slot, MSG.format); return; }
  // GIF は使わない（直し10：色が少なく、荒く見えるため）。読み込まずに一言
  const hadGif = files.some(isGif);
  files = files.filter((f) => !isGif(f));
  if (!files.length) { note(slot, MSG.gif); return; }
  // Safari（WebKit）は透過 WebM の透明を黒にする（キャラ・背景が全部かくれる）ので、フレーム・キャラの枠には読み込まない
  if (isWebKit && slot !== 'bg') {
    for (const f of files) if (isWebm(f) && await webmHasAlpha(f)) { note(slot, MSG.webkitWebm); return; }
  }
  for (const f of files) if (await tooBig(slot, f)) return;
  say('読み込んでいます…');
  trialToken[slot]++; // 読み込み中のお試しの素材があれば止める
  let mainFile = null; // いま読み込んでいるファイル（読めなかったときの文を選ぶため）
  try {
    let placed = null; // 手持ちのファイルをそのまま入れたときの { L, f }
    if (slot === 'ch') {
      const f = mainFile = files[0];
      const L = await layerFromFile(f);
      autoKey(L);
      setSlot('ch', L);
      chMoved = false; resetChar();
      placed = { L, f };
      say(L.autoKey ? `キャラ：${f.name}（背景の色（${KEY_NAME[L.autoKey]}）を自動で抜きました。うまく抜けないときはスポイトで選び直してください）` : `キャラ：${f.name}`);
    } else {
      // Kyon の動フレの形なら、自動で見分けて入れる
      const vids = files.filter((f) => kindOf(f) === 'video');
      mainFile = vids[0] || null;
      const done = vids.length ? await tryKyon(vids[0], files, slot) : false;
      if (!done) {
        const plain = files.filter((f) => !/^(bg|fg)_/i.test(f.name));
        const f = mainFile = plain[0] || files[0];
        const L = await layerFromFile(f);
        if (slot === 'bg') L.keyable = false;
        else autoKey(L);
        setSlot(slot, L);
        placed = { L, f };
        // 緑の背景の動画をフレームの枠で抜いたとき：キャラの入れ間違いかもしれない（直し10）
        const extra = L.autoKey && slot === 'fg' && L.type === 'video' ? MSG.keyInFrame : '';
        say(L.autoKey ? `${SLOT_NAME[slot]}：${f.name}（背景の色（${KEY_NAME[L.autoKey]}）を自動で抜きました）${extra}` : `${SLOT_NAME[slot]}：${f.name}`);
        if (extra) note(slot, extra, [], false); // プレビューの下には「自動で抜きました」に続けて出している
      }
      updateSize();
      if (slots.ch && !chMoved) resetChar();
    }
    // 長すぎる動画は、はじめの15秒だけ使う（目安を伝える）
    const L = slots[slot];
    if (L && L.el instanceof HTMLVideoElement && L.el.duration > MAX_REC_SEC + 0.05) {
      say(`${statusEl.textContent}（${Math.round(L.el.duration)}秒の動画なので、動画に保存するときは、はじめの${MAX_REC_SEC}秒を使います）`);
    }
    if (placed) await afterPlaced(slot, placed.L, placed.f);
    // GIF と一緒に選んだときは、GIF だけ読み込まなかったことを伝える（ほかの一言が出ていなければ）
    if (hadGif && $(`note-${slot}`).hidden) note(slot, MSG.gif);
  } catch (e) {
    let msg = e && e.kind === 'big' ? MSG.bigImage : MSG.format;
    if (e && e.kind === 'decode' && mainFile && kindOf(mainFile) === 'video') msg = await videoFailMsg(mainFile);
    note(slot, msg);
    lastErr = `手持ち: ${e && e.kind || '?'} ${e && e.message || e}`;
  }
  refreshUI();
}

// 手持ちのファイルを入れたあとの一言（直し10）
async function afterPlaced(slot, L, f) {
  // 動く WebP：止まった画像として入る
  if (L.type === 'image' && isWebp(f) && await isAnimatedWebp(f)) { note(slot, MSG.animWebp); return; }
  // 透明の所がない画像をフレームの枠に入れた：キャラが全部かくれるので、背景の枠に入れるかを聞く
  if (slot === 'fg' && L.type === 'image' && !L.key && fullyOpaque(L)) {
    note(slot, MSG.opaqueFrame, [
      ['背景に入れる', () => moveFrameToBg(L)],
      ['このままにする', () => {}],
    ]);
  }
}
// 画像の全体に透明な所が1つも無いか（96 画素に縮めて見る）
function fullyOpaque(L) {
  try {
    const [ew, eh] = elSize(L.el);
    const S = 96, sw = Math.max(8, Math.round(S * ew / Math.max(ew, eh))), sh = Math.max(8, Math.round(S * eh / Math.max(ew, eh)));
    const c = document.createElement('canvas'); c.width = sw; c.height = sh;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(L.el, 0, 0, ew, eh, 0, 0, sw, sh);
    const d = x.getImageData(0, 0, sw, sh).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] < 250) return false;
    return true;
  } catch (e) { return false; }
}
function moveFrameToBg(L) {
  if (recording || slots.fg !== L) return;
  if (pick === L) stopPick();
  slots.fg = null;              // 外すが、消さずに背景の枠へ移す
  L.keyable = false; L.key = false; L.autoKey = null;
  setSlot('bg', L);
  clearNote('bg');
  updateSize();
  if (slots.ch && !chMoved) resetChar();
  refreshUI();
  say(`背景：${L.name}（背景の枠に入れました）`);
}

// ふち（四隅・上下左右の端）の色を見て、緑か青の一色の背景なら → 'green' | 'blue' | null（直し07）
//  端の画素のうち 6 割以上が同じような色で、その色が緑か青のときだけ。透明な所があれば何もしない
function detectKeyColor(L) {
  try {
    const [ew, eh] = elSize(L.el);
    if (!ew || !eh) return null;
    const S = 96, sw = Math.max(8, Math.round(S * ew / Math.max(ew, eh))), sh = Math.max(8, Math.round(S * eh / Math.max(ew, eh)));
    const c = document.createElement('canvas'); c.width = sw; c.height = sh;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(L.el, L.rect.x, L.rect.y, L.rect.w, L.rect.h, 0, 0, sw, sh);
    const d = x.getImageData(0, 0, sw, sh).data;
    const px = [];
    const band = 2;
    for (let yy = 0; yy < sh; yy++) for (let xx = 0; xx < sw; xx++) {
      if (xx >= band && xx < sw - band && yy >= band && yy < sh - band) continue;
      const i = (yy * sw + xx) * 4;
      if (d[i + 3] < 250) return null;
      px.push([d[i], d[i + 1], d[i + 2]]);
    }
    const med = [0, 1, 2].map((k) => px.map((q) => q[k]).sort((a, b) => a - b)[px.length >> 1]);
    const near = px.filter((q) => Math.abs(q[0] - med[0]) + Math.abs(q[1] - med[1]) + Math.abs(q[2] - med[2]) < 60).length;
    if (near < px.length * 0.6) return null;
    const [r, g, b] = med;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    // 撮影用の緑・青は、明るくて色が濃い（紺の背景のような、くすんだ青は抜かない）
    if (mx < 90 || (mx - mn) / mx < 0.65) return null;
    let h;
    if (mx === r) h = 60 * (((g - b) / (mx - mn)) % 6); else if (mx === g) h = 60 * ((b - r) / (mx - mn) + 2); else h = 60 * ((r - g) / (mx - mn) + 4);
    if (h < 0) h += 360;
    if (h >= 75 && h <= 165) return 'green';
    if (h >= 185 && h <= 255) return 'blue';
    return null;
  } catch (e) { return null; }
}
const KEY_NAME = { green: '緑', blue: '青' };
// 端に透明な所が1つも無いか（透明を持てる形の画像でも、背景が塗りつぶしなら色を抜けるようにする：直し07）
function edgeOpaque(L) {
  try {
    const [ew, eh] = elSize(L.el);
    const c = document.createElement('canvas'); c.width = 64; c.height = 64;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(L.el, 0, 0, ew, eh, 0, 0, 64, 64);
    const d = x.getImageData(0, 0, 64, 64).data;
    for (let i = 0; i < 64; i++) for (const [xx, yy] of [[i, 0], [i, 63], [0, i], [63, i]]) if (d[(yy * 64 + xx) * 4 + 3] < 250) return false;
    return true;
  } catch (e) { return false; }
}
function autoKey(L) {
  if (!L || L.trial) return;
  if (!L.keyable && L.type === 'image' && edgeOpaque(L)) L.keyable = true;
  if (!L.keyable) return;
  const kc = detectKeyColor(L);
  if (!kc) return;
  L.key = true; L.autoKey = kc;
  L.ks = { ...newKeySet(), preset: kc, rgb: KEY_PRESET[kc] };
}

async function layerFromFile(f) {
  const url = URL.createObjectURL(f);
  try {
    if (kindOf(f) === 'image') {
      const im = await loadImage(url);
      if (Math.max(im.naturalWidth, im.naturalHeight) > MAX_IMAGE_SIDE) throw fail('big', `${im.naturalWidth}x${im.naturalHeight}`);
      return plainLayer(im, f.name, 'image', [url]);
    }
    const L = plainLayer(await loadVideo(url), f.name, 'video', [url]);
    if (isWebm(f)) { L.watch = { still: 0, stuck: 0, changes: 0 }; L.drawWay = 0; } // 止まって見えないか見張る（直し10）
    return L;
  } catch (e) { URL.revokeObjectURL(url); throw e; }
}

// 静止画用の PNG（bg_*.png・fg_*.png）が一緒に選ばれていれば、静止画の保存に使う
async function attachStill(layer, all, prefix, o) {
  const c = all.filter((x) => kindOf(x) === 'image' && x.name.toLowerCase().startsWith(prefix));
  const pf = c.find((x) => x.name.toLowerCase().includes(`_${o}.`)) || c[0];
  if (!pf) return false;
  const su = URL.createObjectURL(pf);
  try {
    const im = await loadImage(su);
    const [iw, ih] = elSize(im);
    if (Math.abs(iw / ih - layer.w / layer.h) < 0.01) { layer.still = im; layer.stillUrl = su; return true; }
  } catch (e) { /* 使わない */ }
  URL.revokeObjectURL(su);
  return false;
}

async function tryKyon(f, all, slot) {
  const url = URL.createObjectURL(f);
  let v;
  try { v = await loadVideo(url); } catch (e) { URL.revokeObjectURL(url); throw e; }
  const [vw, vh] = elSize(v);
  let k = kyonForm(vw, vh);
  if (k && k.ask) {
    const what = k.form === 'full' ? '（背景とフレームに分けて入れます）' : '（透明のフレームとして入れます）';
    if (!window.confirm(`Kyonの動フレとして読み込みますか？\n${what}`)) k = null;
  }
  if (!k) { v.pause(); v.remove(); URL.revokeObjectURL(url); return false; }
  if (k.form === 'full') {
    const L = packLayers(v, k.axis, f.name, [url]);
    const a = await attachStill(L.bg, all, 'bg_', k.o);
    const b = await attachStill(L.fg, all, 'fg_', k.o);
    setSlot('fg', L.fg); setSlot('bg', L.bg);
    const st = (a ? 1 : 0) + (b ? 1 : 0);
    say(`Kyonの動フレ（背景つき）として、フレームと背景の枠に入れました${st ? `（静止画用のPNG ${st}枚も使います）` : ''}`);
  } else {
    const L = alphaLayer(v, k.axis, f.name, [url]);
    const a = await attachStill(L, all, 'fg_', k.o);
    setSlot('fg', L);
    say(`Kyonの動フレ（フレーム）として、フレームの枠に入れました${slot === 'bg' ? '（背景ではなくフレームの形でした）' : ''}${a ? '（静止画用のPNGも使います）' : ''}`);
  }
  return true;
}

function wireSlot(name) {
  const input = $(`file-${name}`);
  input.addEventListener('change', () => {
    if (input.files && input.files.length) addFiles(name, input.files);
    input.value = '';
  });
  $(`rm-${name}`).addEventListener('click', () => {
    if (recording) return;
    trialToken[name]++;
    setSlot(name, null); // 並べたMP4は、外した方だけ消える（もう一方は残る）
    clearNote(name);
    if (name !== 'ch') { updateSize(); if (slots.ch && !chMoved) resetChar(); }
    refreshUI();
    say(`${SLOT_NAME[name]}を外しました`);
  });
  buildKeyBox(name);
  const box = $(`slot-${name}`);
  box.addEventListener('dragover', (e) => { e.preventDefault(); box.classList.add('drag'); });
  box.addEventListener('dragleave', () => box.classList.remove('drag'));
  box.addEventListener('drop', (e) => {
    e.preventDefault(); box.classList.remove('drag');
    if (e.dataTransfer && e.dataTransfer.files.length) addFiles(name, e.dataTransfer.files);
  });
}
// ---------- 背景の色を抜く ----------
function buildKeyBox(k) {
  const row = $(`keyrow-${k}`);
  if (!row) return;
  row.innerHTML = `
    <p class="slot-msg auto-msg" id="auto-${k}" hidden><span id="autotxt-${k}"></span> <button type="button" class="btn ghost mini" id="autooff-${k}">外す</button></p>
    <label class="ck"><input type="checkbox" id="key-${k}">背景の色を抜く</label>
    <div class="keybox" id="keybox-${k}" hidden>
      <div class="row" role="group" aria-label="抜く色">
        <button type="button" class="btn ghost" data-kp="green" aria-pressed="true">緑</button>
        <button type="button" class="btn ghost" data-kp="blue" aria-pressed="false">青</button>
        <button type="button" class="btn ghost" data-kp="pick" aria-pressed="false">スポイト</button>
        <span class="swatch" id="sw-${k}" title="抜く色"></span>
      </div>
      <button type="button" class="btn primary" id="keyfs-${k}">全画面で調整する</button>
      <label class="range"><span>抜き具合</span><input type="range" id="amt-${k}" min="0" max="100" step="1"></label>
      <label class="range"><span>ふちのなじませ</span><input type="range" id="soft-${k}" min="0" max="100" step="1"></label>
      <label class="range"><span>緑かぶりの打ち消し</span><input type="range" id="desp-${k}" min="0" max="200" step="1"></label>
      <p class="note small">緑かぶりの打ち消し：ふちに残る抜く色（緑など）を消します。はじめは真ん中。髪のふちに色が残るときは右へ（強める）、髪・目・服の抜く色に近い色がくすむときは左へ（弱める）。</p>
      <p class="note small">スポイト：押すと全画面になります。抜きたい背景の所に指（マウス）を置くと虫めがねが出るので、見ながら離す（クリックする）と、その色を抜きます。髪や服に緑が入っているときは、青の背景で撮って「青」を使うと残せます。</p>
    </div>`;
  $(`keyfs-${k}`).addEventListener('click', () => openKeyFs(k));
  $(`autooff-${k}`).addEventListener('click', () => {
    const L = slots[k]; if (!L) return;
    L.key = false; L.autoKey = null;
    if (pick === L) stopPick();
    syncKeyBox(k);
    say('背景の色を抜くのを外しました');
  });
  $(`key-${k}`).addEventListener('change', (e) => {
    const L = slots[k]; if (!L) return;
    L.key = e.target.checked; L.autoKey = null;
    if (!L.key && pick === L) stopPick();
    syncKeyBox(k);
  });
  row.querySelectorAll('[data-kp]').forEach((b) => b.addEventListener('click', () => {
    const L = slots[k]; if (!L || recording) return;
    const kp = b.dataset.kp;
    if (kp === 'pick') { if (pick === L) stopPick(); else startPick(L); }
    else { L.ks.preset = kp; L.ks.rgb = KEY_PRESET[kp]; if (pick === L) stopPick(); say(`${kp === 'green' ? '緑' : '青'}を抜きます`); }
    syncKeyBox(k);
  }));
  $(`amt-${k}`).addEventListener('input', (e) => { const L = slots[k]; if (L) { L.ks.amount = Number(e.target.value); diag(); } });
  $(`soft-${k}`).addEventListener('input', (e) => { const L = slots[k]; if (L) { L.ks.soft = Number(e.target.value); diag(); } });
  $(`desp-${k}`).addEventListener('input', (e) => { const L = slots[k]; if (L) { L.ks.desp = Number(e.target.value); diag(); } });
}

function syncKeyBox(k) {
  const row = $(`keyrow-${k}`);
  if (!row) return;
  const L = slots[k];
  row.hidden = !(L && L.keyable);
  if (!L || !L.keyable) return;
  $(`key-${k}`).checked = !!L.key;
  $(`keybox-${k}`).hidden = !L.key;
  $(`auto-${k}`).hidden = !(L.key && L.autoKey);
  if (L.autoKey) $(`autotxt-${k}`).textContent = `背景の色（${KEY_NAME[L.autoKey]}）を自動で抜きました。うまく抜けないときはスポイトで選び直してください。`;
  row.querySelectorAll('[data-kp]').forEach((b) => {
    const on = b.dataset.kp === 'pick' ? (pick === L || L.ks.preset === 'pick') : (pick !== L && L.ks.preset === b.dataset.kp);
    b.setAttribute('aria-pressed', String(on));
    b.disabled = recording;
  });
  $(`keyfs-${k}`).disabled = recording;
  const [r, g, b] = L.ks.rgb.map((v) => Math.round(v * 255));
  $(`sw-${k}`).style.background = `rgb(${r}, ${g}, ${b})`;
  $(`amt-${k}`).value = String(L.ks.amount);
  $(`soft-${k}`).value = String(L.ks.soft);
  $(`desp-${k}`).value = String(L.ks.desp ?? KEY_DEFAULT.desp);
  diag();
}

// スポイト（直し07）：押すと全画面になり、指（マウス）を置いた所を虫めがねで拡大して見せる。離した所の色を抜いて、結果を見せる
function startPick(L) {
  pick = L;
  pickPtr = null;
  $('fs').classList.remove('adj');
  $('pv').classList.add('picking');
  openFs(true);
  $('fs').classList.add('pick'); $('fs').classList.remove('picked');
  $('fsHint').textContent = isTouch
    ? '抜きたい背景の所に指を置いて、虫めがねで見ながら離してください'
    : '抜きたい背景の所にマウスを合わせて、虫めがねで見ながらクリックしてください';
  say('スポイト：抜きたい背景の所を選んでください');
  refreshKeyBoxes();
}
function stopPick() {
  pick = null; pickPtr = null;
  $('pv').classList.remove('picking');
  $('fs').classList.remove('pick');
  hideLoupe();
}
function refreshKeyBoxes() { syncKeyBox('ch'); syncKeyBox('fg'); }
let pickPtr = null, pickLayer = null;
// 虫めがね：指の少し上に丸く出す。真ん中に十字
const loupe = $('loupe');
let loupeAt = null; // { cx, cy }（画面の座標）
function showLoupe(e) { loupeAt = { cx: e.clientX, cy: e.clientY }; loupe.hidden = false; drawLoupe(); }
function hideLoupe() { loupeAt = null; loupe.hidden = true; }
function drawLoupe() {
  if (!loupeAt) return;
  const D = 132, Z = 4; // 大きさ（CSS px）・倍率（画面に見えている大きさの何倍か）
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  if (loupe.width !== Math.round(D * dpr)) { loupe.width = loupe.height = Math.round(D * dpr); }
  const r = cv.getBoundingClientRect();
  const px = (loupeAt.cx - r.left) * W / r.width, py = (loupeAt.cy - r.top) * H / r.height;
  const sw = (D / Z) * (W / r.width);
  const x = loupe.getContext('2d');
  x.imageSmoothingEnabled = false;
  x.fillStyle = '#cfd5e2'; x.fillRect(0, 0, loupe.width, loupe.height);
  x.drawImage(cv, px - sw / 2, py - sw / 2, sw, sw, 0, 0, loupe.width, loupe.height);
  const m = loupe.width / 2, a = 10 * dpr, g = 3 * dpr;
  x.beginPath();
  x.moveTo(m - a, m); x.lineTo(m - g, m); x.moveTo(m + g, m); x.lineTo(m + a, m);
  x.moveTo(m, m - a); x.lineTo(m, m - g); x.moveTo(m, m + g); x.lineTo(m, m + a);
  x.lineWidth = 3 * dpr; x.strokeStyle = 'rgba(0,0,0,.6)'; x.stroke();
  x.lineWidth = 1.5 * dpr; x.strokeStyle = '#fff'; x.stroke();
  // 置く場所：指の上（はみ出すときは下）
  let left = loupeAt.cx - D / 2, top = loupeAt.cy - D - 34;
  if (top < 4) top = loupeAt.cy + 34;
  left = Math.max(4, Math.min(window.innerWidth - D - 4, left));
  loupe.style.left = `${left}px`; loupe.style.top = `${top}px`;
}

// プレビューの点 p（キャンバスの座標）にある、抜く前の色を取る
function samplePick(p) {
  const L = pick;
  const isCh = slots.ch === L;
  let lx, ly; // レイヤーの中の位置
  if (isCh) {
    lx = (p.x - ch.x) / (ch.flip ? -ch.s : ch.s) + L.w / 2;
    ly = (p.y - ch.y) / ch.s + L.h / 2;
  } else {
    const [dx, dy, dw, dh] = cover(L.rect.w, L.rect.h);
    lx = ((p.x - dx) / dw) * L.w; ly = ((p.y - dy) / dh) * L.h;
  }
  if (lx < 0 || ly < 0 || lx >= L.w || ly >= L.h) {
    say(`${isCh ? 'キャラ' : 'フレーム'}の外です。${isCh ? 'キャラ' : 'フレーム'}の背景の所を選んでください。`, true);
    return false;
  }
  const [ew, eh] = elSize(L.el);
  const ex = Math.min(ew - 4, Math.max(3, L.rect.x + lx * (L.rect.w / L.w)));
  const ey = Math.min(eh - 4, Math.max(3, L.rect.y + ly * (L.rect.h / L.h)));
  const c = document.createElement('canvas');
  c.width = c.height = 7;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(L.el, ex - 3, ey - 3, 7, 7, 0, 0, 7, 7);
  const d = x.getImageData(0, 0, 7, 7).data;
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) { if (d[i + 3] < 128) continue; r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
  if (!n) { say('そこは透明なので、抜く色に選べません。', true); return false; }
  const rgb = [r / n / 255, g / n / 255, b / n / 255];
  if (!keyParams(rgb, 0.1, 0.1)) {
    say('この色は色みが薄いので抜けません（白・黒・灰色は抜けません）。緑や青の背景で撮ってください。', true);
    return false;
  }
  L.ks.preset = 'pick'; L.ks.rgb = rgb; L.autoKey = null;
  stopPick();
  syncKeyBox(isCh ? 'ch' : 'fg');
  say('この色を抜きます。残りが出るときは「抜き具合」を右へ、キャラまで消えるときは左へ動かしてください。');
  return true;
}

// 枠の外に落としたときに、ブラウザがファイルを開いてしまわないように
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

// ---------- 指・マウス・キーボード ----------
const ptrs = new Map();
let pinch = null;
function toCanvas(e) {
  const r = cv.getBoundingClientRect();
  return { x: (e.clientX - r.left) * W / r.width, y: (e.clientY - r.top) * H / r.height };
}
function startPinch() {
  const [a, b] = [...ptrs.values()];
  pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, s: ch.s, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, x: ch.x, y: ch.y };
}
// タップ（指で触ってすぐ離す・ほとんど動かさない）を見分ける：ふだんの画面でタップしたら全画面で合わせる（直し06）
let tap = null;
cv.addEventListener('pointerdown', (e) => {
  if (pick) {
    e.preventDefault();
    pickPtr = e.pointerId;
    try { cv.setPointerCapture(e.pointerId); } catch (err) { /* なし */ }
    showLoupe(e);
    return;
  }
  if (keyAdj) { viewDown(e); return; }
  if (!slots.ch) return;
  try { cv.setPointerCapture(e.pointerId); } catch (err) { /* 指が離れたあと */ }
  ptrs.set(e.pointerId, toCanvas(e));
  tap = ptrs.size === 1 && e.pointerType !== 'mouse' && !fsOpen
    ? { id: e.pointerId, t: performance.now(), cx: e.clientX, cy: e.clientY, x: ch.x, y: ch.y, moved: chMoved } : null;
  if (ptrs.size === 2) startPinch();
});
cv.addEventListener('pointermove', (e) => {
  // スポイト：押している指についていく（マウスは押していなくても出す）
  if (pick) { if (pickPtr === e.pointerId || e.pointerType === 'mouse') showLoupe(e); return; }
  if (keyAdj) { viewMove(e); return; }
  if (!ptrs.has(e.pointerId)) return;
  const p = toCanvas(e), prev = ptrs.get(e.pointerId);
  ptrs.set(e.pointerId, p);
  if (ptrs.size === 1) { ch.x += p.x - prev.x; ch.y += p.y - prev.y; chMoved = true; }
  else if (ptrs.size === 2 && pinch) {
    const [a, b] = [...ptrs.values()];
    const base = H / slots.ch.h;
    const ns = Math.min(base * 20, Math.max(base * 0.05, pinch.s * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d));
    const k = ns / pinch.s;
    const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
    ch.s = ns;
    ch.x = cx + (pinch.x - pinch.cx) * k; ch.y = cy + (pinch.y - pinch.cy) * k;
    chMoved = true;
  }
});
cv.addEventListener('pointerleave', (e) => { if (pick && e.pointerType === 'mouse' && pickPtr === null) hideLoupe(); });
['pointerup', 'pointercancel'].forEach((ev) => cv.addEventListener(ev, (e) => {
  if (pick && pickPtr === e.pointerId) {
    pickPtr = null;
    if (e.pointerType !== 'mouse') hideLoupe();
    if (ev === 'pointerup') {
      const L = pick;
      if (samplePick(toCanvas(e))) {
        // 抜いた結果を見せる（全画面のまま。「やり直す」「完了」）
        hideLoupe();
        pickLayer = L;
        $('fs').classList.add('picked');
        $('fsHint').textContent = 'この色を抜きました。よければ「完了」、うまく抜けないときは「やり直す」';
      }
    }
    return;
  }
  if (keyAdj || vptrs.has(e.pointerId)) { viewUp(e); return; }
  ptrs.delete(e.pointerId); pinch = null;
  if (ptrs.size === 2) startPinch();
  if (tap && tap.id === e.pointerId) {
    const isTap = ev === 'pointerup' && ptrs.size === 0 && performance.now() - tap.t < 400 && Math.hypot(e.clientX - tap.cx, e.clientY - tap.cy) < 10;
    if (isTap) { ch.x = tap.x; ch.y = tap.y; chMoved = tap.moved; openFs(); } // 触ったときの小さなずれは戻す
    tap = null;
  }
}));
cv.addEventListener('pointermove', (e) => { if (tap && (e.pointerId !== tap.id || Math.hypot(e.clientX - tap.cx, e.clientY - tap.cy) >= 10)) tap = null; });

// ---------- 全画面で合わせる（直し06） ----------
// プレビュー（#stage）を全画面の箱に移して、画面いっぱいに出す。完了で元に戻す（合わせた結果はそのまま）
function openFs(forPick = false) {
  if (forPick !== true) forPick = false; // クリックのイベントが来たときは false
  $('fs').classList.remove('pick', 'picked');
  if (!forPick) { keyAdj = null; $('fs').classList.remove('adj'); setView(1, 0, 0); }
  $('fsHint').textContent = '指1本でドラッグ：位置／2本指でつまむ：大きさ';
  if (fsOpen) return; // スポイトで開き直すときは、もう開いている
  if ((!slots.ch && !forPick) || recording) return;
  if (pick && !forPick) stopPick();
  fsOpen = true;
  $('fs').hidden = false;
  $('fsBox').appendChild($('stage'));
  document.documentElement.classList.add('fs-open');
  // スマホの「戻る」で閉じられるように
  try { history.pushState({ vfFs: 1 }, ''); } catch (e) { /* なし */ }
  fitStage();
  if (!forPick) $('fsDone').focus({ preventScroll: true });
}
function closeFs(fromHistory = false) {
  if (!fsOpen) return;
  if (pick) stopPick();
  $('fs').classList.remove('pick', 'picked', 'adj');
  if (keyAdj) { const k = keyAdj.k; keyAdj = null; syncKeyBox(k); }
  rawView = null; $('fkRaw').classList.remove('on');
  setView(1, 0, 0); vptrs.clear(); vpinch = null;
  fsOpen = false;
  $('stageBox').appendChild($('stage'));
  $('fs').hidden = true;
  document.documentElement.classList.remove('fs-open');
  ptrs.clear(); pinch = null; tap = null;
  fitStage();
  if (!fromHistory && history.state && history.state.vfFs) { try { history.back(); } catch (e) { /* なし */ } }
}
window.addEventListener('popstate', () => { if (fsOpen) closeFs(true); });
document.addEventListener('keydown', (e) => { if (fsOpen && e.key === 'Escape') { e.preventDefault(); closeFs(); } });
// iPhone：2本指・ダブルタップでページが拡大されないように（全画面の中とプレビューの上）
['gesturestart', 'gesturechange'].forEach((ev) => document.addEventListener(ev, (e) => {
  if (fsOpen || e.target === cv) e.preventDefault();
}, { passive: false }));
$('fs').addEventListener('touchmove', (e) => { if (e.target !== cv && !(e.target instanceof HTMLInputElement)) e.preventDefault(); }, { passive: false });
$('fsOpen').addEventListener('click', openFs);
$('fsDone').addEventListener('click', () => closeFs());
$('fsPickDone').addEventListener('click', () => { if (keyAdj) enterAdj(); else { closeFs(); refreshKeyBoxes(); } });
$('fsPickCancel').addEventListener('click', () => {
  if (keyAdj) { stopPick(); enterAdj(); } else { closeFs(); refreshKeyBoxes(); }
  say('スポイトをやめました');
});
$('fsPickRetry').addEventListener('click', () => { if (pickLayer) startPick(pickLayer); });
$('fsFlip').addEventListener('click', () => { ch.flip = !ch.flip; });
$('fsIn').addEventListener('click', () => { zoomAt(ch.x, ch.y, 1.1); chMoved = true; });
$('fsOut').addEventListener('click', () => { zoomAt(ch.x, ch.y, 1 / 1.1); chMoved = true; });
$('fsReset').addEventListener('click', () => { resetChar(); chMoved = false; });
cv.addEventListener('wheel', (e) => {
  if (keyAdj) { // 調整の画面：ホイールは見るだけの拡大
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    zoomViewAt(e.clientX, e.clientY, view.z * Math.exp(-dy * 0.0015));
    return;
  }
  if (!slots.ch) return;
  e.preventDefault();
  const p = toCanvas(e);
  const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
  zoomAt(p.x, p.y, Math.exp(-dy * 0.0015));
  chMoved = true;
}, { passive: false });
cv.addEventListener('keydown', (e) => {
  if (!slots.ch) return;
  const step = e.shiftKey ? 50 : 10;
  const mv = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
  if (mv) { e.preventDefault(); ch.x += mv[0]; ch.y += mv[1]; chMoved = true; return; }
  if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomAt(ch.x, ch.y, 1.1); chMoved = true; }
  if (e.key === '-') { e.preventDefault(); zoomAt(ch.x, ch.y, 1 / 1.1); chMoved = true; }
});
$('zoomIn').addEventListener('click', () => { zoomAt(ch.x, ch.y, 1.1); chMoved = true; });
$('zoomOut').addEventListener('click', () => { zoomAt(ch.x, ch.y, 1 / 1.1); chMoved = true; });
$('flip').addEventListener('click', () => { ch.flip = !ch.flip; });
$('reset').addEventListener('click', () => { resetChar(); chMoved = false; });

// ---------- 保存 ----------
const MIME_CANDS = [
  'video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1.4d0028', 'video/mp4;codecs=avc1.42E01E',
  'video/mp4;codecs=avc1', 'video/mp4',
  'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm',
];
function pickMime() {
  if (!window.MediaRecorder) return null;
  for (const m of MIME_CANDS) { try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (e) { /* 次へ */ } }
  return '';
}
function canMp4() { if (wcInfo) return true; const m = pickMime(); return !!m && m.includes('mp4'); }
// WebCodecs で書き出せるか（はじめに1回だけ調べる）
let wcInfo = null;
let lastWay = '';
findConfig(1080, 1920, 10e6).then((r) => { wcInfo = r; refreshUI(); }).catch(() => {});

function activeVideos() {
  const set = new Set();
  for (const k of ['bg', 'ch', 'fg']) { const L = slots[k]; if (L && L.el instanceof HTMLVideoElement) set.add(L.el); }
  return [...set];
}
// 動画の長さは、素材に合わせる（直し08 の追記2・Kyon 決定）：フレームが動画ならフレームの1ループ、
//  なければ背景、それもなければキャラの動画の長さ。どれも最長15秒。キャラが長ければ途中で切れ、短ければくり返す
const isVideoLayer = (L) => !!(L && L.el instanceof HTMLVideoElement);
function lengthSource() {
  for (const k of ['fg', 'bg', 'ch']) {
    const L = slots[k];
    if (isVideoLayer(L)) {
      const d = L.el.duration;
      return { k, el: L.el, sec: Number.isFinite(d) && d > 0 ? d : MAX_REC_SEC };
    }
  }
  return null;
}
function videoLength() {
  const src = lengthSource();
  return src ? Math.min(MAX_REC_SEC, src.sec) : 0;
}
const LENGTH_NAME = { fg: 'フレーム', bg: '背景', ch: 'キャラの動画' };
function fileBase() {
  // お試しのフレーム（フレームが無ければお試しの背景）のときはその素材の id、手持ちのときは my
  const F = slots.fg, B = slots.bg;
  const id = F ? (F.trial ? F.trial.id : 'my') : (B ? (B.trial ? B.trial.id : 'my') : 'my');
  return `vframe_${id}_${ratioLabel()}`;
}

function showResult(blob, name, kind) {
  lastOut = { blob, name, kind };
  const img = $('outImg'), vid = $('outVid');
  if (img.src) URL.revokeObjectURL(img.src);
  if (vid.src) URL.revokeObjectURL(vid.src);
  img.hidden = vid.hidden = true;
  $('outInfo').hidden = true; // 動画のときは、このあと outLine で出す
  img.removeAttribute('src'); vid.removeAttribute('src');
  const u = URL.createObjectURL(blob);
  if (kind === 'png') { img.src = u; img.hidden = false; $('saveBtn').textContent = 'この画像を保存'; }
  else { vid.src = u; vid.hidden = false; vid.play().catch(() => {}); $('saveBtn').textContent = 'この動画を保存'; }
  $('result').hidden = false;
}

// 静止画（直し08）：動画を止めて、止めたコマが画面に出てから、描き替え（rAF）の中で描いて画像にする。
//  前は、再生中のまま押したときの処理の中で1回描いていた。iPhone の Safari ではそのとき読む動画のコマが
//  動画の書き出し（描き替えの中で描く）と違う形になることがあり、静止画だけ緑が残ったと考えている
let makingPng = false;
const nextFrame = () => new Promise((res) => requestAnimationFrame(() => res()));
$('makePng').addEventListener('click', async () => {
  if (!slots.ch) { say('先にキャラを入れてください。', true); return; }
  if (makingPng || recording) return;
  makingPng = true; $('makePng').disabled = true;
  const vids = activeVideos();
  const playing = vids.filter((v) => !v.paused);
  try {
    vids.forEach((v) => v.pause());
    // 止めたコマが画面に出るまで、描き替えを3回待つ
    await nextFrame(); await nextFrame(); await nextFrame();
    const b = await new Promise((res) => { requestAnimationFrame(() => { render(true, false); cv.toBlob(res, 'image/png'); }); });
    if (!b) { say('画像を作れませんでした。', true); return; }
    showResult(b, `${fileBase()}.png`, 'png');
    say(`静止画ができました（${W}×${H}）。「この画像を保存」を押してください。`);
    diag();
  } finally {
    playing.forEach((v) => v.play().catch(() => {}));
    makingPng = false; $('makePng').disabled = !slots.ch || recording;
  }
});

function seekZero(v) {
  return new Promise((res) => {
    if (v.currentTime === 0 && v.readyState >= 2) { res(); return; }
    const t = setTimeout(res, 1500);
    v.addEventListener('seeked', () => { clearTimeout(t); res(); }, { once: true });
    v.currentTime = 0;
  });
}

// 動画を作る（直し06）：WebCodecs が使えれば、30コマ/秒一定・BT.709・ふつうの範囲の MP4 にそろえる（js/mp4rec.js）。
// 使えないブラウザは、前の MediaRecorder で録る。
$('makeMp4').addEventListener('click', async () => {
  if (recording) return;
  if (!slots.ch) { say('先にキャラを入れてください。', true); return; }
  const dur = videoLength();
  if (!dur) { say('動画が1つも入っていません。静止画（PNG）で保存してください。', true); return; }
  const vids = activeVideos();
  let done = false;
  try { done = await recordWC(dur, vids); }
  catch (e) {
    lastErr = `書き出し(WebCodecs): ${e && e.message || e}`;
    recording = false; refreshUI();
  }
  if (!done) await recordMR(dur, vids);
});

// 書き出しの時計にする動画：長さを決めた素材の動画（無ければいちばん長い動画）
function masterVideo(vids) {
  const src = lengthSource();
  if (src && vids.includes(src.el)) return src.el;
  return vids.reduce((a, b) => ((b.duration || 0) > (a.duration || 0) ? b : a));
}

async function recordWC(dur, vids) {
  if (!wcInfo) return false;
  const rec = await Mp4Rec.start(W, H);
  if (!rec) return false;
  recording = true; refreshUI();
  say('準備しています…');
  vids.forEach((v) => { v.pause(); v.playbackRate = 1; });
  await Promise.all(vids.map(seekZero));
  const master = masterVideo(vids);
  const N = Math.max(1, Math.round(dur * FPS));
  let next = 0, base = 0, lastT = 0, rate = 1, slow = 0, lastSay = 0;
  const setRate = (r) => { rate = r; vids.forEach((v) => { v.playbackRate = r; }); };
  try {
    render(false, true); rec.add(cv); next = 1; // 0コマ目（どの動画も 0 秒）
    vids.forEach((v) => v.play().catch(() => {}));
    await new Promise((res, rej) => {
      const tick = () => {
        try {
          if (rec.err) throw rec.err;
          // いちばん長い動画の時刻を、出来上がりの時刻にする（コマ i は i/30 秒）
          let t = master.currentTime;
          if (t + 0.5 < lastT) base += master.duration || 0;
          lastT = t; t += base;
          const want = Math.min(N, Math.floor(t * FPS) + 1);
          if (next < want) {
            const s0 = performance.now();
            render(false, true);
            const lag = want - next;
            while (next < want) { rec.add(cv); next++; }
            // 描くのが間に合わない端末では、動画をゆっくり流して、コマが飛ばないようにする
            if (next > 4 && (lag > 1 || performance.now() - s0 > 26 || rec.queue > 6)) {
              if (++slow >= 2 && rate > 0.25) { setRate(rate / 2); slow = 0; }
            }
          }
          if (performance.now() - lastSay > 250) { lastSay = performance.now(); say(`作成中…（${Math.floor((next / N) * 100)}％）この画面のまま待ってください`); }
          if (next >= N) { res(); return; }
          requestAnimationFrame(tick);
        } catch (e) { rej(e); }
      };
      requestAnimationFrame(tick);
    });
    say('仕上げています…');
    vids.forEach((v) => v.pause());
    const blob = await rec.finish();
    recording = false; refreshUI();
    showResult(blob, `${fileBase()}.mp4`, 'mp4');
    say(`動画ができました（MP4・${(N / FPS).toFixed(1)}秒・${(blob.size / 1048576).toFixed(1)}MB）。「この動画を保存」を押してください。`);
    lastWay = `WebCodecs ${rec.profile}（${rec.codec}）・${FPS}fps 一定・${N}コマ・${(rec.bitrate / 1e6).toFixed(1)}Mbps・色の変換 ${rec.yuvWay}・再生の速さ ${rate}`;
    outLine(blob.size, N / FPS, `WebCodecs（H.264 ${rec.profile}・設定 ${(rec.bitrate / 1e6).toFixed(1)}Mbps）`);
    diag('video/mp4', blob.size, N / FPS);
    return true;
  } catch (e) {
    rec.cancel();
    throw e;
  } finally {
    vids.forEach((v) => { v.playbackRate = 1; v.play().catch(() => {}); });
  }
}

async function recordMR(dur, vids) {
  const mime = pickMime();
  if (mime === null || !cv.captureStream) { say('このブラウザは動画の書き出しに対応していません。ChromeかEdgeで開いてください。', true); return; }
  recording = true; refreshUI();
  say('準備しています…');
  vids.forEach((v) => v.pause());
  await Promise.all(vids.map(seekZero));
  // いちばん長い動画の新しいコマが出るたびに1コマ描いて録る（同じコマが重なりにくい）。
  // 使えないブラウザは 30fps で自動に録る。
  const master = masterVideo(vids);
  let stream = null, track = null;
  if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
    stream = cv.captureStream(0);
    track = stream.getVideoTracks()[0];
    if (!track || typeof track.requestFrame !== 'function') { stream.getTracks().forEach((t) => t.stop()); stream = null; track = null; }
  }
  if (!stream) stream = cv.captureStream(30);
  let live = true;
  let rec;
  try {
    rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 10_000_000 } : { videoBitsPerSecond: 10_000_000 });
  } catch (e) {
    recording = false; refreshUI(); vids.forEach((v) => v.play().catch(() => {}));
    say('録画を始められませんでした：' + e.message, true); return;
  }
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.onstop = () => {
    live = false;
    stream.getTracks().forEach((t) => t.stop());
    const type = (rec.mimeType || mime || 'video/webm').split(';')[0];
    const ext = type.includes('mp4') ? 'mp4' : 'webm';
    const blob = new Blob(chunks, { type });
    recording = false; refreshUI();
    showResult(blob, `${fileBase()}.${ext}`, ext);
    say(`動画ができました（${ext.toUpperCase()}・${dur.toFixed(1)}秒・${(blob.size / 1048576).toFixed(1)}MB）。「この動画を保存」を押してください。`
      + (ext === 'webm' ? ' ※WebMになったため、Xに上げられない可能性があります。ChromeかEdgeで開くとMP4で作れます。' : ''), ext === 'webm');
    lastWay = `MediaRecorder（${type}。コマの間隔・色のラベルはブラウザ任せ）`;
    outLine(blob.size, dur, `MediaRecorder（${type}）`);
    diag(type, blob.size, dur);
  };
  render(false, true);
  rec.start(1000);
  if (track) {
    track.requestFrame();
    const onFrame = () => {
      if (!live) return;
      render(false, true);
      track.requestFrame();
      master.requestVideoFrameCallback(onFrame);
    };
    master.requestVideoFrameCallback(onFrame);
  }
  vids.forEach((v) => v.play().catch(() => {}));
  const t0 = performance.now();
  const iv = setInterval(() => {
    const left = Math.max(0, Math.ceil(dur - (performance.now() - t0) / 1000));
    say(`作成中… あと${left}秒（この画面のまま待ってください）`);
  }, 250);
  setTimeout(() => { clearInterval(iv); say('仕上げています…'); rec.stop(); }, dur * 1000 + 80);
}

// 書き出した動画の大きさ・ビットレート・使った道を1行で（直し11：スマホで何が起きたか分かるように）
let lastOutLine = '';
function outLine(bytes, sec, way) {
  lastOutLine = `書き出し：${W}×${H}・${(bytes * 8 / Math.max(0.1, sec) / 1e6).toFixed(1)}Mbps・${sec.toFixed(1)}秒・${way}`;
  $('outInfo').textContent = lastOutLine;
  $('outInfo').hidden = false;
}

$('saveBtn').addEventListener('click', async () => {
  if (!lastOut) return;
  const { blob, name } = lastOut;
  const file = new File([blob], name, { type: blob.type });
  if (isTouch && navigator.canShare && navigator.share) {
    let ok = false;
    try { ok = navigator.canShare({ files: [file] }); } catch (e) { ok = false; }
    if (ok) {
      try { await navigator.share({ files: [file] }); say('保存の画面を開きました。「画像を保存」「ビデオを保存」で写真に入れられます。'); return; }
      catch (e) { if (e && e.name === 'AbortError') { say('保存をやめました。'); return; } }
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  say(`ダウンロードしました：${name}` + (isTouch && !window.isSecureContext ? '（家の中のアドレスでは「写真に保存」が出ないので、ファイルとして保存しました）' : ''));
});
$('closeResult').addEventListener('click', () => { $('result').hidden = true; });
// 「くわしく」の文の終わりの「閉じる」（直し11）
$('aboutClose').addEventListener('click', () => { $('aboutClose').closest('details').open = false; });

// ---------- 画面の更新 ----------
function slotLabel(L) {
  if (!L) return '入っていません';
  if (L.trial) return `お試し：${L.name}`;
  const kind = L.type === 'pack' ? 'Kyonの動フレ（背景つき）' : L.type === 'alpha2' ? 'Kyonの動フレ（フレーム）' : L.type === 'video' ? '動画' : '画像';
  return `${kind}：${L.name}`;
}
function refreshUI() {
  for (const k of ['fg', 'ch', 'bg']) {
    const L = slots[k];
    $(`name-${k}`).textContent = slotLabel(L);
    $(`rm-${k}`).hidden = !L;
    $(`slot-${k}`).classList.toggle('filled', !!L);
    const msg = $(`msg-${k}`);
    msg.hidden = !(L && L.msg);
    msg.textContent = L && L.msg ? L.msg : '';
    syncKeyBox(k);
  }
  $('next-1').disabled = !slots.ch || recording;
  $('next-1').textContent = slots.ch ? '次へ：② 合わせる' : 'キャラを入れると、次へ進めます';
  $('next-2').disabled = !slots.ch || recording;
  document.querySelectorAll('.mat').forEach((b) => {
    const L = slots[b.dataset.slot];
    b.setAttribute('aria-pressed', String(!!(L && L.trial && L.trial.id === b.dataset.id)));
    b.disabled = recording || b.dataset.prep === '1';
  });
  $('empty').hidden = !!slots.ch;
  const hasVid = activeVideos().length > 0;
  $('makePng').disabled = !slots.ch || recording;
  $('makeMp4').disabled = !slots.ch || !hasVid || recording;
  ['zoomIn', 'zoomOut', 'flip', 'reset', 'fsOpen'].forEach((id) => { $(id).disabled = !slots.ch || recording; });
  if (fsOpen && !slots.ch) closeFs();
  const notes = [];
  if (!hasVid) notes.push('動画が入っていないので、保存できるのは静止画（PNG）だけです。');
  else {
    const src = lengthSource();
    notes.push(`動画の長さ：${videoLength().toFixed(1)}秒（${LENGTH_NAME[src.k]}の長さに合わせています。最長15秒）`);
  }
  if (!slots.bg) notes.push('背景がないときは、PNGは透明、動画は白い背景になります。');
  if (hasVid && !canMp4()) notes.push('このブラウザでは動画がMP4で作れず、Xに上げられない可能性があります。ChromeかEdgeで開いてください。');
  $('saveNote').textContent = notes.join(' ');
  updateOrientUI();
  diag();
}

// ---------- テスト用の情報 ----------
let lastRec = '';
let lastErr = '';
function diag(type, size, dur) {
  if (type) lastRec = `${type} / ${(size / 1048576).toFixed(2)}MB / ${dur.toFixed(1)}秒 / ${W}x${H}`;
  const sup = window.MediaRecorder
    ? MIME_CANDS.map((m) => { let ok = false; try { ok = MediaRecorder.isTypeSupported(m); } catch (e) { /* なし */ } return (ok ? '○ ' : '× ') + m; }).join('\n')
    : 'MediaRecorder なし';
  const desc = (k) => { const L = slots[k]; if (!L) return 'なし'; const e = elSize(L.el); return `${L.type} ${Math.round(L.w)}x${Math.round(L.h)}（元 ${e[0]}x${e[1]}）${L.key ? ` 色抜き ${L.ks.preset} ${L.ks.rgb.map((v) => Math.round(v * 255)).join(',')} 抜き具合${L.ks.amount} ふち${L.ks.soft} 緑かぶり${L.ks.desp ?? KEY_DEFAULT.desp}` : ''}${L.still ? ' 静止画PNGあり' : ''}${L.trial ? ' お試し ' + L.trial.id + '/' + L.trial.o : ''}${L.watch ? ` 描き方 ${DRAW_WAY_NAME[L.drawWay || 0]}${L.frozen ? '（どれでも止まる）' : L.watch.done ? '（動いている）' : '（確かめ中）'}` : ''}${L.el instanceof HTMLVideoElement ? ` 時刻 ${L.el.currentTime.toFixed(2)}${L.el.paused ? ' 止まっている' : ''}` : ''}`; };
  $('diag').textContent = [
    'ブラウザ: ' + navigator.userAgent + (isWebKit ? '（WebKit）' : ''),
    'WebGL: ' + (procCh ? 'あり' : 'なし ' + glError),
    'captureStream: ' + !!cv.captureStream,
    'WebGL の精度: ' + (procCh ? procCh.precision : '-'),
    'share(files): ' + !!(navigator.canShare) + (isTouch ? '（タッチ）' : '（マウス）'),
    '安全な接続（https など）: ' + (window.isSecureContext ? 'はい' : 'いいえ'),
    `画面: ${W}x${H}`,
    `フレーム: ${desc('fg')}`, `キャラ: ${desc('ch')}`, `背景: ${desc('bg')}`,
    '対応形式:', sup,
    '動画の書き出し: ' + (wcInfo ? `WebCodecs（H.264 ${wcInfo.profile}・${FPS}fps 一定・BT.709・ふつうの範囲）` : 'MediaRecorder（この端末は WebCodecs の H.264 が使えません）'),
    lastRec ? '最後に作った動画: ' + lastRec : '',
    lastOutLine ? '最後の' + lastOutLine : '',
    lastWay ? '最後の書き出し方: ' + lastWay : '',
    'お試しの素材の先読み: ' + ({ loading: '読み込み中', ready: 'できた（機内モードでも使える）', failed: 'できなかった' }[trialPrep] || '-'),
    lastErr ? '最後の読み込みの失敗: ' + lastErr : '',
  ].join('\n');
}

// ---------- はじめ ----------
$('hint').textContent = isTouch
  ? '指でドラッグ：移動／2本指：拡大縮小'
  : 'ドラッグ：移動／ホイール：拡大縮小／矢印キー：少しずつ移動（Shiftで大きく）';
$('fsNote').textContent = isTouch
  ? 'プレビューをタップすると全画面で合わせられます。'
  : 'プレビューの横の「全画面」で、大きくして合わせられます。';
if (!procCh) say('この端末ではWebGLが使えないため、背景の色を抜く・Kyonの動フレ（透明のフレーム）が使えません。', true);

// ---------- タブ（① 素材｜② 合わせる｜③ 保存する） ----------
function showTab(n, focus = false) {
  for (const i of [1, 2, 3]) {
    const t = $(`tab-${i}`);
    t.setAttribute('aria-selected', String(i === n));
    t.tabIndex = i === n ? 0 : -1;
    $(`panel-${i}`).hidden = i !== n;
  }
  if (focus) $(`tab-${n}`).focus();
  // タブが上に貼り付いているとき（スマホで下まで見ていたとき）は、切り替えた中身の頭に戻す
  const tabs = document.querySelector('.tabs');
  const stick = parseFloat(getComputedStyle(tabs).top) || 0;
  const tr = tabs.getBoundingClientRect();
  if (tr.top <= stick + 1) {
    const pr = $(`panel-${n}`).getBoundingClientRect();
    window.scrollBy(0, pr.top - tr.bottom);
  }
}
for (const i of [1, 2, 3]) {
  const t = $(`tab-${i}`);
  t.addEventListener('click', () => showTab(i));
  t.addEventListener('keydown', (e) => {
    const d = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (e.key === 'Home') { e.preventDefault(); showTab(1, true); }
    else if (e.key === 'End') { e.preventDefault(); showTab(3, true); }
    else if (d) { e.preventDefault(); showTab(((i - 1 + d + 3) % 3) + 1, true); }
  });
}
document.querySelectorAll('.next').forEach((b) => b.addEventListener('click', () => showTab(Number(b.dataset.go))));

buildTrialButtons();
preloadTrials();
['fg', 'ch', 'bg'].forEach(wireSlot);
updateSize();
refreshUI();
requestAnimationFrame(loop);

// ---------- 背景の色を抜くのを、全画面で調整する（直し08） ----------
// 画面いっぱいのプレビューの下に、つまみ3つ・抜く前（押している間）・スポイト・元に戻す・完了。
// 2本指（ホイール）で拡大して髪のふちを見られる。拡大は見るだけで、キャラの大きさ・位置は変えない
let keyAdj = null;   // { k, L, saved }
let rawView = null;  // 抜く前を見せているレイヤー
const view = { z: 1, x: 0, y: 0 };
const vptrs = new Map();
let vpinch = null;
function setView(z, x, y) {
  const st = $('stage');
  z = Math.min(8, Math.max(1, z));
  // はみ出しすぎないように（拡大したぶんだけ動かせる）
  const mx = (st.offsetWidth * (z - 1)) / 2, my = (st.offsetHeight * (z - 1)) / 2;
  view.z = z; view.x = Math.max(-mx, Math.min(mx, x)); view.y = Math.max(-my, Math.min(my, y));
  st.style.transform = z === 1 && !view.x && !view.y ? '' : `translate(${view.x}px, ${view.y}px) scale(${view.z})`;
}
// 画面の点 (cx, cy) を動かさずに、拡大の倍率を z にする
function zoomViewAt(cx, cy, z) {
  const b = $('fsBox').getBoundingClientRect();
  const C = { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  const nz = Math.min(8, Math.max(1, z));
  const px = (cx - C.x - view.x) / view.z, py = (cy - C.y - view.y) / view.z;
  setView(nz, cx - C.x - px * nz, cy - C.y - py * nz);
}
function viewDown(e) {
  try { cv.setPointerCapture(e.pointerId); } catch (err) { /* なし */ }
  vptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (vptrs.size === 2) {
    const [a, b] = [...vptrs.values()];
    vpinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, z: view.z };
  }
}
function viewMove(e) {
  if (!vptrs.has(e.pointerId)) return;
  const prev = vptrs.get(e.pointerId);
  const p = { x: e.clientX, y: e.clientY };
  vptrs.set(e.pointerId, p);
  if (vptrs.size === 1) { setView(view.z, view.x + p.x - prev.x, view.y + p.y - prev.y); }
  else if (vptrs.size === 2 && vpinch) {
    const [a, b] = [...vptrs.values()];
    const mxp = (a.x + b.x) / 2, myp = (a.y + b.y) / 2;
    // 2本指の真ん中の動きでずらしてから、真ん中を中心に拡大する
    const pa = prev, other = [...vptrs.entries()].find(([id]) => id !== e.pointerId)[1];
    const pm = { x: (pa.x + other.x) / 2, y: (pa.y + other.y) / 2 };
    setView(view.z, view.x + mxp - pm.x, view.y + myp - pm.y);
    zoomViewAt(mxp, myp, vpinch.z * Math.hypot(a.x - b.x, a.y - b.y) / vpinch.d);
  }
}
function viewUp(e) {
  vptrs.delete(e.pointerId); vpinch = null;
  if (vptrs.size === 2) { const [a, b] = [...vptrs.values()]; vpinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, z: view.z }; }
}

function openKeyFs(k) {
  const L = slots[k];
  if (!L || !L.key || recording) return;
  if (pick) stopPick();
  keyAdj = { k, L, saved: { ...L.ks } };
  openFs(true);
  enterAdj();
}
function enterAdj() {
  if (!keyAdj) return;
  const L = keyAdj.L;
  if (slots[keyAdj.k] !== L) { closeFs(); return; }
  $('fs').classList.remove('pick', 'picked');
  $('fs').classList.add('adj');
  $('fsHint').textContent = isTouch
    ? 'つまみを動かすと、すぐ変わります。2本指で広げると、髪のふちを拡大して見られます（キャラの大きさは変わりません）'
    : 'つまみを動かすと、すぐ変わります。ホイールで拡大して、髪のふちを見られます（キャラの大きさは変わりません）';
  $('fkAmt').value = String(L.ks.amount);
  $('fkSoft').value = String(L.ks.soft);
  $('fkDesp').value = String(L.ks.desp ?? KEY_DEFAULT.desp);
  diag();
  fitStage();
  setView(view.z, view.x, view.y);
}
[['fkAmt', 'amount'], ['fkSoft', 'soft'], ['fkDesp', 'desp']].forEach(([id, key]) => {
  $(id).addEventListener('input', (e) => { if (keyAdj) { keyAdj.L.ks[key] = Number(e.target.value); diag(); } });
});
// 押している間だけ、抜く前を見せる
const rawOn = (e) => { if (!keyAdj) return; e.preventDefault(); rawView = keyAdj.L; $('fkRaw').classList.add('on'); };
const rawOff = () => { rawView = null; $('fkRaw').classList.remove('on'); };
$('fkRaw').addEventListener('pointerdown', rawOn);
['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => $('fkRaw').addEventListener(ev, rawOff));
$('fkRaw').addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') rawOn(e); });
$('fkRaw').addEventListener('keyup', rawOff);
$('fkRaw').addEventListener('contextmenu', (e) => e.preventDefault());
$('fkPick').addEventListener('click', () => { if (keyAdj) startPick(keyAdj.L); });
$('fkUndo').addEventListener('click', () => {
  if (!keyAdj) return;
  keyAdj.L.ks = { ...keyAdj.saved };
  enterAdj();
  say('背景の色を抜くのを、全画面にする前に戻しました');
});
$('fkDone').addEventListener('click', () => closeFs());
