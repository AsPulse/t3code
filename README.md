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
| `meta` | このブランチ。運用文書と `series` | 永続 |

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

## 新しいパッチを始める

```sh
git fetch upstream --tags
git switch -c carry/<name> <現在のベースのタグ>
# 実装してコミット
```

始めたら `series` に 1 行足して、`meta` にコミットします。

## upstream のリリースに追従する

初回だけ rerere を有効にします。一度解いたコンフリクトの解き方を git が覚えて、次から自動で当て直します。

```sh
git config rerere.enabled true
```

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
grep -v '^\s*#' ../t3code-meta/series | awk 'NF { print $1 }' | while read -r branch; do
  git merge --no-ff --no-edit "$branch" || break
done
```

`series` は `meta` ブランチにあるので、`meta` の worktree の中のファイルを読みます。merge は 1 本ずつ行い、パッチどうしのコンフリクトがどの組み合わせで起きたかが分かるようにしています。

### 5. ビルドして確認したら push する

```sh
git push origin "aspulse/$NEW"
git push --force-with-lease origin carry/<name> upstream-pr/<name> ...
```

rebase した `carry/*` と `upstream-pr/*` は履歴が書き換わるので、`--force-with-lease` が必要です。`aspulse/*` は作り直さないので、force push は不要です。

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

作業中のブランチを切り替えずに編集できるよう、`meta` は別の worktree に置きます。

```sh
git worktree add ../t3code-meta meta
```
