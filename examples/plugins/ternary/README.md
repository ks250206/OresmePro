# ternary: 3元相図の見本プラグイン

3 成分の組成を 3元相図(三角図)に描く OresmePro のプラグインです。三角形の枠、グリッド、目盛りの数値、頂点の名前、点、凡例を、すべて普通のトレースとして作ります。描いたあとは **Modify Trace Appearance** などで、色、線種、マーカー、文字の大きさを自由に変えられます。

- [入れ方](#入れ方)
- [`ternary`: 3元相図](#ternary-3元相図)
- [パネル](#パネル)
- [しくみ](#しくみ)
- [English](#english)

## 入れ方

**Python › Plugins…** を開き、次のどちらかで入れます。

- **Install from GitHub…**: アドレスに `https://github.com/ks250206/OresmePro/tree/main/examples/plugins/ternary` を入れて **Fetch**
- **Install from Folder…**: このフォルダ(`examples/plugins/ternary`)を選びます

使う Python パッケージは numpy だけです。

## `ternary`: 3元相図

A が上、B が右下、C が左下の三角形に、点 (a, b, c) を描きます。各点は a + b + c = 100 % に揃えるので、分率、百分率、量のどれを渡しても構いません。

| 引数           | 意味                                                                                                                              |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `a`, `b`, `c`  | 各成分の wave(同じ点数)                                                                                                           |
| `names`        | 頂点の名前。上・右下・左下の順にカンマ区切り(既定 `"A, B, C"`)                                                                    |
| `step`         | グリッドと目盛りの間隔(%、既定 10)                                                                                                |
| `grid`         | グリッドを描くか                                                                                                                  |
| `ticks`        | 目盛りの数値をどの辺に書くか。`clockwise`(A は左辺、B は右辺、C は底辺)、`counterclockwise`(A は右辺、B は底辺、C は左辺)、`none` |
| `legend`       | 点の凡例の文字。空なら凡例なし                                                                                                    |
| `marker`       | 点のマーカーの形。`circle`、`square`(既定)、`triangle`、`diamond`、`cross`、`plus`                                                |
| `marker_color` | 点の色。`"#rrggbb"`、`"#rgb"`、または `red`・`blue`・`black` などの名前(既定 `#4a90d9`)                                           |
| `marker_size`  | 点のマーカーの大きさ(既定 4)                                                                                                      |
| `marker_fill`  | マーカーを塗りつぶすか。オフなら輪郭だけ(既定 オン)                                                                               |

```python
op.invoke("plugin.ternary.ternary", {"a": "SiO2", "b": "Al2O3", "c": "CaO",
                                     "names": "SiO2, Al2O3, CaO", "legend": "Samples",
                                     "marker": "circle", "marker_color": "red"})
```

グラフ `Ternary0` ができます。wave は最初の入力の隣に `SiO2_x`、`SiO2_y`(点)、`SiO2_frame_x`(枠)、`SiO2_grid_x`(グリッド)、`SiO2_a_label`(目盛りの数値)、`SiO2_corner_text`(頂点の名前)などの名前で置かれます。

## パネル

**Python › Plugins…** でこのプラグインを選び、**Add Panels to Experiment** を押すと、パネル **Ternary Diagram** が実験に入ります。A・B・C の wave、頂点の名前、グリッドの間隔と有無、目盛りの辺、凡例、点のマーカーの形・色・大きさ・塗りつぶしを選んで **Draw** を押すと、`ternary` を呼んで図を描きます。パネルは実験と一緒に保存され、編集もできます。

## しくみ

- 組成 (a, b, c) は x = b + a/2、y = a·√3/2 の点になります
- 枠、グリッド、目盛りの線は、NaN で区切った 1 本の線のトレースです
- 目盛りの数値と頂点の名前は、文字マーカー(トレースの `text_marker`)で、データ座標の位置に置いた文字です
- グラフ本来の軸は座標を持つだけで、描きません(`line=False`、`ticks="none"`、`labels="off"`)
- 横と縦の 1 単位を同じ長さにする(Plot area の Plan)ので、三角形はいつも正三角形です
- action はグラフの形を `"graph"` として返し、アプリがそれを確かめてから自分のコマンドで作ります。プラグインが実験に直接触れることはありません

## English

A plugin that draws compositions of three components as a ternary diagram: A at the top, B at the bottom right, C at the bottom left. The frame, grid, tick labels, corner names, points and legend are all ordinary traces, so their colors, lines, markers and text can be changed afterwards like those of any trace.

Install it from **Python › Plugins…** with this folder or its GitHub address, then run **Ternary Diagram** or:

```python
op.invoke("plugin.ternary.ternary", {"a": "SiO2", "b": "Al2O3", "c": "CaO"})
```

Its panel (**Add Panels to Experiment** in **Python › Plugins…**) has fields for the waves and the settings and a **Draw** button. Each point is scaled to a + b + c = 100 %. `step` sets the grid, `ticks` the sides the values are written on (`clockwise`, `counterclockwise` or `none`), `names` the corners and `legend` the points' legend; `marker`, `marker_color`, `marker_size` and `marker_fill` set the shape, color, size and fill of the points' markers. The tick labels and corner names are text markers placed in data coordinates; the graph's own axes carry the coordinates and are not drawn; the plot area is sized so that a unit is as long across as up, so the triangle is equilateral. The action returns the graph's description as `"graph"`, and the app checks it and makes the graph with its own commands.
