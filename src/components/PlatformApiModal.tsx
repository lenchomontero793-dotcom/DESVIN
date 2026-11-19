import { useState, type FormEvent } from 'react';
import {
  Activity,
  CheckCircle2,
  FlaskConical,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  X,
} from 'lucide-react';
import type {
  ApiAuthType,
  ApiConfig,
  ApiSyncLog,
  ApiType,
  Platform,
} from '../types';
import { formatRelativeTime } from '../utils/formatters';
import { PlatformBadge } from './StatusLabel';

interface PlatformApiModalProps {
  platform: Platform;
  existingConfig?: ApiConfig;
  syncLogs: ApiSyncLog[];
  onClose: () => void;
  onSaveApiConfig: (platformId: string, config: Partial<ApiConfig>) => Promise<boolean>;
  onTestConnection: (
    platformId: string,
  ) => Promise<{ ok: boolean; count: number; msg: string; sample?: unknown[] }>;
  onForceSync: (
    platformId: string,
  ) => Promise<{ ok: boolean; msg: string }>;
}

const API_PRESETS: Record<
  ApiType,
  { baseUrl: string; fieldMap: Record<string, string>; offboardEndpoint: string; offboardPayload: string }
> = {
  office365: {
    baseUrl: 'https://graph.microsoft.com/v1.0/users',
    fieldMap: { email: 'userPrincipalName', name: 'displayName', id: 'id', status: 'accountEnabled' },
    offboardEndpoint: 'https://graph.microsoft.com/v1.0/users/{account_id}',
    offboardPayload: '{"accountEnabled": false}',
  },
  salesforce: {
    baseUrl: 'https://tuinstancia.my.salesforce.com/services/data/v59.0/query',
    fieldMap: { email: 'Email', name: 'Name', id: 'Id', status: 'IsActive' },
    offboardEndpoint: 'https://tuinstancia.my.salesforce.com/services/data/v59.0/sobjects/User/{account_id}',
    offboardPayload: '{"IsActive": false}',
  },
  sap: {
    baseUrl: 'https://sap-idm.empresa.local/sap/opu/odata/sap/USER_SRV/UserSet',
    fieldMap: { email: 'Email', name: 'FullName', id: 'UserName', status: 'Locked' },
    offboardEndpoint: 'https://sap-idm.empresa.local/sap/opu/odata/sap/USER_SRV/UserSet(\'{account_id}\')',
    offboardPayload: '{"Locked": true}',
  },
  workday: {
    baseUrl: 'https://wd2-impl-services1.workday.com/ccx/api/v1/tenant/workers',
    fieldMap: { email: 'Email_Work', name: 'Worker_ID', id: 'Employee_ID', status: 'Active' },
    offboardEndpoint: '',
    offboardPayload: '{"active": false}',
  },
  custom: {
    baseUrl: 'https://api.plataforma.empresa.local/v1/users',
    fieldMap: { email: 'email', name: 'name', id: 'id', status: 'status' },
    offboardEndpoint: 'https://api.plataforma.empresa.local/v1/users/{account_id}/disable',
    offboardPayload: '{"active": false}',
  },
};

export function PlatformApiModal({
  platform,
  existingConfig,
  syncLogs,
  onClose,
  onSaveApiConfig,
  onTestConnection,
  onForceSync,
}: PlatformApiModalProps) {
  const inferType = (): ApiType => {
    if (existingConfig?.apiType) return existingConfig.apiType;
    if (platform.id === 'Office 365') return 'office365';
    if (platform.id === 'Salesforce') return 'salesforce';
    if (platform.id === 'SAP') return 'sap';
    return 'custom';
  };

  const initialType = inferType();
  const [apiType, setApiType] = useState<ApiType>(initialType);
  const [baseUrl, setBaseUrl] = useState(existingConfig?.baseUrl || platform.endpoint || '');
  const [authType, setAuthType] = useState<ApiAuthType>(existingConfig?.authType || 'bearer');
  const [token, setToken] = useState('');
  const [username, setUsername] = useState(existingConfig?.username || '');
  const [password, setPassword] = useState('');
  const [clientId, setClientId] = useState(existingConfig?.clientId || '');
  const [clientSecret, setClientSecret] = useState('');
  const [tenantId, setTenantId] = useState(existingConfig?.tenantId || '');

  const [queryParams, setQueryParams] = useState<[string, string][]>(() =>
    Object.entries(existingConfig?.extraParams?.query || {}),
  );
  const [fieldMap, setFieldMap] = useState<Record<string, string>>(() => ({
    ...API_PRESETS[initialType].fieldMap,
    ...(existingConfig?.fieldMap || {}),
  }));

  const [offboardEndpoint, setOffboardEndpoint] = useState(existingConfig?.offboardEndpoint || '');
  const [offboardMethod, setOffboardMethod] = useState<'PATCH' | 'PUT' | 'POST' | 'DELETE'>(
    existingConfig?.offboardMethod || 'PATCH',
  );
  const [offboardPayload, setOffboardPayload] = useState(
    existingConfig?.offboardPayload || '{"accountEnabled": false}',
  );
  const [syncEnabled, setSyncEnabled] = useState(Boolean(existingConfig?.syncEnabled));
  const [syncInterval, setSyncInterval] = useState(existingConfig?.syncInterval || 24);

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    msg: string;
    sample?: unknown[];
  } | null>(null);

  const platformLogs = syncLogs.filter((l) => l.platformId === platform.id);

  const handleApplyPreset = (nextType: ApiType) => {
    setApiType(nextType);
    const p = API_PRESETS[nextType];
    if (!baseUrl) setBaseUrl(p.baseUrl);
    setFieldMap(p.fieldMap);
    if (!offboardEndpoint && p.offboardEndpoint) setOffboardEndpoint(p.offboardEndpoint);
    if (p.offboardPayload) setOffboardPayload(p.offboardPayload);
  };

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const queryObj: Record<string, string> = {};
      for (const [k, v] of queryParams) {
        if (k.trim()) queryObj[k.trim()] = v.trim();
      }
      await onSaveApiConfig(platform.id, {
        apiType,
        baseUrl: baseUrl.trim(),
        authType,
        token: token.trim() || undefined,
        username: username.trim(),
        password: password.trim() || undefined,
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim() || undefined,
        tenantId: tenantId.trim(),
        extraParams: { query: queryObj, verifySsl: true },
        fieldMap,
        offboardEndpoint: offboardEndpoint.trim(),
        offboardMethod,
        offboardPayload: offboardPayload.trim(),
        syncEnabled,
        syncInterval,
      });
      setToken('');
      setPassword('');
      setClientSecret('');
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await onTestConnection(platform.id);
      setTestResult(res);
    } finally {
      setTesting(false);
    }
  };

  const handleSync = async () => {
    setSyncing(true);
    try {
      const res = await onForceSync(platform.id);
      setTestResult({ ok: res.ok, msg: res.msg });
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/45 flex items-center justify-center p-4 no-print"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white border border-[#1F1E1D]/15 rounded-xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden shadow-lg">
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-[#1F1E1D]/10 flex items-center justify-between gap-4 bg-[#FAF9F5]">
          <div className="flex items-center gap-3 min-w-0">
            <PlatformBadge platform={platform} size="md" />
            <div className="min-w-0">
              <h2 className="text-[15px] font-semibold text-[#141413] truncate">
                Conector API REST · {platform.name}
              </h2>
              <p className="text-[11px] text-[#5E5D57]">
                Sincronización automática de identidades, mapeo JSON y endpoint de baja remota
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              disabled={testing || !existingConfig}
              onClick={handleTest}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-[#1F1E1D]/20 bg-white hover:bg-[#F3F2EC] text-[#141413] disabled:opacity-50 whitespace-nowrap"
            >
              <FlaskConical className="w-3.5 h-3.5 text-[#185FA5]" />
              <span>{testing ? 'Probando...' : 'Probar conexión'}</span>
            </button>
            <button
              type="button"
              disabled={syncing || !existingConfig}
              onClick={handleSync}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-[#185FA5] text-white hover:bg-[#144D87] disabled:opacity-50 whitespace-nowrap"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
              <span>{syncing ? 'Sincronizando...' : 'Sincronizar ahora'}</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Cerrar"
              className="p-1.5 rounded-md border border-[#1F1E1D]/15 hover:bg-[#ECEAE1] text-[#3D3D3A]"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="p-5 overflow-y-auto space-y-5">
          {testResult && (
            <div
              className={`p-3 rounded-lg border text-xs flex items-start gap-2 ${
                testResult.ok
                  ? 'bg-[#EAF3DE] border-[#639922]/30 text-[#2E6B1E]'
                  : 'bg-[#FCEBEB] border-[#A32D2D]/30 text-[#A32D2D]'
              }`}
            >
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
              <div>
                <div className="font-medium">{testResult.msg}</div>
                {testResult.sample && testResult.sample.length > 0 && (
                  <pre className="mt-2 p-2 rounded bg-white/80 text-[11px] font-mono-tabular overflow-x-auto text-[#141413]">
                    {JSON.stringify(testResult.sample, null, 2)}
                  </pre>
                )}
              </div>
            </div>
          )}

          <form onSubmit={handleSave} className="space-y-5">
            {/* Section 1: Endpoint & Auth */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="p-4 rounded-xl border border-[#1F1E1D]/15 space-y-3">
                <h3 className="text-xs font-semibold text-[#141413]">1. Conexión y autenticación</h3>
                <div className="grid grid-cols-2 gap-2.5">
                  <div>
                    <label className="block text-[11px] font-medium text-[#5E5D57] mb-1">
                      Tipo de API
                    </label>
                    <select
                      value={apiType}
                      onChange={(e) => handleApplyPreset(e.target.value as ApiType)}
                      className="w-full px-2.5 py-1.5 text-xs rounded-lg border border-[#1F1E1D]/20 bg-white"
                    >
                      <option value="office365">Office 365 (Graph)</option>
                      <option value="salesforce">Salesforce REST</option>
                      <option value="sap">SAP OData / IDM</option>
                      <option value="workday">Workday HCM</option>
                      <option value="custom">API REST Propia</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-[#5E5D57] mb-1">
                      Autenticación
                    </label>
                    <select
                      value={authType}
                      onChange={(e) => setAuthType(e.target.value as ApiAuthType)}
                      className="w-full px-2.5 py-1.5 text-xs rounded-lg border border-[#1F1E1D]/20 bg-white"
                    >
                      <option value="bearer">Bearer Token</option>
                      <option value="basic">Basic Auth</option>
                      <option value="apikey">Header X-API-Key</option>
                      <option value="oauth2_cc">OAuth2 Client Credentials</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] font-medium text-[#5E5D57] mb-1">
                    URL base listado de usuarios *
                  </label>
                  <input
                    required
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder="https://graph.microsoft.com/v1.0/users"
                    className="w-full px-3 py-1.5 text-xs font-mono-tabular rounded-lg border border-[#1F1E1D]/20 outline-none focus:border-[#185FA5]"
                  />
                </div>

                {(authType === 'bearer' || authType === 'apikey') && (
                  <div>
                    <label className="block text-[11px] font-medium text-[#5E5D57] mb-1">
                      {authType === 'bearer' ? 'Bearer Token' : 'API Key'}
                      {existingConfig?.hasToken && (
                        <span className="ml-1.5 text-[#2E6B1E]">(guardado)</span>
                      )}
                    </label>
                    <input
                      type="password"
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      placeholder={
                        existingConfig?.hasToken
                          ? 'Dejar vacío para conservar el token actual'
                          : 'Pega el token o API key...'
                      }
                      className="w-full px-3 py-1.5 text-xs font-mono-tabular rounded-lg border border-[#1F1E1D]/20 outline-none focus:border-[#185FA5]"
                    />
                  </div>
                )}

                {authType === 'basic' && (
                  <div className="grid grid-cols-2 gap-2.5">
                    <div>
                      <label className="block text-[11px] font-medium text-[#5E5D57] mb-1">
                        Usuario API
                      </label>
                      <input
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        className="w-full px-2.5 py-1.5 text-xs rounded-lg border border-[#1F1E1D]/20"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-medium text-[#5E5D57] mb-1">
                        Contraseña {existingConfig?.hasPassword && <span className="text-[#2E6B1E]">(ok)</span>}
                      </label>
                      <input
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder={existingConfig?.hasPassword ? '••••••••' : ''}
                        className="w-full px-2.5 py-1.5 text-xs rounded-lg border border-[#1F1E1D]/20"
                      />
                    </div>
                  </div>
                )}

                {authType === 'oauth2_cc' && (
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <label className="block text-[11px] font-medium text-[#5E5D57] mb-1">
                        Tenant ID
                      </label>
                      <input
                        value={tenantId}
                        onChange={(e) => setTenantId(e.target.value)}
                        className="w-full px-2 py-1.5 text-xs font-mono-tabular rounded-lg border border-[#1F1E1D]/20"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-medium text-[#5E5D57] mb-1">
                        Client ID
                      </label>
                      <input
                        value={clientId}
                        onChange={(e) => setClientId(e.target.value)}
                        className="w-full px-2 py-1.5 text-xs font-mono-tabular rounded-lg border border-[#1F1E1D]/20"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-medium text-[#5E5D57] mb-1">
                        Secret {existingConfig?.hasClientSecret && <span className="text-[#2E6B1E]">(ok)</span>}
                      </label>
                      <input
                        type="password"
                        value={clientSecret}
                        onChange={(e) => setClientSecret(e.target.value)}
                        placeholder={existingConfig?.hasClientSecret ? '••••••' : ''}
                        className="w-full px-2 py-1.5 text-xs font-mono-tabular rounded-lg border border-[#1F1E1D]/20"
                      />
                    </div>
                  </div>
                )}

                {/* Query Params */}
                <div className="pt-2 border-t border-[#1F1E1D]/10 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-medium text-[#5E5D57]">
                      Parámetros Query String (opcional)
                    </span>
                    <button
                      type="button"
                      onClick={() => setQueryParams((prev) => [...prev, ['', '']])}
                      className="inline-flex items-center gap-1 text-[11px] text-[#185FA5] hover:underline"
                    >
                      <Plus className="w-3 h-3" />
                      <span>Agregar</span>
                    </button>
                  </div>
                  {queryParams.map(([k, v], idx) => (
                    <div key={idx} className="flex items-center gap-1.5">
                      <input
                        placeholder="clave (ej. $top)"
                        value={k}
                        onChange={(e) =>
                          setQueryParams((prev) =>
                            prev.map((row, i) => (i === idx ? [e.target.value, row[1]] : row)),
                          )
                        }
                        className="flex-1 px-2 py-1 text-xs font-mono-tabular rounded border border-[#1F1E1D]/20"
                      />
                      <input
                        placeholder="valor"
                        value={v}
                        onChange={(e) =>
                          setQueryParams((prev) =>
                            prev.map((row, i) => (i === idx ? [row[0], e.target.value] : row)),
                          )
                        }
                        className="flex-1 px-2 py-1 text-xs font-mono-tabular rounded border border-[#1F1E1D]/20"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          setQueryParams((prev) => prev.filter((_, i) => i !== idx))
                        }
                        className="p-1 text-[#73726C] hover:text-[#A32D2D]"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {/* Section 2: Field Map & Offboarding Endpoint */}
              <div className="space-y-4">
                <div className="p-4 rounded-xl border border-[#1F1E1D]/15 space-y-2.5">
                  <h3 className="text-xs font-semibold text-[#141413]">
                    2. Mapeo de campos JSON (rutas con punto)
                  </h3>
                  <div className="grid grid-cols-2 gap-2">
                    {(['email', 'name', 'id', 'status'] as const).map((key) => (
                      <div key={key}>
                        <label className="block text-[11px] text-[#5E5D57] mb-0.5 capitalize">
                          Campo {key}
                        </label>
                        <input
                          value={fieldMap[key] || ''}
                          onChange={(e) =>
                            setFieldMap((prev) => ({ ...prev, [key]: e.target.value }))
                          }
                          className="w-full px-2.5 py-1.5 text-xs font-mono-tabular rounded-lg border border-[#1F1E1D]/20"
                        />
                      </div>
                    ))}
                  </div>
                </div>

                <div className="p-4 rounded-xl border border-[#1F1E1D]/15 space-y-2.5">
                  <h3 className="text-xs font-semibold text-[#141413]">
                    3. Baja remota vía API (opcional)
                  </h3>
                  <div className="grid grid-cols-4 gap-2">
                    <div className="col-span-3">
                      <label className="block text-[11px] text-[#5E5D57] mb-0.5">
                        Endpoint de baja (usa <code className="font-mono-tabular">{'{account_id}'}</code>)
                      </label>
                      <input
                        value={offboardEndpoint}
                        onChange={(e) => setOffboardEndpoint(e.target.value)}
                        placeholder="https://graph.microsoft.com/v1.0/users/{account_id}"
                        className="w-full px-2.5 py-1.5 text-xs font-mono-tabular rounded-lg border border-[#1F1E1D]/20"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-[#5E5D57] mb-0.5">Método</label>
                      <select
                        value={offboardMethod}
                        onChange={(e) =>
                          setOffboardMethod(e.target.value as 'PATCH' | 'PUT' | 'POST' | 'DELETE')
                        }
                        className="w-full px-2 py-1.5 text-xs rounded-lg border border-[#1F1E1D]/20 bg-white"
                      >
                        <option value="PATCH">PATCH</option>
                        <option value="PUT">PUT</option>
                        <option value="POST">POST</option>
                        <option value="DELETE">DELETE</option>
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="block text-[11px] text-[#5E5D57] mb-0.5">Payload JSON</label>
                    <input
                      value={offboardPayload}
                      onChange={(e) => setOffboardPayload(e.target.value)}
                      className="w-full px-2.5 py-1.5 text-xs font-mono-tabular rounded-lg border border-[#1F1E1D]/20"
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Section 3: Auto Sync Scheduler + Save */}
            <div className="p-4 rounded-xl bg-[#FAF9F5] border border-[#1F1E1D]/10 flex flex-wrap items-center justify-between gap-4">
              <div className="flex flex-wrap items-center gap-4">
                <label className="inline-flex items-center gap-2 text-xs font-medium text-[#141413] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={syncEnabled}
                    onChange={(e) => setSyncEnabled(e.target.checked)}
                  />
                  <span>Activar sincronización periódica automática</span>
                </label>

                <div className="flex items-center gap-2 text-xs text-[#5E5D57]">
                  <span>Cada</span>
                  <input
                    type="number"
                    min={1}
                    max={720}
                    value={syncInterval}
                    onChange={(e) => setSyncInterval(Number(e.target.value) || 24)}
                    className="w-16 px-2 py-1 text-xs font-mono-tabular rounded border border-[#1F1E1D]/20 bg-white"
                  />
                  <span>horas</span>
                </div>
              </div>

              <button
                type="submit"
                disabled={saving}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg bg-[#185FA5] text-white hover:bg-[#144D87] disabled:opacity-50"
              >
                <Save className="w-3.5 h-3.5" />
                <span>{saving ? 'Guardando...' : 'Guardar configuración API'}</span>
              </button>
            </div>
          </form>

          {/* Sync Logs */}
          <div className="space-y-2">
            <h3 className="text-xs font-semibold text-[#5E5D57] flex items-center gap-1.5">
              <Activity className="w-3.5 h-3.5 text-[#185FA5]" />
              <span>Historial reciente de sincronizaciones API ({platformLogs.length})</span>
            </h3>
            <div className="border border-[#1F1E1D]/15 rounded-xl overflow-hidden">
              {platformLogs.length === 0 ? (
                <div className="p-4 text-center text-xs text-[#73726C]">
                  Sin ejecuciones API registradas todavía para {platform.name}.
                </div>
              ) : (
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-[#F5F4ED] border-b border-[#1F1E1D]/10 text-[11px] text-[#5E5D57]">
                      <th className="py-2 px-3">Origen</th>
                      <th className="py-2 px-3">Estado</th>
                      <th className="py-2 px-3">Registros</th>
                      <th className="py-2 px-3">Detalle</th>
                      <th className="py-2 px-3 text-right">Fecha</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#1F1E1D]/10">
                    {platformLogs.slice(0, 15).map((log) => (
                      <tr key={log.id}>
                        <td className="py-2 px-3 font-medium capitalize">{log.trigger}</td>
                        <td className="py-2 px-3">
                          <span
                            className={`font-semibold ${
                              log.status === 'ok' ? 'text-[#2E6B1E]' : 'text-[#A32D2D]'
                            }`}
                          >
                            {log.status === 'ok' ? 'OK' : 'Error'}
                          </span>
                        </td>
                        <td className="py-2 px-3 font-mono-tabular tabular-nums">
                          {log.recordsTotal} ({log.recordsMatched} cruzados)
                        </td>
                        <td className="py-2 px-3 text-[#5E5D57]">{log.detail}</td>
                        <td className="py-2 px-3 text-right text-[#73726C] tabular-nums">
                          {formatRelativeTime(log.createdAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
