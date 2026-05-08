/**
 * ベース楽器 (Tone.js MonoSynth ベースのポリフォニック・シンセ)。
 *
 * フィンガー奏法のエレキ/アコースティックベースに近い「生音感」を狙った設計:
 * - 三角波 (triangle) を採用。鋸波より倍音が大幅に少なく、丸く太い音になる。
 * - フィルタエンベロープを「短いアタック → 速い decay」に設定し、指弾きの
 *   「ボン」というプラックアタックを再現。
 * - シグナルチェーン全体で:
 *     HighPass(40Hz)   ※サブ帯のゴロつきカット
 *   → 軽いチューブ歪み (Distortion 0.16)  ※倍音追加で芯を出す
 *   → EQ3 (低+3 / 中-2 / 高-10dB)         ※耳障りなトレブル除去
 *   → Compressor                          ※ダイナミクスを締める
 *   → Reverb (decay 0.6, wet 0.04)        ※自然な部屋鳴り
 *   → Destination
 *
 * holdOn/holdOff で持続音、triggerNote で短いノート、chordOn で和音発音。
 */

import * as Tone from "tone";
import { midiToNoteString } from "../music/pitch";

let bassSynth: Tone.PolySynth | null = null;
let bassHighpass: Tone.Filter | null = null;
let bassDistortion: Tone.Distortion | null = null;
let bassEq: Tone.EQ3 | null = null;
let bassCompressor: Tone.Compressor | null = null;
let bassReverb: Tone.Reverb | null = null;

function ensureBass() {
  if (bassSynth) return;

  // 出力段から逆順に組み立て。
  bassReverb = new Tone.Reverb({ decay: 0.6, wet: 0.04 }).toDestination();
  bassCompressor = new Tone.Compressor({
    threshold: -18,
    ratio: 3.5,
    attack: 0.006,
    release: 0.12,
    knee: 6,
  }).connect(bassReverb);
  // 低音をふくよかに / 中域は控えめ / 高域はバッサリ落として「指弾きベース」の質感に。
  bassEq = new Tone.EQ3({
    low: 3,
    mid: -2,
    high: -10,
    lowFrequency: 200,
    highFrequency: 2200,
  }).connect(bassCompressor);
  // チューブアンプ的な軽い歪みで、芯になる倍音を追加。
  bassDistortion = new Tone.Distortion({
    distortion: 0.16,
    oversample: "2x",
    wet: 0.45,
  }).connect(bassEq);
  // 40Hz 未満のサブ帯をカット (低音の濁りを取る)。
  bassHighpass = new Tone.Filter({
    frequency: 40,
    type: "highpass",
    Q: 0.7,
  }).connect(bassDistortion);

  bassSynth = new Tone.PolySynth(Tone.MonoSynth, {
    oscillator: {
      // 三角波 → 倍音が少なく、フィンガーベースらしい丸い基音。
      type: "triangle",
    },
    filter: {
      Q: 2.2,
      type: "lowpass",
      rolloff: -24,
    },
    envelope: {
      // 指弾きの短いアタック → そこそこサステイン → 自然な余韻。
      attack: 0.008,
      decay: 0.35,
      sustain: 0.55,
      release: 0.9,
    },
    filterEnvelope: {
      // フィルタを「開いて瞬時に閉じる」= 「ボン」というプラック感。
      attack: 0.002,
      decay: 0.16,
      sustain: 0.22,
      release: 0.45,
      baseFrequency: 90,
      octaves: 3.6,
    },
    volume: -6,
  });
  bassSynth.connect(bassHighpass);
}

export function bassHoldOn(midi: number, velocity = 0.85): void {
  ensureBass();
  bassSynth?.triggerAttack(midiToNoteString(midi), undefined, velocity);
}

export function bassHoldOff(midi: number): void {
  bassSynth?.triggerRelease(midiToNoteString(midi));
}

export function bassTriggerNote(
  midi: number,
  durationSec: number,
  velocity = 0.85,
  time?: number,
): void {
  ensureBass();
  bassSynth?.triggerAttackRelease(
    midiToNoteString(midi),
    Math.max(0.05, durationSec),
    time,
    velocity,
  );
}

/**
 * 和音を一括で鳴らす (コードパレット / 進行プリセット用)。
 * ベース層に armed しているときに使う。
 * 重低音が濁るのを避けるため、最低音だけを 1 オクターブ下げて鳴らす。
 */
export function bassChordOn(
  midiNotes: number[],
  velocity = 0.8,
  duration = 1.4,
): void {
  ensureBass();
  if (!bassSynth || midiNotes.length === 0) return;
  const sorted = [...midiNotes].sort((a, b) => a - b);
  const root = sorted[0] - 12; // ルートを 1 オクターブ下げてベースらしく
  const notes = [root, ...sorted].map(midiToNoteString);
  bassSynth.triggerAttackRelease(
    notes,
    Math.max(0.05, duration),
    undefined,
    velocity,
  );
}

export function bassReleaseAll(): void {
  bassSynth?.releaseAll();
}
