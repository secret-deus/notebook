/**
 * 从 Obsidian Vault 同步公开笔记到 src/content/notes
 *
 * 用法:
 *   npm run sync:vault
 *   OBSIDIAN_VAULT="D:/notes" npm run sync:vault
 *   node scripts/sync-vault.mjs --dry-run
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const dryRun = process.argv.includes('--dry-run');

const DEFAULT_VAULT = 'C:/Users/admin/Documents/Obsidian Vault';
const vault = process.env.OBSIDIAN_VAULT || DEFAULT_VAULT;
const notesOut = path.join(root, 'src/content/notes');
const assetsOut = path.join(root, 'public/assets');

const IGNORE_DIR = new Set([
	'.obsidian',
	'.git',
	'.trash',
	'node_modules',
	'private',
	'templates',
	'template',
	'attachments-private',
]);

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.pdf']);

function ensureDir(dir) {
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function walk(dir, base = dir, files = []) {
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

function parseFrontmatter(raw) {
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

function shouldPublish(data) {
	if (data.publish === false) return false;
	if (data.draft === true) return false;
	return true;
}

function ensureTitle(raw, filename) {
	const { data, body, fm } = parseFrontmatter(raw);
	if (data.title) return raw;
	const title = path.basename(filename, path.extname(filename));
	if (raw.startsWith('---') && fm !== undefined) {
		return `---\n${fm}\ntitle: ${JSON.stringify(title)}\n---\n${body}`;
	}
	return `---\ntitle: ${JSON.stringify(title)}\npublish: true\n---\n\n${raw}`;
}

function main() {
	console.log(`Vault: ${vault}`);
	console.log(`Out:   ${notesOut}`);
	if (!fs.existsSync(vault)) {
		console.error('Vault 路径不存在。请设置 OBSIDIAN_VAULT 或修改 scripts/sync-vault.mjs / src/consts.ts');
		process.exit(1);
	}

	ensureDir(notesOut);
	ensureDir(assetsOut);

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

		// 输出扁平或保留相对路径：保留相对路径更利于子目录笔记
		const destRel = relPosix.replace(/\.mdx?$/i, '') + path.extname(full);
		const dest = path.join(notesOut, destRel);
		const content = ensureTitle(raw, full);

		if (dryRun) {
			console.log(`  + ${destRel}`);
		} else {
			ensureDir(path.dirname(dest));
			fs.writeFileSync(dest, content, 'utf8');
		}
		mdCount++;
	}

	console.log(
		dryRun
			? `[dry-run] 将同步 ${mdCount} 篇笔记, ${assetCount} 个资源, 跳过 ${skipCount}`
			: `完成：同步 ${mdCount} 篇笔记, ${assetCount} 个资源, 跳过 ${skipCount}`,
	);
}

main();
