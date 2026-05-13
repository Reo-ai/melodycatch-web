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
 *   PluckSynth × 8 (attackNoise 1.8, dampening 5200, resonance 0.992)
 *     ──▶ HighPass(70Hz)
 *     ──▶ BodyPeak(110Hz, +4dB)        ※ボディ最低共鳴
 *     ──▶ BodyPeak2(220Hz, +3dB)       ※第二ボディ共鳴 (バス側)
 *     ──▶ MudCut(330Hz, -2.5dB)        ※こもりを除去
 *     ──▶ MidPeak(1.8kHz, +1.5dB)      ※コードの輪郭
 *     ──▶ PresencePeak(4kHz, +3.5dB)   ※ピックのアタック・煌めき
 *     ──▶ AirShelf(8kHz, +2dB)         ※鉄弦アコギの空気感
 *     ──▶ LowPass(12kHz)               ※耳に痛い超高域だけカット
 *     ──▶ FeedbackDelay(45ms, 0.18, wet 0.12)  ※胴の奥での反射
 *     ──▶ Chorus(0.55Hz, depth 0.45, wet 0.2)   ※弦のうねり
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

const VOICE_COUNT = 8;

let acReverb: Tone.Reverb | null = null;
let acChorus: Tone.Chorus | null = null;
let acDelay: Tone.FeedbackDelay | null = null;
let acLowpass: Tone.Filter | null = null;
let acAirShelf: Tone.Filter | null = null;
let acPresencePeak: Tone.Filter | null = null;
let acMidPeak: Tone.Filter | null = null;
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
  acReverb = new Tone.Reverb({ decay: 3.0, wet: 0.3 }).toDestination();
  acGain = new Tone.Gain(0.58).connect(acReverb);
  // 弦のうねり (12 弦/コーラス感)。
  acChorus = new Tone.Chorus({
    frequency: 0.55,
    delayTime: 3.8,
    depth: 0.45,
    type: "sine",
    spread: 180,
    wet: 0.2,
  }).connect(acGain);
  acChorus.start();
  // 胴の奥での反射 — ごく短いフィードバックディレイ。
  acDelay = new Tone.FeedbackDelay({
    delayTime: 0.045,
    feedback: 0.18,
    wet: 0.12,
  }).connect(acChorus);
  // 耳に痛い超高域だけカット。
  acLowpass = new Tone.Filter({
    frequency: 12000,
    type: "lowpass",
    Q: 0.5,
    rolloff: -24,
  }).connect(acDelay);
  // 空気感 (シェルフで 8kHz 以上を +2dB)。
  acAirShelf = new Tone.Filter({
    frequency: 8000,
    type: "highshelf",
    gain: 2,
  }).connect(acLowpass);
  // ピックのアタック・煌めき (4kHz)。
  acPresencePeak = new Tone.Filter({
    frequency: 4000,
    type: "peaking",
    Q: 0.85,
    gain: 3.5,
  }).connect(acAirShelf);
  // コードの輪郭 (中域)。
  acMidPeak = new Tone.Filter({
    frequency: 1800,
    type: "peaking",
    Q: 1.1,
    gain: 1.5,
  }).connect(acPresencePeak);
  // こもりカット (330Hz)。
  acMudCut = new Tone.Filter({
    frequency: 330,
    type: "peaking",
    Q: 1.2,
    gain: -2.5,
  }).connect(acMidPeak);
  // 第二ボディ共鳴 (220Hz 付近の「ボーン」)。
  acBodyPeak2 = new Tone.Filter({
    frequency: 220,
    type: "peaking",
    Q: 1.3,
    gain: 3,
  }).connect(acMudCut);
  // ボディ最低共鳴 (110Hz 付近の「胴」)。
  acBodyPeak = new Tone.Filter({
    frequency: 110,
    type: "peaking",
    Q: 1.2,
    gain: 4,
  }).connect(acBodyPeak2);
  acHighpass = new Tone.Filter({
    frequency: 70,
    type: "highpass",
  }).connect(acBodyPeak);

  for (let i = 0; i < VOICE_COUNT; i++) {
    const v = new Tone.PluckSynth({
      // ピックでの弾弦感をしっかり出すために noise を強めに。
      attackNoise: 1.8,
      // アコギは倍音が豊か → dampening を上げて高域が長く残るように。
      dampening: 5200,
      // サステインを長めに (鉄弦アコギは減衰がゆっくり)。
      resonance: 0.992,
      release: 1.2,
    });
    v.volume.value = -2;
    v.connect(acHighpass);
    acVoices.push(v);
  }

  // アタックノイズ: ピック/指で弦を弾いた瞬間のスクラッチ音。
  // → ホワイトノイズの極短いバーストを HPF してから本線にミックス。
  const noiseHP = new Tone.Filter({
    frequency: 2500,
    type: "highpass",
    Q: 0.5,
  });
  const noiseGain = new Tone.Gain(0.06);
  acAttackNoise = new Tone.NoiseSynth({
    noise: { type: "white" },
    envelope: { attack: 0.001, decay: 0.04, sustain: 0, release: 0.04 },
  });
  acAttackNoise.volume.value = -14;
  acAttackNoise.connect(noiseHP);
  noiseHP.connect(noiseGain);
  noiseGain.connect(acHighpass);
}

/** ピック/指で弦をはじく瞬間のスクラッチ音を鳴らす。 */
function triggerAttackNoise(velocity: number, time?: number): void {
  if (!acAttackNoise) return;
  try {
    // velocity に応じてノイズの音量を微調整。
    acAttackNoise.volume.value = -14 + (clamp01(velocity) - 0.85) * 6;
    acAttackNoise.triggerAttackRelease(0.04, time);
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
