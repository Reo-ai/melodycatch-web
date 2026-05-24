/**
 * 生ドラム (アコースティック寄り) サウンドエンジン。
 *
 * `drums.ts` の電子ドラム版より「生っぽさ」と「音量」を強化した別キット。
 *  - Kick : 深い胴鳴り (低めピッチ + 長めサスティン) + ビーターアタック
 *  - Snare: 2 層のシェル胴 + バンドパスノイズで長めのテイル
 *  - Toms : ピッチ追従の MembraneSynth + 倍音
 *  - Hat 閉: MetalSynth で金属的に
 *  - Hat 開: MetalSynth + ノイズシマー
 *  - Crash: MetalSynth + 長尺ホワイトノイズ
 *  - Ride : MetalSynth (ベル) + 細かいスティック粒
 *  - Rim  : 硬めの木質パーカッション
 *  - Clap : ユーザーリクエスト通り `drums.ts` 側 (電子) を流用
 *
 * `triggerDrumHitAcoustic(midi, time?, velocity)` を呼ぶ。
 * LiveDrumKit / 録音再生 (drumAcoustic レイヤー) から共有。
 */

import * as Tone from "tone";
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
} from "./drums";

// ---------------------------------------------------------------------------
// Master chain (生ドラム専用バス)
//
// 生ドラムらしさの肝は「単発のシンセ音色」よりも「全体の処理 (圧縮・部屋鳴り・
// アタックの強調)」と「人間味 (ベロシティ揺らぎ・微妙なタイミング揺らぎ・
// ゴーストノート)」にある。ここではマスタチェーンを
//   [ kit bus ] → [ EQ3 ] → [ glue compressor ] → [ destination ]
//                      └→ [ room send → short reverb → destination ]
// の 2 系統に分け、各楽器の triggerAttackRelease 後に微小なランダマイズを
// かけて生っぽさを出す。
// ---------------------------------------------------------------------------
let aBus: Tone.Channel | null = null;
let aComp: Tone.Compressor | null = null;
let aEq: Tone.EQ3 | null = null;
/** 部屋鳴り送り用 (バスから分岐して短いリバーブに送る)。 */
let aRoomSend: Tone.Gain | null = null;
let aRoomReverb: Tone.Reverb | null = null;
/** 全体に薄くかけるサチュレーション (アナログ感)。 */
let aSat: Tone.Distortion | null = null;

// ---- Kick ----
let aKickSub: Tone.MembraneSynth | null = null;
let aKickBody: Tone.MembraneSynth | null = null;
let aKickBeater: Tone.NoiseSynth | null = null;
let aKickBeaterHPF: Tone.Filter | null = null;

// ---- Snare ----
let aSnareShellHi: Tone.MembraneSynth | null = null;
let aSnareShellLo: Tone.MembraneSynth | null = null;
let aSnareNoise: Tone.NoiseSynth | null = null;
let aSnareBP: Tone.Filter | null = null;
let aSnareTailHPF: Tone.Filter | null = null;
let aSnareTail: Tone.NoiseSynth | null = null;
// 「スナップ」層: 5kHz 付近の鋭いノイズトランジェント (= スネアワイヤが弾ける瞬間)
let aSnareSnap: Tone.NoiseSynth | null = null;
let aSnareSnapBP: Tone.Filter | null = null;

// ---- Rim ----
let aRimNoise: Tone.NoiseSynth | null = null;
let aRimBP: Tone.Filter | null = null;
let aRimClick: Tone.MembraneSynth | null = null;

// ---- Hi-hat closed ----
let aHatMetal: Tone.MetalSynth | null = null;
let aHatHPF: Tone.Filter | null = null;
// 生ハットの「チッ」感を出すための広帯域ノイズ層 (MetalSynth だけだと電子っぽい)
let aHatNoise: Tone.NoiseSynth | null = null;
let aHatNoiseBP: Tone.Filter | null = null;

// ---- Hi-hat open ----
let aHatOpenMetal: Tone.MetalSynth | null = null;
let aHatOpenNoise: Tone.NoiseSynth | null = null;
let aHatOpenHPF: Tone.Filter | null = null;

// ---- Crash ----
let aCrashMetal: Tone.MetalSynth | null = null;
let aCrashNoise: Tone.NoiseSynth | null = null;
let aCrashHPF: Tone.Filter | null = null;

// ---- Ride ----
let aRideBell: Tone.MetalSynth | null = null;
let aRideStick: Tone.NoiseSynth | null = null;
let aRideStickBP: Tone.Filter | null = null;

// ---- Toms ----
let aTomLo: Tone.MembraneSynth | null = null;
let aTomMid: Tone.MembraneSynth | null = null;
let aTomHi: Tone.MembraneSynth | null = null;

// ---- Clap (生ドラム専用) ----
let aClapNoise: Tone.NoiseSynth | null = null;
let aClapBP: Tone.Filter | null = null;

// ---------------------------------------------------------------------------
// Sample-based path (Tone.Sampler / Tone.Player)
//
// /public/drums/*.wav に CC0 等の本物の生ドラムサンプルを置くと
// シンセより本物の音で鳴らせる。各楽器のサンプルが読み込めたかどうかを
// `aSamplesReady[midi]` で管理し、true のヒットはサンプル側だけが鳴り、
// false のヒットは既存のシンセ側にフォールバックする。
// ---------------------------------------------------------------------------
const aSamplers: Partial<Record<number, Tone.Player>> = {};
const aSamplesReady: Partial<Record<number, boolean>> = {};
/** サンプルが 1 つでも読み込まれているか (= 生ドラム差し替え動作中か) */
let aSampleMode = false;
/** 現在ロード中のキットのベース URL (例: "/drums/kit1/")。未ロード時は null */
let aCurrentKitBase: string | null = null;

/**
 * 利用可能なキット ID。
 *   - "root"  : /drums/*.wav (後方互換 / 既定キット)
 *   - "kit1..4": /drums/kit1..4/*.wav
 */
export type AcousticDrumKitId = "root" | "kit1" | "kit2" | "kit3" | "kit4";

export const ACOUSTIC_DRUM_KIT_LABEL_JA: Record<AcousticDrumKitId, string> = {
  root: "標準 (既定)",
  kit1: "Kit1: Sixties Rock (Ludwig)",
  kit2: "Kit2: Sixties Basic (汎用ロック)",
  kit3: "Kit3: Jazz (Premier/Gretsch)",
  kit4: "Kit4: Electro (Cheetah 80s)",
};

/**
 * /public/drums/ 配下の WAV/MP3 ファイルからサンプルを読み込んで
 * 各 MIDI ノートに紐付ける。ファイルが無いものはエラーを握りつぶし、
 * シンセフォールバックのままにする。アプリ起動時に一度呼べばよい。
 * 同じ baseUrl で再呼出しされた場合は何もしない (二重ロード防止)。
 */
export function loadAcousticDrumSamples(baseUrl = "/drums/") {
  ensureAcousticDrums();
  if (aCurrentKitBase === baseUrl) return; // 同じキットなら何もしない
  // 既存のプレイヤーを破棄してリセット
  for (const k of Object.keys(aSamplers)) {
    const m = Number(k);
    const p = aSamplers[m];
    try { p?.stop(); } catch { /* ignore */ }
    try { p?.dispose(); } catch { /* ignore */ }
    delete aSamplers[m];
    aSamplesReady[m] = false;
  }
  aSampleMode = false;
  aCurrentKitBase = baseUrl;
  const files: Array<{ midi: number; file: string }> = [
    { midi: DRUM_KICK_MIDI,       file: "kick.wav" },
    { midi: DRUM_SNARE_MIDI,      file: "snare.wav" },
    { midi: DRUM_RIM_MIDI,        file: "rim.wav" },
    { midi: DRUM_HIHAT_MIDI,      file: "hihat_closed.wav" },
    { midi: DRUM_HIHAT_OPEN_MIDI, file: "hihat_open.wav" },
    { midi: DRUM_CRASH_MIDI,      file: "crash.wav" },
    { midi: DRUM_RIDE_MIDI,       file: "ride.wav" },
    { midi: DRUM_TOM_LO_MIDI,     file: "tom_lo.wav" },
    { midi: DRUM_TOM_MID_MIDI,    file: "tom_mid.wav" },
    { midi: DRUM_TOM_HI_MIDI,     file: "tom_hi.wav" },
    { midi: DRUM_CLAP_MIDI,       file: "clap.wav" },
  ];
  for (const { midi, file } of files) {
    const url = baseUrl + file;
    const player = new Tone.Player({
      url,
      autostart: false,
      onload: () => {
        aSamplesReady[midi] = true;
        aSampleMode = true;
      },
      onerror: () => {
        // ファイルが無い (404) などは静かに無視 (シンセ側で鳴らす)
        aSamplesReady[midi] = false;
      },
    });
    if (aBus) player.connect(aBus);
    aSamplers[midi] = player;
  }
}

/**
 * 指定のキット ID へ切り替える。/drums/kit1/ のようなサブフォルダから再ロード。
 * "root" の場合は /drums/ (後方互換 = 既存ファイルを直接使用)。
 */
export function setAcousticDrumKit(kitId: AcousticDrumKitId) {
  const base = kitId === "root" ? "/drums/" : `/drums/${kitId}/`;
  loadAcousticDrumSamples(base);
}

/** サンプル差し替え動作中か */
export function isAcousticDrumSampleMode(): boolean {
  return aSampleMode;
}

/** 1 発のサンプル発音。読み込み済みの楽器のみ鳴り、未読み込みは false を返す。 */
function triggerSample(midi: number, time: number, velocity: number): boolean {
  if (!aSamplesReady[midi]) return false;
  const player = aSamplers[midi];
  if (!player || !player.loaded) return false;
  // Tone.Player は volume をデシベルで持つ。velocity をリニア→dB に変換。
  const v = Math.max(0.05, Math.min(1, velocity));
  player.volume.value = Tone.gainToDb(v);
  try {
    player.start(time);
  } catch {
    // 同じプレイヤーを連打した時の "already started" を握りつぶす
    try {
      player.stop(time);
      player.start(time);
    } catch {
      return false;
    }
  }
  return true;
}

function ensureAcousticDrums() {
  if (aKickSub) return;

  // === マスタチェーン ===
  // 生ドラムらしさは「アタックを残しつつ、サスティンを軽く詰めて部屋鳴りで貼る」
  // 1. ナチュラルなグルーコンプ (バス全体をまとめる)
  //    アタック 8ms に伸ばし、トランジェント (キック/スネアの "コン" "パン") を逃がす。
  //    比率 2.0 / knee 12 で「踏みつぶさず、後ろの胴鳴りだけ揃える」感覚。
  aComp = new Tone.Compressor({
    threshold: -16,
    ratio: 2.0,
    attack: 0.008,
    release: 0.22,
    knee: 12,
  }).toDestination();
  // 2. テープ風サチュレーション: ごく薄く (wet 0.18) かけて倍音を足し、デジタル感を消す
  aSat = new Tone.Distortion({ distortion: 0.05, wet: 0.18 }).connect(aComp);
  // 3. EQ: 低域は控えめに、中域 (胴鳴り) は触らず、高域だけ少し開ける
  //    ボトムを盛りすぎると "シンセドラム" 感が出るので 1.5dB 程度に抑える。
  aEq = new Tone.EQ3({ low: 1.5, mid: 0, high: 1.8, lowFrequency: 180, highFrequency: 4500 }).connect(aSat);

  // 4. 部屋鳴りリバーブ: 短め (0.9s) で初期反射感、preDelay でアタックを濁らせない
  aRoomReverb = new Tone.Reverb({ decay: 0.9, preDelay: 0.018, wet: 1.0 }).toDestination();
  aRoomSend = new Tone.Gain(0.22).connect(aRoomReverb);

  // 5. メインバス: ドライ (EQ→sat→comp) と Wet (room) の 2 系統に送る
  aBus = new Tone.Channel({ volume: 5 });
  aBus.connect(aEq);
  aBus.connect(aRoomSend);

  // ---- KICK : サブ (低胴・タイト) + ボディ (中胴・スクエア寄り) + ビーター (アタック)
  // 実機キックは「低音の押し込み」と「ビーターのコンッ」の二層構造。
  // 電子ドラム感を抜く鍵: octaves を絞る (シンセベース化を防ぐ) +
  //                      ピッチエンベロープを浅くする (= "ドゥウーン" を避ける) +
  //                      pitchDecay を速く (= ピッチが落ちる瞬間が短い).
  aKickSub = new Tone.MembraneSynth({
    pitchDecay: 0.028,    // 0.05 → 0.028: ピッチが落ちる時間を短くして "ドスッ" に
    octaves: 5,            // 8 → 5: シンセ風スイープ感を抑えて生ドラム寄り
    envelope: { attack: 0.001, decay: 0.4, sustain: 0, release: 0.45 },
    oscillator: { type: "sine" },
    volume: 1,
  }).connect(aBus);
  aKickBody = new Tone.MembraneSynth({
    pitchDecay: 0.02,
    octaves: 3.5,          // 4.5 → 3.5: 胴鳴り中域を太く
    envelope: { attack: 0.001, decay: 0.18, sustain: 0, release: 0.2 },
    oscillator: { type: "triangle" },
    volume: -6,
  }).connect(aBus);
  // ビーター: 帯域を 1.6kHz に下げてフェルト感 (= 木質のコンッ) を出す
  aKickBeaterHPF = new Tone.Filter({ type: "highpass", frequency: 1600, Q: 0.6 });
  aKickBeater = new Tone.NoiseSynth({
    noise: { type: "pink" },
    envelope: { attack: 0.0005, decay: 0.012, sustain: 0, release: 0.006 },
    volume: -10,
  }).chain(aKickBeaterHPF, aBus);

  // ---- SNARE : 胴の倍音 2 層 + スネアワイヤノイズ (BP) + テイル (HPF)
  // 実機スネアの音は「胴の鳴り (200Hz / 400Hz 付近)」+「スネアワイヤ (3〜6kHz の
  // バンドパスノイズ)」+「上半部のサスティン (HPF ノイズの長め減衰)」が混ざる。
  // 電子ドラム感の原因: BP の Q が高すぎて笛のような共振が出る + 胴鳴りが大きすぎる。
  // 解決: 胴を控えめに、ワイヤを広帯域に、テイルを長めに残す = 自然なスネア。
  aSnareShellHi = new Tone.MembraneSynth({
    pitchDecay: 0.008,
    octaves: 3,
    envelope: { attack: 0.001, decay: 0.13, sustain: 0, release: 0.12 },
    oscillator: { type: "triangle" },
    volume: -10,           // 胴鳴りは抑え目 (= ノイズ主体)
  }).connect(aBus);
  aSnareShellLo = new Tone.MembraneSynth({
    pitchDecay: 0.015,
    octaves: 2.6,
    envelope: { attack: 0.001, decay: 0.16, sustain: 0, release: 0.14 },
    oscillator: { type: "sine" },
    volume: -12,
  }).connect(aBus);
  // スネアワイヤ: BP を 2.2kHz 中心 / Q 0.7 と広めにして「パン」を金属共振でなく
  // ホワイトノイズの帯域として出す (= 自然なスネアの粒感)
  aSnareBP = new Tone.Filter({ type: "bandpass", frequency: 2200, Q: 0.7 });
  aSnareNoise = new Tone.NoiseSynth({
    noise: { type: "white" },
    envelope: { attack: 0.0005, decay: 0.18, sustain: 0, release: 0.16 },
    volume: -2,
  }).chain(aSnareBP, aBus);
  // テイル: HPF を 3.5kHz と少し下げて、「シャラ…」感が長く残るように
  aSnareTailHPF = new Tone.Filter({ type: "highpass", frequency: 3500, Q: 0.4 });
  aSnareTail = new Tone.NoiseSynth({
    noise: { type: "white" },
    envelope: { attack: 0.001, decay: 0.32, sustain: 0, release: 0.28 },
    volume: -11,
  }).chain(aSnareTailHPF, aBus);
  // スナップ層: 5kHz BP (Q 高め) を 8ms だけ通す = スネアワイヤが弾ける瞬間の "パッ"
  // これだけで一気に「録音した生スネア」の感じが出る (= MembraneSynth では出せない鋭さ)
  aSnareSnapBP = new Tone.Filter({ type: "bandpass", frequency: 5200, Q: 2.5 });
  aSnareSnap = new Tone.NoiseSynth({
    noise: { type: "white" },
    envelope: { attack: 0.0003, decay: 0.012, sustain: 0, release: 0.006 },
    volume: -4,
  }).chain(aSnareSnapBP, aBus);

  // ---- RIM : 木のリム + 短いクリック
  aRimBP = new Tone.Filter({ type: "bandpass", frequency: 1400, Q: 5 });
  aRimNoise = new Tone.NoiseSynth({
    noise: { type: "pink" },
    envelope: { attack: 0.0005, decay: 0.035, sustain: 0, release: 0.02 },
    volume: -8,
  }).chain(aRimBP, aBus);
  aRimClick = new Tone.MembraneSynth({
    pitchDecay: 0.005,
    octaves: 2,
    envelope: { attack: 0.001, decay: 0.05, sustain: 0, release: 0.04 },
    oscillator: { type: "square" },
    volume: -22,
  }).connect(aBus);

  // ---- HAT CLOSED : 金属層 (MetalSynth) + 広帯域ノイズ層 (生ドラムの "シャッ")
  // MetalSynth 単体だと「ピーンッ」と電子的に響くので、3〜7kHz のバンドパスノイズを
  // 上から重ねて「チッ」「シャッ」のホワイトな粒感を加える。これだけで一気に生っぽくなる。
  aHatHPF = new Tone.Filter({ type: "highpass", frequency: 9000, Q: 0.5 });
  aHatMetal = new Tone.MetalSynth({
    envelope: { attack: 0.001, decay: 0.05, release: 0.025 },
    harmonicity: 5.1,         // 3.7 → 5.1: より非整数 = 金物っぽい
    modulationIndex: 22,       // 32 → 22: 倍音をやや薄く
    resonance: 8500,           // 7200 → 8500: ピークを上に押し上げて自然な抜け感
    octaves: 1.2,
    volume: -22,               // -16 → -22: 金属層を弱くしてノイズ層が主役
  }).chain(aHatHPF, aBus);
  aHatNoiseBP = new Tone.Filter({ type: "bandpass", frequency: 6500, Q: 0.5 });
  aHatNoise = new Tone.NoiseSynth({
    noise: { type: "white" },
    envelope: { attack: 0.0005, decay: 0.04, sustain: 0, release: 0.02 },
    volume: -8,
  }).chain(aHatNoiseBP, aBus);

  // ---- HAT OPEN : 同じく + 長めシマー (ノイズで支援)
  aHatOpenHPF = new Tone.Filter({ type: "highpass", frequency: 7200, Q: 0.6 });
  aHatOpenMetal = new Tone.MetalSynth({
    envelope: { attack: 0.001, decay: 0.4, release: 0.25 },
    harmonicity: 4.1,
    modulationIndex: 30,
    resonance: 6800,
    octaves: 1.5,
    volume: -16,
  }).chain(aHatOpenHPF, aBus);
  aHatOpenNoise = new Tone.NoiseSynth({
    noise: { type: "white" },
    envelope: { attack: 0.002, decay: 0.45, sustain: 0, release: 0.25 },
    volume: -22,
  }).chain(aHatOpenHPF, aBus);

  // ---- CRASH : 大きい金物 + 長いノイズシマー (非整数倍音)
  aCrashHPF = new Tone.Filter({ type: "highpass", frequency: 4200, Q: 0.4 });
  aCrashMetal = new Tone.MetalSynth({
    envelope: { attack: 0.001, decay: 1.8, release: 1.0 },
    harmonicity: 5.3,
    modulationIndex: 50,
    resonance: 5500,
    octaves: 2,
    volume: -14,
  }).chain(aCrashHPF, aBus);
  aCrashNoise = new Tone.NoiseSynth({
    noise: { type: "white" },
    envelope: { attack: 0.001, decay: 1.8, sustain: 0, release: 1.0 },
    volume: -18,
  }).chain(aCrashHPF, aBus);

  // ---- RIDE : ベル中心 + スティック粒 (非整数倍音)
  aRideBell = new Tone.MetalSynth({
    envelope: { attack: 0.001, decay: 0.55, release: 0.4 },
    harmonicity: 3.9,
    modulationIndex: 28,
    resonance: 4800,
    octaves: 1.6,
    volume: -16,
  }).connect(aBus);
  aRideStickBP = new Tone.Filter({ type: "bandpass", frequency: 5800, Q: 1.6 });
  aRideStick = new Tone.NoiseSynth({
    noise: { type: "white" },
    envelope: { attack: 0.001, decay: 0.16, sustain: 0, release: 0.12 },
    volume: -18,
  }).chain(aRideStickBP, aBus);

  // ---- TOMS : ロック寄りに octaves/pitchDecay を絞り、アタックを強く
  // 生トムの特徴は「ヘッドの倍音 (sine) + 胴の倍音 (triangle 5度上) + 木質アタック (HPF pink noise)」
  // 単一 MembraneSynth だと "ボーン" としか鳴らないので、pitchDecay を浅くして
  // ピッチが落ちる時間を短くする (= "ドコッ" のドラム感)。
  aTomLo = new Tone.MembraneSynth({
    pitchDecay: 0.025,            // 0.04 → 0.025: ピッチ落ち時間を短く
    octaves: 2.8,                  // 3.5 → 2.8: シンセ風スイープ感を抑制
    envelope: { attack: 0.001, decay: 0.5, sustain: 0, release: 0.45 },
    oscillator: { type: "sine" },
    volume: -3,
  }).connect(aBus);
  aTomMid = new Tone.MembraneSynth({
    pitchDecay: 0.022,
    octaves: 2.6,
    envelope: { attack: 0.001, decay: 0.4, sustain: 0, release: 0.36 },
    oscillator: { type: "sine" },
    volume: -4,
  }).connect(aBus);
  aTomHi = new Tone.MembraneSynth({
    pitchDecay: 0.02,
    octaves: 2.4,
    envelope: { attack: 0.001, decay: 0.3, sustain: 0, release: 0.28 },
    oscillator: { type: "sine" },
    volume: -4,
  }).connect(aBus);

  // ---- CLAP : 生ドラム専用 (大きめ音量で aBus へ)
  aClapBP = new Tone.Filter({ type: "bandpass", frequency: 1700, Q: 1.0 });
  aClapNoise = new Tone.NoiseSynth({
    noise: { type: "white" },
    envelope: { attack: 0.001, decay: 0.2, sustain: 0, release: 0.12 },
    volume: -2,
  }).chain(aClapBP, aBus);
}

// ---------------------------------------------------------------------------
// Humanization helpers
//
// 実機ドラマーは、同じ拍の同じヒットでも毎回まったく同じ音にはならない:
//   - ベロシティが ±10〜15% 揺らぐ
//   - スティック位置や角度で音色が微妙に変わる (ピッチが ±数十セント揺れる)
//   - タイミングが ±数 ms 前後する (バスドラ / スネアは正確、ハットは揺らぎ大)
// この差が「打ち込み」と「生演奏」の最大の違い。
// ここではトリガー時に決定論的でない (Math.random) 揺らぎを乗せる。
// ---------------------------------------------------------------------------

/** ベロシティを ±range の比率で揺らす。 */
function jitterVel(v: number, range: number): number {
  const j = 1 + (Math.random() * 2 - 1) * range;
  return Math.max(0.05, Math.min(1, v * j));
}

/** ピッチ (周波数) を半音 ±range セントの範囲で揺らす。
 *  Tone の MembraneSynth は note を文字列でも数値でも受けるが、
 *  軽い揺らぎは "ピッチ" ではなく playbackRate 相当で出すと自然。
 *  ここでは MIDI ノートを 0.01 半音単位でずらして対応する。 */
function jitterPitch(noteOrMidi: number, semitones: number): number {
  return noteOrMidi + (Math.random() * 2 - 1) * semitones;
}

/** タイミングを ±ms 揺らす (秒単位に変換)。 */
function jitterTime(t: number, ms: number): number {
  return t + ((Math.random() * 2 - 1) * ms) / 1000;
}

/** MIDI 数値を Tone 用のノート文字列に変換 (sharp 表記)。 */
const PC_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
function midiToNote(midi: number): string {
  const pc = ((Math.round(midi) % 12) + 12) % 12;
  const octave = Math.floor(Math.round(midi) / 12) - 1;
  return `${PC_NAMES[pc]}${octave}`;
}

/**
 * 生ドラムを 1 発鳴らす。
 * Clap (DRUM_CLAP_MIDI) も生ドラム専用シンセを aBus 上に持つ。
 *
 * velocity がかなり小さい (< 0.35) ヒットは "ゴーストノート" 扱いとし、
 * 倍音 / テイル成分を弱めて柔らかい音色にする (スネアは特に効く)。
 */
export function triggerDrumHitAcoustic(
  midi: number,
  time?: number,
  velocity = 0.85,
) {
  ensureAcousticDrums();
  const vRaw = Math.max(0.05, Math.min(1, velocity));
  const t0 = time ?? Tone.now();
  // サンプル差し替え動作中で、この楽器のサンプルが読み込めていれば
  // サンプルだけ鳴らしてシンセ側はスキップ (= 完全に生ドラムの音)
  if (aSampleMode && triggerSample(midi, jitterTime(t0, 2), jitterVel(vRaw, 0.08))) {
    return;
  }
  // ゴースト判定 (微弱な裏拍ヒット)
  const ghost = vRaw < 0.35;

  switch (midi) {
    case DRUM_CLAP_MIDI: {
      // 3 連打感を出すために少しずらして 2 発、各回タイミング・ベロシティを揺らす
      const v = jitterVel(vRaw, 0.08);
      aClapNoise?.triggerAttackRelease(0.05, jitterTime(t0, 2), v);
      aClapNoise?.triggerAttackRelease(0.14, t0 + 0.014 + (Math.random() * 0.006 - 0.003), v * jitterVel(0.85, 0.1));
      return;
    }
    case DRUM_KICK_MIDI: {
      // キックはタイミング揺らぎ小 (±2ms 程度)、ピッチも狭く
      const t = jitterTime(t0, 2);
      const v = jitterVel(vRaw, 0.06);
      const subPitch = jitterPitch(33, 0.1); // A1 = 33
      const bodyPitch = jitterPitch(36, 0.1); // C2
      aKickSub?.triggerAttackRelease(midiToNote(subPitch), "4n", t, v);
      aKickBody?.triggerAttackRelease(midiToNote(bodyPitch), "8n", t, v * 0.85);
      // 強く叩くほどビーターの "コンッ" が際立つ
      aKickBeater?.triggerAttackRelease(0.022, t, v * (0.55 + vRaw * 0.35));
      return;
    }
    case DRUM_SNARE_MIDI: {
      // スネアはタイミング揺らぎ ±3ms、ベロシティ ±10%
      const t = jitterTime(t0, 3);
      const v = jitterVel(vRaw, 0.1);
      // ゴーストは胴鳴り＋ノイズを大幅に弱め、テイルもほぼ無く
      const shellMul = ghost ? 0.35 : 0.7;
      const noiseMul = ghost ? 0.45 : 1.0;
      const tailMul = ghost ? 0.0 : 0.55;
      const snapMul = ghost ? 0.25 : 1.0;
      aSnareShellHi?.triggerAttackRelease(midiToNote(jitterPitch(52, 0.15)), 0.13, t, v * shellMul);
      aSnareShellLo?.triggerAttackRelease(midiToNote(jitterPitch(45, 0.15)), 0.18, t, v * shellMul * 0.85);
      aSnareNoise?.triggerAttackRelease(0.18 + Math.random() * 0.03, t, v * noiseMul);
      // スナップ層: ヒット瞬間に "パッ" と弾ける成分 (生スネア感の決め手)
      aSnareSnap?.triggerAttackRelease(0.015, t, v * snapMul);
      if (!ghost) {
        aSnareTail?.triggerAttackRelease(0.32 + Math.random() * 0.05, t, v * tailMul);
      }
      return;
    }
    case DRUM_RIM_MIDI: {
      const t = jitterTime(t0, 2);
      const v = jitterVel(vRaw, 0.08);
      aRimNoise?.triggerAttackRelease(0.035, t, v);
      aRimClick?.triggerAttackRelease(midiToNote(jitterPitch(69, 0.2)), 0.04, t, v * 0.7);
      return;
    }
    case DRUM_HIHAT_MIDI: {
      // ハットは生っぽさが特に出る部分: タイミング ±6ms、ベロシティ ±15%、強弱で帯域変化
      const t = jitterTime(t0, 6);
      const v = jitterVel(vRaw, 0.15);
      // 強く叩くほど高域が伸びる (チック→チッ→チャッ)
      const decay = 0.035 + vRaw * 0.05;
      aHatMetal?.triggerAttackRelease("C6", decay, t, v * 0.55);
      // ノイズ層 (主役): 「チッ」のホワイト粒感
      aHatNoise?.triggerAttackRelease(decay * 1.1, t, v * 0.85);
      return;
    }
    case DRUM_HIHAT_OPEN_MIDI: {
      const t = jitterTime(t0, 5);
      const v = jitterVel(vRaw, 0.1);
      aHatOpenMetal?.triggerAttackRelease("C6", 0.35 + Math.random() * 0.08, t, v * 0.7);
      aHatOpenNoise?.triggerAttackRelease(0.4 + Math.random() * 0.08, t, v * 0.6);
      return;
    }
    case DRUM_CRASH_MIDI: {
      const t = jitterTime(t0, 4);
      const v = jitterVel(vRaw, 0.07);
      aCrashMetal?.triggerAttackRelease("C5", 1.6 + Math.random() * 0.2, t, v * 0.8);
      aCrashNoise?.triggerAttackRelease(1.6 + Math.random() * 0.2, t, v * 0.6);
      return;
    }
    case DRUM_RIDE_MIDI: {
      const t = jitterTime(t0, 4);
      const v = jitterVel(vRaw, 0.1);
      aRideBell?.triggerAttackRelease("C5", 0.45 + Math.random() * 0.1, t, v * 0.55);
      aRideStick?.triggerAttackRelease(0.14, t, v * 0.7);
      return;
    }
    case DRUM_TOM_LO_MIDI: {
      const t = jitterTime(t0, 3);
      const v = jitterVel(vRaw, 0.08);
      aTomLo?.triggerAttackRelease(midiToNote(jitterPitch(41, 0.2)), "4n", t, v);
      return;
    }
    case DRUM_TOM_MID_MIDI: {
      const t = jitterTime(t0, 3);
      const v = jitterVel(vRaw, 0.08);
      aTomMid?.triggerAttackRelease(midiToNote(jitterPitch(45, 0.2)), "4n", t, v);
      return;
    }
    case DRUM_TOM_HI_MIDI: {
      const t = jitterTime(t0, 3);
      const v = jitterVel(vRaw, 0.08);
      aTomHi?.triggerAttackRelease(midiToNote(jitterPitch(50, 0.2)), "8n", t, v);
      return;
    }
    default:
      return;
  }
}
