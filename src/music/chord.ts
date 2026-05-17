/**
 * Chord theory: qualities, diatonic triads, voicing.
 * Port of MelodyCatch/Shared/Theory/Diatonic.swift, extended.
 *
 * 拡張系コード:
 *   - 7th 系: dom7 / maj7 / min7 / m7b5 (ハーフディミニッシュ) / dim7
 *   - サス系: sus2 / sus4 / 7sus4
 *   - add 系: add9 / add2 (= add9 の別表記)
 *   - 6th: maj6 / min6
 *   - 9th: maj9 / dom9 / min9
 *   - augmented dominant: 7#5
 */

import { SHARP_NAMES, pitchClass } from "./pitch";
import type { Scale } from "./scale";
import { SCALE_INTERVALS } from "./scale";

export type ChordQuality =
  | "major"
  | "minor"
  | "diminished"
  | "augmented"
  | "sus2"
  | "sus4"
  | "dom7"
  | "maj7"
  | "min7"
  | "m7b5"
  | "dim7"
  | "dom7sus4"
  | "add9"
  | "minAdd9"
  | "maj6"
  | "min6"
  | "maj9"
  | "min9"
  | "dom9"
  | "dom7sharp5";

/** Symbol shown after the root letter (e.g. "m", "°"). */
export const CHORD_QUALITY_SYMBOL: Record<ChordQuality, string> = {
  major: "",
  minor: "m",
  diminished: "°",
  augmented: "+",
  sus2: "sus2",
  sus4: "sus4",
  dom7: "7",
  maj7: "maj7",
  min7: "m7",
  m7b5: "m7♭5",
  dim7: "°7",
  dom7sus4: "7sus4",
  add9: "add9",
  minAdd9: "m(add9)",
  maj6: "6",
  min6: "m6",
  maj9: "maj9",
  min9: "m9",
  dom9: "9",
  dom7sharp5: "7♯5",
};

/** Friendly Japanese label shown alongside the symbol. */
export const CHORD_QUALITY_LABEL_JA: Record<ChordQuality, string> = {
  major: "メジャー",
  minor: "マイナー",
  diminished: "ディム(減)",
  augmented: "オーグ(増)",
  sus2: "サス2",
  sus4: "サス4",
  dom7: "セブンス",
  maj7: "メジャー7",
  min7: "マイナー7",
  m7b5: "ハーフディム",
  dim7: "ディム7",
  dom7sus4: "7サス4",
  add9: "アド9",
  minAdd9: "マイナーアド9",
  maj6: "シックス",
  min6: "マイナーシックス",
  maj9: "メジャー9",
  min9: "マイナー9",
  dom9: "ナインス",
  dom7sharp5: "オーグ7",
};

/** Short mood description used as a hint. */
export const CHORD_QUALITY_MOOD_JA: Record<ChordQuality, string> = {
  major: "明るい",
  minor: "暗い",
  diminished: "不安・緊張",
  augmented: "浮遊感",
  sus2: "宙吊り(透明)",
  sus4: "宙吊り(力強い)",
  dom7: "解決を予感させる",
  maj7: "おしゃれ・夢見心地",
  min7: "切ない・ジャジー",
  m7b5: "ジャズの ii (薄暗い)",
  dim7: "サスペンス・経過",
  dom7sus4: "解決前のため息",
  add9: "キラキラ・浮遊感",
  minAdd9: "切ない・透明",
  maj6: "懐かしさ・甘い",
  min6: "クールでお洒落",
  maj9: "幻想的・上品",
  min9: "ネオソウル・濃い情緒",
  dom9: "ファンキー・厚み",
  dom7sharp5: "緊張・ジャズ的",
};

/** Semitone offsets from the root. */
export const CHORD_INTERVALS: Record<ChordQuality, number[]> = {
  major: [0, 4, 7],
  minor: [0, 3, 7],
  diminished: [0, 3, 6],
  augmented: [0, 4, 8],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  dom7: [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  min7: [0, 3, 7, 10],
  m7b5: [0, 3, 6, 10],
  dim7: [0, 3, 6, 9],
  dom7sus4: [0, 5, 7, 10],
  add9: [0, 4, 7, 14],
  minAdd9: [0, 3, 7, 14],
  maj6: [0, 4, 7, 9],
  min6: [0, 3, 7, 9],
  maj9: [0, 4, 7, 11, 14],
  min9: [0, 3, 7, 10, 14],
  dom9: [0, 4, 7, 10, 14],
  dom7sharp5: [0, 4, 8, 10],
};

export interface HarmonicChord {
  rootPitchClass: number; // 0..11
  quality: ChordQuality;
  /** Roman numeral label, e.g. "I", "vi", "vii°". Optional. */
  roman?: string;
}

export function makeChord(
  rootPitchClass: number,
  quality: ChordQuality,
  roman?: string,
): HarmonicChord {
  return { rootPitchClass: pitchClass(rootPitchClass), quality, roman };
}

/** "C", "Am", "B°" style label. */
export function chordSymbol(chord: HarmonicChord): string {
  return `${SHARP_NAMES[chord.rootPitchClass]}${CHORD_QUALITY_SYMBOL[chord.quality]}`;
}

/** "Cメジャー(明るい)" style longer label. */
export function chordLabelJa(chord: HarmonicChord): string {
  return `${SHARP_NAMES[chord.rootPitchClass]}${CHORD_QUALITY_LABEL_JA[chord.quality]}`;
}

/** Voiced MIDI notes for the chord, root at-or-above the given bass MIDI. */
export function chordVoicing(chord: HarmonicChord, bassMidi = 48): number[] {
  let root = bassMidi;
  while (pitchClass(root) !== chord.rootPitchClass) root += 1;
  return CHORD_INTERVALS[chord.quality].map((iv) => root + iv);
}

// ---------------------------------------------------------------------------
// Diatonic triads for a scale
// ---------------------------------------------------------------------------

const MAJOR_ROMANS = ["I", "ii", "iii", "IV", "V", "vi", "vii°"];
const MINOR_ROMANS = ["i", "ii°", "III", "iv", "v", "VI", "VII"];

const MAJOR_QUALITIES: ChordQuality[] = [
  "major", "minor", "minor", "major", "major", "minor", "diminished",
];
const MINOR_QUALITIES: ChordQuality[] = [
  "minor", "diminished", "major", "minor", "minor", "major", "major",
];

/**
 * Seven diatonic triads for the given scale.
 * Pentatonic scales fall back to their major/minor parent.
 */
export function diatonicTriads(scale: Scale): HarmonicChord[] {
  const intervals = SCALE_INTERVALS[scale.kind];
  if (intervals.length < 7) {
    const fallbackKind = scale.kind === "pentatonicMinor" ? "minor" : "major";
    return diatonicTriads({ rootPitchClass: scale.rootPitchClass, kind: fallbackKind });
  }
  const useMinor = scale.kind === "minor" || scale.kind === "dorian";
  const qualities = useMinor ? MINOR_QUALITIES : MAJOR_QUALITIES;
  const romans = useMinor ? MINOR_ROMANS : MAJOR_ROMANS;
  return Array.from({ length: 7 }, (_, i) => {
    const root = (scale.rootPitchClass + intervals[i]) % 12;
    return makeChord(root, qualities[i], romans[i]);
  });
}

/**
 * 同じスケール度数で「拡張された」コードに置き換える。
 * 例: major → maj7 / add9 / maj6 / maj9
 *     minor → min7 / minAdd9 / min6 / min9
 *     dom (V) → dom7 / dom9 / dom7sus4 / dom7sharp5
 *     diminished → m7b5 / dim7
 *
 * 自動作曲モードで「同じ進行でも豪華に響く」「単調にならない」ようにするため、
 * 元の度数 (I/ii/V など) のロマン数字を保ったまま品質だけ拡張する。
 */
export function withQuality(chord: HarmonicChord, quality: ChordQuality): HarmonicChord {
  return { ...chord, quality };
}

/**
 * 元のトライアドに対応する拡張バリエーション。
 * V (dominant) は dom7 系を、それ以外の major は maj7/add9/maj6/maj9 を、
 * minor は min7/minAdd9/min6/min9 を、ハーフ・ディムは m7b5 を返す。
 *
 * romanIndex は 0-indexed の度数 (0=I, 4=V, ...) で、V 専用の dom 拡張に使う。
 */
export function richVariants(
  chord: HarmonicChord,
  romanIndex: number,
): ChordQuality[] {
  switch (chord.quality) {
    case "major":
      // 5 度 (V) ならドミナント拡張、それ以外はメジャー系
      if (romanIndex === 4) {
        return ["major", "dom7", "dom9", "dom7sus4"];
      }
      return ["major", "maj7", "add9", "maj6", "maj9", "sus4", "sus2"];
    case "minor":
      return ["minor", "min7", "minAdd9", "min6", "min9"];
    case "diminished":
      return ["diminished", "m7b5", "dim7"];
    case "augmented":
      return ["augmented", "dom7sharp5"];
    default:
      return [chord.quality];
  }
}

/**
 * 一群の MIDI 音 (同時に鳴っている音、または同小節内の音) から
 * 一番ありそうな HarmonicChord を推定する。
 * Chord 層の手書き入力 / コードパレット選択を自動作曲のコード進行に流し込む際に使う。
 *
 * - 最低音をルート候補として優先。
 * - 各候補ルートについて、相対インターバル集合を CHORD_INTERVALS と比較して一致度を採点。
 * - 該当なしなら null。
 */
export function detectChordFromMidis(midis: number[]): HarmonicChord | null {
  if (midis.length === 0) return null;
  const pcSet = new Set(midis.map((m) => pitchClass(m)));
  if (pcSet.size === 0) return null;
  const sorted = [...midis].sort((a, b) => a - b);
  const lowestPc = pitchClass(sorted[0]);

  const qualities = Object.keys(CHORD_INTERVALS) as ChordQuality[];

  let best: { root: number; quality: ChordQuality; score: number } | null = null;
  // 候補ルート: ピッチクラス集合の各要素を試す (最低音優先)
  const rootCandidates: number[] = [lowestPc];
  for (const pc of pcSet) {
    if (!rootCandidates.includes(pc)) rootCandidates.push(pc);
  }
  for (const root of rootCandidates) {
    for (const q of qualities) {
      const ivs = CHORD_INTERVALS[q];
      let hit = 0;
      for (const iv of ivs) {
        const need = (root + iv) % 12;
        if (pcSet.has(need)) hit++;
      }
      // 余分な音 (コードトーン外) があると減点
      const extra = pcSet.size - hit;
      let score = hit * 3 - extra;
      // 最低音 = ルートなら大きく加点
      if (root === lowestPc) score += 2;
      // インターバル数が多い (= 拡張和音) はわずかに加点 (より具体的なマッチを優先)
      score += ivs.length * 0.1;
      // 全構成音そろってる場合のみ採用候補に
      if (hit < Math.min(3, ivs.length)) continue;
      if (!best || score > best.score) {
        best = { root, quality: q, score };
      }
    }
  }
  if (!best) {
    // 1〜2 音しかなくて判定不能 → 単音をルートのメジャー扱い
    return { rootPitchClass: lowestPc, quality: "major" };
  }
  return { rootPitchClass: best.root, quality: best.quality };
}
