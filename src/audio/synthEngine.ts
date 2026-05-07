/**
 * シンセサイザ楽器 (Tone.js PolySynth ベース)。
 *
 * - 厚みのある fatsawtooth + 軽いリバーブで「明るいリード」風の音色。
 * - holdOn / holdOff で持続音、triggerNote で短いノートを鳴らせる。
 * - pianoEngine / bassEngine と独立しているので、同時に鳴らしても干渉しない。
 */

import * as Tone from "tone";
import { midiToNoteString } from "../music/pitch";

let synthSynth: Tone.PolySynth | null = null;
let synthReverb: Tone.Reverb | null = null;

function ensureSynth() {
  if (synthSynth) return;
  synthReverb = new Tone.Reverb({ decay: 1.4, wet: 0.18 }).toDestination();
  synthSynth = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: "fatsawtooth", count: 3, spread: 28 },
    envelope: {
      attack: 0.015,
      decay: 0.25,
      sustain: 0.55,
      release: 0.5,
    },
    volume: -12,
  }).connect(synthReverb);
}

export function synthHoldOn(midi: number, velocity = 0.8): void {
  ensureSynth();
  synthSynth?.triggerAttack(midiToNoteString(midi), undefined, velocity);
}

export function synthHoldOff(midi: number): void {
  synthSynth?.triggerRelease(midiToNoteString(midi));
}

export function synthTriggerNote(
  midi: number,
  durationSec: number,
  velocity = 0.8,
  time?: number,
): void {
  ensureSynth();
  synthSynth?.triggerAttackRelease(
    midiToNoteString(midi),
    Math.max(0.05, durationSec),
    time,
    velocity,
  );
}

/**
 * 和音を一括で鳴らす (コードパレット / 進行プリセット用)。
 * シンセ層に armed しているときに使う。
 */
export function synthChordOn(
  midiNotes: number[],
  velocity = 0.8,
  duration = 1.4,
): void {
  ensureSynth();
  if (!synthSynth || midiNotes.length === 0) return;
  const notes = midiNotes.map(midiToNoteString);
  synthSynth.triggerAttackRelease(
    notes,
    Math.max(0.05, duration),
    undefined,
    velocity,
  );
}

export function synthReleaseAll(): void {
  synthSynth?.releaseAll();
}
