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
import BrandMark from "./components/BrandMark";
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
      <SubPageShell title="保存スロット再生" backHref={studioHref(["player", "slot"])} width="max-w-3xl">
        <SavedPlayer />
      </SubPageShell>
    );
  }

  if (libraryRoute) {
    return (
      <SubPageShell title="保存ライブラリ" backHref={studioHref(["library"])} width="max-w-4xl">
        <LibraryPage />
      </SubPageShell>
    );
  }

  const tabs: { id: MainTool; label: string; short: string }[] = [
    { id: "studio", label: "スタジオ", short: "スタジオ" },
    { id: "chordQuiz", label: "コード進行クイズ", short: "クイズ" },
  ];

  return (
    <div className="min-h-screen text-ink-800">
      <header className="sticky top-0 z-30 border-b border-white/[0.06] bg-page/70 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3 sm:gap-5">
          <div className="flex min-w-0 items-center gap-3">
            <BrandMark size={36} />
            <div className="min-w-0 leading-tight">
              <h1 className="whitespace-nowrap font-display text-lg font-bold tracking-tight text-white sm:text-xl">
                Melody Catch
              </h1>
              <p className="hidden truncate text-[11px] text-ink-500 sm:block">
                AI 作曲 &amp; コード進行スタジオ
              </p>
            </div>
          </div>

          <nav
            aria-label="アプリ切り替え"
            className="ml-auto flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] p-1"
          >
            {tabs.map((t) => {
              const active = activeTool === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setActiveTool(t.id)}
                  aria-pressed={active}
                  className={`min-h-9 whitespace-nowrap rounded-full px-3 text-xs font-semibold transition sm:px-4 sm:text-sm ${
                    active
                      ? "bg-white text-page shadow-[0_4px_16px_-4px_rgba(255,255,255,0.35)]"
                      : "text-ink-600 hover:bg-white/[0.06] hover:text-white"
                  }`}
                >
                  <span className="sm:hidden">{t.short}</span>
                  <span className="hidden sm:inline">{t.label}</span>
                </button>
              );
            })}
          </nav>

          <div
            className="hidden items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 md:flex"
            title="現在のキー"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.9)]" />
            <span className="text-[11px] font-medium uppercase tracking-wider text-ink-500">Key</span>
            <span className="text-sm font-semibold text-white">{scaleName}</span>
          </div>
        </div>
      </header>

      <main
        className={`mx-auto px-4 pb-6 pt-6 sm:pt-8 ${
          activeTool === "studio" ? "max-w-6xl" : "max-w-[1400px]"
        }`}
      >
        {activeTool === "studio" ? (
          <Studio scale={scale} onScaleChange={setScale} />
        ) : (
          <section className="mc-card overflow-hidden p-0">
            <iframe
              title="コード進行マスタークイズ"
              src={CHORD_QUIZ_URL}
              className="block h-[calc(100vh-150px)] min-h-[760px] w-full border-0 bg-white"
            />
          </section>
        )}
      </main>

      <footer className="mx-auto flex max-w-6xl flex-col items-center gap-2 px-4 pb-12 pt-6 text-center">
        <div className="flex items-center gap-2 text-ink-500">
          <BrandMark size={18} />
          <span className="font-display text-sm font-semibold text-ink-600">Melody Catch</span>
        </div>
        <p className="text-[11px] text-ink-400">Tone.js + React で動くブラウザ作曲スタジオ</p>
      </footer>
    </div>
  );
}

/** 現在の URL から指定パラメータを外した Studio への URL。 */
function studioHref(dropParams: string[]): string {
  if (typeof window === "undefined") return "/";
  const u = new URL(window.location.href);
  for (const p of dropParams) u.searchParams.delete(p);
  return u.toString();
}

/** 保存ライブラリ / 再生モード用の簡易シェル。 */
function SubPageShell({
  title,
  backHref,
  width,
  children,
}: {
  title: string;
  backHref: string;
  width: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen text-ink-800">
      <header className="sticky top-0 z-30 border-b border-white/[0.06] bg-page/70 backdrop-blur-xl">
        <div className={`mx-auto flex ${width} items-center justify-between gap-3 px-4 py-3`}>
          <div className="flex min-w-0 items-center gap-3">
            <BrandMark size={30} />
            <h1 className="truncate font-display text-base font-bold tracking-tight text-white">
              Melody Catch <span className="font-sans font-medium text-ink-500">/ {title}</span>
            </h1>
          </div>
          <a
            href={backHref}
            className="shrink-0 rounded-full border border-white/10 bg-white/[0.05] px-3.5 py-1.5 text-xs font-semibold text-ink-700 transition hover:bg-white/10 hover:text-white"
          >
            ← スタジオを開く
          </a>
        </div>
      </header>
      <main>{children}</main>
    </div>
  );
}
