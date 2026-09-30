import type { Env } from "../types";

const GRAPH = "https://graph.microsoft.com/v1.0";

type TokenCache = {
  token: string;
  expiresAt: number;
};

let tokenCache: TokenCache | null = null;

export interface DriveItem {
  id: string;
  name: string;
  size?: number;
  webUrl?: string;
  parentReference?: {
    driveId?: string;
    id?: string;
    path?: string;
  };
  ["@microsoft.graph.downloadUrl"]?: string;
}

export interface UploadSession {
  uploadUrl: string;
  expirationDateTime: string;
  nextExpectedRanges?: string[];
}

function encodePath(path: string): string {
  return path
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function rootPath(env: Env): string {
  return env.ONEDRIVE_ROOT_PATH.replace(/^\/+|\/+$/g, "");
}

export function projectPath(env: Env, projectId: string, relative: string): string {
  return [rootPath(env), "projects", projectId, relative]
    .filter(Boolean)
    .join("/");
}

async function accessToken(env: Env): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) {
    return tokenCache.token;
  }

  const tenant = env.ONEDRIVE_TENANT_ID || "common";
  const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;
  const form = new URLSearchParams();

  if (env.ONEDRIVE_AUTH_MODE === "refresh_token") {
    if (!env.ONEDRIVE_REFRESH_TOKEN) {
      throw new Error("ONEDRIVE_REFRESH_TOKEN is required for refresh_token auth mode");
    }
    form.set("client_id", env.ONEDRIVE_CLIENT_ID);
    if (env.ONEDRIVE_CLIENT_SECRET) {
      form.set("client_secret", env.ONEDRIVE_CLIENT_SECRET);
    }
    form.set("grant_type", "refresh_token");
    form.set("refresh_token", env.ONEDRIVE_REFRESH_TOKEN);
    form.set("scope", "offline_access Files.ReadWrite");
  } else {
    if (!env.ONEDRIVE_CLIENT_SECRET) {
      throw new Error("ONEDRIVE_CLIENT_SECRET is required for client_credentials auth mode");
    }
    form.set("client_id", env.ONEDRIVE_CLIENT_ID);
    form.set("client_secret", env.ONEDRIVE_CLIENT_SECRET);
    form.set("grant_type", "client_credentials");
    form.set("scope", "https://graph.microsoft.com/.default");
  }

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });

  if (!response.ok) {
    throw new Error(`OneDrive token request failed (${response.status}): ${await response.text()}`);
  }

  const body = (await response.json()) as {
    access_token: string;
    expires_in?: number;
  };

  tokenCache = {
    token: body.access_token,
    expiresAt: Date.now() + Math.max(60, body.expires_in ?? 3600) * 1000,
  };
  return body.access_token;
}

async function graphFetch(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  const token = await accessToken(env);
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  return fetch(`${GRAPH}${path}`, {
    ...init,
    headers,
  });
}

async function graphJson<T>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
  const response = await graphFetch(env, path, init);
  if (!response.ok) {
    throw new Error(`Microsoft Graph request failed (${response.status}): ${await response.text()}`);
  }
  return response.json<T>();
}

export async function getDriveItem(env: Env, itemId: string): Promise<DriveItem> {
  return graphJson<DriveItem>(
    env,
    `/drives/${encodeURIComponent(env.ONEDRIVE_DRIVE_ID)}/items/${encodeURIComponent(itemId)}?$select=id,name,size,webUrl,parentReference`,
  );
}

export async function getDownloadUrl(env: Env, itemId: string): Promise<string> {
  const item = await graphJson<DriveItem>(
    env,
    `/drives/${encodeURIComponent(env.ONEDRIVE_DRIVE_ID)}/items/${encodeURIComponent(itemId)}?$select=id,@microsoft.graph.downloadUrl`,
  );

  const url = item["@microsoft.graph.downloadUrl"];
  if (!url) throw new Error("OneDrive did not return a download URL");
  return url;
}

async function getItemByPath(env: Env, path: string): Promise<DriveItem | null> {
  const encoded = encodePath(path);
  const response = await graphFetch(
    env,
    `/drives/${encodeURIComponent(env.ONEDRIVE_DRIVE_ID)}/root:/${encoded}`,
  );

  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Microsoft Graph path lookup failed (${response.status}): ${await response.text()}`);
  }
  return response.json<DriveItem>();
}

async function createFolder(
  env: Env,
  parentId: string | "root",
  name: string,
): Promise<DriveItem> {
  const parent =
    parentId === "root"
      ? `/drives/${encodeURIComponent(env.ONEDRIVE_DRIVE_ID)}/root/children`
      : `/drives/${encodeURIComponent(env.ONEDRIVE_DRIVE_ID)}/items/${encodeURIComponent(parentId)}/children`;

  return graphJson<DriveItem>(env, parent, {
    method: "POST",
    body: JSON.stringify({
      name,
      folder: {},
      "@microsoft.graph.conflictBehavior": "fail",
    }),
  });
}

export async function ensureFolderPath(env: Env, folderPath: string): Promise<void> {
  const segments = folderPath.split("/").filter(Boolean);
  let currentPath = "";
  let parentId: string | "root" = "root";

  for (const segment of segments) {
    currentPath = currentPath ? `${currentPath}/${segment}` : segment;
    const existing = await getItemByPath(env, currentPath);
    if (existing) {
      parentId = existing.id;
      continue;
    }

    try {
      const created = await createFolder(env, parentId, segment);
      parentId = created.id;
    } catch (error) {
      // Another request can create the same folder between lookup and create.
      const raced = await getItemByPath(env, currentPath);
      if (!raced) throw error;
      parentId = raced.id;
    }
  }
}

export async function createUploadSession(
  env: Env,
  path: string,
  conflictBehavior: "replace" | "rename" | "fail" = "replace",
): Promise<UploadSession> {
  const slash = path.lastIndexOf("/");
  const parent = slash === -1 ? "" : path.slice(0, slash);
  const filename = slash === -1 ? path : path.slice(slash + 1);

  if (parent) await ensureFolderPath(env, parent);

  const encodedPath = encodePath(path);
  return graphJson<UploadSession>(
    env,
    `/drives/${encodeURIComponent(env.ONEDRIVE_DRIVE_ID)}/root:/${encodedPath}:/createUploadSession`,
    {
      method: "POST",
      body: JSON.stringify({
        item: {
          "@microsoft.graph.conflictBehavior": conflictBehavior,
          name: filename,
        },
      }),
    },
  );
}

export async function assertProjectItem(
  env: Env,
  projectId: string,
  itemId: string,
): Promise<DriveItem> {
  const item = await getDriveItem(env, itemId);
  const expected = `/${rootPath(env)}/projects/${projectId}/`.toLowerCase();
  const actual = (item.parentReference?.path ?? "").toLowerCase();

  // parentReference.path includes /drive/root: before the actual path.
  if (!actual.includes(expected.slice(0, -1))) {
    throw new Error("OneDrive item is outside this project");
  }
  return item;
}
