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

/** 正式博文：偏时间线、可带封面 */
const posts = defineCollection({
	loader: glob({ base: './src/content/posts', pattern: '**/*.{md,mdx}' }),
	schema: ({ image }) =>
		z.object({
			title: z.string(),
			description: z.string().default(''),
			pubDate: z.coerce.date(),
			updatedDate: z.coerce.date().optional(),
			heroImage: z.optional(image()),
			tags,
			draft: z.boolean().default(false),
		}),
});

/**
 * 常青笔记 / Obsidian / 坚果云
 * 宽松 schema：允许额外 frontmatter 字段，避免同步后构建失败
 */
const notes = defineCollection({
	loader: glob({ base: './src/content/notes', pattern: '**/*.{md,mdx}' }),
	schema: z
		.object({
			title: z.union([z.string(), z.number()]).transform(String).optional(),
			description: z.union([z.string(), z.number()]).transform(String).optional(),
			pubDate: z.coerce.date().optional(),
			updatedDate: z.coerce.date().optional(),
			// 常见别名
			date: z.coerce.date().optional(),
			created: z.coerce.date().optional(),
			updated: z.coerce.date().optional(),
			tags,
			/** Obsidian / 同步脚本可用 publish: false 排除私密笔记 */
			publish: looseBool,
			draft: looseBool,
		})
		.passthrough()
		.transform((data) => ({
			...data,
			publish: data.publish ?? true,
			draft: data.draft ?? false,
			// 日期别名回填
			pubDate: data.pubDate ?? data.date ?? data.created,
			updatedDate: data.updatedDate ?? data.updated,
		})),
});

export const collections = { posts, notes };
