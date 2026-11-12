---
title: 軸、凡例、注釈、カーソル
sidebar:
  order: 3
---

## 軸と注釈

軸は `g.axis("left")` のように名前で取得します。`range` で範囲を固定し、`autoscale()` で自動スケールに戻せます。別単位の系列を追加する場合は、新しい軸を作り、トレースの追加時に軸名を渡します。

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

A・B を同じトレースに置くと、その間の点を [フィット範囲](../curve-fitting/) に使えます。[Axis API](../../reference/api/axis/) · [Cursor API](../../reference/api/cursor/)
