/**
 * 本格ドラムキット (Tone.js 合成音源)。
 *
 * GM 互換の MIDI 番号で 10 種類のパーツを発音できる:
 *  - Kick (36)        : MembraneSynth + サブ + クリック
 *  - Snare (38)       : NoiseSynth (バンドパス) + 1 音シェル
 *  - Rim/Cross (37)   : 短いホワイトノイズ + 木質感
 *  - Hi-hat Closed(42): NoiseSynth + ハイパス
 *  - Hi-hat Open (46) : NoiseSynth (長め) + ハイパス
 *  - Tom Low (45)     : MembraneSynth (中低音)
 *  - Tom Mid (47)     : MembraneSynth (中音)
 *  - Tom Hi (50)      : MembraneSynth (高音)
 *  - Crash (49)       : NoiseSynth (シマー長め)
 *  - Ride (51)        : NoiseSynth (バンドパス + 細かい)
 *  - Clap (39)        : NoiseSynth (3 連エンベロープ近似)
 *
 * 5 つの基本パターン (8ビート/16ビート/バラード/ボサノバ/シャッフル) を提供し、
 * DrumPad の編集 UI と DrumLoop ランタイムから使われる。
 *
 * シンセはモジュール直下のシングルトンとして共有し、
 * DrumLoop (ライブ演奏) と Playback (録音再生) と
 * AutoComposeSession (自動作曲) のいずれからも triggerDrumHit() で鳴らせる。
 */

import * as Tone from "tone";
import { getMixerInput } from "./mixer";

export type DrumPatternId =
  | "rock8"
  | "pop16"
  | "ballad"
  | "bossa"
  | "shuffle";

export interface DrumPattern {
  id: DrumPatternId;
  name: string;
  description: string;
  steps: number; // 16
  kick: boolean[];
  snare: boolean[];
  hihat: boolean[];
}

// ---------- GM ドラム MIDI 番号 ----------
export const DRUM_KICK_MIDI = 36;        // C2
export const DRUM_RIM_MIDI = 37;         // C#2
export const DRUM_SNARE_MIDI = 38;       // D2
export const DRUM_CLAP_MIDI = 39;        // D#2
export const DRUM_TOM_LO_MIDI = 45;      // A2
export const DRUM_HIHAT_MIDI = 42;       // F#2  (closed hat)
export const DRUM_HIHAT_OPEN_MIDI = 46;  // A#2  (open hat)
export const DRUM_TOM_MID_MIDI = 47;     // B2
export const DRUM_CRASH_MIDI = 49;       // C#3
export const DRUM_TOM_HI_MIDI = 50;      // D3
export const DRUM_RIDE_MIDI = 51;        // D#3

export const DRUM_MIDIS = [
  DRUM_KICK_MIDI,
  DRUM_RIM_MIDI,
  DRUM_SNARE_MIDI,
  DRUM_CLAP_MIDI,
  DRUM_TOM_LO_MIDI,
  DRUM_HIHAT_MIDI,
  DRUM_HIHAT_OPEN_MIDI,
  DRUM_TOM_MID_MIDI,
  DRUM_CRASH_MIDI,
  DRUM_TOM_HI_MIDI,
  DRUM_RIDE_MIDI,
] as const;

export type DrumKind =
  | "kick"
  | "snare"
  | "hihat"
  | "hihatOpen"
  | "ride"
  | "crash"
  | "tomLo"
  | "tomMid"
  | "tomHi"
  | "clap"
  | "rim";

export function drumKindOf(midi: number): DrumKind | null {
  switch (midi) {
    case DRUM_KICK_MIDI: return "kick";
    case DRUM_SNARE_MIDI: return "snare";
    case DRUM_HIHAT_MIDI: return "hihat";
    case DRUM_HIHAT_OPEN_MIDI: return "hihatOpen";
    case DRUM_RIDE_MIDI: return "ride";
    case DRUM_CRASH_MIDI: return "crash";
    case DRUM_TOM_LO_MIDI: return "tomLo";
    case DRUM_TOM_MID_MIDI: return "tomMid";
    case DRUM_TOM_HI_MIDI: return "tomHi";
    case DRUM_CLAP_MIDI: return "clap";
    case DRUM_RIM_MIDI: return "rim";
    default: return null;
  }
}

export function drumKindToMidi(kind: DrumKind): number {
  switch (kind) {
    case "kick": return DRUM_KICK_MIDI;
    case "snare": return DRUM_SNARE_MIDI;
    case "hihat": return DRUM_HIHAT_MIDI;
    case "hihatOpen": return DRUM_HIHAT_OPEN_MIDI;
    case "ride": return DRUM_RIDE_MIDI;
    case "crash": return DRUM_CRASH_MIDI;
    case "tomLo": return DRUM_TOM_LO_MIDI;
    case "tomMid": return DRUM_TOM_MID_MIDI;
    case "tomHi": return DRUM_TOM_HI_MIDI;
    case "clap": return DRUM_CLAP_MIDI;
    case "rim": return DRUM_RIM_MIDI;
  }
}

export const DRUM_KIND_LABEL_JA: Record<DrumKind, string> = {
  kick: "キック",
  snare: "スネア",
  hihat: "ハット(閉)",
  hihatOpen: "ハット(開)",
  ride: "ライド",
  crash: "クラッシュ",
  tomLo: "タム(低)",
  tomMid: "タム(中)",
  tomHi: "タム(高)",
  clap: "クラップ",
  rim: "リム",
};

// 16-step グリッド (1拍 = 4 ステップ)。true でその step に発音。
export const DRUM_PATTERNS: DrumPattern[] = [
  {
    id: "rock8",
    name: "8ビート",
    description: "ロック・ポップスの基本",
    steps: 16,
    kick:  [true, false,false,false, false,false,false,false, true, false,false,false, false,false,false,false],
    snare: [false,false,false,false, true, false,false,false, false,false,false,false, true, false,false,false],
    hihat: [true, false,true, false, true, false,true, false, true, false,true, false, true, false,true, false],
  },
  {
    id: "pop16",
    name: "16ビート",
    description: "ファンク・ダンス系",
    steps: 16,
    kick:  [true, false,false,false, false,false,true, false, false,false,true, false, false,false,false,false],
    snare: [false,false,false,false, true, false,false,false, false,false,false,false, true, false,false,false],
    hihat: [true, true, true, true,  true, true, true, true,  true, true, true, true,  true, true, true, true],
  },
  {
    id: "ballad",
    name: "バラード",
    description: "スロー・しっとり",
    steps: 16,
    kick:  [true, false,false,false, false,false,false,false, false,false,false,false, false,false,false,false],
    snare: [false,false,false,false, false,false,false,false, true, false,false,false, false,false,false,false],
    hihat: [true, false,false,false, true, false,false,false, true, false,false,false, true, false,false,false],
  },
  {
    id: "bossa",
    name: "ボサノバ",
    description: "ラテン・軽やか",
    steps: 16,
    kick:  [true, false,false,false, false,false,true, false, false,false,true, false, false,false,false,false],
    snare: [false,false,false,true,  false,false,false,false, false,true, false,false, false,false,true, false],
    hihat: [true, false,true, false, true, false,true, false, true, false,true, false, true, false,true, false],
  },
  {
    id: "shuffle",
    name: "シャッフル",
    description: "跳ねる・ブルース系",
    steps: 16,
    kick:  [true, false,false,false, false,false,false,false, true, false,false,false, false,false,false,false],
    snare: [false,false,false,false, true, false,false,false, false,false,false,false, true, false,false,false],
    hihat: [true, false,false,true,  true, false,false,true,  true, false,false,true,  true, false,false,true],
  },
];

export function getDrumPattern(id: DrumPatternId): DrumPattern {
  return DRUM_PATTERNS.find((p) => p.id === id) ?? DRUM_PATTERNS[0];
}

/** プリセットを編集可能なコピーとして取り出す。 */
export function clonePattern(p: DrumPattern): DrumPattern {
  return {
    ...p,
    kick: [...p.kick],
    snare: [...p.snare],
    hihat: [...p.hihat],
  };
}

// ---------------------------------------------------------------------------
// Shared synths (module-level singletons)
// ---------------------------------------------------------------------------

// マスターバス: コンプ + ローシェルフで「ドラムらしい」存在感
let drumBus: Tone.Channel | null = null;
let drumComp: Tone.Compressor | null = null;
let drumEq: Tone.EQ3 | null = null;

// 各シンセ + 周辺
let kickSynth: Tone.MembraneSynth | null = null;
let kickClick: Tone.NoiseSynth | null = null;
let kickClickHPF: Tone.Filter | null = null;

let snareNoise: Tone.NoiseSynth | null = null;
let snareBody: Tone.MembraneSynth | null = null;
let snareBP: Tone.Filter | null = null;

let rimNoise: Tone.NoiseSynth | null = null;
let rimBP: Tone.Filter | null = null;

let hihatNoise: Tone.NoiseSynth | null = null;
let hihatHPF: Tone.Filter | null = null;

let hihatOpenNoise: Tone.NoiseSynth | null = null;
let hihatOpenHPF: Tone.Filter | null = null;

let crashNoise: Tone.NoiseSynth | null = null;
let crashHPF: Tone.Filter | null = null;
let crashBP: Tone.Filter | null = null;

let rideNoise: Tone.NoiseSynth | null = null;
let rideBP: Tone.Filter | null = null;
let rideBell: Tone.MetalSynth | null = null;

let tomLo: Tone.MembraneSynth | null = null;
let tomMid: Tone.MembraneSynth | null = null;
let tomHi: Tone.MembraneSynth | null = null;

let clapNoise: Tone.NoiseSynth | null = null;
let clapBP: Tone.Filter | null = null;

function ensureDrumSynths() {
  if (kickSynth) return;

  // マスターチェーン: drumBus → drumEq → drumComp → destination
  drumComp = new Tone.Compressor({
    threshold: -18,
    ratio: 3,
    attack: 0.003,
    release: 0.12,
  }).connect(getMixerInput("drum"));
  drumEq = new Tone.EQ3({ low: 2, mid: 0, high: 1 }).connect(drumComp);
  drumBus = new Tone.Channel({ volume: -2 }).connect(drumEq);

  // ---- KICK : 低音 (MembraneSynth) + アタックの "クリック" (HPF ノイズ)
  kickSynth = new Tone.MembraneSynth({
    pitchDecay: 0.045,
    octaves: 6.2,
    envelope: { attack: 0.001, decay: 0.42, sustain: 0, release: 0.5 },
    oscillator: { type: "sine" },
    volume: -3,
  }).connect(drumBus);
  kickClickHPF = new Tone.Filter({ type: "highpass", frequency: 2500, Q: 1.0 });
  kickClick = new Tone.NoiseSynth({
    noise: { type: "white" },
    envelope: { attack: 0.0005, decay: 0.018, sustain: 0, release: 0.01 },
    volume: -22,
  }).chain(kickClickHPF, drumBus);

  // ---- SNARE : ノイズ (バンドパス) + 短いシェル音
  snareBP = new Tone.Filter({ type: "bandpass", frequency: 1800, Q: 0.9 });
  snareNoise = new Tone.NoiseSynth({
    noise: { type: "white" },
    envelope: { attack: 0.001, decay: 0.16, sustain: 0, release: 0.12 },
    volume: -8,
  }).chain(snareBP, drumBus);
  snareBody = new Tone.MembraneSynth({
    pitchDecay: 0.02,
    octaves: 4,
    envelope: { attack: 0.001, decay: 0.12, sustain: 0, release: 0.1 },
    volume: -18,
  }).connect(drumBus);

  // ---- RIM : 短いクリックノイズ (木質)
  rimBP = new Tone.Filter({ type: "bandpass", frequency: 1200, Q: 4 });
  rimNoise = new Tone.NoiseSynth({
    noise: { type: "pink" },
    envelope: { attack: 0.0005, decay: 0.03, sustain: 0, release: 0.02 },
    volume: -14,
  }).chain(rimBP, drumBus);

  // ---- HI-HAT CLOSED : ハイパス + 短いノイズ
  hihatHPF = new Tone.Filter({ type: "highpass", frequency: 6000, Q: 0.7 });
  hihatNoise = new Tone.NoiseSynth({
    noise: { type: "white" },
    envelope: { attack: 0.001, decay: 0.07, sustain: 0, release: 0.02 },
    volume: -6,
  }).chain(hihatHPF, drumBus);

  // ---- HI-HAT OPEN : 同じハイパス + 長めディケイ
  hihatOpenHPF = new Tone.Filter({ type: "highpass", frequency: 7000, Q: 0.6 });
  hihatOpenNoise = new Tone.NoiseSynth({
    noise: { type: "white" },
    envelope: { attack: 0.001, decay: 0.35, sustain: 0, release: 0.18 },
    volume: -16,
  }).chain(hihatOpenHPF, drumBus);

  // ---- CRASH : ハイパス + 長いシマー
  crashHPF = new Tone.Filter({ type: "highpass", frequency: 5200, Q: 0.4 });
  crashBP = new Tone.Filter({ type: "bandpass", frequency: 9000, Q: 0.5 });
  crashNoise = new Tone.NoiseSynth({
    noise: { type: "white" },
    envelope: { attack: 0.001, decay: 1.6, sustain: 0, release: 0.8 },
    volume: -14,
  }).chain(crashBP, crashHPF, drumBus);

  // ---- RIDE : 中高域 + 金属ベル
  rideBP = new Tone.Filter({ type: "bandpass", frequency: 5500, Q: 1.4 });
  rideNoise = new Tone.NoiseSynth({
    noise: { type: "white" },
    envelope: { attack: 0.001, decay: 0.22, sustain: 0, release: 0.15 },
    volume: -18,
  }).chain(rideBP, drumBus);
  rideBell = new Tone.MetalSynth({
    envelope: { attack: 0.001, decay: 0.2, release: 0.1 },
    harmonicity: 5.1,
    modulationIndex: 24,
    resonance: 4000,
    octaves: 1.2,
    volume: -28,
  }).connect(drumBus);

  // ---- TOMS : 3 種類の Membrane
  tomLo = new Tone.MembraneSynth({
    pitchDecay: 0.06,
    octaves: 4,
    envelope: { attack: 0.001, decay: 0.5, sustain: 0, release: 0.4 },
    volume: -8,
  }).connect(drumBus);
  tomMid = new Tone.MembraneSynth({
    pitchDecay: 0.05,
    octaves: 4,
    envelope: { attack: 0.001, decay: 0.4, sustain: 0, release: 0.35 },
    volume: -8,
  }).connect(drumBus);
  tomHi = new Tone.MembraneSynth({
    pitchDecay: 0.04,
    octaves: 4,
    envelope: { attack: 0.001, decay: 0.32, sustain: 0, release: 0.3 },
    volume: -8,
  }).connect(drumBus);

  // ---- CLAP : 中域バンドパスの短いノイズ
  clapBP = new Tone.Filter({ type: "bandpass", frequency: 1500, Q: 1.2 });
  clapNoise = new Tone.NoiseSynth({
    noise: { type: "white" },
    envelope: { attack: 0.001, decay: 0.18, sustain: 0, release: 0.1 },
    volume: -11,
  }).chain(clapBP, drumBus);
}

/**
 * ドラムを 1 発鳴らす。
 * @param midi  GM 規格の MIDI 番号 (36/37/38/39/42/45/46/47/49/50/51 など)
 * @param time  Tone.Transport タイム。省略時は即時発音。
 * @param velocity 0..1
 */
export function triggerDrumHit(
  midi: number,
  time?: number,
  velocity = 0.85,
) {
  ensureDrumSynths();
  const v = Math.max(0.05, Math.min(1, velocity));
  const t = time ?? Tone.now();
  switch (midi) {
    case DRUM_KICK_MIDI:
      kickSynth?.triggerAttackRelease("C2", "8n", t, v);
      kickClick?.triggerAttackRelease(0.018, t, v * 0.7);
      return;
    case DRUM_SNARE_MIDI:
      snareNoise?.triggerAttackRelease(0.16, t, v);
      snareBody?.triggerAttackRelease("D3", 0.08, t, v * 0.6);
      return;
    case DRUM_RIM_MIDI:
      rimNoise?.triggerAttackRelease(0.03, t, v);
      return;
    case DRUM_HIHAT_MIDI:
      hihatNoise?.triggerAttackRelease(0.04, t, v);
      return;
    case DRUM_HIHAT_OPEN_MIDI:
      hihatOpenNoise?.triggerAttackRelease(0.32, t, v);
      return;
    case DRUM_CRASH_MIDI:
      crashNoise?.triggerAttackRelease(1.5, t, v);
      return;
    case DRUM_RIDE_MIDI:
      rideNoise?.triggerAttackRelease(0.18, t, v);
      rideBell?.triggerAttackRelease("C5", 0.12, t, v * 0.18);
      return;
    case DRUM_TOM_LO_MIDI:
      tomLo?.triggerAttackRelease("F2", "8n", t, v);
      return;
    case DRUM_TOM_MID_MIDI:
      tomMid?.triggerAttackRelease("A2", "8n", t, v);
      return;
    case DRUM_TOM_HI_MIDI:
      tomHi?.triggerAttackRelease("D3", "8n", t, v);
      return;
    case DRUM_CLAP_MIDI:
      // クラップは「3 連打の集合」感を出すために少しずらして 2 発鳴らす
      clapNoise?.triggerAttackRelease(0.04, t, v);
      clapNoise?.triggerAttackRelease(0.12, t + 0.014, v * 0.85);
      return;
    default:
      return;
  }
}

// ---------------------------------------------------------------------------
// Drum loop runtime
// ---------------------------------------------------------------------------

/**
 * Tone.Loop で 16 分音符グリッドをスケジュールするドラムループ。
 * - start(pattern, bpm) で再生開始
 * - stop() で停止
 * - setPattern(pattern) / setBpm(bpm) でリアルタイム差し替え
 * - onStep コールバックで現在 step を UI に通知
 * - onHit コールバックで個別ヒット (録音用) を通知
 */
export class DrumLoop {
  private loop: Tone.Loop | null = null;
  private pattern: DrumPattern = DRUM_PATTERNS[0];
  private step = 0;
  private playing = false;
  private onStep?: (step: number) => void;
  private onHit?: (midi: number, velocity: number) => void;

  setOnStep(cb?: (step: number) => void) {
    this.onStep = cb;
  }

  setOnHit(cb?: (midi: number, velocity: number) => void) {
    this.onHit = cb;
  }

  setPattern(p: DrumPattern) {
    this.pattern = p;
  }

  setBpm(bpm: number) {
    Tone.getTransport().bpm.rampTo(bpm, 0.05);
  }

  isPlaying() {
    return this.playing;
  }

  start(pattern: DrumPattern, bpm: number) {
    ensureDrumSynths();
    this.pattern = pattern;
    this.step = 0;
    Tone.getTransport().bpm.value = bpm;
    if (this.loop) {
      this.loop.dispose();
      this.loop = null;
    }
    // 16 分音符ごとに 1 step 進める
    this.loop = new Tone.Loop((time) => {
      const s = this.step % this.pattern.steps;
      const fire = (midi: number, vel: number, on: boolean) => {
        if (!on) return;
        triggerDrumHit(midi, time, vel);
        if (this.onHit) {
          const cb = this.onHit;
          // 録音タイムスタンプを画面側のクロックに合わせるため Draw キューで発火
          Tone.getDraw().schedule(() => cb(midi, vel), time);
        }
      };
      fire(DRUM_KICK_MIDI, 0.95, this.pattern.kick[s]);
      fire(DRUM_SNARE_MIDI, 0.85, this.pattern.snare[s]);
      fire(DRUM_HIHAT_MIDI, 0.75, this.pattern.hihat[s]);
      const captured = s;
      Tone.getDraw().schedule(() => {
        this.onStep?.(captured);
      }, time);
      this.step = (this.step + 1) % this.pattern.steps;
    }, "16n").start(0);
    Tone.getTransport().start();
    this.playing = true;
  }

  stop() {
    this.playing = false;
    if (this.loop) {
      this.loop.stop();
      this.loop.dispose();
      this.loop = null;
    }
    Tone.getTransport().stop();
    Tone.getTransport().cancel();
    this.step = 0;
    this.onStep?.(-1);
  }

  dispose() {
    this.stop();
    // 共有シンセはモジュール寿命で保持 (Playback でも使うため破棄しない)
  }
}
