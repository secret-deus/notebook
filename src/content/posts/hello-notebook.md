---
title: 欢迎来到我的笔记博客
description: 用 Astro 搭的 Obsidian 笔记博客骨架，说明内容怎么组织。
pubDate: 2026-07-11
tags:
  - 博客
  - 开始
---

这是一篇**正式文章**示例。

## 两套内容

| 类型 | 目录 | 适合 |
|------|------|------|
| 文章 | `src/content/posts/` | 有日期的长文、教程、周记 |
| 笔记 | `src/content/notes/` | 常青笔记、卡片、概念页 |

## 写作流程

1. 在 Obsidian 里写
2. 公开笔记加 frontmatter（见下方）
3. `npm run sync:vault` 同步
4. `npm run dev` 预览

```yaml
---
title: 笔记标题
tags: [技术, 笔记]
publish: true
---
```

笔记之间可以用双链互相引用，例如：[[写作约定]]、[[Obsidian 与本站]]。
