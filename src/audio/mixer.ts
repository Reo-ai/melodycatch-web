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

const channels = new Map<MixerChannelId, Tone.Channel>();
let master: Tone.Channel | null = null;

function ensureMaster(): Tone.Channel {
  if (!master) {
    master = new Tone.Channel({ volume: 0 }).toDestination();
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
    ch = new Tone.Channel({ volume: 0 });
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
