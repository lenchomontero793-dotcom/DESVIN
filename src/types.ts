export type UserStatus = 'Activo' | 'Inactivo' | 'Pendiente' | 'En proceso de baja';

export type PortalRole = 'IT_ADMIN' | 'RRHH_MANAGER' | 'AUDITOR' | 'USER';

export type PermissionModule =
  | 'usuarios'
  | 'plataformas'
  | 'reportes'
  | 'bajas'
  | 'configuracion'
  | 'audit';

export type PermissionMatrix = '*' | Record<string, Record<string, boolean>>;

export type PlatformStatus = 'Operativo' | 'Mantenimiento' | 'Desconectado' | 'Deshabilitado';

export type PlatformType =
  | 'ERP'
  | 'CRM'
  | 'Productividad'
  | 'RRHH'
  | 'Web'
  | 'Propia'
  | 'BI'
  | 'Seguridad'
  | 'Comunicaciones'
  | 'Otro';

export interface Platform {
  id: string;
  name: string;
  abbr: string;
  colorHex: string;
  type: PlatformType;
  status: PlatformStatus;
  lastSyncAt: string;
  endpoint: string;
  syncMode: 'Automática' | 'Manual' | 'Webhook';
  requiredForActive: boolean;
  colMap?: string;
  notes?: string;
  isDefault?: boolean;
}

export interface PlatformAccount {
  platformId: string;
  username: string;
  role: string;
  status: 'Activo' | 'Suspendido' | 'Pendiente revocar';
  lastAccess: string;
}

export interface User {
  id: string;
  rut: string;
  name: string;
  email: string;
  dept: string;
  position: string;
  manager?: string;
  phone?: string;
  hireDate?: string;
  notes?: string;
  status: UserStatus;
  portalRole: PortalRole;
  accounts: PlatformAccount[];
  lastAccess: string;
  sourceMaster: string;
  updatedAt: string;
}

export interface SysRole {
  id: string;
  name: string;
  description: string;
  permissions: PermissionMatrix;
  isSystem: boolean;
  createdAt: string;
}

export interface SysUser {
  id: string;
  username: string;
  fullName: string;
  email: string;
  roleId: string;
  roleName?: string;
  active: boolean;
  mustChangePw: boolean;
  lastLogin?: string;
  createdAt: string;
}

export interface AuthUser {
  id: string;
  kind: 'sys' | 'directory';
  username?: string;
  name: string;
  email: string;
  rut?: string;
  dept: string;
  position: string;
  status: UserStatus;
  portalRole: PortalRole;
  roleId?: string;
  roleName: string;
  permissions: PermissionMatrix;
  mustChangePw: boolean;
  linkedUserId?: string;
}

export interface AuthSession {
  token: string;
  user: AuthUser;
}

export interface OffboardingRecord {
  id: string;
  userId: string;
  userName: string;
  email: string;
  rut: string;
  dept: string;
  offboardDate: string;
  reason: string;
  notes?: string;
  initiatedBy?: string;
  pendingPlatforms: string[];
  revokedPlatforms: string[];
  status: 'En proceso' | 'Completado';
  completedAt?: string;
}

export interface Inconsistency {
  id: string;
  userId: string;
  userName: string;
  email: string;
  rut: string;
  issue: string;
  platforms: string[];
  priority: 'Alta' | 'Media';
  type: 'BAJA_CON_ACCESO' | 'INACTIVO_CON_ACCESO' | 'FALTA_PLATAFORMA_BASE' | 'SIN_ORIGEN_RRHH';
}

export interface AuditEvent {
  id: string;
  userId?: string;
  action:
    | 'user_created'
    | 'access_granted'
    | 'access_revoked'
    | 'offboarding_started'
    | 'offboarding_completed'
    | 'platform_synced'
    | 'platform_import'
    | 'manual_link'
    | 'api_config'
    | 'api_offboard'
    | 'consolidation'
    | 'inconsistency_alert'
    | 'settings_updated'
    | 'sys_user'
    | 'sys_role'
    | 'backup_restore'
    | 'ai_assistant'
    | 'password_changed'
    | 'auth_login';
  text: string;
  actor: string;
  timestamp: string;
}

export type MatchMethod =
  | 'email'
  | 'email_parcial'
  | 'rut'
  | 'rut_cuenta'
  | 'nombre'
  | 'cuenta_usuario'
  | 'manual'
  | 'api_email'
  | 'api_rut'
  | 'api_nombre';

export interface PlatformImportRow {
  id: string;
  platformId: string;
  rawName: string;
  rawEmail: string;
  rawRut: string;
  rawAccountId: string;
  rawStatus: string;
  rawExtra?: Record<string, string>;
  matchedUserId?: string;
  matchMethod?: MatchMethod;
  matchStatus: 'encontrado' | 'no_encontrado';
  importedAt: string;
}

export type ApiType = 'office365' | 'salesforce' | 'sap' | 'workday' | 'custom';
export type ApiAuthType = 'bearer' | 'basic' | 'apikey' | 'oauth2_cc';

export interface ApiConfig {
  platformId: string;
  apiType: ApiType;
  baseUrl: string;
  authType: ApiAuthType;
  token?: string;
  hasToken?: boolean;
  username?: string;
  password?: string;
  hasPassword?: boolean;
  clientId?: string;
  clientSecret?: string;
  hasClientSecret?: boolean;
  tenantId?: string;
  extraParams: {
    query?: Record<string, string>;
    verifySsl?: boolean;
  };
  fieldMap: Record<string, string>;
  offboardEndpoint: string;
  offboardMethod: 'PATCH' | 'PUT' | 'POST' | 'DELETE';
  offboardPayload: string;
  syncEnabled: boolean;
  syncInterval: number;
  lastSync?: string;
  lastSyncStatus?: 'ok' | 'error';
  lastSyncCount?: number;
  updatedAt?: string;
}

export interface ApiSyncLog {
  id: string;
  platformId: string;
  trigger: 'manual' | 'forzado' | 'automatico' | 'offboard';
  status: 'ok' | 'error';
  recordsTotal: number;
  recordsMatched: number;
  recordsNew: number;
  recordsError: number;
  detail: string;
  createdAt: string;
}

export interface SystemSettings {
  orgName: string;
  syncFrequency: 'Cada hora' | 'Cada 6 horas' | 'Diaria (02:00 AM)' | 'Manual';
  alertEmail: string;
  graceDays: number;
  sessionHours: number;
  schedulerCheckMinutes: number;
  backupRetention: number;
  authMode: 'LDAP / Active Directory' | 'OAuth 2.0' | 'SAML 2.0';
  adminRoles: string;
  autoFlagOffboarding: boolean;
}

export interface BackupRecord {
  name: string;
  size: string;
  sizeBytes: number;
  created: string;
  kind: string;
  version: string;
  note: string;
}

export interface UpdateHistoryEntry {
  id: string;
  kind: string;
  fromVersion: string;
  toVersion: string;
  detail: string;
  appliedBy: string;
  createdAt: string;
}

export interface ServiceInfo {
  version: string;
  schemaVersion: number;
  nodeVersion: string;
  uptimeSeconds: number;
  dbSize: string;
  backupCount: number;
  aiConfigured: boolean;
  updateHistory: UpdateHistoryEntry[];
}

export interface AiProposalChange {
  label: string;
  current: string;
  new: string;
}

export interface AiProposalCard {
  id: string | null;
  action: string;
  title: string;
  reason: string;
  changes: AiProposalChange[];
  warnings: string[];
  errors: string[];
  sensitive: boolean;
  restart: boolean;
  canApply: boolean;
  status?: 'pendiente' | 'aplicando' | 'aplicada' | 'descartada' | 'deshecha' | 'expirada';
  undoable?: boolean;
  appliedAt?: string;
}

export interface AppStateResponse {
  platforms: Platform[];
  users: User[];
  offboardings: OffboardingRecord[];
  auditLogs: AuditEvent[];
  settings: SystemSettings;
  inconsistencies: Inconsistency[];
  sysRoles: SysRole[];
  sysUsers: SysUser[];
  platformImports: PlatformImportRow[];
  apiConfigs: ApiConfig[];
  apiSyncLogs: ApiSyncLog[];
  backups: BackupRecord[];
  serviceInfo: ServiceInfo;
}

export interface ConsolidationRowInput {
  rut?: string;
  name: string;
  email: string;
  dept?: string;
  position?: string;
  status?: string;
  username?: string;
  role?: string;
  reason?: string;
  offboardDate?: string;
}

export interface ConsolidationPreviewItem {
  email: string;
  rut: string;
  name: string;
  dept: string;
  position: string;
  incomingStatus: UserStatus;
  action: 'CREAR_USUARIO' | 'VINCULAR_CUENTA' | 'CONSOLIDAR_BAJA' | 'ACTUALIZAR_ESTADO' | 'SIN_CAMBIOS';
  detail: string;
  existingUserId?: string;
  username: string;
  role: string;
  reason?: string;
  offboardDate?: string;
}

export interface ConsolidationPreviewResponse {
  platformId: string;
  totalRows: number;
  summary: {
    newUsers: number;
    linkedAccounts: number;
    offboardingsDetected: number;
    statusUpdates: number;
    unchanged: number;
  };
  items: ConsolidationPreviewItem[];
}
