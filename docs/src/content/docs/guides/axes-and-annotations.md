---
title: 軸、凡例、注釈、カーソル
sidebar:
  order: 3
---

## 軸と注釈

軸は `g.axis("left")` のように名前で取得します。`range` で範囲を固定し、`autoscale()` で自動スケールに戻せます。別単位の系列を追加する場合は、新しい軸を作り、トレースの追加時に軸名を渡します。

**Modify Axis** の **Show labels** で、軸に描くラベルを選べます(Igor Pro の ModifyGraph `noLabel` と同じ)。軸線と目盛りはどれでも残ります。

| 設定      | 描くもの                             |
| --------- | ------------------------------------ |
| on        | 目盛りラベルと軸ラベル(既定)         |
| axis only | 軸ラベルだけ(目盛りの数値を描かない) |
| off       | どちらも描かない                     |

ラベルを描かない分だけ余白が自動で狭くなります。積み重ねたグラフで内側の軸の数値を消すときなどに使います。

```python
g.axis("bottom").labels = "axis only"
g.axis("left").set(labels="off")
```

- `g.legend()` はトレースの凡例を追加します。`anchor="LT"` で左上を指定できます。
- `g.textbox("Run 1")` はグラフ上に固定したテキストを追加します。
- `g.tag(trace, point, "Y = {y}")` は指定点に追従するラベルを追加します。点番号は0始まりです。

## カーソルで点を確認する

トレースのコンテキストメニューから A または B を置き、カーソルを動かしてサンプル点を確認します。Python では `Graph.cursor` が配置と取得を行います。

```python
y = op.make("cursor_data", [1, 4, 9, 16], dx=0.5)
g = op.display(y)
a = g.cursor("A", g.trace(), 2)
print(a.point, a.x, a.y)
```

カーソルを置くと、グラフの下にカーソル情報の欄が出て、位置と A–B 間の差を表示します。グラフのコンテキストメニューの **Show Cursor Info**、`⌘I` / `Ctrl+I`、Python の `g.set(show_info=True)` でも出し入れできます。欄を出すとグラフ(図)の大きさはそのままでウィンドウが欄の高さだけ下へ伸び、隠すと縮みます(Igor の Info パネルと同じ)。そのため書き出す図の大きさは欄の有無で変わらず、Undo すると欄とウィンドウの高さが一緒に戻ります。以前の版で欄を出したまま保存した実験は、保存したときのウィンドウと図の大きさのまま開きます。

A・B を同じトレースに置くと、その間の点を [フィット範囲](../curve-fitting/) に使えます。[Axis API](../../reference/api/axis/) · [Cursor API](../../reference/api/cursor/)
