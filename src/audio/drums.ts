/**
 * シンプルなドラムマシン (Tone.js 合成音源)。
 *
 * - キック: MembraneSynth (低音 + ピッチエンベロープ)
 * - スネア: NoiseSynth (ホワイトノイズ + 短いエンベロープ)
 * - ハイハット: MetalSynth (金属的な高周波)
 * - 16-step ループ。BPM 指定可能。
 *
 * 5 つの基本パターン (8ビート、16ビート、バラード、ボサノバ、シャッフル) を提供。
 *
 * シンセはモジュール直下のシングルトンとして共有しており、
 * DrumLoop (ライブ演奏) と Playback (録音再生) の両方から triggerDrumHit() で鳴らせる。
 */

import * as Tone from "tone";

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
export const DRUM_KICK_MIDI = 36; // C2
export const DRUM_SNARE_MIDI = 38; // D2
export const DRUM_HIHAT_MIDI = 42; // F#2 (closed hat)
export const DRUM_MIDIS = [
  DRUM_KICK_MIDI,
  DRUM_SNARE_MIDI,
  DRUM_HIHAT_MIDI,
] as const;

export type DrumKind = "kick" | "snare" | "hihat";

export function drumKindOf(midi: number): DrumKind | null {
  if (midi === DRUM_KICK_MIDI) return "kick";
  if (midi === DRUM_SNARE_MIDI) return "snare";
  if (midi === DRUM_HIHAT_MIDI) return "hihat";
  return null;
}

export function drumKindToMidi(kind: DrumKind): number {
  return kind === "kick"
    ? DRUM_KICK_MIDI
    : kind === "snare"
      ? DRUM_SNARE_MIDI
      : DRUM_HIHAT_MIDI;
}

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

let kickSynth: Tone.MembraneSynth | null = null;
let snareSynth: Tone.NoiseSynth | null = null;
let hihatSynth: Tone.NoiseSynth | null = null;
let hihatHPF: Tone.Filter | null = null;

function ensureDrumSynths() {
  if (kickSynth) return;
  kickSynth = new Tone.MembraneSynth({
    pitchDecay: 0.04,
    octaves: 6,
    envelope: { attack: 0.001, decay: 0.35, sustain: 0, release: 0.4 },
    volume: -4,
  }).toDestination();
  snareSynth = new Tone.NoiseSynth({
    noise: { type: "white" },
    envelope: { attack: 0.001, decay: 0.18, sustain: 0, release: 0.1 },
    volume: -10,
  }).toDestination();
  // クローズドハットは NoiseSynth + ハイパスフィルタで作る (確実に発音)。
  // 旧実装の MetalSynth は引数解釈が安定せず無音になるケースがあったため差し替え。
  hihatHPF = new Tone.Filter({ type: "highpass", frequency: 7000, Q: 0.6 }).toDestination();
  hihatSynth = new Tone.NoiseSynth({
    noise: { type: "white" },
    envelope: { attack: 0.001, decay: 0.05, sustain: 0, release: 0.02 },
    volume: -10,
  }).connect(hihatHPF);
}

/**
 * ドラムを 1 発鳴らす。
 * @param midi  GM 規格の MIDI 番号 (36/38/42)
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
  if (midi === DRUM_KICK_MIDI && kickSynth) {
    kickSynth.triggerAttackRelease("C2", "8n", t, v);
  } else if (midi === DRUM_SNARE_MIDI && snareSynth) {
    snareSynth.triggerAttackRelease("16n", t, v);
  } else if (midi === DRUM_HIHAT_MIDI && hihatSynth) {
    hihatSynth.triggerAttackRelease("32n", t, v);
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
