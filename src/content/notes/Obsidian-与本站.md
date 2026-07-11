---
title: Obsidian 与本站
description: Vault 如何接到这个 Astro 项目。
tags:
  - Obsidian
  - 工作流
publish: true
pubDate: 2026-07-11
---

## 默认库路径

见 `src/consts.ts` 里的 `DEFAULT_VAULT_PATH`，当前指向：

`C:/Users/admin/Documents/Obsidian Vault`

也可用环境变量覆盖：

```powershell
$env:OBSIDIAN_VAULT="D:\path\to\vault"
npm run sync:vault
```

## 同步规则（sync-vault）

脚本会：

1. 扫描 Vault 下的 `.md`
2. 跳过 `.obsidian`、以 `.` 开头的目录、`private` / `templates` 等
3. 若 frontmatter 含 `publish: false` 或 `draft: true` 则跳过
4. 拷贝到 `src/content/notes/`，并尽量补全缺失的 `title`

## 图片

把图片放到 Vault 的可同步位置后，同步脚本会把常见图片拷到 `public/assets/`。

正文里可用：

```md
![[photo.png]]
```

或标准 Markdown：

```md
![说明](/assets/photo.png)
```

## 相关

- [[写作约定]]
- [示例文章](/posts/hello-notebook/)
