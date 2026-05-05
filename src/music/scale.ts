/**
 * Scale definitions and helpers.
 * Port of MelodyCatch/Shared/Theory/Scale.swift
 */

import { SHARP_NAMES, pitchClass } from "./pitch";

export type ScaleKind =
  | "major"
  | "minor"
  | "dorian"
  | "mixolydian"
  | "pentatonicMajor"
  | "pentatonicMinor";

export const SCALE_INTERVALS: Record<ScaleKind, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  pentatonicMajor: [0, 2, 4, 7, 9],
  pentatonicMinor: [0, 3, 5, 7, 10],
};

/** English display names — matching the Swift app for parity. */
export const SCALE_DISPLAY_NAMES_EN: Record<ScaleKind, string> = {
  major: "Major",
  minor: "Minor",
  dorian: "Dorian",
  mixolydian: "Mixolydian",
  pentatonicMajor: "Pent. Major",
  pentatonicMinor: "Pent. Minor",
};

/** Japanese names (more friendly for Japanese-speaking users). */
export const SCALE_DISPLAY_NAMES_JA: Record<ScaleKind, string> = {
  major: "メジャー",
  minor: "マイナー",
  dorian: "ドリアン",
  mixolydian: "ミクソリディアン",
  pentatonicMajor: "ペンタトニック(明)",
  pentatonicMinor: "ペンタトニック(暗)",
};

/** Short hint describing the mood of each scale. */
export const SCALE_MOOD_JA: Record<ScaleKind, string> = {
  major: "明るく華やか",
  minor: "切なく感情的",
  dorian: "落ち着いた・ジャズ寄り",
  mixolydian: "明るいけど少し渋い",
  pentatonicMajor: "明るい・素朴",
  pentatonicMinor: "ブルース・哀愁",
};

export const ALL_SCALE_KINDS: ScaleKind[] = [
  "major",
  "minor",
  "dorian",
  "mixolydian",
  "pentatonicMajor",
  "pentatonicMinor",
];

export interface Scale {
  rootPitchClass: number; // 0..11
  kind: ScaleKind;
}

export function makeScale(rootPitchClass: number, kind: ScaleKind): Scale {
  return { rootPitchClass: pitchClass(rootPitchClass), kind };
}

export const C_MAJOR: Scale = makeScale(0, "major");
export const A_MINOR: Scale = makeScale(9, "minor");

export function scaleRootName(scale: Scale): string {
  return SHARP_NAMES[scale.rootPitchClass];
}

export function scaleDisplayName(scale: Scale, lang: "ja" | "en" = "ja"): string {
  const names = lang === "ja" ? SCALE_DISPLAY_NAMES_JA : SCALE_DISPLAY_NAMES_EN;
  return `${scaleRootName(scale)} ${names[scale.kind]}`;
}

/** Find the scale root pitch at-or-above a given MIDI value. */
export function nearestRootAtOrAbove(scale: Scale, midi: number): number {
  let candidate = midi;
  while (pitchClass(candidate) !== scale.rootPitchClass) candidate += 1;
  return candidate;
}

/** Returns MIDI note numbers for one octave of the scale starting at octaveBase. */
export function scaleMidiNotes(scale: Scale, octaveBase: number): number[] {
  const root = nearestRootAtOrAbove(scale, octaveBase);
  return SCALE_INTERVALS[scale.kind].map((iv) => root + iv);
}

/** True if the MIDI note belongs to the scale (any octave). */
export function scaleContains(scale: Scale, midi: number): boolean {
  const rel = ((midi - scale.rootPitchClass) % 12 + 12) % 12;
  return SCALE_INTERVALS[scale.kind].includes(rel);
}
