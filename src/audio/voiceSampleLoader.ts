/**
 * gleitz/midi-js-soundfonts の `<instrument>-mp3.js` 形式をパースして
 * `{ "A4": "data:audio/mp3;base64,..." }` の辞書を返すローダー。
 *
 * ファイル形式 (抜粋):
 *   if (typeof(MIDI) === 'undefined') var MIDI = {};
 *   if (typeof(MIDI.Soundfont) === 'undefined') MIDI.Soundfont = {};
 *   MIDI.Soundfont.choir_aahs = {
 *   "A0": "data:audio/mp3;base64,...",
 *   "A1": "...",
 *   ...
 *   };
 *
 * eval は使わず、対応 `{}` を手で走査して中身の JSON 互換オブジェクトだけ
 * 取り出して JSON.parse する。末尾カンマだけ除去する。
 */

export async function loadGleitzSoundfont(
  url: string,
  name: string,
): Promise<Record<string, string>> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`fetch ${url} failed: ${res.status}`);
  }
  const text = await res.text();
  const marker = `Soundfont.${name}`;
  const tagIdx = text.indexOf(marker);
  if (tagIdx < 0) {
    throw new Error(`marker not found: ${marker}`);
  }
  const start = text.indexOf("{", tagIdx);
  if (start < 0) {
    throw new Error("opening brace not found");
  }
  let depth = 0;
  let end = -1;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (c === "\\") {
        escape = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
    } else if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) {
    throw new Error("unterminated object literal");
  }
  let body = text.slice(start, end + 1);
  // 末尾カンマ ( "...": "...", } ) を除去して JSON 互換にする。
  body = body.replace(/,(\s*})/g, "$1");
  return JSON.parse(body) as Record<string, string>;
}
