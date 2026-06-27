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
import SavedPlayer from "./components/SavedPlayer";
import LibraryPage from "./components/LibraryPage";
import { C_MAJOR, scaleDisplayName, type Scale } from "./music/scale";

type MainTool = "studio" | "chordQuiz";

const CHORD_QUIZ_URL = "https://reo-ai.github.io/-/?v=b260d6b";

/** URL ?player=1 が付いていれば別タブ再生モード。 */
function isPlayerRoute(): boolean {
  if (typeof window === "undefined") return false;
  const url = new URL(window.location.href);
  return url.searchParams.get("player") === "1";
}

/** URL ?library=1 が付いていれば保存ライブラリモード。 */
function isLibraryRoute(): boolean {
  if (typeof window === "undefined") return false;
  const url = new URL(window.location.href);
  return url.searchParams.get("library") === "1";
}

export default function App() {
  const [scale, setScale] = useState<Scale>(C_MAJOR);
  const [activeTool, setActiveTool] = useState<MainTool>("studio");
  const playerRoute = useMemo(() => isPlayerRoute(), []);
  const libraryRoute = useMemo(() => isLibraryRoute(), []);

  const scaleName = useMemo(() => scaleDisplayName(scale, "ja"), [scale]);

  if (playerRoute) {
    return (
      <div className="min-h-screen bg-ink-50 text-ink-900">
        <header className="border-b border-ink-200 bg-gradient-to-r from-violet-950 via-fuchsia-900 to-violet-950 text-white shadow-md">
          <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
            <h1 className="text-lg font-extrabold tracking-tight">
              Melody Catch · 保存スロット再生
            </h1>
            <a
              href={(() => {
                if (typeof window === "undefined") return "/";
                const u = new URL(window.location.href);
                u.searchParams.delete("player");
                u.searchParams.delete("slot");
                return u.toString();
              })()}
              className="rounded-full bg-white/10 px-3 py-1 text-xs font-medium text-white hover:bg-white/20"
            >
              Studio を開く
            </a>
          </div>
        </header>
        <main>
          <SavedPlayer />
        </main>
      </div>
    );
  }

  if (libraryRoute) {
    return (
      <div className="min-h-screen bg-ink-50 text-ink-900">
        <header className="border-b border-ink-200 bg-gradient-to-r from-violet-950 via-fuchsia-900 to-violet-950 text-white shadow-md">
          <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-3">
            <h1 className="text-lg font-extrabold tracking-tight">
              Melody Catch · 保存ライブラリ
            </h1>
            <a
              href={(() => {
                if (typeof window === "undefined") return "/";
                const u = new URL(window.location.href);
                u.searchParams.delete("library");
                return u.toString();
              })()}
              className="rounded-full bg-white/10 px-3 py-1 text-xs font-medium text-white hover:bg-white/20"
            >
              Studio を開く
            </a>
          </div>
        </header>
        <main>
          <LibraryPage />
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-ink-50 text-ink-900">
      <header className="sticky top-0 z-10 border-b border-ink-200 bg-gradient-to-r from-violet-950 via-fuchsia-900 to-violet-950 text-white shadow-md backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-3">
          <div>
            <h1 className="flex flex-wrap items-center gap-x-3 gap-y-1 tracking-tight">
              <span
                className="bg-gradient-to-b from-yellow-200 via-amber-300 to-yellow-500 bg-clip-text text-2xl font-extrabold text-transparent sm:text-3xl"
                style={{
                  WebkitTextStroke: "1px rgba(91, 33, 182, 0.85)",
                  filter:
                    "drop-shadow(0 1px 0 rgba(255, 215, 0, 0.35)) drop-shadow(0 2px 6px rgba(0,0,0,0.45))",
                }}
              >
                Melody Catch
              </span>
              <span className="inline-block rounded-full bg-gradient-to-r from-fuchsia-600 via-pink-500 to-fuchsia-600 px-3 py-0.5 text-[10px] font-bold uppercase tracking-wider text-yellow-100 shadow-[0_2px_6px_rgba(0,0,0,0.45),inset_0_0_0_1px_rgba(253,224,71,0.5)] sm:text-xs">
                ピアノ作曲・コード進行アシスタント
              </span>
            </h1>
            <p className="mt-0.5 text-xs text-violet-200 sm:text-sm">
              現在のキー: <span className="font-medium text-yellow-200">{scaleName}</span>
            </p>
          </div>
          <nav
            aria-label="アプリ切り替え"
            className="grid grid-cols-2 gap-2 rounded-2xl border border-white/15 bg-white/10 p-1 shadow-inner sm:flex sm:w-fit"
          >
            <button
              type="button"
              onClick={() => setActiveTool("studio")}
              className={`min-h-11 rounded-xl px-4 text-sm font-bold transition ${
                activeTool === "studio"
                  ? "bg-white text-violet-950 shadow"
                  : "text-violet-100 hover:bg-white/10"
              }`}
            >
              Melody Catch
            </button>
            <button
              type="button"
              onClick={() => setActiveTool("chordQuiz")}
              className={`min-h-11 rounded-xl px-4 text-sm font-bold transition ${
                activeTool === "chordQuiz"
                  ? "bg-white text-violet-950 shadow"
                  : "text-violet-100 hover:bg-white/10"
              }`}
            >
              コード進行クイズ
            </button>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6">
        {activeTool === "studio" ? (
          <Studio scale={scale} onScaleChange={setScale} />
        ) : (
          <section className="overflow-hidden rounded-3xl border border-ink-200 bg-white shadow-xl">
            <div className="flex flex-col gap-2 border-b border-ink-200 bg-ink-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-lg font-extrabold text-ink-900">
                  コード進行マスタークイズ
                </h2>
                <p className="text-sm text-ink-500">
                  単体版も残したまま、Melody Catch内のタブとして表示しています。
                </p>
              </div>
              <a
                href={CHORD_QUIZ_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-10 items-center justify-center rounded-full bg-violet-700 px-4 text-sm font-bold text-white shadow hover:bg-violet-800"
              >
                単体版を開く
              </a>
            </div>
            <iframe
              title="コード進行マスタークイズ"
              src={CHORD_QUIZ_URL}
              className="block h-[calc(100vh-210px)] min-h-[720px] w-full border-0 bg-white"
            />
          </section>
        )}
      </main>

      <footer className="mx-auto max-w-6xl px-4 pb-10 pt-4 text-center text-xs text-ink-400">
        Melody Catch Web — Tone.js + React で作られています
      </footer>
    </div>
  );
}
