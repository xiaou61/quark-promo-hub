import assert from "node:assert/strict";
import test from "node:test";
import { resolve, sep } from "node:path";
import { safeJoin } from "../server/paths.ts";

const root = resolve(process.cwd(), "web", "dist");
const inside = (p: string | null) => p === null || p === root || p.startsWith(root + sep);

test("正常路径落在 dist 内", () => {
  assert.equal(safeJoin(root, "/index.html"), resolve(root, "index.html"));
  assert.equal(safeJoin(root, "/assets/app.js"), resolve(root, "assets", "app.js"));
});

test("越界尝试一律不能逃出 dist", () => {
  for (const bad of [
    "/../server/index.ts",
    "/..%2fserver/index.ts",
    "/a/../../x",
    "/../../etc/passwd",
    "/%2e%2e/%2e%2e/secret",
    "/C:/Windows/win.ini",
    "/..\\..\\secret",
  ]) {
    const got = safeJoin(root, bad);
    assert.ok(inside(got), `${bad} → ${got}`);
  }
});
