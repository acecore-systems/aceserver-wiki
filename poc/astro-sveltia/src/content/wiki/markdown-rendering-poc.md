---
title: Markdown表示確認
description: 見出し、一覧、引用、表、コードなど、Wiki記事で使う基本的なMarkdown記法の表示確認用サンプルです。
category: 技術検証
order: 20
draft: false
---

このページは表示確認専用です。エースサーバーの仕様や利用案内を記載した記事ではありません。

## 基本的な要素

通常の文章には、**太字**、_強調_、[内部リンク](/article/markdown-editing-poc/)を使用できます。

> 引用文は、本文と区別できるように左側へ線を表示します。

| 項目       | このPoCでの扱い     |
| ---------- | ------------------- |
| 記事本文   | Markdown            |
| メタデータ | YAML frontmatter    |
| 公開画面   | Astroによる静的HTML |

## コード

インラインコードは `draft: false` のように表示されます。

```text
記事を編集
変更を検証
公開へ反映
```
