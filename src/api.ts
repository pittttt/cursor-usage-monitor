import * as vscode from "vscode";
import { execSync } from "child_process";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";

export interface CombinedUsageData {
  monthlyUsageDollars: number;
  monthlyLimitDollars: number;
  usagePercent: number;
  premiumRequestsUsed: number;
  premiumRequestsLimit: number;
  billingStart: string;
  billingEnd?: string;
  invoiceItems: Array<{ description: string; dollars: number }>;
  updatedAt: Date;
}

let outputChannel: vscode.OutputChannel | undefined;

function getOutputChannel(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel("Cursor Usage Monitor");
  }
  return outputChannel;
}

function log(message: string): void {
  getOutputChannel().appendLine(`[${new Date().toLocaleTimeString("zh-CN")}] ${message}`);
}

// ---- Auth ----

function getStateDbPath(): string {
  const platform = process.platform;
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
  } else if (platform === "win32") {
    return path.join(process.env.APPDATA || "", "Cursor", "User", "globalStorage", "state.vscdb");
  }
  return path.join(os.homedir(), ".config", "Cursor", "User", "globalStorage", "state.vscdb");
}

function readDbKey(key: string): string | null {
  const dbPath = getStateDbPath();
  if (!fs.existsSync(dbPath)) {
    return null;
  }
  try {
    return execSync(
      `sqlite3 "${dbPath}" "SELECT value FROM ItemTable WHERE key = '${key}' LIMIT 1"`,
      { encoding: "utf-8", timeout: 5000 }
    ).trim() || null;
  } catch {
    return null;
  }
}

function extractUserIdFromJwt(jwt: string): string {
  try {
    const payload = jwt.split(".")[1];
    let padded = payload;
    while (padded.length % 4 !== 0) {
      padded += "=";
    }
    const decoded = JSON.parse(Buffer.from(padded, "base64").toString("utf-8"));
    const sub = decoded.sub as string;
    const parts = sub.split("|");
    return parts[parts.length - 1];
  } catch {
    return "";
  }
}

function getJwtExpiry(jwt: string): Date | null {
  try {
    const payload = jwt.split(".")[1];
    let padded = payload;
    while (padded.length % 4 !== 0) {
      padded += "=";
    }
    const decoded = JSON.parse(Buffer.from(padded, "base64").toString("utf-8"));
    return decoded.exp ? new Date(decoded.exp * 1000) : null;
  } catch {
    return null;
  }
}

export function getValidAccessToken(): { jwt: string; sessionCookie: string } | null {
  const accessToken = readDbKey("cursorAuth/accessToken");
  if (!accessToken) {
    log("[auth] 无法读取 access token");
    return null;
  }

  const expiry = getJwtExpiry(accessToken);
  if (expiry && expiry.getTime() < Date.now()) {
    log(`[auth] Token 已过期 (${expiry.toLocaleDateString("zh-CN")})，等待 Cursor 自动刷新...`);
    vscode.window.showWarningMessage(
      "Cursor Usage Monitor: Token 已过期，请重启 Cursor 或重新登录以刷新 Token。"
    );
    return null;
  }

  if (expiry) {
    const daysLeft = Math.ceil((expiry.getTime() - Date.now()) / 86400000);
    log(`[auth] Token 有效期至 ${expiry.toLocaleDateString("zh-CN")}（剩余 ${daysLeft} 天）`);
  }

  const userId = extractUserIdFromJwt(accessToken);
  if (!userId) {
    log("[auth] 无法从 token 中提取 userId");
    return null;
  }

  const sessionCookie = `WorkosCursorSessionToken=${userId}::${accessToken}`;
  log(`[auth] userId: ${userId.substring(0, 12)}...`);
  return { jwt: accessToken, sessionCookie };
}

// ---- Fetch helpers ----

async function fetchJson<T>(url: string, cookie: string, timeoutMs = 8000): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url, {
      headers: {
        Cookie: cookie,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    });

    if (!resp.ok) {
      log(`[fetch] ${url} → ${resp.status}`);
      return null;
    }

    const text = await resp.text();
    if (text.includes("Vercel Security Checkpoint") || text.includes("<!DOCTYPE html>")) {
      log(`[fetch] ${url} → Vercel checkpoint blocked`);
      return null;
    }

    return JSON.parse(text) as T;
  } catch (err) {
    log(`[fetch] ${url} → ${err instanceof Error ? err.message : err}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJsonBearer<T>(url: string, jwt: string, method = "GET", body?: unknown, timeoutMs = 8000): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${jwt}`,
    "Content-Type": "application/json",
  };
  if (method === "POST") {
    headers["Connect-Protocol-Version"] = "1";
  }

  try {
    const resp = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    if (!resp.ok) {
      log(`[fetch] ${url} → ${resp.status}`);
      return null;
    }

    return (await resp.json()) as T;
  } catch (err) {
    log(`[fetch] ${url} → ${err instanceof Error ? err.message : err}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---- Types ----

interface UsageSummary {
  billingCycleStart?: string;
  billingCycleEnd?: string;
  membershipType?: string;
  individualUsage?: {
    overall?: { enabled?: boolean; used?: number; limit?: number };
    onDemand?: { enabled?: boolean; used?: number; limit?: number };
    plan?: { used?: number; limit?: number; breakdown?: { total?: number } };
  };
  teamUsage?: Record<string, unknown>;
}

interface PlanInfo {
  planInfo?: {
    planName?: string;
    price?: string;
    billingCycleEnd?: string;
  };
}

// ---- Disk cache ----

let cachedData: CombinedUsageData | null = null;
let cacheFilePath: string | undefined;

export function initCacheDir(storagePath: string): void {
  if (!fs.existsSync(storagePath)) {
    fs.mkdirSync(storagePath, { recursive: true });
  }
  cacheFilePath = path.join(storagePath, "usage-cache.json");
  loadCacheFromDisk();
}

function loadCacheFromDisk(): void {
  if (!cacheFilePath || !fs.existsSync(cacheFilePath)) {
    return;
  }
  try {
    const raw = fs.readFileSync(cacheFilePath, "utf-8");
    const obj = JSON.parse(raw);
    obj.updatedAt = new Date(obj.updatedAt);
    cachedData = obj as CombinedUsageData;
    log(`[cache] 从磁盘加载缓存 (${cachedData.updatedAt.toLocaleString("zh-CN")})`);
  } catch {
    log("[cache] 读取磁盘缓存失败");
  }
}

function saveCacheToDisk(data: CombinedUsageData): void {
  if (!cacheFilePath) {
    return;
  }
  try {
    fs.writeFileSync(cacheFilePath, JSON.stringify(data), "utf-8");
    log("[cache] 已写入磁盘缓存");
  } catch {
    log("[cache] 写入磁盘缓存失败");
  }
}

// ---- Core fetch ----

function parseSummary(summary: UsageSummary): CombinedUsageData {
  let monthlyUsageDollars = 0;
  let monthlyLimitDollars = 0;

  const billingStart = summary.billingCycleStart ?? "";
  const now = new Date();
  const billingEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();

  const individual = summary.individualUsage;
  if (individual) {
    if (individual.overall && individual.overall.enabled) {
      monthlyUsageDollars = (individual.overall.used ?? 0) / 100;
      monthlyLimitDollars = (individual.overall.limit ?? 0) / 100;
      log(`[summary] overall: $${monthlyUsageDollars}/$${monthlyLimitDollars}`);
    }

    if (monthlyUsageDollars === 0 && individual.onDemand && individual.onDemand.enabled) {
      monthlyUsageDollars = (individual.onDemand.used ?? 0) / 100;
      if (monthlyLimitDollars === 0) {
        monthlyLimitDollars = (individual.onDemand.limit ?? 0) / 100;
      }
      log(`[summary] onDemand: $${monthlyUsageDollars}/$${monthlyLimitDollars}`);
    }

    if (monthlyUsageDollars === 0 && individual.plan) {
      monthlyUsageDollars = (individual.plan.used ?? 0) / 100;
      if (monthlyLimitDollars === 0) {
        monthlyLimitDollars = (individual.plan.limit ?? individual.plan.breakdown?.total ?? 0) / 100;
      }
      log(`[summary] plan: $${monthlyUsageDollars}/$${monthlyLimitDollars}`);
    }
  }

  const usagePercent = monthlyLimitDollars > 0 ? (monthlyUsageDollars / monthlyLimitDollars) * 100 : 0;

  return {
    monthlyUsageDollars,
    monthlyLimitDollars,
    usagePercent,
    premiumRequestsUsed: 0,
    premiumRequestsLimit: 0,
    billingStart,
    billingEnd,
    invoiceItems: [],
    updatedAt: new Date(),
  };
}

export async function fetchCoreUsage(
  jwt: string,
  sessionCookie: string
): Promise<CombinedUsageData> {
  log("[fetch] 开始获取数据...");

  // 始终并行获取 GetPlanInfo（用于 reset 时间，该接口稳定可用）
  const [summary, planInfo] = await Promise.all([
    fetchJson<UsageSummary>(
      "https://cursor.com/api/usage-summary",
      sessionCookie
    ),
    fetchJsonBearer<PlanInfo>(
      "https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo",
      jwt, "POST", {}
    ),
  ]);

  // Reset 时间：usage-summary 可用时用真实值，否则用下月1号
  let fallbackBillingEnd: string;
  const now = new Date();
  const nextMonth1st = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  fallbackBillingEnd = nextMonth1st.toISOString();

  if (planInfo?.planInfo) {
    log(`[planInfo] ${planInfo.planInfo.planName}`);
  }

  if (summary) {
    log(`[summary] 成功: ${JSON.stringify(summary).substring(0, 600)}`);
    const result = parseSummary(summary);
    if (!result.billingEnd) {
      result.billingEnd = fallbackBillingEnd;
    }
    cachedData = result;
    saveCacheToDisk(result);
    log(`结果: $${result.monthlyUsageDollars}/$${result.monthlyLimitDollars} (${result.usagePercent.toFixed(1)}%)`);
    return result;
  }

  // API 失败：优先使用缓存，补充最新 reset 时间
  if (cachedData) {
    log("[summary] API 不可用，使用缓存数据（上次更新: " +
      cachedData.updatedAt.toLocaleTimeString("zh-CN") + "）");
    return {
      ...cachedData,
      billingEnd: cachedData.billingEnd ?? fallbackBillingEnd,
      updatedAt: cachedData.updatedAt,
    };
  }

  // 无缓存：只显示 reset 时间
  log("[summary] API 不可用且无缓存");
  return {
    monthlyUsageDollars: 0,
    monthlyLimitDollars: 0,
    usagePercent: 0,
    premiumRequestsUsed: 0,
    premiumRequestsLimit: 0,
    billingStart: "",
    billingEnd: fallbackBillingEnd,
    invoiceItems: [],
    updatedAt: new Date(),
  };
}

// Phase 2: invoice items (background)
export async function fetchSupplementalUsage(
  sessionCookie: string,
  existing: CombinedUsageData
): Promise<CombinedUsageData> {
  const now = new Date();
  log("[phase2] 获取账单明细...");

  const invoice = await fetchJson<{ items?: Array<{ description?: string; cents?: number }> }>(
    "https://cursor.com/api/dashboard/get-monthly-invoice",
    sessionCookie
  );

  // Can't POST with fetchJson, so this might not work; just return existing
  if (!invoice?.items) {
    return existing;
  }

  const invoiceItems: Array<{ description: string; dollars: number }> = [];
  for (const item of invoice.items) {
    if (typeof item.cents !== "number" || item.description?.includes("Mid-month usage paid")) {
      continue;
    }
    invoiceItems.push({
      description: item.description ?? "",
      dollars: item.cents / 100,
    });
  }
  log(`[invoice] ${invoiceItems.length} 项账单明细`);

  return {
    ...existing,
    invoiceItems: invoiceItems.length > 0 ? invoiceItems : existing.invoiceItems,
    updatedAt: new Date(),
  };
}
