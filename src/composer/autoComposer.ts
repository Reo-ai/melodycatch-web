/**
 * 自動作曲モード — 純粋な音楽理論ベースのアルゴリズム作曲機 (v2)。
 *
 * v1 からの主な変更:
 *
 * 1) **曲構造 (Song Sections)**
 *    Intro / Verse-A / Pre-Chorus / Chorus / Verse-B / Bridge / Outro を
 *    指定小節数から自動的に組み立て、セクションごとに
 *      - リズムの密度
 *      - ベロシティ (= ダイナミクス、侘び寂び)
 *      - 使うコード拡張の派手さ
 *      - ドラムパターン
 *    を変える。
 *
 * 2) **コード拡張**
 *    diatonicTriads は I/ii/iii/IV/V/vi/vii° のトライアドを返すが、
 *    セクションとスタイルに応じて maj7 / add9 / dom7 / dom9 / sus2 / sus4 /
 *    m7 / minAdd9 / m6 / m7♭5 / 9 / 7sus4 / 7#5 などにランダムに置換する。
 *    Chorus は派手 (9th/maj7)、Verse は控えめ (triad + 軽い sus)、
 *    Bridge は変化球 (sus / 7sus4 / 7#5)。
 *
 * 3) **ドラムの面白み**
 *    - フルキット (kick/snare/hat 閉/hat 開/crash/ride/3 toms/clap/rim) を使う
 *    - セクション頭で crash + キック
 *    - Chorus 中は ride に切り替え、ハットを開閉ミックス
 *    - 各セクション最終小節でフィル (タムやスネア連打)
 *    - スネアにゴーストノート、キックに 16 分のシンコペーション
 *
 * 4) **メロディの呼応 / フレージング**
 *    - 2 小節 1 フレーズで「上行 → 解決」の弧を描く
 *    - フレーズ末尾は長音 + コードトーン (安定)
 *    - フレーズ間に休符を必ず入れて呼吸を作る
 *    - セクションごとに音域を上下させる (Chorus は高め, Verse は中低)
 *
 * 5) **ベースの追い込み**
 *    - 1 拍目はルート、3 拍目はオクターブや 5th
 *    - 小節末でアプローチノート (半音 / 全音) で次コードへ
 *    - Chorus は 8 分刻み、Verse は静か、Bridge は跳ねる
 */

import type { NoteEvent } from "../audio/recorder";
import {
  DRUM_CLAP_MIDI,
  DRUM_CRASH_MIDI,
  DRUM_HIHAT_MIDI,
  DRUM_HIHAT_OPEN_MIDI,
  DRUM_KICK_MIDI,
  DRUM_RIDE_MIDI,
  DRUM_RIM_MIDI,
  DRUM_SNARE_MIDI,
  DRUM_TOM_HI_MIDI,
  DRUM_TOM_LO_MIDI,
  DRUM_TOM_MID_MIDI,
} from "../audio/drums";
import {
  chordVoicing,
  diatonicTriads,
  richVariants,
  withQuality,
  type ChordQuality,
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

export type SectionKind =
  | "intro"
  | "verse"
  | "preChorus"
  | "chorus"
  | "bridge"
  | "outro";

export interface SongSection {
  kind: SectionKind;
  startBar: number; // inclusive
  endBar: number;   // exclusive
  /** このセクションの平均ダイナミクス (0..1)。 */
  intensity: number;
}

export interface ComposedSong {
  /** 1 小節 = 1 コード (進行)。 */
  chords: HarmonicChord[];
  sections: SongSection[];
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

function pick<T>(arr: T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length)];
}

// ---------------------------------------------------------------------------
// 曲構造 (Song Sections)
// ---------------------------------------------------------------------------

/**
 * 与えられた合計小節数を Intro / Verse / Pre-Chorus / Chorus / Bridge / Outro
 * に分配する。長さに応じて構成を変える。
 */
function planSections(bars: number, style: ComposerStyle, rng: () => number): SongSection[] {
  // intensity は侘び寂びを作るための基準ダイナミクス (0..1)
  const intensityOf: Record<SectionKind, number> = {
    intro: 0.45,
    verse: 0.55,
    preChorus: 0.7,
    chorus: 0.92,
    bridge: 0.6,
    outro: 0.4,
  };

  const sections: SongSection[] = [];
  let cur = 0;
  const push = (kind: SectionKind, len: number) => {
    if (len <= 0) return;
    const end = Math.min(bars, cur + len);
    sections.push({
      kind,
      startBar: cur,
      endBar: end,
      intensity: intensityOf[kind] + (rng() - 0.5) * 0.08,
    });
    cur = end;
  };

  // ジャズは Intro / A / A / B / A 形式 (32 小節 AABA に寄せる)
  if (style === "jazz") {
    if (bars >= 32) {
      push("intro", 4);
      push("verse", 8);     // A
      push("verse", 8);     // A
      push("bridge", 8);    // B
      push("verse", bars - cur - 2); // A
      push("outro", bars - cur);
    } else if (bars >= 16) {
      push("intro", 2);
      push("verse", 6);
      push("bridge", 4);
      push("verse", bars - cur - 2);
      push("outro", bars - cur);
    } else {
      push("verse", Math.max(2, Math.floor(bars / 2)));
      push("bridge", Math.max(1, Math.floor(bars / 4)));
      push("verse", bars - cur);
    }
    return sections.filter((s) => s.endBar > s.startBar);
  }

  // pop / ballad / rock の一般的な構成
  if (bars >= 32) {
    // Intro / Verse / Pre / Chorus / Verse / Pre / Chorus / Bridge / Chorus / Outro
    push("intro", 4);
    push("verse", 6);
    push("preChorus", 2);
    push("chorus", 4);
    push("verse", 4);
    push("preChorus", 2);
    push("chorus", 4);
    push("bridge", 2);
    push("chorus", Math.max(2, bars - cur - 2));
    push("outro", bars - cur);
  } else if (bars >= 16) {
    push("intro", 2);
    push("verse", 4);
    push("preChorus", 2);
    push("chorus", 4);
    push("verse", Math.max(2, bars - cur - 2));
    push("outro", bars - cur);
  } else if (bars >= 8) {
    push("intro", 1);
    push("verse", 3);
    push("chorus", 3);
    push("outro", bars - cur);
  } else {
    push("verse", Math.max(1, Math.floor(bars / 2)));
    push("chorus", bars - cur);
  }

  return sections.filter((s) => s.endBar > s.startBar);
}

/** 小節 → セクション解決ヘルパ。 */
function sectionAtBar(sections: SongSection[], bar: number): SongSection {
  for (const s of sections) {
    if (bar >= s.startBar && bar < s.endBar) return s;
  }
  return sections[sections.length - 1];
}

/** あるセクションでそのバーが最終小節かを判定 (フィル用)。 */
function isSectionLastBar(sec: SongSection, bar: number): boolean {
  return bar === sec.endBar - 1;
}

// ---------------------------------------------------------------------------
// コード進行テンプレート (拡張前のダイアトニック度数)
// 1〜7 はダイアトニックの度数 (I, ii, iii, IV, V, vi, vii°)
// ---------------------------------------------------------------------------
const PROGRESSION_TEMPLATES: Record<ComposerStyle, number[][]> = {
  pop: [
    [1, 5, 6, 4],
    [6, 4, 1, 5],
    [1, 6, 4, 5],
    [4, 5, 3, 6],
    [1, 5, 6, 3, 4, 1, 4, 5],
    [4, 1, 5, 6],
    [2, 5, 1, 6],
  ],
  ballad: [
    [1, 3, 4, 5],
    [6, 4, 1, 5],
    [4, 5, 6, 1],
    [1, 4, 6, 5],
    [1, 5, 4, 5],
    [1, 4, 5, 6, 4, 5, 1, 1],
  ],
  rock: [
    [1, 4, 5, 5],
    [1, 5, 4, 4],
    [6, 4, 1, 5],
    [1, 7, 4, 1],
    [1, 4, 1, 5],
    [1, 6, 4, 5, 1, 6, 7, 5],
  ],
  jazz: [
    [2, 5, 1, 6],
    [1, 6, 2, 5],
    [3, 6, 2, 5],
    [1, 4, 2, 5, 1, 6, 2, 5],
    [1, 4, 7, 3, 6, 2, 5, 1],
  ],
};

/**
 * セクションとスタイルに応じてコード拡張の "派手さ" を決める。
 *
 * 戻り値: トライアドのまま使う確率 / 軽い拡張 (sus, 7) を使う確率 /
 *         派手な拡張 (9, add9, maj7) を使う確率 の重み。
 */
function extensionWeights(
  section: SectionKind,
  style: ComposerStyle,
): { triad: number; light: number; rich: number } {
  // ジャズはいつでも豪華
  if (style === "jazz") {
    if (section === "intro" || section === "outro") return { triad: 0.1, light: 0.4, rich: 0.5 };
    return { triad: 0.05, light: 0.3, rich: 0.65 };
  }
  // バラードはセクション関係なく maj7/add9 多め
  if (style === "ballad") {
    if (section === "chorus") return { triad: 0.1, light: 0.3, rich: 0.6 };
    return { triad: 0.25, light: 0.4, rich: 0.35 };
  }
  // ロックはトライアド主体、Bridge/Chorus で 7 が出る
  if (style === "rock") {
    if (section === "chorus") return { triad: 0.55, light: 0.35, rich: 0.1 };
    if (section === "bridge") return { triad: 0.4, light: 0.45, rich: 0.15 };
    return { triad: 0.75, light: 0.2, rich: 0.05 };
  }
  // pop は Chorus で派手に
  if (section === "chorus") return { triad: 0.25, light: 0.4, rich: 0.35 };
  if (section === "bridge") return { triad: 0.2, light: 0.5, rich: 0.3 };
  if (section === "preChorus") return { triad: 0.3, light: 0.45, rich: 0.25 };
  return { triad: 0.5, light: 0.4, rich: 0.1 };
}

function enrichChord(
  base: HarmonicChord,
  degree: number, // 1..7
  section: SectionKind,
  style: ComposerStyle,
  rng: () => number,
): HarmonicChord {
  const variants = richVariants(base, degree - 1);
  if (variants.length === 1) return base;
  const w = extensionWeights(section, style);

  // 各バリエーションを "richness" でグループ分け
  const tier: Record<ChordQuality, "triad" | "light" | "rich"> = {
    major: "triad",
    minor: "triad",
    diminished: "triad",
    augmented: "triad",
    sus2: "light",
    sus4: "light",
    dom7: "light",
    maj7: "light",
    min7: "light",
    m7b5: "light",
    dim7: "light",
    dom7sus4: "rich",
    add9: "rich",
    minAdd9: "rich",
    maj6: "rich",
    min6: "rich",
    maj9: "rich",
    min9: "rich",
    dom9: "rich",
    dom7sharp5: "rich",
  };

  const weights = variants.map((q) => {
    const t = tier[q];
    if (t === "triad") return w.triad;
    if (t === "light") return w.light;
    return w.rich;
  });
  const picked = pickWeighted(variants, weights, rng);
  return withQuality(base, picked);
}

/**
 * 構造に沿ったコード進行を組み立てる。
 * セクション境界では「次セクションへ向かう」ようテンプレを切る。
 * Chorus は同じ進行を 2 回繰り返してフックを強調する。
 */
function buildProgression(
  scale: Scale,
  bars: number,
  style: ComposerStyle,
  sections: SongSection[],
  rng: () => number,
): HarmonicChord[] {
  const dia = diatonicTriads(scale);
  const templates = PROGRESSION_TEMPLATES[style];
  const out: HarmonicChord[] = new Array(bars);

  // セクションごとに 1 つテンプレを選び、その中で回す
  for (const sec of sections) {
    let tpl: number[];
    if (sec.kind === "chorus") {
      // Chorus は最もキャッチーなテンプレ (先頭) を使う
      tpl = templates[0];
    } else if (sec.kind === "bridge") {
      // Bridge は別のテンプレを意図的に選ぶ
      tpl = templates[Math.min(templates.length - 1, Math.floor(rng() * (templates.length - 1)) + 1)];
    } else if (sec.kind === "intro" || sec.kind === "outro") {
      // Intro/Outro は I と V を中心に静かに
      tpl = [1, 4, 1, 5];
    } else {
      tpl = pick(templates, rng);
    }
    const len = sec.endBar - sec.startBar;
    for (let i = 0; i < len; i++) {
      const deg = tpl[i % tpl.length];
      const idx = Math.max(0, Math.min(6, deg - 1));
      const base = dia[idx];
      const enriched = enrichChord(base, deg, sec.kind, style, rng);
      out[sec.startBar + i] = enriched;
    }
  }

  // 万一の埋め残し対策
  for (let i = 0; i < bars; i++) {
    if (!out[i]) out[i] = dia[0];
  }

  return out;
}

// ---------------------------------------------------------------------------
// メロディ生成
// ---------------------------------------------------------------------------

interface RhythmSlot {
  beats: number;   // 1=4分, 0.5=8分, 0.25=16分
  rest: boolean;
  strong: boolean;
}

const RHYTHM_PATTERNS: Record<ComposerStyle, RhythmSlot[][]> = {
  pop: [
    [
      { beats: 0.5, rest: false, strong: true },
      { beats: 0.5, rest: false, strong: false },
      { beats: 0.5, rest: false, strong: false },
      { beats: 0.5, rest: true,  strong: false },
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
    [
      { beats: 0.75, rest: false, strong: true },
      { beats: 0.25, rest: false, strong: false },
      { beats: 0.5,  rest: false, strong: false },
      { beats: 0.5,  rest: true,  strong: false },
      { beats: 0.75, rest: false, strong: true },
      { beats: 0.25, rest: false, strong: false },
      { beats: 1,    rest: false, strong: false },
    ],
    // シンコペ
    [
      { beats: 0.25, rest: true,  strong: false },
      { beats: 0.75, rest: false, strong: true },
      { beats: 0.5,  rest: false, strong: false },
      { beats: 0.5,  rest: false, strong: false },
      { beats: 0.25, rest: true,  strong: false },
      { beats: 0.75, rest: false, strong: true },
      { beats: 1,    rest: false, strong: false },
    ],
  ],
  ballad: [
    [
      { beats: 1.5, rest: false, strong: true },
      { beats: 0.5, rest: false, strong: false },
      { beats: 1,   rest: false, strong: true },
      { beats: 1,   rest: false, strong: false },
    ],
    [
      { beats: 2, rest: false, strong: true },
      { beats: 1, rest: false, strong: false },
      { beats: 1, rest: false, strong: true },
    ],
    [
      { beats: 1, rest: false, strong: true },
      { beats: 1, rest: true,  strong: false },
      { beats: 1, rest: false, strong: true },
      { beats: 1, rest: false, strong: false },
    ],
    // 長いロングトーン (侘び寂び)
    [
      { beats: 4, rest: false, strong: true },
    ],
    [
      { beats: 0.5, rest: false, strong: true },
      { beats: 0.5, rest: false, strong: false },
      { beats: 2,   rest: false, strong: true },
      { beats: 1,   rest: true,  strong: false },
    ],
  ],
  rock: [
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
      { beats: 1,   rest: false, strong: true },
      { beats: 1,   rest: false, strong: false },
      { beats: 0.5, rest: false, strong: true },
      { beats: 0.5, rest: false, strong: false },
      { beats: 1,   rest: false, strong: false },
    ],
    // 16 分混じり
    [
      { beats: 0.5, rest: false, strong: true },
      { beats: 0.25, rest: false, strong: false },
      { beats: 0.25, rest: false, strong: false },
      { beats: 0.5, rest: false, strong: false },
      { beats: 0.5, rest: false, strong: false },
      { beats: 0.5, rest: false, strong: true },
      { beats: 0.5, rest: false, strong: false },
      { beats: 1,   rest: false, strong: false },
    ],
  ],
  jazz: [
    // 跳ねたフィール (三連符近似)
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
      { beats: 1,    rest: true,  strong: false },
      { beats: 0.67, rest: false, strong: false },
      { beats: 0.33, rest: false, strong: false },
      { beats: 0.67, rest: false, strong: true },
      { beats: 0.33, rest: false, strong: false },
      { beats: 1,    rest: false, strong: false },
    ],
    // 8 分裏拍主体 (ジャズらしいシンコペ)
    [
      { beats: 0.5, rest: true,  strong: false },
      { beats: 1,   rest: false, strong: true },
      { beats: 0.5, rest: false, strong: false },
      { beats: 0.5, rest: false, strong: false },
      { beats: 0.5, rest: true,  strong: false },
      { beats: 1,   rest: false, strong: true },
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

/**
 * セクションごとのメロディ音域とダイナミクスを返す。
 */
function melodyRangeFor(section: SectionKind): { lo: number; hi: number; vel: number } {
  switch (section) {
    case "intro": return { lo: 60, hi: 72, vel: 0.55 };  // C4..C5
    case "verse": return { lo: 60, hi: 74, vel: 0.65 };
    case "preChorus": return { lo: 64, hi: 76, vel: 0.75 };
    case "chorus": return { lo: 67, hi: 84, vel: 0.92 }; // G4..C6 (派手)
    case "bridge": return { lo: 62, hi: 78, vel: 0.7 };
    case "outro": return { lo: 60, hi: 72, vel: 0.5 };
  }
}

function generateMelody(
  scale: Scale,
  chords: HarmonicChord[],
  sections: SongSection[],
  bpm: number,
  style: ComposerStyle,
  rng: () => number,
): NoteEvent[] {
  const beatSec = 60 / bpm;
  const events: NoteEvent[] = [];
  const patterns = RHYTHM_PATTERNS[style];

  let prevMidi: number | null = null;

  for (let bar = 0; bar < chords.length; bar++) {
    const sec = sectionAtBar(sections, bar);
    const { lo, hi, vel } = melodyRangeFor(sec.kind);
    const range = scaleTonesInRange(scale, lo, hi);
    if (range.length === 0) continue;

    const chord = chords[bar];
    const chordTones = chordVoicing(chord, 48);
    const chordPCs = new Set(chordTones.map((m) => m % 12));

    // Intro/Outro は半分以上を休符にして "間" を作る
    if ((sec.kind === "intro" || sec.kind === "outro") && rng() < 0.5) {
      // 2 拍休む → 半小節だけ短いフレーズ
      const barStart = bar * 4 * beatSec;
      const pitch = pick(range.filter((m) => chordPCs.has(m % 12)), rng) ?? range[Math.floor(range.length / 2)];
      events.push({
        midi: pitch,
        startSec: barStart + 2 * beatSec,
        durationSec: 2 * beatSec * 0.9,
        velocity: vel * 0.9,
      });
      prevMidi = pitch;
      continue;
    }

    // フレーズ末尾 (= セクション最終小節) はロングトーンで解決させる
    const isLastInSec = isSectionLastBar(sec, bar);

    const slots = pick(patterns, rng);
    const barStart = bar * 4 * beatSec;
    let t = barStart;

    const totalBeats = slots.reduce((a, s) => a + s.beats, 0);
    const beatScale = 4 / totalBeats;

    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      const slotDurSec = slot.beats * beatScale * beatSec;
      if (slot.rest) {
        t += slotDurSec;
        continue;
      }

      let candidates: number[];
      if (slot.strong) {
        candidates = range.filter((m) => chordPCs.has(m % 12));
        if (candidates.length === 0) candidates = range;
      } else {
        candidates = range;
      }

      let pickMidi: number;
      if (prevMidi === null) {
        // 最初は中央付近のコードトーン
        const mids = candidates.filter((m) => chordPCs.has(m % 12));
        pickMidi = (mids.length > 0 ? mids : candidates)[
          Math.floor((mids.length > 0 ? mids.length : candidates.length) / 2)
        ];
      } else {
        // フレーズの形: 前半は上昇傾向、後半は下降傾向で「弧」を作る
        const phasePos = (i / Math.max(1, slots.length - 1)); // 0..1
        const climbBias = phasePos < 0.5 ? +0.4 : -0.4;
        const weights = candidates.map((m) => {
          const d = m - (prevMidi as number);
          const ad = Math.abs(d);
          // ステップワイズ優先 (±2 半音内が最大)
          let w = ad === 0 ? 0.35 : ad > 9 ? 0.02 : ad > 5 ? 0.18 : ad > 2 ? 0.55 : 1.0;
          // セクション形に沿った方向バイアス
          if ((climbBias > 0 && d > 0) || (climbBias < 0 && d < 0)) w *= 1.4;
          return w;
        });
        pickMidi = pickWeighted(candidates, weights, rng);
      }

      const isLastSlot = i === slots.length - 1;
      // セクション最終小節の最後の音はロング解決
      let dur = slotDurSec * 0.92;
      if (isLastSlot && isLastInSec) {
        dur = slotDurSec * 1.4;
      } else if (isLastSlot) {
        dur = slotDurSec * 1.05;
      }
      dur = Math.max(0.08, dur);

      // セクションのダイナミクスで全体ベロシティ + 強拍プラス
      const v = Math.max(0.25, Math.min(1, vel + (slot.strong ? 0.05 : -0.08) + (rng() - 0.5) * 0.05));

      events.push({
        midi: pickMidi,
        startSec: t,
        durationSec: dur,
        velocity: v,
      });
      prevMidi = pickMidi;
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
  sections: SongSection[],
  bpm: number,
  style: ComposerStyle,
  rng: () => number,
): NoteEvent[] {
  const beatSec = 60 / bpm;
  const barSec = beatSec * 4;
  const out: NoteEvent[] = [];
  const baseMidi = 48; // C3

  for (let bar = 0; bar < chords.length; bar++) {
    const sec = sectionAtBar(sections, bar);
    const voicing = chordVoicing(chords[bar], baseMidi);
    const barStart = bar * barSec;
    const vel0 = sec.intensity;

    // Intro/Outro は薄めに (構成音の上 2 音だけ)
    const effectiveVoicing =
      sec.kind === "intro" || sec.kind === "outro" ? voicing.slice(0, 3) : voicing;

    if (style === "ballad") {
      // アルペジオ。Chorus 中だけ 8 分にして密度を上げる
      const sub = sec.kind === "chorus" ? 0.5 : 1;
      const reps = 4 / sub;
      for (let i = 0; i < reps; i++) {
        const m = effectiveVoicing[i % effectiveVoicing.length];
        out.push({
          midi: m,
          startSec: barStart + i * sub * beatSec,
          durationSec: sub * beatSec * 1.4,
          velocity: vel0 * 0.7,
        });
      }
    } else if (style === "jazz") {
      // 2/4 コンプ (チャールストン気味)。Bridge では裏拍を強調
      const offsets = sec.kind === "bridge" ? [0.5, 1.5, 2.5, 3.5] : [1, 3];
      for (const off of offsets) {
        for (const m of effectiveVoicing) {
          out.push({
            midi: m,
            startSec: barStart + off * beatSec,
            durationSec: beatSec * 0.55,
            velocity: vel0 * 0.6 + (rng() - 0.5) * 0.05,
          });
        }
      }
    } else if (style === "rock") {
      // ブロックコード + Chorus で 8 分カッティング
      if (sec.kind === "chorus") {
        for (let b = 0; b < 8; b++) {
          for (const m of effectiveVoicing) {
            out.push({
              midi: m,
              startSec: barStart + b * (beatSec / 2),
              durationSec: beatSec * 0.4,
              velocity: vel0 * (b % 2 === 0 ? 0.8 : 0.55),
            });
          }
        }
      } else {
        for (const m of effectiveVoicing) {
          out.push({
            midi: m,
            startSec: barStart,
            durationSec: barSec * 0.95,
            velocity: vel0 * 0.7,
          });
        }
      }
    } else {
      // pop: セクションによって density を変える
      if (sec.kind === "chorus") {
        // 8 分ストロークでサビ感
        for (let b = 0; b < 8; b++) {
          for (const m of effectiveVoicing) {
            out.push({
              midi: m,
              startSec: barStart + b * (beatSec / 2),
              durationSec: beatSec * 0.45,
              velocity: vel0 * (b === 0 ? 0.95 : b % 2 === 0 ? 0.78 : 0.55),
            });
          }
        }
      } else if (sec.kind === "preChorus") {
        // 4 分のはずみ
        for (let b = 0; b < 4; b++) {
          for (const m of effectiveVoicing) {
            out.push({
              midi: m,
              startSec: barStart + b * beatSec,
              durationSec: beatSec * 0.85,
              velocity: vel0 * (b === 0 ? 0.9 : 0.7),
            });
          }
        }
      } else {
        // verse/intro/outro はホワイトノート長め
        for (const m of effectiveVoicing) {
          out.push({
            midi: m,
            startSec: barStart,
            durationSec: barSec * 0.95,
            velocity: vel0 * 0.65,
          });
        }
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
  sections: SongSection[],
  bpm: number,
  style: ComposerStyle,
  rng: () => number,
): NoteEvent[] {
  const beatSec = 60 / bpm;
  const out: NoteEvent[] = [];
  const baseMidi = 36; // C2

  for (let bar = 0; bar < chords.length; bar++) {
    const sec = sectionAtBar(sections, bar);
    const ch = chords[bar];
    let root = baseMidi;
    while (root % 12 !== ch.rootPitchClass) root += 1;
    if (root > 48) root -= 12;
    const fifth = root + 7;
    const octave = root + 12;
    const third = root + 4; // 簡易: メジャー想定。微差は許容
    const barStart = bar * 4 * beatSec;
    const vel0 = sec.intensity;

    // Intro / Outro は控えめ (1 拍目だけ)
    if (sec.kind === "intro" || sec.kind === "outro") {
      out.push({
        midi: root,
        startSec: barStart,
        durationSec: 4 * beatSec * 0.9,
        velocity: vel0 * 0.65,
      });
      continue;
    }

    if (style === "ballad") {
      // バラードはルート長音 + Chorus では 2 + 2 で動く
      if (sec.kind === "chorus") {
        out.push({ midi: root,  startSec: barStart, durationSec: 2 * beatSec * 0.95, velocity: vel0 * 0.8 });
        out.push({ midi: fifth, startSec: barStart + 2 * beatSec, durationSec: 2 * beatSec * 0.95, velocity: vel0 * 0.75 });
      } else {
        out.push({ midi: root, startSec: barStart, durationSec: 4 * beatSec * 0.95, velocity: vel0 * 0.7 });
      }
    } else if (style === "jazz") {
      // ウォーキングベース。Bridge では裏拍シンコペ
      const next = chords[bar + 1] ?? ch;
      let nextRoot = baseMidi;
      while (nextRoot % 12 !== next.rootPitchClass) nextRoot += 1;
      if (nextRoot > 48) nextRoot -= 12;
      const approach = nextRoot + (rng() < 0.5 ? -1 : 1);
      const seq = [root, third, fifth, approach];
      for (let b = 0; b < 4; b++) {
        out.push({
          midi: seq[b],
          startSec: barStart + b * beatSec,
          durationSec: beatSec * 0.85,
          velocity: vel0 * (b === 0 ? 0.85 : 0.7) + (rng() - 0.5) * 0.04,
        });
      }
    } else if (style === "rock") {
      // 8 分刻み。Chorus は 16 分混じり
      const sub = sec.kind === "chorus" ? 0.25 : 0.5;
      const reps = 4 / sub;
      for (let b = 0; b < reps; b++) {
        const isThirdBeat = b === reps / 2;
        out.push({
          midi: isThirdBeat ? fifth : root,
          startSec: barStart + b * sub * beatSec,
          durationSec: beatSec * sub * 0.9,
          velocity: vel0 * (b % 2 === 0 ? 0.9 : 0.65),
        });
      }
    } else {
      // pop
      if (sec.kind === "chorus") {
        // 1-and-2-and pattern (跳ねるベースライン)
        const seq = [root, root, fifth, root, octave, root, fifth, root];
        for (let b = 0; b < 8; b++) {
          out.push({
            midi: seq[b],
            startSec: barStart + b * (beatSec / 2),
            durationSec: beatSec * 0.45,
            velocity: vel0 * (b % 2 === 0 ? 0.85 : 0.6),
          });
        }
      } else if (sec.kind === "preChorus") {
        // 4 つ打ち気味
        for (let b = 0; b < 4; b++) {
          out.push({
            midi: root,
            startSec: barStart + b * beatSec,
            durationSec: beatSec * 0.9,
            velocity: vel0 * 0.85,
          });
        }
      } else {
        const seq = [root, octave, fifth, root];
        for (let b = 0; b < 4; b++) {
          out.push({
            midi: seq[b],
            startSec: barStart + b * beatSec,
            durationSec: beatSec * 0.9,
            velocity: vel0 * (b === 0 || b === 2 ? 0.85 : 0.65),
          });
        }
      }
    }

    // 小節最後でアプローチノート (次コードへの導音)
    if (bar + 1 < chords.length && rng() < 0.35) {
      const next = chords[bar + 1];
      let nextRoot = baseMidi;
      while (nextRoot % 12 !== next.rootPitchClass) nextRoot += 1;
      if (nextRoot > 48) nextRoot -= 12;
      const approach = nextRoot + (rng() < 0.5 ? -1 : 1);
      out.push({
        midi: approach,
        startSec: barStart + 3.5 * beatSec,
        durationSec: beatSec * 0.45,
        velocity: vel0 * 0.5,
      });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// ドラム
// ---------------------------------------------------------------------------

function addNote(out: NoteEvent[], midi: number, startSec: number, velocity: number) {
  out.push({ midi, startSec, durationSec: 0.05, velocity });
}

/**
 * フィル: 小節最後の 1 拍 or 2 拍を 16 分のタムやスネア連打で埋める。
 */
function appendFill(
  out: NoteEvent[],
  barStart: number,
  beatSec: number,
  size: "small" | "big",
  rng: () => number,
) {
  const fillStart = barStart + (size === "big" ? 2 : 3) * beatSec;
  const n = size === "big" ? 8 : 4; // 16 分音符の個数
  const sub = beatSec / 4;
  const tomSeq = [DRUM_TOM_HI_MIDI, DRUM_TOM_HI_MIDI, DRUM_TOM_MID_MIDI, DRUM_TOM_MID_MIDI, DRUM_TOM_LO_MIDI, DRUM_TOM_LO_MIDI, DRUM_SNARE_MIDI, DRUM_SNARE_MIDI];
  for (let i = 0; i < n; i++) {
    const m = rng() < 0.6 ? tomSeq[(8 - n + i) % tomSeq.length] : DRUM_SNARE_MIDI;
    addNote(out, m, fillStart + i * sub, 0.85 + (i / n) * 0.1);
  }
}

function generateDrums(
  sections: SongSection[],
  bars: number,
  bpm: number,
  style: ComposerStyle,
  rng: () => number,
): NoteEvent[] {
  const beatSec = 60 / bpm;
  const out: NoteEvent[] = [];

  for (let bar = 0; bar < bars; bar++) {
    const sec = sectionAtBar(sections, bar);
    const barStart = bar * 4 * beatSec;
    const intensity = sec.intensity;
    const isSectionStart = bar === sec.startBar;
    const isSectionLast = isSectionLastBar(sec, bar);

    // セクション開始: クラッシュ + 強キック (Intro/Outro 以外)
    if (isSectionStart && sec.kind !== "intro" && sec.kind !== "outro") {
      addNote(out, DRUM_CRASH_MIDI, barStart, Math.min(1, intensity + 0.05));
      addNote(out, DRUM_KICK_MIDI, barStart, 0.95);
    }

    if (sec.kind === "intro" || sec.kind === "outro") {
      // Intro/Outro: キックとハットを薄く、スネアは弱
      addNote(out, DRUM_KICK_MIDI, barStart, intensity * 0.85);
      if (bar % 2 === 1) {
        addNote(out, DRUM_RIM_MIDI, barStart + 2 * beatSec, intensity * 0.7);
      }
      // 4 分ハイハット
      for (let b = 0; b < 4; b++) {
        addNote(out, DRUM_HIHAT_MIDI, barStart + b * beatSec, intensity * 0.55);
      }
      // Intro 最後はライドへ移行を示唆
      if (isSectionLast) {
        addNote(out, DRUM_TOM_LO_MIDI, barStart + 3 * beatSec, intensity * 0.7);
        addNote(out, DRUM_TOM_MID_MIDI, barStart + 3.5 * beatSec, intensity * 0.75);
      }
      continue;
    }

    if (style === "ballad") {
      // バラード: 1キック / 3スネア / 4分ハット (Chorus は 8 分 + ride 増)
      addNote(out, DRUM_KICK_MIDI, barStart, intensity * 0.95);
      addNote(out, DRUM_SNARE_MIDI, barStart + 2 * beatSec, intensity * 0.85);
      if (sec.kind === "chorus") {
        // ride で広がりを出す
        for (let b = 0; b < 8; b++) {
          const isOff = b % 2 === 1;
          addNote(out, isOff ? DRUM_RIDE_MIDI : DRUM_HIHAT_MIDI, barStart + b * (beatSec / 2), intensity * (b % 2 === 0 ? 0.7 : 0.5));
        }
        // クラップで厚みを足す
        addNote(out, DRUM_CLAP_MIDI, barStart + 2 * beatSec, intensity * 0.55);
      } else {
        for (let b = 0; b < 4; b++) {
          addNote(out, DRUM_HIHAT_MIDI, barStart + b * beatSec, intensity * 0.55);
        }
      }
    } else if (style === "jazz") {
      // ジャズ: ライド + 2/4 スネア (ライト) + キックは "feathered"
      // ライド 4 分 + 三連の中
      for (let b = 0; b < 4; b++) {
        addNote(out, DRUM_RIDE_MIDI, barStart + b * beatSec, intensity * 0.65);
        // 三連の最後 (= 2/3 of the beat)
        addNote(out, DRUM_RIDE_MIDI, barStart + (b + 0.67) * beatSec, intensity * 0.45);
      }
      addNote(out, DRUM_SNARE_MIDI, barStart + 1 * beatSec, intensity * 0.5);
      addNote(out, DRUM_SNARE_MIDI, barStart + 3 * beatSec, intensity * 0.55);
      addNote(out, DRUM_KICK_MIDI, barStart, intensity * 0.45);
      // ゴーストノートのスネア
      if (rng() < 0.35) {
        addNote(out, DRUM_SNARE_MIDI, barStart + 2.67 * beatSec, intensity * 0.25);
      }
    } else {
      // pop / rock: セクションに応じた密度
      // キック
      const kickSlots = sec.kind === "chorus"
        ? [0, 2.5, 3]      // ロックらしい
        : sec.kind === "preChorus"
          ? [0, 1.5, 2, 3.5]
          : [0, 2];
      for (const off of kickSlots) {
        addNote(out, DRUM_KICK_MIDI, barStart + off * beatSec, intensity * (off === 0 ? 0.98 : 0.85));
      }
      // スネア (2,4)
      addNote(out, DRUM_SNARE_MIDI, barStart + 1 * beatSec, intensity * 0.92);
      addNote(out, DRUM_SNARE_MIDI, barStart + 3 * beatSec, intensity * 0.95);
      // ゴーストノート
      if (rng() < 0.4 && sec.kind !== "verse") {
        addNote(out, DRUM_SNARE_MIDI, barStart + 2.5 * beatSec, intensity * 0.25);
      }
      // クラップは Chorus で 2,4 重ね
      if (sec.kind === "chorus") {
        addNote(out, DRUM_CLAP_MIDI, barStart + 1 * beatSec, intensity * 0.55);
        addNote(out, DRUM_CLAP_MIDI, barStart + 3 * beatSec, intensity * 0.55);
      }
      // ハットは Chorus は ride 多め、それ以外は閉じハット
      if (sec.kind === "chorus") {
        for (let b = 0; b < 8; b++) {
          const isOff = b % 2 === 1;
          // 裏拍は時々オープン
          if (isOff && rng() < 0.25) {
            addNote(out, DRUM_HIHAT_OPEN_MIDI, barStart + b * (beatSec / 2), intensity * 0.65);
          } else {
            addNote(out, isOff ? DRUM_RIDE_MIDI : DRUM_HIHAT_MIDI, barStart + b * (beatSec / 2), intensity * (b % 2 === 0 ? 0.75 : 0.55));
          }
        }
      } else if (sec.kind === "preChorus") {
        for (let b = 0; b < 16; b++) {
          addNote(out, DRUM_HIHAT_MIDI, barStart + b * (beatSec / 4), intensity * (b % 4 === 0 ? 0.75 : 0.45));
        }
      } else {
        for (let b = 0; b < 8; b++) {
          // 4 拍目裏でオープンを時々入れる
          if (b === 7 && rng() < 0.3) {
            addNote(out, DRUM_HIHAT_OPEN_MIDI, barStart + b * (beatSec / 2), intensity * 0.6);
          } else {
            addNote(out, DRUM_HIHAT_MIDI, barStart + b * (beatSec / 2), intensity * (b % 2 === 0 ? 0.7 : 0.5));
          }
        }
      }
    }

    // セクション最終小節: フィルイン (Intro/Outro は上の continue で抜けてるのでここに来ない)
    if (isSectionLast) {
      // Chorus → 次セクションへ向かう大きなフィル / それ以外は小フィル
      const big = sec.kind === "chorus" || sec.kind === "bridge";
      appendFill(out, barStart, beatSec, big ? "big" : "small", rng);
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

  const sections = planSections(bars, style, rng);
  const chords = buildProgression(scale, bars, style, sections, rng);
  const melodyNotes = (opts.includeMelody ?? true)
    ? generateMelody(scale, chords, sections, bpm, style, rng)
    : [];
  const chordNotes = (opts.includeChord ?? true)
    ? generateChordLayer(chords, sections, bpm, style, rng)
    : [];
  const bassNotes = (opts.includeBass ?? true)
    ? generateBass(chords, sections, bpm, style, rng)
    : [];
  const drumNotes = (opts.includeDrums ?? true)
    ? generateDrums(sections, bars, bpm, style, rng)
    : [];

  const totalSec = bars * 4 * (60 / bpm);

  for (const arr of [melodyNotes, chordNotes, bassNotes, drumNotes]) {
    arr.sort((a, b) => a.startSec - b.startSec);
  }

  return {
    chords,
    sections,
    melodyNotes,
    chordNotes,
    bassNotes,
    drumNotes,
    totalSec,
    bpm,
    style,
  };
}

/** UI 表示用のセクションラベル。 */
export const SECTION_LABEL_JA: Record<SectionKind, string> = {
  intro: "イントロ",
  verse: "Aメロ",
  preChorus: "Bメロ",
  chorus: "サビ",
  bridge: "間奏",
  outro: "アウトロ",
};
