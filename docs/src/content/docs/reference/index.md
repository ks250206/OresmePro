---
title: Python API の使い方
description: OresmePro の公開 Python API を分類ごとに調べる。
---

コマンドウィンドウまたは Procedure で `import oresme as op` を使います。Python カーネルはアプリ内で実行され、Wave やグラフへの操作は JavaScript ブリッジを通じて Experiment に反映されます。

| 目的                                            | リファレンス                            | 使用例                                                             |
| ----------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------ |
| 配列を作り、値やスケーリングを操作する          | [Wave](./api/wave/)                     | [最初の Wave](../getting-started/)                                 |
| グラフを作り、トレースやスタイルを追加する      | [Graph](./api/graph/)                   | [グラフ編集](../guides/graphs/)                                    |
| 描画方式・色・誤差棒を調整する                  | [Trace](./api/trace/)                   | [重ね描き](../examples/overlay/)                                   |
| 表示範囲、目盛り、ラベルを変更する              | [Axis](./api/axis/)                     | [複数軸](../examples/multiple-axes/)                               |
| 数値格子を描画する                              | [Image / Contour](./api/image-contour/) | [2D画像と等高線](../examples/image-contour/)                       |
| トレース上の点を調べる                          | [Cursor](./api/cursor/)                 | [カーソル](../guides/axes-and-annotations/#カーソルで点を確認する) |
| Wave を列に並べる                               | [Table](./api/table/)                   | [テーブル操作](../guides/tables/)                                  |
| Wave を階層化する                               | [Folder](./api/folder/)                 | [フォルダに整理する](../guides/waves/#フォルダに整理する)          |
| フィット、統計、変換を行う                      | [Analysis](./api/analysis/)             | [FFT](../examples/fft/)                                            |
| ファイル、Procedure、レイアウト、時刻表示を扱う | [Global Functions](./api/global/)       | [CSV の読み込み](../getting-started/import-csv/)                   |

## シグネチャとエラー

シグネチャと英語の docstring は公開モジュールのソースから生成されます。`*` に続く引数には名前を付けます。グラフやテーブルなどのオブジェクトは作成関数（`op.display`、`op.edit`）や検索関数（`op.graph`、`op.table`）から取得します。

名前が存在しないなどアプリ側で操作が拒否される場合は `op.OresmeError` が発生します。NumPy などの処理からは Python の例外も伝播します。各項目の「明示的な例外」はソース中の `raise` から取得したものです。
