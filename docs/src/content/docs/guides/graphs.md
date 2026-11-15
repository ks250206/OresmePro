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

## グラフテンプレート

同じ構成の図を別の試料のデータで作るには、グラフをテンプレートとして保存します。グラフの右クリック › **Save as Template…** で保存すると、グラフが描いている Wave はスロット(`y`、`x`、誤差棒の `yerr` と `xerr`、色の `color`、画像と等高線の `z`)に置き換わり、トレース・軸・見た目・注釈・図の大きさが残ります。トレースが複数あるときは `y1`、`y2` のように番号が付きます。軸の範囲は、軸ごとに固定するか新しいデータに合わせるかを保存するときに選びます。

注釈と軸ラベルでは `{y.name}` と `{y.unit}` がスロットに入れた Wave の名前と単位になります。元のグラフの Wave の名前や、括弧の中の単位(`(A)`)が文字の中にあれば、保存するときにこの参照に置き換わるので、別の試料で作った図に古い試料名は残りません。

**Graph → Make Graphs from Template…** でテンプレートを選び、行ごとにスロットの Wave を選びます。1 行が 1 枚のグラフで、何枚作っても Undo 1 回で戻ります。Wave の単位がテンプレートを作ったときと違えば警告が出ます。テンプレートは Experiment に保存され、スタイルと同じくブラウザのライブラリや JSON ファイルにも置けます。

```python
t = op.graph_template(g, "IV", fixed="bottom")
t.make(y=["s1_I", "s2_I", "s3_I"], x=["s1_V", "s2_V", "s3_V"])
```

[Graph API](../../reference/api/graph/) · [Trace API](../../reference/api/trace/) · [重ね描き](../../examples/overlay/)
