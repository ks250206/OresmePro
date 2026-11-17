---
title: プラグイン
sidebar:
  order: 11
---

プラグインは、解析(Action)、パネル、テンプレート、グラフテンプレート、スタイルを追加します。GitHub のリポジトリ、またはフォルダや zip から入れます。中央の配布サービスはありません。

## 入れる

**Python → Plugins…** を開き、**Install from GitHub…**、**Install from Folder…**、**Install from Zip…** のどれかを選びます。

- GitHub の場合は、リポジトリの URL を入れます。`…/tree/<ブランチ>/<フォルダ>` の形の URL も使えます。ブランチやタグを別に指定することもできます
- ブランチやタグは、その時点のコミットに固定されます。以後のファイルはすべて同じコミットから取得するので、リポジトリが更新されても、入れたものは変わりません
- 入れる前に、プラグインの名前・版・導入元・コミット・Action の一覧・使う Python パッケージ・ファイル数が表示されます。**Install** を押すまで、プラグインのコードは何も実行されません

入れたプラグインはブラウザに保存され、どの Experiment からも使えます。各ファイルの SHA-256 を記録し、読み出すたびに照合するので、保存されたファイルが書き換えられていれば実行しません。

## プラグインのコードはどこで動くか

Python のコードを含むプラグインは、アプリとは別のサンドボックスで動きます。

- サンドボックスは、オリジンを持たない iframe の中の Worker です。プラグイン専用の Pyodide がそこで動きます
- このブラウザにある Experiment(OPFS)、IndexedDB、キャッシュには届きません
- ネットワークも使えません。Pyodide とパッケージはアプリが読み込んで渡します
- プラグインに渡るのは、Action に選んだ wave の値・スケーリング・単位だけです。プラグインは新しい wave と数値を返し、アプリがそれを検査して Experiment に入れます。プラグインが Experiment を直接読んだり書き換えたりすることはありません

この仕組みが成り立たないブラウザでは、コードを含むプラグインは動きません。アプリの Python で代わりに動かすこともしません。データだけのプラグイン(パネル・テンプレート・スタイル)はどこでも使えます。

プロシージャやコマンドラインの Python は、これとは違い、アプリの Python で動きます(このブラウザの Experiment を読めて、通信もできます)。作者を知らないコードはプロシージャではなく、プラグインとして入れてください。

## 使う

- **Python → Plugins…** でプラグインを選び、Action の **Open** を押すと、その Action のフォームが専用のウィンドウで開きます。**Python → Plugin Actions** からも直接開けます。wave と値を選んで **Run** を押します
- このウィンドウはモーダルではありません。開いたままグラフやテーブル、コマンドを使え、タイトルバーをドラッグして好きな位置に動かせます。何度でも Run でき、閉じるまで入力した値が残ります。Experiment には保存されません
- Python からは `op.invoke("plugin.<プラグイン名>.<Action 名>", {...})` で呼びます。`op.atomic()` の中でも使えます
- 結果の wave は、最初の入力 wave の隣に `<入力名>_<役割>` という名前で作られます。同じ名前の wave があるときは上書きせず、`_1` などを付けます
- 例外は `op.invoke(..., replace=True)` と、モデル編集ウィンドウのフィットだけです。同じプラグインの同じ Action が同じ入力 wave で最後に結果を残したときに作った wave のうち、その結果に残ったコピーと値・スケーリングが同じもの(つまり、その後に変えていないもの)だけを、同じ名前で作り直します。そのとき作ったグラフも、トレースの見た目や軸はそのままで、足りないトレースを足し、もう作らない wave のトレースを外して更新します(もう作らない wave は、どこにも表示されていなければ消します)。変えた・名前を変えた wave と、それ以外のものには触れず、新しい名前で作ります。上書きするかどうかはアプリと使う人が決め、プラグインが選ぶことはありません
- プラグインが **モデル編集ウィンドウ**(下の `editors`)を持つときは、**Analysis** メニューの最後と **Python → Plugins…** の **Open** から開きます。データの上で項目をドラッグし、表で値と制約を書いて、**Fit** でフィットします。ウィンドウの中の編集は Ctrl+Z で戻せます
- プラグインが結果を返すと、フィットと同じく **Analysis → Results…** に残ります。結果には、作ったプラグイン・版・導入元・コミットが記録されます
- グラフテンプレートとスタイルは **Add … to Experiment** で Experiment に入れます

## 止める・更新する・外す

- **Turn Off** で Action が使えなくなり、動いているサンドボックスも止まります
- **Update…** は、入れたときと同じブランチやタグの現在のコミットを取得し、違いを見せてから入れ替えます
- **Remove…** でプラグインとそのファイルを消します。作った wave・グラフ・結果は Experiment に残ります。結果を再実行しようとすると、必要なプラグインの名前を示して止まります
- Experiment を開いただけで、プラグインを取得したり起動したりすることはありません

## プラグインを作る

フォルダに `oresme-plugin.json` を置きます。

```json
{
  "manifestVersion": 1,
  "name": "scale",
  "title": "Scale",
  "version": "1.0.0",
  "python": { "entry": "scale", "packages": [] },
  "files": ["scale.py"],
  "actions": [
    {
      "name": "scale",
      "title": "Scale a wave",
      "params": {
        "y": { "type": "wave", "title": "Wave" },
        "factor": { "type": "number", "default": 2 }
      }
    }
  ]
}
```

- `files` にはパッケージのファイルをすべて書きます。ここにないファイルは入りません
- `actions` の引数の型は `op.action` と同じです(`wave`、`waves`、`number`、`integer`、`numbers`、`string`、`boolean`、`choice`、`json`)。`json` は構造を持つ値(リストや dict)で、中身はプラグインが確かめます。Action はここで宣言するので、コードを動かす前に内容を表示して確かめられます
- `wave` と `waves` の引数は数値の wave を取ります。`"text": true` を付けると、テキスト wave も取ります(試料名や結晶構造の名前など)。付けていない引数にテキスト wave を渡すと、実行する前に断ります
- Python 側では、Action ごとに関数を登録します

```python
from oresme_plugin import action, wave

@action("scale")
def scale(y, factor=2.0):
    return {
        "waves": {"scaled": wave(y.data * factor, like=y)},
        "values": {"result": {"names": ["factor"], "coef": [factor], "sigma": [0.0]}},
    }
```

wave の引数は `Wave`(`.data` は読み取り専用の NumPy 配列。`.x`、`.dx`、`.unit` なども使えます)として渡されます。テキスト wave は、`.data` が文字列(`str`)の 1 次元配列で、`.is_text` が `True` です。`values` の `result` に `names`、`coef`、`sigma` を入れると、解析結果として残ります。

文字列のリスト(または文字列の NumPy 配列)を `wave(...)` に渡すと、テキスト wave になります(文字マーカーのラベルなど)。

### グラフを返す

Action は `waves` と `values` に加えて `"graph"` を返せます。アプリは、返された wave だけを使って(役割の名前で指定します)、そのグラフを作ります。

```python
return {
    "waves": {"x": wave(x), "y": wave(y), "label": wave(["P1", "P2"])},
    "graph": {
        "name": "Peaks",
        "traces": [
            {"y": "y", "x": "x", "mode": "markers", "legend": "Peaks"},
            {"y": "y", "x": "x", "mode": "markers", "text_marker": "label", "text_anchor": "LB"},
        ],
        "axes": {"left": {"label": "Intensity"}, "bottom": {"min": 0}},
        "graph": {"margin_left": 40},
        "annotations": [{"kind": "legend", "anchor": "RT"}],
    },
}
```

- トレースは、アプリのトレースと同じプロパティ(`mode`、`color`、`line_size`、`marker`、`text_marker` など)を取ります。wave を指すプロパティには役割の名前を書きます。`axis`、`haxis` で軸の側を選び、`legend` を付けたトレースは凡例に並びます
- `axes` と `graph` は、軸とグラフのプロパティです。名前は Python と同じ snake_case で書けます
- アプリは、Python から頼まれたときと同じように、すべてを確かめてから作ります。不正なプロパティがあれば、その実行は何も残しません

### モデル編集ウィンドウ(editors)

ピークや成分を組み合わせたモデルを、スペクトルの上でドラッグし、表で値と制約を書いて作り、フィットするウィンドウを、プラグインは `editors` で宣言できます(CasaXPS の Components ページのような画面です)。ウィンドウはアプリが描き、プラグインのコードはサンドボックスの Python で計算だけをします。プラグインの JavaScript は動きません。宣言は `actions` と同じく、入れる前に表示して確かめられ、項目ごとに検査されます。

```json
"editors": [{
  "kind": "spectrum-fit",
  "name": "xps",
  "title": "XPS Peak Fitting",
  "preview": "xps_preview",
  "fit": "xps_fit",
  "data": "spectrum",
  "x": "energy",
  "range": "region",
  "items": {
    "param": "components",
    "title": "Component",
    "fields": [
      {"key": "name", "title": "Name", "type": "text"},
      {"key": "shape", "title": "Line shape", "type": "text", "default": "GL(30)", "choices": ["GL(30)", "LA(1.53,243)"]},
      {"key": "position", "title": "Position (eV)", "constraint": true},
      {"key": "fwhm", "title": "FWHM (eV)", "default": 1.2, "constraint": true, "min": 0.05},
      {"key": "area", "title": "Area", "constraint": true, "min": 0}
    ],
    "drag": {
      "x": "position",
      "height": {"field": "area", "rule": "proportional"},
      "width": {"field": "fwhm", "rule": "full", "scale": ["area"]}
    },
    "coef": "{letter}_{key}"
  },
  "partner": {"title": "Doublet", "offset": "Δ (eV)", "ratios": [["p (1:2)", 0.5]],
              "ties": {"position": "{ref}+{offset}", "fwhm": "{ref}", "area": "{ref}*{ratio}"}},
  "settings": ["background", "shift"],
  "axis": {"label": "Binding Energy (eV)", "reverse": true}
}]
```

- `preview` と `fit` は、そのプラグインの Action の名前です。どちらも同じ引数を取ります: `data`(データの `wave`)、`x`(X の `wave`、省略可)、`range`(長さ 2 の `numbers`。プロット上の破線をドラッグして動かします)、`items.param`(`json`。項目のリスト)、`settings`(Settings タブに並ぶ、普通の値の引数)
- `kind` は画面の種類です。`"spectrum-fit"`(データ・範囲・背景の上の項目)と、下の `"view"` があり、知らない種類のエディタを持つプラグインは入れられません
- 項目(items)は A, B, C … と文字が付き、表では項目ごとに列が並びます。`fields` の `type` は `"number"`(既定)か `"text"`、`"constraint": true` の欄にはその下に制約の行が付きます
- `drag` は、プロット上のドラッグでどの欄がどう変わるかの決まりです。アプリはこの決まりどおりに動かすだけで、欄の意味は知りません。`x`: 頂上の四角を落とした X にする欄。`height`: 四角を上下に動かしたとき変わる欄で、`"proportional"` なら新旧の高さの比を掛け(面積のように高さに比例する量)、`"value"` なら高さそのもの(高さは preview が返す頂上と背景の差)。`width`: ◇ で変わる欄で、`"full"` なら ◇ の間の距離(FWHM)、`"half"` なら中心から ◇ までの距離。`scale` に挙げた欄には新旧の幅の比を掛けます(幅に比例して面積が増える形で高さを保つため)
- 項目は `{"<key>": 値, …, "constraints": {"<key>": "制約の文字列"}}` として渡ります。既定値のままの欄(`drag` が変える欄以外)は省くので、プラグインは欄がないときにその既定値を使います。制約の文字列の意味はプラグインが決めます。ただし、文字列の中で単独の大文字は項目を指すとみなし、項目を消したときにアプリが付け替えます
- `preview` は編集のたびに呼ばれ、履歴に残らず、Experiment も変えません。返すのは wave `x`(範囲の中の X)、`data`、`background`、`fit`、`residual`、`item0`, `item1`, …(各項目だけ。背景は含めない)、`all_x`・`all_y`(データ全体、灰色の点に)、そして `values` に `items`(項目ごとに `values`: 制約を当てはめた数値、`tied`: 他の項目に結ばれた欄、`peak`: `[x, 頂上の y, その下の背景]`)、`errors`(`{"item", "field", "message"}` のリスト)、`problem`(文字列か null)です
- `fit` は普通の Action の実行として履歴と解析結果に残ります。`values` の `items`(項目ごとの求まった数値)を表に戻し、`report`(`columns`、`rows`、`lines`、`warnings`)を Report タブに出します。`coef` を書くと、再び開いたときに、残った結果の係数(`A_position` など)から値を読み戻します
- ウィンドウのフィットは `replace=True` で実行します(下)

### 部品で組み立てる画面(view)

`spectrum-fit` が決まった形の画面なのに対し、`kind: "view"` のエディタは、画面の構成も操作への応答もプラグインの Python が決めます。描くのはアプリの部品(並べ方、タブ、入力欄、wave の選択、編集できる表、プロット、ボタン)だけで、プラグインの HTML や JavaScript は動きません。設計は [docs/design/plugin-views.md](https://github.com/ks250206/OresmePro/blob/main/docs/design/plugin-views.md) にあります。

```json
"editors": [{"kind": "view", "name": "eis", "title": "EIS Circuit Fitting"}]
```

```python
from oresme_plugin import ui, view, wave

@view("eis")
def eis_view(state, event, waves):
    if event["type"] == "open":
        state = {"frequency": None, "circuit": "R0-p(R1,CPE1)", "params": []}
    ...
    return {
        "state": state,
        "ui": ui.view(
            ui.row(ui.wave("Frequency (Hz)", "frequency"), ui.string("Circuit", "circuit")),
            ui.split(ui.plot([ui.series("im", "re", mode="markers")], equal=True),
                     ui.table("params", [ui.col("name", editable=False), ui.col("value", type="number")])),
            ui.button("Fit", action="eis_circuit", args={"circuit": ui.bind("circuit")}, replace=True),
        ),
        "waves": {"re": wave(...), "im": wave(...)},
        "message": None,
    }
```

- ハンドラは、画面のイベントのたびに `(state, event, waves)` で呼ばれます。`state` はアプリが持ち、毎回渡す値で、ハンドラ自身は何も覚えません。`waves` は、画面の `ui.wave` で選ばれた wave の**コピー**だけです(キーはその部品の `bind`)
- `event` は `open`(`last`: このプラグインが最後に残した結果)、`change`(`paths`: 変わった道筋。元に戻したときは `"*"`)、`command`(`id`: `ui.button(on=...)`)、`done`(`ui.button(action=...)` の実行が終わった: `args`(実行した引数。今の画面への結果か確かめるため)、`ok`、`values`、`result`、`error`)。ハンドラが状態の中で wave を選んだとき(`open` で前の結果から戻したときなど)は、アプリがその wave を付けて続けて `change` を送ります
- 返す `state`・`ui`・`message` を省くと前のまま、`waves` はその返事で描く配列だけ(Experiment には入りません)。`bind` は状態の中の道筋(`params.2.value`)で、入力した値はすぐ状態に入り、ハンドラにはまとめて伝わります。ウィンドウの中の編集は Ctrl+Z で戻せます
- Experiment を変えるのは `ui.button(action=...)` だけです。そのプラグインの action を、`args` の値(`ui.bind(道筋)` は押したときの状態の値)で実行し、履歴に `op.invoke(...)` として残ります。`replace=True` なら上の上書きの規則で実行します
- 部品は `ui.view`、`column`、`row`、`split`、`tabs`、`group`、`text`、`number`、`string`、`choice`、`checkbox`、`wave`、`table`(`ui.col` で列)、`plot`(`ui.series` で系列。`x_log`、`y_log`、`equal`、`x_reverse`)、`button` です。アプリは知らない部品や props があると全体を断り、理由を表示します

見本として、次のプラグインを置いています。

- 電気化学の解析(CV のピーク、Tafel、インピーダンスの等価回路フィット): [examples/plugins/electrochem](https://github.com/ks250206/OresmePro/tree/main/examples/plugins/electrochem)。view **EIS Circuit Fitting** で、回路とパラメータを編集しながら Nyquist・Bode 図を見て、フィットできます
- 3元相図: [examples/plugins/ternary](https://github.com/ks250206/OresmePro/tree/main/examples/plugins/ternary)。枠、グリッド、目盛りの数値、頂点の名前を、普通のトレースと文字マーカーで描き、グラフとして返します
- XPS のピークフィット(CasaXPS のような領域・Shirley/Tougaard 背景・GL/SGL/LA の線形・成分間の制約、RSF による定量): [examples/plugins/xps](https://github.com/ks250206/OresmePro/tree/main/examples/plugins/xps)。モデル編集ウィンドウ **XPS Peak Fitting** を持ちます([使い方](../xps/))。結合エネルギーの軸を反転し、残差を上に並べたグラフを返します
