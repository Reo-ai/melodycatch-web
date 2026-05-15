/**
 * ボーカル (合唱) 楽器 — フォルマント合成バージョン。
 *
 * 実装方針:
 * - 外部 CDN サンプルは使わず、Tone.js のシンセだけで「あー (Ah)」母音の
 *   合唱パッドを生成する。ネット環境に依存せず、初回発音もすぐ鳴る。
 * - ノコギリ波を 2 段の bandpass (F1≈700Hz / F2≈1100Hz) に並列で通し、
 *   人の「Ah」母音フォルマントを再現。
 * - 軽い Vibrato + Chorus でユニゾン合唱の "うねり" を加え、長めの
 *   Reverb で聖堂感を出す。
 *
 * シグナルチェーン:
 *
 *   PolySynth(saw, slow attack)
 *     ──┬─▶ Filter(700Hz bandpass, Q=8)  ─▶ Gain(0.7) ─┐
 *       └─▶ Filter(1100Hz bandpass, Q=10) ─▶ Gain(0.5) ─┴─▶ Gain(0.55)
 *           ─▶ Vibrato(5Hz, depth 0.02)
 *           ─▶ Chorus(0.4Hz, depth 0.5, wet 0.25)
 *           ─▶ Reverb(decay 3.0, wet 0.32)
 *           ─▶ Destination
 *
 * インターフェース:
 * - holdOn/holdOff … 押しっぱなしの持続音 (ピアノ層と同じ)
 * - triggerNote   … 1 ノートを所定の長さで鳴らす
 * - chordOn       … 和音を一括発音 (コードパレット用)
 * - releaseAll    … 全ボイス停止
 */

import * as Tone from "tone";
import { midiToNoteString } from "../music/pitch";

let vocalSynth: Tone.PolySynth<Tone.Synth> | null = null;
let vocalReverb: Tone.Reverb | null = null;
let vocalChorus: Tone.Chorus | null = null;
let vocalVibrato: Tone.Vibrato | null = null;
let vocalMerge: Tone.Gain | null = null;
let vocalFormant1: Tone.Filter | null = null;
let vocalFormant2: Tone.Filter | null = null;
let vocalFormant1Gain: Tone.Gain | null = null;
let vocalFormant2Gain: Tone.Gain | null = null;
let vocalSplit: Tone.Gain | null = null;

function ensureVocal() {
  if (vocalSynth) return;

  // 出力側 (Destination 寄り) から順に作る。
  vocalReverb = new Tone.Reverb({ decay: 3.0, wet: 0.32 }).toDestination();
  vocalChorus = new Tone.Chorus({
    frequency: 0.4,
    delayTime: 4.0,
    depth: 0.5,
    type: "sine",
    spread: 180,
    wet: 0.25,
  }).connect(vocalReverb);
  vocalChorus.start();
  vocalVibrato = new Tone.Vibrato({ frequency: 5, depth: 0.02 }).connect(
    vocalChorus,
  );
  vocalMerge = new Tone.Gain(0.55).connect(vocalVibrato);

  // フォルマント (Ah 母音): F1=700Hz, F2=1100Hz
  vocalFormant1 = new Tone.Filter({
    frequency: 700,
    type: "bandpass",
    Q: 8,
  });
  vocalFormant1Gain = new Tone.Gain(0.7).connect(vocalMerge);
  vocalFormant1.connect(vocalFormant1Gain);

  vocalFormant2 = new Tone.Filter({
    frequency: 1100,
    type: "bandpass",
    Q: 10,
  });
  vocalFormant2Gain = new Tone.Gain(0.5).connect(vocalMerge);
  vocalFormant2.connect(vocalFormant2Gain);

  // PolySynth → split → 並列フォルマント
  vocalSplit = new Tone.Gain(1);
  vocalSplit.connect(vocalFormant1);
  vocalSplit.connect(vocalFormant2);

  vocalSynth = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: "sawtooth" },
    envelope: {
      attack: 0.35,
      decay: 0.15,
      sustain: 0.85,
      release: 1.2,
    },
  });
  vocalSynth.connect(vocalSplit);
  vocalSynth.volume.value = -10;
}

/** UI から事前ロード可能にする。シンセ版なので呼ばなくても問題ない。 */
export function preloadVocal(): void {
  ensureVocal();
}

/** シンセ実装は常にロード済み扱い。 */
export function isVocalLoaded(): boolean {
  return vocalSynth != null;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

export function vocalHoldOn(midi: number, velocity = 0.85): void {
  ensureVocal();
  vocalSynth?.triggerAttack(
    midiToNoteString(midi),
    undefined,
    clamp01(velocity),
  );
}

export function vocalHoldOff(midi: number): void {
  vocalSynth?.triggerRelease(midiToNoteString(midi));
}

export function vocalTriggerNote(
  midi: number,
  durationSec: number,
  velocity = 0.85,
  time?: number,
): void {
  ensureVocal();
  vocalSynth?.triggerAttackRelease(
    midiToNoteString(midi),
    Math.max(0.05, durationSec),
    time,
    clamp01(velocity),
  );
}

/**
 * 和音を一括で鳴らす (コードパレット用)。
 * 合唱らしい一体感のためにストロークではなく同時発音。
 */
export function vocalChordOn(
  midiNotes: number[],
  velocity = 0.8,
  duration = 1.6,
): void {
  ensureVocal();
  if (!vocalSynth || midiNotes.length === 0) return;
  const notes = midiNotes.map(midiToNoteString);
  vocalSynth.triggerAttackRelease(
    notes,
    Math.max(0.05, duration),
    undefined,
    clamp01(velocity),
  );
}

export function vocalReleaseAll(): void {
  vocalSynth?.releaseAll();
}
