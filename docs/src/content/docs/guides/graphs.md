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

## プロット領域の大きさ

プロット領域(軸で囲まれた部分)の幅と高さは、既定ではウィンドウの大きさから余白を引いた残りです。論文の図のように長さを決めるには、**Modify Graph** の **Plot area** で幅と高さのモードをそれぞれ選びます。Igor Pro の ModifyGraph `width` / `height` と同じ考え方です。

| モード   | 意味                                                                                                        |
| -------- | ----------------------------------------------------------------------------------------------------------- |
| Auto     | ウィンドウに合わせる(既定)                                                                                  |
| Absolute | 決まった長さ(pt・cm・inch。1 inch = 72 pt)                                                                  |
| Aspect   | もう一方の f 倍                                                                                             |
| Plan     | 横軸の 1 単位が縦軸の 1 単位の f 倍の長さになる大きさ(高さでは逆向き)。f = 1 で縦横同じ縮尺(Nyquist 図など) |
| Per unit | 軸の 1 単位あたりの長さ(例: 1 V あたり 2 cm)                                                                |

余白は既定で目盛りとラベルに合わせて自動です(下の「余白」で固定できます)。Auto でない向きでは図の大きさがプロット領域と余白の和になり、ウィンドウが図に合わせて大きさを変えます。その向きはウィンドウを手で引き伸ばしても変わりません。Plan と Per unit は軸の範囲から計算するので、範囲や自動スケールが変わると大きさも変わります。対数軸の 1 単位は 1 桁です。幅と高さの両方を Aspect か Plan にはできません。

画面と SVG・PNG のレイアウトの 1 単位は CSS ピクセル(1/96 inch)、グラフの PDF は 1 単位を 0.75 pt で書くので、8 cm は画面でも PDF でも 8 cm です(ピクセル単位に丸めるため誤差は 0.13 mm 以内)。Absolute は 12〜3000 pt、計算で決まる大きさは 16〜4000 ピクセルに収めます。ページレイアウトでは用紙の上で同じ長さになり、グラフは枠の左上から描かれます。スタイルは Auto・Absolute・Aspect を持ち(サイズ付きで保存したとき)、グラフテンプレートと `g.script()` はすべてのモードを再現します。

```python
g.set(width=op.cm(8), height=("aspect", 0.75))
g.set(width=("plan", 1, "bottom", "left"), height=op.cm(6))
g.set(width=("per_unit", 2, "cm", "bottom"))
g.set(width="auto")
g.width   # op.cm(8)、('aspect', 0.75) などの同じ形で返る
```

## 余白

プロット領域のまわりの余白は、既定では軸・目盛りラベル・軸ラベルが収まる幅に自動で決まります。**Modify Graph** の **Margins** で Left・Bottom・Right・Top をそれぞれ pt で固定するか、**Auto** に戻せます。Igor Pro の ModifyGraph `margin` と同じです。Auto のチェックを外すと、いまの余白の幅が入るので、そのまま OK を押しても見た目は変わりません。

固定した余白はラベルの大きさに関係なくその幅のままなので、狭すぎるとラベルが切れ、広ければ空白が残ります。複数のグラフで軸の位置をそろえたいときに便利です。範囲は 0〜360 pt(5 inch)で、ページレイアウトでは用紙の上で同じ長さになります。余白はスタイルとグラフテンプレートに含まれます。

```python
g.set(margin_left=op.cm(2), margin_bottom=40)   # 長さ、または pt の数値
g.margin_left = "auto"                          # None でも可
g.set(margins=(60, 40, 10, 10))                 # left, bottom, right, top をまとめて
g.set(margins="auto")
g.margin_bottom   # 40(pt)、Auto なら None
```

## 表示倍率

**Modify Graph** の **Magnification** で、グラフをウィンドウの中で拡大・縮小して表示できます。Igor Pro の ModifyGraph `expand` と同じで、0.125〜8 倍から選びます(None は等倍)。倍率を変えるとウィンドウも同じ倍率で大きさを変え、図そのものの大きさ(プロット領域、余白、文字の大きさ)は変わりません。SVG・PNG・PDF への書き出し、スタイルの大きさ、ページレイアウトは倍率に関係なく等倍で扱います。

```python
g.magnification = 2     # 2 倍で表示
g.set(magnification=1)  # 等倍に戻す
```

## グラフを連動させる

**Graph → Link Graphs…**(グラフの右クリックにもあります)で 2 つ以上のグラフを選んで **Link** を押すと、1 つを拡大・移動したときに他のグラフも同じ範囲になります。
連動する軸は X(下の軸)だけか、X と Y(下と左)を選べます。最初は 1 つ目のグラフの範囲にそろいます。
**Cursors follow each other by X** をオンにすると、1 つのグラフに置いたカーソルが、他のグラフでも同じ X に最も近い点に置かれます。
点の数や間隔が違っても(充放電曲線・電流・温度を別々のグラフに出した場合など)、点番号ではなく X の値で対応します。
連動中のグラフはタイトルに「linked」と出ます。**Unlink** で外します。

```python
op.link_graphs("XPS1", "XPS2", "XPS3", "XPS4")          # X を連動、カーソルも
op.link_graphs(charge, current, temp, axes="xy", cursors=False)
g.link        # {'graphs': [...], 'axes': 'x', 'cursors': True}
g.unlink()
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
