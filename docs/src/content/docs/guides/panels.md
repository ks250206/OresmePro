---
title: パネル
sidebar:
  order: 11
---

パネルは、ボタンと入力欄で解析を動かすウィンドウです。Igor のコントロールパネルに当たります。決まった解析を、Python を書かない人にも使ってもらうために使います。

## パネルを作る

**Windows → New Panel** で空のパネルが編集モードで開きます。**Add ▾** で部品を足し、部品をクリックすると右のフォームで設定を変えられます。

| 部品        | 内容                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Heading     | 見出し                                                                                                                         |
| Text        | 説明文(複数行)                                                                                                                 |
| Wave Picker | Wave の選択。次元の数と名前(`*_I` のようなパターンも可)で絞る。数値の Wave を並べ、**Text waves too** でテキスト Wave も並べる |
| Wave List   | Wave の一覧。Wave Picker と同じように絞り、1 つか複数を選ぶ                                                                    |
| Plot        | 小さなグラフ。アクティブなグラフの wave を取ってきて描く                                                                       |
| Choice      | 選択肢のメニュー                                                                                                               |
| Number      | 数値。最小・最大・刻みを指定できる                                                                                             |
| Text Field  | 文字の入力欄                                                                                                                   |
| Checkbox    | チェック(真偽)                                                                                                                 |
| Button      | 登録された Action を呼ぶボタン                                                                                                 |

部品は上から 1 行に 1 つ並びます。**On the line before** を付けると前の部品と同じ行に並びます。↑ ↓(**Alt+矢印キー**)で並べ替え、**Delete** で削除します。編集を終えるにはタイトルバーの **Done** を押します。タイトルバーの **Edit** か、右クリック → **Edit Panel** で再び編集モードになります。

## 部品を自由に置く

行に並べるだけでなく、Igor のパネルのように部品を好きな位置に置けます。

- 編集モードで部品を**ドラッグ**すると、その位置に置かれます(パネルの左上からのピクセル数 x, y)。置いた部品は行から外れ、ほかの部品の上に重なります。行に並ぶ部品は、置いた部品がないものとして並びます
- 選んだ部品の右下の**取っ手**をドラッグすると大きさ(w, h)が変わります
- **矢印キー**で 1 ピクセル、**Shift+矢印キー**で 10 ピクセル動きます。行に並んでいる部品も、動かすとその位置に置かれます
- 重なった部品は z の大きいものが前に描かれます。ツールバーの **Front** / **Back**、または右クリック → **Bring to Front** / **Send to Back** で前面・背面へ動かします
- 右クリック → **Return to Line** で、置いた部品を行に戻します

右のフォームの **Look and Place** では、文字の色(**Color**)と背景色(**Background**)、位置(**Placed by x and y** と **X**・**Y**)、大きさ(**Width**・**Height**。空なら中身の大きさ)、**Z** を数値で指定できます。**None** で色を外します。ドラッグ 1 回、色の選択 1 回、矢印キーで続けて動かした分がそれぞれ 1 回の Undo で、履歴には `op.panel("free").control("go").set(x=200, y=150)` のように残ります。

## Wave List と Plot

**Wave List** は、条件に合う Wave の一覧です。値は選んだ Wave の名前のリストで、ボタンでは複数の Wave をとる引数(`waves`)に渡せます。**Select several** を外すと 1 つだけ選べます。Wave の名前を変えると追従し、削除した Wave は **missing** と表示されます。

**Plot** は、パネルの中の小さなグラフです。右上の **From Graph**(フォームでは **Take from Active Graph**)を押すと、いちばん前にあるグラフ(アクティブなグラフ)のトレースの wave を取ってきて描きます。新しく足した Plot は、アクティブなグラフの wave で始まります。フォームの **Waves** に 1 行に 1 つ、`y` か `y vs x` の形で書いても指定できます。**Live** を付けると、自分の wave ではなく、アクティブなグラフをそのまま描き続けます。大きさは **Width**・**Height** で決めます。

## ボタンに解析を割り当てる

ボタンを選び、**Action** に呼ぶ解析(`core.fit` など)を選ぶと、その引数が並びます。引数ごとに次のどれかを選びます。

- **Leave out**: 渡さない(省略できる引数だけ)
- **Fixed value**: 決まった値を渡す
- **Control**: パネルの部品の、押したときの値を渡す
- **New control**: 引数に合った部品を作って結び付ける。Wave の引数なら Wave Picker、選択肢ならその選択肢のメニュー、数ならその範囲の Number

ボタンが持つのは Action の名前と引数だけで、Python のコードは持ちません。押したときに部品の値から引数を作り、Action の引数の型で確かめてから呼びます。足りないもの(「Choose a wave for Spectrum.」など)や合わないものはボタンの下に表示され、何も実行されません。Wave Picker で何も選んでいないとき、Action が省略できる引数なら、その引数は渡さずに呼びます。

呼び出しの実行中は、そのパネルのボタンは押せません。連打しても 1 回しか動きません。実行中に値を変えても、動いている呼び出しには影響しません。失敗するとエラーがボタンの下に表示され、値はそのまま残ります。呼び出しは同じ意味の Python(`op.fit("gauss", op.wave("sig"))` など)として履歴に残ります。

## 値の保存と Undo

部品の値は Experiment に保存され、開き直すと戻ります。値の変更は Undo でき、履歴には `op.panel("quick_fit")["model"] = "lor"` のように残ります。数値や文字を打ち込んだときは、その欄の 1 回の編集が 1 回の Undo です。

Wave Picker は Wave の名前を持ちます。Python では `text=True` でテキスト Wave も並べます(`p.wave("group", text=True)`)。Wave の名前を変えると追従し、Wave を削除すると名前が残って **missing** と表示されます。Wave List と Plot の wave も同じです。

部品の位置・大きさ・色・z も Experiment に保存され、書き出した JSON にも入ります。使っていない(既定のままの)ものは書き出されないので、これらを使わないパネルは以前の版のアプリでも読めます。

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

部品を足すメソッドはどれも、見た目と位置をキーワードで受け取ります。`color`・`background`(`"#rrggbb"`、色の名前、`(r, g, b)`)、`x`・`y`(置く位置)、`w`・`h`(大きさ)、`z`(重なりの順)です。

```python
# 選んだ wave の平均を作る Action(Procedure で登録する)
@op.action("lab.average", title="Average", params={"waves": {"type": "waves", "title": "Waves"}})
def average(waves):
    return op.make("average", np.mean([w.data for w in waves], axis=0))

p = op.panel("free", title="Free")
p.heading("top", "Spectra", x=10, y=8, color="#2a6fd6")
p.list("waves", "Waves", dims=1, x=10, y=36, w=160, h=140)
pv = p.plot("preview", x=190, y=36, w=280, h=160)
pv.take_from_graph()                     # いちばん前のグラフの wave を描く
p.button("run", "Average", action="lab.average", args={"waves": op.control("waves")},
         x=10, y=190, w=160, background="orange")
p.control("top").bring_to_front()        # send_to_back() で背面へ
p.control("run").place(10, 200)          # unplace() で行に戻す
```

`p.data` と `op.set_panel(name, data)` でも、各部品の `x`・`y`・`w`・`h`・`color`・`background`・`z` をそのまま読み書きできます。

[Panel API](../../reference/api/panel/) · [Actions API](../../reference/api/actions/) · [解析を名前で呼ぶ](../python/#解析を名前で呼ぶ)
