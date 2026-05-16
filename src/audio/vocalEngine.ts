/**
 * ボーカル (合唱) 楽器 — FluidR3 GM サンプル + 母音切替版。
 *
 * 母音モード:
 *   - "aah": Choir Aahs (Program 52) を直接再生 (明るい「アー」)
 *   - "ooh": Voice Oohs (Program 53) を直接再生 (柔らかい「ウー」)
 *   - "hum": Voice Oohs をローパス + ハイ減衰で閉口音化 (「んー」)
 *
 * サンプルは 2.8MB / 母音 で大きいため、選択された母音だけ遅延ロードする。
 * ロード中は前バージョンと同じフォルマント合成フォールバックを鳴らす。
 *
 * 出力ルーティング (母音ごとに独立した sampler → 母音別の post-chain → 共通バス):
 *
 *   Sampler(aah) ─▶ Gain(post-aah) ──┐
 *   Sampler(ooh) ─▶ Gain(post-ooh) ──┼─▶ vocalInput ─▶ Chorus ─▶ Gain ─▶ Reverb ─▶ Dest
 *   Sampler(hum) ─▶ Lowpass(500Hz) ─▶ Gain(post-hum) ┘
 *   Fallback (formant synth) ──────────▶ vocalInput
 *
 * ライセンス:
 * - midi-js-soundfonts (MIT) + FluidR3 GM (MIT/OFL系, 商用可)
 */

import * as Tone from "tone";
import { midiToNoteString } from "../music/pitch";
import { loadGleitzSoundfont } from "./voiceSampleLoader";

export type VocalVowel = "aah" | "ooh" | "hum";

interface VowelSpec {
  url: string;
  sfName: string;
  /** UI 表示用日本語ラベル。 */
  label: string;
  /** Sampler 自体のボリューム (dB)。母音ごとの音量差を吸収。 */
  samplerDb: number;
}

const VOWEL_SPECS: Record<VocalVowel, VowelSpec> = {
  aah: {
    url: "https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM/choir_aahs-mp3.js",
    sfName: "choir_aahs",
    label: "アー",
    samplerDb: -3,
  },
  ooh: {
    url: "https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM/voice_oohs-mp3.js",
    sfName: "voice_oohs",
    label: "ウー",
    samplerDb: -2,
  },
  hum: {
    // Hum は Ooh サンプルをローパスで通すので URL は Ooh と同じ。
    url: "https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM/voice_oohs-mp3.js",
    sfName: "voice_oohs",
    label: "んー",
    samplerDb: 0,
  },
};

// 共通出力チェーン -----------------------------------------------------------
let vocalReverb: Tone.Reverb | null = null;
let vocalGain: Tone.Gain | null = null;
let vocalChorus: Tone.Chorus | null = null;
let vocalInput: Tone.Gain | null = null;

// 母音別 sampler/状態 --------------------------------------------------------
interface VowelRuntime {
  sampler: Tone.Sampler | null;
  loading: boolean;
  ready: boolean;
  /** sampler 出力先 (post chain head)。母音切替時に gain を 0 にして遮断する。 */
  postInput: Tone.ToneAudioNode | null;
  postGain: Tone.Gain | null;
}
const vowelRuntime: Record<VocalVowel, VowelRuntime> = {
  aah: { sampler: null, loading: false, ready: false, postInput: null, postGain: null },
  ooh: { sampler: null, loading: false, ready: false, postInput: null, postGain: null },
  hum: { sampler: null, loading: false, ready: false, postInput: null, postGain: null },
};

// ロード中フォールバック -----------------------------------------------------
let fallbackSynth: Tone.PolySynth<Tone.Synth> | null = null;
let fallbackChainHead: Tone.Filter | null = null;

// 現在選択中の母音 -----------------------------------------------------------
let activeVowel: VocalVowel = "aah";

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

function buildVowelPostChain(vowel: VocalVowel): VowelRuntime {
  buildOutputChain();
  const rt = vowelRuntime[vowel];
  if (rt.postInput) return rt;
  // 現在 active な母音だけ通す/それ以外は 0 にする。
  const gain = new Tone.Gain(vowel === activeVowel ? 1 : 0).connect(vocalInput!);
  rt.postGain = gain;
  if (vowel === "hum") {
    // 閉口音シミュレート: 500Hz ローパス + 軽めのハイ減衰 + 出力を少し落とす
    const lp = new Tone.Filter({ frequency: 500, type: "lowpass", Q: 0.9 }).connect(gain);
    const shelf = new Tone.Filter({ frequency: 1200, type: "highshelf", gain: -6 }).connect(lp);
    rt.postInput = shelf;
  } else {
    rt.postInput = gain;
  }
  return rt;
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

async function ensureSamplerLoaded(vowel: VocalVowel) {
  const rt = vowelRuntime[vowel];
  if (rt.sampler || rt.loading) return;
  rt.loading = true;
  try {
    const post = buildVowelPostChain(vowel);
    const spec = VOWEL_SPECS[vowel];
    const samples = await loadGleitzSoundfont(spec.url, spec.sfName);
    await new Promise<void>((resolve, reject) => {
      const s = new Tone.Sampler({
        urls: samples,
        release: 1.2,
        onload: () => {
          rt.ready = true;
          resolve();
        },
        onerror: (err) => {
          reject(err);
        },
      }).connect(post.postInput!);
      s.volume.value = spec.samplerDb;
      rt.sampler = s;
    });
  } catch (e) {
    console.error(`[vocal] sample load failed for ${vowel}, fallback synth in use`, e);
    rt.sampler = null;
    rt.ready = false;
  } finally {
    rt.loading = false;
  }
}

function ensureVocal() {
  buildFallbackSynth();
  void ensureSamplerLoaded(activeVowel);
}

/** UI から事前ロード可能にする (初回発音時のもたつき軽減用)。 */
export function preloadVocal(vowel?: VocalVowel): void {
  buildFallbackSynth();
  void ensureSamplerLoaded(vowel ?? activeVowel);
}

/** 現在 active な母音のサンプルがロード完了したか。 */
export function isVocalLoaded(vowel?: VocalVowel): boolean {
  return vowelRuntime[vowel ?? activeVowel].ready;
}

/** 現在 active な母音のサンプルを fetch 中か。 */
export function isVocalLoading(vowel?: VocalVowel): boolean {
  return vowelRuntime[vowel ?? activeVowel].loading;
}

/** 現在選択中の母音を取得。 */
export function getVocalVowel(): VocalVowel {
  return activeVowel;
}

/** 母音を切り替える。サンプル未ロードなら自動でロードを開始する。 */
export function setVocalVowel(vowel: VocalVowel): void {
  if (vowel === activeVowel) return;
  // 切り替え前に旧母音の鳴っている音を止める。
  vowelRuntime[activeVowel].sampler?.releaseAll();
  // post-chain の gain で物理的に遮断 (リバーブテールは残す)。
  const prev = vowelRuntime[activeVowel];
  if (prev.postGain) prev.postGain.gain.rampTo(0, 0.05);
  activeVowel = vowel;
  buildFallbackSynth();
  buildVowelPostChain(vowel);
  const next = vowelRuntime[vowel];
  if (next.postGain) next.postGain.gain.rampTo(1, 0.05);
  void ensureSamplerLoaded(vowel);
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function activeSampler(): Tone.Sampler | null {
  const rt = vowelRuntime[activeVowel];
  return rt.ready ? rt.sampler : null;
}

export function vocalHoldOn(midi: number, velocity = 0.85): void {
  ensureVocal();
  const note = midiToNoteString(midi);
  const v = clamp01(velocity);
  const s = activeSampler();
  if (s) {
    s.triggerAttack(note, undefined, v);
  } else {
    fallbackSynth?.triggerAttack(note, undefined, v);
  }
}

export function vocalHoldOff(midi: number): void {
  const note = midiToNoteString(midi);
  // 切り替わり境界で取り残されないよう、両方に release を投げる。
  for (const v of Object.values(vowelRuntime)) {
    v.sampler?.triggerRelease(note);
  }
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
  const s = activeSampler();
  if (s) {
    s.triggerAttackRelease(note, d, time, v);
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
  const s = activeSampler();
  if (s) {
    s.triggerAttackRelease(notes, d, undefined, v);
  } else {
    fallbackSynth?.triggerAttackRelease(notes, d, undefined, v);
  }
}

export function vocalReleaseAll(): void {
  for (const v of Object.values(vowelRuntime)) {
    v.sampler?.releaseAll();
  }
  fallbackSynth?.releaseAll();
}
