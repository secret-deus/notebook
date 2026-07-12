import fs from 'node:fs';
import path from 'node:path';

/** 把项目根目录 .env 读进 process.env（不覆盖已有环境变量） */
export function loadEnv(root) {
	const file = path.join(root, '.env');
	if (!fs.existsSync(file)) return;
	const text = fs.readFileSync(file, 'utf8');
	for (const line of text.split(/\r?\n/)) {
		const t = line.trim();
		if (!t || t.startsWith('#')) continue;
		const i = t.indexOf('=');
		if (i <= 0) continue;
		const key = t.slice(0, i).trim();
		let val = t.slice(i + 1).trim();
		if (
			(val.startsWith('"') && val.endsWith('"')) ||
			(val.startsWith("'") && val.endsWith("'"))
		) {
			val = val.slice(1, -1);
		}
		if (process.env[key] === undefined) process.env[key] = val;
	}
}
