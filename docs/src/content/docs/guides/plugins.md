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

wave の引数は `Wave`(`.data` は読み取り専用の NumPy 配列。`.x`、`.dx`、`.unit` なども使えます)として渡されます。`values` の `result` に `names`、`coef`、`sigma` を入れると、解析結果として残ります。

見本として、電気化学の解析(CV のピーク、Tafel、インピーダンスの等価回路フィット)を [examples/plugins/electrochem](https://github.com/ks250206/OresmePro/tree/main/examples/plugins/electrochem) に置いています。
