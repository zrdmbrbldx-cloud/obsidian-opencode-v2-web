"use strict";

/**
 * OpenCode V2 Web for Obsidian
 * ============================
 * Shows the OpenCode V2 *web interface* inside an Obsidian pane.
 *
 * Design notes (see the project brief):
 *   - The plugin does NOT spawn its own server. It reuses the OpenCode V2
 *     background service (`opencode service`) which is shared with other
 *     clients, and only starts it when nothing is listening.
 *   - Credentials are never persisted. The pairing link is produced at runtime
 *     by `opencode pair`, kept in memory only, and handed straight to the
 *     iframe. It is never written to data.json, logs, or the vault.
 *   - Because the iframe is loaded from the same origin as the service, no CORS
 *     configuration is required.
 *
 * The web UI authenticates via the fragment of
 *   <origin>/connect#<base64url({"username":"opencode","password":"..."})>
 * which `opencode pair` already produces for us.
 */

const {
	Plugin,
	PluginSettingTab,
	Setting,
	ItemView,
	Notice,
} = require("obsidian");

const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const fs = require("fs");

const VIEW_TYPE = "opencode-v2-web";

const STATE = {
	STOPPED: "stopped",
	STARTING: "starting",
	RUNNING: "running",
	ERROR: "error",
};

const DEFAULT_SETTINGS = {
	opencodePath: "",
	workingDirectory: "",
	autoStart: true,
	openInSidebar: true,
	stopServiceOnUnload: false,
	serviceStartTimeoutSec: 30,
};

/* --------------------------------------------------------------- utilities */

/** Remove ANSI colour codes from CLI output. */
function stripAnsi(text) {
	return String(text).replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}

/** Quote an argument for a Windows cmd.exe command line. */
function quoteWin(arg) {
	if (arg === "") return '""';
	if (!/[\s"^&|<>()]/.test(arg)) return arg;
	return '"' + arg.replace(/"/g, '\\"') + '"';
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** GET a URL, resolving true when the server answers with a non-error status. */
function probeHttp(url, timeoutMs) {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (v) => {
			if (!settled) {
				settled = true;
				resolve(v);
			}
		};
		let req;
		try {
			req = http.get(url, { timeout: timeoutMs }, (res) => {
				res.resume();
				finish(res.statusCode >= 200 && res.statusCode < 500);
			});
		} catch (err) {
			return finish(false);
		}
		req.on("error", () => finish(false));
		req.on("timeout", () => {
			req.destroy();
			finish(false);
		});
	});
}

/* ------------------------------------------------------------ CLI launcher */

/**
 * Runs the OpenCode CLI and captures output.
 * Never logs argv or output, because `opencode pair` prints credentials.
 */
function runCli(exe, args, { cwd, env, timeoutMs = 30000 } = {}) {
	return new Promise((resolve) => {
		const isWindows = process.platform === "win32";
		const ext = path.extname(exe).toLowerCase();
		let command = exe;
		let finalArgs = args;

		if (isWindows && (ext === ".cmd" || ext === ".bat")) {
			command = process.env.ComSpec || "cmd.exe";
			finalArgs = ["/d", "/s", "/c", [exe, ...args].map(quoteWin).join(" ")];
		}

		let child;
		try {
			child = spawn(command, finalArgs, {
				cwd,
				env,
				windowsHide: true,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (err) {
			return resolve({ code: -1, stdout: "", stderr: err.message });
		}

		let stdout = "";
		let stderr = "";
		let done = false;
		const finish = (result) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve(result);
		};

		const timer = setTimeout(() => {
			try {
				child.kill();
			} catch (err) {
				/* ignore */
			}
			finish({ code: -1, stdout, stderr: stderr + "\n(timed out)" });
		}, timeoutMs);

		child.stdout.on("data", (c) => {
			stdout += c.toString();
		});
		child.stderr.on("data", (c) => {
			stderr += c.toString();
		});
		child.on("error", (err) => finish({ code: -1, stdout, stderr: err.message }));
		child.on("exit", (code) => finish({ code: code === null ? -1 : code, stdout, stderr }));
	});
}

/* ------------------------------------------------------------- view + state */

class OpenCodeV2WebView extends ItemView {
	constructor(leaf, plugin) {
		super(leaf);
		this.plugin = plugin;
		this.iframeEl = null;
		this.loadedLink = null;
		this.unsubscribe = null;
	}

	getViewType() {
		return VIEW_TYPE;
	}

	getDisplayText() {
		return "OpenCode V2";
	}

	getIcon() {
		return "app-window";
	}

	async onOpen() {
		this.contentEl.addClass("opencode-v2-web-root");
		this.unsubscribe = this.plugin.onStateChange(() => this.render());
		this.render();
		if (this.plugin.settings.autoStart) {
			this.plugin.connect();
		}
	}

	async onClose() {
		if (this.unsubscribe) {
			this.unsubscribe();
			this.unsubscribe = null;
		}
		this.teardownIframe();
	}

	teardownIframe() {
		if (this.iframeEl) {
			try {
				this.iframeEl.src = "about:blank";
				this.iframeEl.remove();
			} catch (err) {
				/* ignore */
			}
			this.iframeEl = null;
		}
		this.loadedLink = null;
	}

	render() {
		const state = this.plugin.state;
		const link = this.plugin.connectLink;

		if (state === STATE.RUNNING && link) {
			// Only (re)build the frame when the link actually changed, so ordinary
			// re-renders never reload the running web UI.
			if (this.iframeEl && this.iframeEl.isConnected && this.loadedLink === link) return;
			this.contentEl.empty();
			this.teardownIframe();
			const frame = this.contentEl.createEl("iframe", { cls: "opencode-v2-web-frame" });
			frame.setAttribute("allow", "clipboard-read; clipboard-write");
			frame.src = link;
			this.iframeEl = frame;
			this.loadedLink = link;
			return;
		}

		this.teardownIframe();
		this.contentEl.empty();
		const box = this.contentEl.createDiv({ cls: "opencode-v2-web-status" });

		if (state === STATE.STARTING) {
			box.createDiv({ cls: "opencode-v2-web-spinner" });
			box.createEl("h3", { text: "Connecting to OpenCode…" });
			box.createEl("p", {
				cls: "opencode-v2-web-muted",
				text: this.plugin.statusDetail || "Checking the local OpenCode service.",
			});
			return;
		}

		if (state === STATE.ERROR) {
			box.createEl("h3", { text: "OpenCode is unavailable" });
			const pre = box.createEl("pre", { cls: "opencode-v2-web-error" });
			pre.setText(this.plugin.lastError || "Unknown error.");
			this.buttonRow(box, [
				{ label: "Try again", cta: true, action: () => this.plugin.connect() },
				{ label: "Settings", action: () => this.plugin.openSettings() },
			]);
			return;
		}

		box.createEl("h3", { text: "OpenCode is not connected" });
		box.createEl("p", {
			cls: "opencode-v2-web-muted",
			text: "Connect to the local OpenCode service to load the web interface.",
		});
		this.buttonRow(box, [
			{ label: "Connect", cta: true, action: () => this.plugin.connect() },
		]);
	}

	buttonRow(parent, buttons) {
		const row = parent.createDiv({ cls: "opencode-v2-web-buttons" });
		for (const spec of buttons) {
			const btn = row.createEl("button", { text: spec.label });
			if (spec.cta) btn.addClass("mod-cta");
			btn.addEventListener("click", () => spec.action());
		}
	}
}

/* ------------------------------------------------------------------ plugin */

class OpenCodeV2WebPlugin extends Plugin {
	async onload() {
		await this.loadSettings();

		// Runtime-only state. Deliberately not persisted.
		this.state = STATE.STOPPED;
		this.statusDetail = "";
		this.lastError = null;
		this.serviceUrl = null;
		this.connectLink = null;
		this.startedService = false;
		this.stateListeners = new Set();
		this.connecting = false;

		this.registerView(VIEW_TYPE, (leaf) => new OpenCodeV2WebView(leaf, this));

		this.addRibbonIcon("app-window", "OpenCode V2 web interface", () => this.toggleView());

		this.addCommand({ id: "toggle", name: "Toggle web interface", callback: () => this.toggleView() });
		this.addCommand({ id: "connect", name: "Connect", callback: () => this.connect() });
		this.addCommand({ id: "refresh", name: "Refresh web interface", callback: () => this.refreshView() });
		this.addCommand({ id: "disconnect", name: "Disconnect", callback: () => this.disconnect() });

		this.statusBarEl = this.addStatusBarItem();
		this.statusBarEl.addClass("opencode-v2-web-statusbar");
		this.statusBarEl.addEventListener("click", () => this.toggleView());

		this.addSettingTab(new OpenCodeV2WebSettingTab(this.app, this));
		this.renderStatusBar();
	}

	async onunload() {
		// Only ever stop a service this plugin started, and only if the user
		// asked for it. The background service is shared with other clients.
		if (this.startedService && this.settings.stopServiceOnUnload) {
			await this.runOpencode(["service", "stop"], 15000);
		}
	}

	/* ------------------------------------------------------------- settings */

	async loadSettings() {
		const stored = (await this.loadData()) || {};
		this.settings = Object.assign({}, DEFAULT_SETTINGS, stored);
		if (!this.settings.opencodePath) {
			this.settings.opencodePath = this.guessOpencodePath();
		}
		await this.saveSettings();
	}

	async saveSettings() {
		// Only settings are persisted - never the pairing link or password.
		await this.saveData(this.settings);
	}

	guessOpencodePath() {
		// Only an explicit override is auto-detected. A bare "opencode" relies on
		// PATH, which Obsidian does not always inherit - users on a dedicated
		// profile should point this at their own wrapper script in the settings.
		const candidates = [process.env.OPENCODE_PATH].filter(Boolean);
		for (const candidate of candidates) {
			try {
				if (fs.existsSync(candidate)) return candidate;
			} catch (err) {
				/* ignore */
			}
		}
		return "opencode";
	}

	resolveCwd() {
		const configured = (this.settings.workingDirectory || "").trim();
		if (configured) {
			try {
				if (fs.statSync(configured).isDirectory()) return configured;
			} catch (err) {
				/* fall through */
			}
		}
		try {
			const adapter = this.app.vault.adapter;
			if (adapter && typeof adapter.getBasePath === "function") {
				const base = adapter.getBasePath();
				if (base) return base;
			}
		} catch (err) {
			/* ignore */
		}
		return process.cwd();
	}

	runOpencode(args, timeoutMs) {
		return runCli(this.settings.opencodePath || "opencode", args, {
			cwd: this.resolveCwd(),
			env: process.env,
			timeoutMs: timeoutMs || 30000,
		});
	}

	/* ---------------------------------------------------------------- state */

	onStateChange(cb) {
		this.stateListeners.add(cb);
		return () => this.stateListeners.delete(cb);
	}

	notifyStateChange() {
		for (const cb of this.stateListeners) {
			try {
				cb();
			} catch (err) {
				console.error("[opencode-v2-web] state listener failed", err);
			}
		}
		this.renderStatusBar();
	}

	setState(state, { detail, error } = {}) {
		this.state = state;
		if (detail !== undefined) this.statusDetail = detail;
		if (error !== undefined) this.lastError = error;
		this.notifyStateChange();
	}

	renderStatusBar() {
		if (!this.statusBarEl) return;
		const labels = {
			[STATE.STOPPED]: "OpenCode: idle",
			[STATE.STARTING]: "OpenCode: connecting…",
			[STATE.RUNNING]: "OpenCode: ready",
			[STATE.ERROR]: "OpenCode: error",
		};
		this.statusBarEl.setText(labels[this.state] || "OpenCode");
		this.statusBarEl.toggleClass("is-error", this.state === STATE.ERROR);
		this.statusBarEl.toggleClass("is-ready", this.state === STATE.RUNNING);
	}

	/* ------------------------------------------------------------ connecting */

	/** Read the background service URL, starting it only when nothing is up. */
	async ensureService() {
		this.setState(STATE.STARTING, { detail: "Checking the OpenCode service…", error: null });

		let url = await this.readServiceUrl();
		if (url && (await probeHttp(url + "/", 2500))) {
			this.serviceUrl = url;
			return url;
		}

		this.setState(STATE.STARTING, { detail: "Starting the OpenCode service…" });
		const start = await this.runOpencode(["service", "start"], 60000);
		this.startedService = true;
		if (start.code !== 0 && !(start.stdout + start.stderr).toLowerCase().includes("already")) {
			// Fall through: `service status` below is the source of truth.
		}

		const deadline = Date.now() + (this.settings.serviceStartTimeoutSec || 30) * 1000;
		while (Date.now() < deadline) {
			url = await this.readServiceUrl();
			if (url && (await probeHttp(url + "/", 2500))) {
				this.serviceUrl = url;
				return url;
			}
			await sleep(1000);
		}

		throw new Error(
			"The OpenCode background service did not become reachable.\n\n" +
				`Command: ${this.settings.opencodePath} service start\n` +
				(start.stderr ? "\n" + stripAnsi(start.stderr).trim() : "")
		);
	}

	/** `opencode service status` prints the service URL, or nothing. */
	async readServiceUrl() {
		const res = await this.runOpencode(["service", "status"], 20000);
		const text = stripAnsi(res.stdout + "\n" + res.stderr);
		const match = text.match(/https?:\/\/[^\s"']+/);
		return match ? match[0].replace(/\/+$/, "") : null;
	}

	/**
	 * Ask the CLI for a fresh pairing link. Held in memory only - never logged,
	 * never written to disk.
	 */
	async readPairLink() {
		const res = await this.runOpencode(["pair"], 30000);
		const text = stripAnsi(res.stdout);

		// Preferred: the explicit "Link" line.
		let match = text.match(/^\s*Link\s+(https?:\/\/\S+)\s*$/m);
		if (match) return match[1].trim();

		// Fallback: any /connect#... URL in the output.
		match = text.match(/https?:\/\/\S*\/connect#\S+/);
		if (match) return match[0].trim();

		// Last resort: rebuild it from the printed URLs / Username / Password.
		const urlMatch = text.match(/^\s*URLs?\s+(https?:\/\/\S+)\s*$/m);
		const userMatch = text.match(/^\s*Username\s+(\S+)\s*$/m);
		const passMatch = text.match(/^\s*Password\s+(\S+)\s*$/m);
		if (urlMatch && userMatch && passMatch) {
			const payload = { username: userMatch[1], password: passMatch[1] };
			const hash = Buffer.from(JSON.stringify(payload), "utf8")
				.toString("base64")
				.replace(/\+/g, "-")
				.replace(/\//g, "_")
				.replace(/=+$/, "");
			return `${urlMatch[1].replace(/\/+$/, "")}/connect#${hash}`;
		}

		throw new Error(
			"Could not read a pairing link from `opencode pair`.\n\n" +
				(stripAnsi(res.stderr).trim() || "No output was produced.")
		);
	}

	async connect() {
		if (this.connecting) return;
		this.connecting = true;
		try {
			await this.ensureService();
			this.setState(STATE.STARTING, { detail: "Pairing with the local service…" });
			this.connectLink = await this.readPairLink();
			this.setState(STATE.RUNNING, { detail: "", error: null });
		} catch (err) {
			this.connectLink = null;
			this.setState(STATE.ERROR, { error: err.message || String(err) });
		} finally {
			this.connecting = false;
		}
	}

	/** Force the iframe to reload from a freshly minted pairing link. */
	async refreshView() {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
		for (const leaf of leaves) {
			if (leaf.view instanceof OpenCodeV2WebView) {
				leaf.view.teardownIframe();
			}
		}
		this.connectLink = null;
		await this.connect();
	}

	disconnect() {
		this.connectLink = null;
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			if (leaf.view instanceof OpenCodeV2WebView) leaf.view.teardownIframe();
		}
		this.setState(STATE.STOPPED, { detail: "" });
	}

	/* ----------------------------------------------------------------- views */

	async toggleView() {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
		if (existing.length > 0) {
			this.app.workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = this.settings.openInSidebar
			? this.app.workspace.getRightLeaf(false)
			: this.app.workspace.getLeaf(true);
		if (!leaf) {
			new Notice("Could not open an OpenCode pane.");
			return;
		}
		await leaf.setViewState({ type: VIEW_TYPE, active: true });
		this.app.workspace.revealLeaf(leaf);
	}

	openSettings() {
		const setting = this.app.setting;
		if (setting && typeof setting.openTabById === "function") {
			setting.openTabById(this.manifest.id);
		}
	}
}

/* -------------------------------------------------------------- settings UI */

class OpenCodeV2WebSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "OpenCode V2 Web" });

		new Setting(containerEl)
			.setName("OpenCode executable")
			.setDesc(
				"Path to the OpenCode CLI, or a .cmd wrapper that sets its own profile. Used only for `service` and `pair`."
			)
			.addText((text) =>
				text
					.setPlaceholder("opencode")
					.setValue(this.plugin.settings.opencodePath)
					.onChange(async (value) => {
						this.plugin.settings.opencodePath = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Working directory")
			.setDesc("Directory the CLI runs in. Leave empty to use the vault root.")
			.addText((text) =>
				text
					.setPlaceholder("Vault root")
					.setValue(this.plugin.settings.workingDirectory)
					.onChange(async (value) => {
						this.plugin.settings.workingDirectory = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Connect automatically")
			.setDesc("Connect to the local service when the OpenCode pane opens.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoStart).onChange(async (value) => {
					this.plugin.settings.autoStart = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Open in sidebar")
			.setDesc("Open the web interface in the right sidebar instead of a main tab.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.openInSidebar).onChange(async (value) => {
					this.plugin.settings.openInSidebar = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Stop service on unload")
			.setDesc(
				"Only applies to a service this plugin started. The background service is shared with other clients, so leaving this off is usually correct."
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.stopServiceOnUnload).onChange(async (value) => {
					this.plugin.settings.stopServiceOnUnload = value;
					await this.plugin.saveSettings();
				})
			);

		containerEl.createEl("h3", { text: "Status" });

		const status = containerEl.createDiv({ cls: "opencode-v2-web-muted" });
		status.setText(
			[
				`State: ${this.plugin.state}`,
				`Service: ${this.plugin.serviceUrl || "not detected"}`,
				`Started by this plugin: ${this.plugin.startedService ? "yes" : "no"}`,
			].join("\n")
		);
		status.style.whiteSpace = "pre-wrap";

		new Setting(containerEl)
			.setName("Reconnect")
			.setDesc("Re-check the service and request a fresh pairing link.")
			.addButton((button) =>
				button
					.setButtonText("Reconnect")
					.setCta()
					.onClick(async () => {
						await this.plugin.refreshView();
						this.display();
					})
			);
	}
}

module.exports = OpenCodeV2WebPlugin;
