// お試しの素材の一覧。層ごと（fg＝フレーム、ch＝キャラ、bg＝背景）に並べる。
// 素材を足すときは、その層の配列に1つ書き足す（形は README.md）。
//  v = 縦（9:16）、h = 横（16:9）
//  video：動画のパス。type が 'alpha2' のときは「色｜透け具合」の2コマ（axis 'x'＝横に並ぶ／'y'＝縦に並ぶ）
//  still：静止画の保存に使う PNG（無ければ動画のそのときのコマ）
//  key：緑や青の背景のままの動画のとき、入れたら「背景の色を抜く」を入れる（お試しのキャラ）
//  booth：その素材の BOOTH の商品ページ（無ければショップのトップ）
export const BOOTH_SHOP = 'https://kyon-animotion.booth.pm/';
// 版の数字。素材のファイルを差し替えたら変える（ブラウザに古いファイルが残らないように）。scriptsump_version.py で一度に変えられる
const V = '?v=20261108c';

export const MATERIALS = {
  fg: [
    {
      id: 'trial-frame', name: 'お試しのフレーム', note: '動く・Good Morning!', thumb: 'materials/trial-frame/thumb.png', booth: BOOTH_SHOP,
      v: { type: 'alpha2', axis: 'x', video: 'materials/trial-frame/frame_v.mp4', still: 'materials/trial-frame/fg_v.png' },
      h: { type: 'alpha2', axis: 'y', video: 'materials/trial-frame/frame_h.mp4', still: 'materials/trial-frame/fg_h.png' },
    },
  ],
  ch: [
    {
      // キャラは画面の向きに関係なく同じもの（高さに合わせて真ん中に置く）
      // 緑の背景のままの動画。入れると「背景の色を抜く」が緑で入る（使う人が自分の動画を抜くときの見本・テスト）
      //  key：{ preset: 'green'|'blue', amount: 抜き具合, soft: ふちのなじませ }（緑・青のボタンと同じ抜き方。85・28 は直し03でふちを見て決めた）。still は無し（動画のそのときのコマを使う）
      id: 'trial-chara', name: 'お試しのキャラ', note: '動く・緑の背景', thumb: 'materials/trial-chara/thumb.png',
      v: { type: 'video', video: 'materials/trial-chara/chara_green.mp4', key: { preset: 'green', amount: 85, soft: 28 } },
      h: { type: 'video', video: 'materials/trial-chara/chara_green.mp4', key: { preset: 'green', amount: 85, soft: 28 } },
    },
  ],
  bg: [
    {
      id: 'trial-bg', name: 'お試しの背景', note: '動く', thumb: 'materials/trial-bg/thumb.png', booth: BOOTH_SHOP,
      v: { type: 'video', video: 'materials/trial-bg/bg_v.mp4', still: 'materials/trial-bg/bg_v.png' },
      h: { type: 'video', video: 'materials/trial-bg/bg_h.mp4', still: 'materials/trial-bg/bg_h.png' },
    },
  ],
};

// パスに版の数字を付ける
for (const list of Object.values(MATERIALS)) {
  for (const m of list) {
    m.thumb += V;
    for (const o of ['v', 'h']) if (m[o]) { m[o].video += V; if (m[o].still) m[o].still += V; }
  }
}
