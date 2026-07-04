/** Cloudflare bindings available to the Worker. */
export interface Env {
	MCP_OBJECT: DurableObjectNamespace;
	/** Singleton DO that persists the Cronometer session across all MCP sessions. */
	SESSION_STORE: DurableObjectNamespace;
	/** Static bearer token the MCP client must send. */
	MCP_AUTH_TOKEN: string;
	/** Cronometer account email (Worker secret). */
	CRONOMETER_EMAIL: string;
	/** Cronometer account password (Worker secret). */
	CRONOMETER_PASSWORD: string;
}

/** Per-request props passed through to the MCP Durable Object. */
export type Props = {
	authenticated: boolean;
	baseUrl?: string;
};

/** Hono context variables. */
export interface Variables {
	props?: Props;
}
