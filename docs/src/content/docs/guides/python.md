---
title: コマンド履歴と Python スクリプト
sidebar:
  order: 10
---

## 履歴を再利用する

コマンドウィンドウでは **↑ / ↓** で入力の先頭に一致する履歴を呼び出し、**Ctrl+R** で検索します。画面操作の一部は対応する Python コードとして履歴に表示されます。再実行すると再びデータが変更される操作もあるため、対象 Wave やウィンドウ名を確認してください。

## Procedure に保存する

**Windows → New Procedure** でエディタを開き、Python を入力して **Run** を押します。**Shift+Enter** では選択範囲または現在行、**Ctrl+Enter**（macOS では **⌘+Enter**）ではファイル全体を実行できます。Procedure は Experiment に保存されます。Python から作成する場合は `op.new_procedure(name, code)` を使います。

コマンド入力には `np` と `op` が初期設定されています。Procedure に `import numpy as np` と `import oresme as op` を書いておくと依存が明確です。SciPy、pandas、scikit-learn、lmfit は利用時に読み込まれます。長い処理を止めるには **Python → Interrupt** を使います。Python を再起動するとセッション変数は消えますが、Experiment の Wave はアプリ側に残ります。

[Python API の使い方](../../reference/) · [Procedure](../../reference/api/global/#procedure)
