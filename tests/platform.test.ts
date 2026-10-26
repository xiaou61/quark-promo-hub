import { test } from "node:test";
import assert from "node:assert/strict";
import { parseShareUrl as parseQuark } from "../server/quark.ts";
import { parseShareUrl as parseUc } from "../server/uc.ts";
import { parseShareUrl as parseBaidu } from "../server/baidu.ts";
import { shareApiFor } from "../server/resource.ts";

// 资源站按平台分发解析器。认错平台会把链接丢给错误的接口，必须分开测。

test("UC 分享链接", () => {
  const r = parseUc("https://drive.uc.cn/s/0324d6e3d40b4");
  assert.equal(r.pwdId, "0324d6e3d40b4");
  assert.equal(r.passcode, "");
});

test("UC 链接带提取码", () => {
  const r = parseUc("https://drive.uc.cn/s/abc12345 提取码：x9k2");
  assert.equal(r.pwdId, "abc12345");
  assert.equal(r.passcode, "x9k2");
});

test("百度链接去掉开头的 1（接口里的 surl 不带）", () => {
  const r = parseBaidu("https://pan.baidu.com/s/1abcDEF123");
  assert.equal(r.pwdId, "abcDEF123");
  assert.equal(r.passcode, "");
});

test("百度链接带提取码", () => {
  const r = parseBaidu("https://pan.baidu.com/s/1abcDEF123 提取码：x9k2");
  assert.equal(r.pwdId, "abcDEF123");
  assert.equal(r.passcode, "x9k2");
});

test("三家不能互相解析", () => {
  assert.throws(() => parseUc("https://pan.quark.cn/s/0d150487c957"), /无法识别 UC/);
  assert.throws(() => parseQuark("https://drive.uc.cn/s/0324d6e3d40b4"), /无法识别/);
  assert.throws(() => parseBaidu("https://pan.quark.cn/s/0d150487c957"), /无法识别百度/);
  assert.throws(() => parseUc("https://pan.baidu.com/s/1abcDEF123"), /无法识别 UC/);
});

test("三个平台各有独立实现", () => {
  const q = shareApiFor("quark");
  const u = shareApiFor("uc");
  const b = shareApiFor("baidu");
  assert.notEqual(q, u);
  assert.notEqual(u, b);
  assert.notEqual(q, b);
});

