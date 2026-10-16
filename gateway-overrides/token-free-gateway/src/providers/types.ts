export interface ModelInfo {
	id: string;
	name: string;
}

export interface StreamResult {
	text: string;
	thinkingText: string;
	/**
	 * viralizeai: imagens que vieram NA MESMA resposta (a foto que o ChatGPT
	 * mostra junto da matéria). O parser lia só `parts[0]` e só aproveitava
	 * se fosse texto, então elas eram descartadas aqui dentro e nunca
	 * chegavam ao ViralizeAI.
	 *
	 * Pode ser URL pública (foto achada na web) ou ponteiro interno do
	 * ChatGPT (`file-service://…`, imagem gerada). Quem consome decide.
	 */
	imagens?: string[];
	/**
	 * viralizeai: ponteiro da conversa real no provedor (`chatgpt:<conversa>:
	 * <mensagem>`). Mandado de volta como `conversation_id`, faz a próxima
	 * mensagem continuar a MESMA conversa no chatgpt.com.
	 */
	conversa?: string;
	/** viralizeai: endereço dessa conversa (https://chatgpt.com/c/<id>). */
	conversaUrl?: string;
	/**
	 * viralizeai: a resposta chamou o gerador de imagem. Quando o stream fecha
	 * antes de a imagem ficar pronta, o client lê a conversa até ela aparecer.
	 */
	aguardandoImagem?: boolean;
	/**
	 * viralizeai: quantas das `imagens` (as primeiras) são fotos que a tela do
	 * ChatGPT mostrou (<AsyncImage>), e não miniaturas de páginas citadas.
	 */
	fotosDaTela?: number;
	/** viralizeai: imagem → página de onde ela veio (para o crédito). */
	paginasDasImagens?: Record<string, string>;
}

export class SessionExpiredError extends Error {
	constructor(
		public readonly providerId: string,
		message?: string,
	) {
		super(
			message ??
				`Session expired for provider "${providerId}". Run 'token-free-gateway webauth' to re-authorize.`,
		);
		this.name = "SessionExpiredError";
	}
}

/**
 * Carries a provider-side HTTP status code so the gateway can return
 * an appropriate HTTP status to the client (e.g. 400 → don't retry).
 */
export class ProviderApiError extends Error {
	constructor(
		public readonly httpStatus: number,
		message: string,
	) {
		super(message);
		this.name = "ProviderApiError";
	}
}

export interface WebProviderClient {
	readonly providerId: string;
	init(): Promise<void>;
	sendMessage(params: {
		message: string;
		model?: string;
		signal?: AbortSignal;
		conversationId?: string;
		conversationName?: string;
		webSearch?: boolean;
	}): Promise<ReadableStream<Uint8Array>>;
	parseStream(
		body: ReadableStream<Uint8Array>,
		onDelta?: (delta: string) => void,
	): Promise<StreamResult>;
	listModels(): ModelInfo[];
	close?(): Promise<void>;
	/** Lightweight session validity check (e.g. cookie expiry, test API call). */
	checkSession?(): Promise<{ valid: boolean; reason?: string }>;
}

export type WebProviderFactory = (credentials: unknown) => WebProviderClient;

/**
 * Race a promise against a timeout. Rejects with a descriptive error on expiry.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label = "Operation"): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
		}),
	]).finally(() => clearTimeout(timer));
}

export interface ProviderDefinition {
	id: string;
	name: string;
	models: ModelInfo[];
	factory: WebProviderFactory;
	loginFn: (params: {
		onProgress: (msg: string) => void;
		openUrl: (url: string) => Promise<boolean>;
	}) => Promise<unknown>;
}
