# xps: CasaXPS のように使う XPS ピークフィットの見本プラグイン

> **アプリ本体に XPS Peak Fitting ウィンドウができました。** スペクトルの上で成分をドラッグし、CasaXPS のような成分の表で制約を書いてフィットできます(**Analysis › XPS Peak Fitting…**、Python では `op.xps_fit`)。プラグインを入れる必要はありません。このプラグインは、プラグインの書き方の見本と、サーベイからの定量(`quantify`)のために残してあります。

XPS スペクトルのピークモデルを、CasaXPS と同じ手順で作る OresmePro のプラグインです。領域(Region)を決め、その下に背景(Shirley・直線)を引き、CasaXPS の線形(GL、SGL、テール付き、LA)と成分の間の制約(`pos=A+1.5`、`area=A*0.5`、`fwhm=A`)を持つ合成成分を最小二乗でフィットします。領域の面積と感度係数(RSF)からの原子濃度も求めます。計算は合成スペクトルで検算してあります([検算](#検算))。

- [入れ方](#入れ方)
- [`xps_fit`: ピークモデル](#xps_fit-ピークモデル)
- [成分表の書き方](#成分表の書き方)
- [線形](#線形)
- [`quantify`: 原子濃度](#quantify-原子濃度)
- [限界](#限界)
- [English](#english)

## 入れ方

**Python › Plugins…** を開き、次のどちらかで入れます。

- **Install from GitHub…**: アドレスに `https://github.com/ks250206/OresmePro/tree/main/examples/plugins/xps` を入れて **Fetch**
- **Install from Folder…**: このフォルダ(`examples/plugins/xps`)を選びます

使う Python パッケージは numpy と scipy です。入るのは `oresme-plugin.json` に並んだファイルだけで、この README と `tests/` は入りません。

```python
op.invoke("plugin.xps.xps_fit", {
    "spectrum": "C1s",
    "components": "C-C: GL(30) pos=284.8; C-O: GL(30) pos=A+1.5 fwhm=A; O-C=O: GL(30) pos=288.8 fwhm=A",
    "region": [281, 293],
    "shift": -0.4,
})
```

## `xps_fit`: ピークモデル

| 引数            | 内容                                                                                               |
| --------------- | -------------------------------------------------------------------------------------------------- |
| `spectrum`      | 強度の wave(counts または cps)                                                                     |
| `components`    | 成分表([成分表の書き方](#成分表の書き方))                                                          |
| `energy`        | 各点のエネルギーの wave。省くと `spectrum` の X スケーリング                                       |
| `region`        | フィットする結合エネルギーの範囲 `[from, to]`(eV、`shift` を足したあと)。省くとスペクトル全体      |
| `background`    | `Shirley`(既定)、`Linear`、`None`                                                                  |
| `average`       | 背景の両端の高さを、端の何点の平均にするか(CasaXPS の Av Width にあたる。既定 5)                   |
| `energy_axis`   | エネルギーが `binding`(既定)か `kinetic` か。kinetic なら BE = hν − KE                             |
| `photon_energy` | hν(eV、既定 1486.6 = Al Kα。Mg Kα は 1253.6)                                                       |
| `shift`         | 帯電補正(eV)。すべての結合エネルギーに足します。C 1s が 285.6 eV に出て 284.8 eV にしたいなら −0.8 |
| `weighting`     | `poisson`(既定: 各点を 1/√counts で重み付け)か `unit`                                              |

背景はデータから計算し、フィットの間は固定します(CasaXPS と同じ)。Shirley は、両端の高さのあいだを、低結合エネルギー側から積算した「背景より上の面積」に比例して上がり、動かなくなるまで反復して求めます。

フィットは `scipy.optimize.least_squares`(trust region、制限付き)で、各成分の位置・FWHM・面積を動かします。制約で結ばれたパラメータは、結ばれた先と一緒に動きます。不確かさは解での Jacobian から(残差の分散で尺度合わせ)求め、結ばれたパラメータには結ばれた先の不確かさ(係数倍)を、固定したパラメータには 0 を付けます。**この不確かさには背景の不確かさ(両端のノイズ)が入っていません**。高結合エネルギー側の端に近い成分ほど、背景の段差の影響を受けます。

作る wave(領域の範囲だけ。最初の wave の隣に `<名前>_<役割>`):

- `region`: 領域のデータ
- `background`: 背景
- `comp_A`, `comp_B`, …: 各成分を背景に載せたもの(CasaXPS の表示と同じ)
- `envelope`: 背景 + 全成分
- `residual`: データ − envelope
- `be`: `energy` の wave を渡したときだけ。結合エネルギー(`shift` 込み)。X スケーリングから求めたときは、上の wave の X スケーリングが結合エネルギーになります

さらに、結合エネルギーの軸を反転させたグラフ(`XPSFit`)を作ります。下に データ(点)・背景・成分・envelope、上に残差を並べ、凡例には成分の名前が出ます。作ったあとは普通のグラフとして色や線を変えられます。

返す値: `components`(成分ごとに `letter`, `name`, `shape`, `position`, `fwhm`, `area` とそれぞれの `_sigma`、真の半値全幅 `width`、`rsf`、`percent` = 面積/RSF の割合、制約 `constraints`)、`chisq`, `chisq_reduced`, `residual_std`, `points`, `warnings`(制限に張り付いたパラメータなど)。**Analysis › Results** には `A_position`, `A_fwhm`, `A_area`, `A_percent`, … として残ります。

## 成分表の書き方

1 行に 1 成分(または `;` で区切る)。上から A, B, C, … と文字が付きます(CasaXPS の列の見出しと同じ)。

```
C-C:   GL(30) pos=284.8         fwhm=1.1[0.6,2]
C-O:   GL(30) pos=A+1.5         fwhm=A
O-C=O: GL(30) pos=288.8[288,290] fwhm=A  rsf=1
```

- `:` の前が名前(省くと文字が名前)。線形はどこに書いてもよく、省くと `GL(30)`
- `pos`: 位置(結合エネルギー、eV)。必須
- `fwhm`: 幅のパラメータ F(eV)。省くと 1.5 から
- `area`: 面積。省くとデータの高さから見積もった値から
- `rsf`: 相対感度係数(既定 1)。`percent` に使います
- `gauss`: 線形に畳み込むガウス関数の FWHM(eV、既定 0)。どの線形にも使えます

値の書き方:

| 書き方                                | 意味                                                                        |
| ------------------------------------- | --------------------------------------------------------------------------- |
| `284.8`                               | ここから動かす。制限は既定(pos は領域、fwhm は 0.05〜20 eV、area は 0 以上) |
| `284.8[284.5,285.1]`, `[284.5,285.1]` | 制限のなかで動かす(始めの値を省くと中央から)                                |
| `284.8!`                              | 固定                                                                        |
| `A+1.5`, `A-1.5`, `A*0.5`, `A/2`, `A` | 成分 A の同じパラメータに結ぶ(CasaXPS の制約)。位置の差、面積比、同じ幅など |

スピン軌道二重線の例(Ti 2p、金属):

```
Ti 2p3/2: LA(1.53,243) pos=454 fwhm=0.8 gauss=0.6
Ti 2p1/2: LA(1.53,243) pos=A+6.1 fwhm=A*1.4 area=A*0.5 gauss=0.6
```

制約が輪になっているとき(`A` の fwhm が `B` に、`B` が `A` に)、ない成分を指すときなどは、実行する前に理由を示して断ります。

## 線形

CasaXPS のマニュアル(2.3.15 rev 1.3、p. 55 と p. 301)の式で、u = (BE − E)/F、m は % です。u > 0 が高結合エネルギー側です。

| 線形         | 式                                                                                    |
| ------------ | ------------------------------------------------------------------------------------- |
| `GL(m)`      | exp(−4 ln2 (1 − m/100) u²) / (1 + 4 (m/100) u²)(ガウスとローレンツの積)               |
| `SGL(m)`     | (1 − m/100) exp(−4 ln2 u²) + (m/100) / (1 + 4u²)(和)                                  |
| `GL(m)T(k)`  | 高結合エネルギー側で GL + (1 − GL) exp(−k u)、反対側は GL。k が小さいほど裾が長い     |
| `SGL(m)T(k)` | 同じく SGL に裾を付けたもの                                                           |
| `LA(α,β)`    | 高結合エネルギー側で (1 + 4u²)^(−α)、反対側で (1 + 4u²)^(−β)。α, β > 0.5 で面積が有限 |

- F は CasaXPS が FWHM として表示する値です。真の半値全幅になるのは GL(0)、GL(100)、SGL(m) で裾もガウスもないときだけで、GL(30) では 0.961 F です。真の幅は `width` に出します
- 面積は線形全体(全エネルギー)の面積で、これをフィットします。ガウス関数を畳み込んでも面積は変わりません
- CasaXPS の `LA(α,β,m)` の 3 つ目の数 m(0〜499 の整数)はガウス関数の幅を決めますが、その換算はマニュアルに書かれていないため、同じ形を再現できません。`LA(α,β,m)` は断り、代わりに `gauss=` でガウス関数の FWHM を eV で与えます
- テールの式はマニュアルの印刷のままだと減衰しないので、上の表のように読んでいます

## `quantify`: 原子濃度

| 引数                                    | 内容                                                                   |
| --------------------------------------- | ---------------------------------------------------------------------- |
| `spectra`                               | スペクトルの wave(サーベイ 1 本でも、各領域のナロースキャンでも)       |
| `regions`                               | 領域の表。1 行(または `;`)に `名前: from to rsf=...`                   |
| `energies`                              | 各スペクトルのエネルギーの wave(同じ順に)。省くと X スケーリング       |
| `background`, `average`                 | `xps_fit` と同じ                                                       |
| `energy_axis`, `photon_energy`, `shift` | `xps_fit` と同じ                                                       |
| `ke_exponent`                           | 面積を KE^x でも割る(透過関数と脱出深さ)。RSF がそれを含むなら 0(既定) |

```
C 1s: 280 292 rsf=1
O 1s: 526-538 rsf=2.93
N 1s: 396 to 404 rsf=1.8
```

各領域は、その範囲を含む最初のスペクトルから取ります。背景より上を結合エネルギーで積分した面積を RSF(と KE^x)で割り、合計を 100 % にします。返す値は `regions`(名前、範囲、取ったスペクトル、ピークの位置、面積、RSF、補正した面積、`percent`)。Results には `C 1s %` などとして残ります。作る wave は各スペクトルの背景(`background`、スペクトルが複数なら `background1`, …)で、スペクトルと同じスケーリング・点数、領域の外は NaN です。

## 限界

- 背景はデータから一度計算して固定します。フィットしながら背景を求め直す方法(active Shirley など)や、Tougaard 背景はありません(アプリ本体の `op.background` には Tougaard があります)
- 不確かさに背景の不確かさは入りません。Monte Carlo による誤差評価もありません
- 非対称な線形(テール付き、LA)の裾は領域の外まで伸びます。領域の端に裾が残っていると、データの端から作る背景が裾の一部を取り込みます。裾が十分小さくなるまで領域を広げてください(CasaXPS のマニュアルも、非対称な線形での定量には注意を促しています)
- グラフの上でピークをドラッグして動かすことはできません。初期値は成分表で与えます
- DS(Doniach–Šunjić)、LF、Voigt の線形はまだありません

## 検算

`tests/test_xps.py` が、答えのわかっている合成スペクトルで確かめます。

- 線形: 各線形の面積が数値積分と 10⁻⁷ で一致すること、ガウス関数を畳み込んでも面積が保たれること、FWHM(ガウスどうしの畳み込みは √(F² + g²))、テールと LA が高結合エネルギー側に寄ること
- Shirley: Shirley の定義どおりに作った背景を、データから 10⁻⁶ の精度で求め直すこと(エネルギーが降順でも同じ)
- C 1s(GL(30) の 3 成分、位置と幅の制約あり、Shirley 背景): 雑音なしなら全パラメータが相対 10⁻⁶ 以内で戻ること。Poisson 雑音を入れると、真の値が σ の 4 倍以内にあり、χ²/ν ≈ 1 であること
- Ti 2p(LA(1.53,243) にガウス 0.6 eV、二重線の位置・幅・面積比の制約): 位置が 1 meV 以内、面積が 0.2 % 以内で戻ること
- 運動エネルギーの XY データ、帯電補正、領域の指定で同じ答えになること。断るべき入力を断ること
- 定量: サーベイ 1 本からと、運動エネルギーのナロースキャン 3 本からとで、同じ原子濃度になること

numpy と scipy のある Python で、リポジトリから実行します。

```sh
python3 examples/plugins/xps/tests/test_xps.py
# または
uv run --no-project --with numpy --with scipy python -I examples/plugins/xps/tests/test_xps.py
```

アプリの単体テスト(`src/app/plugins/xps.test.ts`)は同じ検算をプラグインが動く Pyodide で実行し、`xps_fit` の結果を wave・解析結果・グラフとしてアプリに取り込めることも確かめます。

## English

The app now has an **XPS Peak Fitting** window of its own (**Analysis › XPS Peak Fitting…**, `op.xps_fit` in Python), where components are dragged on the spectrum and constrained in a table as in CasaXPS, with no plugin to install. This plugin stays as an example of writing one, and for quantification from a survey (`quantify`).

**xps** is an example OresmePro plugin that builds peak models of XPS spectra the way CasaXPS does, in the plugin sandbox (Python with NumPy and SciPy). Install it from **Python › Plugins…** with _Install from GitHub…_ (`https://github.com/ks250206/OresmePro/tree/main/examples/plugins/xps`) or _Install from Folder…_ (this folder).

- **`xps_fit`** (spectrum, components, energy, region, background, average, energy_axis, photon_energy, shift, weighting): a region of binding energies, a background computed from the data and held fixed (Shirley, Linear or None, end levels averaged over `average` points), and synthetic components fitted by bounded least squares, weighted by 1/√counts by default. Components are a table, one per line or `;`, lettered A, B, C…: `name: shape pos=… fwhm=… area=… rsf=… gauss=…`. A value is a start (`284.8`), limits (`284.8[284,286]`), fixed (`284.8!`) or tied to another component as CasaXPS's constraints are (`A+1.5`, `A*0.5`, `A/2`, `A`). Shapes follow the CasaXPS manual: `GL(m)`, `SGL(m)`, `GL(m)T(k)`, `SGL(m)T(k)` and `LA(α,β)`; `gauss=` convolves any of them with a Gaussian of that FWHM in eV (CasaXPS's integer m of `LA(α,β,m)` is not documented, so it is refused). Kinetic energies are converted with the photon energy; `shift` is the charge correction. Makes the region's data, background, each component on the background, the envelope and the residual, and a graph with a reversed binding energy axis and the residual above; reports positions, F (the FWHM parameter), the true width, areas with uncertainties (which leave out the background's), and each component's share of area/RSF.
- **`quantify`** (spectra, regions, energies, background, average, energy_axis, photon_energy, shift, ke_exponent): regions `name: from to rsf=…`, each taken from the first spectrum that covers it (a survey or narrow scans), integrated over a background and divided by RSF (and KE^x); reports atomic percentages and makes the backgrounds.

Limits: the background is not refined with the fit and there is no Tougaard background here; uncertainties leave out the background's; asymmetric tails reaching past the region bias the background; no dragging of peaks on the graph; no DS, LF or Voigt shapes yet. `tests/test_xps.py` checks every part on synthetic spectra with known answers.
