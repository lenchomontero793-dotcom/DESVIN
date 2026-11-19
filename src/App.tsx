import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  Database,
  Download,
  Eye,
  History,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Menu,
  Plug,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  UserCheck,
  UserMinus,
  Users,
  X,
} from 'lucide-react';
import { AccountValidationView } from './components/AccountValidationView';
import { AdminConfigView } from './components/AdminConfigView';
import { AssistantView } from './components/AssistantView';
import { AuditLogView } from './components/AuditLogView';
import { ConsolidationView } from './components/ConsolidationView';
import { DashboardView } from './components/DashboardView';
import { LoginPortal } from './components/LoginPortal';
import {
  BulkImportModal,
  ChangePasswordModal,
  ConfirmModal,
  NewOffboardingModal,
  NewUserModal,
  PlatformModal,
  ReportPreviewModal,
  UserDetailModal,
} from './components/Modals';
import { MyProfileView } from './components/MyProfileView';
import { OffboardingView } from './components/OffboardingView';
import { PlatformApiModal } from './components/PlatformApiModal';
import { PlatformCrossMatchModal } from './components/PlatformCrossMatchModal';
import { PlatformsView } from './components/PlatformsView';
import { ReportsView, buildReportData, type ReportType } from './components/ReportsView';
import { UsersView } from './components/UsersView';
import type {
  ApiConfig,
  AppStateResponse,
  AuthSession,
  ConsolidationPreviewItem,
  ConsolidationPreviewResponse,
  OffboardingRecord,
  Platform,
  PortalRole,
  User,
} from './types';
import { downloadCsv, parseCsvText } from './utils/formatters';
import {
  getAllowedPages,
  getDefaultPage,
  hasPerm,
  type NavPage,
} from './utils/rbac';

const TOKEN_STORAGE_KEY = 'usersync_session_token';

interface ToastState {
  message: string;
  tone: 'success' | 'error';
}

export default function App() {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [authChecking, setAuthChecking] = useState(true);

  const [state, setState] = useState<AppStateResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState<NavPage>('dashboard');
  const [searchQuery, setSearchQuery] = useState('');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);

  // Active modals
  const [inspectUserId, setInspectUserId] = useState<string | null>(null);
  const [showNewUserModal, setShowNewUserModal] = useState(false);
  const [showBulkImportModal, setShowBulkImportModal] = useState(false);
  const [showChangePwModal, setShowChangePwModal] = useState(false);
  const [offboardModalUser, setOffboardModalUser] = useState<User | null | undefined>(undefined);
  const [platformModalState, setPlatformModalState] = useState<{
    open: boolean;
    platform?: Platform | null;
  }>({ open: false });
  const [crossMatchPlatformId, setCrossMatchPlatformId] = useState<string | null>(null);
  const [apiModalPlatformId, setApiModalPlatformId] = useState<string | null>(null);
  const [previewReportType, setPreviewReportType] = useState<ReportType | null>(null);
  const [confirmState, setConfirmState] = useState<{
    title: string;
    message: string;
    confirmLabel: string;
    danger?: boolean;
    onConfirm: () => Promise<void>;
  } | null>(null);

  const showToast = useCallback((message: string, tone: 'success' | 'error' = 'success') => {
    setToast({ message, tone });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const clearSession = useCallback(() => {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    setSession(null);
    setState(null);
    setInspectUserId(null);
    setShowNewUserModal(false);
    setShowBulkImportModal(false);
    setShowChangePwModal(false);
    setOffboardModalUser(undefined);
    setPlatformModalState({ open: false });
    setCrossMatchPlatformId(null);
    setApiModalPlatformId(null);
    setPreviewReportType(null);
    setConfirmState(null);
  }, []);

  // Verify saved token on boot
  useEffect(() => {
    const savedToken = localStorage.getItem(TOKEN_STORAGE_KEY);
    if (!savedToken) {
      setAuthChecking(false);
      return;
    }

    fetch('/api/auth/me', {
      headers: { Authorization: `Bearer ${savedToken}` },
    })
      .then(async (res) => {
        if (!res.ok) {
          clearSession();
          return;
        }
        const data = (await res.json()) as { user: AuthSession['user'] };
        setSession({ token: savedToken, user: data.user });
        setPage(getDefaultPage(data.user));
      })
      .catch(() => {
        clearSession();
      })
      .finally(() => {
        setAuthChecking(false);
      });
  }, [clearSession]);

  const fetchState = useCallback(
    async (token: string) => {
      setLoading(true);
      try {
        const res = await fetch('/api/state', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.status === 401 || res.status === 403) {
          clearSession();
          return;
        }
        if (!res.ok) throw new Error('Error al cargar la base de datos.');
        const data = (await res.json()) as AppStateResponse;
        setState(data);
      } catch (err) {
        showToast(
          err instanceof Error ? err.message : 'Error de conexión con el servidor.',
          'error',
        );
      } finally {
        setLoading(false);
      }
    },
    [clearSession, showToast],
  );

  useEffect(() => {
    if (session?.token) {
      void fetchState(session.token);
    }
  }, [session?.token, fetchState]);

  const handleLoginSuccess = (newSession: AuthSession) => {
    localStorage.setItem(TOKEN_STORAGE_KEY, newSession.token);
    setSession(newSession);
    setPage(getDefaultPage(newSession.user));
    setSearchQuery('');
    showToast(`Bienvenido, ${newSession.user.name} (${newSession.user.roleName}).`);
  };

  const handleLogout = async () => {
    if (session?.token) {
      try {
        await fetch('/api/auth/logout', {
          method: 'POST',
          headers: { Authorization: `Bearer ${session.token}` },
        });
      } catch {
        // ignore network error on logout
      }
    }
    clearSession();
  };

  const handleChangePassword = async (
    currentPassword: string,
    newPassword: string,
  ): Promise<string | null> => {
    if (!session?.token) return 'Sesión no válida.';
    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.token}`,
        },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await res.json();
      if (!res.ok) {
        return data.error || 'No se pudo actualizar la contraseña.';
      }
      setSession((prev) => (prev ? { ...prev, user: data.user } : null));
      showToast('Contraseña actualizada correctamente.');
      return null;
    } catch {
      return 'Error de red al actualizar contraseña.';
    }
  };

  const apiMutate = async (
    url: string,
    method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    body?: unknown,
    successMessage?: string,
  ): Promise<boolean> => {
    if (!session?.token) return false;
    try {
      const res = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.token}`,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if (res.status === 401) {
        clearSession();
        return false;
      }
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'No se pudo completar la operación.', 'error');
        return false;
      }
      setState(data as AppStateResponse);
      if (successMessage) showToast(successMessage, 'success');
      return true;
    } catch {
      showToast('Error de red al comunicarse con el servidor.', 'error');
      return false;
    }
  };

  const handleCreateUser = async (payload: {
    name: string;
    email: string;
    rut: string;
    dept: string;
    position: string;
    manager?: string;
    phone?: string;
    hireDate?: string;
    notes?: string;
    portalRole: PortalRole;
    password?: string;
    platformIds: string[];
  }) => {
    return apiMutate('/api/users', 'POST', payload, `Usuario ${payload.name} creado y consolidado.`);
  };

  const handleBulkImportUsers = async (
    rows: Record<string, string>[],
    mode: 'omitir' | 'actualizar',
  ): Promise<boolean> => {
    if (!session?.token) return false;
    try {
      const res = await fetch('/api/users/bulk-import', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.token}`,
        },
        body: JSON.stringify({ rows, mode }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Error en importación masiva.', 'error');
        return false;
      }
      setState(data.state as AppStateResponse);
      const s = data.summary;
      showToast(
        `Importación masiva: ${s.created} creados, ${s.updated} actualizados, ${s.skipped} omitidos.`,
      );
      return true;
    } catch {
      showToast('Error de red en importación masiva.', 'error');
      return false;
    }
  };

  const handleUpdateUser = async (userId: string, patch: Partial<User>) => {
    await apiMutate(`/api/users/${userId}`, 'PATCH', patch, 'Ficha de usuario actualizada.');
  };

  const handleTogglePlatform = async (userId: string, platformId: string, enable: boolean) => {
    await apiMutate(
      `/api/users/${userId}/toggle-platform`,
      'POST',
      { platformId, enable },
      enable ? `Acceso habilitado en ${platformId}.` : `Acceso revocado en ${platformId}.`,
    );
  };

  const handleApiOffboard = async (platformId: string, userId: string) => {
    if (!session?.token) return;
    try {
      const res = await fetch(
        `/api/platforms/${encodeURIComponent(platformId)}/api/offboard/${encodeURIComponent(userId)}`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${session.token}` },
        },
      );
      const data = await res.json();
      if (data.state) setState(data.state as AppStateResponse);
      if (!res.ok || !data.result?.ok) {
        showToast(data.result?.msg || data.error || 'Error en baja remota vía API.', 'error');
      } else {
        showToast(data.result.msg || `Baja remota ejecutada en ${platformId}.`);
      }
    } catch {
      showToast('Error de red al ejecutar baja remota API.', 'error');
    }
  };

  const handleStartOffboarding = async (userId: string, reason: string, offboardDate: string) => {
    return apiMutate(
      '/api/offboardings',
      'POST',
      { userId, reason, offboardDate },
      'Proceso de baja iniciado. Accesos marcados para revocación.',
    );
  };

  const handleRevokePlatformInOffboarding = async (offboardingId: string, platformId: string) => {
    await apiMutate(
      `/api/offboardings/${offboardingId}/revoke`,
      'POST',
      { platformId },
      `Acceso ${platformId} revocado correctamente.`,
    );
  };

  const handleRequestRevokeAll = (record: OffboardingRecord) => {
    setConfirmState({
      title: 'Confirmar revocación total de accesos',
      message: `¿Confirmas revocar inmediatamente los ${record.pendingPlatforms.length} accesos pendientes (${record.pendingPlatforms.join(', ')}) para ${record.userName}? Esta acción marcará su desvinculación como completada.`,
      confirmLabel: 'Revocar todos los accesos',
      danger: true,
      onConfirm: async () => {
        await apiMutate(
          `/api/offboardings/${record.id}/revoke`,
          'POST',
          { all: true },
          `Todos los accesos de ${record.userName} han sido revocados.`,
        );
      },
    });
  };

  const handleSyncPlatform = async (platformId: string) => {
    await apiMutate(
      `/api/platforms/${encodeURIComponent(platformId)}/sync`,
      'POST',
      undefined,
      `Sincronización ${platformId} completada.`,
    );
  };

  const handleSavePlatform = async (payload: Partial<Platform>, isEdit: boolean) => {
    if (isEdit && payload.id) {
      return apiMutate(
        `/api/platforms/${encodeURIComponent(payload.id)}`,
        'PATCH',
        payload,
        `Configuración de ${payload.name} guardada.`,
      );
    }
    return apiMutate(
      '/api/platforms',
      'POST',
      payload,
      `Plataforma ${payload.name} integrada al directorio.`,
    );
  };

  const handleRequestDeletePlatform = (platform: Platform) => {
    setConfirmState({
      title: 'Eliminar plataforma personalizada',
      message: `¿Confirmas eliminar '${platform.name}' junto con sus importaciones, configuración API y cuentas asociadas?`,
      confirmLabel: 'Eliminar plataforma',
      danger: true,
      onConfirm: async () => {
        await apiMutate(
          `/api/platforms/${encodeURIComponent(platform.id)}`,
          'DELETE',
          undefined,
          `Plataforma ${platform.name} eliminada.`,
        );
      },
    });
  };

  const handleRunPlatformImport = async (
    platformId: string,
    rows: Record<string, string>[],
    mode: 'reemplazar' | 'agregar',
  ): Promise<{ total: number; matched: number; unmatched: number } | null> => {
    if (!session?.token) return null;
    try {
      const res = await fetch(`/api/platforms/${encodeURIComponent(platformId)}/imports`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.token}`,
        },
        body: JSON.stringify({ rows, mode }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Error al cruzar planilla.', 'error');
        return null;
      }
      setState(data.state as AppStateResponse);
      const s = data.summary as { total: number; matched: number; unmatched: number };
      showToast(
        `Cruce ${platformId}: ${s.matched}/${s.total} coincidentes (${s.unmatched} sin cruce).`,
      );
      return s;
    } catch {
      showToast('Error de red al importar planilla.', 'error');
      return null;
    }
  };

  const handleManualLink = async (platformId: string, importId: string, userId: string) => {
    await apiMutate(
      `/api/platforms/${encodeURIComponent(platformId)}/imports/${encodeURIComponent(importId)}/link`,
      'POST',
      { userId },
      'Registro vinculado manualmente al directorio.',
    );
  };

  const handleSaveApiConfig = async (
    platformId: string,
    config: Partial<ApiConfig>,
  ): Promise<boolean> => {
    return apiMutate(
      `/api/platforms/${encodeURIComponent(platformId)}/api`,
      'PUT',
      config,
      `Configuración API guardada para ${platformId}.`,
    );
  };

  const handleTestApiConnection = async (platformId: string) => {
    if (!session?.token) return { ok: false, count: 0, msg: 'Sesión no válida.' };
    try {
      const res = await fetch(`/api/platforms/${encodeURIComponent(platformId)}/api/test`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.token}` },
      });
      return (await res.json()) as { ok: boolean; count: number; msg: string; sample?: unknown[] };
    } catch {
      return { ok: false, count: 0, msg: 'Error de red al probar conexión API.' };
    }
  };

  const handleForceApiSync = async (platformId: string) => {
    if (!session?.token) return { ok: false, msg: 'Sesión no válida.' };
    try {
      const res = await fetch(`/api/platforms/${encodeURIComponent(platformId)}/api/sync`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.token}` },
      });
      const data = await res.json();
      if (data.state) setState(data.state as AppStateResponse);
      if (data.result?.ok) {
        showToast(data.result.msg || `Sincronización API ${platformId} completada.`);
      } else {
        showToast(data.result?.msg || 'Error en sincronización API.', 'error');
      }
      return data.result as { ok: boolean; msg: string };
    } catch {
      return { ok: false, msg: 'Error de red al sincronizar API.' };
    }
  };

  const handlePreviewConsolidation = async (
    platformId: string,
    rawText: string,
  ): Promise<ConsolidationPreviewResponse | null> => {
    if (!session?.token) return null;
    const rows = parseCsvText(rawText);
    try {
      const res = await fetch('/api/consolidate/preview', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.token}`,
        },
        body: JSON.stringify({ platformId, rows }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Error al analizar los registros.', 'error');
        return null;
      }
      return data as ConsolidationPreviewResponse;
    } catch {
      showToast('Error al procesar el cruce de datos.', 'error');
      return null;
    }
  };

  const handleCommitConsolidation = async (platformId: string, items: ConsolidationPreviewItem[]) => {
    await apiMutate(
      '/api/consolidate/commit',
      'POST',
      { platformId, items },
      `Base de datos consolidada desde ${platformId}.`,
    );
  };

  const handleRequestReset = () => {
    setConfirmState({
      title: 'Restablecer datos iniciales',
      message:
        'Se creará un respaldo preventivo automático y se restaurará el directorio corporativo, plataformas y bajas al estado inicial de demostración. ¿Deseas continuar?',
      confirmLabel: 'Restablecer datos',
      danger: true,
      onConfirm: async () => {
        await apiMutate('/api/reset', 'POST', undefined, 'Base de datos restablecida.');
      },
    });
  };

  const handleQuickExport = () => {
    if (!state) return;
    const built = buildReportData('inventario', {
      users: state.users,
      platforms: state.platforms,
      offboardings: state.offboardings,
      inconsistencies: state.inconsistencies,
      auditLogs: state.auditLogs,
    });
    downloadCsv(built.filename, built.headers, built.rows);
    showToast(`Inventario exportado (${built.filename}).`);
  };

  if (authChecking) {
    return (
      <div className="min-h-screen bg-[#FAF9F5] flex items-center justify-center p-6">
        <div className="text-sm text-[#5E5D57]">Verificando sesión corporativa...</div>
      </div>
    );
  }

  if (!session) {
    return <LoginPortal onLoginSuccess={handleLoginSuccess} />;
  }

  const authUser = session.user;
  const isCollaboratorOnly = authUser.kind === 'directory' && authUser.portalRole === 'USER';
  const allowedPages = getAllowedPages(authUser);

  const canCreateUsers = hasPerm(authUser, 'usuarios', 'crear');
  const canEditUsers = hasPerm(authUser, 'usuarios', 'editar');
  const canManageBajas = hasPerm(authUser, 'bajas', 'gestionar');
  const canCreatePlatforms = hasPerm(authUser, 'plataformas', 'crear');
  const canEditPlatforms = hasPerm(authUser, 'plataformas', 'editar');
  const canImportPlatforms = hasPerm(authUser, 'plataformas', 'importar');
  const canExportReports = hasPerm(authUser, 'reportes', 'exportar');
  const canAssignAdminRole = authUser.permissions === '*';
  const isReadOnly = !canCreateUsers && !canEditUsers && !canManageBajas && !canEditPlatforms;

  const handleNavClick = (target: NavPage) => {
    if (allowedPages.includes(target)) {
      setPage(target);
    }
    setMobileMenuOpen(false);
  };

  const pendingOffboardings = state?.offboardings.filter((o) => o.status === 'En proceso') ?? [];
  const inspectedUser = state?.users.find((u) => u.id === inspectUserId) ?? null;
  const crossMatchPlatform =
    state?.platforms.find((p) => p.id === crossMatchPlatformId) ?? null;
  const apiModalPlatform =
    state?.platforms.find((p) => p.id === apiModalPlatformId) ?? null;

  const navGroups: {
    section: string;
    items: { id: NavPage; label: string; icon: typeof LayoutDashboard; count?: number }[];
  }[] = [
    {
      section: 'Principal',
      items: [
        { id: 'mi-perfil', label: 'Mi perfil y accesos', icon: UserCheck },
        { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
        { id: 'usuarios', label: 'Usuarios', icon: Users },
        {
          id: 'bajas',
          label: 'Bajas y desvinc.',
          icon: UserMinus,
          count: pendingOffboardings.length || undefined,
        },
      ],
    },
    {
      section: 'Plataformas',
      items: [
        { id: 'validacion', label: 'Validar cuentas', icon: ShieldCheck },
        { id: 'consolidar', label: 'Consolidar BD', icon: Database },
        { id: 'plataformas', label: 'Plataformas', icon: Plug },
        { id: 'reportes', label: 'Reportes', icon: BarChart3 },
      ],
    },
    {
      section: 'Sistema',
      items: [
        { id: 'audit', label: 'Audit Log', icon: History },
        { id: 'asistente', label: 'Asistente IA', icon: Sparkles },
        { id: 'configuracion', label: 'Configuración', icon: Settings },
      ],
    },
  ];

  const renderSidebarContent = () => (
    <>
      <div className="px-4 pb-4 pt-1 border-b border-[#1F1E1D]/10">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-[#185FA5] text-white flex items-center justify-center shrink-0">
            <Users className="w-4 h-4" />
          </div>
          <div>
            <h1 className="text-[15px] font-semibold text-[#141413] leading-tight">UserSync</h1>
            <p className="text-[11px] text-[#5E5D57]">Gestión de identidades</p>
          </div>
        </div>
      </div>

      <nav className="flex-1 py-2 overflow-y-auto">
        {navGroups.map((group) => {
          const visibleItems = group.items.filter((i) => allowedPages.includes(i.id));
          if (visibleItems.length === 0) return null;
          return (
            <div key={group.section} className="mb-2">
              <div className="px-4 pt-3 pb-1 text-[10px] font-semibold text-[#73726C] tracking-wider uppercase">
                {group.section}
              </div>
              <div className="px-2 space-y-0.5">
                {visibleItems.map((item) => {
                  const Icon = item.icon;
                  const active = page === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => handleNavClick(item.id)}
                      className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-[13px] transition-colors whitespace-nowrap ${
                        active
                          ? 'bg-[#E6F1FB] text-[#0C447C] font-semibold'
                          : 'text-[#3D3D3A] hover:bg-[#F3F2EC] hover:text-[#141413]'
                      }`}
                    >
                      <span className="flex items-center gap-2.5 min-w-0">
                        <Icon className="w-4 h-4 shrink-0" />
                        <span className="truncate">{item.label}</span>
                      </span>
                      {item.count !== undefined && (
                        <span className="text-[11px] font-mono-tabular font-semibold text-[#A32D2D] tabular-nums">
                          {item.count}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </nav>

      {/* Authenticated User & Role Card */}
      <div className="px-3 pt-3 border-t border-[#1F1E1D]/10 space-y-2">
        <div className="px-2">
          <div className="text-xs font-semibold text-[#141413] truncate">{authUser.name}</div>
          <div className="text-[11px] text-[#5E5D57] truncate">{authUser.email}</div>
          <div className="text-[11px] font-medium text-[#185FA5] mt-1">{authUser.roleName}</div>
        </div>
        <div className="flex flex-col gap-1.5">
          <button
            type="button"
            onClick={() => setShowChangePwModal(true)}
            className="w-full flex items-center justify-center gap-2 px-3 py-1.5 rounded-lg border border-[#1F1E1D]/15 text-xs font-medium text-[#3D3D3A] hover:bg-[#F3F2EC] hover:text-[#141413] transition-colors"
          >
            <KeyRound className="w-3.5 h-3.5" />
            <span>Cambiar clave</span>
          </button>
          <button
            type="button"
            onClick={handleLogout}
            className="w-full flex items-center justify-center gap-2 px-3 py-1.5 rounded-lg border border-[#1F1E1D]/15 text-xs font-medium text-[#3D3D3A] hover:bg-[#F3F2EC] hover:text-[#141413] transition-colors"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Cerrar sesión</span>
          </button>
        </div>
      </div>
    </>
  );

  return (
    <div className="min-h-screen flex bg-[#FAF9F5] text-[#141413]">
      {/* Desktop Sidebar */}
      <aside className="hidden md:flex w-[240px] shrink-0 bg-white border-r border-[#1F1E1D]/15 flex-col py-4 no-print">
        {renderSidebarContent()}
      </aside>

      {/* Mobile Sidebar Drawer */}
      {mobileMenuOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/40 md:hidden no-print"
          onClick={(e) => {
            if (e.target === e.currentTarget) setMobileMenuOpen(false);
          }}
        >
          <aside className="w-[240px] h-full bg-white border-r border-[#1F1E1D]/15 flex flex-col py-4">
            <div className="px-4 pb-2 flex justify-end">
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                className="p-1 rounded border border-[#1F1E1D]/15"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            {renderSidebarContent()}
          </aside>
        </div>
      )}

      {/* Main Content Column */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Topbar */}
        <header className="bg-white border-b border-[#1F1E1D]/15 px-4 md:px-6 py-3 flex items-center justify-between gap-4 no-print">
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Abrir menú"
              className="md:hidden p-2 rounded-lg border border-[#1F1E1D]/15 text-[#3D3D3A]"
            >
              <Menu className="w-4 h-4" />
            </button>

            {!isCollaboratorOnly ? (
              <div className="relative flex-1 max-w-md">
                <Search className="w-4 h-4 text-[#73726C] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Buscar usuario, RUT, email..."
                  className="w-full pl-9 pr-3 py-1.5 text-[13px] rounded-lg border border-[#1F1E1D]/15 bg-[#FAF9F5] text-[#141413] outline-none focus:border-[#378ADD] focus:bg-white transition-colors"
                />
              </div>
            ) : (
              <div className="text-xs font-medium text-[#5E5D57]">
                Portal personal · {authUser.dept} · {authUser.position}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {!isCollaboratorOnly && isReadOnly && (
              <span className="inline-flex items-center gap-1.5 text-xs text-[#5E5D57] mr-2 whitespace-nowrap">
                <Eye className="w-3.5 h-3.5 text-[#185FA5]" />
                <span>Solo lectura</span>
              </span>
            )}
            {!isCollaboratorOnly && canExportReports && (
              <button
                type="button"
                onClick={handleQuickExport}
                disabled={!state}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-[#1F1E1D]/20 bg-white hover:bg-[#F3F2EC] text-[#141413] whitespace-nowrap shrink-0"
              >
                <Download className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Exportar</span>
              </button>
            )}
            {canCreateUsers && (
              <button
                type="button"
                onClick={() => setShowNewUserModal(true)}
                disabled={!state}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium rounded-lg bg-[#185FA5] hover:bg-[#144D87] text-white whitespace-nowrap shrink-0"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Nuevo usuario</span>
              </button>
            )}
          </div>
        </header>

        {/* Dynamic Offboarding Alert Banner */}
        {state && !isCollaboratorOnly && pendingOffboardings.length > 0 && (
          <div className="bg-[#FAEEDA] border-b border-[#BA7517]/30 px-4 md:px-6 py-2.5 flex flex-wrap items-center justify-between gap-3 text-[13px] text-[#633806] no-print">
            <div className="flex items-center gap-2.5 min-w-0">
              <AlertTriangle className="w-4 h-4 text-[#BA7517] shrink-0" />
              <span>
                <strong className="tabular-nums">{pendingOffboardings.length}</strong>{' '}
                {pendingOffboardings.length === 1
                  ? 'usuario en proceso de desvinculación pendiente'
                  : 'usuarios en proceso de desvinculación pendientes'}{' '}
                de revocar accesos en plataformas corporativas.
              </span>
            </div>
            {allowedPages.includes('bajas') && (
              <button
                type="button"
                onClick={() => handleNavClick('bajas')}
                className="px-3 py-1 text-xs font-medium rounded-md bg-white border border-[#BA7517]/40 hover:bg-[#FAF9F5] text-[#633806] whitespace-nowrap shrink-0"
              >
                Ver ahora
              </button>
            )}
          </div>
        )}

        {/* Viewport Content */}
        <main className="flex-1 p-4 md:p-6 overflow-y-auto">
          {loading || !state ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                {[1, 2, 3, 4].map((n) => (
                  <div key={n} className="h-24 rounded-lg bg-[#ECEAE1] animate-pulse" />
                ))}
              </div>
              <div className="h-64 rounded-xl bg-[#ECEAE1] animate-pulse" />
            </div>
          ) : (
            <>
              {page === 'mi-perfil' && state.users[0] && (
                <MyProfileView
                  user={state.users[0]}
                  platforms={state.platforms}
                  offboarding={state.offboardings[0]}
                />
              )}
              {page === 'dashboard' && allowedPages.includes('dashboard') && (
                <DashboardView
                  users={state.users}
                  platforms={state.platforms}
                  offboardings={state.offboardings}
                  inconsistencies={state.inconsistencies}
                  auditLogs={state.auditLogs}
                  onInspectUser={(uid) => setInspectUserId(uid)}
                  onNavigate={(target) => {
                    if (allowedPages.includes(target)) handleNavClick(target);
                  }}
                />
              )}
              {page === 'usuarios' && allowedPages.includes('usuarios') && (
                <UsersView
                  users={state.users}
                  platforms={state.platforms}
                  inconsistencies={state.inconsistencies}
                  searchQuery={searchQuery}
                  canWrite={canCreateUsers}
                  onInspectUser={(uid) => setInspectUserId(uid)}
                  onNewUser={() => setShowNewUserModal(true)}
                  onBulkImport={canCreateUsers ? () => setShowBulkImportModal(true) : undefined}
                />
              )}
              {page === 'validacion' && allowedPages.includes('validacion') && (
                <AccountValidationView
                  users={state.users}
                  platforms={state.platforms}
                  searchQuery={searchQuery}
                  canWrite={canEditUsers}
                  onTogglePlatform={handleTogglePlatform}
                  onInspectUser={(uid) => setInspectUserId(uid)}
                />
              )}
              {page === 'consolidar' && allowedPages.includes('consolidar') && (
                <ConsolidationView
                  platforms={state.platforms}
                  onPreview={handlePreviewConsolidation}
                  onCommit={handleCommitConsolidation}
                  onOpenCrossMatch={(pl) => setCrossMatchPlatformId(pl.id)}
                />
              )}
              {page === 'bajas' && allowedPages.includes('bajas') && (
                <OffboardingView
                  offboardings={state.offboardings}
                  searchQuery={searchQuery}
                  canWrite={canManageBajas}
                  onRevokePlatform={handleRevokePlatformInOffboarding}
                  onRequestRevokeAll={handleRequestRevokeAll}
                  onStartOffboarding={() => setOffboardModalUser(null)}
                />
              )}
              {page === 'plataformas' && allowedPages.includes('plataformas') && (
                <PlatformsView
                  platforms={state.platforms}
                  users={state.users}
                  apiConfigs={state.apiConfigs}
                  platformImports={state.platformImports}
                  canCreate={canCreatePlatforms}
                  canEdit={canEditPlatforms}
                  canImport={canImportPlatforms}
                  onSyncPlatform={handleSyncPlatform}
                  onConfigurePlatform={(pl) => setPlatformModalState({ open: true, platform: pl })}
                  onAddPlatform={() => setPlatformModalState({ open: true, platform: null })}
                  onOpenCrossMatch={(pl) => setCrossMatchPlatformId(pl.id)}
                  onOpenApiConfig={(pl) => setApiModalPlatformId(pl.id)}
                />
              )}
              {page === 'reportes' && allowedPages.includes('reportes') && (
                <ReportsView
                  users={state.users}
                  platforms={state.platforms}
                  offboardings={state.offboardings}
                  inconsistencies={state.inconsistencies}
                  auditLogs={state.auditLogs}
                  onPreviewReport={(type) => setPreviewReportType(type)}
                  onNotify={(msg) => showToast(msg)}
                />
              )}
              {page === 'audit' && allowedPages.includes('audit') && (
                <AuditLogView
                  auditLogs={state.auditLogs}
                  canExport={canExportReports}
                  onNotify={(msg) => showToast(msg)}
                />
              )}
              {page === 'asistente' && allowedPages.includes('asistente') && (
                <AssistantView
                  token={session.token}
                  aiConfigured={state.serviceInfo.aiConfigured}
                  onStateReplace={(next) => setState(next)}
                  onNotify={showToast}
                />
              )}
              {page === 'configuracion' && allowedPages.includes('configuracion') && (
                <AdminConfigView
                  authUser={authUser}
                  token={session.token}
                  sysUsers={state.sysUsers}
                  sysRoles={state.sysRoles}
                  settings={state.settings}
                  backups={state.backups}
                  serviceInfo={state.serviceInfo}
                  onMutate={apiMutate}
                  onStateReplace={(next) => setState(next)}
                  onRequestReset={handleRequestReset}
                  onNotify={showToast}
                />
              )}
            </>
          )}
        </main>
      </div>

      {/* Modals */}
      {state && inspectedUser && (
        <UserDetailModal
          user={inspectedUser}
          platforms={state.platforms}
          auditLogs={state.auditLogs}
          apiConfigs={state.apiConfigs}
          canWrite={canEditUsers}
          canAssignAdminRole={canAssignAdminRole}
          onClose={() => setInspectUserId(null)}
          onTogglePlatform={handleTogglePlatform}
          onApiOffboard={canManageBajas ? handleApiOffboard : undefined}
          onUpdateUser={handleUpdateUser}
          onStartOffboarding={(u) => setOffboardModalUser(u)}
        />
      )}

      {state && showNewUserModal && canCreateUsers && (
        <NewUserModal
          platforms={state.platforms}
          canAssignAdminRole={canAssignAdminRole}
          onClose={() => setShowNewUserModal(false)}
          onCreate={handleCreateUser}
        />
      )}

      {state && showBulkImportModal && canCreateUsers && (
        <BulkImportModal
          onClose={() => setShowBulkImportModal(false)}
          onSubmit={handleBulkImportUsers}
        />
      )}

      {state && offboardModalUser !== undefined && canManageBajas && (
        <NewOffboardingModal
          users={state.users}
          preselectedUser={offboardModalUser}
          onClose={() => setOffboardModalUser(undefined)}
          onSubmit={handleStartOffboarding}
        />
      )}

      {platformModalState.open && (canCreatePlatforms || canEditPlatforms) && (
        <PlatformModal
          platform={platformModalState.platform}
          onClose={() => setPlatformModalState({ open: false })}
          onSave={handleSavePlatform}
          onDelete={canEditPlatforms ? handleRequestDeletePlatform : undefined}
        />
      )}

      {state && crossMatchPlatform && (
        <PlatformCrossMatchModal
          platform={crossMatchPlatform}
          imports={state.platformImports}
          users={state.users}
          canImport={canImportPlatforms}
          onClose={() => setCrossMatchPlatformId(null)}
          onRunImport={handleRunPlatformImport}
          onManualLink={handleManualLink}
        />
      )}

      {state && apiModalPlatform && canEditPlatforms && (
        <PlatformApiModal
          platform={apiModalPlatform}
          existingConfig={state.apiConfigs.find((c) => c.platformId === apiModalPlatform.id)}
          syncLogs={state.apiSyncLogs}
          onClose={() => setApiModalPlatformId(null)}
          onSaveApiConfig={handleSaveApiConfig}
          onTestConnection={handleTestApiConnection}
          onForceSync={handleForceApiSync}
        />
      )}

      {state && previewReportType && allowedPages.includes('reportes') && (
        <ReportPreviewModal
          reportType={previewReportType}
          users={state.users}
          platforms={state.platforms}
          offboardings={state.offboardings}
          inconsistencies={state.inconsistencies}
          auditLogs={state.auditLogs}
          onClose={() => setPreviewReportType(null)}
        />
      )}

      {(authUser.mustChangePw || showChangePwModal) && (
        <ChangePasswordModal
          required={authUser.mustChangePw}
          onClose={() => setShowChangePwModal(false)}
          onSubmit={handleChangePassword}
        />
      )}

      {confirmState && (
        <ConfirmModal
          title={confirmState.title}
          message={confirmState.message}
          confirmLabel={confirmState.confirmLabel}
          danger={confirmState.danger}
          onConfirm={confirmState.onConfirm}
          onClose={() => setConfirmState(null)}
        />
      )}

      {/* Toast Notification */}
      {toast && (
        <div
          role="status"
          className={`fixed bottom-5 right-5 z-50 flex items-center gap-2.5 px-4 py-3 rounded-lg shadow-lg border text-xs font-medium no-print ${
            toast.tone === 'error'
              ? 'bg-[#FCEBEB] border-[#A32D2D]/30 text-[#A32D2D]'
              : 'bg-[#141413] border-[#141413] text-white'
          }`}
        >
          {toast.tone === 'error' ? (
            <AlertTriangle className="w-4 h-4 shrink-0" />
          ) : (
            <CheckCircle2 className="w-4 h-4 text-[#7AD7B4] shrink-0" />
          )}
          <span>{toast.message}</span>
        </div>
      )}
    </div>
  );
}
