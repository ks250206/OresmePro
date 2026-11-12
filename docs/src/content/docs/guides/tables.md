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
