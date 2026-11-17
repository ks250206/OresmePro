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
- `actions` の引数の型は `op.action` と同じです(`wave`、`waves`、`number`、`integer`、`numbers`、`string`、`boolean`、`choice`)。Action はここで宣言するので、コードを動かす前に内容を表示して確かめられます
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

見本として、次のプラグインを置いています。

- 電気化学の解析(CV のピーク、Tafel、インピーダンスの等価回路フィット): [examples/plugins/electrochem](https://github.com/ks250206/OresmePro/tree/main/examples/plugins/electrochem)
- 3元相図: [examples/plugins/ternary](https://github.com/ks250206/OresmePro/tree/main/examples/plugins/ternary)。枠、グリッド、目盛りの数値、頂点の名前を、普通のトレースと文字マーカーで描き、グラフとして返します
