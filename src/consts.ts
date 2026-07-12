/** 站点全局配置 —— 改这里就能换站名、域名、作者信息 */
export const SITE_TITLE = 'Notebook';
export const SITE_DESCRIPTION = '用 Obsidian 写作，用 Astro 发布的个人笔记博客。';
export const SITE_AUTHOR = '你的名字';

/** 部署域名，构建 RSS / sitemap 会用到（不要带 https://） */
export const SITE_URL = 'https://notebook.any.me.uk';

/**
 * Obsidian 库路径（给 scripts/sync-vault.mjs 用）
 * 也可用环境变量 OBSIDIAN_VAULT 覆盖
 */
export const DEFAULT_VAULT_PATH = 'C:/Users/admin/Documents/Obsidian Vault';
