// @ts-check

import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import { unified } from '@astrojs/markdown-remark';
import { defineConfig, fontProviders } from 'astro/config';
import { remarkObsidian } from './src/plugins/remark-obsidian.mjs';

// https://astro.build/config
// Astro 7 默认 Sätteri 不跑 remark 插件；笔记博客需要 [[wikilink]]，改用 unified
export default defineConfig({
	site: 'https://notebook.any.me.uk',
	integrations: [mdx(), sitemap()],
	markdown: {
		processor: unified({
			remarkPlugins: [remarkObsidian],
			shikiConfig: {
				themes: {
					light: 'github-light',
					dark: 'github-dark',
				},
				defaultColor: false,
			},
		}),
	},
	fonts: [
		{
			provider: fontProviders.local(),
			name: 'Atkinson',
			cssVariable: '--font-atkinson',
			fallbacks: [
				'"Segoe UI"',
				'"PingFang SC"',
				'"Hiragino Sans GB"',
				'"Microsoft YaHei"',
				'sans-serif',
			],
			options: {
				variants: [
					{
						src: ['./src/assets/fonts/atkinson-regular.woff'],
						weight: 400,
						style: 'normal',
						display: 'swap',
					},
					{
						src: ['./src/assets/fonts/atkinson-bold.woff'],
						weight: 700,
						style: 'normal',
						display: 'swap',
					},
				],
			},
		},
	],
});
