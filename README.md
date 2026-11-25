# FanSSH

面向运维人员和开发者的桌面终端与运维客户端（v1 可运行骨架），主要面向 Windows，同时提供 Linux 构建。

技术栈：Tauri 2（Rust 后端）+ React 18 + TypeScript + xterm.js，SSH/SFTP 基于 russh，RDP 基于 IronRDP，凭据在 Windows 下使用 DPAPI 加密。

## 当前已实现

- **SSH 终端**：xterm.js 渲染，真实 SSH 连接与交互；多标签页（新建/关闭/切换）；布局模型支持一个标签内多个面板（分屏）；支持密码、OpenSSH/PEM 私钥（含口令）、一层跳板机（ProxyJump）。
- **会话管理器**：服务器配置包含名称、协议、host/port/user、认证方式、分组、标签、跳板机；配置与凭据分开存储；JSON 导入/导出（导出不含凭据）。
- **凭据存储**：Windows 下用 DPAPI 包装主密钥，每条凭据再用 AES-256-GCM 做信封加密；Linux 下改用数据目录中的主密钥文件（见下方「Linux 版本」）。
- **SFTP**：远程目录浏览、上传、下载、chmod，带传输进度队列（最小可用）。
- **AI 侧边栏**：支持 Ollama 或 OpenAI 兼容接口；把终端选中内容发给模型分析；自然语言转 Shell 命令，结果经本地风险规则评估后，必须由用户确认才写入终端。
- **RDP**：配置中可选 RDP 协议，Windows / Linux 共用内嵌远程桌面；支持 NLA/CredSSP 登录、画面显示、鼠标与键盘输入，一次性密码不会写入磁盘。
- **构建流水线**：GitHub Actions 在 Windows runner 上产出 NSIS 安装包与便携版 zip，在 Ubuntu runner 上产出 AppImage 与 deb。

## 尚未实现 / 已知限制

- SSH 主机密钥使用本地 `known_hosts.json` 做首次信任后校验；首次连接会自动记录，后续指纹变化会拒绝连接。
- 终端日志高亮、全局搜索、快捷键自定义、会话录制、插件机制未实现。
- AI 为非流式响应；NL2CMD 的本地风险规则是保守拦截，不能替代人工审查。
- SFTP 未实现本地双栏文件浏览。
- RDP 剪贴板、多显示器、音频、磁盘映射、RD 网关、智能卡登录暂未接入；服务器证书目前只用于 CredSSP 通道绑定，尚未做主机身份校验。
- 当前开发机为 Linux，Tauri 桌面窗口与 Windows 专属行为（DPAPI、安装包）需在 Windows 上实际验证。

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

## Linux 版本

### 构建

CI 使用 `ubuntu-22.04`（见 `.github/workflows/windows-build.yml` 的 `build-linux`），依赖：

```bash
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev librsvg2-dev \
  libayatana-appindicator3-dev libxdo-dev libssl-dev libudev-dev libfuse2 patchelf \
  pkg-config build-essential file
npm install
npm run tauri build -- --bundles appimage,deb
```

产物位置：

- AppImage：`src-tauri/target/release/bundle/appimage/*.AppImage`
- deb：`src-tauri/target/release/bundle/deb/*.deb`

### 与 Windows 版的能力差异

- **凭据加密**：Windows 使用 DPAPI，密文与当前 Windows 用户绑定。Linux 没有等价系统能力，
  改为在数据目录（`~/.local/share/com.fanssh.app/` 或 `XDG_DATA_HOME` 对应目录）下生成
  主密钥文件 `secret.key`：目录权限 `0700`、文件权限 `0600`，首次启动自动生成，
  用于 AES-256-GCM 信封加密。**安全差异**：密钥与密文同机存放，能读取当前用户数据目录的程序
  即可同时拿到密钥与密文，强度低于 DPAPI；请确保数据目录不被其他用户或其他程序读取。
- **RDP**：Linux 下使用同一套内嵌 IronRDP 会话，不依赖系统 `mstsc.exe`。
- **串口**：Linux 普通用户默认无权打开串口设备，需要先执行
  `sudo usermod -aG dialout $USER` 并重新登录。
- **SFTP / Docker 面板**：依赖 SSH 会话，Linux 下与 Windows 行为一致。
- **自动更新**：Linux AppImage 已接入应用内更新检查；deb 仍需通过包管理器或手动下载更新。

## CI

工作流文件：`.github/workflows/windows-build.yml`，仓库根即本项目目录。

- 触发：推送到 `main`、推送 `v*` 标签、针对相关路径的 Pull Request、手动 `workflow_dispatch`。
- Windows 流程：安装 Node/Rust → `npm ci` → `npm run build` → `npm run tauri build -- --bundles nsis` → 打包便携版 zip。
- Windows 产物：`fanssh-nsis-installer`（安装包）与 `fanssh-portable-windows-x64`（便携版 zip）两个 artifact。
- Linux 流程：`ubuntu-22.04` 安装 webkit2gtk 等依赖 → `npm run tauri build -- --bundles appimage,deb`。
- Linux 产物：`fanssh-linux-appimage` 与 `fanssh-linux-deb` 两个 artifact。
- 推送 `v*` 标签时，额外创建 GitHub Release 并附带上述产物（Linux 资产在 Windows Release 完成后追加）。
- 配置了签名私钥后，构建会生成 `.sig` 与 `latest.json`，并把安装包、便携包、`latest.json` 发布到公开更新通道仓库（默认 `fanlic/fanssh-updates`，可用仓库变量 `UPDATES_REPO` 覆盖）。
- 工作流中不包含任何账号、邮箱或令牌：源码仓库用 `GITHUB_TOKEN`，跨仓库发布用 secret `UPDATES_TOKEN`。

## 自动更新

安装版通过 `tauri-plugin-updater` 自更新，重启用 `tauri-plugin-process` 的 relaunch。入口在应用右上角「设置 → 检查更新」，会显示当前版本、检测结果、更新日志与下载进度，下载安装前需要二次确认。便携版不参与自更新，只提示去更新通道下载新的 zip。

### 更新源（endpoint）

地址只写在 [tauri.conf.json](src-tauri/tauri.conf.json) 的 `plugins.updater.endpoints`，Rust 代码不写死：

```json
"updater": {
  "endpoints": ["https://github.com/fanlic/fanssh-updates/releases/latest/download/latest.json"],
  "pubkey": "<你的公钥>"
}
```

换更新源（自建 CDN、换仓库、fork）只改这一行后重新构建即可。客户端固定请求该地址，因此 `latest.json` 必须发布在这个 URL 上。

### 签名密钥（一次性）

在仓库外生成并保存密钥，**不要提交**：

```bash
npx tauri signer generate -w ~/keys/fanssh.key
# 私钥：~/keys/fanssh.key
# 公钥：~/keys/fanssh.key.pub
```

把 `fanssh.key.pub` 的完整内容填到 `plugins.updater.pubkey`（替换 `REPLACE_WITH_PUBLIC_KEY_FROM_TAURI_SIGNER`）。丢失私钥或更换密钥后，已安装的旧版本将无法验证新包，只能让用户手动重装。

### CI 需要配置的 secrets

在源码仓库 `Settings → Secrets and variables → Actions` 添加：

| 名称 | 取值来源 |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | `~/keys/fanssh.key` 的完整内容（含 `untrusted comment` 行） |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 生成密钥时设置的密码 |
| `UPDATES_TOKEN` | 对 `fanlic/fanssh-updates` 有 `contents: write` 权限的 PAT（用于跨仓库发布） |

未配置 `TAURI_SIGNING_PRIVATE_KEY` 时，CI 会跳过签名与 `latest.json`，仍可正常产出未签名的安装包（此时应用内检查更新不可用）。

本地想验证更新包时，把 `bundle.createUpdaterArtifacts` 手动改为 `true`，并设置 `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 两个环境变量后构建。

### latest.json 结构

```json
{
  "version": "1.0.1",
  "notes": "本次更新说明",
  "pub_date": "2026-11-11T12:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "<安装包的 .sig 内容>",
      "url": "https://github.com/fanlic/fanssh-updates/releases/download/1.0.1/FanSSH_1.0.1_x64-setup.exe"
    }
  }
}
```

## 数据与安全

- 配置：`profiles.json`，不含任何明文密码或私钥。
- SSH 主机密钥：`known_hosts.json`，保存 host/port、算法与 SHA256 指纹；服务器重装或换密钥后可在设置的安全页面删除对应记录再重连。
- 凭据：`vault.json`，主密钥在 Windows 下由 DPAPI（当前用户范围）包装，Linux 下由数据目录中的 `secret.key`（目录 0700 / 文件 0600）包装；每条凭据使用 AES-256-GCM，AAD 绑定 `id:kind`。
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
