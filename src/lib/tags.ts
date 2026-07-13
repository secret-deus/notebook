import type { PostEntry } from './content';

export type TagStat = {
	tag: string;
	slug: string;
	count: number;
	entries: PostEntry[];
};

export function normalizeTag(raw: string): string {
	return String(raw).trim().replace(/\s+/g, ' ');
}

export function tagSlug(tag: string): string {
	return encodeURIComponent(normalizeTag(tag));
}

export function tagHref(tag: string): string {
	return `/tags/${tagSlug(tag)}/`;
}

export function buildTagStats(
	entries: PostEntry[],
	opts?: { minCount?: number },
): TagStat[] {
	const minCount = opts?.minCount ?? 1;
	const map = new Map<string, TagStat>();

	for (const entry of entries) {
		for (const raw of entry.data.tags ?? []) {
			const tag = normalizeTag(String(raw));
			if (!tag) continue;
			const key = tag.toLowerCase();
			const existing = map.get(key);
			if (existing) {
				existing.count += 1;
				existing.entries.push(entry);
			} else {
				map.set(key, {
					tag,
					slug: tagSlug(tag),
					count: 1,
					entries: [entry],
				});
			}
		}
	}

	return [...map.values()]
		.filter((t) => t.count >= minCount)
		.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh-CN'));
}

export function groupTagsByInitial(stats: TagStat[]): Array<{ key: string; tags: TagStat[] }> {
	const groups = new Map<string, TagStat[]>();
	for (const t of stats) {
		const ch = t.tag.charAt(0).toUpperCase();
		const key = /[A-Z0-9]/.test(ch) ? ch : '中文/其他';
		const list = groups.get(key) ?? [];
		list.push(t);
		groups.set(key, list);
	}
	const keys = [...groups.keys()].sort((a, b) => {
		if (a === '中文/其他') return 1;
		if (b === '中文/其他') return -1;
		return a.localeCompare(b);
	});
	return keys.map((key) => ({
		key,
		tags: (groups.get(key) ?? []).sort((a, b) => a.tag.localeCompare(b.tag, 'zh-CN')),
	}));
}
