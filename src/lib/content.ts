import { getCollection, type CollectionEntry } from 'astro:content';

export type PostEntry = CollectionEntry<'posts'>;
export type NoteEntry = CollectionEntry<'notes'>;

/** 已发布、非草稿的文章（按日期新→旧） */
export async function getPublishedPosts(): Promise<PostEntry[]> {
	const posts = await getCollection('posts', ({ data }) => !data.draft);
	return posts.sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());
}

/** 已发布、非草稿的笔记 */
export async function getPublishedNotes(): Promise<NoteEntry[]> {
	const notes = await getCollection('notes', ({ data }) => !data.draft && data.publish !== false);
	return notes.sort((a, b) => {
		const da = a.data.updatedDate ?? a.data.pubDate ?? new Date(0);
		const db = b.data.updatedDate ?? b.data.pubDate ?? new Date(0);
		return db.valueOf() - da.valueOf();
	});
}

/** 汇总标签 → 条目列表 */
export async function getTagMap(): Promise<Map<string, Array<PostEntry | NoteEntry>>> {
	const [posts, notes] = await Promise.all([getPublishedPosts(), getPublishedNotes()]);
	const map = new Map<string, Array<PostEntry | NoteEntry>>();

	for (const entry of [...posts, ...notes]) {
		for (const tag of entry.data.tags ?? []) {
			const list = map.get(tag) ?? [];
			list.push(entry);
			map.set(tag, list);
		}
	}

	return map;
}

export function entryHref(entry: PostEntry | NoteEntry): string {
	if (entry.collection === 'posts') return `/posts/${entry.id}/`;
	return `/notes/${entry.id}/`;
}

export function entryTitle(entry: PostEntry | NoteEntry): string {
	if (entry.data.title) return entry.data.title;
	const base = entry.id.split('/').pop() ?? entry.id;
	return base;
}
