---
title: グラフの作成と編集
sidebar:
  order: 2
---

**Windows → New Graph…** で Y Wave を選びます。任意の X Wave を指定するか、各 Y Wave のスケーリングを横軸に使います。グラフを選択した状態で **Graph → Append Traces…** からトレースを追加できます。

## トレースを編集する

グラフのプロット領域を右クリックし、トレースや軸の設定を開きます。トレースの線色・マーカー・表示方式を変えても Wave の値は変わりません。X と Y の誤差棒には対応する点数の Wave を割り当てます。複素数 Wave は実部・虚部・絶対値・位相から表示成分を選べます。

```python
y = op.make("response", [0.1, 0.3, 0.7, 0.8])
g = op.display(y, name="Response")
g.trace().set(mode="lines+markers", color="#ab1831")
```

## 再利用と書き出し

保存したグラフスタイルは同じ Experiment の他のグラフにも適用できます。`g.script()` はグラフの作り方を Python コードで返します。元データが使える Experiment で実行してください。図として共有する場合は `g.save("response.svg")` や **File → Save Graph as PDF / SVG / PNG** を使います。

[Graph API](../../reference/api/graph/) · [Trace API](../../reference/api/trace/) · [重ね描き](../../examples/overlay/)
