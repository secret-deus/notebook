/** 把笔记标题 / 文件名收成 URL 友好的 id（保留中文） */
export function toNoteSlug(input: string): string {
	return input
		.trim()
		.replace(/\\/g, '/')
		.replace(/\.mdx?$/i, '')
		.replace(/^\/+|\/+$/g, '')
		.replace(/\s+/g, '-')
		.toLowerCase();
}

/** 从 content collection id 得到展示标题 */
export function titleFromId(id: string): string {
	const base = id.split('/').pop() ?? id;
	return base.replace(/-/g, ' ');
}
