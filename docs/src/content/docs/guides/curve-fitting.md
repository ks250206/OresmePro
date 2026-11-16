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

## 試料の条件と結果を比べる

組成・膜厚・温度・サイクル数・装置などの**試料の属性**を、データフォルダ(試料ごとのフォルダ)か wave に付けられます。
**Data → Sample Attributes…** の表で、行(試料)ごとに数値か文字を入力します。フォルダの属性はその中の wave すべてに付き、wave 自身の属性が上書きします。
Data Browser のフォルダ・wave の右クリック **Attributes…** でも開けます。

結果は、読んだ wave の試料の属性を持ちます。**Analysis → Results…** では属性が列に並び、**Plot…** で「膜厚を横軸、A を縦軸」のように、
パラメータを属性(または別のパラメータ)に対してプロットできます(標準偏差は誤差棒)。`op.results_table()` も属性の列を作ります。

```python
op.set_attributes("run1:", thickness=12.5, Mg=0.3, instrument="XPS-2")   # フォルダ(末尾に :)
op.wave("run1:spectrum").set_attributes(cycle=3)                         # wave
op.wave("run1:spectrum").attributes      # {'thickness': 12.5, 'Mg': 0.3, 'instrument': 'XPS-2', 'cycle': 3}
op.plot_results("A", "thickness")        # A を膜厚に対してプロット
```

## 同じ手順を多くの試料に適用する

1 つの試料で決めた解析を、**解析テンプレート**として名前を付けて残し、多くの試料に順に適用できます。

1. **Analysis → Results…** で結果を選び、**Make Template…** で名前を付けます。結果が読んだ wave はテンプレートの入力になります。
   複数の結果を選ぶと、行った順の複数段のテンプレートになり、前の段が作った wave(残差など)は「その段の出力」として次の段に渡ります。
2. **Analysis → Templates…** でテンプレートを選び、試料の行を作ります(1 行が 1 試料)。**Add Selected Waves** は Data Browser で選んだ wave、
   **Add from Folder** はフォルダの wave(入力が複数のときは、入力と同じ名前の wave を持つフォルダごと)から行を作ります。
3. **Run** で実行します。試料ごとに `op.atomic()` の中で全段を行うので、失敗した試料は何も残さず、成功した試料はその場で実験に入ります。
   失敗したときに残りを続けるか止めるかを選べます。
4. 実行の記録(Run)には、使ったテンプレートの写し、入力とその指紋、試料ごとの状態とエラーが残ります。
   **Retry Failed** は失敗・中断・未実行の試料だけを、記録にある写しでやり直します(あとでテンプレートを変えても、過去の Run の条件は変わりません)。
   **Make Table** は成功した試料の係数と、失敗した試料の理由を 1 つの表にします。

試料の出力は既存の wave を上書きしません。試料を始める前からある名前で wave を作ろうとすると、`fit_s1_1` のように `_1`、`_2` を付けた名前になります
(`W_coef`・`W_sigma`・`W_peaks` は除きます)。

```python
t = op.result("Fit0").template("Peak")             # 結果から
run = t.run(["s1", "s2", "s3"], on_error="continue")
run.counts                                         # {'succeeded': 2, 'failed': 1, ...}
run.retry()                                        # 失敗した試料だけ
run.table()                                        # 状態・エラー・係数の表
```

手で書くときは、各段の引数に固定値、入力(`{"$input": "spectrum"}`)、前の段の出力(`{"$step": "bg", "output": "subtracted"}`)を書きます。

[Templates API](../../reference/api/templates/)
