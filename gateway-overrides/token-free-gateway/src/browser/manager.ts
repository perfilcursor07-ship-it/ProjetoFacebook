/**
 * Centralized browser lifecycle manager for all web AI providers.
 * Maintains a single shared CDP connection to Chrome, with auto-reconnection,
 * health checking, and optional Chrome auto-start.
 */

import type { Browser, BrowserContext, Page } from "playwright-core";
import { chromium } from "playwright-core";
import { getChromeWebSocketUrl, getDefaultCdpUrl, getHeadersWithAuth } from "./cdp-helpers.ts";
import { ehAbaAuxiliar, registrarPagina } from "../viralizeai/abas.ts";

export interface BrowserCookie {
	name: string;
	value: string;
	domain: string;
	path: string;
	secure?: boolean;
}

class BrowserManager {
	private static instance: BrowserManager | null = null;

	private browser: Browser | null = null;
	private context: BrowserContext | null = null;
	private connecting: Promise<BrowserContext> | null = null;
	private disconnected = false;

	static getInstance(): BrowserManager {
		if (!BrowserManager.instance) {
			BrowserManager.instance = new BrowserManager();
		}
		return BrowserManager.instance;
	}

	/**
	 * Get the shared BrowserContext, connecting if needed.
	 * Concurrent callers share the same in-flight connection promise.
	 */
	async getContext(): Promise<BrowserContext> {
		if (this.context && !this.disconnected) {
			return this.context;
		}

		if (this.connecting) {
			return this.connecting;
		}

		this.connecting = this.connect();
		try {
			const ctx = await this.connecting;
			return ctx;
		} finally {
			this.connecting = null;
		}
	}

	/**
	 * Get or create a page for the given domain.
	 * Reuses an existing tab whose URL contains the domain string.
	 */
	async getPage(domain: string, fallbackUrl?: string): Promise<Page> {
		const ctx = await this.getContext();
		const pages = ctx.pages();
		// A aba de leitura da conversa também está no chatgpt.com e não pode
		// ser entregue como aba principal do provedor (veja ../viralizeai/abas.ts).
		const existing = pages.find((p) => p.url().includes(domain) && !ehAbaAuxiliar(p));
		// viralizeai: abas dos provedores são recarregadas de tempos em tempos
		// para não acumular memória (veja ../viralizeai/abas.ts).
		if (existing) {
			registrarPagina(existing);
			return existing;
		}

		const page = await ctx.newPage();
		if (fallbackUrl) {
			await page.goto(fallbackUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
		}
		registrarPagina(page);
		return page;
	}

	/**
	 * viralizeai: um cookie torto derrubava a injeção inteira.
	 *
	 *   [BrowserManager] addCookies failed: Protocol error (Storage.setCookies):
	 *   Invalid cookie fields
	 *
	 * `addCookies` é tudo ou nada: basta UM campo inválido no
	 * auth-profiles.json e nenhum cookie entra — de nenhum provedor. O gateway
	 * seguia sem a sessão e o erro aparecia só como uma linha de aviso.
	 *
	 * Aqui ficam só os campos que o Chrome aceita, com os valores normalizados.
	 * Cookie sem nome, sem valor ou sem domínio é descartado: ele não teria
	 * como ser aplicado mesmo.
	 */
	private static limparCookie(bruto: unknown): BrowserCookie | null {
		if (!bruto || typeof bruto !== "object") return null;
		const c = bruto as Record<string, unknown>;
		const name = typeof c.name === "string" ? c.name.trim() : "";
		const domain = typeof c.domain === "string" ? c.domain.trim() : "";
		if (!name || !domain) return null;
		if (typeof c.value !== "string") return null;

		const limpo: Record<string, unknown> = {
			name,
			value: c.value,
			domain,
			path: typeof c.path === "string" && c.path.startsWith("/") ? c.path : "/",
		};
		if (typeof c.secure === "boolean") limpo.secure = c.secure;
		if (typeof c.httpOnly === "boolean") limpo.httpOnly = c.httpOnly;
		// Sessão (sem expiração) é -1; data inválida ou no passado remoto só
		// faria o Chrome recusar o lote inteiro.
		if (typeof c.expires === "number" && Number.isFinite(c.expires) && c.expires > 0) {
			limpo.expires = Math.floor(c.expires);
		}
		const sameSite = String(c.sameSite ?? "").toLowerCase();
		if (sameSite === "strict") limpo.sameSite = "Strict";
		else if (sameSite === "lax") limpo.sameSite = "Lax";
		else if (sameSite === "none") limpo.sameSite = "None";
		return limpo as unknown as BrowserCookie;
	}

	/**
	 * Inject cookies into the shared browser context.
	 */
	async addCookies(cookies: BrowserCookie[]): Promise<void> {
		const ctx = await this.getContext();
		if (cookies.length === 0) return;
		try {
			// viralizeai: não sobrescreve sessão viva. O Chrome logado (pelo
			// noVNC/webauth) é a fonte de verdade; o cookie salvo em
			// auth-profiles.json só entra se o Chrome ainda não tiver aquele
			// cookie. Antes, um sessionKey antigo derrubava o login do Claude.
			const atuais = await ctx.cookies().catch(() => []);
			const chave = (c: { name: string; domain?: string }) =>
				`${c.name}|${String(c.domain || "").replace(/^\./, "")}`;
			const existentes = new Set(atuais.filter((c) => c.value).map(chave));
			const faltando = cookies
				.filter((c) => !existentes.has(chave(c)))
				.map((c) => BrowserManager.limparCookie(c))
				.filter((c): c is BrowserCookie => c !== null);
			if (!faltando.length) return;
			try {
				await ctx.addCookies(faltando);
			} catch {
				// Um cookie ruim não pode levar os outros junto: na segunda
				// tentativa cada um vai sozinho e só o culpado fica de fora.
				const recusados: string[] = [];
				for (const cookie of faltando) {
					await ctx.addCookies([cookie]).catch(() => recusados.push(cookie.name));
				}
				if (recusados.length) {
					// Só os NOMES: o valor do cookie é a credencial.
					console.warn(`[BrowserManager] cookies recusados pelo Chrome: ${recusados.join(", ")}`);
				}
			}
		} catch (err) {
			console.warn(
				`[BrowserManager] addCookies failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	/**
	 * Check whether Chrome is reachable and the CDP connection is alive.
	 */
	async isHealthy(): Promise<boolean> {
		if (this.disconnected || !this.browser || !this.context) {
			// Try a lightweight CDP probe even without an active connection
			const cdpUrl = getDefaultCdpUrl();
			const ws = await getChromeWebSocketUrl(cdpUrl, 3000);
			return ws !== null;
		}

		try {
			// Verify the context is still responsive
			const pages = this.context.pages();
			return pages.length >= 0; // will throw if disconnected
		} catch {
			return false;
		}
	}

	/**
	 * Graceful shutdown: disconnect from Chrome without killing it.
	 */
	async shutdown(): Promise<void> {
		if (this.browser) {
			try {
				this.browser.removeAllListeners("disconnected");
				await this.browser.close().catch(() => {});
			} catch {
				// ignore
			}
		}
		this.browser = null;
		this.context = null;
		this.disconnected = true;
		this.connecting = null;
	}

	// ── internal ──────────────────────────────────────────────────────

	private async connect(): Promise<BrowserContext> {
		const cdpUrl = getDefaultCdpUrl();
		console.log(`[BrowserManager] Connecting to Chrome at ${cdpUrl}...`);

		let wsUrl: string | null = null;
		for (let attempt = 0; attempt < 15; attempt++) {
			wsUrl = await getChromeWebSocketUrl(cdpUrl, 2000);
			if (wsUrl) break;

			// On first failure, try to auto-start Chrome
			if (attempt === 2) {
				await this.tryAutoStartChrome();
			}

			await new Promise((r) => setTimeout(r, 1000));
		}

		if (!wsUrl) {
			throw new Error(
				`[BrowserManager] Failed to connect to Chrome at ${cdpUrl}. ` +
					"Make sure Chrome is running in debug mode (token-free-gateway chrome start).",
			);
		}

		const browser = await chromium.connectOverCDP(wsUrl, {
			headers: getHeadersWithAuth(wsUrl),
		});

		const ctx = browser.contexts()[0];
		if (!ctx) {
			throw new Error("[BrowserManager] CDP connection returned no browser context");
		}

		this.browser = browser;
		this.context = ctx;
		this.disconnected = false;

		browser.on("disconnected", () => {
			console.warn("[BrowserManager] Chrome disconnected. Will auto-reconnect on next request.");
			this.browser = null;
			this.context = null;
			this.disconnected = true;
		});

		const pageCount = ctx.pages().length;
		console.log(
			`[BrowserManager] Connected successfully (${pageCount} existing tab${pageCount !== 1 ? "s" : ""})`,
		);

		return ctx;
	}

	private async tryAutoStartChrome(): Promise<void> {
		try {
			console.log("[BrowserManager] Chrome not reachable, attempting auto-start...");
			const { startChrome } = await import("../cli/chrome.ts");
			await startChrome();
		} catch (err) {
			console.warn(
				`[BrowserManager] Auto-start failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
}

export { BrowserManager };
