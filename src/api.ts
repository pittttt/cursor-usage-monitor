import * as https from "https";
import * as vscode from "vscode";

export interface CombinedUsageData {
  /** Monthly usage in dollars */
  monthlyUsageDollars: number;
  /** Monthly usage limit in dollars */
  monthlyLimitDollars: number;
  /** Usage percentage: monthlyUsageDollars / monthlyLimitDollars * 100 */
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

function httpsRequest(
  url: string,
  token: string,
  method: "GET" | "POST" = "GET",
  body?: Record<string, unknown>,
  maxRedirects = 5
): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options: https.RequestOptions = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method,
      headers: {
        "Content-Type": "application/json",
        Cookie: `WorkosCursorSessionToken=${token}`,
        Origin: "https://cursor.com",
        Referer: "https://cursor.com/dashboard",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "*/*",
        "Accept-Language": "en",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
      },
    };

    const req = https.request(options, (res) => {
      // HTTP-level redirect (301, 302, 307, 308)
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (maxRedirects <= 0) {
          reject(new Error("重定向次数过多"));
          return;
        }
        log(`HTTP ${res.statusCode} 重定向: ${res.headers.location}`);
        res.resume();
        httpsRequest(res.headers.location, token, method, body, maxRedirects - 1)
          .then(resolve)
          .catch(reject);
        return;
      }

      let data = "";
      res.on("data", (chunk: Buffer) => {
        data += chunk.toString();
      });
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(
            new Error(`API 状态码 ${res.statusCode}: ${data}`)
          );
          return;
        }

        // Handle Cursor's JSON-body redirect
        try {
          const parsed = JSON.parse(data);
          if (parsed.redirect && (parsed.status === "308" || parsed.status === 308)) {
            if (maxRedirects <= 0) {
              reject(new Error("重定向次数过多"));
              return;
            }
            log(`JSON 重定向: ${parsed.redirect}`);
            httpsRequest(parsed.redirect, token, method, body, maxRedirects - 1)
              .then(resolve)
              .catch(reject);
            return;
          }
        } catch {
          // not JSON, continue normally
        }

        resolve(data);
      });
    });

    req.on("error", (err) => reject(new Error(`网络请求失败: ${err.message}`)));
    req.setTimeout(15000, () => {
      req.destroy(new Error("请求超时"));
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

function extractUserId(token: string): string {
  const decoded = decodeURIComponent(token);
  const separatorIndex = decoded.indexOf("::");
  if (separatorIndex > 0) {
    return decoded.substring(0, separatorIndex);
  }
  return token.split("%3A%3A")[0] || token;
}

export async function fetchCombinedUsage(
  token: string
): Promise<CombinedUsageData> {
  const userId = extractUserId(token);
  log(`userId: ${userId.substring(0, 12)}...`);

  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();

  // Fetch all APIs in parallel
  const [usageBody, invoiceBody, summaryBody, hardLimitBody] = await Promise.all([
    httpsRequest(
      `https://cursor.com/api/usage?user=${encodeURIComponent(userId)}`,
      token
    ).catch((err) => {
      log(`[usage] 失败: ${err.message}`);
      return null;
    }),
    httpsRequest(
      "https://cursor.com/api/dashboard/get-monthly-invoice",
      token,
      "POST",
      { month: currentMonth, year: currentYear, includeUsageEvents: false }
    ).catch((err) => {
      log(`[invoice] 失败: ${err.message}`);
      return null;
    }),
    httpsRequest(
      "https://cursor.com/api/usage-summary",
      token
    ).catch((err) => {
      log(`[summary] 失败: ${err.message}`);
      return null;
    }),
    httpsRequest(
      "https://cursor.com/api/dashboard/get-hard-limit",
      token,
      "POST",
      {}
    ).catch((err) => {
      log(`[hard-limit] 失败: ${err.message}`);
      return null;
    }),
  ]);

  log(`[usage] 响应: ${usageBody ?? "null"}`);
  log(`[invoice] 响应: ${invoiceBody ?? "null"}`);
  log(`[summary] 响应: ${summaryBody ?? "null"}`);
  log(`[hard-limit] 响应: ${hardLimitBody ?? "null"}`);

  // --- Parse usage (request counts) ---
  let premiumUsed = 0;
  let premiumLimit = 500;
  let billingStart = "";

  if (usageBody) {
    try {
      const usage = JSON.parse(usageBody);
      const gpt4 = usage["gpt-4"] ?? {};
      premiumUsed = gpt4.numRequests ?? 0;
      premiumLimit = gpt4.maxRequestUsage ?? 500;
      billingStart = usage.startOfMonth ?? "";
      log(`[usage] 解析: requests=${premiumUsed}/${premiumLimit}, start=${billingStart}`);
    } catch (err) {
      log(`[usage] JSON 解析失败: ${err}`);
    }
  }

  // --- Parse usage-summary ---
  let monthlyUsageDollars = 0;
  let monthlyLimitDollars = 0;
  let billingEnd: string | undefined;

  if (summaryBody) {
    try {
      const summary = JSON.parse(summaryBody);

      // Log all top-level keys for debugging
      const topKeys = Object.keys(summary);
      log(`[summary] 顶层字段: ${JSON.stringify(topKeys)}`);
      for (const key of topKeys) {
        const val = summary[key];
        const str = typeof val === "object" ? JSON.stringify(val) : String(val);
        log(`[summary] ${key}: ${str.substring(0, 500)}`);
      }

      billingStart = billingStart || summary.billingCycleStart || summary.startOfMonth || "";
      billingEnd = summary.billingCycleEnd || summary.endOfMonth;

      // --- Strategy 1: New unified monthly usage format ---
      // Try top-level fields like monthlyUsage, usage, usedAmount, etc.
      const usedCandidates = [
        summary.monthlyUsage?.used,
        summary.usage?.used,
        summary.usedAmount,
        summary.used,
        summary.totalUsed,
        summary.currentUsage,
      ];
      const limitCandidates = [
        summary.monthlyUsage?.limit,
        summary.monthlyUsage?.budget,
        summary.usage?.limit,
        summary.usage?.budget,
        summary.limit,
        summary.budget,
        summary.totalLimit,
        summary.monthlyBudget,
      ];

      for (const v of usedCandidates) {
        if (typeof v === "number" && v > 0) {
          monthlyUsageDollars = v > 100 ? v / 100 : v;
          log(`[summary] 从顶层候选字段找到 used: ${v}`);
          break;
        }
      }
      for (const v of limitCandidates) {
        if (typeof v === "number" && v > 0) {
          monthlyLimitDollars = v > 100 ? v / 100 : v;
          log(`[summary] 从顶层候选字段找到 limit: ${v}`);
          break;
        }
      }

      // --- Strategy 2: individualUsage ---
      const individual = summary.individualUsage;
      if (individual && monthlyUsageDollars === 0) {
        const iKeys = Object.keys(individual);
        log(`[summary] individualUsage 字段: ${JSON.stringify(iKeys)}`);
        for (const key of iKeys) {
          log(`[summary] individualUsage.${key}: ${JSON.stringify(individual[key])}`);
        }

        // New format: individualUsage.overall (2026+)
        if (individual.overall) {
          const usedCents = individual.overall.used ?? 0;
          const limitCents = individual.overall.limit ?? 0;
          monthlyUsageDollars = usedCents / 100;
          monthlyLimitDollars = limitCents / 100;
          log(`[summary] individualUsage.overall: used=$${monthlyUsageDollars}, limit=$${monthlyLimitDollars}`);
        }

        // Fallback: direct used/limit on individualUsage
        if (monthlyUsageDollars === 0 && (individual.used !== undefined || individual.limit !== undefined)) {
          const usedCents = individual.used ?? 0;
          const limitCents = individual.limit ?? 0;
          monthlyUsageDollars = usedCents > 100 ? usedCents / 100 : usedCents;
          monthlyLimitDollars = limitCents > 100 ? limitCents / 100 : limitCents;
          log(`[summary] individualUsage 直接字段: used=$${monthlyUsageDollars}, limit=$${monthlyLimitDollars}`);
        }

        // Old plan-based format
        if (monthlyUsageDollars === 0 && individual.plan) {
          const planUsedCents = individual.plan.used ?? 0;
          const breakdown = individual.plan.breakdown;
          monthlyUsageDollars = planUsedCents / 100;
          monthlyLimitDollars = (individual.plan.limit ?? breakdown?.included ?? 0) / 100;

          if (individual.onDemand) {
            monthlyUsageDollars += (individual.onDemand.used ?? 0) / 100;
          }
          if (individual.usageBased) {
            if ((individual.onDemand?.used ?? 0) === 0) {
              monthlyUsageDollars += (individual.usageBased.used ?? 0) / 100;
            }
          }
        }
      }

      // --- Strategy 3: teamUsage ---
      const team = summary.teamUsage;
      if (team) {
        log(`[summary] teamUsage: ${JSON.stringify(team)}`);
        if (monthlyUsageDollars === 0 && team.used !== undefined) {
          monthlyUsageDollars = team.used > 100 ? team.used / 100 : team.used;
          monthlyLimitDollars = (team.limit ?? team.budget ?? 0);
          if (monthlyLimitDollars > 100) {
            monthlyLimitDollars = monthlyLimitDollars / 100;
          }
        }
      }

      // --- Strategy 4: Fallback old top-level ---
      if (monthlyUsageDollars === 0) {
        const rawIncluded = summary.includedUsage ?? summary.planUsage ?? 0;
        const rawOnDemand = summary.onDemandUsage ?? summary.additionalUsage ?? 0;
        const inc = rawIncluded > 100 ? rawIncluded / 100 : rawIncluded;
        const ond = rawOnDemand > 100 ? rawOnDemand / 100 : rawOnDemand;
        monthlyUsageDollars = inc + ond;
      }

      log(`[summary] 解析: usage=$${monthlyUsageDollars}, limit=$${monthlyLimitDollars}`);
    } catch (err) {
      log(`[summary] JSON 解析失败: ${err}`);
    }
  }

  // Override limit from hard-limit API if we still don't have one
  if (hardLimitBody && monthlyLimitDollars === 0) {
    try {
      const hardLimit = JSON.parse(hardLimitBody);
      log(`[hard-limit] 响应: ${JSON.stringify(hardLimit)}`);
      const apiLimit = hardLimit.hardLimit ?? hardLimit.limit ?? 0;
      if (apiLimit > 0) {
        monthlyLimitDollars = apiLimit;
      }
    } catch (err) {
      log(`[hard-limit] JSON 解析失败: ${err}`);
    }
  }

  // --- Parse monthly invoice (fallback + detail) ---
  const invoiceItems: Array<{ description: string; dollars: number }> = [];

  if (invoiceBody) {
    try {
      const invoice = JSON.parse(invoiceBody);

      // Use periodStartMs as the reset date (matches dashboard "Resets" exactly)
      const periodStartMs = Number(invoice.periodStartMs);
      if (periodStartMs > 0) {
        const resetDate = new Date(periodStartMs);
        billingEnd = resetDate.toISOString();
        log(`[invoice] periodStartMs=${periodStartMs} → billingEnd=${billingEnd}`);
      }

      let totalInvoiceCents = 0;
      if (invoice.items && Array.isArray(invoice.items)) {
        for (const item of invoice.items) {
          if (typeof item.cents !== "number") {
            continue;
          }
          if (item.description?.includes("Mid-month usage paid")) {
            continue;
          }
          invoiceItems.push({
            description: item.description ?? "",
            dollars: item.cents / 100,
          });
          totalInvoiceCents += item.cents;
        }
      }

      if (monthlyUsageDollars === 0 && totalInvoiceCents > 0) {
        monthlyUsageDollars = totalInvoiceCents / 100;
        log(`[invoice] 使用 invoice 作为 monthlyUsage: $${monthlyUsageDollars}`);
      }
    } catch (err) {
      log(`[invoice] JSON 解析失败: ${err}`);
    }
  }

  // --- Calculate percentage ---
  const usagePercent = monthlyLimitDollars > 0
    ? (monthlyUsageDollars / monthlyLimitDollars) * 100
    : 0;

  log(`最终结果: usage=$${monthlyUsageDollars}/$${monthlyLimitDollars} (${usagePercent.toFixed(1)}%)`);

  return {
    monthlyUsageDollars,
    monthlyLimitDollars,
    usagePercent,
    premiumRequestsUsed: premiumUsed,
    premiumRequestsLimit: premiumLimit,
    billingStart,
    billingEnd,
    invoiceItems,
    updatedAt: new Date(),
  };
}
