/**
 * 从本地 Obsidian / 坚果云同步目录拉取公开笔记
 *
 * 用法:
 *   npm run sync:vault
 *   OBSIDIAN_VAULT="D:/Nutstore/Notes" npm run sync:vault
 *   npm run sync:vault -- --dry-run
 *   npm run sync:vault -- --clean
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './lib/load-env.mjs';
import { syncLocalVault } from './lib/vault-sync.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
loadEnv(root);

const dryRun = process.argv.includes('--dry-run');
const clean = process.argv.includes('--clean');

/** 优先：环境变量 → 坚果云本地盘 → 默认 Obsidian Vault */
const DEFAULT_VAULT = 'C:/Users/admin/Documents/Obsidian Vault';
const vault =
	process.env.OBSIDIAN_VAULT ||
	process.env.NUTSTORE_VAULT ||
	process.env.NUTSTORE_LOCAL_PATH ||
	DEFAULT_VAULT;

const postsOut = path.join(root, 'src/content/posts');
const assetsOut = path.join(root, 'public/assets');

try {
	console.log(`Vault: ${vault}`);
	console.log(`Out:   ${postsOut}（统一文章流）`);
	const { mdCount, assetCount, skipCount } = syncLocalVault({
		vault,
		postsOut,
		assetsOut,
		dryRun,
		clean,
	});
	console.log(
		dryRun
			? `[dry-run] 将同步 ${mdCount} 篇笔记, ${assetCount} 个资源, 跳过 ${skipCount}`
			: `完成：同步 ${mdCount} 篇笔记, ${assetCount} 个资源, 跳过 ${skipCount}`,
	);
} catch (e) {
	console.error(e.message || e);
	console.error(
		'提示：把坚果云里的库路径写到 .env 的 NUTSTORE_VAULT，或设环境变量 OBSIDIAN_VAULT',
	);
	process.exit(1);
}
