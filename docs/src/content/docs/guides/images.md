---
title: 画像プロットと等高線
sidebar:
  order: 4
---

**Windows → New Image Plot…** または **New Contour Plot…** で数値 Wave を選びます。画像は格子点の値を色に写し、等高線は指定値の境界を描きます。同じ座標の Wave から作ると1つのグラフに重ねられます。

## 座標、色、面を選ぶ

- Wave の第1・第2次元に X・Y スケーリングを設定します。座標付き配列を作るときは `np.meshgrid(x, y, indexing="ij")` で軸の順を揃えます。
- 画像は `color_table`、`z_min`、`z_max` で配色と値域を指定できます。複数の試料を比較するときは同じ値域を指定します。
- 3次元・4次元 Wave では `layer` と `chunk` で表示する面を選べます。
- `g.append_contour(field, levels=[0.2, 0.5, 0.8])` は3つの値に対応する線を描きます。カラースケールは `g.colorscale()` で追加できます。

[実行できる2D サンプル](../../examples/image-contour/) · [Image / Contour API](../../reference/api/image-contour/)
