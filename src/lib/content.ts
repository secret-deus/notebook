import { getCollection, type CollectionEntry } from 'astro:content';

export type PostEntry = CollectionEntry<'posts'>;
/** @deprecated 已统一为文章流，保留别名避免旧引用 */
export type NoteEntry = PostEntry;

/** 已发布文章（含从知识库同步的笔记） */
export async function getPublishedPosts(): Promise<PostEntry[]> {
	const posts = await getCollection(
		'posts',
		({ data }) => !data.draft && data.publish !== false,
	);
	return posts.sort((a, b) => {
		const da = a.data.updatedDate ?? a.data.pubDate ?? new Date(0);
		const db = b.data.updatedDate ?? b.data.pubDate ?? new Date(0);
		return db.valueOf() - da.valueOf();
	});
}

/** @deprecated 使用 getPublishedPosts */
export async function getPublishedNotes(): Promise<PostEntry[]> {
	return getPublishedPosts();
}

/** 汇总标签 → 条目列表（规范化空白，合并大小写） */
export async function getTagMap(): Promise<Map<string, Array<PostEntry>>> {
	const posts = await getPublishedPosts();
	const map = new Map<string, Array<PostEntry>>();
	const keyToDisplay = new Map<string, string>();

	for (const entry of posts) {
		for (const raw of entry.data.tags ?? []) {
			const tag = String(raw).trim().replace(/\s+/g, ' ');
			if (!tag) continue;
			const key = tag.toLowerCase();
			if (!keyToDisplay.has(key)) keyToDisplay.set(key, tag);
			const display = keyToDisplay.get(key)!;
			const list = map.get(display) ?? [];
			list.push(entry);
			map.set(display, list);
		}
	}

	return map;
}

export function entryHref(entry: PostEntry): string {
	return `/posts/${entry.id}/`;
}

export function entryTitle(entry: PostEntry): string {
	if (entry.data.title) return entry.data.title;
	const base = entry.id.split('/').pop() ?? entry.id;
	return base;
}
