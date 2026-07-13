import type { PostEntry } from './content';
import { entryHref, entryTitle } from './content';

export type TreeFile = {
	kind: 'file';
	id: string;
	name: string;
	title: string;
	href: string;
	entry: PostEntry;
};

export type TreeFolder = {
	kind: 'folder';
	path: string;
	name: string;
	children: TreeNode[];
	fileCount: number;
};

export type TreeNode = TreeFolder | TreeFile;

function countFiles(node: TreeNode): number {
	if (node.kind === 'file') return 1;
	return node.children.reduce((n, c) => n + countFiles(c), 0);
}

/** 从文章 id 构建目录树（按路径段） */
export function buildNoteTree(posts: PostEntry[]): TreeFolder {
	const root: TreeFolder = {
		kind: 'folder',
		path: '',
		name: 'posts',
		children: [],
		fileCount: 0,
	};

	const folderMap = new Map<string, TreeFolder>();
	folderMap.set('', root);

	function ensureFolder(path: string): TreeFolder {
		if (folderMap.has(path)) return folderMap.get(path)!;
		const parts = path.split('/').filter(Boolean);
		const name = parts[parts.length - 1] ?? path;
		const parentPath = parts.slice(0, -1).join('/');
		const parent = ensureFolder(parentPath);
		const folder: TreeFolder = {
			kind: 'folder',
			path,
			name,
			children: [],
			fileCount: 0,
		};
		parent.children.push(folder);
		folderMap.set(path, folder);
		return folder;
	}

	const sorted = [...posts].sort((a, b) => a.id.localeCompare(b.id, 'zh-CN'));

	for (const entry of sorted) {
		const parts = entry.id.split('/').filter(Boolean);
		const fileName = parts[parts.length - 1] ?? entry.id;
		const folderPath = parts.slice(0, -1).join('/');
		const parent = ensureFolder(folderPath);
		parent.children.push({
			kind: 'file',
			id: entry.id,
			name: fileName,
			title: entryTitle(entry),
			href: entryHref(entry),
			entry,
		});
	}

	function sortNode(folder: TreeFolder) {
		folder.children.sort((a, b) => {
			if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
			const an = a.kind === 'folder' ? a.name : a.title;
			const bn = b.kind === 'folder' ? b.name : b.title;
			return an.localeCompare(bn, 'zh-CN');
		});
		for (const c of folder.children) {
			if (c.kind === 'folder') sortNode(c);
		}
		folder.fileCount = countFiles(folder);
	}
	sortNode(root);
	return root;
}

export function getTopFolders(posts: PostEntry[]): Array<{ path: string; name: string; count: number }> {
	const tree = buildNoteTree(posts);
	return tree.children
		.filter((c): c is TreeFolder => c.kind === 'folder')
		.map((f) => ({ path: f.path, name: f.name, count: f.fileCount }));
}

export function getFolderContents(posts: PostEntry[], folderPath: string) {
	const tree = buildNoteTree(posts);
	const parts = folderPath.split('/').filter(Boolean);
	let cur: TreeFolder = tree;
	for (const p of parts) {
		const next = cur.children.find((c) => c.kind === 'folder' && c.name === p);
		if (!next || next.kind !== 'folder') {
			return { folder: null as TreeFolder | null, folders: [] as TreeFolder[], files: [] as TreeFile[] };
		}
		cur = next;
	}
	const folders = cur.children.filter((c): c is TreeFolder => c.kind === 'folder');
	const files = cur.children.filter((c): c is TreeFile => c.kind === 'file');
	return { folder: cur, folders, files };
}

export function listAllFolderPaths(posts: PostEntry[]): string[] {
	const tree = buildNoteTree(posts);
	const paths: string[] = [];
	function walk(f: TreeFolder) {
		if (f.path) paths.push(f.path);
		for (const c of f.children) {
			if (c.kind === 'folder') walk(c);
		}
	}
	walk(tree);
	return paths;
}

export function folderHref(path: string): string {
	if (!path) return '/posts/';
	return `/posts/folder/${path.split('/').map(encodeURIComponent).join('/')}/`;
}
