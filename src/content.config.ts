import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const tags = z.array(z.string()).default([]);

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
 * 常青笔记 / Obsidian 笔记
 * frontmatter 尽量宽松，方便直接从 Vault 拷过来
 */
const notes = defineCollection({
	loader: glob({ base: './src/content/notes', pattern: '**/*.{md,mdx}' }),
	schema: z.object({
		title: z.string().optional(),
		description: z.string().optional(),
		pubDate: z.coerce.date().optional(),
		updatedDate: z.coerce.date().optional(),
		tags,
		/** Obsidian / 同步脚本可用 publish: false 排除私密笔记 */
		publish: z.boolean().default(true),
		draft: z.boolean().default(false),
	}),
});

export const collections = { posts, notes };
