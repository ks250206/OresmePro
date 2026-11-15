---
title: テーブル操作
sidebar:
  order: 5
---

**Windows → New Table…** で Wave を列として選びます。セルを編集すると Experiment 内の Wave が更新され、同じ Wave を使うグラフにも反映されます。列ごとの Wave は異なる長さを持てます。

## 入力とコピー

- セルを選択して編集し、範囲を選んでコピー・ペーストします。表計算ソフトとの間ではタブ区切りのテキストを受け渡せます。
- 列をテーブルから外しても Wave は Experiment に残ります。
- Python では `op.edit` でテーブルを作り、`table.append` や `table.remove` で列を入れ替えます。

```python
t = op.make("sample_time", [0, 1, 2], unit="s")
v = op.make("sample_voltage", [1.0, 1.2, 1.4], unit="V")
table = op.edit(t, v, name="Samples")
table.digits = 4
```

pandas と連携する場合は `table.to_dataframe()`、逆方向には `op.from_dataframe(frame)` を使います。DataFrame の列にする Wave は1次元にします。[Table API](../../reference/api/table/)

## 式で値を決める

**Data → Set Wave Values…**、または列見出しや Data Browser の右クリックから、Wave に式を持たせて値を計算します(Igor の Set Wave Values と `R := V / I` にあたります)。ダイアログには先頭の数点の値が表示され、式に誤りがあればその位置を示します。

- **自動**にすると、式に使った Wave が変わるたびに計算し直します。計算し直しは元の変更と同じ Undo の段に入ります。
- **手動**にすると、入力が変わったときに Data Browser の印が赤くなり(_f\*_)、右クリックの **Recalculate** で計算し直します。
- 計算に失敗したときや入力の Wave を削除したときは、前の値を残して印が赤くなります(_f!_)。ツールチップに理由が出ます。
- 入力の名前を変えると、式の中の名前も書き換わります。式と状態は Experiment に保存されます。

式は本体が解釈する専用の言語です。使えるのは数値、Wave の名前(フォルダの中は `run1:V`)、`p`(点の番号)、`x`(X の値)、`pi`、`e`、`nan`、`inf`、`+ - * / ^`、比較、`&& || !`、`条件 ? a : b` と、`abs`・`sqrt`・`exp`・`ln`・`log`(常用対数)・`log10`・三角関数と双曲線関数・`atan2`・`floor`・`ceil`・`round`・`min`・`max`・`pow`・`hypot`・`sign`・`isnan` だけです。属性の参照や、ほかの関数の呼び出しは書けません。`p` や `x` と同じ名前の Wave は `'x'` と引用符で囲みます。

点ごとに計算するので、式の中の Wave は数値の1次元の Wave で、点数と X のスケーリングが同じでなければなりません(補間はしません)。0 での割り算は NaN になり、その件数が表示されます。NaN は `isnan` 以外の演算をそのまま通ります。

```python
r = op.set_formula("R", "V / I")              # 自動
m = op.set_formula("ratio", "run1:A / run2:A", auto=False)
r.formula_info["status"]                       # "ok"、"stale"、"error"、"missing"
op.recalculate()                               # 手動の式を計算し直す
r.formula = None                               # 式を外す(値は残る)
```

自動の式を持つ Wave に直接入力した値は、すぐに式の値で置き換わります。値を手で変えるときは、先に式を外します。[Wave API](../../reference/api/wave/)
