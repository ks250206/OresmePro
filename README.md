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

メニューバーのコマンドは、ウィンドウの後ろのデスクトップを右クリックしても出せます。
メニューバーのメニューがそれぞれサブメニューになり、使える・使えない、チェック、ショートカットも同じです。
ウィンドウの上の右クリックは、これまでどおりそのウィンドウのメニューです。

CSV / TSV などのテキストと **Excel のブック**(`.xlsx` / `.xlsm`)は、ウィンドウにドロップするか
**File › Load Delimited Text…** / **Load Excel Workbook…** で読み込みます。読み込む前に **Load Data** ダイアログが開き、
ファイルがどう読まれるかを先頭 100 行のプレビューで確認して、そのまま **Load** を押すか、判定を直してから読み込めます。

列が 1 列ずつ wave になります。指定しなかったものは自動で判定します。

- **文字コード**: BOM、なければ UTF-8・Shift_JIS・EUC-JP のうちバイト列が正しく読める最初のもの。
- **区切りと表の位置**: タブ・カンマ・セミコロン・空白のうち、行の列数がそろい始める位置がいちばん早いもの。
  測定装置が表の前に書く数行(装置名、日付など)は読み飛ばします。行数を自分で指定することもできます。
- **ヘッダー**: 1 行目の文字列の下が数値や日付の列ならヘッダー、1 行目も下と同じ数値・日付ならデータと見ます。
- **単位**: `Voltage (V)` や `I [mA]` のようなヘッダーは、名前 `Voltage` と単位 `V` に分けます。
  `Ewe/V` の形や、ヘッダーの下の単位の行から取ることもできます。
- **列の型**: 空でないセルがすべて数値か欠損値の印のときだけ数値の列、すべて日付か欠損値の印のときだけ日付の列になり、
  文字列が 1 つでも混じる列は、すべてのセルを書かれたとおりに持つテキスト wave になります。
  欠損値の印(`NaN`、`NA`、`N/A`、`#N/A`、`null`、`None`、`-`、`--`、Excel のエラー値 `#DIV/0!` など)と空のセルは NaN、
  `inf`・`-inf`・`Infinity` は無限大として読みます。小数点がカンマのファイル(`1,5`)は **Decimal comma** を選びます。

ダイアログでは列ごとに wave 名・単位・型(数値 / 日付 / 文字列 / 読まない)を指定できます。
型を指定した列で、その型として読めないセルは NaN になり、プレビューで赤く表示され、件数が履歴にも残ります。
列の役割として **X**(グラフの横軸)と **± of …**(その列の誤差)を選んで **Make a graph** にチェックすると、読み込みと同時にグラフができます。

- **プリセット**: 設定に名前を付けて保存できます(**Save As…**)。対象のファイル名のパターン(`*.mpt` など)を付けておくと、
  合うファイルを開いたときに自動で選ばれます。プリセットはブラウザに保存され、別の実験でも使えます。**Export… / Import…** で JSON として受け渡せます。
- **複数のファイル**: まとめてドロップすると 1 つずつダイアログが出ます。**Load the other … the same way** で残りを同じ設定で読み込みます。
- **元ファイルの記録**: **Keep the file with the experiment**(既定でオン)で、元ファイルを実験と一緒に保存し、
  履歴には同じ読み込みを再現する Python(`op.load_text("run.csv", decimal=",", …)`)が入ります。
  wave のノートには、ファイル名とその内容の SHA-256 が残ります。

Excel では、セルのあるシートごとに表が 1 つ開きます(読むシートはダイアログで選べます)。数値は表示形式ではなく保存されている値そのもの、
数式は計算済みの値、日付の書式のセルは日付 wave になります。表の上にあるタイトル行や、空の行・列は読み飛ばします。古い `.xls` は `.xlsx` に保存し直してください。

Python からも同じ読み込みができます。

```python
waves = op.load_text("run.csv", decimal=",", skip=3,
                     columns={0: {"name": "t", "unit": "s"}, 4: {"type": "skip"}},
                     graph=True, x=0, errors={1: 2})
sheets = op.load_excel("bench.xlsx", sheets="Run 1")     # {シート名: [wave, …]}
op.load_text("cell3.mpt", preset="EC-Lab")               # ダイアログで保存したプリセット
```

**Igor Pro のファイル**も読み込めます。バイナリウェーブ(`.ibw`)と、パックド実験(`.pxp`、テンプレートの `.pxt`)の wave です。
ウィンドウにドロップするか **File › Load Igor Files…** で、ダイアログを経ずにすぐ読み込みます(ファイルが中身をそのまま記述しているので、判定することがありません)。

- `.ibw` は 1 ファイルが 1 つの wave です。`.pxp` は、すべての wave を元のデータフォルダごと、いま開いている実験に加えます。
  フォルダは必要なものが作られ、同じ名前のフォルダがあればその中に入ります。wave のないデータフォルダは作りません。
  どちらも 1 回の Undo で取り消せます。表やグラフは開きません。
- 値・型・次元(1〜4)・X と Y のスケーリングと単位・値の単位・wave のノートを引き継ぎます。
  Igor は最初の次元(行)を先に並べて保存しますが、読み込むときにこのアプリの並びに直すので、`w[i, j]` の意味は Igor の `w[i][j]` と同じです。
- バージョン 1・2・3・5 の、Mac(ビッグエンディアン)と Windows(リトルエンディアン)のどちらで書かれたファイルも読めます。
  ヘッダーのチェックサムを確かめ、途中で切れている・壊れている・Igor のファイルではない場合は、何も読み込まずに理由を表示します。一部だけを黙って読むことはしません。
- wave のノートの先頭には、元のファイル名とその SHA-256、Igor での wave のパス、バージョンと型が入ります。
  Igor でのノートは、その下の `Igor's note:` の行に続けてそのまま入ります(改行だけ LF に揃えます)。
  そのままの形では引き継げなかったものも、ノートに書かれます。
  - 64 ビット整数の wave は `float64` になります。2⁵³ を超えていて丸められた値があれば、その数も書かれます。
  - 3・4 次元目のスケーリングと単位(このアプリの wave は最初の 2 次元にしかスケーリングを持たないため)。
  - 2 次元以上のテキスト wave は、Igor の点の順(最初の添字が先)に並べた 1 次元のテキスト wave になります。
  - 複素数の整数型の wave は、値を正確に表せる `complex64`(8・16 ビット)か `complex128`(32 ビット)になります。
  - 次元ラベルは読み込みません。従属関係の式(dependency formula)は引き継がず、保存されている値を読みます。
    値が保存されていない従属 wave は読み込まず、そう表示します。
- Igor で使える名前(空白や記号を含む名前、数字で始まる名前)は、このアプリで使える名前に直します(`'raw data'` → `raw_data`、`'2nd'` → `wave_2nd`)。
  同じ名前の wave がすでにあれば `_1` などを付け、上書きはしません。直した名前は履歴に残ります。
- 名前・単位・ノート・テキスト wave の文字は、UTF-8 として正しければ UTF-8(Igor 7 以降)、そうでなければ
  Shift_JIS(2 バイト文字を含み、Shift_JIS として正しいとき)、それ以外は Mac で書かれたファイルなら MacRoman、
  Windows で書かれたファイルなら Windows-1252 として読みます。どのバイトも何かの文字になるので、文字が落ちることはありません。
  UTF-8 以外で読んだときは、ノートにそう書かれます。
- `.pxp` の wave 以外のもの(グラフ・表などのウィンドウ、プロシージャ、変数と文字列変数、履歴)は読み込みません。
  履歴には、読み込んだ wave の数とフォルダ、直した名前、読み込まなかったものが書かれます。

```python
op.load_igor("scan.ibw")        # [wave]
op.load_igor("session.pxp")     # すべての wave のリスト。w.name はフォルダ付き("raw_data:signal")
```

Python 本体(Pyodide)と NumPy・IPython はアプリと一緒に配信され、起動に数秒かかります。
グラフや表の操作は Python の起動を待たずに使えます。

## できること

### wave とデータフォルダ

Igor と同じく、データの単位は **wave**(名前・スケーリング・単位・ノートを持つ配列)です。
表は wave を列として並べたビュー、グラフは wave を参照するビューで、wave を書き換えると表もグラフも追従します。
グラフや表で使用中の wave は削除できません。

- 数値の wave は 1〜4 次元です。最初の 2 次元には X・Y のスケーリング(開始値・刻み・単位)があります。
- 空の(0 で埋まった)wave は **Data › Make Waves…** で作ります。名前はカンマか空白で区切って複数まとめて書け、
  点数(行・列・レイヤー・チャンク)、型、X のスケーリングと単位、データの単位、入れるデータフォルダを選べます。
  名前は打つそばから確かめ、既にある名前は「Overwrite existing waves」を入れない限り何も作らずに断ります。
  何本作っても Undo 1 回で戻り、履歴には 1 本ごとに `op.make("w", n=(20, 30), dtype="float32")` のような行が残ります。
  データブラウザのフォルダや空いたところの右クリックからも開けます。
- 数値の**型**は `float64`(既定)、`float32`、`int8`〜`int32`、`uint8`〜`uint32`、複素数の `complex128` / `complex64` です。
  メモリ上もその型の配列で持つので、`uint16` の画像は `float64` の 1/4 で済みます。`.oresme` の中の `.npy` もその型で保存されます。
  - 型は NumPy の配列からそのまま引き継ぎます(`op.make("img", frame)` で `uint16` の配列を渡せば `uint16` の wave)。
    ただしリストや `np.arange(10)` のような既定の整数は、ほかの数と同じく `float64` になります。型を指定するには `dtype="int32"` です。
  - wave に値を代入しても型は変わりません(Igor と同じ)。整数の wave では四捨五入され、範囲の端で止まります。NaN は持てないので 0 になります。
  - 型の変更は **Data › Change Wave Type…**(`w.redimension("float32")`)です。
  - **複素数**の wave は、表では実部・虚部の 2 列になります。グラフでは実部・虚部・絶対値・位相のどれを描くかを trace ごとに選べます。
    `op.fft(w, output="complex")` はスペクトルを複素数のまま返し、`op.ifft` で元の信号に戻せます。
    2 次元 wave は `w[i, j]` の `i` が X 方向(横)です。3〜4 次元の wave は、表・画像・等高線で 1 面(レイヤーとチャンク)ずつ表示します。
- **日付**は 1970-01-01 UTC からの秒数として持ち、単位を `dat` にします(Igor と同じ流儀です)。
  CSV の日付の列(`2026-11-11 09:00` など)や NumPy の `datetime64` は自動でこの形になり、表では日付として表示・編集できます。
  どの時計で読むかは **Data › Time Zone for Dates…**(`op.set_time_zone("Asia/Tokyo")`)で決めます。UTC(既定)、このコンピュータのタイムゾーン(`"local"`)、または IANA 名です。
  グラフの軸・表・カーソルの読み値がそのゾーンの時刻になり、オフセットなしで入力・読み込みした日付もそのゾーンの時刻として解釈されます(wave の中身は変わりません)。
- テキストの wave(1 次元の文字列)も作れます。CSV の文字列の列はテキスト wave として読み込まれます。
- wave は**データフォルダ**に入れられます。`run1:signal` はフォルダ `run1` の中の `signal` です。
  データブラウザではツリーで表示され、wave をフォルダへドラッグして移動できます。

### グラフ

既存のチャートライブラリは使わず、専用のレンダラで描いています。

- 目盛りは 1-2-5 刻み。大きい値・小さい値は 1000 のべき乗を括り出し、軸ラベルに SI 接頭辞付きの単位(`mV`)か `×10³` として 1 回だけ表示します。対数軸は 10 のべき乗の主目盛りと 2–9 の副目盛りです。
- 余白は目盛りラベルの実測幅から自動で決まります。
- 自動スケールは Igor と同じくデータの範囲ちょうどです。軸は trace と重ならないよう、データ領域の少し外側に描きます。
- 点数が画素数よりずっと多い trace は、画素列ごとの最初・最小・最大・最後の点に間引いて描きます。見た目は変わらず、数百万点でも滑らかに動きます。
  10 万点以上の wave には、64 点・4096 点ごとの最小・最大の位置の索引を一度だけ作り、間引き自体も全点を見ずに済ませます(1000 万点の全体表示の再描画が約 15 ms)。
- trace のモード: `lines` / `markers` / `lines+markers` / `sticks` / `dots` / `cityscape` / `bars`。線種、マーカー 6 種、色、太さ、**誤差棒**(定数、または wave から点ごとに。X・Y とも)。
  - **塗りつぶし**: ゼロまで、または次の trace まで(2 本の曲線の間の帯)。色と不透明度を指定できます。
  - **オフセット**: wave を変えずに、描く位置だけ X・Y にずらします(重なった曲線を並べるときなど)。
  - **点ごとの色**: 別の wave の値をカラーテーブルに通して、マーカー・棒・線を点ごとに色分けします。
- **画像プロット**と**等高線**(2 次元 wave)。カラーテーブル 6 種、Z 範囲、カラースケールバー。等高線のレベルは本数指定(切りのよい値を自動選択)か値の列挙で、各レベルの値を線の上に書き込みます(オフにもできます)。
  ラベルは離れた線それぞれに付き、長い線には間隔を空けて複数付きます。
- 軸: 範囲、対数、**反転**、ミラー軸、目盛りの向き、副目盛り、グリッド、ラベル。
  - **目盛りの間隔**を指定できます(`tick_step=0.25`)。
  - **目盛りラベルの書式**を Python の書式指定の形で指定できます: `".2f"`(小数 2 桁)、`",.0f"`(3 桁区切り)、`".1e"`(1.2×10⁴)、`"%"` など。指定すると、べき乗の括り出しは行いません。
  - **カテゴリ軸**: X にテキスト wave を指定すると、点が等間隔に並び、目盛りがその文字列になります。`bars` と組み合わせると棒グラフで、同じ軸の棒は横に並びます。
    対数の X 軸でも、棒はどの桁でも同じ幅で描かれます。
  - **日付軸**: 単位が `dat` の軸は、目盛りが切りのよい時刻・日・月・年になり、目盛りに出ない部分(日付や年)は軸ラベルに 1 回だけ出ます。
  - 標準の左・下・右・上に加えて、**名前を付けた軸を追加**できます(自由軸)。同じ側に複数あるときは外側へ並びます。
  - 軸ごとに**描画範囲**(プロット領域の何 % から何 % か)を指定でき、1 つのグラフの中にプロットを積み重ねられます。
- **カーソル A / B**: trace 上の点に置き、位置と A–B 間の差を情報バーに表示します。ドラッグか `←` `→`(`Shift` で 10 点)で動かせます。
- 凡例とテキストボックス。ラベルでは `^{...}` で上付き、`_{...}` で下付きになります(例: `cm^{-1}`)。
  凡例・テキスト・カラースケールは**ドラッグで好きな位置へ**動かせます。ダブルクリックで内容を編集します。
- **タグ**: trace の 1 点に矢印付きのラベルを付けます(trace を右クリック › Add Tag)。データが変わっても拡大しても、その点に付いて動きます。
  テキスト中の `{x}` `{y}` `{point}` はその点の値に置き換わります。
- 画面と同じ描画命令から **PDF**(ベクター)、SVG、PNG(3 倍解像度)を書き出します。カーソルは既定では入りません(Python の `g.save(..., cursors=True)` で入れられます)。

操作:

| 操作                            | 動作                                                    |
| ------------------------------- | ------------------------------------------------------- |
| グラフ内をドラッグ              | マーキー。離すと Expand / Shrink などのメニューが出ます |
| ホイール                        | カーソル位置を中心に拡大・縮小(軸の上では、その軸だけ)  |
| Alt + ドラッグ                  | 表示範囲の移動                                          |
| 軸・trace・画像をダブルクリック | 設定ダイアログ                                          |
| 凡例・テキスト・タグをドラッグ  | 移動(ダブルクリックで編集、右クリックで削除)            |
| trace を右クリック              | その点にカーソル A / B やタグを置く、trace の削除など   |
| `Ctrl+A` / `⌘A`                 | 自動スケール                                            |
| `Ctrl+I` / `⌘I`                 | カーソル情報バーの表示切り替え                          |

積み重ねたプロットでは、マーキーやホイールはポインタのある段の軸だけに効きます。

### グラフのスタイル

研究室や論文の図をすべて同じ見た目にそろえるために、あるグラフの見た目に名前を付けて保存し、ほかのグラフに適用できます(**Graph › Styles…**)。

- スタイルが持つのは**見た目だけ**です: フォントと文字の大きさ、軸ごと(左・下・右・上と、追加した軸)の目盛りの向き・副目盛り・ミラー軸・グリッド、
  trace の色・線の太さ・線種・モード・マーカー・マーカーの大きさ・マーカーを塗るか中抜きか、それに保存するときに選べば**図の大きさ**。
  範囲・ラベル・対数・反転・目盛りの間隔と書式・誤差棒・オフセット・塗りつぶしなど、データによって決まるものは持ちません
  (同じ値がどのデータのグラフにも合うものが見た目、描くものによって変わるものがデータ、という区別です)。
- trace の見た目は順番の**繰り返し**です。3 本分のスタイルを 5 本の trace のグラフに適用すると、4 本目と 5 本目は 1 本目と 2 本目の見た目になります。
  スタイルを適用したグラフにあとから足した trace や軸も、そのスタイルに従います。
- スタイルは持っている部分だけを変えます(`op.set_style` で線の太さだけのスタイルも作れます)。
- 適用先は、そのグラフ、選んだグラフ、すべてのグラフ。何枚に適用しても Undo 1 回で戻ります。グラフの右クリック › **Apply Style** からもすぐ適用できます。
- **新しいグラフの既定のスタイル**を決めておくと、以後作るグラフはすべてその見た目で始まります。
- スタイルは実験に保存されます。実験をまたいで使うものは、ブラウザの**ライブラリ**に入れておきます(**To Library** / **To Experiment**)。
  ライブラリのスタイルを適用すると、まず実験にコピーされ、履歴には `op.set_style(...)` として残るので、履歴はどの実験でも再実行できます。
- **Export…** / **Import…** で JSON ファイルに書き出し・読み込みできます(1 ファイルに複数入ります)。名前が重なるものは `paper_1` のように別名で取り込みます。

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
  タブや改行を含むセルは表計算ソフトと同じく `"` で囲み、表からコピーしたものは、カンマなどを含むセルもそのまま貼り付けられます。
  タブのないテキストは、カンマで区切った各部分がすべて数値か日付のときだけカンマで区切ります(`1, 2, 3` など)。
- `Delete` で選択範囲をクリア(数値は NaN、テキストは空)。右クリックから、選択した行数ぶんの**点の挿入・削除**ができます。
- 表の上部に、選択中のセルの値(全桁)と、表示する**桁数**の設定があります。列の境界をドラッグすると列幅を変えられます(ダブルクリックで元に戻す)。桁数と列幅は実験ファイルに保存されます。
- 2 次元以上の wave は列ごとに展開して表示し、3〜4 次元では表示するレイヤーを表の上部で選びます。
- テキスト wave は文字列のまま、日付は日付として編集できます。

### 解析

**Analysis** メニューから実行できます。どれも Python の関数を呼び出すだけなので、実行したコマンドと結果は履歴に残ります。

- **Curve Fitting…**: `line`、多項式、`gauss`、`lor`、`voigt`、`pseudo_voigt`、`exp`、`dblexp`、`sin`、`power`、`sigmoid` を最小二乗法で当てはめます。
  `line` と多項式は線形最小二乗法で直接解き、そのほかは Levenberg–Marquardt で反復します。収束しなかったときは結果にそう表示されます(`r.converged` が `False`)。
  初期値は自動で推定します。カーソル A–B 間だけを対象にもできます。
  係数の**固定**(`y0=0`)、**制約**(`A > 0, 2 < x0 < 5`)、点ごとの標準偏差による**重み付け**を指定できます。
  結果は `fit_<wave名>`(当てはめた曲線。元データのグラフに追加されます)、`W_coef`(係数)、`W_sigma`(標準偏差)に入ります。
  **残差**(`res_<wave名>`。データの上に専用の軸を作って表示)と、当てはめた曲線の**信頼帯**(`fit_<wave名>_lo` / `_hi`。網掛けで表示)も出せます。
  **当てはめに使う点**は、元の wave を書き換えずに選べます: X の範囲(`xrange=`)、除外する X の区間(`exclude=[(5, 7), (15, 15)]`。ダイアログでは「Leave out」に `5..7, 15`)、
  点ごとのマスク(`mask=`。0 の点を使わない)。組み合わせて使えます。当てはめた曲線は除外した区間もまたいで描かれ、残差は除外した点についても出ます。
  結果には係数の**共分散**と**相関**(`r.covariance`、`r.correlation`)、**止まった理由**(`r.reason`)が入り、ほぼ完全に相関している係数の組は結果の表示に出ます。
- **解析結果の保存と比較**: フィット(`op.fit`、`op.fit_peaks`、`op.fit_global`)のたびに、条件と結果をひとまとまりにした「結果」が実験に保存されます(`Fit0`、`Peaks0`、`Global0`、…)。
  保存されるのは、関数・対象の wave・使った点の選び方・初期値・固定・制約・重みと、係数・不確かさ・共分散・χ²・収束したかと止まった理由、作られた wave の名前です。
  結果は、読んだ wave のその時点の内容の指紋を持っているので、**あとで元データが変わると「data changed」と表示されます**。
  データブラウザの **Results** に一覧が出ます(右クリックで再実行・削除)。**Analysis › Results…** では、結果を行、係数を列にした表で試料や条件を見比べ、
  **Fit Again**(同じ設定で、いまのデータに対して再実行。新しい結果として横に残ります)、**Apply to Waves…**(同じ設定を別の wave に適用)、**Make Table**(結果を wave の表にする)ができます。
  Python では `op.results()`、`op.result("Fit0")`、`r.rerun()`、`r.apply([w2, w3])`、`op.results_table()` です。結果は実験ファイルと自動保存に含まれ、Undo で一緒に戻ります。
  自作の関数によるフィットを再実行するときは、同じ名前の関数が定義されている必要があります。配列で渡した重みやマスクは保存されないので、再実行時に渡し直します(wave で渡せば保存されます)。
- **一括フィット**(`op.fit_batch("exp", [w1, w2, w3])`): 複数の wave に同じ設定で順に当てはめ、結果表(`Results`)を作ります。
- **同時フィット**(`op.fit_global("exp", [w1, w2, w3], shared=["tau"])`): 複数の wave に 1 つの関数を同時に当てはめ、指定した係数(時定数、ピーク位置など)を全部の wave で共通にします。
  共通の係数は 1 つの値として、そのほかは wave ごとに求まります。固定(`hold=`)と制約(`bounds=`)はすべての wave に同じものが掛かります。
- **マルチピークフィット**(Analysis › Multi-peak Fit…): ピークを自動で探し(または位置を指定し)、ガウス・ローレンツ・Voigt・擬 Voigt のいずれかの和とベースライン(定数・直線)を同時に当てはめます。
  各ピークの位置・高さ・半値全幅・面積(とそれぞれの標準偏差)を一覧で出し、`W_peaks` に入れます。合計の曲線と各ピークの曲線がグラフに追加されます。
  **ピーク間の拘束**(スピン軌道分裂の 2 本組など)を掛けられます。ピークは開始位置の左から 1、2、… と数えます:
  `same_width=True`(すべてのピークを 1 番目と同じ幅に)、`spacing={(1, 2): 1.2}`(2 番目を 1 番目の右 1.2 に固定)、`area_ratio={(1, 2): 0.5}`(2 番目の面積を 1 番目の半分に固定)。
  拘束された量は当てはめの対象から外れ、相手のピークから決まります(不確かさも相手から引き継ぎます)。使う点の選び方(`xrange=`、`exclude=`、`mask=`)は Curve Fitting と同じです。
- **Voigt と擬 Voigt**: Voigt はガウスとローレンツの畳み込みで、装置の分解能(ガウス)と寿命による広がり(ローレンツ)を分けて求めるのに使います。
  幅はガウス幅 `gwidth`(`gauss` の `width` と同じく exp(−(x/gwidth)²))とローレンツ幅 `lwidth`(`lor` 形状と同じく半値半幅)の 2 つで、どちらも当てはめます。
  `A`(マルチピークでは高さ)はピークの高さです。`lwidth` が 0 ならガウス、`gwidth` が 0 ならローレンツと一致します。
  値は Faddeeva 関数 w(z) の実部から計算します(Weideman の有理近似、40 項。誤差はピーク値の 1e-15 以下。SciPy は使いません)。
  マルチピークでは、全体の半値全幅(プロファイルから正確に求めます)と面積に加えて、ガウス成分とローレンツ成分の半値全幅(`gauss_fwhm`、`lorentz_fwhm`)を出し、`W_peaks` の 5・6 列目にも入れます。
  擬 Voigt は `eta`·ローレンツ + (1 − `eta`)·ガウスで、両方が同じ半値全幅を持ちます(`width` は半値半幅)。`eta` は 0〜1 に制限し、`W_peaks` の 5 列目に入れます。
  `op.fit` でも `eta` は指定しなくても 0〜1 に制限されます(`bounds=` で片側だけ指定した場合、もう片側はこの制限が残ります)。
- **バックグラウンド**(Analysis › Background…): XPS などのスペクトルのピークの下のバックグラウンドを `<wave名>_bg` に作ります(「Subtracted spectrum」で差し引いた `<wave名>_sub` も)。
  範囲は X の値で指定するか、カーソル A–B 間で、範囲の外は NaN です。両端の高さは、それぞれ端の数点(`average=`、既定 5 点)の平均です。XY データには X wave を指定します。
  **Shirley** は、一方の端の高さから他方の端の高さまで、通り過ぎたピーク面積(バックグラウンドより上の部分)に比例して変わる曲線で、反復して求めます。
  データが高い方の端(XPS では結合エネルギーの高い側、非弾性散乱した電子がたまる側)に向かって上がります。どちらの端から数えても同じ曲線になるので、X が結合エネルギーか運動エネルギーか、増える向きか減る向きかは問いません。
  **Tougaard** は、エネルギーを失っていない側の端の高さに、Tougaard の普遍断面積 `B·T/(C + T²)²`(`B = 2866`、`C = 1643` eV²。X は eV)でその側の各点から失われてきた電子を足したものです。
  既定では、範囲の反対側の端でデータに一致するように `B` を合わせます(`scale=False` で `B` をそのまま使います)。使った `B` は wave のノートに書きます。
  電子がエネルギーを失う向きは、データが高い方の端に向かう向きとみなします(`energy="binding"` で X の増える向き、`"kinetic"` で減る向きと指定もできます)。
  **linear** は両端の平均の点を結ぶ直線です。
- **オンセット**(Analysis › Onset…): UPS / LEIPS のしきい値(二次電子のカットオフ、HOMO・LUMO の立ち上がり)を、直線の外挿で求めます。
  立ち上がり(`edge=`)の範囲の点に直線を当てはめ、ベースライン(`baseline=`)の範囲の点に当てはめた直線、または一定の値(省略すると 0)と交わる X を出します。範囲は X の値です。XY データには X wave を指定します。
  交点の不確かさは、2 本の直線のばらつき(それぞれの範囲で点ごとに独立・同じ大きさの誤差を仮定し、残差から推定)を 1 次まで伝搬したもので、交点での 2 本の直線の不確かさを傾きの差で割ったものです。
  範囲の選び方による違いは含みません(実際にはこちらが大きいことがよくあります)。結果は `r.x`、`r.x_sigma`、`r.edge`(傾き・切片とその標準偏差)、`r.baseline` です。
  `graph=True` で、データを表示しているグラフに 2 本の直線(`<wave名>_edge`、`<wave名>_base`。それぞれの範囲から交点の先まで)と交点の印(`<wave名>_onset`、値のタグ付き)を加えます。
  ダイアログでは、範囲の横の「A–B」でカーソル A・B の X の値を入れられます。
- Wave Stats、微分、積分、平滑化、FFT(振幅スペクトル、または複素数のまま)、ヒストグラム、**補間**(線形・3 次スプライン。XY データを等間隔の wave にするのにも使えます)。
- **X wave に対する微分・積分**: 電流を時間で積分して電荷にする、容量を電圧で微分して dQ/dV を出す、といった XY データの計算です(ダイアログの「X data」で X wave を選びます)。
  X の間隔は不揃いでもよく、微分は内側の点で不等間隔の 3 点公式(2 次精度)、両端で片側差分(X のスケーリングを使うときと同じ)です。
  隣り合う X が同じ値の点(定電圧区間など)と、X が折り返して同じ値に戻る点では傾きが決まらないので、微分は NaN になります。
  積分は台形則の累積で、最初の点で 0 から始まります。X は単調でなくてよく、X が戻る区間の面積は負に数えます(充放電のループなど)。
  Y が値を持つ点で X が NaN だとエラーです。Y の NaN は、微分ではその点と両隣、積分ではそこから先を NaN にします(X のスケーリングを使うときと同じ)。
  結果は元の wave と同じ点数の、X のスケーリングを持たない wave なので、同じ X wave に対して描きます。
  単位は、両方わかっていれば微分が `Y/X`、積分が `Y·X` です(X のスケーリングを使うときも同じ。日付の X は秒として扱います)。
- 画像: **フィルタ**(ガウス・平均・メディアン・シャープ化)、任意の直線に沿った**ラインプロファイル**。

### プロシージャウィンドウ

Igor のプロシージャウィンドウに当たる、実験に保存される Python ファイルです(**Windows › New Procedure**)。

- 行番号・構文の色分け付きのエディタで、入力した内容はそのまま実験に保存されます。
- **Run**(`Ctrl+Enter` / `⌘Enter`)でファイル全体を対話環境で実行します。定義した関数はコマンドラインからそのまま使えます。
  `Shift+Enter` は選択範囲(なければカーソルのある行)だけを実行します。
- 「Run when the experiment opens」がオンのプロシージャは、実験を開いたとき・Python を再起動したときに自動で実行されます。
  Igor がプロシージャをコンパイルするのと同じで、自分の関数がいつでも使える状態になります。
  `.oresme` ファイルを開くときは、自動実行されるプロシージャがあれば実行してよいか確認します(断ると、実行せずに開きます)。
- 名前がそのままモジュール名です。`Procedure` という名前なら、ほかのコードから `import Procedure` できます。
- エラーは `File /experiment/Procedure.py:4, in bad()` のように、ファイル名と行番号付きで履歴に出ます。

### グラフの再作成スクリプト

**Graph › Recreation Script…** で、いま開いているグラフをもう一度描く Python を表示します(Igor のウィンドウ再作成マクロに当たるもの)。
既定値と違うところだけが書き出されます。コピー、コマンドラインへ送る、プロシージャに関数として追加する、のいずれかができます。
Python からは `g.script()` で同じ文字列が得られます。

```python
g = op.display("y", x="x")
g.trace("y").set(mode="markers", color="#0000ff")
g.axis("left").set(label="Squared", grid="major")
g.legend(anchor="RT", frame=True)
```

### ページレイアウト

複数のグラフとテキストを 1 枚の用紙に並べて、図として書き出します(**Windows › New Page Layout**)。Igor のページレイアウトに当たります。

- ツールバーの **Add Graph…** でグラフを、**Add Text…** でテキスト(キャプションなど)を置きます。
  ドラッグで移動、四隅のハンドルでサイズ変更、矢印キーで 1 pt ずつ(`Shift` で 10 pt)、`Delete` で削除です。
- **複数選択**: `Shift`+クリックで足し引き、何もない所からのドラッグ(ラバーバンド)で触れたものをまとめて選択、
  `Ctrl+A`(Mac は `⌘A`)で全選択、`Esc` で解除。選択したものはまとめてドラッグ・矢印キーで動き、`Delete` で消えます。
  1 回の操作が 1 回の取り消し(Undo)です。サイズ変更は 1 つだけ選んだグラフに対してです。
- **揃える・並べる**: ツールバーの **Arrange ▾**、右クリックメニュー、メニューバーの **Layout** から。
  - **Align**: 左・右・上・下の端、横方向の中心(Horizontal Centers)、縦方向の中心(Vertical Centers)を、
    選択全体を囲む枠に揃えます。1 つだけ選んでいるときは用紙に揃えます(用紙の左端・中央など)。
  - **Distribute**: 3 つ以上を、間隔が等しくなるように横または縦に並べ直します。両端のものは動かず、大きさが違っても「すき間」が等しくなります。
  - **Make Same Width / Height / Size**: 最初に選んだグラフの幅・高さに合わせます(左上の角は動きません)。
    テキストは文字の大きさで決まるので対象外です。
  - **Arrange in Grid…**: 行数・列数・余白・間隔を指定し、選択中のグラフ(何も選んでいなければページの全グラフ)を、
    余白の内側いっぱいの格子に並べます。1×2・2×1・2×2・3×2・2×3 のプリセットあり。
    グラフは今ページ上にある**読む順**(上の段から、段の中は左から)にマスを埋めます。マスより多いグラフはその場に残り、
    ダイアログにその名前が出ます。テキストは動きません。
  - 履歴には操作そのもの(`page.align([...], "left")` など)が 1 行で記録され、Python から同じことができます。
- ページはグラフを**そのまま**映します。グラフを変えればページも変わります。グラフはページ上の大きさで描き直されるので、
  文字や線の太さは縮小されません(グラフのフォントが 9 pt なら、紙の上でも 9 pt)。
- 用紙は A4 / A5 / A3 / Letter の縦・横。**Save PDF** で、用紙サイズそのままのベクター PDF になります(Python からは `.svg` と `.png` も)。

```python
page = op.new_layout("Figure", "A4")           # landscape=True で横、(幅, 高さ) を pt で直接指定も可
page.add_text("Figure 1. Damped oscillation", x=40, y=36, size=13)
top = page.add_graph(g1, x=40, y=64, w=250, h=170)          # 位置と大きさは pt(1/72 インチ)。左上が原点
page.add_graph(g2, x=305, y=64, w=250, h=170)
top.set(w=300); page.items; page.item("graph0").remove()
page.save("figure.pdf")

page.align(["graph0", "graph1", "text0"], "left")   # "right" "top" "bottom"、中心は "center"(横)/ "middle"(縦)
page.distribute(page.items[:3], "vertical")          # 名前でも item でも。3 つ以上、間隔を均等に
page.match_size(["graph1", "graph0"], "both")        # 最初のグラフの大きさに("width" / "height" も)
page.arrange(2, 2, margin=36, gap=12)                # 全グラフを読む順に 2×2 へ。gap=(列の間, 行の間) も可
page.arrange(1, 2, items=["graph1", "graph0"])       # items を渡すとその順に。入りきらないグラフは警告して残す
```

### Python のファイル

Python の作業ディレクトリ(`/experiment`)は実験の一部です。

- `np.savetxt("fit.csv", ...)` や `open("notes.txt", "w")` で書いたファイルは、データブラウザ下部の **Files** に並び、実験と一緒に保存されます。
  ダブルクリックでダウンロード、右クリックで削除できます。
- **File › Add Files for Python…** で追加したファイルは、Python から名前だけで開けます(`open("raw.bin", "rb")`)。
- 1 ファイル 64 MB までです。それより大きいファイルは Python からは使えますが、実験には保存されません。

### デスクトップアプリとして使う

OresmePro はインストールできる Web アプリ(PWA)です。

- Chrome / Edge ではアドレスバーの「インストール」から、Safari では「Dock に追加」から、独立したウィンドウのアプリになります。
- **オフラインでも動きます。** 一度開くと、アプリ本体と Python(Pyodide、NumPy、IPython)一式がブラウザに保存され、次からはネットワークなしで起動します。
  SciPy・pandas・scikit-learn・lmfit は、最初に `import` したときに保存されます。使う前にオフライン用に入れておくには
  **Python › Keep SciPy, pandas, scikit-learn and lmfit for Offline Use** を選びます。
- インストールすると、`.oresme` ファイルを OresmePro で開けるようになります(対応ブラウザのみ)。
- データはブラウザの中(OPFS)に置かれます。別の PC やブラウザへは `.oresme` ファイルで持ち運びます。

### 保存

- wave・グラフ・表・プロシージャ・ページレイアウト・グラフのスタイル・Python のファイル・ウィンドウ配置・履歴は、ブラウザの OPFS(Origin Private File System)に自動保存され、次に開いたときに復元されます。
- **保存の状態**はステータスバーの右端に出ます。変更すると「Saving…」、書き終わると「Saved 12:03」になります。
  保存に失敗したときは理由と **Try Again** が出て、間隔を空けて自動でも再試行します。ブラウザが保存領域を貸してくれない場合(プライベートウィンドウなど)は「Not kept in this browser」と出ます。
- **複数の実験**を持てます。**File › New Experiment** は、いまの実験を残したまま新しい実験を始めます。
  **File › Experiments…** で、ブラウザにある実験の一覧から別の実験を開く・名前を付ける・削除することができます。タブごとに 1 つの実験を開き、実験を指定せずに開いたタブは最後に開いた実験になります。
- **同じ実験を 2 つのタブで開いたとき**、自動保存するのは先に開いたタブだけです。後から開いたタブには「Open in another tab: not saved here」と出て、そのタブでの変更は保存されません。
  **Save Here Instead** を押すと、そのタブの状態で保存を引き継ぎ、元のタブは保存をやめます。片方の作業がもう片方の保存で黙って消えることはありません。
- **開いたときの状態に戻す**: **File › Go Back to Opening State…** で、このタブが実験を開いた時点の状態に戻せます(その時点の状態を 1 世代、バックアップとして残しています)。
- **保存されている実験が読めなかったとき**(データファイルが欠けているなど)は、上書きせずにそのまま残し、ステータスバーから **Go Back to Backup**(バックアップへ戻す)か **Start Afresh**(いまの状態で上書き)を選べます。
- **File › Save Experiment As…**(`Ctrl+S` / `⌘S`)で、実験全体を 1 つの `.oresme` ファイルに保存できます。
  開くときは **File › Open Experiment…** か、ウィンドウへのドロップです。
- `.oresme` は zip で、中身は `experiment.json`(構成とプロシージャ)、`waves/*.npy`(NumPy でそのまま読める wave データ)、`files/`(Python のファイル)、`history.json` です。

## Python API

`oresme` モジュール(慣例として `op`)からアプリを操作します。Blender の `bpy` に当たるものです。

```python
# wave
w = op.make("signal", data, x0=0, dx=0.01, x_unit="s", unit="V")
w = op.wave("signal")            # 既存の wave
w.data                           # 読み取り専用の NumPy 配列(コピー)
w.data = w.data * 2              # 全体を書き換え
w[10:20] = 0                     # 一部を書き換え
w.dtype; w.redimension("float32")                        # 型。op.make(..., dtype="uint16") で指定して作る
z = op.make("z", np.exp(1j * np.linspace(0, 6, 100)))    # 複素数。z.data.real、abs(z)、z.is_complex
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
g.tag("signal", 120, "peak {y}")               # 点に付くラベル。x=, y= で箱の位置(プロット領域に対する割合)
g.legend(x=-0.3, y=0.1)                        # anchor からずらして置く(ドラッグしたときもこの値が変わる)

g.trace("signal").set(fill="zero", fill_opacity=0.3)        # 塗りつぶし。fill="next" は次の trace まで
g.trace("signal").set(x_offset=0, y_offset=0.5)             # 描く位置をずらす
g.trace("signal").set(color_wave="depth", color_table="viridis")   # 点ごとの色
g.bottom.set(reverse=True, tick_step=2.5, tick_format=".1f")       # 反転、目盛りの間隔と書式

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
op.set_time_zone("Asia/Tokyo")                 # 日付を読む時計。op.time_zone() で現在の設定

a = g.cursor("A", "signal", 120)               # カーソル。a.x, a.y, a.point
g.cursor("B", "signal", 300).x - a.x

g.save("figure.pdf")                           # .pdf / .svg / .png をダウンロード(cursors=True でカーソルも)

paper = g.save_style("paper")                  # 見た目をスタイルとして保存(size=True で図の大きさも)
g2.apply_style("paper"); op.apply_style("paper")             # 1 枚に、すべてのグラフに(graphs=[g1, g2] で指定も)
op.set_style("talk", {"graph": {"font_size": 18}, "traces": [{"line_size": 2}, {"line_size": 2, "line_style": "dash"}]})
op.set_default_style("paper")                  # 新しいグラフの既定。None で解除。op.display(w, style=None) でその 1 枚だけ外す
op.styles(); paper.data; paper.rename("journal"); paper.remove()

# 解析
r = op.fit("gauss", w)                         # r.coef, r.sigma, r["x0"], r.wave
op.fit(lambda x, a, k: a * np.exp(k * x), w, guess=[1, 0.1])
op.fit("exp", w, cursors=True)                 # カーソル A–B 間
op.fit("gauss", w, hold={"y0": 0}, bounds={"A": (0, None)}, sigma="err")   # 固定・制約・重み
r = op.fit("line", w, residuals=True, band=0.95)        # r.residuals、r.band = (下, 上)
op.fit("gauss", w, xrange=(2, 8), exclude=[(4.5, 5)], mask="good")   # 使う点: X の範囲、除外区間、マスク
r.covariance; r.correlation; r.reason; r.name            # 共分散・相関・止まった理由・保存された結果の名前
kept = op.result("Fit0"); op.results(); kept.changed     # 保存された結果。changed は、あとで変わった入力 wave
kept.rerun(); kept.rerun(replace=True, hold={"y0": 0})   # 同じ設定で再実行(設定の一部を変えても)
kept.apply([w2, w3]); op.fit_batch("exp", [w1, w2, w3])  # 別の wave に同じフィット。結果表 Results もできる
op.results_table([r1, r2], name="Compare")               # 結果を横並びの表に(行が結果、列が係数)
g = op.fit_global("exp", [w1, w2], shared=["tau"])       # 同時フィット: g["tau"]、g["A"](wave ごと)、g.coef
op.fit_peaks(w, peaks=[284.6, 285.8], same_width=True, spacing={(1, 2): 1.2}, area_ratio={(1, 2): 0.5})
peaks = op.fit_peaks(w, shape="gauss", baseline="linear")   # peaks[0]["x"], ["height"], ["width"], ["area"]
peaks = op.fit_peaks(w, shape="voigt")                       # peaks[0]["gauss_fwhm"], ["lorentz_fwhm"]。"pseudo_voigt" は ["eta"]
op.fit("voigt", w)                                           # y0, A, x0, gwidth, lwidth
bg, sub = op.background(w, "shirley", range=(280, 295), subtract=True)   # "tougaard"、"linear"。cursors=True、x= も
r = op.onset(w, edge=(4.2, 4.8), baseline=(5, 6), graph=True)  # r.x, r.x_sigma。baseline=0.1 で一定の値
op.find_peaks(w, smooth=5)                                   # 探すだけ。min_prominence= などで調整
op.stats(w); op.differentiate(w); op.integrate(w); op.smooth(w, 5); op.fft(w); op.histogram(w, bins=50)
op.integrate(current, x=time); op.differentiate(capacity, x=voltage)   # X wave に対して(結果は同じ X に対して描く)
spec = op.fft(w, output="complex"); op.ifft(spec)            # 複素スペクトルと逆変換
g.trace("w_FFT").part = "magnitude"                          # 複素 wave の描く部分: real / imag / magnitude / phase
op.interpolate(y, x, n=200, kind="cubic")                    # at=[...] で指定した X の値も
op.filter_image(m, "gauss", 1.5); op.line_profile(m, (x0, y0), (x1, y1))

# 表
t = op.edit(w, labels)
t.digits = 5                                   # 表示する桁数

# プロシージャ、グラフの再作成
p = op.new_procedure("Fits", "def model(x, a):\n    return a * x\n")
p.run()                                        # 対話環境で実行(model が使えるようになる)
p.code; p.auto_run = False; op.procedure("Fits"); op.procedures()
print(g.script())                              # このグラフをもう一度描く Python
```

`w.data` はコピーなので、`w.data[0] = 1` は wave を変更しません(読み取り専用なのでエラーになります)。
変更するときは `w[0] = 1` か `w.data = ...` を使います。
1 次元の wave は、複素数でも、末尾のすぐ先に書くと伸びます(`w[len(w)] = 1`、`z[len(z)] = 1 + 2j`)。`w.flat[a:b]` は、形によらず格納順で読み書きします。

IPython の上で動いているので、`obj?`、`%timeit`、`%pwd` などのマジックや、最上位の `await` も使えます。

### 科学計算のパッケージ

**SciPy、pandas、scikit-learn、lmfit** は、`import` するだけで使えます。最初に `import` したときに取り込まれ(数秒かかります。ステータスバーに「Loading scipy…」と出ます)、
コマンドラインだけでなく、プロシージャや実験の `.py` ファイルの中の `import` でも同じです。これらはアプリと一緒に配信されるので、CDN に出られないネットワークでも使えます。
Pyodide に含まれるそのほかのパッケージ(SymPy、statsmodels、Matplotlib など)は、`import` した時点で CDN(jsDelivr)から取得します。

wave は NumPy の配列として渡せるので、そのまま使えます。

```python
from scipy.optimize import curve_fit
popt, pcov = curve_fit(lambda x, a, tau: a * np.exp(-x / tau), w.x, w, p0=[1, 1])

from sklearn.linear_model import LinearRegression
lr = LinearRegression().fit(w.x.reshape(-1, 1), w)

df = op.to_dataframe("time", "voltage", "label")      # wave → DataFrame。日付 wave は datetime64、テキスト wave は文字列の列
df = op.table("Table0").to_dataframe()                # 表の列をそのまま
waves = op.from_dataframe(df, "run1_")                # DataFrame → wave(列ごと)。意味のあるインデックスも wave になる

from lmfit.models import GaussianModel, LinearModel
model = GaussianModel() + LinearModel()
r = op.fit(model, w, params=model.make_params(amplitude=5, center=1, sigma=1, slope=0, intercept=0))
r.lmfit                                                # lmfit 自身の結果(ModelResult)。r.coef、r.sigma などはほかのフィットと同じ
```

- **lmfit のモデルを `op.fit` に渡せます。** 当てはめは lmfit が行い(式による拘束 `expr` もそのまま)、使う点の選び方(`xrange=`、`exclude=`、`mask=`、カーソル)、
  重み(`sigma=`)、固定と制約(`hold=`、`bounds=`)、グラフへの曲線の追加、残差、信頼帯、結果の保存(`Fit0`、…)は、組み込みの関数と同じに働きます。
  初期値は `params=`、省略するとモデル自身の推定(`model.guess`)です。保存された結果を再実行するときは、モデルを渡し直します(`kept.rerun(function=model, params=p)`)。
- `op.from_dataframe` は、数値の列を数値 wave、日付の列を日付 wave(UTC)、それ以外をテキスト wave にします。列名は wave 名として使える形に直し、
  すでにある名前には `_1` を付けます。pandas の欠損値は NaN(テキストでは空文字列)になります。

## 設計

```
メインスレッド                              Web Worker
┌──────────────────────────────┐          ┌─────────────────────┐
│ Doc(wave・グラフ・表)       │◀─ 同期 ─▶│ Pyodide + IPython   │
│   ↑ すべての変更は Command   │   RPC    │   import oresme     │
│ GUI(React)── echo ─▶ 履歴  │          │                     │
└──────────────────────────────┘          └─────────────────────┘
```

- **ドキュメントはメインスレッドにあります。** wave のデータ(型ごとの型付き配列。`float64` なら `Float64Array`)もここに置きます。
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
ヘッダーを設定できない静的ホスティングでは、同梱の Service Worker(`sw.js`)が代わりに付けるので、
`dist/` をそのまま置けば動きます。

### ディレクトリ

| 場所                | 内容                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------- |
| `src/core/doc/`     | ドキュメントの型、コマンド、Undo、GUI 操作の Python への書き出し                             |
| `src/core/plot/`    | 目盛り、間引き、等高線、レイアウト、Canvas / SVG / PDF バックエンド、ズーム計算              |
| `src/core/history/` | 履歴、履歴検索、ANSI 出力の解釈、入力が完結しているかの判定                                  |
| `src/core/io/`      | `.npy` の読み書き、区切りテキスト・Excel・Igor のファイルの読み込み、実験ファイル(`.oresme`) |
| `src/core/files/`   | 実験に含まれるファイル(Python の作業ディレクトリの写し)                                      |
| `src/kernel/`       | Python ワーカー、同期ブリッジ、`python/`(Python 側の API と解析)                             |
| `src/app/`          | アプリの状態、自動保存、書き出し、スタイルのライブラリ                                       |
| `src/ui/`           | React コンポーネント                                                                         |

`src/core/` は DOM にも React にも依存しません。

## 技術スタック

| 用途                        | 採用                                     |
| --------------------------- | ---------------------------------------- |
| ランタイム / パッケージ管理 | Node.js 26 / pnpm 12                     |
| ツールチェーン              | Vite+ (`vp`)                             |
| UI                          | React 19, Tailwind CSS 4                 |
| 表                          | TanStack Table(列)+ TanStack Virtual(行) |
| 履歴ビュー                  | TanStack Virtual                         |
| コマンドライン / エディタ   | CodeMirror 6                             |
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

SciPy・pandas・scikit-learn・lmfit とその依存パッケージも同じ場所に置き、アプリと一緒に配信します(合わせて約 23 MB)。
起動時には読み込まず、最初に `import` されたときにブラウザが取りに行きます。
lmfit と、それが必要とする asteval・dill は Pyodide の配布物に含まれないので、PyPI の純 Python の wheel をバージョンとハッシュを固定して取得し、Pyodide のロックファイルに加えています。
それ以外の Pyodide のパッケージは同梱せず、`import` した時点で CDN(jsDelivr)から取得します。
Pyodide 一式の取得元は環境変数 `VITE_PYODIDE_URL` で変更できます。

### テスト

- **単体テスト**(`pnpm test`、Vitest): `src/core/` のロジックと、Python API。
  `src/kernel/kernel.test.ts` は本物の Pyodide を Node 上で起動し、Python API を実際のドキュメントに対して動かします。
  Igor のファイルのテストは、`scripts/igor-fixtures.py`(NumPy が必要)がファイル形式の仕様から書き出したファイル
  (`src/core/io/testdata/igor/`)と、それぞれの中身を記した `expected.json` を読みます。作り直すときは `python3 scripts/igor-fixtures.py` です。
- **E2E テスト**(`pnpm e2e`、Playwright): ビルドしたアプリを Chromium で操作します。コマンドウィンドウのキー操作、
  グラフのマウス操作、表、ファイルの読み込みと保存、Python の中断などを、テストごとに新しいブラウザ(と Python)で確認します。
  既にインストール済みの Chromium を使うときは `PLAYWRIGHT_CHROMIUM_PATH` にそのパスを指定します。
- **CI**(`.github/workflows/ci.yml`): push のたびに、チェック、単体テスト、ビルド、E2E テストを順に実行します。

## 制限

- Windows / macOS / Linux 用のネイティブのパッケージ(Tauri や Electron)はありません。デスクトップでは PWA としてインストールして使います。
- Undo は 100 手前まで、かつ過去の手順だけが抱えている wave データが 512 MB を超えない範囲までです(大きな wave を何度も書き換えると、古い手順から忘れます)。
- 64 ビット整数の wave はありません(`float64` になります。2⁵³ までの整数は正確に入ります)。
- Excel は `.xlsx` / `.xlsm` の読み込みだけです。書き出しと、古い `.xls` は対応していません。
- 同時フィット(`op.fit_global`)、一括フィット(`op.fit_batch`)、ピーク間の拘束(`op.fit_peaks(..., spacing=…)`)は Python から使います(ダイアログはありません)。
  保存された結果を別の wave に適用する操作は **Analysis › Results…** からもできます。
- 解析結果が覚えているのは入力 wave の内容の指紋で、データそのものの写しではありません。元データが変わったことは分かりますが、変わる前のデータには戻せません(Undo か **Go Back to Opening State…** を使います)。
- 2 つのタブで同じ実験を同時に編集して両方の変更を合わせることはできません。保存するのは 1 つのタブだけです。
- Igor のファイルは読み込みだけです(`.ibw` と、`.pxp` / `.pxt` の wave)。`.pxp` のグラフ・表・プロシージャ・変数・履歴、
  パックドでない実験(`.uxp`)、Igor テキストファイル(`.itx`)は読み込めません。次元ラベルと従属関係の式は引き継ぎません。
- `.pxp` がちょうどレコードの境目で切れている場合は、その先に何があったかを知る手がかりがないため、切れていることに気づけません
  (データフォルダの途中で切れていれば気づきます)。
- Python を 1 回の長い計算の途中で止めることはできません(上の「コマンドウィンドウ」を参照)。
- タイムゾーンは実験全体で 1 つです。夏時間の切り替わりで時計が飛ぶ・戻る 1 時間の中の時刻は、どちらか一方として解釈されます。
- 目盛りの間隔と書式の指定は、数値の軸だけに効きます(日付軸・カテゴリ軸は自動)。
- 点ごとの色分けは、線では表示範囲が約 2 万点までのときに行います(それより多いと 1 色で描きます)。
- PDF の文字は、欧文・ギリシャ文字・数学記号はビューア内蔵のフォントでベクターとして、
  日本語などそれ以外の文字は 4 倍解像度の画像として入ります。
- グラフのスタイルは trace と軸とフォントの見た目だけを持ちます。画像プロット・等高線・凡例などの注釈の見た目は含みません。
- 3〜4 次元の wave を一度に立体的に表示する機能(ボリューム表示など)はありません。1 面ずつの表示です。

## ライセンス

未定。
