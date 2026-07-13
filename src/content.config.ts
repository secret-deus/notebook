import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

/** 标签：兼容 number / 混排 YAML（Obsidian 常见） */
const tags = z
	.array(z.union([z.string(), z.number(), z.boolean()]).transform(String))
	.default([]);

const looseBool = z
	.union([z.boolean(), z.string(), z.number()])
	.transform((v) => {
		if (typeof v === 'boolean') return v;
		if (typeof v === 'number') return v !== 0;
		const s = String(v).trim().toLowerCase();
		if (['false', '0', 'no', 'off'].includes(s)) return false;
		if (['true', '1', 'yes', 'on'].includes(s)) return true;
		return Boolean(s);
	})
	.optional();

/**
 * 统一文章流：坚果云 / Obsidian 笔记也当文章发
 * schema 宽松，避免同步后构建失败
 */
const posts = defineCollection({
	loader: glob({ base: './src/content/posts', pattern: '**/*.{md,mdx}' }),
	schema: ({ image }) =>
		z
			.object({
				title: z.union([z.string(), z.number()]).transform(String).optional(),
				description: z
					.union([z.string(), z.number()])
					.transform(String)
					.optional(),
				pubDate: z.coerce.date().optional(),
				updatedDate: z.coerce.date().optional(),
				date: z.coerce.date().optional(),
				created: z.coerce.date().optional(),
				updated: z.coerce.date().optional(),
				heroImage: z.optional(image()),
				tags,
				publish: looseBool,
				draft: looseBool,
			})
			.passthrough()
			.transform((data) => {
				const pubDate = data.pubDate ?? data.date ?? data.created ?? new Date(0);
				return {
					...data,
					title: data.title,
					description: data.description ?? '',
					publish: data.publish ?? true,
					draft: data.draft ?? false,
					pubDate,
					updatedDate: data.updatedDate ?? data.updated,
				};
			}),
});

export const collections = { posts };
