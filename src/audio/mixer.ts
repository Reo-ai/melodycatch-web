// 全エンジン共通のミキサー。
// 各 audio engine は最終出力を `.toDestination()` ではなく
// `.connect(getMixerInput("xxx"))` でこのモジュールのチャネルにつなぐ。
// ここで volume / mute を一元管理し、最後にマスターを経由して destination へ送る。

import * as Tone from "tone";

export type MixerChannelId =
  | "piano"
  | "bass"
  | "drum"
  | "drumAcoustic"
  | "guitar"
  | "guitar2"
  | "acoustic"
  | "synth"
  | "vocal"
  | "fx";

export const MIXER_CHANNEL_IDS: MixerChannelId[] = [
  "piano",
  "bass",
  "drum",
  "drumAcoustic",
  "guitar",
  "guitar2",
  "acoustic",
  "synth",
  "vocal",
  "fx",
];

export const MIXER_CHANNEL_LABEL_JA: Record<MixerChannelId, string> = {
  piano: "ピアノ",
  bass: "ベース",
  drum: "ドラム (電子)",
  drumAcoustic: "ドラム (生)",
  guitar: "ギター1",
  guitar2: "ギター2 (リード)",
  acoustic: "アコギ",
  synth: "シンセ",
  vocal: "ボーカル",
  fx: "FX",
};

/**
 * 楽器ごとの左右の定位 (-1 = 左, 0 = 中央, +1 = 右)。
 * 全部が中央に集まると音が団子になるので、実際のバンドのミックスのように広げる。
 * 低音 (ベース・キック) とメロディ・ボーカルは中央に置くのが定石。
 */
const CHANNEL_PAN: Record<MixerChannelId, number> = {
  piano: -0.12,
  bass: 0,
  drum: 0,
  drumAcoustic: 0,
  guitar: -0.38,
  guitar2: 0.38,
  acoustic: 0.28,
  synth: -0.22,
  vocal: 0,
  fx: 0,
};

const channels = new Map<MixerChannelId, Tone.Channel>();
let master: Tone.Channel | null = null;

/**
 * マスター (全体の仕上げ):
 *   Channel(音量) → 低域の濁り取り → バスコンプ(全体をまとめる) → リミッター(音割れ防止) → 出力
 */
function ensureMaster(): Tone.Channel {
  if (!master) {
    const limiter = new Tone.Limiter(-1).toDestination();
    const glue = new Tone.Compressor({
      threshold: -16,
      ratio: 2.2,
      attack: 0.03,
      release: 0.25,
      knee: 8,
    }).connect(limiter);
    // 30Hz 以下の聞こえない超低域を切って、コンプが無駄に反応しないようにする
    const lowCut = new Tone.Filter({ type: "highpass", frequency: 30, Q: 0.7 }).connect(glue);
    master = new Tone.Channel({ volume: -1 }).connect(lowCut);
  }
  return master;
}

/**
 * エンジンの最終ノードを `.connect(getMixerInput(id))` でここに繋ぐ。
 * 戻り値はそのまま Tone.js の InputNode として扱える。
 */
export function getMixerInput(id: MixerChannelId): Tone.Channel {
  let ch = channels.get(id);
  if (!ch) {
    const m = ensureMaster();
    ch = new Tone.Channel({ volume: 0, pan: CHANNEL_PAN[id] });
    ch.connect(m);
    channels.set(id, ch);
  }
  return ch;
}

export function setMixerChannelVolumeDb(id: MixerChannelId, db: number): void {
  getMixerInput(id).volume.value = db;
}

export function setMixerChannelMute(id: MixerChannelId, mute: boolean): void {
  getMixerInput(id).mute = mute;
}

export function setMixerMasterVolumeDb(db: number): void {
  ensureMaster().volume.value = db;
}

export function setMixerMasterMute(mute: boolean): void {
  ensureMaster().mute = mute;
}
