---
title: Wave とデータフォルダ
sidebar:
  order: 1
---

## Wave の形状とスケーリング

Wave は名前付きの数値配列（1〜4次元）または1次元の文字列配列です。数値 Wave は型、点数、単位、スケーリングを持ちます。一次元なら点番号 `i` の横座標は `x0 + i * dx` です。測定間隔が不規則な場合は X 値を別の Wave にします。二次元なら `w[i, j]` の `i` が X、`j` が Y です。

- `w.data` で読み取り専用の NumPy 配列を取得します。編集するには `w[0] = 1.0` のように代入するか、配列全体を `w.data = values` で置き換えます。
- `np.sin(w)` や `w * 2` の結果は NumPy 配列です。Experiment に残すには `op.make` で Wave を作ります。
- `op.make` は既定で同名の Wave を置き換えます。既存データを保護する場合は `overwrite=False` を指定します。

## フォルダに整理する

**Data → New Data Folder…** または `op.new_folder` でデータフォルダを作ります。Python の Wave 名では階層をコロンで区切ります。

```python
run = op.new_folder("run1")
raw = run.make("voltage", [1.2, 1.6, 2.0], dx=0.5, x_unit="s", unit="V")
raw[0] = 1.3
print(op.wave("run1:voltage").x)
```

グラフやテーブルが参照する Wave を削除する場合は、先に該当するトレースや列を外します。[Wave API](../../reference/api/wave/) · [Folder API](../../reference/api/folder/)
