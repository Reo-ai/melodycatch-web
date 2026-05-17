/**
 * テーマ自由記入欄 → 作曲設定 (style / bpm / scale) の推論。
 *
 * ユーザーが日本語フリーテキストで「悲しい雨の夜」とか「夏のお祭り」とか入れると、
 * キーワード辞書を引いて style / bpm / ScaleKind / 推奨ルート音 を提案する。
 * AI API を呼ばない完全ローカル実装。
 *
 * 戦略:
 *  - 各キーワードは「重み付き提案 (weighted suggestion)」を返す。
 *  - 入力文字列に含まれるキーワード分だけ提案を集めて、
 *    各軸 (style / scaleKind / bpm / rootPc) で多数決 + 平均する。
 *  - 1 件もマッチしなければ提案なし (現在の設定を維持) を返す。
 */

import type { ComposerStyle } from "./autoComposer";
import type { ScaleKind } from "../music/scale";

export interface ThemeSuggestion {
  style?: ComposerStyle;
  scaleKind?: ScaleKind;
  bpm?: number;
  rootPitchClass?: number; // 0..11 (C=0). 省略時は変更しない。
  /** 任意のキーワード → スタイルへの寄与 (-1 .. +1)。集計用 */
  notes?: string;
}

interface KeywordEntry {
  /** ユーザー入力文字列に含まれるとマッチする部分文字列 (大文字小文字は無視) */
  keywords: string[];
  styleWeights?: Partial<Record<ComposerStyle, number>>;
  scaleWeights?: Partial<Record<ScaleKind, number>>;
  /** bpm 提案 (平均にこの値が加算される) */
  bpm?: number;
  /** ルート音提案 (例: メジャー基調なら C(0), 暗いなら A(9)) */
  rootPc?: number;
  note?: string;
}

// ---------------------------------------------------------------------------
// キーワード辞書 — 感情 / 季節 / 場面 / シーン / 楽器
// ---------------------------------------------------------------------------
const ENTRIES: KeywordEntry[] = [
  // === 感情 (暗い / 切ない) ===
  {
    keywords: ["悲しい", "悲", "泣", "涙", "切な", "せつな", "失恋", "別れ", "孤独", "寂し"],
    styleWeights: { ballad: 0.9, pop: 0.2 },
    scaleWeights: { minor: 1.0, pentatonicMinor: 0.6 },
    bpm: 70,
    rootPc: 9, // Am
    note: "悲しい/切ない → バラード + マイナー",
  },
  {
    keywords: ["雨", "あめ", "霧", "曇", "夜", "暗", "静か", "しんみり"],
    styleWeights: { ballad: 0.6, jazz: 0.3 },
    scaleWeights: { minor: 0.7, dorian: 0.4 },
    bpm: 75,
    rootPc: 9,
    note: "雨/夜 → 静かで暗め",
  },
  {
    keywords: ["憂鬱", "ゆううつ", "不安", "怒り", "苦しい", "つらい", "辛い"],
    styleWeights: { rock: 0.7, ballad: 0.4 },
    scaleWeights: { minor: 0.9, pentatonicMinor: 0.7 },
    bpm: 90,
    rootPc: 9,
  },

  // === 感情 (明るい / 元気) ===
  {
    keywords: ["楽しい", "嬉しい", "うれし", "幸せ", "ハッピー", "happy", "笑顔", "ワクワク", "わくわく"],
    styleWeights: { pop: 1.0, rock: 0.4 },
    scaleWeights: { major: 1.0, pentatonicMajor: 0.6 },
    bpm: 128,
    rootPc: 0, // C
    note: "楽しい → ポップ + メジャー",
  },
  {
    keywords: ["元気", "応援", "ガンバ", "がんば", "頑張", "勇気", "希望", "走る", "全力"],
    styleWeights: { rock: 0.8, pop: 0.6 },
    scaleWeights: { major: 0.8, mixolydian: 0.4 },
    bpm: 140,
    rootPc: 4, // E (or G)
  },
  {
    keywords: ["かっこいい", "クール", "cool", "シリアス", "決意", "戦", "戦う", "バトル"],
    styleWeights: { rock: 1.0 },
    scaleWeights: { minor: 0.8, dorian: 0.4 },
    bpm: 130,
    rootPc: 9,
  },

  // === 季節 ===
  {
    keywords: ["春", "桜", "さくら", "新生活", "卒業", "出会い"],
    styleWeights: { pop: 0.8, ballad: 0.4 },
    scaleWeights: { major: 0.7, pentatonicMajor: 0.5 },
    bpm: 110,
    rootPc: 2, // D
    note: "春 → 爽やかなポップ",
  },
  {
    keywords: ["夏", "海", "祭り", "花火", "太陽", "ビーチ", "サマー"],
    styleWeights: { pop: 1.0, rock: 0.5 },
    scaleWeights: { major: 0.9, mixolydian: 0.5 },
    bpm: 130,
    rootPc: 0,
    note: "夏 → アップテンポでメジャー",
  },
  {
    keywords: ["秋", "紅葉", "落葉", "落ち葉", "夕暮れ", "ノスタル"],
    styleWeights: { ballad: 0.7, jazz: 0.5 },
    scaleWeights: { minor: 0.5, dorian: 0.7 },
    bpm: 85,
    rootPc: 9,
    note: "秋 → ノスタルジック",
  },
  {
    keywords: ["冬", "雪", "クリスマス", "聖夜", "ホワイト"],
    styleWeights: { ballad: 0.8, pop: 0.3 },
    scaleWeights: { major: 0.5, minor: 0.4 },
    bpm: 80,
    rootPc: 7, // G (定番)
  },

  // === シーン / 場所 ===
  {
    keywords: ["都会", "ネオン", "シティ", "city", "夜景"],
    styleWeights: { jazz: 0.7, pop: 0.5 },
    scaleWeights: { dorian: 0.7, minor: 0.5 },
    bpm: 100,
    rootPc: 5, // F
  },
  {
    keywords: ["カフェ", "コーヒー", "おしゃれ", "落ち着", "リラックス", "ラウンジ", "lounge"],
    styleWeights: { jazz: 1.0, ballad: 0.4 },
    scaleWeights: { dorian: 0.8, major: 0.4 },
    bpm: 90,
    rootPc: 5,
  },
  {
    keywords: ["教会", "聖", "祈", "神聖", "厳か"],
    styleWeights: { ballad: 0.7 },
    scaleWeights: { major: 0.5, minor: 0.5 },
    bpm: 65,
    rootPc: 7,
  },
  {
    keywords: ["ライブ", "ステージ", "ロック", "rock", "メタル", "パンク", "punk"],
    styleWeights: { rock: 1.2 },
    scaleWeights: { minor: 0.7, pentatonicMinor: 0.8 },
    bpm: 145,
    rootPc: 4,
  },
  {
    keywords: ["ジャズ", "jazz", "swing", "スウィング", "ボサ", "bossa"],
    styleWeights: { jazz: 1.2 },
    scaleWeights: { dorian: 0.9, mixolydian: 0.5 },
    bpm: 110,
    rootPc: 5,
  },
  {
    keywords: ["バラード", "ballad", "ラブソング", "love"],
    styleWeights: { ballad: 1.2 },
    scaleWeights: { major: 0.6, minor: 0.4 },
    bpm: 70,
    rootPc: 7,
  },
  {
    keywords: ["ポップ", "pop", "ポップス", "j-pop", "アイドル"],
    styleWeights: { pop: 1.2 },
    scaleWeights: { major: 0.9, pentatonicMajor: 0.5 },
    bpm: 122,
    rootPc: 0,
  },

  // === 速度修飾語 ===
  {
    keywords: ["スロー", "ゆっくり", "slow", "ゆった", "穏やか"],
    bpm: 65,
  },
  {
    keywords: ["速", "ファスト", "fast", "アップテンポ", "急", "疾走", "高速"],
    bpm: 150,
  },
  {
    keywords: ["ミドル", "中くらい", "普通", "ふつう"],
    bpm: 100,
  },
];

// ---------------------------------------------------------------------------
// 推論本体
// ---------------------------------------------------------------------------

const STYLES: ComposerStyle[] = ["pop", "ballad", "rock", "jazz"];
const SCALES: ScaleKind[] = [
  "major",
  "minor",
  "dorian",
  "mixolydian",
  "pentatonicMajor",
  "pentatonicMinor",
];

export interface ThemeInferResult {
  suggestion: ThemeSuggestion;
  /** マッチしたエントリの説明 (UI 表示用) */
  matchedNotes: string[];
  /** マッチしたキーワード数 */
  matchCount: number;
}

/**
 * 自由記入文 → 作曲設定 提案。
 * 1 件もマッチしなければ suggestion は空オブジェクト。
 */
export function inferFromTheme(text: string): ThemeInferResult {
  const lower = text.toLowerCase();
  const styleScore: Record<ComposerStyle, number> = { pop: 0, ballad: 0, rock: 0, jazz: 0 };
  const scaleScore: Record<ScaleKind, number> = {
    major: 0, minor: 0, dorian: 0, mixolydian: 0,
    pentatonicMajor: 0, pentatonicMinor: 0,
  };
  let bpmSum = 0;
  let bpmCount = 0;
  let rootPcSum = 0;
  let rootPcCount = 0;
  const matchedNotes: string[] = [];
  let matchCount = 0;

  for (const entry of ENTRIES) {
    let hit = false;
    for (const kw of entry.keywords) {
      if (lower.includes(kw.toLowerCase())) {
        hit = true;
        matchCount++;
      }
    }
    if (!hit) continue;
    if (entry.note) matchedNotes.push(entry.note);
    if (entry.styleWeights) {
      for (const s of STYLES) {
        const w = entry.styleWeights[s];
        if (w) styleScore[s] += w;
      }
    }
    if (entry.scaleWeights) {
      for (const k of SCALES) {
        const w = entry.scaleWeights[k];
        if (w) scaleScore[k] += w;
      }
    }
    if (entry.bpm !== undefined) {
      bpmSum += entry.bpm;
      bpmCount++;
    }
    if (entry.rootPc !== undefined) {
      rootPcSum += entry.rootPc;
      rootPcCount++;
    }
  }

  const suggestion: ThemeSuggestion = {};

  // style: 最大スコアが 0 より大きければ採用
  let bestStyle: ComposerStyle | null = null;
  let bestStyleScore = 0;
  for (const s of STYLES) {
    if (styleScore[s] > bestStyleScore) {
      bestStyleScore = styleScore[s];
      bestStyle = s;
    }
  }
  if (bestStyle && bestStyleScore > 0) suggestion.style = bestStyle;

  // scaleKind: 最大スコアが 0 より大きければ採用
  let bestScale: ScaleKind | null = null;
  let bestScaleScore = 0;
  for (const k of SCALES) {
    if (scaleScore[k] > bestScaleScore) {
      bestScaleScore = scaleScore[k];
      bestScale = k;
    }
  }
  if (bestScale && bestScaleScore > 0) suggestion.scaleKind = bestScale;

  // bpm: 平均、40..200 に丸める
  if (bpmCount > 0) {
    const avg = Math.round(bpmSum / bpmCount);
    suggestion.bpm = Math.max(40, Math.min(200, avg));
  }

  // rootPitchClass: 平均、0..11 に丸める
  if (rootPcCount > 0) {
    suggestion.rootPitchClass = Math.round(rootPcSum / rootPcCount) % 12;
  }

  return { suggestion, matchedNotes, matchCount };
}
