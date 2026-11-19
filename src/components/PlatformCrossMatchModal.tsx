import { useMemo, useState, type ChangeEvent } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Link2,
  Search,
  Upload,
  X,
} from 'lucide-react';
import type { MatchMethod, Platform, PlatformImportRow, User } from '../types';
import {
  downloadExcelSpreadsheet,
  parseRawSpreadsheetText,
} from '../utils/formatters';
import { PlatformBadge } from './StatusLabel';

interface PlatformCrossMatchModalProps {
  platform: Platform;
  imports: PlatformImportRow[];
  users: User[];
  canImport: boolean;
  onClose: () => void;
  onRunImport: (
    platformId: string,
    rows: Record<string, string>[],
    mode: 'reemplazar' | 'agregar',
  ) => Promise<{ total: number; matched: number; unmatched: number } | null>;
  onManualLink: (platformId: string, importId: string, userId: string) => Promise<void>;
}

const METHOD_LABELS: Record<MatchMethod, string> = {
  email: 'Email exacto',
  email_parcial: 'Email parcial',
  rut: 'RUT',
  rut_cuenta: 'RUT en cuenta',
  nombre: 'Nombre',
  cuenta_usuario: 'ID cuenta',
  manual: 'Manual',
  api_email: 'API Email',
  api_rut: 'API RUT',
  api_nombre: 'API Nombre',
};

export function buildPlatformTemplateRows(platform: Platform): {
  headers: string[];
  rows: string[][];
} {
  const presets: Record<string, { headers: string[]; rows: string[][] }> = {
    SAP: {
      headers: ['sap_user', 'nombre', 'email', 'rut', 'perfil', 'mandante', 'grupo', 'estado'],
      rows: [
        ['AGARCIA', 'Ana García López', 'a.garcia@empresa.com', '16.482.190-4', 'Basis Admin', '100', 'GR_TI', 'Activo'],
        ['CMENDOZA', 'Carlos Mendoza Ríos', 'c.mendoza@empresa.com', '18.210.445-K', 'SD_USER', '100', 'GR_SALES', 'Activo'],
      ],
    },
    Salesforce: {
      headers: ['sf_username', 'nombre', 'email', 'perfil', 'rol', 'licencia', 'estado', 'ultimo_acceso'],
      rows: [
        ['a.garcia@empresa.com', 'Ana García López', 'a.garcia@empresa.com', 'System Admin', 'TI', 'Salesforce', 'Activo', '2026-11-18'],
        ['c.mendoza@empresa.com', 'Carlos Mendoza Ríos', 'c.mendoza@empresa.com', 'Sales Rep', 'Ventas', 'Salesforce', 'Activo', '2026-11-18'],
      ],
    },
    'Office 365': {
      headers: ['upn', 'nombre', 'email', 'licencia', 'grupo', 'mfa_activo', 'estado'],
      rows: [
        ['a.garcia@empresa.com', 'Ana García López', 'a.garcia@empresa.com', 'E5', 'GrupoTI', 'Si', 'Activo'],
        ['c.mendoza@empresa.com', 'Carlos Mendoza Ríos', 'c.mendoza@empresa.com', 'E3', 'GrupoVentas', 'Si', 'Activo'],
      ],
    },
    HCM: {
      headers: ['empleado_id', 'nombre', 'email', 'rut', 'departamento', 'cargo', 'fecha_ingreso', 'estado'],
      rows: [
        ['16482190', 'Ana García López', 'a.garcia@empresa.com', '16.482.190-4', 'TI', 'Arquitecta de Sistemas', '2022-03-15', 'Activo'],
        ['18210445', 'Carlos Mendoza Ríos', 'c.mendoza@empresa.com', '18.210.445-K', 'Ventas', 'Ejecutivo Comercial', '2021-07-01', 'Activo'],
      ],
    },
    'ERP Propio': {
      headers: ['usuario', 'nombre', 'email', 'rut', 'modulo', 'rol', 'estado'],
      rows: [
        ['agarcia', 'Ana García López', 'a.garcia@empresa.com', '16.482.190-4', 'TI', 'Supervisor TI', 'Activo'],
        ['lsoto', 'Laura Soto', 'l.soto@empresa.com', '16.820.991-5', 'Operaciones', 'Gerencia', 'Activo'],
      ],
    },
    Portal: {
      headers: ['username', 'nombre', 'email', 'empresa', 'plan', 'estado', 'ultimo_acceso'],
      rows: [
        ['s.torres@empresa.com', 'Sofía Torres', 's.torres@empresa.com', 'Empresa SA', 'Gestor', 'Activo', '2026-11-18'],
      ],
    },
  };

  if (presets[platform.id]) return presets[platform.id];

  const customCols = platform.colMap
    ? platform.colMap
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean)
    : ['nombre', 'email', 'rut', 'id_usuario', 'rol', 'estado'];

  const sampleRow = customCols.map((col) => {
    const low = col.toLowerCase();
    if (low.includes('email') || low.includes('mail') || low.includes('correo')) return 'a.garcia@empresa.com';
    if (low.includes('nombre') || low.includes('name')) return 'Ana García López';
    if (low.includes('rut') || low.includes('dni')) return '16.482.190-4';
    if (low.includes('estado') || low.includes('status')) return 'Activo';
    if (low.includes('rol') || low.includes('perfil')) return 'Usuario';
    if (low.includes('id') || low.includes('user')) return 'AGARCIA';
    return 'Valor';
  });

  return { headers: customCols, rows: [sampleRow] };
}

export function PlatformCrossMatchModal({
  platform,
  imports,
  users,
  canImport,
  onClose,
  onRunImport,
  onManualLink,
}: PlatformCrossMatchModalProps) {
  const [filter, setFilter] = useState<'todos' | 'encontrado' | 'no_encontrado'>('todos');
  const [query, setQuery] = useState('');
  const [importMode, setImportMode] = useState<'reemplazar' | 'agregar'>('reemplazar');
  const [rawText, setRawText] = useState('');
  const [importing, setImporting] = useState(false);
  const [showImportPanel, setShowImportPanel] = useState(imports.length === 0);
  const [linkingRowId, setLinkingRowId] = useState<string | null>(null);
  const [selectedUserId, setSelectedUserId] = useState<string>('');
  const [linkingBusy, setLinkingBusy] = useState(false);

  const platformRows = useMemo(
    () => imports.filter((pi) => pi.platformId === platform.id),
    [imports, platform.id],
  );

  const stats = useMemo(() => {
    const total = platformRows.length;
    const matched = platformRows.filter((r) => r.matchStatus === 'encontrado').length;
    const unmatched = total - matched;
    const pct = total > 0 ? Math.round((matched / total) * 100) : 0;

    const byMethod: Record<string, number> = {};
    for (const r of platformRows) {
      if (r.matchMethod) {
        byMethod[r.matchMethod] = (byMethod[r.matchMethod] || 0) + 1;
      }
    }
    return { total, matched, unmatched, pct, byMethod };
  }, [platformRows]);

  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return platformRows.filter((r) => {
      if (filter !== 'todos' && r.matchStatus !== filter) return false;
      if (!q) return true;
      return (
        r.rawName.toLowerCase().includes(q) ||
        r.rawEmail.toLowerCase().includes(q) ||
        r.rawRut.toLowerCase().includes(q) ||
        r.rawAccountId.toLowerCase().includes(q)
      );
    });
  }, [platformRows, filter, query]);

  const userById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);
  const activeCandidates = useMemo(
    () =>
      users
        .filter((u) => u.status === 'Activo' || u.status === 'Pendiente')
        .sort((a, b) => a.name.localeCompare(b.name)),
    [users],
  );

  const handleFileUpload = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setRawText(String(reader.result ?? ''));
    };
    reader.readAsText(file, 'utf-8');
  };

  const handleDownloadTemplate = () => {
    const tpl = buildPlatformTemplateRows(platform);
    const safeName = platform.name.replace(/[^A-Za-z0-9_-]+/g, '_');
    downloadExcelSpreadsheet(
      `plantilla_${safeName}.xls`,
      platform.name,
      tpl.headers,
      tpl.rows,
      [
        [`Plantilla de importación para ${platform.name}`, ''],
        ['Cruce automático de 6 niveles', 'Email exacto, email parcial, RUT, RUT en cuenta, nombre normalizado y cuenta usuario.'],
        ['Registros sin cruce', 'Se pueden vincular manualmente desde la pestaña "Sin cruce".'],
      ],
    );
  };

  const handleLoadSample = () => {
    const tpl = buildPlatformTemplateRows(platform);
    const extraUnmatched =
      platform.id === 'SAP'
        ? '\nJPEREZ_EXT,Jorge Pérez Externo,jorge.externo@proveedor.cl,19.123.456-7,MM_EXT,100,EXT,Activo'
        : '\nEXTERNO1,Usuario Externo Prueba,externo.prueba@partner.com,19.123.456-7,Viewer,Activo';
    const csv = [
      tpl.headers.join(','),
      ...tpl.rows.map((r) => r.join(',')),
    ].join('\n');
    setRawText(csv + (platform.id === 'SAP' ? extraUnmatched : ''));
  };

  const handleImportSubmit = async () => {
    const parsed = parseRawSpreadsheetText(rawText);
    if (parsed.length === 0) return;
    setImporting(true);
    try {
      const res = await onRunImport(platform.id, parsed, importMode);
      if (res) {
        setShowImportPanel(false);
        setRawText('');
      }
    } finally {
      setImporting(false);
    }
  };

  const handleConfirmLink = async (importId: string) => {
    if (!selectedUserId) return;
    setLinkingBusy(true);
    try {
      await onManualLink(platform.id, importId, selectedUserId);
      setLinkingRowId(null);
      setSelectedUserId('');
    } finally {
      setLinkingBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/45 flex items-center justify-center p-4 no-print"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white border border-[#1F1E1D]/15 rounded-xl w-full max-w-5xl max-h-[90vh] flex flex-col overflow-hidden shadow-lg">
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-[#1F1E1D]/10 flex items-center justify-between gap-4 bg-[#FAF9F5]">
          <div className="flex items-center gap-3 min-w-0">
            <PlatformBadge platform={platform} size="md" />
            <div className="min-w-0">
              <h2 className="text-[15px] font-semibold text-[#141413] truncate">
                Cruce e importación · {platform.name}
              </h2>
              <p className="text-[11px] text-[#5E5D57]">
                Motor de coincidencia de 6 niveles (Email, Email parcial, RUT, RUT en cuenta, Nombre y Cuenta)
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={handleDownloadTemplate}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-[#1F1E1D]/20 bg-white hover:bg-[#F3F2EC] text-[#141413] whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Plantilla Excel</span>
            </button>
            {canImport && (
              <button
                type="button"
                onClick={() => setShowImportPanel((v) => !v)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-[#185FA5] text-white hover:bg-[#144D87] whitespace-nowrap"
              >
                <Upload className="w-3.5 h-3.5" />
                <span>{showImportPanel ? 'Ocultar carga' : 'Importar planilla'}</span>
              </button>
            )}
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
          {/* KPI Summary */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="p-3.5 rounded-lg bg-[#FAF9F5] border border-[#1F1E1D]/10">
              <div className="text-[11px] text-[#5E5D57]">Registros en planilla</div>
              <div className="text-xl font-semibold text-[#141413] tabular-nums mt-0.5">
                {stats.total}
              </div>
            </div>
            <div className="p-3.5 rounded-lg bg-[#FAF9F5] border border-[#1F1E1D]/10">
              <div className="text-[11px] text-[#5E5D57]">Cruzados con directorio</div>
              <div className="text-xl font-semibold text-[#2E6B1E] tabular-nums mt-0.5">
                {stats.matched}
              </div>
            </div>
            <div className="p-3.5 rounded-lg bg-[#FAF9F5] border border-[#1F1E1D]/10">
              <div className="text-[11px] text-[#5E5D57]">Sin coincidencia</div>
              <div className="text-xl font-semibold text-[#A32D2D] tabular-nums mt-0.5">
                {stats.unmatched}
              </div>
            </div>
            <div className="p-3.5 rounded-lg bg-[#FAF9F5] border border-[#1F1E1D]/10">
              <div className="text-[11px] text-[#5E5D57]">Cobertura de cruce</div>
              <div className="text-xl font-semibold text-[#185FA5] tabular-nums mt-0.5">
                {stats.pct}%
              </div>
            </div>
          </div>

          {/* Coverage Bar & Method Breakdown */}
          {stats.total > 0 && (
            <div className="p-4 rounded-xl border border-[#1F1E1D]/10 bg-white space-y-2.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-[#3D3D3A]">Cobertura de cruce automático</span>
                <span className="font-mono-tabular font-semibold text-[#141413]">
                  {stats.matched} / {stats.total} ({stats.pct}%)
                </span>
              </div>
              <div className="h-2 rounded-full bg-[#ECEAE1] overflow-hidden">
                <div
                  className="h-full bg-[#185FA5] rounded-full transition-all"
                  style={{ width: `${stats.pct}%` }}
                />
              </div>
              {Object.keys(stats.byMethod).length > 0 && (
                <div className="flex flex-wrap gap-3 pt-1 text-[11px] text-[#5E5D57]">
                  {Object.entries(stats.byMethod).map(([method, cnt]) => (
                    <span key={method} className="tabular-nums">
                      <strong className="text-[#141413]">
                        {METHOD_LABELS[method as MatchMethod] || method}:
                      </strong>{' '}
                      {cnt}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Upload / Paste Import Form */}
          {showImportPanel && canImport && (
            <div className="p-4 rounded-xl border border-[#185FA5]/30 bg-[#F5F8FC] space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-xs font-semibold text-[#141413]">
                    Cargar planilla exportada desde {platform.name}
                  </h3>
                  <p className="text-[11px] text-[#5E5D57]">
                    Sube un archivo CSV / JSON o pega las filas para cruzarlas automáticamente contra el directorio maestro.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleLoadSample}
                    className="px-2.5 py-1 text-[11px] font-medium rounded border border-[#1F1E1D]/20 bg-white hover:bg-[#F3F2EC]"
                  >
                    Cargar ejemplo
                  </button>
                  <label className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium rounded border border-[#1F1E1D]/20 bg-white hover:bg-[#F3F2EC] cursor-pointer">
                    <Upload className="w-3 h-3 text-[#185FA5]" />
                    <span>Subir CSV/JSON</span>
                    <input
                      type="file"
                      accept=".csv,.txt,.json"
                      onChange={handleFileUpload}
                      className="hidden"
                    />
                  </label>
                </div>
              </div>

              <textarea
                rows={5}
                value={rawText}
                onChange={(e) => setRawText(e.target.value)}
                placeholder={`Pega aquí el CSV o JSON exportado desde ${platform.name}...`}
                className="w-full p-3 text-xs font-mono-tabular rounded-lg border border-[#1F1E1D]/20 bg-white text-[#141413] outline-none focus:border-[#185FA5]"
              />

              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-4 text-xs text-[#3D3D3A]">
                  <label className="inline-flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="radio"
                      name="importMode"
                      checked={importMode === 'reemplazar'}
                      onChange={() => setImportMode('reemplazar')}
                    />
                    <span>Reemplazar cruce previo</span>
                  </label>
                  <label className="inline-flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="radio"
                      name="importMode"
                      checked={importMode === 'agregar'}
                      onChange={() => setImportMode('agregar')}
                    />
                    <span>Agregar a historial existente</span>
                  </label>
                </div>

                <button
                  type="button"
                  disabled={importing || !rawText.trim()}
                  onClick={handleImportSubmit}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg bg-[#185FA5] text-white hover:bg-[#144D87] disabled:opacity-50"
                >
                  <Upload className="w-3.5 h-3.5" />
                  <span>{importing ? 'Ejecutando cruce...' : 'Ejecutar cruce 6 niveles'}</span>
                </button>
              </div>
            </div>
          )}

          {/* Filter Tabs & Search */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1 bg-[#F5F4ED] p-1 rounded-lg">
              {(
                [
                  ['todos', `Todos (${stats.total})`],
                  ['encontrado', `Cruzados (${stats.matched})`],
                  ['no_encontrado', `Sin cruce (${stats.unmatched})`],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setFilter(key)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                    filter === key
                      ? 'bg-white text-[#141413] shadow-xs'
                      : 'text-[#5E5D57] hover:text-[#141413]'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="relative">
              <Search className="w-3.5 h-3.5 text-[#73726C] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Buscar en planilla..."
                className="pl-8 pr-3 py-1.5 text-xs rounded-lg border border-[#1F1E1D]/20 bg-white outline-none focus:border-[#185FA5]"
              />
            </div>
          </div>

          {/* Results Table */}
          <div className="border border-[#1F1E1D]/15 rounded-xl overflow-hidden">
            {filteredRows.length === 0 ? (
              <div className="p-8 text-center text-xs text-[#5E5D57]">
                {platformRows.length === 0
                  ? `Aún no se ha importado ni sincronizado ninguna planilla para ${platform.name}.`
                  : 'No hay registros que coincidan con el filtro.'}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-[#F5F4ED] border-b border-[#1F1E1D]/10 text-[11px] font-semibold text-[#5E5D57]">
                      <th className="py-2.5 px-3">Dato en {platform.abbr}</th>
                      <th className="py-2.5 px-3">Email / RUT</th>
                      <th className="py-2.5 px-3">ID Cuenta</th>
                      <th className="py-2.5 px-3">Estado</th>
                      <th className="py-2.5 px-3">Usuario Directorio</th>
                      <th className="py-2.5 px-3">Método</th>
                      <th className="py-2.5 px-3 text-right">Acción</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#1F1E1D]/10">
                    {filteredRows.map((row) => {
                      const matchedUser = row.matchedUserId
                        ? userById.get(row.matchedUserId)
                        : undefined;
                      const isLinkingThis = linkingRowId === row.id;

                      return (
                        <tr key={row.id} className="hover:bg-[#FAF9F5]">
                          <td className="py-2.5 px-3 font-medium text-[#141413]">
                            {row.rawName || '—'}
                          </td>
                          <td className="py-2.5 px-3 text-[#5E5D57]">
                            <div>{row.rawEmail || '—'}</div>
                            {row.rawRut && (
                              <div className="text-[11px] font-mono-tabular text-[#73726C]">
                                {row.rawRut}
                              </div>
                            )}
                          </td>
                          <td className="py-2.5 px-3 font-mono-tabular text-[#5E5D57]">
                            {row.rawAccountId || '—'}
                          </td>
                          <td className="py-2.5 px-3">{row.rawStatus || '—'}</td>
                          <td className="py-2.5 px-3">
                            {matchedUser ? (
                              <div>
                                <div className="font-medium text-[#141413] flex items-center gap-1">
                                  <CheckCircle2 className="w-3.5 h-3.5 text-[#2E6B1E] shrink-0" />
                                  <span>{matchedUser.name}</span>
                                </div>
                                <div className="text-[11px] text-[#73726C]">
                                  {matchedUser.email}
                                </div>
                              </div>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-[#A32D2D] font-medium">
                                <AlertTriangle className="w-3.5 h-3.5" />
                                <span>Sin coincidencia</span>
                              </span>
                            )}
                          </td>
                          <td className="py-2.5 px-3 text-[11px] text-[#5E5D57]">
                            {row.matchMethod ? METHOD_LABELS[row.matchMethod] || row.matchMethod : '—'}
                          </td>
                          <td className="py-2.5 px-3 text-right">
                            {!matchedUser && canImport ? (
                              isLinkingThis ? (
                                <div className="flex items-center justify-end gap-1.5">
                                  <select
                                    value={selectedUserId}
                                    onChange={(e) => setSelectedUserId(e.target.value)}
                                    className="px-2 py-1 text-[11px] rounded border border-[#1F1E1D]/20 bg-white max-w-[180px]"
                                  >
                                    <option value="">Seleccionar usuario...</option>
                                    {activeCandidates.map((u) => (
                                      <option key={u.id} value={u.id}>
                                        {u.name} ({u.email})
                                      </option>
                                    ))}
                                  </select>
                                  <button
                                    type="button"
                                    disabled={linkingBusy || !selectedUserId}
                                    onClick={() => handleConfirmLink(row.id)}
                                    className="px-2.5 py-1 text-[11px] font-medium rounded bg-[#185FA5] text-white hover:bg-[#144D87] disabled:opacity-50"
                                  >
                                    OK
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setLinkingRowId(null)}
                                    className="px-2 py-1 text-[11px] rounded border border-[#1F1E1D]/20 hover:bg-[#F3F2EC]"
                                  >
                                    ×
                                  </button>
                                </div>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setLinkingRowId(row.id);
                                    setSelectedUserId(activeCandidates[0]?.id || '');
                                  }}
                                  className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded border border-[#185FA5]/30 text-[#185FA5] hover:bg-[#E6F1FB] whitespace-nowrap"
                                >
                                  <Link2 className="w-3 h-3" />
                                  <span>Vincular</span>
                                </button>
                              )
                            ) : (
                              <span className="text-[11px] text-[#73726C]">Vinculado</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
