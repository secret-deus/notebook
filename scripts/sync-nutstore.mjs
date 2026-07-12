/**
 * 从坚果云接入笔记
 *
 * 模式 A — 本地同步盘（推荐，有坚果云客户端时）:
 *   .env 设置 NUTSTORE_VAULT=D:/Nutstore/我的坚果云/Obsidian
 *   npm run sync:nutstore
 *
 * 模式 B — WebDAV（本机没有客户端时）:
 *   .env 设置:
 *     NUTSTORE_WEBDAV_USER=你的坚果云邮箱
 *     NUTSTORE_WEBDAV_PASS=应用密码（账号安全页生成，不是登录密码）
 *     NUTSTORE_WEBDAV_PATH=/dav/你的库文件夹名   （可选，默认整盘 dav 根下递归 .md）
 *   npm run sync:nutstore -- --webdav
 *
 * 其它:
 *   --dry-run  只列文件
 *   --clean    同步前清空 src/content/notes
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './lib/load-env.mjs';
import {
	IMAGE_EXT,
	ensureDir,
	ensureTitle,
	parseFrontmatter,
	shouldPublish,
	syncLocalVault,
} from './lib/vault-sync.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
loadEnv(root);

const dryRun = process.argv.includes('--dry-run');
const clean = process.argv.includes('--clean');
const forceWebdav = process.argv.includes('--webdav');

const notesOut = path.join(root, 'src/content/notes');
const assetsOut = path.join(root, 'public/assets');
const cacheDir = path.join(root, '.cache/nutstore-vault');

const DAV_BASE = (process.env.NUTSTORE_WEBDAV_URL || 'https://dav.jianguoyun.com/dav').replace(
	/\/$/,
	'',
);

function authHeader() {
	const user = process.env.NUTSTORE_WEBDAV_USER || process.env.NUTSTORE_USER;
	const pass = process.env.NUTSTORE_WEBDAV_PASS || process.env.NUTSTORE_PASS;
	if (!user || !pass) {
		throw new Error(
			'缺少 WebDAV 凭证。请在 .env 设置 NUTSTORE_WEBDAV_USER / NUTSTORE_WEBDAV_PASS\n' +
				'应用密码：坚果云网页 → 账户信息 → 安全选项 → 添加应用密码',
		);
	}
	return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

function joinDav(base, rel) {
	const b = base.replace(/\/$/, '');
	const r = String(rel || '').replace(/^\/+/, '');
	return r ? `${b}/${r}` : b;
}

/** PROPFIND 列出一层；返回 { href, isDir, displayName }[] */
async function propfind(url, depth = '1') {
	const res = await fetch(url, {
		method: 'PROPFIND',
		headers: {
			Authorization: authHeader(),
			Depth: depth,
			'Content-Type': 'application/xml; charset=utf-8',
		},
		body: `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:displayname/>
    <d:resourcetype/>
    <d:getcontentlength/>
  </d:prop>
</d:propfind>`,
	});

	if (!res.ok) {
		const t = await res.text().catch(() => '');
		throw new Error(`WebDAV PROPFIND 失败 ${res.status} ${url}\n${t.slice(0, 300)}`);
	}

	const xml = await res.text();
	const responses = [];
	const chunks = xml.split(/<d:response[\s>]/i).slice(1);
	for (const chunk of chunks) {
		const hrefM = chunk.match(/<d:href>([^<]+)<\/d:href>/i);
		if (!hrefM) continue;
		let href = hrefM[1].trim();
		try {
			href = decodeURIComponent(href);
		} catch {
			/* keep raw */
		}
		const isDir = /<d:collection\s*\/>/i.test(chunk) || /<d:collection>/i.test(chunk);
		const nameM = chunk.match(/<d:displayname>([^<]*)<\/d:displayname>/i);
		const displayName = nameM ? nameM[1] : path.posix.basename(href.replace(/\/$/, ''));
		responses.push({ href, isDir, displayName });
	}
	return responses;
}

/** 递归收集 .md / 图片的 WebDAV 路径（相对 dav root 的 path） */
async function listRemoteFiles(startUrl) {
	const found = [];
	const queue = [startUrl];
	const seen = new Set();

	while (queue.length) {
		const url = queue.shift();
		if (seen.has(url)) continue;
		seen.add(url);

		const items = await propfind(url, '1');
		// 第一项通常是自己
		for (const item of items) {
			const abs = item.href.startsWith('http')
				? item.href
				: `https://dav.jianguoyun.com${item.href.startsWith('/') ? '' : '/'}${item.href}`;

			// 跳过自身
			const normSelf = url.replace(/\/$/, '');
			const normItem = abs.replace(/\/$/, '');
			if (normItem === normSelf) continue;

			if (item.isDir) {
				// 跳过隐藏/系统目录
				const base = item.displayName || path.posix.basename(normItem);
				if (base.startsWith('.')) continue;
				if (['private', 'templates', 'template', '.obsidian', '.trash'].includes(base.toLowerCase()))
					continue;
				queue.push(normItem.endsWith('/') ? normItem : normItem + '/');
				continue;
			}

			const ext = path.extname(normItem).toLowerCase();
			if (ext === '.md' || ext === '.mdx' || IMAGE_EXT.has(ext)) {
				found.push(abs);
			}
		}
	}
	return found;
}

function remoteToRel(remoteUrl, rootUrl) {
	const r = remoteUrl.replace(/\/$/, '');
	const root = rootUrl.replace(/\/$/, '');
	let rel = r.startsWith(root) ? r.slice(root.length) : r;
	rel = rel.replace(/^\/+/, '');
	try {
		rel = decodeURIComponent(rel);
	} catch {
		/* ignore */
	}
	return rel;
}

async function downloadToCache(remoteFiles, rootUrl) {
	ensureDir(cacheDir);
	// 清空缓存目录
	for (const name of fs.readdirSync(cacheDir)) {
		fs.rmSync(path.join(cacheDir, name), { recursive: true, force: true });
	}

	let n = 0;
	for (const url of remoteFiles) {
		const rel = remoteToRel(url, rootUrl);
		const dest = path.join(cacheDir, rel);
		if (dryRun) {
			console.log(`  ~ ${rel}`);
			n++;
			continue;
		}
		ensureDir(path.dirname(dest));
		const res = await fetch(url, { headers: { Authorization: authHeader() } });
		if (!res.ok) {
			console.warn(`  ! 下载失败 ${res.status}: ${rel}`);
			continue;
		}
		const buf = Buffer.from(await res.arrayBuffer());
		fs.writeFileSync(dest, buf);
		n++;
		if (n % 20 === 0) console.log(`  … 已下载 ${n} 个文件`);
	}
	return n;
}

function resolveLocalVault() {
	return (
		process.env.NUTSTORE_VAULT ||
		process.env.NUTSTORE_LOCAL_PATH ||
		process.env.OBSIDIAN_VAULT ||
		''
	);
}

async function main() {
	const local = resolveLocalVault();
	const hasWebdavCred =
		Boolean(process.env.NUTSTORE_WEBDAV_USER || process.env.NUTSTORE_USER) &&
		Boolean(process.env.NUTSTORE_WEBDAV_PASS || process.env.NUTSTORE_PASS);

	// 有本地路径且存在、未强制 webdav → 本地模式
	if (local && fs.existsSync(local) && !forceWebdav) {
		console.log('模式: 坚果云本地同步盘');
		console.log(`Vault: ${local}`);
		console.log(`Out:   ${notesOut}`);
		const r = syncLocalVault({ vault: local, notesOut, assetsOut, dryRun, clean });
		console.log(
			dryRun
				? `[dry-run] 将同步 ${r.mdCount} 篇笔记, ${r.assetCount} 个资源, 跳过 ${r.skipCount}`
				: `完成：同步 ${r.mdCount} 篇笔记, ${r.assetCount} 个资源, 跳过 ${r.skipCount}`,
		);
		return;
	}

	// 无本机库 → WebDAV（填了凭证即可，不必强加 --webdav）
	if (!hasWebdavCred) {
		console.error('笔记不在本机时，请用坚果云 WebDAV：\n');
		console.error('1. 打开 https://www.jianguoyun.com/d/account → 安全选项 → 添加应用密码');
		console.error('2. 编辑项目根目录 .env：');
		console.error('     NUTSTORE_WEBDAV_USER=你的邮箱');
		console.error('     NUTSTORE_WEBDAV_PASS=应用密码（不是登录密码）');
		console.error('     NUTSTORE_WEBDAV_PATH=库文件夹名   # 可选，先留空可扫整个盘');
		console.error('3. 运行: npm run sync:nutstore:webdav');
		console.error('   或:   npm run sync:nutstore -- --dry-run');
		process.exit(1);
	}

	if (local && !fs.existsSync(local)) {
		console.warn(`提示: NUTSTORE_VAULT 路径不存在，改走 WebDAV: ${local}`);
	}

	// WebDAV 模式
	const sub = (process.env.NUTSTORE_WEBDAV_PATH || process.env.NUTSTORE_DAV_PATH || '').replace(
		/^\/dav\/?/i,
		'',
	);
	const rootUrl = joinDav(DAV_BASE, sub);
	console.log('模式: 坚果云 WebDAV');
	console.log(`Remote: ${rootUrl}`);
	console.log(`Cache:  ${cacheDir}`);
	console.log(`Out:    ${notesOut}`);

	console.log('列出远程文件…');
	const files = await listRemoteFiles(rootUrl.endsWith('/') ? rootUrl : rootUrl + '/');
	console.log(`远程匹配 ${files.length} 个文件（md/图片）`);

	const downloaded = await downloadToCache(files, rootUrl);
	console.log(dryRun ? `[dry-run] 将下载 ${downloaded} 个` : `已下载 ${downloaded} 个到缓存`);

	if (dryRun) return;

	const r = syncLocalVault({
		vault: cacheDir,
		notesOut,
		assetsOut,
		dryRun: false,
		clean,
	});
	console.log(`完成：同步 ${r.mdCount} 篇笔记, ${r.assetCount} 个资源, 跳过 ${r.skipCount}`);
}

main().catch((e) => {
	console.error(e.message || e);
	process.exit(1);
});
