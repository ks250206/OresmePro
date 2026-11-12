---
title: Experiment の保存と読み込み
sidebar:
  order: 9
---

Experiment には Wave、フォルダ、グラフ、テーブル、Procedure、関連ファイル、解析結果が含まれます。

## ブラウザーで作業を再開する

**File → New Experiment** で新規作成し、**File → Experiments…** でブラウザーに保存された Experiment を開きます。保存状態はステータスバーで確認できます。同じ Experiment を複数タブで開いた場合は、1つのタブが保存を担当します。

自動保存はブラウザーの OPFS に依存します。ブラウザーのデータを消去すると失われる可能性があるため、持ち出すデータはファイルとして保存してください。

## ファイルとして保存・復元する

1. **File → Save Experiment As…** で `.oresme` ファイルをダウンロードします。
2. 復元するには **File → Open Experiment…** を使うか、そのファイルをアプリにドロップします。
3. 自動実行を指定した Procedure がある Experiment をファイルから開くと、実行を許可するか確認されます。コードを確認するまで実行を保留できます。

[保存の実装](../../architecture/#opfs-による保存)
