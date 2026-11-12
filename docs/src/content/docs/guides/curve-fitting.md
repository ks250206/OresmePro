---
title: カーブフィッティング
sidebar:
  order: 6
---

## モデルと範囲を選ぶ

**Analysis → Curve Fitting…** で関数と1次元の Y Wave を選びます。X Wave を指定しない場合は Y Wave の X スケーリングを使います。カーソル間を選ぶ場合は対象トレースに A と B を置きます。Python では `range` が両端を含む点番号、`xrange` が X 座標の範囲、`cursors=True` がカーソル間を指定します。

`op.fit_functions()` でモデル名と式を確認できます。たとえば `gauss` の式は `y0 + A*exp(-((x-x0)/width)^2)` で、半値全幅は `2*sqrt(log(2))*abs(width)` です。`exp` は `y0 + A*exp(-x/tau)` です。

## 結果を検証する

- 既知のパラメータを固定するには `hold`、許容範囲を指定するには `bounds` を使います。既知の点ごとの標準偏差は `sigma` に渡します。
- `op.fit` は `FitResult` を返します。`converged`、`reason`、残差とパラメータ間の相関を確認し、初期値やフィット範囲を調整します。
- 係数と推定標準偏差は `W_coef` と `W_sigma` に書かれます。フィットは通常 Experiment にも記録され、**Analysis → Results…** から比較・再実行できます。
- 組み込みモデルに加え、初期値付きの Python 関数や lmfit モデルを渡せます。

[ガウシアン](../../examples/gaussian/) · [指数関数](../../examples/exponential/) · [Analysis API](../../reference/api/analysis/#fit)
