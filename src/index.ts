import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const OBSIDIAN_VAULT = path.join(
	process.env.HOME ?? "",
	"Library/Mobile Documents/iCloud~md~obsidian/Documents/Zhao",
);
const STATUS_FILE = path.join(OBSIDIAN_VAULT, ".obsidian/context.json");

interface ObsidianTab {
	path: string;
	name: string;
	isActive: boolean;
}

interface ObsidianSelection {
	text: string;
	sourcePath: string;
}

interface ObsidianStatus {
	ts: number;
	active: { path: string; name: string } | null;
	tabs: ObsidianTab[];
	selection: ObsidianSelection | null;
}

function readStatus(): ObsidianStatus | undefined {
	try {
		const raw = fs.readFileSync(STATUS_FILE, "utf-8");
		return JSON.parse(raw) as ObsidianStatus;
	} catch {
		return undefined;
	}
}

function formatWidget(status: ObsidianStatus, ctx: ExtensionContext): string[] {
	const active = status.active;
	if (!active) return [];

	const dir = path.dirname(active.path);
	const dirLabel = dir === "." ? "" : ` (${dir})`;
	const tabCount = status.tabs.length;

	const label = chalk.hex("#7C3AED").bold("Obsidian") + " ";
	const fileLine = ctx.ui.theme.fg("accent", active.name) + ctx.ui.theme.fg("muted", `${dirLabel} | ${tabCount} tabs`);

	const parts = [label + fileLine];

	if (status.selection?.text) {
		const charCount = status.selection.text.length;
		parts.push(ctx.ui.theme.fg("muted", `  sel: ${charCount} chars in ${status.selection.sourcePath}`));
	}

	return parts;
}

function formatContext(status: ObsidianStatus): string {
	const lines: string[] = ["[Obsidian Context]"];

	if (status.active) {
		lines.push(`Active file: ${status.active.path}`);
	}

	if (status.tabs.length > 0) {
		lines.push(`Open tabs (${status.tabs.length}):`);
		for (const tab of status.tabs) {
			const marker = tab.isActive ? " <-- active" : "";
			lines.push(`  - ${tab.path}${marker}`);
		}
	}

	if (status.selection?.text) {
		lines.push(`Selected text in ${status.selection.sourcePath}:`);
		lines.push(`  "${status.selection.text}"`);
	}

	return lines.join("\n");
}

export default function obsidianContextExtension(pi: ExtensionAPI): void {
	let currentStatus: ObsidianStatus | undefined;
	let watcher: fs.FSWatcher | null = null;
	let latestCtx: ExtensionContext | undefined;
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;

	function updateWidget(): void {
		if (!latestCtx?.hasUI) return;
		if (currentStatus && currentStatus.tabs.length > 0) {
			latestCtx.ui.setWidget("obsidian-tabs", formatWidget(currentStatus, latestCtx));
		} else {
			latestCtx.ui.setWidget("obsidian-tabs", undefined);
		}
	}

	function reload(): void {
		currentStatus = readStatus();
		updateWidget();
	}

	function startWatching(): void {
		stopWatching();

		const dir = path.dirname(STATUS_FILE);
		const basename = path.basename(STATUS_FILE);

		try {
			watcher = fs.watch(dir, (_eventType, filename) => {
				if (filename !== basename) return;
				if (debounceTimer) clearTimeout(debounceTimer);
				debounceTimer = setTimeout(reload, 100);
			});
			watcher.on("error", () => {
				stopWatching();
				setTimeout(startWatching, 5000);
			});
		} catch {
			setTimeout(startWatching, 5000);
		}
	}

	function stopWatching(): void {
		if (debounceTimer) {
			clearTimeout(debounceTimer);
			debounceTimer = null;
		}
		if (watcher) {
			watcher.close();
			watcher = null;
		}
	}

	// Inject Obsidian context as a hidden message before each agent turn
	pi.on("before_agent_start", async () => {
		currentStatus = readStatus();
		if (!currentStatus) return;

		return {
			message: {
				customType: "obsidian-context",
				content: formatContext(currentStatus),
				display: false,
			},
		};
	});

	// Filter out stale obsidian-context messages to avoid accumulation
	pi.on("context", async (event) => {
		const messages = event.messages;
		let lastIndex = -1;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i] as { customType?: string };
			if (msg.customType === "obsidian-context") {
				if (lastIndex === -1) {
					lastIndex = i;
				} else {
					messages.splice(i, 1);
					lastIndex--;
				}
			}
		}
		return { messages };
	});

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		reload();
		startWatching();
	});

	pi.on("session_shutdown", async () => {
		stopWatching();
		latestCtx = undefined;
	});
}
