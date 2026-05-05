/**
 * MIDI pitch helpers. Middle C = 60.
 * Port of MelodyCatch/Shared/Theory/Pitch.swift
 */

export const MIDDLE_C = 60;

export const SHARP_NAMES = [
  "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
] as const;

export const FLAT_NAMES = [
  "C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B",
] as const;

/** Japanese display names for pitch classes (kept short, optional helper). */
export const PITCH_LABELS_JA = [
  "ド", "ド#", "レ", "レ#", "ミ", "ファ", "ファ#", "ソ", "ソ#", "ラ", "ラ#", "シ",
] as const;

const BLACK_KEY_PITCH_CLASSES = new Set([1, 3, 6, 8, 10]);

/** Pitch class of a MIDI note (0..11). */
export function pitchClass(midi: number): number {
  return ((midi % 12) + 12) % 12;
}

/** Octave number for a MIDI note (Middle C = C4). */
export function octaveOf(midi: number): number {
  return Math.floor(midi / 12) - 1;
}

/** "C4", "F#3" etc. */
export function noteName(midi: number, preferFlats = false): string {
  const table = preferFlats ? FLAT_NAMES : SHARP_NAMES;
  return `${table[pitchClass(midi)]}${octaveOf(midi)}`;
}

/** True if the MIDI note maps to a black key on the piano. */
export function isBlackKey(midi: number): boolean {
  return BLACK_KEY_PITCH_CLASSES.has(pitchClass(midi));
}

/** Convert MIDI to Tone.js note string (e.g. 60 -> "C4"). */
export function midiToNoteString(midi: number): string {
  return noteName(midi, false);
}
