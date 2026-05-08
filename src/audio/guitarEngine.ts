/**
 * ギター楽器 (ディストーションを強めにかけたハードロック系エレキギター)。
 *
 * 構成:
 * - 音源は **Tone.PluckSynth (Karplus-Strong)** ボイスプール × 8。
 *   撥弦の物理モデルなので、シンセサイザーらしい持続音が出ず、
 *   ピックアタック → 自然減衰というギター本来の挙動になる。
 * - 歪み段は **2 段重ね** (プリ Distortion + Chebyshev 倍音強調) で、
 *   1 段だけでは出ない厚みのある倍音を追加。
 * - キャビ EQ (HighPass + MidPeak + LowPass) で
 *   実機ギターアンプ + キャビネットの音域に整形。
 *
 * シグナルチェーン:
 *   PluckSynth × 8
 *     ──▶ PreGain(+6dB)         ※歪みを稼ぐ
 *     ──▶ Distortion(0.85, soft-clip)
 *     ──▶ Chebyshev(order=12)   ※高次倍音
 *     ──▶ HighPass(110Hz)
 *     ──▶ MidPeak(1.4kHz +5dB)
 *     ──▶ LowPass(4.8kHz, -24dB/oct)
 *     ──▶ Chorus(弱め)
 *     ──▶ Gain ──▶ Reverb(短め) ──▶ Destination
 *
 * 実装メモ:
 * - PluckSynth は Tone.js の PolySynth が要求する Monophonic<any> 型制約を
 *   満たさないため、自前で多重発音用のボイスプールを管理する。
 * - PluckSynth.triggerAttack(Release) は velocity 引数を受け付けないため、
 *   強弱は volume.value で表現する (= 約 ±8dB のレンジ)。
 */

import * as Tone from "tone";
import { midiToNoteString } from "../music/pitch";

const VOICE_COUNT = 8;

let guitarReverb: Tone.Reverb | null = null;
let guitarChorus: Tone.Chorus | null = null;
let guitarLowpass: Tone.Filter | null = null;
let guitarMidPeak: Tone.Filter | null = null;
let guitarHighpass: Tone.Filter | null = null;
let guitarChebyshev: Tone.Chebyshev | null = null;
let guitarDistortion: Tone.Distortion | null = null;
let guitarPreGain: Tone.Gain | null = null;
let guitarGain: Tone.Gain | null = null;

/** ラウンドロビンで使う PluckSynth ボイス。 */
let guitarVoices: Tone.PluckSynth[] = [];
let voiceCursor = 0;
/** 同じ MIDI ノートが現在どのボイスで鳴っているか (HoldOff 用)。 */
const noteToVoice: Map<number, Tone.PluckSynth> = new Map();

function ensureGuitar() {
  if (guitarVoices.length > 0) return;
  guitarReverb = new Tone.Reverb({ decay: 1.4, wet: 0.18 }).toDestination();
  guitarGain = new Tone.Gain(0.55).connect(guitarReverb);
  guitarChorus = new Tone.Chorus({
    frequency: 0.8,
    delayTime: 2.5,
    depth: 0.15,
    wet: 0.1,
  })
    .connect(guitarGain)
    .start();
  guitarLowpass = new Tone.Filter({
    frequency: 4800,
    type: "lowpass",
    Q: 0.6,
    rolloff: -24,
  }).connect(guitarChorus);
  guitarMidPeak = new Tone.Filter({
    frequency: 1400,
    type: "peaking",
    Q: 1.1,
    gain: 5,
  }).connect(guitarLowpass);
  guitarHighpass = new Tone.Filter({
    frequency: 110,
    type: "highpass",
  }).connect(guitarMidPeak);
  // 2 段歪み: ハードクリップに近い Distortion → Chebyshev で高次倍音を加算。
  // PluckSynth の素朴なノコギリ的成分を厚くしてハードロック感を出す。
  guitarChebyshev = new Tone.Chebyshev({
    order: 12,
    wet: 0.45,
  }).connect(guitarHighpass);
  guitarDistortion = new Tone.Distortion({
    distortion: 0.85,
    oversample: "4x",
    wet: 1.0,
  }).connect(guitarChebyshev);
  // 歪み段を稼ぐためのプリゲイン (PluckSynth は素では大人しいので)
  guitarPreGain = new Tone.Gain(2.0).connect(guitarDistortion);

  for (let i = 0; i < VOICE_COUNT; i++) {
    const v = new Tone.PluckSynth({
      attackNoise: 1.8,
      dampening: 4200,
      resonance: 0.92,
      release: 0.6,
    });
    v.volume.value = -3;
    v.connect(guitarPreGain);
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
