"use client";

import { ChangeEvent, useEffect, useMemo, useState } from "react";
import { fingerprintVideo } from "./lib/video-fingerprint";

type ModuleId = "registry" | "verify" | "directory";
type Provider = "alipay" | "douyin" | "bilibili";
type VerifySample = "risk" | "authorized";
type VerifyView = "public" | "platform";
type ReviewDecision = "pending" | "human" | "limit" | "pass";
type VerificationSignal = { label: string; engine: string; score: number; weight: number; detail: string; contribution?: number };
type VerificationResult = {
  riskScore: number;
  matchScore: number;
  title: string;
  level: string;
  signals: VerificationSignal[];
  analysisId?: string | null;
  matchedCaseId?: string | null;
  algorithmVersion?: string;
  evidenceCoverage?: number;
  recommendation?: string;
  thresholdPolicy?: string;
  topFactors?: Array<{ label: string; contribution: number; detail: string }>;
};
type ReviewTask = {
  id: string;
  analysisId: string;
  videoName: string;
  platform: string;
  publisherAccount: string;
  riskScore: number;
  status: string;
  decision: string;
  reviewerNote?: string;
  result?: VerificationResult;
  createdAt: string;
  updatedAt?: string;
};
type AuditLog = { id: number; action: string; entity_type: string; entity_id: string; detail?: string; created_at: string };
type FormErrors = Record<string, string>;
type ConfirmAction = {
  title: string;
  message: string;
  confirmLabel: string;
  tone?: "primary" | "danger";
  onConfirm: () => void | Promise<void>;
};

function relationRequirement(relation: string) {
  switch (relation) {
    case "本人":
      return { required: false, title: "无需上传关系证明", description: "系统将自动核对申请人与患者姓名是否一致" };
    case "母亲":
    case "父亲":
      return { required: true, title: "上传亲子关系证明", description: "出生医学证明、户口簿或亲属关系证明" };
    case "配偶":
      return { required: true, title: "上传配偶关系证明", description: "结婚证、户口簿或具有法律效力的关系材料" };
    case "子女":
      return { required: true, title: "上传亲属关系证明", description: "户口簿、出生医学证明或亲属关系证明" };
    case "其他监护人":
      return { required: true, title: "上传监护或授权证明", description: "监护证明、授权委托书或其他有效关系材料" };
    default:
      return { required: true, title: "上传关系证明", description: "先选择与患者关系，系统会提示可用材料" };
  }
}

function apiAddress(path: string) {
  if (typeof window !== "undefined" && window.location.protocol === "file:") return `http://127.0.0.1:4178${path}`;
  return path;
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiAddress(path), init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `请求失败：${response.status}`);
  return payload as T;
}

async function uploadLocalFile(file: File, kind: string) {
  return apiRequest<{ id: string; size: number }>("/api/upload", {
    method: "POST",
    headers: { "x-file-name": encodeURIComponent(file.name), "x-file-kind": encodeURIComponent(kind) },
    body: file,
  });
}

const modules: Array<{
  id: ModuleId;
  index: string;
  title: string;
}> = [
  {
    id: "registry",
    index: "01",
    title: "求助者建档",
  },
  {
    id: "verify",
    index: "02",
    title: "视频核验与举报",
  },
  {
    id: "directory",
    index: "03",
    title: "可信案例目录",
  },
];

const verificationModels = {
  risk: {
    riskScore: 86,
    matchScore: 92.4,
    matchedCaseId: "DEMO-1001",
    title: "疑似复用可信求助内容并替换收款入口",
    level: "高风险",
    signals: [
      { label: "发布账号未授权", engine: "账号授权关系", score: 96, weight: 24, detail: "发布账号不在案例授权账号名单中" },
      { label: "收款入口冲突", engine: "项目与收款入口核对", score: 98, weight: 28, detail: "个人收款账户与演示项目 ALI-DEMO-1001 不一致" },
      { label: "视频编辑异常", engine: "画面顺序与编辑痕迹", score: 74, weight: 18, detail: "收款画面可能经过二次覆盖" },
      { label: "病例语义冲突", engine: "文案与病例摘要核对", score: 55, weight: 12, detail: "传播文案新增未经可信源确认的病情描述" },
      { label: "传播关系未知", engine: "发布者授权关系", score: 86, weight: 18, detail: "发布者与求助者之间没有可核验的授权记录" },
    ],
  },
  authorized: {
    riskScore: 6,
    matchScore: 91.7,
    matchedCaseId: "DEMO-1001",
    title: "可信原片的家属授权转发",
    level: "低风险",
    signals: [
      { label: "发布账号未授权", engine: "账号授权关系", score: 3, weight: 24, detail: "演示授权记录有效至 2027-12-31" },
      { label: "收款入口冲突", engine: "项目与收款入口核对", score: 2, weight: 28, detail: "收款入口指向演示项目 ALI-DEMO-1001" },
      { label: "视频编辑异常", engine: "画面顺序与编辑痕迹", score: 12, weight: 18, detail: "只发现内容平台的常规转码" },
      { label: "病例语义冲突", engine: "文案与病例摘要核对", score: 8, weight: 12, detail: "关键信息与可信病例摘要一致" },
      { label: "传播关系未知", engine: "发布者授权关系", score: 7, weight: 18, detail: "家属授权记录与当前发布账号一致" },
    ],
  },
};

const registrySteps = [
  { title: "身份与病例", short: "核验求助事实" },
  { title: "账号绑定", short: "确认账号控制权" },
  { title: "项目关联", short: "锁定公开募捐" },
  { title: "视频可信源", short: "生成可比对指纹" },
];

const patientCities = ["杭州", "宁波", "温州", "嘉兴", "湖州", "绍兴", "金华", "衢州", "舟山", "台州", "丽水", "省外/其他地区"];

const hospitalsByCity: Record<string, string[]> = {
  杭州: ["浙江省儿童医院", "浙江大学医学院附属第一医院", "浙江大学医学院附属第二医院", "浙江省人民医院", "杭州市第一人民医院"],
  宁波: ["宁波市妇女儿童医院", "宁波市第一医院", "宁波市第二医院"],
  温州: ["温州医科大学附属第一医院", "温州医科大学附属第二医院（育英儿童医院）", "温州市中心医院"],
  嘉兴: ["嘉兴市第一医院", "嘉兴市第二医院", "嘉兴市妇幼保健院"],
  湖州: ["湖州市中心医院", "湖州市第一人民医院", "湖州市妇幼保健院"],
  绍兴: ["绍兴市人民医院", "绍兴市中心医院", "绍兴市妇幼保健院"],
  金华: ["金华市中心医院", "浙江大学医学院附属第四医院", "金华市人民医院"],
  衢州: ["衢州市人民医院", "衢州市妇幼保健院"],
  舟山: ["舟山医院", "舟山市妇女儿童医院"],
  台州: ["浙江省台州医院", "台州市中心医院", "台州市第一人民医院"],
  丽水: ["丽水市中心医院", "丽水市人民医院"],
  "省外/其他地区": ["其他公立医院", "其他医疗机构"],
};

const providers: Array<{
  id: Provider;
  name: string;
  mark: string;
  color: string;
  account: string;
  accountId: string;
}> = [
  {
    id: "alipay",
    name: "支付宝",
    mark: "支",
    color: "#1677ff",
    account: "虚拟申请人",
    accountId: "ALI_DEMO•••1001",
  },
  {
    id: "douyin",
    name: "抖音",
    mark: "抖",
    color: "#151922",
    account: "虚拟求助账号",
    accountId: "DY_DEMO•••1001",
  },
  {
    id: "bilibili",
    name: "哔哩哔哩",
    mark: "B",
    color: "#00a1d6",
    account: "虚拟康复记录",
    accountId: "BILI_DEMO•••1001",
  },
];

const whitelist = [
  {
    id: "DEMO-1001",
    name: "林安宁",
    avatar: "宁",
    age: "8岁",
    city: "杭州",
    disease: "急性淋巴细胞白血病",
    hospital: "浙江省儿童医院",
    applicant: "方静（母亲）",
    applicantName: "方静",
    applicantRelation: "母亲",
    applicantIdMasked: "DEMO********1001",
    applicantPhone: "1XX **** 1001",
    identityStatus: "虚拟演示身份·核验通过",
    project: "陪安宁完成后续治疗",
    virtualPhone: "95000-61001",
    email: "lin-anning@example.invalid",
    confidence: "96.8%",
    updated: "2026-08-09 12:00",
    status: "虚拟演示·实时有效",
    lastChecked: "演示数据",
  },
  {
    id: "DEMO-1002",
    name: "周小满",
    avatar: "满",
    age: "37岁",
    city: "宁波",
    disease: "扩张型心肌病",
    hospital: "宁波市第一医院",
    applicant: "周小满（本人）",
    applicantName: "周小满",
    applicantRelation: "本人",
    applicantIdMasked: "DEMO********1002",
    applicantPhone: "1XX **** 1002",
    identityStatus: "虚拟演示身份·核验通过",
    project: "守护小满的心脏康复路",
    virtualPhone: "95000-61002",
    email: "zhou-xiaoman@example.invalid",
    confidence: "94.6%",
    updated: "2026-08-09 12:00",
    status: "虚拟演示·实时有效",
    lastChecked: "演示数据",
  },
];

type CaseRecord = (typeof whitelist)[number] & {
  projectId?: string;
  projectPlatform?: string;
  published?: boolean;
  hasTrustedVideo?: boolean;
  sourceVideoName?: string;
  accounts?: Array<{ platform: string; accountKey?: string; displayName?: string; authorizedUntil?: string; trustBadge?: boolean }>;
};

function isDemoCase(record: Pick<CaseRecord, "id"> | null | undefined) {
  return Boolean(record?.id.startsWith("DEMO-"));
}

function sortCaseRecords(records: CaseRecord[]) {
  return [...records].sort((left, right) => left.id.localeCompare(right.id, "zh-CN", { numeric: true }));
}

function maskIdentityNumber(value: string) {
  const clean = value.trim();
  if (clean.includes("*")) return clean;
  if (clean.length < 8) return clean;
  return `${clean.slice(0, 4)}${"*".repeat(Math.max(4, clean.length - 8))}${clean.slice(-4)}`;
}

function maskRegistrationPhone(value: string) {
  const clean = value.trim();
  if (clean.includes("*")) return clean;
  const digits = clean.replace(/\D/g, "");
  if (digits.length < 7) return clean;
  return `${digits.slice(0, 3)} **** ${digits.slice(-4)}`;
}

function normalizeFullWidthDigits(value: string) {
  return value.replace(/[０-９]/g, (character) => String(character.charCodeAt(0) - 0xff10));
}

function normalizeIdentityInput(value: string) {
  return normalizeFullWidthDigits(value).replace(/[\s-]/g, "").toUpperCase();
}

function normalizePhoneInput(value: string) {
  return normalizeFullWidthDigits(value).replace(/[^\d]/g, "");
}

function isReasonableName(value: string) {
  return /^[\p{L}·•'\-\s]{2,40}$/u.test(value.trim());
}

function identityValidationError(value: string) {
  const identity = normalizeIdentityInput(value);
  if (!/^\d{17}[\dX]$/.test(identity)) return "请输入18位身份证号，最后一位可以是数字或X";
  const birthText = identity.slice(6, 14);
  const year = Number(birthText.slice(0, 4));
  const month = Number(birthText.slice(4, 6));
  const day = Number(birthText.slice(6, 8));
  const birthDate = new Date(Date.UTC(year, month - 1, day));
  if (birthDate.getUTCFullYear() !== year || birthDate.getUTCMonth() !== month - 1 || birthDate.getUTCDate() !== day) return "身份证号中的出生日期无效";
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checks = ["1", "0", "X", "9", "8", "7", "6", "5", "4", "3", "2"];
  const checksum = identity.slice(0, 17).split("").reduce((sum, digit, index) => sum + Number(digit) * weights[index], 0);
  if (checks[checksum % 11] !== identity[17]) return "身份证号校验位不正确，请检查是否输错数字";
  return "";
}

function createLocalCaseId() {
  return `C${Date.now().toString(36).slice(-6).toUpperCase()}`;
}

function contactDetailsForCase(caseId: string) {
  const numeric = String(Array.from(caseId).reduce((value, character) => (value * 31 + character.charCodeAt(0)) % 100000, 17)).padStart(5, "0");
  return {
    virtualPhone: `95000-${numeric}`,
    email: `trustaid-${caseId.toLowerCase()}@demo.cn`,
  };
}

function auditActionLabel(action: string) {
  const labels: Record<string, string> = {
    "case.upsert": "案例资料更新",
    "case.publish": "确认公开授权",
    "case.unpublish": "撤回公开授权",
    "case.seed-demo": "生成虚拟演示案例",
    "upload.create": "材料安全入库",
    "analysis.create": "生成算法分析",
    "report.create": "提交平台复核",
    "review.update": "保存审核决定",
  };
  return labels[action] || action;
}

export default function Home() {
  const [activeModule, setActiveModule] = useState<ModuleId>("registry");
  const [registryStep, setRegistryStep] = useState(0);
  const [currentCaseId, setCurrentCaseId] = useState("");
  const [applicantName, setApplicantName] = useState("");
  const [applicantRelation, setApplicantRelation] = useState("");
  const [applicantIdNumber, setApplicantIdNumber] = useState("");
  const [applicantIdMasked, setApplicantIdMasked] = useState("");
  const [applicantPhone, setApplicantPhone] = useState("");
  const [patientName, setPatientName] = useState("");
  const [patientAge, setPatientAge] = useState("");
  const [patientCity, setPatientCity] = useState("");
  const [patientDisease, setPatientDisease] = useState("");
  const [patientHospital, setPatientHospital] = useState("");
  const [identityVerified, setIdentityVerified] = useState(false);
  const [registrationSaved, setRegistrationSaved] = useState(false);
  const [registrationSaving, setRegistrationSaving] = useState(false);
  const [registrationFeedback, setRegistrationFeedback] = useState("");
  const [registrationErrors, setRegistrationErrors] = useState<FormErrors>({});
  const [caseFile, setCaseFile] = useState("");
  const [caseUpload, setCaseUpload] = useState<File | null>(null);
  const [relationFile, setRelationFile] = useState("");
  const [relationUpload, setRelationUpload] = useState<File | null>(null);
  const [originalVideo, setOriginalVideo] = useState("");
  const [originalVideoFile, setOriginalVideoFile] = useState<File | null>(null);
  const [bound, setBound] = useState<Record<Provider, boolean>>({
    alipay: false,
    douyin: false,
    bilibili: false,
  });
  const [authProvider, setAuthProvider] = useState<Provider | null>(null);
  const [registryProgress, setRegistryProgress] = useState(0);
  const [registryAnalyzing, setRegistryAnalyzing] = useState(false);
  const [registryVerified, setRegistryVerified] = useState(false);
  const [projectLinked, setProjectLinked] = useState(false);
  const [projectLinking, setProjectLinking] = useState(false);
  const [projectPlatform, setProjectPlatform] = useState("支付宝公益");
  const [projectName, setProjectName] = useState("");
  const [projectId, setProjectId] = useState("");
  const [projectErrors, setProjectErrors] = useState<FormErrors>({});
  const [published, setPublished] = useState(false);

  const [verifyView, setVerifyView] = useState<VerifyView>("public");
  const [verifySample, setVerifySample] = useState<VerifySample>("risk");
  const [publicVideo, setPublicVideo] = useState("疑似换码求助视频.mp4");
  const [publicVideoFile, setPublicVideoFile] = useState<File | null>(null);
  const [verificationInput, setVerificationInput] = useState<"preset" | "file">("preset");
  const [verifyProgress, setVerifyProgress] = useState(0);
  const [verifyAnalyzing, setVerifyAnalyzing] = useState(false);
  const [verifyComplete, setVerifyComplete] = useState(false);
  const [reported, setReported] = useState(false);
  const [reviewDecision, setReviewDecision] = useState<ReviewDecision>("pending");
  const [badgeIssued, setBadgeIssued] = useState(false);
  const [liveAnalysis, setLiveAnalysis] = useState<VerificationResult | null>(null);
  const [foundPlatform, setFoundPlatform] = useState("抖音");
  const [publisherAccount, setPublisherAccount] = useState("陌生转发账号_778");
  const [paymentProjectId, setPaymentProjectId] = useState("PERSONAL-DEMO-778");
  const [textSummary, setTextSummary] = useState("林安宁在浙江省儿童医院治疗急性淋巴细胞白血病，演示项目需要医疗帮助");
  const [currentReportId, setCurrentReportId] = useState<string | null>(null);
  const [reviewTasks, setReviewTasks] = useState<ReviewTask[]>([]);
  const [reviewerNote, setReviewerNote] = useState("");
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);

  const [systemOnline, setSystemOnline] = useState(false);
  const [systemHealth, setSystemHealth] = useState({ cases: 0, trustedSources: 0, publishedCases: 0, pendingReviews: 0, auditEvents: 0, version: "1.0.0", algorithmVersion: "TA-LocalFusion-0.5" });
  const [systemNotice, setSystemNotice] = useState("");
  const [projectInfoOpen, setProjectInfoOpen] = useState(false);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);

  const [query, setQuery] = useState("");
  const [city, setCity] = useState("全部地区");
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [selectedPerson, setSelectedPerson] = useState("DEMO-1001");
  const [directoryPeople, setDirectoryPeople] = useState<CaseRecord[]>(whitelist);
  const [savedRegistryCases, setSavedRegistryCases] = useState<CaseRecord[]>([]);
  const [savedRegistryCase, setSavedRegistryCase] = useState<CaseRecord | null>(null);

  const boundCount = Object.values(bound).filter(Boolean).length;
  const accountRequirementMet = bound.alipay && (bound.douyin || bound.bilibili);
  const selectedProvider = providers.find((provider) => provider.id === authProvider);
  const availableHospitals = hospitalsByCity[patientCity] ?? [];
  const relationEvidence = relationRequirement(applicantRelation);
  const relationEvidenceMet = !relationEvidence.required || Boolean(relationFile);
  const registryMaterialTarget = relationEvidence.required ? 3 : 2;
  const registryMaterials = [caseFile, ...(relationEvidence.required ? [relationFile] : []), originalVideo].filter(Boolean).length;
  const registryCompletion = Math.round(
    ((identityVerified ? 1 : 0) + (caseFile ? 1 : 0) + (relationEvidenceMet ? 1 : 0) + (accountRequirementMet ? 1 : 0) + (projectLinked ? 1 : 0) + (registryVerified ? 1 : 0)) / 6 * 100,
  );
  const completedRegistrySteps = [registrationSaved, accountRequirementMet, projectLinked, registryVerified];
  const unlockedRegistrySteps = [true, registrationSaved, registrationSaved && accountRequirementMet, projectLinked];
  const registrationActionLabel = registrationSaving
    ? "正在保存注册资料…"
    : !caseFile || !relationEvidenceMet
      ? relationEvidence.required ? "请补充病例与关系证明" : "请补充病例材料"
      : !identityVerified
        ? "请先完成身份验证"
        : registrationSaved
          ? "资料已保存，进入账号绑定"
          : "保存注册资料并继续";
  const activeVerification: VerificationResult = liveAnalysis ?? verificationModels[verifySample];
  const activeIsRisk = activeVerification.riskScore >= 30;
  const activeEvidenceCoverage = activeVerification.evidenceCoverage ?? 100;
  const activeEvidenceInsufficient = activeEvidenceCoverage < 70 || activeVerification.level === "证据不足";
  const publicReviewStatus = activeEvidenceInsufficient
    ? "现有信息还不够"
    : activeVerification.riskScore >= 70
      ? "这段内容需要重点核对"
      : activeVerification.riskScore >= 30
        ? "有几处信息建议再确认"
        : "目前未见明显异常";
  const publicReviewSymbol = activeEvidenceInsufficient ? "?" : activeVerification.riskScore >= 30 ? "!" : "✓";
  const activeAlgorithmVersion = activeVerification.algorithmVersion ?? "TA-LocalFusion-0.5";
  const activeRecommendation = activeVerification.recommendation ?? (activeIsRisk ? "建议平台结合完整证据链进行人工复核" : "未见明显异常，可保留内容并持续监测授权状态");
  const reviewTaskSelected = !systemOnline || Boolean(currentReportId);
  const matchedDirectoryCase = activeVerification.matchedCaseId
    ? directoryPeople.find((person) => person.id === activeVerification.matchedCaseId)
    : null;
  const directoryCities = useMemo(
    () => Array.from(new Set(directoryPeople.map((person) => person.city).filter(Boolean))).sort(),
    [directoryPeople],
  );

  const filteredWhitelist = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return directoryPeople.filter((person) => {
      const matchesCity = city === "全部地区" || person.city === city;
      const haystack = [person.name, person.disease, person.hospital, person.project, person.id]
        .join(" ")
        .toLowerCase();
      return matchesCity && (!keyword || haystack.includes(keyword));
    });
  }, [city, directoryPeople, query]);

  const selectedProfile =
    filteredWhitelist.find((person) => person.id === selectedPerson) ??
    filteredWhitelist[0] ??
    null;

  useEffect(() => {
    let active = true;
    async function connectLocalSystem() {
      try {
        const [health, cases, directory, reviews, audits] = await Promise.all([
          apiRequest<{ ok: boolean; cases: number; trustedSources: number; publishedCases: number; pendingReviews: number; auditEvents: number; version: string; algorithmVersion: string }>("/api/health"),
          apiRequest<CaseRecord[]>("/api/cases"),
          apiRequest<CaseRecord[]>("/api/directory"),
          apiRequest<ReviewTask[]>("/api/reviews"),
          apiRequest<AuditLog[]>("/api/audit"),
        ]);
        if (!active) return;
        setSystemOnline(Boolean(health.ok));
        setSystemHealth({ cases: health.cases, trustedSources: health.trustedSources, publishedCases: health.publishedCases, pendingReviews: health.pendingReviews, auditEvents: health.auditEvents, version: health.version, algorithmVersion: health.algorithmVersion });
        const sortedCases = sortCaseRecords(cases);
        setDirectoryPeople(sortCaseRecords(directory));
        setSavedRegistryCases(sortedCases);
        setSavedRegistryCase(sortedCases[0] ?? null);
        setReviewTasks(reviews);
        setAuditLogs(audits);
      } catch {
        if (active) setSystemOnline(false);
      }
    }
    void connectLocalSystem();
    return () => { active = false; };
  }, []);

  async function refreshBackendData() {
    if (!systemOnline) return;
    const [health, cases, directory, reviews, audits] = await Promise.all([
      apiRequest<{ cases: number; trustedSources: number; publishedCases: number; pendingReviews: number; auditEvents: number; version: string; algorithmVersion: string }>("/api/health"),
      apiRequest<CaseRecord[]>("/api/cases"),
      apiRequest<CaseRecord[]>("/api/directory"),
      apiRequest<ReviewTask[]>("/api/reviews"),
      apiRequest<AuditLog[]>("/api/audit"),
    ]);
    setSystemHealth(health);
    const sortedCases = sortCaseRecords(cases);
    setDirectoryPeople(sortCaseRecords(directory));
    setSavedRegistryCases(sortedCases);
    setSavedRegistryCase(sortedCases[0] ?? null);
    setReviewTasks(reviews);
    setAuditLogs(audits);
  }

  function markRegistrationDirty() {
    setRegistrationSaved(false);
    setProjectLinked(false);
    setRegistryVerified(false);
    setPublished(false);
  }

  function handleRelationChange(nextRelation: string) {
    setApplicantRelation(nextRelation);
    setRelationFile("");
    setRelationUpload(null);
    clearRegistrationError("applicantRelation");
    clearRegistrationError("relationFile");
    markRegistrationDirty();
  }

  function requestConfirmation(action: ConfirmAction) {
    setConfirmBusy(false);
    setConfirmAction(action);
  }

  async function runConfirmedAction() {
    if (!confirmAction || confirmBusy) return;
    const action = confirmAction;
    setConfirmBusy(true);
    try {
      await action.onConfirm();
      setConfirmAction(null);
    } finally {
      setConfirmBusy(false);
    }
  }

  function clearRegistrationError(field: string) {
    setRegistrationErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  }

  function validateIdentityFields() {
    const errors: FormErrors = {};
    if (!applicantName.trim()) errors.applicantName = "请填写申请人姓名";
    else if (!isReasonableName(applicantName)) errors.applicantName = "姓名请使用 2—40 个中文、字母或间隔符，不要填写数字或表情";
    if (!applicantRelation) errors.applicantRelation = "请选择申请人与患者的关系";
    const identityError = identityValidationError(applicantIdNumber);
    if (identityError) errors.applicantIdNumber = identityError;
    const normalizedPhone = normalizePhoneInput(applicantPhone);
    if (!/^1[3-9]\d{9}$/.test(normalizedPhone)) errors.applicantPhone = "请输入 11 位中国大陆手机号，例如 13800138000";
    return errors;
  }

  function validateRegistrationFields() {
    const errors: FormErrors = identityVerified ? {} : validateIdentityFields();
    if (!identityVerified) errors.identity = "请先完成模拟身份验证";
    if (!patientName.trim()) errors.patientName = "请填写患者姓名";
    else if (!isReasonableName(patientName)) errors.patientName = "患者姓名请使用 2—40 个中文、字母或间隔符";
    if (!/^(0|[1-9]\d{0,2})$/.test(patientAge.trim()) || Number(patientAge) > 120) {
      errors.patientAge = "年龄只能填写 0—120 的整数";
    }
    if (!patientCity) errors.patientCity = "请选择所在地区";
    if (!patientDisease.trim()) errors.patientDisease = "请填写主要诊断";
    else if (patientDisease.trim().length < 2) errors.patientDisease = "诊断信息至少填写 2 个字符";
    if (!patientHospital) errors.patientHospital = "请选择就诊医院";
    else if (!availableHospitals.includes(patientHospital)) errors.patientHospital = "所选医院与地区不匹配，请重新选择";
    if (applicantRelation === "本人" && applicantName.trim() !== patientName.trim()) {
      errors.patientName = "关系选择了“本人”，患者姓名应与申请人姓名一致";
    }
    if (!caseFile) errors.caseFile = "请上传病例材料（PDF/JPG/PNG，20MB以内）";
    if (relationEvidence.required && !relationFile) errors.relationFile = `${relationEvidence.title}（PDF/JPG/PNG，20MB以内）`;
    return errors;
  }

  function validateProjectFields() {
    const errors: FormErrors = {};
    if (!projectPlatform.trim()) errors.projectPlatform = "请选择公开募捐平台";
    if (projectName.trim().length < 3) errors.projectName = "项目名称至少填写 3 个字符";
    const normalizedProjectId = projectId.trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9_-]{2,63}$/.test(normalizedProjectId)) {
      errors.projectId = "项目编号需为 3—64 位字母、数字、短横线或下划线";
    }
    return errors;
  }

  function markProjectDirty() {
    setProjectLinked(false);
    setRegistryVerified(false);
    setPublished(false);
  }

  function handleFile(
    event: ChangeEvent<HTMLInputElement>,
    setter: (name: string) => void,
    fileSetter?: (file: File) => void,
    errorField?: string,
  ) {
    const file = event.target.files?.[0];
    if (file) {
      const expectsVideo = event.currentTarget.accept.includes("video");
      const extension = file.name.split(".").pop()?.toLowerCase() || "";
      const allowedEvidence = ["pdf", "jpg", "jpeg", "png"].includes(extension);
      const allowedVideo = file.type.startsWith("video/") || ["mp4", "webm", "mov", "m4v"].includes(extension);
      const maxBytes = expectsVideo ? 100 * 1024 * 1024 : 20 * 1024 * 1024;
      if ((expectsVideo && !allowedVideo) || (!expectsVideo && !allowedEvidence)) {
        const message = expectsVideo ? "请选择 MP4、WebM、MOV 等浏览器可播放的视频文件。" : "病例和关系材料仅支持 PDF、JPG、JPEG 或 PNG。";
        event.currentTarget.value = "";
        setSystemNotice(message);
        if (errorField) setRegistrationErrors((current) => ({ ...current, [errorField]: message }));
        return;
      }
      if (file.size > maxBytes) {
        const message = `文件过大：${expectsVideo ? "视频请控制在 100MB 以内" : "证明材料请控制在 20MB 以内"}。`;
        event.currentTarget.value = "";
        setSystemNotice(message);
        if (errorField) setRegistrationErrors((current) => ({ ...current, [errorField]: message }));
        return;
      }
      setter(file.name);
      fileSetter?.(file);
      if (!expectsVideo) markRegistrationDirty();
      setSystemNotice("");
      setRegistrationFeedback("");
      if (errorField) setRegistrationErrors((current) => {
        const next = { ...current };
        delete next[errorField];
        return next;
      });
    }
  }

  function loadRegistryDemo() {
    setCurrentCaseId("DEMO-1001");
    setApplicantName("方静");
    setApplicantRelation("母亲");
    setApplicantIdNumber("330102199208162849");
    setApplicantIdMasked("");
    setApplicantPhone("18800001001");
    setPatientName("林安宁");
    setPatientAge("8");
    setPatientCity("杭州");
    setPatientDisease("急性淋巴细胞白血病");
    setPatientHospital("浙江省儿童医院");
    setIdentityVerified(false);
    setRegistrationSaved(false);
    setRegistrationFeedback("");
    setRegistrationErrors({});
    setProjectErrors({});
    setProjectLinked(false);
    setProjectPlatform("支付宝公益");
    setProjectName("陪安宁完成后续治疗");
    setProjectId("ALI-DEMO-1001");
    setBound({ alipay: false, douyin: false, bilibili: false });
    setRegistryVerified(false);
    setPublished(false);
    setOriginalVideo("");
    setOriginalVideoFile(null);
    setCaseFile("虚拟案例_林安宁_病案首页.pdf");
    setRelationFile("虚拟案例_方静与林安宁_关系证明.jpg");
    setSystemNotice("虚拟演示资料已载入，不对应真实个人。请点击“模拟身份验证”，再保存并继续。");
  }

  function resumeSavedRegistration(caseToResume?: CaseRecord | null) {
    const persisted = caseToResume ?? savedRegistryCase;
    if (!persisted) return;
    const restoredProjectId = persisted.projectId && persisted.projectId !== "待关联" ? persisted.projectId : "";
    const restoredProjectName = persisted.project && persisted.project !== "待关联" ? persisted.project : "";
    setCurrentCaseId(persisted.id);
    setApplicantName(persisted.applicantName || "");
    setApplicantRelation(persisted.applicantRelation || "");
    setApplicantIdNumber("");
    setApplicantIdMasked(persisted.applicantIdMasked || "");
    setApplicantPhone(persisted.applicantPhone || "");
    setPatientName(persisted.name || "");
    setPatientAge(String(persisted.age || "").replace("岁", ""));
    setPatientCity(persisted.city || "");
    setPatientDisease(persisted.disease || "");
    setPatientHospital(persisted.hospital || "");
    setIdentityVerified(String(persisted.identityStatus || "").includes("通过"));
    setRegistrationSaved(true);
    setProjectLinked(Boolean(restoredProjectName && restoredProjectId));
    setProjectPlatform(persisted.projectPlatform && persisted.projectPlatform !== "未填写" ? persisted.projectPlatform : "支付宝公益");
    setProjectName(restoredProjectName);
    setProjectId(restoredProjectId);
    setPublished(Boolean(persisted.published));
    setRegistryVerified(Boolean(persisted.hasTrustedVideo));
    setOriginalVideo(persisted.sourceVideoName || (persisted.hasTrustedVideo ? "可信原片已存档" : ""));
    setOriginalVideoFile(null);
    setBound({
      alipay: Boolean(persisted.accounts?.some((account) => account.platform === "支付宝")),
      douyin: Boolean(persisted.accounts?.some((account) => account.platform === "抖音")),
      bilibili: Boolean(persisted.accounts?.some((account) => account.platform === "哔哩哔哩")),
    });
    setCaseFile("病例材料已存档");
    setCaseUpload(null);
    setRelationFile(persisted.applicantRelation === "本人" ? "" : "关系证明已存档");
    setRelationUpload(null);
    setRegistrationFeedback("已恢复脱敏资料与建档进度；原始附件不会重新显示，选择新文件即可替换。");
    setSystemNotice(`已从本地数据库恢复案例 TA-${persisted.id} 的资料、账号、项目和发布状态。`);
  }

  function startNewApplication() {
    const hasUnsavedInput = !registrationSaved && Boolean(applicantName || applicantIdNumber || applicantPhone || patientName || patientDisease || caseFile || relationFile);
    if (hasUnsavedInput) {
      requestConfirmation({
        title: "放弃当前填写并新建申请？",
        message: "当前尚未保存的身份信息、病例材料与填写进度会被清空；已经保存到本地数据库的案例不会删除。",
        confirmLabel: "放弃并新建",
        tone: "danger",
        onConfirm: createBlankApplication,
      });
      return;
    }
    createBlankApplication();
  }

  function createBlankApplication() {
    resetDemo();
    setActiveModule("registry");
    setRegistryStep(0);
    setSystemNotice("已创建空白建档。保存身份与病例后，系统会自动生成新的独立案例编号。");
  }

  function simulateIdentityVerification() {
    const errors = validateIdentityFields();
    setRegistrationErrors(errors);
    if (Object.keys(errors).length) {
      setSystemNotice(`身份验证前还有 ${Object.keys(errors).length} 项需要修改，错误已标在输入框下方。`);
      return;
    }
    const normalizedIdentity = normalizeIdentityInput(applicantIdNumber);
    const normalizedPhone = normalizePhoneInput(applicantPhone);
    setApplicantName(applicantName.trim());
    setApplicantIdNumber(normalizedIdentity);
    setApplicantPhone(normalizedPhone);
    setApplicantIdMasked(maskIdentityNumber(normalizedIdentity));
    setIdentityVerified(true);
    setRegistrationSaved(false);
    setSystemNotice("模拟身份验证已通过。正式接入时这里替换为支付宝身份验证返回结果，系统不会保存完整身份证号。");
  }

  async function saveRegistrationAndContinue() {
    const errors = validateRegistrationFields();
    setRegistrationErrors(errors);
    if (Object.keys(errors).length) {
      setRegistrationFeedback(`暂时无法保存：还有 ${Object.keys(errors).length} 项需要修改。`);
      setSystemNotice("注册资料未保存。请查看表单中的红色提示，修改后可以直接再次点击保存。 ");
      return;
    }
    setRegistrationSaving(true);
    setRegistrationFeedback("正在上传材料并保存脱敏注册资料，请稍候……");
    const maskedId = applicantIdMasked || maskIdentityNumber(applicantIdNumber);
    const maskedPhone = maskRegistrationPhone(applicantPhone);
    const caseId = currentCaseId || createLocalCaseId();
    const contact = contactDetailsForCase(caseId);
    if (!currentCaseId) setCurrentCaseId(caseId);
    try {
      if (systemOnline) {
        await Promise.all([
          caseUpload ? uploadLocalFile(caseUpload, "病例材料") : Promise.resolve(null),
          relationEvidence.required && relationUpload ? uploadLocalFile(relationUpload, "关系证明") : Promise.resolve(null),
        ]);
        await apiRequest("/api/cases", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: caseId,
            name: patientName.trim(),
            avatar: patientName.trim().slice(-1),
            age: `${patientAge.trim().replace("岁", "")}岁`,
            city: patientCity.trim(),
            disease: patientDisease.trim(),
            hospital: patientHospital.trim(),
            applicant: `${applicantName.trim()}（${applicantRelation.trim()}）`,
            applicantName: applicantName.trim(),
            applicantRelation: applicantRelation.trim(),
            applicantIdMasked: maskedId,
            applicantPhone: maskedPhone,
            identityStatus: "模拟核身通过",
            projectName: "待关联",
            projectId: "待关联",
            projectPlatform: "未填写",
            published: false,
            virtualPhone: contact.virtualPhone,
            email: contact.email,
            confidence: 90,
            status: "身份已核验·待上传可信原片",
            textCorpus: `${patientName} ${patientDisease} ${patientHospital} ${applicantName} ${applicantRelation}`,
            accounts: [],
          }),
        });
        await refreshBackendData();
      }
      setApplicantIdMasked(maskedId);
      setApplicantPhone(maskedPhone);
      setRegistrationSaved(true);
      setBound({ alipay: false, douyin: false, bilibili: false });
      setProjectLinked(false);
      setRegistryVerified(false);
      setPublished(false);
      setRegistrationFeedback("");
      setSystemNotice(systemOnline ? `案例 TA-${caseId} 已脱敏保存到本地数据库，可继续绑定账号。` : `案例 TA-${caseId} 已保存到当前展示会话。`);
      setRegistryStep(1);
    } catch (error) {
      const message = error instanceof Error ? error.message : "未知错误";
      setRegistrationFeedback(`保存失败：${message}。请检查文件大小或重新选择材料后再试。`);
      setSystemNotice(`注册资料保存失败：${message}`);
    } finally {
      setRegistrationSaving(false);
    }
  }

  function confirmBinding() {
    if (!authProvider) return;
    setBound((value) => ({ ...value, [authProvider]: true }));
    setProjectLinked(false);
    setRegistryVerified(false);
    setPublished(false);
    setAuthProvider(null);
  }

  function bindAll() {
    setBound({ alipay: true, douyin: true, bilibili: true });
    setProjectLinked(false);
    setRegistryVerified(false);
    setPublished(false);
    setSystemNotice("演示授权已完成：支付宝 + 抖音 + 哔哩哔哩。你也可以逐个解绑测试。 ");
  }

  function unbindProvider(provider: Provider) {
    setBound((value) => ({ ...value, [provider]: false }));
    setProjectLinked(false);
    setRegistryVerified(false);
    setPublished(false);
    setSystemNotice(`${providers.find((item) => item.id === provider)?.name || "账号"}已解绑；账号关系变化后，项目关联、可信源和公开状态需要重新确认。`);
  }

  function requestUnbindProvider(provider: Provider) {
    const providerName = providers.find((item) => item.id === provider)?.name || "该账号";
    requestConfirmation({
      title: `确认解绑${providerName}？`,
      message: "解绑会使当前项目关联、可信视频源与公开状态失效，需要重新确认账号关系并再次完成后续步骤。已保存的身份与病例资料不会删除。",
      confirmLabel: "确认解绑",
      tone: "danger",
      onConfirm: () => unbindProvider(provider),
    });
  }

  function confirmAccountsAndContinue() {
    if (!bound.alipay) {
      setSystemNotice("还不能继续：必须先绑定支付宝，用于确认实名主体和公开募捐项目归属。 ");
      return;
    }
    if (!bound.douyin && !bound.bilibili) {
      setSystemNotice("还不能继续：请至少再绑定抖音或哔哩哔哩中的一个内容发布账号。 ");
      return;
    }
    setSystemNotice("账号关系已确认，可以继续关联公开募捐项目。 ");
    setRegistryStep(2);
  }

  function accountDisplayName(provider: Provider) {
    if (provider === "alipay") return applicantName || providers[0].account;
    const subject = patientName || applicantName;
    if (!subject) return providers.find((item) => item.id === provider)?.account || "求助账号";
    return provider === "douyin" ? `${subject}求助账号` : `${subject}康复记录`;
  }

  function linkedAccounts() {
    return [
      ...(bound.alipay ? [{ platform: "支付宝", accountKey: "ALI-DEMO-001", displayName: accountDisplayName("alipay"), trustBadge: true }] : []),
      ...(bound.douyin ? [{ platform: "抖音", accountKey: "DY-DEMO-002", displayName: accountDisplayName("douyin"), trustBadge: true }] : []),
      ...(bound.bilibili ? [{ platform: "哔哩哔哩", accountKey: "BILI-DEMO-001", displayName: accountDisplayName("bilibili"), trustBadge: true }] : []),
    ];
  }

  async function linkProjectAndContinue() {
    if (!registrationSaved || !currentCaseId) {
      setSystemNotice("请先完成身份与病例资料保存，再关联公开募捐项目。");
      setRegistryStep(0);
      return;
    }
    if (!accountRequirementMet) {
      setSystemNotice("账号绑定关系已变化，请先返回上一步确认支付宝和至少一个内容平台。 ");
      setRegistryStep(1);
      return;
    }
    const errors = validateProjectFields();
    setProjectErrors(errors);
    if (Object.keys(errors).length) {
      setSystemNotice(`项目暂时不能关联：还有 ${Object.keys(errors).length} 项需要修改，已在输入框下方标出。`);
      return;
    }
    const normalizedProjectId = projectId.trim().toUpperCase();
    setProjectId(normalizedProjectId);
    const contact = contactDetailsForCase(currentCaseId);
    setProjectLinking(true);
    try {
      if (systemOnline) {
        await apiRequest("/api/cases", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: currentCaseId, name: patientName, avatar: patientName.slice(-1), age: `${patientAge.replace("岁", "")}岁`, city: patientCity,
            disease: patientDisease, hospital: patientHospital, applicant: `${applicantName}（${applicantRelation}）`,
            applicantName, applicantRelation, applicantIdMasked, applicantPhone, identityStatus: "模拟核身通过",
            projectName: projectName.trim(), projectId: normalizedProjectId, projectPlatform: projectPlatform.trim(), published: false,
            virtualPhone: contact.virtualPhone, email: contact.email,
            confidence: 93, status: "项目已关联·待上传可信原片",
            textCorpus: `${patientName} ${patientDisease} ${patientHospital} ${applicantName} ${applicantRelation} ${projectName}`,
            accounts: linkedAccounts(),
          }),
        });
        await refreshBackendData();
      }
      setProjectLinked(true);
      setRegistryStep(3);
      setSystemNotice(systemOnline ? `项目 ${normalizedProjectId} 的关联关系已保存到本地数据库。` : "项目关联关系已保存到当前展示会话。");
    } catch (error) {
      setSystemNotice(error instanceof Error ? `项目关联保存失败：${error.message}` : "项目关联保存失败");
    } finally {
      setProjectLinking(false);
    }
  }

  async function startRegistryAnalysis() {
    if (registryAnalyzing) return;
    if (systemOnline) {
      if (!currentCaseId || !projectLinked) {
        setSystemNotice("请先保存申请资料并完成公开募捐项目关联。");
        return;
      }
      if (!originalVideoFile) {
        setSystemNotice("本地可用系统已连接：请先选择一个真实 MP4/WebM 短视频，系统会实际提取关键帧指纹。");
        return;
      }
      setRegistryVerified(false);
      setRegistryAnalyzing(true);
      setRegistryProgress(4);
      setSystemNotice("正在从真实视频生成可信源……");
      try {
        const contact = contactDetailsForCase(currentCaseId);
        const fingerprint = await fingerprintVideo(originalVideoFile, (progress, message) => {
          setRegistryProgress(progress);
          setSystemNotice(message);
        });
        const uploads = [
          caseUpload ? uploadLocalFile(caseUpload, "病例材料") : Promise.resolve(null),
          relationEvidence.required && relationUpload ? uploadLocalFile(relationUpload, "关系证明") : Promise.resolve(null),
          uploadLocalFile(originalVideoFile, "可信原片"),
        ];
        await Promise.all(uploads);
        await apiRequest("/api/cases", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: currentCaseId, name: patientName || "林安宁", avatar: (patientName || "宁").slice(-1), age: `${(patientAge || "8").replace("岁", "")}岁`, city: patientCity || "杭州",
            disease: patientDisease || "急性淋巴细胞白血病", hospital: patientHospital || "浙江省儿童医院", applicant: `${applicantName || "方静"}（${applicantRelation || "母亲"}）`,
            applicantName: applicantName || "方静", applicantRelation: applicantRelation || "母亲",
            applicantIdMasked: applicantIdMasked || maskIdentityNumber(applicantIdNumber), applicantPhone: maskRegistrationPhone(applicantPhone || "18800001001"), identityStatus: identityVerified ? "模拟核身通过" : "待核身",
            projectName: projectName || "待关联", projectId: projectId || "待关联", projectPlatform, published: false,
            virtualPhone: contact.virtualPhone, email: contact.email, confidence: 96.8,
            status: "可信源已生成·待公开授权", fingerprint, sourceVideoName: originalVideoFile.name,
            textCorpus: `${patientName || "林安宁"} ${patientDisease || "急性淋巴细胞白血病"} ${patientHospital || "浙江省儿童医院"} ${applicantName || "方静"} ${applicantRelation || "母亲"} ${projectName || ""}`,
            accounts: linkedAccounts(),
          }),
        });
        setRegistryProgress(100);
        setRegistryVerified(true);
        setPublished(false);
        setSystemNotice(`真实视频指纹已入库：${fingerprint.frameHashes.length} 个关键帧。案例 TA-${currentCaseId} 需确认公开授权后才会进入目录与公众比对。`);
        await refreshBackendData();
      } catch (error) {
        setSystemNotice(error instanceof Error ? `建档失败：${error.message}` : "建档失败");
      } finally {
        setRegistryAnalyzing(false);
      }
      return;
    }
    if (!originalVideo) setOriginalVideo("虚拟案例_安宁与妈妈_原始求助视频.mp4");
    setRegistryVerified(false);
    setRegistryAnalyzing(true);
    setRegistryProgress(6);
    let value = 6;
    const timer = window.setInterval(() => {
      value += value < 55 ? 9 : 6;
      const next = Math.min(value, 100);
      setRegistryProgress(next);
      if (next === 100) {
        window.clearInterval(timer);
        window.setTimeout(() => {
          setRegistryAnalyzing(false);
          setRegistryVerified(true);
        }, 300);
      }
    }, 150);
  }

  async function updateCurrentCasePublication(nextPublished: boolean) {
    if (!currentCaseId || !registryVerified) {
      setSystemNotice("请先生成可信视频源，再确认公开授权。");
      return;
    }
    try {
      if (systemOnline) {
        await apiRequest(`/api/cases/${encodeURIComponent(currentCaseId)}/publication`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ published: nextPublished }),
        });
        await refreshBackendData();
      }
      setPublished(nextPublished);
      setSelectedPerson(currentCaseId);
      setSystemNotice(nextPublished
        ? `案例 TA-${currentCaseId} 已确认授权公开，可在可信案例目录查询。`
        : `案例 TA-${currentCaseId} 已撤回公开授权，目录和公众视频比对将不再使用该案例。`);
    } catch (error) {
      setSystemNotice(error instanceof Error ? `发布失败：${error.message}` : "发布失败");
    }
  }

  function requestPublicationChange(nextPublished: boolean) {
    if (nextPublished) {
      void updateCurrentCasePublication(true);
      return;
    }
    requestConfirmation({
      title: "确认撤回公开授权？",
      message: "撤回后，该案例会立即从公开目录移除，并停止参与公众视频比对。已保存的资料和可信原片不会删除，之后仍可重新授权公开。",
      confirmLabel: "确认撤回",
      tone: "danger",
      onConfirm: () => updateCurrentCasePublication(false),
    });
  }

  async function startPublicAnalysis() {
    if (verifyAnalyzing) return;
    if (verificationInput === "preset") {
      setLiveAnalysis(null);
      setVerifyComplete(false);
      setReported(false);
      setReviewDecision("pending");
      setCurrentReportId(null);
      setReviewerNote("");
      setVerifyAnalyzing(true);
      setVerifyProgress(8);
      setSystemNotice("正在运行内置算法样本：复用预计算视频指纹，并实时融合账号、授权和项目入口信号……");
      let value = 8;
      const timer = window.setInterval(() => {
        value += value < 56 ? 12 : 8;
        const next = Math.min(value, 100);
        setVerifyProgress(next);
        if (next === 100) {
          window.clearInterval(timer);
          window.setTimeout(() => {
            setVerifyAnalyzing(false);
            setVerifyComplete(true);
            setSystemNotice(`内置${verifySample === "risk" ? "疑似换码" : "授权转发"}样本评分完成；结果为预计算演示证据，不写入本地数据库。`);
          }, 260);
        }
      }, 120);
      return;
    }
    if (systemOnline) {
      if (!publicVideoFile) {
        setSystemNotice("请上传一个真实视频。最简单的演示方式：板块一上传一段短视频建档，再在这里上传同一段视频并修改账号或项目编号。");
        return;
      }
      setVerifyComplete(false);
      setReported(false);
      setReviewDecision("pending");
      setCurrentReportId(null);
      setReviewerNote("");
      setVerifyAnalyzing(true);
      setVerifyProgress(4);
      setSystemNotice("正在对上传视频进行真实关键帧分析……");
      try {
        const fingerprint = await fingerprintVideo(publicVideoFile, (progress, message) => {
          setVerifyProgress(Math.min(82, Math.round(progress * 0.82)));
          setSystemNotice(message);
        });
        await uploadLocalFile(publicVideoFile, "公众核验视频");
        setVerifyProgress(88);
        const result = await apiRequest<VerificationResult>("/api/analyze", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            videoName: publicVideoFile.name,
            platform: foundPlatform,
            publisherAccount,
            paymentProjectId,
            textSummary,
            fingerprint,
          }),
        });
        setLiveAnalysis(result);
        setVerifySample(result.riskScore >= 30 ? "risk" : "authorized");
        setVerifyProgress(100);
        setVerifyComplete(true);
        setSystemNotice(`分析 ${result.analysisId} 已保存：原片匹配 ${result.matchScore}%，请根据页面提示决定是否提交平台复核。`);
        await refreshBackendData();
      } catch (error) {
        setSystemNotice(error instanceof Error ? `分析失败：${error.message}` : "分析失败");
      } finally {
        setVerifyAnalyzing(false);
      }
      return;
    }
    setVerifyComplete(false);
    setReported(false);
    setVerifyAnalyzing(true);
    setVerifyProgress(5);
    let value = 5;
    const timer = window.setInterval(() => {
      value += value < 52 ? 8 : 5;
      const next = Math.min(value, 100);
      setVerifyProgress(next);
      if (next === 100) {
        window.clearInterval(timer);
        window.setTimeout(() => {
          setVerifyAnalyzing(false);
          setVerifyComplete(true);
        }, 320);
      }
    }, 150);
  }

  async function submitReport() {
    if (!systemOnline || !activeVerification.analysisId) {
      setReported(true);
      return;
    }
    try {
      const report = await apiRequest<{ id: string; duplicate?: boolean }>("/api/reports", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ analysisId: activeVerification.analysisId }),
      });
      setCurrentReportId(report.id);
      setReported(true);
      setSystemNotice(report.duplicate ? `该分析已存在审核任务 ${report.id}，系统没有重复入队。` : `举报 ${report.id} 已写入本地审核队列。`);
      await refreshBackendData();
    } catch (error) {
      setSystemNotice(error instanceof Error ? error.message : "举报提交失败");
    }
  }

  async function handleReviewDecision(decision: ReviewDecision) {
    const targetId = currentReportId;
    if (systemOnline && !targetId) {
      setSystemNotice("请先从审核队列选择一个任务，再保存平台决定；系统不会默认修改最新任务。");
      return;
    }
    setReviewDecision(decision);
    if (!systemOnline || !targetId || decision === "pending") return;
    try {
      await apiRequest(`/api/reviews/${encodeURIComponent(targetId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision, reviewerNote: reviewerNote.trim() || "平台审核员未补充备注" }),
      });
      setSystemNotice(`审核任务 ${targetId} 已更新，数据库已保存本次平台决定。`);
      await refreshBackendData();
    } catch (error) {
      setSystemNotice(error instanceof Error ? error.message : "审核状态更新失败");
    }
  }

  function requestReviewDecision(decision: "human" | "limit") {
    const isHumanReview = decision === "human";
    requestConfirmation({
      title: isHumanReview ? "确认转入人工深度复核？" : "确认生成限制导流建议？",
      message: isHumanReview
        ? "该操作会写入审核队列和审计记录，但不会自动下架或限制视频。"
        : "系统只会保存一条给内容平台的审核建议，不会自动执行下架、封禁或限制收款。",
      confirmLabel: isHumanReview ? "确认转人工复核" : "确认生成建议",
      tone: isHumanReview ? "primary" : "danger",
      onConfirm: () => handleReviewDecision(decision),
    });
  }

  function openReviewTask(task: ReviewTask) {
    setCurrentReportId(task.id);
    if (task.result) {
      setLiveAnalysis(task.result);
      setVerificationInput("file");
      setVerifySample(task.result.riskScore >= 30 ? "risk" : "authorized");
      setVerifyComplete(true);
    }
    const savedDecision: ReviewDecision = ["human", "limit", "pass"].includes(task.decision)
      ? task.decision as ReviewDecision
      : "pending";
    setReviewDecision(savedDecision);
    setReviewerNote(task.reviewerNote || "");
    setSystemNotice(`已载入审核任务 ${task.id} 的持久化证据与处置状态。`);
  }

  function resetDemo() {
    setActiveModule("registry");
    setRegistryStep(0);
    setCurrentCaseId("");
    setApplicantName("");
    setApplicantRelation("");
    setApplicantIdNumber("");
    setApplicantIdMasked("");
    setApplicantPhone("");
    setPatientName("");
    setPatientAge("");
    setPatientCity("");
    setPatientDisease("");
    setPatientHospital("");
    setIdentityVerified(false);
    setRegistrationSaved(false);
    setRegistrationFeedback("");
    setRegistrationErrors({});
    setCaseFile("");
    setCaseUpload(null);
    setRelationFile("");
    setRelationUpload(null);
    setOriginalVideo("");
    setOriginalVideoFile(null);
    setBound({ alipay: false, douyin: false, bilibili: false });
    setRegistryProgress(0);
    setRegistryVerified(false);
    setProjectLinked(false);
    setProjectLinking(false);
    setProjectPlatform("支付宝公益");
    setProjectName("");
    setProjectId("");
    setProjectErrors({});
    setPublished(false);
    setVerifyView("public");
    setVerifySample("risk");
    setPublicVideo("疑似换码求助视频.mp4");
    setPublicVideoFile(null);
    setVerificationInput("preset");
    setVerifyProgress(0);
    setVerifyComplete(false);
    setReported(false);
    setReviewDecision("pending");
    setBadgeIssued(false);
    setLiveAnalysis(null);
    setPublisherAccount("陌生转发账号_778");
    setPaymentProjectId("PERSONAL-DEMO-778");
    setTextSummary("林安宁在浙江省儿童医院治疗急性淋巴细胞白血病，演示项目需要医疗帮助");
    setCurrentReportId(null);
    setReviewerNote("");
    setSystemNotice("");
    setRevealed({});
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-symbol brand-image" aria-hidden="true"><img src="trustaid-logo.jpg" alt="" /></span>
        </div>
        <div className="topbar-actions">
          <span className={"demo-badge " + (systemOnline ? "online" : "offline")}><i /> {systemOnline ? "本地系统已连接" : "正在连接本地服务"}</span>
          <button className="ghost-button" onClick={() => setProjectInfoOpen(true)}>项目说明</button>
        </div>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <h1>让求助可信，让转发可查，让善意直达。</h1>
          <p>为求助者建立可信源，为公众和平台提供可复核的传播线索。</p>
        </div>
      </section>

      <nav className="module-tabs" aria-label="平台三大功能板块">
        {modules.map((module) => (
          <button
            key={module.id}
            className={"module-tab " + (activeModule === module.id ? "active" : "")}
            onClick={() => { setActiveModule(module.id); setSystemNotice(""); }}
            aria-current={activeModule === module.id ? "page" : undefined}
          >
            <span className="module-index">{module.index}</span>
            <span className="module-copy">
              <strong>{module.title}</strong>
            </span>
          </button>
        ))}
      </nav>

      <div className="content-wrap">
        {systemNotice && <div className="system-notice" role="status"><span>提示</span><p>{systemNotice}</p><button onClick={() => setSystemNotice("")} aria-label="关闭提示">×</button></div>}
        {activeModule === "registry" && (
          <section className="module-page registry-page">
            <div className="page-heading">
              <div>
                <h2>建立可信源</h2>
                <p>免费完成身份、病例、账号、项目和原始视频建档，形成后续核验基准。</p>
              </div>
              <div className="completion-card">
                <div><span>建档完成度</span><strong>{registryCompletion}%</strong></div>
                <div className="progress-track"><i style={{ width: registryCompletion + "%" }} /></div>
                <small>{registryMaterials}/{registryMaterialTarget} 项核心材料 · {boundCount}/3 个账号</small>
              </div>
            </div>

            {systemOnline && (
              <div className="case-workspace">
                <div className="case-workspace-head">
                  <div><strong>已保存的申请</strong><small>点击案例可继续上次进度</small></div>
                  <button onClick={startNewApplication}>＋ 新建申请</button>
                </div>
                <div className="case-workspace-list">
                  {savedRegistryCases.length ? savedRegistryCases.slice(0, 6).map((person) => {
                    const phase = person.published ? "已公开" : person.hasTrustedVideo ? "待公开授权" : person.project && person.project !== "待关联" ? "待生成可信源" : "建档中";
                    return (
                      <button key={person.id} className={currentCaseId === person.id ? "active" : ""} onClick={() => resumeSavedRegistration(person)}>
                        <span className="case-workspace-avatar">{person.avatar || person.name.slice(-1)}</span>
                        <span><strong>{person.name}</strong><small>TA-{person.id}</small></span>
                        <em className={person.published ? "published" : "draft"}>{phase}</em>
                      </button>
                    );
                  }) : <div className="case-workspace-empty">还没有保存的申请</div>}
                </div>
              </div>
            )}

            <div className="registry-layout">
              <aside className="registry-steps">
                <span className="section-caption">建档流程</span>
                {registrySteps.map((item, index) => (
                  <button
                    key={item.title}
                    className={
                      "registry-step " +
                      (registryStep === index ? "active " : "") +
                      (completedRegistrySteps[index] ? "done" : "")
                    }
                    disabled={!unlockedRegistrySteps[index]}
                    onClick={() => {
                      if (!unlockedRegistrySteps[index]) return;
                      setRegistryStep(index);
                    }}
                    title={!unlockedRegistrySteps[index] ? "请先完成上一步" : undefined}
                  >
                    <span>{completedRegistrySteps[index] ? "✓" : index + 1}</span>
                    <div><strong>{item.title}</strong><small>{item.short}</small></div>
                  </button>
                ))}
                <div className="registry-rule">
                  <b>可信建档原则</b>
                  <p>注册与核验永久免费；只处理必要信息；病例原件不公开；平台不收取善款、不参与抽成。</p>
                </div>
              </aside>

              <div className="registry-stage">
                {registryStep === 0 && (
                  <div className="stage-card">
                    <div className="stage-title">
                      <div><span className="section-caption">STEP 01</span><h3>身份信息与病例材料</h3></div>
                      <span className={"status-chip " + (registrationSaved ? "success" : identityVerified ? "neutral" : "pending")}>
                        {registrationSaved ? "身份资料已保存" : identityVerified ? "待保存" : "等待身份验证"}
                      </span>
                    </div>

                    <div className="identity-registration-panel">
                      <div className="registration-header">
                        <span className="portrait large">{applicantName.trim().slice(-1) || "申"}</span>
                        <div><strong>申请人注册资料</strong><span>以下内容可编辑，身份验证通过后仅保存脱敏身份证信息{currentCaseId ? ` · 案例 TA-${currentCaseId}` : ""}</span></div>
                        <span className={"status-chip " + (identityVerified ? "success" : "pending")}>{identityVerified ? "✓ 身份验证通过" : "待身份验证"}</span>
                      </div>
                      <div className="registration-grid applicant-grid">
                        <label className={registrationErrors.applicantName ? "field-invalid" : ""}><span>申请人姓名</span><input value={applicantName} disabled={identityVerified} aria-invalid={Boolean(registrationErrors.applicantName)} onBlur={() => setApplicantName(applicantName.trim())} onChange={(event) => { setApplicantName(event.target.value); clearRegistrationError("applicantName"); markRegistrationDirty(); }} placeholder="请输入真实姓名" />{registrationErrors.applicantName && <small className="field-error">{registrationErrors.applicantName}</small>}</label>
                        <label className={registrationErrors.applicantRelation ? "field-invalid" : ""}><span>与患者关系</span><select value={applicantRelation} disabled={identityVerified} aria-invalid={Boolean(registrationErrors.applicantRelation)} onChange={(event) => handleRelationChange(event.target.value)}><option value="">请选择</option><option>本人</option><option>母亲</option><option>父亲</option><option>配偶</option><option>子女</option><option>其他监护人</option></select>{registrationErrors.applicantRelation && <small className="field-error">{registrationErrors.applicantRelation}</small>}</label>
                        <label className={registrationErrors.applicantIdNumber ? "field-invalid" : ""}><span>身份证号</span><input inputMode="text" maxLength={32} value={identityVerified ? applicantIdMasked : applicantIdNumber} disabled={identityVerified} aria-invalid={Boolean(registrationErrors.applicantIdNumber)} onBlur={() => setApplicantIdNumber(normalizeIdentityInput(applicantIdNumber))} onChange={(event) => { setApplicantIdNumber(event.target.value); clearRegistrationError("applicantIdNumber"); markRegistrationDirty(); }} placeholder="18位，末位可为 X；可粘贴带空格号码" />{registrationErrors.applicantIdNumber && <small className="field-error">{registrationErrors.applicantIdNumber}</small>}</label>
                        <label className={registrationErrors.applicantPhone ? "field-invalid" : ""}><span>手机号</span><input type="tel" inputMode="tel" maxLength={24} value={applicantPhone} disabled={identityVerified} aria-invalid={Boolean(registrationErrors.applicantPhone)} onBlur={() => setApplicantPhone(normalizePhoneInput(applicantPhone))} onChange={(event) => { setApplicantPhone(event.target.value); clearRegistrationError("applicantPhone"); markRegistrationDirty(); }} placeholder="11位大陆手机号，例如 13800138000" />{registrationErrors.applicantPhone && <small className="field-error">{registrationErrors.applicantPhone}</small>}</label>
                      </div>
                      <div className="identity-verification-row">
                        <div><b>本人身份验证</b><span>{identityVerified ? `证件信息已脱敏：${applicantIdMasked}` : "Demo 使用模拟结果；正式接入支付宝身份验证"}</span>{registrationErrors.identity && <small className="field-error">{registrationErrors.identity}</small>}</div>
                        {identityVerified ? (
                          <button onClick={() => { setIdentityVerified(false); markRegistrationDirty(); if (!applicantIdNumber) setApplicantIdMasked(""); setSystemNotice("核心身份字段已解锁，修改后需要重新验证身份。"); }}>重新填写身份</button>
                        ) : <button className="verify-identity-button" onClick={simulateIdentityVerification}>模拟身份验证</button>}
                      </div>
                    </div>

                    <div className="patient-registration">
                      <span className="section-caption">受助者基础资料</span>
                      <div className="registration-grid patient-grid">
                        <label className={registrationErrors.patientName ? "field-invalid" : ""}><span>患者姓名</span><input value={patientName} aria-invalid={Boolean(registrationErrors.patientName)} onBlur={() => setPatientName(patientName.trim())} onChange={(event) => { setPatientName(event.target.value); clearRegistrationError("patientName"); markRegistrationDirty(); }} placeholder="受助者姓名" />{registrationErrors.patientName && <small className="field-error">{registrationErrors.patientName}</small>}</label>
                        <label className={registrationErrors.patientAge ? "field-invalid" : ""}><span>年龄</span><input type="text" inputMode="numeric" maxLength={3} value={patientAge} aria-invalid={Boolean(registrationErrors.patientAge)} onChange={(event) => { setPatientAge(normalizeFullWidthDigits(event.target.value)); clearRegistrationError("patientAge"); markRegistrationDirty(); }} placeholder="0—120 的整数" />{registrationErrors.patientAge && <small className="field-error">{registrationErrors.patientAge}</small>}</label>
                        <label className={registrationErrors.patientCity ? "field-invalid" : ""}><span>所在地区</span><select value={patientCity} aria-invalid={Boolean(registrationErrors.patientCity)} onChange={(event) => { setPatientCity(event.target.value); setPatientHospital(""); clearRegistrationError("patientCity"); clearRegistrationError("patientHospital"); markRegistrationDirty(); }}><option value="">请选择地区</option>{patientCities.map((cityName) => <option key={cityName}>{cityName}</option>)}</select>{registrationErrors.patientCity && <small className="field-error">{registrationErrors.patientCity}</small>}</label>
                        <label className={registrationErrors.patientDisease ? "field-invalid" : ""}><span>主要诊断</span><input value={patientDisease} aria-invalid={Boolean(registrationErrors.patientDisease)} onChange={(event) => { setPatientDisease(event.target.value); clearRegistrationError("patientDisease"); markRegistrationDirty(); }} placeholder="主要疾病或诊断" />{registrationErrors.patientDisease && <small className="field-error">{registrationErrors.patientDisease}</small>}</label>
                        <label className={"hospital-field " + (registrationErrors.patientHospital ? "field-invalid" : "")}><span>就诊医院</span><select value={patientHospital} disabled={!patientCity} aria-invalid={Boolean(registrationErrors.patientHospital)} onChange={(event) => { setPatientHospital(event.target.value); clearRegistrationError("patientHospital"); markRegistrationDirty(); }}><option value="">{patientCity ? "请选择就诊医院" : "请先选择所在地区"}</option>{availableHospitals.map((hospitalName) => <option key={hospitalName}>{hospitalName}</option>)}</select>{registrationErrors.patientHospital && <small className="field-error">{registrationErrors.patientHospital}</small>}</label>
                      </div>
                    </div>

                    <div className="upload-grid">
                      <label className={"upload-box " + (caseFile ? "uploaded " : "") + (registrationErrors.caseFile ? "field-invalid" : "")}>
                        <input
                          type="file"
                          accept=".pdf,.jpg,.jpeg,.png"
                          onChange={(event) => handleFile(event, setCaseFile, setCaseUpload, "caseFile")}
                        />
                        <span className="upload-icon">病</span>
                        <div>
                          <strong>{caseFile || "上传病例材料"}</strong>
                          <small>{caseFile ? "已读取病案摘要 · 原件仅用于核验" : "病案首页、诊断证明或检查报告"}</small>
                        </div>
                        <b>{caseFile ? "已上传" : "选择文件"}</b>
                        {registrationErrors.caseFile && <small className="field-error upload-error">{registrationErrors.caseFile}</small>}
                      </label>
                      {relationEvidence.required ? (
                        <label className={"upload-box " + (relationFile ? "uploaded " : "") + (registrationErrors.relationFile ? "field-invalid" : "")}>
                          <input
                            type="file"
                            accept=".pdf,.jpg,.jpeg,.png"
                            onChange={(event) => handleFile(event, setRelationFile, setRelationUpload, "relationFile")}
                          />
                          <span className="upload-icon relation">证</span>
                          <div>
                            <strong>{relationFile || relationEvidence.title}</strong>
                            <small>{relationFile ? "材料已读取，将与所选关系一起核对" : relationEvidence.description}</small>
                          </div>
                          <b>{relationFile ? "已上传" : "选择文件"}</b>
                          {registrationErrors.relationFile && <small className="field-error upload-error">{registrationErrors.relationFile}</small>}
                        </label>
                      ) : (
                        <div className="upload-box uploaded relation-self" role="status">
                          <span className="upload-icon relation">✓</span>
                          <div><strong>{relationEvidence.title}</strong><small>{relationEvidence.description}</small></div>
                          <b>自动核对</b>
                        </div>
                      )}
                    </div>

                    <div className="extraction-panel">
                      <span className="section-caption">结构化资料预览</span>
                      <div className="extraction-grid">
                        <div><span>受助者</span><strong>{caseFile && patientName ? `${patientName} · ${patientAge || "年龄待补"}${patientAge ? "岁" : ""}` : "待识别"}</strong></div>
                        <div><span>诊断</span><strong>{caseFile && patientDisease ? patientDisease : "待识别"}</strong></div>
                        <div><span>医院</span><strong>{caseFile && patientHospital ? patientHospital : "待识别"}</strong></div>
                        <div><span>申请人关系</span><strong>{applicantRelation === "本人" ? (applicantName && patientName && applicantName.trim() === patientName.trim() ? `${applicantName} · 本人（姓名一致）` : "本人 · 待核对姓名") : relationFile && applicantName ? `${applicantName} · ${applicantRelation || "关系待补"}` : "待核验"}</strong></div>
                      </div>
                    </div>

                    <div className="stage-actions split">
                      <div className="stage-secondary-actions">
                        {systemOnline && savedRegistryCase && <button className="text-button" onClick={() => resumeSavedRegistration()}>继续最近保存的建档</button>}
                        <button className="text-button" onClick={loadRegistryDemo}>载入完整演示资料</button>
                      </div>
                      <button
                        className="primary-button"
                        disabled={registrationSaving}
                        onClick={saveRegistrationAndContinue}
                      >
                        {registrationActionLabel} <span>→</span>
                      </button>
                    </div>
                    {Object.keys(registrationErrors).length > 0 && (
                      <div className="form-error-summary" role="alert">
                        <strong>还有 {Object.keys(registrationErrors).length} 项需要修改</strong>
                        <span>请查看上方红色提示；修正后无需刷新，直接再次提交即可。</span>
                      </div>
                    )}
                    {registrationFeedback && <p className={"registration-feedback " + (/失败|无法保存/.test(registrationFeedback) ? "error" : "pending")} role="status">{registrationFeedback}</p>}
                  </div>
                )}

                {registryStep === 1 && (
                  <div className="stage-card">
                    <div className="stage-title">
                      <div><span className="section-caption">STEP 02</span><h3>绑定外部账号控制权</h3></div>
                      <span className={"status-chip " + (accountRequirementMet ? "success" : "pending")}>{accountRequirementMet ? "绑定条件已满足" : `${boundCount}/3 已绑定`}</span>
                    </div>
                    <p className="stage-description">由各平台授权页返回账号唯一标识，不读取密码、私信或通讯录。至少绑定支付宝和一个内容平台。</p>

                    <div className="account-grid">
                      {providers.map((provider) => (
                        <article className={"account-card " + (bound[provider.id] ? "bound" : "")} key={provider.id}>
                          <div className="account-head">
                            <span className="provider-mark" style={{ background: provider.color }}>{provider.mark}</span>
                            <span className={"account-state " + (bound[provider.id] ? "ok" : "")}>
                              {bound[provider.id] ? "已绑定" : "待授权"}
                            </span>
                          </div>
                          <h4>{provider.name}</h4>
                          {bound[provider.id] ? (
                            <div className="bound-detail">
                              <strong>{accountDisplayName(provider.id)}</strong>
                              <span>{provider.accountId}</span>
                              <button className="unbind-account-button" onClick={() => requestUnbindProvider(provider.id)}>解绑并重选</button>
                            </div>
                          ) : (
                            <button onClick={() => setAuthProvider(provider.id)}>模拟扫码授权</button>
                          )}
                        </article>
                      ))}
                    </div>

                    <div className="permission-note">
                      <span>授权范围</span>
                      <strong>账号唯一标识 · 昵称头像 · 授权状态</strong>
                      <small>平台仅记录账号归属关系，用于识别后续发布者是否获得授权。</small>
                    </div>

                    <div className={"account-requirement " + (accountRequirementMet ? "ok" : "pending")} role="status">
                      <strong>{accountRequirementMet ? "✓ 绑定条件已满足" : "继续条件：支付宝 + 至少一个内容平台"}</strong>
                      <span>{!bound.alipay ? "还缺支付宝" : !bound.douyin && !bound.bilibili ? "还缺抖音或哔哩哔哩" : "可以进入项目关联"}</span>
                    </div>

                    <div className="stage-actions split">
                      <button className="text-button" onClick={bindAll}>一键完成演示授权</button>
                      <button className="primary-button" onClick={confirmAccountsAndContinue}>
                        确认账号关系 <span>→</span>
                      </button>
                    </div>
                  </div>
                )}

                {registryStep === 2 && (
                  <div className="stage-card">
                    <div className="stage-title">
                      <div><span className="section-caption">STEP 03</span><h3>关联公开募捐项目</h3></div>
                      <span className={"status-chip " + (projectLinked ? "success" : "pending")}>{projectLinked ? "关联已保存" : "待模拟核对"}</span>
                    </div>

                    <article className="project-card">
                      <div className="project-top">
                        <div>
                          <span>公开募捐项目登记</span>
                          <h4>{projectName || "请填写需要关联的公开项目"}</h4>
                          <small>{projectId ? `项目编号 ${projectId}` : "项目编号待填写"}</small>
                        </div>
                        <div className="official-seal">{projectPlatform}</div>
                      </div>
                      <div className="registration-grid project-input-grid">
                        <label className={projectErrors.projectPlatform ? "field-invalid" : ""}>
                          <span>公开募捐平台</span>
                          <select value={projectPlatform} aria-invalid={Boolean(projectErrors.projectPlatform)} onChange={(event) => { setProjectPlatform(event.target.value); setProjectErrors((current) => ({ ...current, projectPlatform: "" })); markProjectDirty(); }}>
                            <option>支付宝公益</option>
                            <option>腾讯公益</option>
                            <option>字节跳动公益</option>
                            <option>水滴公益</option>
                            <option>其他公开募捐平台</option>
                          </select>
                          {projectErrors.projectPlatform && <small className="field-error">{projectErrors.projectPlatform}</small>}
                        </label>
                        <label className={projectErrors.projectName ? "field-invalid" : ""}>
                          <span>项目名称</span>
                          <input value={projectName} aria-invalid={Boolean(projectErrors.projectName)} onChange={(event) => { setProjectName(event.target.value); setProjectErrors((current) => ({ ...current, projectName: "" })); markProjectDirty(); }} placeholder="例如：帮助患者完成后续治疗" />
                          {projectErrors.projectName && <small className="field-error">{projectErrors.projectName}</small>}
                        </label>
                        <label className={projectErrors.projectId ? "field-invalid" : ""}>
                          <span>平台项目编号</span>
                          <input value={projectId} aria-invalid={Boolean(projectErrors.projectId)} onBlur={() => setProjectId(projectId.trim().toUpperCase())} onChange={(event) => { setProjectId(normalizeFullWidthDigits(event.target.value).toUpperCase()); setProjectErrors((current) => ({ ...current, projectId: "" })); markProjectDirty(); }} placeholder="例如：ALI-20260808-01" />
                          {projectErrors.projectId && <small className="field-error">{projectErrors.projectId}</small>}
                        </label>
                      </div>
                      <div className="fund-row project-boundaries">
                        <div><span>项目状态</span><strong>等待平台接口核对</strong></div>
                        <div><span>善款去向</span><strong>公开平台托管</strong></div>
                        <div><span>TrustAid 权限</span><strong>只核对，不经手</strong></div>
                      </div>
                    </article>

                    <div className="relation-chain" aria-label="关联关系">
                      <div><span>受助者</span><strong>{patientName || "待填写"}</strong><small>病例已核验</small></div>
                      <i>→</i>
                      <div><span>申请人</span><strong>{applicantName || "待填写"}</strong><small>{applicantRelation || "关系待填写"} · 已核验</small></div>
                      <i>→</i>
                      <div><span>募捐项目</span><strong>{projectId || "待关联"}</strong><small>{projectPlatform}托管</small></div>
                    </div>

                    <div className="core-rule">
                      <span>资金边界</span>
                      <p>善款始终由公开募捐平台托管，TrustAid 只核对项目入口是否一致，不接收、不划转、不抽成。</p>
                    </div>

                    <div className="stage-actions">
                      <button className="primary-button" disabled={projectLinking} onClick={linkProjectAndContinue}>
                        {projectLinking ? "正在保存项目关联…" : "模拟核对并锁定项目"} <span>→</span>
                      </button>
                    </div>
                  </div>
                )}

                {registryStep === 3 && (
                  <div className="stage-card video-register-stage">
                    <div className="stage-title">
                      <div><span className="section-caption">STEP 04</span><h3>上传原始求助视频并生成可信源</h3></div>
                      <span className={"status-chip " + (registryVerified ? "success" : "pending")}>
                        {registryVerified ? "可信源已生成" : "等待视频指纹"}
                      </span>
                    </div>
                    <p className="stage-description">可用系统会在浏览器中真实解码视频、抽取 6—18 个代表画面，并生成画面指纹、色彩与画面顺序特征；身份验证结果由前序模拟接口提供。</p>

                    <div className="video-register-grid">
                      <div>
                        <label className={"video-drop " + (originalVideo ? "has-file" : "")}>
                          <input
                            type="file"
                            accept="video/*"
                            onChange={(event) => handleFile(event, setOriginalVideo, setOriginalVideoFile)}
                          />
                          <span className="video-file-icon">▶</span>
                          <strong>{originalVideo || "上传本人原始求助视频"}</strong>
                          <small>{originalVideo ? (originalVideoFile ? `${(originalVideoFile.size / 1024 / 1024).toFixed(1)} MB · 已准备真实计算` : "预置展示样本") : "支持浏览器可播放的 MP4 / WebM，建议 30 秒以内"}</small>
                          <b>{originalVideo ? "更换视频" : "选择视频"}</b>
                        </label>
                        {!registryVerified && !registryAnalyzing && (
                          <button className="sample-button" onClick={() => systemOnline ? setSystemNotice("可用系统模式必须选择真实视频；展示模式下才使用预置文件名。") : setOriginalVideo("虚拟案例_安宁与妈妈_原始求助视频.mp4")}>
                            {systemOnline ? "为什么需要真实视频？" : "使用预置展示样本"}
                          </button>
                        )}
                      </div>

                      <div className={"confidence-panel " + (registryVerified ? "verified" : "")}>
                        {registryAnalyzing ? (
                          <>
                            <span className="section-caption">VIDEO FINGERPRINT PIPELINE</span>
                            <div className="analysis-number">{registryProgress}<small>%</small></div>
                            <strong>{systemOnline ? "正在真实提取视频指纹" : "正在运行预置核验流程"}</strong>
                            <div className="progress-track"><i style={{ width: registryProgress + "%" }} /></div>
                            <p>
                              {registryProgress < 35
                                ? "浏览器解码并抽取视频关键帧"
                                : registryProgress < 70
                                  ? "计算画面指纹、色彩与顺序特征"
                                  : "写入可信源数据库并建立授权关系"}
                            </p>
                          </>
                        ) : registryVerified ? (
                          <>
                            <span className="section-caption">可信源建档完成度</span>
                            <div className="confidence-score">100<small>%</small></div>
                            <strong>{systemOnline ? "真实视频指纹已入库" : "预置可信源已生成"}</strong>
                            <ul>
                              <li><span>关键帧视觉指纹</span><b>已生成</b></li>
                              <li><span>文件摘要与画面顺序</span><b>已生成</b></li>
                              <li><span>病例与项目关联</span><b>已保存</b></li>
                              <li><span>授权账号关系图</span><b>已保存</b></li>
                            </ul>
                          </>
                        ) : (
                          <>
                            <span className="section-caption">可信源建档状态</span>
                            <div className="confidence-empty">—</div>
                            <strong>上传后生成核验结果</strong>
                            <p>结果将成为后续路人视频比对的可信基准，而不是直接公开原始病例。</p>
                          </>
                        )}
                      </div>
                    </div>

                    {registryVerified ? (
                      <div className="publish-bar">
                        <div><strong>可信案例 TA-{currentCaseId || "待生成"} 与 Trust 徽章已生成</strong><span>只有确认授权后才进入公开目录与公众视频比对</span></div>
                        <button className={published ? "secondary-button" : "primary-button"} onClick={() => requestPublicationChange(!published)}>
                          {published ? "撤回公开授权" : "确认授权并公开发布"}
                        </button>
                      </div>
                    ) : (
                      <div className="stage-actions">
                        <button className="primary-button" disabled={!originalVideo || registryAnalyzing || (systemOnline && !originalVideoFile)} onClick={startRegistryAnalysis}>
                          {registryAnalyzing ? `指纹计算中 ${registryProgress}%` : "生成并入库可信视频源"} <span>⌁</span>
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </section>
        )}

        {activeModule === "verify" && (
          <section className="module-page verify-page">
            <div className="page-heading">
              <div>
                <h2>核验传播视频</h2>
                <p>系统提供可解释的核对线索，不作真假或违法认定。</p>
              </div>
              <div className="public-promise">
                <span>中立边界</span>
                <strong>机器给建议，平台作决定</strong>
                <small>不自动定性、不自动下架、不公开举报人</small>
              </div>
            </div>

            <div className="verify-view-tabs" role="tablist" aria-label="核验端切换">
              <button className={verifyView === "public" ? "active" : ""} onClick={() => setVerifyView("public")}>
                <b>公众核验入口</b><span>上传视频 · 查看线索 · 提交举报</span>
              </button>
              <button className={verifyView === "platform" ? "active" : ""} onClick={() => { setVerifyView("platform"); setVerifyComplete(true); }}>
                <b>平台算法审核台</b><span>证据链 · 权重融合 · 人工复核</span>
              </button>
            </div>

            {verifyView === "public" ? (
              <div className="verify-layout">
                <div className="stage-card public-upload-card">
                  <div className="stage-title">
                    <div><span className="section-caption">待分析传播内容</span><h3>上传视频或选择演示样本</h3></div>
                    <span className="status-chip neutral">公众提交</span>
                  </div>

                  <label className="public-video-drop">
                    <input
                      type="file"
                      accept="video/*"
                      onChange={(event) => {
                        handleFile(event, setPublicVideo, setPublicVideoFile);
                        if (event.target.files?.[0]) setVerificationInput("file");
                      }}
                    />
                    <div className="upload-visual"><span>＋</span><i /><i /><i /></div>
                    <strong>{publicVideo}</strong>
                    <small>{publicVideoFile ? `${(publicVideoFile.size / 1024 / 1024).toFixed(1)} MB · 将真实提取关键帧` : "内置可复核演示样本 · 可直接运行，也可点击上传真实视频"}</small>
                  </label>

                  <div className="sample-switcher">
                    <button className={verifySample === "risk" && verificationInput === "preset" ? "active" : ""} onClick={() => { setVerifySample("risk"); setVerificationInput("preset"); setPublicVideoFile(null); setPublicVideo("疑似换码求助视频.mp4"); setPublisherAccount("陌生转发账号_778"); setPaymentProjectId("PERSONAL-DEMO-778"); setTextSummary("林安宁在浙江省儿童医院治疗白血病，演示项目需要医疗帮助"); setLiveAnalysis(null); setVerifyComplete(false); setReviewDecision("pending"); }}>
                      <span className="risk-dot" /><strong>疑似换码样本</strong><small>原片高度相似，但收款入口被替换</small>
                    </button>
                    <button className={verifySample === "authorized" && verificationInput === "preset" ? "active" : ""} onClick={() => { setVerifySample("authorized"); setVerificationInput("preset"); setPublicVideoFile(null); setPublicVideo("家属授权转发视频.mp4"); setPublisherAccount("安宁求助记录"); setPaymentProjectId("ALI-DEMO-1001"); setTextSummary("林安宁在浙江省儿童医院治疗急性淋巴细胞白血病，项目为陪安宁完成后续治疗"); setLiveAnalysis(null); setVerifyComplete(false); setReviewDecision("pending"); }}>
                      <span className="safe-dot" /><strong>授权转发样本</strong><small>发布账号不同，但授权关系有效</small>
                    </button>
                  </div>

                  <div className="source-fields">
                    <label><span>发现平台</span><select value={foundPlatform} onChange={(event) => setFoundPlatform(event.target.value)}><option>抖音</option><option>哔哩哔哩</option><option>小红书</option><option>其他</option></select></label>
                    <label><span>发布账号</span><input value={publisherAccount} onChange={(event) => setPublisherAccount(event.target.value)} /></label>
                    <label><span>识别到的项目/收款编号</span><input value={paymentProjectId} onChange={(event) => setPaymentProjectId(event.target.value)} /></label>
                    <label><span>视频链接（选填）</span><input defaultValue="douyin.com/video/7382••••" /></label>
                  </div>
                  <label className="source-textarea"><span>视频文案/字幕摘要（参与语义冲突计算）</span><textarea value={textSummary} onChange={(event) => setTextSummary(event.target.value)} /></label>

                  <button className="primary-button wide" disabled={verifyAnalyzing || (verificationInput === "file" && !publicVideoFile)} onClick={startPublicAnalysis}>
                    {verifyAnalyzing
                      ? `${verificationInput === "preset" ? "内置算法样本运行中" : "真实视频计算中"} ${verifyProgress}%`
                      : verificationInput === "preset"
                        ? "运行内置样本核验"
                        : systemOnline
                          ? "提取视频特征并动态核验"
                          : "运行本地展示分析"} <span>⌁</span>
                  </button>
                  {verifyAnalyzing && <div className="progress-track large"><i style={{ width: verifyProgress + "%" }} /></div>}
                </div>

                <aside className={"analysis-result " + (verifyComplete ? "complete" : "")}>
                  {!verifyComplete ? (
                    <div className="result-placeholder">
                      <div className="radar"><i /><i /><i /><span>算</span></div>
                      <h3>等待视频分析</h3>
                      <p>系统将从可信源中比对画面指纹、文案摘要、发布账号、授权关系和收款入口。</p>
                      <ul>
                        <li><b>01</b><span>提取画面、色彩与顺序特征</span></li>
                        <li><b>02</b><span>召回可信原片与案例</span></li>
                        <li><b>03</b><span>融合账号、授权与收款风险</span></li>
                      </ul>
                    </div>
                  ) : (
                    <>
                      <div className={"result-head " + (activeEvidenceInsufficient ? "uncertain" : activeIsRisk ? "risk" : "safe")}>
                        <div className="risk-gauge public-cue"><strong>{publicReviewSymbol}</strong><span>核对提示</span></div>
                        <div><span>{publicReviewStatus} · {activeEvidenceInsufficient ? "不能据此处置" : activeVerification.riskScore >= 70 ? "建议提交平台复核" : activeIsRisk ? "建议联系求助者确认" : "可继续查看授权信息"}</span><h3>{activeVerification.title}</h3><p>{activeVerification.matchedCaseId ? `找到相似可信案例 TA-${activeVerification.matchedCaseId}` : "暂未找到可核对的可信案例"} · 原片相似度 {activeVerification.matchScore}%</p></div>
                      </div>
                      <div className="result-evidence">
                        <div className="positive"><span>可信原片召回</span><strong>{activeVerification.matchScore}%</strong><small>画面指纹、色彩与顺序变化联合匹配</small></div>
                        <div className={activeVerification.signals[0].score >= 30 ? "negative" : "positive"}><span>发布与授权</span><strong>{activeVerification.signals[0].score >= 30 ? "关系待核对" : "授权有效"}</strong><small>{activeVerification.signals[0].detail}</small></div>
                        <div className={activeVerification.signals[1].score >= 30 ? "negative" : "positive"}><span>收款入口</span><strong>{activeVerification.signals[1].score >= 30 ? "发生冲突" : "官方项目"}</strong><small>{activeVerification.signals[1].detail}</small></div>
                      </div>
                      <div className={"evidence-coverage-banner " + (activeEvidenceCoverage < 70 ? "insufficient" : "complete")}>
                        <div><span>信息完整度</span><strong>{activeEvidenceCoverage}%</strong></div>
                        <div className="coverage-track"><i style={{ width: activeEvidenceCoverage + "%" }} /></div>
                        <p>{activeRecommendation}</p>
                      </div>
                      {activeVerification.matchedCaseId ? (
                        <div className="matched-case">
                          <span className="mini-avatar">{matchedDirectoryCase?.avatar || matchedDirectoryCase?.name?.slice(-1) || "助"}</span>
                          <div><small>匹配到本地数据库可信案例</small><strong>{matchedDirectoryCase?.name || "已匹配受助者"} · 案例 TA-{activeVerification.matchedCaseId}</strong><span>案例状态与授权关系已实时读取</span></div>
                          <button onClick={() => { setActiveModule("directory"); setSelectedPerson(activeVerification.matchedCaseId || "DEMO-1001"); }}>查看案例</button>
                        </div>
                      ) : <div className="no-match-note">未召回可信原片：系统不会据此认定视频有问题，建议先补充可信源。</div>}
                      {activeIsRisk ? (
                        <button className={"report-button " + (reported ? "submitted" : "")} onClick={submitReport}>{reported ? `✓ 已进入审核队列${currentReportId ? ` · ${currentReportId}` : ""}` : activeEvidenceInsufficient ? "提交人工补充核验" : "提交证据并建议平台复核"}</button>
                      ) : (
                        <div className="safe-result-note">低风险不等于绝对真实；如仍有疑问，可通过虚拟号码联系受助者确认。</div>
                      )}
                      <button className="evidence-link" onClick={() => setVerifyView("platform")}>展开完整算法证据链 →</button>
                      <p className="result-disclaimer">输出为可信度与风险分析，不构成真假、违法或诈骗认定。</p>
                    </>
                  )}
                </aside>
              </div>
            ) : (
              <div className="algorithm-console">
                <div className="console-toolbar">
                  <div><span className="section-caption">平台审核工作台</span><h3>跨平台求助视频审核任务 {activeVerification.analysisId ? `#${activeVerification.analysisId}` : "#PRESET-DEMO"}</h3><p>{liveAnalysis ? "当前证据来自真实视频指纹与本地授权数据。" : "当前为内置预计算样本，用于现场讲解权重融合；上传真实视频后可生成并保存新任务。"}</p></div>
                  <div className="console-sample-switch">
                    <button className={verifySample === "risk" && verificationInput === "preset" ? "active risk" : ""} onClick={() => { setVerifySample("risk"); setVerificationInput("preset"); setLiveAnalysis(null); setReviewDecision("pending"); setBadgeIssued(false); }}>预置高风险</button>
                    <button className={verifySample === "authorized" && verificationInput === "preset" ? "active safe" : ""} onClick={() => { setVerifySample("authorized"); setVerificationInput("preset"); setLiveAnalysis(null); setReviewDecision("pending"); }}>预置低风险</button>
                  </div>
                </div>

                <div className="algorithm-overview">
                  <div className={"overview-score " + (activeEvidenceInsufficient ? "uncertain" : activeIsRisk ? "risk" : "safe")}><strong>{activeVerification.riskScore}</strong><span>融合风险分</span><small>{activeVerification.level}</small></div>
                  <div className="overview-copy"><span>机器分析结论</span><h3>{activeVerification.title}</h3><p>可信原片召回 {activeVerification.matchScore}% · {activeVerification.matchedCaseId ? `案例 TA-${activeVerification.matchedCaseId}` : "未匹配案例"} · 算法版本 {activeAlgorithmVersion}</p></div>
                  <div className="threshold-legend"><span><i className="low" />0—29 低风险</span><span><i className="mid" />30—69 中风险</span><span><i className="high" />70—100 高风险</span></div>
                </div>

                <div className="evidence-policy-grid">
                  <div><span>证据覆盖度</span><strong>{activeEvidenceCoverage}%</strong><small>{activeEvidenceCoverage < 70 ? "不足以自动处置" : "满足规则融合条件"}</small></div>
                  <div><span>机器建议</span><strong>{activeRecommendation}</strong><small>平台可结合上下文覆盖该建议</small></div>
                  <div><span>决策约束</span><strong>覆盖度 &lt; 70% 禁止自动处置</strong><small>{activeVerification.thresholdPolicy || "分数只用于分流，不代表诈骗概率"}</small></div>
                </div>

                <details className="technical-details">
                  <summary>
                    <span><b>查看技术详情</b><small>关键帧、画面指纹、账号授权关系与权重计算</small></span>
                    <em>展开</em>
                  </summary>
                  <div className="pipeline-section">
                    <span className="section-caption">从原始视频到可复核结论</span>
                    <div className="analysis-pipeline">
                      <div><b>01</b><strong>视频特征提取</strong><span>6—18个关键帧<br />dHash · RGB · 时序差分</span></div><i>→</i>
                      <div><b>02</b><strong>可信源召回</strong><span>SQLite 指纹库逐案检索<br />最佳匹配 {activeVerification.matchScore}%</span></div><i>→</i>
                      <div><b>03</b><strong>关系核对</strong><span>项目编号 · 发布账号<br />OAuth 授权关系图</span></div><i>→</i>
                      <div><b>04</b><strong>加权融合</strong><span>五类风险信号<br />阈值校准与分级</span></div><i>→</i>
                      <div><b>05</b><strong>人机协同</strong><span>中高风险进人工池<br />平台作最终处置</span></div>
                    </div>
                  </div>

                  <div className="signal-panel">
                    <div className="signal-heading"><div><span className="section-caption">WEIGHTED SIGNALS</span><h3>风险信号、权重与可解释贡献</h3></div><code>Risk = Σ(signalᵢ × weightᵢ) = {activeVerification.riskScore}/100</code></div>
                    <div className="signal-table">
                      <div className="signal-table-head"><span>风险信号 / 模型</span><span>信号强度</span><span>权重</span><span>风险贡献</span><span>证据摘要</span></div>
                      {activeVerification.signals.map((signal) => (
                        <div className="signal-row" key={signal.label}>
                          <span><strong>{signal.label}</strong><small>{signal.engine}</small></span>
                          <span className="signal-meter"><i style={{ width: signal.score + "%" }} className={signal.score >= 70 ? "danger" : signal.score >= 30 ? "warning" : "safe"} /><b>{signal.score}</b></span>
                          <span>{signal.weight}%</span>
                          <span><strong>{(signal.score * signal.weight / 100).toFixed(1)}</strong></span>
                          <span><small>{signal.detail}</small></span>
                        </div>
                      ))}
                    </div>
                    <p className="algorithm-note">{liveAnalysis ? "当前分数由本次上传视频的关键帧指纹、项目编号、发布账号和文案动态计算，并已保存分析记录。" : "当前为预计算样本分数；上传真实视频后将切换为动态计算并保存证据记录。"} 该分数是规则融合风险分，并非“诈骗概率”。</p>
                  </div>
                </details>

                {systemOnline && (
                  <div className="review-queue">
                    <div><span className="section-caption">SQLITE REVIEW QUEUE</span><h3>真实审核队列</h3><p>举报提交后会立即出现在这里，关闭并重新启动系统后记录仍然保留。</p></div>
                    <div className="review-task-list">
                      {reviewTasks.length ? reviewTasks.slice(0, 3).map((task) => (
                        <button key={task.id} className={currentReportId === task.id ? "active" : ""} onClick={() => openReviewTask(task)}>
                          <span><strong>{task.id}</strong><small>{task.videoName} · {task.publisherAccount}</small></span>
                          <b>{task.riskScore}</b><em>{task.status}</em>
                        </button>
                      )) : <div className="queue-empty">暂无举报任务，请先在公众入口提交一次动态分析结果。</div>}
                    </div>
                  </div>
                )}

                {systemOnline && (
                  <div className="audit-trail">
                    <div><span className="section-caption">IMMUTABLE AUDIT TRAIL</span><h3>最近审计记录</h3><p>案例、分析、举报和平台决定均带时间记录，方便答辩时说明责任边界。</p></div>
                    <div className="audit-event-list">
                      {auditLogs.length ? auditLogs.slice(0, 6).map((event) => (
                        <div key={event.id}><i /><span><strong>{auditActionLabel(event.action)}</strong><small>{event.entity_type} · {event.entity_id}</small></span><time>{event.created_at.replace("T", " ").slice(5, 16)}</time></div>
                      )) : <div className="queue-empty">暂无审计记录。</div>}
                    </div>
                  </div>
                )}

                <div className="platform-bottom-grid review-only">
                  <article className="decision-card">
                    <div className="stage-title"><div><h3>平台复核与最终处置</h3></div><span className={"status-chip " + (reviewDecision === "pending" ? "pending" : "success")}>{reviewDecision === "pending" ? "待平台决定" : "已保存决定"}</span></div>
                    <p>TrustAid 将证据包送入合作平台审核池，不直接操作视频状态。请平台审核员结合上下文选择：</p>
                    <label className="review-note-field"><span>审核备注（随决定写入审计记录）</span><textarea maxLength={500} value={reviewerNote} onChange={(event) => setReviewerNote(event.target.value)} placeholder="例如：已电话核对项目主体，建议保留视频但限制个人收款入口。" /></label>
                    <div className="decision-actions">
                      <button disabled={!reviewTaskSelected} className={reviewDecision === "human" ? "active" : ""} onClick={() => requestReviewDecision("human")}>转人工深度复核</button>
                      <button disabled={!reviewTaskSelected} className={reviewDecision === "limit" ? "active risk" : ""} onClick={() => requestReviewDecision("limit")}>建议限制收款导流</button>
                      <button disabled={!reviewTaskSelected} className={reviewDecision === "pass" ? "active safe" : ""} onClick={() => handleReviewDecision("pass")}>平台审核通过</button>
                    </div>
                    <div className="decision-result">{!reviewTaskSelected ? "请先选择一条真实审核任务；未选任务时所有处置按钮保持锁定。" : reviewDecision === "pending" ? "尚未选择处置，内容状态保持不变。" : reviewDecision === "human" ? "已进入人工复核队列，预计 10 分钟内返回。" : reviewDecision === "limit" ? "已生成限制导流建议，等待平台审核员确认执行。" : "平台已记录审核通过；Trust 徽章可按授权签发。"}</div>
                    {!activeIsRisk && (!systemOnline || (currentReportId && reviewDecision === "pass")) && <button className="trust-badge-button" onClick={() => setBadgeIssued(true)}>{badgeIssued ? "✓ Trust 徽章已签发至授权账号" : "签发可验证 Trust 徽章"}</button>}
                  </article>
                </div>

              </div>
            )}
          </section>
        )}

        {activeModule === "directory" && (
          <section className="module-page directory-page">
            <div className="page-heading">
              <div>
                <h2>可信案例目录</h2>
                <p>仅展示核验完成且经本人授权公开的必要信息。</p>
              </div>
              <div className="directory-stat">
                <div><strong>{systemOnline ? directoryPeople.length : "1,286"}</strong><span>{systemOnline ? "已授权公开案例" : "演示有效案例"}</span></div>
                <div><strong>{systemOnline ? systemHealth.trustedSources : "97.4%"}</strong><span>{systemOnline ? "已生成可信源" : "持续联系率"}</span></div>
              </div>
            </div>

            <div className="privacy-banner">
              <span>授权与隐私说明</span>
              <p>DEMO- 开头的案例均为虚构演示数据；正式案例仅展示用户主动授权的必要信息，并可随时撤回。</p>
            </div>

            <div className="directory-tools">
              <label className="search-box">
                <span>⌕</span>
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索姓名、疾病、医院或案例编号" />
              </label>
              <label className="city-filter">
                <span>地区</span>
                <select value={city} onChange={(event) => setCity(event.target.value)}>
                  <option>全部地区</option>
                  {directoryCities.map((cityName) => <option key={cityName}>{cityName}</option>)}
                </select>
              </label>
              <span className="result-count">找到 {filteredWhitelist.length} 个公开案例</span>
            </div>

            <div className="directory-layout">
              {selectedProfile ? (
                <>
                  <div className="people-list">
                    {filteredWhitelist.map((person) => (
                      <button
                        key={person.id}
                        className={"person-row " + (selectedProfile.id === person.id ? "selected" : "")}
                        onClick={() => setSelectedPerson(person.id)}
                      >
                        <span className="person-avatar">{person.avatar}</span>
                        <span className="person-main">
                          <strong>{person.name} <i>{isDemoCase(person) ? "虚拟演示" : "✓ 已核验"}</i></strong>
                          <small>{person.age} · {person.city} · {person.disease}</small>
                          <em>{person.hospital} · {person.status} · {person.lastChecked}</em>
                        </span>
                        <span className="person-score"><strong>{person.confidence}</strong><small>身份置信度</small></span>
                        <span className="row-arrow">→</span>
                      </button>
                    ))}
                  </div>

                  <aside className="profile-card">
                    <div className="profile-head">
                      <span className="portrait">{selectedProfile.avatar}</span>
                      <div><span className="verified-label">{isDemoCase(selectedProfile) ? "虚拟演示案例" : "✓ Trust 徽章有效"}</span><h3>{selectedProfile.name}</h3><p>案例 TA-{selectedProfile.id} · 更新于 {selectedProfile.updated}</p></div>
                      <span className="confidence-badge"><strong>{selectedProfile.confidence}</strong><small>身份置信度</small></span>
                    </div>

                    <div className="realtime-strip"><span><i /> {selectedProfile.status}</span><strong>{selectedProfile.lastChecked}</strong><small>{isDemoCase(selectedProfile) ? "以下身份、项目和联系方式全部为虚构演示" : "身份、项目入口与联系授权均在有效期"}</small></div>

                    <div className="profile-facts">
                      <div><span>受助情况</span><strong>{selectedProfile.disease}</strong></div>
                      <div><span>就诊机构</span><strong>{selectedProfile.hospital}</strong></div>
                      <div><span>申请人</span><strong>{selectedProfile.applicant}</strong></div>
                      <div><span>公开项目</span><strong>{selectedProfile.project}</strong></div>
                    </div>

                    <div className="profile-contact">
                      <div className="contact-heading">
                        <div><span>{isDemoCase(selectedProfile) ? "虚拟联系信息" : "隐私虚拟联系"}</span><strong>{isDemoCase(selectedProfile) ? "仅用于功能演示" : "本人已授权平台转接"}</strong></div>
                        <span className="consent-tag">{isDemoCase(selectedProfile) ? "不对应真实号码" : "真实号码不公开"}</span>
                      </div>
                      <div className="contact-row">
                        <span>虚拟号</span>
                        <strong>{revealed[selectedProfile.id] ? selectedProfile.virtualPhone : "已授权 · 点击获取本次转接号"}</strong>
                      </div>
                      <div className="contact-row">
                        <span>邮箱</span>
                        <strong>{revealed[selectedProfile.id] ? selectedProfile.email : "已授权 · 点击后显示"}</strong>
                      </div>
                      <button
                        className="reveal-button"
                        onClick={() => setRevealed((value) => ({ ...value, [selectedProfile.id]: !value[selectedProfile.id] }))}
                      >
                        {revealed[selectedProfile.id] ? "隐藏本次转接信息" : "确认用途并获取虚拟联系"}
                      </button>
                      <small>虚拟号限时有效并记录滥用行为；Demo 中所有人物与联系方式均为虚构。</small>
                    </div>

                    <button
                      className="secondary-button wide"
                      onClick={() => {
                        setActiveModule("verify");
                        setVerifyView("public");
                        setVerifyComplete(false);
                      }}
                    >
                      我看到了相关视频，去核验
                    </button>
                  </aside>
                </>
              ) : (
                <div className="directory-empty-state">
                  <span>暂无公开案例</span>
                  <strong>{directoryPeople.length ? "没有符合当前筛选条件的案例" : "尚无完成可信源建档并确认公开授权的案例"}</strong>
                  <p>{directoryPeople.length ? "请清空搜索词或切换地区后重试。" : "案例资料只有在求助者完成视频可信源并点击“确认授权并公开发布”后才会出现在这里。"}</p>
                  {directoryPeople.length === 0 && <button className="secondary-button" onClick={() => { setActiveModule("registry"); setRegistryStep(0); }}>前往求助者建档</button>}
                </div>
              )}
            </div>
          </section>
        )}
      </div>

      <footer className="site-footer">
        <div><strong>善证 TrustAid</strong></div>
        <p>中立服务 · 不触碰资金流 · 平台保留最终处置权</p>
      </footer>

      {authProvider && selectedProvider && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="auth-title">
          <div className="auth-modal">
            <button className="modal-close" onClick={() => setAuthProvider(null)} aria-label="关闭">×</button>
            <span className="provider-mark modal-mark" style={{ background: selectedProvider.color }}>{selectedProvider.mark}</span>
            <span className="section-caption">模拟账号授权</span>
            <h3 id="auth-title">使用{selectedProvider.name}扫码确认</h3>
            <p>仅获取账号唯一标识、昵称头像与授权状态，不读取密码或私密内容。</p>
            <div className="fake-qr" aria-label="演示二维码">
              {Array.from({ length: 121 }).map((_, index) => <i className={(index * 7 + index % 5) % 3 ? "filled" : ""} key={index} />)}
              <span style={{ background: selectedProvider.color }}>{selectedProvider.mark}</span>
            </div>
            <button className="primary-button wide" onClick={confirmBinding}>我已确认授权</button>
            <small className="modal-footnote">演示授权，不连接第三方平台</small>
          </div>
        </div>
      )}

      {projectInfoOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="project-info-title">
          <div className="project-info-modal">
            <button className="modal-close" onClick={() => setProjectInfoOpen(false)} aria-label="关闭项目说明">×</button>
            <div className="project-modal-heading">
              <span className="project-modal-logo"><img src="trustaid-logo.jpg" alt="TrustAid善证项目Logo" /></span>
              <div><h3 id="project-info-title">项目说明</h3><p>说明当前能力、演示接口与服务边界。</p></div>
            </div>

            <div className="project-capability-grid">
              <section className="capability-card implemented">
                <span>当前系统真实运行</span>
                <h4>可演示、可保存、可复核</h4>
                <ul>
                  <li>浏览器抽取关键帧并生成画面指纹</li>
                  <li>可信原片召回、账号授权与项目编号核对</li>
                  <li>五类信号融合、信息完整度门禁与人工审核</li>
                  <li>案例目录、发布撤回、审核队列与审计记录持久化</li>
                </ul>
              </section>
              <section className="capability-card adapter">
                <span>当前使用演示接口</span>
                <h4>正式接入平台后替换</h4>
                <ul>
                  <li>支付宝身份验证和第三方账号授权回调</li>
                  <li>病历 OCR、二维码识别、语音与音频指纹</li>
                  <li>深度伪造专用模型与跨平台实时数据接口</li>
                  <li>虚拟号码运营商、申诉工单与平台自动化处置</li>
                </ul>
              </section>
            </div>

            <section className="sustainability-panel">
              <div><span>对求助者</span><strong>永久免费</strong><small>不设置付费门槛，不从善款中抽成。</small></div>
              <div><span>对合作平台</span><strong>基础筛查先公益</strong><small>中高风险人工复核、审计报告、SLA 与私有化部署可形成专业服务收入。</small></div>
              <div><span>商业测算</span><strong>情景假设，不是承诺</strong><small>计划书价格与收入用于方案测算，需以客户调研、试点效果和正式合同为准。</small></div>
            </section>

            <div className="project-boundary"><b>固定边界</b><span>TrustAid 不经手善款，不作诈骗或违法认定；机器给建议，合作内容平台作最终决定。</span></div>
          </div>
        </div>
      )}

      {confirmAction && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-message">
          <div className={"confirm-modal " + (confirmAction.tone === "danger" ? "danger" : "primary")}>
            <span className="confirm-symbol" aria-hidden="true">{confirmAction.tone === "danger" ? "!" : "?"}</span>
            <span className="section-caption">操作确认</span>
            <h3 id="confirm-title">{confirmAction.title}</h3>
            <p id="confirm-message">{confirmAction.message}</p>
            <div className="confirm-actions">
              <button className="confirm-cancel" disabled={confirmBusy} onClick={() => setConfirmAction(null)}>取消，保持现状</button>
              <button className="confirm-submit" disabled={confirmBusy} onClick={runConfirmedAction}>{confirmBusy ? "正在处理…" : confirmAction.confirmLabel}</button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
