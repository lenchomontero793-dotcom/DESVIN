import type { ApiSyncLog, ApiType, PlatformImportRow } from '../src/types.ts';
import { addAudit, nowIso, readDb, writeDb, type DatabaseData, type StoredApiConfig } from './db.ts';
import { buildDirectoryIndices, normEmail, normRut, normStr } from './matcher.ts';

interface ApiRequestResult {
  ok: boolean;
  status: number;
  body: string;
  data: unknown;
  error?: string;
}

export async function apiRequest(
  url: string,
  method = 'GET',
  headers: Record<string, string> = {},
  payload?: unknown,
  timeoutMs = 15000,
): Promise<ApiRequestResult> {
  try {
    const init: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...headers,
      },
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (payload !== undefined && method !== 'GET' && method !== 'HEAD') {
      init.body = JSON.stringify(payload);
    }
    const res = await fetch(url, init);
    const body = await res.text();
    let parsed: unknown = {};
    try {
      parsed = body ? JSON.parse(body) : {};
    } catch {
      parsed = { raw: body };
    }
    return {
      ok: res.ok,
      status: res.status,
      body,
      data: parsed,
      error: res.ok ? undefined : `HTTP ${res.status} ${res.statusText}`,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: '',
      data: {},
      error: err instanceof Error ? err.message : 'Error de red',
    };
  }
}

async function getOAuth2Token(cfg: StoredApiConfig): Promise<string | null> {
  const tenant = cfg.tenantId || 'common';
  const tokenUrl =
    cfg.apiType === 'custom'
      ? `${cfg.baseUrl.replace(/\/$/, '')}/oauth2/token`
      : `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;

  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: cfg.clientId || '',
    client_secret: cfg.clientSecret || '',
    scope: cfg.apiType === 'office365' ? 'https://graph.microsoft.com/.default' : 'api',
  });

  try {
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { access_token?: string };
    return json.access_token || null;
  } catch {
    return null;
  }
}

export async function buildAuthHeaders(cfg: StoredApiConfig): Promise<Record<string, string>> {
  const auth = cfg.authType || 'bearer';
  if (auth === 'bearer') {
    return cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {};
  }
  if (auth === 'basic') {
    const cred = Buffer.from(`${cfg.username || ''}:${cfg.password || ''}`).toString('base64');
    return { Authorization: `Basic ${cred}` };
  }
  if (auth === 'apikey') {
    return cfg.token ? { 'X-API-Key': cfg.token } : {};
  }
  if (auth === 'oauth2_cc') {
    const token = await getOAuth2Token(cfg);
    return token ? { Authorization: `Bearer ${token}` } : {};
  }
  return {};
}

const DEFAULT_FIELD_MAPS: Record<ApiType, Record<string, string>> = {
  office365: { email: 'userPrincipalName', name: 'displayName', id: 'id', status: 'accountEnabled' },
  salesforce: { email: 'Email', name: 'Name', id: 'Id', status: 'IsActive' },
  sap: { email: 'Email', name: 'FullName', id: 'UserName', status: 'Locked' },
  workday: { email: 'Email_Work', name: 'Worker_ID', id: 'Employee_ID', status: 'Active' },
  custom: { email: 'email', name: 'name', id: 'id', status: 'status' },
};

function getDotPath(row: unknown, dotPath?: string): string {
  if (!dotPath || !row || typeof row !== 'object') return '';
  let curr: unknown = row;
  for (const part of dotPath.split('.')) {
    if (curr && typeof curr === 'object' && part in (curr as Record<string, unknown>)) {
      curr = (curr as Record<string, unknown>)[part];
    } else {
      return '';
    }
  }
  return curr === null || curr === undefined ? '' : String(curr).trim();
}

export function parseUsersFromResponse(
  dataBody: unknown,
  cfg: StoredApiConfig,
): { email: string; name: string; id: string; status: string }[] {
  let body = dataBody;
  if (typeof dataBody === 'string') {
    try {
      body = JSON.parse(dataBody);
    } catch {
      return [];
    }
  }
  let usersRaw: unknown[] = [];
  if (Array.isArray(body)) {
    usersRaw = body;
  } else if (body && typeof body === 'object') {
    const rec = body as Record<string, unknown>;
    for (const k of ['value', 'data', 'users', 'results', 'items', 'records', 'employees', 'members']) {
      if (Array.isArray(rec[k])) {
        usersRaw = rec[k] as unknown[];
        break;
      }
    }
  }

  const mapping = {
    ...(DEFAULT_FIELD_MAPS[cfg.apiType] || DEFAULT_FIELD_MAPS.custom),
    ...(cfg.fieldMap || {}),
  };

  return usersRaw.map((row) => ({
    email: getDotPath(row, mapping.email),
    name: getDotPath(row, mapping.name),
    id: getDotPath(row, mapping.id),
    status: getDotPath(row, mapping.status),
  }));
}

function appendSyncLog(db: DatabaseData, log: Omit<ApiSyncLog, 'id' | 'createdAt'>): void {
  const entry: ApiSyncLog = {
    id: `sync-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    createdAt: nowIso(),
    ...log,
  };
  db.apiSyncLogs = [entry, ...db.apiSyncLogs].slice(0, 150);
}

export async function testApiConnection(
  cfg: StoredApiConfig,
): Promise<{ ok: boolean; count: number; msg: string; sample?: unknown[] }> {
  if (!cfg.baseUrl) {
    return { ok: false, count: 0, msg: 'URL base no configurada.' };
  }
  let url = cfg.baseUrl.replace(/\/$/, '');
  if (cfg.extraParams?.query && Object.keys(cfg.extraParams.query).length > 0) {
    const qs = new URLSearchParams(cfg.extraParams.query).toString();
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;
  }
  const headers = await buildAuthHeaders(cfg);
  const resp = await apiRequest(url, 'GET', headers, undefined, 10000);
  if (resp.ok) {
    const users = parseUsersFromResponse(resp.data, cfg);
    return {
      ok: true,
      count: users.length,
      sample: users.slice(0, 5),
      msg: `Conexión exitosa (HTTP ${resp.status}). Se detectaron ${users.length} registros en la respuesta.`,
    };
  }
  return {
    ok: false,
    count: 0,
    msg: `Error HTTP ${resp.status}: ${resp.error || resp.body.slice(0, 200)}`,
  };
}

export async function doApiSync(
  db: DatabaseData,
  platformId: string,
  trigger: 'manual' | 'forzado' | 'automatico',
  actor: string,
): Promise<{ ok: boolean; total: number; matched: number; unmatched: number; msg: string }> {
  const cfg = db.apiConfigs.find((c) => c.platformId === platformId);
  if (!cfg) {
    return { ok: false, total: 0, matched: 0, unmatched: 0, msg: 'Sin configuración de API para esta plataforma.' };
  }
  if (!cfg.baseUrl) {
    return { ok: false, total: 0, matched: 0, unmatched: 0, msg: 'URL base no configurada.' };
  }

  let url = cfg.baseUrl.replace(/\/$/, '');
  if (cfg.extraParams?.query && Object.keys(cfg.extraParams.query).length > 0) {
    const qs = new URLSearchParams(cfg.extraParams.query).toString();
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;
  }

  const headers = await buildAuthHeaders(cfg);
  const resp = await apiRequest(url, 'GET', headers, undefined, 20000);

  if (!resp.ok) {
    const errMsg = `Error HTTP ${resp.status}: ${resp.error || resp.body.slice(0, 180)}`;
    cfg.lastSync = nowIso();
    cfg.lastSyncStatus = 'error';
    appendSyncLog(db, {
      platformId,
      trigger,
      status: 'error',
      recordsTotal: 0,
      recordsMatched: 0,
      recordsNew: 0,
      recordsError: 1,
      detail: errMsg,
    });
    writeDb(db);
    return { ok: false, total: 0, matched: 0, unmatched: 0, msg: errMsg };
  }

  const usersApi = parseUsersFromResponse(resp.data, cfg);
  const indices = buildDirectoryIndices(db.users);

  // Remove previous API-origin imports for this platform
  db.platformImports = db.platformImports.filter(
    (pi) => !(pi.platformId === platformId && pi.matchMethod?.startsWith('api_')),
  );

  let matched = 0;
  let unmatched = 0;
  const importedRows: PlatformImportRow[] = [];

  for (const u of usersApi) {
    let uid: string | undefined;
    let method: 'api_email' | 'api_rut' | 'api_nombre' | undefined;

    const email = normEmail(u.email);
    if (email && indices.byEmail.has(email)) {
      uid = indices.byEmail.get(email);
      method = 'api_email';
    } else if (u.id) {
      const rn = normRut(u.id);
      if (rn && indices.byRut.has(rn)) {
        uid = indices.byRut.get(rn);
        method = 'api_rut';
      }
    }
    if (!uid && u.name) {
      const nn = normStr(u.name);
      if (nn && indices.byName.has(nn)) {
        uid = indices.byName.get(nn);
        method = 'api_nombre';
      }
    }

    const isActive = ['true', '1', 'activo', 'active', 'enabled', 'si', 'sí'].includes(
      String(u.status).toLowerCase().trim(),
    );

    if (uid) {
      matched++;
      const dirUser = db.users.find((du) => du.id === uid);
      if (dirUser) {
        const existing = dirUser.accounts.find((a) => a.platformId === platformId);
        if (isActive) {
          if (existing) {
            existing.username = u.id || u.email || existing.username;
            existing.status = 'Activo';
            existing.lastAccess = 'Sync API';
          } else {
            dirUser.accounts.push({
              platformId,
              username: u.id || u.email || dirUser.email,
              role: 'Sincronizado API',
              status: 'Activo',
              lastAccess: 'Sync API',
            });
          }
        } else if (existing) {
          existing.status = 'Suspendido';
        }
        dirUser.updatedAt = nowIso();
      }
    } else {
      unmatched++;
    }

    importedRows.push({
      id: `imp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      platformId,
      rawName: u.name,
      rawEmail: u.email,
      rawRut: '',
      rawAccountId: u.id,
      rawStatus: u.status || 'Activo',
      matchedUserId: uid,
      matchMethod: method,
      matchStatus: uid ? 'encontrado' : 'no_encontrado',
      importedAt: nowIso(),
    });
  }

  db.platformImports = [...importedRows, ...db.platformImports].slice(0, 2000);
  cfg.lastSync = nowIso();
  cfg.lastSyncStatus = 'ok';
  cfg.lastSyncCount = usersApi.length;

  const plat = db.platforms.find((p) => p.id === platformId);
  if (plat) plat.lastSyncAt = nowIso();

  const summaryMsg = `${usersApi.length} registros: ${matched} cruzados, ${unmatched} sin cruce.`;
  appendSyncLog(db, {
    platformId,
    trigger,
    status: 'ok',
    recordsTotal: usersApi.length,
    recordsMatched: matched,
    recordsNew: unmatched,
    recordsError: 0,
    detail: `Sincronización API exitosa (${summaryMsg})`,
  });
  addAudit(db, 'platform_synced', `Sync API ${platformId} (${trigger}): ${summaryMsg}`, actor);
  writeDb(db);

  return { ok: true, total: usersApi.length, matched, unmatched, msg: summaryMsg };
}

export async function doApiOffboard(
  db: DatabaseData,
  platformId: string,
  userId: string,
  actor: string,
): Promise<{ ok: boolean; status: number; msg: string }> {
  const cfg = db.apiConfigs.find((c) => c.platformId === platformId);
  if (!cfg || !cfg.offboardEndpoint) {
    return { ok: false, status: 0, msg: 'Endpoint de baja remota no configurado para esta plataforma.' };
  }
  const user = db.users.find((u) => u.id === userId);
  const acc = user?.accounts.find((a) => a.platformId === platformId);
  if (!user || !acc) {
    return { ok: false, status: 404, msg: 'El usuario no tiene cuenta registrada en esta plataforma.' };
  }

  const acctId = acc.username || user.email;
  const headers = await buildAuthHeaders(cfg);
  const url = cfg.offboardEndpoint.replace(/\{account_id\}/g, encodeURIComponent(acctId));
  let payload: unknown = {};
  try {
    const rawPayload = (cfg.offboardPayload || '{}').replace(/\{account_id\}/g, acctId);
    payload = JSON.parse(rawPayload);
  } catch {
    payload = {};
  }

  const resp = await apiRequest(url, cfg.offboardMethod || 'PATCH', headers, payload, 15000);
  appendSyncLog(db, {
    platformId,
    trigger: 'offboard',
    status: resp.ok ? 'ok' : 'error',
    recordsTotal: 1,
    recordsMatched: resp.ok ? 1 : 0,
    recordsNew: 0,
    recordsError: resp.ok ? 0 : 1,
    detail: `Baja remota de '${user.name}' (${acctId}): HTTP ${resp.status}`,
  });

  if (resp.ok) {
    user.accounts = user.accounts.filter((a) => a.platformId !== platformId);
    user.updatedAt = nowIso();
    const off = db.offboardings.find((o) => o.userId === user.id && o.status === 'En proceso');
    if (off) {
      off.pendingPlatforms = off.pendingPlatforms.filter((p) => p !== platformId);
      if (!off.revokedPlatforms.includes(platformId)) off.revokedPlatforms.push(platformId);
      if (off.pendingPlatforms.length === 0) {
        off.status = 'Completado';
        off.completedAt = nowIso();
        user.status = 'Inactivo';
      }
    }
    addAudit(
      db,
      'api_offboard',
      `Baja remota vía API en ${platformId} para ${user.name} (HTTP ${resp.status})`,
      actor,
      user.id,
    );
  }

  writeDb(db);
  return {
    ok: resp.ok,
    status: resp.status,
    msg: resp.ok ? `Baja remota ejecutada (HTTP ${resp.status}).` : `HTTP ${resp.status}: ${resp.error || 'Fallo remoto'}`,
  };
}

let schedulerTimer: ReturnType<typeof setInterval> | null = null;

export function startApiScheduler(): void {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(() => {
    void (async () => {
      try {
        const db = readDb();
        const enabled = db.apiConfigs.filter((c) => c.syncEnabled && c.baseUrl);
        for (const cfg of enabled) {
          const intervalHours = Math.max(1, cfg.syncInterval || 24);
          if (cfg.lastSync) {
            const elapsedHours = (Date.now() - new Date(cfg.lastSync).getTime()) / (1000 * 3600);
            if (elapsedHours < intervalHours) continue;
          }
          await doApiSync(db, cfg.platformId, 'automatico', 'Scheduler Automático');
        }
      } catch {
        // Keep scheduler resilient
      }
    })();
  }, 60 * 1000);
}
