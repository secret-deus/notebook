/**
 * 将本地一篇（或多篇）笔记 PUT 到坚果云 WebDAV
 * 用法: node scripts/push-to-nutstore.mjs <local-md-path> [remote-rel-path]
 *
 * remote-rel-path 相对 NUTSTORE_WEBDAV_PATH，默认与 posts 下相对路径一致
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './lib/load-env.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
loadEnv(root);

const localArg = process.argv[2];
if (!localArg) {
	console.error('用法: node scripts/push-to-nutstore.mjs <local-md-path> [remote-rel-path]');
	process.exit(1);
}

const localPath = path.isAbsolute(localArg) ? localArg : path.join(root, localArg);
if (!fs.existsSync(localPath)) {
	console.error('文件不存在:', localPath);
	process.exit(1);
}

const postsOut = path.join(root, 'src/content/posts');
let remoteRel = process.argv[3];
if (!remoteRel) {
	const rel = path.relative(postsOut, localPath);
	if (rel.startsWith('..')) {
		remoteRel = path.basename(localPath);
	} else {
		remoteRel = rel.split(path.sep).join('/');
	}
}

const DAV_BASE = (process.env.NUTSTORE_WEBDAV_URL || 'https://dav.jianguoyun.com/dav').replace(
	/\/$/,
	'',
);
const sub = (process.env.NUTSTORE_WEBDAV_PATH || '').replace(/^\/dav\/?/i, '').replace(/^\/+|\/+$/g, '');
const user = process.env.NUTSTORE_WEBDAV_USER || process.env.NUTSTORE_USER;
const pass = process.env.NUTSTORE_WEBDAV_PASS || process.env.NUTSTORE_PASS;
if (!user || !pass) {
	console.error('缺少 NUTSTORE_WEBDAV_USER / NUTSTORE_WEBDAV_PASS');
	process.exit(1);
}

const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

function joinDav(...parts) {
	return parts
		.filter(Boolean)
		.map((p, i) => (i === 0 ? p.replace(/\/$/, '') : String(p).replace(/^\/+|\/+$/g, '')))
		.join('/');
}

async function ensureDir(davDirUrl) {
	// MKCOL each segment under base
	const base = joinDav(DAV_BASE, sub);
	if (!davDirUrl.startsWith(base)) return;
	let rel = davDirUrl.slice(base.length).replace(/^\/+/, '');
	if (!rel) return;
	const segs = rel.split('/').filter(Boolean);
	let cur = base;
	for (const seg of segs) {
		cur = joinDav(cur, encodeURIComponent(seg).replace(/%2F/gi, '/'));
		// try without encode for chinese paths - 坚果云 often wants raw utf8 path encoded per segment
		const tryUrl = joinDav(base, ...segs.slice(0, segs.indexOf(seg) + 1).map(encodeURIComponent));
		const res = await fetch(tryUrl + (tryUrl.endsWith('/') ? '' : '/'), {
			method: 'MKCOL',
			headers: { Authorization: auth },
		});
		// 201 created, 405 exists, 409 parent missing handled by order
		if (![201, 405, 301, 200].includes(res.status) && res.status !== 409) {
			// 409 can mean exists as collection on some servers
			if (res.status !== 409) {
				const t = await res.text().catch(() => '');
				// ignore "already exists" style
				if (res.status !== 405) {
					console.warn(`MKCOL ${res.status} ${tryUrl} ${t.slice(0, 120)}`);
				}
			}
		}
	}
}

async function mkcolRecursive(remoteRelPath) {
	const parts = remoteRelPath.split('/').filter(Boolean);
	// only dirs
	const dirParts = parts.slice(0, -1);
	let built = [];
	for (const p of dirParts) {
		built.push(p);
		const url =
			joinDav(DAV_BASE, sub, ...built.map((s) => encodeURIComponent(s))) + '/';
		const res = await fetch(url, { method: 'MKCOL', headers: { Authorization: auth } });
		console.log(`MKCOL ${res.status} ${decodeURIComponent(url)}`);
	}
}

async function main() {
	const fileName = path.posix.basename(remoteRel.split(path.sep).join('/'));
	const remotePosix = remoteRel.split(path.sep).join('/');
	await mkcolRecursive(remotePosix);

	const url =
		joinDav(DAV_BASE, sub, ...remotePosix.split('/').map(encodeURIComponent));
	const body = fs.readFileSync(localPath);
	const res = await fetch(url, {
		method: 'PUT',
		headers: {
			Authorization: auth,
			'Content-Type': 'text/markdown; charset=utf-8',
			'Content-Length': String(body.length),
		},
		body,
	});
	const t = await res.text().catch(() => '');
	console.log(`PUT ${res.status} ${decodeURIComponent(url)}`);
	if (!res.ok) {
		console.error(t.slice(0, 400));
		process.exit(1);
	}
	console.log('已同步到坚果云:', path.posix.join(sub, remotePosix));
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
