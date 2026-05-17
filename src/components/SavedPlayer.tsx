/**
 * 別タブで開かれる、保存スロット再生専用ページ。
 *
 * - URL `?player=1&slot=N` でこのコンポーネントが App から表示される。
 * - localStorage の `melodycatch.slot.{N}` を読み出し、Playback クラスで再生。
 * - 編集機能は持たない (再生・停止のみ)。
 * - 同じスロットを後から元の Studio で更新しても、このページは
 *   起動時のスナップショットを使う (リロードで最新化)。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Playback, emptyLayer, type LayerId, type Layer } from "../audio/recorder";
import { loadSlot, parsePlayerSlotFromLocation, type SlotData } from "../audio/slots";
import { ensureAudio } from "../audio/pianoEngine";
import PianoRoll from "./PianoRoll";

const LAYER_LABEL: Record<LayerId, string> = {
  melody: "メロディ",
  chord: "コード",
  drum: "電子ドラム",
  drumAcoustic: "生ドラム",
  bass: "ベース",
  synth: "シンセ",
  guitar: "ギター",
  acoustic: "アコギ",
  vocal: "ボーカル",
  fx: "FX",
};

const LAYER_COLOR: Record<LayerId, string> = {
  melody: "bg-rose-500",
  chord: "bg-indigo-500",
  drum: "bg-amber-500",
  drumAcoustic: "bg-yellow-700",
  bass: "bg-emerald-500",
  synth: "bg-violet-500",
  guitar: "bg-sky-500",
  acoustic: "bg-orange-600",
  vocal: "bg-fuchsia-500",
  fx: "bg-slate-500",
};

export default function SavedPlayer() {
  const slotNum = useMemo(() => parsePlayerSlotFromLocation(), []);
  const [data, setData] = useState<SlotData | null>(() =>
    slotNum != null ? loadSlot(slotNum) : null,
  );
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const playbackRef = useRef<Playback | null>(null);
  const rafRef = useRef<number | null>(null);

  // 再生ヘッドを rAF で更新
  useEffect(() => {
    if (!playing) {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      return;
    }
    const tick = () => {
      const pb = playbackRef.current;
      if (pb) setElapsed(pb.elapsedSec());
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [playing]);

  useEffect(() => {
    return () => {
      playbackRef.current?.stop();
    };
  }, []);

  if (slotNum == null) {
    return (
      <div className="mx-auto max-w-xl px-4 py-12 text-center text-ink-700">
        <h2 className="text-xl font-bold">スロットが指定されていません</h2>
        <p className="mt-3 text-sm">
          URL に <code>?player=1&amp;slot=1</code> のようにスロット番号を付けてください。
        </p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="mx-auto max-w-xl px-4 py-12 text-center text-ink-700">
        <h2 className="text-xl font-bold">スロット {slotNum} は空です</h2>
        <p className="mt-3 text-sm">
          Studio からこのスロットへ保存してから、このタブを再読み込みしてください。
        </p>
        <button
          type="button"
          onClick={() => {
            const next = loadSlot(slotNum);
            setData(next);
          }}
          className="mt-4 rounded-full bg-accent-500 px-4 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-accent-600"
        >
          ↻ 読み直す
        </button>
      </div>
    );
  }

  const layers: Layer[] = [
    data.melody,
    data.chord,
    data.bass,
    data.synth,
    data.guitar,
    data.acoustic ?? emptyLayer("acoustic", "アコギ"),
    data.vocal ?? emptyLayer("vocal", "ボーカル"),
    data.drum,
    data.drumAcoustic ?? emptyLayer("drumAcoustic", "生ドラム"),
  ];
  const totalDuration = layers.reduce((acc, l) => {
    for (const n of l.notes) {
      const end = n.startSec + n.durationSec;
      if (end > acc) acc = end;
    }
    return acc;
  }, 0);
  const totalNotes = layers.reduce((acc, l) => acc + l.notes.length, 0);

  async function play() {
    await ensureAudio();
    playbackRef.current?.stop();
    const pb = new Playback(layers.filter((l) => l.notes.length > 0), {
      onEnd: () => {
        setPlaying(false);
        setElapsed(0);
      },
    });
    playbackRef.current = pb;
    pb.start(0);
    setPlaying(true);
  }

  function stop() {
    playbackRef.current?.stop();
    playbackRef.current = null;
    setPlaying(false);
    setElapsed(0);
  }

  function reload() {
    stop();
    const next = loadSlot(slotNum!);
    setData(next);
  }

  const title = data.name?.trim() ? data.name.trim() : `スロット ${slotNum}`;
  const savedDate = new Date(data.savedAt);
  const savedStr = `${savedDate.getFullYear()}/${savedDate.getMonth() + 1}/${savedDate.getDate()} ${String(savedDate.getHours()).padStart(2, "0")}:${String(savedDate.getMinutes()).padStart(2, "0")}`;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 text-ink-900">
      <header className="mb-6 rounded-2xl border border-ink-200 bg-white p-5 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-wider text-accent-600">
          MelodyCatch · 保存スロット {slotNum} を再生
        </p>
        <h2 className="mt-1 text-2xl font-bold">{title}</h2>
        <p className="mt-1 text-xs text-ink-500">
          保存日時: {savedStr} · BPM {data.bpm} · 合計 {totalNotes} ノート ·
          長さ {totalDuration.toFixed(1)} 秒
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {!playing ? (
            <button
              type="button"
              onClick={play}
              disabled={totalNotes === 0}
              className="rounded-full bg-rose-500 px-4 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-rose-600 disabled:opacity-40"
            >
              ▶ 再生
            </button>
          ) : (
            <button
              type="button"
              onClick={stop}
              className="rounded-full bg-ink-700 px-4 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-ink-800"
            >
              ■ 停止
            </button>
          )}
          <button
            type="button"
            onClick={reload}
            className="rounded-full border border-ink-300 bg-white px-3 py-1 text-xs font-medium text-ink-700 hover:border-accent-300"
          >
            ↻ 再読込
          </button>
          <span className="ml-auto text-xs text-ink-500">
            経過: {elapsed.toFixed(2)}s / {totalDuration.toFixed(1)}s
          </span>
        </div>
      </header>

      <section className="mb-6 rounded-2xl border border-ink-200 bg-white p-3 shadow-sm">
        <div className="mb-2 flex items-baseline justify-between">
          <h3 className="text-sm font-semibold text-ink-700">🎹 ピアノロール</h3>
          <span className="text-[11px] text-ink-500">
            読み取り専用 · 再生中はヘッドが動きます
          </span>
        </div>
        <PianoRoll
          melody={data.melody ?? emptyLayer("melody", "メロディ")}
          chord={data.chord ?? emptyLayer("chord", "コード")}
          drum={data.drum ?? emptyLayer("drum", "ドラム")}
          drumAcoustic={data.drumAcoustic ?? emptyLayer("drumAcoustic", "生ドラム")}
          bass={data.bass ?? emptyLayer("bass", "ベース")}
          synth={data.synth ?? emptyLayer("synth", "シンセ")}
          guitar={data.guitar ?? emptyLayer("guitar", "ギター")}
          acoustic={data.acoustic ?? emptyLayer("acoustic", "アコギ")}
          vocal={data.vocal ?? emptyLayer("vocal", "ボーカル")}
          fx={data.fx ?? emptyLayer("fx", "FX")}
          isActive={playing}
          recordingLayerId={null}
          getPlayheadSec={() =>
            playbackRef.current ? playbackRef.current.elapsedSec() : 0
          }
          bpm={data.bpm}
        />
      </section>

      <section className="rounded-2xl border border-ink-200 bg-white p-5 shadow-sm">
        <h3 className="mb-3 text-sm font-semibold text-ink-700">トラック構成</h3>
        <ul className="flex flex-col gap-2">
          {(["melody", "chord", "bass", "synth", "guitar", "acoustic", "vocal", "drum", "drumAcoustic"] as LayerId[]).map(
            (id) => {
              const l = layers.find((x) => x.id === id);
              const count = l ? l.notes.length : 0;
              return (
                <li
                  key={id}
                  className="flex items-center gap-3 rounded-md border border-ink-100 bg-ink-50 px-3 py-1.5 text-xs"
                >
                  <span
                    className={`inline-block h-3 w-3 rounded-full ${LAYER_COLOR[id]}`}
                  />
                  <span className="w-20 font-medium text-ink-700">
                    {LAYER_LABEL[id]}
                  </span>
                  <span className="text-ink-500">{count} ノート</span>
                </li>
              );
            },
          )}
        </ul>
      </section>

      <p className="mt-6 text-center text-xs text-ink-400">
        このページは別タブで再生専用です。編集する場合は元の Studio タブで操作してください。
      </p>
    </div>
  );
}
