/**
 * ギター楽器 (ディストーションのかかったエレキギター / スタジアムロック想定)。
 *
 * 「シンセっぽい」という指摘を解消するため、コアの音源を
 * **Tone.PluckSynth (Karplus-Strong 物理モデル)** に変更。
 * Karplus-Strong は短いノイズバーストを遅延ループに通すことで
 * 撥弦楽器の倍音/減衰を物理的に再現するため、
 * fatsawtooth + envelope では出せない自然なピック感とディケイが得られる。
 *
 * シグナルチェーン:
 *   PluckSynth × N (ボイスプール)
 *     ──▶ Distortion(0.32)
 *     ──▶ HighPass(95Hz)
 *     ──▶ MidPeak(1.1kHz +3.5dB)
 *     ──▶ LowPass(5.2kHz, -24dB/oct)
 *     ──▶ Chorus(弱め)
 *     ──▶ Gain
 *     ──▶ Reverb(短め)
 *     ──▶ Destination
 *
 * 実装メモ:
 * - PluckSynth は Tone.js の PolySynth が要求する Monophonic<any> 型制約を
 *   満たさないため、自前で多重発音用のボイスプールを管理する。
 * - 同じ MIDI ノートが押された場合は前回のボイスを再利用 (再ピック)。
 * - dampening を 4200Hz, resonance を 0.92 に設定し、
 *   弦のブライトネスとサスティンを両立。
 * - Karplus-Strong は元音が太いので、歪みは 0.32 と控えめでよい。
 */

import * as Tone from "tone";
import { midiToNoteString } from "../music/pitch";

const VOICE_COUNT = 8;

let guitarReverb: Tone.Reverb | null = null;
let guitarChorus: Tone.Chorus | null = null;
let guitarLowpass: Tone.Filter | null = null;
let guitarMidPeak: Tone.Filter | null = null;
let guitarHighpass: Tone.Filter | null = null;
let guitarDistortion: Tone.Distortion | null = null;
let guitarGain: Tone.Gain | null = null;

/** ラウンドロビンで使う PluckSynth ボイス。 */
let guitarVoices: Tone.PluckSynth[] = [];
let voiceCursor = 0;
/** 同じ MIDI ノートが現在どのボイスで鳴っているか (HoldOff 用)。 */
const noteToVoice: Map<number, Tone.PluckSynth> = new Map();

function ensureGuitar() {
  if (guitarVoices.length > 0) return;
  guitarReverb = new Tone.Reverb({ decay: 1.4, wet: 0.18 }).toDestination();
  guitarGain = new Tone.Gain(0.85).connect(guitarReverb);
  guitarChorus = new Tone.Chorus({
    frequency: 0.8,
    delayTime: 2.5,
    depth: 0.15,
    wet: 0.1,
  })
    .connect(guitarGain)
    .start();
  guitarLowpass = new Tone.Filter({
    frequency: 5200,
    type: "lowpass",
    Q: 0.5,
    rolloff: -24,
  }).connect(guitarChorus);
  guitarMidPeak = new Tone.Filter({
    frequency: 1100,
    type: "peaking",
    Q: 1.0,
    gain: 3.5,
  }).connect(guitarLowpass);
  guitarHighpass = new Tone.Filter({
    frequency: 95,
    type: "highpass",
  }).connect(guitarMidPeak);
  guitarDistortion = new Tone.Distortion({
    distortion: 0.32,
    oversample: "4x",
    wet: 0.85,
  }).connect(guitarHighpass);

  for (let i = 0; i < VOICE_COUNT; i++) {
    const v = new Tone.PluckSynth({
      attackNoise: 1.8,
      dampening: 4200,
      resonance: 0.92,
      release: 0.6,
    });
    v.volume.value = -3;
    v.connect(guitarDistortion);
    guitarVoices.push(v);
  }
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** 次に使うボイスを取得 (ラウンドロビン)。 */
function nextVoice(): Tone.PluckSynth {
  const v = guitarVoices[voiceCursor];
  voiceCursor = (voiceCursor + 1) % guitarVoices.length;
  return v;
}

export function guitarHoldOn(midi: number, velocity = 0.85): void {
  ensureGuitar();
  const v = nextVoice();
  noteToVoice.set(midi, v);
  // PluckSynth は撥弦モデルなので triggerAttack で 1 回ピックする。
  // (押しっぱなしでも自然減衰する = ギターの挙動として正しい)
  // PluckSynth.triggerAttack は (note, time?) のみで velocity を受け付けないため、
  // 強弱は volume で表現する。
  v.volume.value = -3 + (clamp01(velocity) - 0.85) * 8;
  v.triggerAttack(midiToNoteString(midi));
}

export function guitarHoldOff(midi: number): void {
  const v = noteToVoice.get(midi);
  if (!v) return;
  noteToVoice.delete(midi);
  // 撥弦楽器は元々減衰するので release は短くフェードさせる。
  v.triggerRelease();
}

export function guitarTriggerNote(
  midi: number,
  durationSec: number,
  velocity = 0.85,
  time?: number,
): void {
  ensureGuitar();
  const v = nextVoice();
  // PluckSynth.triggerAttackRelease は (note, duration, time?) のみ。
  v.volume.value = -3 + (clamp01(velocity) - 0.85) * 8;
  v.triggerAttackRelease(
    midiToNoteString(midi),
    Math.max(0.05, durationSec),
    time,
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
  noteToVoice.clear();
  for (const v of guitarVoices) {
    v.triggerRelease();
  }
}
