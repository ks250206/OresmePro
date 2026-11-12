---
title: 統計、FFT、平滑化、微分積分
sidebar:
  order: 7
---

| 操作         | Python                     | 出力                                     |
| ------------ | -------------------------- | ---------------------------------------- |
| 統計         | `op.stats(w)`              | 平均、標準偏差、最小・最大などを含む辞書 |
| ヒストグラム | `op.histogram(w, bins=30)` | ビンの中心を X、個数を Y とする Wave     |
| FFT          | `op.fft(w)`                | 非負周波数の片側振幅スペクトル           |
| 平滑化       | `op.smooth(w, n=7)`        | 7点移動平均の Wave                       |
| 微分         | `op.differentiate(w, x=x)` | X に対する導関数の Wave                  |
| 積分         | `op.integrate(w, x=x)`     | 台形則による累積積分の Wave              |

## 入力に合わせて使い分ける

FFT は等間隔の1次元信号に使います。サンプル間隔 `dx` と X 単位を確認してください。`x_unit="s"` なら出力周波数の単位は Hz です。逆変換に使う場合は `op.fft(w, output="complex")` で複素スペクトルを保持します。

微分と積分では、測定間隔が一定なら Wave のスケーリングを使えます。不規則な場合は、同じ点数の X Wave または配列を渡します。平滑化の窓幅を変えると細かなピークの形状も変わるため、元の Wave と重ねて確認します。

[FFT](../../examples/fft/) · [ヒストグラム](../../examples/histogram/) · [Analysis API](../../reference/api/analysis/)
