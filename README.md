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
列が 1 列ずつ wave になります(数値の列は数値 wave、文字列の列はテキスト wave)。

初回は Python 本体(Pyodide)と NumPy・IPython を CDN から取得するため、起動に数秒かかります。
グラフや表の操作は Python の起動を待たずに使えます。

## できること

### wave とデータフォルダ

Igor と同じく、データの単位は **wave**(名前・スケーリング・単位・ノートを持つ配列)です。
表は wave を列として並べたビュー、グラフは wave を参照するビューで、wave を書き換えると表もグラフも追従します。
グラフや表で使用中の wave は削除できません。

- 数値の wave は 1〜4 次元です。最初の 2 次元には X・Y のスケーリング(開始値・刻み・単位)があります。
  2 次元 wave は `w[i, j]` の `i` が X 方向(横)です。3〜4 次元の wave は、表・画像・等高線で 1 面(レイヤーとチャンク)ずつ表示します。
- **日付**は 1970-01-01 UTC からの秒数として持ち、単位を `dat` にします(Igor と同じ流儀です)。
  CSV の日付の列(`2026-11-11 09:00` など)や NumPy の `datetime64` は自動でこの形になり、表では日付として表示・編集できます。
- テキストの wave(1 次元の文字列)も作れます。CSV の文字列の列はテキスト wave として読み込まれます。
- wave は**データフォルダ**に入れられます。`run1:signal` はフォルダ `run1` の中の `signal` です。
  データブラウザではツリーで表示され、wave をフォルダへドラッグして移動できます。

### グラフ

既存のチャートライブラリは使わず、専用のレンダラで描いています。

- 目盛りは 1-2-5 刻み。大きい値・小さい値は 1000 のべき乗を括り出し、軸ラベルに SI 接頭辞付きの単位(`mV`)か `×10³` として 1 回だけ表示します。対数軸は 10 のべき乗の主目盛りと 2–9 の副目盛りです。
- 余白は目盛りラベルの実測幅から自動で決まります。
- 自動スケールは Igor と同じくデータの範囲ちょうどです。軸は trace と重ならないよう、データ領域の少し外側に描きます。
- 点数が画素数よりずっと多い trace は、画素列ごとの最初・最小・最大・最後の点に間引いて描きます。見た目は変わらず、数百万点でも滑らかに動きます。
- trace のモード: `lines` / `markers` / `lines+markers` / `sticks` / `dots` / `cityscape` / `bars`。線種、マーカー 6 種、色、太さ、**誤差棒**(定数、または wave から点ごとに。X・Y とも)。
- **画像プロット**と**等高線**(2 次元 wave)。カラーテーブル 6 種、Z 範囲、カラースケールバー。等高線のレベルは本数指定(切りのよい値を自動選択)か値の列挙で、各レベルの値を線の上に書き込みます(オフにもできます)。
- 軸: 範囲、対数、ミラー軸、目盛りの向き、副目盛り、グリッド、ラベル。
  - **カテゴリ軸**: X にテキスト wave を指定すると、点が等間隔に並び、目盛りがその文字列になります。`bars` と組み合わせると棒グラフで、同じ軸の棒は横に並びます。
  - **日付軸**: 単位が `dat` の軸は、目盛りが切りのよい時刻・日・月・年になり、目盛りに出ない部分(日付や年)は軸ラベルに 1 回だけ出ます。
  - 標準の左・下・右・上に加えて、**名前を付けた軸を追加**できます(自由軸)。同じ側に複数あるときは外側へ並びます。
  - 軸ごとに**描画範囲**(プロット領域の何 % から何 % か)を指定でき、1 つのグラフの中にプロットを積み重ねられます。
- **カーソル A / B**: trace 上の点に置き、位置と A–B 間の差を情報バーに表示します。ドラッグか `←` `→`(`Shift` で 10 点)で動かせます。
- 凡例とテキストボックス。ラベルでは `^{...}` で上付き、`_{...}` で下付きになります(例: `cm^{-1}`)。
- 画面と同じ描画命令から **PDF**(ベクター)、SVG、PNG(3 倍解像度)を書き出します。カーソルは既定では入りません(Python の `g.save(..., cursors=True)` で入れられます)。

操作:

| 操作                            | 動作                                                    |
| ------------------------------- | ------------------------------------------------------- |
| グラフ内をドラッグ              | マーキー。離すと Expand / Shrink などのメニューが出ます |
| ホイール                        | カーソル位置を中心に拡大・縮小(軸の上では、その軸だけ)  |
| Alt + ドラッグ                  | 表示範囲の移動                                          |
| 軸・trace・画像をダブルクリック | 設定ダイアログ                                          |
| trace を右クリック              | その点にカーソル A / B を置く、trace の削除など         |
| `Ctrl+A` / `⌘A`                 | 自動スケール                                            |
| `Ctrl+I` / `⌘I`                 | カーソル情報バーの表示切り替え                          |

積み重ねたプロットでは、マーキーやホイールはポインタのある段の軸だけに効きます。

### コマンドウィンドウ

Igor と同じ「上に履歴、下にコマンドライン」の構成です。

- メニューやダイアログ、マウスでの操作は、等価な Python コードとして履歴に残ります。そのまま再実行できます。
- 履歴はリロードしても消えません。
- 実行結果がグラフのときは、履歴にその時点のサムネイルが入ります。
- Python の `input()` はコマンドラインで入力を受け付けます。

| キー                    | 動作                                                                   |
| ----------------------- | ---------------------------------------------------------------------- |
| `Enter`                 | 実行。文が途中(括弧が開いている、`:` で終わる等)なら改行               |
| `Shift+Enter`           | 改行                                                                   |
| `Ctrl+Enter` / `⌘Enter` | 常に実行                                                               |
| `↑` / `↓`               | 入力済みの文字列で始まるコマンドを履歴から呼び出す                     |
| `→` / `End`             | 薄く表示された候補(直近の一致コマンド)を確定。`Alt+→` で 1 語ずつ      |
| `Ctrl+R`                | 履歴のインクリメンタル検索                                             |
| `Tab`                   | Python の名前を補完                                                    |
| `Ctrl+C`                | 実行中の Python を中断。止まらないとき、もう一度押すと Python を再起動 |

履歴の項目をダブルクリックするとコマンドラインに入ります。

Python が中断の合図に気づくのはバイトコードの切れ目だけなので、大きな行列積のような 1 回の長い計算の途中では止められません
(ブラウザ上の Python の制約です)。その場合は 2 度目の `Ctrl+C` で Python を再起動します。
wave・グラフ・表は Python の外にあるので残り、失われるのは Python の変数だけです。

### 表

wave を列として表示・編集します。行も列も仮想スクロールなので、点数の多い wave や数千列の行列でも開けます。

- セルを選んで数字を打てば編集、`Enter` で下へ、`Tab` で右へ進みます。末尾の空セルに入力すると点が追加されます。
- **範囲選択**: ドラッグ、`Shift`+クリック、`Shift`+矢印キー。行番号をクリックすると行、列見出しをクリックすると列、`Ctrl+A` / `⌘A` で全体を選びます。
- **コピー・切り取り・貼り付け**: 選択範囲をタブ区切りでコピーします(表示桁数によらず全桁)。貼り付けは選択範囲の左上から入り、Excel などとやり取りできます。
- `Delete` で選択範囲をクリア(数値は NaN、テキストは空)。右クリックから、選択した行数ぶんの**点の挿入・削除**ができます。
- 表の上部に、選択中のセルの値(全桁)と、表示する**桁数**の設定があります。列の境界をドラッグすると列幅を変えられます(ダブルクリックで元に戻す)。桁数と列幅は実験ファイルに保存されます。
- 2 次元以上の wave は列ごとに展開して表示し、3〜4 次元では表示するレイヤーを表の上部で選びます。
- テキスト wave は文字列のまま、日付は日付として編集できます。

### 解析

**Analysis** メニューから実行できます。どれも Python の関数を呼び出すだけなので、実行したコマンドと結果は履歴に残ります。

- **Curve Fitting…**: `line`、多項式、`gauss`、`lor`、`exp`、`dblexp`、`sin`、`power`、`sigmoid` を最小二乗法(Levenberg–Marquardt)で当てはめます。
  初期値は自動で推定します。カーソル A–B 間だけを対象にもできます。
  係数の**固定**(`y0=0`)、**制約**(`A > 0, 2 < x0 < 5`)、点ごとの標準偏差による**重み付け**を指定できます。
  結果は `fit_<wave名>`(当てはめた曲線。元データのグラフに追加されます)、`W_coef`(係数)、`W_sigma`(標準偏差)に入ります。
- Wave Stats、微分、積分、平滑化、FFT(振幅スペクトル)、ヒストグラム。

### 保存

- wave・グラフ・表・ウィンドウ配置・履歴は、ブラウザの OPFS(Origin Private File System)に自動保存され、次に開いたときに復元されます。
- **File › Save Experiment As…**(`Ctrl+S` / `⌘S`)で、実験全体を 1 つの `.oresme` ファイルに保存できます。
  開くときは **File › Open Experiment…** か、ウィンドウへのドロップです。
- `.oresme` は zip で、中身は `experiment.json`(構成)、`waves/*.npy`(NumPy でそのまま読める wave データ)、`history.json` です。

## Python API

`oresme` モジュール(慣例として `op`)からアプリを操作します。Blender の `bpy` に当たるものです。

```python
# wave
w = op.make("signal", data, x0=0, dx=0.01, x_unit="s", unit="V")
w = op.wave("signal")            # 既存の wave
w.data                           # 読み取り専用の NumPy 配列(コピー)
w.data = w.data * 2              # 全体を書き換え
w[10:20] = 0                     # 一部を書き換え
np.sqrt(w), w + 1, np.mean(w)    # NumPy の関数や演算はそのまま使える
w.set_scale(x0=0, dx=0.5, unit="s"); w.unit = "V"; w.note = "..."
w.rename("volts"); w.duplicate("copy"); op.kill("copy")

m = op.make("map", np.zeros((64, 48)), dx=0.1, dy=0.1)   # 2 次元。m[i, j] の i が X
labels = op.make("labels", ["a", "b", "c"])              # テキスト wave

# データフォルダ
f = op.new_folder("run1")
f.make("signal", data)           # = op.make("run1:signal", data)
w.rename("run1:volts")           # フォルダへ移動
f.waves(); f.rename("archive:run1"); f.kill()

# グラフ
g = op.display(w)                # op.display(y1, y2, x=xwave) も可。配列を直接渡してもよい
g.trace("signal").set(mode="lines+markers", color="blue", line_size=1.5, y_error="err")
g.axis("left").set(label="Amplitude", range=(0, 1), log=False, mirror="ticks", minor=True, grid="major")
g.bottom.autoscale()
g.legend(); g.textbox("T = 300 K", anchor="LT")

g.add_axis("res", "left")                      # 自由軸
g.append("resid", axis="res")
g.left.span = (0, 0.7); g.axis("res").span = (0.75, 1)   # 上下に積む

gi = op.image(m, color_table="viridis")        # 画像プロット。op.contour(m, levels=10) は等高線
gi.append_contour(m, levels=[0.2, 0.5], color="white")
gi.colorscale()
op.image(cube, layer=2)                        # 3 次元 wave の 1 面

labels = op.make("days", ["Mon", "Tue", "Wed"])
gb = op.display(counts, x=labels)              # カテゴリ軸
gb.trace().mode = "bars"

t = op.make("when", np.array(["2026-11-11T09:00"], dtype="datetime64[s]"))   # 日付(単位 dat)

a = g.cursor("A", "signal", 120)               # カーソル。a.x, a.y, a.point
g.cursor("B", "signal", 300).x - a.x

g.save("figure.pdf")                           # .pdf / .svg / .png をダウンロード(cursors=True でカーソルも)

# 解析
r = op.fit("gauss", w)                         # r.coef, r.sigma, r["x0"], r.wave
op.fit(lambda x, a, k: a * np.exp(k * x), w, guess=[1, 0.1])
op.fit("exp", w, cursors=True)                 # カーソル A–B 間
op.fit("gauss", w, hold={"y0": 0}, bounds={"A": (0, None)}, sigma="err")   # 固定・制約・重み
op.stats(w); op.differentiate(w); op.integrate(w); op.smooth(w, 5); op.fft(w); op.histogram(w, bins=50)

# 表
t = op.edit(w, labels)
t.digits = 5                                   # 表示する桁数
```

`w.data` はコピーなので、`w.data[0] = 1` は wave を変更しません(読み取り専用なのでエラーになります)。
変更するときは `w[0] = 1` か `w.data = ...` を使います。
1 次元の wave は、末尾のすぐ先に書くと伸びます(`w[len(w)] = 1`)。`w.flat[a:b]` は、形によらず格納順で読み書きします。

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
  Canvas 2D・SVG・PDF の 3 つのバックエンドがそれを描きます。画面と書き出しが一致し、レイアウトは DOM なしでテストできます。

`SharedArrayBuffer` にはクロスオリジン分離(COOP / COEP ヘッダー)が必要です。開発サーバーとプレビューサーバーはヘッダーを付けます。
ヘッダーを設定できない静的ホスティングでは、同梱の Service Worker(`isolate-sw.js`)が代わりに付けるので、
`dist/` をそのまま置けば動きます。

### ディレクトリ

| 場所                | 内容                                                                            |
| ------------------- | ------------------------------------------------------------------------------- |
| `src/core/doc/`     | ドキュメントの型、コマンド、Undo、GUI 操作の Python への書き出し                |
| `src/core/plot/`    | 目盛り、間引き、等高線、レイアウト、Canvas / SVG / PDF バックエンド、ズーム計算 |
| `src/core/history/` | 履歴、履歴検索、ANSI 出力の解釈、入力が完結しているかの判定                     |
| `src/core/io/`      | `.npy` の読み書き、区切りテキストの読み込み、実験ファイル(`.oresme`)            |
| `src/kernel/`       | Python ワーカー、同期ブリッジ、`python/`(Python 側の API と解析)                |
| `src/app/`          | アプリの状態、自動保存、書き出し                                                |
| `src/ui/`           | React コンポーネント                                                            |

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
| グラフ                      | 専用レンダラ (Canvas 2D / SVG / PDF)     |
| 永続化                      | OPFS、`.oresme` ファイル (zip: fflate)   |

## 開発

```sh
pnpm dev        # 開発サーバー
pnpm check      # フォーマット、lint、型チェック
pnpm test       # 単体テスト
pnpm build      # dist/ にビルド
pnpm preview    # ビルド結果を配信
pnpm e2e        # E2E テスト(先に pnpm build が必要)
```

### Pyodide の同梱

Python(Pyodide)本体と、起動時に使う NumPy・IPython とその依存パッケージは、アプリと一緒に配信します。
`pnpm dev` / `pnpm build` / `pnpm test` の前に `scripts/fetch-pyodide.mjs` が走り、`public/pyodide/` に用意します
(本体は npm パッケージから、パッケージは初回だけダウンロードしてハッシュを検証。このディレクトリはリポジトリには入れません)。
これにより、ビルドしたアプリは起動に外部への接続を必要としません。

SciPy や pandas など起動時に使わないパッケージは同梱せず、`import` した時点で CDN(jsDelivr)から取得します。
Pyodide 一式の取得元は環境変数 `VITE_PYODIDE_URL` で変更できます。

### テスト

- **単体テスト**(`pnpm test`、Vitest): `src/core/` のロジックと、Python API。
  `src/kernel/kernel.test.ts` は本物の Pyodide を Node 上で起動し、Python API を実際のドキュメントに対して動かします。
- **E2E テスト**(`pnpm e2e`、Playwright): ビルドしたアプリを Chromium で操作します。コマンドウィンドウのキー操作、
  グラフのマウス操作、表、ファイルの読み込みと保存、Python の中断などを、テストごとに新しいブラウザ(と Python)で確認します。
  既にインストール済みの Chromium を使うときは `PLAYWRIGHT_CHROMIUM_PATH` にそのパスを指定します。
- **CI**(`.github/workflows/ci.yml`): push のたびに、チェック、単体テスト、ビルド、E2E テストを順に実行します。

## 制限

- Python を 1 回の長い計算の途中で止めることはできません(上の「コマンドウィンドウ」を参照)。
- 日付は UTC として扱います。タイムゾーン付きの文字列は読み込み時に UTC へ換算され、表示は UTC です。
- PDF の文字は、欧文・ギリシャ文字・数学記号はビューア内蔵のフォントでベクターとして、
  日本語などそれ以外の文字は 4 倍解像度の画像として入ります。
- 等高線のラベルは 1 レベルにつき 1 か所(いちばん長い線の中央)です。
- 棒グラフの棒の幅は、対数の X 軸では正しく計算されません。
- 3〜4 次元の wave を一度に立体的に表示する機能(ボリューム表示など)はありません。1 面ずつの表示です。

## ライセンス

未定。
