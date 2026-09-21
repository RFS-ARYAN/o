const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const axios = require("axios");
const FormData = require("form-data");
const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth");

chromium.use(stealth());

const BASE_URL = "https://claude.ai";
const CLAUDE_FILE = path.join(process.cwd(), "claude.json");
const TEMPMAIL_BASE = "https://apis.davidcyril.name.ng/tempmail";
const TEMPMAIL_KEY = "dc_live_kRr527BfwXW9lc6DhJUx5t3iZB0Z0xZp";
const EMAIL_TYPES = ["gmail", "outlook", "yahoo", "hotmail", "proton"];
const DEFAULT_MODEL = "claude-sonnet-5";
const WEB_UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36";

const activeUsers = new Set();

function log(...a) { console.log("[claude]", ...a); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setReaction(api, r, id) {
	return new Promise((res) => {
		try { api.setMessageReaction(r, id, () => res(), true); } catch { res(); }
	});
}

function sendMessageAsync(api, msg, tid, mid) {
	return new Promise((res) => {
		let done = false;
		const finish = (_, info) => {
			if (done) return;
			done = true;
			clearTimeout(t);
			res(info || null);
		};
		const t = setTimeout(() => finish(null, null), 240000);
		try {
			const r = api.sendMessage(msg, tid, finish, mid);
			if (r && typeof r.then === "function") r.then((i) => finish(null, i)).catch(() => finish(null, null));
		} catch { finish(null, null); }
	});
}

function splitMessage(text, max = 1900) {
	if (!text) return [""];
	if (text.length <= max) return [text];
	const parts = [];
	let remaining = text;
	while (remaining.length > 0) {
		let chunk = remaining.slice(0, max);
		const lastNl = chunk.lastIndexOf("\n");
		if (lastNl > max * 0.6) chunk = chunk.slice(0, lastNl);
		parts.push(chunk);
		remaining = remaining.slice(chunk.length).trimStart();
	}
	return parts;
}

// ============================================================
// CLAUDE JSON STORAGE
// ============================================================
function loadClaude() {
	if (!fs.existsSync(CLAUDE_FILE)) {
		return { accounts: [], currentIndex: 0 };
	}
	try {
		const cfg = JSON.parse(fs.readFileSync(CLAUDE_FILE, "utf8"));
		if (cfg.cookie && !cfg.accounts) {
			return {
				accounts: [{ name: "default", cookie: cfg.cookie, orgId: cfg.orgId, model: cfg.model || DEFAULT_MODEL }],
				currentIndex: 0
			};
		}
		if (!Array.isArray(cfg.accounts)) cfg.accounts = [];
		if (typeof cfg.currentIndex !== "number") cfg.currentIndex = 0;
		return cfg;
	} catch {
		return { accounts: [], currentIndex: 0 };
	}
}

function saveClaude(cfg) {
	fs.writeFileSync(CLAUDE_FILE, JSON.stringify(cfg, null, 2));
}

// ============================================================
// TEMPMAIL API
// ============================================================
async function tempmailApi(p, params = {}) {
	const url = TEMPMAIL_BASE + p + "?" + new URLSearchParams(params).toString();
	const res = await axios.get(url, {
		timeout: 30000,
		validateStatus: () => true,
		headers: {
			"X-API-Key": TEMPMAIL_KEY,
			Accept: "application/json",
			"User-Agent": "Mozilla/5.0"
		}
	});
	if (res.status === 401 || res.status === 403) throw new Error("Invalid tempmail API key");
	if (res.status === 429) throw new Error("Tempmail rate limit");
	if (res.status >= 400) throw new Error(`Tempmail HTTP ${res.status}`);
	const data = res.data;
	if (!data.success) throw new Error(data.message || data.code || "Tempmail failed");
	return data.result;
}

async function createTempEmail(type = "gmail") {
	const chosen = EMAIL_TYPES.includes(type) ? type : "gmail";
	const result = await tempmailApi("/create", { type: chosen, apikey: TEMPMAIL_KEY });
	if (!result.email) throw new Error("No email returned");
	return result.email;
}

async function getInbox(email) {
	const result = await tempmailApi("/inbox", { email, apikey: TEMPMAIL_KEY });
	return result?.emails || [];
}

function extractMagicLink(text) {
	const m = String(text).match(/https?:\/\/claude\.ai\/magic-link#[^\s<>"')\]]+/i);
	return m ? m[0] : null;
}

async function waitForMagicLink(email, maxAttempts = 40, intervalMs = 3000) {
	for (let i = 0; i < maxAttempts; i++) {
		log(`Polling inbox ${i + 1}/${maxAttempts}...`);
		try {
			const emails = await getInbox(email);
			for (const mail of emails) {
				const body = mail.body || mail.text || mail.html || mail.body_html || mail.text_content || mail.html_content || "";
				const link = extractMagicLink(body);
				if (link) return link;
			}
		} catch (e) {
			log("Inbox error:", e.message);
		}
		await sleep(intervalMs);
	}
	throw new Error("Timeout: no magic link received");
}

// ============================================================
// CLAUDE AUTO SIGNUP VIA PLAYWRIGHT
// ============================================================
async function createClaudeAccount(emailType) {
	log("Creating temp email:", emailType);
	const email = await createTempEmail(emailType);
	log("Email:", email);

	const browser = await chromium.launch({
		headless: true,
		args: [
			"--no-sandbox",
			"--disable-setuid-sandbox",
			"--disable-dev-shm-usage",
			"--disable-blink-features=AutomationControlled"
		]
	});

	try {
		const context = await browser.newContext({
			userAgent: WEB_UA,
			viewport: { width: 1366, height: 900 },
			locale: "en-US",
			timezoneId: "Asia/Dhaka"
		});

		const page = await context.newPage();

		log("Opening claude.ai login...");
		await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded", timeout: 60000 });
		await page.waitForTimeout(4000);

		let html = await page.content();
		if (html.includes("Just a moment") || html.includes("Checking your browser")) {
			log("Cloudflare challenge...");
			await page.waitForTimeout(12000);
		}

		log("Entering email...");
		const emailSelectors = [
			'input[type="email"]',
			'input[name="email"]',
			'input[placeholder*="email" i]',
			'input[autocomplete="email"]'
		];

		let emailInput = null;
		for (const sel of emailSelectors) {
			try {
				emailInput = await page.waitForSelector(sel, { timeout: 5000, state: "visible" });
				if (emailInput) break;
			} catch {}
		}
		if (!emailInput) throw new Error("Email input not found");

		await emailInput.click();
		await emailInput.fill(email);
		await page.waitForTimeout(800);

		log("Submitting email...");
		const submitSelectors = [
			'button[type="submit"]',
			'button:has-text("Continue")',
			'button:has-text("Continue with email")',
			'button:has-text("Sign in")'
		];
		let submitted = false;
		for (const sel of submitSelectors) {
			try {
				const btn = await page.$(sel);
				if (btn) { await btn.click(); submitted = true; break; }
			} catch {}
		}
		if (!submitted) await emailInput.press("Enter");

		log("Magic link requested. Waiting for email...");
		await page.waitForTimeout(5000);

		const magicLink = await waitForMagicLink(email);
		log("Magic link found:", magicLink.slice(0, 70) + "...");

		log("Visiting magic link...");
		await page.goto(magicLink, { waitUntil: "domcontentloaded", timeout: 60000 });
		await page.waitForTimeout(8000);

		let currentUrl = page.url();
		for (let i = 0; i < 20; i++) {
			if (currentUrl.includes("/chat") || currentUrl.includes("/new") || currentUrl.includes("/recents")) break;
			await page.waitForTimeout(2000);
			currentUrl = page.url();
		}
		log("Final URL:", currentUrl);

		await page.waitForTimeout(4000);

		const cookies = await context.cookies();
		const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
		const sessionCookie = cookies.find((c) => c.name === "sessionKey");
		const orgCookie = cookies.find((c) => c.name === "lastActiveOrg");

		if (!sessionCookie) throw new Error("sessionKey cookie not found. Signup may have failed.");
		if (!orgCookie) throw new Error("lastActiveOrg cookie not found.");

		log("Account created! orgId:", orgCookie.value);

		return {
			email,
			cookie: cookieStr,
			orgId: orgCookie.value,
			model: DEFAULT_MODEL
		};
	} finally {
		await browser.close().catch(() => {});
	}
}

// ============================================================
// CLAUDE API (cookie-based)
// ============================================================
function claudeHeaders(cfg, deviceId, extra = {}) {
	return {
		"authority": "claude.ai",
		"accept-language": "en-US,en;q=0.9",
		"anthropic-client-platform": "web_claude_ai",
		"anthropic-client-version": "1.0.0",
		"content-type": "application/json",
		"origin": BASE_URL,
		"user-agent": WEB_UA,
		"cookie": cfg.cookie,
		"anthropic-device-id": deviceId,
		...extra
	};
}

async function claudeCreateConversation(cfg, deviceId) {
	const res = await fetch(`${BASE_URL}/api/organizations/${cfg.orgId}/chat_conversations`, {
		method: "POST",
		headers: claudeHeaders(cfg, deviceId, { accept: "application/json" }),
		body: JSON.stringify({ name: "", model: cfg.model || DEFAULT_MODEL, include_conversation_preferences: true })
	});
	if (res.status === 429) { const e = new Error("RATE_LIMIT"); e.code = 429; throw e; }
	if (res.status === 401 || res.status === 403) { const e = new Error("AUTH_FAILED"); e.code = res.status; throw e; }
	if (!res.ok) throw new Error(`createConversation HTTP ${res.status}`);
	const data = await res.json();
	if (!data.uuid) throw new Error("No conversation uuid");
	return data.uuid;
}

async function claudeUploadFile(cfg, deviceId, convId, buffer, filename, mimeType) {
	const boundary = "----FormBoundary" + crypto.randomBytes(16).toString("hex");
	const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`);
	const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
	const bodyBuf = Buffer.concat([head, buffer, tail]);
	const res = await fetch(`${BASE_URL}/api/organizations/${cfg.orgId}/conversations/${convId}/wiggle/upload-file`, {
		method: "POST",
		headers: {
			"accept": "*/*",
			"content-type": `multipart/form-data; boundary=${boundary}`,
			"origin": BASE_URL,
			"referer": BASE_URL + "/",
			"user-agent": WEB_UA,
			"cookie": cfg.cookie,
			"anthropic-device-id": deviceId
		},
		body: bodyBuf
	});
	if (!res.ok) throw new Error(`uploadFile HTTP ${res.status}`);
	const data = await res.json();
	return data.uuid;
}

async function claudeParseSSE(res) {
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let fullText = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop();
		for (const line of lines) {
			if (!line.startsWith("data: ")) continue;
			const raw = line.slice(6).trim();
			if (!raw || raw === "[DONE]") continue;
			let evt;
			try { evt = JSON.parse(raw); } catch { continue; }
			if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
				fullText += evt.delta.text || "";
			}
		}
	}
	return fullText;
}

async function claudeSend(cfg, deviceId, conversationId, prompt, fileUuids = []) {
	const body = {
		prompt,
		timezone: "Asia/Dhaka",
		locale: "en-US",
		model: cfg.model || DEFAULT_MODEL,
		effort: "medium",
		thinking_mode: "auto",
		personalized_styles: [{
			type: "default", key: "Default", name: "Normal",
			nameKey: "normal_style_name", prompt: "Normal\n",
			summary: "Default responses from Claude",
			summaryKey: "normal_style_summary", isDefault: true
		}],
		tools: [
			{ type: "web_search_v0", name: "web_search" },
			{ type: "artifacts_v0", name: "artifacts" },
			{ type: "repl_v0", name: "repl" }
		],
		turn_message_uuids: {
			human_message_uuid: crypto.randomUUID(),
			assistant_message_uuid: crypto.randomUUID()
		},
		attachments: [],
		files: fileUuids,
		sync_sources: [],
		rendering_mode: "messages"
	};
	const res = await fetch(`${BASE_URL}/api/organizations/${cfg.orgId}/chat_conversations/${conversationId}/completion`, {
		method: "POST",
		headers: claudeHeaders(cfg, deviceId, { accept: "text/event-stream", referer: `${BASE_URL}/chat/${conversationId}` }),
		body: JSON.stringify(body)
	});
	if (res.status === 429) { const e = new Error("RATE_LIMIT"); e.code = 429; throw e; }
	if (res.status === 401 || res.status === 403) { const e = new Error("AUTH_FAILED"); e.code = res.status; throw e; }
	if (!res.ok) throw new Error(`sendMessage HTTP ${res.status}`);
	return await claudeParseSSE(res);
}

async function askClaudeWithAccount(account, prompt, files = []) {
	const deviceId = crypto.randomUUID();
	const convId = await claudeCreateConversation(account, deviceId);

	const fileUuids = [];
	for (const f of files) {
		try {
			const uuid = await claudeUploadFile(account, deviceId, convId, f.buffer, f.filename, f.mimeType);
			if (uuid) fileUuids.push(uuid);
		} catch (e) { log("Upload fail:", e.message); }
	}

	const text = await claudeSend(account, deviceId, convId, prompt, fileUuids);
	if (!text || !text.trim()) throw new Error("Empty response");
	return text.trim();
}

async function askClaude(prompt, files = []) {
	const cfg = loadClaude();
	if (!cfg.accounts.length) throw new Error("No Claude accounts available. Use 'claude new' to create one.");

	const startIdx = (cfg.currentIndex || 0) % cfg.accounts.length;
	let lastError = null;

	for (let i = 0; i < cfg.accounts.length; i++) {
		const idx = (startIdx + i) % cfg.accounts.length;
		const account = cfg.accounts[idx];
		try {
			log(`Trying Claude: ${account.name || idx}`);
			const text = await askClaudeWithAccount(account, prompt, files);
			cfg.currentIndex = idx;
			saveClaude(cfg);
			log(`Claude ${account.name || idx} OK`);
			return text;
		} catch (err) {
			lastError = err;
			const msg = String(err.message || "");
			if (msg.includes("429") || err.code === 429 || /rate limit/i.test(msg)) continue;
			if (msg.includes("401") || msg.includes("403") || err.code === 401 || err.code === 403) continue;
			continue;
		}
	}

	if (lastError) {
		const msg = String(lastError.message || "");
		if (msg.includes("429") || lastError.code === 429) throw new Error("All Claude accounts rate-limited.");
		if (msg.includes("401") || msg.includes("403")) throw new Error("All Claude accounts expired. Use 'claude new' to create one.");
		throw lastError;
	}
	throw new Error("All Claude accounts failed");
}

// ============================================================
// GOAT-BOT-V2 COMMAND
// ============================================================
module.exports = {
	config: {
		name: "claude",
		aliases: ["claudeai", "sonnet"],
		version: "0.0.2",
		author: "ArYAN",
		countDown: 5,
		role: 0,
		shortDescription: "Chat with Claude AI (auto signup)",
		longDescription: "Chat with Claude via claude.ai. Auto-creates account using temp mail API when needed.",
		category: "ai",
		guide: {
			en:
				"{pn} <question> - chat\n" +
				"{pn} new [gmail|outlook|yahoo|hotmail|proton] - create new Claude account\n" +
				"{pn} list - show saved accounts\n" +
				"{pn} -m <n> - switch to account by index\n" +
				"{pn} rm <n> - remove account\n" +
				"{pn} (reply to a message) - use replied text as prompt"
		}
	},

	onStart: async function ({ api, event, args, message }) {
		const senderID = event.senderID;
		if (activeUsers.has(senderID)) {
			await setReaction(api, "❌", event.messageID);
			return;
		}

		const sub = (args[0] || "").toLowerCase();

		// List accounts
		if (sub === "list") {
			const cfg = loadClaude();
			if (!cfg.accounts.length) {
				return api.sendMessage("No Claude accounts saved. Use 'claude new' to create one.", event.threadID, event.messageID);
			}
			const lines = cfg.accounts.map((a, i) => {
				const marker = i === (cfg.currentIndex || 0) ? " ← active" : "";
				return `${i + 1}. ${a.name || `account-${i + 1}`} [org: ${String(a.orgId).slice(0, 8)}...]${marker}`;
			});
			return api.sendMessage(
				`Claude Accounts (${cfg.accounts.length}):\n\n${lines.join("\n")}`,
				event.threadID,
				event.messageID
			);
		}

		// Create new account
		if (sub === "new") {
			const emailType = (args[1] || "gmail").toLowerCase();
			if (!EMAIL_TYPES.includes(emailType)) {
				return api.sendMessage(`Invalid type. Use: ${EMAIL_TYPES.join(", ")}`, event.threadID, event.messageID);
			}

			activeUsers.add(senderID);
			await setReaction(api, "⏳", event.messageID);

			try {
				const newAccount = await createClaudeAccount(emailType);
				const cfg = loadClaude();
				const name = `acc${cfg.accounts.length + 1}`;
				cfg.accounts.push({
					name,
					cookie: newAccount.cookie,
					orgId: newAccount.orgId,
					model: newAccount.model
				});
				saveClaude(cfg);

				await setReaction(api, "✅", event.messageID);
				await sendMessageAsync(api,
					{
						body:
							`✅ Claude account created!\n\n` +
							`📧 Email: ${newAccount.email}\n` +
							`🏷️ Name: ${name}\n` +
							`🆔 orgId: ${newAccount.orgId}\n` +
							`📊 Total: ${cfg.accounts.length}`
					},
					event.threadID,
					event.messageID
				);
			} catch (err) {
				log("Create error:", err.message);
				await setReaction(api, "❌", event.messageID);
				await sendMessageAsync(api, { body: `❌ Failed: ${String(err.message).slice(0, 250)}` }, event.threadID, event.messageID);
			} finally {
				activeUsers.delete(senderID);
			}
			return;
		}

		// Switch active account
		if (sub === "-m" || sub === "switch") {
			const n = parseInt(args[1], 10);
			const cfg = loadClaude();
			if (isNaN(n) || n < 1 || n > cfg.accounts.length) {
				return api.sendMessage(`Invalid index. Use 1-${cfg.accounts.length}.`, event.threadID, event.messageID);
			}
			cfg.currentIndex = n - 1;
			saveClaude(cfg);
			return api.sendMessage(`✅ Switched to account ${n}: ${cfg.accounts[n - 1].name}`, event.threadID, event.messageID);
		}

		// Remove account
		if (sub === "rm" || sub === "remove") {
			const n = parseInt(args[1], 10);
			const cfg = loadClaude();
			if (isNaN(n) || n < 1 || n > cfg.accounts.length) {
				return api.sendMessage(`Invalid index. Use 1-${cfg.accounts.length}.`, event.threadID, event.messageID);
			}
			const removed = cfg.accounts.splice(n - 1, 1)[0];
			if (cfg.currentIndex >= cfg.accounts.length) cfg.currentIndex = 0;
			saveClaude(cfg);
			return api.sendMessage(`✅ Removed account: ${removed.name}`, event.threadID, event.messageID);
		}

		// Chat with Claude
		let prompt = (args || []).join(" ").trim();
		if (!prompt && event.messageReply?.body) {
			prompt = String(event.messageReply.body).trim();
		}

		if (!prompt) {
			return api.sendMessage(
				`Usage:\n` +
				`• claude <question>\n` +
				`• claude new [gmail|outlook]\n` +
				`• claude list\n` +
				`• claude -m <n>`,
				event.threadID,
				event.messageID
			);
		}

		activeUsers.add(senderID);
		await setReaction(api, "⏳", event.messageID);

		try {
			const cfg = loadClaude();

			// Auto-create if no accounts
			if (!cfg.accounts.length) {
				log("No accounts, auto-creating...");
				const newAccount = await createClaudeAccount("gmail");
				cfg.accounts.push({
					name: "acc1",
					cookie: newAccount.cookie,
					orgId: newAccount.orgId,
					model: newAccount.model
				});
				cfg.currentIndex = 0;
				saveClaude(cfg);
				log("Auto-created account:", newAccount.email);
			}

			const reply = await askClaude(prompt);
			if (!reply || !reply.trim()) throw new Error("Empty response");

			await setReaction(api, "✅", event.messageID);

			const parts = splitMessage(reply);
			for (const p of parts) {
				await sendMessageAsync(api, { body: p }, event.threadID, event.messageID);
			}
		} catch (err) {
			log("Chat error:", err.message);
			await setReaction(api, "❌", event.messageID);

			// Auto-retry by creating new account if all expired
			if (/expired|All Claude accounts/i.test(err.message)) {
				try {
					await sendMessageAsync(api,
						{ body: "⚠️ All accounts expired. Auto-creating new one..." },
						event.threadID,
						event.messageID
					);
					const newAccount = await createClaudeAccount("gmail");
					const cfg2 = loadClaude();
					cfg2.accounts.push({
						name: `acc${cfg2.accounts.length + 1}`,
						cookie: newAccount.cookie,
						orgId: newAccount.orgId,
						model: newAccount.model
					});
					cfg2.currentIndex = cfg2.accounts.length - 1;
					saveClaude(cfg2);

					const reply = await askClaude(prompt);
					await setReaction(api, "✅", event.messageID);
					const parts = splitMessage(reply);
					for (const p of parts) {
						await sendMessageAsync(api, { body: p }, event.threadID, event.messageID);
					}
				} catch (err2) {
					log("Auto-retry failed:", err2.message);
					await setReaction(api, "❌", event.messageID);
					await sendMessageAsync(api, { body: `❌ Failed: ${String(err2.message).slice(0, 250)}` }, event.threadID, event.messageID);
				}
			} else {
				await sendMessageAsync(api, { body: `❌ Failed: ${String(err.message).slice(0, 250)}` }, event.threadID, event.messageID);
			}
		} finally {
			activeUsers.delete(senderID);
		}
	}
};
