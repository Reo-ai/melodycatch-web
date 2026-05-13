/**
 * 保存スロット (localStorage) — 作曲した内容を 10 個まで保存し、
 * 別タブから再生できるようにする。
 *
 * - キーは `melodycatch.slot.{1..10}` を使う。
 * - 値は `SlotData` を JSON シリアライズしたもの。
 * - スケール情報も一緒に保存しているが、別タブ再生では「鳴らす」だけなので
 *   現状はメタ情報として持つだけ (将来の互換用)。
 */
import type { Layer } from "./recorder";

export const SLOT_COUNT = 10;

export interface SlotData {
  /** ユーザーが付けた名前。空ならスロット番号を表示。 */
  name: string;
  /** 保存日時 (epoch ms) */
  savedAt: number;
  /** 再生 BPM (再生側で必要になることはないが、参考表示用) */
  bpm: number;
  /** スケール (参考表示用) */
  scaleRoot: number;
  scaleKind: string;
  /** 7 レイヤー */
  melody: Layer;
  chord: Layer;
  drum: Layer;
  bass: Layer;
  synth: Layer;
  guitar: Layer;
  /** アコギ (歪みなしクリーン)。古い保存データには存在しないので optional。 */
  acoustic?: Layer;
}

const KEY_PREFIX = "melodycatch.slot.";

function key(slot: number): string {
  return `${KEY_PREFIX}${slot}`;
}

/** スロット番号 (1..SLOT_COUNT) のデータを返す。なければ null。 */
export function loadSlot(slot: number): SlotData | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key(slot));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SlotData;
    return parsed;
  } catch {
    return null;
  }
}

export function saveSlot(slot: number, data: SlotData): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(key(slot), JSON.stringify(data));
    return true;
  } catch (e) {
    console.error("[slots] saveSlot failed", e);
    return false;
  }
}

export function deleteSlot(slot: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key(slot));
  } catch {
    /* noop */
  }
}

export function listSlots(): (SlotData | null)[] {
  const out: (SlotData | null)[] = [];
  for (let i = 1; i <= SLOT_COUNT; i++) {
    out.push(loadSlot(i));
  }
  return out;
}

/** URL ?slot=N にマッチしたらスロット番号を返す。0/範囲外は null。 */
export function parsePlayerSlotFromLocation(): number | null {
  if (typeof window === "undefined") return null;
  const url = new URL(window.location.href);
  const raw = url.searchParams.get("slot");
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > SLOT_COUNT) return null;
  return n;
}

/** 別タブで開くための URL を組み立てる。 */
export function buildPlayerUrl(slot: number): string {
  if (typeof window === "undefined") return `?player=1&slot=${slot}`;
  const url = new URL(window.location.href);
  url.searchParams.set("player", "1");
  url.searchParams.set("slot", String(slot));
  url.hash = "";
  return url.toString();
}

// ---- Studio ↔ Library タブ間共有 ------------------------------------------
//
// 「保存パネル」を別タブ (?library=1) に移すため、Studio タブの作業状態を
// localStorage に写し続け、Library タブからその写しを読み出して保存スロットに
// 書き込む。また、Library タブから Studio タブへ「このスロットをロードして」と
// 指示するための loadIntent キーも用意する (Studio は storage イベントで検知)。

/** Studio が今鳴らしている作業状態の写し。Library タブはこれを保存源にする。 */
const CURRENT_KEY = "melodycatch.current";

/** Library → Studio に「このスロットをロードして」と通知するキー (storage イベント駆動)。 */
const LOAD_INTENT_KEY = "melodycatch.loadIntent";

export interface CurrentSnapshot {
  bpm: number;
  scaleRoot: number;
  scaleKind: string;
  updatedAt: number;
  melody: Layer;
  chord: Layer;
  drum: Layer;
  bass: Layer;
  synth: Layer;
  guitar: Layer;
  /** アコギ (歪みなしクリーン)。古いスナップショットには存在しないので optional。 */
  acoustic?: Layer;
}

export function writeCurrent(snap: CurrentSnapshot): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CURRENT_KEY, JSON.stringify(snap));
  } catch {
    /* localStorage quota など。サイレントに失敗。 */
  }
}

export function readCurrent(): CurrentSnapshot | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(CURRENT_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as CurrentSnapshot;
  } catch {
    return null;
  }
}

/** Library タブから Studio タブにスロット N のロードを依頼する。 */
export function writeLoadIntent(slot: number): void {
  if (typeof window === "undefined") return;
  try {
    // 同じ値を続けて書いても storage イベントが発火するように、毎回 timestamp を含める。
    window.localStorage.setItem(
      LOAD_INTENT_KEY,
      JSON.stringify({ slot, ts: Date.now() }),
    );
  } catch {
    /* noop */
  }
}

/** Studio が読み取った後にクリアする。 */
export function consumeLoadIntent(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LOAD_INTENT_KEY);
    if (!raw) return null;
    window.localStorage.removeItem(LOAD_INTENT_KEY);
    const parsed = JSON.parse(raw) as { slot?: number };
    if (typeof parsed.slot === "number" && Number.isInteger(parsed.slot)) {
      return parsed.slot;
    }
    return null;
  } catch {
    return null;
  }
}

/** 別タブで Library を開くための URL を組み立てる。 */
export function buildLibraryUrl(): string {
  if (typeof window === "undefined") return "?library=1";
  const url = new URL(window.location.href);
  url.searchParams.set("library", "1");
  url.searchParams.delete("player");
  url.searchParams.delete("slot");
  url.hash = "";
  return url.toString();
}

/** スロットの簡易ラベル (空 / 名前 + ノート数 + 保存日) */
export function slotLabel(slot: number, data: SlotData | null): string {
  if (!data) return `スロット ${slot}: 空`;
  const total =
    data.melody.notes.length +
    data.chord.notes.length +
    data.drum.notes.length +
    data.bass.notes.length +
    data.synth.notes.length +
    data.guitar.notes.length +
    (data.acoustic?.notes.length ?? 0);
  const date = new Date(data.savedAt);
  const dateStr = `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const name = data.name?.trim() ? data.name.trim() : `スロット ${slot}`;
  return `${name} · ${total} ノート · ${dateStr}`;
}
