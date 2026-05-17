/**
 * 生ドラム (アコースティック寄り) サウンドエンジン。
 *
 * `drums.ts` の電子ドラム版より「生っぽさ」と「音量」を強化した別キット。
 *  - Kick : 深い胴鳴り (低めピッチ + 長めサスティン) + ビーターアタック
 *  - Snare: 2 層のシェル胴 + バンドパスノイズで長めのテイル
 *  - Toms : ピッチ追従の MembraneSynth + 倍音
 *  - Hat 閉: MetalSynth で金属的に
 *  - Hat 開: MetalSynth + ノイズシマー
 *  - Crash: MetalSynth + 長尺ホワイトノイズ
 *  - Ride : MetalSynth (ベル) + 細かいスティック粒
 *  - Rim  : 硬めの木質パーカッション
 *  - Clap : ユーザーリクエスト通り `drums.ts` 側 (電子) を流用
 *
 * `triggerDrumHitAcoustic(midi, time?, velocity)` を呼ぶ。
 * LiveDrumKit / 録音再生 (drumAcoustic レイヤー) から共有。
 */

import * as Tone from "tone";
import {
  DRUM_CLAP_MIDI,
  DRUM_CRASH_MIDI,
  DRUM_HIHAT_MIDI,
  DRUM_HIHAT_OPEN_MIDI,
  DRUM_KICK_MIDI,
  DRUM_RIDE_MIDI,
  DRUM_RIM_MIDI,
  DRUM_SNARE_MIDI,
  DRUM_TOM_HI_MIDI,
  DRUM_TOM_LO_MIDI,
  DRUM_TOM_MID_MIDI,
} from "./drums";

// ---------------------------------------------------------------------------
// Master chain (生ドラム専用バス)
//
// 生ドラムらしさの肝は「単発のシンセ音色」よりも「全体の処理 (圧縮・部屋鳴り・
// アタックの強調)」と「人間味 (ベロシティ揺らぎ・微妙なタイミング揺らぎ・
// ゴーストノート)」にある。ここではマスタチェーンを
//   [ kit bus ] → [ EQ3 ] → [ glue compressor ] → [ destination ]
//                      └→ [ room send → short reverb → destination ]
// の 2 系統に分け、各楽器の triggerAttackRelease 後に微小なランダマイズを
// かけて生っぽさを出す。
// ---------------------------------------------------------------------------
let aBus: Tone.Channel | null = null;
let aComp: Tone.Compressor | null = null;
let aEq: Tone.EQ3 | null = null;
/** 部屋鳴り送り用 (バスから分岐して短いリバーブに送る)。 */
let aRoomSend: Tone.Gain | null = null;
let aRoomReverb: Tone.Reverb | null = null;
/** 全体に薄くかけるサチュレーション (アナログ感)。 */
let aSat: Tone.Distortion | null = null;

// ---- Kick ----
let aKickSub: Tone.MembraneSynth | null = null;
let aKickBody: Tone.MembraneSynth | null = null;
let aKickBeater: Tone.NoiseSynth | null = null;
let aKickBeaterHPF: Tone.Filter | null = null;

// ---- Snare ----
let aSnareShellHi: Tone.MembraneSynth | null = null;
let aSnareShellLo: Tone.MembraneSynth | null = null;
let aSnareNoise: Tone.NoiseSynth | null = null;
let aSnareBP: Tone.Filter | null = null;
let aSnareTailHPF: Tone.Filter | null = null;
let aSnareTail: Tone.NoiseSynth | null = null;

// ---- Rim ----
let aRimNoise: Tone.NoiseSynth | null = null;
let aRimBP: Tone.Filter | null = null;
let aRimClick: Tone.MembraneSynth | null = null;

// ---- Hi-hat closed ----
let aHatMetal: Tone.MetalSynth | null = null;
let aHatHPF: Tone.Filter | null = null;

// ---- Hi-hat open ----
let aHatOpenMetal: Tone.MetalSynth | null = null;
let aHatOpenNoise: Tone.NoiseSynth | null = null;
let aHatOpenHPF: Tone.Filter | null = null;

// ---- Crash ----
let aCrashMetal: Tone.MetalSynth | null = null;
let aCrashNoise: Tone.NoiseSynth | null = null;
let aCrashHPF: Tone.Filter | null = null;

// ---- Ride ----
let aRideBell: Tone.MetalSynth | null = null;
let aRideStick: Tone.NoiseSynth | null = null;
let aRideStickBP: Tone.Filter | null = null;

// ---- Toms ----
let aTomLo: Tone.MembraneSynth | null = null;
let aTomMid: Tone.MembraneSynth | null = null;
let aTomHi: Tone.MembraneSynth | null = null;

// ---- Clap (生ドラム専用) ----
let aClapNoise: Tone.NoiseSynth | null = null;
let aClapBP: Tone.Filter | null = null;

function ensureAcousticDrums() {
  if (aKickSub) return;

  // === マスタチェーン ===
  // 1. ナチュラルなグルーコンプ (バス全体をまとめる)
  aComp = new Tone.Compressor({
    threshold: -14,
    ratio: 2.4,
    attack: 0.004,
    release: 0.16,
    knee: 8,
  }).toDestination();
  // 2. 軽いテープ風サチュレーション (アナログ感)
  aSat = new Tone.Distortion({ distortion: 0.06, wet: 0.35 }).connect(aComp);
  // 3. EQ で低域を持ち上げ・中域少し下げ・高域シルキーに
  aEq = new Tone.EQ3({ low: 3.5, mid: -0.5, high: 2.5, lowFrequency: 220, highFrequency: 3200 }).connect(aSat);

  // 4. 部屋鳴りリバーブ (短く、初期反射感を出す)
  aRoomReverb = new Tone.Reverb({ decay: 1.2, preDelay: 0.012, wet: 1.0 }).toDestination();
  aRoomSend = new Tone.Gain(0.15).connect(aRoomReverb);

  // 5. メインバス: ドライ (EQ→sat→comp) と Wet (room) の 2 系統に送る
  aBus = new Tone.Channel({ volume: 5 });
  aBus.connect(aEq);
  aBus.connect(aRoomSend);

  // ---- KICK : サブ (低胴・タイト) + ボディ (中胴・スクエア寄り) + ビーター (アタック)
  // 実機キックは「低音の押し込み」と「ビーターのコンッ」の二層構造。
  // ここでは Sub を A0 付近まで下げ、Body は短めの低中音、Beater はクリックノイズで担当。
  aKickSub = new Tone.MembraneSynth({
    pitchDecay: 0.05,
    octaves: 8,
    envelope: { attack: 0.001, decay: 0.5, sustain: 0, release: 0.5 },
    oscillator: { type: "sine" },
    volume: 2,
  }).connect(aBus);
  aKickBody = new Tone.MembraneSynth({
    pitchDecay: 0.03,
    octaves: 4.5,
    envelope: { attack: 0.001, decay: 0.22, sustain: 0, release: 0.22 },
    oscillator: { type: "triangle" },
    volume: -7,
  }).connect(aBus);
  // ビーター: より広帯域 (2.2kHz〜) かつ短いトランジェントでクリックを強調
  aKickBeaterHPF = new Tone.Filter({ type: "highpass", frequency: 2200, Q: 0.7 });
  aKickBeater = new Tone.NoiseSynth({
    noise: { type: "pink" },
    envelope: { attack: 0.0005, decay: 0.018, sustain: 0, release: 0.008 },
    volume: -8,
  }).chain(aKickBeaterHPF, aBus);

  // ---- SNARE : 胴の倍音 2 層 + スネアワイヤノイズ (BP) + テイル (HPF)
  // 実機スネアの音は「胴の鳴り (200Hz / 400Hz 付近)」+「スネアワイヤ (3〜6kHz の
  // バンドパスノイズ)」+「上半部のサスティン (HPF ノイズの長め減衰)」が混ざる。
  aSnareShellHi = new Tone.MembraneSynth({
    pitchDecay: 0.01,
    octaves: 3.5,
    envelope: { attack: 0.001, decay: 0.16, sustain: 0, release: 0.14 },
    oscillator: { type: "triangle" },
    volume: -8,
  }).connect(aBus);
  aSnareShellLo = new Tone.MembraneSynth({
    pitchDecay: 0.02,
    octaves: 3,
    envelope: { attack: 0.001, decay: 0.2, sustain: 0, release: 0.18 },
    oscillator: { type: "sine" },
    volume: -10,
  }).connect(aBus);
  // メインのスネアワイヤ: 強めの Q + 3.8kHz 中心で「パンッ」を強調
  aSnareBP = new Tone.Filter({ type: "bandpass", frequency: 3800, Q: 1.4 });
  aSnareNoise = new Tone.NoiseSynth({
    noise: { type: "white" },
    envelope: { attack: 0.0008, decay: 0.16, sustain: 0, release: 0.14 },
    volume: -2,
  }).chain(aSnareBP, aBus);
  // テイル: 高域を長めに残してリリースの「シャラ…」感を出す
  aSnareTailHPF = new Tone.Filter({ type: "highpass", frequency: 4500, Q: 0.5 });
  aSnareTail = new Tone.NoiseSynth({
    noise: { type: "white" },
    envelope: { attack: 0.001, decay: 0.24, sustain: 0, release: 0.2 },
    volume: -13,
  }).chain(aSnareTailHPF, aBus);

  // ---- RIM : 木のリム + 短いクリック
  aRimBP = new Tone.Filter({ type: "bandpass", frequency: 1400, Q: 5 });
  aRimNoise = new Tone.NoiseSynth({
    noise: { type: "pink" },
    envelope: { attack: 0.0005, decay: 0.035, sustain: 0, release: 0.02 },
    volume: -8,
  }).chain(aRimBP, aBus);
  aRimClick = new Tone.MembraneSynth({
    pitchDecay: 0.005,
    octaves: 2,
    envelope: { attack: 0.001, decay: 0.05, sustain: 0, release: 0.04 },
    oscillator: { type: "square" },
    volume: -22,
  }).connect(aBus);

  // ---- HAT CLOSED : 非整数 harmonicity でロックっぽい金属感
  aHatHPF = new Tone.Filter({ type: "highpass", frequency: 8000, Q: 0.6 });
  aHatMetal = new Tone.MetalSynth({
    envelope: { attack: 0.001, decay: 0.06, release: 0.03 },
    harmonicity: 3.7,
    modulationIndex: 32,
    resonance: 7200,
    octaves: 1.4,
    volume: -16,
  }).chain(aHatHPF, aBus);

  // ---- HAT OPEN : 同じく + 長めシマー (ノイズで支援)
  aHatOpenHPF = new Tone.Filter({ type: "highpass", frequency: 7200, Q: 0.6 });
  aHatOpenMetal = new Tone.MetalSynth({
    envelope: { attack: 0.001, decay: 0.4, release: 0.25 },
    harmonicity: 4.1,
    modulationIndex: 30,
    resonance: 6800,
    octaves: 1.5,
    volume: -16,
  }).chain(aHatOpenHPF, aBus);
  aHatOpenNoise = new Tone.NoiseSynth({
    noise: { type: "white" },
    envelope: { attack: 0.002, decay: 0.45, sustain: 0, release: 0.25 },
    volume: -22,
  }).chain(aHatOpenHPF, aBus);

  // ---- CRASH : 大きい金物 + 長いノイズシマー (非整数倍音)
  aCrashHPF = new Tone.Filter({ type: "highpass", frequency: 4200, Q: 0.4 });
  aCrashMetal = new Tone.MetalSynth({
    envelope: { attack: 0.001, decay: 1.8, release: 1.0 },
    harmonicity: 5.3,
    modulationIndex: 50,
    resonance: 5500,
    octaves: 2,
    volume: -14,
  }).chain(aCrashHPF, aBus);
  aCrashNoise = new Tone.NoiseSynth({
    noise: { type: "white" },
    envelope: { attack: 0.001, decay: 1.8, sustain: 0, release: 1.0 },
    volume: -18,
  }).chain(aCrashHPF, aBus);

  // ---- RIDE : ベル中心 + スティック粒 (非整数倍音)
  aRideBell = new Tone.MetalSynth({
    envelope: { attack: 0.001, decay: 0.55, release: 0.4 },
    harmonicity: 3.9,
    modulationIndex: 28,
    resonance: 4800,
    octaves: 1.6,
    volume: -16,
  }).connect(aBus);
  aRideStickBP = new Tone.Filter({ type: "bandpass", frequency: 5800, Q: 1.6 });
  aRideStick = new Tone.NoiseSynth({
    noise: { type: "white" },
    envelope: { attack: 0.001, decay: 0.16, sustain: 0, release: 0.12 },
    volume: -18,
  }).chain(aRideStickBP, aBus);

  // ---- TOMS : ロック寄りに octaves/pitchDecay を絞り、アタックを強く
  aTomLo = new Tone.MembraneSynth({
    pitchDecay: 0.04,
    octaves: 3.5,
    envelope: { attack: 0.001, decay: 0.55, sustain: 0, release: 0.4 },
    oscillator: { type: "sine" },
    volume: -2,
  }).connect(aBus);
  aTomMid = new Tone.MembraneSynth({
    pitchDecay: 0.04,
    octaves: 3.5,
    envelope: { attack: 0.001, decay: 0.45, sustain: 0, release: 0.35 },
    oscillator: { type: "sine" },
    volume: -3,
  }).connect(aBus);
  aTomHi = new Tone.MembraneSynth({
    pitchDecay: 0.04,
    octaves: 3.5,
    envelope: { attack: 0.001, decay: 0.35, sustain: 0, release: 0.28 },
    oscillator: { type: "sine" },
    volume: -3,
  }).connect(aBus);

  // ---- CLAP : 生ドラム専用 (大きめ音量で aBus へ)
  aClapBP = new Tone.Filter({ type: "bandpass", frequency: 1700, Q: 1.0 });
  aClapNoise = new Tone.NoiseSynth({
    noise: { type: "white" },
    envelope: { attack: 0.001, decay: 0.2, sustain: 0, release: 0.12 },
    volume: -2,
  }).chain(aClapBP, aBus);
}

// ---------------------------------------------------------------------------
// Humanization helpers
//
// 実機ドラマーは、同じ拍の同じヒットでも毎回まったく同じ音にはならない:
//   - ベロシティが ±10〜15% 揺らぐ
//   - スティック位置や角度で音色が微妙に変わる (ピッチが ±数十セント揺れる)
//   - タイミングが ±数 ms 前後する (バスドラ / スネアは正確、ハットは揺らぎ大)
// この差が「打ち込み」と「生演奏」の最大の違い。
// ここではトリガー時に決定論的でない (Math.random) 揺らぎを乗せる。
// ---------------------------------------------------------------------------

/** ベロシティを ±range の比率で揺らす。 */
function jitterVel(v: number, range: number): number {
  const j = 1 + (Math.random() * 2 - 1) * range;
  return Math.max(0.05, Math.min(1, v * j));
}

/** ピッチ (周波数) を半音 ±range セントの範囲で揺らす。
 *  Tone の MembraneSynth は note を文字列でも数値でも受けるが、
 *  軽い揺らぎは "ピッチ" ではなく playbackRate 相当で出すと自然。
 *  ここでは MIDI ノートを 0.01 半音単位でずらして対応する。 */
function jitterPitch(noteOrMidi: number, semitones: number): number {
  return noteOrMidi + (Math.random() * 2 - 1) * semitones;
}

/** タイミングを ±ms 揺らす (秒単位に変換)。 */
function jitterTime(t: number, ms: number): number {
  return t + ((Math.random() * 2 - 1) * ms) / 1000;
}

/** MIDI 数値を Tone 用のノート文字列に変換 (sharp 表記)。 */
const PC_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
function midiToNote(midi: number): string {
  const pc = ((Math.round(midi) % 12) + 12) % 12;
  const octave = Math.floor(Math.round(midi) / 12) - 1;
  return `${PC_NAMES[pc]}${octave}`;
}

/**
 * 生ドラムを 1 発鳴らす。
 * Clap (DRUM_CLAP_MIDI) も生ドラム専用シンセを aBus 上に持つ。
 *
 * velocity がかなり小さい (< 0.35) ヒットは "ゴーストノート" 扱いとし、
 * 倍音 / テイル成分を弱めて柔らかい音色にする (スネアは特に効く)。
 */
export function triggerDrumHitAcoustic(
  midi: number,
  time?: number,
  velocity = 0.85,
) {
  ensureAcousticDrums();
  const vRaw = Math.max(0.05, Math.min(1, velocity));
  const t0 = time ?? Tone.now();
  // ゴースト判定 (微弱な裏拍ヒット)
  const ghost = vRaw < 0.35;

  switch (midi) {
    case DRUM_CLAP_MIDI: {
      // 3 連打感を出すために少しずらして 2 発、各回タイミング・ベロシティを揺らす
      const v = jitterVel(vRaw, 0.08);
      aClapNoise?.triggerAttackRelease(0.05, jitterTime(t0, 2), v);
      aClapNoise?.triggerAttackRelease(0.14, t0 + 0.014 + (Math.random() * 0.006 - 0.003), v * jitterVel(0.85, 0.1));
      return;
    }
    case DRUM_KICK_MIDI: {
      // キックはタイミング揺らぎ小 (±2ms 程度)、ピッチも狭く
      const t = jitterTime(t0, 2);
      const v = jitterVel(vRaw, 0.06);
      const subPitch = jitterPitch(33, 0.1); // A1 = 33
      const bodyPitch = jitterPitch(36, 0.1); // C2
      aKickSub?.triggerAttackRelease(midiToNote(subPitch), "4n", t, v);
      aKickBody?.triggerAttackRelease(midiToNote(bodyPitch), "8n", t, v * 0.85);
      // 強く叩くほどビーターの "コンッ" が際立つ
      aKickBeater?.triggerAttackRelease(0.022, t, v * (0.55 + vRaw * 0.35));
      return;
    }
    case DRUM_SNARE_MIDI: {
      // スネアはタイミング揺らぎ ±3ms、ベロシティ ±10%
      const t = jitterTime(t0, 3);
      const v = jitterVel(vRaw, 0.1);
      // ゴーストは胴鳴り＋ノイズを大幅に弱め、テイルもほぼ無く
      const shellMul = ghost ? 0.35 : 0.7;
      const noiseMul = ghost ? 0.45 : 1.0;
      const tailMul = ghost ? 0.0 : 0.55;
      aSnareShellHi?.triggerAttackRelease(midiToNote(jitterPitch(52, 0.15)), 0.13, t, v * shellMul);
      aSnareShellLo?.triggerAttackRelease(midiToNote(jitterPitch(45, 0.15)), 0.18, t, v * shellMul * 0.85);
      aSnareNoise?.triggerAttackRelease(0.18 + Math.random() * 0.03, t, v * noiseMul);
      if (!ghost) {
        aSnareTail?.triggerAttackRelease(0.32 + Math.random() * 0.05, t, v * tailMul);
      }
      return;
    }
    case DRUM_RIM_MIDI: {
      const t = jitterTime(t0, 2);
      const v = jitterVel(vRaw, 0.08);
      aRimNoise?.triggerAttackRelease(0.035, t, v);
      aRimClick?.triggerAttackRelease(midiToNote(jitterPitch(69, 0.2)), 0.04, t, v * 0.7);
      return;
    }
    case DRUM_HIHAT_MIDI: {
      // ハットは生っぽさが特に出る部分: タイミング ±6ms、ベロシティ ±15%、強弱で帯域変化
      const t = jitterTime(t0, 6);
      const v = jitterVel(vRaw, 0.15);
      // 強く叩くほど高域が伸びる (チック→チッ→チャッ)
      const decay = 0.04 + vRaw * 0.05;
      aHatMetal?.triggerAttackRelease("C6", decay, t, v * 0.7);
      return;
    }
    case DRUM_HIHAT_OPEN_MIDI: {
      const t = jitterTime(t0, 5);
      const v = jitterVel(vRaw, 0.1);
      aHatOpenMetal?.triggerAttackRelease("C6", 0.35 + Math.random() * 0.08, t, v * 0.7);
      aHatOpenNoise?.triggerAttackRelease(0.4 + Math.random() * 0.08, t, v * 0.6);
      return;
    }
    case DRUM_CRASH_MIDI: {
      const t = jitterTime(t0, 4);
      const v = jitterVel(vRaw, 0.07);
      aCrashMetal?.triggerAttackRelease("C5", 1.6 + Math.random() * 0.2, t, v * 0.8);
      aCrashNoise?.triggerAttackRelease(1.6 + Math.random() * 0.2, t, v * 0.6);
      return;
    }
    case DRUM_RIDE_MIDI: {
      const t = jitterTime(t0, 4);
      const v = jitterVel(vRaw, 0.1);
      aRideBell?.triggerAttackRelease("C5", 0.45 + Math.random() * 0.1, t, v * 0.55);
      aRideStick?.triggerAttackRelease(0.14, t, v * 0.7);
      return;
    }
    case DRUM_TOM_LO_MIDI: {
      const t = jitterTime(t0, 3);
      const v = jitterVel(vRaw, 0.08);
      aTomLo?.triggerAttackRelease(midiToNote(jitterPitch(41, 0.2)), "4n", t, v);
      return;
    }
    case DRUM_TOM_MID_MIDI: {
      const t = jitterTime(t0, 3);
      const v = jitterVel(vRaw, 0.08);
      aTomMid?.triggerAttackRelease(midiToNote(jitterPitch(45, 0.2)), "4n", t, v);
      return;
    }
    case DRUM_TOM_HI_MIDI: {
      const t = jitterTime(t0, 3);
      const v = jitterVel(vRaw, 0.08);
      aTomHi?.triggerAttackRelease(midiToNote(jitterPitch(50, 0.2)), "8n", t, v);
      return;
    }
    default:
      return;
  }
}
