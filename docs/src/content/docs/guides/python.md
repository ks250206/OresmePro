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

## 変更をまとめて反映する

`with op.atomic():` の中の変更は、ブロックが例外なく終わったときに 1 回の Undo 単位としてまとめて Experiment に入ります。途中で例外が起きると何も残りません。ブロックの中の Python には自分の変更が見えますが、画面にはブロックが終わるまで何も表示されません。

```python
with op.atomic():
    corrected = op.make("corrected", raw.data - background.data)
    op.display(corrected)
```

`op.fit`、`op.fit_peaks`、`op.background` など Wave と結果を作る解析は、それぞれこのブロックの中で動きます。ブロックの実行中に画面で行った変更は、ブロックの変更とぶつからなければ両方残ります。ブロックが読んだ Wave が途中で変わっていた場合は何も残さず `OresmeError` になります。ブロックの中ではグラフを描画・保存できません。

## 解析を名前で呼ぶ

解析は `core.fit` のような名前と引数の型を付けて **Action** として登録されています。パネルやプラグインは、Python のコードではなく名前と JSON の値を渡して呼びます。Python からは `op.invoke` で同じように呼べます。

```python
op.actions()                                                    # 登録された Action の一覧
r = op.invoke("core.fit", {"function": "gauss", "y": "signal"})  # op.fit("gauss", op.wave("signal")) と同じ
```

引数は呼ぶ前に検査され、知らない Action や版、余分な引数・足りない引数、型の違い、選択肢にない値、範囲外の数、存在しない Wave は、何もせずに `OresmeError` になります。通った呼び出しは `op.atomic()` の中で動きます。

Procedure の関数も `@op.action` で登録できます。`core.` は本体、`plugin.` はプラグイン用の名前なので、それ以外の小文字の点区切りの名前を使います。

```python
@op.action("lab.normalize", title="Normalize", params={
    "wave": {"type": "wave", "title": "Wave"},
    "to": {"type": "number", "default": 1.0, "min": 0},
})
def normalize(wave, to=1.0):
    return op.make(f"{wave.name}_norm", wave.data / np.nanmax(wave.data) * to)
```

引数の型は `wave`、`waves`、`number`、`integer`、`numbers`、`string`、`boolean`、`choice` です。数には `min` と `max`、リストには `length`、選択肢には `choices` を付けられます。`default` は関数の既定値と同じにします。省略した引数は関数に渡されません。

画面から呼んだ Action は、同じ意味の Python(`op.fit("gauss", op.wave("signal"))` など)として履歴に残ります。

[Python API の使い方](../../reference/) · [Procedure](../../reference/api/global/#procedure) · [atomic](../../reference/api/global/#atomic) · [Actions API](../../reference/api/actions/)
