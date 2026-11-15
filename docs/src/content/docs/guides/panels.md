---
title: パネル
sidebar:
  order: 11
---

パネルは、ボタンと入力欄で解析を動かすウィンドウです。Igor のコントロールパネルに当たります。決まった解析を、Python を書かない人にも使ってもらうために使います。

## パネルを作る

**Windows → New Panel** で空のパネルが編集モードで開きます。**Add ▾** で部品を足し、部品をクリックすると右のフォームで設定を変えられます。

| 部品        | 内容                                                          |
| ----------- | ------------------------------------------------------------- |
| Heading     | 見出し                                                        |
| Text        | 説明文(複数行)                                                |
| Wave Picker | Wave の選択。次元の数と名前(`*_I` のようなパターンも可)で絞る |
| Choice      | 選択肢のメニュー                                              |
| Number      | 数値。最小・最大・刻みを指定できる                            |
| Text Field  | 文字の入力欄                                                  |
| Checkbox    | チェック(真偽)                                                |
| Button      | 登録された Action を呼ぶボタン                                |

部品は上から 1 行に 1 つ並びます。**On the line before** を付けると前の部品と同じ行に並びます。↑ ↓(**Alt+矢印キー**)で並べ替え、**Delete** で削除します。編集を終えるにはタイトルバーの **Done** を押します。タイトルバーの **Edit** か、右クリック → **Edit Panel** で再び編集モードになります。

## ボタンに解析を割り当てる

ボタンを選び、**Action** に呼ぶ解析(`core.fit` など)を選ぶと、その引数が並びます。引数ごとに次のどれかを選びます。

- **Leave out**: 渡さない(省略できる引数だけ)
- **Fixed value**: 決まった値を渡す
- **Control**: パネルの部品の、押したときの値を渡す
- **New control**: 引数に合った部品を作って結び付ける。Wave の引数なら Wave Picker、選択肢ならその選択肢のメニュー、数ならその範囲の Number

ボタンが持つのは Action の名前と引数だけで、Python のコードは持ちません。押したときに部品の値から引数を作り、Action の引数の型で確かめてから呼びます。足りないもの(「Choose a wave for Spectrum.」など)や合わないものはボタンの下に表示され、何も実行されません。

呼び出しの実行中は、そのパネルのボタンは押せません。連打しても 1 回しか動きません。実行中に値を変えても、動いている呼び出しには影響しません。失敗するとエラーがボタンの下に表示され、値はそのまま残ります。呼び出しは同じ意味の Python(`op.fit("gauss", op.wave("sig"))` など)として履歴に残ります。

## 値の保存と Undo

部品の値は Experiment に保存され、開き直すと戻ります。値の変更は Undo でき、履歴には `op.panel("quick_fit")["model"] = "lor"` のように残ります。数値や文字を打ち込んだときは、その欄の 1 回の編集が 1 回の Undo です。

Wave Picker は Wave の名前を持ちます。Wave の名前を変えると追従し、Wave を削除すると名前が残って **missing** と表示されます。

## データのみとコードを含むパネル

ボタンが `core.`(本体の解析)と `plugin.`(隔離して動くプラグイン)の Action だけを呼ぶパネルは **Data only**(データのみ)です。Procedure で `@op.action` を使って登録した Action を呼ぶボタンがあると **Contains code**(コードを含む)になり、押すとこの Experiment の Python が動きます。編集モードのツールバーに表示されます。

自分の Python をボタンで動かすときは、Procedure で関数を Action として登録し、ボタンでその Action を選びます。

```python
@op.action("lab.normalize", title="Normalize", params={"wave": {"type": "wave", "title": "Wave"}})
def normalize(wave):
    return op.make(f"{wave.name}_norm", wave.data / np.nanmax(wave.data))
```

## 共有する

編集モードの **Export…** で JSON ファイル(`<名前>.panel.json`)に書き出し、**Windows → Import Panel…** で読み込みます。同じ名前のウィンドウがあるときは別の名前で読み込みます。コードを含むパネルを読み込むと、どの Action を呼ぶかが履歴に表示されます。

## Python から作る

```python
p = op.panel("quick_fit", title="Quick Fit")
p.wave("target", label="Spectrum", dims=1)
p.choice("model", ["gauss", "lor"], label="Model")
with p.row():
    p.number("n", "Points", value=5, min=1)
    p.checkbox("quiet", "Quiet", value=True)
p.button("run", "Fit", action="core.fit",
         args={"function": op.control("model"), "y": op.control("target")})
p["model"] = "lor"
r = p.press("run")
```

部品を足すメソッドは、同じ名前・種類の部品がすでにあれば設定だけを変え、値は残します。パネルを組み立てる Procedure を何度実行しても、使っている人の値は消えません。

[Panel API](../../reference/api/panel/) · [Actions API](../../reference/api/actions/) · [解析を名前で呼ぶ](../python/#解析を名前で呼ぶ)
