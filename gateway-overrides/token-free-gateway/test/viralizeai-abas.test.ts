import assert from "node:assert/strict";
import { test } from "node:test";
import {
	RECARREGAR_MS,
	comecarPedido,
	enderecoLimpo,
	recarregarAbasVelhas,
	registrarPagina,
} from "../src/viralizeai/abas.ts";

type Falsa = { url: () => string; isClosed: () => boolean; goto: (u: string) => Promise<void>; reload: () => Promise<void>; once: () => void; idas: string[]; recargas: number };

function abaFalsa(url: string, { demoraMs = 0 } = {}): Falsa {
	const aba: Falsa = {
		idas: [],
		recargas: 0,
		url: () => url,
		isClosed: () => false,
		goto: async (u: string) => {
			await new Promise((r) => setTimeout(r, demoraMs));
			aba.idas.push(u);
			url = u;
		},
		reload: async () => {
			aba.recargas += 1;
		},
		once: () => {},
	};
	return aba;
}

const pagina = (a: Falsa) => a as unknown as Parameters<typeof registrarPagina>[0];

test("cada site volta para a página inicial, sem conversa aberta", () => {
	assert.equal(enderecoLimpo("https://chatgpt.com/c/6ad19384-8b78"), "https://chatgpt.com/");
	assert.equal(enderecoLimpo("https://claude.ai/chat/abc"), "https://claude.ai/new");
	assert.equal(enderecoLimpo("https://chat.deepseek.com/a/chat/s/1"), "https://chat.deepseek.com/");
	assert.equal(enderecoLimpo("https://g1.globo.com/"), null);
});

test("aba velha é recarregada; aba nova fica como está", async () => {
	const inicio = 1_000_000;
	const velha = abaFalsa("https://chatgpt.com/c/conversa-pesada");
	const nova = abaFalsa("https://claude.ai/new");
	registrarPagina(pagina(velha), inicio);
	registrarPagina(pagina(nova), inicio + RECARREGAR_MS - 1);
	const n = await recarregarAbasVelhas(inicio + RECARREGAR_MS);
	assert.equal(n, 1);
	assert.deepEqual(velha.idas, ["https://chatgpt.com/"]);
	assert.equal(nova.idas.length + nova.recargas, 0);
});

test("com pedido em andamento não recarrega nada", async () => {
	const aba = abaFalsa("https://chat.deepseek.com/");
	registrarPagina(pagina(aba), 0);
	const encerrar = await comecarPedido();
	assert.equal(await recarregarAbasVelhas(Date.now() + 10 * RECARREGAR_MS), 0);
	encerrar();
	encerrar(); // encerrar duas vezes não desconta outro pedido
	assert.ok((await recarregarAbasVelhas(Date.now() + 10 * RECARREGAR_MS)) >= 1);
	assert.equal(aba.recargas, 1, "já estava na página inicial: só recarrega");
});

test("pedido que chega durante a recarga espera ela terminar", async () => {
	const aba = abaFalsa("https://claude.ai/chat/x", { demoraMs: 60 });
	registrarPagina(pagina(aba), 0);
	const recarga = recarregarAbasVelhas(Date.now() + 10 * RECARREGAR_MS);
	await new Promise((r) => setTimeout(r, 5));
	const encerrar = await comecarPedido();
	assert.deepEqual(aba.idas, ["https://claude.ai/new"], "o pedido só começou depois da página pronta");
	encerrar();
	await recarga;
});
