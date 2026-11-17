# electrochem: 電気化学の見本プラグイン

OresmePro のプラグインの見本です。サイクリックボルタモグラム(CV)のピーク、Tafel 解析、電気化学インピーダンス(EIS)の等価回路フィット(決まったモデルと、文字で書いた任意の回路)を、隔離された環境(サンドボックス)の Python で行います。数値計算は合成データで検算してあります([検算](#検算))。

- [入れ方](#入れ方)
- [`cv_peaks`: CV のピーク](#cv_peaks-cv-のピーク)
- [`tafel`: Tafel 勾配と交換電流密度](#tafel-tafel-勾配と交換電流密度)
- [`eis_fit`: インピーダンスの等価回路フィット](#eis_fit-インピーダンスの等価回路フィット)
- [`eis_circuit`: 任意の等価回路のフィット](#eis_circuit-任意の等価回路のフィット)
- [Nyquist 図のグラフテンプレート](#nyquist-図のグラフテンプレート)
- [EIS フィットのパネル](#eis-フィットのパネル)
- [EIS Circuit Fitting: 回路を見ながら編集する画面](#eis-circuit-fitting-回路を見ながら編集する画面)
- [English](#english)

## 入れ方

**Python › Plugins…** を開き、次のどちらかで入れます。

- **Install from GitHub…**: アドレスに `https://github.com/ks250206/OresmePro/tree/main/examples/plugins/electrochem` を入れて **Fetch**。ブランチはその時点のコミットに固定されます。
- **Install from Folder…**: このフォルダ(`examples/plugins/electrochem`)を選びます。

入れる前に、提供する action と、使う Python パッケージ(numpy, scipy)が表示されます。入るのは `oresme-plugin.json` に並んだファイルだけで、この README と `tests/` は入りません。

入れたあとは、ダイアログで action を選んで実行するか、Python から呼びます。

```python
op.invoke("plugin.electrochem.eis_fit", {"frequency": "f", "zre": "zre", "zim": "zim", "model": "Randles"})
```

作られた wave は最初に渡した wave の隣に `<その wave の名前>_<役割>` の名前で置かれ(既にある wave は上書きしません)、結果は **Analysis › Results** に残ります。プラグインを削除しても wave と結果は残り、`op.result("Plugin0").rerun()` のような再実行だけが、必要なプラグインを示して止まります。

## 単位と符号

- 電位は V。単位が `mV` の wave は V に直して扱います。範囲などの引数も V で与えます。
- 電流は電流の wave の単位のまま(A、電流密度なら A/cm² など)。
- インピーダンスは Ω、周波数は Hz(角周波数 ω = 2π f)。
- 電流の符号は IUPAC に従い、酸化(アノード)電流が正です。逆の記録(cathodic positive)は `cv_peaks` の `convention` で指定します。

## `cv_peaks`: CV のピーク

CV は電位が行き来するので、電位は電流の X スケールではなく別の wave で渡します。

| 引数                   | 内容                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------- |
| `current`, `potential` | 電流と電位の wave(同じ点数)                                                             |
| `cycle`                | 何番目のサイクルを使うか(1 から)。n 番目の正方向の掃引と n 番目の負方向の掃引を使います |
| `window`               | ピークを探す電位の範囲 `[E1, E2]`(省略時は掃引全体)                                     |
| `anodic_baseline`      | 正方向の掃引で、酸化ピークより手前のベースラインの範囲 `[E1, E2]`                       |
| `cathodic_baseline`    | 負方向の掃引で、還元ピークより手前のベースラインの範囲 `[E1, E2]`                       |
| `convention`           | `anodic positive`(既定、IUPAC)か `cathodic positive`                                    |

- 電位が折り返すところで掃引に分けます。電位の全幅の 2 % より小さい戻りは雑音とみなします。
- ピークは掃引のなかで(ベースラインを引いた)電流が最大(還元は最小)の点を、その近くの点(頂点から雑音の 3 倍以内、少なくとも両側 2 点)に放物線を当てて補います。点の間隔に縛られず、非対称なピークでも頂点がずれにくくしてあります。
- ベースラインは、指定した範囲の点に引いた直線を、ピーク電位まで外挿したものです。指定しないときは電流 0 から測ります。

返す値: `Epa`, `Epc`(V)、`dEp` = Epa − Epc、`E_half` = (Epa + Epc)/2、`ipa`, `ipc`(ベースラインからの高さ、正の値)、`ratio` = ipa/ipc。ピークが掃引や窓の端にあるときは `warnings` に書き、結果を未収束(converged = false)にします。

作る wave:

- `peak_E`, `peak_i`: 二つのピークの電位と電流(`peak_i` を `peak_E` に対して描くと、CV の上に印が付きます)
- `baseline`(ベースラインを指定したとき): 元と同じ点数で、ベースラインの範囲からピークまでだけ値があり、ほかは NaN。電位の wave に対して描きます。

## `tafel`: Tafel 勾配と交換電流密度

平衡から十分離れた(|η| が RT/F ≈ 26 mV より十分大きい)ところでは Butler–Volmer 式の片方の項だけが残り、

log10 |j| = log10 j0 + η / b、 η = E − E_eq

となります。指定した電位範囲の log10|j| を η に対して最小二乗で直線に当て、Tafel 勾配 b と、η = 0 に外挿した交換電流密度 j0 を求めます。

| 引数                   | 内容                                                                     |
| ---------------------- | ------------------------------------------------------------------------ |
| `current`, `potential` | 電流と電位(または過電圧)の wave                                          |
| `e_from`, `e_to`       | フィットする電位の範囲(V、元の電位で)                                    |
| `e_eq`                 | 平衡電位(V)。電位の wave が過電圧なら 0(既定)                            |
| `area`                 | 電極面積。電流をこれで割って電流密度にします(cm² で与えれば j0 は A/cm²) |
| `temperature`          | 温度(K、既定 298.15)。移動係数の計算に使います                           |

返す値: `slope_mV_per_dec`(mV/dec、アノード側で正、カソード側で負)、`j0`、`log10_j0`、`alpha`(α = ln(10) RT / (F |b|)、n を含む αn)と、それぞれの `_sigma`、`branch`、`r_squared`。不確かさは直線の共分散行列を残差の分散で尺度合わせしたものです(データの誤差棒は仮定しません)。範囲のなかで電流の符号が変わるときは警告します。

作る wave: `abs`(|j|)と `fit`(η = 0 から範囲の端までの直線、ほかは NaN)。どちらも電位の wave に対して、左軸を対数にして描きます。

## `eis_fit`: インピーダンスの等価回路フィット

Z = Z′ + j Z″(容量性の円弧では Z″ < 0)。

| 引数                      | 内容                                                                                          |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| `frequency`, `zre`, `zim` | 周波数(Hz)、Z′、虚部の wave(同じ点数)                                                         |
| `model`                   | `Randles`(既定)、`R(RQ)`、`R(RC)`                                                             |
| `imaginary`               | 虚部の wave が `-Z''`(−Z″、容量性の円弧で正。Nyquist 図での向き。既定)か `Z''`(Z″ そのもの)か |
| `weighting`               | `modulus`(既定: 各点の残差をその点の \|Z\| で割る)か `unit`(重みなし)                         |
| `f_min`, `f_max`          | フィットに使う周波数の範囲(省略時はすべて)                                                    |

モデル(R は Ω、C は F、Q は F·s^(n−1)、σ は Ω·s^(−1/2)):

- `R(RC)`: Z = R0 + R1 / (1 + jω R1 C1)
- `R(RQ)`: Z = R0 + R1 / (1 + R1 Q1 (jω)^n1)(Q1, n1 は定位相要素 CPE)
- `Randles`: Z = R0 + 1 / (Q1 (jω)^n1 + 1 / (R1 + Zw))、Zw = σ (1 − j) / √ω

`Randles` は電極反応の標準的な回路で、溶液抵抗 R0 に、二重層(CPE)と「電荷移動抵抗 R1 + 半無限拡散の Warburg インピーダンス」の並列をつないだものです。

フィットは複素非線形最小二乗です。実部と虚部の残差を並べて `scipy.optimize.least_squares`(trust region)で最小化します。抵抗・容量・Q・σ は log10 で動かす(正のまま、桁が違っても扱える)、n1 は 0.2〜1 に限ります。初期値は形から推定します。

- R0: 最高周波数での実部(高周波側の切片)
- R1, C1(Q1): 高周波側から見て最初の −Z″ の極大(円弧の頂点)。頂点では Z′ = R0 + R1/2、ω R1 C1 = 1(CPE なら ω^n R1 Q1 = 1)
- σ: 円弧のあとの谷より低周波側で、Z′ を ω^(−1/2) に対して直線に当てた傾き

n と σ の初期値をいくつか試し、最もよく合ったものを採ります。不確かさは解での Jacobian から(残差の分散で尺度合わせ)。χ² は重みを付けた残差の二乗和で、`chisq_reduced` = χ² / (2N − パラメータ数)。`modulus` では相対誤差の二乗なので、例えば 0.5 % の雑音なら χ²/ν ≈ 2.5 × 10⁻⁵ です。

返す値: 各パラメータと `_sigma`、`C_eff`(CPE と R1 の並列が相当する容量 Q^(1/n) R1^((1−n)/n)、R(RC) では C1)、`f_char`(円弧の特性周波数)、`chisq`, `chisq_reduced`, `frequencies`, `warnings`(パラメータが境界に張り付いたときなど)。

作る wave: `zre_fit`, `zim_fit`。測定したすべての周波数でのフィットの Z′ と虚部で、虚部は渡したときと同じ向き(`-Z''` なら −Z″)です。データと同じ図に重ねられます。

### 限界

- 半無限拡散の Warburg だけで、有限長の拡散(短絡・開放)はありません。それが要るときは `eis_circuit` で `Wo`・`Ws` を使います。
- CPE の n が 1 に張り付くときは、`R(RC)` のほうが合っています。
- 初期値の推定は、円弧が見えるスペクトルを前提にしています。円弧がほとんど見えないときは `f_min`, `f_max` で範囲を絞ってください。
- インダクタンス(高周波で Z″ > 0)は扱いません。その点は `f_max` で外すか、`eis_circuit` で `L` を入れてください。

## `eis_circuit`: 任意の等価回路のフィット

`eis_fit` と同じフィットを、[impedance.py](https://github.com/ECSHackWeek/impedance.py) と同じ書き方の回路で行います。impedance.py は matplotlib と altair を必要とし、アプリに同梱すると約 11 MB 増えるため、回路の部分だけをこのプラグインで実装しています(素子の式は impedance.py と数値的に一致することを確かめてあります)。

```python
op.invoke("plugin.electrochem.eis_circuit",
          {"frequency": "f", "zre": "zre", "zim": "zim", "circuit": "R0-p(R1,CPE1)-W1"})
```

回路の書き方: 直列は `-`、並列は `p(a, b, ...)`(各枝も直列にできます)。素子は種類とラベルで、ラベルは数字か `_` で始めます(`R1`、`R_ct`。`Rct` は不可)。

| 種類       | 素子                  | Z                        | パラメータ                     |
| ---------- | --------------------- | ------------------------ | ------------------------------ |
| `R`        | 抵抗                  | R                        | `R1` (Ω)                       |
| `C`        | キャパシタ            | 1 / (jω C)               | `C1` (F)                       |
| `L`        | インダクタ            | jω L                     | `L1` (H)                       |
| `CPE`, `Q` | 定位相要素            | 1 / (Q (jω)^n)           | `Q1` (F·s^(n−1))、`n1`(0.2〜1) |
| `W`        | Warburg(半無限)       | σ (1 − j) / √ω           | `W1` (Ω·s^(−1/2))              |
| `Wo`       | Warburg(有限長・開放) | Z0 coth(√(jωτ)) / √(jωτ) | `Wo1_Z0` (Ω)、`Wo1_tau` (s)    |
| `Ws`       | Warburg(有限長・短絡) | Z0 tanh(√(jωτ)) / √(jωτ) | `Ws1_Z0` (Ω)、`Ws1_tau` (s)    |

例: `R0-p(R1,C1)`(= `R(RC)`)、`R0-p(R1-W1,CPE1)`(= `Randles`)、`R0-p(R1,CPE1)-p(R2,CPE2)`(円弧 2 つ)、`L0-R0-p(R1,CPE1)-Wo1`。

| 引数      | 内容                                                                                               |
| --------- | -------------------------------------------------------------------------------------------------- |
| `circuit` | 回路(既定 `R0-p(R1,CPE1)`)                                                                         |
| `guess`   | 初期値。回路がパラメータを名付ける順に 1 つずつ(`R0-p(R1,CPE1)` なら R0, R1, Q1, n1)。省略時は推定 |
| その他    | `frequency`, `zre`, `zim`, `imaginary`, `weighting`, `f_min`, `f_max` は `eis_fit` と同じ          |

初期値は回路の形によらずスペクトルから推定します。主の直列にある抵抗で高周波側の切片を、並列の中の抵抗で円弧が覆う Z′ の幅を分け、C・CPE には円弧の頂点の時定数(ω R C = 1)を、Warburg には低周波側の大きさを当てます。C・CPE が複数あるときは、回路で先に書いたものほど時定数を短く(高周波側の円弧に)します。その初期値と、そのまわりに散らした 15 点から始めたフィットのうち最もよく合ったものを採ります。

返す値: `circuit`、`parameters`(パラメータ名の並び)、各パラメータと `_sigma`、`chisq`、`chisq_reduced`、`frequencies`、`warnings`。作る wave は `eis_fit` と同じ `zre_fit`、`zim_fit` です。

### 限界

- 2 つの枝を入れ替えても同じ回路になるとき(`p(R1,CPE1)-p(R2,CPE2)` など)、どちらのラベルがどの円弧になるかは初期値で決まります。先に書いたほうが高周波側の円弧になるよう推定しますが、確実にしたいときは `guess` を与えてください。
- 素子の多い回路では、データで決まらないパラメータの σ が大きくなったり、境界に張り付いたりします(`warnings` に出ます)。

## Nyquist 図のグラフテンプレート

`templates/nyquist.json` は Nyquist 図のグラフテンプレートです(アプリの **Graph Templates… › Export** の形式)。プラグインダイアログの **Add Graph Templates to Experiment** で実験に入ります。スロットは `zre`, `zim`(データ、丸印)と `zre_fit`, `zim_fit`(フィット、線)で、軸は Z′ (Ω) と −Z″ (Ω) で、プロット領域は高さ 7 cm、幅は Plan 1(Z′ と −Z″ の 1 Ω が同じ長さ)です。半円が半円に見えます。

```python
op.graph_template("Nyquist").make(zre="zre", zim="zim", zre_fit="f_zre_fit", zim_fit="f_zim_fit")
```

虚部の wave は −Z″(正)を想定しています。

## EIS フィットのパネル

`panels/eis_fit.json` は、周波数・Z′・Z″ の wave、虚部の向き、モデル、重みを選んで **Fit** を押すと `eis_fit` を呼ぶパネルです。プラグインダイアログの **Add Panels to Experiment** で実験に入ります(パネル `EISFit`)。ボタンが呼ぶのはプラグインの Action だけなので、パネルは「データのみ」です。プラグインを外してもパネルは残り、ボタンを押すと、プラグインを入れるか有効にするよう表示します。

## EIS Circuit Fitting: 回路を見ながら編集する画面

**Analysis › EIS Circuit Fitting…**(入れると現れます)は、このプラグインの view `eis`(`electrochem/view.py`)です。画面はプラグインの Python がアプリの部品で組み立て、アプリが描きます。

- 上段で周波数・Z′・Z″ の wave、虚部の向き、回路(`R0-p(R1,CPE1)` など。よく使う回路は候補に出ます)を選びます
- 右の表にパラメータが並び、値は spectrum から推定されます(**Guess** でもう一度)。値を書き換えるたびに、左の Nyquist 図と Bode 図(|Z| と位相)に回路の曲線が描き直されます。回路を変えると、同じ名前のパラメータは値を引き継ぎます
- **Fit** は `eis_circuit` を表の値から実行し(履歴に `op.invoke(..., replace=True)` として残り、2 回目からは前の `zre_fit`/`zim_fit` を作り直します)、求まった値と σ を表に戻します
- **Diagram** タブには回路が図で出ます。パレット(**+ R**、**+ C**、…)で素子を足し、端子から端子へドラッグしてつなぐと、つながりが直列と並列でまとまったところで回路の文字列とパラメータの表が追いかけます(`electrochem/diagram.py`)。まとまらないうち(どこにもつながらない端子、ブリッジ)は、理由が下に出て回路は前のままです。回路の文字列を書き換えると図が並べ直されます
- ウィンドウの中の編集は Ctrl+Z で戻せます。ウィンドウの中身は Experiment に保存され、開き直すと残したところから、なければ最後に残したフィットから始まります

## 検算

`tests/test_electrochem.py` が、答えのわかっている合成データで確かめます。

- CV: 可逆系の CV(Nernst 式を満たす表面濃度から、半積分の関係で電流を数値的に求めたもの)で、Epa − E0 = 1.109 RT/F = 28.5 mV、E1/2 = E0、ΔEp ≈ 57.4 mV、ipa が Randles–Ševčík 式に 1 % 以内で合うこと。傾いたベースラインに乗った Gauss 形のピーク(2 サイクル目、雑音あり・なし、符号と mV の扱い)。
- Tafel: Butler–Volmer 式(α = 0.5 / 0.6)から、両方の枝で勾配・j0・α が戻ること。雑音を入れた Tafel 直線で、真の値が報告した σ の 3 倍以内にあること。
- EIS: 3 つのモデルそれぞれで、雑音なしなら全パラメータが相対 10⁻⁶ 以内で戻り、0.5 % の雑音なら真の値が σ の 4 倍以内にあること、χ²/ν が雑音に見合うこと。
- EIS の回路: 回路の読み取り(パラメータ名と、書き損じへのエラー)、`R0-p(R1,C1)` などが `R(RC)` などのモデルと同じ Z になること。R・C・L・CPE・W・Wo・Ws を含む 5 つの回路で、推定した初期値から雑音なしのパラメータが相対 10⁻⁵ 以内で戻ること。円弧 2 つの回路に 0.5 % の雑音を入れて真の値が σ の 4 倍以内にあること、初期値を与えても同じ答えになること。

numpy と scipy のある Python で、リポジトリから実行します。

```sh
python3 examples/plugins/electrochem/tests/test_electrochem.py
# または
uv run --no-project --with numpy --with scipy python -I examples/plugins/electrochem/tests/test_electrochem.py
```

アプリの単体テスト(`src/app/plugins/electrochem.test.ts`)は同じ検算をプラグインが動く Pyodide で実行し、このフォルダがパッケージとして正しいことも確かめます。E2E テスト(`e2e/electrochem.spec.ts`)はダイアログからこのフォルダを入れて `eis_fit` を実行し、削除しても結果が残ることを確かめます。

## English

**electrochem** is an example OresmePro plugin that runs in the plugin sandbox (Python with NumPy and SciPy, no network, no storage). Install it from **Python › Plugins…** with _Install from GitHub…_ (`https://github.com/ks250206/OresmePro/tree/main/examples/plugins/electrochem`) or _Install from Folder…_ (this folder). Units: potentials in V (an `mV` wave is converted), currents in the current wave's unit, impedances in Ω, frequencies in Hz; anodic current positive (IUPAC) unless told otherwise.

- **`cv_peaks`** (current, potential, cycle, window, anodic_baseline, cathodic_baseline, convention): splits the CV into sweeps where the potential turns, finds the oxidation peak on the positive-going sweep and the reduction peak on the negative-going one (refined by a parabola through the points within three times the noise of the top), with optional linear baselines fitted over given potential ranges. Reports Epa, Epc, ΔEp, E1/2, ipa and ipc (heights above the baseline, positive) and ipa/ipc; makes `peak_E`/`peak_i` markers and, with baselines, a `baseline` wave to plot against the potential.
- **`tafel`** (current, potential, e_from, e_to, e_eq, area, temperature): least-squares line through log10|j| against η = E − E_eq over a range; reports the Tafel slope (mV/dec, negative on the cathodic branch), the exchange current density j0 (extrapolated to η = 0), the transfer coefficient α = ln(10)RT/(F|b|), with uncertainties from the fit's covariance; makes `abs` (|j|) and `fit` (the line from η = 0 to the end of the range).
- **`eis_fit`** (frequency, zre, zim, model, imaginary, weighting, f_min, f_max): complex nonlinear least squares (`scipy.optimize.least_squares` on stacked real and imaginary residuals, modulus weighting by default) of `R(RC)` = R0 + R1∥C1, `R(RQ)` = R0 + R1∥CPE, or `Randles` = R0 + CPE∥(R1 + semi-infinite Warburg σ). The imaginary wave holds −Z″ by default (`imaginary="Z''"` for Z″ itself). Initial guesses come from the high-frequency intercept, the arc's apex and the low-frequency Warburg slope; uncertainties from the Jacobian, χ² and reduced χ². Makes `zre_fit`/`zim_fit` at the measured frequencies, in the same sign convention as the input.
- **`eis_circuit`** (frequency, zre, zim, circuit, guess, imaginary, weighting, f_min, f_max): the same fit for any circuit written as [impedance.py](https://github.com/ECSHackWeek/impedance.py) writes them, implemented here because impedance.py needs matplotlib and altair (about 11 MB more if the app shipped it); its elements give the same Z as impedance.py's. Series is `-`, parallel `p(a, b, ...)`; elements are a kind and a label starting with a digit or `_`: `R` (Ω), `C` (F), `L` (H), `CPE` or `Q` (`Q1`, `n1`), `W` (semi-infinite Warburg σ), `Wo` and `Ws` (finite Warburg, open and short: `Wo1_Z0`, `Wo1_tau`). Starting values are guessed from the spectrum for any circuit (series resistors share the high-frequency intercept, resistors in parallel branches the span of Z′, capacitors and CPEs the arc's time constant, those written first the shorter ones) or given as `guess` in the order of the parameters; the best of fits from the guess and 15 starts scattered around it is kept. Reports `circuit`, `parameters`, each parameter with its `_sigma`, χ² and reduced χ²; makes `zre_fit`/`zim_fit`.
- **Nyquist graph template** (`templates/nyquist.json`, in the app's export format): slots `zre`, `zim` (data, markers) and `zre_fit`, `zim_fit` (fit, line); axes Z′ (Ω) and −Z″ (Ω); the plot area is 7 cm tall and its width is Plan 1, so an ohm is as long along Z′ as along −Z″ and a semicircle looks like one.
- **EIS Circuit Fitting** (the view `eis`, `electrochem/view.py`; **Analysis › EIS Circuit Fitting…** once installed): a window its Python builds of the app's parts. Choose the frequency, Z′ and Z″ waves and a circuit; the parameters, guessed from the spectrum, are a table, and every edit draws the circuit again on Nyquist and Bode plots. **Fit** runs `eis_circuit` from the table's values (recorded as `op.invoke(..., replace=True)`, making its waves again in place) and puts what it found, with σ, back into the table. The **Diagram** tab draws the circuit: elements added from the palette and wired port to port become the circuit and its table once they reduce to parts in series and in parallel (`electrochem/diagram.py`); until then it says why, and the circuit stays. A circuit written as text is drawn again. Edits are undone with Ctrl+Z; the window is kept in the experiment, and opened again it goes on from where it was left (or else from the last fit kept).
- **EIS fit panel** (`panels/eis_fit.json`): pick the frequency, Z′ and Z″ waves, the sign of Z″, the model and the weighting, and click **Fit** to call `eis_fit`. Add it with **Add Panels to Experiment**; it calls only the plugin's action, so it is data only.

Limits: only a semi-infinite Warburg element (no finite-length diffusion), no inductive high-frequency points (exclude them with `f_max`), and initial guesses that expect a visible arc. `tests/test_electrochem.py` checks every action on synthetic data with known answers (a simulated reversible CV against Randles–Ševčík and the 28.5 mV peak offset, Butler–Volmer currents, the three circuits with and without noise); run it with any Python that has NumPy and SciPy.
