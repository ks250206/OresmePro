---
title: インポートとエクスポート
sidebar:
  order: 8
---

## 入力ファイルとプレビュー

| 入力                                               | メニュー                         | Python          |
| -------------------------------------------------- | -------------------------------- | --------------- |
| CSV、TSV、空白区切り                               | **File → Load Delimited Text…**  | `op.load_text`  |
| Excel（.xlsx、.xlsm）                              | **File → Load Excel Workbook…**  | `op.load_excel` |
| Igor Wave（.ibw）・Packed Experiment（.pxp、.pxt） | **File → Load Igor Files…**      | `op.load_igor`  |
| Python で直接読む任意のファイル                    | **File → Add Files for Python…** | `open`          |

CSV や Excel ではプレビューで文字コード、列見出し、単位、列型を確認します。数値型に指定した列で変換できないセルは NaN になります。列が意図せず文字列として検出された場合は、プレビューで列型を指定します。定型データの設定はインポートのプリセットに保存できます。Igor の Packed Experiment からは Wave とデータフォルダを取り込みます。

## 出力形式を選ぶ

- 図を配布する場合は **File → Save Graph as PDF / SVG / PNG**、または `g.save("graph.svg")` を使います。
- 列データだけを取り出すにはテーブルからコピーするか、`table.to_dataframe().to_csv("export.csv", index=False)` を実行します。Python が作ったファイルは Data Browser の **Files** からダウンロードできます。
- データ、グラフ、スクリプトを一緒に移すには [Experiment を保存](../experiments/) します。

[CSV 入門](../../getting-started/import-csv/) · [読み込み関数](../../reference/api/global/#load_text)
