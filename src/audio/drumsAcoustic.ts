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
// ---------------------------------------------------------------------------
let aBus: Tone.Channel | null = null;
let aComp: Tone.Compressor | null = null;
let aEq: Tone.EQ3 | null = null;

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

  // 音量を大きめに (+5 dB) 取りつつ、ナチュラルなコンプ
  aComp = new Tone.Compressor({
    threshold: -14,
    ratio: 2.2,
    attack: 0.005,
    release: 0.18,
  }).toDestination();
  aEq = new Tone.EQ3({ low: 3, mid: 0.5, high: 2 }).connect(aComp);
  aBus = new Tone.Channel({ volume: 5 }).connect(aEq);

  // ---- KICK : サブ (低胴・短め) + ボディ (中胴・スクエア寄り) + ビーター (鋭い HPF)
  aKickSub = new Tone.MembraneSynth({
    pitchDecay: 0.04,
    octaves: 7,
    envelope: { attack: 0.001, decay: 0.42, sustain: 0, release: 0.45 },
    oscillator: { type: "sine" },
    volume: 0,
  }).connect(aBus);
  aKickBody = new Tone.MembraneSynth({
    pitchDecay: 0.035,
    octaves: 5,
    envelope: { attack: 0.001, decay: 0.28, sustain: 0, release: 0.26 },
    oscillator: { type: "square" },
    volume: -8,
  }).connect(aBus);
  aKickBeaterHPF = new Tone.Filter({ type: "highpass", frequency: 3000, Q: 0.9 });
  aKickBeater = new Tone.NoiseSynth({
    noise: { type: "pink" },
    envelope: { attack: 0.0008, decay: 0.022, sustain: 0, release: 0.01 },
    volume: -10,
  }).chain(aKickBeaterHPF, aBus);

  // ---- SNARE : 2 つの胴 + ロック向けの鋭いバンドパス + 短めテイル
  aSnareShellHi = new Tone.MembraneSynth({
    pitchDecay: 0.012,
    octaves: 3,
    envelope: { attack: 0.001, decay: 0.18, sustain: 0, release: 0.15 },
    oscillator: { type: "triangle" },
    volume: -10,
  }).connect(aBus);
  aSnareShellLo = new Tone.MembraneSynth({
    pitchDecay: 0.018,
    octaves: 3,
    envelope: { attack: 0.001, decay: 0.22, sustain: 0, release: 0.18 },
    oscillator: { type: "sine" },
    volume: -12,
  }).connect(aBus);
  aSnareBP = new Tone.Filter({ type: "bandpass", frequency: 4500, Q: 1.2 });
  aSnareNoise = new Tone.NoiseSynth({
    noise: { type: "white" },
    envelope: { attack: 0.001, decay: 0.18, sustain: 0, release: 0.15 },
    volume: -4,
  }).chain(aSnareBP, aBus);
  aSnareTailHPF = new Tone.Filter({ type: "highpass", frequency: 5000, Q: 0.5 });
  aSnareTail = new Tone.NoiseSynth({
    noise: { type: "white" },
    envelope: { attack: 0.001, decay: 0.18, sustain: 0, release: 0.14 },
    volume: -14,
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

/**
 * 生ドラムを 1 発鳴らす。
 * Clap (DRUM_CLAP_MIDI) も生ドラム専用シンセを aBus 上に持つ。
 */
export function triggerDrumHitAcoustic(
  midi: number,
  time?: number,
  velocity = 0.85,
) {
  ensureAcousticDrums();
  const v = Math.max(0.05, Math.min(1, velocity));
  const t = time ?? Tone.now();
  switch (midi) {
    case DRUM_CLAP_MIDI:
      // 3 連打感を出すために少しずらして 2 発
      aClapNoise?.triggerAttackRelease(0.05, t, v);
      aClapNoise?.triggerAttackRelease(0.14, t + 0.014, v * 0.85);
      return;
    case DRUM_KICK_MIDI:
      aKickSub?.triggerAttackRelease("A1", "4n", t, v);
      aKickBody?.triggerAttackRelease("C2", "8n", t, v * 0.85);
      aKickBeater?.triggerAttackRelease(0.025, t, v * 0.6);
      return;
    case DRUM_SNARE_MIDI:
      aSnareShellHi?.triggerAttackRelease("E3", 0.14, t, v * 0.7);
      aSnareShellLo?.triggerAttackRelease("A2", 0.18, t, v * 0.6);
      aSnareNoise?.triggerAttackRelease(0.2, t, v);
      aSnareTail?.triggerAttackRelease(0.34, t, v * 0.5);
      return;
    case DRUM_RIM_MIDI:
      aRimNoise?.triggerAttackRelease(0.035, t, v);
      aRimClick?.triggerAttackRelease("A4", 0.04, t, v * 0.7);
      return;
    case DRUM_HIHAT_MIDI:
      aHatMetal?.triggerAttackRelease("C6", 0.06, t, v * 0.7);
      return;
    case DRUM_HIHAT_OPEN_MIDI:
      aHatOpenMetal?.triggerAttackRelease("C6", 0.35, t, v * 0.7);
      aHatOpenNoise?.triggerAttackRelease(0.4, t, v * 0.6);
      return;
    case DRUM_CRASH_MIDI:
      aCrashMetal?.triggerAttackRelease("C5", 1.6, t, v * 0.8);
      aCrashNoise?.triggerAttackRelease(1.6, t, v * 0.6);
      return;
    case DRUM_RIDE_MIDI:
      aRideBell?.triggerAttackRelease("C5", 0.5, t, v * 0.55);
      aRideStick?.triggerAttackRelease(0.14, t, v * 0.7);
      return;
    case DRUM_TOM_LO_MIDI:
      aTomLo?.triggerAttackRelease("F2", "4n", t, v);
      return;
    case DRUM_TOM_MID_MIDI:
      aTomMid?.triggerAttackRelease("A2", "4n", t, v);
      return;
    case DRUM_TOM_HI_MIDI:
      aTomHi?.triggerAttackRelease("D3", "8n", t, v);
      return;
    default:
      return;
  }
}
