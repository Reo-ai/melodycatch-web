# 生ドラムサンプル配置ガイド (CC0 / 無料)

このフォルダに WAV ファイルを配置すると、自動的にシンセドラムが置き換わり、
本物の生ドラム音で鳴ります。ファイルが無いものは従来通りのシンセで鳴り続けます。

## 配置するファイル名 (固定)

```
public/drums/
├── kick.wav
├── snare.wav
├── rim.wav            (リムショット / クロススティック)
├── hihat_closed.wav
├── hihat_open.wav
├── crash.wav
├── ride.wav
├── tom_lo.wav         (フロアタム)
├── tom_mid.wav
├── tom_hi.wav
└── clap.wav
```

各サンプルは「単発の "ワンショット"」を使ってください (ループ不要)。
ステレオでも問題ありませんが、モノラルのほうが軽量です。
8〜44.1kHz / 16bit WAV 推奨 (MP3 でも可。その場合は拡張子を `.mp3` に変えて、
`drumsAcoustic.ts` の `files` 配列の拡張子もそれに合わせてください)。

## 推奨ダウンロード先 (すべて無料 / 商用利用可)

### 1. Drumkit From Hell Lite (CC0 / 寄付ベース)
- 配布元: https://www.drumkitfromhell.com/free-drum-samples
- 中身: ロック向けキック・スネア・タム・シンバル一式
- ライセンス: Royalty Free (商用可)

### 2. Bedroom Producers Blog — Big Mono (無料)
- 配布元: https://bedroomproducersblog.com/free-samples/
- 検索: "Big Mono" "Drumdrops Free Kit"
- 中身: 単発 ワンショット (ロック / ポップ汎用)

### 3. SampleSwap — Free Drum Hits (CC0 大量アーカイブ)
- 配布元: https://sampleswap.org/filebrowser.php?d=DRUMS+%28SINGLE+HITS%29
- 単発の Kick / Snare / Tom / Cymbal が多数
- ライセンスはファイルごとに表示 (CC0 / Public Domain を選ぶ)

### 4. Freesound.org (CC0 / CC-BY フィルタ)
- 配布元: https://freesound.org/
- 検索バーで `kick drum cc0` / `snare drum cc0` 等を検索
- ダウンロード前にライセンスを確認 (CC0 が最も安全)

## ステップ・バイ・ステップ

1. 上記のどれかからドラムサンプル一式をダウンロード
2. お好みの音を選んで上記ファイル名にリネーム
3. `public/drums/` にコピー
4. アプリを再起動 (`npm run dev` を再起動 or ブラウザで強制リロード)
5. 「ロック構成」プリセットで自動作曲 → 本物の生ドラム音で再生される

## 動作確認

ブラウザの開発者ツール → コンソールでエラーが出ていなければ読み込み成功です。
404 が出たファイルだけシンセフォールバックで鳴ります。
