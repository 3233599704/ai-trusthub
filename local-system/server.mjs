import { createServer } from "node:http";
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { once } from "node:events";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

const serverDir = dirname(fileURLToPath(import.meta.url));
const staticRoot = existsSync(join(serverDir, "index.html"))
  ? serverDir
  : resolve(serverDir, "..", "offline");
const dataRoot = process.env.TRUSTAID_DATA_ROOT ? resolve(process.env.TRUSTAID_DATA_ROOT) : join(serverDir, "data");
const uploadRoot = join(dataRoot, "uploads");
mkdirSync(uploadRoot, { recursive: true });
const uploadRules = new Map([
  ["病例材料", { extensions: new Set([".pdf", ".jpg", ".jpeg", ".png"]), maxBytes: 20 * 1024 * 1024 }],
  ["关系证明", { extensions: new Set([".pdf", ".jpg", ".jpeg", ".png"]), maxBytes: 20 * 1024 * 1024 }],
  ["可信原片", { extensions: new Set([".mp4", ".webm", ".mov", ".m4v"]), maxBytes: 100 * 1024 * 1024 }],
  ["公众核验视频", { extensions: new Set([".mp4", ".webm", ".mov", ".m4v"]), maxBytes: 100 * 1024 * 1024 }],
]);

const db = new DatabaseSync(join(dataRoot, "trustaid.db"));
const SYSTEM_VERSION = "1.0.0";
const ALGORITHM_VERSION = "TA-LocalFusion-0.5";
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS cases (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    avatar TEXT NOT NULL,
    age TEXT NOT NULL,
    city TEXT NOT NULL,
    disease TEXT NOT NULL,
    hospital TEXT NOT NULL,
    applicant TEXT NOT NULL,
    applicant_name TEXT NOT NULL DEFAULT '',
    applicant_relation TEXT NOT NULL DEFAULT '',
    applicant_id_masked TEXT NOT NULL DEFAULT '',
    applicant_phone TEXT NOT NULL DEFAULT '',
    identity_status TEXT NOT NULL DEFAULT '待核身',
    project_name TEXT NOT NULL,
    project_id TEXT NOT NULL,
    project_platform TEXT NOT NULL DEFAULT '未填写',
    is_published INTEGER NOT NULL DEFAULT 0,
    virtual_phone TEXT NOT NULL,
    email TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT '待核验',
    fingerprint_json TEXT,
    source_video_name TEXT,
    text_corpus TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    platform TEXT NOT NULL,
    account_key TEXT NOT NULL,
    display_name TEXT NOT NULL,
    authorized_until TEXT NOT NULL,
    trust_badge INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS uploads (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    original_name TEXT NOT NULL,
    stored_path TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS analyses (
    id TEXT PRIMARY KEY,
    video_name TEXT NOT NULL,
    platform TEXT NOT NULL,
    publisher_account TEXT NOT NULL,
    payment_project_id TEXT NOT NULL,
    matched_case_id TEXT,
    match_score REAL NOT NULL,
    risk_score INTEGER NOT NULL,
    algorithm_version TEXT NOT NULL DEFAULT 'TA-LocalFusion-0.5',
    evidence_coverage INTEGER NOT NULL DEFAULT 0,
    input_json TEXT NOT NULL DEFAULT '{}',
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    analysis_id TEXT NOT NULL REFERENCES analyses(id),
    status TEXT NOT NULL DEFAULT '待复核',
    decision TEXT NOT NULL DEFAULT 'pending',
    reviewer_note TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    detail TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_accounts_case_platform ON accounts(case_id, platform);
  CREATE INDEX IF NOT EXISTS idx_analyses_case_created ON analyses(matched_case_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_reports_status_created ON reports(status, created_at);
  CREATE INDEX IF NOT EXISTS idx_audit_entity_created ON audit_logs(entity_type, entity_id, created_at);
`);
const caseColumns = new Set(db.prepare("PRAGMA table_info(cases)").all().map((column) => column.name));
const caseMigrations = [
  ["applicant_name", "ALTER TABLE cases ADD COLUMN applicant_name TEXT NOT NULL DEFAULT ''"],
  ["applicant_relation", "ALTER TABLE cases ADD COLUMN applicant_relation TEXT NOT NULL DEFAULT ''"],
  ["applicant_id_masked", "ALTER TABLE cases ADD COLUMN applicant_id_masked TEXT NOT NULL DEFAULT ''"],
  ["applicant_phone", "ALTER TABLE cases ADD COLUMN applicant_phone TEXT NOT NULL DEFAULT ''"],
  ["identity_status", "ALTER TABLE cases ADD COLUMN identity_status TEXT NOT NULL DEFAULT '待核身'"],
  ["project_platform", "ALTER TABLE cases ADD COLUMN project_platform TEXT NOT NULL DEFAULT '未填写'"],
  ["is_published", "ALTER TABLE cases ADD COLUMN is_published INTEGER NOT NULL DEFAULT 0"],
];
for (const [column, sql] of caseMigrations) if (!caseColumns.has(column)) db.exec(sql);
const analysisColumns = new Set(db.prepare("PRAGMA table_info(analyses)").all().map((column) => column.name));
const analysisMigrations = [
  ["algorithm_version", `ALTER TABLE analyses ADD COLUMN algorithm_version TEXT NOT NULL DEFAULT '${ALGORITHM_VERSION}'`],
  ["evidence_coverage", "ALTER TABLE analyses ADD COLUMN evidence_coverage INTEGER NOT NULL DEFAULT 0"],
  ["input_json", "ALTER TABLE analyses ADD COLUMN input_json TEXT NOT NULL DEFAULT '{}'"],
];
for (const [column, sql] of analysisMigrations) if (!analysisColumns.has(column)) db.exec(sql);
db.exec("CREATE INDEX IF NOT EXISTS idx_cases_public_trusted ON cases(is_published, updated_at) WHERE fingerprint_json IS NOT NULL");
db.exec("PRAGMA optimize");

const now = () => new Date().toISOString();
const demoCases = [
  {
    id: "DEMO-1001", name: "林安宁", avatar: "宁", age: "8岁", city: "杭州",
    disease: "急性淋巴细胞白血病", hospital: "浙江省儿童医院",
    applicant: "方静（母亲）", applicantName: "方静", applicantRelation: "母亲",
    applicantIdMasked: "DEMO********1001", applicantPhone: "1XX **** 1001", identityStatus: "虚拟演示身份·核验通过",
    projectName: "陪安宁完成后续治疗", projectId: "ALI-DEMO-1001", projectPlatform: "支付宝公益", isPublished: 1,
    virtualPhone: "95000-61001", email: "lin-anning@example.invalid", confidence: 96.8, status: "虚拟演示·实时有效",
    fingerprint: {
      duration: 28.4,
      digest: "trustaid-demo-lin-anning-v1",
      frameHashes: ["0f1e2d3c4b5a6978", "1122334455667788", "99aabbccddeeff00", "13579bdf2468ace0", "0123456789abcdef", "fedcba9876543210"],
      colors: [[118, 151, 176], [121, 148, 170], [115, 143, 168], [126, 155, 181], [132, 160, 186], [124, 152, 178]],
      transitions: [5, 7, 6, 9, 7],
    },
    sourceVideoName: "虚拟演示原片_林安宁.mp4",
    accounts: [
      ["支付宝", "ALI-ACCOUNT-DEMO-1001", "方静", "2027-12-31", 1],
      ["抖音", "DY-ACCOUNT-DEMO-1001", "安宁求助记录", "2027-12-31", 1],
      ["哔哩哔哩", "BILI-ACCOUNT-DEMO-1001", "安宁康复日记", "2027-12-31", 1],
    ],
  },
  {
    id: "DEMO-1002", name: "周小满", avatar: "满", age: "37岁", city: "宁波",
    disease: "扩张型心肌病", hospital: "宁波市第一医院",
    applicant: "周小满（本人）", applicantName: "周小满", applicantRelation: "本人",
    applicantIdMasked: "DEMO********1002", applicantPhone: "1XX **** 1002", identityStatus: "虚拟演示身份·核验通过",
    projectName: "守护小满的心脏康复路", projectId: "ALI-DEMO-1002", projectPlatform: "支付宝公益", isPublished: 1,
    virtualPhone: "95000-61002", email: "zhou-xiaoman@example.invalid", confidence: 94.6, status: "虚拟演示·实时有效",
    fingerprint: {
      duration: 34.7,
      digest: "trustaid-demo-zhou-xiaoman-v1",
      frameHashes: ["a1b2c3d4e5f60718", "2233445566778899", "8a9bacbdcedfe0f1", "2468ace013579bdf", "abcdef0123456789", "76543210fedcba98"],
      colors: [[162, 139, 124], [169, 145, 130], [158, 136, 121], [174, 151, 135], [166, 142, 127], [171, 149, 133]],
      transitions: [8, 6, 10, 7, 9],
    },
    sourceVideoName: "虚拟演示原片_周小满.mp4",
    accounts: [
      ["支付宝", "ALI-ACCOUNT-DEMO-1002", "周小满", "2027-12-31", 1],
      ["抖音", "DY-ACCOUNT-DEMO-1002", "小满康复记录", "2027-12-31", 1],
    ],
  },
  {
    id: "DEMO-1003", name: "陈星遥", avatar: "遥", age: "16岁", city: "温州",
    disease: "重型再生障碍性贫血", hospital: "温州医科大学附属第二医院（育英儿童医院）",
    applicant: "陈嘉树（父亲）", applicantName: "陈嘉树", applicantRelation: "父亲",
    applicantIdMasked: "DEMO********1003", applicantPhone: "1XX **** 1003", identityStatus: "虚拟演示身份·核验通过",
    projectName: "陪星遥等待造血干细胞移植", projectId: "ALI-DEMO-1003", projectPlatform: "支付宝公益", isPublished: 0,
    virtualPhone: "95000-61003", email: "chen-xingyao@example.invalid", confidence: 92.9, status: "虚拟演示·待公开授权",
    fingerprint: {
      duration: 31.2,
      digest: "trustaid-demo-chen-xingyao-v1",
      frameHashes: ["55aa55aa55aa55aa", "0a1b2c3d4e5f6071", "89abcdef01234567", "f0e1d2c3b4a59687", "3141592653589793", "2718281828459045"],
      colors: [[105, 133, 157], [111, 139, 163], [101, 129, 154], [117, 144, 167], [109, 136, 161], [114, 141, 165]],
      transitions: [6, 8, 7, 8, 6],
    },
    sourceVideoName: "虚拟演示原片_陈星遥.mp4",
    accounts: [
      ["支付宝", "ALI-ACCOUNT-DEMO-1003", "陈嘉树", "2027-12-31", 1],
      ["哔哩哔哩", "BILI-ACCOUNT-DEMO-1003", "星遥治疗记录", "2027-12-31", 1],
    ],
  },
  {
    id: "DEMO-1004", name: "宋知夏", avatar: "夏", age: "5岁", city: "湖州",
    disease: "先天性心脏病", hospital: "湖州市中心医院",
    applicant: "宋云岚（母亲）", applicantName: "宋云岚", applicantRelation: "母亲",
    applicantIdMasked: "DEMO********1004", applicantPhone: "1XX **** 1004", identityStatus: "虚拟演示身份·核验通过",
    projectName: "待关联", projectId: "待关联", projectPlatform: "未填写", isPublished: 0,
    virtualPhone: "95000-61004", email: "song-zhixia@example.invalid", confidence: 90.0, status: "虚拟演示·建档中",
    fingerprint: null,
    sourceVideoName: null,
    accounts: [],
  },
];

if (Number(db.prepare("SELECT count(*) AS count FROM cases").get().count) === 0) {
  const caseInsert = db.prepare(`INSERT INTO cases (
    id,name,avatar,age,city,disease,hospital,applicant,applicant_name,applicant_relation,
    applicant_id_masked,applicant_phone,identity_status,project_name,project_id,project_platform,is_published,
    virtual_phone,email,confidence,status,fingerprint_json,source_video_name,text_corpus,updated_at,created_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const accountInsert = db.prepare("INSERT INTO accounts(case_id,platform,account_key,display_name,authorized_until,trust_badge) VALUES(?,?,?,?,?,?)");
  const auditInsert = db.prepare("INSERT INTO audit_logs(action,entity_type,entity_id,detail,created_at) VALUES(?,?,?,?,?)");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const demoCase of demoCases) {
      const timestamp = now();
      const textCorpus = [demoCase.name, demoCase.disease, demoCase.hospital, demoCase.applicantName, demoCase.applicantRelation, demoCase.projectName].join(" ");
      caseInsert.run(
        demoCase.id, demoCase.name, demoCase.avatar, demoCase.age, demoCase.city, demoCase.disease, demoCase.hospital,
        demoCase.applicant, demoCase.applicantName, demoCase.applicantRelation, demoCase.applicantIdMasked, demoCase.applicantPhone,
        demoCase.identityStatus, demoCase.projectName, demoCase.projectId, demoCase.projectPlatform, demoCase.isPublished,
        demoCase.virtualPhone, demoCase.email, demoCase.confidence, demoCase.status,
        demoCase.fingerprint ? JSON.stringify(demoCase.fingerprint) : null, demoCase.sourceVideoName, textCorpus, timestamp, timestamp,
      );
      for (const account of demoCase.accounts) accountInsert.run(demoCase.id, ...account);
      auditInsert.run("case.seed-demo", "case", demoCase.id, "系统生成虚拟演示案例，不对应真实个人", timestamp);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function audit(action, entityType, entityId, detail) {
  db.prepare("INSERT INTO audit_logs(action,entity_type,entity_id,detail,created_at) VALUES(?,?,?,?,?)")
    .run(action, entityType, String(entityId), detail, now());
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(response, status, value) {
  if (status === 204) {
    response.writeHead(204);
    response.end();
    return;
  }
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

async function readJson(request, maxBytes = 6 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("请求内容过大");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "请求内容不是有效的 JSON");
  }
}

function caseFromRow(row, { publicView = false } = {}) {
  return {
    id: row.id,
    name: row.name,
    avatar: row.avatar,
    age: row.age,
    city: row.city,
    disease: row.disease,
    hospital: row.hospital,
    applicant: row.applicant,
    applicantName: publicView ? "" : row.applicant_name || row.applicant?.split("（")[0] || "",
    applicantRelation: publicView ? "" : row.applicant_relation || "",
    applicantIdMasked: publicView ? "" : row.applicant_id_masked || "",
    applicantPhone: publicView ? "" : row.applicant_phone || "",
    identityStatus: publicView ? "已核验" : row.identity_status || "待核身",
    project: row.project_name,
    projectId: row.project_id,
    projectPlatform: row.project_platform || "未填写",
    published: Boolean(row.is_published),
    virtualPhone: row.virtual_phone,
    email: row.email,
    confidence: `${Number(row.confidence).toFixed(1)}%`,
    status: row.status,
    lastChecked: "刚刚从本地数据库同步",
    updated: row.updated_at.replace("T", " ").slice(0, 16),
    hasTrustedVideo: Boolean(row.fingerprint_json),
    sourceVideoName: row.source_video_name || "",
    accounts: publicView ? [] : db.prepare("SELECT platform,account_key AS accountKey,display_name AS displayName,authorized_until AS authorizedUntil,trust_badge AS trustBadge FROM accounts WHERE case_id=? ORDER BY id").all(row.id)
      .map((account) => ({ ...account, trustBadge: Boolean(account.trustBadge) })),
  };
}

function hamming(left, right) {
  if (!left || !right) return 64;
  let distance = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const xor = Number.parseInt(left[index], 16) ^ Number.parseInt(right[index], 16);
    distance += ((xor >> 3) & 1) + ((xor >> 2) & 1) + ((xor >> 1) & 1) + (xor & 1);
  }
  return distance + Math.abs(left.length - right.length) * 4;
}

function validateFingerprint(fingerprint) {
  const hashes = fingerprint?.frameHashes;
  if (!Array.isArray(hashes) || hashes.length < 4 || hashes.length > 24) return false;
  if (!hashes.every((hash) => typeof hash === "string" && /^[0-9a-f]{16}$/i.test(hash))) return false;
  const duration = Number(fingerprint.duration);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 3600) return false;
  if (fingerprint.colors && (!Array.isArray(fingerprint.colors) || fingerprint.colors.length > 24)) return false;
  if (fingerprint.transitions && (!Array.isArray(fingerprint.transitions) || fingerprint.transitions.length > 24)) return false;
  return true;
}

function fingerprintSimilarity(candidate, reference) {
  if (!candidate?.frameHashes?.length || !reference?.frameHashes?.length) return 0;
  if (candidate.digest && candidate.digest === reference.digest) return 1;
  const frameScores = candidate.frameHashes.map((hash, index) => {
    const proportional = Math.round(index / Math.max(1, candidate.frameHashes.length - 1) * Math.max(0, reference.frameHashes.length - 1));
    const nearby = reference.frameHashes.slice(Math.max(0, proportional - 2), proportional + 3);
    const bestDistance = Math.min(...nearby.map((other) => hamming(hash, other)));
    return Math.max(0, 1 - bestDistance / 64);
  });
  const hashScore = frameScores.reduce((sum, score) => sum + score, 0) / frameScores.length;
  const colorScores = (candidate.colors ?? []).map((color, index) => {
    const referenceColor = reference.colors?.[Math.round(index / Math.max(1, candidate.colors.length - 1) * Math.max(0, reference.colors.length - 1))];
    if (!referenceColor) return 0;
    const delta = color.reduce((sum, channel, channelIndex) => sum + Math.abs(channel - referenceColor[channelIndex]), 0);
    return Math.max(0, 1 - delta / 765);
  });
  const colorScore = colorScores.length ? colorScores.reduce((sum, score) => sum + score, 0) / colorScores.length : hashScore;
  const candidateDuration = Number(candidate.duration || 0);
  const referenceDuration = Number(reference.duration || 0);
  const durationScore = candidateDuration > 0 && referenceDuration > 0
    ? Math.min(candidateDuration, referenceDuration) / Math.max(candidateDuration, referenceDuration)
    : 0.5;
  return Math.max(0, Math.min(1, hashScore * 0.72 + colorScore * 0.18 + durationScore * 0.10));
}

function transitionDifference(candidate, reference) {
  const left = candidate?.transitions ?? [];
  const right = reference?.transitions ?? [];
  if (!left.length || !right.length) return 0.25;
  const leftMean = left.reduce((sum, value) => sum + value, 0) / left.length;
  const rightMean = right.reduce((sum, value) => sum + value, 0) / right.length;
  return Math.min(1, Math.abs(leftMean - rightMean) / 32);
}

function textSimilarity(left, right) {
  const normalizeText = (value) => String(value ?? "").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
  const grams = (value) => {
    const normalized = normalizeText(value);
    const set = new Set();
    for (let index = 0; index < normalized.length - 1; index += 1) set.add(normalized.slice(index, index + 2));
    return set;
  };
  const a = grams(left);
  const b = grams(right);
  if (!a.size || !b.size) return 0.75;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function enrichAnalysis(result, input, hasTrustedMatch) {
  const hasPublisher = Boolean(String(input.publisherAccount || "").trim());
  const hasProject = Boolean(String(input.paymentProjectId || "").trim());
  const hasText = Boolean(String(input.textSummary || "").trim());
  const hasFingerprint = Boolean(input.fingerprint?.frameHashes?.length);
  const evidenceCoverage = Math.min(100,
    (hasTrustedMatch ? 45 : 10) +
    (hasFingerprint ? 20 : 0) +
    (hasPublisher ? 15 : 0) +
    (hasProject ? 10 : 0) +
    (hasText ? 10 : 0));
  const signals = result.signals.map((signal) => ({
    ...signal,
    contribution: Math.round(signal.score * signal.weight) / 100,
  }));
  const topFactors = signals
    .map((signal) => ({ label: signal.label, contribution: signal.contribution, detail: signal.detail }))
    .sort((left, right) => right.contribution - left.contribution)
    .slice(0, 3);
  const recommendation = evidenceCoverage < 70
    ? "证据覆盖不足：暂不建议自动处置，请补充可信源或转人工核验"
    : result.riskScore >= 70
      ? "建议平台限制收款导流并进入人工深度复核"
      : result.riskScore >= 30
        ? "建议平台保留内容状态并核对账号、项目与授权关系"
        : "未见明显异常：可保留内容并持续监测授权有效期";
  return {
    ...result,
    signals,
    algorithmVersion: ALGORITHM_VERSION,
    evidenceCoverage,
    recommendation,
    topFactors,
    thresholdPolicy: "0—29 低风险；30—69 中风险；70—100 高风险；证据覆盖低于 70% 时禁止自动处置",
  };
}

function buildAnalysis(input) {
  const caseRows = db.prepare("SELECT * FROM cases WHERE fingerprint_json IS NOT NULL AND is_published=1").all();
  let matchedCase = null;
  let referenceFingerprint = null;
  let similarity = 0;
  for (const row of caseRows) {
    const reference = JSON.parse(row.fingerprint_json);
    const score = fingerprintSimilarity(input.fingerprint, reference);
    if (score > similarity) {
      similarity = score;
      matchedCase = row;
      referenceFingerprint = reference;
    }
  }

  if (!matchedCase || similarity < 0.62) {
    const riskScore = 35;
    return enrichAnalysis({
      riskScore,
      matchScore: Math.round(similarity * 1000) / 10,
      title: "未召回足够相似的可信原片，建议补充材料",
      level: "证据不足",
      matchedCaseId: null,
      analysisId: null,
      signals: [
        { label: "发布账号未授权", engine: "本地授权关系图", score: 50, weight: 24, detail: "未匹配可信案例，暂无法确认账号授权" },
        { label: "收款入口冲突", engine: "项目编号核对", score: 40, weight: 28, detail: "未匹配可信案例，暂无法确认收款入口" },
        { label: "视频编辑异常", engine: "关键帧时序检测", score: 20, weight: 18, detail: "未发现可与可信原片对照的编辑证据" },
        { label: "病例语义冲突", engine: "中文字符二元组", score: 25, weight: 12, detail: "文本信息不足或缺少可信病例摘要" },
        { label: "传播关系未知", engine: "跨平台授权图谱", score: 50, weight: 18, detail: "无法建立发布者与求助者的授权路径" },
      ],
    }, input, false);
  }

  const authorized = Boolean(db.prepare(`SELECT id FROM accounts
    WHERE case_id = ? AND platform = ? AND lower(display_name) = lower(?) AND authorized_until >= date('now') LIMIT 1`)
    .get(matchedCase.id, input.platform, input.publisherAccount));
  const paymentMatches = String(input.paymentProjectId ?? "").trim().toLowerCase() === String(matchedCase.project_id).trim().toLowerCase();
  const semanticSimilarity = textSimilarity(input.textSummary, matchedCase.text_corpus);
  const transitionDelta = transitionDifference(input.fingerprint, referenceFingerprint);
  const signals = [
    { label: "发布账号未授权", engine: "本地 OAuth 授权关系图", score: authorized ? 3 : 96, weight: 24, detail: authorized ? `${input.publisherAccount} 位于有效授权集合` : `${input.publisherAccount} 不在案例授权发布者集合` },
    { label: "收款入口冲突", engine: "项目编号 / 二维码结果核对", score: paymentMatches ? 2 : 98, weight: 28, detail: paymentMatches ? `指向官方项目 ${matchedCase.project_id}` : `${input.paymentProjectId || "未提供"} ≠ 官方项目 ${matchedCase.project_id}` },
    { label: "视频编辑异常", engine: "关键帧 pHash 时序检测", score: Math.round(Math.min(96, transitionDelta * 65 + (!paymentMatches && similarity > 0.7 ? 38 : 3))), weight: 18, detail: `关键帧时序差异 ${(transitionDelta * 100).toFixed(1)}%，原片相似度 ${(similarity * 100).toFixed(1)}%` },
    { label: "病例语义冲突", engine: "中文字符二元组相似度", score: Math.round((1 - semanticSimilarity) * 100), weight: 12, detail: `提交文案与可信病例摘要相似度 ${(semanticSimilarity * 100).toFixed(1)}%` },
    { label: "传播关系未知", engine: "跨平台授权图谱", score: authorized ? 5 : 92, weight: 18, detail: authorized ? "存在有效发布授权路径" : "发布账号与求助者无可验证授权路径" },
  ];
  const riskScore = Math.round(signals.reduce((sum, signal) => sum + signal.score * signal.weight / 100, 0));
  const level = riskScore >= 70 ? "高风险" : riskScore >= 30 ? "中风险" : "低风险";
  const title = riskScore >= 70
    ? "可信内容高度相似，但账号或收款关系存在显著冲突"
    : riskScore >= 30
      ? "发现需要人工确认的传播关系或内容差异"
      : "可信原片匹配，账号与项目关系未见明显异常";
  return enrichAnalysis({
    riskScore,
    matchScore: Math.round(similarity * 1000) / 10,
    title,
    level,
    matchedCaseId: matchedCase.id,
    signals,
  }, input, true);
}

async function handleApi(request, response, url) {
  if (request.method === "OPTIONS") return sendJson(response, 204, {});
  if (request.method === "GET" && url.pathname === "/api/health") {
    const counts = db.prepare(`SELECT
      (SELECT count(*) FROM cases) AS cases,
      (SELECT count(*) FROM cases WHERE fingerprint_json IS NOT NULL) AS trustedSources,
      (SELECT count(*) FROM cases WHERE fingerprint_json IS NOT NULL AND is_published=1) AS publishedCases,
      (SELECT count(*) FROM reports WHERE status != '已完成') AS pendingReviews,
      (SELECT count(*) FROM audit_logs) AS auditEvents`).get();
    return sendJson(response, 200, { ok: true, mode: "local-sqlite", version: SYSTEM_VERSION, algorithmVersion: ALGORITHM_VERSION, ...counts });
  }
  if (request.method === "GET" && url.pathname === "/api/cases") {
    const rows = db.prepare("SELECT * FROM cases ORDER BY updated_at DESC").all();
    return sendJson(response, 200, rows.map(caseFromRow));
  }
  if (request.method === "GET" && url.pathname === "/api/directory") {
    const rows = db.prepare("SELECT * FROM cases WHERE fingerprint_json IS NOT NULL AND is_published=1 ORDER BY updated_at DESC").all();
    return sendJson(response, 200, rows.map((row) => caseFromRow(row, { publicView: true })));
  }
  if (request.method === "POST" && url.pathname === "/api/cases") {
    const body = await readJson(request);
    const id = String(body.id || Date.now().toString().slice(-5));
    if (!/^[A-Z0-9-]{3,32}$/i.test(id)) return sendJson(response, 400, { error: "案例编号格式无效" });
    const boundedFields = [
      [body.name, 60], [body.city, 40], [body.disease, 160], [body.hospital, 160],
      [body.applicant, 120], [body.applicantName, 60], [body.applicantRelation, 30],
      [body.applicantIdMasked, 32], [body.applicantPhone, 32], [body.projectName, 160],
      [body.projectId, 80], [body.projectPlatform, 60], [body.virtualPhone, 60],
      [body.email, 120], [body.status, 80], [body.sourceVideoName, 180], [body.textCorpus, 2000],
    ];
    if (boundedFields.some(([value, limit]) => String(value || "").length > limit)) return sendJson(response, 400, { error: "案例字段长度超出限制" });
    if (body.fingerprint && !validateFingerprint(body.fingerprint)) return sendJson(response, 400, { error: "视频指纹结构无效" });
    if (body.accounts && (!Array.isArray(body.accounts) || body.accounts.length > 10 || body.accounts.some((account) =>
      String(account.platform || "").length > 40 || String(account.accountKey || "").length > 120 || String(account.displayName || "").length > 120))) {
      return sendJson(response, 400, { error: "授权账号数据无效" });
    }
    const timestamp = now();
    db.prepare(`INSERT INTO cases (
      id,name,avatar,age,city,disease,hospital,applicant,applicant_name,applicant_relation,
      applicant_id_masked,applicant_phone,identity_status,project_name,project_id,project_platform,is_published,virtual_phone,email,
      confidence,status,fingerprint_json,source_video_name,text_corpus,updated_at,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,avatar=excluded.avatar,age=excluded.age,city=excluded.city,
      disease=excluded.disease,hospital=excluded.hospital,applicant=excluded.applicant,
      applicant_name=excluded.applicant_name,applicant_relation=excluded.applicant_relation,
      applicant_id_masked=excluded.applicant_id_masked,applicant_phone=excluded.applicant_phone,identity_status=excluded.identity_status,
      project_name=excluded.project_name,
      project_id=excluded.project_id,project_platform=excluded.project_platform,is_published=0,
      virtual_phone=excluded.virtual_phone,email=excluded.email,
      confidence=excluded.confidence,status=excluded.status,
      fingerprint_json=CASE WHEN excluded.status='身份已核验·待上传可信原片' THEN NULL ELSE COALESCE(excluded.fingerprint_json,cases.fingerprint_json) END,
      source_video_name=CASE WHEN excluded.status='身份已核验·待上传可信原片' THEN NULL ELSE COALESCE(excluded.source_video_name,cases.source_video_name) END,
      text_corpus=excluded.text_corpus,updated_at=excluded.updated_at`).run(
      id, body.name || "未命名受助者", body.avatar || String(body.name || "助").slice(-1), body.age || "未填写",
      body.city || "未填写", body.disease || "未填写", body.hospital || "未填写", body.applicant || "未填写",
      body.applicantName || "", body.applicantRelation || "", body.applicantIdMasked || "", body.applicantPhone || "", body.identityStatus || "待核身",
      body.projectName || "未填写", body.projectId || "未填写", body.projectPlatform || "未填写", 0,
      body.virtualPhone || "待配置", body.email || "待配置",
      Math.max(0, Math.min(100, Number.isFinite(Number(body.confidence)) ? Number(body.confidence) : 90)), body.status || "实时有效", body.fingerprint ? JSON.stringify(body.fingerprint) : null,
      body.sourceVideoName || null, body.textCorpus || "", timestamp, timestamp,
    );
    if (Array.isArray(body.accounts)) {
      db.prepare("DELETE FROM accounts WHERE case_id = ?").run(id);
      const insert = db.prepare("INSERT INTO accounts(case_id,platform,account_key,display_name,authorized_until,trust_badge) VALUES(?,?,?,?,?,?)");
      for (const account of body.accounts) insert.run(id, account.platform, account.accountKey || randomUUID(), account.displayName, account.authorizedUntil || "2099-12-31", account.trustBadge ? 1 : 0);
    }
    audit("case.upsert", "case", id, body.fingerprint ? "可信原片与案例已写入" : "案例资料已写入");
    const row = db.prepare("SELECT * FROM cases WHERE id = ?").get(id);
    return sendJson(response, 200, caseFromRow(row));
  }
  const publicationMatch = url.pathname.match(/^\/api\/cases\/([^/]+)\/publication$/);
  if (request.method === "PATCH" && publicationMatch) {
    const id = decodeURIComponent(publicationMatch[1]);
    const body = await readJson(request);
    if (typeof body.published !== "boolean") return sendJson(response, 400, { error: "published 必须是布尔值" });
    const current = db.prepare("SELECT fingerprint_json FROM cases WHERE id=?").get(id);
    if (!current) return sendJson(response, 404, { error: "案例不存在" });
    if (body.published && !current.fingerprint_json) return sendJson(response, 409, { error: "尚未生成可信视频源，不能公开发布" });
    const published = body.published ? 1 : 0;
    const status = published ? "实时有效" : "已撤回公开";
    db.prepare("UPDATE cases SET is_published=?,status=?,updated_at=? WHERE id=?").run(published, status, now(), id);
    audit(published ? "case.publish" : "case.unpublish", "case", id, published ? "用户确认授权公开" : "用户撤回公开授权");
    return sendJson(response, 200, caseFromRow(db.prepare("SELECT * FROM cases WHERE id=?").get(id)));
  }
  if (request.method === "POST" && url.pathname === "/api/upload") {
    const originalName = basename(decodeURIComponent(request.headers["x-file-name"] || "upload.bin")).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 180);
    const kind = decodeURIComponent(String(request.headers["x-file-kind"] || "evidence")).slice(0, 30);
    const rule = uploadRules.get(kind);
    if (!rule) return sendJson(response, 400, { error: "不支持的上传类型" });
    const extension = extname(originalName).slice(0, 12).toLowerCase();
    if (!rule.extensions.has(extension)) return sendJson(response, 415, { error: `${kind}不支持 ${extension || "无扩展名"} 文件` });
    const declaredSize = Number(request.headers["content-length"] || 0);
    if (declaredSize > rule.maxBytes) return sendJson(response, 413, { error: `${kind}超过大小限制` });
    const id = randomUUID();
    const storedPath = join(uploadRoot, `${id}${extension}`);
    const stream = createWriteStream(storedPath, { flags: "wx" });
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > rule.maxBytes) {
        stream.destroy();
        await new Promise((resolveClose) => stream.once("close", resolveClose));
        if (existsSync(storedPath)) unlinkSync(storedPath);
        return sendJson(response, 413, { error: `${kind}超过大小限制` });
      }
      if (!stream.write(chunk)) await once(stream, "drain");
    }
    stream.end();
    await once(stream, "finish");
    db.prepare("INSERT INTO uploads(id,kind,original_name,stored_path,size,created_at) VALUES(?,?,?,?,?,?)")
      .run(id, kind, originalName, storedPath, size, now());
    audit("upload.create", "upload", id, `${kind}:${originalName}`);
    return sendJson(response, 201, { id, originalName, size });
  }
  if (request.method === "POST" && url.pathname === "/api/analyze") {
    const body = await readJson(request);
    if (!validateFingerprint(body.fingerprint)) return sendJson(response, 400, { error: "缺少有效视频指纹，至少需要 4 个合法关键帧" });
    if (String(body.publisherAccount || "").length > 120 || String(body.paymentProjectId || "").length > 120 || String(body.textSummary || "").length > 2000) {
      return sendJson(response, 400, { error: "分析字段长度超出限制" });
    }
    const result = buildAnalysis(body);
    const analysisId = `AN-${randomUUID().slice(0, 8).toUpperCase()}`;
    result.analysisId = analysisId;
    db.prepare(`INSERT INTO analyses(id,video_name,platform,publisher_account,payment_project_id,matched_case_id,match_score,risk_score,algorithm_version,evidence_coverage,input_json,result_json,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      analysisId, body.videoName || "未命名视频", body.platform || "未知平台", body.publisherAccount || "未知账号",
      body.paymentProjectId || "未提供", result.matchedCaseId, result.matchScore, result.riskScore,
      result.algorithmVersion, result.evidenceCoverage,
      JSON.stringify({ platform: body.platform || "未知平台", publisherAccount: body.publisherAccount || "未知账号", paymentProjectId: body.paymentProjectId || "未提供", textSummary: body.textSummary || "" }),
      JSON.stringify(result), now(),
    );
    audit("analysis.create", "analysis", analysisId, `${result.level}:${result.riskScore}`);
    return sendJson(response, 200, result);
  }
  if (request.method === "POST" && url.pathname === "/api/reports") {
    const body = await readJson(request);
    const analysis = db.prepare("SELECT id FROM analyses WHERE id = ?").get(body.analysisId);
    if (!analysis) return sendJson(response, 404, { error: "分析记录不存在" });
    const existing = db.prepare("SELECT id,status FROM reports WHERE analysis_id=? ORDER BY created_at DESC LIMIT 1").get(body.analysisId);
    if (existing) return sendJson(response, 200, { id: existing.id, status: existing.status, duplicate: true });
    const id = `RP-${randomUUID().slice(0, 8).toUpperCase()}`;
    const timestamp = now();
    db.prepare("INSERT INTO reports(id,analysis_id,status,decision,reviewer_note,updated_at,created_at) VALUES(?,?,?,?,?,?,?)")
      .run(id, body.analysisId, "待复核", "pending", "", timestamp, timestamp);
    audit("report.create", "report", id, body.analysisId);
    return sendJson(response, 201, { id, status: "待复核" });
  }
  if (request.method === "GET" && url.pathname === "/api/reviews") {
    const rows = db.prepare(`SELECT r.*,a.video_name,a.platform,a.publisher_account,a.risk_score,a.result_json
      FROM reports r JOIN analyses a ON a.id=r.analysis_id ORDER BY r.created_at DESC`).all();
    return sendJson(response, 200, rows.map((row) => ({
      id: row.id, analysisId: row.analysis_id, videoName: row.video_name, platform: row.platform,
      publisherAccount: row.publisher_account, riskScore: row.risk_score, status: row.status,
      decision: row.decision, reviewerNote: row.reviewer_note, result: JSON.parse(row.result_json), createdAt: row.created_at, updatedAt: row.updated_at,
    })));
  }
  const reviewMatch = url.pathname.match(/^\/api\/reviews\/([^/]+)$/);
  if (request.method === "PATCH" && reviewMatch) {
    const body = await readJson(request);
    const id = decodeURIComponent(reviewMatch[1]);
    const allowedDecisions = new Set(["human", "limit", "pass"]);
    if (!allowedDecisions.has(body.decision)) return sendJson(response, 400, { error: "无效的审核决定" });
    const reviewerNote = String(body.reviewerNote || "").trim().slice(0, 500);
    const status = body.decision === "pass" || body.decision === "limit" ? "已完成" : "人工复核中";
    const result = db.prepare("UPDATE reports SET status=?,decision=?,reviewer_note=?,updated_at=? WHERE id=?")
      .run(status, body.decision, reviewerNote, now(), id);
    if (!result.changes) return sendJson(response, 404, { error: "审核任务不存在" });
    audit("review.update", "report", id, `${body.decision}:${status}${reviewerNote ? `:${reviewerNote}` : ""}`);
    return sendJson(response, 200, { id, status, decision: body.decision, reviewerNote });
  }
  if (request.method === "GET" && url.pathname === "/api/audit") {
    const entityId = String(url.searchParams.get("entityId") || "").trim();
    const rows = entityId
      ? db.prepare("SELECT id,action,entity_type,entity_id,created_at FROM audit_logs WHERE entity_id=? ORDER BY id DESC LIMIT 100").all(entityId)
      : db.prepare("SELECT id,action,entity_type,entity_id,created_at FROM audit_logs ORDER BY id DESC LIMIT 100").all();
    return sendJson(response, 200, rows);
  }
  return sendJson(response, 404, { error: "接口不存在" });
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".txt": "text/plain; charset=utf-8",
};

function serveStatic(response, pathname) {
  const publicFiles = new Map([
    ["/", "index.html"],
    ["/index.html", "index.html"],
    ["/app.js", "app.js"],
    ["/app.css", "app.css"],
    ["/og.png", "og.png"],
    ["/trustaid-logo.jpg", "trustaid-logo.jpg"],
  ]);
  const fileName = publicFiles.get(pathname);
  if (!fileName) return sendJson(response, 404, { error: "页面不存在" });
  const target = join(staticRoot, fileName);
  if (!existsSync(target) || !statSync(target).isFile()) return sendJson(response, 404, { error: "页面不存在" });
  const body = readFileSync(target);
  response.writeHead(200, {
    "content-type": mimeTypes[extname(target).toLowerCase()] || "application/octet-stream",
    "content-length": body.length,
    "cache-control": "no-cache",
  });
  response.end(body);
}

const port = Number(process.env.TRUSTAID_PORT || 4178);
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || `127.0.0.1:${port}`}`);
    if (url.pathname.startsWith("/api/")) {
      const origin = String(request.headers.origin || "");
      const allowedOrigins = new Set(["null", `http://127.0.0.1:${port}`, `http://localhost:${port}`]);
      if (origin && !allowedOrigins.has(origin)) return sendJson(response, 403, { error: "拒绝非本地页面调用" });
      if (origin) response.setHeader("access-control-allow-origin", origin);
      response.setHeader("vary", "Origin");
      response.setHeader("access-control-allow-headers", "content-type,x-file-name,x-file-kind");
      response.setHeader("access-control-allow-methods", "GET,POST,PATCH,OPTIONS");
      await handleApi(request, response, url);
    }
    else serveStatic(response, decodeURIComponent(url.pathname));
  } catch (error) {
    console.error(error);
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof HttpError ? error.message : "系统暂时无法处理该请求";
    if (!response.headersSent) sendJson(response, status, { error: message });
    else response.end();
  }
});

server.listen(port, "127.0.0.1", () => {
  const address = `http://127.0.0.1:${port}`;
  console.log(`\n善证 TrustAid 本地可用系统已启动：${address}`);
  console.log(`数据库：${join(dataRoot, "trustaid.db")}`);
  console.log("关闭此窗口即可停止系统。\n");
  if (process.env.TRUSTAID_NO_OPEN !== "1" && process.platform === "win32") {
    const child = spawn("cmd.exe", ["/c", "start", "", address], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
  }
});
