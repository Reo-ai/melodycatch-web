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

/**
 * ギターのボイシング指定 (Verse 等の "chord 役" セクションの弾き方を強制する)。
 *   - "auto"       : style/section ごとの自然な振り分けに任せる (デフォルト)
 *   - "lead"       : リード (single-note ペンタトニック・フレーズ) に強制
 *   - "powerChord" : 開放パワーコード 8 分連打 (ジャンジャン…)
 *   - "palmMute"   : ブリッジミュート・パワーコード 8 分連打 (ズクズク…)
 *
 * "auto" の場合は style の既定 (例: rock の verse = palmMute, chorus = power) を尊重。
 * それ以外の場合、verse / preChorus / chorus / outro 等の "chord 役" セクションを
 * 指定の voicing で上書きする (intro/bridge/break は元のまま)。
 */
export type GuitarVoicingStyle = "auto" | "lead" | "powerChord" | "palmMute";

export const GUITAR_VOICING_STYLE_LABEL_JA: Record<GuitarVoicingStyle, string> = {
  auto: "おまかせ",
  lead: "リード",
  powerChord: "パワーコード",
  palmMute: "ブリッジミュート",
};

export interface AutoComposeOptions {
  scale: Scale;
  bpm: number;
  /** 生成する小節数 (4/4 拍子前提)。 */
  bars: number;
  style: ComposerStyle;
  /** 同じ seed なら同じ曲が生成される。省略時は時刻ベース。 */
  seed?: number;
  /** ギターのボイシング指定 (Verse 等の弾き方を強制)。省略時は "auto"。 */
  guitarVoicing?: GuitarVoicingStyle;
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

/**
 * ロックのイントロ展開パターン。同じイントロでも 3 種類のドラマ性を作り分けるためにある。
 *   - "vocalLed"             : ヴォーカル先行型。先発はベース + ハイハットのみ。
 *                              後半でバンド全部 IN。歌に焦点を当てる入り方。
 *   - "riffLed"              : リフ先行型 (邦ロック王道)。先発からエレキのパームミュート
 *                              リフが走り、ドラム/ベースは半分のところで一気に IN。
 *   - "cleanArpDistortion"   : 静→動展開。先発はクリーンギターのアルペジオで静かに。
 *                              後半で歪みリフ + バンド IN (ONE OK ROCK Mighty Long Fall 型)。
 */
export type RockIntroPattern = "vocalLed" | "riffLed" | "cleanArpDistortion";

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
  /**
   * (rock + intro 限定) イントロの 3 種類の展開パターン。planSections で
   * シードに基づき割り当てる。各レイヤー生成器はこれを読んで preEntry / bandEntry
   * 期 (前半/後半) で挙動を切り替える。
   */
  rockIntroPattern?: RockIntroPattern;
}

/**
 * イントロ section 内で、いま preEntry (前半=助走) か bandEntry (後半=突入) かを返す。
 * 4 小節イントロなら bars 0-1 = preEntry、bars 2-3 = bandEntry。
 * "riffLed" のみ前半からリフを鳴らすので最初から bandEntry 扱いに寄せる
 * (= サブパターンとしてドラム/ベース等の入りだけ遅らせる)。
 */
export function getRockIntroPhase(
  sec: SongSection,
  bar: number,
): "preEntry" | "bandEntry" {
  const len = sec.endBar - sec.startBar;
  const half = Math.floor(len / 2);
  const localBar = bar - sec.startBar;
  return localBar < half ? "preEntry" : "bandEntry";
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
      push("intro", 8);
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
      push("intro", 8);
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
      // 16 小節でも頭 4 小節をしっかりイントロに使うことで「序奏 → 本題」の起伏を出す。
      push("intro", 4);
      push("verse", 4);
      push("bridge", 4);
      push("verse", bars - cur - 2);
      push("outro", bars - cur);
    } else {
      push("verse", Math.max(2, Math.floor(bars / 2)));
      push("bridge", Math.max(1, Math.floor(bars / 4)));
      push("verse", bars - cur);
    }
    return progressIntensity(sections.filter((s) => s.endBar > s.startBar));
  }

  // pop / ballad / rock の一般的な構成
  if (bars >= 96) {
    // 大型構成: Intro / V1 / Pre / C1 / V2 / Pre / C2 / Solo(bridge) / Bridge / Break /
    //          V3(+2) / Pre(+2) / Final Chorus x2(+2) / Outro
    // 96+ 小節クラスは 8 小節イントロで聴き手を導入する (バンドサウンドの幅を見せる)。
    push("intro", 8);
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
    // 64+ も 8 小節イントロで起伏を作る。
    push("intro", 8);
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
    // 16 小節クラスでも 4 小節イントロを確保して「序奏 → 本題」の流れを残す。
    // 全体の尺を圧迫しないように preChorus を省略し、verse → chorus → verse の最小構成。
    push("intro", 4);
    push("verse", 4);
    push("chorus", 4);
    push("verse", Math.max(2, bars - cur - 2));
    push("outro", bars - cur);
  } else if (bars >= 8) {
    // 8 小節クラスは尺が短いので 1 小節カウントオフ的なイントロに留める
    // (4 小節入れると本編が消えてしまう)。
    push("intro", 1);
    push("verse", 3);
    push("chorus", 3);
    push("outro", bars - cur);
  } else {
    push("verse", Math.max(1, Math.floor(bars / 2)));
    push("chorus", bars - cur);
  }

  const finalized = progressIntensity(sections.filter((s) => s.endBar > s.startBar));
  // ロックのイントロには 3 種の展開パターン (vocalLed / riffLed / cleanArpDistortion)
  // をシードに応じて割り当てる。短すぎる (< 2 小節) イントロは preEntry が作れないので
  // 既存の riffLed (= 既存挙動互換) に固定。
  if (style === "rock") {
    const patterns: RockIntroPattern[] = ["vocalLed", "riffLed", "cleanArpDistortion"];
    for (const sec of finalized) {
      if (sec.kind !== "intro") continue;
      const len = sec.endBar - sec.startBar;
      sec.rockIntroPattern = len < 2 ? "riffLed" : pick(patterns, rng);
    }
  }
  return finalized;
}

/**
 * 同種セクションの "N 回目" を辿り、後半ほど盛り上げる progressive intensity。
 *   - chorus / verse / preChorus は「最初は控えめ → 最終回が最高」になる
 *   - サビが 2 回しかなければ 2 回目を +0.06、3 回なら 1/2/3 で +0.0/+0.04/+0.10
 *   - intensity 上限 1.0
 *   - 最終 chorus にはわずかな超過 (+0.05) を許して "max effort" を演出
 */
function progressIntensity(sections: SongSection[]): SongSection[] {
  const counts: Partial<Record<SectionKind, number>> = {};
  for (const s of sections) counts[s.kind] = (counts[s.kind] ?? 0) + 1;
  const seen: Partial<Record<SectionKind, number>> = {};
  for (const s of sections) {
    seen[s.kind] = (seen[s.kind] ?? 0) + 1;
    const idx = seen[s.kind]! - 1; // 0-based
    const total = counts[s.kind]!;
    if (total <= 1) continue;
    // 0..1 の正規化位置 (0 = 最初, 1 = 最後)
    const p = idx / (total - 1);
    if (s.kind === "chorus") {
      // 最初の chorus は -0.05、最後は +0.05 まで持ち上げる
      s.intensity = Math.max(0.5, Math.min(1.0, s.intensity - 0.05 + p * 0.12));
    } else if (s.kind === "verse" || s.kind === "preChorus") {
      // verse / preChorus は最初を抑え、最後でやや盛り上げる
      s.intensity = Math.max(0.4, Math.min(0.95, s.intensity - 0.04 + p * 0.08));
    }
  }
  return sections;
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

/**
 * ロック特有の "♭VII 借用コード" を進行に注入する (ミクソリディアン色)。
 *
 * Sweet Child o' Mine / With or Without You / Born to Run / 多くの邦ロックで
 * 「I → ♭VII → IV」(または i → ♭VII → ♭VI → V のアンダルシア下降) が定番。
 * ダイアトニックに閉じた進行だけだとロックの "粗っぽさ" が出ないため、
 * Verse / Chorus 内で 4 小節周期の 3 小節目 (= 中盤の "山") を確率的に ♭VII へ置換する。
 *
 * 置換条件:
 *   - 現コードが I 系 (major) または vi 系 (minor) のときだけ (I→♭VII / vi→♭VII が自然)
 *   - セクション末尾 (= cadence 小節) は触らない
 *   - 短いセクション (3 小節未満) は触らない
 */
function applyRockBorrowedChords(
  chords: HarmonicChord[],
  scale: Scale,
  sections: SongSection[],
  rng: () => number,
): void {
  const TONIC_QUALS = new Set<ChordQuality>(["major", "maj7", "maj6", "maj9", "add9", "sus2", "sus4"]);
  const SUBMED_QUALS = new Set<ChordQuality>(["minor", "min7", "min6", "min9", "minAdd9"]);
  for (const sec of sections) {
    if (sec.kind !== "chorus" && sec.kind !== "verse") continue;
    const len = sec.endBar - sec.startBar;
    if (len < 3) continue;
    const localScale = transposeScale(scale, sec.keyOffsetSemitones);
    const bVIIRoot = (localScale.rootPitchClass + 10) % 12;
    const tonicRoot = localScale.rootPitchClass;
    const subMediantRoot = (localScale.rootPitchClass + 9) % 12;
    // 4 小節周期で 3 小節目 (idx % 4 === 2) を狙う。最終小節は除外。
    for (let i = 2; i < len - 1; i += 4) {
      const bar = sec.startBar + i;
      const ch = chords[bar];
      if (!ch) continue;
      const isTonic = ch.rootPitchClass === tonicRoot && TONIC_QUALS.has(ch.quality);
      const isSubmed = ch.rootPitchClass === subMediantRoot && SUBMED_QUALS.has(ch.quality);
      if ((isTonic || isSubmed) && rng() < 0.55) {
        chords[bar] = { rootPitchClass: bVIIRoot, quality: "major", roman: "♭VII" };
      }
    }
  }
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
  hasOtherLead: boolean,
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

    // intro / bridge: ギター/アコギがリードを担当しているなら
    // ピアノは静かな寄り添い (= ほぼ休符)。担当楽器がいなければピアノが
    // leadPhraseForBar で "歌う" リードフレーズを担当する。
    if (sec.kind === "intro" || sec.kind === "bridge") {
      const barStart = bar * 4 * beatSec;
      if (hasOtherLead) {
        // ギター系がリード → ピアノはルート保持音のみ (任意で 1 音)
        if (rng() < 0.35) {
          const pitch = pick(range.filter((m) => chordPCs.has(m % 12)), rng)
            ?? range[Math.floor(range.length / 2)];
          events.push({
            midi: pitch,
            startSec: barStart + 2 * beatSec,
            durationSec: 2 * beatSec * 0.9,
            velocity: vel * 0.55,
          });
          prevMidi = pitch;
        }
      } else {
        // ピアノがリードフレーズを担当
        const isLastBar = isSectionLastBar(sec, bar);
        const phrase = leadPhraseForBar(
          chords[bar],
          localScale,
          style,
          barInSec,
          isLastBar,
          lo,
          hi,
          vel,
          rng,
        );
        for (const n of phrase) {
          events.push({
            midi: n.midi,
            startSec: barStart + n.startBeat * beatSec,
            durationSec: Math.max(0.05, n.durationBeats * beatSec * 0.95),
            velocity: n.velocity,
          });
          prevMidi = n.midi;
        }
      }
      barInSec++;
      continue;
    }

    // Outro は半分以上を休符にして "間" を作る
    if (sec.kind === "outro" && rng() < 0.5) {
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
      // フックオープナー (サビ頭ピーク) は+0.08 ベロシティでアクセント
      const hookBoost = isChorusHookOpener ? 0.10 : 0;
      const v = Math.max(0.25, Math.min(1, vel + (slot.strong ? 0.05 : -0.08) + (rng() - 0.5) * 0.05 + hookBoost));

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

    // ===== ピックアップ (アナクルーシス) =====
    // preChorus 最終小節の 4 拍目裏 (= 16 分 4 つ目) に「サビへの繋ぎ」音を 1 つ。
    // ONE OK ROCK 系の「ダー、(息継ぎ)、↑」の感覚を狙う。
    // 次バーがサビなら、サビ最初のコード root の 半音下 (leading tone) を
    // 短く差し込む。次がサビでなければ何もしない。
    if (sec.kind === "preChorus" && isLastInSec) {
      const nextSec = sections[
        sections.findIndex((s) => s === sec) + 1
      ];
      if (nextSec && nextSec.kind === "chorus") {
        const nextChord = chords[bar + 1];
        if (nextChord) {
          // 次サビ chord の root に向けて leading tone (半音下) を選択。
          // 不協を避けるため、scale 内にあれば scale step 下を優先。
          const nextLocalScale = transposeScale(scale, nextSec.keyOffsetSemitones);
          const nextRange = scaleTonesInRange(nextLocalScale, lo, hi);
          // 候補: scale 内で root の半音下 or 全音下
          const targetPc = nextChord.rootPitchClass;
          const downHalf = ((targetPc - 1) + 12) % 12;
          const downWhole = ((targetPc - 2) + 12) % 12;
          let pickup: number | null = null;
          // 半音下 (leading tone) が scale 内なら最優先
          for (const m of nextRange) {
            if (m % 12 === downHalf) {
              if (pickup === null || Math.abs(m - (prevMidi ?? 72)) < Math.abs(pickup - (prevMidi ?? 72))) pickup = m;
            }
          }
          // 無ければ全音下
          if (pickup === null) {
            for (const m of nextRange) {
              if (m % 12 === downWhole) {
                if (pickup === null || Math.abs(m - (prevMidi ?? 72)) < Math.abs(pickup - (prevMidi ?? 72))) pickup = m;
              }
            }
          }
          if (pickup !== null) {
            const pickupStart = barStart + 3.75 * beatSec;
            const pickupDur = 0.25 * beatSec * 0.85;
            const pickupVel = Math.max(0.4, Math.min(1, vel + 0.05));
            events.push({
              midi: pickup,
              startSec: pickupStart,
              durationSec: pickupDur,
              velocity: pickupVel,
            });
            if (recordBar) {
              recordBar.push({
                midi: pickup,
                offsetInBarSec: pickupStart - barStart,
                durSec: pickupDur,
                velocity: pickupVel,
              });
            }
            prevMidi = pickup;
          }
        }
      }
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

    // -------------------------------------------------------------------
    // リズム・テンプレート: hit = "そのタイミングでフルコード", arp = "1音だけ"
    // 同じコードを毎拍ベタ打ちすると単調になるので、各セクションで
    //   ① シンコペーション (拍頭以外も使う)
    //   ② アルペジオ ↔ ブロックコードの混在
    //   ③ 休符の挿入 (ストロークの "切り")
    // の 3 つで変化を出す。
    // -------------------------------------------------------------------
    interface CompHit {
      offset: number;     // 拍 (0..4)
      kind: "block" | "arp" | "topOnly";
      durBeats: number;
      vel: number;
      arpIndex?: number;  // arp の場合に使う voicing index
    }
    const v0 = vel0;
    const top = effectiveVoicing[effectiveVoicing.length - 1];
    const mid = effectiveVoicing[Math.floor(effectiveVoicing.length / 2)] ?? top;

    let pattern: CompHit[] = [];

    if (style === "ballad") {
      // ballad: アルペジオ基本だが、コード全和音をところどころ挟む
      if (sec.kind === "chorus") {
        // 8 分アルペジオ + 1 拍頭はブロックコード
        pattern = [
          { offset: 0,    kind: "block",   durBeats: 0.45, vel: v0 * 0.85 },
          { offset: 0.5,  kind: "arp",     durBeats: 0.45, vel: v0 * 0.55, arpIndex: 2 },
          { offset: 1,    kind: "arp",     durBeats: 0.45, vel: v0 * 0.6,  arpIndex: 3 },
          { offset: 1.5,  kind: "arp",     durBeats: 0.45, vel: v0 * 0.55, arpIndex: 2 },
          { offset: 2,    kind: "block",   durBeats: 0.45, vel: v0 * 0.78 },
          { offset: 2.5,  kind: "arp",     durBeats: 0.45, vel: v0 * 0.55, arpIndex: 2 },
          { offset: 3,    kind: "arp",     durBeats: 0.45, vel: v0 * 0.6,  arpIndex: 3 },
          { offset: 3.5,  kind: "arp",     durBeats: 0.45, vel: v0 * 0.55, arpIndex: 2 },
        ];
      } else {
        // verse/intro/outro: 16 分まじりのアルペジオ (ぐっと感のあるバラード伴奏)
        // root(low) → 3rd → 5th → top → 5th → 3rd の流れ + 拍頭にブロック
        pattern = [
          { offset: 0,    kind: "block", durBeats: 1.4, vel: v0 * 0.7 },
          { offset: 1,    kind: "arp",   durBeats: 0.5, vel: v0 * 0.5, arpIndex: 2 },
          { offset: 1.5,  kind: "arp",   durBeats: 0.5, vel: v0 * 0.55, arpIndex: 3 },
          { offset: 2,    kind: "arp",   durBeats: 0.5, vel: v0 * 0.5,  arpIndex: 2 },
          { offset: 2.5,  kind: "arp",   durBeats: 0.5, vel: v0 * 0.5,  arpIndex: 1 },
          { offset: 3,    kind: "arp",   durBeats: 0.5, vel: v0 * 0.55, arpIndex: 3 },
          { offset: 3.5,  kind: "arp",   durBeats: 0.5, vel: v0 * 0.5,  arpIndex: 2 },
        ];
      }
    } else if (style === "jazz") {
      // jazz: チャールストン (1, 2.5) + bridge は 4 つ叩き、稀に "anticipation" (3.5)
      const useAnticipation = rng() < 0.4 && sec.kind !== "bridge";
      if (sec.kind === "bridge") {
        pattern = [
          { offset: 0.5, kind: "block", durBeats: 0.5, vel: v0 * 0.6 },
          { offset: 1.5, kind: "block", durBeats: 0.5, vel: v0 * 0.55 },
          { offset: 2.5, kind: "block", durBeats: 0.5, vel: v0 * 0.6 },
          { offset: 3.5, kind: "block", durBeats: 0.5, vel: v0 * 0.7 },
        ];
      } else if (useAnticipation) {
        // 1, 2.5, "3.5(次小節先取り)" のチャールストン+先取り
        pattern = [
          { offset: 0,   kind: "block", durBeats: 0.5, vel: v0 * 0.7 },
          { offset: 2.5, kind: "block", durBeats: 0.5, vel: v0 * 0.55 },
          { offset: 3.5, kind: "block", durBeats: 0.5, vel: v0 * 0.65 },
        ];
      } else {
        pattern = [
          { offset: 1,   kind: "block", durBeats: 0.55, vel: v0 * 0.6 },
          { offset: 3,   kind: "block", durBeats: 0.55, vel: v0 * 0.6 },
        ];
      }
    } else if (style === "rock") {
      // rock (ONE OK ROCK / 邦ロック 系):
      //   ピアノ/コード層はギター・ベース・ドラムが主役の "土台" の中で
      //   "色を足す" 役割なので、原則スカスカにしてギターの帯域を空ける。
      //   逆に密にするとピアノバラードっぽくなって "ロックぽくない" 原因になる。
      //
      //   verse: 1 拍頭のみ (= ロングトーン 2 ビート保持) で、ギターのリフを邪魔しない
      //   preChorus: 4 つ持ち (1,2,3,4 拍) で徐々に積み上げ + 4 拍裏で先取り
      //   chorus: 1+3 拍頭でドーン系 + 2,4 拍裏に上声シンコペで "突き上げ"
      //   bridge: 1 拍頭のロングトーン (= フレーズに譲る)
      if (sec.kind === "chorus") {
        // 力強い 1/3 拍頭ロングトーン + 2.75 のシンコペで "突き上げ"
        // 4 分基調なので 8 分密打のような pop ぽさが出ない
        pattern = [
          { offset: 0,    kind: "block",   durBeats: 0.9, vel: v0 * 0.95 },
          { offset: 1.5,  kind: "topOnly", durBeats: 0.4, vel: v0 * 0.45 }, // 上声 ghost
          { offset: 2,    kind: "block",   durBeats: 0.7, vel: v0 * 0.88 },
          { offset: 2.75, kind: "topOnly", durBeats: 0.25, vel: v0 * 0.5 }, // シンコペ (上声のみ)
          { offset: 3.5,  kind: "block",   durBeats: 0.5, vel: v0 * 0.7 },  // 次小節への接続
        ];
      } else if (sec.kind === "preChorus") {
        // 4 つ持ち (盛り上げ) + 4 拍目を 16 分プッシュで突入
        pattern = [
          { offset: 0,    kind: "block", durBeats: 0.9,  vel: v0 * 0.85 },
          { offset: 1,    kind: "block", durBeats: 0.9,  vel: v0 * 0.75 },
          { offset: 2,    kind: "block", durBeats: 0.9,  vel: v0 * 0.8 },
          { offset: 3,    kind: "block", durBeats: 0.25, vel: v0 * 0.9 },
          { offset: 3.5,  kind: "block", durBeats: 0.25, vel: v0 * 0.85 },
          { offset: 3.75, kind: "block", durBeats: 0.25, vel: v0 * 0.95 }, // 突入アクセント
        ];
      } else if (sec.kind === "bridge") {
        // フレーズ役 (ギター) に譲る — 1 拍頭のロングトーンだけ
        pattern = [
          { offset: 0,   kind: "block", durBeats: 1.8, vel: v0 * 0.65 },
          { offset: 2.5, kind: "block", durBeats: 1.4, vel: v0 * 0.6 },
        ];
      } else {
        // verse/intro/outro: 1 拍頭の "ジャーン" のみ — ギターリフが主役
        // (以前は 4 hit だったがロックでは過密だった)
        pattern = [
          { offset: 0, kind: "block", durBeats: 2.0, vel: v0 * 0.75 },
          { offset: 2, kind: "block", durBeats: 1.8, vel: v0 * 0.65 },
        ];
      }
    } else {
      // pop (BUMP OF CHICKEN 系):
      //   verse: シンコペした 3 hit + 上ボイスのアルペジオを散らす
      //   preChorus: 8 分のはずみ + 4 拍目で 16 分プッシュ
      //   chorus: 8 分カッティング + 1 拍頭ロング + シンコペ
      //   bridge: ゆったり半拍ずらし
      if (sec.kind === "chorus") {
        pattern = [
          { offset: 0,    kind: "block",   durBeats: 0.5,  vel: v0 * 0.92 },
          { offset: 0.5,  kind: "block",   durBeats: 0.4,  vel: v0 * 0.6 },
          { offset: 1,    kind: "topOnly", durBeats: 0.4,  vel: v0 * 0.55 },
          { offset: 1.5,  kind: "block",   durBeats: 0.4,  vel: v0 * 0.6 },
          { offset: 2,    kind: "block",   durBeats: 0.4,  vel: v0 * 0.8 },
          { offset: 2.5,  kind: "topOnly", durBeats: 0.4,  vel: v0 * 0.55 },
          { offset: 2.75, kind: "block",   durBeats: 0.25, vel: v0 * 0.65 }, // シンコペ
          { offset: 3.5,  kind: "block",   durBeats: 0.5,  vel: v0 * 0.65 },
        ];
      } else if (sec.kind === "preChorus") {
        pattern = [
          { offset: 0,    kind: "block",   durBeats: 0.45, vel: v0 * 0.85 },
          { offset: 0.5,  kind: "topOnly", durBeats: 0.45, vel: v0 * 0.5 },
          { offset: 1,    kind: "block",   durBeats: 0.45, vel: v0 * 0.75 },
          { offset: 1.5,  kind: "topOnly", durBeats: 0.45, vel: v0 * 0.5 },
          { offset: 2,    kind: "block",   durBeats: 0.45, vel: v0 * 0.8 },
          { offset: 2.5,  kind: "topOnly", durBeats: 0.45, vel: v0 * 0.55 },
          { offset: 3,    kind: "block",   durBeats: 0.25, vel: v0 * 0.85 },
          { offset: 3.25, kind: "block",   durBeats: 0.25, vel: v0 * 0.7 },
          { offset: 3.5,  kind: "block",   durBeats: 0.25, vel: v0 * 0.85 },
          { offset: 3.75, kind: "block",   durBeats: 0.25, vel: v0 * 0.75 },
        ];
      } else if (sec.kind === "bridge") {
        pattern = [
          { offset: 0,    kind: "block",   durBeats: 0.9, vel: v0 * 0.7 },
          { offset: 1.5,  kind: "topOnly", durBeats: 0.5, vel: v0 * 0.5 },
          { offset: 2,    kind: "block",   durBeats: 0.5, vel: v0 * 0.7 },
          { offset: 2.5,  kind: "topOnly", durBeats: 0.5, vel: v0 * 0.5 },
          { offset: 3.5,  kind: "block",   durBeats: 0.5, vel: v0 * 0.65 },
        ];
      } else {
        // verse / intro / outro: シンコペした 3 hit + 上ボイスアルペジオで密度確保
        pattern = [
          { offset: 0,    kind: "block",   durBeats: 0.7, vel: v0 * 0.75 },
          { offset: 0.75, kind: "topOnly", durBeats: 0.4, vel: v0 * 0.45 },
          { offset: 1.5,  kind: "block",   durBeats: 0.5, vel: v0 * 0.55 },
          { offset: 2,    kind: "topOnly", durBeats: 0.4, vel: v0 * 0.45 },
          { offset: 2.5,  kind: "block",   durBeats: 0.7, vel: v0 * 0.7 },
          { offset: 3.25, kind: "topOnly", durBeats: 0.4, vel: v0 * 0.45 },
        ];
      }
    }

    // パターンを実際の NoteEvent へ展開
    for (const hit of pattern) {
      const start = barStart + hit.offset * beatSec;
      const dur = hit.durBeats * beatSec;
      if (hit.kind === "block") {
        for (const m of effectiveVoicing) {
          out.push({ midi: m, startSec: start, durationSec: dur, velocity: hit.vel });
        }
      } else if (hit.kind === "topOnly") {
        // 上 2 音だけ (= "色付け" の高い音)
        const upper = effectiveVoicing.slice(-2);
        for (const m of upper) {
          out.push({ midi: m, startSec: start, durationSec: dur, velocity: hit.vel });
        }
      } else {
        // arp: 指定 index か、上から 2 番目
        const idx = hit.arpIndex ?? Math.max(0, effectiveVoicing.length - 2);
        const m = effectiveVoicing[Math.min(idx, effectiveVoicing.length - 1)] ?? mid;
        out.push({ midi: m, startSec: start, durationSec: dur, velocity: hit.vel });
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
  | "palmMute"
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
  rock:   { intro: "chord", verse: "chord",  preChorus: "chord",  chorus: "chord", bridge: "phrase", break: "chord", outro: "chord" },
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
  // [chord] Verse: 「ベースのように連続で刻む」8 分ブリッジミュート・チャグ
  //   ONE OK ROCK / Foo Fighters の Aメロでよく使われる「ズクズクズクズク…」と
  //   8 分音符で休まずブリッジミュート (palm mute) で power chord を刻むパターン。
  //   ・全音 palmMute (root + 5 + octave、durMul 0.7 / velMul 0.85) で短く詰まった音
  //   ・1, 3 拍頭はアクセント (= 0.95)、その他 8 分は中位 (= 0.78–0.82) で粒揃え
  //   ・2 小節目の 4 拍裏に 1 発だけ 16 分のオープン power を入れて「ジャッ!」と煽る
  verse: { barsLength: 2, notesPerBar: [
    [ // bar 1: 8 分 8 連続 palmMute (ズクズクズクズク…)
      { semitonesFromRoot: 0, startBeat: 0.00, durationBeats: 0.42, velocityScale: 0.95, voicing: "palmMute" },
      { semitonesFromRoot: 0, startBeat: 0.50, durationBeats: 0.42, velocityScale: 0.78, voicing: "palmMute" },
      { semitonesFromRoot: 0, startBeat: 1.00, durationBeats: 0.42, velocityScale: 0.82, voicing: "palmMute" },
      { semitonesFromRoot: 0, startBeat: 1.50, durationBeats: 0.42, velocityScale: 0.78, voicing: "palmMute" },
      { semitonesFromRoot: 0, startBeat: 2.00, durationBeats: 0.42, velocityScale: 0.95, voicing: "palmMute" },
      { semitonesFromRoot: 0, startBeat: 2.50, durationBeats: 0.42, velocityScale: 0.78, voicing: "palmMute" },
      { semitonesFromRoot: 0, startBeat: 3.00, durationBeats: 0.42, velocityScale: 0.85, voicing: "palmMute" },
      { semitonesFromRoot: 0, startBeat: 3.50, durationBeats: 0.42, velocityScale: 0.8,  voicing: "palmMute" },
    ],
    [ // bar 2: 8 連続 palmMute + 4 拍裏 16 分 1 発はオープン power (= "ズクズク…ジャッ!" の煽り)
      { semitonesFromRoot: 0, startBeat: 0.00, durationBeats: 0.42, velocityScale: 0.95, voicing: "palmMute" },
      { semitonesFromRoot: 0, startBeat: 0.50, durationBeats: 0.42, velocityScale: 0.78, voicing: "palmMute" },
      { semitonesFromRoot: 0, startBeat: 1.00, durationBeats: 0.42, velocityScale: 0.82, voicing: "palmMute" },
      { semitonesFromRoot: 0, startBeat: 1.50, durationBeats: 0.42, velocityScale: 0.78, voicing: "palmMute" },
      { semitonesFromRoot: 0, startBeat: 2.00, durationBeats: 0.42, velocityScale: 0.95, voicing: "palmMute" },
      { semitonesFromRoot: 0, startBeat: 2.50, durationBeats: 0.42, velocityScale: 0.78, voicing: "palmMute" },
      { semitonesFromRoot: 0, startBeat: 3.00, durationBeats: 0.42, velocityScale: 0.88, voicing: "palmMute" },
      { semitonesFromRoot: 0, startBeat: 3.50, durationBeats: 0.22, velocityScale: 0.85, voicing: "palmMute" },
      { semitonesFromRoot: 0, startBeat: 3.75, durationBeats: 0.22, velocityScale: 0.95, voicing: "power" },
    ],
  ]},
  // [chord] Pre-Chorus: 「ベースのように連続」+ 16 分ビルドアップ
  //   旧: ペンタトニック・リード (single/double5/octaveUnison) → サビ前のリード過多
  //   新: 8 分 → 16 分へとパワーコードの密度が増していくビルドアップ。
  //       前半 (0–2 拍): 8 分 4 発 / 後半 (2–4 拍): 16 分 8 発で「ザクザクザクザク」とサビに突入
  preChorus: { barsLength: 1, notesPerBar: [[
    // 前半: 8 分 4 発 (連続)
    { semitonesFromRoot: 0, startBeat: 0.00, durationBeats: 0.42, velocityScale: 0.85, voicing: "power" },
    { semitonesFromRoot: 0, startBeat: 0.50, durationBeats: 0.42, velocityScale: 0.78, voicing: "power" },
    { semitonesFromRoot: 0, startBeat: 1.00, durationBeats: 0.42, velocityScale: 0.88, voicing: "power" },
    { semitonesFromRoot: 0, startBeat: 1.50, durationBeats: 0.42, velocityScale: 0.82, voicing: "power" },
    // 後半: 16 分 8 発 (密度上昇 = build-up)
    { semitonesFromRoot: 0, startBeat: 2.00, durationBeats: 0.22, velocityScale: 0.9,  voicing: "power" },
    { semitonesFromRoot: 0, startBeat: 2.25, durationBeats: 0.22, velocityScale: 0.82, voicing: "power" },
    { semitonesFromRoot: 0, startBeat: 2.50, durationBeats: 0.22, velocityScale: 0.88, voicing: "power" },
    { semitonesFromRoot: 0, startBeat: 2.75, durationBeats: 0.22, velocityScale: 0.85, voicing: "power" },
    { semitonesFromRoot: 0, startBeat: 3.00, durationBeats: 0.22, velocityScale: 0.95, voicing: "power" },
    { semitonesFromRoot: 0, startBeat: 3.25, durationBeats: 0.22, velocityScale: 0.9,  voicing: "power" },
    { semitonesFromRoot: 0, startBeat: 3.50, durationBeats: 0.22, velocityScale: 0.98, voicing: "power" },
    { semitonesFromRoot: 0, startBeat: 3.75, durationBeats: 0.22, velocityScale: 1.0,  voicing: "power" },
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
        power: ["palmMute", "mute"],
        palmMute: ["power", "mute"],
        mute: ["palmMute", "power"],
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

// ---------------------------------------------------------------------------
// フィーチャー・リード (intro / bridge 用ソロフレーズ)
//
// 「イントロや間奏で、ギターを使っているときはギターで、ピアノを使っている
// ときはピアノでかっこいいフレーズを入れる」ためのフレーズビルダ。
//
// 1 小節分のメロディックリードを (startBeat, durationBeats, midi, velocity)
// として返す。midi は絶対値、velocity も絶対値 (0..1)。
//
// 思想:
//   - 強拍 (1, 3 拍目) はコードトーンで着地させる
//   - 弱拍 (1.5, 2.5, 3.5 拍目) はスケール経過音/隣接音で歌う
//   - barInSec に応じてフレーズ形を変えて単調さを避ける
//       bar 0: 「お題提示」(コール) — 後半に長音で間を作る
//       bar 1: 「展開」(8分主体のフレーズライン)
//       bar 2+: 「ペンタトニック / ビバップ風リック」(シンコペ)
//       最終 bar: 「解決」(下降してルートにロングトーン着地)
//   - loMidi..hiMidi 範囲を超える音は出さない (= 楽器の音域に従う)
//   - スケール外音は出さない (= 音外し防止)
//
// 戻り値は startBeat 昇順とは限らないため、呼び出し側でソートすること。
// ---------------------------------------------------------------------------
interface LeadNote {
  startBeat: number;
  durationBeats: number;
  midi: number;
  velocity: number;
}

function leadPhraseForBar(
  chord: HarmonicChord,
  scale: Scale,
  _style: ComposerStyle,
  barInSec: number,
  isLastBar: boolean,
  loMidi: number,
  hiMidi: number,
  velBase: number,
  rng: () => number,
): LeadNote[] {
  const scaleTones = scaleTonesInRange(scale, loMidi, hiMidi);
  if (scaleTones.length < 4) return [];
  const chordIntervals = chordToneSet(chord);
  const chordPCSet = new Set(
    chordIntervals.map((iv) => (((chord.rootPitchClass + iv) % 12) + 12) % 12),
  );
  const chordTones = scaleTones.filter((m) => chordPCSet.has(((m % 12) + 12) % 12));
  if (chordTones.length === 0) return [];

  const centerMidi = Math.floor((loMidi + hiMidi) / 2);
  const clampToRange = (m: number) => Math.max(loMidi, Math.min(hiMidi, m));

  const nearestChordTo = (target: number): number => {
    let best = chordTones[0];
    let bd = Math.abs(best - target);
    for (const m of chordTones) {
      const d = Math.abs(m - target);
      if (d < bd) {
        best = m;
        bd = d;
      }
    }
    return best;
  };
  const stepInScale = (cur: number, dir: 1 | -1): number => {
    const i = scaleTones.indexOf(cur);
    if (i === -1) {
      // cur がスケール外なら最も近い chord トーンに飛ぶ (= レンジ内に必ず戻る)
      return nearestChordTo(cur + dir);
    }
    const j = Math.max(0, Math.min(scaleTones.length - 1, i + dir));
    return scaleTones[j];
  };
  const nearestChordAbove = (cur: number): number => {
    const above = chordTones.filter((m) => m > cur);
    return above.length ? above[0] : chordTones[chordTones.length - 1];
  };
  const nearestChordBelow = (cur: number): number => {
    const below = chordTones.filter((m) => m < cur);
    return below.length ? below[below.length - 1] : chordTones[0];
  };

  const out: LeadNote[] = [];
  const push = (sb: number, db: number, midi: number, vel: number) => {
    out.push({
      startBeat: sb,
      durationBeats: db,
      midi: clampToRange(midi),
      velocity: Math.max(0.18, Math.min(1, vel)),
    });
  };

  // ---- 最終 bar: 解決ロングトーン ----
  if (isLastBar) {
    const rootInRange = scaleTones.find((m) => m % 12 === chord.rootPitchClass);
    const rootCenter = rootInRange ?? nearestChordTo(centerMidi);
    let cur = nearestChordTo(centerMidi + 5); // 高めから降りる
    const rhythm = [0.0, 0.5, 1.0, 1.5, 2.0];
    for (let i = 0; i < rhythm.length; i++) {
      push(rhythm[i], 0.45, cur, velBase * (0.6 + i * 0.04));
      cur = stepInScale(cur, -1);
    }
    // 半音アプローチ → ルート着地 (ロング)
    push(2.5, 0.22, rootCenter + 1, velBase * 0.7);
    push(2.75, 1.2, rootCenter, velBase * 0.95);
    return out;
  }

  // ---- bar 0: オープン (コール風) ----
  if (barInSec === 0) {
    const high = nearestChordTo(centerMidi + 5);
    const helper = stepInScale(high, -1);
    const land = nearestChordTo(centerMidi);
    const above = nearestChordAbove(land);
    push(0.0, 0.45, high, velBase * 0.85);
    push(0.5, 0.22, helper, velBase * 0.65);
    push(0.75, 0.22, high, velBase * 0.7);
    push(1.5, 0.5, stepInScale(high, -1), velBase * 0.7);
    push(2.0, 0.45, above, velBase * 0.8);
    push(2.5, 0.22, stepInScale(above, 1), velBase * 0.6);
    push(3.0, 0.9, land, velBase * 0.85);
    return out;
  }

  // ---- bar 1: 展開 (8 分主体のラインで上下) ----
  if (barInSec === 1) {
    let cur = nearestChordTo(centerMidi - 3);
    const rhythm = [0.0, 0.5, 1.0, 1.25, 1.5, 2.0, 2.5, 3.0, 3.5];
    const dirs: (1 | -1)[] = [1, 1, 1, 1, -1, 1, -1, -1, -1];
    for (let i = 0; i < rhythm.length; i++) {
      const isStrong = i % 2 === 0;
      push(
        rhythm[i],
        i === rhythm.length - 1 ? 0.5 : 0.42,
        cur,
        velBase * (isStrong ? 0.8 : 0.6) + (rng() - 0.5) * 0.04,
      );
      cur = stepInScale(cur, dirs[i]);
    }
    return out;
  }

  // ---- bar 2+: ペンタトニック / ビバップ風リック ----
  const high = nearestChordTo(centerMidi + 7);
  const mid = nearestChordTo(centerMidi);
  const low = nearestChordBelow(mid);
  const aboveLow = nearestChordAbove(low);
  push(0.0, 0.42, high, velBase * 0.9);
  push(0.5, 0.22, stepInScale(high, -1), velBase * 0.6);
  push(0.75, 0.22, mid, velBase * 0.7);
  push(1.0, 0.42, stepInScale(mid, 1), velBase * 0.75);
  push(1.5, 0.42, high, velBase * 0.85);
  push(2.0, 0.22, stepInScale(high, -1), velBase * 0.65);
  push(2.25, 0.22, mid, velBase * 0.7);
  push(2.5, 0.42, stepInScale(mid, -1), velBase * 0.7);
  push(3.0, 0.5, low, velBase * 0.75);
  push(3.5, 0.45, aboveLow, velBase * 0.8);
  return out;
}

/**
 * ボイシング指定 (lead/powerChord/palmMute) を 1 小節分の RiffNote に適用する。
 * chord 役セクション (verse/preChorus/chorus/outro) のみ対象。
 * intro / bridge / break は元のフレーズ生成器に任せる (歌うリード/フィル等)。
 */
function overrideVoicingForBar(
  baseBarNotes: RiffNote[],
  voicing: GuitarVoicingStyle,
  beatsPerBar = 4,
): RiffNote[] {
  if (voicing === "auto") return baseBarNotes;
  if (voicing === "lead") {
    // リード強制: 既存リフを廃棄して 8 分のペンタトニック単音ラインに置き換える
    //   1, 3, 5, 7 度を交互に上下するシンプルな線。
    const degrees = [0, 7, 12, 7, 10, 7, 5, 3];
    return Array.from({ length: 8 }, (_, i) => ({
      semitonesFromRoot: degrees[i] ?? 0,
      startBeat: i * (beatsPerBar / 8),
      durationBeats: (beatsPerBar / 8) * 0.92,
      velocityScale: i % 2 === 0 ? 0.9 : 0.75,
      voicing: "single" as RiffVoicing,
    }));
  }
  // powerChord / palmMute: 8 分連打を生成
  const targetVoicing: RiffVoicing = voicing === "powerChord" ? "power" : "palmMute";
  const accentVelocity = voicing === "powerChord" ? 0.95 : 0.92;
  const passVelocity = voicing === "powerChord" ? 0.78 : 0.78;
  return Array.from({ length: 8 }, (_, i) => ({
    semitonesFromRoot: 0,
    startBeat: i * (beatsPerBar / 8),
    durationBeats: (beatsPerBar / 8) * (voicing === "powerChord" ? 0.95 : 0.84),
    velocityScale: (i === 0 || i === 4) ? accentVelocity : passVelocity,
    voicing: targetVoicing,
  }));
}

function generateGuitarLayer(
  chords: HarmonicChord[],
  scale: Scale,
  sections: SongSection[],
  bpm: number,
  style: ComposerStyle,
  rng: () => number,
  guitarVoicing: GuitarVoicingStyle = "auto",
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

    // intro / bridge: 静的リフの代わりに leadPhraseForBar で
    // 「コード&スケール対応の歌うリードフレーズ」をその場で生成する。
    // ギター音域 E3 (52) .. E5 (76)。各拍頭にオクターブ下を薄く重ねて
    // 太い "オクターブユニゾン" 感を出す。
    if (sec.kind === "intro" || sec.kind === "bridge") {
      // ロックのイントロ: 「歌うリード」ではなく、ONE OK ROCK / Foo Fighters 系の
      // パームミュート 8 分 + コード突き刺し ("ザクザクザクザクジャーン" のリフ) を生成。
      // これは Sweet Child o' Mine 型のオクターブ・ラインではなく、より日本のロックバンド
      // (= 全パートが頭から鳴っている塊感) を狙ったパターン。
      if (style === "rock" && sec.kind === "intro") {
        const pattern: RockIntroPattern = sec.rockIntroPattern ?? "riffLed";
        const phase = getRockIntroPhase(sec, bar);
        const power = [root, root + 7, root + 12];
        const fullPower = fullVoicing.slice(0, 4);
        const emitRiffBar = () => {
          // 既存のパームミュート 8 分 + 4 拍裏突き刺し
          for (let i = 0; i < 8; i++) {
            const t = barStart + i * (beatSec / 2);
            const isAccent = i === 0 || i === 4;
            const isStab = i === 7;
            if (isStab) {
              for (const m of fullPower) {
                out.push({ midi: m, startSec: t, durationSec: beatSec * 0.85, velocity: Math.min(1, vel0 * 1.1) });
              }
            } else {
              const dur = beatSec * 0.22;
              const vel = Math.max(0.5, vel0 * (isAccent ? 1.0 : 0.78));
              for (const m of power) {
                out.push({ midi: m, startSec: t, durationSec: dur, velocity: vel });
              }
            }
          }
        };
        const emitCleanArpBar = () => {
          // クリーンアルペジオ: 単音で root, 5度, oct, 3度上 を上昇 (8 分音符 8 個)
          const third = fullVoicing.find((m) => ((m - root) % 12 + 12) % 12 === 4 || ((m - root) % 12 + 12) % 12 === 3) ?? root + 4;
          const arpNotes = [root, root + 7, root + 12, third + 12, root + 12, root + 7, third, root];
          for (let i = 0; i < 8; i++) {
            const t = barStart + i * (beatSec / 2);
            const dur = beatSec * 0.55;
            const vel = Math.max(0.4, vel0 * 0.7);
            out.push({ midi: arpNotes[i], startSec: t, durationSec: dur, velocity: vel });
          }
        };
        if (pattern === "vocalLed") {
          // preEntry はギター無音 → バンドインで全力リフ
          if (phase === "preEntry") {
            barInSec++;
            continue;
          }
          emitRiffBar();
          barInSec++;
          continue;
        }
        if (pattern === "cleanArpDistortion") {
          // preEntry はクリーンアルペジオ → バンドインで歪みリフ
          if (phase === "preEntry") {
            emitCleanArpBar();
          } else {
            emitRiffBar();
          }
          barInSec++;
          continue;
        }
        // riffLed (既存): イントロ全体で歪みリフ
        emitRiffBar();
        barInSec++;
        continue;
      }
      const localScale = transposeScale(scale, sec.keyOffsetSemitones);
      const isLastBar = isSectionLastBar(sec, bar);
      const phrase = leadPhraseForBar(
        chords[bar],
        localScale,
        style,
        barInSec,
        isLastBar,
        52,
        76,
        Math.max(0.5, vel0 * 1.05),
        rng,
      );
      for (const n of phrase) {
        const startSec = barStart + n.startBeat * beatSec;
        const durationSec = Math.max(0.05, n.durationBeats * beatSec * 0.95);
        out.push({ midi: n.midi, startSec, durationSec, velocity: n.velocity });
        // 拍頭 (整数拍) は太く: オクターブ下を半分の音量で重ねる
        const beatFrac = n.startBeat - Math.floor(n.startBeat);
        if (beatFrac < 0.05 && n.midi - 12 >= 40) {
          out.push({
            midi: n.midi - 12,
            startSec,
            durationSec: Math.max(0.05, durationSec * 0.7),
            velocity: n.velocity * 0.55,
          });
        }
      }
      barInSec++;
      continue;
    }

    const riff = GUITAR_RIFF_LIBRARY[style][sec.kind] ?? EMPTY_RIFF;
    let baseBarNotes = riff.notesPerBar[barInSec % riff.barsLength];

    // ユーザーがギターのボイシングを明示指定している場合、
    // chord 役セクション (verse/preChorus/chorus/outro) を上書きする。
    // intro / bridge / break は上の早期 return 分岐で扱われているのでここには来ない。
    //   - "lead"       → 8 分ペンタトニック・リード (single)
    //   - "powerChord" → 8 分パワーコード連打 (power)
    //   - "palmMute"   → 8 分パームミュート連打 (palmMute)
    if (guitarVoicing !== "auto") {
      baseBarNotes = overrideVoicingForBar(baseBarNotes, guitarVoicing);
    }

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
          // 軽いパームミュート/スクラッチ相当 — パワーコードの低 2 音だけを短く弱く
          pitches = [baseMidiForNote, baseMidiForNote + 7];
          durMul = 0.55;
          velMul = 0.7;
          break;
        case "palmMute":
          // フル・ブリッジミュート — power と同じ root + 5 + octave を、
          // ブリッジ寄りで掌底ミュートして「ズクズク」と 8 分連続で刻む向け。
          // power よりは短く・少しソフトだが、mute よりは芯が残る中間的サステイン。
          pitches = [baseMidiForNote, baseMidiForNote + 7, baseMidiForNote + 12];
          durMul = 0.7;
          velMul = 0.85;
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
  scale: Scale,
  sections: SongSection[],
  bpm: number,
  style: ComposerStyle,
  hasGuitarLead: boolean,
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
    const barInSec = bar - sec.startBar;

    if (sec.kind === "break") {
      // 1 拍目に低音 root のみ余韻
      out.push({ midi: root, startSec: barStart, durationSec: beatSec * 0.7, velocity: 0.55 });
      continue;
    }
    if (sec.kind === "intro" || sec.kind === "bridge") {
      // ロックイントロ: パターン別の挙動 (cleanArpDistortion の preEntry をアコギで前に出す)
      if (style === "rock" && sec.kind === "intro") {
        const pattern: RockIntroPattern = sec.rockIntroPattern ?? "riffLed";
        const phase = getRockIntroPhase(sec, bar);
        if (pattern === "vocalLed" && phase === "preEntry") {
          // 歌だけ: アコギも休む
          continue;
        }
        if (pattern === "cleanArpDistortion" && phase === "preEntry") {
          // クリーン・アルペジオ (アコギで歌うように。8 分粒で root - 3rd - 5th - oct - 5th - 3rd - 5th - 3rd)
          const arpPattern = [0, 1, 2, 3, 2, 1, 2, 1];
          for (let i = 0; i < 8; i++) {
            out.push({
              midi: arp[arpPattern[i] % arp.length],
              startSec: barStart + i * (beatSec / 2),
              durationSec: beatSec * 0.7,
              velocity: Math.max(0.45, vel0 * (i === 0 ? 0.85 : 0.65)),
            });
          }
          continue;
        }
        if (pattern === "riffLed" || phase === "bandEntry") {
          // バンドイン: アコギは静かな分散和音でエレキの陰に隠れる
          for (let i = 0; i < 4; i++) {
            out.push({
              midi: arp[i % arp.length],
              startSec: barStart + i * beatSec,
              durationSec: beatSec * 1.1,
              velocity: vel0 * 0.4,
            });
          }
          continue;
        }
      }
      if (!hasGuitarLead) {
        // ギターがいないので acoustic がリードフレーズを担当
        const localScale = transposeScale(scale, sec.keyOffsetSemitones);
        const isLastBar = isSectionLastBar(sec, bar);
        const phrase = leadPhraseForBar(
          chords[bar],
          localScale,
          style,
          barInSec,
          isLastBar,
          48, // C3
          72, // C5
          Math.max(0.45, vel0 * 0.95),
          rng,
        );
        for (const n of phrase) {
          out.push({
            midi: n.midi,
            startSec: barStart + n.startBeat * beatSec,
            durationSec: Math.max(0.05, n.durationBeats * beatSec),
            velocity: n.velocity,
          });
        }
      } else {
        // ギターがリードを取るので静かな分散和音で寄り添う
        for (let i = 0; i < 4; i++) {
          out.push({
            midi: arp[i % arp.length],
            startSec: barStart + i * beatSec,
            durationSec: beatSec * 1.1,
            velocity: vel0 * 0.45,
          });
        }
      }
      continue;
    }
    if (sec.kind === "outro") {
      // 静かな分散和音 (アウトロは余韻)
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

  // 最終サビ直前のセクションを特定 (ラスサビ前ドロップ用)
  let finalChorusIdx = -1;
  for (let i = sections.length - 1; i >= 0; i--) {
    if (sections[i].kind === "chorus") { finalChorusIdx = i; break; }
  }
  const preFinal = finalChorusIdx > 0 ? sections[finalChorusIdx - 1] : null;

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
    // ラスサビ直前の最終小節: 前半だけ鳴らして後半を完全に "落とす"
    const dropBeforeFinal =
      preFinal !== null && sec === preFinal && isSectionLastBar(sec, bar);
    if (dropBeforeFinal) {
      // 2 拍だけ強めのルート (= 最後の溜め)
      out.push({
        midi: root,
        startSec: barStart,
        durationSec: 2 * beatSec * 0.9,
        velocity: vel0 * 0.95,
      });
      continue;
    }

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
      // ロックイントロ: パターン別の挙動
      if (style === "rock" && sec.kind === "intro") {
        const pattern: RockIntroPattern = sec.rockIntroPattern ?? "riffLed";
        const phase = getRockIntroPhase(sec, bar);
        if (pattern === "vocalLed" && phase === "preEntry") {
          // 歌だけのプリエントリー: ベース無音
          continue;
        }
        if (pattern === "cleanArpDistortion" && phase === "preEntry") {
          // クリーンアルペジオ中: ベースは長音ルートで薄く支える
          out.push({
            midi: root,
            startSec: barStart,
            durationSec: 4 * beatSec * 0.95,
            velocity: vel0 * 0.5,
          });
          continue;
        }
        // バンドイン / riffLed: 8 分ルートドライブ (ギターのリフに同期)
        for (let i = 0; i < 8; i++) {
          const t = barStart + i * (beatSec / 2);
          const isAccent = i === 0 || i === 4;
          out.push({
            midi: root,
            startSec: t,
            durationSec: beatSec * 0.42,
            velocity: Math.max(0.5, vel0 * (isAccent ? 0.95 : 0.75)),
          });
        }
        continue;
      }
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
      // ロック (ONE OK ROCK 系): セクションごとに表情を変える
      //   verse: 8 分ルートドライブ + 拍頭強・裏弱 + 時々オクターブジャンプ
      //   preChorus: 4 つ打ち + 4 拍目で 16 分シンコペ (サビへの加速)
      //   chorus: 8 分の ルート⇄オクターブ 上下 (ヒーロー感) + 3 拍目 5 度
      //   bridge: フィルイン的な動き (タイミング崩し)
      if (sec.kind === "chorus") {
        // 8 分: root-root-oct-fifth-root-oct-fifth-(approach to next)
        // ONE OK ROCK サビの「重く跳ねる」感を狙う。
        // バックビート同期: 2 拍 (b=2) と 4 拍 (b=6) のアクセントを更に強くし、
        // スネアと一体感を作る (= ロックの "ハマる" 感)。
        const seq = [root, root, octave, fifth, root, octave, fifth, octave];
        for (let b = 0; b < 8; b++) {
          const isOnBeat = b % 2 === 0;
          const isBackbeat = b === 2 || b === 6; // 2 拍頭 / 4 拍頭
          const isDownbeat = b === 0 || b === 4; // 1 拍頭 / 3 拍頭
          const vScale = isBackbeat ? 1.0
            : isDownbeat ? 0.92
            : isOnBeat ? 0.85
            : 0.68;
          out.push({
            midi: seq[b],
            startSec: barStart + b * (beatSec / 2),
            durationSec: beatSec * 0.45,
            velocity: vel0 * vScale,
          });
        }
      } else if (sec.kind === "preChorus") {
        // 4 つ打ち (1,2,3 拍) + 4 拍目を 16 分 root-root-root-approach で煽る
        for (let b = 0; b < 3; b++) {
          out.push({
            midi: root,
            startSec: barStart + b * beatSec,
            durationSec: beatSec * 0.92,
            velocity: vel0 * 0.92,
          });
        }
        // 4 拍目 = 16 分プッシュ (サビへの「ダッ・ダッ・ダッ・ダ」)
        for (let i = 0; i < 4; i++) {
          out.push({
            midi: root,
            startSec: barStart + 3 * beatSec + i * (beatSec / 4),
            durationSec: beatSec * 0.22,
            velocity: vel0 * (0.85 + i * 0.04),
          });
        }
      } else {
        // verse: 8 分ドライブ、拍頭強。3 拍目で 5 度に上がる定番形
        for (let b = 0; b < 8; b++) {
          const isThirdBeat = b === 4; // 3 拍目頭
          const isOctAccent = b === 6 && rng() < 0.4; // 4 拍目頭でオクターブジャンプ
          out.push({
            midi: isOctAccent ? octave : (isThirdBeat ? fifth : root),
            startSec: barStart + b * (beatSec / 2),
            durationSec: beatSec * 0.45,
            velocity: vel0 * (b % 2 === 0 ? 0.9 : 0.62),
          });
        }
      }
    } else {
      // pop (BUMP OF CHICKEN 系): メロディアスで動きのあるベース
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
        // 1,2,3 拍 4 つ打ち + 4 拍目 16 分ドライブ
        for (let b = 0; b < 3; b++) {
          out.push({
            midi: root,
            startSec: barStart + b * beatSec,
            durationSec: beatSec * 0.9,
            velocity: vel0 * 0.88,
          });
        }
        for (let i = 0; i < 4; i++) {
          out.push({
            midi: i === 3 ? octave : root,
            startSec: barStart + 3 * beatSec + i * (beatSec / 4),
            durationSec: beatSec * 0.22,
            velocity: vel0 * (0.8 + i * 0.05),
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

    // 小節最後で次コードへのクロマチック/全音アプローチノート
    // 確率を 35% → 60% に。ロック・ポップで「歌うベースライン」を作る。
    // 次ルートの高低に応じて半音上 or 半音下を選ぶ (= 自然な下降/上昇導音)。
    // (break/intro/outro はこの時点で continue 済み)
    if (bar + 1 < chords.length) {
      const next = chords[bar + 1];
      let nextRoot = baseMidi;
      while (nextRoot % 12 !== next.rootPitchClass) nextRoot += 1;
      if (nextRoot > 48) nextRoot -= 12;
      const useChromatic = rng() < 0.6;
      if (useChromatic && nextRoot !== root) {
        // 次ルートが上なら半音下から、下なら半音上から接近 (= 自然な歌うベース)
        const approach = nextRoot + (nextRoot > root ? -1 : 1);
        out.push({
          midi: approach,
          startSec: barStart + 3.5 * beatSec,
          durationSec: beatSec * 0.45,
          velocity: vel0 * 0.55,
        });
      }
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

  // 最終サビ (最後の chorus セクション) のインデックスを特定。
  // ONE OK ROCK / BUMP OF CHICKEN 系では「ラスサビ直前の一瞬の無音」が定番。
  let finalChorusIdx = -1;
  for (let i = sections.length - 1; i >= 0; i--) {
    if (sections[i].kind === "chorus") { finalChorusIdx = i; break; }
  }
  const finalChorus = finalChorusIdx >= 0 ? sections[finalChorusIdx] : null;
  // ラスサビ直前のセクション (通常 preChorus or bridge)
  const preFinal = finalChorusIdx > 0 ? sections[finalChorusIdx - 1] : null;

  // セクション kind 別の「何回目の登場か」を 1-indexed で記録
  //   = 1番Aメロ / 2番Aメロ / 落ちサビ / 1番Bメロ / 2番Bメロ ... を区別するための情報。
  // これで「2番Aメロは1番より密度高め」「2回目のブリッジはタム中心」等の展開を作れる。
  const occIndex = new Map<SongSection, number>();
  const countByKind: Record<SectionKind, number> = {
    intro: 0, verse: 0, preChorus: 0, chorus: 0, bridge: 0, break: 0, outro: 0,
  };
  for (const s of sections) {
    countByKind[s.kind] += 1;
    occIndex.set(s, countByKind[s.kind]);
  }

  // セクションが「ラスサビ直前」かどうか
  const isPreFinal = (s: SongSection) =>
    preFinal !== null && s === preFinal;
  // セクションが「ラスサビ本体」かどうか
  const isFinalChorus = (s: SongSection) =>
    finalChorus !== null && s === finalChorus;

  for (let bar = 0; bar < bars; bar++) {
    const sec = sectionAtBar(sections, bar);
    const barStart = bar * 4 * beatSec;
    const intensity = sec.intensity;
    const isSectionStart = bar === sec.startBar;
    const isSectionLast = isSectionLastBar(sec, bar);
    // ラスサビ直前の最終小節 → ドラム後半を完全に止める ("溜め")
    const dropBeforeFinal = isPreFinal(sec) && isSectionLast;
    // ラスサビの 1 小節目 → クラッシュ/キックをさらに強める
    const finalChorusHead = isFinalChorus(sec) && isSectionStart;

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
      // ラスサビ頭は更に強い "爆発"
      const headBoost = finalChorusHead ? 0.15 : 0;
      addNote(out, DRUM_CRASH_MIDI, barStart, Math.min(1, intensity + 0.05 + headBoost));
      addNote(out, DRUM_KICK_MIDI, barStart, Math.min(1, 0.95 + headBoost));
      // ラスサビ頭は左右に大クラッシュ感を出すため2枚目クラッシュ
      if (finalChorusHead) {
        addNote(out, DRUM_CRASH_MIDI, barStart + beatSec * 0.05, 0.85);
      }
    }
    // サビの 4 小節毎にもクラッシュを追加 (= "うねり" を作る)
    // ONE OK ROCK の Chorus は 1 + 5 拍目にしっかりシンバルが入る
    if (
      sec.kind === "chorus" &&
      !isSectionStart &&
      (bar - sec.startBar) % 4 === 0
    ) {
      addNote(out, DRUM_CRASH_MIDI, barStart, intensity * 0.9);
    }

    if (sec.kind === "intro" || sec.kind === "outro") {
      // ロックイントロ: パターン別の挙動
      if (style === "rock" && sec.kind === "intro") {
        const pattern: RockIntroPattern = sec.rockIntroPattern ?? "riffLed";
        const phase = getRockIntroPhase(sec, bar);
        if (pattern === "vocalLed" && phase === "preEntry") {
          // 完全無音 (歌だけのプリエントリー)
          continue;
        }
        if (pattern === "cleanArpDistortion" && phase === "preEntry") {
          // クリーンアルペジオ中: ハイハット 4 分のみで支える
          for (let b = 0; b < 4; b++) {
            addNote(out, DRUM_HIHAT_MIDI, barStart + b * beatSec, intensity * 0.45);
          }
          continue;
        }
        // バンドイン / riffLed: 8 ビートでバンドの塊感を出す
        // フィル: イントロ最終小節は派手にフィルイン
        addNote(out, DRUM_KICK_MIDI, barStart, intensity * 1.0);
        addNote(out, DRUM_SNARE_MIDI, barStart + 2 * beatSec, intensity * 0.95);
        if (!isSectionLast) {
          addNote(out, DRUM_KICK_MIDI, barStart + 2.5 * beatSec, intensity * 0.8);
        }
        // 8 分ハイハット
        for (let b = 0; b < 8; b++) {
          const t = barStart + b * (beatSec / 2);
          const isOpen = b === 7;
          addNote(out, isOpen ? DRUM_HIHAT_OPEN_MIDI : DRUM_HIHAT_MIDI, t, intensity * (b % 2 === 0 ? 0.7 : 0.55));
        }
        // バンドイン最初の小節: クラッシュ強打
        if (phase === "bandEntry" && (bar - sec.startBar) === Math.floor((sec.endBar - sec.startBar) / 2)) {
          addNote(out, DRUM_CRASH_MIDI, barStart, intensity * 1.0);
        }
        if (isSectionLast) {
          addNote(out, DRUM_TOM_LO_MIDI, barStart + 3 * beatSec, intensity * 0.85);
          addNote(out, DRUM_TOM_MID_MIDI, barStart + 3.5 * beatSec, intensity * 0.9);
        }
        continue;
      }
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
      //
      // 【サビ・パターン・ローテーション】
      // サビごとに 4 種類のパターンを切替 (= 「FX のあとは必ずライド」を回避):
      //   pattern 0 : 王道 8 ビート (closed hat 8th + 4 拍裏オープン)        … rock デフォルト
      //   pattern 1 : ONE OK ROCK「完全感覚Dreamer」サビ風 (全拍クラッシュ)    … 爆発的
      //   pattern 2 : 16 分閉じハット (= Tomoya 風アップダウン)               … 疾走感
      //   pattern 3 : 裏拍ライド (= pop デフォルト、jazz 寄り広がり)            … 広がり
      // chorusPatternId は「サビセクションの startBar」で決まる (= 毎サビ違う)
      const chorusPatternId = sec.kind === "chorus"
        ? (style === "rock"
            // rock: 0 / 1 / 2 を中心にローテ (ride は出さない)
            ? [0, 1, 2, 0, 1, 2][sec.startBar % 6] ?? 0
            // pop: 0 / 3 / 1 をローテ (ride 比率を下げる)
            : [0, 3, 1, 0, 3, 1][sec.startBar % 6] ?? 0)
        : 0;

      // 【Verse パターンローテ】1番Aメロ / 2番Aメロ / 3番... の登場順で雰囲気を変える。
      //   0: 標準 8 ビート (1番Aメロ = シンプルに歌を聞かせる)
      //   1: 16 分密度 + キックシンコペ (2番Aメロ = 一度サビを通った後の "戻り" を密度で表現)
      //   2: ハーフタイム感 (3番以降 / 落ちAメロ = リリース感)
      // ※ rock の場合は元々スリップビート等で変化が付くため、Aメロ密度を半分の確率で上書きする
      const verseOcc = occIndex.get(sec) ?? 1;
      const versePatternId = sec.kind === "verse"
        ? Math.min(2, verseOcc - 1)
        : 0;

      // 【Bridge パターンローテ】曲中に複数登場するブリッジを変化させる。
      //   0: 標準 (既存の 8 ビート + ライド) — 1 回目のブリッジ
      //   1: タムワーク中心 (= breakdown 感) — 2 回目のブリッジ
      //   2: ハーフタイム / ライドオンリー (= 落ちブリッジ) — 3 回目以降
      const bridgeOcc = occIndex.get(sec) ?? 1;
      const bridgePatternId = sec.kind === "bridge"
        ? Math.min(2, bridgeOcc - 1)
        : 0;

      // 【PreChorus 段階的盛り上げ】サビ前は 1 小節目→終盤に向けて密度を上げる。
      //   セクション長が 2 小節以上の時、後半小節は前半より 16 分密度を上げる。
      const preChorusBarPos = bar - sec.startBar;
      const preChorusLen = sec.endBar - sec.startBar;
      // 0 (序盤) 〜 1 (終盤) の度合い
      const preChorusBuildRatio = preChorusLen > 1
        ? preChorusBarPos / Math.max(1, preChorusLen - 1)
        : 1;
      // キック
      //   chorus: 王道 8 ビート「ドン・カッ・ドコッ・カッ」(= 0, 2, 2.5) を基本に、
      //           パターン 1 (爆発) と 2 (16 分) で踏み変える。
      //   preChorus: 16 分シンコペ
      //   verse: シンプル 1+3。ただし Tomoya「スリップビート」(スネア半拍遅れ) も時々入る。
      // verse の occurrence 別キック:
      //   pattern 0 (1番Aメロ): シンプル「ドンカッ・ドンドンカッ」基本
      //   pattern 1 (2番Aメロ): 16 分シンコペで密度↑
      //   pattern 2 (落ちAメロ): ハーフタイム = キック [0] のみ
      const verseKickRock = versePatternId === 1
        ? [0, 1.5, 2, 2.5]        // 2番: シンコペ密度
        : versePatternId === 2
          ? [0]                    // 落ち: 1 発のみ
          : [0, 2, 2.5];           // 1番: 標準 8 beat
      const verseKickPop = versePatternId === 1
        ? [0, 1.5, 2, 3]
        : versePatternId === 2
          ? [0]
          : [0, 2];
      // bridge の occurrence 別キック:
      //   pattern 0: 標準 8 ビート感
      //   pattern 1: タムワーク中心 = キック [0, 2.5] (薄め)
      //   pattern 2: ハーフタイム = キック [0] のみ
      const bridgeKickRock = bridgePatternId === 1
        ? [0, 2.5]
        : bridgePatternId === 2
          ? [0]
          : [0, 2, 2.5];
      const bridgeKickPop = bridgePatternId === 1
        ? [0, 2.5]
        : bridgePatternId === 2
          ? [0]
          : [0, 1.75, 2];

      const kickSlots = style === "rock"
        ? (sec.kind === "chorus"
            // chorus パターン別キック (rock は常に「ドンカッ・ドンドンカッ」8 ビート系。
            // ポップな 4 つ打ちは pop 専用。):
            //   0: 王道 8 ビート 「ドンカッ・ドコッカッ」 (1 / 3 / 3+8th)
            //   1: 全拍クラッシュ伴でも、キックは 8 ビート (1 / 3 / 3+8th)
            //   2: 16 分跳ね、キック密度高め
            ? (chorusPatternId === 2
                ? [0, 1.5, 2, 2.5, 3.5]      // Tomoya 16 分シンコペ
                : [0, 2, 2.5])                // 王道 8 beat ドンカッ・ドコッカッ (0/1 共通)
            : sec.kind === "preChorus"
              ? [0, 1.5, 2, 3.5]
              : sec.kind === "bridge"
                ? bridgeKickRock
                : verseKickRock)
        : (sec.kind === "chorus"
            ? (chorusPatternId === 1
                ? [0, 1, 2, 3]                  // 4 つ打ち
                : chorusPatternId === 3
                  ? [0, 1.5, 2, 2.75, 3]       // pop シンコペ
                  : [0, 2, 2.5])                // 王道 8 beat
            : sec.kind === "preChorus"
              ? [0, 1.5, 2, 3.5]
              : sec.kind === "bridge"
                ? bridgeKickPop
                : verseKickPop);
      for (const off of kickSlots) {
        // ラスサビ直前の最終小節: 後半 (2 拍以降) のキックを抜く
        if (dropBeforeFinal && off >= 2) continue;
        addNote(out, DRUM_KICK_MIDI, barStart + off * beatSec, intensity * (off === 0 ? 0.98 : 0.85));
      }
      // スネア (2,4) — ラスサビ前ドロップでは 4 拍目スネアを抜く ("間")
      // ロックはバックビートが命なので、キックより前に出るくらい強く叩く。
      // verse の rock スタイル: 2 小節ごとに Tomoya「スリップビート」 (4 拍目スネアを半拍遅らせて 4.5 に配置) を交互に適用
      //   = ONE OK ROCK「完全感覚Dreamer」Aメロの特徴 (スネアが 4 拍目ウラ)
      const snareVel2 = style === "rock" ? Math.min(1, intensity * 1.05) : intensity * 0.92;
      const snareVel4 = style === "rock" ? Math.min(1, intensity * 1.08) : intensity * 0.95;
      const slipBeat = style === "rock" && sec.kind === "verse" && versePatternId === 0 && ((bar - sec.startBar) % 4 === 1 || (bar - sec.startBar) % 4 === 3);
      // ハーフタイム感: verse / bridge pattern 2 では 2 拍目スネアを抜き、3 拍目のみ叩く
      const halfTime = (sec.kind === "verse" && versePatternId === 2) || (sec.kind === "bridge" && bridgePatternId === 2);
      if (!halfTime) {
        addNote(out, DRUM_SNARE_MIDI, barStart + 1 * beatSec, snareVel2);
      }
      if (!dropBeforeFinal) {
        if (halfTime) {
          // ハーフタイム: 3 拍目のみスネア (ハーフタイム感)
          addNote(out, DRUM_SNARE_MIDI, barStart + 2 * beatSec, snareVel4 * 0.95);
        } else {
          // スリップビート時は 4 拍目を 4.5 (= 4 拍裏) にずらす
          const snare4Off = slipBeat ? 3.5 : 3;
          addNote(out, DRUM_SNARE_MIDI, barStart + snare4Off * beatSec, snareVel4 * (slipBeat ? 0.95 : 1));
        }
      }
      // ゴーストノート (verse pattern 1 では密度を上げて 16分裏に多めに配置)
      if (sec.kind === "verse" && versePatternId === 1) {
        // 2番Aメロ: 16 分裏のゴーストスネアを 2 箇所追加 (密度↑)
        if (rng() < 0.7) addNote(out, DRUM_SNARE_MIDI, barStart + 1.75 * beatSec, intensity * 0.25);
        if (rng() < 0.55) addNote(out, DRUM_SNARE_MIDI, barStart + 3.75 * beatSec, intensity * 0.22);
      } else if (rng() < 0.4 && sec.kind !== "verse") {
        addNote(out, DRUM_SNARE_MIDI, barStart + 2.5 * beatSec, intensity * 0.25);
      }
      // クラップは Chorus で 2,4 重ね
      if (sec.kind === "chorus") {
        addNote(out, DRUM_CLAP_MIDI, barStart + 1 * beatSec, intensity * 0.55);
        addNote(out, DRUM_CLAP_MIDI, barStart + 3 * beatSec, intensity * 0.55);
      }
      // ハイハット / シンバル (サビ4パターン + その他は従来通り)
      //   chorus pattern 0: 王道 8 分閉じハット + 4 拍裏オープン
      //   chorus pattern 1: 全拍クラッシュ (ONE OK ROCK「完全感覚Dreamer」サビ風)
      //   chorus pattern 2: 16 分閉じハット (Tomoya 風 / 疾走感)
      //   chorus pattern 3: 表ハット / 裏ライド (pop 広がり) ← 旧 pop デフォルト
      //   preChorus: 16 分 (盛り上げ) + 最終小節後半は崩す
      //   bridge: 8 分閉じハット + 拍頭ライド
      //   verse: 8 分閉じハット + 4 拍目裏のオープン (時々)
      if (sec.kind === "chorus") {
        if (chorusPatternId === 1) {
          // 【パターン 1】完全感覚Dreamer サビ風: 4 分でクラッシュを全拍に
          //   ハイハットは無し、または極薄。クラッシュの "うねり" でサビの爆発を演出。
          // 1 拍目: セクション頭 or 4 小節毎クラッシュと重ならない時のみ追加
          const beat1AlreadyHit = isSectionStart || (bar - sec.startBar) % 4 === 0;
          for (let b = 0; b < 4; b++) {
            if (b === 0 && beat1AlreadyHit) continue;
            addNote(out, DRUM_CRASH_MIDI, barStart + b * beatSec, intensity * (b % 2 === 0 ? 0.85 : 0.7));
          }
          // 8 分裏に薄い閉じハット (= "粒" を入れる)
          for (let b = 1; b < 8; b += 2) {
            addNote(out, DRUM_HIHAT_MIDI, barStart + b * (beatSec / 2), intensity * 0.35);
          }
        } else if (chorusPatternId === 2) {
          // 【パターン 2】Tomoya 16 分閉じハット: アップダウン奏法のシミュレート。
          //   拍頭・拍裏は強く、16 分の "and-of" は弱く (アップストロークの音圧差)。
          for (let b = 0; b < 16; b++) {
            const onBeat = b % 4 === 0;        // 拍頭 (ダウン)
            const offBeat = b % 4 === 2;       // 拍裏 (ダウン)
            const isOpen = b === 14 && rng() < 0.6;  // 4 拍裏オープン (時々)
            if (isOpen) {
              addNote(out, DRUM_HIHAT_OPEN_MIDI, barStart + b * (beatSec / 4), intensity * 0.7);
            } else {
              const v = onBeat ? 0.85 : offBeat ? 0.7 : 0.5;
              addNote(out, DRUM_HIHAT_MIDI, barStart + b * (beatSec / 4), intensity * v);
            }
          }
          // 16 分の裏拍にゴーストスネア (Tomoya 風 16th-back ghost)
          if (rng() < 0.5) {
            addNote(out, DRUM_SNARE_MIDI, barStart + 1.75 * beatSec, intensity * 0.2);
            addNote(out, DRUM_SNARE_MIDI, barStart + 3.75 * beatSec, intensity * 0.22);
          }
        } else if (chorusPatternId === 3) {
          // 【パターン 3】pop / バラード寄り広がり: 表ハット / 裏ライド
          for (let b = 0; b < 8; b++) {
            const isOff = b % 2 === 1;
            const isLastOff = b === 7;
            if (isLastOff) {
              addNote(out, DRUM_HIHAT_OPEN_MIDI, barStart + b * (beatSec / 2), intensity * 0.75);
              continue;
            }
            addNote(out, isOff ? DRUM_RIDE_MIDI : DRUM_HIHAT_MIDI, barStart + b * (beatSec / 2), intensity * (b % 2 === 0 ? 0.78 : 0.55));
          }
        } else {
          // 【パターン 0】王道 8 ビート: 8 分閉じハット + 4 拍裏オープン
          for (let b = 0; b < 8; b++) {
            const isOff = b % 2 === 1;
            const isLastOff = b === 7;
            if (isLastOff) {
              addNote(out, DRUM_HIHAT_OPEN_MIDI, barStart + b * (beatSec / 2), intensity * (style === "rock" ? 0.85 : 0.75));
              continue;
            }
            if (isOff && rng() < (style === "rock" ? 0.15 : 0.25)) {
              addNote(out, DRUM_HIHAT_OPEN_MIDI, barStart + b * (beatSec / 2), intensity * 0.65);
              continue;
            }
            addNote(out, DRUM_HIHAT_MIDI, barStart + b * (beatSec / 2), intensity * (isOff ? 0.7 : 0.85));
          }
        }
      } else if (sec.kind === "preChorus") {
        // 段階的盛り上げ: 前半は 8 分基調、後半は 16 分に密度を上げる。
        //   buildRatio = 0 (序盤) → 8 分のみ
        //   buildRatio = 1 (終盤) → 16 分全部
        // 最終小節は前半 (2 拍まで) のみで止めて、後半をタムフィルが占拠する空間を作る
        // ラスサビ前ドロップでは更に短く (1 拍まで) して "完全な間" を作る
        const stopAt = dropBeforeFinal ? 4 : (isSectionLast ? 8 : 16);
        // 16分の各位置を「拍頭 / 16分裏 / 8分裏 / 16分裏」と区別
        for (let b = 0; b < stopAt; b++) {
          const mod = b % 4;
          // 拍頭 (mod=0): 常に鳴らす
          // 8 分裏 (mod=2): buildRatio が 0.3 以上で鳴らす
          // 16 分裏 (mod=1,3): buildRatio が 0.6 以上で鳴らす
          let play = false;
          if (mod === 0) play = true;
          else if (mod === 2) play = preChorusBuildRatio >= 0.3;
          else play = preChorusBuildRatio >= 0.6;
          if (!play) continue;
          addNote(out, DRUM_HIHAT_MIDI, barStart + b * (beatSec / 4), intensity * (mod === 0 ? 0.78 : 0.45));
        }
      } else if (sec.kind === "bridge") {
        // 【Bridge パターン別ハイハット】
        //   0: 既存 8 分閉じハット + 拍頭ライド感 (汎用)
        //   1: タムワーク中心 = ハットなし、代わりにタムを刻む (= breakdown 感)
        //   2: ハーフタイム = 4 分ライド (= 落ちブリッジ)
        if (bridgePatternId === 1) {
          // breakdown 風: ハットなし、タム (Lo/Mid) を 8 分で刻む
          for (let b = 0; b < 8; b++) {
            const tom = b % 4 === 0 ? DRUM_TOM_LO_MIDI : b % 4 === 2 ? DRUM_TOM_MID_MIDI : DRUM_TOM_LO_MIDI;
            // 8 分裏は弱めにゴースト
            const v = b % 2 === 0 ? 0.7 : 0.4;
            if (b % 2 === 0 || rng() < 0.5) {
              addNote(out, tom, barStart + b * (beatSec / 2), intensity * v);
            }
          }
        } else if (bridgePatternId === 2) {
          // 落ちブリッジ: 4 分ライドのみ
          for (let b = 0; b < 4; b++) {
            addNote(out, DRUM_RIDE_MIDI, barStart + b * beatSec, intensity * 0.65);
          }
        } else {
          // 標準: 8 分閉じハット + 4 拍目裏オープン (時々)
          for (let b = 0; b < 8; b++) {
            if (b === 7 && rng() < 0.3) {
              addNote(out, DRUM_HIHAT_OPEN_MIDI, barStart + b * (beatSec / 2), intensity * 0.6);
            } else {
              addNote(out, DRUM_HIHAT_MIDI, barStart + b * (beatSec / 2), intensity * (b % 2 === 0 ? 0.7 : 0.5));
            }
          }
        }
      } else if (sec.kind === "verse") {
        // 【Verse パターン別ハイハット】
        //   0: 標準 8 分閉じハット + 4 拍裏オープン時々 (1番Aメロ)
        //   1: 16 分閉じハット (2番Aメロ = 密度↑)
        //   2: 4 分ライド (落ちAメロ = ハーフタイム広がり)
        if (versePatternId === 1) {
          // 16 分閉じハット: 拍頭・拍裏を強く、16 分の "and-of" を弱く
          for (let b = 0; b < 16; b++) {
            const onBeat = b % 4 === 0;
            const offBeat = b % 4 === 2;
            const v = onBeat ? 0.7 : offBeat ? 0.55 : 0.35;
            addNote(out, DRUM_HIHAT_MIDI, barStart + b * (beatSec / 4), intensity * v);
          }
        } else if (versePatternId === 2) {
          // 落ちAメロ: 4 分ライド + 拍頭にハットを薄く重ねる
          for (let b = 0; b < 4; b++) {
            addNote(out, DRUM_RIDE_MIDI, barStart + b * beatSec, intensity * 0.55);
          }
        } else {
          // 1番Aメロ: 標準 8 分ハット
          for (let b = 0; b < 8; b++) {
            if (b === 7 && rng() < 0.3) {
              addNote(out, DRUM_HIHAT_OPEN_MIDI, barStart + b * (beatSec / 2), intensity * 0.6);
            } else {
              addNote(out, DRUM_HIHAT_MIDI, barStart + b * (beatSec / 2), intensity * (b % 2 === 0 ? 0.7 : 0.5));
            }
          }
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

    // セクション最終小節: フィルイン
    //   chorus / bridge → 大フィル (次セクションへ向かう)
    //   preChorus → 大フィル必須 (= サビへ向かう「タムロール突入」)
    //   verse → 小フィル
    //   ラスサビ前ドロップ → フィル無し (完全な無音で "落とす")
    if (isSectionLast && !dropBeforeFinal) {
      const big = sec.kind === "chorus" || sec.kind === "bridge" || sec.kind === "preChorus";
      appendFill(out, barStart, beatSec, big ? "big" : "small", rng);
    }
    // ラスサビ前ドロップの最終小節: 3 拍目だけスネアの "コツン" を残して残りは無音
    if (dropBeforeFinal) {
      addNote(out, DRUM_SNARE_MIDI, barStart + 2.5 * beatSec, intensity * 0.35);
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
// アレンジ (各楽器のセクション毎の「鳴る/休む/薄く」を制御)
// ---------------------------------------------------------------------------
/**
 * 楽器ごとに、各セクションでどれだけ存在感を出すかのテーブル。
 * 0 = そのセクションでは完全に休符 (ノートを削除)
 * 1 = フル
 * 0..1 中間値 = ベロシティをその比率にスケールして残す
 *
 * 「曲っぽさ」の核心は楽器の出入り。
 * イントロ〜1番Aメロでドラム/ピアノコンプを休ませて、Bメロ→サビで「ドン!」と全員入ると
 * 聴き手は「あ、サビが来た!」と感じる。
 */
type ArrangeLayer =
  | "melody" | "chord" | "bass" | "drums"
  | "guitar" | "acoustic" | "vocal" | "synth";

function applyArrangement(
  notes: NoteEvent[],
  layer: ArrangeLayer,
  sections: SongSection[],
  bpm: number,
  style: ComposerStyle,
): NoteEvent[] {
  if (notes.length === 0 || sections.length === 0) return notes;

  const barSec = (60 / bpm) * 4;

  // 各 SongSection が「その kind の何回目の登場か」を 1-indexed で記録
  const occIndex = new Map<SongSection, number>();
  const countByKind: Record<SectionKind, number> = {
    intro: 0, verse: 0, preChorus: 0, chorus: 0, bridge: 0, break: 0, outro: 0,
  };
  for (const s of sections) {
    countByKind[s.kind] += 1;
    occIndex.set(s, countByKind[s.kind]);
  }

  // 最終 chorus の参照
  let finalChorus: SongSection | null = null;
  for (let i = sections.length - 1; i >= 0; i--) {
    if (sections[i].kind === "chorus") { finalChorus = sections[i]; break; }
  }

  const presence = (sec: SongSection): number => {
    const occ = occIndex.get(sec) ?? 1;
    const isFirst = occ === 1;
    const isFinal = sec === finalChorus;

    // ===== ロック専用アレンジ =====
    // ロックは「静かに始めて積み上げる」のではなく「最初からバンド全員でドカン」が定番。
    // (Highway to Hell / Smells Like Teen Spirit / 邦ロックのイントロ)
    // ピアノは完全に引っ込み、ギター+ベース+ドラムでイントロから走る。
    if (style === "rock") {
      switch (layer) {
        case "drums":
          switch (sec.kind) {
            case "intro": return isFirst ? 0.85 : 1;     // イントロから 8 ビート全開
            case "verse": return isFirst ? 0.9 : 0.95;   // 1番からドラムあり
            case "preChorus": return 1;
            case "chorus": return 1;
            case "bridge": return 0.85;
            case "break": return 0;
            case "outro": return 0.85;
          }
          break;
        case "chord":
          // ロックではピアノコンプは "色付け" のみ。サビ以外はほぼ無音。
          switch (sec.kind) {
            case "intro": return 0;
            case "verse": return 0;
            case "preChorus": return 0.4;
            case "chorus": return 0.7;
            case "bridge": return 0.5;
            case "break": return 0;
            case "outro": return 0.2;
          }
          break;
        case "bass":
          switch (sec.kind) {
            case "intro": return isFirst ? 0.85 : 1;     // イントロからベース全開
            case "verse": return 1;
            case "preChorus": return 1;
            case "chorus": return 1;
            case "bridge": return 0.9;
            case "break": return 0;
            case "outro": return 0.85;
          }
          break;
        case "guitar":
          // ロックの主役。イントロで最大級、全セクション通して目立つ。
          switch (sec.kind) {
            case "intro": return 1;                       // ギターリフ = 楽曲の顔
            case "verse": return 1;
            case "preChorus": return 1;
            case "chorus": return 1;
            case "bridge": return 1;
            case "break": return 0;
            case "outro": return 1;
          }
          break;
        case "acoustic":
          // ロックではアコギは控えめ (主役はエレキ)。サビで重ねる程度。
          switch (sec.kind) {
            case "intro": return 0.25;
            case "verse": return 0.4;
            case "preChorus": return 0.5;
            case "chorus": return 0.6;
            case "bridge": return 0.45;
            case "break": return 0;
            case "outro": return 0.35;
          }
          break;
        case "melody":
          switch (sec.kind) {
            case "intro": return isFirst ? 0.65 : 0.85;
            case "verse": return 1;
            case "preChorus": return 1;
            case "chorus": return 1;
            case "bridge": return 0.9;
            case "break": return 0;
            case "outro": return 0.7;
          }
          break;
        case "vocal":
          switch (sec.kind) {
            case "intro": return 0;
            case "verse": return 1;
            case "preChorus": return 1;
            case "chorus": return 1;
            case "bridge": return isFinal ? 1 : 0.7;
            case "break": return 0;
            case "outro": return 0.4;
          }
          break;
        case "synth":
          // ロックではシンセはサブ。サビでパッド的に薄く重ねる程度。
          switch (sec.kind) {
            case "intro": return 0.3;
            case "verse": return 0.2;
            case "preChorus": return 0.5;
            case "chorus": return 0.7;
            case "bridge": return 0.6;
            case "break": return 0;
            case "outro": return 0.3;
          }
          break;
      }
      return 1;
    }

    // ===== pop / ballad / jazz の従来アレンジ (静かに立ち上げる型) =====
    switch (layer) {
      case "drums":
        switch (sec.kind) {
          case "intro": return 0;                       // ドラムは完全休符
          case "verse": return isFirst ? 0 : 0.85;      // 1番Aメロもドラムなし (魅せる)
          case "preChorus": return 1;
          case "chorus": return isFinal ? 1 : 0.95;
          case "bridge": return 0.55;
          case "break": return 0;
          case "outro": return 0.3;
        }
        break;
      case "chord":
        switch (sec.kind) {
          case "intro": return 0;                       // ピアノコンプ休符
          case "verse": return isFirst ? 0 : 0.7;       // 1番はピアノ無し
          case "preChorus": return 0.85;
          case "chorus": return 1;
          case "bridge": return 0.9;
          case "break": return 0;
          case "outro": return 0.5;
        }
        break;
      case "bass":
        switch (sec.kind) {
          case "intro": return isFirst ? 0 : 0.55;      // 1回目イントロはベース無し
          case "verse": return isFirst ? 0.7 : 0.9;
          case "preChorus": return 1;
          case "chorus": return 1;
          case "bridge": return 0.85;
          case "break": return 0;
          case "outro": return 0.5;
        }
        break;
      case "melody":
        switch (sec.kind) {
          case "intro": return isFirst ? 0.55 : 0.8;
          case "verse": return 1;
          case "preChorus": return 1;
          case "chorus": return 1;
          case "bridge": return 0.85;
          case "break": return 0;
          case "outro": return 0.55;
        }
        break;
      case "guitar":
        switch (sec.kind) {
          case "intro": return isFirst ? 0.35 : 0.65;
          case "verse": return isFirst ? 0.5 : 0.85;
          case "preChorus": return 0.9;
          case "chorus": return 1;
          case "bridge": return 0.8;
          case "break": return 0;
          case "outro": return 0.5;
        }
        break;
      case "acoustic":
        switch (sec.kind) {
          case "intro": return 1;                       // アコギはイントロ主役
          case "verse": return isFirst ? 1 : 0.85;
          case "preChorus": return 0.65;
          case "chorus": return 0.55;                   // サビは退く
          case "bridge": return 0.75;
          case "break": return 0;
          case "outro": return 0.85;
        }
        break;
      case "vocal":
        switch (sec.kind) {
          case "intro": return 0;                       // イントロはインスト
          case "verse": return 1;
          case "preChorus": return 1;
          case "chorus": return 1;
          case "bridge": return 0.6;
          case "break": return 0;
          case "outro": return 0.4;
        }
        break;
      case "synth":
        switch (sec.kind) {
          case "intro": return 0.6;
          case "verse": return isFirst ? 0.25 : 0.55;
          case "preChorus": return 0.8;
          case "chorus": return 1;
          case "bridge": return 0.9;
          case "break": return 0.3;
          case "outro": return 0.55;
        }
        break;
    }
    return 1;
  };

  const out: NoteEvent[] = [];
  for (const n of notes) {
    // ノートの開始拍が属する小節 → そのセクションを引く
    const barIdx = Math.floor(n.startSec / barSec + 1e-6);
    const sec = sections.find(s => barIdx >= s.startBar && barIdx < s.endBar);
    if (!sec) {
      out.push(n);
      continue;
    }
    const p = presence(sec);
    if (p <= 0.01) continue; // 完全休符
    if (p >= 0.99) {
      out.push(n);
    } else {
      out.push({
        ...n,
        velocity: Math.max(0.05, Math.min(1, n.velocity * p)),
      });
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
  // ロック: ♭VII 借用コードを進行に注入 (Sweet Child o' Mine 型)
  if (style === "rock" && !(opts.chordsOverride && opts.chordsOverride.length > 0)) {
    applyRockBorrowedChords(chords, scale, sections, rng);
  }
  await yieldToUI();

  // intro / bridge で「誰がリードを取るか」の優先順位:
  //   ギター > アコギ > ピアノ (melody)
  const hasGuitarLead = (opts.includeGuitar ?? false);
  const hasAcousticLead = !hasGuitarLead && (opts.includeAcoustic ?? false);
  const melodyHasOtherLead = hasGuitarLead || hasAcousticLead;

  const melodyNotes = (opts.includeMelody ?? true)
    ? generateMelody(scale, chords, sections, bpm, style, melodyHasOtherLead, rng)
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
    ? generateGuitarLayer(chords, scale, sections, bpm, style, rng, opts.guitarVoicing ?? "auto")
    : [];
  await yieldToUI();

  const acousticNotes = (opts.includeAcoustic ?? false)
    ? generateAcousticLayer(chords, scale, sections, bpm, style, hasGuitarLead, rng)
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

  // セクション × 楽器のアレンジを適用 (イントロでドラム休符など)
  const arrMelody = applyArrangement(melodyNotes, "melody", sections, bpm, style);
  const arrChord = applyArrangement(chordNotes, "chord", sections, bpm, style);
  const arrBass = applyArrangement(bassNotes, "bass", sections, bpm, style);
  const arrDrums = applyArrangement(drumNotes, "drums", sections, bpm, style);
  const arrGuitar = applyArrangement(guitarNotes, "guitar", sections, bpm, style);
  const arrAcoustic = applyArrangement(acousticNotes, "acoustic", sections, bpm, style);
  const arrVocal = applyArrangement(vocalNotes, "vocal", sections, bpm, style);
  const arrSynth = applyArrangement(synthNotes, "synth", sections, bpm, style);

  for (const arr of [
    arrMelody, arrChord, arrBass, arrDrums, fxNotes,
    arrGuitar, arrAcoustic, arrVocal, arrSynth,
  ]) {
    arr.sort((a, b) => a.startSec - b.startSec);
  }

  return {
    chords,
    sections,
    melodyNotes: arrMelody,
    chordNotes: arrChord,
    bassNotes: arrBass,
    drumNotes: arrDrums,
    fxNotes,
    guitarNotes: arrGuitar,
    acousticNotes: arrAcoustic,
    vocalNotes: arrVocal,
    synthNotes: arrSynth,
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
  // ロック: ♭VII 借用コードを進行に注入 (Sweet Child o' Mine 型)
  if (style === "rock" && !(opts.chordsOverride && opts.chordsOverride.length > 0)) {
    applyRockBorrowedChords(chords, scale, sections, rng);
  }
  // intro / bridge で「誰がリードを取るか」の優先順位:
  //   ギター > アコギ > ピアノ (melody)
  const hasGuitarLead = (opts.includeGuitar ?? false);
  const hasAcousticLead = !hasGuitarLead && (opts.includeAcoustic ?? false);
  const melodyHasOtherLead = hasGuitarLead || hasAcousticLead;

  const melodyNotes = (opts.includeMelody ?? true)
    ? generateMelody(scale, chords, sections, bpm, style, melodyHasOtherLead, rng)
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
    ? generateGuitarLayer(chords, scale, sections, bpm, style, rng, opts.guitarVoicing ?? "auto")
    : [];
  const acousticNotes = (opts.includeAcoustic ?? false)
    ? generateAcousticLayer(chords, scale, sections, bpm, style, hasGuitarLead, rng)
    : [];
  const vocalNotes = (opts.includeVocal ?? false)
    ? generateVocalLayer(melodyNotes, chords, sections, scale, bpm)
    : [];
  const synthNotes = (opts.includeSynth ?? false)
    ? generateSynthLayer(melodyNotes, chords, sections, bpm, style, rng)
    : [];

  const totalSec = bars * 4 * (60 / bpm);

  // セクション × 楽器のアレンジを適用 (イントロでドラム休符など)
  const arrMelody = applyArrangement(melodyNotes, "melody", sections, bpm, style);
  const arrChord = applyArrangement(chordNotes, "chord", sections, bpm, style);
  const arrBass = applyArrangement(bassNotes, "bass", sections, bpm, style);
  const arrDrums = applyArrangement(drumNotes, "drums", sections, bpm, style);
  const arrGuitar = applyArrangement(guitarNotes, "guitar", sections, bpm, style);
  const arrAcoustic = applyArrangement(acousticNotes, "acoustic", sections, bpm, style);
  const arrVocal = applyArrangement(vocalNotes, "vocal", sections, bpm, style);
  const arrSynth = applyArrangement(synthNotes, "synth", sections, bpm, style);

  for (const arr of [
    arrMelody, arrChord, arrBass, arrDrums, fxNotes,
    arrGuitar, arrAcoustic, arrVocal, arrSynth,
  ]) {
    arr.sort((a, b) => a.startSec - b.startSec);
  }

  return {
    chords,
    sections,
    melodyNotes: arrMelody,
    chordNotes: arrChord,
    bassNotes: arrBass,
    drumNotes: arrDrums,
    fxNotes,
    guitarNotes: arrGuitar,
    acousticNotes: arrAcoustic,
    vocalNotes: arrVocal,
    synthNotes: arrSynth,
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
