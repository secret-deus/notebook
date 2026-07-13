/**
 * 共享：从本地 Vault 同步到 src/content/posts（统一文章流）
 */
import fs from 'node:fs';
import path from 'node:path';

export const IGNORE_DIR = new Set([
	'.obsidian',
	'.git',
	'.trash',
	'node_modules',
	'private',
	'templates',
	'template',
	'attachments-private',
	'.nutstore',
	'.sync',
]);

export const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.pdf']);

export function ensureDir(dir) {
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function walk(dir, base = dir, files = []) {
	if (!fs.existsSync(dir)) return files;
	for (const name of fs.readdirSync(dir)) {
		if (name.startsWith('.') && name !== '.') continue;
		const full = path.join(dir, name);
		const rel = path.relative(base, full);
		const stat = fs.statSync(full);
		if (stat.isDirectory()) {
			if (IGNORE_DIR.has(name.toLowerCase())) continue;
			walk(full, base, files);
		} else {
			files.push({ full, rel });
		}
	}
	return files;
}

export function parseFrontmatter(raw) {
	if (!raw.startsWith('---')) return { data: {}, body: raw };
	const end = raw.indexOf('\n---', 3);
	if (end === -1) return { data: {}, body: raw };
	const fm = raw.slice(3, end).trim();
	const body = raw.slice(end + 4).replace(/^\r?\n/, '');
	const data = {};
	for (const line of fm.split(/\r?\n/)) {
		const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (!m) continue;
		const key = m[1];
		let val = m[2].trim();
		if (val === 'true') val = true;
		else if (val === 'false') val = false;
		else if (
			(val.startsWith('"') && val.endsWith('"')) ||
			(val.startsWith("'") && val.endsWith("'"))
		) {
			val = val.slice(1, -1);
		}
		data[key] = val;
	}
	return { data, body, fm };
}

export function shouldPublish(data) {
	if (data.publish === false) return false;
	if (data.draft === true) return false;
	return true;
}

export function ensureTitle(raw, filename) {
	const { data, body, fm } = parseFrontmatter(raw);
	if (data.title) return raw;
	const title = path.basename(filename, path.extname(filename));
	if (raw.startsWith('---') && fm !== undefined) {
		return `---\n${fm}\ntitle: ${JSON.stringify(title)}\n---\n${body}`;
	}
	return `---\ntitle: ${JSON.stringify(title)}\npublish: true\n---\n\n${raw}`;
}

/**
 * @param {object} opts
 * @param {string} opts.vault 源目录
 * @param {string} [opts.postsOut] 目标 posts 目录（文章流）
 * @param {string} [opts.notesOut] 兼容旧参数，等同 postsOut
 * @param {string} opts.assetsOut 目标资源目录
 * @param {boolean} [opts.dryRun]
 * @param {boolean} [opts.clean] 同步前清空目标目录
 */
export function syncLocalVault({
	vault,
	postsOut,
	notesOut,
	assetsOut,
	dryRun = false,
	clean = false,
}) {
	const outDir = postsOut || notesOut;
	if (!outDir) throw new Error('需要 postsOut（或兼容 notesOut）');
	if (!fs.existsSync(vault)) {
		throw new Error(`Vault 路径不存在: ${vault}`);
	}

	ensureDir(outDir);
	ensureDir(assetsOut);

	if (clean && !dryRun) {
		for (const name of fs.readdirSync(outDir)) {
			if (name === '.gitkeep') continue;
			fs.rmSync(path.join(outDir, name), { recursive: true, force: true });
		}
	}

	const files = walk(vault);
	let mdCount = 0;
	let assetCount = 0;
	let skipCount = 0;

	for (const { full, rel } of files) {
		const ext = path.extname(full).toLowerCase();
		const relPosix = rel.split(path.sep).join('/');

		if (IMAGE_EXT.has(ext)) {
			const dest = path.join(assetsOut, path.basename(full));
			if (!dryRun) fs.copyFileSync(full, dest);
			assetCount++;
			continue;
		}

		if (ext !== '.md' && ext !== '.mdx') continue;

		const raw = fs.readFileSync(full, 'utf8');
		const { data } = parseFrontmatter(raw);
		if (!shouldPublish(data)) {
			skipCount++;
			continue;
		}

		const destRel = relPosix.replace(/\.mdx?$/i, '') + path.extname(full);
		const dest = path.join(outDir, destRel);
		const content = ensureTitle(raw, full);

		if (dryRun) {
			console.log(`  + ${destRel}`);
		} else {
			ensureDir(path.dirname(dest));
			fs.writeFileSync(dest, content, 'utf8');
		}
		mdCount++;
	}

	return { mdCount, assetCount, skipCount };
}
