/**
 * ギター楽器 (PluckSynth ベース)。
 *
 * 2 種類のサウンドを切り替えられる:
 *   - "distortion" : ハードロック系エレキ。2 段歪み (Distortion + Chebyshev) +
 *                    アンプ EQ + 軽いコーラスで「ジャー」というドライブ感。
 *   - "clean"      : クリーントーン。歪み無し、開いた LowPass、軽いコーラスと
 *                    リバーブだけ。コードカッティングやアルペジオに合う。
 *
 * setGuitarType(type) で切り替え。再生中の音は止めて内部チェーンを作り直す。
 *
 * 実装メモ:
 * - PluckSynth は Tone.js の PolySynth が要求する Monophonic<any> 型制約を
 *   満たさないため、自前で多重発音用のボイスプールを管理する。
 * - PluckSynth.triggerAttack(Release) は velocity 引数を受け付けないため、
 *   強弱は volume.value で表現する (= 約 ±8dB のレンジ)。
 */

import * as Tone from "tone";
import { midiToNoteString } from "../music/pitch";
import { getReverbInput } from "./mixer";
import { createSampler, samplerReady, velocity01 } from "./sampledInstruments";

export type GuitarType = "distortion" | "clean";

let currentGuitarType: GuitarType = "distortion";

const VOICE_COUNT = 8;

let guitarReverb: Tone.Reverb | null = null;
let guitarChorus: Tone.Chorus | null = null;
let guitarLowpass: Tone.Filter | null = null;
let guitarMidPeak: Tone.Filter | null = null;
let guitarBodyPeak: Tone.Filter | null = null;
let guitarHighpass: Tone.Filter | null = null;
let guitarChebyshev: Tone.Chebyshev | null = null;
let guitarDistortion: Tone.Distortion | null = null;
let guitarPreGain: Tone.Gain | null = null;
let guitarGain: Tone.Gain | null = null;

/**
 * 本物のエレキギター (クリーンのライン録り) のサンプル音源。
 * クリーン時はそのまま、ディストーション時は歪み回路に通して鳴らす。
 * 読み込みが終わるまでは下の PluckSynth (シンセ) が代わりに鳴る。
 */
let guitarSampler: Tone.Sampler | null = null;
/** ラウンドロビンで使う PluckSynth ボイス (本物の音源が読み込めていない時だけ作る)。 */
let guitarVoices: Tone.PluckSynth[] = [];
/**
 * PluckSynth は鳴っていなくても常に計算し続ける (内部で AudioWorklet を使う) ため、
 * 最初から 8 個作っておくと、本物の音源で鳴らしている間もずっと処理が重くなる。
 * 代わりの音が本当に必要になった時にだけ作る。ここにはその接続先と設定を覚えておく。
 */
let guitarVoiceTarget: Tone.InputNode | null = null;
let guitarVoiceOpts: { attackNoise: number; dampening: number; resonance: number; release: number; volume: number } | null = null;

function ensureGuitarVoices(): void {
  if (guitarVoices.length > 0 || !guitarVoiceTarget || !guitarVoiceOpts) return;
  const { volume, ...opts } = guitarVoiceOpts;
  for (let i = 0; i < VOICE_COUNT; i++) {
    const v = new Tone.PluckSynth(opts);
    v.volume.value = volume;
    v.connect(guitarVoiceTarget);
    guitarVoices.push(v);
  }
}
let voiceCursor = 0;
/** 同じ MIDI ノートが現在どのボイスで鳴っているか (HoldOff 用)。 */
const noteToVoice: Map<number, Tone.PluckSynth> = new Map();
/** 押しっぱなし時に「再ピック」するための setTimeout ハンドル。
 *  Karplus-Strong は撥弦モデルなので 1 回弾くと自然減衰する。
 *  長押し中は一定間隔で再ピックすることで、ギターの「サステイン強奏」
 *  (短いトレモロ的な持続) を再現する。 */
const noteToRepluckTimer: Map<number, number> = new Map();
/** 自動再ピックの初回ディレイ (ms)。
 *  短すぎると単音が tremolo 的になるので、自然減衰がそろそろ消えかける頃合いに設定。 */
const REPLUCK_DELAY_MS = 1100;
/** 各回の再ピックの音量減衰 (dB)。少しずつ弱くして自然なフェード感に。 */
const REPLUCK_DECAY_DB = -2;

function disposeGuitar(): void {
  for (const v of guitarVoices) {
    try {
      v.triggerRelease();
    } catch {
      /* noop */
    }
    v.dispose();
  }
  guitarVoices = [];
  guitarVoiceTarget = null;
  guitarVoiceOpts = null;
  try {
    guitarSampler?.releaseAll();
  } catch {
    /* noop */
  }
  guitarSampler?.dispose();
  guitarSampler = null;
  noteToVoice.clear();
  for (const handle of noteToRepluckTimer.values()) {
    window.clearTimeout(handle);
  }
  noteToRepluckTimer.clear();
  guitarPreGain?.dispose();
  guitarDistortion?.dispose();
  guitarChebyshev?.dispose();
  guitarHighpass?.dispose();
  guitarBodyPeak?.dispose();
  guitarMidPeak?.dispose();
  guitarLowpass?.dispose();
  guitarChorus?.dispose();
  guitarGain?.dispose();
  guitarReverb?.dispose();
  guitarPreGain = null;
  guitarDistortion = null;
  guitarChebyshev = null;
  guitarHighpass = null;
  guitarBodyPeak = null;
  guitarMidPeak = null;
  guitarLowpass = null;
  guitarChorus = null;
  guitarGain = null;
  guitarReverb = null;
}

/** ギターのサウンドタイプを切り替える。再生中の音は止めて内部チェーンを作り直す。 */
export function setGuitarType(type: GuitarType): void {
  if (type === currentGuitarType && guitarSampler) return;
  disposeGuitar();
  currentGuitarType = type;
  // 次回の発音で ensureGuitar() が新しいタイプで作り直す。
}

export function getGuitarType(): GuitarType {
  return currentGuitarType;
}

function ensureGuitar() {
  if (guitarSampler) return;

  if (currentGuitarType === "distortion") {
    // ハードロック系エレキ (現行の挙動)。
    // 残響は共有の部屋リバーブへ送る (楽器ごとにリバーブを持つと重いため)
    guitarReverb = null;
    guitarGain = new Tone.Gain(0.55).connect(getReverbInput("guitar", "room", 0.18));
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
    guitarChebyshev = new Tone.Chebyshev({
      order: 12,
      wet: 0.45,
    }).connect(guitarHighpass);
    guitarDistortion = new Tone.Distortion({
      distortion: 0.85,
      oversample: "4x",
      wet: 1.0,
    }).connect(guitarChebyshev);
    // 歪み段を稼ぐためのプリゲイン。
    guitarPreGain = new Tone.Gain(2.0).connect(guitarDistortion);

    guitarVoiceTarget = guitarPreGain;
    guitarVoiceOpts = { attackNoise: 1.8, dampening: 4200, resonance: 0.97, release: 0.6, volume: -3 };
    guitarSampler = createSampler("eguitar", { release: 0.25, volume: -16 });
    guitarSampler.connect(guitarPreGain);
  } else {
    // クリーントーン: 歪みなし、開いた高域、軽いコーラスとリバーブ。
    guitarReverb = null;
    guitarGain = new Tone.Gain(0.62).connect(getReverbInput("guitar", "hall", 0.2));
    guitarChorus = new Tone.Chorus({
      frequency: 0.6,
      delayTime: 3.0,
      depth: 0.3,
      wet: 0.18,
    })
      .connect(guitarGain)
      .start();
    // クリーンなので高域は開いてキラキラを残す。
    guitarLowpass = new Tone.Filter({
      frequency: 7500,
      type: "lowpass",
      Q: 0.5,
      rolloff: -24,
    }).connect(guitarChorus);
    // コードの輪郭は控えめにブーストする (歪みがないので軽めで OK)。
    guitarMidPeak = new Tone.Filter({
      frequency: 1800,
      type: "peaking",
      Q: 1.0,
      gain: 1.5,
    }).connect(guitarLowpass);
    // ボディ感 (200Hz 付近) を軽く乗せて痩せた音になるのを防ぐ。
    guitarBodyPeak = new Tone.Filter({
      frequency: 200,
      type: "peaking",
      Q: 1.0,
      gain: 2,
    }).connect(guitarMidPeak);
    guitarHighpass = new Tone.Filter({
      frequency: 85,
      type: "highpass",
    }).connect(guitarBodyPeak);

    // クリーンは指弾き〜軽いピッキングをイメージしてアタックを控えめに、高域は早めに減衰。
    guitarVoiceTarget = guitarHighpass;
    guitarVoiceOpts = { attackNoise: 1.4, dampening: 4600, resonance: 0.975, release: 0.7, volume: -2 };
    guitarSampler = createSampler("eguitar", { release: 0.35, volume: -9.7 });
    guitarSampler.connect(guitarHighpass);
  }
}

/** 本物のギター音源の読み込みが終わっているか。 */
function guitarSamplerOn(): boolean {
  return samplerReady(guitarSampler);
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** 次に使うボイスを取得 (ラウンドロビン)。 */
function nextVoice(): Tone.PluckSynth {
  ensureGuitarVoices();
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
  if (guitarSamplerOn()) {
    guitarSampler!.triggerAttack(midiToNoteString(midi), undefined, velocity01(velocity));
    return;
  }
  // 同じ音が既に鳴っていたらタイマーをクリア (重複再ピック防止)。
  clearRepluckTimer(midi);
  const v = nextVoice();
  noteToVoice.set(midi, v);
  // PluckSynth は撥弦モデルなので triggerAttack で 1 回ピックする。
  const baseVolumeDb =
    (currentGuitarType === "clean" ? -2 : -3) + (clamp01(velocity) - 0.85) * 8;
  v.volume.value = baseVolumeDb;
  v.triggerAttack(midiToNoteString(midi));
  // 押しっぱなしで「伸ばす」ためのリプラックを予約。
  scheduleRepluck(midi, baseVolumeDb, 1);
}

export function guitarHoldOff(midi: number): void {
  // リプラックタイマーは必ずクリア (キーが離れたら再ピックしない)。
  clearRepluckTimer(midi);
  if (guitarSamplerOn()) {
    guitarSampler!.triggerRelease(midiToNoteString(midi));
  }
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
  if (guitarSamplerOn()) {
    guitarSampler!.triggerAttackRelease(
      midiToNoteString(midi),
      Math.max(0.05, durationSec),
      time,
      velocity01(velocity),
    );
    return;
  }
  const v = nextVoice();
  v.volume.value =
    (currentGuitarType === "clean" ? -2 : -3) + (clamp01(velocity) - 0.85) * 8;
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
  try {
    guitarSampler?.releaseAll();
  } catch {
    /* noop */
  }
}

/** 本物のギター音源を先に読み込んでおく。 */
export function preloadGuitar(): void {
  ensureGuitar();
  ensureLeadGuitar();
}

// ===========================================================================
// リードギター (2 本目) 用の並列チェーン
// ---------------------------------------------------------------------------
// バンド演奏で「クリーン + ディストーション」「バッキング + リード」のように
// 2 本のギターを同時に鳴らすため、独立した内部チェーン + ボイスプールを用意する。
// プライマリ (上の API) は手動演奏 + バッキング兼用。
// このリードチャネルは自動作曲のリードパート再生専用。
// ===========================================================================

let currentLeadGuitarType: GuitarType = "clean";

let leadReverb: Tone.Reverb | null = null;
let leadChorus: Tone.Chorus | null = null;
let leadLowpass: Tone.Filter | null = null;
let leadMidPeak: Tone.Filter | null = null;
let leadBodyPeak: Tone.Filter | null = null;
let leadHighpass: Tone.Filter | null = null;
let leadChebyshev: Tone.Chebyshev | null = null;
let leadDistortion: Tone.Distortion | null = null;
let leadPreGain: Tone.Gain | null = null;
let leadGain: Tone.Gain | null = null;
let leadVoices: Tone.PluckSynth[] = [];
let leadVoiceCursor = 0;
/** リードの代わりの音も、必要になった時にだけ作る (上のバッキングと同じ理由)。 */
let leadVoiceTarget: Tone.InputNode | null = null;
let leadVoiceOpts: { attackNoise: number; dampening: number; resonance: number; release: number; volume: number } | null = null;

function ensureLeadVoices(): void {
  if (leadVoices.length > 0 || !leadVoiceTarget || !leadVoiceOpts) return;
  const { volume, ...opts } = leadVoiceOpts;
  for (let i = 0; i < VOICE_COUNT; i++) {
    const v = new Tone.PluckSynth(opts);
    v.volume.value = volume;
    v.connect(leadVoiceTarget);
    leadVoices.push(v);
  }
}
/** リードギター用の本物のギター音源 (バッキングとは別チェーンで鳴らすので別インスタンス)。 */
let leadSampler: Tone.Sampler | null = null;

function disposeLeadGuitarInternal(): void {
  for (const v of leadVoices) {
    try { v.triggerRelease(); } catch { /* noop */ }
    v.dispose();
  }
  leadVoices = [];
  leadVoiceTarget = null;
  leadVoiceOpts = null;
  try { leadSampler?.releaseAll(); } catch { /* noop */ }
  leadSampler?.dispose();
  leadSampler = null;
  leadPreGain?.dispose();
  leadDistortion?.dispose();
  leadChebyshev?.dispose();
  leadHighpass?.dispose();
  leadBodyPeak?.dispose();
  leadMidPeak?.dispose();
  leadLowpass?.dispose();
  leadChorus?.dispose();
  leadGain?.dispose();
  leadReverb?.dispose();
  leadPreGain = null;
  leadDistortion = null;
  leadChebyshev = null;
  leadHighpass = null;
  leadBodyPeak = null;
  leadMidPeak = null;
  leadLowpass = null;
  leadChorus = null;
  leadGain = null;
  leadReverb = null;
}

export function setLeadGuitarType(type: GuitarType): void {
  if (type === currentLeadGuitarType && leadSampler) return;
  disposeLeadGuitarInternal();
  currentLeadGuitarType = type;
}

export function getLeadGuitarType(): GuitarType {
  return currentLeadGuitarType;
}

function ensureLeadGuitar() {
  if (leadSampler) return;

  if (currentLeadGuitarType === "distortion") {
    // リード用ディストーション: バッキングより少し明るめ、リバーブやや深め
    leadReverb = null;
    leadGain = new Tone.Gain(0.5).connect(getReverbInput("guitar2", "room", 0.22));
    leadChorus = new Tone.Chorus({
      frequency: 1.1,
      delayTime: 2.2,
      depth: 0.2,
      wet: 0.15,
    }).connect(leadGain).start();
    leadLowpass = new Tone.Filter({ frequency: 5400, type: "lowpass", Q: 0.6, rolloff: -24 }).connect(leadChorus);
    // リード用に中域をもう少し前に出す
    leadMidPeak = new Tone.Filter({ frequency: 1700, type: "peaking", Q: 1.0, gain: 6 }).connect(leadLowpass);
    leadHighpass = new Tone.Filter({ frequency: 130, type: "highpass" }).connect(leadMidPeak);
    leadChebyshev = new Tone.Chebyshev({ order: 14, wet: 0.55 }).connect(leadHighpass);
    leadDistortion = new Tone.Distortion({ distortion: 0.78, oversample: "4x", wet: 1.0 }).connect(leadChebyshev);
    leadPreGain = new Tone.Gain(1.9).connect(leadDistortion);

    leadVoiceTarget = leadPreGain;
    leadVoiceOpts = { attackNoise: 1.6, dampening: 4500, resonance: 0.975, release: 0.7, volume: -2 };
    leadSampler = createSampler("eguitar", { release: 0.3, volume: -16 });
    leadSampler.connect(leadPreGain);
  } else {
    // リード用クリーン: コーラスを深めに、リバーブも深めにして "歌う" 雰囲気
    leadReverb = null;
    leadGain = new Tone.Gain(0.6).connect(getReverbInput("guitar2", "hall", 0.28));
    leadChorus = new Tone.Chorus({
      frequency: 0.55,
      delayTime: 3.5,
      depth: 0.4,
      wet: 0.25,
    }).connect(leadGain).start();
    leadLowpass = new Tone.Filter({ frequency: 7800, type: "lowpass", Q: 0.5, rolloff: -24 }).connect(leadChorus);
    leadMidPeak = new Tone.Filter({ frequency: 2000, type: "peaking", Q: 0.9, gain: 2 }).connect(leadLowpass);
    leadBodyPeak = new Tone.Filter({ frequency: 220, type: "peaking", Q: 1.0, gain: 1.5 }).connect(leadMidPeak);
    leadHighpass = new Tone.Filter({ frequency: 90, type: "highpass" }).connect(leadBodyPeak);

    leadVoiceTarget = leadHighpass;
    leadVoiceOpts = { attackNoise: 1.3, dampening: 4800, resonance: 0.98, release: 0.9, volume: -1 };
    leadSampler = createSampler("eguitar", { release: 0.5, volume: -8.7 });
    leadSampler.connect(leadHighpass);
  }
}

function nextLeadVoice(): Tone.PluckSynth {
  ensureLeadVoices();
  const v = leadVoices[leadVoiceCursor];
  leadVoiceCursor = (leadVoiceCursor + 1) % leadVoices.length;
  return v;
}

/**
 * リードギター: 自動作曲のスケジューラから 1 音ずつ発音する。
 * バッキング側 (guitarTriggerNote) と独立した音色チェーンで鳴る。
 */
export function leadGuitarTriggerNote(
  midi: number,
  durationSec: number,
  velocity = 0.85,
  time?: number,
): void {
  ensureLeadGuitar();
  if (samplerReady(leadSampler)) {
    leadSampler.triggerAttackRelease(
      midiToNoteString(midi),
      Math.max(0.05, durationSec),
      time,
      velocity01(velocity),
    );
    return;
  }
  const v = nextLeadVoice();
  v.volume.value =
    (currentLeadGuitarType === "clean" ? -1 : -2) + (clamp01(velocity) - 0.85) * 8;
  v.triggerAttackRelease(midiToNoteString(midi), Math.max(0.05, durationSec), time);
}

export function leadGuitarReleaseAll(): void {
  for (const v of leadVoices) {
    try { v.triggerRelease(); } catch { /* noop */ }
  }
  try { leadSampler?.releaseAll(); } catch { /* noop */ }
}
