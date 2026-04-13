import * as vscode from "vscode";
import { CombinedUsageData } from "./api";

type UsageTreeItem = vscode.TreeItem & { children?: UsageTreeItem[] };

export class UsageTreeDataProvider
  implements vscode.TreeDataProvider<UsageTreeItem>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<
    UsageTreeItem | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private data: CombinedUsageData | null = null;
  private error: string | null = null;
  private loading = false;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  setLoading(): void {
    this.loading = true;
    this.error = null;
    this.refresh();
  }

  setData(data: CombinedUsageData): void {
    this.data = data;
    this.loading = false;
    this.error = null;
    this.refresh();
  }

  setError(message: string): void {
    this.error = message;
    this.loading = false;
    this.refresh();
  }

  getTreeItem(element: UsageTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: UsageTreeItem): UsageTreeItem[] {
    if (element) {
      return element.children ?? [];
    }
    return this.buildRootItems();
  }

  private buildRootItems(): UsageTreeItem[] {
    if (this.loading) {
      return [this.makeItem("$(sync~spin) 正在加载用量数据...")];
    }

    if (this.error) {
      const errorItem = this.makeItem(`$(error) ${this.error}`);
      const hintItem = this.makeItem(
        '$(info) 请运行 "Cursor Usage: 设置 Token" 命令配置 Token'
      );
      return [errorItem, hintItem];
    }

    if (!this.data) {
      const noDataItem = this.makeItem("$(info) 尚未获取用量数据");
      const hintItem = this.makeItem(
        '$(info) 请先运行 "Cursor Usage: 设置 Token" 命令'
      );
      return [noDataItem, hintItem];
    }

    const items: UsageTreeItem[] = [];

    const usageItem = this.makeItem(
      `$(package) Your Monthly Usage: $${this.data.monthlyUsageDollars.toFixed(2)} / $${this.data.monthlyLimitDollars.toFixed(2)}`,
      vscode.TreeItemCollapsibleState.None
    );
    usageItem.description = `${this.data.usagePercent.toFixed(1)}%`;
    items.push(usageItem);

    items.push(this.makeSeparator());

    if (this.data.billingStart) {
      const startDate = new Date(this.data.billingStart).toLocaleDateString(
        "zh-CN"
      );
      const endDate = this.data.billingEnd
        ? new Date(this.data.billingEnd).toLocaleDateString("zh-CN")
        : "本月结束";
      const billingItem = this.makeItem(
        `$(calendar) 计费周期: ${startDate} ~ ${endDate}`
      );
      items.push(billingItem);
    }

    if (this.data.invoiceItems.length > 0) {
      const invoiceParent = this.makeItem(
        `$(list-unordered) 本月账单明细 (${this.data.invoiceItems.length} 项)`,
        vscode.TreeItemCollapsibleState.Collapsed
      );
      invoiceParent.children = this.data.invoiceItems.map((item) => {
        const child = this.makeItem(
          `$${item.dollars.toFixed(2)} — ${this.truncate(item.description, 60)}`
        );
        child.tooltip = item.description;
        return child;
      });
      items.push(invoiceParent);
    }

    items.push(this.makeSeparator());

    const updatedItem = this.makeItem(
      `$(clock) 更新于 ${this.data.updatedAt.toLocaleTimeString("zh-CN")}`
    );
    updatedItem.description = "点击标题栏刷新按钮手动刷新";
    items.push(updatedItem);

    return items;
  }

  private makeItem(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState = vscode
      .TreeItemCollapsibleState.None
  ): UsageTreeItem {
    const item = new vscode.TreeItem(
      label,
      collapsibleState
    ) as UsageTreeItem;
    return item;
  }

  private makeSeparator(): UsageTreeItem {
    const item = this.makeItem("─────────────────────");
    item.description = "";
    return item;
  }

  private truncate(str: string, maxLen: number): string {
    return str.length > maxLen ? str.substring(0, maxLen - 3) + "..." : str;
  }
}
