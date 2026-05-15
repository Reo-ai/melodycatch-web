/**
 * 別タブで開かれる「保存ライブラリ」ページ。
 *
 * - URL `?library=1` で App から表示される。
 * - localStorage の `melodycatch.current` (Studio タブが書き出した最新状態の写し)
 *   をスロットへ保存できる。
 * - 既存スロットのロード/削除/別タブ再生/Studio で開く 操作が可能。
 * - Studio に「このスロットをロードして」と伝えるには `melodycatch.loadIntent` を
 *   書き込み、Studio はそれを storage イベントで検知する。
 *
 * 注意: Library タブは Studio の現在の作業状態をリアルタイムに同期するが、
 * 保存はあくまで Studio が書いたスナップショットに対して行う。
 */
import { useEffect, useState } from "react";
import {
  SLOT_COUNT,
  buildPlayerUrl,
  deleteSlot,
  listSlots,
  readCurrent,
  saveSlot,
  writeLoadIntent,
  type CurrentSnapshot,
  type SlotData,
} from "../audio/slots";

function countNotes(d: SlotData | CurrentSnapshot): number {
  return (
    d.melody.notes.length +
    d.chord.notes.length +
    d.drum.notes.length +
    d.bass.notes.length +
    d.synth.notes.length +
    d.guitar.notes.length +
    (d.acoustic?.notes.length ?? 0) +
    (d.vocal?.notes.length ?? 0)
  );
}

function formatDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default function LibraryPage() {
  const [slots, setSlots] = useState<(SlotData | null)[]>(() => listSlots());
  const [current, setCurrent] = useState<CurrentSnapshot | null>(() =>
    readCurrent(),
  );

  // 他タブ (Studio) からの localStorage 変更を購読し、表示をリフレッシュ。
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (!e.key) {
        setSlots(listSlots());
        setCurrent(readCurrent());
        return;
      }
      if (e.key.startsWith("melodycatch.slot.")) {
        setSlots(listSlots());
      } else if (e.key === "melodycatch.current") {
        setCurrent(readCurrent());
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  function refresh() {
    setSlots(listSlots());
    setCurrent(readCurrent());
  }

  function handleSave(slot: number) {
    const snap = readCurrent();
    if (!snap) {
      window.alert(
        "Studio タブが見つかりません。Studio タブを開いた状態で保存してください。",
      );
      return;
    }
    const existing = slots[slot - 1];
    const defaultName = existing?.name ?? `スロット ${slot}`;
    const name = window.prompt(
      existing
        ? `スロット ${slot} は既に使われています。上書きしますか？\n新しい名前を入力してください。`
        : `スロット ${slot} に保存します。\n名前を入力してください。`,
      defaultName,
    );
    if (name === null) return;
    const data: SlotData = {
      name: name.trim() || `スロット ${slot}`,
      savedAt: Date.now(),
      bpm: snap.bpm,
      scaleRoot: snap.scaleRoot,
      scaleKind: snap.scaleKind,
      melody: snap.melody,
      chord: snap.chord,
      drum: snap.drum,
      bass: snap.bass,
      synth: snap.synth,
      guitar: snap.guitar,
      acoustic: snap.acoustic,
      vocal: snap.vocal,
    };
    if (saveSlot(slot, data)) {
      refresh();
    } else {
      window.alert(
        `スロット ${slot} の保存に失敗しました (localStorage の上限の可能性があります)。`,
      );
    }
  }

  function handleDelete(slot: number) {
    if (!window.confirm(`スロット ${slot} を削除します。よろしいですか？`)) {
      return;
    }
    deleteSlot(slot);
    refresh();
  }

  function handleLoadInStudio(slot: number) {
    writeLoadIntent(slot);
    window.alert(
      `Studio タブにスロット ${slot} のロードを依頼しました。Studio タブに切り替えて確認してください。`,
    );
  }

  function handleOpenPlayer(slot: number) {
    const url = buildPlayerUrl(slot);
    window.open(url, "_blank", "noopener,noreferrer");
  }

  const currentTotal = current ? countNotes(current) : 0;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 text-ink-900">
      <header className="mb-6 rounded-2xl border border-ink-200 bg-white p-5 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-wider text-accent-600">
          MelodyCatch · 保存ライブラリ
        </p>
        <h2 className="mt-1 text-2xl font-bold">💾 保存・読み込み</h2>
        <p className="mt-1 text-xs text-ink-500">
          このタブは Studio タブと localStorage を共有します。Studio
          タブで作業中の譜面を任意のスロットへ保存できます。
        </p>
        {current ? (
          <p className="mt-3 rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
            ✓ Studio の現在状態を検知しました ({currentTotal} ノート · BPM{" "}
            {current.bpm} · 更新: {formatDate(current.updatedAt)})。
            下のスロットへ保存できます。
          </p>
        ) : (
          <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700">
            ⚠ Studio タブの作業状態が見つかりません。Studio
            タブを開いた状態で何か変更すると、ここに表示されます。
          </p>
        )}
      </header>

      <section className="rounded-2xl border border-ink-200 bg-white p-5 shadow-sm">
        <div className="mb-3 flex items-baseline justify-between">
          <h3 className="text-sm font-semibold text-ink-700">
            保存スロット (
            {slots.filter((s) => s != null).length} / {SLOT_COUNT} 使用中)
          </h3>
          <button
            type="button"
            onClick={refresh}
            className="rounded-full border border-ink-300 bg-white px-3 py-0.5 text-xs font-medium text-ink-700 hover:border-accent-300"
          >
            ↻ 再読込
          </button>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {slots.map((data, i) => {
            const slot = i + 1;
            const used = data != null;
            const title = data?.name?.trim() || `スロット ${slot}`;
            const noteTotal = data ? countNotes(data) : 0;
            return (
              <div
                key={slot}
                className={[
                  "flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2",
                  used
                    ? "border-emerald-200 bg-emerald-50"
                    : "border-ink-200 bg-ink-50",
                ].join(" ")}
              >
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-white text-sm font-bold text-ink-700 shadow-sm">
                  {slot}
                </span>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-xs font-semibold text-ink-800">
                    {used ? title : "(空き)"}
                  </span>
                  {used && data && (
                    <span className="text-[10px] text-ink-500">
                      {noteTotal} ノート · BPM {data.bpm} ·{" "}
                      {formatDate(data.savedAt)}
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  <button
                    type="button"
                    onClick={() => handleSave(slot)}
                    disabled={!current}
                    title={
                      current
                        ? used
                          ? "Studio の現在状態でこのスロットを上書きします"
                          : "Studio の現在状態をこのスロットに保存します"
                        : "Studio タブが見つからないため保存できません"
                    }
                    className="rounded-full bg-accent-500 px-2.5 py-0.5 text-[11px] font-semibold text-white hover:bg-accent-600 disabled:opacity-40"
                  >
                    {used ? "上書き保存" : "保存"}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleLoadInStudio(slot)}
                    disabled={!used}
                    title="Studio タブにこのスロットのロードを依頼します"
                    className="rounded-full border border-ink-300 bg-white px-2.5 py-0.5 text-[11px] font-medium text-ink-700 hover:border-accent-300 disabled:opacity-40"
                  >
                    Studio で読み込む
                  </button>
                  <button
                    type="button"
                    onClick={() => handleOpenPlayer(slot)}
                    disabled={!used}
                    title="別タブを開いてこのスロットを再生します"
                    className="rounded-full border border-violet-300 bg-white px-2.5 py-0.5 text-[11px] font-medium text-violet-700 hover:bg-violet-50 disabled:opacity-40"
                  >
                    🎧 別タブで再生
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(slot)}
                    disabled={!used}
                    title="このスロットを削除します"
                    className="rounded-full border border-rose-200 bg-white px-2 py-0.5 text-[11px] font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-40"
                  >
                    🗑
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <p className="mt-6 text-center text-xs text-ink-400">
        ライブラリタブは保存・管理専用です。曲の編集は Studio タブで行ってください。
      </p>
    </div>
  );
}
