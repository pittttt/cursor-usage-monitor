import * as vscode from "vscode";
import { CombinedUsageData } from "./api";

export class UsageStatusBarItem {
  private item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.item.command = "cursorUsageMonitor.refresh";
    this.setLoading();
    this.item.show();
  }

  private getThreshold(): number {
    const config = vscode.workspace.getConfiguration("cursorUsageMonitor");
    return config.get<number>("warningThreshold", 85);
  }

  setLoading(): void {
    this.item.text = "$(sync~spin) Cursor Usage";
    this.item.tooltip = "正在加载 Cursor 用量...";
    this.item.backgroundColor = undefined;
  }

  setData(data: CombinedUsageData): void {
    const total = data.totalUsageDollars.toFixed(2);
    const onDemand = data.onDemandUsageDollars.toFixed(2);
    const included = data.includedUsageDollars.toFixed(2);
    const percent = data.usagePercent;
    const threshold = this.getThreshold();
    const overThreshold = percent >= threshold;

    this.item.text = `$(dashboard) $${total}`;
    this.item.command = "cursorUsageMonitor.refresh";

    if (overThreshold) {
      this.item.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.warningBackground"
      );
    } else {
      this.item.backgroundColor = undefined;
    }

    const statusIcon = overThreshold ? "$(warning)" : "$(pass)";
    const statusEmoji = overThreshold ? "⚠️" : "✅";
    const totalLimit = data.totalLimitDollars.toFixed(2);
    const includedLimit = data.includedLimitDollars.toFixed(2);
    const onDemandLimit = data.onDemandLimitDollars.toFixed(2);

    const tooltip = new vscode.MarkdownString(
      [
        "**Cursor Usage Monitor**",
        "",
        `${statusIcon} **使用率**: ${percent.toFixed(1)}% ${statusEmoji}  ($${total} / $${totalLimit})`,
        "",
        `---`,
        "",
        `$(package) **Your Included Usage**: $${included} / $${includedLimit}`,
        "",
        `$(flame) **On-Demand Usage**: $${onDemand} / $${onDemandLimit}`,
        "",
        `---`,
        "",
        `$(gear) 告警阈值: [${threshold}%](command:cursorUsageMonitor.setThreshold "点击修改阈值") _(点击可修改)_`,
        "",
        data.billingEnd
          ? `$(calendar) **Resets**: ${new Date(data.billingEnd).toLocaleDateString("zh-CN")}（${this.daysUntil(data.billingEnd)} 天后重置）`
          : "",
        "",
        this.buildDashboardLink(),
        "",
        `_更新于 ${data.updatedAt.toLocaleTimeString("zh-CN")}_`,
        "",
        "_点击刷新_",
      ].join("\n")
    );
    tooltip.isTrusted = true;
    tooltip.supportThemeIcons = true;
    this.item.tooltip = tooltip;
  }

  setError(message: string): void {
    this.item.text = "$(dashboard) --";
    this.item.tooltip = `Cursor Usage: ${message}\n\n点击重试`;
    this.item.command = "cursorUsageMonitor.refresh";
    this.item.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.errorBackground"
    );
  }

  setNoToken(): void {
    this.item.text = "$(key) 设置 Token";
    this.item.tooltip = "点击设置 Cursor Session Token";
    this.item.command = "cursorUsageMonitor.setToken";
    this.item.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground"
    );
  }

  private buildDashboardLink(): string {
    const to = new Date();
    const from = new Date(to);
    from.setDate(from.getDate() - 30);
    const toDate = to.toISOString().slice(0, 10);
    const fromDate = from.toISOString().slice(0, 10);
    return `$(link-external) [查看用量明细](https://cursor.com/cn/dashboard/usage?from=${fromDate}&to=${toDate})`;
  }

  private daysUntil(dateStr: string): number {
    const target = new Date(dateStr).getTime();
    const now = Date.now();
    return Math.max(0, Math.ceil((target - now) / (1000 * 60 * 60 * 24)));
  }

  dispose(): void {
    this.item.dispose();
  }
}
