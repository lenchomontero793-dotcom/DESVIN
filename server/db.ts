import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type {
  ApiConfig,
  ApiSyncLog,
  AuditEvent,
  AuthUser,
  BackupRecord,
  Inconsistency,
  OffboardingRecord,
  PermissionMatrix,
  Platform,
  PlatformImportRow,
  PortalRole,
  ServiceInfo,
  SysRole,
  SysUser,
  SystemSettings,
  UpdateHistoryEntry,
  User,
  UserStatus,
} from '../src/types.ts';

export const APP_VERSION = '2.0.0';
export const SCHEMA_VERSION = 3;
export const DATA_DIR = path.resolve(process.cwd(), 'data');
export const BACKUP_DIR = path.join(DATA_DIR, 'backups');
export const DB_FILE = path.join(DATA_DIR, 'usersync-db.json');
export const DEFAULT_ADMIN_PASSWORD = 'admin123';

export interface StoredSession {
  token: string;
  userId: string;
  kind: 'sys' | 'directory';
  createdAt: string;
}

export interface StoredApiConfig extends ApiConfig {
  token: string;
  password: string;
  clientSecret: string;
}

export interface StoredAiProposal {
  id: string;
  userId: string;
  action: string;
  params: Record<string, unknown>;
  before: Record<string, unknown>;
  summary: {
    title: string;
    reason: string;
    changes: { label: string; current: string; new: string }[];
    warnings: string[];
    sensitive: boolean;
    restart: boolean;
  };
  status: 'pendiente' | 'aplicando' | 'aplicada' | 'descartada' | 'deshecha' | 'expirada';
  result?: string;
  createdAt: string;
  appliedAt?: string;
}

export interface DatabaseData {
  platforms: Platform[];
  users: User[];
  offboardings: OffboardingRecord[];
  auditLogs: AuditEvent[];
  settings: SystemSettings;
  credentials: Record<string, string>;
  sysRoles: SysRole[];
  sysUsers: SysUser[];
  sysCredentials: Record<string, string>;
  platformImports: PlatformImportRow[];
  apiConfigs: StoredApiConfig[];
  apiSyncLogs: ApiSyncLog[];
  aiProposals: StoredAiProposal[];
  updateHistory: UpdateHistoryEntry[];
  sessions: StoredSession[];
}

export const SERVER_START_MS = Date.now();

export function nowIso(): string {
  return new Date().toISOString();
}

export function minutesAgoIso(mins: number): string {
  return new Date(Date.now() - mins * 60 * 1000).toISOString();
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 2) return false;
  const [salt, keyHex] = parts;
  const keyBuf = Buffer.from(keyHex, 'hex');
  const derivedBuf = crypto.scryptSync(password, salt, 64);
  if (keyBuf.length !== derivedBuf.length) return false;
  return crypto.timingSafeEqual(keyBuf, derivedBuf);
}

export function humanSize(bytes: number): string {
  let n = Number(bytes) || 0;
  for (const unit of ['B', 'KB', 'MB', 'GB']) {
    if (n < 1024 || unit === 'GB') {
      return unit === 'B' ? `${Math.round(n)} ${unit}` : `${n.toFixed(1)} ${unit}`;
    }
    n /= 1024;
  }
  return `${bytes} B`;
}

export function mapRoleNameToPortalRole(role: SysRole | undefined): PortalRole {
  if (!role) return 'AUDITOR';
  if (role.permissions === '*') return 'IT_ADMIN';
  const nameLower = role.name.toLowerCase();
  if (nameLower.includes('rrhh')) return 'RRHH_MANAGER';
  if (nameLower.includes('admin') || nameLower.includes('ti')) return 'IT_ADMIN';
  if (nameLower.includes('analista') || nameLower.includes('audit')) return 'AUDITOR';
  const perms = role.permissions;
  if (perms?.configuracion?.gestionar || perms?.plataformas?.editar) return 'IT_ADMIN';
  if (perms?.usuarios?.crear || perms?.bajas?.gestionar) return 'RRHH_MANAGER';
  return 'AUDITOR';
}

export function toAuthUserFromSys(sysUser: SysUser, roles: SysRole[], users: User[]): AuthUser {
  const role = roles.find((r) => r.id === sysUser.roleId);
  const linkedDir = users.find((u) => u.email.toLowerCase() === sysUser.email.toLowerCase());
  return {
    id: sysUser.id,
    kind: 'sys',
    username: sysUser.username,
    name: sysUser.fullName,
    email: sysUser.email,
    rut: linkedDir?.rut,
    dept: linkedDir?.dept || 'TI / Sistemas',
    position: linkedDir?.position || role?.name || 'Operador del Sistema',
    status: sysUser.active ? 'Activo' : 'Inactivo',
    portalRole: mapRoleNameToPortalRole(role),
    roleId: sysUser.roleId,
    roleName: role?.name || 'Sin rol',
    permissions: role?.permissions || {},
    mustChangePw: sysUser.mustChangePw,
    linkedUserId: linkedDir?.id,
  };
}

export function toAuthUserFromDirectory(user: User, roles: SysRole[]): AuthUser {
  let permissions: PermissionMatrix = {};
  let roleName = 'Colaborador';
  if (user.portalRole === 'IT_ADMIN') {
    permissions = '*';
    roleName = 'Superadmin';
  } else if (user.portalRole === 'RRHH_MANAGER') {
    const rrhh = roles.find((r) => r.id === 'role-rrhh');
    permissions = rrhh?.permissions || {
      usuarios: { ver: true, crear: true, editar: true },
      bajas: { ver: true, gestionar: true },
      reportes: { ver: true, exportar: true },
      plataformas: { ver: true, importar: true },
    };
    roleName = 'Gestor RRHH';
  } else if (user.portalRole === 'AUDITOR') {
    const analista = roles.find((r) => r.id === 'role-analista');
    permissions = analista?.permissions || {
      usuarios: { ver: true },
      plataformas: { ver: true },
      reportes: { ver: true, exportar: true },
      bajas: { ver: true },
      audit: { ver: true },
    };
    roleName = 'Auditor / Analista';
  }

  return {
    id: user.id,
    kind: 'directory',
    name: user.name,
    email: user.email,
    rut: user.rut,
    dept: user.dept,
    position: user.position,
    status: user.status,
    portalRole: user.portalRole,
    roleName,
    permissions,
    mustChangePw: false,
    linkedUserId: user.id,
  };
}

export function hasPerm(authUser: AuthUser | undefined, module: string, action: string): boolean {
  if (!authUser) return false;
  if (authUser.permissions === '*') return true;
  return Boolean(authUser.permissions?.[module]?.[action]);
}

export function buildDefaultRoles(): SysRole[] {
  const created = nowIso();
  return [
    {
      id: 'role-superadmin',
      name: 'Superadmin',
      description: 'Acceso total irrestricto a todos los módulos, APIs, servicio y asistente IA',
      permissions: '*',
      isSystem: true,
      createdAt: created,
    },
    {
      id: 'role-admin',
      name: 'Administrador',
      description: 'Gestión completa de identidades, plataformas, importaciones y bajas',
      permissions: {
        usuarios: { ver: true, crear: true, editar: true, eliminar: true },
        plataformas: { ver: true, crear: true, editar: true, importar: true },
        reportes: { ver: true, exportar: true },
        bajas: { ver: true, gestionar: true },
        audit: { ver: true },
      },
      isSystem: false,
      createdAt: created,
    },
    {
      id: 'role-analista',
      name: 'Analista',
      description: 'Visualización, auditoría de inconsistencias, audit log y exportación de reportes',
      permissions: {
        usuarios: { ver: true },
        plataformas: { ver: true },
        reportes: { ver: true, exportar: true },
        bajas: { ver: true },
        audit: { ver: true },
      },
      isSystem: false,
      createdAt: created,
    },
    {
      id: 'role-rrhh',
      name: 'RRHH',
      description: 'Gestión de altas, directorio maestro, bajas y reportes de nómina',
      permissions: {
        usuarios: { ver: true, crear: true, editar: true },
        plataformas: { ver: true, importar: true },
        bajas: { ver: true, gestionar: true },
        reportes: { ver: true, exportar: true },
      },
      isSystem: false,
      createdAt: created,
    },
  ];
}

export function buildSeedData(): DatabaseData {
  const platforms: Platform[] = [
    {
      id: 'SAP',
      name: 'SAP S/4HANA',
      abbr: 'SAP',
      colorHex: '#1E73BE',
      type: 'ERP',
      status: 'Operativo',
      lastSyncAt: minutesAgoIso(2),
      endpoint: 'https://sap-idm.empresa.local/api/v2/users',
      syncMode: 'Automática',
      requiredForActive: false,
      isDefault: true,
      colMap: 'sap_user,nombre,email,rut,perfil,mandante,grupo,estado',
      notes: 'Sistema ERP corporativo principal (FI/CO/MM/HR)',
    },
    {
      id: 'Salesforce',
      name: 'Salesforce CRM',
      abbr: 'SF',
      colorHex: '#00A1E0',
      type: 'CRM',
      status: 'Operativo',
      lastSyncAt: minutesAgoIso(5),
      endpoint: 'https://empresa.my.salesforce.com/services/data/v59.0',
      syncMode: 'Automática',
      requiredForActive: false,
      isDefault: true,
      colMap: 'sf_username,nombre,email,perfil,rol,licencia,estado,ultimo_acceso',
      notes: 'CRM comercial y gestión de cuentas regionales',
    },
    {
      id: 'Office 365',
      name: 'Office 365',
      abbr: 'O365',
      colorHex: '#D83B01',
      type: 'Productividad',
      status: 'Operativo',
      lastSyncAt: minutesAgoIso(1),
      endpoint: 'https://graph.microsoft.com/v1.0/users',
      syncMode: 'Automática',
      requiredForActive: true,
      isDefault: true,
      colMap: 'upn,nombre,email,licencia,grupo,mfa_activo,estado',
      notes: 'Microsoft Entra ID / Exchange / Teams',
    },
    {
      id: 'HCM',
      name: 'HCM Propio',
      abbr: 'HCM',
      colorHex: '#639922',
      type: 'RRHH',
      status: 'Operativo',
      lastSyncAt: minutesAgoIso(8),
      endpoint: 'https://hcm.empresa.local/api/colaboradores',
      syncMode: 'Automática',
      requiredForActive: true,
      isDefault: true,
      colMap: 'empleado_id,nombre,email,rut,departamento,cargo,fecha_ingreso,estado',
      notes: 'Fuente maestra de RRHH y nómina vigente',
    },
    {
      id: 'ERP Propio',
      name: 'ERP Propio',
      abbr: 'ERP',
      colorHex: '#534AB7',
      type: 'Propia',
      status: 'Operativo',
      lastSyncAt: minutesAgoIso(15),
      endpoint: 'https://erp-interno.empresa.local/api/identidades',
      syncMode: 'Webhook',
      requiredForActive: false,
      isDefault: true,
      colMap: 'usuario,nombre,email,rut,modulo,rol,estado',
      notes: 'Plataforma interna de operaciones e inventario',
    },
    {
      id: 'Portal',
      name: 'Portal Clientes',
      abbr: 'WEB',
      colorHex: '#BA7517',
      type: 'Web',
      status: 'Mantenimiento',
      lastSyncAt: minutesAgoIso(120),
      endpoint: 'https://portal.empresa.com/admin/accounts',
      syncMode: 'Manual',
      requiredForActive: false,
      isDefault: true,
      colMap: 'username,nombre,email,empresa,plan,estado,ultimo_acceso',
      notes: 'Portal de atención B2B y soporte externo',
    },
  ];

  const users: User[] = [
    {
      id: 'u-1',
      rut: '16.482.190-4',
      name: 'Ana García López',
      email: 'a.garcia@empresa.com',
      dept: 'TI',
      position: 'Arquitecta de Sistemas',
      manager: 'Dirección de Tecnología',
      phone: '+56 9 8120 4411',
      hireDate: '2022-03-15',
      notes: 'Administrador técnico SAP y Entra ID',
      status: 'Activo',
      portalRole: 'IT_ADMIN',
      lastAccess: 'Hoy 09:14',
      sourceMaster: 'HCM Propio',
      updatedAt: minutesAgoIso(60),
      accounts: [
        { platformId: 'SAP', username: 'AGARCIA', role: 'Basis Admin', status: 'Activo', lastAccess: 'Hoy 09:10' },
        { platformId: 'Office 365', username: 'a.garcia@empresa.com', role: 'Global Admin', status: 'Activo', lastAccess: 'Hoy 09:14' },
        { platformId: 'HCM', username: '16482190', role: 'Empleado', status: 'Activo', lastAccess: 'Ayer 16:00' },
        { platformId: 'ERP Propio', username: 'agarcia', role: 'Supervisor TI', status: 'Activo', lastAccess: 'Hoy 08:40' },
      ],
    },
    {
      id: 'u-16',
      rut: '17.301.884-2',
      name: 'Carolina Díaz Fuentes',
      email: 'c.diaz@empresa.com',
      dept: 'RRHH',
      position: 'Jefa de Gestión de Personas',
      manager: 'Gerencia General',
      phone: '+56 9 7400 1829',
      hireDate: '2020-08-01',
      notes: 'Responsable de altas y desvinculaciones corporativas',
      status: 'Activo',
      portalRole: 'RRHH_MANAGER',
      lastAccess: 'Hoy 10:15',
      sourceMaster: 'HCM Propio',
      updatedAt: minutesAgoIso(35),
      accounts: [
        { platformId: 'HCM', username: '17301884', role: 'Admin Nómina', status: 'Activo', lastAccess: 'Hoy 10:15' },
        { platformId: 'Office 365', username: 'c.diaz@empresa.com', role: 'E3 User', status: 'Activo', lastAccess: 'Hoy 10:05' },
        { platformId: 'SAP', username: 'CDIAZ', role: 'HR Manager', status: 'Activo', lastAccess: 'Ayer 18:10' },
      ],
    },
    {
      id: 'u-10',
      rut: '17.655.310-9',
      name: 'Javier Herrera',
      email: 'j.herrera@empresa.com',
      dept: 'TI',
      position: 'CISO / Seguridad TI',
      manager: 'Dirección de Tecnología',
      phone: '+56 9 9102 3340',
      hireDate: '2020-09-07',
      notes: 'Revisión periódica de accesos y cumplimiento ISO 27001',
      status: 'Activo',
      portalRole: 'AUDITOR',
      lastAccess: 'Hoy 09:55',
      sourceMaster: 'HCM Propio',
      updatedAt: minutesAgoIso(25),
      accounts: [
        { platformId: 'SAP', username: 'JHERRERA', role: 'Security Auditor', status: 'Activo', lastAccess: 'Hoy 09:55' },
        { platformId: 'Office 365', username: 'j.herrera@empresa.com', role: 'Security Admin', status: 'Activo', lastAccess: 'Hoy 09:50' },
        { platformId: 'HCM', username: '17655310', role: 'Jefatura', status: 'Activo', lastAccess: 'Hoy 08:30' },
        { platformId: 'ERP Propio', username: 'jherrera', role: 'Auditor', status: 'Activo', lastAccess: 'Ayer 16:50' },
        { platformId: 'Salesforce', username: 'j.herrera@empresa.com', role: 'Compliance', status: 'Activo', lastAccess: 'Hace 2 días' },
        { platformId: 'Portal', username: 'j.herrera@empresa.com', role: 'Admin', status: 'Activo', lastAccess: 'Hace 4 días' },
      ],
    },
    {
      id: 'u-2',
      rut: '18.210.445-K',
      name: 'Carlos Mendoza Ríos',
      email: 'c.mendoza@empresa.com',
      dept: 'Ventas',
      position: 'Ejecutivo Comercial Senior',
      manager: 'Gerencia Comercial',
      phone: '+56 9 8765 4321',
      hireDate: '2021-07-01',
      status: 'Activo',
      portalRole: 'USER',
      lastAccess: 'Hoy 08:52',
      sourceMaster: 'HCM Propio',
      updatedAt: minutesAgoIso(90),
      accounts: [
        { platformId: 'Salesforce', username: 'c.mendoza@empresa.com', role: 'Account Exec', status: 'Activo', lastAccess: 'Hoy 08:52' },
        { platformId: 'Office 365', username: 'c.mendoza@empresa.com', role: 'E3 User', status: 'Activo', lastAccess: 'Hoy 08:45' },
        { platformId: 'HCM', username: '18210445', role: 'Empleado', status: 'Activo', lastAccess: 'Hace 4 días' },
      ],
    },
    {
      id: 'u-3',
      rut: '15.903.772-1',
      name: 'María Fernández',
      email: 'm.fernandez@empresa.com',
      dept: 'Finanzas',
      position: 'Contralora Corporativa',
      manager: 'Gerencia de Finanzas',
      phone: '+56 9 6543 2190',
      hireDate: '2020-01-10',
      status: 'Activo',
      portalRole: 'AUDITOR',
      lastAccess: 'Ayer 17:30',
      sourceMaster: 'HCM Propio',
      updatedAt: minutesAgoIso(180),
      accounts: [
        { platformId: 'SAP', username: 'MFERNANDEZ', role: 'FI-CO Approver', status: 'Activo', lastAccess: 'Ayer 17:30' },
        { platformId: 'Office 365', username: 'm.fernandez@empresa.com', role: 'E5 User', status: 'Activo', lastAccess: 'Ayer 17:20' },
        { platformId: 'HCM', username: '15903772', role: 'Jefatura', status: 'Activo', lastAccess: 'Hace 2 días' },
        { platformId: 'ERP Propio', username: 'mfernandez', role: 'Contabilidad', status: 'Activo', lastAccess: 'Ayer 15:10' },
        { platformId: 'Portal', username: 'm.fernandez@empresa.com', role: 'Auditor', status: 'Activo', lastAccess: 'Hace 6 días' },
      ],
    },
    {
      id: 'u-4',
      rut: '17.114.508-2',
      name: 'Roberto Silva',
      email: 'r.silva@empresa.com',
      dept: 'RRHH',
      position: 'Especialista de Nómina',
      manager: 'Carolina Díaz Fuentes',
      hireDate: '2019-05-20',
      status: 'En proceso de baja',
      portalRole: 'USER',
      lastAccess: 'Hace 3 días',
      sourceMaster: 'HCM Propio',
      updatedAt: minutesAgoIso(200),
      accounts: [
        { platformId: 'SAP', username: 'RSILVA', role: 'HR Payroll', status: 'Pendiente revocar', lastAccess: 'Hace 3 días' },
        { platformId: 'Office 365', username: 'r.silva@empresa.com', role: 'E3 User', status: 'Pendiente revocar', lastAccess: 'Hace 3 días' },
        { platformId: 'HCM', username: '17114508', role: 'Analista RRHH', status: 'Suspendido', lastAccess: 'Hace 4 días' },
      ],
    },
    {
      id: 'u-5',
      rut: '19.340.112-8',
      name: 'Claudia Vargas',
      email: 'c.vargas@empresa.com',
      dept: 'Operaciones',
      position: 'Jefa de Logística',
      manager: 'Laura Soto',
      hireDate: '2023-02-14',
      status: 'Activo',
      portalRole: 'USER',
      lastAccess: 'Hoy 10:01',
      sourceMaster: 'HCM Propio',
      updatedAt: minutesAgoIso(45),
      accounts: [
        { platformId: 'SAP', username: 'CVARGAS', role: 'MM-WM Manager', status: 'Activo', lastAccess: 'Hoy 10:01' },
        { platformId: 'Office 365', username: 'c.vargas@empresa.com', role: 'E3 User', status: 'Activo', lastAccess: 'Hoy 09:50' },
        { platformId: 'HCM', username: '19340112', role: 'Jefatura', status: 'Activo', lastAccess: 'Ayer 11:00' },
        { platformId: 'ERP Propio', username: 'cvargas', role: 'Bodega Central', status: 'Activo', lastAccess: 'Hoy 09:30' },
      ],
    },
    {
      id: 'u-6',
      rut: '14.772.309-6',
      name: 'Pedro Ramos',
      email: 'p.ramos@empresa.com',
      dept: 'TI',
      position: 'Consultor Externo',
      manager: 'Ana García López',
      hireDate: '2018-11-03',
      status: 'Inactivo',
      portalRole: 'USER',
      lastAccess: 'Hace 45 días',
      sourceMaster: 'HCM Propio',
      updatedAt: minutesAgoIso(300),
      accounts: [
        { platformId: 'Office 365', username: 'p.ramos@empresa.com', role: 'F3 User', status: 'Activo', lastAccess: 'Hace 45 días' },
        { platformId: 'HCM', username: '14772309', role: 'Externo', status: 'Activo', lastAccess: 'Hace 50 días' },
      ],
    },
    {
      id: 'u-7',
      rut: '20.115.689-0',
      name: 'Sofía Torres',
      email: 's.torres@empresa.com',
      dept: 'Ventas',
      position: 'Coordinadora de Cuentas',
      manager: 'Gerencia Comercial',
      hireDate: '2022-08-22',
      status: 'Activo',
      portalRole: 'USER',
      lastAccess: 'Hoy 11:22',
      sourceMaster: 'HCM Propio',
      updatedAt: minutesAgoIso(30),
      accounts: [
        { platformId: 'Salesforce', username: 's.torres@empresa.com', role: 'Sales Ops', status: 'Activo', lastAccess: 'Hoy 11:22' },
        { platformId: 'Office 365', username: 's.torres@empresa.com', role: 'E3 User', status: 'Activo', lastAccess: 'Hoy 11:10' },
        { platformId: 'HCM', username: '20115689', role: 'Empleado', status: 'Activo', lastAccess: 'Hace 3 días' },
        { platformId: 'Portal', username: 's.torres@empresa.com', role: 'Gestor', status: 'Activo', lastAccess: 'Ayer 16:40' },
      ],
    },
    {
      id: 'u-8',
      rut: '21.094.221-7',
      name: 'Diego Morales',
      email: 'd.morales@empresa.com',
      dept: 'Finanzas',
      position: 'Analista Contable',
      manager: 'María Fernández',
      hireDate: '2024-01-08',
      status: 'Pendiente',
      portalRole: 'USER',
      lastAccess: 'Nunca',
      sourceMaster: 'HCM Propio',
      updatedAt: minutesAgoIso(240),
      accounts: [{ platformId: 'HCM', username: '21094221', role: 'Empleado', status: 'Activo', lastAccess: 'Nunca' }],
    },
    {
      id: 'u-9',
      rut: '16.820.991-5',
      name: 'Laura Soto',
      email: 'l.soto@empresa.com',
      dept: 'Operaciones',
      position: 'Gerente de Operaciones',
      manager: 'Gerencia General',
      hireDate: '2021-04-19',
      status: 'Activo',
      portalRole: 'USER',
      lastAccess: 'Hoy 07:48',
      sourceMaster: 'HCM Propio',
      updatedAt: minutesAgoIso(110),
      accounts: [
        { platformId: 'SAP', username: 'LSOTO', role: 'Director Ops', status: 'Activo', lastAccess: 'Hoy 07:48' },
        { platformId: 'Office 365', username: 'l.soto@empresa.com', role: 'E5 User', status: 'Activo', lastAccess: 'Hoy 07:40' },
        { platformId: 'HCM', username: '16820991', role: 'Gerencia', status: 'Activo', lastAccess: 'Ayer 18:00' },
        { platformId: 'ERP Propio', username: 'lsoto', role: 'Gerencia', status: 'Activo', lastAccess: 'Hoy 07:35' },
        { platformId: 'Salesforce', username: 'l.soto@empresa.com', role: 'Executive View', status: 'Activo', lastAccess: 'Ayer 14:20' },
      ],
    },
    {
      id: 'u-11',
      rut: '18.540.312-1',
      name: 'Ignacio Pérez',
      email: 'i.perez@empresa.com',
      dept: 'Ventas',
      position: 'Ejecutivo Regional',
      manager: 'Gerencia Comercial',
      status: 'En proceso de baja',
      portalRole: 'USER',
      lastAccess: 'Hace 8 días',
      sourceMaster: 'HCM Propio',
      updatedAt: minutesAgoIso(120),
      accounts: [
        { platformId: 'Salesforce', username: 'i.perez@empresa.com', role: 'Sales Rep', status: 'Pendiente revocar', lastAccess: 'Hace 8 días' },
        { platformId: 'ERP Propio', username: 'iperez', role: 'Comercial', status: 'Pendiente revocar', lastAccess: 'Hace 9 días' },
      ],
    },
    {
      id: 'u-12',
      rut: '15.221.840-3',
      name: 'Valentina Cruz',
      email: 'v.cruz@empresa.com',
      dept: 'Finanzas',
      position: 'Analista Tesorería',
      manager: 'María Fernández',
      status: 'En proceso de baja',
      portalRole: 'USER',
      lastAccess: 'Hace 11 días',
      sourceMaster: 'HCM Propio',
      updatedAt: minutesAgoIso(360),
      accounts: [{ platformId: 'SAP', username: 'VCRUZ', role: 'Treasury Analyst', status: 'Pendiente revocar', lastAccess: 'Hace 11 días' }],
    },
    {
      id: 'u-13',
      rut: '19.882.400-K',
      name: 'Felipe Gutiérrez',
      email: 'f.gutierrez@empresa.com',
      dept: 'Operaciones',
      position: 'Analista de Procesos',
      manager: 'Laura Soto',
      status: 'En proceso de baja',
      portalRole: 'USER',
      lastAccess: 'Hace 2 días',
      sourceMaster: 'HCM Propio',
      updatedAt: minutesAgoIso(140),
      accounts: [
        { platformId: 'Office 365', username: 'f.gutierrez@empresa.com', role: 'E3 User', status: 'Pendiente revocar', lastAccess: 'Hace 2 días' },
        { platformId: 'Salesforce', username: 'f.gutierrez@empresa.com', role: 'Read Only', status: 'Pendiente revocar', lastAccess: 'Hace 5 días' },
        { platformId: 'SAP', username: 'FGUTIERREZ', role: 'PM User', status: 'Pendiente revocar', lastAccess: 'Hace 3 días' },
      ],
    },
    {
      id: 'u-14',
      rut: '16.109.420-8',
      name: 'Martín Rojas',
      email: 'm.rojas@empresa.com',
      dept: 'Ventas',
      position: 'Consultor Comercial',
      status: 'Inactivo',
      portalRole: 'USER',
      lastAccess: 'Hace 30 días',
      sourceMaster: 'HCM Propio',
      updatedAt: minutesAgoIso(1440),
      accounts: [],
    },
    {
      id: 'u-15',
      rut: '17.902.118-5',
      name: 'Daniela Muñoz',
      email: 'd.munoz@empresa.com',
      dept: 'Operaciones',
      position: 'Coordinadora de Turno',
      status: 'Inactivo',
      portalRole: 'USER',
      lastAccess: 'Hace 35 días',
      sourceMaster: 'HCM Propio',
      updatedAt: minutesAgoIso(2880),
      accounts: [],
    },
  ];

  const credentials: Record<string, string> = {};

  const sysRoles = buildDefaultRoles();
  const sysUsers: SysUser[] = [
    {
      id: 'su-admin',
      username: 'admin',
      fullName: 'Administrador del Sistema',
      email: 'admin@empresa.com',
      roleId: 'role-superadmin',
      active: true,
      mustChangePw: false,
      lastLogin: minutesAgoIso(15),
      createdAt: minutesAgoIso(4320),
    },
  ];

  const sysCredentials: Record<string, string> = {
    'su-admin': hashPassword(DEFAULT_ADMIN_PASSWORD),
  };

  const offboardings: OffboardingRecord[] = [
    {
      id: 'off-1',
      userId: 'u-4',
      userName: 'Roberto Silva',
      email: 'r.silva@empresa.com',
      rut: '17.114.508-2',
      dept: 'RRHH',
      offboardDate: '2026-11-15',
      reason: 'Renuncia voluntaria',
      initiatedBy: 'c.diaz',
      pendingPlatforms: ['SAP', 'Office 365'],
      revokedPlatforms: ['HCM'],
      status: 'En proceso',
    },
    {
      id: 'off-2',
      userId: 'u-11',
      userName: 'Ignacio Pérez',
      email: 'i.perez@empresa.com',
      rut: '18.540.312-1',
      dept: 'Ventas',
      offboardDate: '2026-11-12',
      reason: 'Término de contrato',
      initiatedBy: 'c.diaz',
      pendingPlatforms: ['Salesforce', 'ERP Propio'],
      revokedPlatforms: ['Office 365', 'HCM'],
      status: 'En proceso',
    },
    {
      id: 'off-3',
      userId: 'u-12',
      userName: 'Valentina Cruz',
      email: 'v.cruz@empresa.com',
      rut: '15.221.840-3',
      dept: 'Finanzas',
      offboardDate: '2026-11-10',
      reason: 'Jubilación',
      initiatedBy: 'admin',
      pendingPlatforms: ['SAP'],
      revokedPlatforms: ['Office 365', 'HCM', 'ERP Propio'],
      status: 'En proceso',
    },
    {
      id: 'off-4',
      userId: 'u-13',
      userName: 'Felipe Gutiérrez',
      email: 'f.gutierrez@empresa.com',
      rut: '19.882.400-K',
      dept: 'Operaciones',
      offboardDate: '2026-11-16',
      reason: 'Renuncia voluntaria',
      initiatedBy: 'c.diaz',
      pendingPlatforms: ['Office 365', 'Salesforce', 'SAP'],
      revokedPlatforms: ['HCM'],
      status: 'En proceso',
    },
    {
      id: 'off-5',
      userId: 'u-14',
      userName: 'Martín Rojas',
      email: 'm.rojas@empresa.com',
      rut: '16.109.420-8',
      dept: 'Ventas',
      offboardDate: '2026-10-28',
      reason: 'Renuncia voluntaria',
      initiatedBy: 'admin',
      pendingPlatforms: [],
      revokedPlatforms: ['Salesforce', 'Office 365', 'HCM'],
      status: 'Completado',
      completedAt: '2026-10-29T11:30:00Z',
    },
    {
      id: 'off-6',
      userId: 'u-15',
      userName: 'Daniela Muñoz',
      email: 'd.munoz@empresa.com',
      rut: '17.902.118-5',
      dept: 'Operaciones',
      offboardDate: '2026-10-20',
      reason: 'Despido',
      initiatedBy: 'admin',
      pendingPlatforms: [],
      revokedPlatforms: ['SAP', 'Office 365', 'HCM', 'ERP Propio'],
      status: 'Completado',
      completedAt: '2026-10-20T18:10:00Z',
    },
  ];

  const auditLogs: AuditEvent[] = [
    {
      id: 'log-1',
      userId: 'u-1',
      action: 'access_granted',
      text: 'Ana García López agregada a ERP Propio',
      actor: 'Sistema / Sync',
      timestamp: minutesAgoIso(55),
    },
    {
      id: 'log-2',
      userId: 'u-11',
      action: 'access_revoked',
      text: 'Ignacio Pérez: acceso Office 365 revocado',
      actor: 'it-admin@empresa.com',
      timestamp: minutesAgoIso(115),
    },
    {
      id: 'log-3',
      action: 'platform_synced',
      text: 'Sincronización SAP S/4HANA completada (16 identidades consolidadas)',
      actor: 'Conector SAP',
      timestamp: minutesAgoIso(135),
    },
    {
      id: 'log-4',
      userId: 'u-6',
      action: 'inconsistency_alert',
      text: 'Inconsistencia detectada: Pedro Ramos (Inactivo con 2 cuentas activas)',
      actor: 'Motor de Auditoría',
      timestamp: minutesAgoIso(190),
    },
    {
      id: 'log-5',
      userId: 'u-8',
      action: 'user_created',
      text: 'Diego Morales creado en directorio maestro desde HCM Propio',
      actor: 'RRHH Sync',
      timestamp: minutesAgoIso(240),
    },
  ];

  const settings: SystemSettings = {
    orgName: 'Mi Empresa S.A.',
    syncFrequency: 'Diaria (02:00 AM)',
    alertEmail: 'it-admin@empresa.com',
    graceDays: 1,
    sessionHours: 8,
    schedulerCheckMinutes: 5,
    backupRetention: 10,
    authMode: 'LDAP / Active Directory',
    adminRoles: 'Superadmin, Administrador, RRHH',
    autoFlagOffboarding: true,
  };

  return {
    platforms,
    users,
    offboardings,
    auditLogs,
    settings,
    credentials,
    sysRoles,
    sysUsers,
    sysCredentials,
    platformImports: [],
    apiConfigs: [],
    apiSyncLogs: [],
    aiProposals: [],
    updateHistory: [
      {
        id: 'upd-init',
        kind: 'instalación',
        fromVersion: '1.6.0',
        toVersion: APP_VERSION,
        detail: 'Esquema inicializado con RBAC granular, motor de cruce 6 niveles, APIs y Asistente IA',
        appliedBy: 'Sistema',
        createdAt: nowIso(),
      },
    ],
    sessions: [],
  };
}

export function migrateDb(db: DatabaseData): boolean {
  let dirty = false;
  if (!db.credentials || typeof db.credentials !== 'object') {
    db.credentials = {};
    dirty = true;
  }
  if (!Array.isArray(db.sessions)) {
    db.sessions = [];
    dirty = true;
  }
  for (const s of db.sessions) {
    if (!s.kind) {
      s.kind = 'directory';
      dirty = true;
    }
  }

  if (!Array.isArray(db.sysRoles) || db.sysRoles.length === 0) {
    db.sysRoles = buildDefaultRoles();
    dirty = true;
  }
  if (!db.sysCredentials || typeof db.sysCredentials !== 'object') {
    db.sysCredentials = {};
    dirty = true;
  }
  if (!Array.isArray(db.sysUsers) || db.sysUsers.length === 0) {
    db.sysUsers = [
      {
        id: 'su-admin',
        username: 'admin',
        fullName: 'Administrador del Sistema',
        email: 'admin@empresa.com',
        roleId: 'role-superadmin',
        active: true,
        mustChangePw: false,
        createdAt: nowIso(),
      },
    ];
    db.sysCredentials['su-admin'] = hashPassword(DEFAULT_ADMIN_PASSWORD);
    dirty = true;
  }

  if (!Array.isArray(db.platformImports)) {
    db.platformImports = [];
    dirty = true;
  }
  if (!Array.isArray(db.apiConfigs)) {
    db.apiConfigs = [];
    dirty = true;
  }
  if (!Array.isArray(db.apiSyncLogs)) {
    db.apiSyncLogs = [];
    dirty = true;
  }
  if (!Array.isArray(db.aiProposals)) {
    db.aiProposals = [];
    dirty = true;
  }
  if (!Array.isArray(db.updateHistory)) {
    db.updateHistory = [
      {
        id: 'upd-migrated',
        kind: 'migración',
        fromVersion: '1.6.0',
        toVersion: APP_VERSION,
        detail: `Esquema actualizado automáticamente a v${SCHEMA_VERSION}`,
        appliedBy: 'Sistema',
        createdAt: nowIso(),
      },
    ];
    dirty = true;
  }

  // Ensure new SystemSettings fields
  const defaultSettings: SystemSettings = {
    orgName: 'Mi Empresa S.A.',
    syncFrequency: 'Diaria (02:00 AM)',
    alertEmail: 'it-admin@empresa.com',
    graceDays: 1,
    sessionHours: 8,
    schedulerCheckMinutes: 5,
    backupRetention: 10,
    authMode: 'LDAP / Active Directory',
    adminRoles: 'Superadmin, Administrador, RRHH',
    autoFlagOffboarding: true,
  };
  for (const [k, v] of Object.entries(defaultSettings)) {
    if ((db.settings as unknown as Record<string, unknown>)[k] === undefined) {
      (db.settings as unknown as Record<string, unknown>)[k] = v;
      dirty = true;
    }
  }

  const defaultPlatIds = new Set(['SAP', 'Salesforce', 'Office 365', 'HCM', 'ERP Propio', 'Portal']);
  for (const p of db.platforms) {
    if (p.isDefault === undefined && defaultPlatIds.has(p.id)) {
      p.isDefault = true;
      dirty = true;
    }
  }

  for (const u of db.users) {
    if (!u.portalRole) {
      u.portalRole = 'USER';
      dirty = true;
    }
  }
  const adminSu = db.sysUsers.find((su) => su.username.toLowerCase() === 'admin');
  if (adminSu && !db.sysCredentials[adminSu.id]) {
    db.sysCredentials[adminSu.id] = hashPassword(DEFAULT_ADMIN_PASSWORD);
    dirty = true;
  }

  return dirty;
}

export function ensureDirs(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

export function readDb(): DatabaseData {
  ensureDirs();
  if (!fs.existsSync(DB_FILE)) {
    const seed = buildSeedData();
    fs.writeFileSync(DB_FILE, JSON.stringify(seed, null, 2), 'utf-8');
    return seed;
  }
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as DatabaseData;
    if (migrateDb(parsed)) {
      fs.writeFileSync(DB_FILE, JSON.stringify(parsed, null, 2), 'utf-8');
    }
    return parsed;
  } catch {
    const seed = buildSeedData();
    fs.writeFileSync(DB_FILE, JSON.stringify(seed, null, 2), 'utf-8');
    return seed;
  }
}

export function writeDb(data: DatabaseData): void {
  ensureDirs();
  const tmp = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, DB_FILE);
}

export function addAudit(
  db: DatabaseData,
  action: AuditEvent['action'],
  text: string,
  actor = 'Sistema',
  userId?: string,
): void {
  const entry: AuditEvent = {
    id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    userId,
    action,
    text,
    actor,
    timestamp: nowIso(),
  };
  db.auditLogs = [entry, ...db.auditLogs].slice(0, 300);
}

export function computeInconsistencies(db: DatabaseData): Inconsistency[] {
  const list: Inconsistency[] = [];
  const requiredPlatformIds = db.platforms.filter((p) => p.requiredForActive).map((p) => p.id);

  for (const user of db.users) {
    const activeAccounts = user.accounts.filter((a) => a.status === 'Activo' || a.status === 'Pendiente revocar');

    if (user.status === 'En proceso de baja' && activeAccounts.length > 0) {
      list.push({
        id: `inc-baja-${user.id}`,
        userId: user.id,
        userName: user.name,
        email: user.email,
        rut: user.rut,
        issue: `Accesos activos/pendientes tras inicio de baja (${activeAccounts.length} plataformas)`,
        platforms: activeAccounts.map((a) => a.platformId),
        priority: 'Alta',
        type: 'BAJA_CON_ACCESO',
      });
      continue;
    }

    if (user.status === 'Inactivo' && activeAccounts.length > 0) {
      list.push({
        id: `inc-inact-${user.id}`,
        userId: user.id,
        userName: user.name,
        email: user.email,
        rut: user.rut,
        issue: `Usuario inactivo con cuentas aún activas en ${activeAccounts.length} plataforma(s)`,
        platforms: activeAccounts.map((a) => a.platformId),
        priority: 'Alta',
        type: 'INACTIVO_CON_ACCESO',
      });
      continue;
    }

    if (user.status === 'Activo' || user.status === 'Pendiente') {
      const userPlatformIds = new Set(user.accounts.filter((a) => a.status === 'Activo').map((a) => a.platformId));
      const missingRequired = requiredPlatformIds.filter((reqId) => !userPlatformIds.has(reqId));
      if (missingRequired.length > 0) {
        list.push({
          id: `inc-missing-${user.id}`,
          userId: user.id,
          userName: user.name,
          email: user.email,
          rut: user.rut,
          issue: `Sin acceso a plataformas corporativas obligatorias (${missingRequired.join(', ')})`,
          platforms: Array.from(userPlatformIds),
          priority: 'Media',
          type: 'FALTA_PLATAFORMA_BASE',
        });
      }
      if (!userPlatformIds.has('HCM') && user.accounts.length > 0) {
        list.push({
          id: `inc-nohcm-${user.id}`,
          userId: user.id,
          userName: user.name,
          email: user.email,
          rut: user.rut,
          issue: 'Cuenta activa en sistemas sin ficha vigente en HCM Propio (cuenta huérfana)',
          platforms: Array.from(userPlatformIds),
          priority: 'Alta',
          type: 'SIN_ORIGEN_RRHH',
        });
      }
    }
  }

  return list;
}

export function sanitizeApiConfig(cfg: StoredApiConfig): ApiConfig {
  return {
    platformId: cfg.platformId,
    apiType: cfg.apiType,
    baseUrl: cfg.baseUrl,
    authType: cfg.authType,
    token: '',
    hasToken: Boolean(cfg.token),
    username: cfg.username || '',
    password: '',
    hasPassword: Boolean(cfg.password),
    clientId: cfg.clientId || '',
    clientSecret: '',
    hasClientSecret: Boolean(cfg.clientSecret),
    tenantId: cfg.tenantId || '',
    extraParams: cfg.extraParams || { query: {}, verifySsl: true },
    fieldMap: cfg.fieldMap || {},
    offboardEndpoint: cfg.offboardEndpoint || '',
    offboardMethod: cfg.offboardMethod || 'PATCH',
    offboardPayload: cfg.offboardPayload || '',
    syncEnabled: Boolean(cfg.syncEnabled),
    syncInterval: cfg.syncInterval || 24,
    lastSync: cfg.lastSync,
    lastSyncStatus: cfg.lastSyncStatus,
    lastSyncCount: cfg.lastSyncCount,
    updatedAt: cfg.updatedAt,
  };
}

/* ── Backup Engine ─────────────────────────────────────────────────────── */

export function listBackups(): BackupRecord[] {
  ensureDirs();
  const files = fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const full = path.join(BACKUP_DIR, f);
      const stat = fs.statSync(full);
      let meta: { created?: string; kind?: string; version?: string; note?: string } = {};
      try {
        const parsed = JSON.parse(fs.readFileSync(full, 'utf-8')) as {
          backupInfo?: { created?: string; kind?: string; version?: string; note?: string };
        };
        meta = parsed.backupInfo || {};
      } catch {
        // ignore corrupt meta
      }
      return {
        name: f,
        mtimeMs: stat.mtimeMs,
        sizeBytes: stat.size,
        size: humanSize(stat.size),
        created: meta.created || new Date(stat.mtimeMs).toISOString(),
        kind: meta.kind || 'manual',
        version: meta.version || APP_VERSION,
        note: meta.note || '',
      };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  return files.map(({ mtimeMs: _m, ...rest }) => rest);
}

export function pruneBackups(retention: number): void {
  ensureDirs();
  const keep = Math.max(3, retention || 10);
  const all = listBackups();
  for (const old of all.slice(keep)) {
    try {
      fs.unlinkSync(path.join(BACKUP_DIR, old.name));
    } catch {
      // ignore
    }
  }
}

export function makeBackup(db: DatabaseData, kind = 'manual', note = ''): string {
  ensureDirs();
  const cleanKind = kind.toLowerCase().replace(/[^a-z-]/g, '') || 'manual';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  let filename = `${stamp}_${cleanKind}_v${APP_VERSION}.json`;
  let idx = 2;
  while (fs.existsSync(path.join(BACKUP_DIR, filename))) {
    filename = `${stamp}_${cleanKind}_v${APP_VERSION}-${idx}.json`;
    idx++;
  }

  // Strip active tokens/sessions and raw secrets from config snapshot
  const snapshotDb: DatabaseData = {
    ...db,
    sessions: [],
    apiConfigs: db.apiConfigs.map((c) => ({
      ...c,
      token: '',
      password: '',
      clientSecret: '',
    })),
  };

  const payload = {
    backupInfo: {
      created: nowIso(),
      kind: cleanKind,
      version: APP_VERSION,
      schemaVersion: SCHEMA_VERSION,
      note: (note || '').slice(0, 120),
    },
    data: snapshotDb,
  };

  fs.writeFileSync(path.join(BACKUP_DIR, filename), JSON.stringify(payload, null, 2), 'utf-8');
  pruneBackups(db.settings.backupRetention);
  return filename;
}

export function validateBackupFilename(fname: string): string {
  if (!/^[A-Za-z0-9_.\-]+\.json$/.test(fname || '')) {
    throw new Error('Nombre de respaldo inválido.');
  }
  const full = path.join(BACKUP_DIR, fname);
  if (!fs.existsSync(full)) {
    throw new Error('El respaldo solicitado no existe.');
  }
  return full;
}

export function restoreBackup(
  db: DatabaseData,
  fname: string,
  what: 'db' | 'config' | 'all',
  actor: string,
): { safetyBackup: string } {
  const full = validateBackupFilename(fname);
  const parsed = JSON.parse(fs.readFileSync(full, 'utf-8')) as {
    backupInfo?: unknown;
    data?: DatabaseData;
  };
  if (!parsed.data || !Array.isArray(parsed.data.users)) {
    throw new Error('El archivo de respaldo está dañado o no contiene datos válidos de UserSync.');
  }

  const safetyBackup = makeBackup(db, 'pre-restauracion', `Antes de restaurar ${fname}`);
  const preservedHistory = [...db.updateHistory];
  const preservedSessions = [...db.sessions];
  const preservedApiConfigs = [...db.apiConfigs];

  if (what === 'db' || what === 'all') {
    db.platforms = parsed.data.platforms || db.platforms;
    db.users = parsed.data.users || db.users;
    db.offboardings = parsed.data.offboardings || [];
    db.auditLogs = parsed.data.auditLogs || [];
    db.sysRoles = parsed.data.sysRoles || db.sysRoles;
    db.sysUsers = parsed.data.sysUsers || db.sysUsers;
    db.credentials = parsed.data.credentials || db.credentials;
    db.sysCredentials = parsed.data.sysCredentials || db.sysCredentials;
    db.platformImports = parsed.data.platformImports || [];
    db.apiSyncLogs = parsed.data.apiSyncLogs || [];
    // Restore API configs structure while preserving existing secrets if platform matches
    if (Array.isArray(parsed.data.apiConfigs)) {
      db.apiConfigs = parsed.data.apiConfigs.map((c) => {
        const prev = preservedApiConfigs.find((p) => p.platformId === c.platformId);
        return {
          ...c,
          token: prev?.token || '',
          password: prev?.password || '',
          clientSecret: prev?.clientSecret || '',
        };
      });
    }
  }

  if (what === 'config' || what === 'all') {
    if (parsed.data.settings) {
      db.settings = { ...db.settings, ...parsed.data.settings };
    }
  }

  migrateDb(db);
  db.sessions = preservedSessions;
  db.updateHistory = [
    {
      id: `upd-${Date.now()}`,
      kind: 'restauración',
      fromVersion: APP_VERSION,
      toVersion: APP_VERSION,
      detail: `${what === 'db' ? 'Datos' : what === 'config' ? 'Configuración' : 'Todo'} restaurado desde ${fname}`,
      appliedBy: actor,
      createdAt: nowIso(),
    },
    ...preservedHistory,
  ].slice(0, 50);

  addAudit(db, 'backup_restore', `Restauración (${what}) desde respaldo ${fname}`, actor);
  writeDb(db);
  return { safetyBackup };
}

export function getServiceInfo(db: DatabaseData): ServiceInfo {
  const backups = listBackups();
  let dbBytes = 0;
  try {
    dbBytes = fs.statSync(DB_FILE).size;
  } catch {
    dbBytes = 0;
  }
  return {
    version: APP_VERSION,
    schemaVersion: SCHEMA_VERSION,
    nodeVersion: process.version,
    uptimeSeconds: Math.floor((Date.now() - SERVER_START_MS) / 1000),
    dbSize: humanSize(dbBytes),
    backupCount: backups.length,
    aiConfigured: Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim()),
    updateHistory: db.updateHistory.slice(0, 20),
  };
}

export function getStateForAuth(db: DatabaseData, authUser: AuthUser) {
  if (authUser.kind === 'directory' && authUser.portalRole === 'USER') {
    const selfUser = db.users.find((u) => u.id === authUser.id);
    const selfOffboardings = db.offboardings.filter((o) => o.userId === authUser.id);
    return {
      platforms: db.platforms,
      users: selfUser ? [selfUser] : [],
      offboardings: selfOffboardings,
      auditLogs: [],
      settings: db.settings,
      inconsistencies: [],
      sysRoles: [],
      sysUsers: [],
      platformImports: [],
      apiConfigs: [],
      apiSyncLogs: [],
      backups: [],
      serviceInfo: {
        version: APP_VERSION,
        schemaVersion: SCHEMA_VERSION,
        nodeVersion: process.version,
        uptimeSeconds: 0,
        dbSize: '—',
        backupCount: 0,
        aiConfigured: false,
        updateHistory: [],
      },
    };
  }

  const canAudit = hasPerm(authUser, 'audit', 'ver');
  const canSys = hasPerm(authUser, 'configuracion', 'ver') || hasPerm(authUser, 'configuracion', 'gestionar');
  const canService = hasPerm(authUser, 'configuracion', 'servicio');
  const canPlatforms = hasPerm(authUser, 'plataformas', 'ver');

  const roleMap = new Map(db.sysRoles.map((r) => [r.id, r.name]));

  return {
    platforms: db.platforms,
    users: db.users,
    offboardings: db.offboardings,
    auditLogs: canAudit ? db.auditLogs : db.auditLogs.slice(0, 15),
    settings: db.settings,
    inconsistencies: computeInconsistencies(db),
    sysRoles: canSys ? db.sysRoles : [],
    sysUsers: canSys
      ? db.sysUsers.map((su) => ({ ...su, roleName: roleMap.get(su.roleId) || '—' }))
      : [],
    platformImports: canPlatforms ? db.platformImports : [],
    apiConfigs: canPlatforms ? db.apiConfigs.map(sanitizeApiConfig) : [],
    apiSyncLogs: canPlatforms ? db.apiSyncLogs.slice(0, 80) : [],
    backups: canService ? listBackups() : [],
    serviceInfo: getServiceInfo(db),
  };
}

export function normalizeStatus(raw?: string): UserStatus {
  const val = (raw || '').trim().toLowerCase();
  if (val.includes('baja') || val.includes('desvinc') || val.includes('offboard') || val.includes('termino')) {
    return 'En proceso de baja';
  }
  if (val.includes('inactivo') || val.includes('inactive') || val.includes('disabled') || val === '0' || val === 'false') {
    return 'Inactivo';
  }
  if (val.includes('pendiente') || val.includes('pending')) {
    return 'Pendiente';
  }
  return 'Activo';
}

export function buildUsername(email: string, platformId: string): string {
  const local = email.split('@')[0] || 'usuario';
  if (platformId === 'SAP') {
    return local.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 12);
  }
  if (platformId === 'ERP Propio') {
    return local.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  }
  return email.toLowerCase();
}
