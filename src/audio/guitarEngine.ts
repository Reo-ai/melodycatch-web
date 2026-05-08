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
/** 押しっぱなし時に「再ピック」するための setTimeout ハンドル。
 *  Karplus-Strong は撥弦モデルなので 1 回弾くと自然減衰する。
 *  長押し中は一定間隔で再ピックすることで、ギターの「サステイン強奏」
 *  (短いトレモロ的な持続) を再現する。 */
const noteToRepluckTimer: Map<number, number> = new Map();
/** 自動再ピックの初回ディレイ (ms)。
 *  短すぎると単音が tremolo 的になるので、自然減衰がそろそろ消えかける頃合い (~1.1 秒) に設定。 */
const REPLUCK_DELAY_MS = 1100;
/** 各回の再ピックの音量減衰 (dB)。少しずつ弱くして自然なフェード感に。 */
const REPLUCK_DECAY_DB = -2;

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
      // resonance を上げて 1 回のピックの減衰時間を延ばす (より「伸び」のある音)。
      resonance: 0.97,
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

/** 既存のリプラックタイマーをクリア。 */
function clearRepluckTimer(midi: number): void {
  const t = noteToRepluckTimer.get(midi);
  if (t !== undefined) {
    window.clearTimeout(t);
    noteToRepluckTimer.delete(midi);
  }
}

/** 押しっぱなし中の自動再ピックを再帰的にスケジュール。 */
function scheduleRepluck(midi: number, baseVolumeDb: number, step: number): void {
  const handle = window.setTimeout(() => {
    // ノートが解放されていたら何もしない。
    const v = noteToVoice.get(midi);
    if (!v) {
      noteToRepluckTimer.delete(midi);
      return;
    }
    // 段階的に音量を下げて自然なフェード感を出す (下限は -16dB)。
    const decayed = Math.max(baseVolumeDb + REPLUCK_DECAY_DB * step, -16);
    v.volume.value = decayed;
    v.triggerAttack(midiToNoteString(midi));
    // 次の再ピックをスケジュール。
    scheduleRepluck(midi, baseVolumeDb, step + 1);
  }, REPLUCK_DELAY_MS);
  noteToRepluckTimer.set(midi, handle);
}

export function guitarHoldOn(midi: number, velocity = 0.85): void {
  ensureGuitar();
  // 同じ音が既に鳴っていたらタイマーをクリア (重複再ピック防止)。
  clearRepluckTimer(midi);
  const v = nextVoice();
  noteToVoice.set(midi, v);
  // PluckSynth は撥弦モデルなので triggerAttack で 1 回ピックする。
  // (押しっぱなしでも自然減衰する = ギターの挙動として正しい)
  // PluckSynth.triggerAttack は (note, time?) のみで velocity を受け付けないため、
  // 強弱は volume で表現する。
  const baseVolumeDb = -3 + (clamp01(velocity) - 0.85) * 8;
  v.volume.value = baseVolumeDb;
  v.triggerAttack(midiToNoteString(midi));
  // 押しっぱなしで「伸ばす」ためのリプラックを予約。
  scheduleRepluck(midi, baseVolumeDb, 1);
}

export function guitarHoldOff(midi: number): void {
  // リプラックタイマーは必ずクリア (キーが離れたら再ピックしない)。
  clearRepluckTimer(midi);
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
  // 全リプラックタイマーをクリア。
  for (const handle of noteToRepluckTimer.values()) {
    window.clearTimeout(handle);
  }
  noteToRepluckTimer.clear();
  noteToVoice.clear();
  for (const v of guitarVoices) {
    v.triggerRelease();
  }
}
