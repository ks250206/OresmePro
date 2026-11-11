# OresmePro

OresmePro は、実験データの読み込み・表編集・グラフ作成・解析を 1 つのワークスペースで行う、
ブラウザで動く科学データ解析環境です。WaveMetrics の Igor Pro の作業感
(wave、グラフ、コマンドウィンドウ、「GUI 操作がすべてコマンドとして履歴に残る」こと)を手本にしつつ、
スクリプト言語には Python を採用しています。

[scispace_poc](https://github.com/ks250206/scispace_poc) での試作を踏まえて、一から作り直したものです。

## 名前の由来

名前は 14 世紀フランスの学者 **ニコル・オレーム**(Nicole Oresme, 1320 頃–1382)にちなみます。

オレームは『質と運動の図形化について』(_Tractatus de configurationibus qualitatum et motuum_, 1350 年代)で、
変化する量を図として描く方法を示しました。横方向に時間などの広がり(_longitudo_)を、
縦方向にその時点での強さ(_latitudo_)をとるもので、デカルトの座標幾何学より約 300 年早く、
**世界で初めてグラフをプロットした人物**とされています。
彼はこの図を使い、等加速度運動で進む距離が「速度–時間グラフの下の面積」に等しいこと(平均速度定理)を幾何学的に証明しました。

データを図にして初めて見えるものがある、という OresmePro の中心にある考えは、オレームのこの仕事に遡ります。

## 使ってみる

```sh
pnpm install
pnpm dev
```

開いたら、下のコマンドウィンドウに Python を入力します(`np` と `op` は読み込み済みです)。

```python
x = np.linspace(0, 10, 2000)
signal = op.make("signal", np.sin(2 * np.pi * x) * np.exp(-x / 3), dx=x[1] - x[0], x_unit="s", unit="V")
g = op.display(signal)
g.axis("left").label = "Amplitude"
g.trace("signal").color = "blue"
g.legend()
```

CSV / TSV ファイルは、ウィンドウにドロップするか **File › Load Delimited Text…** で読み込めます。
数値の列が 1 列ずつ wave になります。

初回は Python 本体(Pyodide)と NumPy・IPython を CDN から取得するため、起動に数秒かかります。
グラフや表の操作は Python の起動を待たずに使えます。

## できること

### wave

Igor と同じく、データの単位は **wave**(名前・X スケーリング・単位・ノートを持つ数値配列)です。
表は wave を列として並べたビュー、グラフは wave を参照するビューで、wave を書き換えると表もグラフも追従します。
グラフや表で使用中の wave は削除できません。

### グラフ

既存のチャートライブラリは使わず、専用のレンダラで描いています。

- 目盛りは 1-2-5 刻み。大きい値・小さい値は 1000 のべき乗を括り出し、軸ラベルに SI 接頭辞付きの単位(`mV`)か `×10³` として 1 回だけ表示します。対数軸は 10 のべき乗の主目盛りと 2–9 の副目盛りです。
- 余白は目盛りラベルの実測幅から自動で決まります。
- 自動スケールは Igor と同じくデータの範囲ちょうどです。軸は trace と重ならないよう、データ領域の少し外側に描きます。
- 点数が画素数よりずっと多い trace は、画素列ごとの最初・最小・最大・最後の点に間引いて描きます。見た目は変わらず、数百万点でも滑らかに動きます。
- trace のモード: `lines` / `markers` / `lines+markers` / `sticks` / `dots` / `cityscape`。線種、マーカー 6 種、色、太さを設定できます。
- 軸: 左・下・右・上。範囲、対数、ミラー軸、目盛りの向き、副目盛り、グリッド、ラベル。
- 凡例とテキストボックス。ラベルでは `^{...}` で上付き、`_{...}` で下付きになります(例: `cm^{-1}`)。
- 画面と同じ描画命令から SVG と PNG(3 倍解像度)を書き出します。

操作:

| 操作                        | 動作                                                    |
| --------------------------- | ------------------------------------------------------- |
| グラフ内をドラッグ          | マーキー。離すと Expand / Shrink などのメニューが出ます |
| ホイール                    | カーソル位置を中心に拡大・縮小(軸の上では、その軸だけ)  |
| Alt + ドラッグ              | 表示範囲の移動                                          |
| 軸や trace をダブルクリック | 設定ダイアログ                                          |
| `Ctrl+A` / `⌘A`             | 自動スケール                                            |
| 右クリック                  | trace の追加・削除、凡例、書き出しなど                  |

### コマンドウィンドウ

Igor と同じ「上に履歴、下にコマンドライン」の構成です。

- メニューやダイアログ、マウスでの操作は、等価な Python コードとして履歴に残ります。そのまま再実行できます。
- 履歴はリロードしても消えません。
- 実行結果がグラフのときは、履歴にその時点のサムネイルが入ります。

| キー                    | 動作                                                              |
| ----------------------- | ----------------------------------------------------------------- |
| `Enter`                 | 実行。文が途中(括弧が開いている、`:` で終わる等)なら改行          |
| `Shift+Enter`           | 改行                                                              |
| `Ctrl+Enter` / `⌘Enter` | 常に実行                                                          |
| `↑` / `↓`               | 入力済みの文字列で始まるコマンドを履歴から呼び出す                |
| `→` / `End`             | 薄く表示された候補(直近の一致コマンド)を確定。`Alt+→` で 1 語ずつ |
| `Ctrl+R`                | 履歴のインクリメンタル検索                                        |
| `Tab`                   | Python の名前を補完                                               |
| `Ctrl+C`                | 実行中の Python を中断                                            |

履歴の項目をダブルクリックするとコマンドラインに入ります。

### 表

wave を列として表示・編集します。行は仮想スクロールなので、点数の多い wave でも開けます。
セルを選んで数字を打てば編集、`Enter` で下へ、`Tab` で右へ進みます。
末尾の空セルに入力すると点が追加されます。Excel などからの貼り付けにも対応しています。

### 保存

wave・グラフ・表・ウィンドウ配置・履歴は、ブラウザの OPFS(Origin Private File System)に自動保存され、
次に開いたときに復元されます。wave のデータは `.npy` 形式です。

## Python API

`oresme` モジュール(慣例として `op`)からアプリを操作します。Blender の `bpy` に当たるものです。

```python
# wave
w = op.make("signal", data, x0=0, dx=0.01, x_unit="s", unit="V")
w = op.wave("signal")            # 既存の wave
w.data                           # 読み取り専用の NumPy 配列(コピー)
w.data = w.data * 2              # 全体を書き換え
w[10:20] = 0                     # 一部を書き換え
np.sqrt(w), w + 1, w.x           # NumPy の関数や演算はそのまま使える
w.set_scale(x0=0, dx=0.5, unit="s"); w.unit = "V"; w.note = "..."
w.rename("volts"); w.duplicate("copy"); op.kill("copy")

# グラフ
g = op.display(w)                # op.display(y1, y2, x=xwave) も可。配列を直接渡してもよい
g.append("other", axis="right")
g.trace("signal").set(mode="lines+markers", color="blue", line_size=1.5, marker="square")
g.axis("left").set(label="Amplitude", range=(0, 1), log=False, mirror="ticks", minor=True, grid="major")
g.bottom.autoscale()
g.legend(); g.textbox("T = 300 K", anchor="LT")
g.svg()                          # SVG 文字列

# 表
t = op.edit(w, "other")
```

`w.data` はコピーなので、`w.data[0] = 1` は wave を変更しません(読み取り専用なのでエラーになります)。
変更するときは `w[0] = 1` か `w.data = ...` を使います。

IPython の上で動いているので、`obj?`、`%timeit`、`%pwd` などのマジックや、最上位の `await` も使えます。
SciPy や pandas など Pyodide に含まれるパッケージは、`import` した時点で自動的に取得されます。

## 設計

```
メインスレッド                              Web Worker
┌──────────────────────────────┐          ┌─────────────────────┐
│ Doc(wave・グラフ・表)       │◀─ 同期 ─▶│ Pyodide + IPython   │
│   ↑ すべての変更は Command   │   RPC    │   import oresme     │
│ GUI(React)── echo ─▶ 履歴  │          │                     │
└──────────────────────────────┘          └─────────────────────┘
```

- **ドキュメントはメインスレッドにあります。** wave のデータ(`Float64Array`)もここに置きます。
  Python はそのクライアントなので、Python を再起動しても、無限ループで強制終了しても、wave やグラフは失われません。
  グラフや表の操作は Python の起動や実行を待ちません。
- **すべての変更は 1 つの関数を通ります。** GUI も Python も `applyCommand(state, command)` に同じコマンドを渡します。
  コマンドは不変の状態を返す純粋関数で、Undo は以前の状態に戻すだけです(変更のない wave は共有されます)。
  Python の 1 回の実行は 1 つの Undo 単位になります。
- **Python からの呼び出しは同期です。** `w.data` のような式は次の行に進む前に答えが必要ですが、
  Python を実行中のワーカーはメッセージを受け取れません。そこでワーカーは要求を送ったあと `SharedArrayBuffer` 上で
  `Atomics.wait` で待ち、メインスレッドがそこに答えを書き込んで起こします。
- **グラフは描画命令のリストを経由します。** `layoutGraph()` がグラフ定義とサイズから線・文字などの命令のリストを作る純粋関数で、
  Canvas 2D と SVG の 2 つのバックエンドがそれを描きます。画面と書き出しが一致し、レイアウトは DOM なしでテストできます。

`SharedArrayBuffer` にはクロスオリジン分離(COOP / COEP ヘッダー)が必要です。開発サーバーとプレビューサーバーはヘッダーを付けます。
ヘッダーを設定できない静的ホスティングでは、同梱の Service Worker(`isolate-sw.js`)が代わりに付けるので、
`dist/` をそのまま置けば動きます。

### ディレクトリ

| 場所                | 内容                                                               |
| ------------------- | ------------------------------------------------------------------ |
| `src/core/doc/`     | ドキュメントの型、コマンド、Undo、GUI 操作の Python への書き出し   |
| `src/core/plot/`    | 目盛り、間引き、レイアウト、Canvas / SVG バックエンド、ズーム計算  |
| `src/core/history/` | 履歴、履歴検索、ANSI 出力の解釈、入力が完結しているかの判定        |
| `src/core/io/`      | `.npy` の読み書き、区切りテキストの読み込み                        |
| `src/kernel/`       | Python ワーカー、同期ブリッジ、`python/oresme.py`(Python 側の API) |
| `src/app/`          | アプリの状態、自動保存、書き出し                                   |
| `src/ui/`           | React コンポーネント                                               |

`src/core/` は DOM にも React にも依存しません。

## 技術スタック

| 用途                        | 採用                                     |
| --------------------------- | ---------------------------------------- |
| ランタイム / パッケージ管理 | Node.js 26 / pnpm 12                     |
| ツールチェーン              | Vite+ (`vp`)                             |
| UI                          | React 19, Tailwind CSS 4                 |
| 表                          | TanStack Table(列)+ TanStack Virtual(行) |
| 履歴ビュー                  | TanStack Virtual                         |
| コマンドライン              | CodeMirror 6                             |
| スクリプト言語              | Python 3.14 (Pyodide 314 + IPython 9)    |
| グラフ                      | 専用レンダラ (Canvas 2D / SVG)           |
| 永続化                      | OPFS                                     |

## 開発

```sh
pnpm dev        # 開発サーバー
pnpm check      # フォーマット、lint、型チェック
pnpm test       # テスト
pnpm build      # dist/ にビルド
pnpm preview    # ビルド結果を配信
```

`pnpm test` のうち `src/kernel/kernel.test.ts` は、本物の Pyodide を Node 上で起動して Python API を実際のドキュメントに対して動かします。
初回は NumPy と IPython を取得するためネットワークが必要です(`node_modules/.cache/pyodide` にキャッシュされます)。

Pyodide の取得元は環境変数 `VITE_PYODIDE_URL` で変更できます(既定は jsDelivr)。

## まだないもの

- データフォルダ(現在は `root` 直下のみ)、多次元 wave、テキスト wave
- グラフのカーソル A/B、自由軸、軸の分割表示、画像プロット、等高線、誤差棒
- PDF 書き出し
- 実験全体を 1 ファイルに保存・読み込みする機能(現在はブラウザ内への自動保存のみ)
- カーブフィッティングなどの解析ダイアログ(Python からは `from scipy.optimize import curve_fit` のように書けば使えます)
- Python の `input()`
- 長い C 拡張の呼び出し(大きな行列積など)の途中での中断。`Ctrl+C` はその呼び出しが終わった時点で効きます。待てないときは **Python › Restart Python** を使います(wave やグラフは残ります)

## ライセンス

未定。
