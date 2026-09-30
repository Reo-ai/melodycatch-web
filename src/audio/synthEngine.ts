/**
 * シンセサイザ楽器 (Tone.js PolySynth ベース)。
 *
 * - 厚みのある fatsawtooth + 軽いリバーブで「明るいリード」風の音色。
 * - holdOn / holdOff で持続音、triggerNote で短いノートを鳴らせる。
 * - pianoEngine / bassEngine と独立しているので、同時に鳴らしても干渉しない。
 */

import * as Tone from "tone";
import { midiToNoteString } from "../music/pitch";
import { getMixerInput } from "./mixer";
import { createSampler, samplerReady, velocity01 } from "./sampledInstruments";

/**
 * "strings" = 本物の弦楽合奏 (チェロ / ビオラ / バイオリン) を録音した音源。
 * "synth"   = 従来の明るいシンセリード。
 * 自動作曲ではポップ / バラードのパッド (後ろで伸ばす和音) にストリングス、
 * ロック / ジャズの合いの手 (速いアルペジオ) にシンセを使う。
 */
export type SynthTone = "strings" | "synth";
let currentTone: SynthTone = "strings";

let synthSynth: Tone.PolySynth | null = null;
let synthReverb: Tone.Reverb | null = null;
let stringsSampler: Tone.Sampler | null = null;
let stringsReverb: Tone.Reverb | null = null;

export function setSynthTone(tone: SynthTone): void {
  if (tone === currentTone) return;
  synthReleaseAll();
  currentTone = tone;
}

export function getSynthTone(): SynthTone {
  return currentTone;
}

/** ストリングスが使える状態か (選択中 かつ 読み込み完了)。読み込み中はシンセで代わりに鳴らす。 */
function stringsOn(): boolean {
  return currentTone === "strings" && samplerReady(stringsSampler);
}

function ensureStrings() {
  if (stringsSampler) return;
  // 弦はホールで鳴っている感じが大事なので、シンセより長めの残響をかける
  stringsReverb = new Tone.Reverb({ decay: 2.8, preDelay: 0.02, wet: 0.3 }).connect(getMixerInput("synth"));
  const highpass = new Tone.Filter({ frequency: 60, type: "highpass", Q: 0.7 }).connect(stringsReverb);
  // 弓で弾き始める自然な立ち上がり (attack) と、弓を離したあとの余韻 (release)
  stringsSampler = createSampler("strings", { attack: 0.08, release: 0.9, volume: -2 });
  stringsSampler.connect(highpass);
}

/** ストリングス音源を先に読み込んでおく。 */
export function preloadStrings(): void {
  ensureStrings();
}

function ensureSynth() {
  ensureStrings();
  if (synthSynth) return;
  synthReverb = new Tone.Reverb({ decay: 1.4, wet: 0.18 }).connect(getMixerInput("synth"));
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
  if (stringsOn()) {
    stringsSampler!.triggerAttack(midiToNoteString(midi), undefined, velocity01(velocity));
    return;
  }
  synthSynth?.triggerAttack(midiToNoteString(midi), undefined, velocity);
}

export function synthHoldOff(midi: number): void {
  if (stringsOn()) stringsSampler!.triggerRelease(midiToNoteString(midi));
  synthSynth?.triggerRelease(midiToNoteString(midi));
}

export function synthTriggerNote(
  midi: number,
  durationSec: number,
  velocity = 0.8,
  time?: number,
): void {
  ensureSynth();
  if (stringsOn()) {
    stringsSampler!.triggerAttackRelease(
      midiToNoteString(midi),
      Math.max(0.05, durationSec),
      time,
      velocity01(velocity),
    );
    return;
  }
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
  if (stringsOn()) {
    stringsSampler!.triggerAttackRelease(notes, Math.max(0.05, duration), undefined, velocity01(velocity));
    return;
  }
  synthSynth.triggerAttackRelease(
    notes,
    Math.max(0.05, duration),
    undefined,
    velocity,
  );
}

export function synthReleaseAll(): void {
  synthSynth?.releaseAll();
  try {
    stringsSampler?.releaseAll();
  } catch {
    /* noop */
  }
}
