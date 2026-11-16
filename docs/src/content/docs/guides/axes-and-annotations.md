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

軸ラベルの向きは軸の側で決まります。左軸は下から上へ、右軸は上から下へ読む向き(文字の上が軸の外側)、上下の軸は横書きです。**Modify Axis** の **turned … °** で、そこから時計回りに回せます(Igor Pro の ModifyGraph `lblRot` に当たります)。右軸を左軸と同じ下から上の向きにするなら 180 です。範囲は −360〜360 度で、回した分だけ自動の余白が広がります。

```python
g.axis("right").label_rotation = 180
```

**Modify Axis** の **Draw the axis line** を外すと、軸線そのものを描きません(Igor Pro の `axThick=0` に当たります)。目盛りを none、Show labels を off にもすると、その軸は何も描かれません。3元相図のように、トレースで描いた図を、表示しない軸の座標に置くときに使います。

```python
g.axis("left").set(line=False, ticks="none", labels="off")
```

## 文字マーカー

**Modify Trace Appearance** の **Text markers** で wave を選ぶと、マーカーの代わりに、その wave の値を各点に文字で描きます(Igor Pro の textMarker に当たります)。データ座標の位置に置くラベルとして使えます。テキスト wave ならその文字を、数値の wave なら数値を書きます。モードは markers か lines+markers にします。

- **Text anchor** で、ラベルのどの点をデータ点に合わせるかを選びます。`MC` は中央、`RC` は点の左、`MT` は点の下に置きます
- Python では文字の大きさ(`text_size`)と回転(`text_rotation`、時計回りの度)も指定できます
- 色はトレースの色です。`color_wave` で点ごとに色を変えることもできます

```python
names = op.make("names", ["P1", "P2", "P3"])
g.trace("peaks").set(mode="markers", text_marker=names, text_anchor="LB", text_size=10)
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
