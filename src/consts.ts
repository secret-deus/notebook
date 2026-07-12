/** 站点全局配置 —— 改这里就能换站名、域名、作者信息 */
export const SITE_TITLE = 'Notebook';
export const SITE_DESCRIPTION = '用 Obsidian 写作，用 Astro 发布的个人笔记博客。';
export const SITE_AUTHOR = '你的名字';

/** 部署域名，构建 RSS / sitemap 会用到（不要带 https://） */
export const SITE_URL = 'https://notebook.any.me.uk';

/**
 * 默认本地库路径（scripts/sync-vault.mjs / sync-nutstore.mjs）
 * 优先级实际由脚本决定：
 *   OBSIDIAN_VAULT / NUTSTORE_VAULT 环境变量 或 .env
 *   → 本字段
 * 坚果云：把同步盘里的库路径写到 .env 的 NUTSTORE_VAULT
 * WebDAV：见 .env.example 的 NUTSTORE_WEBDAV_*
 */
export const DEFAULT_VAULT_PATH = 'C:/Users/admin/Documents/Obsidian Vault';
