import { Hono } from "hono";
import type { Env, Variables } from "../types.js";

const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function base64url(data: ArrayBuffer | Uint8Array): string {
	const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
	let binary = "";
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function decodeBase64url(str: string): Uint8Array {
	const padded = str.replace(/-/g, "+").replace(/_/g, "/");
	const padding = (4 - (padded.length % 4)) % 4;
	const binary = atob(padded + "=".repeat(padding));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

async function hmacSign(key: string, data: string): Promise<string> {
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(key),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
	return base64url(sig);
}

async function sha256Base64url(data: string): Promise<string> {
	const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
	return base64url(hash);
}

function safeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

const oauthRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// OAuth Authorization Server metadata (RFC 8414)
oauthRoutes.get("/.well-known/oauth-authorization-server", (c) => {
	const base = new URL(c.req.url).origin;
	return c.json({
		issuer: base,
		authorization_endpoint: `${base}/oauth/authorize`,
		token_endpoint: `${base}/oauth/token`,
		registration_endpoint: `${base}/oauth/register`,
		response_types_supported: ["code"],
		grant_types_supported: ["authorization_code"],
		code_challenge_methods_supported: ["S256"],
		token_endpoint_auth_methods_supported: ["none"],
	});
});

// Protected resource metadata (RFC 9728)
oauthRoutes.get("/.well-known/oauth-protected-resource", (c) => {
	const base = new URL(c.req.url).origin;
	return c.json({
		resource: base,
		authorization_servers: [base],
		bearer_methods_supported: ["header"],
	});
});

// Dynamic client registration (RFC 7591) — stateless: accept any public client
oauthRoutes.post("/oauth/register", async (c) => {
	let body: Record<string, unknown> = {};
	try {
		body = await c.req.json();
	} catch {
		// keep defaults on malformed body
	}
	const clientId = (body.client_id as string) || crypto.randomUUID();
	return c.json(
		{
			client_id: clientId,
			client_id_issued_at: Math.floor(Date.now() / 1000),
			redirect_uris: (body.redirect_uris as string[]) ?? [],
			grant_types: (body.grant_types as string[]) ?? ["authorization_code"],
			response_types: (body.response_types as string[]) ?? ["code"],
			token_endpoint_auth_method: "none",
			...(body.client_name ? { client_name: body.client_name } : {}),
		},
		201,
	);
});

const PAGE_STYLE = `
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  background:#f1f5f9; display:flex; align-items:center; justify-content:center;
  min-height:100vh; padding:1rem; color:#1e293b; }
.card { background:#fff; border-radius:14px; box-shadow:0 10px 30px rgba(0,0,0,0.12);
  padding:2rem; max-width:420px; width:100%; }
.logo { background:linear-gradient(135deg,#16a34a,#059669); color:#fff;
  border-radius:10px; padding:0.5rem 0.9rem; display:inline-block; font-weight:700;
  font-size:1.05rem; margin-bottom:1.2rem; }
h1 { font-size:1.25rem; margin-bottom:0.4rem; }
p { color:#64748b; font-size:0.9rem; margin-bottom:1.4rem; }
label { display:block; font-size:0.85rem; font-weight:500; color:#374151; margin-bottom:0.3rem; }
input[type=password] { width:100%; padding:0.65rem 0.8rem; border:1px solid #d1d5db;
  border-radius:8px; font-size:0.95rem; outline:none; }
input[type=password]:focus { border-color:#059669; box-shadow:0 0 0 3px rgba(5,150,105,0.15); }
button { width:100%; background:#16a34a; color:#fff; border:none; border-radius:8px;
  padding:0.72rem; font-size:1rem; font-weight:600; cursor:pointer; margin-top:1rem; }
button:hover { background:#15803d; }
.hint { font-size:0.78rem; color:#94a3b8; margin-top:1rem; word-break:break-all; }
`;

// Authorization endpoint — GET: display the authorization form
oauthRoutes.get("/oauth/authorize", (c) => {
	const qs = c.req.query();
	const { response_type, client_id, redirect_uri, state, code_challenge, code_challenge_method } = qs;

	if (response_type !== "code") {
		return c.json({ error: "unsupported_response_type" }, 400);
	}
	if (!code_challenge || !redirect_uri) {
		return c.json(
			{ error: "invalid_request", error_description: "code_challenge and redirect_uri are required" },
			400,
		);
	}

	const actionParams = new URLSearchParams({
		response_type: response_type ?? "",
		client_id: client_id ?? "",
		redirect_uri: redirect_uri ?? "",
		state: state ?? "",
		code_challenge: code_challenge ?? "",
		code_challenge_method: code_challenge_method ?? "S256",
	});

	return c.html(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Authorize — Cronometer MCP</title>
<style>${PAGE_STYLE}</style></head>
<body><div class="card">
<div class="logo">Cronometer MCP</div>
<h1>Authorize Claude</h1>
<p>Enter your <strong>MCP access token</strong> (<code>MCP_AUTH_TOKEN</code>) to allow Claude to read and log your Cronometer nutrition data.</p>
<form method="POST" action="/oauth/authorize?${actionParams}">
  <label for="token">MCP Access Token</label>
  <input type="password" id="token" name="token" placeholder="Paste your MCP_AUTH_TOKEN here" required autofocus>
  <button type="submit">Authorize</button>
</form>
<p class="hint">Requesting client: ${client_id ?? "unknown"}</p>
</div></body></html>`);
});

// Authorization endpoint — POST: validate token, issue signed code, redirect
oauthRoutes.post("/oauth/authorize", async (c) => {
	const qs = c.req.query();
	const { client_id, redirect_uri, state, code_challenge } = qs;

	const form = await c.req.formData();
	const token = (form.get("token") as string | null) ?? "";

	if (!token || !safeEqual(token, c.env.MCP_AUTH_TOKEN)) {
		return c.html(
			`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Error — Cronometer MCP</title>
<style>${PAGE_STYLE}</style></head>
<body><div class="card">
<div class="logo">Cronometer MCP</div>
<h1 style="color:#dc2626">Invalid Token</h1>
<p>The access token you entered is incorrect. <a href="javascript:history.back()" style="color:#059669">Try again</a>.</p>
</div></body></html>`,
			401,
		);
	}

	// Stateless auth code: base64url(payload) + "." + HMAC(payload)
	const payload = base64url(
		new TextEncoder().encode(
			JSON.stringify({
				cid: client_id ?? "",
				ruri: redirect_uri ?? "",
				cc: code_challenge ?? "",
				exp: Date.now() + CODE_TTL_MS,
			}),
		),
	);
	const sig = await hmacSign(c.env.MCP_AUTH_TOKEN, payload);
	const code = `${payload}.${sig}`;

	const dest = new URL(redirect_uri ?? "");
	dest.searchParams.set("code", code);
	if (state) dest.searchParams.set("state", state);

	return c.redirect(dest.toString(), 302);
});

// Token endpoint — exchange auth code for bearer access token
oauthRoutes.post("/oauth/token", async (c) => {
	const contentType = c.req.header("content-type") ?? "";
	let params: Record<string, string>;
	if (contentType.includes("application/json")) {
		params = await c.req.json();
	} else {
		const form = await c.req.formData();
		params = Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]));
	}

	const { grant_type, code, code_verifier } = params;

	if (grant_type !== "authorization_code") {
		return c.json({ error: "unsupported_grant_type" }, 400);
	}
	if (!code) {
		return c.json({ error: "invalid_grant", error_description: "Missing code" }, 400);
	}

	const dotIdx = code.lastIndexOf(".");
	if (dotIdx < 0) return c.json({ error: "invalid_grant" }, 400);

	const payload = code.slice(0, dotIdx);
	const sig = code.slice(dotIdx + 1);

	// Verify HMAC signature
	const expectedSig = await hmacSign(c.env.MCP_AUTH_TOKEN, payload);
	if (!safeEqual(sig, expectedSig)) {
		return c.json({ error: "invalid_grant" }, 400);
	}

	// Decode payload
	let data: { cid: string; ruri: string; cc: string; exp: number };
	try {
		data = JSON.parse(new TextDecoder().decode(decodeBase64url(payload)));
	} catch {
		return c.json({ error: "invalid_grant" }, 400);
	}

	if (Date.now() > data.exp) {
		return c.json({ error: "invalid_grant", error_description: "Authorization code expired" }, 400);
	}

	// Verify PKCE S256
	if (code_verifier) {
		const computed = await sha256Base64url(code_verifier);
		if (computed !== data.cc) {
			return c.json({ error: "invalid_grant", error_description: "PKCE verification failed" }, 400);
		}
	} else if (data.cc) {
		// code_challenge was provided but no verifier — reject
		return c.json({ error: "invalid_grant", error_description: "code_verifier required" }, 400);
	}

	// The access token IS the MCP_AUTH_TOKEN; existing bearer middleware accepts it unchanged
	return c.json({
		access_token: c.env.MCP_AUTH_TOKEN,
		token_type: "Bearer",
		expires_in: 31_536_000,
	});
});

export default oauthRoutes;
