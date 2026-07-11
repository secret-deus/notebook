# Notebook —— Obsidian 笔记博客（Astro）

用 **Obsidian** 写作，用 **Astro** 生成静态站点的个人笔记博客。

- 文章（时间线）+ 笔记（常青 / 双链）
- 支持 `[[wikilink]]`、标签、RSS、sitemap
- 一键从 Vault 同步公开笔记

## 快速开始

```bash
npm install
npm run dev
```

浏览器打开终端提示的地址（一般是 `http://localhost:4321`）。

```bash
npm run build    # 产出到 dist/
npm run preview  # 预览构建结果
```

## 内容放哪

| 路径 | 说明 |
|------|------|
| `src/content/posts/` | 正式文章（需 `title` + `pubDate`） |
| `src/content/notes/` | 笔记（可从 Obsidian 同步） |
| `public/assets/` | 图片等静态资源 |
| `src/consts.ts` | 站名、作者、默认 Vault 路径 |

### 文章示例 frontmatter

```yaml
---
title: 标题
description: 摘要
pubDate: 2026-07-11
tags: [博客]
---
```

### 笔记示例 frontmatter

```yaml
---
title: 标题
tags: [笔记]
publish: true
---
```

`publish: false` 或 `draft: true` 不会上线。

## 从 Obsidian 同步

默认库路径：`C:/Users/admin/Documents/Obsidian Vault`  
（可在 `src/consts.ts` 或环境变量 `OBSIDIAN_VAULT` 修改）

```powershell
npm run sync:vault
# 或
$env:OBSIDIAN_VAULT="D:\path\to\vault"
npm run sync:vault
# 只预览不同步
npm run sync:vault -- --dry-run
```

会跳过 `.obsidian`、`private`、`templates` 等目录，以及 `publish: false` 的笔记。

## 双链

笔记正文中的 `[[写作约定]]` 会链到 `/notes/写作约定/`。  
文件名与双链目标保持一致即可（中文文件名可用）。

## 自定义

- **站名 / 文案**：`src/consts.ts`
- **配色 / 字体**：`src/styles/global.css`
- **导航**：`src/components/Header.astro`
- **布局**：`src/layouts/`
- **Obsidian 语法插件**：`src/plugins/remark-obsidian.mjs`

Astro 本身可继续加 React/Vue、Tailwind、部署适配器等，自由度很高。

## 部署

构建产物在 `dist/`，可丢到：

- GitHub Pages / Cloudflare Pages / Netlify / 任意静态托管
- 改 `astro.config.mjs` 里的 `site` 为你的域名

## 命令

| 命令 | 作用 |
|------|------|
| `npm run dev` | 本地开发 |
| `npm run build` | 生产构建 |
| `npm run preview` | 预览构建 |
| `npm run sync:vault` | 从 Obsidian 同步笔记 |
