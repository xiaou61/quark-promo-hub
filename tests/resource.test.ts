import { test } from "node:test";
import assert from "node:assert/strict";
import { parseShareUrl } from "../server/quark.ts";

// 资源站依赖「从链接里认出 pwd_id」，认错就转存到别人的分享，所以单独测。
test("解析标准夸克分享链接", () => {
  const r = parseShareUrl("https://pan.quark.cn/s/5789ce53d13c");
  assert.equal(r.pwdId, "5789ce53d13c");
  assert.equal(r.passcode, "");
});

test("链接里带提取码", () => {
  const r = parseShareUrl("https://pan.quark.cn/s/abc12345 提取码：x9k2");
  assert.equal(r.pwdId, "abc12345");
  assert.equal(r.passcode, "x9k2");
});

test("只给 pwd_id", () => {
  assert.equal(parseShareUrl("5789ce53d13c").pwdId, "5789ce53d13c");
});

test("不是分享链接要报错，不能猜", () => {
  assert.throws(() => parseShareUrl("https://example.com/notashare"), /无法识别分享链接/);
});
