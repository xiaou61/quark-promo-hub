import { test } from "node:test";
import assert from "node:assert/strict";
import { parseShareUrl as parseQuark } from "../server/quark.ts";
import { parseShareUrl as parseUc } from "../server/uc.ts";
import { shareApiFor } from "../server/resource.ts";

// 资源站按平台分发解析器。认错平台会把夸克链接丢给 UC 接口，必须分开测。

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

test("夸克和 UC 不能互相解析", () => {
  assert.throws(() => parseUc("https://pan.quark.cn/s/0d150487c957"), /无法识别 UC 分享链接/);
  assert.throws(() => parseQuark("https://drive.uc.cn/s/0324d6e3d40b4"), /无法识别分享链接/);
});

test("按平台取到对应实现", () => {
  assert.equal(shareApiFor("quark"), shareApiFor("quark"));
  assert.notEqual(shareApiFor("quark"), shareApiFor("uc"));
});

test("百度不支持资源站，要明确报错", () => {
  assert.throws(() => shareApiFor("baidu"), /暂不支持baidu/);
});
