import * as vscode from "vscode";
import { fetchCombinedUsage } from "./api";
import { UsageStatusBarItem } from "./statusBar";
import { UsageTreeDataProvider } from "./usageView";

const TOKEN_SECRET_KEY = "cursorUsageMonitor.token";

let statusBarItem: UsageStatusBarItem | undefined;
let treeDataProvider: UsageTreeDataProvider | undefined;
let refreshTimer: ReturnType<typeof setInterval> | undefined;

async function getToken(
  context: vscode.ExtensionContext
): Promise<string | undefined> {
  return context.secrets.get(TOKEN_SECRET_KEY);
}

async function setToken(
  context: vscode.ExtensionContext,
  token: string
): Promise<void> {
  await context.secrets.store(TOKEN_SECRET_KEY, token);
}

async function promptForToken(context: vscode.ExtensionContext): Promise<boolean> {
  const tokenGuide = [
    "获取 Token 方法：",
    "1. 在浏览器中登录 cursor.com",
    '2. 打开开发者工具 → Application → Cookies',
    '3. 找到 "WorkosCursorSessionToken" 的值',
    "4. 复制完整的 Token 值粘贴到下方",
  ].join("\n");

  const token = await vscode.window.showInputBox({
    title: "设置 Cursor Session Token",
    prompt: tokenGuide,
    placeHolder: "粘贴你的 WorkosCursorSessionToken 值",
    password: true,
    ignoreFocusOut: true,
  });

  if (token && token.trim()) {
    await setToken(context, token.trim());
    vscode.window.showInformationMessage("Cursor Token 已保存，正在获取用量数据...");
    return true;
  }
  return false;
}

async function refresh(context: vscode.ExtensionContext): Promise<void> {
  const token = await getToken(context);

  if (!token) {
    statusBarItem?.setNoToken();
    treeDataProvider?.setError("未配置 Token，请先设置");
    return;
  }

  statusBarItem?.setLoading();
  treeDataProvider?.setLoading();

  try {
    const data = await fetchCombinedUsage(token);
    statusBarItem?.setData(data);
    treeDataProvider?.setData(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    statusBarItem?.setError(message);
    treeDataProvider?.setError(message);
  }
}

function startAutoRefresh(context: vscode.ExtensionContext): void {
  stopAutoRefresh();

  const config = vscode.workspace.getConfiguration("cursorUsageMonitor");
  const intervalMinutes = config.get<number>("refreshInterval", 5);
  const intervalMs = intervalMinutes * 60 * 1000;

  refreshTimer = setInterval(() => {
    refresh(context);
  }, intervalMs);
}

function stopAutoRefresh(): void {
  if (refreshTimer !== undefined) {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  statusBarItem = new UsageStatusBarItem();
  context.subscriptions.push({ dispose: () => statusBarItem?.dispose() });

  treeDataProvider = new UsageTreeDataProvider();
  const treeView = vscode.window.createTreeView("cursorUsageView", {
    treeDataProvider,
    showCollapseAll: false,
  });
  context.subscriptions.push(treeView);

  const refreshCmd = vscode.commands.registerCommand(
    "cursorUsageMonitor.refresh",
    () => refresh(context)
  );
  context.subscriptions.push(refreshCmd);

  const setTokenCmd = vscode.commands.registerCommand(
    "cursorUsageMonitor.setToken",
    async () => {
      const saved = await promptForToken(context);
      if (saved) {
        refresh(context);
        startAutoRefresh(context);
      }
    }
  );
  context.subscriptions.push(setTokenCmd);

  const setThresholdCmd = vscode.commands.registerCommand(
    "cursorUsageMonitor.setThreshold",
    async () => {
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
        refresh(context);
      }
    }
  );
  context.subscriptions.push(setThresholdCmd);

  const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("cursorUsageMonitor.refreshInterval")) {
      startAutoRefresh(context);
    }
  });
  context.subscriptions.push(configListener);

  context.subscriptions.push({
    dispose: () => stopAutoRefresh(),
  });

  // 启动时检查 token，无 token 则提示用户输入
  getToken(context).then(async (token) => {
    if (!token) {
      statusBarItem?.setNoToken();
      treeDataProvider?.setError("未配置 Token，请先设置");
      const saved = await promptForToken(context);
      if (saved) {
        refresh(context);
        startAutoRefresh(context);
      }
    } else {
      refresh(context);
      startAutoRefresh(context);
    }
  });
}

export function deactivate(): void {
  stopAutoRefresh();
}
