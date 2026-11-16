---
title: コマンド履歴と Python スクリプト
sidebar:
  order: 10
---

## 履歴を再利用する

コマンドウィンドウでは **↑ / ↓** で入力の先頭に一致する履歴を呼び出し、**Ctrl+R** で検索します。画面操作の一部は対応する Python コードとして履歴に表示されます。再実行すると再びデータが変更される操作もあるため、対象 Wave やウィンドウ名を確認してください。

## Procedure に保存する

**Windows → New Procedure…** でエディタを開き、Python を入力して **Run** を押します。**Shift+Enter** では選択範囲または現在行、**Ctrl+Enter**（macOS では **⌘+Enter**）ではファイル全体を実行できます。Procedure は Experiment に保存されます。Python から作成する場合は `op.new_procedure(name, code)` を使います。

### 名前空間と import

Procedure はそれぞれ `<名前>.py` というファイルで、名前がそのままモジュール名です(そのため名前は ASCII の英数字と `_` だけ)。

- **Run**(`p.run()`)はファイルを**コマンドウィンドウと同じ名前空間**で実行します。定義した関数や変数はそのままコマンド入力から使えます。
- `import 名前` で読み込むと、Procedure ごとに**別の名前空間**(モジュール)になります。ほかの Procedure からも `import tools` や `from tools import scaled` で使えます。Procedure の中身を変えると、次の入力の前に読み込み直されます。

```python
# Procedure "tools"
SCALE = 3
def scaled(x):
    return SCALE * x

# Procedure "analysis"
import tools
result = tools.scaled(2)   # 6。analysis 側の SCALE とはぶつからない
```

名前を変えるとモジュール名も変わるので、`import` している側も書き換えてください。

### 書き出しと読み込み

Procedure ウィンドウを右クリックして **Export as 名前.py** を選ぶと `.py` ファイルとして保存できます。**Windows → Import Procedure…**(または同じ右クリックメニュー)で `.py` ファイルを Procedure として取り込みます。名前はファイル名から付けます(使えない文字は `_`、同じ名前があれば `_0` などを付ける)。

取り込んだコードは**実行されません**。Experiment を開いたときの自動実行もオフの状態で入るので、中身を確認してから **Run** するか、**Run When the Experiment Opens** をオンにしてください。他人から受け取った `.py` には任意のコードを書けるため、信頼できるものだけを実行してください。Python からは `op.new_procedure(name, code, auto_run=False)` で同じことができます。

コマンド入力には `np` と `op` が初期設定されています。Procedure に `import numpy as np` と `import oresme as op` を書いておくと依存が明確です。SciPy、pandas、scikit-learn、lmfit は利用時に読み込まれます。長い処理を止めるには **Python → Interrupt** を使います。Python を再起動するとセッション変数は消えますが、Experiment の Wave はアプリ側に残ります。

### Procedure Browser

**Python → Procedure Browser** で、実験の Procedure と、その中で定義したクラス・関数を、入れ子のまま一覧できます(Igor の Procedure Browser に当たります)。

- **Signatures** をオンにすると、引数(`(r, *, pi=3.14)`)と戻り値の注釈も表示します
- 関数やクラスをクリックすると、その Procedure を開いて(閉じていれば開き直して)、定義の行にカーソルを置きます
- ファイルを選んで **Export**(`name.py` として保存)、**Run**(実行)できます。**New…** と **Import…** もここから使えます。右クリックで名前の変更もできます
- 一覧はエディタと同じ構文解析で作るので、Python が動いていなくても、文法の誤りがあっても読める範囲で表示します

## 変数を見る・消す

**Python → Variables** で、コマンド入力や Procedure が作った変数を、名前・型・値の概要とともに一覧できます(変数エクスプローラー)。入力を実行するたびに更新します。

- 配列は形と型(`2×3 float64`)、リストや dict は要素数と先頭、関数は引数を表示します
- ダブルクリック(または右クリックの **Show Value**)で、値をコマンドウィンドウに表示します
- チェックを付けて **Drop** すると、`del a, b` を実行してその変数を消します。**Drop All…** は確認のあとで、一覧の変数をすべて消します。どちらも履歴に残ります
- 起動時からある `np`、`op`、IPython の名前、`_` で始まる名前、モジュールは一覧に出ないので、誤って消して Python が使えなくなることはありません

## パッケージを追加する

NumPy・SciPy・pandas・scikit-learn・lmfit など、Pyodide に同梱されたパッケージは `import` するだけで読み込まれます。
それ以外は **Python → Packages…** か、コマンド入力の `%pip` で追加します。

```python
%pip install pybaselines impedance      # PyPI から(依存も一緒に)
%pip install statsmodels                # Pyodide 同梱のものはそこから
%pip list                               # Python に入っているもの全部
%pip freeze                             # この実験が使うもの(name==version)
%pip show pybaselines
%pip uninstall impedance
await op.install("emcee==3.1.6")        # Python から。結果は op.packages()
```

- 入れたパッケージは、名前・バージョン・wheel・SHA-256・依存関係として**実験に記録**されます。実験を開くたび・Python を再起動するたびに、記録どおりのバージョンが自動で入り直してから Procedure が動きます(履歴に `await op.install()` が残ります)。
- PyPI の wheel はブラウザに保存され、同じパッケージを使う実験どうしで共有されます。一度入れたものはオフラインでも入れ直せます。
- 他の人から受け取った `.oresme` を開くとき、PyPI のパッケージを使っていれば入れるかどうかを確認します(import するとそのコードが動くため)。断った場合は **Python → Packages…** の **Install Them** であとから入れられます。
- **Python → Packages…** では、この実験のパッケージとそれが連れてきた依存をツリーで表示し、Python の中での状態(未導入・導入済み・import 済み)も示します。おすすめ(pybaselines、impedance、statsmodels、PyWavelets、uncertainties、emcee、iminuit、pint、sympy など)はワンクリックで入れられ、**Copy Requirements** で一覧をコピーできます。下の **In Python now** の表は、プリインストール(NumPy・IPython など)、アプリ同梱で import 時に読み込まれるもの(SciPy・pandas・scikit-learn・lmfit など。import 前も版付きで表示)、この実験のものを含め、Python のパッケージを版と状態(import 済み・読み込み済み・未読み込み)つきで表示します。
- 入れられるのは、pure Python の wheel と Pyodide 向けにビルドされたものだけです。Pyodide に同梱されたパッケージの一覧は [Packages in Pyodide](https://pyodide.org/en/stable/usage/packages-in-pyodide.html) にあります。Pyodide にない独自のコンパイル済みコードを持つパッケージ(Numba、PyTorch など)は動きません。
- `%pip uninstall` で記録から外れます。すでに import したモジュールは Python を再起動するまで残ります。

## 変更をまとめて反映する

`with op.atomic():` の中の変更は、ブロックが例外なく終わったときに 1 回の Undo 単位としてまとめて Experiment に入ります。途中で例外が起きると何も残りません。ブロックの中の Python には自分の変更が見えますが、画面にはブロックが終わるまで何も表示されません。

```python
with op.atomic():
    corrected = op.make("corrected", raw.data - background.data)
    op.display(corrected)
```

`op.fit`、`op.fit_peaks`、`op.background` など Wave と結果を作る解析は、それぞれこのブロックの中で動きます。ブロックの実行中に画面で行った変更は、ブロックの変更とぶつからなければ両方残ります。ブロックが読んだ Wave が途中で変わっていた場合は何も残さず `OresmeError` になります。ブロックの中ではグラフを描画・保存できません。

## 解析を名前で呼ぶ

解析は `core.fit` のような名前と引数の型を付けて **Action** として登録されています。パネルやプラグインは、Python のコードではなく名前と JSON の値を渡して呼びます。Python からは `op.invoke` で同じように呼べます。

```python
op.actions()                                                    # 登録された Action の一覧
r = op.invoke("core.fit", {"function": "gauss", "y": "signal"})  # op.fit("gauss", op.wave("signal")) と同じ
```

引数は呼ぶ前に検査され、知らない Action や版、余分な引数・足りない引数、型の違い、選択肢にない値、範囲外の数、存在しない Wave は、何もせずに `OresmeError` になります。通った呼び出しは `op.atomic()` の中で動きます。

Procedure の関数も `@op.action` で登録できます。`core.` は本体、`plugin.` はプラグイン用の名前なので、それ以外の小文字の点区切りの名前を使います。

```python
@op.action("lab.normalize", title="Normalize", params={
    "wave": {"type": "wave", "title": "Wave"},
    "to": {"type": "number", "default": 1.0, "min": 0},
})
def normalize(wave, to=1.0):
    return op.make(f"{wave.name}_norm", wave.data / np.nanmax(wave.data) * to)
```

引数の型は `wave`、`waves`、`number`、`integer`、`numbers`、`string`、`boolean`、`choice` です。数には `min` と `max`、リストには `length`、選択肢には `choices` を付けられます。`default` は関数の既定値と同じにします。省略した引数は関数に渡されません。

画面から呼んだ Action は、同じ意味の Python(`op.fit("gauss", op.wave("signal"))` など)として履歴に残ります。パネルのボタンも Action を呼びます([パネル](../panels/))。

[Python API の使い方](../../reference/) · [Procedure](../../reference/api/procedure/) · [atomic](../../reference/api/global/#atomic) · [Actions API](../../reference/api/actions/)
