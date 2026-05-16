/**
 * 自動作曲モード — 純粋な音楽理論ベースのアルゴリズム作曲機。
 *
 * - 完全にローカル (API 通信なし)
 * - 与えられた Scale / BPM / スタイル / 小節数から
 *   コード進行・メロディ・ベース・ドラムを生成する
 * - 返り値は NoteEvent[] (startSec/durationSec が既に絶対時刻)
 *   なので、そのまま Layer.notes に流すか、リアルタイムスケジューラで
 *   1 ノートずつ書き込んでいくこともできる。
 */

import type { NoteEvent } from "../audio/recorder";
import { DRUM_HIHAT_MIDI, DRUM_KICK_MIDI, DRUM_SNARE_MIDI } from "../audio/drums";
import {
  chordVoicing,
  diatonicTriads,
  type HarmonicChord,
} from "../music/chord";
import type { Scale } from "../music/scale";
import { SCALE_INTERVALS, scaleContains } from "../music/scale";

export type ComposerStyle = "pop" | "ballad" | "rock" | "jazz";

export const COMPOSER_STYLE_LABEL_JA: Record<ComposerStyle, string> = {
  pop: "ポップ",
  ballad: "バラード",
  rock: "ロック",
  jazz: "ジャズ",
};

export interface AutoComposeOptions {
  scale: Scale;
  bpm: number;
  /** 生成する小節数 (4/4 拍子前提)。 */
  bars: number;
  style: ComposerStyle;
  /** 同じ seed なら同じ曲が生成される。省略時は時刻ベース。 */
  seed?: number;
  includeMelody?: boolean;
  includeChord?: boolean;
  includeBass?: boolean;
  includeDrums?: boolean;
}

export interface ComposedSong {
  /** 1 小節 = 1 コード (進行)。 */
  chords: HarmonicChord[];
  melodyNotes: NoteEvent[];
  chordNotes: NoteEvent[];
  bassNotes: NoteEvent[];
  drumNotes: NoteEvent[];
  totalSec: number;
  bpm: number;
  style: ComposerStyle;
}

// ---------------------------------------------------------------------------
// 乱数 (mulberry32: 再現性のあるシード付き PRNG)
// ---------------------------------------------------------------------------
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickWeighted<T>(items: T[], weights: number[], rng: () => number): T {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return items[Math.floor(rng() * items.length)];
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

// ---------------------------------------------------------------------------
// コード進行テンプレート
// 1〜7 はダイアトニックの度数 (I, ii, iii, IV, V, vi, vii°)
// ---------------------------------------------------------------------------
const PROGRESSION_TEMPLATES: Record<ComposerStyle, number[][]> = {
  pop: [
    [1, 5, 6, 4], // I-V-vi-IV (一番有名なポップ進行)
    [6, 4, 1, 5], // 小室進行
    [1, 6, 4, 5], // 50s 進行
    [4, 5, 3, 6], // 王道進行
    [1, 5, 6, 3, 4, 1, 4, 5],
  ],
  ballad: [
    [1, 3, 4, 5],
    [6, 4, 1, 5],
    [4, 5, 6, 1],
    [1, 4, 6, 5],
    [1, 5, 4, 5],
  ],
  rock: [
    [1, 4, 5, 5],
    [1, 5, 4, 4],
    [6, 4, 1, 5],
    [1, 7, 4, 1], // bVII を含む (ロック定番)
    [1, 4, 1, 5],
  ],
  jazz: [
    [2, 5, 1, 6], // ii-V-I-vi
    [1, 6, 2, 5], // I-vi-ii-V
    [3, 6, 2, 5], // iii-vi-ii-V
    [1, 4, 2, 5, 1, 6, 2, 5],
  ],
};

function buildProgression(
  scale: Scale,
  bars: number,
  style: ComposerStyle,
  rng: () => number,
): HarmonicChord[] {
  const dia = diatonicTriads(scale); // 7 chord (1..7 が dia[0..6])
  const templates = PROGRESSION_TEMPLATES[style];
  const tpl = templates[Math.floor(rng() * templates.length)];
  const out: HarmonicChord[] = [];
  for (let i = 0; i < bars; i++) {
    const deg = tpl[i % tpl.length];
    const idx = Math.max(0, Math.min(6, deg - 1));
    out.push(dia[idx]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// メロディ生成
// ---------------------------------------------------------------------------

interface RhythmSlot {
  /** 拍数 (1 = 4分音符, 0.5 = 8分音符)。 */
  beats: number;
  /** true で休符。 */
  rest: boolean;
  /** 強拍 (1拍目・3拍目など) のヒント。コード構成音を優先する。 */
  strong: boolean;
}

const RHYTHM_PATTERNS: Record<ComposerStyle, RhythmSlot[][]> = {
  pop: [
    // 8 分音符基調 (1 + 0.5*6 + 休符)
    [
      { beats: 0.5, rest: false, strong: true },
      { beats: 0.5, rest: false, strong: false },
      { beats: 0.5, rest: false, strong: false },
      { beats: 0.5, rest: true, strong: false },
      { beats: 0.5, rest: false, strong: true },
      { beats: 0.5, rest: false, strong: false },
      { beats: 0.5, rest: false, strong: false },
      { beats: 0.5, rest: false, strong: false },
    ],
    [
      { beats: 1, rest: false, strong: true },
      { beats: 0.5, rest: false, strong: false },
      { beats: 0.5, rest: false, strong: false },
      { beats: 1, rest: false, strong: true },
      { beats: 1, rest: false, strong: false },
    ],
    // 付点
    [
      { beats: 0.75, rest: false, strong: true },
      { beats: 0.25, rest: false, strong: false },
      { beats: 0.5, rest: false, strong: false },
      { beats: 0.5, rest: true, strong: false },
      { beats: 0.75, rest: false, strong: true },
      { beats: 0.25, rest: false, strong: false },
      { beats: 1, rest: false, strong: false },
    ],
  ],
  ballad: [
    [
      { beats: 1.5, rest: false, strong: true },
      { beats: 0.5, rest: false, strong: false },
      { beats: 1, rest: false, strong: true },
      { beats: 1, rest: false, strong: false },
    ],
    [
      { beats: 2, rest: false, strong: true },
      { beats: 1, rest: false, strong: false },
      { beats: 1, rest: false, strong: true },
    ],
    [
      { beats: 1, rest: false, strong: true },
      { beats: 1, rest: true, strong: false },
      { beats: 1, rest: false, strong: true },
      { beats: 1, rest: false, strong: false },
    ],
  ],
  rock: [
    // 全部 8 分音符
    [
      { beats: 0.5, rest: false, strong: true },
      { beats: 0.5, rest: false, strong: false },
      { beats: 0.5, rest: false, strong: false },
      { beats: 0.5, rest: false, strong: false },
      { beats: 0.5, rest: false, strong: true },
      { beats: 0.5, rest: false, strong: false },
      { beats: 0.5, rest: false, strong: false },
      { beats: 0.5, rest: false, strong: false },
    ],
    [
      { beats: 1, rest: false, strong: true },
      { beats: 1, rest: false, strong: false },
      { beats: 0.5, rest: false, strong: true },
      { beats: 0.5, rest: false, strong: false },
      { beats: 1, rest: false, strong: false },
    ],
  ],
  jazz: [
    // 跳ねたフィール (三連符近似: 0.67 + 0.33)
    [
      { beats: 0.67, rest: false, strong: true },
      { beats: 0.33, rest: false, strong: false },
      { beats: 0.67, rest: false, strong: false },
      { beats: 0.33, rest: false, strong: false },
      { beats: 0.67, rest: false, strong: true },
      { beats: 0.33, rest: false, strong: false },
      { beats: 0.67, rest: false, strong: false },
      { beats: 0.33, rest: false, strong: false },
    ],
    [
      { beats: 1, rest: true, strong: false },
      { beats: 0.67, rest: false, strong: false },
      { beats: 0.33, rest: false, strong: false },
      { beats: 0.67, rest: false, strong: true },
      { beats: 0.33, rest: false, strong: false },
      { beats: 1, rest: false, strong: false },
    ],
  ],
};

function scaleTonesInRange(scale: Scale, minMidi: number, maxMidi: number): number[] {
  const out: number[] = [];
  for (let m = minMidi; m <= maxMidi; m++) {
    if (scaleContains(scale, m)) out.push(m);
  }
  return out;
}

function generateMelody(
  scale: Scale,
  chords: HarmonicChord[],
  bpm: number,
  style: ComposerStyle,
  rng: () => number,
): NoteEvent[] {
  const beatSec = 60 / bpm;
  const events: NoteEvent[] = [];
  // メロディは C4(60) 〜 C6(84) のレンジに収める
  const range = scaleTonesInRange(scale, 60, 84);
  if (range.length === 0) return events;

  let prevMidi: number | null = null;
  const patterns = RHYTHM_PATTERNS[style];

  for (let bar = 0; bar < chords.length; bar++) {
    const chord = chords[bar];
    const chordTones = chordVoicing(chord, 48); // C3 ベースで構成音取得
    const chordPCs = new Set(chordTones.map((m) => m % 12));

    const slots = patterns[Math.floor(rng() * patterns.length)];
    const barStart = bar * 4 * beatSec;
    let t = barStart;

    // 4 拍ぴったりに収まるように slots の合計拍数で正規化
    const totalBeats = slots.reduce((a, s) => a + s.beats, 0);
    const beatScale = 4 / totalBeats;

    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      const slotDurSec = slot.beats * beatScale * beatSec;
      if (slot.rest) {
        t += slotDurSec;
        continue;
      }

      // 候補ピッチ: 強拍ならコード構成音、弱拍はスケール音全体
      let candidates: number[];
      if (slot.strong) {
        candidates = range.filter((m) => chordPCs.has(m % 12));
        if (candidates.length === 0) candidates = range;
      } else {
        candidates = range;
      }

      // 直前音から ±半オクターブ内を優先 (跳躍を抑える)
      let pick: number;
      if (prevMidi === null) {
        // 最初の音はコード構成音の中ほど
        const mid = candidates[Math.floor(candidates.length / 2)];
        pick = mid;
      } else {
        const weights = candidates.map((m) => {
          const d = Math.abs(m - (prevMidi as number));
          if (d === 0) return 0.4; // 同音はやや避ける
          if (d > 9) return 0.02;
          if (d > 5) return 0.15;
          if (d > 2) return 0.5;
          return 1.0;
        });
        pick = pickWeighted(candidates, weights, rng);
      }

      // フレーズ末尾 (小節最後の音) はやや長めにして安定
      const isLastInBar = i === slots.length - 1;
      const dur = Math.max(
        0.08,
        isLastInBar ? slotDurSec * 1.1 : slotDurSec * 0.92,
      );

      events.push({
        midi: pick,
        startSec: t,
        durationSec: dur,
        velocity: slot.strong ? 0.85 : 0.7,
      });
      prevMidi = pick;
      t += slotDurSec;
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// コード層 (バッキング)
// ---------------------------------------------------------------------------
function generateChordLayer(
  chords: HarmonicChord[],
  bpm: number,
  style: ComposerStyle,
): NoteEvent[] {
  const beatSec = 60 / bpm;
  const barSec = beatSec * 4;
  const out: NoteEvent[] = [];
  const baseMidi = 48; // C3

  for (let bar = 0; bar < chords.length; bar++) {
    const voicing = chordVoicing(chords[bar], baseMidi);
    const barStart = bar * barSec;

    if (style === "ballad") {
      // アルベルティ・ベース風アルペジオ
      for (let beat = 0; beat < 4; beat++) {
        const idx = beat % voicing.length;
        out.push({
          midi: voicing[idx],
          startSec: barStart + beat * beatSec,
          durationSec: beatSec * 1.4,
          velocity: 0.6,
        });
      }
    } else if (style === "jazz") {
      // 4 ビート気味のコンプ (2拍目と4拍目)
      for (const m of voicing) {
        out.push({
          midi: m,
          startSec: barStart + beatSec,
          durationSec: beatSec * 0.6,
          velocity: 0.5,
        });
        out.push({
          midi: m,
          startSec: barStart + 3 * beatSec,
          durationSec: beatSec * 0.6,
          velocity: 0.55,
        });
      }
    } else {
      // pop / rock: ブロックコード (1 小節伸ばす)
      for (const m of voicing) {
        out.push({
          midi: m,
          startSec: barStart,
          durationSec: barSec * 0.95,
          velocity: 0.6,
        });
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// ベース
// ---------------------------------------------------------------------------
function generateBass(
  chords: HarmonicChord[],
  bpm: number,
  style: ComposerStyle,
  rng: () => number,
): NoteEvent[] {
  const beatSec = 60 / bpm;
  const out: NoteEvent[] = [];
  const baseMidi = 36; // C2

  for (let bar = 0; bar < chords.length; bar++) {
    const ch = chords[bar];
    // ベースは構成音の最低音 (= ルート) を C2 オクターブで掴む
    let root = baseMidi;
    while (root % 12 !== ch.rootPitchClass) root += 1;
    if (root > 48) root -= 12;
    const fifth = root + 7;
    const octave = root + 12;
    const barStart = bar * 4 * beatSec;

    if (style === "ballad") {
      out.push({
        midi: root,
        startSec: barStart,
        durationSec: 4 * beatSec * 0.95,
        velocity: 0.75,
      });
    } else if (style === "jazz") {
      // ウォーキングベース (各拍に 1 音, 半音/全音アプローチで次小節へ)
      const next = chords[bar + 1] ?? ch;
      let nextRoot = baseMidi;
      while (nextRoot % 12 !== next.rootPitchClass) nextRoot += 1;
      if (nextRoot > 48) nextRoot -= 12;
      const approach = nextRoot + (rng() < 0.5 ? -1 : 1);
      const seq = [root, root + 4, fifth, approach];
      for (let b = 0; b < 4; b++) {
        out.push({
          midi: seq[b],
          startSec: barStart + b * beatSec,
          durationSec: beatSec * 0.85,
          velocity: 0.72,
        });
      }
    } else if (style === "rock") {
      // 8 分音符の刻み (root を連打 + 3拍目で 5th)
      for (let b = 0; b < 8; b++) {
        const isThirdBeat = b === 4;
        out.push({
          midi: isThirdBeat ? fifth : root,
          startSec: barStart + b * (beatSec / 2),
          durationSec: beatSec * 0.45,
          velocity: b % 2 === 0 ? 0.82 : 0.68,
        });
      }
    } else {
      // pop: root - oct - fifth - root (1拍ごと)
      const seq = [root, octave, fifth, root];
      for (let b = 0; b < 4; b++) {
        out.push({
          midi: seq[b],
          startSec: barStart + b * beatSec,
          durationSec: beatSec * 0.9,
          velocity: b === 0 || b === 2 ? 0.8 : 0.65,
        });
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// ドラム
// ---------------------------------------------------------------------------
function generateDrums(
  bars: number,
  bpm: number,
  style: ComposerStyle,
): NoteEvent[] {
  const beatSec = 60 / bpm;
  const out: NoteEvent[] = [];

  for (let bar = 0; bar < bars; bar++) {
    const barStart = bar * 4 * beatSec;

    if (style === "ballad") {
      // 1拍目キック / 3拍目スネア / 4分のハイハット
      out.push({ midi: DRUM_KICK_MIDI, startSec: barStart, durationSec: 0.05, velocity: 0.85 });
      out.push({ midi: DRUM_SNARE_MIDI, startSec: barStart + 2 * beatSec, durationSec: 0.05, velocity: 0.8 });
      for (let b = 0; b < 4; b++) {
        out.push({
          midi: DRUM_HIHAT_MIDI,
          startSec: barStart + b * beatSec,
          durationSec: 0.05,
          velocity: 0.55,
        });
      }
    } else if (style === "jazz") {
      // ジャズの基本: 4分のライドっぽいハイハット + 2拍目4拍目スネア (ライト)
      for (let b = 0; b < 4; b++) {
        out.push({
          midi: DRUM_HIHAT_MIDI,
          startSec: barStart + b * beatSec,
          durationSec: 0.05,
          velocity: 0.55,
        });
      }
      out.push({ midi: DRUM_SNARE_MIDI, startSec: barStart + beatSec, durationSec: 0.05, velocity: 0.5 });
      out.push({ midi: DRUM_SNARE_MIDI, startSec: barStart + 3 * beatSec, durationSec: 0.05, velocity: 0.55 });
      out.push({ midi: DRUM_KICK_MIDI, startSec: barStart, durationSec: 0.05, velocity: 0.6 });
    } else {
      // pop / rock: 8 ビート (キック=1,3 / スネア=2,4 / ハイハット=8分)
      out.push({ midi: DRUM_KICK_MIDI, startSec: barStart, durationSec: 0.05, velocity: 0.9 });
      out.push({ midi: DRUM_KICK_MIDI, startSec: barStart + 2 * beatSec, durationSec: 0.05, velocity: 0.85 });
      out.push({ midi: DRUM_SNARE_MIDI, startSec: barStart + beatSec, durationSec: 0.05, velocity: 0.85 });
      out.push({ midi: DRUM_SNARE_MIDI, startSec: barStart + 3 * beatSec, durationSec: 0.05, velocity: 0.85 });
      for (let b = 0; b < 8; b++) {
        out.push({
          midi: DRUM_HIHAT_MIDI,
          startSec: barStart + b * (beatSec / 2),
          durationSec: 0.05,
          velocity: b % 2 === 0 ? 0.7 : 0.55,
        });
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// 公開関数: 1 曲生成
// ---------------------------------------------------------------------------
export function composeSong(opts: AutoComposeOptions): ComposedSong {
  const { scale, bpm, bars, style } = opts;
  const seed = opts.seed ?? (Date.now() & 0xffffffff);
  const rng = makeRng(seed);
  // scaleContains を使うので参照だけ残す (lint 対策)
  void SCALE_INTERVALS;

  const chords = buildProgression(scale, bars, style, rng);
  const melodyNotes = (opts.includeMelody ?? true)
    ? generateMelody(scale, chords, bpm, style, rng)
    : [];
  const chordNotes = (opts.includeChord ?? true)
    ? generateChordLayer(chords, bpm, style)
    : [];
  const bassNotes = (opts.includeBass ?? true)
    ? generateBass(chords, bpm, style, rng)
    : [];
  const drumNotes = (opts.includeDrums ?? true)
    ? generateDrums(bars, bpm, style)
    : [];

  const totalSec = bars * 4 * (60 / bpm);

  // 念のため startSec でソート
  for (const arr of [melodyNotes, chordNotes, bassNotes, drumNotes]) {
    arr.sort((a, b) => a.startSec - b.startSec);
  }

  return {
    chords,
    melodyNotes,
    chordNotes,
    bassNotes,
    drumNotes,
    totalSec,
    bpm,
    style,
  };
}
