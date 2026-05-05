/**
 * Chord theory: qualities, diatonic triads, voicing.
 * Port of MelodyCatch/Shared/Theory/Diatonic.swift
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
  | "min7";

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
