/**
 * 実際の楽器を録音したサンプル音源 (public/samples/ 配下) を Tone.Sampler で鳴らすための共通部品。
 *
 * 音源 (すべて CC0 = 著作権放棄。クレジット表記不要・商用利用可):
 *   - bass     : Karoryfer "Black And Blue Basses" (darkblack, 指弾き)
 *   - eguitar  : Karoryfer "Emilyguitar" (クリーン・ライン録り)
 *   - acoustic : Jeff Learman "Martin HD28" (Discord SFZ GM Bank 026, スチール弦)
 *   - strings  : Versilian Studios "VSCO 2 CE" 弦楽合奏 (低音=チェロ / 中音=ビオラ / 高音=バイオリン)
 *   - violin   : Versilian Studios "VSCO 2 CE" ソロ・バイオリン (メロディのリード音色)
 * 詳細は public/samples/CREDITS.txt。
 *
 * ファイル名は「実際に鳴っている音程の MIDI 番号」(例: 40.mp3 = E2)。
 * 3 半音おきに録ってあり、間の音は Tone.Sampler が近いサンプルから音程をずらして作る。
 *
 * 読み込みが終わるまでは各エンジンが従来のシンセ音で代わりに鳴らす (無音にならないように)。
 */
import * as Tone from "tone";
import { midiToNoteString } from "../music/pitch";

export type SampleSetId = "bass" | "eguitar" | "acoustic" | "strings" | "violin";

const SAMPLE_MIDIS: Record<SampleSetId, number[]> = {
  bass: [23, 26, 29, 32, 35, 38, 41, 44, 47, 50, 53],
  eguitar: [37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 69, 72, 75, 78, 81, 84, 86],
  acoustic: [40, 43, 46, 49, 52, 55, 58, 61, 64, 68, 71, 74, 77, 80, 83],
  strings: [36, 40, 43, 47, 50, 53, 55, 59, 62, 65, 69, 72, 76, 79, 83, 86],
  // ソロ・バイオリン (メロディ専用のリード)
  violin: [55, 57, 60, 64, 67, 69, 72, 76, 79, 81, 84, 88, 91, 93],
};

export interface SamplerOptions {
  /** ノートを離してから消えるまでの秒数。 */
  release?: number;
  attack?: number;
  /** dB */
  volume?: number;
}

/** サンプル音源の Sampler を作る。読み込みは非同期で、完了後に `sampler.loaded` が true になる。 */
export function createSampler(id: SampleSetId, opts: SamplerOptions = {}): Tone.Sampler {
  const urls: Record<string, string> = {};
  for (const m of SAMPLE_MIDIS[id]) urls[midiToNoteString(m)] = `${m}.mp3`;
  const sampler = new Tone.Sampler({
    urls,
    baseUrl: `${import.meta.env.BASE_URL}samples/${id}/`,
    attack: opts.attack ?? 0,
    release: opts.release ?? 0.4,
    onerror: (e) => {
      // 読み込みに失敗してもアプリは止めない (シンセ音のまま鳴り続ける)
      console.warn(`[sampledInstruments] ${id} の読み込みに失敗しました`, e);
    },
  });
  if (opts.volume !== undefined) sampler.volume.value = opts.volume;
  return sampler;
}

/** Sampler が使える状態か (読み込み完了)。 */
export function samplerReady(s: Tone.Sampler | null | undefined): s is Tone.Sampler {
  return !!s && s.loaded;
}

/** 0..1 の強さを Sampler に渡す値に整える。 */
export function velocity01(v: number): number {
  return Math.max(0.05, Math.min(1, v));
}
