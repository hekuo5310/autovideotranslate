import type { Env } from "../types";

const GRAPH = "https://graph.microsoft.com/v1.0";
const SCOPES = "offline_access Files.ReadWrite User.Read";

type Connection = {
  id: string;
  drive_id: string;
  refresh_token_ciphertext: string;
  account_id: string | null;
  account_name: string | null;
};

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
};

type DriveItem = {
  id: string;
  name: string;
  size?: number;
  webUrl?: string;
  parentReference?: { path?: string };
  ["@microsoft.graph.downloadUrl"]?: string;
};

export type UploadSession = {
  uploadUrl: string;
  expirationDateTime: string;
  nextExpectedRanges?: string[];
};

let cachedAccess: { token: string; expiresAt: number; connectionId: string } | null = null;

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function unb64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), c => c.charCodeAt(0));
}
async function aesKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function encryptSecret(secret: string, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(secret);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)));
  return `v1.${b64(iv)}.${b64(cipher)}`;
}
async function decryptSecret(secret: string, stored: string): Promise<string> {
  const [version, iv64, cipher64] = stored.split(".");
  if (version !== "v1" || !iv64 || !cipher64) throw new Error("Invalid encrypted token format");
  const key = await aesKey(secret);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv64) }, key, unb64(cipher64));
  return new TextDecoder().decode(plain);
}

function encodePath(path: string): string {
  return path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}
function rootPath(env: Env): string {
  return env.ONEDRIVE_ROOT_PATH.replace(/^\/+|\/+$/g, "");
}
export function projectPath(env: Env, projectId: string, relative: string): string {
  return [rootPath(env), "projects", projectId, relative].filter(Boolean).join("/");
}
function tokenUrl(env: Env): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(env.ONEDRIVE_TENANT_ID || "common")}/oauth2/v2.0/token`;
}
export function oauthRedirectUri(env: Env): string {
  return new URL("/api/auth/onedrive/callback", env.APP_ORIGIN).toString();
}
export function oauthAuthorizeUrl(env: Env, state: string, challenge: string): string {
  const u = new URL(`https://login.microsoftonline.com/${encodeURIComponent(env.ONEDRIVE_TENANT_ID || "common")}/oauth2/v2.0/authorize`);
  u.searchParams.set("client_id", env.ONEDRIVE_CLIENT_ID);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", oauthRedirectUri(env));
  u.searchParams.set("response_mode", "query");
  u.searchParams.set("scope", SCOPES);
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}
async function postToken(env: Env, form: URLSearchParams): Promise<TokenResponse> {
  form.set("client_id", env.ONEDRIVE_CLIENT_ID);
  if (env.ONEDRIVE_CLIENT_SECRET) form.set("client_secret", env.ONEDRIVE_CLIENT_SECRET);
  const r = await fetch(tokenUrl(env), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
  if (!r.ok) throw new Error(`Microsoft token request failed (${r.status}): ${await r.text()}`);
  return r.json<TokenResponse>();
}
async function currentConnection(env: Env): Promise<Connection> {
  const row = await env.DB.prepare(
    "SELECT id, drive_id, refresh_token_ciphertext, account_id, account_name FROM onedrive_connections WHERE active = 1 ORDER BY updated_at DESC LIMIT 1"
  ).first<Connection>();
  if (!row) throw new Error("OneDrive is not connected");
  return row;
}
async function accessToken(env: Env): Promise<{ token: string; connection: Connection }> {
  const connection = await currentConnection(env);
  if (cachedAccess && cachedAccess.connectionId === connection.id && cachedAccess.expiresAt > Date.now() + 60_000) {
    return { token: cachedAccess.token, connection };
  }
  const refresh = await decryptSecret(env.TOKEN_ENCRYPTION_KEY, connection.refresh_token_ciphertext);
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refresh,
    scope: SCOPES,
  });
  const token = await postToken(env, form);
  if (token.refresh_token) {
    const encrypted = await encryptSecret(env.TOKEN_ENCRYPTION_KEY, token.refresh_token);
    await env.DB.prepare("UPDATE onedrive_connections SET refresh_token_ciphertext = ?, updated_at = ? WHERE id = ?")
      .bind(encrypted, Date.now(), connection.id).run();
    connection.refresh_token_ciphertext = encrypted;
  }
  cachedAccess = {
    token: token.access_token,
    expiresAt: Date.now() + Math.max(60, token.expires_in ?? 3600) * 1000,
    connectionId: connection.id,
  };
  return { token: token.access_token, connection };
}
async function graphFetch(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  const { token } = await accessToken(env);
  const h = new Headers(init.headers);
  h.set("authorization", `Bearer ${token}`);
  if (init.body && !h.has("content-type")) h.set("content-type", "application/json");
  return fetch(`${GRAPH}${path}`, { ...init, headers: h });
}
async function graphJson<T>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
  const r = await graphFetch(env, path, init);
  if (!r.ok) throw new Error(`Microsoft Graph request failed (${r.status}): ${await r.text()}`);
  return r.json<T>();
}

export async function finishOAuth(env: Env, code: string, verifier: string): Promise<void> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: oauthRedirectUri(env),
    code_verifier: verifier,
    scope: SCOPES,
  });
  const token = await postToken(env, form);
  if (!token.refresh_token) throw new Error("Microsoft did not return a refresh token");
  const auth = `Bearer ${token.access_token}`;
  const [driveRes, meRes] = await Promise.all([
    fetch(`${GRAPH}/me/drive?$select=id`, { headers: { authorization: auth } }),
    fetch(`${GRAPH}/me?$select=id,displayName,userPrincipalName`, { headers: { authorization: auth } }),
  ]);
  if (!driveRes.ok) throw new Error(`Unable to resolve OneDrive: ${await driveRes.text()}`);
  const drive = await driveRes.json<{ id: string }>();
  const me = meRes.ok ? await meRes.json<{ id?: string; displayName?: string; userPrincipalName?: string }>() : {};
  const encrypted = await encryptSecret(env.TOKEN_ENCRYPTION_KEY, token.refresh_token);
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("UPDATE onedrive_connections SET active = 0 WHERE active = 1"),
    env.DB.prepare(
      "INSERT INTO onedrive_connections (id, drive_id, refresh_token_ciphertext, account_id, account_name, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)"
    ).bind(id, drive.id, encrypted, me.id ?? null, me.userPrincipalName ?? me.displayName ?? null, now, now),
  ]);
  cachedAccess = {
    token: token.access_token,
    expiresAt: Date.now() + Math.max(60, token.expires_in ?? 3600) * 1000,
    connectionId: id,
  };
}

export async function connectionStatus(env: Env) {
  const row = await env.DB.prepare(
    "SELECT drive_id, account_id, account_name, created_at, updated_at FROM onedrive_connections WHERE active = 1 ORDER BY updated_at DESC LIMIT 1"
  ).first();
  return row ? { connected: true, ...row } : { connected: false };
}
async function driveId(env: Env): Promise<string> {
  return (await currentConnection(env)).drive_id;
}
export async function getDriveItem(env: Env, itemId: string): Promise<DriveItem> {
  return graphJson(env, `/drives/${encodeURIComponent(await driveId(env))}/items/${encodeURIComponent(itemId)}?$select=id,name,size,webUrl,parentReference`);
}
export async function getDownloadUrl(env: Env, itemId: string): Promise<string> {
  const item = await graphJson<DriveItem>(env, `/drives/${encodeURIComponent(await driveId(env))}/items/${encodeURIComponent(itemId)}?$select=id,@microsoft.graph.downloadUrl`);
  const u = item["@microsoft.graph.downloadUrl"];
  if (!u) throw new Error("OneDrive did not return a download URL");
  return u;
}
async function getItemByPath(env: Env, path: string): Promise<DriveItem | null> {
  const r = await graphFetch(env, `/drives/${encodeURIComponent(await driveId(env))}/root:/${encodePath(path)}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Graph path lookup failed (${r.status}): ${await r.text()}`);
  return r.json<DriveItem>();
}
async function createFolder(env: Env, parentId: string | "root", name: string): Promise<DriveItem> {
  const drive = encodeURIComponent(await driveId(env));
  const path = parentId === "root"
    ? `/drives/${drive}/root/children`
    : `/drives/${drive}/items/${encodeURIComponent(parentId)}/children`;
  return graphJson(env, path, {
    method: "POST",
    body: JSON.stringify({ name, folder: {}, "@microsoft.graph.conflictBehavior": "fail" }),
  });
}
async function ensureFolderPath(env: Env, folderPath: string): Promise<void> {
  const segments = folderPath.split("/").filter(Boolean);
  let currentPath = "";
  let parentId: string | "root" = "root";
  for (const segment of segments) {
    currentPath = currentPath ? `${currentPath}/${segment}` : segment;
    const existing = await getItemByPath(env, currentPath);
    if (existing) { parentId = existing.id; continue; }
    try {
      parentId = (await createFolder(env, parentId, segment)).id;
    } catch (error) {
      const raced = await getItemByPath(env, currentPath);
      if (!raced) throw error;
      parentId = raced.id;
    }
  }
}
export async function createUploadSession(env: Env, path: string, conflictBehavior: "replace" | "rename" | "fail" = "replace"): Promise<UploadSession> {
  const slash = path.lastIndexOf("/");
  const parent = slash === -1 ? "" : path.slice(0, slash);
  const filename = slash === -1 ? path : path.slice(slash + 1);
  if (parent) await ensureFolderPath(env, parent);
  return graphJson(env, `/drives/${encodeURIComponent(await driveId(env))}/root:/${encodePath(path)}:/createUploadSession`, {
    method: "POST",
    body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": conflictBehavior, name: filename } }),
  });
}
export async function assertProjectItem(env: Env, projectId: string, itemId: string): Promise<DriveItem> {
  const item = await getDriveItem(env, itemId);
  const expected = `/${rootPath(env)}/projects/${projectId}`.toLowerCase();
  const actual = (item.parentReference?.path ?? "").toLowerCase();
  if (!actual.includes(expected)) throw new Error("OneDrive item is outside this project");
  return item;
}
