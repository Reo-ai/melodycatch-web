/**
 * アコースティックギター (歪みのない撥弦楽器)。
 *
 * 構成:
 * - 音源は **Tone.PluckSynth (Karplus-Strong)** ボイスプール × 8。
 * - 歪み (Distortion / Chebyshev) は **無し**。
 * - 木のボディの胴鳴り (低域共鳴 100/200Hz) と弦の煌めき (高域ピーク 4kHz)
 *   を EQ で作り込み、軽いコーラスで複数の弦が干渉するうねり感を演出する。
 * - さらに弾弦時の「指/ピックの摩擦音」をホワイトノイズの短バーストで重ねて、
 *   アコギ特有の生っぽいアタックを足す。
 * - ショートディレイで「胴の奥で響く反射」を再現し、空間感を作る。
 *
 * シグナルチェーン (ノート信号):
 *   PluckSynth × 8 (attackNoise 1.3, dampening 3800, resonance 0.992)
 *     ──▶ HighPass(70Hz)
 *     ──▶ BodyPeak(110Hz, +4.5dB)      ※ボディ最低共鳴 (より木胴っぽく)
 *     ──▶ BodyPeak2(220Hz, +3.5dB)     ※第二ボディ共鳴 (バス側)
 *     ──▶ MudCut(330Hz, -2.5dB)        ※こもりを除去
 *     ──▶ WoodPeak(800Hz, +1dB)        ※木の中域 (アコギの「ぬくもり」)
 *     ──▶ MidPeak(1.8kHz, +0.8dB)      ※コードの輪郭 (控えめに)
 *     ──▶ PresencePeak(2.6kHz, +1.5dB) ※指弾きの自然な存在感 (エレキ的な 4kHz は避ける)
 *     ──▶ AirShelf(10kHz, +0.6dB)      ※空気感 (ほんのり)
 *     ──▶ LowPass(9.5kHz)              ※エレキっぽい超高域をバッサリ
 *     ──▶ FeedbackDelay(45ms, 0.16, wet 0.06)   ※胴の奥での反射 (薄め)
 *     ──▶ Chorus(0.4Hz, depth 0.35, wet 0.08)   ※弦のうねり (ごく薄く)
 *     ──▶ Gain ──▶ Reverb(decay 3.0, wet 0.3)  ──▶ Destination
 *
 * アタックノイズチェーン (発音時に並列で短時間鳴る):
 *   NoiseSynth (white, decay 0.04s)
 *     ──▶ HighPass(2500Hz)
 *     ──▶ Gain(0.06)
 *     ──▶ (共通の Reverb 入口へ)
 */

import * as Tone from "tone";
import { midiToNoteString } from "../music/pitch";
import { getMixerInput } from "./mixer";

const VOICE_COUNT = 8;

let acReverb: Tone.Reverb | null = null;
let acChorus: Tone.Chorus | null = null;
let acDelay: Tone.FeedbackDelay | null = null;
let acLowpass: Tone.Filter | null = null;
let acAirShelf: Tone.Filter | null = null;
let acPresencePeak: Tone.Filter | null = null;
let acMidPeak: Tone.Filter | null = null;
let acWoodPeak: Tone.Filter | null = null;
let acMudCut: Tone.Filter | null = null;
let acBodyPeak2: Tone.Filter | null = null;
let acBodyPeak: Tone.Filter | null = null;
let acHighpass: Tone.Filter | null = null;
let acGain: Tone.Gain | null = null;
let acVoices: Tone.PluckSynth[] = [];
/** アタックノイズ (ピック/指のスクラッチ) 用。発音時に短時間トリガする。 */
let acAttackNoise: Tone.NoiseSynth | null = null;
let voiceCursor = 0;
const noteToVoice: Map<number, Tone.PluckSynth> = new Map();
const noteToRepluckTimer: Map<number, number> = new Map();
/** アコギは減衰がゆるやかで「鳴りっぱなし」感が出やすいので、エレキより少し短めの間隔で再ピック。 */
const REPLUCK_DELAY_MS = 1300;
const REPLUCK_DECAY_DB = -2;

function ensureAcoustic() {
  if (acVoices.length > 0) return;
  // 終段: Reverb → Destination
  acReverb = new Tone.Reverb({ decay: 3.0, wet: 0.3 }).connect(getMixerInput("acoustic"));
  acGain = new Tone.Gain(0.58).connect(acReverb);
  // 弦のうねり — エレクトロっぽさを避けるため、コーラスはごく薄く。
  acChorus = new Tone.Chorus({
    frequency: 0.4,
    delayTime: 3.8,
    depth: 0.35,
    type: "sine",
    spread: 180,
    wet: 0.08,
  }).connect(acGain);
  acChorus.start();
  // 胴の奥での反射 — ディレイ感を控えめに (空間エフェクトを薄く)。
  acDelay = new Tone.FeedbackDelay({
    delayTime: 0.045,
    feedback: 0.16,
    wet: 0.06,
  }).connect(acChorus);
  // 超高域をしっかりカットして、エレキ的な「シャリ感」を排除。
  acLowpass = new Tone.Filter({
    frequency: 9500,
    type: "lowpass",
    Q: 0.5,
    rolloff: -24,
  }).connect(acDelay);
  // 空気感 (10kHz 以上をほんのり)。エレキっぽい強い air は避ける。
  acAirShelf = new Tone.Filter({
    frequency: 10000,
    type: "highshelf",
    gain: 0.6,
  }).connect(acLowpass);
  // 指弾きの自然な存在感 (2.6kHz)。エレキ的な 4kHz プレゼンスは避ける。
  acPresencePeak = new Tone.Filter({
    frequency: 2600,
    type: "peaking",
    Q: 0.9,
    gain: 1.5,
  }).connect(acAirShelf);
  // コードの輪郭 (中域、控えめに)。
  acMidPeak = new Tone.Filter({
    frequency: 1800,
    type: "peaking",
    Q: 1.1,
    gain: 0.8,
  }).connect(acPresencePeak);
  // 木の中域の「ぬくもり」を 800Hz 付近で軽く足す。
  acWoodPeak = new Tone.Filter({
    frequency: 800,
    type: "peaking",
    Q: 1.0,
    gain: 1,
  }).connect(acMidPeak);
  // こもりカット (330Hz)。
  acMudCut = new Tone.Filter({
    frequency: 330,
    type: "peaking",
    Q: 1.2,
    gain: -2.5,
  }).connect(acWoodPeak);
  // 第二ボディ共鳴 (220Hz 付近の「ボーン」)。
  acBodyPeak2 = new Tone.Filter({
    frequency: 220,
    type: "peaking",
    Q: 1.3,
    gain: 3.5,
  }).connect(acMudCut);
  // ボディ最低共鳴 (110Hz 付近の「胴」)。木胴感をしっかり。
  acBodyPeak = new Tone.Filter({
    frequency: 110,
    type: "peaking",
    Q: 1.2,
    gain: 4.5,
  }).connect(acBodyPeak2);
  acHighpass = new Tone.Filter({
    frequency: 70,
    type: "highpass",
  }).connect(acBodyPeak);

  for (let i = 0; i < VOICE_COUNT; i++) {
    const v = new Tone.PluckSynth({
      // 指/ピックの摩擦音を抑えめにしてエレクトロっぽい鋭さを避ける。
      attackNoise: 1.3,
      // dampening を下げて高域を早めに減衰 → エレキ的な「シャリーン」を抑える。
      dampening: 3800,
      // サステインは鉄弦アコギらしくゆっくりめに。
      resonance: 0.992,
      release: 1.2,
    });
    v.volume.value = -2;
    v.connect(acHighpass);
    acVoices.push(v);
  }

  // アタックノイズ: 指/ピックで弦を弾いた瞬間の摩擦音。
  // エレキっぽい鋭さを抑えるため、HPF を下げて全体音量も控えめにする。
  const noiseHP = new Tone.Filter({
    frequency: 2000,
    type: "highpass",
    Q: 0.5,
  });
  const noiseGain = new Tone.Gain(0.035);
  acAttackNoise = new Tone.NoiseSynth({
    noise: { type: "white" },
    envelope: { attack: 0.001, decay: 0.035, sustain: 0, release: 0.04 },
  });
  acAttackNoise.volume.value = -17;
  acAttackNoise.connect(noiseHP);
  noiseHP.connect(noiseGain);
  noiseGain.connect(acHighpass);
}

/** ピック/指で弦をはじく瞬間のスクラッチ音を鳴らす。 */
function triggerAttackNoise(velocity: number, time?: number): void {
  if (!acAttackNoise) return;
  try {
    // velocity に応じてノイズの音量を微調整。エレキっぽい鋭さを抑えるため控えめに。
    acAttackNoise.volume.value = -17 + (clamp01(velocity) - 0.85) * 5;
    acAttackNoise.triggerAttackRelease(0.035, time);
  } catch {
    /* 高速連打時の TimeError は無視 */
  }
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function nextVoice(): Tone.PluckSynth {
  const v = acVoices[voiceCursor];
  voiceCursor = (voiceCursor + 1) % acVoices.length;
  return v;
}

function clearRepluckTimer(midi: number): void {
  const t = noteToRepluckTimer.get(midi);
  if (t !== undefined) {
    window.clearTimeout(t);
    noteToRepluckTimer.delete(midi);
  }
}

function scheduleRepluck(midi: number, baseVolumeDb: number, step: number): void {
  const handle = window.setTimeout(() => {
    const v = noteToVoice.get(midi);
    if (!v) {
      noteToRepluckTimer.delete(midi);
      return;
    }
    const decayed = Math.max(baseVolumeDb + REPLUCK_DECAY_DB * step, -16);
    v.volume.value = decayed;
    v.triggerAttack(midiToNoteString(midi));
    scheduleRepluck(midi, baseVolumeDb, step + 1);
  }, REPLUCK_DELAY_MS);
  noteToRepluckTimer.set(midi, handle);
}

export function acousticHoldOn(midi: number, velocity = 0.85): void {
  ensureAcoustic();
  clearRepluckTimer(midi);
  const v = nextVoice();
  noteToVoice.set(midi, v);
  const baseVolumeDb = -2 + (clamp01(velocity) - 0.85) * 8;
  v.volume.value = baseVolumeDb;
  triggerAttackNoise(velocity);
  v.triggerAttack(midiToNoteString(midi));
  scheduleRepluck(midi, baseVolumeDb, 1);
}

export function acousticHoldOff(midi: number): void {
  clearRepluckTimer(midi);
  const v = noteToVoice.get(midi);
  if (!v) return;
  noteToVoice.delete(midi);
  v.triggerRelease();
}

export function acousticTriggerNote(
  midi: number,
  durationSec: number,
  velocity = 0.85,
  time?: number,
): void {
  ensureAcoustic();
  const v = nextVoice();
  v.volume.value = -2 + (clamp01(velocity) - 0.85) * 8;
  triggerAttackNoise(velocity, time);
  v.triggerAttackRelease(
    midiToNoteString(midi),
    Math.max(0.05, durationSec),
    time,
  );
}

/**
 * 和音をストロークで鳴らす (低音 → 高音にずらしてジャラン感)。
 * エレキより少し速めの strum (12ms) でアコギらしい鋭さに。
 */
export function acousticChordOn(
  midiNotes: number[],
  velocity = 0.8,
  duration = 1.4,
): void {
  ensureAcoustic();
  const sorted = [...midiNotes].sort((a, b) => a - b);
  const strumStep = 12;
  sorted.forEach((m, i) => {
    window.setTimeout(() => {
      acousticTriggerNote(m, duration, velocity);
    }, i * strumStep);
  });
}

export function acousticReleaseAll(): void {
  for (const handle of noteToRepluckTimer.values()) {
    window.clearTimeout(handle);
  }
  noteToRepluckTimer.clear();
  noteToVoice.clear();
  for (const v of acVoices) {
    v.triggerRelease();
  }
}
