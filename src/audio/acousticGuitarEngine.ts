/**
 * アコースティックギター (歪みのない撥弦楽器)。
 *
 * 構成:
 * - 音源は **Tone.PluckSynth (Karplus-Strong)** ボイスプール × 8 (エレキと同じ仕組み)。
 * - ただしエレキとは違い、歪み (Distortion / Chebyshev) は **無し**。
 * - ボディの胴鳴り感を出すため、軽い EQ + 控えめなリバーブだけを通す。
 *
 * シグナルチェーン:
 *   PluckSynth × 8
 *     ──▶ HighPass(80Hz)        ※ローカット (もたつき防止)
 *     ──▶ MidPeak(2.2kHz +3dB)  ※アコースティックらしい中高域の煌めき
 *     ──▶ LowPass(7.5kHz)       ※高域はそこまで暴れない
 *     ──▶ Gain ──▶ Reverb(やや長め) ──▶ Destination
 */

import * as Tone from "tone";
import { midiToNoteString } from "../music/pitch";

const VOICE_COUNT = 8;

let acReverb: Tone.Reverb | null = null;
let acLowpass: Tone.Filter | null = null;
let acMidPeak: Tone.Filter | null = null;
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
  acReverb = new Tone.Reverb({ decay: 2.2, wet: 0.22 }).toDestination();
  acGain = new Tone.Gain(0.65).connect(acReverb);
  acLowpass = new Tone.Filter({
    frequency: 7500,
    type: "lowpass",
    Q: 0.6,
    rolloff: -24,
  }).connect(acGain);
  acMidPeak = new Tone.Filter({
    frequency: 2200,
    type: "peaking",
    Q: 1.0,
    gain: 3,
  }).connect(acLowpass);
  acHighpass = new Tone.Filter({
    frequency: 80,
    type: "highpass",
  }).connect(acMidPeak);

  for (let i = 0; i < VOICE_COUNT; i++) {
    const v = new Tone.PluckSynth({
      attackNoise: 1.2,
      // アコギは弦のダンピングが弱い → dampening を低めに (倍音が豊か)
      dampening: 3200,
      resonance: 0.985,
      release: 0.8,
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
