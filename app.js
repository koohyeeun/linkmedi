
// ---- angles ----
// 2D 관절각 계산 (TRD 5.2). MediaPipe Pose 33 landmarks 인덱스 사용.
const LM = { EAR_L: 7, EAR_R: 8, SH_L: 11, SH_R: 12, EL_L: 13, EL_R: 14, WR_L: 15, WR_R: 16, HIP_L: 23, HIP_R: 24 };
const CORE_VISIBILITY = 0.6;

const deg = (r) => (r * 180) / Math.PI;

// 3점 각도: arccos((BA·BC)/(|BA||BC|)), B가 꼭짓점
function angleAt(a, b, c) {
  const ba = [a.x - b.x, a.y - b.y];
  const bc = [c.x - b.x, c.y - b.y];
  const n = Math.hypot(...ba) * Math.hypot(...bc);
  if (n === 0) return NaN;
  const cos = Math.max(-1, Math.min(1, (ba[0] * bc[0] + ba[1] * bc[1]) / n));
  return deg(Math.acos(cos));
}

// 벡터(from→to)가 기준 방향과 이루는 각도
function tilt(from, to, ref) {
  const v = [to.x - from.x, to.y - from.y];
  const n = Math.hypot(...v);
  if (n === 0) return NaN;
  const cos = Math.max(-1, Math.min(1, (v[0] * ref[0] + v[1] * ref[1]) / n));
  return deg(Math.acos(cos));
}

const UP = [0, -1];
const DOWN = [0, 1];

function pickSide(lm) {
  const vis = (idx) => idx.reduce((s, i) => s + (lm[i]?.visibility ?? 0), 0);
  const left = vis([LM.EAR_L, LM.SH_L, LM.EL_L, LM.HIP_L]);
  const right = vis([LM.EAR_R, LM.SH_R, LM.EL_R, LM.HIP_R]);
  return left >= right ? "L" : "R";
}

function isValidFrame(lm, side = pickSide(lm)) {
  if (!lm || lm.length < 33) return false;
  const s = side === "L" ? [LM.EAR_L, LM.SH_L, LM.EL_L, LM.HIP_L] : [LM.EAR_R, LM.SH_R, LM.EL_R, LM.HIP_R];
  return s.every((i) => (lm[i]?.visibility ?? 0) >= CORE_VISIBILITY);
}

// 보이는 한쪽 기준 단일측 측정
function calculateJointAngles(lm) {
  const side = pickSide(lm);
  const k = side === "L"
    ? { ear: LM.EAR_L, sh: LM.SH_L, el: LM.EL_L, wr: LM.WR_L, hip: LM.HIP_L }
    : { ear: LM.EAR_R, sh: LM.SH_R, el: LM.EL_R, wr: LM.WR_R, hip: LM.HIP_R };
  return {
    side,
    trunkFlexionDeg: tilt(lm[k.hip], lm[k.sh], UP),
    neckFlexionDeg: tilt(lm[k.sh], lm[k.ear], UP),
    armElevationDeg: tilt(lm[k.sh], lm[k.el], DOWN),
    elbowAngleDeg: angleAt(lm[k.sh], lm[k.el], lm[k.wr]),
  };
}

// ---- analysis ----
// 프레임 목록 → AnalysisResult (TRD 5.2, 5.3, A.1). 순수 함수.

const RULE_VERSION = "prototype-0.1";
const MIN_CONFIDENCE = 0.6;

// 임계값: 허리·어깨는 TRD 명시, 목은 가정값(README 명시)
const THRESHOLDS = {
  waist: { caution: 20, high: 60 },
  shoulder: { caution: 45, high: 90 },
  neck: { caution: 20, high: 45 },
};

const REGION_LABEL = { waist: "허리", shoulder: "어깨", neck: "목" };

function gradeOf(region, deg) {
  const t = THRESHOLDS[region];
  if (!(deg > t.caution)) return 0;
  return deg > t.high ? 2 : 1;
}

const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

function overallLevel(ratios, highRatios) {
  const worst = Math.max(ratios.waist, ratios.shoulder, ratios.neck);
  const worstHigh = Math.max(highRatios.waist, highRatios.shoulder, highRatios.neck);
  if (worstHigh >= 20 || worst >= 70) return "high";
  if (worst >= 30) return "medium";
  return "low";
}

function uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 3) | 8).toString(16);
  });
}

function kstIso(d = new Date()) {
  const k = new Date(d.getTime() + 9 * 3600 * 1000);
  return k.toISOString().replace("Z", "+09:00").replace(/\.\d{3}/, "");
}

function analyzeFrames(frames, { sample = false } = {}) {
  const total = frames.length;
  const rows = frames.map((lm) => (lm && isValidFrame(lm) ? calculateJointAngles(lm) : null));
  const valid = rows.filter(Boolean);
  const confidence = total ? valid.length / total : 0;

  const cnt = { waist: 0, shoulder: 0, neck: 0 };
  const hi = { waist: 0, shoulder: 0, neck: 0 };
  const timeline = rows.map((r) => {
    if (!r) return { valid: false, waist: 0, shoulder: 0, neck: 0 };
    const g = {
      waist: gradeOf("waist", r.trunkFlexionDeg),
      shoulder: gradeOf("shoulder", r.armElevationDeg),
      neck: gradeOf("neck", r.neckFlexionDeg),
    };
    for (const k of Object.keys(g)) { if (g[k] >= 1) cnt[k]++; if (g[k] === 2) hi[k]++; }
    return { valid: true, ...g };
  });
  const pct = (o) => ({
    waist: round(valid.length ? (o.waist / valid.length) * 100 : 0),
    shoulder: round(valid.length ? (o.shoulder / valid.length) * 100 : 0),
    neck: round(valid.length ? (o.neck / valid.length) * 100 : 0),
  });
  const ratios = pct(cnt);
  const highRatios = pct(hi);
  const m = (f) => round(mean(valid.map(f)));
  const romOf = (f) => {
    const v = valid.map(f).filter(Number.isFinite);
    if (!v.length) return { min: null, max: null, rom: null };
    const min = Math.min(...v), max = Math.max(...v);
    return { min: round(min), max: round(max), rom: round(max - min) };
  };
  const sideArm = (s) => { const a = valid.filter((r) => r.side === s); return a.length ? round(mean(a.map((r) => r.armElevationDeg))) : null; };

  return {
    assessmentId: uuid(),
    createdAt: kstIso(),
    scoreType: "prototype_index",
    sample,
    bodyMetrics: {
      trunkFlexionDeg: m((r) => r.trunkFlexionDeg),
      neckFlexionDeg: m((r) => r.neckFlexionDeg),
      leftArmElevationDeg: sideArm("L"),
      rightArmElevationDeg: sideArm("R"),
      elbowAngleDeg: m((r) => r.elbowAngleDeg),
    },
    rom: {
      trunk: romOf((r) => r.trunkFlexionDeg),
      neck: romOf((r) => r.neckFlexionDeg),
      armElevation: romOf((r) => r.armElevationDeg),
      elbow: romOf((r) => r.elbowAngleDeg),
    },
    riskMetrics: { regionRiskRatios: ratios, highRatios, overallLevel: overallLevel(ratios, highRatios) },
    quality: {
      totalFrames: total,
      validFrames: valid.length,
      excludedFrames: total - valid.length,
      confidence: round(confidence, 2),
      lowConfidence: confidence < MIN_CONFIDENCE,
    },
    timeline,
    ruleVersion: RULE_VERSION,
    limitations: ["2D single-camera estimate", "Not a medical diagnosis"],
  };
}

// ---- questionnaire ----
// 간단 자가 설문: 불편 부위 · 통증 · 기간 · 위험 신호
const REGIONS = [["neck", "목"], ["shoulder", "어깨"], ["elbow", "팔꿈치"], ["wrist", "손목/손"], ["waist", "허리"], ["knee", "무릎"], ["foot", "발"]];
const ONSETS = [["lt1w", "1주 이내"], ["lt1m", "1개월"], ["gt3m", "3개월 이상"]];
const FREQS = [["sometimes", "가끔"], ["often", "자주"], ["daily", "거의 매일"]];
const IMPACTS = [["pausedWork", "통증 때문에 일하다 멈추거나 자세를 바꿨어요"], ["lostSleep", "통증 때문에 잠을 설쳤어요"]];
const TREATMENTS = [["none", "없음"], ["ongoing", "치료 중"], ["done", "치료 후"]];
const WARNINGS = [
  ["numbness", "저림·감각 이상"], ["weakness", "힘 빠짐"], ["nightPain", "밤에 통증으로 깸"], ["injury", "다친 뒤 시작된 심한 통증"], ["fever", "발열 동반"],
];
const PREFS = [["night", "야간 진료"], ["weekend", "주말 진료"], ["english", "외국어 가능"]];
const TASKS = ["용접", "취부·조립", "배관", "도장", "의장", "기타"];
const labelOf = (list, k) => list.find((x) => x[0] === k)?.[1] ?? k;

function readQuestionnaire(raw = {}) {
  return {
    regions: [...(raw.regions ?? [])],
    pain: raw.pain === undefined || raw.pain === null || raw.pain === "" ? null : Number(raw.pain),
    onset: raw.onset ?? null,
    freq: raw.freq ?? null,
    impacts: [...(raw.impacts ?? [])],
    treatment: raw.treatment ?? null,
    warnings: [...(raw.warnings ?? [])],
    prefs: [...(raw.prefs ?? [])],
  };
}

// 설문은 2화면: 1) 부위·통증  2) 기간·치료·위험 신호·병원 조건
function validateQuestionnaire(q, step = 3) {
  const errors = [];
  if (step === 1) {
    if (!q.regions.length) errors.push("불편한 부위를 1개 이상 선택해 주세요.");
    if (!Number.isInteger(q.pain) || q.pain < 0 || q.pain > 10) errors.push("통증 정도(0~10)를 선택해 주세요.");
  }
  if (step === 2) {
    if (!q.onset) errors.push("언제부터 불편한지 선택해 주세요.");
    if (!q.freq) errors.push("얼마나 자주 불편한지 선택해 주세요.");
    if (!q.treatment) errors.push("치료 경험을 선택해 주세요.");
  }
  return { valid: errors.length === 0, errors };
}

const hasWarningSign = (q) => q.warnings.length > 0;

// ---- findings ----
// 영상 각도 분석 + 자가 설문 → 통합 판정(의심 소견) + 추천 진료과. 확정 진단이 아닌 참고 정보.

const RULES = {
  waist: { finding: "허리를 과도하게 숙이는 자세가 반복돼요 (요추 부담 의심)", dept: "정형외과" },
  shoulder: { finding: "팔을 어깨 높이 위로 드는 자세가 많아요 (어깨 충돌·회전근개 부담 의심)", dept: "정형외과" },
  neck: { finding: "목을 앞으로 숙이는 자세가 많아요 (경추 부담 의심)", dept: "재활의학과" },
};
const CAUTION = 30;
const RANK = { low: 0, medium: 1, high: 2 };
const LEVELS = ["low", "medium", "high"];
const WARNING_LABEL = Object.fromEntries(WARNINGS);

function judge(analysis, survey = null) {
  const ratios = analysis.riskMetrics.regionRiskRatios;
  const lowConf = analysis.quality.lowConfidence;
  const sRegions = survey?.regions ?? [];
  const pain = survey?.pain ?? 0;
  const redFlags = (survey?.warnings ?? []).map((w) => WARNING_LABEL[w] ?? w);

  const findings = Object.keys(REGION_LABEL)
    .filter((k) => ratios[k] >= CAUTION)
    .sort((a, b) => ratios[b] - ratios[a])
    .map((k) => ({ region: k, label: REGION_LABEL[k], ratio: ratios[k], text: RULES[k].finding, dept: RULES[k].dept,
      matched: sRegions.includes(k) && pain >= 4 }));
  const matched = findings.filter((f) => f.matched);
  const reported = sRegions.filter((k) => REGION_LABEL[k] && !findings.some((f) => f.region === k)).map((k) => REGION_LABEL[k]);
  const unmeasured = sRegions.filter((k) => !REGION_LABEL[k]).map((k) => labelOf(REGIONS, k));
  const longTerm = survey?.onset === "gt3m" && survey?.freq !== "sometimes";

  const videoLevel = lowConf ? "low" : analysis.riskMetrics.overallLevel;
  const painLevel = pain >= 7 ? "high" : pain >= 4 ? "medium" : "low";
  let rank = Math.max(RANK[videoLevel], RANK[painLevel]);
  if (matched.length) rank = Math.min(2, rank + 1);
  if (redFlags.length) rank = 2;
  const level = LEVELS[rank];

  const referral = redFlags.length > 0 || pain >= 7 || longTerm || (!lowConf && (videoLevel === "high" || (videoLevel === "medium" && findings.length > 0))) || (matched.length > 0 && pain >= 4);
  const dept = (matched[0] ?? findings[0])?.dept ?? (sRegions.includes("neck") ? "재활의학과" : "정형외과");

  const headline = redFlags.length ? "위험 신호가 있어 병원 상담을 권장해요"
    : lowConf && !survey ? "신뢰도가 낮아 판정할 수 없어요"
    : referral ? "병원 상담을 권장해요"
    : findings.length || pain >= 4 ? "자세 개선과 경과 관찰을 권장해요"
    : "뚜렷한 부담 자세는 발견되지 않았어요";
  return { findings, matched, reported, unmeasured, longTerm, emergency: (survey?.warnings ?? []).includes("injury") && pain >= 8, redFlags, level, referral, recommendedDepartment: dept, headline, pain, hasSurvey: !!survey };
}

// ---- hospitals ----
// 병원 필터/정렬 (TRD 5.5). 모든 데이터는 예시.
const HOSPITALS = [
  { id: "h1", name: "거제 바른정형외과 (예시)", department: "정형외과", region: "고현동", night: false, weekend: true, english: false, distanceKm: 1.2, popularity: 82 },
  { id: "h2", name: "옥포 튼튼재활의학과 (예시)", department: "재활의학과", region: "옥포동", night: true, weekend: true, english: true, distanceKm: 6.5, popularity: 74 },
  { id: "h3", name: "거제 조선직업환경의학과 (예시)", department: "직업환경의학과", region: "아주동", night: false, weekend: false, english: true, distanceKm: 4.1, popularity: 65 },
  { id: "h4", name: "장승포 나은정형외과 (예시)", department: "정형외과", region: "장승포동", night: true, weekend: false, english: false, distanceKm: 8.3, popularity: 90 },
  { id: "h5", name: "고현 편한재활의학과 (예시)", department: "재활의학과", region: "고현동", night: false, weekend: true, english: false, distanceKm: 1.8, popularity: 58 },
];

const SORT_EXPLAIN = {
  recommend: "추천순: 설문·분석 부위와 맞는 진료과이면 가산점, 선택한 조건(야간/주말/외국어)을 충족한 개수만큼 가산점을 줍니다.",
  popular: "인기순: 예시 값(준비 중)입니다. 실제 이용 데이터가 아닙니다.",
  distance: "거리순: 동(洞) 단위 예시 거리 기준 가까운 순입니다.",
};

function filterAndSortHospitals(list, filters = {}, sort = "recommend", ctx = {}) {
  const { night, weekend, english, department } = filters;
  const out = list.filter((h) =>
    (!night || h.night) && (!weekend || h.weekend) && (!english || h.english) &&
    (!department || h.department === department));
  const score = (h) => {
    let s = ctx.recommendedDepartment && h.department === ctx.recommendedDepartment ? 10 : 0;
    for (const k of ["night", "weekend", "english"]) if (ctx.preferences?.[k] && h[k]) s += 1;
    return s;
  };
  const cmp = {
    recommend: (a, b) => score(b) - score(a) || a.distanceKm - b.distanceKm,
    popular: (a, b) => b.popularity - a.popularity,
    distance: (a, b) => a.distanceKm - b.distanceKm,
  }[sort] ?? (() => 0);
  return [...out].sort(cmp);
}

// ---- summary ----
// 요약 생성 및 전송 시뮬레이션 (TRD 5.5, A.3). 영상/프레임은 절대 포함하지 않는다.
const FORBIDDEN = /video|frame|blob|image|file/i;
const ALLOWED_FIELDS = ["riskLevel", "bodyRegion", "taskType", "painScore", "changeVsPrevious"];

function hasForbiddenKey(obj) {
  if (obj && typeof obj === "object") {
    return Object.keys(obj).some((k) => (k !== "videoIncluded" && FORBIDDEN.test(k)) || hasForbiddenKey(obj[k]));
  }
  return false;
}

function buildSummary(record, comparison, selectedFields) {
  const full = {
    riskLevel: record.level ?? record.analysis.riskMetrics.overallLevel,
    bodyRegion: record.regions,
    taskType: record.taskType,
    painScore: record.painScore,
    changeVsPrevious: comparison?.comparable ? { status: comparison.status, delta: comparison.deltaPercentagePoint } : null,
  };
  const summary = {};
  for (const f of selectedFields) {
    if (!ALLOWED_FIELDS.includes(f)) throw new Error(`허용되지 않은 필드: ${f}`);
    summary[f] = full[f];
  }
  return summary;
}

function buildPayload({ assessmentId, hospitalId, summary, userClicked }) {
  return {
    assessmentId, hospitalId, selectedFields: Object.keys(summary), summary,
    videoIncluded: false, userClicked: !!userClicked,
    deliveryMode: "simulation", status: "SIMULATED",
  };
}

// 네트워크 호출 없음. 규칙 위반 시 400 모사.
function simulateSubmit(payload) {
  if (payload.userClicked !== true) return { status: 400, error: "USER_CLICK_REQUIRED" };
  if (payload.videoIncluded !== false || hasForbiddenKey(payload)) return { status: 400, error: "VIDEO_OR_FRAME_NOT_ALLOWED" };
  return { status: 200, result: "SIMULATED", payload };
}

// ---- videoValidator ----
const LIMITS = { minSec: 10, maxSec: 30, maxBytes: 100 * 1024 * 1024 };

function validateVideoMeta({ type, size, duration }, consent) {
  const errors = [];
  if (!consent) errors.push("민감 건강정보 처리에 동의해 주세요.");
  if (!type || !type.startsWith("video/")) errors.push("동영상 파일(MP4/MOV/WebM)만 올릴 수 있어요.");
  if (size > LIMITS.maxBytes) errors.push("파일 크기는 100MB 이하여야 해요.");
  if (!(duration >= LIMITS.minSec && duration <= LIMITS.maxSec)) errors.push("영상 길이는 10~30초여야 해요.");
  return { valid: errors.length === 0, errors };
}

function readVideoDuration(file) {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    const url = URL.createObjectURL(file);
    v.preload = "metadata";
    v.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve(v.duration); };
    v.onerror = () => { URL.revokeObjectURL(url); reject(new Error("영상을 읽을 수 없어요.")); };
    v.src = url;
  });
}

// ---- storage ----
// localStorage에는 설문/점수/부위/날짜만 저장. 영상·프레임·타임라인은 저장하지 않는다.
const KEY = "linkmedi.assessments";

function loadAssessments() {
  try { return JSON.parse(localStorage.getItem(KEY) ?? "[]"); } catch { return []; }
}

function saveAssessment(record) {
  const list = loadAssessments();
  const { timeline, ...analysis } = record.analysis;
  list.push({ ...record, analysis });
  localStorage.setItem(KEY, JSON.stringify(list));
}

function clearAssessments() { localStorage.removeItem(KEY); }

// ---- sample ----
// 데모용 샘플 좌표 (영상 없이 분석 경로 시연). 합성 데이터이며 실제 측정이 아님.
function frame(trunk, neck, arm, vis = 0.9) {
  const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: vis }));
  const r = (d) => (d * Math.PI) / 180;
  const hip = { x: 0.5, y: 0.8 };
  const sh = { x: hip.x + 0.3 * Math.sin(r(trunk)), y: hip.y - 0.3 * Math.cos(r(trunk)) };
  const ear = { x: sh.x + 0.12 * Math.sin(r(neck)), y: sh.y - 0.12 * Math.cos(r(neck)) };
  const el = { x: sh.x + 0.18 * Math.sin(r(arm)), y: sh.y + 0.18 * Math.cos(r(arm)) };
  const wr = { x: el.x + 0.16 * Math.sin(r(arm + 60)), y: el.y + 0.16 * Math.cos(r(arm + 60)) };
  for (const [i, p] of [[7, ear], [8, ear], [11, sh], [12, sh], [13, el], [14, el], [15, wr], [16, wr], [23, hip], [24, hip]]) {
    lm[i] = { ...p, z: 0, visibility: vis };
  }
  return lm;
}

function series(n, f, lowVisEvery = 0) {
  return Array.from({ length: n }, (_, i) => {
    const [t, ne, a] = f(i);
    return frame(t, ne, a, lowVisEvery && i % lowVisEvery === 0 ? 0.3 : 0.9);
  });
}

const SAMPLES = {
  waist: { label: "허리 부담 샘플", frames: () => series(30, (i) => [30 + (i % 10) * 6, 15, 20 + (i % 5) * 5], 10) },
  shoulder: { label: "어깨 부담 샘플", frames: () => series(30, (i) => [10 + (i % 4) * 3, 12, 60 + (i % 6) * 8], 10) },
  neck: { label: "목 부담 샘플", frames: () => series(30, (i) => [12, 25 + (i % 8) * 4, 20], 10) },
};

// ---- poseAnalysis ----
// 참고 코드(썬해드)와 같은 MediaPipe Pose(legacy CDN) 방식. 영상/카메라 모두 브라우저 안에서만 처리한다.


const SAMPLE_FPS = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pose = null;
let handler = null;
function ensurePose() {
  if (pose) return pose;
  if (typeof Pose === "undefined") throw new Error("Pose 라이브러리를 불러오지 못했어요(인터넷 확인)");
  pose = new Pose({ locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${f}` });
  pose.setOptions({ modelComplexity: 1, smoothLandmarks: false, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
  pose.onResults((r) => handler && handler(r));
  return pose;
}

function detect(image) {
  const p = ensurePose();
  return new Promise((resolve, reject) => {
    handler = resolve;
    p.send({ image }).catch(reject);
  });
}

// 캔버스에 영상 프레임 + 골격 + 관절각 라벨을 그린다 (메모리에서만, 저장하지 않음)
function drawFrame(canvas, image, lm) {
  const vw = image.videoWidth || image.width, vh = image.videoHeight || image.height;
  if (!vw) return;
  const w = Math.min(640, vw);
  canvas.width = w; canvas.height = Math.round((vh * w) / vw);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  if (!lm) return;
  if (typeof drawConnectors === "function" && typeof POSE_CONNECTIONS !== "undefined") {
    drawConnectors(ctx, lm, POSE_CONNECTIONS, { color: "#00FF00", lineWidth: 3 });
    drawLandmarks(ctx, lm, { color: "#FF0000", lineWidth: 1, radius: 3 });
  }
  if (!isValidFrame(lm)) return;
  const a = calculateJointAngles(lm);
  const k = a.side === "L" ? { sh: 11, el: 13, hip: 23 } : { sh: 12, el: 14, hip: 24 };
  const label = (text, p) => {
    ctx.font = "bold 14px sans-serif"; ctx.lineWidth = 3; ctx.strokeStyle = "#000"; ctx.fillStyle = "#ffeb3b";
    const x = p.x * canvas.width + 6, y = p.y * canvas.height;
    ctx.strokeText(text, x, y); ctx.fillText(text, x, y);
  };
  label(`몸통 ${Math.round(a.trunkFlexionDeg)}°`, lm[k.hip]);
  label(`목 ${Math.round(a.neckFlexionDeg)}°`, lm[k.sh]);
  label(`팔 ${Math.round(a.armElevationDeg)}°`, lm[k.el]);
}

// 업로드 영상: 3fps로 시크하며 분석
async function analyzeVideo(file, { canvas, onProgress = () => {} } = {}) {
  ensurePose();
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true; video.playsInline = true; video.src = url;
  try {
    await new Promise((res, rej) => { video.onloadeddata = res; video.onerror = () => rej(new Error("영상을 읽을 수 없어요.")); });
    const n = Math.max(1, Math.floor(video.duration * SAMPLE_FPS));
    const frames = [];
    for (let i = 0; i < n; i++) {
      await new Promise((res) => { video.onseeked = res; video.currentTime = Math.min(i / SAMPLE_FPS, video.duration - 0.01); });
      const lm = (await detect(video)).poseLandmarks ?? null;
      if (canvas) drawFrame(canvas, video, lm);
      frames.push(lm);
      onProgress((i + 1) / n);
    }
    return analyzeFrames(frames);
  } finally {
    video.removeAttribute("src"); video.load();
    URL.revokeObjectURL(url);
  }
}

// 라이브 카메라 미리보기(골격 표시). stop()으로 종료.
async function startCamera(video, canvas) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("이 브라우저는 카메라를 지원하지 않아요.");
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: 640, height: 480 }, audio: false });
  video.srcObject = stream; video.muted = true; video.playsInline = true;
  await video.play();
  ensurePose();
  let running = true, recording = null;
  const loop = (async () => {
    while (running) {
      const t0 = performance.now();
      const lm = (await detect(video)).poseLandmarks ?? null;
      drawFrame(canvas, video, lm);
      if (recording) recording.push(lm);
      await sleep(Math.max(0, 1000 / SAMPLE_FPS - (performance.now() - t0)));
    }
  })();
  return {
    startRecording() { recording = []; },
    get recordedCount() { return recording ? recording.length : 0; },
    finishRecording() { const f = recording ?? []; recording = null; return analyzeFrames(f); },
    async stop() { running = false; await loop.catch(() => {}); stream.getTracks().forEach((t) => t.stop()); video.srcObject = null; },
  };
}

// ---- follow-up compare ----
// 같은 지표로 이전 기록과 비교 (PRD ③). 수치는 코드로 계산, 문장은 규칙 템플릿.
function compareWithPrev(prev, cur) {
  if (!prev) return null;
  const pa = prev.analysis, ca = cur;
  if ((prev.taskType ?? "") !== (cur.taskType ?? "") || pa.quality?.lowConfidence || ca.quality.lowConfidence) {
    return { comparable: false };
  }
  const pr = pa.riskMetrics.regionRiskRatios, cr = ca.riskMetrics.regionRiskRatios;
  const diffs = Object.keys(REGION_LABEL).map((k) => ({ k, label: REGION_LABEL[k], from: pr[k], to: cr[k], d: round(cr[k] - pr[k]) }));
  const top = [...diffs].sort((a, b) => Math.abs(b.d) - Math.abs(a.d))[0];
  const status = top.d <= -10 ? "improved" : top.d >= 10 ? "worsened" : "maintained";
  const remain = [...diffs].sort((a, b) => b.to - a.to)[0];
  const comment = status === "improved" ? `${top.label} 부담 자세가 ${top.from}%에서 ${top.to}%로 줄었어요.`
    : status === "worsened" ? `${top.label} 부담 자세가 ${top.from}%에서 ${top.to}%로 늘었어요.`
    : `전체적으로 지난번과 비슷하게 유지되고 있어요.`;
  const remainText = remain.to >= CAUTION ? ` 아직 ${remain.label} 부담(${remain.to}%)이 남아 있어요.` : "";
  return { comparable: true, status, diffs, top, deltaPercentagePoint: top.d, comment: comment + remainText };
}

// ---- app ----
document.querySelector("link[rel=icon]").href = "data:image/svg+xml," + encodeURIComponent(document.querySelector(".top svg").outerHTML);








const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const STEPS = { login: "로그인", survey: "1/4 자가 설문", upload: "2/4 영상 분석", result: "3/4 통합 결과", hospital: "4/4 병원 연계", done: "자가 관리" };

const USERS="linkmedi.users", SESSION="linkmedi.session";
const readUsers=()=>{ try{return JSON.parse(localStorage.getItem(USERS)??"{}");}catch{return {};} };
async function hashPin(id,pin){ const s="linkmedi:"+id+":"+pin; if(!crypto?.subtle) return btoa(unescape(encodeURIComponent(s))); const b=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s)); return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join(""); }
const newSurvey = () => ({ regions: [], pain: null, onset: null, freq: null, impacts: [], treatment: null, warnings: [], prefs: [] });
const state = { survey: newSurvey(), sstep: 1, taskType: "용접", prev: null, comparison: null, reminder: localStorage.getItem("linkmedi.reminder") ?? "", surveyErr: [], user: localStorage.getItem(SESSION), signup: false, loginErr: "", screen: localStorage.getItem(SESSION) ? "survey" : "login", mode: "upload", consent: false, errors: [], busy: false, progress: 0,
  analysis: null, judged: null, filters: {}, sort: "recommend", sent: null, cam: null, recording: false, recSec: 0 };
let timer = null;

async function stopCam() {
  clearInterval(timer);
  if (state.cam) { await state.cam.stop(); state.cam = null; }
  state.recording = false;
}

function go(screen) {
  stopCam();
  state.screen = screen;
  render();
  window.scrollTo(0, 0);
}

function finish(analysis) {
  state.analysis = analysis;
  analysis.taskType = state.taskType;
  state.judged = judge(analysis, readQuestionnaire(state.survey));
  state.sent = null;
  state.filters = Object.fromEntries(state.survey.prefs.map((k) => [k, true]));
  state.prev = analysis.sample ? null : loadAssessments().filter((r) => r.userId === state.user).slice(-1)[0] ?? null;
  state.comparison = compareWithPrev(state.prev, analysis);
  if (!analysis.sample) {
    saveAssessment({ assessmentId: analysis.assessmentId, createdAt: analysis.createdAt, analysis,
      regions: state.judged.findings.map((f) => f.region), taskType: state.taskType, painScore: state.survey.pain, survey: readQuestionnaire(state.survey), userId: state.user });
  }
  go("result");
}

function render() {
  $("#stepLabel").innerHTML = state.user ? `${esc(state.user)}님 <button class="chip" id="logout" style="min-height:32px;padding:0 10px;font-size:13px">로그아웃</button>` : "";
  if (state.screen !== "login") $("#stepLabel").insertAdjacentText("afterbegin", STEPS[state.screen] + " · ");
  const lo = $("#logout"); if (lo) lo.onclick = () => { localStorage.removeItem(SESSION); state.user = null; state.analysis = null; state.survey = newSurvey(); go("login"); };
  $("#app").innerHTML = { login: viewLogin, survey: viewSurvey, upload: viewUpload, result: viewResult, hospital: viewHospital, done: viewDone }[state.screen]();
  bind();
}

function viewLogin() {
  return `<div class="card"><h2>${state.signup ? "회원가입" : "로그인"}</h2>
    <p class="muted">작업 자세 분석 후 병원 연계까지 도와드려요. 계정은 이 기기에만 저장되는 데모예요.</p>
    ${state.loginErr ? `<div class="err">${esc(state.loginErr)}</div>` : ""}
    <input id="uid" placeholder="아이디 (영문/숫자 3자 이상)" autocomplete="username" style="width:100%;min-height:48px;font-size:16px;margin:4px 0 10px">
    <input id="pin" type="password" inputmode="numeric" placeholder="비밀번호 (4자 이상)" autocomplete="current-password" style="width:100%;min-height:48px;font-size:16px;margin:4px 0 10px">
    <button class="btn" id="authGo">${state.signup ? "가입하고 시작" : "로그인"}</button>
    <button class="btn ghost" id="authSwitch">${state.signup ? "이미 계정이 있어요" : "처음이에요 (회원가입)"}</button>
    <button class="btn sec" id="guest">로그인 없이 체험</button></div>`;
}

function bodyMap(sel) {
  const pts = { neck: [60, 46], shoulder: [38, 62], elbow: [28, 105], wrist: [24, 145], waist: [60, 120], knee: [50, 185], foot: [50, 232] };
  const dot = (k, x, y) => `<circle cx="${x}" cy="${y}" r="11" class="bp ${sel.includes(k) ? "on" : ""}" data-sreg="${k}"/><text x="${x}" y="${y + 4}" text-anchor="middle" font-size="9" fill="${sel.includes(k) ? "#fff" : "#1e3a8a"}" pointer-events="none">${labelOf(REGIONS, k).slice(0, 2)}</text>`;
  return `<svg viewBox="0 0 120 250" style="width:150px;display:block;margin:6px auto"><circle cx="60" cy="20" r="14" fill="#dbeafe"/><rect x="40" y="38" width="40" height="95" rx="16" fill="#dbeafe"/><rect x="46" y="130" width="12" height="105" rx="6" fill="#dbeafe"/><rect x="62" y="130" width="12" height="105" rx="6" fill="#dbeafe"/><rect x="20" y="50" width="12" height="105" rx="6" fill="#dbeafe"/><rect x="88" y="50" width="12" height="105" rx="6" fill="#dbeafe"/>
    ${Object.entries(pts).map(([k, [x, y]]) => dot(k, x, y)).join("")}</svg>`;
}

function viewSurvey() {
  const s = state.survey, st = state.sstep;
  const chips = (arr, sel, attr) => arr.map(([k, l]) => `<button class="chip ${sel.includes(k) ? "on" : ""}" data-${attr}="${k}">${l}</button>`).join("");
  const body = st === 1 ? `
    <b>1. 불편한 부위 (복수 선택)</b>${bodyMap(s.regions)}<div class="chips">${chips(REGIONS, s.regions, "sreg")}</div>
    <p><b>2. 가장 불편한 곳의 통증 정도</b> <span class="muted">0=없음 · 10=매우 심함</span></p>
    <div class="scale">${Array.from({ length: 11 }, (_, i) => `<button class="chip ${s.pain === i ? "on" : ""}" data-spain="${i}">${i}</button>`).join("")}</div>`
  : `
    <p><b>3. 언제부터, 얼마나 자주 불편했나요?</b></p><div class="chips">${chips(ONSETS, s.onset ? [s.onset] : [], "sonset")}</div>
    <div class="chips" style="margin-top:8px">${chips(FREQS, s.freq ? [s.freq] : [], "sfreq")}</div>
    <p><b>4. 치료 경험</b></p><div class="chips">${chips(TREATMENTS, s.treatment ? [s.treatment] : [], "streat")}</div>
    <p><b>5. 해당되는 위험 신호 (없으면 건너뛰기)</b></p><div class="chips">${chips(WARNINGS, s.warnings, "swarn")}</div>
    ${s.warnings.length ? `<div class="alert" style="margin-top:10px">의료진 상담을 권장해요. 결과 화면에서 병원 연계를 먼저 안내해 드려요. 보낼지는 직접 선택해요.<br>갑작스러운 극심한 통증·심한 외상·호흡곤란이 있다면 즉시 <b>119</b>에 연락하세요.</div>` : ""}
    <p><b>6. 병원 조건 (선택)</b></p><div class="chips">${chips(PREFS, s.prefs, "spref")}</div>`;
  return `<div class="card"><h2>간단 자가 설문 <span class="muted">${st}/2</span></h2><p class="muted">1분이면 끝나요. 참고용 체크이며 진단이 아니에요. 영상 분석 결과와 합쳐서 봐요.</p>
    ${state.surveyErr.map((e) => `<div class="err">${esc(e)}</div>`).join("")}${body}</div>
  <button class="btn" id="surveyNext">${st < 2 ? "다음" : "다음: 영상 분석"}</button>
  ${st > 1 ? `<button class="btn ghost" id="surveyPrev">← 이전</button>` : ""}`;
}

function viewUpload() {
  const cam = state.mode === "camera";
  return `
  <div class="card"><h2>작업 영상으로 자세 분석</h2>
    <p class="muted">작업하는 모습을 옆(또는 45°)에서 전신이 나오게 찍어 주세요. 10~30초, 매번 같은 각도로 찍으면 비교가 정확해요. 영상은 이 기기에서만 처리되고 저장·전송되지 않아요.</p>
    <label class="muted">작업 종류</label>
    <select id="taskType">${TASKS.map((t) => `<option ${state.taskType === t ? "selected" : ""}>${t}</option>`).join("")}</select>
    <div class="chips"><button class="chip ${cam ? "" : "on"}" data-mode="upload">영상 업로드</button><button class="chip ${cam ? "on" : ""}" data-mode="camera">카메라 촬영</button></div>
    <label class="row"><input type="checkbox" id="consent" ${state.consent ? "checked" : ""}> 민감 건강정보 처리에 동의합니다</label>
    ${state.errors.map((e) => `<div class="err">${esc(e)}</div>`).join("")}
    ${cam ? `
      <video id="cam" playsinline muted hidden></video>
      <canvas id="view" class="view"></canvas>
      <div id="recInfo" class="muted">${state.recording ? `촬영 중… ${state.recSec}초 (10~30초)` : "카메라를 켜면 골격과 각도가 실시간으로 보여요."}</div>
      ${state.cam ? (state.recording
        ? `<button class="btn" id="recStop" ${state.recSec < 10 ? "disabled" : ""}>촬영 완료 · 분석</button>`
        : `<button class="btn" id="recStart">촬영 시작</button>`)
        : `<button class="btn" id="camOn">카메라 켜기</button>`}`
    : `
      <input type="file" id="file" accept="video/*" ${state.busy ? "disabled" : ""}>
      <canvas id="view" class="view" ${state.busy ? "" : "hidden"}></canvas>
      ${state.busy ? `<progress max="1" value="${state.progress}"></progress><div class="muted">분석 중… ${Math.round(state.progress * 100)}%</div>` : ""}
      <div class="muted">MP4/MOV/WebM · 10~30초 · 100MB 이하</div>`}
  </div>
  <button class="btn ghost" id="toSurvey">← 설문 수정</button>
  <div class="card"><b>샘플로 먼저 체험</b><p class="muted">영상 없이 앱 흐름만 볼 수 있어요(가상 데이터).</p>
    <div class="chips">${Object.entries(SAMPLES).map(([k, s]) => `<button class="chip" data-sample="${k}">${s.label}</button>`).join("")}</div></div>`;
}

const gradeBar = (v) => `<div class="bar"><i class="${v >= 70 ? "h" : v >= 30 ? "m" : ""}" style="width:${v}%"></i></div>`;
const fmtDeg = (v) => (v == null ? "-" : `${v}°`);

function viewResult() {
  const a = state.analysis, j = state.judged, r = a.riskMetrics, b = a.bodyMetrics, rom = a.rom, q = a.quality;
  const lvl = { low: "낮음", medium: "주의", high: "높음" }[j.level];
  return `
  ${a.sample ? `<div class="info">샘플(가상) 데이터예요. 저장되지 않아요.</div>` : ""}
  ${q.lowConfidence ? `<div class="alert">신뢰도 ${Math.round(q.confidence * 100)}%로 낮아요. 옆모습 전체가 보이게 다시 촬영해 주세요.</div>` : ""}
  <div class="card"><span class="badge ${j.level}">종합 위험도 ${lvl}</span>
    <h2>${esc(j.headline)}</h2>
    ${j.emergency ? `<div class="alert">심한 외상 후 극심한 통증이 의심돼요. 응급 상황이면 즉시 <b>119</b>에 연락하세요.</div>` : ""}
    ${j.redFlags.length ? `<div class="alert">위험 신호: ${j.redFlags.map(esc).join(", ")} — 의료진 상담을 권장해요.</div>` : ""}
    ${j.longTerm ? `<div class="alert">3개월 이상 자주 불편하셨어요. 병원 상담을 권장해요.</div>` : ""}
    ${j.hasSurvey ? `<div class="info">자가 설문: ${state.survey.regions.map((k) => labelOf(REGIONS, k)).join("·")} · 통증 ${j.pain}/10 · ${labelOf(ONSETS, state.survey.onset)} · ${labelOf(FREQS, state.survey.freq)} · 작업 ${esc(state.taskType)}</div>` : ""}
    ${state.survey.impacts.length ? `<div class="muted">최근 1주: ${state.survey.impacts.map((k) => labelOf(IMPACTS, k)).join(" / ")}</div>` : ""}
    ${j.findings.length ? `<b>의심 소견</b><ul>${j.findings.map((f) => `<li>${esc(f.label)} 영상 ${f.ratio}% — ${esc(f.text)}${f.matched ? ` <span class="badge high">설문과 일치</span>` : ""}</li>`).join("")}</ul>` : ""}
    ${j.reported.length ? `<div class="muted">설문에서 ${j.reported.join("·")} 불편을 선택했지만 영상에서는 뚜렷한 부담 자세가 보이지 않았어요. 작업 외 원인일 수 있어요.</div>` : ""}
    ${j.unmeasured.length ? `<div class="muted">${j.unmeasured.join("·")}은(는) 영상으로 측정하지 않는 부위예요(설문 참고용).</div>` : ""}
    <div class="muted">확정 진단이 아니라 영상 기반 참고 정보예요. 정확한 판단은 의료진에게 받으세요. (분석 신뢰도 ${Math.round(q.confidence * 100)}%, 유효 ${q.validFrames}/${q.totalFrames}프레임)</div></div>
  <div class="card"><b>관절 각도 · ROM (최소~최대)</b>
    <table class="rt"><tr><th>부위</th><th>평균</th><th>최소</th><th>최대</th><th>ROM</th></tr>
      <tr><td>몸통 굴곡</td><td>${fmtDeg(b.trunkFlexionDeg)}</td><td>${fmtDeg(rom.trunk.min)}</td><td>${fmtDeg(rom.trunk.max)}</td><td><b>${fmtDeg(rom.trunk.rom)}</b></td></tr>
      <tr><td>목 굴곡</td><td>${fmtDeg(b.neckFlexionDeg)}</td><td>${fmtDeg(rom.neck.min)}</td><td>${fmtDeg(rom.neck.max)}</td><td><b>${fmtDeg(rom.neck.rom)}</b></td></tr>
      <tr><td>팔 올림</td><td>${fmtDeg(Math.max(b.leftArmElevationDeg ?? 0, b.rightArmElevationDeg ?? 0))}</td><td>${fmtDeg(rom.armElevation.min)}</td><td>${fmtDeg(rom.armElevation.max)}</td><td><b>${fmtDeg(rom.armElevation.rom)}</b></td></tr>
      <tr><td>팔꿈치</td><td>${fmtDeg(b.elbowAngleDeg)}</td><td>${fmtDeg(rom.elbow.min)}</td><td>${fmtDeg(rom.elbow.max)}</td><td><b>${fmtDeg(rom.elbow.rom)}</b></td></tr></table>
    <div class="muted">2D 단일 카메라, 보이는 한쪽 기준 추정값이에요.</div></div>
  <div class="card"><b>부위별 부담 자세 비율</b>
    ${["waist", "shoulder", "neck"].map((k) => `<div>${REGION_LABEL[k]} ${r.regionRiskRatios[k]}% <span class="muted">(주의 ${THRESHOLDS[k].caution}°↑ / 위험 ${THRESHOLDS[k].high}°↑)</span>${gradeBar(r.regionRiskRatios[k])}</div>`).join("")}
    <div class="muted">시간 흐름 (허리)</div><div class="tl">${a.timeline.map((t) => `<i class="${t.valid ? "g" + t.waist : "x"}"></i>`).join("")}</div></div>
  ${viewCompare()}
  <div class="card"><b>다음 단계는 직접 선택해요</b><div class="muted">병원 연계는 자동으로 이루어지지 않고, 원본 영상은 전송되지 않아요.</div>
  ${j.referral ? `<button class="btn" id="toHosp">${esc(j.recommendedDepartment)} 병원 연계하기</button>` : `<button class="btn sec" id="toHosp">병원 알아보기 (선택)</button>`}
  <button class="btn ghost" id="nolink">연계하지 않을래요 (자가 관리)</button></div>
  <button class="btn ghost" id="again">다시 분석</button>`;
}

function viewCompare() {
  const c = state.comparison, p = state.prev;
  if (!p) return `<div class="info">이번 결과가 기준(첫 기록)이에요. 2주 뒤 같은 작업을 다시 찍으면 변화를 비교해 드려요.</div>`;
  if (!c?.comparable) return `<div class="info">이전 기록과 작업 종류가 다르거나 신뢰도가 낮아 비교할 수 없어요. 같은 각도·작업으로 다시 촬영해 주세요.</div>`;
  const st = { improved: ["개선", "ok"], maintained: ["유지", "medium"], worsened: ["악화", "high"] }[c.status];
  const pp = p.painScore, np = state.survey.pain;
  return `<div class="card"><span class="badge ${st[1] === "ok" ? "" : st[1]}">이전 대비 ${st[0]}</span>
    <h3>${esc(c.comment)}</h3>
    <table class="rt"><tr><th>부위</th><th>이전</th><th>이번</th><th>변화</th></tr>
    ${c.diffs.map((d) => `<tr><td>${d.label}</td><td>${d.from}%</td><td>${d.to}%</td><td class="delta ${d.d < 0 ? "neg" : d.d > 0 ? "pos" : ""}">${d.d > 0 ? "+" : ""}${d.d}%p</td></tr>`).join("")}</table>
    ${pp != null && np != null ? `<div>통증 ${pp} → ${np} <span class="muted">(설문 기준)</span></div>` : ""}
    <div class="muted">기준: 부담 자세 비율 10%p 이상 감소=개선, ±10%p=유지, 10%p 이상 증가=악화</div></div>`;
}

function viewDone() {
  return `<div class="card"><h2>자가 관리를 계속해요</h2>
    <p>병원 연계 없이 자세 개선을 이어가요. 언제든 결과 화면에서 병원 연계를 선택할 수 있어요.</p>
    <ul><li>같은 자세를 오래 유지하지 말고 50분마다 1~2분 스트레칭하세요.</li><li>허리를 숙이는 작업은 작업대 높이를 조정해 보세요.</li><li>통증·저림이 심해지면 의료진 상담을 받으세요.</li></ul>
    <label class="row"><input type="checkbox" id="remind" ${state.reminder ? "checked" : ""}> 2주 뒤 재촬영 알림 받기${state.reminder ? ` (${state.reminder})` : ""}</label></div>
  <button class="btn" id="restart">재설문 + 새 영상으로 경과 비교</button>
  <button class="btn ghost" id="back">결과로 돌아가기</button>`;
}

function viewHospital() {
  const j = state.judged;
  const list = filterAndSortHospitals(HOSPITALS, state.filters, state.sort, { recommendedDepartment: j.recommendedDepartment, preferences: state.filters });
  return `
  <div class="card"><b>추천 진료과: ${esc(j.recommendedDepartment)}</b><div class="muted">병원 전송은 항상 본인이 선택해요. 병원 정보는 예시예요.</div>
    <div class="chips">${[["night", "야간"], ["weekend", "주말"], ["english", "외국어"]].map(([k, l]) => `<button class="chip ${state.filters[k] ? "on" : ""}" data-filter="${k}">${l}</button>`).join("")}</div>
    <select id="sort">${[["recommend", "추천순"], ["distance", "거리순"], ["popular", "인기순 (준비 중)"]].map(([v, l]) => `<option value="${v}" ${state.sort === v ? "selected" : ""}>${l}</option>`).join("")}</select>
    <details><summary class="muted">어떻게 정렬되나요?</summary><div class="muted">${SORT_EXPLAIN.recommend}<br>${SORT_EXPLAIN.popular}<br>${SORT_EXPLAIN.distance}<br>광고 순위는 없어요.</div></details></div>
  ${list.map((h) => `<div class="card hosp"><div><b>${esc(h.name)}</b><div class="muted">${h.department} · ${h.region} · ${h.distanceKm}km${h.night ? " · 야간" : ""}${h.weekend ? " · 주말" : ""}${h.english ? " · 외국어" : ""}</div></div>
    <button class="chip" data-send="${h.id}">요약 보내기</button></div>`).join("") || `<div class="info">조건에 맞는 병원이 없어요.</div>`}
  <button class="btn ghost" id="nolink">연계하지 않을래요</button>
  <button class="btn ghost" id="back">결과로 돌아가기</button>`;
}

const SUM_FIELDS = [["riskLevel", "위험도 등급"], ["bodyRegion", "부담 부위"], ["taskType", "작업 종류"], ["changeVsPrevious", "이전 영상 대비 변화"], ["painScore", "통증 정도·설문 (선택)"]];

function openSummary(hid) {
  const h = HOSPITALS.find((x) => x.id === hid), a = state.analysis;
  const record = { analysis: a, level: state.judged.level, regions: [...new Set([...state.judged.findings.map((f) => f.label), ...state.survey.regions.map((k) => labelOf(REGIONS, k))])], taskType: state.taskType, painScore: state.survey.pain };
  let fields = ["riskLevel", "bodyRegion", "taskType"];
  const m = $("#modal"); m.hidden = false;
  const draw = () => {
    const summary = buildSummary(record, state.comparison, fields);
    m.innerHTML = `<div><h3>${esc(h.name)}에 보낼 요약</h3><div class="muted">보낼 항목을 직접 고르세요.</div>
      ${SUM_FIELDS.map(([k, l]) => `<label class="row"><input type="checkbox" data-f="${k}" ${fields.includes(k) ? "checked" : ""}> ${l}</label>`).join("")}
      <pre class="pre">${esc(JSON.stringify(summary, null, 2))}</pre>
      <div class="info">원본 영상·프레임은 포함되지 않아요. 지금은 시뮬레이션이라 실제로 전송되지 않아요.</div>
      <button class="btn" id="ok">내가 확인했고, 선택한 병원으로 보냅니다</button><button class="btn ghost" id="no">취소</button></div>`;
    m.querySelectorAll("[data-f]").forEach((c) => (c.onchange = () => { fields = SUM_FIELDS.map((x) => x[0]).filter((k) => (k === c.dataset.f ? c.checked : fields.includes(k))); draw(); }));
    $("#no").onclick = () => (m.hidden = true);
    $("#ok").onclick = () => {
      const res = simulateSubmit(buildPayload({ assessmentId: a.assessmentId, hospitalId: hid, summary, userClicked: true }));
      m.innerHTML = `<div><h3>${res.status === 200 ? "전송 시뮬레이션 완료" : "전송 실패"}</h3>
        <p><span class="badge sim">SIMULATED</span> 실제 병원으로 전송되지 않았어요.</p><button class="btn" id="done">닫기</button></div>`;
      $("#done").onclick = () => (m.hidden = true);
    };
  };
  draw();
}

async function onFile(e) {
  const file = e.target.files[0]; if (!file) return;
  state.errors = [];
  let duration = 0;
  try { duration = await readVideoDuration(file); } catch (err) { state.errors = [err.message]; return render(); }
  const v = validateVideoMeta({ type: file.type, size: file.size, duration }, state.consent);
  if (!v.valid) { state.errors = v.errors; return render(); }
  state.busy = true; state.progress = 0; render();
  try {
    const a = await analyzeVideo(file, { canvas: $("#view"), onProgress: (p) => { state.progress = p; const el = document.querySelector("progress"); if (el) el.value = p; } });
    state.busy = false; finish(a);
  } catch (err) { state.busy = false; state.errors = [err.message]; render(); }
}

function bind() {
  const tog = (arr, k) => (arr.includes(k) ? arr.filter((x) => x !== k) : [...arr, k]);
  document.querySelectorAll("[data-sreg]").forEach((b) => (b.onclick = () => { state.survey.regions = tog(state.survey.regions, b.dataset.sreg); render(); }));
  document.querySelectorAll("[data-swarn]").forEach((b) => (b.onclick = () => { state.survey.warnings = tog(state.survey.warnings, b.dataset.swarn); render(); }));
  document.querySelectorAll("[data-spain]").forEach((b) => (b.onclick = () => { state.survey.pain = Number(b.dataset.spain); render(); }));
  document.querySelectorAll("[data-sonset]").forEach((b) => (b.onclick = () => { state.survey.onset = b.dataset.sonset; render(); }));
  document.querySelectorAll("[data-sfreq]").forEach((b) => (b.onclick = () => { state.survey.freq = b.dataset.sfreq; render(); }));
  document.querySelectorAll("[data-streat]").forEach((b) => (b.onclick = () => { state.survey.treatment = b.dataset.streat; render(); }));
  document.querySelectorAll("[data-simp]").forEach((b) => (b.onclick = () => { state.survey.impacts = tog(state.survey.impacts, b.dataset.simp); render(); }));
  document.querySelectorAll("[data-spref]").forEach((b) => (b.onclick = () => { state.survey.prefs = tog(state.survey.prefs, b.dataset.spref); render(); }));
  const sn = $("#surveyNext");
  if (sn) sn.onclick = () => {
    const v = validateQuestionnaire(readQuestionnaire(state.survey), state.sstep); state.surveyErr = v.errors;
    if (!v.valid) return render();
    if (state.sstep < 2) { state.sstep++; render(); window.scrollTo(0, 0); } else go("upload");
  };
  const sp = $("#surveyPrev"); if (sp) sp.onclick = () => { state.sstep--; state.surveyErr = []; render(); };
  const ts = $("#toSurvey"); if (ts) ts.onclick = () => { state.sstep = 1; go("survey"); };
  const wt = $("#taskType"); if (wt) wt.onchange = () => (state.taskType = wt.value);
  const nolink = $("#nolink"); if (nolink) nolink.onclick = () => { state.screen = "done"; render(); window.scrollTo(0, 0); };
  const rem = $("#remind"); if (rem) rem.onchange = () => {
    state.reminder = rem.checked ? new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10) : "";
    localStorage.setItem("linkmedi.reminder", state.reminder); render();
  };
  const restart = $("#restart"); if (restart) restart.onclick = () => { state.survey = newSurvey(); state.sstep = 1; state.analysis = null; go("survey"); };
  const authGo = $("#authGo");
  if (authGo) {
    const submit = async () => {
      const id = $("#uid").value.trim(), pin = $("#pin").value, users = readUsers();
      if (!/^[A-Za-z0-9]{3,}$/.test(id) || pin.length < 4) { state.loginErr = "아이디(영문/숫자 3자↑)와 비밀번호(4자↑)를 확인해 주세요."; return render(); }
      const h = await hashPin(id, pin);
      if (state.signup) {
        if (users[id]) { state.loginErr = "이미 있는 아이디예요."; return render(); }
        users[id] = h; localStorage.setItem(USERS, JSON.stringify(users));
      } else if (users[id] !== h) { state.loginErr = "아이디 또는 비밀번호가 맞지 않아요."; return render(); }
      localStorage.setItem(SESSION, id); state.user = id; state.loginErr = ""; go("survey");
    };
    authGo.onclick = submit;
    $("#pin").onkeydown = (e) => { if (e.key === "Enter") submit(); };
    $("#authSwitch").onclick = () => { state.signup = !state.signup; state.loginErr = ""; render(); };
    $("#guest").onclick = () => { state.user = "게스트"; go("survey"); };
  }
  document.querySelectorAll("[data-mode]").forEach((b) => (b.onclick = async () => { await stopCam(); state.mode = b.dataset.mode; state.errors = []; render(); }));
  const consent = $("#consent"); if (consent) consent.onchange = () => (state.consent = consent.checked);
  const file = $("#file"); if (file) file.onchange = onFile;
  document.querySelectorAll("[data-sample]").forEach((b) => (b.onclick = () => finish(analyzeFrames(SAMPLES[b.dataset.sample].frames(), { sample: true }))));
  const camOn = $("#camOn");
  if (camOn) camOn.onclick = async () => {
    if (!state.consent) { state.errors = ["민감 건강정보 처리에 동의해 주세요."]; return render(); }
    state.errors = [];
    try { state.cam = await startCamera($("#cam"), $("#view")); render(); }
    catch (err) { state.errors = [err.message || "카메라를 사용할 수 없어요."]; render(); }
  };
  const recStart = $("#recStart");
  if (recStart) recStart.onclick = () => {
    state.cam.startRecording(); state.recording = true; state.recSec = 0; render();
    timer = setInterval(() => {
      state.recSec++;
      const info = $("#recInfo"); if (info) info.textContent = `촬영 중… ${state.recSec}초 (10~30초)`;
      const stop = $("#recStop"); if (stop && state.recSec >= 10) stop.disabled = false;
      if (state.recSec >= 30) stop?.click();
    }, 1000);
  };
  const recStop = $("#recStop");
  if (recStop) recStop.onclick = async () => {
    const a = state.cam.finishRecording(); await stopCam(); finish(a);
  };
  const toHosp = $("#toHosp"); if (toHosp) toHosp.onclick = () => go("hospital");
  const again = $("#again"); if (again) again.onclick = () => { state.errors = []; go("upload"); };
  const back = $("#back"); if (back) back.onclick = () => go("result");
  document.querySelectorAll("[data-filter]").forEach((b) => (b.onclick = () => { state.filters[b.dataset.filter] = !state.filters[b.dataset.filter]; render(); }));
  const sort = $("#sort"); if (sort) sort.onchange = () => { state.sort = sort.value; render(); };
  document.querySelectorAll("[data-send]").forEach((b) => (b.onclick = () => openSummary(b.dataset.send)));
}

render();



