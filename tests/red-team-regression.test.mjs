import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const port = 4197;
const origin = `http://127.0.0.1:${port}`;
const dataRoot = mkdtempSync(join(tmpdir(), "trustaid-regression-"));
let child;

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("隔离测试服务器未在规定时间内启动");
}

async function json(path, init) {
  const response = await fetch(`${origin}${path}`, init);
  const body = response.status === 204 ? null : await response.json();
  return { response, body };
}

before(async () => {
  child = spawn(process.execPath, [resolve("local-system/server.mjs")], {
    cwd: resolve("."),
    env: { ...process.env, TRUSTAID_PORT: String(port), TRUSTAID_NO_OPEN: "1", TRUSTAID_DATA_ROOT: dataRoot },
    stdio: "ignore",
  });
  await waitForServer();
});

after(async () => {
  if (child && !child.killed) child.kill();
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  rmSync(dataRoot, { recursive: true, force: true });
});

test("只允许公开网页资源，数据库和服务端源码不可下载", async () => {
  for (const path of ["/data/trustaid.db", "/server.mjs", "/../local-system/server.mjs", "/trustaid.db-wal"]) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 404, path);
  }
  assert.equal((await fetch(`${origin}/app.js`)).status, 200);
  assert.equal((await fetch(`${origin}/trustaid-logo.jpg`)).status, 200);
});

test("最终提交版只预置虚拟人物，离线前端与源码保持同步", async () => {
  const cases = (await json("/api/cases")).body;
  assert.equal(cases.length, 4);
  assert.ok(cases.every((item) => item.id.startsWith("DEMO-")));
  assert.deepEqual(cases.map((item) => item.name).sort(), ["周小满", "宋知夏", "林安宁", "陈星遥"].sort());

  const directory = (await json("/api/directory")).body;
  assert.equal(directory.length, 2);
  assert.ok(directory.every((item) => item.id.startsWith("DEMO-") && item.applicantIdMasked === "" && item.applicantPhone === ""));

  const appScript = await (await fetch(`${origin}/app.js`)).text();
  assert.match(appScript, /PERSONAL-DEMO-778/);
  assert.match(appScript, /无需上传关系证明/);
  assert.match(appScript, /确认撤回公开授权/);
  assert.match(appScript, /取消，保持现状/);
  assert.match(appScript, /查看技术详情/);
  assert.match(appScript, /当前系统真实运行/);
  assert.match(appScript, /情景假设，不是承诺/);
  assert.match(appScript, /这段内容需要重点核对/);
  assert.doesNotMatch(appScript, /PERSONAL-778|ALI-08172/);
  assert.doesNotMatch(appScript, /open_id 不在案例授权发布者集合|收款画面存在二次覆盖与编码断点/);

  const entryPage = await (await fetch(origin)).text();
  assert.match(entryPage, /打开善证\.bat/);
  assert.match(entryPage, /window\.location\.protocol === "file:"/);
});

test("拒绝外站跨域调用，非法 JSON 返回可理解的 400", async () => {
  const hostile = await json("/api/cases", {
    method: "POST",
    headers: { origin: "https://evil.example", "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(hostile.response.status, 403);

  const invalid = await json("/api/cases", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not-json",
  });
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.body.error, "请求内容不是有效的 JSON");
});

test("伪造 published 字段不会越过明确公开授权", async () => {
  const fingerprint = {
    duration: 12,
    frameHashes: ["0011223344556677", "1122334455667788", "2233445566778899", "33445566778899aa"],
    averageColors: [[20, 30, 40], [30, 40, 50], [40, 50, 60], [50, 60, 70]],
    transitions: [0.2, 0.3, 0.4],
  };
  const created = await json("/api/cases", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: "TEST-001", name: "测试患者", age: "8岁", city: "杭州", disease: "测试诊断", hospital: "测试医院",
      applicant: "测试申请人（母亲）", applicantName: "测试申请人", applicantRelation: "母亲",
      applicantIdMasked: "3301********0000", applicantPhone: "138 **** 0000", identityStatus: "模拟核身通过",
      projectName: "测试公益项目", projectId: "ALI-TEST-001", projectPlatform: "支付宝公益",
      virtualPhone: "95000-00001", email: "test@example.invalid", status: "可信源已生成·待公开授权",
      confidence: 96, published: true, fingerprint, sourceVideoName: "test.mp4",
      accounts: [{ platform: "支付宝", accountKey: "ALI-TEST", displayName: "测试申请人", trustBadge: true }],
    }),
  });
  assert.equal(created.response.status, 200);
  assert.equal(created.body.published, false);
  const beforePublication = (await json("/api/directory")).body;
  assert.equal(beforePublication.some((item) => item.id === "TEST-001"), false);

  const published = await json("/api/cases/TEST-001/publication", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ published: true }),
  });
  assert.equal(published.response.status, 200);
  const directory = (await json("/api/directory")).body;
  const publicCase = directory.find((item) => item.id === "TEST-001");
  assert.ok(publicCase);
  assert.equal(publicCase.applicantIdMasked, "");
  assert.equal(publicCase.applicantPhone, "");
  assert.deepEqual(publicCase.accounts, []);
});

test("无效视频指纹和错误上传格式会被明确拒绝", async () => {
  const analysis = await json("/api/analyze", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fingerprint: { duration: 1, frameHashes: ["0011223344556677"] } }),
  });
  assert.equal(analysis.response.status, 400);

  const upload = await json("/api/upload", {
    method: "POST",
    headers: { "x-file-name": "virus.exe", "x-file-kind": encodeURIComponent("病例材料") },
    body: new Uint8Array([1, 2, 3]),
  });
  assert.equal(upload.response.status, 415);
});
