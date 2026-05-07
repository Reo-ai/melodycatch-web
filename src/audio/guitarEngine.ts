/**
 * ギター楽器 (Tone.js PluckSynth ベース、手動ボイス管理)。
 *
 * - PluckSynth で撥弦音を作る。Tone.PolySynth は PluckSynth を受け付けない
 *   (Monophonic 派生でないため) ので、自前で MIDI -> PluckSynth マップを管理する。
 * - holdOn / holdOff で持続音、triggerNote で短いノート、chordOn で和音を鳴らせる。
 * - pianoEngine / bassEngine / synthEngine と独立しているので、
 *   同時に鳴らしても干渉しない。
 */

import * as Tone from "tone";
import { midiToNoteString } from "../music/pitch";

let guitarReverb: Tone.Reverb | null = null;
let guitarGain: Tone.Gain | null = null;
const voices: Map<number, Tone.PluckSynth> = new Map();

function ensureGuitar() {
  if (guitarGain) return;
  guitarReverb = new Tone.Reverb({ decay: 1.6, wet: 0.18 }).toDestination();
  guitarGain = new Tone.Gain(0.9).connect(guitarReverb);
}

function makeVoice(): Tone.PluckSynth {
  ensureGuitar();
  const v = new Tone.PluckSynth({
    attackNoise: 0.6,
    dampening: 4200,
    resonance: 0.78,
    release: 1.4,
  });
  v.volume.value = -6;
  if (guitarGain) v.connect(guitarGain);
  return v;
}

function disposeVoice(v: Tone.PluckSynth) {
  // 余韻が消えてからクリーンアップする
  setTimeout(() => {
    try {
      v.dispose();
    } catch {
      // noop
    }
  }, 1800);
}

export function guitarHoldOn(midi: number, velocity = 0.85): void {
  ensureGuitar();
  // 既存ボイスがあればリリース後に破棄して新規割り当て
  const prev = voices.get(midi);
  if (prev) {
    try {
      prev.triggerRelease();
    } catch {
      // noop
    }
    disposeVoice(prev);
    voices.delete(midi);
  }
  const v = makeVoice();
  // velocity をボリュームに反映 (0..1 → -16..0 dB ぐらい)
  v.volume.value = -6 + (Math.max(0, Math.min(1, velocity)) - 1) * 12;
  voices.set(midi, v);
  v.triggerAttack(midiToNoteString(midi));
}

export function guitarHoldOff(midi: number): void {
  const v = voices.get(midi);
  if (!v) return;
  voices.delete(midi);
  try {
    v.triggerRelease();
  } catch {
    // noop
  }
  disposeVoice(v);
}

export function guitarTriggerNote(
  midi: number,
  durationSec: number,
  velocity = 0.85,
  time?: number,
): void {
  ensureGuitar();
  const v = makeVoice();
  v.volume.value = -6 + (Math.max(0, Math.min(1, velocity)) - 1) * 12;
  v.triggerAttack(midiToNoteString(midi), time);
  // duration 後にリリース + 破棄
  const ms = Math.max(50, durationSec * 1000);
  window.setTimeout(() => {
    try {
      v.triggerRelease();
    } catch {
      // noop
    }
    disposeVoice(v);
  }, ms);
}

/**
 * 和音を一括で鳴らす (コードパレット / 進行プリセット用)。
 * ギターらしい軽いストロークになるよう、少しずらして発音する。
 */
export function guitarChordOn(
  midiNotes: number[],
  velocity = 0.8,
  duration = 1.4,
): void {
  ensureGuitar();
  const sorted = [...midiNotes].sort((a, b) => a - b);
  const strumStep = 12; // ms ずつずらしてストロークっぽく
  sorted.forEach((m, i) => {
    window.setTimeout(() => {
      guitarTriggerNote(m, duration, velocity);
    }, i * strumStep);
  });
}

export function guitarReleaseAll(): void {
  voices.forEach((v) => {
    try {
      v.triggerRelease();
    } catch {
      // noop
    }
    disposeVoice(v);
  });
  voices.clear();
}
