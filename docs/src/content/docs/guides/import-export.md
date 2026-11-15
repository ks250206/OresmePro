---
title: インポートとエクスポート
sidebar:
  order: 8
---

## 入力ファイルとプレビュー

| 入力                                               | メニュー                               | Python            |
| -------------------------------------------------- | -------------------------------------- | ----------------- |
| CSV、TSV、空白区切り                               | **File → Load Delimited Text…**        | `op.load_text`    |
| Excel（.xlsx、.xlsm）                              | **File → Load Excel Workbook…**        | `op.load_excel`   |
| Igor Wave（.ibw）・Packed Experiment（.pxp、.pxt） | **File → Load Igor Files…**            | `op.load_igor`    |
| Parquet（.parquet）                                | **File → Load Parquet or HDF5 Files…** | `op.load_parquet` |
| HDF5（.h5、.hdf5）                                 | **File → Load Parquet or HDF5 Files…** | `op.load_hdf5`    |
| Python で直接読む任意のファイル                    | **File → Add Files for Python…**       | `open`            |

CSV や Excel ではプレビューで文字コード、列見出し、単位、列型を確認します。数値型に指定した列で変換できないセルは NaN になります。列が意図せず文字列として検出された場合は、プレビューで列型を指定します。定型データの設定はインポートのプリセットに保存できます。Igor の Packed Experiment からは Wave とデータフォルダを取り込みます。

## Parquet と HDF5

Parquet と HDF5 は、Pyodide のパッケージ（pyarrow、h5py）を使って Python で読み込みます。パッケージは初めて読み込むときに取り込まれます。ドロップまたはメニューで選んだファイルは Experiment のファイルに入り、`op.load_parquet("run.parquet")` のような 1 行が実行されて履歴に残ります。読み込みは 1 回の Undo で取り消せます。

- Parquet は列ごとに 1 つの Wave になり、テーブルが開きます。日時と日付は日付 Wave（単位 `dat`、UTC）、文字列とカテゴリはテキスト Wave、真偽値は `uint8` になります。null は NaN（テキストでは空文字列）になり、件数が Wave のノートに入ります。
- HDF5 はデータセットごとに 1 つの Wave になり、グループはデータフォルダになります。形（4 次元まで）と型を引き継ぎ、属性はノートに、文字列の属性 `units` は単位になります。
- 2⁵³ を超える 64 ビット整数は `float64` に丸められ、その数がノートに入ります。ノートには元のファイル名と SHA-256 も記録されます。

```python
op.load_parquet("run.parquet", columns=["t", "voltage"], table=False)
op.load_hdf5("scan.h5", datasets="/run1")
```

## 出力形式を選ぶ

- 図を配布する場合は **File → Save Graph as PDF / SVG / PNG**、または `g.save("graph.svg")` を使います。
- 列データだけを取り出すにはテーブルからコピーするか、`table.to_dataframe().to_csv("export.csv", index=False)` を実行します。Python が作ったファイルは Data Browser の **Files** からダウンロードできます。
- データ、グラフ、スクリプトを一緒に移すには [Experiment を保存](../experiments/) します。

[CSV 入門](../../getting-started/import-csv/) · [読み込み関数](../../reference/api/global/#load_text)
