# FanSSH

面向运维人员和开发者的 Windows 终端与运维客户端（v1 可运行骨架）。

技术栈：Tauri 2（Rust 后端）+ React 18 + TypeScript + xterm.js，SSH/SFTP 基于 russh，凭据使用 Windows DPAPI 加密，RDP 调用系统 `mstsc.exe`。

## 当前已实现

- **SSH 终端**：xterm.js 渲染，真实 SSH 连接与交互；多标签页（新建/关闭/切换）；布局模型支持一个标签内多个面板（分屏）；支持密码、OpenSSH/PEM 私钥（含口令）、一层跳板机（ProxyJump）。
- **会话管理器**：服务器配置包含名称、协议、host/port/user、认证方式、分组、标签、跳板机；配置与凭据分开存储；JSON 导入/导出（导出不含凭据）。
- **凭据存储**：Windows 下用 DPAPI 包装主密钥，每条凭据再用 AES-256-GCM 做信封加密；非 Windows 开发环境回退为本地 `secret.key`（仅用于开发调试）。
- **SFTP**：远程目录浏览、上传、下载、chmod，带传输进度队列（最小可用）。
- **AI 侧边栏**：支持 Ollama 或 OpenAI 兼容接口；把终端选中内容发给模型分析；自然语言转 Shell 命令，结果经本地风险规则评估后，必须由用户确认才写入终端。
- **RDP**：配置中可选 RDP 协议，连接时生成 `.rdp` 文件并调用 `mstsc.exe`。
- **构建流水线**：GitHub Actions 在 Windows runner 上产出 NSIS 安装包与便携版 zip。

## 尚未实现 / 已知限制

- SSH 主机密钥目前只记录、未接入 known_hosts 校验。
- 终端日志高亮、全局搜索、快捷键自定义、会话录制、插件机制未实现。
- AI 为非流式响应；NL2CMD 的本地风险规则是保守拦截，不能替代人工审查。
- SFTP 未实现断点续传、本地双栏文件浏览、在线文本编辑。
- RDP 仅外部调用 `mstsc.exe`，未做窗口嵌入。
- 当前开发机为 Linux，Tauri 桌面窗口与 Windows 专属行为（DPAPI、mstsc）需在 Windows 上实际验证。

## 本地开发

前置条件：

- Node.js 20+
- Rust stable（含 cargo）
- Windows：WebView2 Runtime、Visual Studio Build Tools（MSVC + Windows SDK）
- Linux（仅用于前端/后端编译检查）：需要 webkit2gtk-4.1、gtk3 等开发包，例如
  `sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev`

安装依赖并启动桌面开发模式：

```bash
npm install
npm run tauri dev
```

仅启动前端（浏览器中无法使用 Tauri IPC，只能看界面）：

```bash
npm run dev
```

仅做类型检查与前端构建：

```bash
npm run build
```

后端编译检查：

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

## Windows 构建

```bash
npm install
npm run tauri build -- --bundles nsis
```

产物位置：

- 可执行文件：`src-tauri/target/release/fanssh.exe`
- NSIS 安装包：`src-tauri/target/release/bundle/nsis/`

便携版：把 `fanssh.exe` 与一个空的 `portable.marker` 放在同一目录，应用会把配置与凭据写到 exe 同级的 `data/` 目录，而不是用户 AppData。

## CI

工作流文件：`.github/workflows/windows-build.yml`，仓库根即本项目目录。

- 触发：推送到 `main`、推送 `v*` 标签、针对相关路径的 Pull Request、手动 `workflow_dispatch`。
- 流程：安装 Node/Rust → `npm ci` → `npm run build` → `npm run tauri build -- --bundles nsis` → 打包便携版 zip。
- 产物：`fanssh-nsis-installer`（安装包）与 `fanssh-portable-windows-x64`（便携版 zip）两个 artifact。
- 推送 `v*` 标签时，额外创建 GitHub Release 并附带上述产物。
- 工作流中不包含任何账号、邮箱或令牌，使用 GitHub 自动提供的 `GITHUB_TOKEN`。

## 数据与安全

- 配置：`profiles.json`，不含任何明文密码或私钥。
- 凭据：`vault.json`，主密钥由 DPAPI（当前用户范围）包装；每条凭据使用 AES-256-GCM，AAD 绑定 `id:kind`。
- AI API Key 同样存放在凭据库，不写入 `settings.json`，也不会回传到前端。
- 数据目录优先级：环境变量 `FANSSH_DATA_DIR` → exe 同级存在 `portable.marker` 时的 `data/` → 系统应用数据目录。

> 注意：`vault.json`、`profiles.json`、`settings.json`、`secret.key` 等运行期文件已被 `.gitignore` 排除，请勿提交。

## 目录结构

```
.
├── .github/workflows/windows-build.yml   # Windows 构建与打包
├── src/                                  # React 前端
│   ├── components/                       # 侧栏、终端、SFTP、AI、配置对话框
│   ├── lib/terminalRegistry.ts           # xterm 实例与选区访问
│   ├── api.ts                            # Tauri 命令封装
│   ├── store.ts                          # 标签 / 面板状态
│   └── types.ts                          # 与 Rust 对齐的类型
├── src-tauri/                            # Rust 后端
│   ├── src/session/                      # 会话模型与 SSH 会话管理
│   ├── src/transport/                    # ssh / sftp / rdp
│   ├── src/ai/                           # AI 调用、提示词、风险守卫
│   ├── src/ipc/                          # 命令、DTO、错误模型
│   ├── src/vault/                        # 加密凭据库
│   ├── src/app/                          # 状态、设置、数据目录
│   └── tauri.conf.json
├── package.json
└── vite.config.ts
```
