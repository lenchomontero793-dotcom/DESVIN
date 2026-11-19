import { useMemo, useState } from 'react';
import { Download, History, Search } from 'lucide-react';
import type { AuditEvent } from '../types';
import { downloadCsv, formatRelativeTime } from '../utils/formatters';

interface AuditLogViewProps {
  auditLogs: AuditEvent[];
  canExport: boolean;
  onNotify: (msg: string) => void;
}

const ACTION_LABELS: Record<AuditEvent['action'], { label: string; category: string; tone: string }> = {
  user_created: { label: 'Usuario creado', category: 'usuarios', tone: 'text-[#2E6B1E]' },
  access_granted: { label: 'Acceso / ficha', category: 'usuarios', tone: 'text-[#185FA5]' },
  access_revoked: { label: 'Acceso revocado', category: 'bajas', tone: 'text-[#A32D2D]' },
  offboarding_started: { label: 'Inicio de baja', category: 'bajas', tone: 'text-[#854F0B]' },
  offboarding_completed: { label: 'Baja completada', category: 'bajas', tone: 'text-[#2E6B1E]' },
  platform_synced: { label: 'Sync plataforma', category: 'integraciones', tone: 'text-[#185FA5]' },
  platform_import: { label: 'Importación cruce', category: 'integraciones', tone: 'text-[#534AB7]' },
  manual_link: { label: 'Vinculación manual', category: 'integraciones', tone: 'text-[#185FA5]' },
  api_config: { label: 'Configuración API', category: 'integraciones', tone: 'text-[#3D3D3A]' },
  api_offboard: { label: 'Baja remota API', category: 'bajas', tone: 'text-[#A32D2D]' },
  consolidation: { label: 'Consolidación BD', category: 'integraciones', tone: 'text-[#534AB7]' },
  inconsistency_alert: { label: 'Inconsistencia', category: 'bajas', tone: 'text-[#854F0B]' },
  settings_updated: { label: 'Configuración', category: 'sistema', tone: 'text-[#3D3D3A]' },
  sys_user: { label: 'Operador sistema', category: 'sistema', tone: 'text-[#185FA5]' },
  sys_role: { label: 'Roles y permisos', category: 'sistema', tone: 'text-[#534AB7]' },
  backup_restore: { label: 'Respaldo / Restore', category: 'sistema', tone: 'text-[#2E6B1E]' },
  ai_assistant: { label: 'Asistente IA', category: 'sistema', tone: 'text-[#185FA5]' },
  password_changed: { label: 'Cambio de clave', category: 'sistema', tone: 'text-[#3D3D3A]' },
  auth_login: { label: 'Inicio de sesión', category: 'sistema', tone: 'text-[#5E5D57]' },
};

export function AuditLogView({ auditLogs, canExport, onNotify }: AuditLogViewProps) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('todos');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return auditLogs.filter((log) => {
      const meta = ACTION_LABELS[log.action] || { label: log.action, category: 'sistema', tone: 'text-[#5E5D57]' };
      const matchesCat = category === 'todos' || meta.category === category;
      const matchesQuery =
        !q ||
        log.text.toLowerCase().includes(q) ||
        log.actor.toLowerCase().includes(q) ||
        meta.label.toLowerCase().includes(q);
      return matchesCat && matchesQuery;
    });
  }, [auditLogs, query, category]);

  const handleExportCsv = () => {
    const headers = ['ID', 'Acción', 'Detalle', 'Realizado por', 'Fecha / Hora'];
    const rows = filtered.map((l) => [
      l.id,
      ACTION_LABELS[l.action]?.label || l.action,
      l.text,
      l.actor,
      new Date(l.timestamp).toLocaleString('es-CL'),
    ]);
    const filename = `usersync_audit_log_${new Date().toISOString().slice(0, 10)}.csv`;
    downloadCsv(filename, headers, rows);
    onNotify(`Audit log exportado (${filename}).`);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-[16px] font-semibold text-[#141413]">Audit Log del sistema</h2>
          <p className="text-xs text-[#5E5D57] mt-0.5 tabular-nums">
            Registro trazable de {filtered.length} eventos de identidad, integraciones, bajas y configuración.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-[#73726C] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filtrar evento o responsable..."
              className="pl-8 pr-3 py-1.5 text-xs rounded-lg border border-[#1F1E1D]/20 bg-white outline-none focus:border-[#185FA5]"
            />
          </div>

          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="text-xs px-3 py-1.5 rounded-lg border border-[#1F1E1D]/20 bg-white text-[#141413] outline-none focus:border-[#185FA5]"
          >
            <option value="todos">Todas las categorías</option>
            <option value="usuarios">Usuarios y accesos</option>
            <option value="bajas">Bajas y revocaciones</option>
            <option value="integraciones">Integraciones, cruces y APIs</option>
            <option value="sistema">Sistema, roles, respaldos e IA</option>
          </select>

          {canExport && (
            <button
              type="button"
              onClick={handleExportCsv}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-[#1F1E1D]/20 bg-white hover:bg-[#F3F2EC] text-[#141413] whitespace-nowrap shrink-0"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Exportar CSV</span>
            </button>
          )}
        </div>
      </div>

      <div className="bg-white border border-[#1F1E1D]/15 rounded-xl overflow-hidden">
        {filtered.length === 0 ? (
          <div className="p-10 text-center space-y-2 text-[#5E5D57]">
            <History className="w-6 h-6 mx-auto text-[#73726C]" />
            <p className="text-xs">No se encontraron registros de auditoría para el filtro actual.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-[13px]">
              <thead>
                <tr className="bg-[#F5F4ED] border-b border-[#1F1E1D]/10 text-[11px] font-semibold text-[#5E5D57]">
                  <th className="py-2.5 px-4 w-14">#</th>
                  <th className="py-2.5 px-4">Acción</th>
                  <th className="py-2.5 px-4">Detalle</th>
                  <th className="py-2.5 px-4">Realizado por</th>
                  <th className="py-2.5 px-4 text-right">Fecha / Hora</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1F1E1D]/10">
                {filtered.map((log, idx) => {
                  const meta = ACTION_LABELS[log.action] || {
                    label: log.action,
                    category: 'sistema',
                    tone: 'text-[#5E5D57]',
                  };
                  return (
                    <tr key={log.id} className="hover:bg-[#FAF9F5]">
                      <td className="py-2.5 px-4 text-[11px] font-mono-tabular text-[#73726C] tabular-nums">
                        {idx + 1}
                      </td>
                      <td className="py-2.5 px-4 whitespace-nowrap">
                        <span className={`text-xs font-semibold ${meta.tone}`}>{meta.label}</span>
                      </td>
                      <td className="py-2.5 px-4 text-xs text-[#141413]">{log.text}</td>
                      <td className="py-2.5 px-4 text-xs text-[#5E5D57] font-mono-tabular">
                        {log.actor}
                      </td>
                      <td className="py-2.5 px-4 text-right text-xs text-[#73726C] tabular-nums whitespace-nowrap">
                        <div>{new Date(log.timestamp).toLocaleString('es-CL')}</div>
                        <div className="text-[10px]">{formatRelativeTime(log.timestamp)}</div>
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
  );
}
