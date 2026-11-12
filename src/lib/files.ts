import type { TorrentFile } from './types';
export type FileNode = {
  name: string;
  path: string;
  ids: number[];
  length: number;
  completed: number;
  children: FileNode[];
  depth: number;
};
export function fileTree(files: TorrentFile[]): FileNode[] {
  const root: FileNode = {
    name: '',
    path: '',
    ids: [],
    length: 0,
    completed: 0,
    children: [],
    depth: -1,
  };
  for (const [id, file] of files.entries()) {
    let node = root;
    const parts = file.name.split('/');
    for (const [depth, name] of parts.entries()) {
      let child = node.children.find((x) => x.name === name);
      if (!child) {
        child = {
          name,
          path: parts.slice(0, depth + 1).join('/'),
          ids: [],
          length: 0,
          completed: 0,
          children: [],
          depth,
        };
        node.children.push(child);
      }
      child.ids.push(id);
      child.length += file.length;
      child.completed += file.bytesCompleted;
      node = child;
    }
  }
  const sort = (nodes: FileNode[]) => {
    nodes.sort(
      (a, b) =>
        Number(!!b.children.length) - Number(!!a.children.length) ||
        a.name.localeCompare(b.name, undefined, { numeric: true }),
    );
    for (const node of nodes) sort(node.children);
  };
  sort(root.children);
  return root.children;
}
export function flatten(nodes: FileNode[], collapsed: Set<string>): FileNode[] {
  return nodes.flatMap((node) => [
    node,
    ...(collapsed.has(node.path) ? [] : flatten(node.children, collapsed)),
  ]);
}
