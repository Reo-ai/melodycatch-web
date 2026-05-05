/**
 * MelodyCatch (Web) — ルート画面。
 *
 * 演奏モードと録音モードを統合した「Studio」スクリーン 1 枚で構成。
 * - キー / スケール
 * - ドラム
 * - DAW 風ピアノロール
 * - 録音トラック (使いたい時だけ録音)
 * - コードパレット / 進行プリセット
 * - スケール構成音ピアノ / 88 鍵ピアノ
 */

import { useMemo, useState } from "react";
import Studio from "./components/Studio";
import { C_MAJOR, scaleDisplayName, type Scale } from "./music/scale";

export default function App() {
  const [scale, setScale] = useState<Scale>(C_MAJOR);

  const scaleName = useMemo(() => scaleDisplayName(scale, "ja"), [scale]);

  return (
    <div className="min-h-screen bg-ink-50 text-ink-900">
      <header className="sticky top-0 z-10 border-b border-ink-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
          <div>
            <h1 className="text-xl font-bold tracking-tight sm:text-2xl">
              Melody Catch
              <span className="ml-2 text-xs font-normal text-ink-500 sm:text-sm">
                ピアノ作曲・コード進行アシスタント
              </span>
            </h1>
            <p className="mt-0.5 text-xs text-ink-500 sm:text-sm">
              現在のキー: <span className="font-medium text-ink-900">{scaleName}</span>
            </p>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6">
        <Studio scale={scale} onScaleChange={setScale} />
      </main>

      <footer className="mx-auto max-w-6xl px-4 pb-10 pt-4 text-center text-xs text-ink-400">
        Melody Catch Web — Tone.js + React で作られています
      </footer>
    </div>
  );
}
