/**
 * FX (効果音) エンジン。
 *
 * 楽曲に「セクション転換」や「盛り上げ」を演出するための非楽音的サウンドを提供する。
 *
 * 提供する FX (MIDI 番号で識別):
 *   - 0  : ホワイトノイズ・ヒット (短い「シャッ」)
 *   - 1  : スウィープ・アップ (上昇フィルタ・スウィープ)
 *   - 2  : スウィープ・ダウン (下降フィルタ・スウィープ)
 *   - 3  : ライザー (build-up: ノイズ + 上昇ピッチで盛り上げる)
 *   - 4  : ダウンリフター (下降スウィープ。落としに使う)
 *   - 5  : フォール (ピッチが下に落ちる効果音)
 *   - 6  : リバースシンバル (徐々に盛り上がってくるシンバル風)
 *
 * triggerFx(midi, durationSec, velocity) で発音する。
 * durationSec は FX の長さ。リバースシンバルやライザーは長め (2〜4 秒) を想定。
 */

import * as Tone from "tone";
import { ensureAudio } from "./pianoEngine";

export const FX_WHITE_NOISE = 0;
export const FX_SWEEP_UP = 1;
export const FX_SWEEP_DOWN = 2;
export const FX_RISER = 3;
export const FX_DOWNLIFTER = 4;
export const FX_FALL = 5;
export const FX_REVERSE_CYMBAL = 6;

export const FX_LABEL_JA: Record<number, string> = {
  [FX_WHITE_NOISE]: "ホワイトノイズ",
  [FX_SWEEP_UP]: "スウィープ↑",
  [FX_SWEEP_DOWN]: "スウィープ↓",
  [FX_RISER]: "ライザー",
  [FX_DOWNLIFTER]: "ダウンリフター",
  [FX_FALL]: "フォール",
  [FX_REVERSE_CYMBAL]: "リバースシンバル",
};

export const FX_MIDI_LIST = [
  FX_WHITE_NOISE,
  FX_SWEEP_UP,
  FX_SWEEP_DOWN,
  FX_RISER,
  FX_DOWNLIFTER,
  FX_FALL,
  FX_REVERSE_CYMBAL,
];

let fxBus: Tone.Channel | null = null;
let fxReverb: Tone.Reverb | null = null;
let fxCompressor: Tone.Compressor | null = null;

function ensureFxBus(): Tone.Channel {
  if (fxBus) return fxBus;
  fxReverb = new Tone.Reverb({ decay: 1.6, wet: 0.18 }).toDestination();
  fxCompressor = new Tone.Compressor({
    threshold: -16,
    ratio: 3,
    attack: 0.01,
    release: 0.2,
    knee: 6,
  }).connect(fxReverb);
  fxBus = new Tone.Channel({ volume: -6 }).connect(fxCompressor);
  return fxBus;
}

/** 短いホワイトノイズ・ヒット (「シャッ」)。 */
function triggerWhiteNoise(durationSec: number, velocity: number, time?: number): void {
  const bus = ensureFxBus();
  const dur = Math.max(0.05, Math.min(2.0, durationSec));
  const noise = new Tone.NoiseSynth({
    noise: { type: "white" },
    envelope: {
      attack: 0.002,
      decay: dur * 0.6,
      sustain: 0.0,
      release: dur * 0.3,
    },
    volume: -6 + (velocity - 0.5) * 8,
  }).connect(bus);
  const t = time ?? Tone.now();
  noise.triggerAttackRelease(dur, t);
  // 自動解放
  window.setTimeout(
    () => {
      try {
        noise.dispose();
      } catch {
        /* noop */
      }
    },
    (dur + 0.5) * 1000,
  );
}

/** フィルタ・スウィープ (アップ/ダウン)。 */
function triggerSweep(durationSec: number, velocity: number, up: boolean, time?: number): void {
  const bus = ensureFxBus();
  const dur = Math.max(0.3, Math.min(6.0, durationSec));
  const filter = new Tone.Filter({
    type: "bandpass",
    frequency: up ? 200 : 6000,
    Q: 6,
  }).connect(bus);
  const noise = new Tone.Noise("pink");
  noise.volume.value = -12 + (velocity - 0.5) * 6;
  noise.connect(filter);
  const t = time ?? Tone.now();
  noise.start(t);
  noise.stop(t + dur + 0.05);
  filter.frequency.setValueAtTime(up ? 200 : 6000, t);
  filter.frequency.exponentialRampToValueAtTime(up ? 7000 : 180, t + dur);
  // 末尾フェードアウト用にゲイン制御
  const fadeNode = new Tone.Gain(1).connect(bus);
  filter.disconnect();
  filter.connect(fadeNode);
  fadeNode.gain.setValueAtTime(1, t);
  fadeNode.gain.linearRampToValueAtTime(0, t + dur + 0.05);
  window.setTimeout(
    () => {
      try {
        noise.dispose();
        filter.dispose();
        fadeNode.dispose();
      } catch {
        /* noop */
      }
    },
    (dur + 0.6) * 1000,
  );
}

/** ライザー (盛り上げ): ノイズスウィープ + 上昇ピッチ。 */
function triggerRiser(durationSec: number, velocity: number, time?: number): void {
  const bus = ensureFxBus();
  const dur = Math.max(0.6, Math.min(8.0, durationSec));
  const t = time ?? Tone.now();

  // 1) フィルタ付きノイズの上昇スウィープ
  const filter = new Tone.Filter({ type: "bandpass", frequency: 300, Q: 4 });
  const noise = new Tone.Noise("white");
  noise.volume.value = -14 + (velocity - 0.5) * 6;
  const gain = new Tone.Gain(0.001);
  noise.chain(filter, gain, bus);
  noise.start(t);
  noise.stop(t + dur + 0.05);
  filter.frequency.setValueAtTime(300, t);
  filter.frequency.exponentialRampToValueAtTime(8000, t + dur);
  // 音量も上昇 (build-up)
  gain.gain.setValueAtTime(0.05, t);
  gain.gain.exponentialRampToValueAtTime(1.0, t + dur);
  gain.gain.linearRampToValueAtTime(0.001, t + dur + 0.05);

  // 2) ピッチ上昇のサイン (低音)
  const osc = new Tone.Oscillator(80, "sawtooth");
  const oscGain = new Tone.Gain(0.001).connect(bus);
  osc.connect(oscGain);
  osc.start(t);
  osc.stop(t + dur + 0.05);
  osc.frequency.setValueAtTime(80, t);
  osc.frequency.exponentialRampToValueAtTime(1200, t + dur);
  oscGain.gain.setValueAtTime(0.05, t);
  oscGain.gain.exponentialRampToValueAtTime(0.4, t + dur);
  oscGain.gain.linearRampToValueAtTime(0.001, t + dur + 0.05);

  window.setTimeout(
    () => {
      try {
        noise.dispose();
        filter.dispose();
        gain.dispose();
        osc.dispose();
        oscGain.dispose();
      } catch {
        /* noop */
      }
    },
    (dur + 0.6) * 1000,
  );
}

/** ダウンリフター: 下に落とす効果音 (ノイズ + 下降ピッチ)。 */
function triggerDownlifter(durationSec: number, velocity: number, time?: number): void {
  const bus = ensureFxBus();
  const dur = Math.max(0.4, Math.min(5.0, durationSec));
  const t = time ?? Tone.now();

  const filter = new Tone.Filter({ type: "lowpass", frequency: 8000, Q: 2 });
  const noise = new Tone.Noise("pink");
  noise.volume.value = -10 + (velocity - 0.5) * 6;
  const gain = new Tone.Gain(1).connect(bus);
  noise.chain(filter, gain);
  noise.start(t);
  noise.stop(t + dur + 0.05);
  filter.frequency.setValueAtTime(8000, t);
  filter.frequency.exponentialRampToValueAtTime(200, t + dur);
  gain.gain.setValueAtTime(1, t);
  gain.gain.linearRampToValueAtTime(0.001, t + dur + 0.05);

  const osc = new Tone.Oscillator(800, "sine");
  const oscGain = new Tone.Gain(0.3).connect(bus);
  osc.connect(oscGain);
  osc.start(t);
  osc.stop(t + dur + 0.05);
  osc.frequency.setValueAtTime(800, t);
  osc.frequency.exponentialRampToValueAtTime(60, t + dur);
  oscGain.gain.setValueAtTime(0.3, t);
  oscGain.gain.linearRampToValueAtTime(0.001, t + dur + 0.05);

  window.setTimeout(
    () => {
      try {
        noise.dispose();
        filter.dispose();
        gain.dispose();
        osc.dispose();
        oscGain.dispose();
      } catch {
        /* noop */
      }
    },
    (dur + 0.6) * 1000,
  );
}

/** フォール (ピッチが下に「ピューン」と落ちる)。 */
function triggerFall(durationSec: number, velocity: number, time?: number): void {
  const bus = ensureFxBus();
  const dur = Math.max(0.2, Math.min(2.5, durationSec));
  const t = time ?? Tone.now();

  const osc = new Tone.Oscillator(1200, "triangle");
  const gain = new Tone.Gain(0.001).connect(bus);
  osc.connect(gain);
  osc.start(t);
  osc.stop(t + dur + 0.05);
  osc.frequency.setValueAtTime(1200, t);
  osc.frequency.exponentialRampToValueAtTime(80, t + dur);
  const peak = 0.25 + (velocity - 0.5) * 0.2;
  gain.gain.setValueAtTime(0.001, t);
  gain.gain.exponentialRampToValueAtTime(peak, t + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.001, t + dur);

  window.setTimeout(
    () => {
      try {
        osc.dispose();
        gain.dispose();
      } catch {
        /* noop */
      }
    },
    (dur + 0.5) * 1000,
  );
}

/** リバースシンバル: 徐々に盛り上がってからピーク。サビ前に決まる。 */
function triggerReverseCymbal(durationSec: number, velocity: number, time?: number): void {
  const bus = ensureFxBus();
  const dur = Math.max(0.6, Math.min(6.0, durationSec));
  const t = time ?? Tone.now();

  // 金属的な倍音を含んだノイズ (シンバル風) + 緩やかなアタック
  const hp = new Tone.Filter({ type: "highpass", frequency: 4000, Q: 0.7 });
  const noise = new Tone.NoiseSynth({
    noise: { type: "white" },
    envelope: {
      attack: dur * 0.85,
      decay: dur * 0.1,
      sustain: 1.0,
      release: 0.05,
    },
    volume: -6 + (velocity - 0.5) * 6,
  });
  noise.chain(hp, bus);
  noise.triggerAttackRelease(dur, t);

  // ベル感を出すために MetalSynth を薄く重ねる
  const metal = new Tone.MetalSynth({
    envelope: { attack: dur * 0.8, decay: dur * 0.15, release: 0.05 },
    harmonicity: 5.1,
    modulationIndex: 32,
    resonance: 4000,
    octaves: 1.2,
    volume: -22 + (velocity - 0.5) * 4,
  }).connect(bus);
  metal.triggerAttackRelease("16n", t);

  window.setTimeout(
    () => {
      try {
        noise.dispose();
        hp.dispose();
        metal.dispose();
      } catch {
        /* noop */
      }
    },
    (dur + 0.6) * 1000,
  );
}

/**
 * FX を発音する。
 * @param midi  FX_* 定数のいずれか
 * @param durationSec  FX の長さ (秒)。リバースシンバルやライザーは長めを推奨。
 * @param velocity  0..1
 * @param time  Tone.now() ベースの時刻 (省略時は即時)
 */
export function triggerFx(
  midi: number,
  durationSec: number,
  velocity = 0.9,
  time?: number,
): void {
  void ensureAudio();
  switch (midi) {
    case FX_WHITE_NOISE:
      triggerWhiteNoise(durationSec, velocity, time);
      return;
    case FX_SWEEP_UP:
      triggerSweep(durationSec, velocity, true, time);
      return;
    case FX_SWEEP_DOWN:
      triggerSweep(durationSec, velocity, false, time);
      return;
    case FX_RISER:
      triggerRiser(durationSec, velocity, time);
      return;
    case FX_DOWNLIFTER:
      triggerDownlifter(durationSec, velocity, time);
      return;
    case FX_FALL:
      triggerFall(durationSec, velocity, time);
      return;
    case FX_REVERSE_CYMBAL:
      triggerReverseCymbal(durationSec, velocity, time);
      return;
    default:
      // 未知の MIDI は短いホワイトノイズにフォールバック
      triggerWhiteNoise(Math.max(0.1, durationSec), velocity, time);
  }
}
