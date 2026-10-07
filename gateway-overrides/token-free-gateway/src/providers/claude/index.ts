import type { ProviderDefinition } from "../types.ts";
import { loginClaudeWeb } from "./auth.ts";
import { CLAUDE_WEB_MODELS, ClaudeWebClient } from "./client.ts";

export const definition: ProviderDefinition = {
	id: "claude-web",
	name: "Claude Web",
	models: CLAUDE_WEB_MODELS,
	factory: (credentials) => new ClaudeWebClient(credentials as any),
	loginFn: loginClaudeWeb,
};
