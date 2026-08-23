import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const keychainService = "good-agent-context";

interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
}

interface TokenSet {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  client_id: string;
  token_endpoint: string;
}

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
}

function base64Url(value: Buffer): string {
  return value.toString("base64url");
}

function problem(message: string): Error {
  return new Error(`Cloudflare Access login failed: ${message}`);
}

function accountFor(baseUrl: string): string {
  return new URL(baseUrl).origin;
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw problem(`response did not contain ${field}.`);
  return value;
}

async function fetchJson(url: URL | string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) throw problem(`request to ${new URL(url).origin} returned HTTP ${response.status}.`);
  return payload;
}

async function metadataFor(baseUrl: string): Promise<AuthorizationServerMetadata> {
  const origin = accountFor(baseUrl);
  const metadata = await fetchJson(new URL("/.well-known/oauth-authorization-server", `${origin}/`));
  if (!metadata || typeof metadata !== "object") throw problem("authorization-server metadata was invalid.");
  const candidate = metadata as Record<string, unknown>;
  return {
    issuer: stringField(candidate.issuer, "issuer"),
    authorization_endpoint: stringField(candidate.authorization_endpoint, "authorization_endpoint"),
    token_endpoint: stringField(candidate.token_endpoint, "token_endpoint"),
    registration_endpoint: stringField(candidate.registration_endpoint, "registration_endpoint"),
  };
}

async function registerLoopbackClient(metadata: AuthorizationServerMetadata, redirectUri: string): Promise<string> {
  const registration = await fetchJson(metadata.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Good Agent Context CLI",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (!registration || typeof registration !== "object") throw problem("dynamic client registration response was invalid.");
  return stringField((registration as Record<string, unknown>).client_id, "client_id");
}

function waitForCallback(server: ReturnType<typeof createServer>, expectedState: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(problem("timed out waiting for the browser callback.")), 5 * 60_000);
    server.on("request", (request, response) => {
      const remote = request.socket.remoteAddress;
      if (remote !== "127.0.0.1" && remote !== "::1" && remote !== "::ffff:127.0.0.1") {
        response.writeHead(403).end("Loopback callback required.");
        return;
      }
      const callback = new URL(request.url ?? "/", "http://127.0.0.1");
      if (callback.pathname !== "/callback") {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found.");
        return;
      }
      const code = callback.searchParams.get("code");
      if (!code || callback.searchParams.get("state") !== expectedState) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("Login could not be verified. Return to the terminal and try again.");
        clearTimeout(timeout);
        reject(problem("callback was missing a matching authorization code and state."));
        return;
      }
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("Good Agent Context login complete. You can close this tab.");
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

async function openBrowser(url: URL): Promise<void> {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url.toString()] : [url.toString()];
  try {
    await execFileAsync(command, args);
  } catch {
    process.stderr.write(`Open this URL in a browser to continue:\n${url}\n`);
  }
}

async function exchangeToken(tokenEndpoint: string, parameters: URLSearchParams): Promise<TokenSet> {
  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: parameters,
  });
  const payload = await response.json().catch(() => undefined) as TokenResponse | undefined;
  if (!response.ok) throw problem(`token endpoint returned HTTP ${response.status}.`);
  const accessToken = stringField(payload?.access_token, "access_token");
  const expiresIn = typeof payload?.expires_in === "number" && Number.isFinite(payload.expires_in) ? payload.expires_in : 300;
  return {
    access_token: accessToken,
    refresh_token: typeof payload?.refresh_token === "string" ? payload.refresh_token : undefined,
    expires_at: Date.now() + expiresIn * 1_000,
    client_id: parameters.get("client_id") ?? "",
    token_endpoint: tokenEndpoint,
  };
}

async function keychainRead(account: string): Promise<TokenSet | undefined> {
  if (process.platform !== "darwin") return undefined;
  try {
    const { stdout } = await execFileAsync("security", ["find-generic-password", "-s", keychainService, "-a", account, "-w"]);
    const parsed: unknown = JSON.parse(stdout);
    if (!parsed || typeof parsed !== "object") return undefined;
    const token = parsed as Partial<TokenSet>;
    if (typeof token.access_token !== "string" || typeof token.client_id !== "string" || typeof token.token_endpoint !== "string" || typeof token.expires_at !== "number") return undefined;
    return token as TokenSet;
  } catch {
    return undefined;
  }
}

async function keychainWrite(account: string, token: TokenSet): Promise<void> {
  if (process.platform !== "darwin") {
    throw problem("secure credential storage is currently supported by this CLI on macOS only; set GOOD_CONTEXT_TOKEN instead.");
  }
  await execFileAsync("security", ["add-generic-password", "-U", "-s", keychainService, "-a", account, "-w", JSON.stringify(token)]);
}

export async function loginWithCloudflareAccess(baseUrl: string): Promise<void> {
  const metadata = await metadataFor(baseUrl);
  process.stderr.write(`Discovered Cloudflare Access issuer ${metadata.issuer}.\n`);
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", () => resolve()).once("error", reject));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw problem("could not allocate a loopback callback port.");
    const redirectUri = `http://127.0.0.1:${address.port}/callback`;
    const clientId = await registerLoopbackClient(metadata, redirectUri);
    process.stderr.write("Registered a loopback PKCE client; opening the browser…\n");
    const verifier = base64Url(randomBytes(48));
    const challenge = base64Url(createHash("sha256").update(verifier).digest());
    const state = base64Url(randomBytes(24));
    const authorization = new URL(metadata.authorization_endpoint);
    authorization.searchParams.set("response_type", "code");
    authorization.searchParams.set("client_id", clientId);
    authorization.searchParams.set("redirect_uri", redirectUri);
    authorization.searchParams.set("code_challenge", challenge);
    authorization.searchParams.set("code_challenge_method", "S256");
    authorization.searchParams.set("state", state);
    authorization.searchParams.set("resource", accountFor(baseUrl));
    const callback = waitForCallback(server, state);
    await openBrowser(authorization);
    process.stderr.write("Waiting for the browser callback…\n");
    const code = await callback;
    const token = await exchangeToken(metadata.token_endpoint, new URLSearchParams({
      grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier,
    }));
    await keychainWrite(accountFor(baseUrl), token);
    process.stderr.write("Stored refresh credentials in the macOS Keychain.\n");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

export async function storedAccessToken(baseUrl: string): Promise<string | undefined> {
  const account = accountFor(baseUrl);
  const token = await keychainRead(account);
  if (!token) return undefined;
  if (token.expires_at > Date.now() + 30_000) return token.access_token;
  if (!token.refresh_token) return undefined;
  const refreshed = await exchangeToken(token.token_endpoint, new URLSearchParams({
    grant_type: "refresh_token", refresh_token: token.refresh_token, client_id: token.client_id,
  }));
  if (!refreshed.refresh_token) refreshed.refresh_token = token.refresh_token;
  await keychainWrite(account, refreshed);
  return refreshed.access_token;
}
