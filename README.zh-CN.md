# DSH 模拟沙盒（Mock DSH Sandbox）

中文 · [English](README.md)

一个 DeepSeek Harness（DSH）插件，让插件开发使用一个一次性的 DSH，而不是你正在使用的那个。
每个 mock 都是真实的 DSH 进程，拥有独立的 `DSH_HOME`、profile、端口、工作目录和日志，
因此安装、弄坏、重启或替换组件都不会碰到正在使用的 profile。

## 为什么需要它

插件运行在 DSH Host 进程里。一个损坏的 bundle、写错的 Loader patch 或 profile 改动，
都可能让正在使用的 DSH 无法启动。这个插件让安全路径变成最省事的路径：

- **隔离实例**——每个实例都有独立的 DSH home 和 profile。
- **一个工具**——`mock_dsh` 负责启动、安装、检查、停止和删除。
- **组件 Mock**——禁用或覆盖某一行，或者提供一个 stub 服务。
- **模型提醒**——system prompt 中的段落要求模型先使用 mock。
- **授权守卫**——对真实 profile 的改动会暂停，并附上中英双语警告，等待用户明确授权。

## 环境要求

- 提供 `tools`、`systemPrompt`、`workingDirectory`、`agents` 服务的 DSH 构建
  （自带的 `web` 和 `desktop` profile 均满足）。
- 无额外依赖：插件是纯 ESM，只使用 Node 内置模块。
- 已在 Windows 11 + DSH `0.2.1-rc.3` 上测试。

## 安装

把本目录克隆或复制到一个固定位置，然后作为本地 bundle 安装：

1. 在 DSH 中调用 `plugin_manager`，`action` 为 `install_bundle`，`target` 填本目录的绝对路径。
2. 保持目录不动。DSH 以链接方式安装本地 bundle，移动或删除 checkout 会让插件失效；
   如需迁移，请先卸载 bundle。

修改代码后，用 `plugin_manager` 先禁用再启用 `include:mock-dsh-sandbox` 这一行即可重载，
或者重启 DSH。

## 快速开始

`mock_dsh` 工具的参数示例：

```json
{ "action": "start", "name": "myplugin" }
{ "action": "install", "name": "myplugin", "source": "D:/work/my-plugin" }
{ "action": "restart", "name": "myplugin" }
{ "action": "run", "name": "myplugin", "args": ["--profile", "mock", "--dump-config"] }
{ "action": "logs", "name": "myplugin", "lines": 80 }
{ "action": "destroy", "name": "myplugin" }
```

`start` 会返回 mock 的 URL、根目录、隔离 home 和日志路径。打开 URL 即可查看 mock 的 Web UI
（URL 自带访问 token）。

## 工具参数

| 参数 | 含义 |
|---|---|
| `action` | 必填：`start`、`restart`、`install`、`run`、`logs`、`list`、`stop` 或 `destroy`。 |
| `name` | 实例名，默认 `dev`；小写字母、数字和连字符，最长 32 个字符。 |
| `template` | 新建 mock profile 时使用的自带模板，默认 `web`。 |
| `port` | 新 mock 的监听端口；`0`（默认）由系统分配。 |
| `patches` | 启动时应用的 Loader patch 文件，绝对路径或相对于会话工作目录。 |
| `source` | `install`：本地 bundle 目录或包名。 |
| `args` | `run`：短时 dsh CLI 命令的参数。 |
| `lines` | `logs`：返回末尾多少行，默认 40。 |

| action | 作用 |
|---|---|
| `start` | 按需创建隔离 home/profile，启动 `dsh --profile mock --port <n> --no-open`，等待 URL。 |
| `restart` | 使用已保存的模板、端口和 patches 重启。 |
| `install` | 在 mock 的 `DSH_HOME` 下执行 `dsh plugin --profile mock add <source>`。 |
| `run` | 在 mock 的 `DSH_HOME` 和工作目录下执行短时 dsh CLI 命令。 |
| `logs` | 查看 mock 启动日志末尾。 |
| `list` | 列出所有实例及其进程是否存活。 |
| `stop` | 结束进程，保留文件。 |
| `destroy` | 停止并删除整个实例目录。 |

## 实例目录

实例位于 `<会话工作目录>/.dsh-mock/instances/<name>/`：

```text
dev/
  home/        # DSH_HOME，包含 profiles/mock
  workspace/   # mock 的工作目录
  logs/        # dsh.log、profile-init.log、install-*.log、run-*.log
  record.json  # 名称、pid、url、路径、patches、时间戳
```

mock 从自带的 `web` 模板创建，而不是复制正在使用的 profile。它的 home 不会复制真实 DSH
的凭据，因此 mock 初始处于未登录状态。

## Mock 组件

组件替换只发生在 mock 中，不会改动真实 profile。

**用 Loader patch 覆盖或禁用一行：**

```yaml
# patches/no-web-tools.yml
- id: tool-web
  disabled: true
```

启动或重启时传入：

```json
{ "action": "start", "name": "myplugin", "patches": ["patches/no-web-tools.yml"] }
```

**提供 stub 服务：** 编写一个小 bundle，在其 patch 中插入一个提供相同服务的行，
安装到 mock 后重启：

```json
{ "action": "install", "name": "myplugin", "source": "D:/work/my-stub-bundle" }
{ "action": "restart", "name": "myplugin" }
```

两种方式都可以用下面的命令检查组合后的配置树：

```json
{ "action": "run", "args": ["--profile", "mock", "--dump-config"], "name": "myplugin" }
```

完整输出写入返回结果中的日志路径，工具结果只显示末尾部分。

## 真实 profile 守卫

在 mock 之外，插件会检查模型发起的、可能修改当前 DSH 的工具调用：

- `plugin_manager` 中安装、移除、启用、禁用插件或 bundle 的动作，包括版本豁免；
- `write` / `edit` 写入 `DSH_PROFILE_DIR` 或任意 `DSH_HOME/profiles/<name>` 下的文件；
- `pwsh` / `bash` 中会安装到 profile（`dsh plugin`、`--from-default-profile`）
  或改写 profile 文件的命令。

如果该调用本来就需要授权，守卫会在原授权提示前加上中英双语警告，保留正常的允许/拒绝选择。
如果当前会话策略会让该调用无需提示就执行，守卫会主动发起一次授权请求；
在 `never` 审批策略下则直接失败关闭。拒绝授权不会改动真实 profile，模型应改用 mock 重试。

守卫在 mock 内部不生效：mock 启动时会带上 `DSH_MOCK_INSTANCE`，
同时位于 `.dsh-mock/instances` 下的 `DSH_HOME` 也会被识别为 mock。

## 隔离与清理

- 所有子进程的 `DSH_HOME`、`DSH_PROFILE`、`DSH_PROFILE_DIR` 都指向实例目录，不会使用真实 profile。
- mock 使用系统分配端口并带 `--no-open` 启动；stdout 和 stderr 写入实例日志。
- `stop` 会结束整个进程树（Windows 用 `taskkill /T /F`，其他平台先 `SIGTERM` 再 `SIGKILL`），
  并确认记录的 PID 已消失。对于上一个 Host 遗留的 PID，会先核对进程映像再结束。
- `destroy` 在删除前会检查目标确实是 `.dsh-mock/instances` 下的实例目录。
- 禁用插件时会结束它仍持有的 mock；Host 崩溃遗留的实例会继续出现在 `list` 中，
  可以稍后 `stop` 或 `destroy`。

## 安全与限制

- 每个 mock 都是真实 DSH 进程，运行期间会占用内存、CPU 和一个监听端口；用完请 `stop` 或 `destroy`。
- profile 保护基于路径匹配；符号链接或特殊路径写法不会被额外解析。
- shell 命令识别是启发式的，只覆盖文档中列出的 dsh/pnpm 和 profile 写入模式，
  不能覆盖任意 PowerShell/Bash 写法。
- 守卫只约束模型发起的工具调用，不拦截用户在 DSH UI 中的直接操作。
- Windows 是已验证路径；POSIX 的结束进程分支已实现，但未在此环境验证。
- 向 mock 安装包使用 pnpm，可能在实例目录之外创建包存储。

## 开发

没有构建步骤。修改 `index.js` 后检查语法：

```bash
node --check index.js
```

要在运行中的 DSH 里加载改动，用 `plugin_manager` 先禁用再启用
`include:mock-dsh-sandbox`，或者重启 DSH。在安装到真实 profile 之前，
先用一个新实例验证 `start`、`list`、`stop`、`destroy`。

## 仓库结构

```text
.
├── index.js             # Host 插件：mock_dsh、提示词段落、真实 profile 守卫
├── cordis.patch.yml     # 插入插件行的 bundle patch
├── package.json         # DSH bundle 清单与 locale/icon 导出
├── locale/en.json       # 英文标题与描述
├── locale/zh.json       # 中文标题与描述
├── icon.svg             # 原创插件图标
├── README.md            # 英文 README
└── README.zh-CN.md      # 本文件
```
