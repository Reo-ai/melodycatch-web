/**
 * ボーカル (合唱) 楽器。
 *
 * 実装方針:
 * - 音源は **Tone.Sampler** で `nbrosowsky/tonejs-instruments` の Choir Aahs
 *   サンプルを CDN (GitHub Pages) から直接ロードする。
 *   元サンプル: Versilian Studios "Versilian Community Sample Library (VCSL)"
 *   ライセンス: CC0 / Public Domain。
 * - サンプルを直接鳴らすので「人の声」のフォルマント感がそのまま得られる。
 *   合成 (フォルマントシンセ) より自然で、追加の重量級ライブラリも不要。
 *
 * シグナルチェーン:
 *   Sampler (Choir Aahs)
 *     ──▶ HighPass(80Hz)            ※低域のサンプルノイズを落とす
 *     ──▶ BodyPeak(250Hz, +1dB)     ※声の胸響き
 *     ──▶ PresencePeak(2.5kHz, +1.5dB) ※歌詞の明瞭度
 *     ──▶ AirShelf(8kHz, +1dB)      ※空気感
 *     ──▶ LowPass(10kHz)            ※サンプル由来のシャリ感をカット
 *     ──▶ Chorus(0.3Hz, depth 0.4, wet 0.18) ※合唱の "うねり"
 *     ──▶ Gain(0.55)
 *     ──▶ Reverb(decay 3.2, wet 0.32) ※聖堂感
 *     ──▶ Destination
 *
 * インターフェース:
 * - holdOn/holdOff … 押しっぱなしの持続音 (ピアノ層と同じ)
 * - triggerNote   … 1 ノートを所定の長さで鳴らす
 * - chordOn       … 和音を一括発音 (コードパレット用、軽く時間差で柔らかく)
 * - releaseAll    … 全ボイス停止
 */

import * as Tone from "tone";
import { midiToNoteString } from "../music/pitch";

const SAMPLE_BASE_URL =
  "https://nbrosowsky.github.io/tonejs-instruments/samples/choir/";

let vocalSampler: Tone.Sampler | null = null;
let vocalReverb: Tone.Reverb | null = null;
let vocalChorus: Tone.Chorus | null = null;
let vocalLowpass: Tone.Filter | null = null;
let vocalAirShelf: Tone.Filter | null = null;
let vocalPresencePeak: Tone.Filter | null = null;
let vocalBodyPeak: Tone.Filter | null = null;
let vocalHighpass: Tone.Filter | null = null;
let vocalGain: Tone.Gain | null = null;

/** ロード完了したかどうか (UI 側で "読み込み中..." 表示に使える)。 */
let vocalLoaded = false;

function ensureVocal() {
  if (vocalSampler) return;

  vocalReverb = new Tone.Reverb({ decay: 3.2, wet: 0.32 }).toDestination();
  vocalGain = new Tone.Gain(0.55).connect(vocalReverb);
  vocalChorus = new Tone.Chorus({
    frequency: 0.3,
    delayTime: 4.0,
    depth: 0.4,
    type: "sine",
    spread: 180,
    wet: 0.18,
  }).connect(vocalGain);
  vocalChorus.start();
  vocalLowpass = new Tone.Filter({
    frequency: 10000,
    type: "lowpass",
    Q: 0.5,
    rolloff: -24,
  }).connect(vocalChorus);
  vocalAirShelf = new Tone.Filter({
    frequency: 8000,
    type: "highshelf",
    gain: 1,
  }).connect(vocalLowpass);
  vocalPresencePeak = new Tone.Filter({
    frequency: 2500,
    type: "peaking",
    Q: 1.0,
    gain: 1.5,
  }).connect(vocalAirShelf);
  vocalBodyPeak = new Tone.Filter({
    frequency: 250,
    type: "peaking",
    Q: 1.0,
    gain: 1,
  }).connect(vocalPresencePeak);
  vocalHighpass = new Tone.Filter({
    frequency: 80,
    type: "highpass",
  }).connect(vocalBodyPeak);

  vocalSampler = new Tone.Sampler({
    urls: {
      A3: "A3.mp3",
      C4: "C4.mp3",
      E4: "E4.mp3",
      A4: "A4.mp3",
      C5: "C5.mp3",
      E5: "E5.mp3",
      A5: "A5.mp3",
    },
    baseUrl: SAMPLE_BASE_URL,
    release: 1.2,
    onload: () => {
      vocalLoaded = true;
    },
  }).connect(vocalHighpass);
  // サンプル全体音量を下げて他楽器とバランスをとる。
  vocalSampler.volume.value = -6;
}

export function isVocalLoaded(): boolean {
  return vocalLoaded;
}

/** UI から事前ロード可能にする。初回発音時のもたつき軽減用。 */
export function preloadVocal(): void {
  ensureVocal();
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

export function vocalHoldOn(midi: number, velocity = 0.85): void {
  ensureVocal();
  vocalSampler?.triggerAttack(midiToNoteString(midi), undefined, clamp01(velocity));
}

export function vocalHoldOff(midi: number): void {
  vocalSampler?.triggerRelease(midiToNoteString(midi));
}

export function vocalTriggerNote(
  midi: number,
  durationSec: number,
  velocity = 0.85,
  time?: number,
): void {
  ensureVocal();
  vocalSampler?.triggerAttackRelease(
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
  if (!vocalSampler || midiNotes.length === 0) return;
  const notes = midiNotes.map(midiToNoteString);
  vocalSampler.triggerAttackRelease(
    notes,
    Math.max(0.05, duration),
    undefined,
    clamp01(velocity),
  );
}

export function vocalReleaseAll(): void {
  vocalSampler?.releaseAll();
}
