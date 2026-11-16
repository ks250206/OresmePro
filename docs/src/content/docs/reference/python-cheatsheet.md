---
title: Python 早見表
description: よく使う操作を「やりたいこと → コード」で引く一覧。
sidebar:
  order: 3
---

コマンド入力と Procedure では `np`(NumPy)と `op`(`import oresme as op`)が使えます。詳しい引数は [Python API](../) を見てください。

## Wave

```python
x = np.linspace(0, 10, 501)
y = op.make("signal", np.sin(x), dx=x[1] - x[0], x_unit="s", unit="V")  # 作る
y = op.wave("signal")              # 名前で取る
y.data                             # NumPy 配列(書き換えると wave も変わる)
y.data = y.data * 2                # まとめて書き換え
y.x                                # X の値(スケーリングから)
y.set_scale(0, 0.02, "s")          # X の開始値・刻み・単位
y.unit = "mV"; y.note = "run 1"    # 単位・ノート
y.rename("run1:signal")            # 名前の変更・フォルダへ移動
op.waves()                         # 全 wave
op.kill(y)                         # 削除
op.set_formula("ratio", "a / b")   # 数式(a か b が変わると再計算)
```

## データフォルダと試料の属性

```python
op.new_folder("run1")
op.folder("run1").make("spectrum", data)            # run1:spectrum
op.set_attributes("run1:", thickness=12.5, Mg=0.3)  # 試料の属性(フォルダは末尾に :)
op.wave("run1:spectrum").attributes                  # 受け継いだ属性も含む
```

## ファイルの読み込み

```python
op.load_text("data.csv")             # CSV・TSV・空白区切り
op.load_excel("book.xlsx")           # Excel(シートごと)
op.load_igor("run.pxp")              # Igor の .ibw・.pxp
op.load_parquet("run.parquet")       # Parquet
op.load_hdf5("scan.h5")              # HDF5
df = op.table("Table0").to_dataframe()   # テーブル → pandas
op.from_dataframe(df)                     # pandas → wave
```

## グラフ

```python
g = op.display(y)                          # Y を描く(X は y のスケーリング)
g = op.display(y, x=xw, name="Spectrum")   # X wave 付き、名前を付けて
g.append(y2)                               # トレースを追加
g.trace("signal").set(mode="markers", color="#ab1831", marker="circle")
g.axis("left").set(range=(0, 1), log=False, label="Intensity")
g.axis("bottom").autoscale()
g.axis("left").labels = "axis only"        # 目盛りの数値を消す
g.set(width=op.cm(8), height=("aspect", 0.75))   # プロット領域の大きさ
g.set(margins=(60, 40, 10, 10), magnification=1.5)
g.legend(); g.textbox("Run 1")
g.cursor("A", g.trace(), 10)               # カーソル
g.save("figure.pdf")                       # 書き出し(.pdf / .svg / .png)
print(g.script())                          # 作り直す Python
op.link_graphs("G1", "G2")                 # 軸とカーソルを連動
op.image(matrix); op.contour(matrix)       # 2 次元 wave
```

## テーブルとウィンドウ

```python
t = op.edit(y, y2, name="Raw")           # テーブル
op.rename_window("Graph0", "Spectrum")
op.close_window("Spectrum")              # 閉じる(中身は残る)
op.reopen_window("Spectrum")
op.kill_window("Raw")                    # 削除
op.windows("graph")                      # ウィンドウ名の一覧
```

## 解析

```python
r = op.fit("gauss", y)                                   # フィット
r = op.fit("exp", y, hold={"y0": 0}, bounds={"tau": (0, None)}, xrange=(1, 5))
r.coef, r.sigma, r.converged, r["x0"]
op.fit_peaks(y, peaks=3, shape="voigt")                  # 多ピーク
op.background(y, "shirley", subtract=True)               # 背景
op.onset(y, edge=(1.0, 1.5), baseline=(0.0, 0.5))        # 立ち上がり
op.stats(y); op.differentiate(y); op.integrate(y)
op.smooth(y, 5); op.fft(y); op.histogram(y, bins=50)
op.results()                                             # 実験に残った結果
op.results_table()                                       # 結果を表に
op.plot_results("A", "thickness")                        # パラメータを属性に対してプロット
op.result("Fit0").template("Peak").run(["s1", "s2"])     # 同じ解析を多数の試料に
```

## まとめて反映・パッケージ・Procedure

```python
with op.atomic():                     # 1 回の Undo にまとめ、失敗したら何も残さない
    a = op.make("a", np.arange(10))
    op.display(a)

%pip install pybaselines              # パッケージを入れる(実験に記録)
await op.install("emcee")
op.packages()

p = op.new_procedure("tools", "def twice(x):\n    return 2 * x\n")
p.run()                               # コマンド入力と同じ名前空間で実行
import tools                          # 別の名前空間(モジュール)として
```
