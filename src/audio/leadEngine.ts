/**
 * メロディ専用の「リード」音源。
 *
 * 曲の主役は歌 (メロディ)。伴奏と同じピアノでメロディを鳴らすと、どれが主役か分からず
 * 「打ち込みを並べただけ」に聞こえる。歌の代わりになる音色で、伴奏より一段前に出して鳴らす。
 *
 * 音色:
 *   - "violin": 本物のソロ・バイオリン (VSCO 2 CE, CC0)。ビブラートがあり、人の声に一番近い「歌う楽器」。
 *   - "guitar": 本物のエレキギター (Karoryfer Emilyguitar, CC0) を歪み + ディレイで。ロックのリード。
 *   - "piano" : 従来どおりピアノ (pianoEngine) で鳴らす。
 *
 * 音は mixer の "lead" チャネル (中央・少し大きめ) に出す。読み込み中はピアノで代わりに鳴らす。
 */
import * as Tone from "tone";
import { midiToNoteString } from "../music/pitch";
import { getMixerInput } from "./mixer";
import { createSampler, samplerReady, velocity01 } from "./sampledInstruments";
import { holdOff as pianoHoldOff, holdOn as pianoHoldOn } from "./pianoEngine";

export type LeadTone = "violin" | "guitar" | "piano";

export const LEAD_TONE_LABEL_JA: Record<LeadTone, string> = {
  violin: "バイオリン",
  guitar: "ギター",
  piano: "ピアノ",
};

let currentTone: LeadTone = "violin";
let violin: Tone.Sampler | null = null;
let guitar: Tone.Sampler | null = null;
/** どの音をどの音源で鳴らし始めたか (途中で音色を変えても正しく止めるため)。 */
const heldBy = new Map<number, LeadTone>();

function ensureLead(): void {
  if (violin) return;
  const out = getMixerInput("lead");

  // 共通の空間: 短いディレイ (歌のような余韻) + プレート風リバーブ
  const reverb = new Tone.Reverb({ decay: 2.4, preDelay: 0.02, wet: 0.24 }).connect(out);
  const delay = new Tone.FeedbackDelay({ delayTime: 0.28, feedback: 0.22, wet: 0.12 }).connect(reverb);

  // バイオリン: 低い胴鳴りを整理し、声の「抜け」の帯域 (3kHz 付近) を少し持ち上げる
  const vPresence = new Tone.Filter({ type: "peaking", frequency: 3000, Q: 0.9, gain: 2 }).connect(delay);
  const vHighpass = new Tone.Filter({ type: "highpass", frequency: 180, Q: 0.7 }).connect(vPresence);
  violin = createSampler("violin", { attack: 0.04, release: 0.35, volume: 4 });
  violin.connect(vHighpass);

  // ギター: 歪み → 低域を削る → 耳に痛い高域を丸める → コーラスで広げる
  const gChorus = new Tone.Chorus({ frequency: 0.8, delayTime: 3, depth: 0.25, wet: 0.2 }).connect(delay).start();
  const gLowpass = new Tone.Filter({ type: "lowpass", frequency: 5200, Q: 0.6, rolloff: -24 }).connect(gChorus);
  const gHighpass = new Tone.Filter({ type: "highpass", frequency: 140, Q: 0.7 }).connect(gLowpass);
  const gDrive = new Tone.Distortion({ distortion: 0.55, oversample: "4x", wet: 1 }).connect(gHighpass);
  guitar = createSampler("eguitar", { attack: 0.005, release: 0.4, volume: -15 });
  guitar.connect(gDrive);
}

export function setLeadTone(tone: LeadTone): void {
  if (tone === currentTone) return;
  leadReleaseAll();
  currentTone = tone;
}

export function getLeadTone(): LeadTone {
  return currentTone;
}

/** リード音源を先に読み込んでおく。 */
export function preloadLead(): void {
  ensureLead();
}

/** 今の音色で実際に鳴らせる音源 (読み込み中はピアノ)。 */
function activeTone(): LeadTone {
  if (currentTone === "violin" && samplerReady(violin)) return "violin";
  if (currentTone === "guitar" && samplerReady(guitar)) return "guitar";
  return "piano";
}

export function leadHoldOn(midi: number, velocity = 0.85): void {
  ensureLead();
  const tone = activeTone();
  heldBy.set(midi, tone);
  if (tone === "piano") {
    pianoHoldOn(midi, velocity);
    return;
  }
  const s = tone === "violin" ? violin! : guitar!;
  s.triggerAttack(midiToNoteString(midi), undefined, velocity01(velocity));
}

export function leadHoldOff(midi: number): void {
  const tone = heldBy.get(midi) ?? activeTone();
  heldBy.delete(midi);
  if (tone === "piano") {
    pianoHoldOff(midi);
    return;
  }
  const s = tone === "violin" ? violin : guitar;
  s?.triggerRelease(midiToNoteString(midi));
}

export function leadReleaseAll(): void {
  for (const [midi, tone] of heldBy) {
    if (tone === "piano") pianoHoldOff(midi);
  }
  heldBy.clear();
  try { violin?.releaseAll(); } catch { /* noop */ }
  try { guitar?.releaseAll(); } catch { /* noop */ }
}
