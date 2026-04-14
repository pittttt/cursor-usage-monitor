import * as vscode from "vscode";
import { getValidAccessToken, fetchCoreUsage, fetchSupplementalUsage, initCacheDir } from "./api";
import { UsageStatusBarItem } from "./statusBar";
import { UsageTreeDataProvider } from "./usageView";

let statusBarItem: UsageStatusBarItem | undefined;
let treeDataProvider: UsageTreeDataProvider | undefined;
let refreshTimer: ReturnType<typeof setInterval> | undefined;

async function refresh(): Promise<void> {
  const auth = getValidAccessToken();

  if (!auth) {
    statusBarItem?.setError("无法读取 Token，请确认已登录 Cursor");
    treeDataProvider?.setError("无法读取 Token，请确认已登录 Cursor");
    return;
  }

  statusBarItem?.setLoading();
  treeDataProvider?.setLoading();

  try {
    const coreData = await fetchCoreUsage(auth.jwt, auth.sessionCookie);
    statusBarItem?.setData(coreData);
    treeDataProvider?.setData(coreData);

    // Background: fetch invoice items
    fetchSupplementalUsage(auth.sessionCookie, coreData).then((fullData) => {
      statusBarItem?.setData(fullData);
      treeDataProvider?.setData(fullData);
    }).catch(() => {});
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    statusBarItem?.setError(message);
    treeDataProvider?.setError(message);
  }
}

function startAutoRefresh(): void {
  stopAutoRefresh();

  const config = vscode.workspace.getConfiguration("cursorUsageMonitor");
  const intervalMinutes = config.get<number>("refreshInterval", 5);
  const intervalMs = intervalMinutes * 60 * 1000;

  refreshTimer = setInterval(() => {
    refresh();
  }, intervalMs);
}

function stopAutoRefresh(): void {
  if (refreshTimer !== undefined) {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  initCacheDir(context.globalStorageUri.fsPath);

  statusBarItem = new UsageStatusBarItem();
  context.subscriptions.push({ dispose: () => statusBarItem?.dispose() });

  treeDataProvider = new UsageTreeDataProvider();
  const treeView = vscode.window.createTreeView("cursorUsageView", {
    treeDataProvider,
    showCollapseAll: false,
  });
  context.subscriptions.push(treeView);

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorUsageMonitor.refresh", () => refresh())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorUsageMonitor.setToken", () => {
      vscode.window.showInformationMessage(
        "当前版本已支持自动读取 Token，无需手动设置。如显示异常，请确认已登录 Cursor。"
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorUsageMonitor.setThreshold", async () => {
      const config = vscode.workspace.getConfiguration("cursorUsageMonitor");
      const current = config.get<number>("warningThreshold", 85);

      const input = await vscode.window.showInputBox({
        title: "设置用量告警阈值",
        prompt: `当前阈值: ${current}%，输入新的阈值（0-100）`,
        placeHolder: "例如: 85",
        value: String(current),
        validateInput: (v) => {
          const n = Number(v);
          if (isNaN(n) || n < 0 || n > 100) {
            return "请输入 0 到 100 之间的数字";
          }
          return undefined;
        },
      });

      if (input !== undefined) {
        await config.update("warningThreshold", Number(input), vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`告警阈值已设置为 ${input}%`);
        refresh();
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("cursorUsageMonitor.refreshInterval")) {
        startAutoRefresh();
      }
    })
  );

  context.subscriptions.push({ dispose: () => stopAutoRefresh() });

  // Start immediately
  refresh();
  startAutoRefresh();
}

export function deactivate(): void {
  stopAutoRefresh();
}
