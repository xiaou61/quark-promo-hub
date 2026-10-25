import { normalize, resolve, sep } from "node:path";

// 静态文件边界：解析后的绝对路径必须仍在 root 内，否则越界读取。
export function safeJoin(root: string, rel: string): string | null {
  const decoded = decodeURIComponent(rel);
  const target = resolve(root, "." + sep + normalize(decoded).replace(/^([/\\])+/, ""));
  const base = resolve(root);
  return target === base || target.startsWith(base + sep) ? target : null;
}
