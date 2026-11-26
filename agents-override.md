# AsPulse/t3code (fork)

このリポジトリは [pingdotgg/t3code](https://github.com/pingdotgg/t3code) の fork です。

- 作業を始める前に、必ずこのディレクトリの `AGENTS.md` を読むこと。このファイル (`AGENTS.override.md`) があると、Codex は `AGENTS.md` を自動では読まない
- fork の運用方法（ブランチ構成、upstream への追従手順）は `meta` ブランチにある。ブランチを作る、rebase する、統合ブランチを組み立てるといった作業の前に `git show meta:README.md` で読むこと
- このファイルと `CLAUDE.local.md` は `meta` ブランチの hook が生成する。直接編集せず、`meta` ブランチの `agents-override.md` を編集すること
- `vp` や Node 26 / Playwright が PATH にない場合（NixOS 上のエージェント実行など）は、`direnv exec . <cmd>` 経由で `meta` ブランチの devshell を使うこと
