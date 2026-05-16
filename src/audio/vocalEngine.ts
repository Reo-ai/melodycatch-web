/**
 * ボーカル (合唱) 楽器 — FluidR3 GM "Choir Aahs" サンプル再生版。
 *
 * 音源について:
 * - `gleitz/midi-js-soundfonts` が GitHub Pages で公開している
 *   FluidR3 GM SoundFont の "Choir Aahs" (Program 52) を使う。
 *   2.8MB の JS ファイルに「A0〜C8 のナチュラル音 52 サンプル」が
 *   base64 で埋め込まれている形式。
 * - ライセンスは MIT (FluidR3 自体は OFL/CC-by 系で、midi-js-soundfonts は
 *   商用利用も明示的に許可されている)。
 *
 * ロード戦略:
 * - 初回発音時に 2.8MB の fetch + デコードが走るので、それまでは
 *   フォルマント合成 (前バージョン) をフォールバックとして鳴らす。
 *   ロード完了後に自動で Tone.Sampler 経由の実サンプル再生に切り替わる。
 *
 * シグナルチェーン:
 *
 *   Sampler (Choir Aahs サンプル群)
 *     ──▶ Chorus(0.3Hz, depth 0.4, wet 0.1)
 *     ──▶ Gain(1.0)
 *     ──▶ Reverb(decay 3.0, wet 0.28)
 *     ──▶ Destination
 *
 *   (ロード中フォールバック)
 *   PolySynth(fatsawtooth) ─▶ HighPass ─▶ Peak F1/F2/F3/SingerFormant
 *     ─▶ LowPass ─▶ Chorus ─▶ Gain ─▶ Reverb ─▶ Destination
 */

import * as Tone from "tone";
import { midiToNoteString } from "../music/pitch";
import { loadGleitzSoundfont } from "./voiceSampleLoader";

const SOUNDFONT_URL =
  "https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM/choir_aahs-mp3.js";

// 出力チェーン (サンプラーとフォールバック合成で共有)
let vocalReverb: Tone.Reverb | null = null;
let vocalGain: Tone.Gain | null = null;
let vocalChorus: Tone.Chorus | null = null;
let vocalInput: Tone.Gain | null = null;

// 実サンプル再生
let vocalSampler: Tone.Sampler | null = null;
let vocalLoading = false;
let vocalReady = false;

// ロード中フォールバック (フォルマント合成)
let fallbackSynth: Tone.PolySynth<Tone.Synth> | null = null;
let fallbackChainHead: Tone.Filter | null = null;

function buildOutputChain() {
  if (vocalInput) return;
  vocalReverb = new Tone.Reverb({ decay: 3.0, wet: 0.28 }).toDestination();
  vocalGain = new Tone.Gain(1.0).connect(vocalReverb);
  vocalChorus = new Tone.Chorus({
    frequency: 0.3,
    delayTime: 4.0,
    depth: 0.4,
    type: "sine",
    spread: 180,
    wet: 0.1,
  }).connect(vocalGain);
  vocalChorus.start();
  vocalInput = new Tone.Gain(1).connect(vocalChorus);
}

function buildFallbackSynth() {
  if (fallbackSynth) return;
  buildOutputChain();
  // フォルマント (Ah 母音) チェーン: 直列ピーキングフィルタ
  const lp = new Tone.Filter({ frequency: 8000, type: "lowpass", Q: 0.7 }).connect(
    vocalInput!,
  );
  const sf = new Tone.Filter({ frequency: 3500, type: "peaking", Q: 8, gain: 8 }).connect(lp);
  const f3 = new Tone.Filter({ frequency: 2440, type: "peaking", Q: 8, gain: 10 }).connect(sf);
  const f2 = new Tone.Filter({ frequency: 1090, type: "peaking", Q: 6, gain: 12 }).connect(f3);
  const f1 = new Tone.Filter({ frequency: 730, type: "peaking", Q: 4, gain: 15 }).connect(f2);
  const hp = new Tone.Filter({ frequency: 80, type: "highpass", Q: 0.7 }).connect(f1);
  fallbackChainHead = hp;

  fallbackSynth = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: "fatsawtooth", count: 3, spread: 30 },
    envelope: { attack: 0.25, decay: 0.1, sustain: 0.9, release: 0.8 },
  });
  fallbackSynth.connect(fallbackChainHead);
  fallbackSynth.volume.value = -2;
}

async function ensureSamplerLoaded() {
  if (vocalSampler || vocalLoading) return;
  vocalLoading = true;
  try {
    buildOutputChain();
    const samples = await loadGleitzSoundfont(SOUNDFONT_URL, "choir_aahs");
    await new Promise<void>((resolve, reject) => {
      vocalSampler = new Tone.Sampler({
        urls: samples,
        release: 1.2,
        onload: () => {
          vocalReady = true;
          resolve();
        },
        onerror: (err) => {
          reject(err);
        },
      }).connect(vocalInput!);
      vocalSampler.volume.value = -3;
    });
  } catch (e) {
    // ロード失敗時はフォールバック合成が代わりに鳴り続ける。
    console.error("[vocal] sample load failed, falling back to formant synth", e);
    vocalSampler = null;
    vocalReady = false;
  } finally {
    vocalLoading = false;
  }
}

function ensureVocal() {
  buildFallbackSynth();
  void ensureSamplerLoaded();
}

/** UI から事前ロード可能にする (初回発音時のもたつき軽減用)。 */
export function preloadVocal(): void {
  ensureVocal();
}

/** 本物サンプルがロード完了したか (UI の "読み込み中..." 表示用)。 */
export function isVocalLoaded(): boolean {
  return vocalReady;
}

/** 本物サンプルを fetch 中か。 */
export function isVocalLoading(): boolean {
  return vocalLoading;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function useSampler(): boolean {
  return vocalReady && vocalSampler != null;
}

export function vocalHoldOn(midi: number, velocity = 0.85): void {
  ensureVocal();
  const note = midiToNoteString(midi);
  const v = clamp01(velocity);
  if (useSampler()) {
    vocalSampler!.triggerAttack(note, undefined, v);
  } else {
    fallbackSynth?.triggerAttack(note, undefined, v);
  }
}

export function vocalHoldOff(midi: number): void {
  const note = midiToNoteString(midi);
  // 切り替わり境界で取り残されないよう、両方に release を投げる。
  vocalSampler?.triggerRelease(note);
  fallbackSynth?.triggerRelease(note);
}

export function vocalTriggerNote(
  midi: number,
  durationSec: number,
  velocity = 0.85,
  time?: number,
): void {
  ensureVocal();
  const note = midiToNoteString(midi);
  const v = clamp01(velocity);
  const d = Math.max(0.05, durationSec);
  if (useSampler()) {
    vocalSampler!.triggerAttackRelease(note, d, time, v);
  } else {
    fallbackSynth?.triggerAttackRelease(note, d, time, v);
  }
}

/**
 * 和音を一括で鳴らす (コードパレット用)。
 */
export function vocalChordOn(
  midiNotes: number[],
  velocity = 0.8,
  duration = 1.6,
): void {
  ensureVocal();
  if (midiNotes.length === 0) return;
  const notes = midiNotes.map(midiToNoteString);
  const v = clamp01(velocity);
  const d = Math.max(0.05, duration);
  if (useSampler()) {
    vocalSampler!.triggerAttackRelease(notes, d, undefined, v);
  } else {
    fallbackSynth?.triggerAttackRelease(notes, d, undefined, v);
  }
}

export function vocalReleaseAll(): void {
  vocalSampler?.releaseAll();
  fallbackSynth?.releaseAll();
}
