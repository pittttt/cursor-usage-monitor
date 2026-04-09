# Cursor Usage Monitor

在 Cursor IDE 中实时展示你的 Cursor 用量信息，包括 **Included Usage**（套餐内用量）、**On-Demand Usage**（按需用量）以及总用量。

## 功能

- **状态栏** — 底部状态栏实时显示总用量金额，鼠标悬停查看详情
- **侧边栏面板** — 独立的用量概览视图，展示完整用量数据
- **账单明细** — 展示当月账单明细（模型、请求数、费用）
- **Premium 请求进度** — 可视化进度条展示 Premium 请求使用情况
- **自动刷新** — 可配置的自动刷新间隔（默认 5 分钟）

## 安装

```bash
cd cursor-usage-monitor
npm install
npm run compile
```

然后在 Cursor 中通过「扩展：从 VSIX 安装」或开发模式加载。

## 配置 Token

1. 在浏览器中登录 [cursor.com](https://cursor.com)
2. 打开开发者工具（F12）→ Application → Cookies
3. 找到 `WorkosCursorSessionToken` 的值并复制
4. 在 Cursor 中按 `Cmd+Shift+P`，运行 **Cursor Usage: 设置 Token**
5. 粘贴 Token

Token 会安全地存储在 VS Code SecretStorage 中。

## 设置

| 设置项 | 默认值 | 说明 |
|--------|--------|------|
| `cursorUsageMonitor.refreshInterval` | `5` | 自动刷新间隔（分钟） |

## 使用的 API

- `GET https://www.cursor.com/api/usage-summary` — 获取 Included / On-Demand 用量
- `GET https://www.cursor.com/api/usage?user=ID` — 获取 Premium 请求数
- `POST https://www.cursor.com/api/dashboard/get-monthly-invoice` — 获取月度账单明细

所有 API 通过 `WorkosCursorSessionToken` Cookie 进行认证。
