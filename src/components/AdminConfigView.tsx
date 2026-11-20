import { useEffect, useState, type FormEvent } from 'react';
import {
  Archive,
  CheckCircle2,
  Cpu,
  Download,
  Edit3,
  History,
  KeyRound,
  Plus,
  RotateCcw,
  Save,
  Server,
  Shield,
  ShieldAlert,
  Trash2,
  UserCheck,
  UserPlus,
  UserX,
  X,
} from 'lucide-react';
import type {
  AppStateResponse,
  AuthUser,
  BackupRecord,
  PermissionMatrix,
  PermissionModule,
  ServiceInfo,
  SysRole,
  SysUser,
  SystemSettings,
} from '../types';
import { apiFetch } from '../utils/apiClient';
import { formatRelativeTime, formatUptime } from '../utils/formatters';
import { PERMS_CATALOG, hasPerm } from '../utils/rbac';
import { ConfirmModal } from './Modals';

interface AdminConfigViewProps {
  authUser: AuthUser;
  token: string;
  sysUsers: SysUser[];
  sysRoles: SysRole[];
  settings: SystemSettings;
  backups: BackupRecord[];
  serviceInfo: ServiceInfo;
  onMutate: (
    url: string,
    method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    body?: unknown,
    successMessage?: string,
  ) => Promise<boolean>;
  onStateReplace: (nextState: AppStateResponse) => void;
  onRequestReset: () => void;
  onNotify: (msg: string, tone?: 'success' | 'error') => void;
}

type AdminTab = 'usuarios' | 'roles' | 'servicio';

export function AdminConfigView({
  authUser,
  token,
  sysUsers,
  sysRoles,
  settings,
  backups,
  serviceInfo,
  onMutate,
  onStateReplace,
  onRequestReset,
  onNotify,
}: AdminConfigViewProps) {
  const canManageSysUsersRoles = hasPerm(authUser, 'configuracion', 'gestionar');
  const canManageService = hasPerm(authUser, 'configuracion', 'servicio');

  const [tab, setTab] = useState<AdminTab>(() =>
    canManageSysUsersRoles ? 'usuarios' : canManageService ? 'servicio' : 'usuarios',
  );

  // Settings form
  const [form, setForm] = useState<SystemSettings>(settings);
  const [savingSettings, setSavingSettings] = useState(false);

  // Backup state
  const [backupNote, setBackupNote] = useState('');
  const [creatingBackup, setCreatingBackup] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<{
    name: string;
    what: 'db' | 'config' | 'all';
  } | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [deleteBackupName, setDeleteBackupName] = useState<string | null>(null);

  // SysUser Modal
  const [sysUserModal, setSysUserModal] = useState<{ open: boolean; editing?: SysUser | null }>({
    open: false,
  });
  const [suUsername, setSuUsername] = useState('');
  const [suFullName, setSuFullName] = useState('');
  const [suEmail, setSuEmail] = useState('');
  const [suRoleId, setSuRoleId] = useState('');
  const [suPassword, setSuPassword] = useState('');
  const [suMustChangePw, setSuMustChangePw] = useState(false);
  const [savingSysUser, setSavingSysUser] = useState(false);

  // SysRole Modal
  const [sysRoleModal, setSysRoleModal] = useState<{ open: boolean; editing?: SysRole | null }>({
    open: false,
  });
  const [roleName, setRoleName] = useState('');
  const [roleDesc, setRoleDesc] = useState('');
  const [rolePerms, setRolePerms] = useState<Record<string, Record<string, boolean>>>({});
  const [savingRole, setSavingRole] = useState(false);
  const [deleteRoleTarget, setDeleteRoleTarget] = useState<SysRole | null>(null);

  useEffect(() => {
    setForm(settings);
  }, [settings]);

  const openCreateSysUser = () => {
    setSuUsername('');
    setSuFullName('');
    setSuEmail('');
    setSuRoleId(sysRoles.find((r) => !r.isSystem)?.id || sysRoles[0]?.id || '');
    setSuPassword('');
    setSuMustChangePw(true);
    setSysUserModal({ open: true, editing: null });
  };

  const openEditSysUser = (su: SysUser) => {
    setSuUsername(su.username);
    setSuFullName(su.fullName);
    setSuEmail(su.email);
    setSuRoleId(su.roleId);
    setSuPassword('');
    setSuMustChangePw(su.mustChangePw);
    setSysUserModal({ open: true, editing: su });
  };

  const handleSaveSysUser = async (e: FormEvent) => {
    e.preventDefault();
    setSavingSysUser(true);
    try {
      if (sysUserModal.editing) {
        const ok = await onMutate(
          `/api/sys-users/${encodeURIComponent(sysUserModal.editing.id)}`,
          'PATCH',
          {
            fullName: suFullName.trim(),
            email: suEmail.trim(),
            roleId: suRoleId,
            mustChangePw: suMustChangePw,
            ...(suPassword.trim().length >= 6 ? { newPassword: suPassword.trim() } : {}),
          },
          `Operador '${sysUserModal.editing.username}' actualizado.`,
        );
        if (ok) setSysUserModal({ open: false });
      } else {
        const ok = await onMutate(
          '/api/sys-users',
          'POST',
          {
            username: suUsername.trim(),
            fullName: suFullName.trim(),
            email: suEmail.trim(),
            roleId: suRoleId,
            password: suPassword.trim(),
            mustChangePw: suMustChangePw,
          },
          `Operador '${suUsername.trim()}' creado.`,
        );
        if (ok) setSysUserModal({ open: false });
      }
    } finally {
      setSavingSysUser(false);
    }
  };

  const openCreateRole = () => {
    setRoleName('');
    setRoleDesc('');
    setRolePerms({});
    setSysRoleModal({ open: true, editing: null });
  };

  const openEditRole = (role: SysRole) => {
    setRoleName(role.name);
    setRoleDesc(role.description);
    if (role.permissions === '*') {
      const all: Record<string, Record<string, boolean>> = {};
      for (const [mod, meta] of Object.entries(PERMS_CATALOG)) {
        all[mod] = {};
        for (const act of Object.keys(meta.actions)) all[mod][act] = true;
      }
      setRolePerms(all);
    } else {
      setRolePerms(JSON.parse(JSON.stringify(role.permissions || {})));
    }
    setSysRoleModal({ open: true, editing: role });
  };

  const toggleRolePerm = (mod: PermissionModule, act: string) => {
    setRolePerms((prev) => ({
      ...prev,
      [mod]: {
        ...(prev[mod] || {}),
        [act]: !prev[mod]?.[act],
      },
    }));
  };

  const toggleModuleAll = (mod: PermissionModule) => {
    const actions = Object.keys(PERMS_CATALOG[mod].actions);
    const allChecked = actions.every((a) => Boolean(rolePerms[mod]?.[a]));
    setRolePerms((prev) => {
      const nextMod: Record<string, boolean> = {};
      for (const a of actions) nextMod[a] = !allChecked;
      return { ...prev, [mod]: nextMod };
    });
  };

  const handleSaveRole = async (e: FormEvent) => {
    e.preventDefault();
    if (!roleName.trim()) return;
    setSavingRole(true);
    try {
      const payload: { name: string; description: string; permissions: PermissionMatrix } = {
        name: roleName.trim(),
        description: roleDesc.trim(),
        permissions: rolePerms,
      };
      if (sysRoleModal.editing) {
        const ok = await onMutate(
          `/api/sys-roles/${encodeURIComponent(sysRoleModal.editing.id)}`,
          'PATCH',
          payload,
          `Rol '${payload.name}' actualizado.`,
        );
        if (ok) setSysRoleModal({ open: false });
      } else {
        const ok = await onMutate(
          '/api/sys-roles',
          'POST',
          payload,
          `Rol '${payload.name}' creado.`,
        );
        if (ok) setSysRoleModal({ open: false });
      }
    } finally {
      setSavingRole(false);
    }
  };

  const handleSaveSettings = async (e: FormEvent) => {
    e.preventDefault();
    setSavingSettings(true);
    try {
      await onMutate('/api/settings', 'PUT', form, 'Parámetros del servicio guardados.');
    } finally {
      setSavingSettings(false);
    }
  };

  const handleCreateBackup = async () => {
    setCreatingBackup(true);
    try {
      const res = await apiFetch('/api/backups', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ note: backupNote.trim() || 'Respaldo manual desde portal' }),
      });
      const data = await res.json();
      if (!res.ok) {
        onNotify(data.error || 'No se pudo crear el respaldo.', 'error');
        return;
      }
      onStateReplace(data.state as AppStateResponse);
      setBackupNote('');
      onNotify(`Respaldo creado: ${data.filename}`);
    } catch {
      onNotify('Error de red al crear el respaldo.', 'error');
    } finally {
      setCreatingBackup(false);
    }
  };

  const handleDownloadBackup = async (name: string) => {
    try {
      const res = await apiFetch(`/api/backups/${encodeURIComponent(name)}/download`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        onNotify('No se pudo descargar el archivo de respaldo.', 'error');
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      onNotify(`Respaldo descargado: ${name}`);
    } catch {
      onNotify('Error al descargar respaldo.', 'error');
    }
  };

  const handleConfirmRestore = async () => {
    if (!restoreTarget) return;
    setRestoring(true);
    try {
      const res = await apiFetch(`/api/backups/${encodeURIComponent(restoreTarget.name)}/restore`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ what: restoreTarget.what }),
      });
      const data = await res.json();
      if (!res.ok) {
        onNotify(data.error || 'No se pudo restaurar el respaldo.', 'error');
        return;
      }
      onStateReplace(data.state as AppStateResponse);
      setRestoreTarget(null);
      onNotify(
        `Respaldo restaurado (${restoreTarget.what}). Copia previa de seguridad: ${data.safetyBackup}.`,
      );
    } catch {
      onNotify('Error de red al restaurar el respaldo.', 'error');
    } finally {
      setRestoring(false);
    }
  };

  const countPerms = (perms: PermissionMatrix): number => {
    if (perms === '*') {
      return Object.values(PERMS_CATALOG).reduce(
        (acc, m) => acc + Object.keys(m.actions).length,
        0,
      );
    }
    return Object.values(perms).reduce(
      (acc, mod) => acc + Object.values(mod).filter(Boolean).length,
      0,
    );
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-[16px] font-semibold text-[#141413]">
            Administración del sistema y servicio
          </h2>
          <p className="text-xs text-[#5E5D57] mt-0.5">
            Gestiona operadores con acceso al portal, matriz de roles RBAC, parámetros del servicio y respaldos ZIP/JSON.
          </p>
        </div>

        {/* Section Tabs */}
        <div className="flex items-center gap-1 bg-[#F5F4ED] p-1 rounded-lg border border-[#1F1E1D]/10">
          {canManageSysUsersRoles && (
            <>
              <button
                type="button"
                onClick={() => setTab('usuarios')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                  tab === 'usuarios'
                    ? 'bg-white text-[#141413] shadow-xs'
                    : 'text-[#5E5D57] hover:text-[#141413]'
                }`}
              >
                Usuarios del sistema ({sysUsers.length})
              </button>
              <button
                type="button"
                onClick={() => setTab('roles')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                  tab === 'roles'
                    ? 'bg-white text-[#141413] shadow-xs'
                    : 'text-[#5E5D57] hover:text-[#141413]'
                }`}
              >
                Roles y permisos ({sysRoles.length})
              </button>
            </>
          )}
          {canManageService && (
            <button
              type="button"
              onClick={() => setTab('servicio')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                tab === 'servicio'
                  ? 'bg-white text-[#141413] shadow-xs'
                  : 'text-[#5E5D57] hover:text-[#141413]'
              }`}
            >
              Servicio y respaldos
            </button>
          )}
        </div>
      </div>

      {/* TAB 1: SYSTEM USERS */}
      {tab === 'usuarios' && canManageSysUsersRoles && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-[#5E5D57]">
              Operadores autorizados a administrar, auditar o consolidar identidades en UserSync.
            </div>
            <button
              type="button"
              onClick={openCreateSysUser}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg bg-[#185FA5] text-white hover:bg-[#144D87] whitespace-nowrap shrink-0"
            >
              <UserPlus className="w-3.5 h-3.5" />
              <span>Nuevo operador</span>
            </button>
          </div>

          <div className="bg-white border border-[#1F1E1D]/15 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-[13px]">
                <thead>
                  <tr className="bg-[#F5F4ED] border-b border-[#1F1E1D]/10 text-[11px] font-semibold text-[#5E5D57]">
                    <th className="py-2.5 px-4">Usuario / Nombre</th>
                    <th className="py-2.5 px-4">Email corporativo</th>
                    <th className="py-2.5 px-4">Rol asignado</th>
                    <th className="py-2.5 px-4">Estado</th>
                    <th className="py-2.5 px-4">Último acceso</th>
                    <th className="py-2.5 px-4 text-right">Acciones</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1F1E1D]/10">
                  {sysUsers.map((su) => {
                    const isSelf = su.id === authUser.id;
                    return (
                      <tr key={su.id} className="hover:bg-[#FAF9F5]">
                        <td className="py-2.5 px-4">
                          <div className="font-medium text-[#141413] flex items-center gap-1.5">
                            <span>{su.fullName}</span>
                            {isSelf && (
                              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-[#E6F1FB] text-[#0C447C]">
                                Tú
                              </span>
                            )}
                            {su.mustChangePw && (
                              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-[#FAEEDA] text-[#633806]">
                                Clave temporal
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] font-mono-tabular text-[#73726C]">
                            @{su.username}
                          </div>
                        </td>
                        <td className="py-2.5 px-4 text-xs text-[#5E5D57]">{su.email}</td>
                        <td className="py-2.5 px-4 text-xs font-medium text-[#185FA5]">
                          {su.roleName || su.roleId}
                        </td>
                        <td className="py-2.5 px-4">
                          {su.active ? (
                            <span className="inline-flex items-center gap-1 text-xs font-medium text-[#2E6B1E]">
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              <span>Activo</span>
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-xs font-medium text-[#A32D2D]">
                              <UserX className="w-3.5 h-3.5" />
                              <span>Desactivado</span>
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 px-4 text-xs text-[#73726C] tabular-nums">
                          {su.lastLogin ? formatRelativeTime(su.lastLogin) : 'Sin ingresos'}
                        </td>
                        <td className="py-2.5 px-4 text-right">
                          <div className="inline-flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => openEditSysUser(su)}
                              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded border border-[#1F1E1D]/20 hover:bg-[#F3F2EC] text-[#141413]"
                            >
                              <Edit3 className="w-3 h-3" />
                              <span>Editar</span>
                            </button>
                            <button
                              type="button"
                              disabled={isSelf}
                              onClick={() =>
                                onMutate(
                                  `/api/sys-users/${encodeURIComponent(su.id)}/toggle`,
                                  'POST',
                                  undefined,
                                  `Operador '${su.username}' ${su.active ? 'desactivado' : 'activado'}.`,
                                )
                              }
                              title={isSelf ? 'No puedes desactivarte a ti mismo' : undefined}
                              className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded border disabled:opacity-40 ${
                                su.active
                                  ? 'border-[#A32D2D]/30 text-[#A32D2D] hover:bg-[#FCEBEB]'
                                  : 'border-[#2E6B1E]/30 text-[#2E6B1E] hover:bg-[#EAF3DE]'
                              }`}
                            >
                              {su.active ? (
                                <>
                                  <UserX className="w-3 h-3" />
                                  <span>Desactivar</span>
                                </>
                              ) : (
                                <>
                                  <UserCheck className="w-3 h-3" />
                                  <span>Activar</span>
                                </>
                              )}
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: ROLES & PERMISSIONS */}
      {tab === 'roles' && canManageSysUsersRoles && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-[#5E5D57]">
              Define perfiles RBAC granulares por módulo y acción para restringir exactamente qué puede ver o modificar cada operador.
            </div>
            <button
              type="button"
              onClick={openCreateRole}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg bg-[#185FA5] text-white hover:bg-[#144D87] whitespace-nowrap shrink-0"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Nuevo rol</span>
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {sysRoles.map((role) => {
              const assignedCount = sysUsers.filter((u) => u.roleId === role.id).length;
              const permTotal = countPerms(role.permissions);

              return (
                <div
                  key={role.id}
                  className="bg-white border border-[#1F1E1D]/15 rounded-xl p-5 flex flex-col justify-between gap-4"
                >
                  <div className="space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <Shield className="w-4 h-4 text-[#185FA5] shrink-0" />
                          <h3 className="text-sm font-semibold text-[#141413]">{role.name}</h3>
                          {role.isSystem && (
                            <span className="text-[10px] font-medium px-2 py-0.5 rounded bg-[#E6F1FB] text-[#0C447C]">
                              Sistema
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-[#5E5D57] mt-1">
                          {role.description || 'Sin descripción registrada.'}
                        </p>
                      </div>
                      <div className="text-right shrink-0 text-[11px] text-[#73726C] tabular-nums">
                        <div>{assignedCount} operador(es)</div>
                        <div>{role.permissions === '*' ? 'Acceso total' : `${permTotal} permisos`}</div>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 pt-2 border-t border-[#1F1E1D]/10">
                      {(Object.keys(PERMS_CATALOG) as PermissionModule[]).map((mod) => {
                        const modInfo = PERMS_CATALOG[mod];
                        const actions = Object.keys(modInfo.actions);
                        const permsMap =
                          role.permissions === '*'
                            ? null
                            : (role.permissions as Record<string, Record<string, boolean>>);
                        const activeActs =
                          permsMap === null
                            ? actions.length
                            : actions.filter((a) => Boolean(permsMap[mod]?.[a])).length;
                        return (
                          <div
                            key={mod}
                            className="px-2.5 py-1.5 rounded-lg bg-[#FAF9F5] border border-[#1F1E1D]/10 text-[11px]"
                          >
                            <div className="font-medium text-[#141413] truncate">{modInfo.label}</div>
                            <div
                              className={`tabular-nums ${
                                activeActs > 0 ? 'text-[#185FA5] font-semibold' : 'text-[#73726C]'
                              }`}
                            >
                              {activeActs} / {actions.length} acciones
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {!role.isSystem && (
                    <div className="flex items-center justify-end gap-2 pt-2 border-t border-[#1F1E1D]/10">
                      <button
                        type="button"
                        onClick={() => openEditRole(role)}
                        className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg border border-[#1F1E1D]/20 hover:bg-[#F3F2EC]"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                        <span>Editar permisos</span>
                      </button>
                      <button
                        type="button"
                        disabled={assignedCount > 0}
                        onClick={() => setDeleteRoleTarget(role)}
                        title={
                          assignedCount > 0
                            ? 'Reasigna los operadores antes de eliminar el rol'
                            : 'Eliminar rol'
                        }
                        className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg border border-[#A32D2D]/30 text-[#A32D2D] hover:bg-[#FCEBEB] disabled:opacity-40"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>Eliminar</span>
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* TAB 3: SERVICE PARAMETERS, BACKUPS & DIAGNOSTICS */}
      {tab === 'servicio' && canManageService && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 items-start">
          {/* Left 2 cols: Parameters + Backups */}
          <div className="lg:col-span-2 space-y-5">
            <form
              onSubmit={handleSaveSettings}
              className="bg-white border border-[#1F1E1D]/15 rounded-xl p-5 space-y-4"
            >
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-[#141413] flex items-center gap-2">
                  <Server className="w-4 h-4 text-[#185FA5]" />
                  <span>Parámetros operativos del servicio</span>
                </h3>
                <button
                  type="submit"
                  disabled={savingSettings}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium rounded-lg bg-[#185FA5] text-white hover:bg-[#144D87] disabled:opacity-50"
                >
                  <Save className="w-3.5 h-3.5" />
                  <span>{savingSettings ? 'Guardando...' : 'Guardar parámetros'}</span>
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-medium text-[#5E5D57] mb-1">
                    Nombre de la organización
                  </label>
                  <input
                    value={form.orgName}
                    onChange={(e) => setForm({ ...form, orgName: e.target.value })}
                    className="w-full px-3 py-2 text-xs rounded-lg border border-[#1F1E1D]/20 bg-white outline-none focus:border-[#185FA5]"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-[#5E5D57] mb-1">
                    Email de alertas e inconsistencias
                  </label>
                  <input
                    type="email"
                    value={form.alertEmail}
                    onChange={(e) => setForm({ ...form, alertEmail: e.target.value })}
                    className="w-full px-3 py-2 text-xs rounded-lg border border-[#1F1E1D]/20 bg-white outline-none focus:border-[#185FA5]"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-[#5E5D57] mb-1">
                    Frecuencia global de sincronización
                  </label>
                  <select
                    value={form.syncFrequency}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        syncFrequency: e.target.value as SystemSettings['syncFrequency'],
                      })
                    }
                    className="w-full px-3 py-2 text-xs rounded-lg border border-[#1F1E1D]/20 bg-white"
                  >
                    <option value="Cada hora">Cada hora</option>
                    <option value="Cada 6 horas">Cada 6 horas</option>
                    <option value="Diaria (02:00 AM)">Diaria (02:00 AM)</option>
                    <option value="Manual">Manual</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-[#5E5D57] mb-1">
                    Autenticación corporativa
                  </label>
                  <select
                    value={form.authMode}
                    onChange={(e) =>
                      setForm({ ...form, authMode: e.target.value as SystemSettings['authMode'] })
                    }
                    className="w-full px-3 py-2 text-xs rounded-lg border border-[#1F1E1D]/20 bg-white"
                  >
                    <option value="LDAP / Active Directory">LDAP / Active Directory</option>
                    <option value="OAuth 2.0">OAuth 2.0</option>
                    <option value="SAML 2.0">SAML 2.0</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div>
                  <label className="block text-[11px] font-medium text-[#5E5D57] mb-1">
                    Días de gracia (bajas)
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={30}
                    value={form.graceDays}
                    onChange={(e) => setForm({ ...form, graceDays: Number(e.target.value) || 0 })}
                    className="w-full px-3 py-2 text-xs font-mono-tabular rounded-lg border border-[#1F1E1D]/20"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-[#5E5D57] mb-1">
                    Expiración sesión (h)
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={168}
                    value={form.sessionHours}
                    onChange={(e) => setForm({ ...form, sessionHours: Number(e.target.value) || 8 })}
                    className="w-full px-3 py-2 text-xs font-mono-tabular rounded-lg border border-[#1F1E1D]/20"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-[#5E5D57] mb-1">
                    Ciclo scheduler (min)
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={120}
                    value={form.schedulerCheckMinutes}
                    onChange={(e) =>
                      setForm({ ...form, schedulerCheckMinutes: Number(e.target.value) || 5 })
                    }
                    className="w-full px-3 py-2 text-xs font-mono-tabular rounded-lg border border-[#1F1E1D]/20"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-[#5E5D57] mb-1">
                    Retención respaldos
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={form.backupRetention}
                    onChange={(e) =>
                      setForm({ ...form, backupRetention: Number(e.target.value) || 20 })
                    }
                    className="w-full px-3 py-2 text-xs font-mono-tabular rounded-lg border border-[#1F1E1D]/20"
                  />
                </div>
              </div>

              <label className="flex items-center gap-2.5 text-xs text-[#3D3D3A] cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.autoFlagOffboarding}
                  onChange={(e) => setForm({ ...form, autoFlagOffboarding: e.target.checked })}
                />
                <span>
                  Marcar automáticamente accesos de SAP, Salesforce y Office 365 al recibir una baja desde HCM
                </span>
              </label>
            </form>

            {/* Backups Manager */}
            <div className="bg-white border border-[#1F1E1D]/15 rounded-xl p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-[#141413] flex items-center gap-2">
                    <Archive className="w-4 h-4 text-[#185FA5]" />
                    <span>Respaldos y restauración ({backups.length})</span>
                  </h3>
                  <p className="text-[11px] text-[#5E5D57] mt-0.5">
                    Toda restauración crea automáticamente un snapshot preventivo antes de sobrescribir.
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <input
                    value={backupNote}
                    onChange={(e) => setBackupNote(e.target.value)}
                    placeholder="Nota del respaldo..."
                    className="px-2.5 py-1.5 text-xs rounded-lg border border-[#1F1E1D]/20 outline-none focus:border-[#185FA5]"
                  />
                  <button
                    type="button"
                    disabled={creatingBackup}
                    onClick={handleCreateBackup}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-[#185FA5] text-white hover:bg-[#144D87] disabled:opacity-50 whitespace-nowrap"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>{creatingBackup ? 'Creando...' : 'Crear respaldo'}</span>
                  </button>
                </div>
              </div>

              {backups.length === 0 ? (
                <div className="p-6 text-center text-xs text-[#73726C] border border-dashed border-[#1F1E1D]/20 rounded-lg">
                  Aún no hay respaldos almacenados. Crea uno ahora para guardar un snapshot completo.
                </div>
              ) : (
                <div className="border border-[#1F1E1D]/10 rounded-lg overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="bg-[#F5F4ED] border-b border-[#1F1E1D]/10 text-[11px] text-[#5E5D57]">
                        <th className="py-2 px-3">Archivo / Nota</th>
                        <th className="py-2 px-3">Tipo</th>
                        <th className="py-2 px-3">Tamaño</th>
                        <th className="py-2 px-3">Fecha</th>
                        <th className="py-2 px-3 text-right">Acciones</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#1F1E1D]/10">
                      {backups.map((b) => (
                        <tr key={b.name} className="hover:bg-[#FAF9F5]">
                          <td className="py-2 px-3">
                            <div className="font-mono-tabular font-medium text-[#141413]">
                              {b.name}
                            </div>
                            {b.note && <div className="text-[11px] text-[#73726C]">{b.note}</div>}
                          </td>
                          <td className="py-2 px-3 uppercase text-[11px] text-[#5E5D57]">
                            {b.kind} · v{b.version}
                          </td>
                          <td className="py-2 px-3 font-mono-tabular tabular-nums">{b.size}</td>
                          <td className="py-2 px-3 text-[#73726C] tabular-nums">
                            {new Date(b.created).toLocaleString('es-CL')}
                          </td>
                          <td className="py-2 px-3 text-right">
                            <div className="inline-flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => handleDownloadBackup(b.name)}
                                title="Descargar JSON"
                                className="p-1.5 rounded border border-[#1F1E1D]/20 hover:bg-[#F3F2EC] text-[#141413]"
                              >
                                <Download className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => setRestoreTarget({ name: b.name, what: 'all' })}
                                className="px-2 py-1 text-[11px] font-medium rounded border border-[#185FA5]/30 text-[#185FA5] hover:bg-[#E6F1FB]"
                              >
                                Restaurar
                              </button>
                              <button
                                type="button"
                                onClick={() => setDeleteBackupName(b.name)}
                                title="Eliminar respaldo"
                                className="p-1.5 rounded border border-[#A32D2D]/25 text-[#A32D2D] hover:bg-[#FCEBEB]"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          {/* Right Col: Diagnostics & Update History */}
          <div className="space-y-5">
            <div className="bg-white border border-[#1F1E1D]/15 rounded-xl p-5 space-y-3">
              <h3 className="text-sm font-semibold text-[#141413] flex items-center gap-2">
                <Cpu className="w-4 h-4 text-[#185FA5]" />
                <span>Diagnóstico del servicio</span>
              </h3>
              <div className="space-y-2 text-xs">
                <div className="flex justify-between gap-2">
                  <span className="text-[#5E5D57]">Versión UserSync</span>
                  <span className="font-mono-tabular font-semibold">
                    v{serviceInfo.version} (schema {serviceInfo.schemaVersion})
                  </span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-[#5E5D57]">Entorno Node.js</span>
                  <span className="font-mono-tabular">{serviceInfo.nodeVersion}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-[#5E5D57]">Tiempo activo</span>
                  <span className="font-mono-tabular tabular-nums">
                    {formatUptime(serviceInfo.uptimeSeconds)}
                  </span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-[#5E5D57]">Tamaño de BD</span>
                  <span className="font-mono-tabular tabular-nums">{serviceInfo.dbSize}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-[#5E5D57]">Respaldos almacenados</span>
                  <span className="font-mono-tabular tabular-nums">{serviceInfo.backupCount}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-[#5E5D57]">Motor Asistente IA</span>
                  <span
                    className={`font-medium ${
                      serviceInfo.aiConfigured ? 'text-[#2E6B1E]' : 'text-[#854F0B]'
                    }`}
                  >
                    {serviceInfo.aiConfigured ? 'Activo (entorno)' : 'Sin secreto GEMINI'}
                  </span>
                </div>
              </div>

              <div className="pt-3 border-t border-[#1F1E1D]/10">
                <button
                  type="button"
                  onClick={onRequestReset}
                  className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-[#A32D2D]/30 text-[#A32D2D] hover:bg-[#FCEBEB]"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>Restablecer datos iniciales demo</span>
                </button>
              </div>
            </div>

            <div className="bg-white border border-[#1F1E1D]/15 rounded-xl p-5 space-y-3">
              <h3 className="text-sm font-semibold text-[#141413] flex items-center gap-2">
                <History className="w-4 h-4 text-[#185FA5]" />
                <span>Historial de versiones y migraciones</span>
              </h3>
              <div className="space-y-2.5 max-h-72 overflow-y-auto">
                {serviceInfo.updateHistory.length === 0 ? (
                  <p className="text-xs text-[#73726C]">Sin migraciones registradas.</p>
                ) : (
                  serviceInfo.updateHistory.map((u) => (
                    <div
                      key={u.id}
                      className="p-2.5 rounded-lg bg-[#FAF9F5] border border-[#1F1E1D]/10 text-xs space-y-0.5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-[#141413]">
                          v{u.fromVersion} → v{u.toVersion}
                        </span>
                        <span className="text-[10px] text-[#73726C] tabular-nums">
                          {formatRelativeTime(u.createdAt)}
                        </span>
                      </div>
                      <div className="text-[#5E5D57]">{u.detail}</div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* MODAL: CREATE / EDIT SYS USER */}
      {sysUserModal.open && (
        <div
          className="fixed inset-0 z-50 bg-black/45 flex items-center justify-center p-4 no-print"
          onClick={(e) => {
            if (e.target === e.currentTarget) setSysUserModal({ open: false });
          }}
        >
          <div className="bg-white border border-[#1F1E1D]/15 rounded-xl w-full max-w-md overflow-hidden shadow-lg">
            <div className="px-5 py-3.5 border-b border-[#1F1E1D]/10 flex items-center justify-between bg-[#FAF9F5]">
              <h3 className="text-sm font-semibold text-[#141413]">
                {sysUserModal.editing
                  ? `Editar operador · @${sysUserModal.editing.username}`
                  : 'Nuevo operador del sistema'}
              </h3>
              <button
                type="button"
                onClick={() => setSysUserModal({ open: false })}
                className="p-1 rounded border border-[#1F1E1D]/15 hover:bg-[#ECEAE1]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveSysUser} className="p-5 space-y-3.5">
              {!sysUserModal.editing && (
                <div>
                  <label className="block text-xs font-medium text-[#5E5D57] mb-1">
                    Nombre de usuario *
                  </label>
                  <input
                    required
                    value={suUsername}
                    onChange={(e) => setSuUsername(e.target.value)}
                    placeholder="ej: m.sanchez"
                    className="w-full px-3 py-2 text-xs font-mono-tabular rounded-lg border border-[#1F1E1D]/20 outline-none focus:border-[#185FA5]"
                  />
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-[#5E5D57] mb-1">
                  Nombre completo *
                </label>
                <input
                  required
                  value={suFullName}
                  onChange={(e) => setSuFullName(e.target.value)}
                  className="w-full px-3 py-2 text-xs rounded-lg border border-[#1F1E1D]/20 outline-none focus:border-[#185FA5]"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-[#5E5D57] mb-1">
                  Email corporativo *
                </label>
                <input
                  type="email"
                  required
                  value={suEmail}
                  onChange={(e) => setSuEmail(e.target.value)}
                  className="w-full px-3 py-2 text-xs rounded-lg border border-[#1F1E1D]/20 outline-none focus:border-[#185FA5]"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-[#5E5D57] mb-1">Rol RBAC *</label>
                <select
                  required
                  value={suRoleId}
                  onChange={(e) => setSuRoleId(e.target.value)}
                  className="w-full px-3 py-2 text-xs rounded-lg border border-[#1F1E1D]/20 bg-white"
                >
                  {sysRoles.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-[#5E5D57] mb-1 flex items-center gap-1">
                  <KeyRound className="w-3.5 h-3.5 text-[#185FA5]" />
                  <span>
                    {sysUserModal.editing ? 'Nueva contraseña (opcional)' : 'Contraseña inicial *'}
                  </span>
                </label>
                <input
                  type="password"
                  required={!sysUserModal.editing}
                  minLength={6}
                  value={suPassword}
                  onChange={(e) => setSuPassword(e.target.value)}
                  placeholder={sysUserModal.editing ? 'Dejar vacío para conservar actual' : 'Mínimo 6 caracteres'}
                  className="w-full px-3 py-2 text-xs font-mono-tabular rounded-lg border border-[#1F1E1D]/20 outline-none focus:border-[#185FA5]"
                />
              </div>

              <label className="flex items-center gap-2 text-xs text-[#3D3D3A] cursor-pointer pt-1">
                <input
                  type="checkbox"
                  checked={suMustChangePw}
                  onChange={(e) => setSuMustChangePw(e.target.checked)}
                />
                <span>Forzar cambio de contraseña en el próximo ingreso</span>
              </label>

              <div className="flex justify-end gap-2 pt-3 border-t border-[#1F1E1D]/10">
                <button
                  type="button"
                  onClick={() => setSysUserModal({ open: false })}
                  className="px-4 py-2 text-xs font-medium rounded-lg border border-[#1F1E1D]/20 hover:bg-[#F3F2EC]"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={savingSysUser}
                  className="px-4 py-2 text-xs font-medium rounded-lg bg-[#185FA5] text-white hover:bg-[#144D87] disabled:opacity-50"
                >
                  {savingSysUser ? 'Guardando...' : 'Guardar operador'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: CREATE / EDIT SYS ROLE */}
      {sysRoleModal.open && (
        <div
          className="fixed inset-0 z-50 bg-black/45 flex items-center justify-center p-4 no-print"
          onClick={(e) => {
            if (e.target === e.currentTarget) setSysRoleModal({ open: false });
          }}
        >
          <div className="bg-white border border-[#1F1E1D]/15 rounded-xl w-full max-w-2xl max-h-[88vh] flex flex-col overflow-hidden shadow-lg">
            <div className="px-5 py-3.5 border-b border-[#1F1E1D]/10 flex items-center justify-between bg-[#FAF9F5]">
              <h3 className="text-sm font-semibold text-[#141413]">
                {sysRoleModal.editing ? `Editar rol · ${sysRoleModal.editing.name}` : 'Crear rol RBAC'}
              </h3>
              <button
                type="button"
                onClick={() => setSysRoleModal({ open: false })}
                className="p-1 rounded border border-[#1F1E1D]/15 hover:bg-[#ECEAE1]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveRole} className="p-5 overflow-y-auto space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-[#5E5D57] mb-1">
                    Nombre del rol *
                  </label>
                  <input
                    required
                    value={roleName}
                    onChange={(e) => setRoleName(e.target.value)}
                    placeholder="Ej: Auditor Externo"
                    className="w-full px-3 py-2 text-xs rounded-lg border border-[#1F1E1D]/20 outline-none focus:border-[#185FA5]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[#5E5D57] mb-1">Descripción</label>
                  <input
                    value={roleDesc}
                    onChange={(e) => setRoleDesc(e.target.value)}
                    placeholder="Alcance operativo del rol"
                    className="w-full px-3 py-2 text-xs rounded-lg border border-[#1F1E1D]/20 outline-none focus:border-[#185FA5]"
                  />
                </div>
              </div>

              <div className="space-y-2.5">
                <div className="text-xs font-semibold text-[#141413]">
                  Matriz de permisos por módulo
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {(Object.keys(PERMS_CATALOG) as PermissionModule[]).map((mod) => {
                    const info = PERMS_CATALOG[mod];
                    const actions = Object.entries(info.actions);
                    const allChecked = actions.every(([act]) => Boolean(rolePerms[mod]?.[act]));
                    return (
                      <div
                        key={mod}
                        className="p-3 rounded-lg border border-[#1F1E1D]/15 bg-[#FAF9F5] space-y-2"
                      >
                        <div className="flex items-center justify-between gap-2 pb-1.5 border-b border-[#1F1E1D]/10">
                          <span className="text-xs font-semibold text-[#141413]">{info.label}</span>
                          <button
                            type="button"
                            onClick={() => toggleModuleAll(mod)}
                            className="text-[11px] font-medium text-[#185FA5] hover:underline"
                          >
                            {allChecked ? 'Desmarcar' : 'Marcar todo'}
                          </button>
                        </div>
                        <div className="space-y-1.5">
                          {actions.map(([act, label]) => (
                            <label
                              key={act}
                              className="flex items-center gap-2 text-xs text-[#3D3D3A] cursor-pointer"
                            >
                              <input
                                type="checkbox"
                                checked={Boolean(rolePerms[mod]?.[act])}
                                onChange={() => toggleRolePerm(mod, act)}
                              />
                              <span>{label}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-[#1F1E1D]/10">
                <button
                  type="button"
                  onClick={() => setSysRoleModal({ open: false })}
                  className="px-4 py-2 text-xs font-medium rounded-lg border border-[#1F1E1D]/20 hover:bg-[#F3F2EC]"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={savingRole}
                  className="px-4 py-2 text-xs font-medium rounded-lg bg-[#185FA5] text-white hover:bg-[#144D87] disabled:opacity-50"
                >
                  {savingRole ? 'Guardando...' : 'Guardar rol'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: RESTORE BACKUP */}
      {restoreTarget && (
        <div
          className="fixed inset-0 z-50 bg-black/45 flex items-center justify-center p-4 no-print"
          onClick={(e) => {
            if (e.target === e.currentTarget) setRestoreTarget(null);
          }}
        >
          <div className="bg-white border border-[#1F1E1D]/15 rounded-xl w-full max-w-md p-5 space-y-4 shadow-lg">
            <div className="flex items-start gap-3">
              <ShieldAlert className="w-5 h-5 text-[#BA7517] shrink-0 mt-0.5" />
              <div className="space-y-1">
                <h3 className="text-sm font-semibold text-[#141413]">
                  Restaurar desde respaldo
                </h3>
                <p className="text-xs text-[#5E5D57]">
                  Archivo: <strong className="font-mono-tabular">{restoreTarget.name}</strong>. Se creará automáticamente un respaldo preventivo del estado actual antes de restaurar.
                </p>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-[#5E5D57]">Alcance a restaurar</label>
              <select
                value={restoreTarget.what}
                onChange={(e) =>
                  setRestoreTarget({
                    ...restoreTarget,
                    what: e.target.value as 'db' | 'config' | 'all',
                  })
                }
                className="w-full px-3 py-2 text-xs rounded-lg border border-[#1F1E1D]/20 bg-white"
              >
                <option value="all">Todo (Directorio + Configuración del servicio)</option>
                <option value="db">Solo Directorio, plataformas, bajas e importaciones</option>
                <option value="config">Solo Parámetros del servicio, roles y operadores</option>
              </select>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setRestoreTarget(null)}
                className="px-4 py-2 text-xs font-medium rounded-lg border border-[#1F1E1D]/20 hover:bg-[#F3F2EC]"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={restoring}
                onClick={handleConfirmRestore}
                className="px-4 py-2 text-xs font-medium rounded-lg bg-[#185FA5] text-white hover:bg-[#144D87] disabled:opacity-50"
              >
                {restoring ? 'Restaurando...' : 'Confirmar restauración'}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteBackupName && (
        <ConfirmModal
          title="Eliminar archivo de respaldo"
          message={`¿Confirmas eliminar permanentemente el respaldo '${deleteBackupName}'?`}
          confirmLabel="Eliminar respaldo"
          danger
          onConfirm={async () => {
            await onMutate(
              `/api/backups/${encodeURIComponent(deleteBackupName)}`,
              'DELETE',
              undefined,
              `Respaldo ${deleteBackupName} eliminado.`,
            );
            setDeleteBackupName(null);
          }}
          onClose={() => setDeleteBackupName(null)}
        />
      )}

      {deleteRoleTarget && (
        <ConfirmModal
          title="Eliminar rol RBAC"
          message={`¿Confirmas eliminar el rol '${deleteRoleTarget.name}'?`}
          confirmLabel="Eliminar rol"
          danger
          onConfirm={async () => {
            await onMutate(
              `/api/sys-roles/${encodeURIComponent(deleteRoleTarget.id)}`,
              'DELETE',
              undefined,
              `Rol '${deleteRoleTarget.name}' eliminado.`,
            );
            setDeleteRoleTarget(null);
          }}
          onClose={() => setDeleteRoleTarget(null)}
        />
      )}
    </div>
  );
}
