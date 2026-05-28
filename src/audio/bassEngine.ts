/**
 * ベース楽器 (Tone.js MonoSynth ベースのポリフォニック・シンセ)。
 *
 * 3 種類のベースタイプを切り替えられる:
 *   - "wood"  : ウッド (アップライト) ベース。三角波 + 重い低域、歪みなし、短い減衰。
 *   - "synth" : シンセベース。鋸波 + 共振フィルタ + 軽い歪み (パワフルで派手)。
 *   - "slap"  : スラップベース。鋭いプラックアタック + 明るい中域 + ノイズで「カン」。
 *
 * setBassType(type) で切り替え。再生中の音は止めて内部チェーンを作り直す。
 * holdOn/holdOff で持続音、triggerNote で短いノート、chordOn で和音発音。
 */

import * as Tone from "tone";
import { midiToNoteString } from "../music/pitch";
import { getMixerInput } from "./mixer";

export type BassType = "wood" | "synth" | "slap";

let currentBassType: BassType = "wood";

let bassSynth: Tone.PolySynth | null = null;
let bassHighpass: Tone.Filter | null = null;
let bassDistortion: Tone.Distortion | null = null;
let bassEq: Tone.EQ3 | null = null;
let bassCompressor: Tone.Compressor | null = null;
let bassReverb: Tone.Reverb | null = null;
/** スラップ時の「カン」ノイズ。slap 以外では使われない。 */
let bassSlapNoise: Tone.NoiseSynth | null = null;
let bassSlapNoiseFilter: Tone.Filter | null = null;

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function disposeBass(): void {
  try {
    bassSynth?.releaseAll();
  } catch {
    /* noop */
  }
  bassSynth?.dispose();
  bassSlapNoise?.dispose();
  bassSlapNoiseFilter?.dispose();
  bassHighpass?.dispose();
  bassDistortion?.dispose();
  bassEq?.dispose();
  bassCompressor?.dispose();
  bassReverb?.dispose();
  bassSynth = null;
  bassSlapNoise = null;
  bassSlapNoiseFilter = null;
  bassHighpass = null;
  bassDistortion = null;
  bassEq = null;
  bassCompressor = null;
  bassReverb = null;
}

/** ベースタイプを切り替える。再生中の音は止めて内部チェーンを作り直す。 */
export function setBassType(type: BassType): void {
  if (type === currentBassType && bassSynth) return;
  disposeBass();
  currentBassType = type;
  // 次回の発音で ensureBass() が新しいタイプで作り直す。
}

export function getBassType(): BassType {
  return currentBassType;
}

function ensureBass() {
  if (bassSynth) return;

  // 共通の終段。
  bassReverb = new Tone.Reverb({ decay: 0.6, wet: 0.04 }).connect(getMixerInput("bass"));
  bassCompressor = new Tone.Compressor({
    threshold: -18,
    ratio: 3.5,
    attack: 0.006,
    release: 0.12,
    knee: 6,
  }).connect(bassReverb);

  if (currentBassType === "wood") {
    // ウッドベース (アップライト) — 木の胴鳴り、丸く太い、歪みなし、短い減衰。
    // 低域を強めにブースト、中域は控えめ、高域はバッサリ落とす。
    bassEq = new Tone.EQ3({
      low: 5,
      mid: -2,
      high: -16,
      lowFrequency: 180,
      highFrequency: 1800,
    }).connect(bassCompressor);
    // ウッドは歪み無し。EQ → HighPass。
    bassHighpass = new Tone.Filter({
      frequency: 35,
      type: "highpass",
      Q: 0.7,
    }).connect(bassEq);
    bassSynth = new Tone.PolySynth(Tone.MonoSynth, {
      oscillator: {
        // 三角波 → 倍音少なめでウッドの基音感。
        type: "triangle",
      },
      filter: {
        // 共振控えめ → 鳴き要素を出さず木胴っぽく。
        Q: 1.4,
        type: "lowpass",
        rolloff: -24,
      },
      envelope: {
        // 指弾きアコースティックの「ボン」→ 短いサステイン → 自然な余韻。
        attack: 0.012,
        decay: 0.55,
        sustain: 0.2,
        release: 0.6,
      },
      filterEnvelope: {
        // フィルタは小さく開いて閉じる (高域の鳴き禁止)。
        attack: 0.004,
        decay: 0.3,
        sustain: 0.1,
        release: 0.4,
        baseFrequency: 80,
        octaves: 2.4,
      },
      volume: -4,
    });
    bassSynth.connect(bassHighpass);
  } else if (currentBassType === "synth") {
    // シンセベース — 鋸波 + 共振フィルタ + 軽い歪みでパワフルに。
    bassEq = new Tone.EQ3({
      low: 2,
      mid: 0,
      high: -6,
      lowFrequency: 200,
      highFrequency: 2500,
    }).connect(bassCompressor);
    bassDistortion = new Tone.Distortion({
      distortion: 0.22,
      oversample: "2x",
      wet: 0.55,
    }).connect(bassEq);
    bassHighpass = new Tone.Filter({
      frequency: 40,
      type: "highpass",
      Q: 0.7,
    }).connect(bassDistortion);
    bassSynth = new Tone.PolySynth(Tone.MonoSynth, {
      oscillator: {
        // 鋸波 → 倍音豊富でシンセらしいパンチ。
        type: "sawtooth",
      },
      filter: {
        Q: 3.5,
        type: "lowpass",
        rolloff: -24,
      },
      envelope: {
        attack: 0.005,
        decay: 0.3,
        sustain: 0.6,
        release: 0.7,
      },
      filterEnvelope: {
        // 大きな共振フィルタ・スウィープでシンセ感を演出。
        attack: 0.002,
        decay: 0.18,
        sustain: 0.35,
        release: 0.4,
        baseFrequency: 110,
        octaves: 4.2,
      },
      volume: -8,
    });
    bassSynth.connect(bassHighpass);
  } else {
    // スラップベース — 鋭いプラックアタック、明るい中域、白ノイズの「カン」。
    bassEq = new Tone.EQ3({
      low: 3,
      mid: 4,
      high: -4,
      lowFrequency: 180,
      highFrequency: 2800,
    }).connect(bassCompressor);
    bassDistortion = new Tone.Distortion({
      distortion: 0.18,
      oversample: "2x",
      wet: 0.4,
    }).connect(bassEq);
    bassHighpass = new Tone.Filter({
      frequency: 45,
      type: "highpass",
      Q: 0.7,
    }).connect(bassDistortion);
    bassSynth = new Tone.PolySynth(Tone.MonoSynth, {
      oscillator: {
        type: "sawtooth",
      },
      filter: {
        Q: 4.0,
        type: "lowpass",
        rolloff: -24,
      },
      envelope: {
        // 鋭いプラック → 速い decay → 短いサステイン。
        attack: 0.002,
        decay: 0.18,
        sustain: 0.25,
        release: 0.5,
      },
      filterEnvelope: {
        // ワイドかつ高速のフィルタ・スウィープで「ピヤァ」というスラップ感。
        attack: 0.001,
        decay: 0.09,
        sustain: 0.12,
        release: 0.3,
        baseFrequency: 150,
        octaves: 5.0,
      },
      volume: -6,
    });
    bassSynth.connect(bassHighpass);
    // 「カン」を作る短いノイズバースト。HPF をかけて中高域だけ残す。
    bassSlapNoiseFilter = new Tone.Filter({
      frequency: 1800,
      type: "highpass",
      Q: 0.6,
    }).connect(bassEq); // 歪みを通さず直接 EQ へ。
    bassSlapNoise = new Tone.NoiseSynth({
      noise: { type: "white" },
      envelope: { attack: 0.001, decay: 0.05, sustain: 0, release: 0.05 },
    });
    bassSlapNoise.volume.value = -10;
    bassSlapNoise.connect(bassSlapNoiseFilter);
  }
}

function triggerSlapNoise(velocity: number, time?: number): void {
  if (currentBassType !== "slap" || !bassSlapNoise) return;
  try {
    bassSlapNoise.volume.value = -10 + (clamp01(velocity) - 0.85) * 8;
    bassSlapNoise.triggerAttackRelease(0.05, time);
  } catch {
    /* 高速連打時の TimeError は無視 */
  }
}

export function bassHoldOn(midi: number, velocity = 0.85): void {
  ensureBass();
  triggerSlapNoise(velocity);
  bassSynth?.triggerAttack(midiToNoteString(midi), undefined, velocity);
}

export function bassHoldOff(midi: number): void {
  bassSynth?.triggerRelease(midiToNoteString(midi));
}

export function bassTriggerNote(
  midi: number,
  durationSec: number,
  velocity = 0.85,
  time?: number,
): void {
  ensureBass();
  triggerSlapNoise(velocity, time);
  bassSynth?.triggerAttackRelease(
    midiToNoteString(midi),
    Math.max(0.05, durationSec),
    time,
    velocity,
  );
}

/**
 * 和音を一括で鳴らす (コードパレット / 進行プリセット用)。
 * ベース層に armed しているときに使う。
 * 重低音が濁るのを避けるため、最低音だけを 1 オクターブ下げて鳴らす。
 */
export function bassChordOn(
  midiNotes: number[],
  velocity = 0.8,
  duration = 1.4,
): void {
  ensureBass();
  if (!bassSynth || midiNotes.length === 0) return;
  const sorted = [...midiNotes].sort((a, b) => a - b);
  const root = sorted[0] - 12; // ルートを 1 オクターブ下げてベースらしく
  const notes = [root, ...sorted].map(midiToNoteString);
  triggerSlapNoise(velocity);
  bassSynth.triggerAttackRelease(
    notes,
    Math.max(0.05, duration),
    undefined,
    velocity,
  );
}

export function bassReleaseAll(): void {
  bassSynth?.releaseAll();
}
