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
  CHORD_INTERVALS,
  chordVoicing,
  diatonicTriads,
  richVariants,
  withQuality,
  type ChordQuality,
  type HarmonicChord,
} from "../music/chord";
import type { Scale } from "../music/scale";
import { SCALE_INTERVALS, scaleContains } from "../music/scale";
import {
  FX_DOWNLIFTER,
  FX_FALL,
  FX_REVERSE_CYMBAL,
  FX_RISER,
  FX_SWEEP_DOWN,
  FX_SWEEP_UP,
  FX_WHITE_NOISE,
} from "../audio/fxEngine";

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
  /** FX (リバースシンバル / ライザー / ダウンリフター 等) を入れるか。 */
  includeFx?: boolean;
  /** エレキギター層 (パワーコード/カッティング) を生成するか。 */
  includeGuitar?: boolean;
  /** アコースティックギター層 (フィンガーピッキング/分散和音) を生成するか。 */
  includeAcoustic?: boolean;
  /** ボーカル層 (メロディ + ハモリ) を生成するか。 */
  includeVocal?: boolean;
  /** シンセ層 (パッド or カウンターメロディ) を生成するか。 */
  includeSynth?: boolean;
  /**
   * ユーザー指定のコード進行。指定された場合、自動生成の進行を完全に置き換える。
   * 配列長が bars と一致しない場合は、不足分は最後のコードを反復、超過分は切り捨て。
   * Chord 層手書き / コードパレット選択を反映するための入口。
   */
  chordsOverride?: HarmonicChord[];
}

export type SectionKind =
  | "intro"
  | "verse"
  | "preChorus"
  | "chorus"
  | "bridge"
  | "break"
  | "outro";

export interface SongSection {
  kind: SectionKind;
  startBar: number; // inclusive
  endBar: number;   // exclusive
  /** このセクションの平均ダイナミクス (0..1)。 */
  intensity: number;
  /**
   * セクション中だけ適用する転調量 (半音単位)。
   * 例えば最終サビを +2 半音上げて盛り上げる、などに使う。
   * 0 のときは転調なし。
   */
  keyOffsetSemitones: number;
}

export interface ComposedSong {
  /** 1 小節 = 1 コード (進行)。 */
  chords: HarmonicChord[];
  sections: SongSection[];
  melodyNotes: NoteEvent[];
  chordNotes: NoteEvent[];
  bassNotes: NoteEvent[];
  drumNotes: NoteEvent[];
  /** セクション転換時の効果音 (リバースシンバル / ライザー / ダウンリフター 等)。 */
  fxNotes: NoteEvent[];
  /** エレキギター専用パターン (空配列なら未生成)。 */
  guitarNotes: NoteEvent[];
  /** アコースティックギター専用パターン (空配列なら未生成)。 */
  acousticNotes: NoteEvent[];
  /** ボーカル専用パターン (メロディ + 上 3 度ハモリ等)。 */
  vocalNotes: NoteEvent[];
  /** シンセ専用パターン (パッド or カウンターメロディ)。 */
  synthNotes: NoteEvent[];
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
    break: 0.25,
    outro: 0.4,
  };

  const sections: SongSection[] = [];
  let cur = 0;
  /**
   * セクションを 1 つ追加するヘルパ。
   * keyOffset は「このセクション全体だけ転調」するときの半音数。
   * 例えば最終サビを +2 にして高揚させる、ブリッジを -3 にして雰囲気を変える 等。
   */
  const push = (kind: SectionKind, len: number, keyOffset = 0) => {
    if (len <= 0) return;
    const end = Math.min(bars, cur + len);
    sections.push({
      kind,
      startBar: cur,
      endBar: end,
      intensity: intensityOf[kind] + (rng() - 0.5) * 0.08,
      keyOffsetSemitones: keyOffset,
    });
    cur = end;
  };

  // ジャズは Intro / A / A / B / A 形式 (32 小節 AABA に寄せる)。
  // 64+ では AABA を 2 ラウンドしてキー転調を入れる。
  if (style === "jazz") {
    if (bars >= 96) {
      // 1 ラウンド AABA → ピアノソロ(bridge) → 2 ラウンド AABA を +5 半音 (4 度上) で
      push("intro", 4);
      push("verse", 8);
      push("verse", 8);
      push("bridge", 8);
      push("verse", 8);
      push("bridge", 8); // ソロ的セクション
      push("verse", 8, 5);
      push("verse", 8, 5);
      push("bridge", 8, 5);
      push("verse", Math.max(4, bars - cur - 4), 5);
      push("outro", bars - cur);
    } else if (bars >= 64) {
      // AABA + キー上げの A
      push("intro", 4);
      push("verse", 8);
      push("verse", 8);
      push("bridge", 8);
      push("verse", 8);
      push("verse", 8, 5);
      push("bridge", 8, 5);
      push("verse", Math.max(4, bars - cur - 4), 5);
      push("outro", bars - cur);
    } else if (bars >= 32) {
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
  if (bars >= 96) {
    // 大型構成: Intro / V1 / Pre / C1 / V2 / Pre / C2 / Solo(bridge) / Bridge / Break /
    //          V3(+2) / Pre(+2) / Final Chorus x2(+2) / Outro
    push("intro", 4);
    push("verse", 8);
    push("preChorus", 4);
    push("chorus", 8);
    push("verse", 8);
    push("preChorus", 4);
    push("chorus", 8);
    push("bridge", 4);   // 楽器ソロ的ブロック
    push("bridge", 4);
    push("break", 2);    // 完全ドロップ (ドラム停止)
    push("verse", 6, 2); // キー +2 で展開復帰
    push("preChorus", 4, 2);
    push("chorus", 8, 2);
    push("chorus", Math.max(4, bars - cur - 4), 2);
    push("outro", bars - cur);
  } else if (bars >= 64) {
    // Intro / V1 / Pre / C1 / V2 / Pre / C2 / Bridge / Break / Final C(+2) / Outro
    push("intro", 4);
    push("verse", 8);
    push("preChorus", 4);
    push("chorus", 8);
    push("verse", 8);
    push("preChorus", 4);
    push("chorus", 8);
    push("bridge", 4);
    push("break", 2);
    push("chorus", 8, 2);
    push("chorus", Math.max(2, bars - cur - 2), 2);
    push("outro", bars - cur);
  } else if (bars >= 48) {
    // Intro / V1 / Pre / C1 / V2 / Pre / C2 / Bridge / Final C(+2) / Outro
    push("intro", 4);
    push("verse", 6);
    push("preChorus", 2);
    push("chorus", 4);
    push("verse", 6);
    push("preChorus", 2);
    push("chorus", 4);
    push("bridge", 4);
    push("break", 1);
    push("chorus", Math.max(4, bars - cur - 2), 2);
    push("outro", bars - cur);
  } else if (bars >= 32) {
    // Intro / Verse / Pre / Chorus / Verse / Pre / Chorus / Bridge / Final Chorus(+2) / Outro
    push("intro", 4);
    push("verse", 6);
    push("preChorus", 2);
    push("chorus", 4);
    push("verse", 4);
    push("preChorus", 2);
    push("chorus", 4);
    push("bridge", 2);
    push("chorus", Math.max(2, bars - cur - 2), 2);
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
// コード進行: 音楽理論ベースの "機能和声" エンジン
//
// テンプレート (固定の度数列) を選んで回すのではなく、
// 「機能 (T = Tonic, S = Subdominant, D = Dominant)」のマルコフ連鎖で
// 1 小節ずつ機能を引き、その機能に属する度数をスタイル/直前コードの
// 共通音 (ヴォイス・リーディング) を加味して選ぶ。
//
// これにより同じスタイル・同じセクションでも毎回違う進行が生成され、
// 「テンプレ感」が薄れる。終止 (cadence) のみセクション毎に固定して
// 「サビへ向かう V」「サビ末尾の I」など曲構造上必要な流れを保証する。
// ---------------------------------------------------------------------------

type ChordFunction = "T" | "S" | "D";

/** Major key におけるダイアトニック度数 → 機能の対応。 */
const FUNCTION_OF_DEGREE: Record<number, ChordFunction> = {
  1: "T", // I
  2: "S", // ii
  3: "T", // iii (代理 T)
  4: "S", // IV
  5: "D", // V
  6: "T", // vi (代理 T)
  7: "D", // vii°
};

/** 機能 → 候補度数。スタイル毎に重みが違う。 */
type FunctionMembers = Record<ChordFunction, Array<{ deg: number; w: number }>>;

const STYLE_FUNCTION_MEMBERS: Record<ComposerStyle, FunctionMembers> = {
  // pop: I/vi/IV/V を主軸に、ii を時々
  pop: {
    T: [{ deg: 1, w: 5 }, { deg: 6, w: 4 }, { deg: 3, w: 1 }],
    S: [{ deg: 4, w: 5 }, { deg: 2, w: 3 }],
    D: [{ deg: 5, w: 6 }, { deg: 7, w: 1 }],
  },
  // rock: I-IV-V の骨格、vi はやや控えめ、iii は出にくい
  rock: {
    T: [{ deg: 1, w: 6 }, { deg: 6, w: 3 }, { deg: 3, w: 1 }],
    S: [{ deg: 4, w: 6 }, { deg: 2, w: 1 }],
    D: [{ deg: 5, w: 6 }, { deg: 7, w: 2 }],
  },
  // ballad: vi が強い (関係短調的)、IV/ii で陰を作る
  ballad: {
    T: [{ deg: 1, w: 5 }, { deg: 6, w: 5 }, { deg: 3, w: 2 }],
    S: [{ deg: 4, w: 5 }, { deg: 2, w: 3 }],
    D: [{ deg: 5, w: 5 }, { deg: 7, w: 1 }],
  },
  // jazz: ii-V-I が王道。ii が S の主役、iii/vi も T の常連
  jazz: {
    T: [{ deg: 1, w: 4 }, { deg: 3, w: 3 }, { deg: 6, w: 4 }],
    S: [{ deg: 2, w: 6 }, { deg: 4, w: 3 }],
    D: [{ deg: 5, w: 7 }, { deg: 7, w: 2 }],
  },
};

/**
 * 機能の遷移確率 (Markov chain)。
 *   T → S, D が多い (T で安定したら動き出す)
 *   S → D が圧倒的 (S → D は機能和声の核)
 *   D → T が圧倒的 (D は T に解決)
 * 同じ機能の連続 (T→T 等) は控えめにして「動き」を作る。
 */
const FUNCTION_TRANSITIONS: Record<ChordFunction, Record<ChordFunction, number>> = {
  T: { T: 1, S: 5, D: 4 },
  S: { T: 2, S: 1, D: 6 },
  D: { T: 7, S: 1, D: 1 },
};

/** セクション末尾の必須終止機能 (cadence)。 */
function cadenceFunctionFor(kind: SectionKind): ChordFunction {
  switch (kind) {
    case "intro":     return "D"; // verse へ
    case "verse":     return "D"; // preChorus へ
    case "preChorus": return "D"; // V 終止 → chorus へ
    case "chorus":    return "T"; // 解決 (I or vi)
    case "bridge":    return "D"; // chorus 再突入へ
    case "break":     return "T"; // I のみ
    case "outro":     return "T"; // I 解決
  }
}

/** セクション先頭の推奨開始機能 (なければ null = 自由)。 */
function startFunctionFor(kind: SectionKind): ChordFunction | null {
  switch (kind) {
    case "intro":     return "T";
    case "verse":     return "T";
    case "preChorus": return "S"; // 動き出し感
    case "chorus":    return null; // T (1) or T (6) どちらでも、後段で決める
    case "bridge":    return "S"; // chorus と対比
    case "break":     return "T";
    case "outro":     return "T";
  }
}

/**
 * 機能列を Markov chain で生成する。
 *   - start で初期機能を固定
 *   - end で最後の機能を固定 (cadence)
 *   - 最後から 2 つ手前は cadence への自然な遷移を強制 (D→T なら直前は S または D)
 */
function rollFunctionSequence(
  start: ChordFunction,
  end: ChordFunction,
  len: number,
  rng: () => number,
): ChordFunction[] {
  if (len <= 0) return [];
  if (len === 1) return [end];
  if (len === 2) {
    // 2 小節セクション: 終止前は cadence への自然遷移
    const before: ChordFunction = end === "T" ? "D" : end === "D" ? "S" : "T";
    return [before === start ? start : before, end];
  }
  const seq: ChordFunction[] = new Array(len);
  seq[0] = start;
  seq[len - 1] = end;
  // 末尾の 1 つ手前は cadence に自然に繋がる機能
  const beforeEnd: ChordFunction =
    end === "T" ? (rng() < 0.75 ? "D" : "S") :
    end === "D" ? (rng() < 0.7 ? "S" : "T") :
    /* end === "S" */ "T";
  seq[len - 2] = beforeEnd;
  // 中間を Markov で埋める
  let prev = seq[0];
  for (let i = 1; i < len - 2; i++) {
    const probs = FUNCTION_TRANSITIONS[prev];
    const next = pickWeighted(
      ["T", "S", "D"] as ChordFunction[],
      ["T", "S", "D"].map((f) => probs[f as ChordFunction]),
      rng,
    );
    seq[i] = next;
    prev = next;
  }
  return seq;
}

/**
 * 機能 → 度数を 1 つ選ぶ。
 * スタイル別の基本重みに加え、直前コードとの共通音 (ヴォイス・リーディング) で加点。
 * また直前と同じ度数になりやすい状況を避ける。
 */
function pickDegreeForFunction(
  fn: ChordFunction,
  style: ComposerStyle,
  prevDegree: number | null,
  dia: HarmonicChord[],
  rng: () => number,
): number {
  const members = STYLE_FUNCTION_MEMBERS[style][fn];
  const weights = members.map(({ deg, w }) => {
    let weight = w;
    if (prevDegree != null) {
      // 同じ度数の連続は避ける (break 用の I 連打は別ロジック)
      if (deg === prevDegree) weight *= 0.15;
      // 直前のコードとの共通音数で加点 (多いほど滑らか)
      const prevChord = dia[Math.max(0, Math.min(6, prevDegree - 1))];
      const curChord = dia[Math.max(0, Math.min(6, deg - 1))];
      const common = commonTones(prevChord, curChord);
      // 共通音 1 つにつき +0.6 (最大 3 音で +1.8)
      weight *= 1 + common * 0.3;
      // ルートが完全 4/5 度関係なら +ボーナス (強い進行感)
      const prevRoot = prevChord.rootPitchClass;
      const curRoot = curChord.rootPitchClass;
      const interval = ((curRoot - prevRoot) % 12 + 12) % 12;
      if (interval === 5 || interval === 7) weight *= 1.25;
    }
    return weight;
  });
  return pickWeighted(members.map((m) => m.deg), weights, rng);
}

/** 2 つのコードの共通音数 (0..3)。トライアド前提。 */
function commonTones(a: HarmonicChord, b: HarmonicChord): number {
  const aTones = chordPitchClasses(a);
  const bTones = chordPitchClasses(b);
  let n = 0;
  for (const t of aTones) if (bTones.has(t)) n++;
  return n;
}

function chordPitchClasses(c: HarmonicChord): Set<number> {
  // トライアド 3 音だけで判定 (拡張前のダイアトニック前提なので近似で十分)
  const r = c.rootPitchClass;
  const set = new Set<number>([r]);
  if (c.quality === "minor" || c.quality === "diminished") set.add((r + 3) % 12);
  else set.add((r + 4) % 12);
  if (c.quality === "diminished") set.add((r + 6) % 12);
  else if (c.quality === "augmented") set.add((r + 8) % 12);
  else set.add((r + 7) % 12);
  return set;
}

/**
 * 1 セクション分の度数列を生成する。
 * 機能列を Markov で引き → 各機能から度数をスタイル+ヴォイス・リーディングで選ぶ。
 * Pre-Chorus は ii-V or IV-V のループを優先的に出す。
 * Bridge は冒頭で T を避けて対比を作る。
 */
function buildSectionDegrees(
  kind: SectionKind,
  len: number,
  style: ComposerStyle,
  dia: HarmonicChord[],
  prevDegree: number | null,
  rng: () => number,
): number[] {
  if (kind === "break") {
    // break は I で 1 拍ヒット (上位ロジックで処理) なので I 固定
    return new Array(len).fill(1);
  }

  const start = startFunctionFor(kind) ?? "T";
  const end = cadenceFunctionFor(kind);
  const funcs = rollFunctionSequence(start, end, len, rng);

  const out: number[] = [];
  let prev = prevDegree;
  for (let i = 0; i < funcs.length; i++) {
    let fn = funcs[i];

    // Pre-Chorus は中間でも S と D を交互にしてサビへ突き上げる
    if (kind === "preChorus" && i > 0 && i < funcs.length - 1) {
      const prevFn = i > 0 ? FUNCTION_OF_DEGREE[out[i - 1]] : start;
      fn = prevFn === "S" ? "D" : "S";
    }
    // Bridge の冒頭 (1 小節目) は vi/iii で対比、ただし最後の cadence は D
    if (kind === "bridge" && i === 0) {
      // T 機能だが vi (deg 6) を優先
      const deg = rng() < 0.65 ? 6 : 3;
      out.push(deg);
      prev = deg;
      continue;
    }
    // Chorus の冒頭は 1 (王道) or 6 (切ない hook) どちらか
    if (kind === "chorus" && i === 0) {
      const deg = rng() < 0.6 ? 1 : 6;
      out.push(deg);
      prev = deg;
      continue;
    }
    // Chorus の末尾は I で着地するのが王道だが、たまに vi で余韻
    if (kind === "chorus" && i === funcs.length - 1) {
      const deg = rng() < 0.75 ? 1 : 6;
      out.push(deg);
      prev = deg;
      continue;
    }
    // Pre-Chorus 末尾は必ず V
    if (kind === "preChorus" && i === funcs.length - 1) {
      out.push(5);
      prev = 5;
      continue;
    }

    const deg = pickDegreeForFunction(fn, style, prev, dia, rng);
    out.push(deg);
    prev = deg;
  }

  // ジャズの場合、内部で ii-V の連結を 1 箇所注入してみる
  if (style === "jazz" && len >= 4 && rng() < 0.6) {
    // out 内のどこかで連続する S(2 or 4) → D(5) があれば 2→5 に強制置換
    for (let i = 0; i < out.length - 1; i++) {
      const fnA = FUNCTION_OF_DEGREE[out[i]];
      const fnB = FUNCTION_OF_DEGREE[out[i + 1]];
      if (fnA === "S" && fnB === "D") {
        out[i] = 2;
        out[i + 1] = 5;
        break;
      }
    }
  }

  return out;
}

/**
 * 与えられたスケールを keyOffsetSemitones 半音だけ平行移動した新しいスケールを返す。
 * 転調セクション (例: 最終サビ +2) のコード進行構築に使う。
 */
function transposeScale(scale: Scale, keyOffsetSemitones: number): Scale {
  if (!keyOffsetSemitones) return scale;
  return {
    rootPitchClass: ((scale.rootPitchClass + keyOffsetSemitones) % 12 + 12) % 12,
    kind: scale.kind,
  };
}

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
  // break (ドロップ) はコードが鳴ってもごく短いスタブだけなのでトライアド主体
  if (section === "break") {
    return { triad: 0.7, light: 0.25, rich: 0.05 };
  }
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
 * 構造に沿ったコード進行を組み立てる (機能和声エンジン版)。
 *
 * セクション毎に buildSectionDegrees() で度数列を生成し、
 * Verse1↔Verse2、PreChorus1↔PreChorus2、Chorus1↔Chorus2 は
 * 「最初に生成した度数列を memo して 2 回目以降も同じ」にすることで
 * 「歌の繰り返し」感を保つ。
 *
 * 同じシードで呼ぶ限り再現性があるが、シードが違えば毎回違う進行になる。
 */
function buildProgression(
  scale: Scale,
  bars: number,
  style: ComposerStyle,
  sections: SongSection[],
  rng: () => number,
): HarmonicChord[] {
  const out: HarmonicChord[] = new Array(bars);
  const degMemo = new Map<SectionKind, number[]>();
  let lastDegree: number | null = null;

  for (const sec of sections) {
    const localScale = transposeScale(scale, sec.keyOffsetSemitones);
    const dia = diatonicTriads(localScale);
    const len = sec.endBar - sec.startBar;

    if (sec.kind === "break") {
      // break は I で 1 拍ヒット + 残り無音 (上位ロジック側で生成)
      for (let i = sec.startBar; i < sec.endBar; i++) out[i] = dia[0];
      lastDegree = 1;
      continue;
    }

    let degrees: number[];
    const cached = degMemo.get(sec.kind);
    const memoizable =
      sec.kind === "verse" || sec.kind === "preChorus" || sec.kind === "chorus";
    if (cached && memoizable) {
      // 2 回目以降の Verse / Pre-Chorus / Chorus は同じ度数列を使う
      // (Verse1 と Verse2 が違うコードだと「歌の繰り返し」感が出ない)
      degrees = cached.slice(0, len);
      // 長さが足りない場合は同じ列を繰り返して埋める
      while (degrees.length < len) degrees.push(cached[degrees.length % cached.length]);
    } else {
      degrees = buildSectionDegrees(sec.kind, len, style, dia, lastDegree, rng);
      if (memoizable) degMemo.set(sec.kind, degrees);
    }

    for (let i = 0; i < len; i++) {
      const deg = degrees[i % degrees.length];
      const idx = Math.max(0, Math.min(6, deg - 1));
      const base = dia[idx];
      const enriched = enrichChord(base, deg, sec.kind, style, rng);
      out[sec.startBar + i] = enriched;
    }
    lastDegree = degrees[degrees.length - 1] ?? lastDegree;
  }

  // 万一の埋め残し対策 (元キーのトニック)
  const fallbackDia = diatonicTriads(scale);
  for (let i = 0; i < bars; i++) {
    if (!out[i]) out[i] = fallbackDia[0];
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
    // 16 分跳ね (キャッチー)
    [
      { beats: 0.25, rest: false, strong: true },
      { beats: 0.25, rest: false, strong: false },
      { beats: 0.5,  rest: false, strong: false },
      { beats: 0.5,  rest: true,  strong: false },
      { beats: 0.5,  rest: false, strong: true },
      { beats: 0.25, rest: false, strong: false },
      { beats: 0.25, rest: false, strong: false },
      { beats: 1,    rest: false, strong: false },
    ],
    // 付点と切り (ラテン pop っぽい)
    [
      { beats: 0.75, rest: false, strong: true },
      { beats: 0.25, rest: false, strong: false },
      { beats: 0.5,  rest: false, strong: false },
      { beats: 0.5,  rest: false, strong: true },
      { beats: 0.5,  rest: true,  strong: false },
      { beats: 0.5,  rest: false, strong: false },
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
    // 流れる 8 分 (アンセム系バラード)
    [
      { beats: 1,   rest: false, strong: true },
      { beats: 0.5, rest: false, strong: false },
      { beats: 0.5, rest: false, strong: false },
      { beats: 0.5, rest: false, strong: true },
      { beats: 0.5, rest: false, strong: false },
      { beats: 1,   rest: false, strong: false },
    ],
    // 弱起 (アウフタクト) → 強拍ロングトーン
    [
      { beats: 0.5, rest: true,  strong: false },
      { beats: 0.5, rest: false, strong: false },
      { beats: 2,   rest: false, strong: true },
      { beats: 1,   rest: false, strong: false },
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
    // パンチライン (休 → アクセント)
    [
      { beats: 1,    rest: false, strong: true },
      { beats: 0.5,  rest: true,  strong: false },
      { beats: 0.5,  rest: false, strong: false },
      { beats: 1,    rest: false, strong: true },
      { beats: 0.5,  rest: true,  strong: false },
      { beats: 0.5,  rest: false, strong: false },
    ],
    // チョーキング風ロングトーン後の連打
    [
      { beats: 2,    rest: false, strong: true },
      { beats: 0.5,  rest: false, strong: false },
      { beats: 0.5,  rest: false, strong: false },
      { beats: 0.5,  rest: false, strong: true },
      { beats: 0.5,  rest: false, strong: false },
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
    // バップ風 8 分連 (フレーズ走り)
    [
      { beats: 0.5,  rest: false, strong: true },
      { beats: 0.5,  rest: false, strong: false },
      { beats: 0.5,  rest: false, strong: false },
      { beats: 0.5,  rest: false, strong: false },
      { beats: 0.5,  rest: false, strong: true },
      { beats: 0.5,  rest: false, strong: false },
      { beats: 0.5,  rest: false, strong: false },
      { beats: 0.5,  rest: false, strong: false },
    ],
    // 4 分 + 4 分 + 8 分裏 (会話的)
    [
      { beats: 1,    rest: false, strong: true },
      { beats: 1,    rest: false, strong: false },
      { beats: 0.5,  rest: true,  strong: false },
      { beats: 0.5,  rest: false, strong: true },
      { beats: 1,    rest: false, strong: false },
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
    case "break": return { lo: 60, hi: 72, vel: 0.4 };   // ほぼ無音 + 終わりにヒント
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

  // セクション kind ごとの「最初に作ったメロディ」memo。
  // Verse1 を生成したら Verse2 / Verse3 は同じメロディ (rhythm + 音高) を
  // そのまま使う。Chorus も同様 (= サビのフックが毎回同じになる)。
  // keyOffsetSemitones が違うセクション (= 転調済みサビ) には、その差分を加算して使う。
  interface MemoNote {
    midi: number;          // 初出時に鳴った絶対 MIDI
    offsetInBarSec: number; // 小節先頭からのオフセット (秒)
    durSec: number;
    velocity: number;
  }
  interface SectionMemo {
    bars: MemoNote[][];           // 各小節のノート列
    keyOffsetSemitones: number;   // memo を作ったときの転調量
  }
  const memos = new Map<SectionKind, SectionMemo>();

  // セクションが切り替わったときに「セクション内何小節目か」を 0 に戻すための追跡
  let curSec: SongSection | null = null;
  let barInSec = 0;

  // ===== モチーフ構造 (Phase 4b) =====
  // Verse / Chorus / PreChorus の最初の 2 小節を「モチーフ」(A, B) として記録し、
  // 3 小節目以降は motif[(barInSec) % 2] の "形" (リズム slots + コードルート相対音程)
  // を、現小節のコードルートに合わせて再生する。
  // 結果: 4 小節セクションは A B A B' の形 (call & response) になる。
  // memo は最終的に "確定したメロディ" を Verse2 用に保存するので
  // モチーフ展開済みのメロディが Verse2 でも一字一句再現される。
  interface MotifNote {
    slotIndex: number;
    semitonesFromRoot: number; // 記録時のコードルートからの差分 (絶対 MIDI - chordRoot)
  }
  interface MotifBar {
    slots: typeof patterns[number]; // この小節のリズム (motif 全体で固定)
    notes: MotifNote[];             // 鳴った音の相対音程
  }
  const motifMap = new Map<SectionKind, MotifBar[]>();

  for (let bar = 0; bar < chords.length; bar++) {
    const sec = sectionAtBar(sections, bar);
    if (curSec !== sec) {
      curSec = sec;
      barInSec = 0;
    }
    const isRepeatableKind =
      sec.kind === "verse" || sec.kind === "preChorus" || sec.kind === "chorus";
    const memo = isRepeatableKind ? memos.get(sec.kind) : undefined;
    const isReplay = !!memo;

    const { lo, hi, vel } = melodyRangeFor(sec.kind);
    // 転調セクション中はそのキーのスケール音だけ使う (= 音外し防止)
    const localScale = transposeScale(scale, sec.keyOffsetSemitones);
    const range = scaleTonesInRange(localScale, lo, hi);
    if (range.length === 0) {
      if (isRepeatableKind) barInSec++;
      continue;
    }

    const chord = chords[bar];
    const chordTones = chordVoicing(chord, 48);
    const chordPCs = new Set(chordTones.map((m) => m % 12));

    // ----- 再現モード: 保存済みメロディを転調差分だけずらして再生 ---------
    if (isReplay && barInSec < memo!.bars.length) {
      const transpose = sec.keyOffsetSemitones - memo!.keyOffsetSemitones;
      const barStart = bar * 4 * beatSec;
      const notesOfBar = memo!.bars[barInSec];
      for (const n of notesOfBar) {
        const m = n.midi + transpose;
        events.push({
          midi: m,
          startSec: barStart + n.offsetInBarSec,
          durationSec: n.durSec,
          velocity: n.velocity,
        });
        prevMidi = m;
      }
      barInSec++;
      continue;
    }

    // break セクションはメロディも基本休む。最後の小節 4 拍裏に
    // 「サビへ戻る」ピックアップだけ置いて余韻を作る。
    if (sec.kind === "break") {
      const beatSecLocal = 60 / bpm;
      const isLast = isSectionLastBar(sec, bar);
      if (isLast) {
        const barStart = bar * 4 * beatSecLocal;
        const pickup = pick(range.filter((m) => chordPCs.has(m % 12)), rng)
          ?? range[Math.floor(range.length / 2)];
        events.push({
          midi: pickup,
          startSec: barStart + 3.5 * beatSecLocal,
          durationSec: 0.5 * beatSecLocal * 0.9,
          velocity: 0.6,
        });
        prevMidi = pickup;
      }
      continue;
    }

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

    // ---- モチーフ slots 解決 ----
    // 0/1 小節目: 新規 slots を pick して motif に記録
    // 2 小節目以降: motif[(barInSec) % 2].slots を再利用 (リズム形を保つ)
    const isMotifSec = isRepeatableKind && !memo;
    let motifList = isMotifSec ? motifMap.get(sec.kind) : undefined;
    if (isMotifSec && !motifList) {
      motifList = [];
      motifMap.set(sec.kind, motifList);
    }
    let slots: typeof patterns[number];
    let motifBarForRecord: MotifBar | null = null;
    let motifBarForReplay: MotifBar | null = null;
    if (isMotifSec && barInSec < 2) {
      slots = pick(patterns, rng);
      motifBarForRecord = { slots, notes: [] };
      motifList!.push(motifBarForRecord);
    } else if (isMotifSec && motifList && motifList.length >= 2) {
      motifBarForReplay = motifList[barInSec % 2];
      slots = motifBarForReplay.slots;
    } else {
      slots = pick(patterns, rng);
    }

    const barStart = bar * 4 * beatSec;
    let t = barStart;

    const totalBeats = slots.reduce((a, s) => a + s.beats, 0);
    const beatScale = 4 / totalBeats;
    const chordRoot = chordTones[0];

    // ----- memo 書き込み準備: このセクション kind を初めて生成するなら memo を作る ---
    let recordBar: MemoNote[] | null = null;
    if (isRepeatableKind && !memo) {
      let m = memos.get(sec.kind);
      if (!m) {
        m = { bars: [], keyOffsetSemitones: sec.keyOffsetSemitones };
        memos.set(sec.kind, m);
      }
      // 小節を末尾追加 (Verse1 を 0,1,2,... と順に記録していく)
      while (m.bars.length <= barInSec) m.bars.push([]);
      recordBar = m.bars[barInSec];
    }

    // ===== モチーフ B' 変奏 (Phase 5) =====
    // バー 3 (= 4 小節セクションの最終小節、motif B の繰り返し位置) では
    // 機械的な literal 再生ではなく、後半 ~40% の音を「スケール tonic への
    // カデンツ的下降 (or 上昇) 進行」に置き換える。
    // これにより A B A B' の "B'" 部分が解決感を持ち、繰り返しの単調さを抑える。
    // Verse1 の bar 3 で生成した B' は memo されるので、Verse2 でも同じ B' が鳴る。
    const isBPrime = !!motifBarForReplay && barInSec === 3 && isLastInSec;
    const bPrimeStartSlot = isBPrime ? Math.floor(slots.length * 0.6) : -1;
    // 現在のキー (localScale) のトニックを range 内で見つける
    let tonicTarget: number | null = null;
    if (isBPrime) {
      const ts = range.filter((m) => m % 12 === localScale.rootPitchClass);
      if (ts.length > 0) {
        // メロディ範囲の中央寄りのオクターブを選ぶ
        tonicTarget = ts[Math.floor(ts.length / 2)];
      }
    }
    // range 上で prev から方向 dir に 1 ステップ動いた音を返す
    function stepInScaleRange(prev: number, dir: number): number {
      const idx = range.indexOf(prev);
      if (idx === -1) {
        // range にない (絶対あり得ないが念のため): 最も近い range 値
        let best = range[0];
        let bd = Math.abs(best - prev);
        for (const r of range) {
          const d = Math.abs(r - prev);
          if (d < bd) { best = r; bd = d; }
        }
        return best;
      }
      const ni = Math.max(0, Math.min(range.length - 1, idx + dir));
      return range[ni];
    }

    // ===== 直近 2 音追跡 (anti-stagnation 用) =====
    let recentSame = 0; // 直近で prevMidi と同じ音を何回続けて鳴らしたか
    let lastDelta: number | null = null; // 直前のジャンプ量 (leap recovery 用)

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
      // モチーフ再生: 記録された semitonesFromRoot を現在の chordRoot に当てて再生。
      // 範囲外なら 1 オクターブずらして range 内に収める。
      let motifReplayPitch: number | null = null;
      if (motifBarForReplay) {
        const rec = motifBarForReplay.notes.find((n) => n.slotIndex === i);
        if (rec) {
          let m = chordRoot + rec.semitonesFromRoot;
          while (m < lo) m += 12;
          while (m > hi) m -= 12;
          if (m >= lo && m <= hi) {
            // セクション最後の小節の最終 slot は「解決音」(コードトーン) に寄せる
            if (isLastInSec && i === slots.length - 1) {
              const resolves = range.filter((rm) => chordPCs.has(rm % 12));
              if (resolves.length > 0) {
                let best = resolves[0];
                let bestD = Math.abs(best - m);
                for (const r of resolves) {
                  const d = Math.abs(r - m);
                  if (d < bestD) { best = r; bestD = d; }
                }
                m = best;
              }
            }
            motifReplayPitch = m;
          }
        }
        // ----- B' 変奏: 後半 slot を tonic 方向のスケール step に置換 -----
        if (isBPrime && i >= bPrimeStartSlot && tonicTarget !== null) {
          if (i === slots.length - 1) {
            motifReplayPitch = tonicTarget;
          } else if (prevMidi != null) {
            const dir = tonicTarget > prevMidi ? 1 : tonicTarget < prevMidi ? -1 : 0;
            motifReplayPitch = dir === 0 ? prevMidi : stepInScaleRange(prevMidi, dir);
          }
        }
      }
      // Chorus 1 小節目の頭は「フック」として、高めのコードトーンから始める。
      // これが memo されて、以降の全 Chorus でも同じ高い始まり方になる。
      const isChorusHookOpener =
        sec.kind === "chorus" && barInSec === 0 && i === 0 && !isReplay;
      if (motifReplayPitch !== null) {
        pickMidi = motifReplayPitch;
      } else if (isChorusHookOpener) {
        const hookCands = range.filter((m) => chordPCs.has(m % 12) && m >= 72); // C5 以上
        const fallback = range.filter((m) => chordPCs.has(m % 12));
        const src = hookCands.length > 0 ? hookCands : (fallback.length > 0 ? fallback : range);
        pickMidi = src[Math.floor(src.length * 0.7)] ?? src[src.length - 1];
      } else if (prevMidi === null) {
        // 最初は中央付近のコードトーン
        const mids = candidates.filter((m) => chordPCs.has(m % 12));
        pickMidi = (mids.length > 0 ? mids : candidates)[
          Math.floor((mids.length > 0 ? mids.length : candidates.length) / 2)
        ];
      } else {
        // フレーズの形: アーチ contour (前半 climb, 中盤 peak, 後半 descend)
        // peak を 60% 位置に置くことで「自然な弧」を作る。
        const phasePos = (i / Math.max(1, slots.length - 1)); // 0..1
        const peakPos = 0.6;
        const climbBias = phasePos < peakPos ? +0.45 : -0.45;
        // ===== leap recovery: 直前が大きく跳ねたら逆方向 step を強制バイアス =====
        const leapRecoverDir =
          lastDelta != null && Math.abs(lastDelta) >= 5
            ? (lastDelta > 0 ? -1 : +1)
            : 0;
        const weights = candidates.map((m) => {
          const d = m - (prevMidi as number);
          const ad = Math.abs(d);
          // ステップワイズ優先 (±2 半音内が最大)
          let w = ad === 0 ? 0.30 : ad > 9 ? 0.02 : ad > 5 ? 0.18 : ad > 2 ? 0.55 : 1.0;
          // セクション形に沿った方向バイアス
          if ((climbBias > 0 && d > 0) || (climbBias < 0 && d < 0)) w *= 1.4;
          // leap recovery: 直前が leap なら逆方向 step を大きく押し上げる
          if (leapRecoverDir !== 0 && d !== 0) {
            const sameDir = (leapRecoverDir > 0 && d > 0) || (leapRecoverDir < 0 && d < 0);
            if (sameDir && ad <= 3) w *= 2.4;
            else if (!sameDir && ad > 4) w *= 0.15;
          }
          // 直前と同じ音が 2 回以上続いたら 3 回目は強く抑制
          if (recentSame >= 1 && d === 0) w *= 0.05;
          // 弱拍で「コードトーンへの半音/全音アプローチ」を加点 (passing/neighbor)
          if (!slot.strong && !chordPCs.has(m % 12) && ad <= 2 && ad >= 1) {
            w *= 1.3;
          }
          // 強拍がコードトーンの場合、prev から近いコードトーンを優先
          if (slot.strong && chordPCs.has(m % 12)) {
            if (ad <= 4) w *= 1.5;
          }
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
      // memo に記録 (Verse2 で同じフレーズを再生するため)
      if (recordBar) {
        recordBar.push({
          midi: pickMidi,
          offsetInBarSec: t - barStart,
          durSec: dur,
          velocity: v,
        });
      }
      // モチーフバンクに記録 (このセクションの 2 小節目以降で再利用)
      if (motifBarForRecord) {
        motifBarForRecord.notes.push({
          slotIndex: i,
          semitonesFromRoot: pickMidi - chordRoot,
        });
      }
      // leap recovery / anti-stagnation 用の追跡更新
      if (prevMidi != null) {
        lastDelta = pickMidi - prevMidi;
        if (pickMidi === prevMidi) recentSame++;
        else recentSame = 0;
      }
      prevMidi = pickMidi;
      t += slotDurSec;
    }

    if (isRepeatableKind) barInSec++;
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

    // ブレイク: 1 拍目に 1 発スタブだけ落として、あとは無音。
    if (sec.kind === "break") {
      for (const m of voicing.slice(0, 3)) {
        out.push({
          midi: m,
          startSec: barStart,
          durationSec: beatSec * 0.4,
          velocity: 0.55,
        });
      }
      continue;
    }

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
// エレキギター層 (リフベース)
// 「コードルートからの半音オフセット + 拍位置 + ボイシング種別」のリフを
// ライブラリとして持ち、コードが変わるたびに root だけ差し替えて
// 同じリフを反復する → ジャンルらしい "フック" を作る。
// ---------------------------------------------------------------------------

/**
 * リフ 1 音分の指示。
 * semitonesFromRoot は「現在の小節のコードルート」からの半音差。
 * 5 = 完全 4 度上、7 = 完全 5 度上、10 = 短 7 度、12 = オクターブ上。
 *
 * voicing:
 *   "single"        → その 1 音だけ (ソロライン)
 *   "power"         → root + 5th + octave (3rd 抜き) を semitonesFromRoot で平行移動
 *   "full"          → コード全和音 (4 音) を上にスタック
 *   "octaveUnison"  → 単音 + その 1 オクターブ上 (ロックのオクターブ・ライン)
 *   "double5"       → 単音 + 完全 5 度上 (ダブルストップ、ロックソロ感)
 *   "double3"       → 単音 + 短 3 度上 (ブルーノート・ダブルストップ)
 *   "mute"          → パワーコードだが極短かつ弱め (パームミュート相当の "ズク")
 *   "stab"          → コード全和音だが極短 (16 分以下)。ファンキースタブ
 *
 * graceBefore:
 *   -1 を指定すると、開始 1/16 拍前に半音下から滑り込む擬似スライド音を 1 つ前置く。
 *   +1 で半音上から (Half-Step Slide Down)。0/省略でなし。
 */
type RiffVoicing =
  | "single"
  | "power"
  | "full"
  | "octaveUnison"
  | "double5"
  | "double3"
  | "mute"
  | "stab";

interface RiffNote {
  semitonesFromRoot: number;
  startBeat: number;       // 0..4
  durationBeats: number;
  velocityScale: number;   // 0..1
  voicing: RiffVoicing;
  graceBefore?: -1 | 1;
}

interface GuitarRiff {
  /** フレーズの小節長 (通常 1 or 2)。bar % barsLength でどの bar を使うか決まる。 */
  barsLength: number;
  notesPerBar: RiffNote[][];
}

const EMPTY_RIFF: GuitarRiff = { barsLength: 1, notesPerBar: [[]] };

/**
 * セクションごとのギターの役割。メリハリを出すため、1 セクションは原則
 * 1 つの役割だけを担当する。
 *
 *   "chord"  → リズム/バッキング担当。power, full, stab, mute をメインに使い、
 *              コード進行を縦に刻んで楽曲を支える (= かっこよさを和音で出す)。
 *   "phrase" → リード/フレーズ担当。single, double5, double3, octaveUnison を
 *              メインに使い、横ラインで聴き手を魅せる (= メロディで歌う)。
 *
 * 多くのスタイルで Verse/Chorus = chord (土台)、Pre-Chorus/Bridge = phrase
 * (盛り上げ/対比) という配置にし、リスナーに役割の変化を感じさせる。
 * Ballad だけは Verse もアルペジオの phrase 担当にして「歌の伴奏」感を出す。
 */
type GuitarRole = "chord" | "phrase";
const GUITAR_ROLE: Record<ComposerStyle, Record<SectionKind, GuitarRole>> = {
  rock:   { intro: "chord", verse: "chord",  preChorus: "phrase", chorus: "chord", bridge: "phrase", break: "chord", outro: "chord" },
  pop:    { intro: "chord", verse: "chord",  preChorus: "phrase", chorus: "chord", bridge: "phrase", break: "chord", outro: "chord" },
  ballad: { intro: "phrase", verse: "phrase", preChorus: "phrase", chorus: "chord", bridge: "phrase", break: "chord", outro: "chord" },
  jazz:   { intro: "chord", verse: "chord",  preChorus: "phrase", chorus: "chord", bridge: "phrase", break: "chord", outro: "chord" },
};

/**
 * ロック:
 *  [chord]  Intro/Verse/Chorus/Outro = パワーコード + パームミュートのみ (ズンズンチャン)
 *  [phrase] Pre-Chorus/Bridge = single + double5 + octaveUnison のペンタトニック・リード
 *
 * 役割純化: 1 セクション内で voicing 集合を混在させない。
 *   chord  → power, mute
 *   phrase → single, double5, octaveUnison
 */
const ROCK_RIFFS: Record<SectionKind, GuitarRiff> = {
  // [chord] Intro: 長めのパワーコード + 後半にパームミュートでアプローチ
  intro: { barsLength: 1, notesPerBar: [[
    { semitonesFromRoot: 0, startBeat: 0.00, durationBeats: 2.4,  velocityScale: 0.7,  voicing: "power" },
    { semitonesFromRoot: 0, startBeat: 2.50, durationBeats: 0.22, velocityScale: 0.5,  voicing: "mute" },
    { semitonesFromRoot: 0, startBeat: 2.75, durationBeats: 0.22, velocityScale: 0.55, voicing: "mute" },
    { semitonesFromRoot: 0, startBeat: 3.00, durationBeats: 0.22, velocityScale: 0.6,  voicing: "mute" },
    { semitonesFromRoot: 0, startBeat: 3.25, durationBeats: 0.22, velocityScale: 0.65, voicing: "mute" },
    { semitonesFromRoot: 0, startBeat: 3.50, durationBeats: 0.45, velocityScale: 0.85, voicing: "power" },
  ]] },
  // [chord] Verse: 16 分パームミュート + 拍頭にパワーコードのアクセント
  // "ズク ズク ズク ジャン / ズク ズク ジャ・ジャン" の感じ — power と mute のみ
  verse: { barsLength: 2, notesPerBar: [
    [ // bar 1
      { semitonesFromRoot: 0, startBeat: 0.00, durationBeats: 0.45, velocityScale: 0.95, voicing: "power" },
      { semitonesFromRoot: 0, startBeat: 0.50, durationBeats: 0.22, velocityScale: 0.55, voicing: "mute" },
      { semitonesFromRoot: 0, startBeat: 0.75, durationBeats: 0.22, velocityScale: 0.55, voicing: "mute" },
      { semitonesFromRoot: 0, startBeat: 1.00, durationBeats: 0.22, velocityScale: 0.55, voicing: "mute" },
      { semitonesFromRoot: 0, startBeat: 1.50, durationBeats: 0.4,  velocityScale: 0.85, voicing: "power" },
      { semitonesFromRoot: 0, startBeat: 2.00, durationBeats: 0.45, velocityScale: 0.95, voicing: "power" },
      { semitonesFromRoot: 0, startBeat: 2.50, durationBeats: 0.22, velocityScale: 0.55, voicing: "mute" },
      { semitonesFromRoot: 0, startBeat: 2.75, durationBeats: 0.22, velocityScale: 0.6,  voicing: "mute" },
      { semitonesFromRoot: 0, startBeat: 3.00, durationBeats: 0.22, velocityScale: 0.55, voicing: "mute" },
      { semitonesFromRoot: 0, startBeat: 3.50, durationBeats: 0.45, velocityScale: 0.9,  voicing: "power" },
    ],
    [ // bar 2: 同じ骨格、後半にパームミュート連打で煽る
      { semitonesFromRoot: 0, startBeat: 0.00, durationBeats: 0.45, velocityScale: 0.95, voicing: "power" },
      { semitonesFromRoot: 0, startBeat: 0.50, durationBeats: 0.22, velocityScale: 0.55, voicing: "mute" },
      { semitonesFromRoot: 0, startBeat: 0.75, durationBeats: 0.22, velocityScale: 0.55, voicing: "mute" },
      { semitonesFromRoot: 0, startBeat: 1.00, durationBeats: 0.22, velocityScale: 0.6,  voicing: "mute" },
      { semitonesFromRoot: 0, startBeat: 1.50, durationBeats: 0.4,  velocityScale: 0.85, voicing: "power" },
      { semitonesFromRoot: 0, startBeat: 2.00, durationBeats: 0.22, velocityScale: 0.5,  voicing: "mute" },
      { semitonesFromRoot: 0, startBeat: 2.25, durationBeats: 0.22, velocityScale: 0.55, voicing: "mute" },
      { semitonesFromRoot: 0, startBeat: 2.50, durationBeats: 0.22, velocityScale: 0.6,  voicing: "mute" },
      { semitonesFromRoot: 0, startBeat: 2.75, durationBeats: 0.22, velocityScale: 0.65, voicing: "mute" },
      { semitonesFromRoot: 0, startBeat: 3.00, durationBeats: 0.45, velocityScale: 0.95, voicing: "power" },
      { semitonesFromRoot: 0, startBeat: 3.50, durationBeats: 0.45, velocityScale: 0.9,  voicing: "power" },
    ],
  ]},
  // [phrase] Pre-Chorus: ペンタトニック・リード — single + double5 + octaveUnison のみ
  // 16 分でオクターブ上昇 → 半音 grace で Chorus へ突入
  preChorus: { barsLength: 1, notesPerBar: [[
    { semitonesFromRoot: 0,  startBeat: 0.00, durationBeats: 0.22, velocityScale: 0.75, voicing: "octaveUnison" },
    { semitonesFromRoot: 3,  startBeat: 0.50, durationBeats: 0.22, velocityScale: 0.8,  voicing: "octaveUnison" },
    { semitonesFromRoot: 5,  startBeat: 1.00, durationBeats: 0.22, velocityScale: 0.85, voicing: "octaveUnison" },
    { semitonesFromRoot: 7,  startBeat: 1.25, durationBeats: 0.22, velocityScale: 0.7,  voicing: "single" },
    { semitonesFromRoot: 5,  startBeat: 1.50, durationBeats: 0.22, velocityScale: 0.8,  voicing: "octaveUnison" },
    { semitonesFromRoot: 7,  startBeat: 1.75, durationBeats: 0.22, velocityScale: 0.7,  voicing: "double5" },
    { semitonesFromRoot: 7,  startBeat: 2.00, durationBeats: 0.4,  velocityScale: 0.9,  voicing: "octaveUnison" },
    { semitonesFromRoot: 10, startBeat: 2.50, durationBeats: 0.4,  velocityScale: 0.85, voicing: "octaveUnison" },
    { semitonesFromRoot: 11, startBeat: 3.00, durationBeats: 0.22, velocityScale: 0.8,  voicing: "single", graceBefore: -1 },
    { semitonesFromRoot: 12, startBeat: 3.25, durationBeats: 0.22, velocityScale: 0.9,  voicing: "octaveUnison" },
    { semitonesFromRoot: 12, startBeat: 3.50, durationBeats: 0.45, velocityScale: 1.0,  voicing: "octaveUnison" },
  ]] },
  // [chord] Chorus: アンセム的にパワーコードを 8 分で押し出す + 16 分パームミュート
  chorus: { barsLength: 2, notesPerBar: [
    [ // bar 1: 8 分でジャーン・ジャーン と支え、間にミュート
      { semitonesFromRoot: 0, startBeat: 0.00, durationBeats: 0.45, velocityScale: 0.95, voicing: "power" },
      { semitonesFromRoot: 0, startBeat: 0.50, durationBeats: 0.22, velocityScale: 0.55, voicing: "mute" },
      { semitonesFromRoot: 0, startBeat: 0.75, durationBeats: 0.22, velocityScale: 0.55, voicing: "mute" },
      { semitonesFromRoot: 0, startBeat: 1.00, durationBeats: 0.45, velocityScale: 0.9,  voicing: "power" },
      { semitonesFromRoot: 0, startBeat: 1.50, durationBeats: 0.4,  velocityScale: 0.85, voicing: "power" },
      { semitonesFromRoot: 0, startBeat: 2.00, durationBeats: 0.45, velocityScale: 0.95, voicing: "power" },
      { semitonesFromRoot: 0, startBeat: 2.50, durationBeats: 0.22, velocityScale: 0.55, voicing: "mute" },
      { semitonesFromRoot: 0, startBeat: 2.75, durationBeats: 0.22, velocityScale: 0.55, voicing: "mute" },
      { semitonesFromRoot: 0, startBeat: 3.00, durationBeats: 0.45, velocityScale: 0.9,  voicing: "power" },
      { semitonesFromRoot: 0, startBeat: 3.50, durationBeats: 0.45, velocityScale: 0.95, voicing: "power" },
    ],
    [ // bar 2: 後半はパワーコード保持で「ジャーン」と着地
      { semitonesFromRoot: 0, startBeat: 0.00, durationBeats: 0.45, velocityScale: 0.95, voicing: "power" },
      { semitonesFromRoot: 0, startBeat: 0.50, durationBeats: 0.22, velocityScale: 0.55, voicing: "mute" },
      { semitonesFromRoot: 0, startBeat: 0.75, durationBeats: 0.22, velocityScale: 0.55, voicing: "mute" },
      { semitonesFromRoot: 0, startBeat: 1.00, durationBeats: 0.45, velocityScale: 0.9,  voicing: "power" },
      { semitonesFromRoot: 0, startBeat: 1.50, durationBeats: 0.4,  velocityScale: 0.85, voicing: "power" },
      { semitonesFromRoot: 0, startBeat: 2.00, durationBeats: 1.4,  velocityScale: 1.0,  voicing: "power" },
      { semitonesFromRoot: 0, startBeat: 3.50, durationBeats: 0.45, velocityScale: 0.75, voicing: "power" },
    ],
  ]},
  // [phrase] Bridge: ペンタトニック・ライン + grace (ハンマリング相当)
  // single + double5 + octaveUnison のみ
  bridge: { barsLength: 2, notesPerBar: [
    [
      { semitonesFromRoot: 0,  startBeat: 0.00, durationBeats: 0.4,  velocityScale: 0.85, voicing: "single" },
      { semitonesFromRoot: 3,  startBeat: 0.50, durationBeats: 0.22, velocityScale: 0.65, voicing: "single", graceBefore: -1 },
      { semitonesFromRoot: 5,  startBeat: 0.75, durationBeats: 0.4,  velocityScale: 0.8,  voicing: "single" },
      { semitonesFromRoot: 7,  startBeat: 1.25, durationBeats: 0.4,  velocityScale: 0.85, voicing: "double5", graceBefore: -1 },
      { semitonesFromRoot: 10, startBeat: 1.75, durationBeats: 0.4,  velocityScale: 0.8,  voicing: "single" },
      { semitonesFromRoot: 12, startBeat: 2.25, durationBeats: 0.4,  velocityScale: 0.95, voicing: "octaveUnison", graceBefore: -1 },
      { semitonesFromRoot: 10, startBeat: 2.75, durationBeats: 0.4,  velocityScale: 0.7,  voicing: "single" },
      { semitonesFromRoot: 7,  startBeat: 3.25, durationBeats: 0.6,  velocityScale: 0.85, voicing: "double5" },
    ],
    [
      { semitonesFromRoot: 12, startBeat: 0.00, durationBeats: 0.4,  velocityScale: 0.95, voicing: "octaveUnison" },
      { semitonesFromRoot: 10, startBeat: 0.50, durationBeats: 0.22, velocityScale: 0.7,  voicing: "single" },
      { semitonesFromRoot: 7,  startBeat: 0.75, durationBeats: 0.4,  velocityScale: 0.85, voicing: "double5" },
      { semitonesFromRoot: 5,  startBeat: 1.25, durationBeats: 0.22, velocityScale: 0.7,  voicing: "single", graceBefore: -1 },
      { semitonesFromRoot: 3,  startBeat: 1.50, durationBeats: 0.22, velocityScale: 0.65, voicing: "single" },
      { semitonesFromRoot: 5,  startBeat: 1.75, durationBeats: 0.4,  velocityScale: 0.8,  voicing: "double5" },
      { semitonesFromRoot: 7,  startBeat: 2.25, durationBeats: 0.4,  velocityScale: 0.85, voicing: "octaveUnison" },
      { semitonesFromRoot: 10, startBeat: 2.75, durationBeats: 0.4,  velocityScale: 0.8,  voicing: "single", graceBefore: -1 },
      { semitonesFromRoot: 12, startBeat: 3.00, durationBeats: 0.9,  velocityScale: 1.0,  voicing: "octaveUnison" },
    ],
  ]},
  break: EMPTY_RIFF,
  // [chord] Outro: フェードアウト的に長いパワーコード保持 + ミュートで間を埋める
  outro: { barsLength: 1, notesPerBar: [[
    { semitonesFromRoot: 0, startBeat: 0.0, durationBeats: 2.4, velocityScale: 0.7, voicing: "power" },
    { semitonesFromRoot: 0, startBeat: 2.5, durationBeats: 0.22, velocityScale: 0.5, voicing: "mute" },
    { semitonesFromRoot: 0, startBeat: 2.75, durationBeats: 0.22, velocityScale: 0.5, voicing: "mute" },
    { semitonesFromRoot: 0, startBeat: 3.0, durationBeats: 0.9, velocityScale: 0.5, voicing: "power" },
  ]] },
};

/**
 * ポップス: カッティング/ストラム + フックメロディ。
 *  [chord]  Intro/Verse/Chorus/Outro = full (ストラム) + stab (カッティング) のみ
 *  [phrase] Pre-Chorus/Bridge = single + double5 + octaveUnison のフックメロディ
 *
 * 役割純化: 1 セクション内で voicing 集合を混在させない。
 *   chord  → full, stab
 *   phrase → single, double5, octaveUnison
 */
const POP_RIFFS: Record<SectionKind, GuitarRiff> = {
  // [chord] Intro: 軽い full ストラムを 2 拍頭に + 残響を空ける
  intro: { barsLength: 1, notesPerBar: [[
    { semitonesFromRoot: 0, startBeat: 0.0, durationBeats: 1.6, velocityScale: 0.55, voicing: "full" },
    { semitonesFromRoot: 0, startBeat: 2.0, durationBeats: 0.22, velocityScale: 0.5,  voicing: "stab" },
    { semitonesFromRoot: 0, startBeat: 2.5, durationBeats: 0.22, velocityScale: 0.5,  voicing: "stab" },
    { semitonesFromRoot: 0, startBeat: 3.5, durationBeats: 0.22, velocityScale: 0.55, voicing: "stab" },
  ]] },
  // [chord] Verse: 16 分カッティング (stab) + 拍頭に full ストラム、空間を多く残す
  verse: { barsLength: 2, notesPerBar: [
    [
      { semitonesFromRoot: 0, startBeat: 0.0,  durationBeats: 0.45, velocityScale: 0.85, voicing: "full" },
      { semitonesFromRoot: 0, startBeat: 0.75, durationBeats: 0.18, velocityScale: 0.45, voicing: "stab" },
      { semitonesFromRoot: 0, startBeat: 1.0,  durationBeats: 0.22, velocityScale: 0.7,  voicing: "stab" },
      { semitonesFromRoot: 0, startBeat: 1.75, durationBeats: 0.18, velocityScale: 0.5,  voicing: "stab" },
      { semitonesFromRoot: 0, startBeat: 2.0,  durationBeats: 0.45, velocityScale: 0.85, voicing: "full" },
      { semitonesFromRoot: 0, startBeat: 2.75, durationBeats: 0.18, velocityScale: 0.45, voicing: "stab" },
      { semitonesFromRoot: 0, startBeat: 3.0,  durationBeats: 0.22, velocityScale: 0.7,  voicing: "stab" },
      { semitonesFromRoot: 0, startBeat: 3.5,  durationBeats: 0.18, velocityScale: 0.5,  voicing: "stab" },
    ],
    [ // bar 2: ストラム回数を増やしてサビへ寄せる
      { semitonesFromRoot: 0, startBeat: 0.0,  durationBeats: 0.45, velocityScale: 0.85, voicing: "full" },
      { semitonesFromRoot: 0, startBeat: 0.75, durationBeats: 0.18, velocityScale: 0.45, voicing: "stab" },
      { semitonesFromRoot: 0, startBeat: 1.0,  durationBeats: 0.22, velocityScale: 0.7,  voicing: "stab" },
      { semitonesFromRoot: 0, startBeat: 1.5,  durationBeats: 0.22, velocityScale: 0.6,  voicing: "stab" },
      { semitonesFromRoot: 0, startBeat: 2.0,  durationBeats: 0.45, velocityScale: 0.9,  voicing: "full" },
      { semitonesFromRoot: 0, startBeat: 2.5,  durationBeats: 0.22, velocityScale: 0.7,  voicing: "stab" },
      { semitonesFromRoot: 0, startBeat: 2.75, durationBeats: 0.18, velocityScale: 0.5,  voicing: "stab" },
      { semitonesFromRoot: 0, startBeat: 3.0,  durationBeats: 0.22, velocityScale: 0.75, voicing: "stab" },
      { semitonesFromRoot: 0, startBeat: 3.5,  durationBeats: 0.45, velocityScale: 0.9,  voicing: "full" },
    ],
  ]},
  // [phrase] Pre-Chorus: オクターブの跳ね + 9th (14) で空気感を持ち上げる
  preChorus: { barsLength: 1, notesPerBar: [[
    { semitonesFromRoot: 12, startBeat: 0.0, durationBeats: 0.4, velocityScale: 0.8,  voicing: "single" },
    { semitonesFromRoot: 7,  startBeat: 0.5, durationBeats: 0.4, velocityScale: 0.65, voicing: "single" },
    { semitonesFromRoot: 12, startBeat: 1.0, durationBeats: 0.4, velocityScale: 0.85, voicing: "octaveUnison" },
    { semitonesFromRoot: 14, startBeat: 1.5, durationBeats: 0.4, velocityScale: 0.7,  voicing: "single", graceBefore: -1 },
    { semitonesFromRoot: 12, startBeat: 2.0, durationBeats: 0.4, velocityScale: 0.9,  voicing: "octaveUnison" },
    { semitonesFromRoot: 14, startBeat: 2.5, durationBeats: 0.4, velocityScale: 0.75, voicing: "double5" },
    { semitonesFromRoot: 16, startBeat: 3.0, durationBeats: 0.4, velocityScale: 0.95, voicing: "single", graceBefore: -1 },
    { semitonesFromRoot: 12, startBeat: 3.5, durationBeats: 0.4, velocityScale: 0.85, voicing: "octaveUnison" },
  ]] },
  // [chord] Chorus: 拍頭に full ストラム + 間に 16 分 stab でフック (パワフルなバッキング)
  chorus: { barsLength: 2, notesPerBar: [
    [
      { semitonesFromRoot: 0, startBeat: 0.0,  durationBeats: 0.45, velocityScale: 0.95, voicing: "full" },
      { semitonesFromRoot: 0, startBeat: 0.5,  durationBeats: 0.22, velocityScale: 0.7,  voicing: "stab" },
      { semitonesFromRoot: 0, startBeat: 0.75, durationBeats: 0.18, velocityScale: 0.55, voicing: "stab" },
      { semitonesFromRoot: 0, startBeat: 1.0,  durationBeats: 0.45, velocityScale: 0.85, voicing: "full" },
      { semitonesFromRoot: 0, startBeat: 1.5,  durationBeats: 0.22, velocityScale: 0.7,  voicing: "stab" },
      { semitonesFromRoot: 0, startBeat: 2.0,  durationBeats: 0.45, velocityScale: 0.95, voicing: "full" },
      { semitonesFromRoot: 0, startBeat: 2.5,  durationBeats: 0.22, velocityScale: 0.7,  voicing: "stab" },
      { semitonesFromRoot: 0, startBeat: 2.75, durationBeats: 0.18, velocityScale: 0.55, voicing: "stab" },
      { semitonesFromRoot: 0, startBeat: 3.0,  durationBeats: 0.45, velocityScale: 0.85, voicing: "full" },
      { semitonesFromRoot: 0, startBeat: 3.5,  durationBeats: 0.22, velocityScale: 0.75, voicing: "stab" },
    ],
    [ // bar 2: 後半に full ストラムを長く伸ばして締める
      { semitonesFromRoot: 0, startBeat: 0.0,  durationBeats: 0.45, velocityScale: 0.95, voicing: "full" },
      { semitonesFromRoot: 0, startBeat: 0.5,  durationBeats: 0.22, velocityScale: 0.7,  voicing: "stab" },
      { semitonesFromRoot: 0, startBeat: 0.75, durationBeats: 0.18, velocityScale: 0.55, voicing: "stab" },
      { semitonesFromRoot: 0, startBeat: 1.0,  durationBeats: 0.45, velocityScale: 0.85, voicing: "full" },
      { semitonesFromRoot: 0, startBeat: 1.5,  durationBeats: 0.22, velocityScale: 0.7,  voicing: "stab" },
      { semitonesFromRoot: 0, startBeat: 2.0,  durationBeats: 1.4,  velocityScale: 0.9,  voicing: "full" },
      { semitonesFromRoot: 0, startBeat: 3.5,  durationBeats: 0.45, velocityScale: 0.7,  voicing: "full" },
    ],
  ]},
  // [phrase] Bridge: ハイポジ single + double5 + オクターブの会話的フック
  bridge: { barsLength: 1, notesPerBar: [[
    { semitonesFromRoot: 12, startBeat: 0.0, durationBeats: 0.4, velocityScale: 0.85, voicing: "octaveUnison" },
    { semitonesFromRoot: 14, startBeat: 0.5, durationBeats: 0.4, velocityScale: 0.7,  voicing: "single", graceBefore: -1 },
    { semitonesFromRoot: 12, startBeat: 1.0, durationBeats: 0.4, velocityScale: 0.8,  voicing: "double5" },
    { semitonesFromRoot: 9,  startBeat: 1.5, durationBeats: 0.4, velocityScale: 0.7,  voicing: "single" },
    { semitonesFromRoot: 14, startBeat: 2.0, durationBeats: 0.4, velocityScale: 0.85, voicing: "double5", graceBefore: -1 },
    { semitonesFromRoot: 12, startBeat: 2.5, durationBeats: 0.4, velocityScale: 0.75, voicing: "single" },
    { semitonesFromRoot: 16, startBeat: 3.0, durationBeats: 0.4, velocityScale: 0.9,  voicing: "octaveUnison", graceBefore: -1 },
    { semitonesFromRoot: 12, startBeat: 3.5, durationBeats: 0.4, velocityScale: 0.8,  voicing: "single" },
  ]] },
  break: EMPTY_RIFF,
  // [chord] Outro: 長い full ストラムを 2 回でフェードアウト
  outro: { barsLength: 1, notesPerBar: [[
    { semitonesFromRoot: 0, startBeat: 0.0, durationBeats: 1.8, velocityScale: 0.6, voicing: "full" },
    { semitonesFromRoot: 0, startBeat: 2.0, durationBeats: 1.8, velocityScale: 0.5, voicing: "full" },
  ]] },
};

/**
 * バラード: 繊細なアルペジオ/メロディ + サビでフル和音の支え。
 *  [phrase] Intro/Verse/Pre-Chorus/Bridge = single + double5 のアルペジオ・メロディ
 *  [chord]  Chorus/Outro = full ストラムのみ
 *
 * 役割純化: 1 セクション内で voicing 集合を混在させない。
 *   chord  → full
 *   phrase → single, double5
 */
const BALLAD_RIFFS: Record<SectionKind, GuitarRiff> = {
  // [phrase] Intro: 静かな単音アルペジオ (root → 5 → octave → 5)
  intro: { barsLength: 1, notesPerBar: [[
    { semitonesFromRoot: 0,  startBeat: 0.0, durationBeats: 0.95, velocityScale: 0.4,  voicing: "single" },
    { semitonesFromRoot: 7,  startBeat: 1.0, durationBeats: 0.95, velocityScale: 0.4,  voicing: "single" },
    { semitonesFromRoot: 12, startBeat: 2.0, durationBeats: 0.95, velocityScale: 0.45, voicing: "single" },
    { semitonesFromRoot: 7,  startBeat: 3.0, durationBeats: 0.95, velocityScale: 0.4,  voicing: "single" },
  ]] },
  // [phrase] Verse: 8 分上昇アルペジオ
  verse: { barsLength: 1, notesPerBar: [[
    { semitonesFromRoot: 0,  startBeat: 0.0, durationBeats: 0.45, velocityScale: 0.5,  voicing: "single" },
    { semitonesFromRoot: 7,  startBeat: 0.5, durationBeats: 0.45, velocityScale: 0.45, voicing: "single" },
    { semitonesFromRoot: 12, startBeat: 1.0, durationBeats: 0.45, velocityScale: 0.55, voicing: "single" },
    { semitonesFromRoot: 16, startBeat: 1.5, durationBeats: 0.45, velocityScale: 0.5,  voicing: "single" },
    { semitonesFromRoot: 19, startBeat: 2.0, durationBeats: 0.45, velocityScale: 0.55, voicing: "single" },
    { semitonesFromRoot: 16, startBeat: 2.5, durationBeats: 0.45, velocityScale: 0.5,  voicing: "single" },
    { semitonesFromRoot: 12, startBeat: 3.0, durationBeats: 0.45, velocityScale: 0.5,  voicing: "single" },
    { semitonesFromRoot: 7,  startBeat: 3.5, durationBeats: 0.45, velocityScale: 0.45, voicing: "single" },
  ]] },
  // [phrase] Pre-Chorus: 高音メロディ + 半音アプローチ (grace) で歌の盛り上がりを誘導
  preChorus: { barsLength: 1, notesPerBar: [[
    { semitonesFromRoot: 12, startBeat: 0.0, durationBeats: 0.9, velocityScale: 0.55, voicing: "double5" },
    { semitonesFromRoot: 14, startBeat: 1.0, durationBeats: 0.4, velocityScale: 0.5,  voicing: "single", graceBefore: -1 },
    { semitonesFromRoot: 12, startBeat: 1.5, durationBeats: 0.4, velocityScale: 0.55, voicing: "single" },
    { semitonesFromRoot: 16, startBeat: 2.0, durationBeats: 0.4, velocityScale: 0.6,  voicing: "single", graceBefore: -1 },
    { semitonesFromRoot: 14, startBeat: 2.5, durationBeats: 0.4, velocityScale: 0.55, voicing: "single" },
    { semitonesFromRoot: 19, startBeat: 3.0, durationBeats: 0.9, velocityScale: 0.65, voicing: "double5", graceBefore: -1 },
  ]] },
  // [chord] Chorus: フル和音支えのみ (リリカルなストラム保持)
  chorus: { barsLength: 2, notesPerBar: [
    [
      { semitonesFromRoot: 0, startBeat: 0.0, durationBeats: 1.9, velocityScale: 0.7,  voicing: "full" },
      { semitonesFromRoot: 0, startBeat: 2.0, durationBeats: 1.9, velocityScale: 0.65, voicing: "full" },
    ],
    [
      { semitonesFromRoot: 0, startBeat: 0.0, durationBeats: 1.9, velocityScale: 0.7,  voicing: "full" },
      { semitonesFromRoot: 0, startBeat: 2.0, durationBeats: 0.9, velocityScale: 0.6,  voicing: "full" },
      { semitonesFromRoot: 0, startBeat: 3.0, durationBeats: 0.9, velocityScale: 0.65, voicing: "full" },
    ],
  ]},
  // [phrase] Bridge: 静かな単音アルペジオ
  bridge: { barsLength: 1, notesPerBar: [[
    { semitonesFromRoot: 0,  startBeat: 0.0, durationBeats: 0.9, velocityScale: 0.45, voicing: "single" },
    { semitonesFromRoot: 5,  startBeat: 1.0, durationBeats: 0.9, velocityScale: 0.4,  voicing: "single", graceBefore: -1 },
    { semitonesFromRoot: 7,  startBeat: 2.0, durationBeats: 0.9, velocityScale: 0.5,  voicing: "double5" },
    { semitonesFromRoot: 12, startBeat: 3.0, durationBeats: 0.9, velocityScale: 0.55, voicing: "single", graceBefore: -1 },
  ]] },
  break: EMPTY_RIFF,
  // [chord] Outro: 長い full 1 発で締める
  outro: { barsLength: 1, notesPerBar: [[
    { semitonesFromRoot: 0, startBeat: 0.0, durationBeats: 3.8, velocityScale: 0.4, voicing: "full" },
  ]] },
};

/**
 * ジャズ: Freddie Green 4 ビートコンプ + ウォーキング/ビバップライン。
 *  [chord]  Intro/Verse/Chorus/Outro = stab + full のみ (4 ビートコンプ)
 *  [phrase] Pre-Chorus/Bridge = single のみ (ウォーキング/ビバップライン)
 *
 * 役割純化: 1 セクション内で voicing 集合を混在させない。
 *   chord  → stab, full
 *   phrase → single
 */
const JAZZ_RIFFS: Record<SectionKind, GuitarRiff> = {
  // [chord] Intro: 軽い 4 ビート stab で導入
  intro: { barsLength: 1, notesPerBar: [[
    { semitonesFromRoot: 0, startBeat: 0.0, durationBeats: 0.35, velocityScale: 0.45, voicing: "stab" },
    { semitonesFromRoot: 0, startBeat: 1.0, durationBeats: 0.35, velocityScale: 0.4,  voicing: "stab" },
    { semitonesFromRoot: 0, startBeat: 2.0, durationBeats: 0.35, velocityScale: 0.45, voicing: "stab" },
    { semitonesFromRoot: 0, startBeat: 3.0, durationBeats: 0.35, velocityScale: 0.5,  voicing: "stab" },
  ]] },
  // [chord] Verse: Freddie Green 4 ビート (各拍に短い stab)。bar2 にシンコペ + 拍頭の full アクセント
  verse: { barsLength: 2, notesPerBar: [
    [
      { semitonesFromRoot: 0, startBeat: 0.0, durationBeats: 0.32, velocityScale: 0.55, voicing: "stab" },
      { semitonesFromRoot: 0, startBeat: 1.0, durationBeats: 0.32, velocityScale: 0.45, voicing: "stab" },
      { semitonesFromRoot: 0, startBeat: 2.0, durationBeats: 0.32, velocityScale: 0.55, voicing: "stab" },
      { semitonesFromRoot: 0, startBeat: 3.0, durationBeats: 0.32, velocityScale: 0.5,  voicing: "stab" },
    ],
    [ // bar 2: 1 拍目に full アクセント + 3 拍裏にシンコペ stab
      { semitonesFromRoot: 0, startBeat: 0.0, durationBeats: 0.4,  velocityScale: 0.65, voicing: "full" },
      { semitonesFromRoot: 0, startBeat: 1.0, durationBeats: 0.32, velocityScale: 0.45, voicing: "stab" },
      { semitonesFromRoot: 0, startBeat: 2.0, durationBeats: 0.32, velocityScale: 0.55, voicing: "stab" },
      { semitonesFromRoot: 0, startBeat: 2.5, durationBeats: 0.32, velocityScale: 0.5,  voicing: "stab" }, // シンコペ
      { semitonesFromRoot: 0, startBeat: 3.0, durationBeats: 0.32, velocityScale: 0.55, voicing: "stab" },
      { semitonesFromRoot: 0, startBeat: 3.5, durationBeats: 0.32, velocityScale: 0.5,  voicing: "stab" }, // シンコペ
    ],
  ]},
  // [phrase] Pre-Chorus: ウォーキング/ビバップ単音 — single のみ
  // root → 3 → 5 → 6 → 7 → octave → 9 → 10 でコードトーン + クロマチック上昇
  preChorus: { barsLength: 1, notesPerBar: [[
    { semitonesFromRoot: 0,  startBeat: 0.0, durationBeats: 0.4, velocityScale: 0.55, voicing: "single" },
    { semitonesFromRoot: 4,  startBeat: 0.5, durationBeats: 0.4, velocityScale: 0.65, voicing: "single", graceBefore: -1 },
    { semitonesFromRoot: 7,  startBeat: 1.0, durationBeats: 0.4, velocityScale: 0.6,  voicing: "single" },
    { semitonesFromRoot: 9,  startBeat: 1.5, durationBeats: 0.4, velocityScale: 0.65, voicing: "single" },
    { semitonesFromRoot: 11, startBeat: 2.0, durationBeats: 0.4, velocityScale: 0.6,  voicing: "single", graceBefore: -1 },
    { semitonesFromRoot: 12, startBeat: 2.5, durationBeats: 0.4, velocityScale: 0.7,  voicing: "single" },
    { semitonesFromRoot: 14, startBeat: 3.0, durationBeats: 0.4, velocityScale: 0.65, voicing: "single" },
    { semitonesFromRoot: 16, startBeat: 3.5, durationBeats: 0.4, velocityScale: 0.7,  voicing: "single", graceBefore: -1 },
  ]] },
  // [chord] Chorus: 2 小節 — bar1 = 4 ビート stab コンプ、bar2 = ビバップシンコペ + full アクセント
  chorus: { barsLength: 2, notesPerBar: [
    [
      { semitonesFromRoot: 0, startBeat: 0.0, durationBeats: 0.4,  velocityScale: 0.7,  voicing: "full" },
      { semitonesFromRoot: 0, startBeat: 1.0, durationBeats: 0.32, velocityScale: 0.5,  voicing: "stab" },
      { semitonesFromRoot: 0, startBeat: 2.0, durationBeats: 0.4,  velocityScale: 0.65, voicing: "full" },
      { semitonesFromRoot: 0, startBeat: 3.0, durationBeats: 0.32, velocityScale: 0.55, voicing: "stab" },
    ],
    [ // bar 2: 1 拍目に full + シンコペ stab を散りばめて 4 拍目に full で着地
      { semitonesFromRoot: 0, startBeat: 0.0, durationBeats: 0.4,  velocityScale: 0.7,  voicing: "full" },
      { semitonesFromRoot: 0, startBeat: 1.0, durationBeats: 0.32, velocityScale: 0.5,  voicing: "stab" },
      { semitonesFromRoot: 0, startBeat: 1.5, durationBeats: 0.32, velocityScale: 0.5,  voicing: "stab" }, // シンコペ
      { semitonesFromRoot: 0, startBeat: 2.0, durationBeats: 0.32, velocityScale: 0.6,  voicing: "stab" },
      { semitonesFromRoot: 0, startBeat: 2.5, durationBeats: 0.32, velocityScale: 0.55, voicing: "stab" }, // シンコペ
      { semitonesFromRoot: 0, startBeat: 3.0, durationBeats: 0.9,  velocityScale: 0.75, voicing: "full" },
    ],
  ]},
  // [phrase] Bridge: ビバップライン — single のみで半音/全音アプローチを多用
  bridge: { barsLength: 1, notesPerBar: [[
    { semitonesFromRoot: -1, startBeat: 0.0, durationBeats: 0.32, velocityScale: 0.6,  voicing: "single" },
    { semitonesFromRoot: 0,  startBeat: 0.5, durationBeats: 0.4,  velocityScale: 0.7,  voicing: "single" },
    { semitonesFromRoot: 5,  startBeat: 1.0, durationBeats: 0.3,  velocityScale: 0.6,  voicing: "single", graceBefore: -1 },
    { semitonesFromRoot: 6,  startBeat: 1.5, durationBeats: 0.3,  velocityScale: 0.6,  voicing: "single" },
    { semitonesFromRoot: 7,  startBeat: 2.0, durationBeats: 0.4,  velocityScale: 0.7,  voicing: "single" },
    { semitonesFromRoot: 10, startBeat: 2.5, durationBeats: 0.3,  velocityScale: 0.65, voicing: "single" },
    { semitonesFromRoot: 11, startBeat: 3.0, durationBeats: 0.3,  velocityScale: 0.65, voicing: "single", graceBefore: -1 },
    { semitonesFromRoot: 12, startBeat: 3.5, durationBeats: 0.4,  velocityScale: 0.75, voicing: "single" },
  ]] },
  break: EMPTY_RIFF,
  // [chord] Outro: 締めの長 full
  outro: { barsLength: 1, notesPerBar: [[
    { semitonesFromRoot: 0, startBeat: 0.0, durationBeats: 1.8, velocityScale: 0.55, voicing: "full" },
    { semitonesFromRoot: 0, startBeat: 2.0, durationBeats: 1.8, velocityScale: 0.45, voicing: "full" },
  ]] },
};

const GUITAR_RIFF_LIBRARY: Record<ComposerStyle, Record<SectionKind, GuitarRiff>> = {
  rock: ROCK_RIFFS,
  pop: POP_RIFFS,
  ballad: BALLAD_RIFFS,
  jazz: JAZZ_RIFFS,
};

// ---------------------------------------------------------------------------
// リフ変奏エンジン (music-theory ベース)
//
// 既存の GUITAR_RIFF_LIBRARY は「骨格」として保ったまま、bar ごとに少しだけ
// ミューテーションを掛けてリスナーが「あ、同じパターンの繰り返しじゃないな」と
// 感じるようにする。
//
// 原則:
//   - アクセント (velocityScale >= 0.85) は触らない (= 骨格の "ノリ" は守る)
//   - 弱拍 (weak slots) だけを変奏対象にする
//   - 1 bar につき 1〜2 個までしか mutate しない (= 過剰変化させない)
//   - 変奏は role に応じて異なる:
//       chord  → ゴースト挿入 / voicing flip / 5度/8度差し替え / 微小タイミング揺らぎ
//       phrase → 通過音(passing) / 隣接音(neighbor) / オクターブ跳躍 / アーティキュレーション
//   - セクション最終 bar は専用 fill (次セクションへ橋を架ける)
// ---------------------------------------------------------------------------

/** velocityScale がこれ以上の音は「アクセント」とみなし、変奏で触らない。 */
const RIFF_ACCENT_THRESHOLD = 0.85;

/** 0..len-1 の弱拍 (= 非アクセント) インデックスの配列。 */
function weakSlots(notes: RiffNote[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < notes.length; i++) {
    if (notes[i].velocityScale < RIFF_ACCENT_THRESHOLD) out.push(i);
  }
  return out;
}

/** chord.quality に対応する半音オフセット配列を「コードトーン候補」として返す。 */
function chordToneSet(chord: HarmonicChord): number[] {
  // 例: major → [0, 4, 7]、min7 → [0, 3, 7, 10]、maj9 → [0, 4, 7, 11, 14]
  return CHORD_INTERVALS[chord.quality];
}

/**
 * `current` (chord root からの半音) に最も近い「他のコードトーン」を返す。
 * 通過音/隣接音の着地先決定に使う。dir = +1 で上向き、-1 で下向き、0 はどちらでも。
 */
function nearestChordTone(current: number, chord: HarmonicChord, dir: 0 | 1 | -1): number {
  const set = chordToneSet(chord);
  // -12..+24 まで展開して、dir に合う最寄りを探す
  const candidates: number[] = [];
  for (let oct = -1; oct <= 2; oct++) {
    for (const iv of set) candidates.push(iv + 12 * oct);
  }
  const filtered = dir === 0
    ? candidates.filter((c) => c !== current)
    : dir > 0
      ? candidates.filter((c) => c > current)
      : candidates.filter((c) => c < current);
  if (filtered.length === 0) return current;
  filtered.sort((a, b) => Math.abs(a - current) - Math.abs(b - current));
  return filtered[0];
}

/** RiffNote を deep copy。 */
function cloneRiffNotes(notes: RiffNote[]): RiffNote[] {
  return notes.map((n) => ({ ...n }));
}

/**
 * chord 役の変奏ストラテジ。
 *   "ghost"      : 既存のアクセント間に 16 分パームミュートを 1 音差し込む
 *   "flipVoice"  : 弱拍 1 音の voicing を power↔mute / mute→stab などに差し替え
 *   "octShift"   : 弱拍 1 音の semitonesFromRoot を +12 か -12 へずらす
 *   "displace"   : 弱拍 1 音の startBeat を ±1/16 拍ずらす (シンコペ感)
 *   "drop"       : 弱拍 1 音を抜く (休符化)
 */
function mutateChordBar(
  base: RiffNote[],
  rng: () => number,
): RiffNote[] {
  if (base.length === 0) return base;
  const strategies = ["ghost", "flipVoice", "octShift", "displace", "drop"] as const;
  const s = strategies[Math.floor(rng() * strategies.length)];
  const notes = cloneRiffNotes(base);
  const weak = weakSlots(notes);
  switch (s) {
    case "ghost": {
      // 隣接 2 音の startBeat の中点に mute を差し込む (重ならない位置で)
      if (notes.length < 2) return notes;
      const i = Math.floor(rng() * (notes.length - 1));
      const a = notes[i];
      const b = notes[i + 1];
      const gap = b.startBeat - (a.startBeat + a.durationBeats);
      if (gap < 0.15) return notes;
      const insertAt = a.startBeat + a.durationBeats + Math.min(0.12, gap * 0.5);
      notes.push({
        semitonesFromRoot: a.semitonesFromRoot,
        startBeat: insertAt,
        durationBeats: Math.min(0.18, gap * 0.6),
        velocityScale: 0.5,
        voicing: "mute",
      });
      return notes;
    }
    case "flipVoice": {
      if (weak.length === 0) return notes;
      const i = weak[Math.floor(rng() * weak.length)];
      const n = notes[i];
      const flips: Record<RiffVoicing, RiffVoicing[]> = {
        power: ["mute"],
        mute: ["power", "stab"],
        full: ["stab"],
        stab: ["full"],
        single: ["double5"],
        double5: ["single", "octaveUnison"],
        double3: ["single"],
        octaveUnison: ["double5"],
      };
      const opts = flips[n.voicing] ?? [];
      if (opts.length === 0) return notes;
      n.voicing = opts[Math.floor(rng() * opts.length)];
      return notes;
    }
    case "octShift": {
      if (weak.length === 0) return notes;
      const i = weak[Math.floor(rng() * weak.length)];
      const n = notes[i];
      // power/mute は -12 すると低すぎるので +12 のみ、single 系は ±12 両方
      const isLow = n.voicing === "power" || n.voicing === "mute";
      n.semitonesFromRoot += isLow ? 12 : (rng() < 0.5 ? 12 : -12);
      return notes;
    }
    case "displace": {
      if (weak.length === 0) return notes;
      const i = weak[Math.floor(rng() * weak.length)];
      const n = notes[i];
      const shift = (rng() < 0.5 ? -1 : 1) * 0.125; // ±1/16 拍
      const newStart = Math.max(0, Math.min(3.95, n.startBeat + shift));
      n.startBeat = newStart;
      return notes;
    }
    case "drop": {
      if (weak.length === 0 || notes.length <= 2) return notes;
      const i = weak[Math.floor(rng() * weak.length)];
      notes.splice(i, 1);
      return notes;
    }
  }
  return notes;
}

/**
 * phrase 役の変奏ストラテジ。
 *   "passing"   : 連続する 2 音間に通過音 (途中の半音/全音) を 16 分で挿入
 *   "neighbor"  : 弱拍 1 音を ±1 (半音) または ±2 (全音) ずらして隣接音にする
 *   "chordTone" : 弱拍 1 音を直近の別コードトーンに置き換える
 *   "octFlip"   : 弱拍 1 音を 1 オクターブ上 or 下にジャンプ
 *   "graceAdd"  : graceBefore を弱拍 1 音に付ける (ハンマリング/スライド感)
 *   "graceDrop" : 既存 graceBefore を消す (素直なフレーズに戻す)
 */
function mutatePhraseBar(
  base: RiffNote[],
  chord: HarmonicChord,
  rng: () => number,
): RiffNote[] {
  if (base.length === 0) return base;
  const strategies = ["passing", "neighbor", "chordTone", "octFlip", "graceAdd", "graceDrop"] as const;
  const s = strategies[Math.floor(rng() * strategies.length)];
  const notes = cloneRiffNotes(base);
  const weak = weakSlots(notes);
  switch (s) {
    case "passing": {
      if (notes.length < 2) return notes;
      // 跳躍 (|delta| >= 3) のある隣接 2 音を探す
      const candidates: number[] = [];
      for (let i = 0; i < notes.length - 1; i++) {
        const d = notes[i + 1].semitonesFromRoot - notes[i].semitonesFromRoot;
        if (Math.abs(d) >= 3) candidates.push(i);
      }
      if (candidates.length === 0) return notes;
      const i = candidates[Math.floor(rng() * candidates.length)];
      const a = notes[i];
      const b = notes[i + 1];
      const gap = b.startBeat - (a.startBeat + a.durationBeats);
      if (gap < 0.12) return notes;
      const dir = b.semitonesFromRoot > a.semitonesFromRoot ? 1 : -1;
      const between = a.semitonesFromRoot + dir * Math.max(1, Math.floor(Math.abs(b.semitonesFromRoot - a.semitonesFromRoot) / 2));
      notes.push({
        semitonesFromRoot: between,
        startBeat: a.startBeat + a.durationBeats + Math.min(0.1, gap * 0.4),
        durationBeats: Math.min(0.2, gap * 0.6),
        velocityScale: Math.max(0.55, a.velocityScale - 0.15),
        voicing: a.voicing === "double5" || a.voicing === "octaveUnison" ? "single" : a.voicing,
      });
      return notes;
    }
    case "neighbor": {
      if (weak.length === 0) return notes;
      const i = weak[Math.floor(rng() * weak.length)];
      const n = notes[i];
      const step = rng() < 0.6 ? 1 : 2; // 半音 or 全音
      const dir = rng() < 0.5 ? 1 : -1;
      n.semitonesFromRoot += dir * step;
      return notes;
    }
    case "chordTone": {
      if (weak.length === 0) return notes;
      const i = weak[Math.floor(rng() * weak.length)];
      const n = notes[i];
      n.semitonesFromRoot = nearestChordTone(n.semitonesFromRoot, chord, 0);
      return notes;
    }
    case "octFlip": {
      if (weak.length === 0) return notes;
      const i = weak[Math.floor(rng() * weak.length)];
      const n = notes[i];
      // 高音側に行きすぎると刺さるので、現状が +12 以上なら -12、それ以外は +12
      n.semitonesFromRoot += n.semitonesFromRoot >= 12 ? -12 : 12;
      return notes;
    }
    case "graceAdd": {
      const noGrace = notes
        .map((n, i) => ({ n, i }))
        .filter((x) => x.n.graceBefore === undefined && x.n.velocityScale >= 0.6);
      if (noGrace.length === 0) return notes;
      const { i } = noGrace[Math.floor(rng() * noGrace.length)];
      notes[i].graceBefore = rng() < 0.5 ? -1 : 1;
      return notes;
    }
    case "graceDrop": {
      const withGrace = notes
        .map((n, i) => ({ n, i }))
        .filter((x) => x.n.graceBefore !== undefined);
      if (withGrace.length === 0) return notes;
      const { i } = withGrace[Math.floor(rng() * withGrace.length)];
      delete notes[i].graceBefore;
      return notes;
    }
  }
  return notes;
}

/**
 * セクション最終 bar 用の fill。次セクションへの「橋」を架ける。
 *   chord 役  → 4 拍目に 16 分パームミュート連打 + 拍裏にアクセント power
 *   phrase 役 → 後半 2 拍をスケール降下 (5 → 4 → 3 → 2 → root) に置き換え
 */
function applySectionEndFill(
  base: RiffNote[],
  role: GuitarRole,
  chord: HarmonicChord,
  rng: () => number,
): RiffNote[] {
  const notes = cloneRiffNotes(base);
  if (role === "chord") {
    // 既存 4 拍目以降の音を一旦削除して、16 分ミュート連打 + 拍裏 power に置き換え
    const kept = notes.filter((n) => n.startBeat < 3.0);
    const fill: RiffNote[] = [
      { semitonesFromRoot: 0, startBeat: 3.00, durationBeats: 0.18, velocityScale: 0.55, voicing: "mute" },
      { semitonesFromRoot: 0, startBeat: 3.25, durationBeats: 0.18, velocityScale: 0.6,  voicing: "mute" },
      { semitonesFromRoot: 0, startBeat: 3.50, durationBeats: 0.18, velocityScale: 0.65, voicing: "mute" },
      { semitonesFromRoot: 0, startBeat: 3.75, durationBeats: 0.22, velocityScale: 0.95, voicing: "power" },
    ];
    return [...kept, ...fill];
  }
  // phrase 役: コードトーンを使った降下フレーズで着地
  const kept = notes.filter((n) => n.startBeat < 2.0);
  // コードトーン候補を高音から並べる
  const set = chordToneSet(chord);
  const high = [...set, ...set.map((v) => v + 12)].sort((a, b) => b - a);
  // 上から 4 音 + root に着地
  const pick = (i: number) => high[Math.min(i, high.length - 1)];
  const descend: RiffNote[] = [
    { semitonesFromRoot: pick(0),                 startBeat: 2.00, durationBeats: 0.22, velocityScale: 0.7,  voicing: "single" },
    { semitonesFromRoot: pick(1),                 startBeat: 2.50, durationBeats: 0.22, velocityScale: 0.7,  voicing: "single" },
    { semitonesFromRoot: pick(2),                 startBeat: 3.00, durationBeats: 0.22, velocityScale: 0.75, voicing: "single" },
    { semitonesFromRoot: pick(3),                 startBeat: 3.50, durationBeats: 0.22, velocityScale: 0.75, voicing: "single" },
    { semitonesFromRoot: 0,                       startBeat: 3.75, durationBeats: 0.22, velocityScale: 0.9,  voicing: "octaveUnison", graceBefore: rng() < 0.5 ? -1 : 1 },
  ];
  return [...kept, ...descend];
}

/**
 * 1 bar 分のリフを役割と repIndex/セクション位置に応じて変奏する。
 *
 * - repIndex === 0 かつ最終 bar でない → 骨格そのまま (リスナーに型を覚えさせる)
 * - repIndex >= 1 → 1〜2 個のミューテーションを適用
 * - セクション最終 bar → fill で次へ橋を架ける
 */
function varyRiffBar(
  base: RiffNote[],
  repIndex: number,
  isLastBarOfSection: boolean,
  role: GuitarRole,
  chord: HarmonicChord,
  rng: () => number,
): RiffNote[] {
  if (isLastBarOfSection && base.length > 0) {
    return applySectionEndFill(base, role, chord, rng);
  }
  if (repIndex === 0) return base;
  let notes = base;
  const numMutations = 1 + (rng() < 0.35 ? 1 : 0);
  for (let k = 0; k < numMutations; k++) {
    notes = role === "chord"
      ? mutateChordBar(notes, rng)
      : mutatePhraseBar(notes, chord, rng);
  }
  // startBeat 順に並べ替え (ghost / passing 挿入で順序が崩れている可能性)
  notes = [...notes].sort((a, b) => a.startBeat - b.startBeat);
  return notes;
}

function generateGuitarLayer(
  chords: HarmonicChord[],
  sections: SongSection[],
  bpm: number,
  style: ComposerStyle,
  rng: () => number,
): NoteEvent[] {
  const beatSec = 60 / bpm;
  const barSec = beatSec * 4;
  const out: NoteEvent[] = [];
  const baseMidi = 40; // ギター低音域 E2

  // セクションごとに「このセクションは何小節目か」を追跡。
  // Chorus が 8 小節なら、リフ (barsLength=2) を 4 回反復する。
  let curSec: SongSection | null = null;
  let barInSec = 0;

  for (let bar = 0; bar < chords.length; bar++) {
    const sec = sectionAtBar(sections, bar);
    if (curSec !== sec) {
      curSec = sec;
      barInSec = 0;
    }
    const fullVoicing = chordVoicing(chords[bar], baseMidi);
    const root = fullVoicing[0];
    const fullChord = fullVoicing.slice(0, 4);
    const barStart = bar * barSec;
    const vel0 = sec.intensity;

    // break: 1 拍目に短いストップだけ (リフはなし)
    if (sec.kind === "break") {
      const power = [root, root + 7, root + 12];
      for (const m of power) {
        out.push({ midi: m, startSec: barStart, durationSec: beatSec * 0.25, velocity: 0.7 });
      }
      barInSec++;
      continue;
    }

    const riff = GUITAR_RIFF_LIBRARY[style][sec.kind] ?? EMPTY_RIFF;
    const baseBarNotes = riff.notesPerBar[barInSec % riff.barsLength];

    // セクションの役割 (chord = バッキング / phrase = リード) に応じて
    // ヒューマナイズを微妙に変える:
    //   phrase 役 → 少しレガート + タイミング揺らぎ大きめ (歌う)
    //   chord  役 → 少しタイト + タイミング揺らぎ小さめ (刻む)
    const role = GUITAR_ROLE[style][sec.kind];
    const roleDurMul = role === "phrase" ? 1.05 : 0.98;
    const roleJitterMul = role === "phrase" ? 1.25 : 0.9;

    // 同じ riff bar の何回目の反復か。0 = 初出、1+ = 反復 → 変奏対象。
    const repIndex = Math.floor(barInSec / riff.barsLength);
    const isLastBarOfSection = bar === sec.endBar - 1;
    const barNotes = varyRiffBar(
      baseBarNotes,
      repIndex,
      isLastBarOfSection,
      role,
      chords[bar],
      rng,
    );

    for (const n of barNotes) {
      const baseMidiForNote = root + n.semitonesFromRoot;
      let pitches: number[];
      // duration / velocity の voicing 別補正:
      //   mute  → 短く・弱く (パームミュート "ズク")
      //   stab  → 短く・キレ良く (16 分以下のコードカッティング)
      let durMul = 1;
      let velMul = 1;
      switch (n.voicing) {
        case "power":
          pitches = [baseMidiForNote, baseMidiForNote + 7, baseMidiForNote + 12];
          break;
        case "full":
          // root が semitonesFromRoot 分上下しているなら、和音もそれだけ平行移動
          pitches = fullChord.map((m) => m + n.semitonesFromRoot);
          break;
        case "octaveUnison":
          // ロックのオクターブライン (Iron Maiden 系)
          pitches = [baseMidiForNote, baseMidiForNote + 12];
          break;
        case "double5":
          // 完全 5 度ダブルストップ (ブルース/ロックソロ)
          pitches = [baseMidiForNote, baseMidiForNote + 7];
          break;
        case "double3":
          // 短 3 度ダブルストップ (ブルーノート風)
          pitches = [baseMidiForNote, baseMidiForNote + 3];
          break;
        case "mute":
          // パームミュート相当 — パワーコードの低 2 音だけを短く弱く
          pitches = [baseMidiForNote, baseMidiForNote + 7];
          durMul = 0.55;
          velMul = 0.7;
          break;
        case "stab":
          // ファンキースタブ — フル和音を極短に
          pitches = fullChord.map((m) => m + n.semitonesFromRoot);
          durMul = 0.5;
          velMul = 1.05;
          break;
        case "single":
        default:
          pitches = [baseMidiForNote];
          break;
      }

      // 微妙な timing / velocity ジッタで人間味を出す (±5ms / ±6%)
      // role に応じてジッタ幅とレガート量を微調整
      const tJitter = (rng() - 0.5) * 0.010 * roleJitterMul; // 秒
      const vJitter = 1 + (rng() - 0.5) * 0.12;
      const startSec = barStart + n.startBeat * beatSec + tJitter;
      const durationSec = Math.max(0.04, n.durationBeats * beatSec * durMul * roleDurMul);
      const vel = Math.max(0.18, Math.min(1, vel0 * n.velocityScale * velMul * vJitter));

      // graceBefore: 開始 1/16 拍前に半音 ±1 のアプローチノートを 1 つ前置く
      // (ハンマリング/スライドイン感)。ピッチは pitches[0] の +/-1。
      if (n.graceBefore !== undefined) {
        const graceOffset = n.graceBefore; // -1 or +1
        const graceDur = Math.max(0.03, beatSec * 0.08);
        const graceStart = Math.max(0, startSec - beatSec * 0.12);
        out.push({
          midi: pitches[0] + graceOffset,
          startSec: graceStart,
          durationSec: graceDur,
          velocity: Math.max(0.15, vel * 0.55),
        });
      }

      for (const m of pitches) {
        out.push({
          midi: m,
          startSec,
          durationSec,
          velocity: vel,
        });
      }
    }
    barInSec++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// アコースティックギター層 (フィンガーピッキング / アルペジオ 中心)
// chord 層がブロック / piano アルペジオを、guitar 層がパワーコード/カッティングを
// 担うのに対し、acoustic 層は「Travis ピッキング」「分散和音」など
// 落ち着いた繊細なパターンを担当する。
// ---------------------------------------------------------------------------
function generateAcousticLayer(
  chords: HarmonicChord[],
  sections: SongSection[],
  bpm: number,
  style: ComposerStyle,
  rng: () => number,
): NoteEvent[] {
  const beatSec = 60 / bpm;
  const barSec = beatSec * 4;
  const out: NoteEvent[] = [];
  const baseMidi = 48; // C3 — アコギは中域中心

  for (let bar = 0; bar < chords.length; bar++) {
    const sec = sectionAtBar(sections, bar);
    const voicing = chordVoicing(chords[bar], baseMidi);
    // 4 音アルペジオ素材 (root, 3rd, 5th, 7th/oct)。chordVoicing 不足分はオクターブで補う。
    const arp = voicing.length >= 4
      ? voicing.slice(0, 4)
      : [voicing[0], voicing[1] ?? voicing[0] + 7, voicing[2] ?? voicing[0] + 12, voicing[0] + 12];
    const root = voicing[0];
    const barStart = bar * barSec;
    const vel0 = sec.intensity;

    if (sec.kind === "break") {
      // 1 拍目に低音 root のみ余韻
      out.push({ midi: root, startSec: barStart, durationSec: beatSec * 0.7, velocity: 0.55 });
      continue;
    }
    if (sec.kind === "intro" || sec.kind === "outro") {
      // 静かな分散和音
      for (let i = 0; i < 4; i++) {
        out.push({
          midi: arp[i % arp.length],
          startSec: barStart + i * beatSec,
          durationSec: beatSec * 1.1,
          velocity: vel0 * 0.55,
        });
      }
      continue;
    }

    if (style === "ballad") {
      // ballad: ゆっくり分散和音 (8 分 root-3-5-3-root-3-5-3)
      const pattern = [0, 1, 2, 1, 0, 1, 2, 1];
      for (let i = 0; i < 8; i++) {
        out.push({
          midi: arp[pattern[i] % arp.length],
          startSec: barStart + i * (beatSec / 2),
          durationSec: beatSec * 0.6,
          velocity: vel0 * (i === 0 ? 0.75 : 0.55),
        });
      }
    } else if (style === "pop") {
      // Travis picking: bass を 1,3 拍目に、treble を 2,4 拍目に交互。8 分粒。
      // 1: root (low), 2: 3rd, 3: 5th, 4: 3rd, 5: root+oct, 6: 3rd, 7: 5th, 8: 3rd
      const pattern = [
        { idx: 0, vel: 0.8 },  // root
        { idx: 2, vel: 0.55 }, // 5th
        { idx: 1, vel: 0.6 },  // 3rd
        { idx: 2, vel: 0.55 }, // 5th
        { idx: 3, vel: 0.65 }, // 7th/oct
        { idx: 2, vel: 0.5 },  // 5th
        { idx: 1, vel: 0.55 }, // 3rd
        { idx: 2, vel: 0.5 },  // 5th
      ];
      for (let i = 0; i < 8; i++) {
        const p = pattern[i];
        out.push({
          midi: arp[p.idx % arp.length],
          startSec: barStart + i * (beatSec / 2),
          durationSec: beatSec * 0.55,
          velocity: vel0 * p.vel,
        });
      }
    } else if (style === "rock") {
      // フォークロック調: 8 分ダウンアップストローク (フル和音を 8 分粒で)
      const strum = voicing.slice(0, 4);
      for (let i = 0; i < 8; i++) {
        for (const m of strum) {
          out.push({
            midi: m,
            startSec: barStart + i * (beatSec / 2),
            durationSec: beatSec * 0.35,
            velocity: vel0 * (i === 0 ? 0.85 : i % 2 === 0 ? 0.65 : 0.45),
          });
        }
      }
    } else {
      // jazz: ボサノバ / 軽いフィンガリング. root を 1, 3.5 拍目、和音 stab を 2, 4 拍目
      out.push({ midi: root, startSec: barStart, durationSec: beatSec * 0.9, velocity: vel0 * 0.7 });
      for (const m of arp.slice(1)) {
        out.push({
          midi: m,
          startSec: barStart + 1 * beatSec,
          durationSec: beatSec * 0.4,
          velocity: vel0 * 0.55,
        });
      }
      out.push({
        midi: root,
        startSec: barStart + 2.5 * beatSec,
        durationSec: beatSec * 0.5,
        velocity: vel0 * 0.6,
      });
      for (const m of arp.slice(1)) {
        out.push({
          midi: m,
          startSec: barStart + 3 * beatSec,
          durationSec: beatSec * 0.4,
          velocity: vel0 * 0.5 + (rng() - 0.5) * 0.04,
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// ボーカル層 (メロディに 3 度/オクターブのハモリを乗せる)
// Verse は基本ユニゾン (= melody そのまま)、Chorus / Pre-Chorus では
// 上 3 度 (ダイアトニック、可能ならコードトーン) を重ねてハーモニーを作る。
// ---------------------------------------------------------------------------
function generateVocalLayer(
  melodyNotes: NoteEvent[],
  chords: HarmonicChord[],
  sections: SongSection[],
  scale: Scale,
  bpm: number,
): NoteEvent[] {
  const beatSec = 60 / bpm;
  const barSec = beatSec * 4;
  const out: NoteEvent[] = [];

  for (const note of melodyNotes) {
    const bar = Math.floor(note.startSec / barSec);
    if (bar < 0 || bar >= chords.length) {
      out.push(note);
      continue;
    }
    const sec = sectionAtBar(sections, bar);
    // ユニゾン (= リードボーカルとしてメロディそのまま)
    out.push(note);

    // ハモリ対象セクション
    const wantHarmony = sec.kind === "chorus" || sec.kind === "preChorus";
    if (!wantHarmony) continue;

    const localScale = transposeScale(scale, sec.keyOffsetSemitones);
    const chord = chords[bar];
    const chordPCs = new Set(chordVoicing(chord, 48).map((m) => m % 12));

    // 上 3 度 (ダイアトニック)。3..5 半音上を順に試して最初の音階内ピッチを採用。
    // できればコードトーンを優先。
    const cand: number[] = [];
    for (let off = 3; off <= 5; off++) {
      const m = note.midi + off;
      if (scaleContains(localScale, m)) cand.push(m);
    }
    if (cand.length === 0) continue;
    const harmony = cand.find((c) => chordPCs.has(c % 12)) ?? cand[0];

    out.push({
      midi: harmony,
      startSec: note.startSec,
      durationSec: note.durationSec,
      velocity: note.velocity * 0.7,
    });

    // 最終サビ感: chorus の最終 4 小節はオクターブ下も足してさらに厚くする
    const sectionEndBar = sec.endBar;
    const isLast4 = sec.kind === "chorus" && bar >= sectionEndBar - 4;
    if (isLast4 && note.midi - 12 >= 36) {
      out.push({
        midi: note.midi - 12,
        startSec: note.startSec,
        durationSec: note.durationSec,
        velocity: note.velocity * 0.55,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// シンセ層 (パッド or カウンターメロディ)
// pop / ballad → 高音域でロングトーンの "パッド" (root + 5th + 9th を sustain)
// rock / jazz → メロディの隙間を埋めるカウンターラインを 8 分/16 分で
// ---------------------------------------------------------------------------
function generateSynthLayer(
  melodyNotes: NoteEvent[],
  chords: HarmonicChord[],
  sections: SongSection[],
  bpm: number,
  style: ComposerStyle,
  rng: () => number,
): NoteEvent[] {
  const beatSec = 60 / bpm;
  const barSec = beatSec * 4;
  const out: NoteEvent[] = [];

  if (style === "pop" || style === "ballad") {
    // PAD: 高音域 (C5〜) で 1 小節フルサスティン。Intro / Outro / Break は休む。
    for (let bar = 0; bar < chords.length; bar++) {
      const sec = sectionAtBar(sections, bar);
      if (sec.kind === "break" || sec.kind === "intro" || sec.kind === "outro") continue;
      const voicing = chordVoicing(chords[bar], 72); // C5
      const padTones = voicing.slice(0, 3);
      const barStart = bar * barSec;
      const v = sec.intensity * (style === "ballad" ? 0.35 : 0.42);
      for (const m of padTones) {
        out.push({
          midi: m,
          startSec: barStart,
          durationSec: barSec * 0.97,
          velocity: v,
        });
      }
    }
  } else {
    // rock / jazz: カウンターライン。
    // メロディが鳴っていない区間 (= 小節末の余白) にコードトーンの
    // 16 分上行アルペジオを差し込んで「合いの手」を作る。
    // Verse / Intro / Outro / Break は休む。
    for (let bar = 0; bar < chords.length; bar++) {
      const sec = sectionAtBar(sections, bar);
      if (sec.kind !== "chorus" && sec.kind !== "bridge" && sec.kind !== "preChorus") continue;
      const barStart = bar * barSec;
      const barEnd = barStart + barSec;
      const chord = chords[bar];
      const voicing = chordVoicing(chord, 60); // C4

      // この小節内のメロディ音
      const inBar = melodyNotes
        .filter((n) => n.startSec >= barStart && n.startSec < barEnd)
        .sort((a, b) => a.startSec - b.startSec);
      const last = inBar[inBar.length - 1];
      const gapStart = last ? last.startSec + last.durationSec : barStart;
      const gapLen = barEnd - gapStart;

      if (gapLen < beatSec * 0.6) continue; // 隙間が狭ければスキップ

      // 16 分でアルペジオを最大 4 音差し込む
      const sixteenth = beatSec / 4;
      const tones = voicing.slice(0, 4);
      const slots = Math.min(tones.length, Math.floor(gapLen / sixteenth));
      // 上行 or 下行をランダムに選択して "問いと答え" の応答を作る
      const ascending = rng() < 0.5;
      for (let i = 0; i < slots; i++) {
        const idx = ascending ? i : tones.length - 1 - i;
        const m = tones[idx % tones.length];
        out.push({
          midi: m,
          startSec: gapStart + i * sixteenth,
          durationSec: sixteenth * 0.9,
          velocity: sec.intensity * 0.6,
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

    // ブレイク: 1 拍目だけ短いベース、あとは無音
    if (sec.kind === "break") {
      out.push({
        midi: root,
        startSec: barStart,
        durationSec: beatSec * 0.4,
        velocity: 0.45,
      });
      continue;
    }

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

    // ブレイク (ドロップ): ドラムをほぼ完全に止める。
    //   - 先頭にだけクラップを 1 発
    //   - 最終小節 4 拍目に "戻ってくる" スネアロール (16 分 x 4)
    if (sec.kind === "break") {
      if (isSectionStart) {
        addNote(out, DRUM_CLAP_MIDI, barStart, 0.55);
      }
      if (isSectionLast) {
        // 4 拍目に小さいフィル
        const sub = beatSec / 4;
        for (let i = 0; i < 4; i++) {
          addNote(out, DRUM_SNARE_MIDI, barStart + 3 * beatSec + i * sub, 0.5 + i * 0.1);
        }
      }
      continue;
    }

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
// FX (効果音): セクション転換・サビ前の盛り上げ等
// ---------------------------------------------------------------------------
/**
 * セクション境界・サビ前に FX (リバースシンバル/ライザー/ダウンリフター/フォール 等) を配置する。
 *
 * 配置ルール:
 *   - サビ (chorus) の直前: リバースシンバル + ライザー (1〜2 小節分の build-up)
 *   - サビ終わり: ダウンリフター or フォール
 *   - bridge 直前: スウィープ (上昇 or 下降)
 *   - イントロ頭: ホワイトノイズ・スウィープアップ
 *   - アウトロ頭: フォール
 */
function generateFx(
  sections: SongSection[],
  bpm: number,
  rng: () => number,
): NoteEvent[] {
  const out: NoteEvent[] = [];
  const beatSec = 60 / bpm;
  const barSec = beatSec * 4;

  const addFx = (
    midi: number,
    startSec: number,
    durationSec: number,
    velocity: number,
  ) => {
    if (startSec < 0) return;
    out.push({
      midi,
      startSec,
      durationSec: Math.max(0.1, durationSec),
      velocity: Math.max(0.1, Math.min(1, velocity)),
    });
  };

  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    const next = sections[i + 1];
    const secStart = sec.startBar * barSec;

    // イントロ頭: スウィープアップでオープニング
    if (sec.kind === "intro" && i === 0) {
      addFx(FX_SWEEP_UP, secStart, Math.min(2 * barSec, 1.5), 0.6);
    }

    // サビ前の build-up (前セクションの最終 1〜2 小節を build-up に使う)
    if (next && next.kind === "chorus") {
      const buildBars = sec.endBar - sec.startBar >= 2 ? 2 : 1;
      const buildStart = (next.startBar - buildBars) * barSec;
      const buildDur = buildBars * barSec - 0.05;
      // リバースシンバル (盛り上がってサビ頭に着地)
      addFx(FX_REVERSE_CYMBAL, buildStart, buildDur, 0.9);
      // ライザーを少し遅らせて重ねる
      if (buildBars >= 2 && rng() < 0.7) {
        addFx(FX_RISER, buildStart + barSec * 0.5, buildDur - barSec * 0.5, 0.75);
      }
    }

    // ブリッジ前: スウィープで色を変える
    if (next && next.kind === "bridge") {
      const startSec = next.startBar * barSec - barSec * 0.5;
      addFx(rng() < 0.5 ? FX_SWEEP_UP : FX_SWEEP_DOWN, startSec, barSec * 0.5, 0.6);
    }

    // サビ終わり (= sec が chorus で次が chorus でないとき): ダウンリフター or フォール
    if (sec.kind === "chorus" && (!next || next.kind !== "chorus")) {
      const dropSec = sec.endBar * barSec - barSec * 0.75;
      if (rng() < 0.6) {
        addFx(FX_DOWNLIFTER, dropSec, barSec * 0.75, 0.7);
      } else {
        addFx(FX_FALL, dropSec, barSec * 0.5, 0.7);
      }
    }

    // アウトロ頭: フォール or ホワイトノイズ
    if (sec.kind === "outro") {
      addFx(rng() < 0.5 ? FX_FALL : FX_WHITE_NOISE, secStart, barSec * 0.75, 0.55);
    }

    // ブレイク中はホワイトノイズで「ヒスの効いた間」を演出 +
    // ブレイク末尾でリバースシンバルを置いて次のサビへ着地
    if (sec.kind === "break") {
      const breakLen = (sec.endBar - sec.startBar) * barSec;
      addFx(FX_WHITE_NOISE, secStart, breakLen * 0.9, 0.35);
      addFx(FX_REVERSE_CYMBAL, sec.endBar * barSec - barSec * 0.9, barSec * 0.9, 0.85);
      if (rng() < 0.7) {
        addFx(FX_RISER, sec.endBar * barSec - barSec * 0.6, barSec * 0.55, 0.7);
      }
    }

    // 転調セクション (前セクションと keyOffset が違う) の直前に上昇スウィープを追加
    if (next && next.keyOffsetSemitones !== sec.keyOffsetSemitones) {
      addFx(FX_SWEEP_UP, next.startBar * barSec - barSec * 0.35, barSec * 0.35, 0.6);
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// 公開関数: 1 曲生成
// ---------------------------------------------------------------------------
/**
 * イベントループに 1 ティック制御を返す。
 * これを各 generate*Layer の合間に挟むことで、
 * ボタン押下 → composeSong 完了までの間に
 * UI が完全フリーズするのを防ぐ。
 */
function yieldToUI(): Promise<void> {
  return new Promise<void>((resolve) => {
    // setTimeout(0) で次の macrotask に回す。
    // 50ms 程度なら UI は完全に再描画 / クリック受付ができる。
    setTimeout(resolve, 0);
  });
}

/**
 * composeSong の非同期版。
 * 各レイヤー生成の合間に await yieldToUI() を挟んで、
 * 「自動作曲」ボタンを押した瞬間の数百 ms フリーズを解消する。
 *
 * 出力は composeSong と完全に同一 (内容も順序も)。
 * 計算結果が決定的なように同じ rng (= 同 seed) を共有する。
 */
export async function composeSongAsync(opts: AutoComposeOptions): Promise<ComposedSong> {
  const { scale, bpm, bars, style } = opts;
  const seed = opts.seed ?? (Date.now() & 0xffffffff);
  const rng = makeRng(seed);
  void SCALE_INTERVALS;

  const sections = planSections(bars, style, rng);
  let chords: HarmonicChord[];
  if (opts.chordsOverride && opts.chordsOverride.length > 0) {
    const src = opts.chordsOverride;
    chords = [];
    for (let i = 0; i < bars; i++) {
      chords.push(src[Math.min(i, src.length - 1)]);
    }
  } else {
    chords = buildProgression(scale, bars, style, sections, rng);
  }
  await yieldToUI();

  const melodyNotes = (opts.includeMelody ?? true)
    ? generateMelody(scale, chords, sections, bpm, style, rng)
    : [];
  await yieldToUI();

  const chordNotes = (opts.includeChord ?? true)
    ? generateChordLayer(chords, sections, bpm, style, rng)
    : [];
  await yieldToUI();

  const bassNotes = (opts.includeBass ?? true)
    ? generateBass(chords, sections, bpm, style, rng)
    : [];
  await yieldToUI();

  const drumNotes = (opts.includeDrums ?? true)
    ? generateDrums(sections, bars, bpm, style, rng)
    : [];
  await yieldToUI();

  const fxNotes = (opts.includeFx ?? true)
    ? generateFx(sections, bpm, rng)
    : [];
  await yieldToUI();

  const guitarNotes = (opts.includeGuitar ?? false)
    ? generateGuitarLayer(chords, sections, bpm, style, rng)
    : [];
  await yieldToUI();

  const acousticNotes = (opts.includeAcoustic ?? false)
    ? generateAcousticLayer(chords, sections, bpm, style, rng)
    : [];
  await yieldToUI();

  const vocalNotes = (opts.includeVocal ?? false)
    ? generateVocalLayer(melodyNotes, chords, sections, scale, bpm)
    : [];
  await yieldToUI();

  const synthNotes = (opts.includeSynth ?? false)
    ? generateSynthLayer(melodyNotes, chords, sections, bpm, style, rng)
    : [];

  const totalSec = bars * 4 * (60 / bpm);

  for (const arr of [
    melodyNotes, chordNotes, bassNotes, drumNotes, fxNotes,
    guitarNotes, acousticNotes, vocalNotes, synthNotes,
  ]) {
    arr.sort((a, b) => a.startSec - b.startSec);
  }

  return {
    chords,
    sections,
    melodyNotes,
    chordNotes,
    bassNotes,
    drumNotes,
    fxNotes,
    guitarNotes,
    acousticNotes,
    vocalNotes,
    synthNotes,
    totalSec,
    bpm,
    style,
  };
}

export function composeSong(opts: AutoComposeOptions): ComposedSong {
  const { scale, bpm, bars, style } = opts;
  const seed = opts.seed ?? (Date.now() & 0xffffffff);
  const rng = makeRng(seed);
  // scaleContains を使うので参照だけ残す (lint 対策)
  void SCALE_INTERVALS;

  const sections = planSections(bars, style, rng);
  // ユーザーが Chord 層やコードパレットで進行を指定していればそれを優先。
  // 長さが足りなければ最後のコードを反復、超過分は切り捨て。
  let chords: HarmonicChord[];
  if (opts.chordsOverride && opts.chordsOverride.length > 0) {
    const src = opts.chordsOverride;
    chords = [];
    for (let i = 0; i < bars; i++) {
      chords.push(src[Math.min(i, src.length - 1)]);
    }
  } else {
    chords = buildProgression(scale, bars, style, sections, rng);
  }
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
  const fxNotes = (opts.includeFx ?? true)
    ? generateFx(sections, bpm, rng)
    : [];
  const guitarNotes = (opts.includeGuitar ?? false)
    ? generateGuitarLayer(chords, sections, bpm, style, rng)
    : [];
  const acousticNotes = (opts.includeAcoustic ?? false)
    ? generateAcousticLayer(chords, sections, bpm, style, rng)
    : [];
  const vocalNotes = (opts.includeVocal ?? false)
    ? generateVocalLayer(melodyNotes, chords, sections, scale, bpm)
    : [];
  const synthNotes = (opts.includeSynth ?? false)
    ? generateSynthLayer(melodyNotes, chords, sections, bpm, style, rng)
    : [];

  const totalSec = bars * 4 * (60 / bpm);

  for (const arr of [
    melodyNotes, chordNotes, bassNotes, drumNotes, fxNotes,
    guitarNotes, acousticNotes, vocalNotes, synthNotes,
  ]) {
    arr.sort((a, b) => a.startSec - b.startSec);
  }

  return {
    chords,
    sections,
    melodyNotes,
    chordNotes,
    bassNotes,
    drumNotes,
    fxNotes,
    guitarNotes,
    acousticNotes,
    vocalNotes,
    synthNotes,
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
  break: "ブレイク",
  outro: "アウトロ",
};
