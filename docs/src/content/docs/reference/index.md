---
title: Python API の使い方
description: OresmePro の公開 Python API を分類ごとに調べる。
---

コマンドウィンドウまたは Procedure で `import oresme as op` を使います。よく使うコードは [Python 早見表](./python-cheatsheet/)、画面の操作は [メニュー](./menus/) と [マウスとキー](./mouse-and-keys/)、言葉の意味は [用語集](./glossary/)、うまくいかないときは [困ったとき](./troubleshooting/) を見てください。Python カーネルはアプリ内で実行され、Wave やグラフへの操作は JavaScript ブリッジを通じて Experiment に反映されます。

| 目的                                       | リファレンス                                  | 使用例                                                              |
| ------------------------------------------ | --------------------------------------------- | ------------------------------------------------------------------- |
| 配列を作り、値やスケーリングを操作する     | [Wave](./api/wave/)                           | [最初の Wave](../getting-started/)                                  |
| グラフを作り、トレースやスタイルを追加する | [グラフ](./api/graph/)                        | [グラフ編集](../guides/graphs/)                                     |
| 描画方式・色・誤差棒を調整する             | [トレース](./api/trace/)                      | [重ね描き](../examples/overlay/)                                    |
| 表示範囲、目盛り、ラベルを変更する         | [軸](./api/axis/)                             | [複数軸](../examples/multiple-axes/)                                |
| 数値格子を描画する                         | [画像と等高線](./api/image-contour/)          | [2D画像と等高線](../examples/image-contour/)                        |
| トレース上の点を調べる                     | [カーソル](./api/cursor/)                     | [カーソル](../guides/axes-and-annotations/#カーソルで点を確認する)  |
| Wave を列に並べる                          | [テーブル](./api/table/)                      | [テーブル操作](../guides/tables/)                                   |
| Wave を階層化する                          | [データフォルダと属性](./api/folder/)         | [フォルダに整理する](../guides/waves/#フォルダに整理する)           |
| フィット、統計、変換を行う                 | [解析](./api/analysis/)                       | [FFT](../examples/fft/)                                             |
| 解析を名前と型の決まった引数で呼ぶ         | [Actions](./api/actions/)                     | [解析を名前で呼ぶ](../guides/python/#解析を名前で呼ぶ)              |
| 解析の手順を多くの試料に適用する           | [解析テンプレート](./api/templates/)          | [一括実行](../guides/curve-fitting/#同じ手順を多くの試料に適用する) |
| ボタンと入力欄で解析を動かすパネルを作る   | [パネル](./api/panel/)                        | [パネル](../guides/panels/)                                         |
| ファイルを読み込む                         | [ファイルの読み込み](./api/files/)            | [CSV の読み込み](../getting-started/import-csv/)                    |
| グラフのスタイルとテンプレートを使う       | [スタイルとグラフテンプレート](./api/styles/) | [グラフテンプレート](../guides/graphs/#グラフテンプレート)          |
| グラフや文字をページに並べる               | [ページレイアウト](./api/layout/)             | [Layout メニュー](./menus/#layout)                                  |
| ウィンドウの名前を変える・閉じる・開き直す | [ウィンドウ](./api/windows/)                  | [メニュー](./menus/#windows)                                        |
| 実験に保存する Python ファイルを扱う       | [Procedure](./api/procedure/)                 | [Procedure](../guides/python/)                                      |
| パッケージを入れる・一覧する               | [パッケージ](./api/packages/)                 | [パッケージを追加する](../guides/python/#パッケージを追加する)      |
| エラー、まとめて変更、時刻表示             | [全般](./api/global/)                         | [Python](../guides/python/)                                         |

## シグネチャとエラー

シグネチャと説明は公開モジュールのソース(docstring)から生成されます。説明の日本語訳は `docs/scripts/api-ja.json` にあり、docstring が変わると翻訳の更新を求めます。`*` に続く引数には名前を付けます。グラフやテーブルなどのオブジェクトは作成関数（`op.display`、`op.edit`）や検索関数（`op.graph`、`op.table`）から取得します。

名前が存在しないなどアプリ側で操作が拒否される場合は `op.OresmeError` が発生します。NumPy などの処理からは Python の例外も伝播します。各項目の「明示的な例外」はソース中の `raise` から取得したものです。
