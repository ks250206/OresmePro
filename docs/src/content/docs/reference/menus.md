---
title: メニュー
description: メニューバーの全項目と、それぞれが何をするか、対応する Python。
sidebar:
  order: 1
---

メニューバーの項目を、メニューごとに並べます。画面の操作は、ほとんどが対応する Python の行としてコマンドウィンドウの履歴に残ります(下の表の「Python」列)。デスクトップ(ウィンドウのない所)を右クリックしても、同じメニューがサブメニューとして出ます。ダイアログ右下の **?** は、そのダイアログの説明ページ(英語版)を開きます。

## File

| 項目                          | すること                                                      | Python / 備考       |
| ----------------------------- | ------------------------------------------------------------- | ------------------- |
| New Experiment                | 新しい実験を始める。開いていた実験はブラウザに残る            |                     |
| Experiments…                  | ブラウザに保存された実験の一覧。開く・名前変更・削除          |                     |
| Open Experiment…              | `.oresme` ファイルを開く(ドロップでも可)                      |                     |
| Save Experiment As…           | ファイル名を入れて `.oresme` として保存(**Ctrl+S** / **⌘S**)  |                     |
| Go Back to Opening State…     | この実験を開いた時点の状態に戻す                              |                     |
| Add Files for Python…         | 任意のファイルを実験に入れ、Python から名前で開けるようにする | `open("name.txt")`  |
| Save Graph as PDF / SVG / PNG | 最前面のグラフを書き出す                                      | `g.save("fig.pdf")` |

## Edit

| 項目 | すること                                                                        |
| ---- | ------------------------------------------------------------------------------- |
| Undo | 直前の操作を取り消す(**Ctrl+Z** / **⌘Z**)。エディタ内ではその文字入力を取り消す |
| Redo | やり直す(**Ctrl+Y** / **⇧⌘Z**)                                                  |

## Data

| 項目                        | すること                                                     | Python / 備考                                |
| --------------------------- | ------------------------------------------------------------ | -------------------------------------------- |
| Make Waves…                 | 新しい wave を作る(点数・型・初期値・スケーリング)           | `op.make("w", n=100)`                        |
| Set Wave Values…            | 式や値で wave の中身を設定する                               | `w.data = ...`                               |
| Recalculate Formulas        | 自動でない数式を計算し直す                                   | `op.recalculate()`                           |
| Load Delimited Text…        | CSV・TSV・空白区切りを、プレビューを見て読み込む             | `op.load_text("data.csv")`                   |
| Load Excel Workbook…        | `.xlsx` / `.xlsm` を読み込む                                 | `op.load_excel("book.xlsx")`                 |
| Load Igor Files…            | `.ibw`・`.pxp`・`.pxt` を読み込む                            | `op.load_igor("run.pxp")`                    |
| Load Parquet or HDF5 Files… | Parquet・HDF5 を読み込む                                     | `op.load_parquet(...)` / `op.load_hdf5(...)` |
| New Data Folder…            | データフォルダを作る                                         | `op.new_folder("run1")`                      |
| Sample Attributes…          | 試料(データフォルダ・wave)の属性を表で入力する               | `op.set_attributes("run1:", thickness=12)`   |
| Time Zone for Dates…        | 日付を表示・入力するタイムゾーン                             | `op.set_time_zone("Asia/Tokyo")`             |
| Change Wave Scaling…        | 選んだ wave の X(と Y)の開始値・刻み・単位                   | `w.set_scale(x0, dx, "s")`                   |
| Change Wave Type…           | 数値の型を変える(float32、int16、complex128 など)            | `w.redimension("float32")`                   |
| Rename or Move Wave…        | 名前を変える。`folder:name` でフォルダへ移す                 | `w.rename("new")`                            |
| Kill Selected Waves         | 選んだ wave を削除する(グラフ・テーブルで使用中のものは不可) | `op.kill(w)`                                 |

## Analysis

| 項目                                                                                   | すること                                                                                                                                                                                        | Python                                       |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Curve Fitting…                                                                         | 関数をフィットする(hold・bounds・範囲・重み・残差・信頼帯)                                                                                                                                      | `op.fit("gauss", y)`                         |
| Multi-peak Fit…                                                                        | 複数ピークを一度にフィットする                                                                                                                                                                  | `op.fit_peaks(y)`                            |
| Results…                                                                               | 実験に残ったフィット結果の比較・再実行・テンプレート化・プロット                                                                                                                                | `op.results()`、`op.plot_results(...)`       |
| Templates…                                                                             | 解析テンプレートの作成・編集と、多数の試料への実行                                                                                                                                              | `op.template("Peak").run([...])`             |
| Background…                                                                            | Shirley・Tougaard・直線の背景                                                                                                                                                                   | `op.background(y, "shirley")`                |
| (プラグインのモデル編集ウィンドウ)                                                     | 入れたプラグインの編集ウィンドウと view(xps プラグインの XPS Peak Fitting… と XPS Quantification…、electrochem の EIS Circuit Fitting… など)。メニューの最後に並ぶ([ガイド](../../guides/xps/)) | `op.invoke("plugin.…", {...}, replace=True)` |
| Onset…                                                                                 | 立ち上がりの開始点(接線とベースラインの交点)                                                                                                                                                    | `op.onset(y, edge=(...))`                    |
| Wave Stats… / Differentiate… / Integrate… / Smooth… / FFT… / Histogram… / Interpolate… | 統計量と、微分・積分・平滑化・FFT・ヒストグラム・補間                                                                                                                                           | `op.stats`、`op.differentiate` など          |
| Filter Image…                                                                          | 2 次元 wave にフィルタをかける                                                                                                                                                                  | `op.filter_image(img, ...)`                  |

## Graph

最前面のグラフに対して働きます。

| 項目                                             | すること                                                                         | Python                                     |
| ------------------------------------------------ | -------------------------------------------------------------------------------- | ------------------------------------------ |
| Append Traces… / Append Image… / Append Contour… | トレース・画像・等高線を追加する                                                 | `g.append(y)`、`g.append_image(m)`         |
| Add Axis…                                        | 自由軸を追加する                                                                 | `g.add_axis("right2", "right")`            |
| Modify Trace Appearance…                         | 線・マーカー・文字マーカー・色・誤差棒・塗り                                     | `g.trace().set(color="red")`               |
| Modify Axis…                                     | 範囲・対数・目盛り・ラベル・表示するラベル(on/axis only/off)・ラベルの向き・軸線 | `g.axis("left").set(log=True)`             |
| Modify Graph…                                    | フォント・プロット領域の大きさ・余白・表示倍率                                   | `g.set(width=op.cm(8))`                    |
| Autoscale Axes                                   | 全軸を自動範囲に戻す(**Ctrl+A** / **⌘A**)                                        | `g.axis("left").autoscale()`               |
| Show Tools                                       | 図形を描くツールのパレットを出し入れする(**⌥T** / **Alt+T**)                     | `g.draw("arrow", [...])`                   |
| Show Cursor Info                                 | カーソル情報の欄を出し入れする(**Ctrl+I** / **⌘I**)                              | `g.show_info = True`                       |
| Add Legend / Add Text… / Add Color Scale         | 凡例・テキスト・カラースケールを置く                                             | `g.legend()`、`g.textbox("...")`           |
| Styles…                                          | グラフスタイルの保存・適用・既定の設定                                           | `op.set_style(...)`、`op.apply_style(...)` |
| Save as Template… / Make Graphs from Template…   | グラフテンプレートを保存し、別のデータでグラフを作る                             | `op.graph_template("T").make(...)`         |
| Recreation Script…                               | このグラフを作り直す Python を表示する                                           | `g.script()`                               |
| Link Graphs…                                     | 複数グラフの軸とカーソルを連動させる                                             | `op.link_graphs(g1, g2)`                   |

## Table

最前面のテーブルに対して働きます。**New Table…**、**Append Columns to Table…**(wave を列として足す)、**Remove Columns from Table…**(列を外す。wave は残る)があります。Python では `t.append(...)`、`t.remove(...)` です。

## Layout

最前面のページレイアウトに対して働きます。グラフ・テキストの追加、選択した項目の整列(左右上下・中央)、等間隔配置、同じ幅・高さ・大きさへの統一、**Arrange in Grid…**(格子状の配置)、**Select All** があります。Python では `op.new_layout()` と `Layout` のメソッドを使います。

## Windows

| 項目                                                          | すること                                                             | Python                                        |
| ------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------- |
| New Graph… / New Image Plot… / New Contour Plot… / New Table… | ウィンドウを作る(名前を指定できる)                                   | `op.display(y)`、`op.edit(y)`                 |
| New Procedure…                                                | Procedure(実験に保存される Python ファイル)を作る                    | `op.new_procedure("tools")`                   |
| New Note                                                      | Markdown で書くノートを作る                                          | `op.new_note()`                               |
| New Page Layout / New Panel                                   | ページレイアウト・パネルを作る                                       | `op.new_layout()`、`op.new_panel()`           |
| Import Procedure… / Import Panel…                             | `.py` / パネルの JSON を取り込む。取り込んだコードは実行しない       |                                               |
| Import Markdown as Note…                                      | `.md` ファイルをノートとして取り込む                                 |                                               |
| Rename Window…                                                | 最前面のウィンドウの名前を変える(タイトルバーのダブルクリックでも)   | `op.rename_window("G0", "Spectrum")`          |
| Close Window…                                                 | 閉じる(中身は残る)か Kill するかを選ぶ                               | `op.close_window(...)`、`op.kill_window(...)` |
| Data Browser / Command Window                                 | パネルの表示・非表示                                                 |                                               |
| Graphs / Tables / Procedures / Layouts / Panels / Notes       | 種類ごとのウィンドウ一覧。閉じたものは「(closed)」で、選ぶと開き直す | `op.reopen_window(...)`                       |

## Python

| 項目                                   | すること                                                                         | Python / 備考       |
| -------------------------------------- | -------------------------------------------------------------------------------- | ------------------- |
| Interrupt                              | 実行中の Python とプラグインを止める(**Ctrl+C**)。もう一度押すと Python を再起動 |                     |
| Restart Python                         | Python を再起動する。wave・グラフ・テーブルは残る                                |                     |
| Variables                              | Python の変数の一覧。選んで消せる(`del`)                                         |                     |
| Procedure Browser                      | Procedure と、その中のクラス・関数の一覧。クリックで定義の行へ                   |                     |
| Packages…                              | この実験のパッケージ、Python の中のパッケージ一覧、導入と削除                    | `%pip install name` |
| Plugins…                               | プラグインの導入・管理・実行                                                     |                     |
| Plugin Actions                         | 有効なプラグインの Action のフォームを、動かせるウィンドウで開く                 |                     |
| Keep Optional Packages for Offline Use | 同梱パッケージ(SciPy など)を先にブラウザへ保存し、オフラインで使えるようにする   |                     |

## Help

**Documentation**(このドキュメント)、**Python API Reference**、**Put an Example in the Command Line**(例をコマンド入力に入れる)、**OresmePro on GitHub**、**Report a Problem…**(GitHub の issue を開く)、**About OresmePro** があります。メニューバー右端の GitHub のアイコンもリポジトリを開きます。

## ウィンドウの右クリック

| 場所             | 主な項目                                                                                                                                                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| グラフ           | Modify Trace / Axis / Graph、Rename Graph…、Link Graphs…、Apply Style、カーソルの設置、範囲の拡大・縮小                                                                                                                 |
| テーブル         | Display、Set Wave Values…、Change Wave Scaling…、Rename or Move…、行の挿入・削除、Append / Remove Columns…、Rename Table…                                                                                               |
| Procedure        | 編集・整形・検索、Run Procedure、Run Selection、Run When the Experiment Opens、Rename Procedure…、Export as name.py、Import Procedure…                                                                                  |
| Note             | Rename Note…、Export as name.md、Import Markdown…                                                                                                                                                                       |
| ページレイアウト | Layout メニューと同じ項目、項目の編集・削除                                                                                                                                                                             |
| Data Browser     | wave: Display・Edit・Append to Table・Copy Full Path・Attributes…・Change Wave Scaling…・Rename or Move…・Duplicate…・Kill。フォルダ: Make Waves…・New Data Folder…・Copy Full Path・Attributes…・Rename or Move…・Kill |
