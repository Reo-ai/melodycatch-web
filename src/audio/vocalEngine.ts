/**
 * ボーカル (合唱) 楽器 — FluidR3 GM サンプル + 母音 + 子音アタック + 表現。
 *
 * 3 軸で音色をコントロール:
 *   1. 母音 (VocalVowel):   "aah" | "ooh" | "hum"
 *   2. 子音アタック (VocalSyllable): "none" | "la" | "ta" | "na" | "ma" | "pa"
 *      → 各ノートの頭に短いノイズ/フィルタバーストを挿入し、「ラララ」「タタタ」風に。
 *   3. 表現 (VocalExpression): "flat" | "natural" | "expressive"
 *      → ビブラート深さ、しゃくり (ピッチスクープ)、release/attack 長を変化。
 *
 * 出力ルーティング:
 *
 *   Sampler(aah) ─▶ Gain(post-aah) ─┐
 *   Sampler(ooh) ─▶ Gain(post-ooh) ─┤
 *   Sampler(hum) ─▶ LP+HS ─▶ Gain ─┤─▶ vocalInput ─▶ Vibrato ─▶ Chorus
 *   Noise ─▶ Filter ─▶ AmpEnv ─▶ Gain (子音バースト) ─┤            ─▶ Gain ─▶ Reverb ─▶ Dest
 *   Fallback Synth ─▶ formant chain ─────────────────┘
 *
 * しゃくり (ピッチスクープ):
 *   - Tone.Sampler.detune を発音時刻に -N cents → 0 へランプ。
 *   - Sampler の detune は同 sampler の全ボイス共通なので、
 *     コードオンでは衝突を避けるためスクープを適用しない (vocalChordOn 内で省略)。
 *
 * ライセンス: midi-js-soundfonts (MIT) + FluidR3 GM (MIT/OFL系, 商用可)。
 */

import * as Tone from "tone";
import { midiToNoteString } from "../music/pitch";
import { loadGleitzSoundfont } from "./voiceSampleLoader";

// =============================================================================
// 型定義
// =============================================================================
export type VocalVowel = "aah" | "ooh" | "hum";
export type VocalSyllable = "none" | "la" | "ta" | "na" | "ma" | "pa";
export type VocalExpression = "flat" | "natural" | "expressive";

interface VowelSpec {
  url: string;
  sfName: string;
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
    url: "https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM/voice_oohs-mp3.js",
    sfName: "voice_oohs",
    label: "んー",
    samplerDb: 0,
  },
};

interface SyllableProfile {
  noiseType: "white" | "pink" | "brown";
  filterFreq: number;
  filterType: "bandpass" | "lowpass" | "highpass";
  filterQ: number;
  /** バースト持続時間 (秒)。 */
  duration: number;
  /** バースト音量 (0-1)。 */
  gain: number;
  /** 子音→母音の遷移時間 (秒)。母音発音をこの分遅らせる。 */
  preDelay: number;
}

const SYLLABLE_PROFILES: Record<Exclude<VocalSyllable, "none">, SyllableProfile> = {
  // ラ: 軟口蓋気味のミッド、短いソフトバースト
  la: { noiseType: "pink", filterFreq: 400, filterType: "bandpass", filterQ: 2, duration: 0.03, gain: 0.22, preDelay: 0.03 },
  // タ: 鋭い高域トランジェント
  ta: { noiseType: "white", filterFreq: 5000, filterType: "highpass", filterQ: 1, duration: 0.015, gain: 0.45, preDelay: 0.015 },
  // ナ: 鼻腔共振イメージ (250Hz バンドパス)
  na: { noiseType: "pink", filterFreq: 250, filterType: "bandpass", filterQ: 4, duration: 0.04, gain: 0.28, preDelay: 0.04 },
  // マ: 唇閉鎖からの開放、暗めの低域
  ma: { noiseType: "pink", filterFreq: 200, filterType: "lowpass", filterQ: 2, duration: 0.045, gain: 0.28, preDelay: 0.045 },
  // パ: 唇の破裂、中域バースト
  pa: { noiseType: "white", filterFreq: 1500, filterType: "bandpass", filterQ: 1, duration: 0.018, gain: 0.4, preDelay: 0.018 },
};

interface ExpressionPreset {
  /** Vibrato 深さ (0-1)。0 で無効。 */
  vibratoDepth: number;
  /** Vibrato 周波数 (Hz)。 */
  vibratoFreq: number;
  /** Sampler の release (秒)。長いほどレガート気味。 */
  release: number;
  /** Sampler の attack (秒)。 */
  attack: number;
  /** しゃくり量 (cents)。0 で無効。 */
  scoopCents: number;
  /** しゃくり所要時間 (秒)。 */
  scoopDurSec: number;
}

const EXPRESSION_PRESETS: Record<VocalExpression, ExpressionPreset> = {
  flat:       { vibratoDepth: 0,     vibratoFreq: 5,   release: 0.8, attack: 0.005, scoopCents: 0,  scoopDurSec: 0    },
  natural:    { vibratoDepth: 0.015, vibratoFreq: 5,   release: 1.5, attack: 0.04,  scoopCents: 0,  scoopDurSec: 0    },
  expressive: { vibratoDepth: 0.03,  vibratoFreq: 5.5, release: 2.2, attack: 0.08,  scoopCents: 40, scoopDurSec: 0.12 },
};

// =============================================================================
// 共通出力チェーン
// =============================================================================
let vocalReverb: Tone.Reverb | null = null;
let vocalGain: Tone.Gain | null = null;
let vocalChorus: Tone.Chorus | null = null;
let vocalVibrato: Tone.Vibrato | null = null;
let vocalInput: Tone.Gain | null = null;

// =============================================================================
// 母音別 sampler/状態
// =============================================================================
interface VowelRuntime {
  sampler: Tone.Sampler | null;
  loading: boolean;
  ready: boolean;
  postInput: Tone.ToneAudioNode | null;
  postGain: Tone.Gain | null;
}
const vowelRuntime: Record<VocalVowel, VowelRuntime> = {
  aah: { sampler: null, loading: false, ready: false, postInput: null, postGain: null },
  ooh: { sampler: null, loading: false, ready: false, postInput: null, postGain: null },
  hum: { sampler: null, loading: false, ready: false, postInput: null, postGain: null },
};

// =============================================================================
// 子音バースト用ノード
// =============================================================================
let consonantNoise: Tone.Noise | null = null;
let consonantFilter: Tone.Filter | null = null;
let consonantEnv: Tone.AmplitudeEnvelope | null = null;

// =============================================================================
// フォールバック合成 (ロード中)
// =============================================================================
let fallbackSynth: Tone.PolySynth<Tone.Synth> | null = null;
let fallbackChainHead: Tone.Filter | null = null;

// =============================================================================
// 現在選択中
// =============================================================================
let activeVowel: VocalVowel = "aah";
let activeSyllable: VocalSyllable = "none";
let activeExpression: VocalExpression = "natural";

function buildOutputChain() {
  if (vocalInput) return;
  const exp = EXPRESSION_PRESETS[activeExpression];
  vocalReverb = new Tone.Reverb({ decay: 3.0, wet: 0.28 }).toDestination();
  vocalGain = new Tone.Gain(4.0).connect(vocalReverb);
  vocalChorus = new Tone.Chorus({
    frequency: 0.3,
    delayTime: 4.0,
    depth: 0.4,
    type: "sine",
    spread: 180,
    wet: 0.1,
  }).connect(vocalGain);
  vocalChorus.start();
  vocalVibrato = new Tone.Vibrato({
    frequency: exp.vibratoFreq,
    depth: exp.vibratoDepth,
  }).connect(vocalChorus);
  vocalInput = new Tone.Gain(1).connect(vocalVibrato);
}

function buildVowelPostChain(vowel: VocalVowel): VowelRuntime {
  buildOutputChain();
  const rt = vowelRuntime[vowel];
  if (rt.postInput) return rt;
  const gain = new Tone.Gain(vowel === activeVowel ? 1 : 0).connect(vocalInput!);
  rt.postGain = gain;
  if (vowel === "hum") {
    const lp = new Tone.Filter({ frequency: 500, type: "lowpass", Q: 0.9 }).connect(gain);
    const shelf = new Tone.Filter({ frequency: 1200, type: "highshelf", gain: -6 }).connect(lp);
    rt.postInput = shelf;
  } else {
    rt.postInput = gain;
  }
  return rt;
}

function buildConsonantChain() {
  if (consonantNoise) return;
  buildOutputChain();
  const gain = new Tone.Gain(1).connect(vocalInput!);
  consonantEnv = new Tone.AmplitudeEnvelope({
    attack: 0.005,
    decay: 0.03,
    sustain: 0,
    release: 0.02,
  }).connect(gain);
  consonantFilter = new Tone.Filter({ frequency: 2000, type: "bandpass", Q: 2 }).connect(consonantEnv);
  consonantNoise = new Tone.Noise("white").connect(consonantFilter);
  consonantNoise.start();
}

function buildFallbackSynth() {
  if (fallbackSynth) return;
  buildOutputChain();
  const lp = new Tone.Filter({ frequency: 8000, type: "lowpass", Q: 0.7 }).connect(vocalInput!);
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
    const exp = EXPRESSION_PRESETS[activeExpression];
    const samples = await loadGleitzSoundfont(spec.url, spec.sfName);
    await new Promise<void>((resolve, reject) => {
      const s = new Tone.Sampler({
        urls: samples,
        attack: exp.attack,
        release: exp.release,
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
  buildConsonantChain();
  void ensureSamplerLoaded(activeVowel);
}

// =============================================================================
// 公開 API: ロード/状態
// =============================================================================
export function preloadVocal(vowel?: VocalVowel): void {
  buildFallbackSynth();
  buildConsonantChain();
  void ensureSamplerLoaded(vowel ?? activeVowel);
}

export function isVocalLoaded(vowel?: VocalVowel): boolean {
  return vowelRuntime[vowel ?? activeVowel].ready;
}

export function isVocalLoading(vowel?: VocalVowel): boolean {
  return vowelRuntime[vowel ?? activeVowel].loading;
}

// =============================================================================
// 公開 API: 設定
// =============================================================================
export function getVocalVowel(): VocalVowel {
  return activeVowel;
}

export function setVocalVowel(vowel: VocalVowel): void {
  if (vowel === activeVowel) return;
  vowelRuntime[activeVowel].sampler?.releaseAll();
  const prev = vowelRuntime[activeVowel];
  if (prev.postGain) prev.postGain.gain.rampTo(0, 0.05);
  activeVowel = vowel;
  buildFallbackSynth();
  buildConsonantChain();
  buildVowelPostChain(vowel);
  const next = vowelRuntime[vowel];
  if (next.postGain) next.postGain.gain.rampTo(1, 0.05);
  void ensureSamplerLoaded(vowel);
}

export function getVocalSyllable(): VocalSyllable {
  return activeSyllable;
}

export function setVocalSyllable(s: VocalSyllable): void {
  activeSyllable = s;
  if (s !== "none") buildConsonantChain();
}

export function getVocalExpression(): VocalExpression {
  return activeExpression;
}

export function setVocalExpression(e: VocalExpression): void {
  activeExpression = e;
  const p = EXPRESSION_PRESETS[e];
  if (vocalVibrato) {
    vocalVibrato.depth.rampTo(p.vibratoDepth, 0.2);
    vocalVibrato.frequency.rampTo(p.vibratoFreq, 0.2);
  }
  // 既にロード済みの sampler にも attack/release を反映 (Tone.js は public プロパティ)。
  for (const v of Object.values(vowelRuntime)) {
    if (v.sampler) {
      try {
        (v.sampler as unknown as { attack: number }).attack = p.attack;
        (v.sampler as unknown as { release: number }).release = p.release;
      } catch {
        // 失敗しても無視 (次回ロードに反映される)
      }
    }
  }
}

// =============================================================================
// 内部ヘルパー
// =============================================================================
function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function activeSampler(): Tone.Sampler | null {
  const rt = vowelRuntime[activeVowel];
  return rt.ready ? rt.sampler : null;
}

/**
 * 子音バーストをスケジュール。子音→母音の preDelay (秒) を返す。
 * syllable === "none" のときは 0 を返す (遅延なし)。
 */
function triggerConsonant(time: number): number {
  if (activeSyllable === "none") return 0;
  buildConsonantChain();
  if (!consonantNoise || !consonantFilter || !consonantEnv) return 0;
  const p = SYLLABLE_PROFILES[activeSyllable];
  if (consonantNoise.type !== p.noiseType) {
    consonantNoise.type = p.noiseType;
  }
  consonantFilter.frequency.setValueAtTime(p.filterFreq, time);
  consonantFilter.type = p.filterType;
  consonantFilter.Q.setValueAtTime(p.filterQ, time);
  consonantEnv.triggerAttackRelease(p.duration, time, p.gain);
  return p.preDelay;
}

/**
 * しゃくり (ピッチスクープ): sampler の detune を -scoopCents → 0 にランプ。
 * Sampler 全体に効くので、コード再生時は呼ばない。
 */
function applyScoop(time: number): void {
  const p = EXPRESSION_PRESETS[activeExpression];
  if (p.scoopCents === 0) return;
  const s = activeSampler();
  if (!s) return;
  try {
    const det = (s as unknown as { detune: Tone.Param<"cents"> }).detune;
    det.cancelScheduledValues(time);
    det.setValueAtTime(-p.scoopCents, time);
    det.linearRampToValueAtTime(0, time + p.scoopDurSec);
  } catch {
    // 古い Tone.js 版では detune が見えないケース。無視。
  }
}

// =============================================================================
// 公開 API: 発音
// =============================================================================
export function vocalHoldOn(midi: number, velocity = 0.85): void {
  ensureVocal();
  const note = midiToNoteString(midi);
  const v = clamp01(velocity);
  const baseTime = Tone.now();
  const preDelay = triggerConsonant(baseTime);
  const vowelTime = baseTime + preDelay;
  applyScoop(vowelTime);
  const s = activeSampler();
  if (s) {
    s.triggerAttack(note, vowelTime, v);
  } else {
    fallbackSynth?.triggerAttack(note, vowelTime, v);
  }
}

export function vocalHoldOff(midi: number): void {
  const note = midiToNoteString(midi);
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
  const baseTime = time ?? Tone.now();
  const preDelay = triggerConsonant(baseTime);
  const vowelTime = baseTime + preDelay;
  applyScoop(vowelTime);
  const s = activeSampler();
  if (s) {
    s.triggerAttackRelease(note, d, vowelTime, v);
  } else {
    fallbackSynth?.triggerAttackRelease(note, d, vowelTime, v);
  }
}

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
  const baseTime = Tone.now();
  const preDelay = triggerConsonant(baseTime);
  const vowelTime = baseTime + preDelay;
  // コードオンではしゃくりはスキップ (Sampler 全体に効くので和音が崩れる)。
  const s = activeSampler();
  if (s) {
    s.triggerAttackRelease(notes, d, vowelTime, v);
  } else {
    fallbackSynth?.triggerAttackRelease(notes, d, vowelTime, v);
  }
}

export function vocalReleaseAll(): void {
  for (const v of Object.values(vowelRuntime)) {
    v.sampler?.releaseAll();
  }
  fallbackSynth?.releaseAll();
}
