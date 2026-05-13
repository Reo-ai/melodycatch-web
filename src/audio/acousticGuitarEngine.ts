/**
 * アコースティックギター (歪みのない撥弦楽器)。
 *
 * 構成:
 * - 音源は **Tone.PluckSynth (Karplus-Strong)** ボイスプール × 8。
 * - 歪み (Distortion / Chebyshev) は **無し**。
 * - 木のボディの胴鳴り (低域共鳴) と弦の煌めき (高域ピーク) を EQ で作り込み、
 *   さらに軽いコーラスで複数の弦が干渉するうねり感を演出する。
 *
 * シグナルチェーン:
 *   PluckSynth × 8 (attackNoise 1.6, dampening 4500, resonance 0.99)
 *     ──▶ HighPass(70Hz)               ※低域のもたつきを除去
 *     ──▶ BodyPeak(140Hz, +5dB)        ※ボディ共鳴 (胴鳴り)
 *     ──▶ MidPeak(2.2kHz, +2dB)        ※コードの輪郭
 *     ──▶ PresencePeak(3.8kHz, +3dB)   ※ピックのアタック・煌めき
 *     ──▶ LowPass(9kHz)                ※耳に痛い超高域だけカット
 *     ──▶ Chorus(0.6Hz, depth 0.4, wet 0.18) ※弦同士の自然なうねり
 *     ──▶ Gain ──▶ Reverb(decay 2.6, wet 0.26) ──▶ Destination
 */

import * as Tone from "tone";
import { midiToNoteString } from "../music/pitch";

const VOICE_COUNT = 8;

let acReverb: Tone.Reverb | null = null;
let acChorus: Tone.Chorus | null = null;
let acLowpass: Tone.Filter | null = null;
let acPresencePeak: Tone.Filter | null = null;
let acMidPeak: Tone.Filter | null = null;
let acBodyPeak: Tone.Filter | null = null;
let acHighpass: Tone.Filter | null = null;
let acGain: Tone.Gain | null = null;
let acVoices: Tone.PluckSynth[] = [];
let voiceCursor = 0;
const noteToVoice: Map<number, Tone.PluckSynth> = new Map();
const noteToRepluckTimer: Map<number, number> = new Map();
/** アコギは減衰がゆるやかで「鳴りっぱなし」感が出やすいので、エレキより少し短めの間隔で再ピック。 */
const REPLUCK_DELAY_MS = 1300;
const REPLUCK_DECAY_DB = -2;

function ensureAcoustic() {
  if (acVoices.length > 0) return;
  acReverb = new Tone.Reverb({ decay: 2.6, wet: 0.26 }).toDestination();
  acGain = new Tone.Gain(0.6).connect(acReverb);
  acChorus = new Tone.Chorus({
    frequency: 0.6,
    delayTime: 3.5,
    depth: 0.4,
    type: "sine",
    spread: 180,
    wet: 0.18,
  }).connect(acGain);
  acChorus.start();
  acLowpass = new Tone.Filter({
    frequency: 9000,
    type: "lowpass",
    Q: 0.5,
    rolloff: -24,
  }).connect(acChorus);
  acPresencePeak = new Tone.Filter({
    frequency: 3800,
    type: "peaking",
    Q: 0.8,
    gain: 3,
  }).connect(acLowpass);
  acMidPeak = new Tone.Filter({
    frequency: 2200,
    type: "peaking",
    Q: 1.0,
    gain: 2,
  }).connect(acPresencePeak);
  acBodyPeak = new Tone.Filter({
    frequency: 140,
    type: "peaking",
    Q: 1.0,
    gain: 5,
  }).connect(acMidPeak);
  acHighpass = new Tone.Filter({
    frequency: 70,
    type: "highpass",
  }).connect(acBodyPeak);

  for (let i = 0; i < VOICE_COUNT; i++) {
    const v = new Tone.PluckSynth({
      // ピックでの弾弦感をしっかり出すために noise を強めに。
      attackNoise: 1.6,
      // アコギは倍音が豊か → dampening を上げて高域が長く残るように。
      dampening: 4500,
      // サステインを長めに (鉄弦アコギは減衰がゆっくり)。
      resonance: 0.99,
      release: 1.0,
    });
    v.volume.value = -2;
    v.connect(acHighpass);
    acVoices.push(v);
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
