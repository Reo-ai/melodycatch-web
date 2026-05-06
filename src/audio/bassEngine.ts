/**
 * ベース楽器 (Tone.js MonoSynth ベースのポリフォニック・サンセザイザ)。
 *
 * - 鋸波 + ローパスフィルタ + フィルタエンベロープで「ピチッ」とした
 *   低音シンセベースを作る。
 * - holdOn / holdOff で持続音、triggerNote で短いノートを鳴らせる。
 * - pianoEngine と独立しているので、ピアノ層と同時に鳴らしても干渉しない。
 */

import * as Tone from "tone";
import { midiToNoteString } from "../music/pitch";

let bassSynth: Tone.PolySynth | null = null;

function ensureBass() {
  if (bassSynth) return;
  bassSynth = new Tone.PolySynth(Tone.MonoSynth, {
    oscillator: { type: "sawtooth" },
    filter: { Q: 1.5, type: "lowpass", rolloff: -24 },
    envelope: {
      attack: 0.005,
      decay: 0.25,
      sustain: 0.45,
      release: 0.6,
    },
    filterEnvelope: {
      attack: 0.001,
      decay: 0.5,
      sustain: 0.15,
      release: 0.6,
      baseFrequency: 180,
      octaves: 2.4,
    },
    volume: -8,
  }).toDestination();
}

export function bassHoldOn(midi: number, velocity = 0.85): void {
  ensureBass();
  bassSynth?.triggerAttack(midiToNoteString(midi), undefined, velocity);
}

export function bassHoldOff(midi: number): void {
  bassSynth?.triggerRelease(midiToNoteString(midi));
}

export function bassTriggerNote(
  midi: number,
  durationSec: number,
  velocity = 0.85,
  time?: number,
): void {
  ensureBass();
  bassSynth?.triggerAttackRelease(
    midiToNoteString(midi),
    Math.max(0.05, durationSec),
    time,
    velocity,
  );
}

export function bassReleaseAll(): void {
  bassSynth?.releaseAll();
}
