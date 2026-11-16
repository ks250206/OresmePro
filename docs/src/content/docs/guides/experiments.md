---
title: Experiment の保存と読み込み
sidebar:
  order: 9
---

Experiment には Wave、フォルダ、グラフ、テーブル、Procedure、関連ファイル、解析結果が含まれます。

## ブラウザーで作業を再開する

**File → New Experiment** で新規作成し、**File → Experiments…** でブラウザーに保存された Experiment を開きます。保存状態はステータスバーで確認できます。同じ Experiment を複数タブで開いた場合は、1つのタブが保存を担当します。

自動保存はブラウザーの OPFS に依存します。ブラウザーのデータを消去すると失われる可能性があるため、持ち出すデータはファイルとして保存してください。

## ファイルとして保存・復元する

1. **File → Save Experiment As…**(**Ctrl+S** / **⌘S**)でファイル名を入力し、`.oresme` ファイルとしてダウンロードします。既定は Experiment の名前で、`.oresme` は自動で付きます。
2. 復元するには **File → Open Experiment…** を使うか、そのファイルをアプリにドロップします。
3. 自動実行を指定した Procedure がある Experiment をファイルから開くと、実行を許可するか確認されます。コードを確認するまで実行を保留できます。

## ウィンドウを閉じる・削除する・名前を変える

ウィンドウ左上の × を押すと、**Close** と **Kill** を選ぶダイアログが出ます。

- **Close**: ウィンドウを閉じますが、グラフ・テーブル・Procedure などの中身は Experiment に残ります。**Windows** メニューの種類別の一覧(Graphs、Tables、Procedures、Layouts、Panels)に「(closed)」として並び、選ぶとその時点のデータで再び開きます(Igor のウィンドウ再作成マクロに当たります)。閉じたグラフも Wave を使っているので、その Wave を削除するにはウィンドウを Kill してください。
- **Kill**: ウィンドウと中身を削除します。表示していた Wave は残ります。

どちらも Undo できます。Alt(Option)を押しながら × をクリックすると、確認なしで Kill します。

ウィンドウの名前は、タイトルバーのダブルクリック、**Windows → Rename Window…**、各ウィンドウの右クリックメニューで変えられます。グラフの名前を変えると、それを載せたページレイアウトも追随します。**New Graph**・**New Table**・**New Procedure** では作るときに名前を指定できます。

```python
op.close_window("Graph0")          # g.close() でも同じ
op.reopen_window("Graph0")         # g.reopen()
op.rename_window("Graph0", "Spectrum")
op.kill_window("Table0")
op.windows("graph", closed=False)  # 開いているグラフの名前
```

## ノートを書く

**Windows → New Note** で、Markdown で書くノートのウィンドウを作ります(Igor のノートブックに当たります)。実験と一緒に保存されるので、何をどの条件で行ったか、結果の考察などを残しておけます。

- **Split** は左で書き、右に整形した表示を打つそばから示します。**Edit** は書くだけ、**View** は読むだけです。中身のあるノートは View で開きます
- 見出し、強調、リスト、引用、コード、表、リンクが使えます
- 右クリックで **Export as name.md**(Markdown ファイルとして書き出し)、**Windows → Import Markdown as Note…** で `.md` ファイルを取り込めます

他の人から受け取った実験のノートでも安全に開けるよう、表示には次の制限があります。

- 文章中の HTML(`<script>` など)は文字としてそのまま表示します
- リンクは http、https、mailto のアドレスだけが有効で、新しいタブで開きます
- 画像はデータを文章に含むもの(`data:image/png;base64,...`)だけを表示します。アドレスで指定した画像は読み込まず、その画像へのリンクとして表示します

```python
n = op.new_note("log", "# Run 12")
n.append(f"Peak at {r.coef[1]:.3g} eV")  # 末尾に段落を追加
print(n.text)
```

[保存の実装](../../architecture/#opfs-による保存)
