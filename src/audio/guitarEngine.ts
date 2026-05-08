/**
 * ギター楽器 (ディストーションのかかったエレキギター / スタジアムロック想定)。
 *
 * シグナルチェーン:
 *   PolySynth(MonoSynth, fatsawtooth ×2) ──▶ Distortion(控えめ)
 *     ──▶ HighPass(90Hz) ──▶ MidPeak(850Hz +4dB) ──▶ LowPass(4.2kHz, -24dB/oct)
 *     ──▶ Chorus(弱め) ──▶ Gain ──▶ Reverb(短め) ──▶ Destination
 *
 * 「シンセ感を抑える」ための主な調整:
 * - fatsawtooth で 2 オシレータをデチューン → 単一 saw のピーキーさを和らげ、弦の太さを再現
 * - エンベロープの sustain を 0.78 → 0.34 に大きく下げ、ピックで弾いた直後に減衰させる
 *   (持続的な "uuuu" というシンセ的な伸びがなくなる)
 * - 中域 850Hz をピーキングで +4dB → ギターキャビネットらしい "鼻にかかった" 音圧
 * - LowPass を 4.2kHz/-24dB に変更し、シンセの高域ジャリつきを減衰
 * - ディストーションを 0.85 → 0.55 に。歪ませすぎるとサスティンが強調されてシンセに戻る
 * - Chorus の wet/depth を控えめに (0.32→0.12 / 0.45→0.18)。ハードロック系では弱めが自然
 * - Reverb の decay を短く (2.6→1.6s)。スタジアム感は残しつつクリアさを確保
 */

import * as Tone from "tone";
import { midiToNoteString } from "../music/pitch";

let guitarReverb: Tone.Reverb | null = null;
let guitarChorus: Tone.Chorus | null = null;
let guitarLowpass: Tone.Filter | null = null;
let guitarMidPeak: Tone.Filter | null = null;
let guitarHighpass: Tone.Filter | null = null;
let guitarDistortion: Tone.Distortion | null = null;
let guitarGain: Tone.Gain | null = null;
let guitarPoly: Tone.PolySynth<Tone.MonoSynth> | null = null;

function ensureGuitar() {
  if (guitarPoly) return;
  guitarReverb = new Tone.Reverb({ decay: 1.6, wet: 0.18 }).toDestination();
  guitarGain = new Tone.Gain(0.6).connect(guitarReverb);
  guitarChorus = new Tone.Chorus({
    frequency: 0.6,
    delayTime: 2.5,
    depth: 0.18,
    wet: 0.12,
  })
    .connect(guitarGain)
    .start();
  guitarLowpass = new Tone.Filter({
    frequency: 4200,
    type: "lowpass",
    Q: 0.6,
    rolloff: -24,
  }).connect(guitarChorus);
  guitarMidPeak = new Tone.Filter({
    frequency: 850,
    type: "peaking",
    Q: 0.9,
    gain: 4,
  }).connect(guitarLowpass);
  guitarHighpass = new Tone.Filter({
    frequency: 90,
    type: "highpass",
  }).connect(guitarMidPeak);
  guitarDistortion = new Tone.Distortion({
    distortion: 0.55,
    oversample: "4x",
    wet: 1,
  }).connect(guitarHighpass);
  guitarPoly = new Tone.PolySynth(Tone.MonoSynth, {
    // fatsawtooth: 2 osc detune で弦の太さを表現
    oscillator: { type: "fatsawtooth", count: 2, spread: 14 } as Partial<
      Tone.MonoSynthOptions["oscillator"]
    >,
    envelope: {
      attack: 0.004,
      decay: 0.32,
      // ピック型: sustain を低くして自然な減衰
      sustain: 0.34,
      release: 0.45,
    },
    filter: { type: "lowpass", Q: 1.6 },
    filterEnvelope: {
      attack: 0.003,
      decay: 0.2,
      sustain: 0.45,
      release: 0.5,
      baseFrequency: 280,
      octaves: 3.6,
    },
  });
  guitarPoly.connect(guitarDistortion);
  guitarPoly.volume.value = -9;
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
