/**
 * ボーカル (合唱) 楽器 — フォルマント合成 (改良版)。
 *
 * 設計のポイント:
 * - 並列 bandpass だと原音が消えて「管楽器」っぽくなるため、
 *   原音を全部通しつつ各 formant 周波数を **ピーキングフィルタで持ち上げる**
 *   直列ボーカルトラクト方式に変更。
 * - 「Ah」母音の 4 つのフォルマント (F1〜F3 + 歌唱形成峰) をブースト。
 * - ノコギリ波の unison (fatsawtooth) で複数歌唱者の厚みを再現。
 * - 軽くノイズを混ぜて息混じり感を出す。
 *
 * シグナルチェーン:
 *
 *   PolySynth(fatsawtooth, unison 3, slow attack)
 *     ──▶ Highpass(80Hz)            ※低域ゴロゴロ感をカット
 *     ──▶ Peak(730Hz, Q=4, +15dB)   ※F1 (Ah)
 *     ──▶ Peak(1090Hz, Q=6, +12dB)  ※F2 (Ah)
 *     ──▶ Peak(2440Hz, Q=8, +10dB)  ※F3 (明瞭度)
 *     ──▶ Peak(3500Hz, Q=8, +8dB)   ※歌唱形成峰 (Singer's Formant)
 *     ──▶ Lowpass(8000Hz)           ※耳に痛い高域カット
 *     ──▶ Vibrato(5Hz, depth 0.02)
 *     ──▶ Chorus(0.4Hz, depth 0.5, wet 0.3)
 *     ──▶ Gain(1.4)                 ※全体音量
 *     ──▶ Reverb(decay 3.0, wet 0.28)
 *     ──▶ Destination
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
let vocalGain: Tone.Gain | null = null;
let vocalChorus: Tone.Chorus | null = null;
let vocalVibrato: Tone.Vibrato | null = null;
let vocalLowpass: Tone.Filter | null = null;
let vocalSingerFormant: Tone.Filter | null = null;
let vocalFormant3: Tone.Filter | null = null;
let vocalFormant2: Tone.Filter | null = null;
let vocalFormant1: Tone.Filter | null = null;
let vocalHighpass: Tone.Filter | null = null;

function ensureVocal() {
  if (vocalSynth) return;

  // 出力側 (Destination 寄り) から順に作る。
  vocalReverb = new Tone.Reverb({ decay: 3.0, wet: 0.28 }).toDestination();
  vocalGain = new Tone.Gain(1.4).connect(vocalReverb);
  vocalChorus = new Tone.Chorus({
    frequency: 0.4,
    delayTime: 4.0,
    depth: 0.5,
    type: "sine",
    spread: 180,
    wet: 0.3,
  }).connect(vocalGain);
  vocalChorus.start();
  vocalVibrato = new Tone.Vibrato({ frequency: 5, depth: 0.02 }).connect(
    vocalChorus,
  );

  // 直列ピーキングフィルタで声道をシミュレート (Ah 母音)。
  vocalLowpass = new Tone.Filter({
    frequency: 8000,
    type: "lowpass",
    Q: 0.7,
  }).connect(vocalVibrato);
  vocalSingerFormant = new Tone.Filter({
    frequency: 3500,
    type: "peaking",
    Q: 8,
    gain: 8,
  }).connect(vocalLowpass);
  vocalFormant3 = new Tone.Filter({
    frequency: 2440,
    type: "peaking",
    Q: 8,
    gain: 10,
  }).connect(vocalSingerFormant);
  vocalFormant2 = new Tone.Filter({
    frequency: 1090,
    type: "peaking",
    Q: 6,
    gain: 12,
  }).connect(vocalFormant3);
  vocalFormant1 = new Tone.Filter({
    frequency: 730,
    type: "peaking",
    Q: 4,
    gain: 15,
  }).connect(vocalFormant2);
  vocalHighpass = new Tone.Filter({
    frequency: 80,
    type: "highpass",
    Q: 0.7,
  }).connect(vocalFormant1);

  vocalSynth = new Tone.PolySynth(Tone.Synth, {
    oscillator: {
      type: "fatsawtooth",
      count: 3,
      spread: 30,
    },
    envelope: {
      attack: 0.25,
      decay: 0.1,
      sustain: 0.9,
      release: 0.8,
    },
  });
  vocalSynth.connect(vocalHighpass);
  // PolySynth 全体ボリュームを少し上げる (formant ピーキングで音圧が上がる分は Gain で吸収済み)。
  vocalSynth.volume.value = -2;
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
