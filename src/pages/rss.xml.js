import rss from '@astrojs/rss';
import { SITE_DESCRIPTION, SITE_TITLE } from '../consts';
import { getPublishedPosts, entryTitle } from '../lib/content';

export async function GET(context) {
	const posts = await getPublishedPosts();

	return rss({
		title: SITE_TITLE,
		description: SITE_DESCRIPTION,
		site: context.site,
		items: posts.map((post) => ({
			title: entryTitle(post),
			description: post.data.description || entryTitle(post),
			pubDate: post.data.pubDate?.valueOf() > 0 ? post.data.pubDate : new Date(),
			link: `/posts/${post.id}/`,
		})),
	});
}
