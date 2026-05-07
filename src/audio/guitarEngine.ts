/**
 * ギター楽器 (ディストーションのかかったエレキギター / スタジアムロック想定)。
 *
 * シグナルチェーン:
 *   PolySynth(MonoSynth, sawtooth) ──▶ Distortion ──▶ HighPass(110Hz)
 *     ──▶ LowPass(3.4kHz) ──▶ Chorus ──▶ Gain ──▶ Reverb ──▶ Destination
 *
 * - sawtooth + Distortion で歪んだエレキギターのコア音色を作る。
 * - Highpass / Lowpass はキャビネットシミュレーション (低域モヤと超高域のジャリつきをカット)。
 * - Chorus でコーラスがかった「広がり」、Reverb でスタジアムの空気感。
 * - holdOn / holdOff で持続音、triggerNote で短いノート、chordOn でストロークを鳴らせる。
 */

import * as Tone from "tone";
import { midiToNoteString } from "../music/pitch";

let guitarReverb: Tone.Reverb | null = null;
let guitarChorus: Tone.Chorus | null = null;
let guitarLowpass: Tone.Filter | null = null;
let guitarHighpass: Tone.Filter | null = null;
let guitarDistortion: Tone.Distortion | null = null;
let guitarGain: Tone.Gain | null = null;
let guitarPoly: Tone.PolySynth<Tone.MonoSynth> | null = null;

function ensureGuitar() {
  if (guitarPoly) return;
  guitarReverb = new Tone.Reverb({ decay: 2.6, wet: 0.22 }).toDestination();
  guitarGain = new Tone.Gain(0.55).connect(guitarReverb);
  guitarChorus = new Tone.Chorus({
    frequency: 1.1,
    delayTime: 3.6,
    depth: 0.45,
    wet: 0.32,
  })
    .connect(guitarGain)
    .start();
  guitarLowpass = new Tone.Filter({
    frequency: 3400,
    type: "lowpass",
    Q: 0.9,
  }).connect(guitarChorus);
  guitarHighpass = new Tone.Filter({
    frequency: 110,
    type: "highpass",
  }).connect(guitarLowpass);
  guitarDistortion = new Tone.Distortion({
    distortion: 0.85,
    oversample: "4x",
    wet: 1,
  }).connect(guitarHighpass);
  guitarPoly = new Tone.PolySynth(Tone.MonoSynth, {
    oscillator: { type: "sawtooth" },
    envelope: {
      attack: 0.005,
      decay: 0.18,
      sustain: 0.78,
      release: 0.55,
    },
    filter: { type: "lowpass", Q: 1.1 },
    filterEnvelope: {
      attack: 0.005,
      decay: 0.25,
      sustain: 0.55,
      release: 0.6,
      baseFrequency: 230,
      octaves: 3.2,
    },
  });
  guitarPoly.connect(guitarDistortion);
  guitarPoly.volume.value = -10;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

export function guitarHoldOn(midi: number, velocity = 0.85): void {
  ensureGuitar();
  guitarPoly!.triggerAttack(
    midiToNoteString(midi),
    undefined,
    clamp01(velocity),
  );
}

export function guitarHoldOff(midi: number): void {
  if (!guitarPoly) return;
  guitarPoly.triggerRelease(midiToNoteString(midi));
}

export function guitarTriggerNote(
  midi: number,
  durationSec: number,
  velocity = 0.85,
  time?: number,
): void {
  ensureGuitar();
  guitarPoly!.triggerAttackRelease(
    midiToNoteString(midi),
    Math.max(0.05, durationSec),
    time,
    clamp01(velocity),
  );
}

/**
 * 和音を一括で鳴らす (コードパレット / 進行プリセット用)。
 * ギターらしいダウンストロークになるよう、低音弦から少しずらして発音する。
 */
export function guitarChordOn(
  midiNotes: number[],
  velocity = 0.8,
  duration = 1.4,
): void {
  ensureGuitar();
  const sorted = [...midiNotes].sort((a, b) => a - b);
  const strumStep = 14; // ms ずつずらしてストロークっぽく
  sorted.forEach((m, i) => {
    window.setTimeout(() => {
      guitarTriggerNote(m, duration, velocity);
    }, i * strumStep);
  });
}

export function guitarReleaseAll(): void {
  if (!guitarPoly) return;
  guitarPoly.releaseAll();
}
