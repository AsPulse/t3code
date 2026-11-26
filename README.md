# AsPulse/t3code の運用

このリポジトリは [pingdotgg/t3code](https://github.com/pingdotgg/t3code) の fork です。upstream のリリースに追従しつつ、いくつかの独自パッチを当てたバージョンを使います。

このブランチ (`meta`) には運用のための文書とファイルだけを置きます。T3 Code のコードとは履歴を共有しない orphan ブランチなので、他のどのブランチにも混ざりません。

## ブランチ構成

| ブランチ | 役割 | 寿命 |
|---|---|---|
| `main` | upstream の `main` をそのまま追う。自分のコミットは載せない | 永続 |
| `carry/<name>` | 自分専用で持ち続ける機能。1 機能につき 1 本 | upstream に同等機能が入るまで |
| `upstream-pr/<name>` | upstream に PR を出している修正。取り込まれたら消す | PR が閉じるまで |
| `aspulse/<tag>` | upstream のタグに `series` のブランチを全部 merge したもの。実際にビルドして使う | 作り直さない。古いものはロールバック用に残す |
| `meta` | このブランチ。運用文書、`series`、開発用 `flake.nix` | 永続 |

`carry/*` と `upstream-pr/*` は、必ず upstream のリリースタグから生やします。機能どうしは互いに依存させません。依存がどうしても必要なときだけ、後の機能を前の機能のブランチの上に積みます。

```
upstream ──●── v0.1.11 ────────●── v0.1.12
                │                │
carry/a ────────┴─ a1 a2         ├─ a1' a2'   (v0.1.12 へ rebase)
carry/b ────────┴─ b1            ├─ b1'
carry/c ────────┴─ c1            ×            (upstream に同等機能が入ったので外す)
                                 │
aspulse/v0.1.11                  aspulse/v0.1.12
= v0.1.11 + a + b + c            = v0.1.12 + a' + b'
```

追従するのは安定版のタグ (`v0.1.11` など) です。`-nightly` 付きのタグは、必要な修正が安定版に来るのを待てないときだけ使います。

## `series` ファイル

統合ブランチに何をどの順で入れるかは、このブランチの [`series`](./series) が決めます。

```
# branch               note
carry/a
upstream-pr/b          https://github.com/pingdotgg/t3code/pull/123
# carry/c              v0.1.12 で upstream に同等機能が入ったので外した
```

- 1 行につき 1 ブランチです。先頭の単語がブランチ名で、残りはメモです
- `#` で始まる行は無視されます。外したブランチは消さずにコメントアウトし、外した理由を書きます
- 上から順に merge します。依存があるブランチは依存先より下に書きます

## clone したら最初にやること

```sh
git remote add upstream https://github.com/pingdotgg/t3code.git
git fetch origin meta
git branch meta origin/meta
git config rerere.enabled true
git config core.hooksPath "$(git rev-parse --path-format=absolute --git-common-dir)/hooks"

for hook in post-checkout pre-commit; do
  git show "meta:hooks/$hook" > ".git/hooks/$hook"
  chmod +x ".git/hooks/$hook"
done
printf 'AGENTS.override.md\nCLAUDE.local.md\n' >> .git/info/exclude
.git/hooks/post-checkout
```

### エージェント向けの案内ファイル

upstream には `AGENTS.md` と `CLAUDE.md` があり、`main` は upstream のまま保つので、そこに fork の案内は書けません。代わりに `post-checkout` hook が、コミットしない案内ファイルを worktree ごとに置きます。

- `AGENTS.override.md`：Codex 向けです。中身は [`agents-override.md`](./agents-override.md) のコピーです。Codex はこのファイルがあると `AGENTS.md` を自動では読まないので、`AGENTS.md` を読むよう中に書いています
- `CLAUDE.local.md`：Claude Code 向けです。`@AGENTS.override.md` で上のファイルを読み込みます。upstream の `CLAUDE.md` が `@AGENTS.md` を読み込むので、`AGENTS.md` も自動で読まれます

`.git/hooks/` と `.git/info/exclude` は全部の worktree で共有されます。そのため、T3 Code や `git worktree add` で作った worktree にも同じファイルが置かれ、git からは無視されます。

upstream は `vp i` (`prepare`) のたびに `core.hooksPath` を `.vite-hooks/_` に書き換えようとしますが、あらかじめ `.git/hooks` の絶対パスを `core.hooksPath` に設定しておくと `vp` は上書きせずスキップします。upstream の `.vite-hooks/pre-commit` は `.git/hooks/pre-commit` から委譲しています。

hook は、`meta` ブランチにコミットされた `agents-override.md` を毎回読みます。案内を変えるときは `agents-override.md` を編集してコミットします。hook 自体を変えたときは、上の `git show meta:hooks/...` の手順でもう一度コピーします。

### 開発環境（Nix devshell）

開発用の `flake.nix` も、各 `carry/*` や `main` からは切り離してこのブランチ (`meta`) に置きます。Node 26、patchelf 済みの `pnpm`、ローカル `node_modules/.bin/vp` へ委譲する `vp` シム、Rust (`cargo` / `rustc`)、および Linux 向けのパッチ済み Playwright Chromium (`PLAYWRIGHT_BROWSERS_PATH`) を提供します。

`meta` を隣に worktree として置いておき、メイン checkout と T3 Code の worktree 親ディレクトリに `.envrc` を配置します。親ディレクトリに置いておけば、新しく作った worktree ごとに `direnv allow` し直す必要がありません。

```sh
git worktree add ../t3code-meta meta

meta_dir="$(cd ../t3code-meta && pwd)"
printf 'use flake %s\n' "$meta_dir" > .envrc
printf '.envrc\n' >> .git/info/exclude
direnv allow

# T3 Code が作成する worktree 群にも共通で効かせる場合
mkdir -p ~/.t3/worktrees/t3code
printf 'use flake %s\n' "$meta_dir" > ~/.t3/worktrees/t3code/.envrc
direnv allow ~/.t3/worktrees/t3code
```

direnv が自動で走らない環境（エージェントや単発コマンド）では、`direnv exec . <cmd>` または `nix develop ../t3code-meta -c <cmd>` で実行します。

## 新しいパッチを始める

```sh
git fetch upstream --tags
git switch -c carry/<name> <現在のベースのタグ>
# 実装してコミット
```

始めたら `series` に 1 行足して、`meta` にコミットします。

## upstream のリリースに追従する

### 1. 新しいタグを取る

```sh
git fetch upstream --tags
git tag -l 'v*' --sort=-v:refname | grep -v nightly | head -3
```

以下では、古いタグを `OLD`、新しいタグを `NEW` とします。

### 2. 各パッチを rebase する

`series` に載っているブランチを 1 本ずつ rebase します。古いタグは新しいタグの祖先なので、`--onto` を指定しなくても自分のコミットだけが載せ替わります。

```sh
git rebase --update-refs "$NEW" carry/<name>
```

コンフリクトが出たら、そのブランチの中で解きます。どの機能の問題かがブランチ名で分かります。

### 3. rebase の前後で差分がどう変わったかを確認する

```sh
git range-diff "$OLD..carry/<name>@{1}" "$NEW..carry/<name>"
```

コンフリクトの解き方を間違えると、ここでパッチの中身が変わって見えます。

### 4. 統合ブランチを組み立てる

```sh
git switch -c "aspulse/$NEW" "$NEW"
git show meta:series | grep -v '^\s*#' | awk 'NF { print $1 }' | while read -r branch; do
  git merge --no-ff --no-edit "$branch" || break
done
```

`series` は `meta` ブランチから直接読むので、`meta` の worktree がなくても動きます。merge は 1 本ずつ行い、パッチどうしのコンフリクトがどの組み合わせで起きたかが分かるようにしています。

パッチどうしが同じ箇所を触っていると、統合ブランチを作り直すたびに同じコンフリクトが起きます。rerere はそのときの解き方を記録し、次から自動で当て直します。手順 2 の rebase では、前回解いた結果がすでにパッチの中身になっているので、rerere の記録はほとんど当たりません。

- 記録は `.git/rr-cache/` にあり、全部の worktree で共有されます。push されないので、別のマシンでは使えません
- `git gc` のときに、解決済みの記録は 60 日（`gc.rerereResolved`）、未解決の記録は 15 日（`gc.rerereUnresolved`）で消えます
- 毎回同じ組み合わせでぶつかるなら、片方をもう片方の上に積んで依存関係にするほうが根本的な対処です

### 5. ビルドして確認したら push する

```sh
git push origin "aspulse/$NEW"
git push --force-with-lease origin carry/<name> upstream-pr/<name> ...
```

rebase した `carry/*` と `upstream-pr/*` は履歴が書き換わるので、`--force-with-lease` が必要です。`aspulse/*` は作り直さないので、force push は不要です。

### 6. 配布物をビルドする

`aspulse-$NEW` タグを push すると、「Fork Release」が Linux x64 の CLI tarball をビルドし、タグと同じ名前の GitHub Release に載せます。

```sh
git tag "aspulse-$NEW" "aspulse/$NEW"
git push origin "aspulse-$NEW"
```

同じ upstream バージョンで作り直すときは、`aspulse-$NEW-2` のように末尾に番号を付けます。CI の進み具合は Actions タブの「Fork Release」で見ます。

macOS arm64 の DMG は、Nix と Xcode Command Line Tools が使える Apple Silicon Mac でビルドします。push したタグを指定してください。

```sh
curl -fsSL https://raw.githubusercontent.com/AsPulse/t3code/meta/scripts/build-mac.sh | bash -s -- "aspulse-$NEW" --upload
```

- `--upload` を付けると、認証済みの `gh` で DMG を Release に載せます。CI と Mac のどちらが先でも Release を作れます。添付を追加するたびに、その時点の全 tarball と DMG を含む `SHA256SUMS` を作り直します
- DMG は `~/Library/Caches/t3code-fork-build/t3code/release/` に残ります。アプリはアドホック署名で、公証はありません。アドホック署名はビルドごとに変わるので、入れ替えた後の初回起動でキーチェーンへのアクセス許可を求められることがあります。公式版で上書きされないよう、デスクトップの自動更新は無効です
- Launch check は省きます。起動すると普段使っている T3 Code とユーザーデータや単一インスタンスのロックを共有するためです
- fork の CLI では `t3 update` も画面からのサーバー更新も使いません。upstream の版に置き換わり、パッチが消えます

Mac にインストールするには `--install` を付けます。起動中の T3 Code があれば終了を待ちます。古いアプリを `~/Library/Caches/t3code-fork-build/backups/` に日時付きの zip で退避し、DMG のアプリを `/Applications/T3 Code (Beta).app` にコピーします。コピーしたアプリの隔離属性も取り除きます。

元に戻すには、T3 Code を終了し、`/Applications` にある新しいアプリをゴミ箱に移します。次に、`<zip>` を退避した zip のパスに置き換えて展開します。

```sh
ditto -x -k "<zip>" /Applications
```

## upstream に同等の機能が入ったとき

- **完全に置き換わった**：`series` の該当行をコメントアウトし、どのバージョンで入ったかを書きます。ブランチは消してかまいません
- **一部だけ置き換わった**：`carry/<name>` を「upstream の機能に足りない差分だけ」まで削って rebase し直します。削った経緯は `series` のメモに書きます
- **`upstream-pr/*` が取り込まれた**：`series` から外し、ブランチを消します

統合ブランチは毎回タグから作り直すので、外した機能の残骸は新しい統合ブランチに残りません。

## コンフリクトを減らすために

ブランチ構成よりも、次の 2 つのほうがコンフリクトの量への影響が大きいです。

- **upstream のコードを書き換える量を減らす**：新しいコードはなるべく新しいファイルに置きます。既存のファイルには、呼び出しを数行足すだけにします
- **汎用的な部分は upstream に PR を出す**：拡張ポイントだけでも取り込まれれば、fork 側で持つ差分が減ります

## このブランチを編集する

読むだけなら `git show meta:<file>` で足ります。編集するときは、作業中のブランチを切り替えずに済むよう、`meta` を別の worktree に取り出します。

```sh
git worktree add ../t3code-meta meta
```

編集が終わったら `git worktree remove ../t3code-meta` で消してかまいません。消えるのは作業ディレクトリだけで、`meta` ブランチは残ります。
