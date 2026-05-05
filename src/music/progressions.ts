/**
 * Common chord progression templates, expressed as arrays of scale-degree
 * indices (0-based). Index 0 = I (or i), 4 = V, 5 = vi, etc.
 */

import type { Scale } from "./scale";
import type { HarmonicChord } from "./chord";
import { diatonicTriads } from "./chord";

export interface ProgressionTemplate {
  id: string;
  /** Japanese display label. */
  name: string;
  /** Mood / use-case hint. */
  mood: string;
  /** 0-based diatonic degree indices. */
  degrees: number[];
  /** Roman-numeral preview (for the *major* parent). */
  romanLabel: string;
}

export const MAJOR_PROGRESSIONS: ProgressionTemplate[] = [
  {
    id: "I-V-vi-IV",
    name: "王道進行",
    mood: "明るい・J-POP定番",
    degrees: [0, 4, 5, 3],
    romanLabel: "I – V – vi – IV",
  },
  {
    id: "vi-IV-V-I-komuro",
    name: "小室進行",
    mood: "90年代J-POPの王様",
    degrees: [5, 3, 4, 0],
    romanLabel: "vi – IV – V – I",
  },
  {
    id: "IV-III-vi-I-marunouchi",
    name: "丸の内進行",
    mood: "おしゃれ・シティポップ",
    degrees: [3, 2, 5, 0],
    romanLabel: "IV – III – vi – I",
  },
  {
    id: "canon",
    name: "カノン進行",
    mood: "感動的・卒業ソング",
    degrees: [0, 4, 5, 2, 3, 0, 3, 4],
    romanLabel: "I – V – vi – iii – IV – I – IV – V",
  },
  {
    id: "IV-V-iii-vi",
    name: "J-POP王道(4536)",
    mood: "切なくて熱い",
    degrees: [3, 4, 2, 5],
    romanLabel: "IV – V – iii – vi",
  },
  {
    id: "vi-IV-I-V",
    name: "感動系",
    mood: "壮大・サビ前",
    degrees: [5, 3, 0, 4],
    romanLabel: "vi – IV – I – V",
  },
  {
    id: "I-vi-ii-V",
    name: "Stand By Me",
    mood: "レトロ・ハートフル",
    degrees: [0, 5, 1, 4],
    romanLabel: "I – vi – ii – V",
  },
  {
    id: "I-vi-IV-V",
    name: "50sドゥーワップ",
    mood: "懐かしい・ノスタルジック",
    degrees: [0, 5, 3, 4],
    romanLabel: "I – vi – IV – V",
  },
  {
    id: "ii-V-I",
    name: "ジャズ ツーファイブワン",
    mood: "おしゃれ・大人",
    degrees: [1, 4, 0],
    romanLabel: "ii – V – I",
  },
  {
    id: "I-IV-V-V",
    name: "クラシック進行",
    mood: "シンプル・まっすぐ",
    degrees: [0, 3, 4, 4],
    romanLabel: "I – IV – V – V",
  },
  {
    id: "I-IV-V-vi",
    name: "アメリカンロック",
    mood: "明るく勢い",
    degrees: [0, 3, 4, 5],
    romanLabel: "I – IV – V – vi",
  },
];

export const MINOR_PROGRESSIONS: ProgressionTemplate[] = [
  {
    id: "i-VI-III-VII",
    name: "壮大系",
    mood: "シネマティック・劇的",
    degrees: [0, 5, 2, 6],
    romanLabel: "i – VI – III – VII",
  },
  {
    id: "i-iv-v-i",
    name: "マイナー基本",
    mood: "正統派・暗い",
    degrees: [0, 3, 4, 0],
    romanLabel: "i – iv – v – i",
  },
  {
    id: "i-VII-VI-V",
    name: "下降系",
    mood: "切ない・ロック",
    degrees: [0, 6, 5, 4],
    romanLabel: "i – VII – VI – V",
  },
  {
    id: "i-VI-VII-i",
    name: "アンドラスティック",
    mood: "幻想的",
    degrees: [0, 5, 6, 0],
    romanLabel: "i – VI – VII – i",
  },
  {
    id: "iv-v-III-VI-minor",
    name: "マイナー4536",
    mood: "切ないJ-POP",
    degrees: [3, 4, 2, 5],
    romanLabel: "iv – v – III – VI",
  },
  {
    id: "VI-VII-i-heroic",
    name: "ヒロイック上昇",
    mood: "勝利・ファンタジー",
    degrees: [5, 6, 0],
    romanLabel: "VI – VII – i",
  },
  {
    id: "i-VI-iv-v-minor",
    name: "マイナー1645",
    mood: "ロックバラード",
    degrees: [0, 5, 3, 4],
    romanLabel: "i – VI – iv – v",
  },
  {
    id: "i-iv-VII-III",
    name: "シネマティック",
    mood: "ハリポタ風・神秘的",
    degrees: [0, 3, 6, 2],
    romanLabel: "i – iv – VII – III",
  },
  {
    id: "i-III-iv-VII-amb",
    name: "アンビエント",
    mood: "浮遊感・幻想",
    degrees: [0, 2, 3, 6],
    romanLabel: "i – III – iv – VII",
  },
];

export function progressionsFor(scale: Scale): ProgressionTemplate[] {
  const isMinor = scale.kind === "minor" || scale.kind === "dorian" || scale.kind === "pentatonicMinor";
  return isMinor ? MINOR_PROGRESSIONS : MAJOR_PROGRESSIONS;
}

/** Resolve a template into actual chords for the given scale. */
export function resolveProgression(
  scale: Scale,
  template: ProgressionTemplate,
): HarmonicChord[] {
  const triads = diatonicTriads(scale);
  return template.degrees.map((d) => triads[d % triads.length]);
}
