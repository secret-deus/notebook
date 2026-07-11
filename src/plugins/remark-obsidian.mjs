/**
 * 轻量 Obsidian Markdown 兼容：
 * - [[笔记]] / [[笔记|显示名]] → 站内链接
 * - ![[image.png]] → 图片
 * - #tag（行内，避免标题）可选保留为纯文本（标签页走 frontmatter）
 *
 * 链接策略：优先当笔记 /notes/{slug}/，也兼容 /posts/{slug}/
 * 文件名与 wikilink 目标保持一致即可（中文文件名 OK）。
 */
import { visit } from 'unist-util-visit';

const WIKI_RE = /(!)?\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g;

function toSlug(raw) {
	// 与 Astro content id 对齐：空白 → -，ASCII 小写（中文不变）
	return String(raw)
		.trim()
		.replace(/\\/g, '/')
		.replace(/\.mdx?$/i, '')
		.replace(/^\/+|\/+$/g, '')
		.replace(/\s+/g, '-')
		.toLowerCase();
}

function guessHref(target) {
	const slug = toSlug(target);
	// 资源文件走 /assets 或原路径
	if (/\.(png|jpe?g|gif|webp|svg|pdf|mp4|mp3)$/i.test(slug)) {
		return `/assets/${slug.split('/').pop()}`;
	}
	// 默认进 notes；posts 同名时请在正文里用标准 Markdown 链到 /posts/...
	return `/notes/${encodeURI(slug)}/`;
}

function splitTextNode(value) {
	const nodes = [];
	let last = 0;
	let match;
	const re = new RegExp(WIKI_RE.source, 'g');

	while ((match = re.exec(value)) !== null) {
		const [full, bang, target, heading, alias] = match;
		if (match.index > last) {
			nodes.push({ type: 'text', value: value.slice(last, match.index) });
		}

		const display = (alias || target).trim();
		const href = guessHref(target) + (heading ? `#${encodeURIComponent(heading)}` : '');

		if (bang) {
			nodes.push({
				type: 'image',
				url: href.startsWith('/assets/') ? href : guessHref(target),
				alt: display,
				title: null,
			});
		} else {
			nodes.push({
				type: 'link',
				url: href,
				title: null,
				children: [{ type: 'text', value: display }],
			});
		}

		last = match.index + full.length;
	}

	if (last < value.length) {
		nodes.push({ type: 'text', value: value.slice(last) });
	}

	return nodes.length ? nodes : [{ type: 'text', value }];
}

export function remarkObsidian() {
	return (tree) => {
		visit(tree, 'text', (node, index, parent) => {
			if (!parent || typeof index !== 'number') return;
			if (!node.value || !node.value.includes('[[')) return;
			// 跳过代码
			if (parent.type === 'code' || parent.type === 'inlineCode') return;

			const replacement = splitTextNode(node.value);
			parent.children.splice(index, 1, ...replacement);
			return index + replacement.length;
		});
	};
}
