# OpenCode V2 Web — Obsidian Plugin

Show the **OpenCode V2 web interface** inside an Obsidian pane.

Unlike terminal-based integrations, this plugin does not render a TUI. It embeds the
web UI that OpenCode V2 already ships with, so you get the real interface —
session list, streaming replies, model picker — inside Obsidian.

---

## Why

OpenCode V2 exposes a full web UI through its local background service. Plugins that
run the CLI in a terminal give you an ANSI TUI, which looks out of place in Obsidian.
This plugin simply points an `iframe` at the web UI.

It also avoids reimplementing anything: session management, streaming, permissions and
model selection are all handled by the OpenCode web app itself.

## Requirements

- Obsidian desktop **1.7.2+**
- **OpenCode V2** installed (`opencode --version` should report `2.x`)
- Windows, macOS or Linux (Windows is the tested platform)

## Installation

### Manual

1. Create the folder `<vault>/.obsidian/plugins/opencode-v2-web/`
2. Copy `main.js`, `manifest.json` and `styles.css` into it
3. Enable **OpenCode V2 Web** in *Settings → Community plugins*

### BRAT (beta)

Add `obsidian-opencode-v2-web` as a beta plugin via
[BRAT](https://github.com/TfTHacker/obsidian42-brat), pointing at this repository.

## Usage

- Click the window icon in the ribbon, or
- Run **OpenCode V2 Web: Toggle web interface** from the command palette, or
- Click the status bar item

The plugin then:

1. Reads the background service URL with `opencode service status`
2. Starts the service with `opencode service start` **only if** nothing is listening
3. Requests a pairing link with `opencode pair`
4. Loads that link in the pane

### Commands

| Command | Description |
|---|---|
| Toggle web interface | Open or focus the pane |
| Connect | (Re)connect to the local service |
| Refresh web interface | Request a fresh pairing link and reload the pane |
| Disconnect | Unload the web interface from the pane |

## Settings

| Setting | Default | Description |
|---|---|---|
| OpenCode executable | auto-detected | Path to the CLI, or a `.cmd`/`.bat` wrapper that sets its own profile |
| Working directory | vault root | Directory the CLI runs in |
| Connect automatically | on | Connect when the pane opens |
| Open in sidebar | on | Use the right sidebar instead of a main tab |
| Stop service on unload | off | Only stops a service this plugin started |

## How it works

```
Obsidian (command / ribbon / status bar)
        │
        ▼
   ItemView  ──iframe──▶  OpenCode V2 web UI
        │                        │
        │                        ▼
        │            OpenCode background service (127.0.0.1:49374)
        ▼
  opencode service status / start / pair
```

The web UI authenticates through the fragment of a pairing URL:

```
<origin>/connect#<base64url({"username":"opencode","password":"<service password>"})>
```

`opencode pair` already produces exactly this link, so the plugin uses it verbatim
rather than constructing one.

Because the iframe is loaded from the same origin as the service, **no CORS
configuration is required**.

## Security & privacy

- **Credentials are never persisted.** The pairing link lives in memory for the
  lifetime of the connection. It is not written to `data.json`, not written to logs,
  and not written to the vault.
- The UI only ever displays the local service address, never the password.
- The plugin talks to a **loopback address only** (`127.0.0.1`).
- The plugin does **not** stop the shared background service. Other clients (a
  terminal, another editor) may depend on it. Only a service this plugin started can
  be stopped, and only when you enable *Stop service on unload*.

## Notes on the OpenCode V2 API

- `GET /` is unauthenticated and returns the web UI HTML.
- `GET /api/*` requires HTTP Basic auth, username `opencode`.
- Responses carry no `X-Frame-Options` and no `frame-ancestors` CSP directive, so
  embedding is permitted.
- The service log only records **non-2xx** responses, which is useful to know when
  debugging authentication: a successful session produces no log entries.

## Troubleshooting

**"OpenCode is unavailable"**
Check *OpenCode executable* in the settings. A bare `opencode` relies on `PATH`,
which Obsidian does not always inherit — use an absolute path.

**The pane shows "Connect to a server"**
The pairing link failed to authenticate. Run *Refresh web interface* to mint a new
link. If it persists, verify `opencode pair` works in a terminal.

**Wrong profile / no credentials**
If OpenCode is installed with a dedicated profile directory, point *OpenCode
executable* at a wrapper script that exports `XDG_DATA_HOME`, `XDG_CONFIG_HOME`,
`XDG_CACHE_HOME` and `XDG_STATE_HOME` before invoking the CLI. On Windows a `.cmd`
wrapper is supported directly.

**Port keeps changing**
That is normal — the background service picks a free port. The plugin always asks
the CLI for the current URL instead of assuming a port.

## Known limitations

- The plugin does not inject note context (open note / selected text) into a session.
  That would require the V2 API and a way to identify the active session; it is not
  implemented yet.
- Sending messages and streaming are handled entirely by the web UI, so they depend on
  OpenCode's own behaviour rather than this plugin.

## License

MIT — see [LICENSE](LICENSE).

---

## 中文说明

把 **OpenCode V2 自带的 Web 界面**嵌进 Obsidian 面板，取代终端里的 TUI。

插件本身不实现聊天界面：会话列表、流式回复、模型选择全部由 OpenCode 的 Web 应用负责。
它只做三件事——探测后台服务、必要时启动服务、用 `opencode pair` 取一个配对链接交给 iframe。

**要点**

- 复用 OpenCode V2 的**共享后台服务**，不会另起一套服务，也不会在关闭面板时把它停掉
- **凭据零持久化**：配对链接只在内存中，不写入设置、日志或仓库
- iframe 与服务同源，无需配置 CORS
- Windows 下支持 `.cmd` / `.bat` 包装脚本，便于保留独立的 XDG profile

**安装**：把 `main.js`、`manifest.json`、`styles.css` 放进
`<仓库>/.obsidian/plugins/opencode-v2-web/`，然后在 *设置 → 第三方插件* 中启用。

**排查**：若面板显示 "Connect to a server"，点 *Refresh web interface* 重新取链接；
若提示找不到可执行文件，请在设置里填写绝对路径。
