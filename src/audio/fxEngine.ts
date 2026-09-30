/**
 * FX (効果音) エンジン。
 *
 * 楽曲に「セクション転換」や「盛り上げ」を演出するための非楽音的サウンドを提供する。
 *
 * 提供する FX (MIDI 番号で識別):
 *   - 0  : ホワイトノイズ・ヒット (短い「シャッ」)
 *   - 1  : スウィープ・アップ (上昇フィルタ・スウィープ)
 *   - 2  : スウィープ・ダウン (下降フィルタ・スウィープ)
 *   - 3  : ライザー (build-up: ノイズ + 上昇ピッチで盛り上げる)
 *   - 4  : ダウンリフター (下降スウィープ。落としに使う)
 *   - 5  : フォール (ピッチが下に落ちる効果音)
 *   - 6  : リバースシンバル (本物のクラッシュシンバルの録音を逆再生)
 *   - 7  : インパクト (サビ頭の「ドーン」: 本物のキック + クラッシュ + 重低音の落下 + 残響)
 *
 * 本物の音 (シンバル / キック) は public/drums/studio の録音 (CC0) を使う。
 * 読み込みが終わるまではシンセで作った代わりの音で鳴らす。
 *
 * triggerFx(midi, durationSec, velocity) で発音する。
 * durationSec は FX の長さ。リバースシンバルやライザーは長め (2〜4 秒) を想定。
 */

import * as Tone from "tone";
import { ensureAudio } from "./pianoEngine";
import { getReverbBus, getReverbInput } from "./mixer";

export const FX_WHITE_NOISE = 0;
export const FX_SWEEP_UP = 1;
export const FX_SWEEP_DOWN = 2;
export const FX_RISER = 3;
export const FX_DOWNLIFTER = 4;
export const FX_FALL = 5;
export const FX_REVERSE_CYMBAL = 6;
export const FX_IMPACT = 7;

export const FX_LABEL_JA: Record<number, string> = {
  [FX_WHITE_NOISE]: "ホワイトノイズ",
  [FX_SWEEP_UP]: "スウィープ↑",
  [FX_SWEEP_DOWN]: "スウィープ↓",
  [FX_RISER]: "ライザー",
  [FX_DOWNLIFTER]: "ダウンリフター",
  [FX_FALL]: "フォール",
  [FX_REVERSE_CYMBAL]: "リバースシンバル",
  [FX_IMPACT]: "インパクト",
};

export const FX_MIDI_LIST = [
  FX_WHITE_NOISE,
  FX_SWEEP_UP,
  FX_SWEEP_DOWN,
  FX_RISER,
  FX_DOWNLIFTER,
  FX_FALL,
  FX_REVERSE_CYMBAL,
  FX_IMPACT,
];

let fxBus: Tone.Channel | null = null;
let fxCompressor: Tone.Compressor | null = null;
/** 大きなホールのような長い残響 (インパクトやライザーの終わりを広げる)。 */
let fxHallSend: Tone.Gain | null = null;

// ---- 本物の録音 (Studio ドラムキットのクラッシュ / キック) ----
let crashBuf: Tone.ToneAudioBuffer | null = null;
let crashRevBuf: Tone.ToneAudioBuffer | null = null;
let kickBuf: Tone.ToneAudioBuffer | null = null;
let samplesRequested = false;

/** 本物のシンバル / キックの録音を読み込む (1 回だけ)。 */
function loadFxSamples(): void {
  if (samplesRequested) return;
  samplesRequested = true;
  const base = `${import.meta.env.BASE_URL}drums/studio/`;
  // 一番強く叩いたクラッシュ (1.mp3) とキック (7.mp3)
  crashBuf = new Tone.ToneAudioBuffer(`${base}crash/1.mp3`);
  crashRevBuf = new Tone.ToneAudioBuffer(`${base}crash/1.mp3`, (b) => {
    b.reverse = true; // 逆再生用
  });
  kickBuf = new Tone.ToneAudioBuffer(`${base}kick/7.mp3`);
}

/** FX で使う録音を先に読み込んでおく。 */
export function preloadFx(): void {
  ensureFxBus();
}

/** 使い終わったノードを後で片付ける。 */
function disposeLater(nodes: Array<{ dispose: () => unknown }>, afterSec: number): void {
  window.setTimeout(() => {
    for (const n of nodes) {
      try {
        n.dispose();
      } catch {
        /* noop */
      }
    }
  }, afterSec * 1000);
}

function ensureFxBus(): Tone.Channel {
  if (fxBus) return fxBus;
  // リバーブ: 中位の decay + preDelay でアタックを濁らせない / wet を 0.22 にして空間広め
  // 残響は共有のホールへ送る (楽器ごとにリバーブを持つと重いため)
  const fxOut = getReverbInput("fx", "hall", 0.22);
  // コンプ: 比率を緩める (3 → 2.0) + knee 大きめでナチュラルに
  fxCompressor = new Tone.Compressor({
    threshold: -14,
    ratio: 2.0,
    attack: 0.02,
    release: 0.25,
    knee: 10,
  }).connect(fxOut);
  fxBus = new Tone.Channel({ volume: -6 }).connect(fxCompressor);
  // ホール残響 (送り): 長い余韻で空間を広げる
  const hall = getReverbBus("hall");
  fxHallSend = new Tone.Gain(0).connect(hall);
  fxBus.connect(fxHallSend);
  fxHallSend.gain.value = 0.18;
  loadFxSamples();
  return fxBus;
}

/** 短いホワイトノイズ・ヒット (「シャッ」)。 */
function triggerWhiteNoise(durationSec: number, velocity: number, time?: number): void {
  const bus = ensureFxBus();
  const dur = Math.max(0.05, Math.min(2.0, durationSec));
  const noise = new Tone.NoiseSynth({
    noise: { type: "white" },
    envelope: {
      attack: 0.002,
      decay: dur * 0.6,
      sustain: 0.0,
      release: dur * 0.3,
    },
    volume: -6 + (velocity - 0.5) * 8,
  }).connect(bus);
  const t = time ?? Tone.now();
  noise.triggerAttackRelease(dur, t);
  // 自動解放
  window.setTimeout(
    () => {
      try {
        noise.dispose();
      } catch {
        /* noop */
      }
    },
    (dur + 0.5) * 1000,
  );
}

/** フィルタ・スウィープ (アップ/ダウン)。
 *  Q を 6 → 2.5 に下げて「笛のような共振」を解消し、自然な空気の流れに。
 *  +レゾナンス層を別途乗せず、シンプルな BP + 末尾フェードで仕上げる。 */
function triggerSweep(durationSec: number, velocity: number, up: boolean, time?: number): void {
  const bus = ensureFxBus();
  const dur = Math.max(0.3, Math.min(6.0, durationSec));
  // 末尾フェード用 Gain を直接 bus 手前に置く
  const fadeNode = new Tone.Gain(1).connect(bus);
  const filter = new Tone.Filter({
    type: "bandpass",
    frequency: up ? 200 : 6000,
    Q: 2.5,                 // 6 → 2.5: 自然な air sweep に
  }).connect(fadeNode);
  // ピンクノイズ + ホワイトノイズの 2 層 (ピンク = 低域厚み、ホワイト = 高域伸び)
  const pink = new Tone.Noise("pink");
  pink.volume.value = -10 + (velocity - 0.5) * 6;
  pink.connect(filter);
  const white = new Tone.Noise("white");
  white.volume.value = -18 + (velocity - 0.5) * 4;
  white.connect(filter);
  const t = time ?? Tone.now();
  pink.start(t);
  pink.stop(t + dur + 0.05);
  white.start(t);
  white.stop(t + dur + 0.05);
  filter.frequency.setValueAtTime(up ? 200 : 6000, t);
  filter.frequency.exponentialRampToValueAtTime(up ? 7000 : 180, t + dur);
  fadeNode.gain.setValueAtTime(1, t);
  fadeNode.gain.linearRampToValueAtTime(0, t + dur + 0.05);
  window.setTimeout(
    () => {
      try {
        pink.dispose();
        white.dispose();
        filter.dispose();
        fadeNode.dispose();
      } catch {
        /* noop */
      }
    },
    (dur + 0.6) * 1000,
  );
}

/**
 * ライザー (盛り上げ)。プロの EDM / J-POP の "シュ〜〜ン" の定番の作り:
 *   1) 空気感のノイズ: フィルタが開きながら音量が上がる (ハイパス + バンドパスで細く上がっていく)
 *   2) 厚みのある音程: 少しずつずらした鋸波 3 本 (スーパーソウ) が 1 オクターブ半上がる
 *   3) 左右に回る動き: パンの回転がだんだん速くなる (緊張感)
 * 最後はサビの頭ぴったりで止める (余韻を残さない方が次の「ドーン」が立つ)。
 */
function triggerRiser(durationSec: number, velocity: number, time?: number): void {
  const bus = ensureFxBus();
  const dur = Math.max(0.6, Math.min(8.0, durationSec));
  const t = time ?? Tone.now();
  const end = t + dur;
  const level = 1.0 + velocity * 0.8;

  // 左右の回転 (0.5Hz → 8Hz に加速)
  const panner = new Tone.AutoPanner({ frequency: 0.5, depth: 0.7 }).connect(bus).start(t);
  panner.frequency.setValueAtTime(0.5, t);
  panner.frequency.exponentialRampToValueAtTime(8, end);
  const master = new Tone.Gain(0).connect(panner);
  // 最初から小さく聞こえていて、最後に向かって大きくなる (最初が無音だと途中から急に出てくる感じになる)
  master.gain.setValueAtTime(level * 0.06, t);
  master.gain.exponentialRampToValueAtTime(level, end - 0.02);
  master.gain.linearRampToValueAtTime(0, end); // サビ頭でピタッと止める

  // 1) ノイズ: 低い所から高い所へフィルタが開く
  const noise = new Tone.Noise("white");
  const hp = new Tone.Filter({ type: "highpass", frequency: 200, Q: 0.7 });
  const bp = new Tone.Filter({ type: "bandpass", frequency: 600, Q: 1.2 });
  const noiseGain = new Tone.Gain(0.8);
  noise.chain(hp, bp, noiseGain, master);
  hp.frequency.setValueAtTime(200, t);
  hp.frequency.exponentialRampToValueAtTime(3500, end);
  bp.frequency.setValueAtTime(600, t);
  bp.frequency.exponentialRampToValueAtTime(11000, end);
  noise.start(t).stop(end + 0.02);

  // 2) スーパーソウ (少しずつ音程をずらした鋸波 3 本) が 18 半音上がる
  const sawLp = new Tone.Filter({ type: "lowpass", frequency: 800, Q: 0.8 });
  const sawGain = new Tone.Gain(0.14);
  sawLp.chain(sawGain, master);
  sawLp.frequency.setValueAtTime(800, t);
  sawLp.frequency.exponentialRampToValueAtTime(6000, end);
  const oscs = [-9, 0, 9].map((detune) => {
    const o = new Tone.Oscillator({ frequency: 110, type: "sawtooth", detune }).connect(sawLp);
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(110 * Math.pow(2, 18 / 12), end);
    o.start(t).stop(end + 0.02);
    return o;
  });

  disposeLater([noise, hp, bp, noiseGain, sawLp, sawGain, ...oscs, master, panner], dur + 0.8);
}

/**
 * ダウンリフター (サビ終わりなどで「シュ〜ン…」と落とす)。
 *   1) 空気感のノイズ: 明るい所から暗い所へフィルタが閉じる
 *   2) 重低音: 低いサイン波がさらに下へ落ちて体に響く
 *   3) 左右の回転がだんだん遅くなる (ライザーの逆)
 */
function triggerDownlifter(durationSec: number, velocity: number, time?: number): void {
  const bus = ensureFxBus();
  const dur = Math.max(0.4, Math.min(5.0, durationSec));
  const t = time ?? Tone.now();
  const end = t + dur;
  const level = 0.5 + velocity * 0.5;

  const panner = new Tone.AutoPanner({ frequency: 6, depth: 0.6 }).connect(bus).start(t);
  panner.frequency.setValueAtTime(6, t);
  panner.frequency.exponentialRampToValueAtTime(0.4, end);

  const noise = new Tone.Noise("pink");
  const lp = new Tone.Filter({ type: "lowpass", frequency: 12000, Q: 1.0 });
  const noiseGain = new Tone.Gain(0);
  noise.chain(lp, noiseGain, panner);
  lp.frequency.setValueAtTime(12000, t);
  lp.frequency.exponentialRampToValueAtTime(250, end);
  noiseGain.gain.setValueAtTime(0.0001, t);
  noiseGain.gain.exponentialRampToValueAtTime(0.5 * level, t + 0.03);
  noiseGain.gain.exponentialRampToValueAtTime(0.0001, end);
  noise.start(t).stop(end + 0.02);

  // 重低音の落下 (中央に置く)
  const sub = new Tone.Oscillator({ frequency: 90, type: "sine" });
  const subGain = new Tone.Gain(0);
  sub.chain(subGain, bus);
  sub.frequency.setValueAtTime(90, t);
  sub.frequency.exponentialRampToValueAtTime(32, end);
  subGain.gain.setValueAtTime(0.0001, t);
  subGain.gain.exponentialRampToValueAtTime(0.35 * level, t + 0.02);
  subGain.gain.exponentialRampToValueAtTime(0.0001, end);
  sub.start(t).stop(end + 0.02);

  disposeLater([noise, lp, noiseGain, sub, subGain, panner], dur + 0.8);
}

/** フォール (ピッチが下に「ピューン」と落ちる)。 */
function triggerFall(durationSec: number, velocity: number, time?: number): void {
  const bus = ensureFxBus();
  const dur = Math.max(0.2, Math.min(2.5, durationSec));
  const t = time ?? Tone.now();

  const osc = new Tone.Oscillator(1200, "triangle");
  const gain = new Tone.Gain(0.001).connect(bus);
  osc.connect(gain);
  osc.start(t);
  osc.stop(t + dur + 0.05);
  osc.frequency.setValueAtTime(1200, t);
  osc.frequency.exponentialRampToValueAtTime(80, t + dur);
  const peak = 0.25 + (velocity - 0.5) * 0.2;
  gain.gain.setValueAtTime(0.001, t);
  gain.gain.exponentialRampToValueAtTime(peak, t + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.001, t + dur);

  window.setTimeout(
    () => {
      try {
        osc.dispose();
        gain.dispose();
      } catch {
        /* noop */
      }
    },
    (dur + 0.5) * 1000,
  );
}

/**
 * リバースシンバル。本物のクラッシュシンバルの録音を逆再生し、
 * 一番大きくなる瞬間 (= 元の録音の叩いた瞬間) がちょうど time + durationSec に来るようにする。
 * 録音 (約 4 秒) より長く頼まれた場合は、足りない分だけ遅れて始まる。
 * 読み込み前はノイズで作った代わりの音。
 */
function triggerReverseCymbal(durationSec: number, velocity: number, time?: number): void {
  const bus = ensureFxBus();
  const dur = Math.max(0.3, Math.min(8.0, durationSec));
  const t = time ?? Tone.now();

  if (crashRevBuf && crashRevBuf.loaded) {
    const len = crashRevBuf.duration;
    const offset = Math.max(0, len - dur); // 逆再生の後ろ側 (= 叩いた瞬間に近い側) を使う
    const startAt = t + Math.max(0, dur - len);
    const src = new Tone.ToneBufferSource({ url: crashRevBuf, fadeIn: 0.05, fadeOut: 0.01 }).connect(bus);
    src.start(startAt, offset, len - offset, 0.55 + velocity * 0.45);
    src.onended = () => src.dispose();
    return;
  }

  // 代わりの音: 金属的なノイズがだんだん大きくなる
  const hp = new Tone.Filter({ type: "highpass", frequency: 4000, Q: 0.7 });
  const noise = new Tone.NoiseSynth({
    noise: { type: "white" },
    envelope: { attack: dur * 0.95, decay: 0.01, sustain: 1.0, release: 0.03 },
    volume: -6 + (velocity - 0.5) * 6,
  });
  noise.chain(hp, bus);
  noise.triggerAttackRelease(dur, t);
  disposeLater([noise, hp], dur + 0.6);
}

/**
 * インパクト (サビ頭の「ドーン！」)。
 *   1) 本物のキック (一番強い録音)
 *   2) 本物のクラッシュシンバル
 *   3) 重低音の落下 (55Hz → 30Hz、1.5 秒): 映画の予告編のような「ズーン」
 *   4) ホール残響を多めに送って広がりを出す
 */
function triggerImpact(durationSec: number, velocity: number, time?: number): void {
  const bus = ensureFxBus();
  const dur = Math.max(0.8, Math.min(4.0, durationSec));
  const t = time ?? Tone.now();
  const level = 0.55 + velocity * 0.45;
  const nodes: Array<{ dispose: () => unknown }> = [];

  if (kickBuf && kickBuf.loaded) {
    const k = new Tone.ToneBufferSource({ url: kickBuf }).connect(bus);
    k.start(t, 0, undefined, 0.9 * level);
    k.onended = () => k.dispose();
  }
  if (crashBuf && crashBuf.loaded) {
    const c = new Tone.ToneBufferSource({ url: crashBuf, fadeOut: 0.5 }).connect(bus);
    c.start(t, 0, Math.min(crashBuf.duration, dur + 1), 0.7 * level);
    c.onended = () => c.dispose();
  } else {
    // 代わりの音: ノイズのバースト
    const n = new Tone.NoiseSynth({
      noise: { type: "white" },
      envelope: { attack: 0.002, decay: dur * 0.6, sustain: 0, release: 0.2 },
      volume: -10,
    }).connect(bus);
    n.triggerAttackRelease(dur * 0.6, t);
    nodes.push(n);
  }

  // 重低音の落下
  const sub = new Tone.Oscillator({ frequency: 55, type: "sine" });
  const subGain = new Tone.Gain(0);
  sub.chain(subGain, bus);
  sub.frequency.setValueAtTime(55, t);
  sub.frequency.exponentialRampToValueAtTime(30, t + dur);
  subGain.gain.setValueAtTime(0.0001, t);
  subGain.gain.exponentialRampToValueAtTime(0.5 * level, t + 0.01);
  subGain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  sub.start(t).stop(t + dur + 0.05);
  nodes.push(sub, subGain);

  // この瞬間だけホール残響を多めにして「ドーン…」と広げる
  if (fxHallSend) {
    fxHallSend.gain.setValueAtTime(0.45, t);
    fxHallSend.gain.linearRampToValueAtTime(0.18, t + 1.2);
  }
  disposeLater(nodes, dur + 0.8);
}

/**
 * FX を発音する。
 * @param midi  FX_* 定数のいずれか
 * @param durationSec  FX の長さ (秒)。リバースシンバルやライザーは長めを推奨。
 * @param velocity  0..1
 * @param time  Tone.now() ベースの時刻 (省略時は即時)
 */
export function triggerFx(
  midi: number,
  durationSec: number,
  velocity = 0.9,
  time?: number,
): void {
  void ensureAudio();
  switch (midi) {
    case FX_WHITE_NOISE:
      triggerWhiteNoise(durationSec, velocity, time);
      return;
    case FX_SWEEP_UP:
      triggerSweep(durationSec, velocity, true, time);
      return;
    case FX_SWEEP_DOWN:
      triggerSweep(durationSec, velocity, false, time);
      return;
    case FX_RISER:
      triggerRiser(durationSec, velocity, time);
      return;
    case FX_DOWNLIFTER:
      triggerDownlifter(durationSec, velocity, time);
      return;
    case FX_FALL:
      triggerFall(durationSec, velocity, time);
      return;
    case FX_REVERSE_CYMBAL:
      triggerReverseCymbal(durationSec, velocity, time);
      return;
    case FX_IMPACT:
      triggerImpact(durationSec, velocity, time);
      return;
    default:
      // 未知の MIDI は短いホワイトノイズにフォールバック
      triggerWhiteNoise(Math.max(0.1, durationSec), velocity, time);
  }
}
