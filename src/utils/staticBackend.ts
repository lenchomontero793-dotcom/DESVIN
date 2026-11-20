import type {
  ApiConfig,
  ApiSyncLog,
  AppStateResponse,
  AuditEvent,
  AuthUser,
  BackupRecord,
  ConsolidationPreviewItem,
  ConsolidationPreviewResponse,
  ConsolidationRowInput,
  Inconsistency,
  MatchMethod,
  OffboardingRecord,
  PermissionMatrix,
  Platform,
  PlatformAccount,
  PlatformImportRow,
  PortalRole,
  ServiceInfo,
  SysRole,
  SysUser,
  SystemSettings,
  UpdateHistoryEntry,
  User,
  UserStatus,
} from '../types';

const APP_VERSION = '2.0.0';
const SCHEMA_VERSION = 3;
const STATIC_DB_KEY = 'usersync_static_db_v1';
const STATIC_BACKUPS_KEY = 'usersync_static_backups_v1';
const DEFAULT_ADMIN_PASSWORD = 'admin123';
const SESSION_START_MS = Date.now();

interface StoredSession {
  token: string;
  userId: string;
  kind: 'sys' | 'directory';
  createdAt: string;
}

interface StoredApiConfig extends ApiConfig {
  token: string;
  password: string;
  clientSecret: string;
}

interface StaticDatabaseData {
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
  updateHistory: UpdateHistoryEntry[];
  sessions: StoredSession[];
}

interface StoredBackupEntry {
  record: BackupRecord;
  payload: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function minutesAgoIso(mins: number): string {
  return new Date(Date.now() - mins * 60 * 1000).toISOString();
}

function hashStaticPassword(pw: string): string {
  // Deterministic salted obfuscation in browser static mode (no Node crypto available)
  const salt = Math.random().toString(36).slice(2, 10);
  const raw = `${salt}:${pw}`;
  let h = 2166136261;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `static$${salt}$${(h >>> 0).toString(16)}`;
}

function verifyStaticPassword(pw: string, stored: string): boolean {
  if (!stored) return false;
  if (stored.startsWith('static$')) {
    const [, salt, expected] = stored.split('$');
    const raw = `${salt}:${pw}`;
    let h = 2166136261;
    for (let i = 0; i < raw.length; i++) {
      h ^= raw.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16) === expected;
  }
  return stored === pw;
}

function humanSize(bytes: number): string {
  let n = Number(bytes) || 0;
  for (const unit of ['B', 'KB', 'MB', 'GB']) {
    if (n < 1024 || unit === 'GB') {
      return unit === 'B' ? `${Math.round(n)} ${unit}` : `${n.toFixed(1)} ${unit}`;
    }
    n /= 1024;
  }
  return `${bytes} B`;
}

function hasPerm(authUser: AuthUser | undefined, module: string, action: string): boolean {
  if (!authUser) return false;
  if (authUser.permissions === '*') return true;
  return Boolean(authUser.permissions?.[module]?.[action]);
}

function mapRoleNameToPortalRole(role: SysRole | undefined): PortalRole {
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

function toAuthUserFromSys(sysUser: SysUser, roles: SysRole[], users: User[]): AuthUser {
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

function toAuthUserFromDirectory(user: User, roles: SysRole[]): AuthUser {
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

function buildDefaultRoles(): SysRole[] {
  const created = nowIso();
  return [
    {
      id: 'role-superadmin',
      name: 'Superadmin',
      description: 'Acceso total irrestricto a todos los módulos, APIs, servicio y configuración',
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

function buildSeedData(): StaticDatabaseData {
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
    'su-admin': hashStaticPassword(DEFAULT_ADMIN_PASSWORD),
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
      initiatedBy: 'admin',
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
      initiatedBy: 'admin',
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
      initiatedBy: 'admin',
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
    credentials: {},
    sysRoles,
    sysUsers,
    sysCredentials,
    platformImports: [],
    apiConfigs: [],
    apiSyncLogs: [],
    updateHistory: [
      {
        id: 'upd-init',
        kind: 'instalación',
        fromVersion: '1.6.0',
        toVersion: APP_VERSION,
        detail: 'Modo estático en navegador inicializado (sin servidor Node.js)',
        appliedBy: 'Sistema',
        createdAt: nowIso(),
      },
    ],
    sessions: [],
  };
}

function readDb(): StaticDatabaseData {
  try {
    const raw = localStorage.getItem(STATIC_DB_KEY);
    if (raw) {
      return JSON.parse(raw) as StaticDatabaseData;
    }
  } catch {
    // ignore corrupted localStorage and reseed
  }
  const seed = buildSeedData();
  localStorage.setItem(STATIC_DB_KEY, JSON.stringify(seed));
  return seed;
}

function writeDb(db: StaticDatabaseData): void {
  localStorage.setItem(STATIC_DB_KEY, JSON.stringify(db));
}

function readBackups(): StoredBackupEntry[] {
  try {
    const raw = localStorage.getItem(STATIC_BACKUPS_KEY);
    return raw ? (JSON.parse(raw) as StoredBackupEntry[]) : [];
  } catch {
    return [];
  }
}

function writeBackups(entries: StoredBackupEntry[]): void {
  localStorage.setItem(STATIC_BACKUPS_KEY, JSON.stringify(entries));
}

function makeBackup(db: StaticDatabaseData, kind = 'manual', note = ''): string {
  const cleanKind = kind.toLowerCase().replace(/[^a-z-]/g, '') || 'manual';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const existing = readBackups();
  let filename = `${stamp}_${cleanKind}_v${APP_VERSION}.json`;
  let idx = 2;
  while (existing.some((b) => b.record.name === filename)) {
    filename = `${stamp}_${cleanKind}_v${APP_VERSION}-${idx}.json`;
    idx++;
  }

  const snapshotDb: StaticDatabaseData = {
    ...db,
    sessions: [],
    apiConfigs: db.apiConfigs.map((c) => ({ ...c, token: '', password: '', clientSecret: '' })),
  };
  const payload = JSON.stringify(
    {
      backupInfo: {
        created: nowIso(),
        kind: cleanKind,
        version: APP_VERSION,
        schemaVersion: SCHEMA_VERSION,
        note: (note || '').slice(0, 120),
      },
      data: snapshotDb,
    },
    null,
    2,
  );
  const bytes = new Blob([payload]).size;
  const entry: StoredBackupEntry = {
    record: {
      name: filename,
      sizeBytes: bytes,
      size: humanSize(bytes),
      created: nowIso(),
      kind: cleanKind,
      version: APP_VERSION,
      note: (note || '').slice(0, 120),
    },
    payload,
  };
  const keep = Math.max(3, db.settings.backupRetention || 10);
  writeBackups([entry, ...existing].slice(0, keep));
  return filename;
}

function addAudit(
  db: StaticDatabaseData,
  action: AuditEvent['action'],
  text: string,
  actor: string,
  userId?: string,
): void {
  db.auditLogs.unshift({
    id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    userId,
    action,
    text,
    actor,
    timestamp: nowIso(),
  });
  if (db.auditLogs.length > 500) db.auditLogs = db.auditLogs.slice(0, 500);
}

function computeInconsistencies(db: StaticDatabaseData): Inconsistency[] {
  const list: Inconsistency[] = [];
  const requiredPlatformIds = db.platforms.filter((p) => p.requiredForActive).map((p) => p.id);

  for (const user of db.users) {
    const activeAccounts = user.accounts;
    const pendingAccounts = user.accounts.filter((a) => a.status === 'Pendiente revocar');

    if (user.status === 'Inactivo' && activeAccounts.length > 0) {
      list.push({
        id: `inc-ghost-${user.id}`,
        userId: user.id,
        userName: user.name,
        email: user.email,
        rut: user.rut,
        issue: `Usuario Inactivo mantiene ${activeAccounts.length} cuenta(s) activa(s) sin revocar`,
        platforms: activeAccounts.map((a) => a.platformId),
        priority: 'Alta',
        type: 'INACTIVO_CON_ACCESO',
      });
    }

    if (user.status === 'En proceso de baja' && (pendingAccounts.length > 0 || activeAccounts.length > 0)) {
      const platList = (pendingAccounts.length > 0 ? pendingAccounts : activeAccounts).map((a) => a.platformId);
      list.push({
        id: `inc-off-${user.id}`,
        userId: user.id,
        userName: user.name,
        email: user.email,
        rut: user.rut,
        issue: `Desvinculación pendiente de revocación en ${platList.length} plataforma(s)`,
        platforms: platList,
        priority: 'Alta',
        type: 'BAJA_CON_ACCESO',
      });
    }

    if (user.status === 'Activo') {
      const userPlatformIds = new Set(activeAccounts.map((a) => a.platformId));
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

function sanitizeApiConfig(cfg: StoredApiConfig): ApiConfig {
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

function getServiceInfo(db: StaticDatabaseData): ServiceInfo {
  const backups = readBackups();
  const dbBytes = new Blob([localStorage.getItem(STATIC_DB_KEY) || '']).size;
  return {
    version: APP_VERSION,
    schemaVersion: SCHEMA_VERSION,
    nodeVersion: 'Navegador (Modo Estático)',
    uptimeSeconds: Math.floor((Date.now() - SESSION_START_MS) / 1000),
    dbSize: humanSize(dbBytes),
    backupCount: backups.length,
    aiConfigured: false,
    updateHistory: db.updateHistory.slice(0, 20),
  };
}

function getStateForAuth(db: StaticDatabaseData, authUser: AuthUser): AppStateResponse {
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
        nodeVersion: 'Navegador (Modo Estático)',
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
    backups: canService ? readBackups().map((b) => b.record) : [],
    serviceInfo: getServiceInfo(db),
  };
}

function normalizeStatus(raw?: string): UserStatus {
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

function buildUsername(email: string, platformId: string): string {
  const local = email.split('@')[0] || 'usuario';
  if (platformId === 'SAP') {
    return local.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 12);
  }
  if (platformId === 'ERP Propio') {
    return local.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  }
  return email.toLowerCase();
}

function normStr(s: string): string {
  if (!s) return '';
  return s
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ñ/g, 'n')
    .replace(/\s+/g, ' ');
}

function normRut(s: string): string {
  if (!s) return '';
  return s.toLowerCase().replace(/[.\-\s]/g, '').trim();
}

function normEmail(s: string): string {
  return (s || '').toLowerCase().trim();
}

function splitNameVariants(fullName: string): string[] {
  const s = normStr(fullName);
  if (!s) return [];
  const parts = s.split(' ').filter(Boolean);
  const variants = new Set<string>([s]);
  if (parts.length >= 2) {
    variants.add(parts.slice(0, 2).join(' '));
    variants.add([parts[parts.length - 1], ...parts.slice(0, -1)].join(' '));
    if (parts.length >= 3) {
      variants.add(`${parts[0]} ${parts[parts.length - 1]}`);
    }
  }
  return Array.from(variants);
}

function runPlatformCrossImport(
  db: StaticDatabaseData,
  platform: Platform,
  rows: Record<string, string>[],
  mode: 'reemplazar' | 'agregar',
  actor: string,
): { total: number; matched: number; unmatched: number } {
  const byEmail = new Map<string, string>();
  const byEmailLocal = new Map<string, string>();
  const byRut = new Map<string, string>();
  const byName = new Map<string, string>();

  for (const u of db.users) {
    if (u.email) {
      const em = normEmail(u.email);
      byEmail.set(em, u.id);
      const local = em.split('@')[0];
      if (local && local.length > 3) {
        byEmailLocal.set(local, u.id);
        const flat = local.replace(/[._-]/g, '');
        if (flat.length > 3) byEmailLocal.set(flat, u.id);
      }
    }
    if (u.rut) {
      const rn = normRut(u.rut);
      if (rn.length > 3) byRut.set(rn, u.id);
    }
    if (u.name) {
      for (const v of splitNameVariants(u.name)) byName.set(v, u.id);
    }
  }

  const colEmail = new Set(['email', 'correo', 'mail', 'correo_electronico', 'correo electronico', 'e-mail', 'upn', 'user principal name', 'username', 'login', 'usuario', 'sf_username']);
  const colName = new Set(['nombre', 'nombre completo', 'full_name', 'name', 'display name', 'displayname', 'nombre_completo', 'nombres', 'fullname']);
  const colRut = new Set(['rut', 'rut/dni', 'dni', 'cedula', 'rut_dni', 'employee id', 'employeeid', 'empleado_id', 'sap_user', 'id_empleado']);
  const colAccount = new Set(['account', 'cuenta', 'account_id', 'sap_id', 'sf_id', 'o365_id', 'codigo', 'code', 'user_id', 'userid', 'id']);
  const colStatus = new Set(['estado', 'status', 'activo', 'active', 'habilitado', 'enabled', 'state']);

  if (platform.colMap) {
    for (const rawCol of platform.colMap.split(',')) {
      const col = normStr(rawCol);
      if (!col) continue;
      if (/mail|correo|login|upn/.test(col)) colEmail.add(col);
      else if (/nombre|name|display/.test(col)) colName.add(col);
      else if (/rut|dni|cedula|empleado|employee/.test(col)) colRut.add(col);
      else if (/estado|status|activo|active/.test(col)) colStatus.add(col);
      else colAccount.add(col);
    }
  }

  const pick = (row: Record<string, string>, cands: Set<string>): string => {
    const normCands = new Set(Array.from(cands).map((c) => normStr(c)));
    for (const [k, v] of Object.entries(row)) {
      if (normCands.has(normStr(k))) return String(v ?? '').trim();
    }
    return '';
  };

  if (mode === 'reemplazar') {
    db.platformImports = db.platformImports.filter((pi) => pi.platformId !== platform.id);
  }

  let matchedCount = 0;
  let unmatchedCount = 0;
  const createdRows: PlatformImportRow[] = [];

  for (const row of rows) {
    const rawEmail = pick(row, colEmail);
    const rawName = pick(row, colName);
    const rawRut = pick(row, colRut);
    const rawAccount = pick(row, colAccount);
    const rawStatus = pick(row, colStatus) || 'Activo';
    if (!rawEmail && !rawName && !rawRut && !rawAccount) continue;

    let userId: string | undefined;
    let method: MatchMethod | undefined;

    if (rawEmail && byEmail.has(normEmail(rawEmail))) {
      userId = byEmail.get(normEmail(rawEmail));
      method = 'email';
    } else if (rawEmail) {
      const local = normEmail(rawEmail).split('@')[0] || '';
      const flat = local.replace(/[._-]/g, '');
      if (local.length > 3) {
        userId = byEmailLocal.get(local) || byEmailLocal.get(flat);
        if (userId) method = 'email_parcial';
      }
    }
    if (!userId && rawRut && normRut(rawRut).length > 3) {
      userId = byRut.get(normRut(rawRut));
      if (userId) method = 'rut';
    }
    if (!userId && rawAccount && normRut(rawAccount).length > 5) {
      userId = byRut.get(normRut(rawAccount));
      if (userId) method = 'rut_cuenta';
    }
    if (!userId && rawName) {
      for (const v of splitNameVariants(rawName)) {
        if (byName.has(v)) {
          userId = byName.get(v);
          method = 'nombre';
          break;
        }
      }
    }
    if (!userId && rawAccount && rawAccount.trim().length > 3) {
      const acct = normStr(rawAccount).replace(/\s+/g, '');
      userId = byEmailLocal.get(acct) || byEmailLocal.get(acct.replace(/[._-]/g, ''));
      if (userId) method = 'cuenta_usuario';
    }

    if (userId) {
      matchedCount++;
      const dirUser = db.users.find((u) => u.id === userId);
      if (dirUser) {
        const isDisabled = /^(inactivo|inactive|disabled|0|false|no|suspendido)$/i.test(rawStatus.trim());
        const existingAcc = dirUser.accounts.find((a) => a.platformId === platform.id);
        const acctName = rawAccount || rawEmail || buildUsername(dirUser.email, platform.id);
        if (existingAcc) {
          existingAcc.username = acctName;
          existingAcc.status = isDisabled ? 'Suspendido' : 'Activo';
          existingAcc.lastAccess = 'Cruce planilla';
        } else if (!isDisabled) {
          dirUser.accounts.push({
            platformId: platform.id,
            username: acctName,
            role: 'Usuario Estándar',
            status: dirUser.status === 'En proceso de baja' ? 'Pendiente revocar' : 'Activo',
            lastAccess: 'Cruce planilla',
          });
        }
        dirUser.updatedAt = nowIso();
      }
    } else {
      unmatchedCount++;
    }

    createdRows.push({
      id: `imp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      platformId: platform.id,
      rawName,
      rawEmail,
      rawRut,
      rawAccountId: rawAccount,
      rawStatus,
      matchedUserId: userId,
      matchMethod: method,
      matchStatus: userId ? 'encontrado' : 'no_encontrado',
      importedAt: nowIso(),
    });
  }

  db.platformImports = [...createdRows, ...db.platformImports].slice(0, 2000);
  platform.lastSyncAt = nowIso();
  addAudit(
    db,
    'platform_import',
    `Importación y cruce ${platform.name}: ${createdRows.length} filas (${matchedCount} cruzados, ${unmatchedCount} sin cruce)`,
    actor,
  );
  return { total: createdRows.length, matched: matchedCount, unmatched: unmatchedCount };
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function resolveSession(db: StaticDatabaseData, init?: RequestInit): { authUser: AuthUser; token: string } | null {
  const headers = new Headers(init?.headers || {});
  const auth = headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return null;
  const sess = db.sessions.find((s) => s.token === token);
  if (!sess) return null;

  if (sess.kind === 'sys') {
    const su = db.sysUsers.find((u) => u.id === sess.userId);
    if (!su || !su.active) return null;
    return { authUser: toAuthUserFromSys(su, db.sysRoles, db.users), token };
  }
  const dir = db.users.find((u) => u.id === sess.userId);
  if (!dir || dir.status === 'Inactivo') return null;
  return { authUser: toAuthUserFromDirectory(dir, db.sysRoles), token };
}

function parseBody<T>(init?: RequestInit): T {
  if (!init?.body || typeof init.body !== 'string') return {} as T;
  try {
    return JSON.parse(init.body) as T;
  } catch {
    return {} as T;
  }
}

export async function handleStaticApiRequest(input: string, init?: RequestInit): Promise<Response> {
  const method = (init?.method || 'GET').toUpperCase();
  const urlObj = new URL(input, window.location.origin);
  const path = urlObj.pathname;
  const db = readDb();

  // 1. Auth Login
  if (path === '/api/auth/login' && method === 'POST') {
    const { identifier, email, username, password } = parseBody<{
      identifier?: string;
      email?: string;
      username?: string;
      password?: string;
    }>(init);
    const rawId = (identifier || email || username || '').trim().toLowerCase();
    if (!rawId || !password) {
      return jsonRes({ error: 'Ingresa tu usuario o correo corporativo y contraseña.' }, 400);
    }

    const su = db.sysUsers.find((u) => u.username.toLowerCase() === rawId || u.email.toLowerCase() === rawId);
    if (su) {
      const stored = db.sysCredentials[su.id];
      if (!stored || !verifyStaticPassword(password, stored)) {
        return jsonRes({ error: 'Credenciales inválidas. Verifica tu usuario o contraseña.' }, 401);
      }
      if (!su.active) return jsonRes({ error: 'Tu usuario del sistema está desactivado.' }, 403);
      const token = `st_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
      db.sessions.push({ token, userId: su.id, kind: 'sys', createdAt: nowIso() });
      if (db.sessions.length > 50) db.sessions = db.sessions.slice(-50);
      su.lastLogin = nowIso();
      const authUser = toAuthUserFromSys(su, db.sysRoles, db.users);
      addAudit(db, 'auth_login', `Inicio de sesión operador (${su.username} · ${authUser.roleName})`, su.email);
      writeDb(db);
      return jsonRes({ token, user: authUser });
    }

    const dir = db.users.find((u) => u.email.toLowerCase() === rawId);
    if (!dir) return jsonRes({ error: 'Credenciales inválidas. Verifica tu usuario/correo o contraseña.' }, 401);
    const stored = db.credentials[dir.id];
    if (!stored || !verifyStaticPassword(password, stored)) {
      return jsonRes({ error: 'Credenciales inválidas. Verifica tu usuario/correo o contraseña.' }, 401);
    }
    if (dir.status === 'Inactivo') {
      return jsonRes({ error: 'Cuenta inactiva o desvinculada. El acceso al portal ha sido revocado.' }, 403);
    }
    const token = `st_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
    db.sessions.push({ token, userId: dir.id, kind: 'directory', createdAt: nowIso() });
    dir.lastAccess = 'En línea ahora';
    const authUser = toAuthUserFromDirectory(dir, db.sysRoles);
    addAudit(db, 'auth_login', `Inicio de sesión portal (${authUser.roleName})`, dir.email, dir.id);
    writeDb(db);
    return jsonRes({ token, user: authUser });
  }

  const session = resolveSession(db, init);
  if (!session) {
    return jsonRes({ error: 'Sesión no válida o expirada. Inicia sesión nuevamente.' }, 401);
  }
  const { authUser, token } = session;

  if (path === '/api/auth/me' && method === 'GET') {
    return jsonRes({ user: authUser });
  }

  if (path === '/api/auth/logout' && method === 'POST') {
    db.sessions = db.sessions.filter((s) => s.token !== token);
    writeDb(db);
    return jsonRes({ ok: true });
  }

  if (path === '/api/auth/change-password' && method === 'POST') {
    const { currentPassword, newPassword } = parseBody<{ currentPassword?: string; newPassword?: string }>(init);
    if (!currentPassword || !newPassword || newPassword.length < 6) {
      return jsonRes({ error: 'La nueva contraseña debe tener al menos 6 caracteres.' }, 400);
    }
    if (authUser.kind === 'sys') {
      const su = db.sysUsers.find((u) => u.id === authUser.id);
      if (!su || !verifyStaticPassword(currentPassword, db.sysCredentials[authUser.id] || '')) {
        return jsonRes({ error: 'La contraseña actual es incorrecta.' }, 401);
      }
      db.sysCredentials[su.id] = hashStaticPassword(newPassword);
      su.mustChangePw = false;
      addAudit(db, 'password_changed', `Contraseña actualizada por ${su.username}`, su.email);
      writeDb(db);
      return jsonRes({ user: toAuthUserFromSys(su, db.sysRoles, db.users) });
    }
    const dir = db.users.find((u) => u.id === authUser.id);
    if (!dir || !verifyStaticPassword(currentPassword, db.credentials[authUser.id] || '')) {
      return jsonRes({ error: 'La contraseña actual es incorrecta.' }, 401);
    }
    db.credentials[dir.id] = hashStaticPassword(newPassword);
    addAudit(db, 'password_changed', `Contraseña actualizada por ${dir.name}`, dir.email, dir.id);
    writeDb(db);
    return jsonRes({ user: toAuthUserFromDirectory(dir, db.sysRoles) });
  }

  if (path === '/api/state' && method === 'GET') {
    return jsonRes(getStateForAuth(db, authUser));
  }

  // Users
  if (path === '/api/users' && method === 'POST') {
    if (!hasPerm(authUser, 'usuarios', 'crear')) return jsonRes({ error: 'Sin permiso.' }, 403);
    const body = parseBody<{
      name?: string; email?: string; rut?: string; dept?: string; position?: string;
      manager?: string; phone?: string; hireDate?: string; notes?: string;
      status?: UserStatus; portalRole?: PortalRole; password?: string; platformIds?: string[];
    }>(init);
    if (!body.name?.trim() || !body.email?.trim()) {
      return jsonRes({ error: 'Nombre y correo corporativo son obligatorios.' }, 400);
    }
    const cleanEmail = body.email.trim().toLowerCase();
    if (db.users.some((u) => u.email.toLowerCase() === cleanEmail)) {
      return jsonRes({ error: 'Ya existe un usuario con ese correo corporativo.' }, 409);
    }
    const assignedRole: PortalRole = body.portalRole === 'IT_ADMIN' && authUser.portalRole !== 'IT_ADMIN' ? 'USER' : (body.portalRole || 'USER');
    const accounts: PlatformAccount[] = (body.platformIds || []).map((pid) => ({
      platformId: pid,
      username: buildUsername(cleanEmail, pid),
      role: 'Usuario Estándar',
      status: 'Activo',
      lastAccess: 'Recién aprovisionado',
    }));
    const newUser: User = {
      id: `u-${Date.now()}`,
      rut: (body.rut || '').trim() || `20.${Math.floor(100 + Math.random() * 899)}.${Math.floor(100 + Math.random() * 899)}-K`,
      name: body.name.trim(),
      email: cleanEmail,
      dept: body.dept || 'TI',
      position: (body.position || '').trim() || 'Colaborador',
      manager: body.manager?.trim() || undefined,
      phone: body.phone?.trim() || undefined,
      hireDate: body.hireDate?.trim() || new Date().toISOString().slice(0, 10),
      notes: body.notes?.trim() || undefined,
      status: body.status || 'Activo',
      portalRole: assignedRole,
      accounts,
      lastAccess: 'Nunca',
      sourceMaster: 'Creación Manual',
      updatedAt: nowIso(),
    };
    db.users.unshift(newUser);
    if ((body.password || '').trim().length >= 6) {
      db.credentials[newUser.id] = hashStaticPassword(body.password!.trim());
    }
    addAudit(db, 'user_created', `${newUser.name} creado (${assignedRole}) y consolidado en ${accounts.length} plataforma(s)`, authUser.email, newUser.id);
    writeDb(db);
    return jsonRes(getStateForAuth(db, authUser), 201);
  }

  if (path === '/api/users/bulk-import' && method === 'POST') {
    if (!hasPerm(authUser, 'usuarios', 'crear')) return jsonRes({ error: 'Sin permiso.' }, 403);
    const { rows, mode } = parseBody<{ rows?: Record<string, string>[]; mode?: 'omitir' | 'actualizar' }>(init);
    if (!Array.isArray(rows) || rows.length === 0) return jsonRes({ error: 'La planilla no contiene filas.' }, 400);
    let ok = 0;
    let duplicates = 0;
    const errors: string[] = [];
    const platLookup = new Map<string, Platform>();
    for (const p of db.platforms) {
      platLookup.set(normStr(p.id), p);
      platLookup.set(normStr(p.name), p);
    }
    rows.forEach((row, idx) => {
      const getVal = (keys: string[]) => {
        const ks = new Set(keys.map((k) => normStr(k)));
        for (const [k, v] of Object.entries(row)) {
          if (ks.has(normStr(k))) return String(v ?? '').trim();
        }
        return '';
      };
      const name = getVal(['nombre', 'nombre completo', 'full_name', 'name']);
      const email = normEmail(getVal(['email', 'correo', 'mail', 'correo electronico', 'upn']));
      if (!name || !email) {
        errors.push(`Fila ${idx + 2}: nombre o email vacío.`);
        return;
      }
      const rut = getVal(['rut', 'dni', 'cedula']);
      const dept = getVal(['departamento', 'depto', 'area', 'department']) || 'General';
      const position = getVal(['cargo', 'position', 'puesto']) || 'Colaborador';
      const detected: Platform[] = [];
      for (const [k, v] of Object.entries(row)) {
        const pl = platLookup.get(normStr(k));
        if (pl && /^(1|si|sí|yes|x|true|activo)$/i.test(String(v ?? '').trim())) detected.push(pl);
      }
      const existing = db.users.find((u) => normEmail(u.email) === email);
      if (existing) {
        if (mode === 'omitir') {
          duplicates++;
          return;
        }
        existing.name = name;
        if (rut) existing.rut = rut;
        if (dept) existing.dept = dept;
        if (position) existing.position = position;
        for (const pl of detected) {
          if (!existing.accounts.some((a) => a.platformId === pl.id)) {
            existing.accounts.push({ platformId: pl.id, username: buildUsername(email, pl.id), role: 'Usuario Estándar', status: 'Activo', lastAccess: 'Importado' });
          }
        }
        existing.updatedAt = nowIso();
        ok++;
      } else {
        const uid = `u-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        db.users.unshift({
          id: uid,
          rut: rut || `20.${Math.floor(100 + Math.random() * 899)}.${Math.floor(100 + Math.random() * 899)}-K`,
          name,
          email,
          dept,
          position,
          status: 'Activo',
          portalRole: 'USER',
          accounts: detected.map((pl) => ({ platformId: pl.id, username: buildUsername(email, pl.id), role: 'Usuario Estándar', status: 'Activo', lastAccess: 'Importado' })),
          lastAccess: 'Nunca',
          sourceMaster: 'Importación Masiva',
          updatedAt: nowIso(),
        });
        ok++;
      }
    });
    addAudit(db, 'user_created', `Importación masiva: ${ok} procesados, ${duplicates} omitidos`, authUser.email);
    writeDb(db);
    return jsonRes({
      summary: { created: ok, updated: mode === 'actualizar' ? ok : 0, skipped: duplicates, errors },
      state: getStateForAuth(db, authUser),
    });
  }

  const userPatchMatch = path.match(/^\/api\/users\/([^/]+)$/);
  if (userPatchMatch && method === 'PATCH') {
    if (!hasPerm(authUser, 'usuarios', 'editar')) return jsonRes({ error: 'Sin permiso.' }, 403);
    const id = decodeURIComponent(userPatchMatch[1]);
    const user = db.users.find((u) => u.id === id);
    if (!user) return jsonRes({ error: 'Usuario no encontrado.' }, 404);
    const body = parseBody<Partial<User>>(init);
    if (body.name !== undefined) user.name = body.name.trim();
    if (body.email !== undefined) user.email = body.email.trim().toLowerCase();
    if (body.rut !== undefined) user.rut = body.rut.trim();
    if (body.dept !== undefined) user.dept = body.dept;
    if (body.position !== undefined) user.position = body.position.trim();
    if (body.manager !== undefined) user.manager = body.manager.trim() || undefined;
    if (body.phone !== undefined) user.phone = body.phone.trim() || undefined;
    if (body.hireDate !== undefined) user.hireDate = body.hireDate.trim() || undefined;
    if (body.notes !== undefined) user.notes = body.notes.trim() || undefined;
    if (body.status !== undefined) user.status = body.status;
    if (body.portalRole !== undefined) user.portalRole = body.portalRole;
    user.updatedAt = nowIso();
    addAudit(db, 'manual_link', `Ficha de ${user.name} actualizada`, authUser.email, user.id);
    writeDb(db);
    return jsonRes(getStateForAuth(db, authUser));
  }

  const togglePlatMatch = path.match(/^\/api\/users\/([^/]+)\/toggle-platform$/);
  if (togglePlatMatch && method === 'POST') {
    if (!hasPerm(authUser, 'usuarios', 'editar')) return jsonRes({ error: 'Sin permiso.' }, 403);
    const id = decodeURIComponent(togglePlatMatch[1]);
    const user = db.users.find((u) => u.id === id);
    if (!user) return jsonRes({ error: 'Usuario no encontrado.' }, 404);
    const { platformId, enable, role } = parseBody<{ platformId?: string; enable?: boolean; role?: string }>(init);
    if (!platformId) return jsonRes({ error: 'Plataforma requerida.' }, 400);
    if (enable) {
      const existing = user.accounts.find((a) => a.platformId === platformId);
      if (existing) {
        existing.status = 'Activo';
        if (role) existing.role = role;
      } else {
        user.accounts.push({ platformId, username: buildUsername(user.email, platformId), role: role || 'Usuario Estándar', status: 'Activo', lastAccess: 'Aprovisionado ahora' });
      }
      addAudit(db, 'access_granted', `${user.name} habilitado en ${platformId}`, authUser.email, user.id);
    } else {
      user.accounts = user.accounts.filter((a) => a.platformId !== platformId);
      addAudit(db, 'access_revoked', `${user.name}: acceso ${platformId} revocado`, authUser.email, user.id);
    }
    user.updatedAt = nowIso();
    writeDb(db);
    return jsonRes(getStateForAuth(db, authUser));
  }

  // Offboardings
  if (path === '/api/offboardings' && method === 'POST') {
    if (!hasPerm(authUser, 'bajas', 'gestionar')) return jsonRes({ error: 'Sin permiso.' }, 403);
    const { userId, reason, offboardDate } = parseBody<{ userId?: string; reason?: string; offboardDate?: string }>(init);
    const user = db.users.find((u) => u.id === userId);
    if (!user) return jsonRes({ error: 'Usuario no encontrado.' }, 404);
    const pendingPlatforms = user.accounts.map((a) => a.platformId);
    for (const acc of user.accounts) acc.status = 'Pendiente revocar';
    user.status = pendingPlatforms.length > 0 ? 'En proceso de baja' : 'Inactivo';
    user.updatedAt = nowIso();
    db.offboardings.unshift({
      id: `off-${Date.now()}`,
      userId: user.id,
      userName: user.name,
      email: user.email,
      rut: user.rut,
      dept: user.dept,
      offboardDate: offboardDate || new Date().toISOString().slice(0, 10),
      reason: (reason || 'Término de contrato').trim(),
      initiatedBy: authUser.username || authUser.email,
      pendingPlatforms,
      revokedPlatforms: [],
      status: pendingPlatforms.length > 0 ? 'En proceso' : 'Completado',
      completedAt: pendingPlatforms.length === 0 ? nowIso() : undefined,
    });
    addAudit(db, 'offboarding_started', `Proceso de baja iniciado para ${user.name}`, authUser.email, user.id);
    writeDb(db);
    return jsonRes(getStateForAuth(db, authUser), 201);
  }

  const offRevokeMatch = path.match(/^\/api\/offboardings\/([^/]+)\/revoke$/);
  if (offRevokeMatch && method === 'POST') {
    if (!hasPerm(authUser, 'bajas', 'gestionar')) return jsonRes({ error: 'Sin permiso.' }, 403);
    const offId = decodeURIComponent(offRevokeMatch[1]);
    const record = db.offboardings.find((o) => o.id === offId);
    if (!record) return jsonRes({ error: 'Registro de baja no encontrado.' }, 404);
    const { platformId, all } = parseBody<{ platformId?: string; all?: boolean }>(init);
    const user = db.users.find((u) => u.id === record.userId);
    const toRevoke = all ? [...record.pendingPlatforms] : platformId ? [platformId] : [];
    for (const pid of toRevoke) {
      if (!record.revokedPlatforms.includes(pid)) record.revokedPlatforms.push(pid);
      record.pendingPlatforms = record.pendingPlatforms.filter((p) => p !== pid);
      if (user) user.accounts = user.accounts.filter((a) => a.platformId !== pid);
    }
    if (record.pendingPlatforms.length === 0) {
      record.status = 'Completado';
      record.completedAt = nowIso();
      if (user) user.status = 'Inactivo';
    }
    if (user) user.updatedAt = nowIso();
    addAudit(db, 'access_revoked', `${record.userName}: ${toRevoke.join(', ')} revocado`, authUser.email, record.userId);
    writeDb(db);
    return jsonRes(getStateForAuth(db, authUser));
  }

  // Platforms
  if (path === '/api/platforms' && method === 'POST') {
    if (!hasPerm(authUser, 'plataformas', 'crear')) return jsonRes({ error: 'Sin permiso.' }, 403);
    const body = parseBody<Partial<Platform>>(init);
    if (!body.name?.trim()) return jsonRes({ error: 'Nombre de plataforma obligatorio.' }, 400);
    const id = (body.id || body.name).trim();
    if (db.platforms.some((p) => p.id.toLowerCase() === id.toLowerCase())) {
      return jsonRes({ error: 'Ya existe una plataforma con ese identificador.' }, 409);
    }
    const newPlat: Platform = {
      id,
      name: body.name.trim(),
      abbr: (body.abbr || body.name.slice(0, 4)).toUpperCase(),
      colorHex: body.colorHex || '#1E73BE',
      type: body.type || 'Propia',
      status: body.status || 'Operativo',
      lastSyncAt: nowIso(),
      endpoint: body.endpoint || 'https://api.empresa.local/users',
      syncMode: body.syncMode || 'Manual',
      requiredForActive: Boolean(body.requiredForActive),
      isDefault: false,
      colMap: body.colMap || '',
      notes: body.notes || '',
    };
    db.platforms.push(newPlat);
    addAudit(db, 'platform_synced', `Plataforma ${newPlat.name} agregada`, authUser.email);
    writeDb(db);
    return jsonRes(getStateForAuth(db, authUser), 201);
  }

  const platMatch = path.match(/^\/api\/platforms\/([^/]+)$/);
  if (platMatch && method === 'PATCH') {
    if (!hasPerm(authUser, 'plataformas', 'editar')) return jsonRes({ error: 'Sin permiso.' }, 403);
    const pid = decodeURIComponent(platMatch[1]);
    const p = db.platforms.find((pl) => pl.id === pid);
    if (!p) return jsonRes({ error: 'Plataforma no encontrada.' }, 404);
    Object.assign(p, parseBody<Partial<Platform>>(init));
    addAudit(db, 'platform_synced', `Plataforma ${p.name} actualizada`, authUser.email);
    writeDb(db);
    return jsonRes(getStateForAuth(db, authUser));
  }

  if (platMatch && method === 'DELETE') {
    if (!hasPerm(authUser, 'plataformas', 'editar')) return jsonRes({ error: 'Sin permiso.' }, 403);
    const pid = decodeURIComponent(platMatch[1]);
    const p = db.platforms.find((pl) => pl.id === pid);
    if (!p) return jsonRes({ error: 'Plataforma no encontrada.' }, 404);
    if (p.isDefault) return jsonRes({ error: 'No se pueden eliminar plataformas base.' }, 400);
    db.platforms = db.platforms.filter((pl) => pl.id !== pid);
    for (const u of db.users) u.accounts = u.accounts.filter((a) => a.platformId !== pid);
    db.platformImports = db.platformImports.filter((pi) => pi.platformId !== pid);
    addAudit(db, 'platform_synced', `Plataforma ${p.name} eliminada`, authUser.email);
    writeDb(db);
    return jsonRes(getStateForAuth(db, authUser));
  }

  const platSyncMatch = path.match(/^\/api\/platforms\/([^/]+)\/sync$/);
  if (platSyncMatch && method === 'POST') {
    if (!hasPerm(authUser, 'plataformas', 'editar')) return jsonRes({ error: 'Sin permiso.' }, 403);
    const pid = decodeURIComponent(platSyncMatch[1]);
    const p = db.platforms.find((pl) => pl.id === pid);
    if (!p) return jsonRes({ error: 'Plataforma no encontrada.' }, 404);
    p.lastSyncAt = nowIso();
    addAudit(db, 'platform_synced', `Sincronización manual completada para ${p.name}`, authUser.email);
    writeDb(db);
    return jsonRes(getStateForAuth(db, authUser));
  }

  const platImpMatch = path.match(/^\/api\/platforms\/([^/]+)\/imports$/);
  if (platImpMatch && method === 'POST') {
    if (!hasPerm(authUser, 'plataformas', 'importar')) return jsonRes({ error: 'Sin permiso.' }, 403);
    const pid = decodeURIComponent(platImpMatch[1]);
    const p = db.platforms.find((pl) => pl.id === pid);
    if (!p) return jsonRes({ error: 'Plataforma no encontrada.' }, 404);
    const { rows, mode } = parseBody<{ rows?: Record<string, string>[]; mode?: 'reemplazar' | 'agregar' }>(init);
    if (!Array.isArray(rows) || rows.length === 0) return jsonRes({ error: 'No hay filas válidas.' }, 400);
    const summary = runPlatformCrossImport(db, p, rows, mode || 'reemplazar', authUser.email);
    writeDb(db);
    return jsonRes({ summary, state: getStateForAuth(db, authUser) });
  }

  const platImpLinkMatch = path.match(/^\/api\/platforms\/([^/]+)\/imports\/([^/]+)\/link$/);
  if (platImpLinkMatch && method === 'POST') {
    if (!hasPerm(authUser, 'plataformas', 'importar')) return jsonRes({ error: 'Sin permiso.' }, 403);
    const pid = decodeURIComponent(platImpLinkMatch[1]);
    const impId = decodeURIComponent(platImpLinkMatch[2]);
    const { userId } = parseBody<{ userId?: string }>(init);
    const imp = db.platformImports.find((r) => r.id === impId && r.platformId === pid);
    const user = db.users.find((u) => u.id === userId);
    if (!imp || !user) return jsonRes({ error: 'Registro o usuario no encontrado.' }, 404);
    imp.matchedUserId = user.id;
    imp.matchMethod = 'manual';
    imp.matchStatus = 'encontrado';
    if (!user.accounts.some((a) => a.platformId === pid)) {
      user.accounts.push({
        platformId: pid,
        username: imp.rawAccountId || imp.rawEmail || buildUsername(user.email, pid),
        role: 'Usuario Estándar',
        status: 'Activo',
        lastAccess: 'Vinculado manual',
      });
    }
    addAudit(db, 'platform_import', `Registro '${imp.rawEmail || imp.rawName}' vinculado a ${user.name}`, authUser.email, user.id);
    writeDb(db);
    return jsonRes(getStateForAuth(db, authUser));
  }

  const platApiCfgMatch = path.match(/^\/api\/platforms\/([^/]+)\/api$/);
  if (platApiCfgMatch && method === 'PUT') {
    if (!hasPerm(authUser, 'plataformas', 'editar')) return jsonRes({ error: 'Sin permiso.' }, 403);
    const pid = decodeURIComponent(platApiCfgMatch[1]);
    const body = parseBody<Partial<ApiConfig>>(init);
    const existing = db.apiConfigs.find((c) => c.platformId === pid);
    if (!existing) {
      const created: StoredApiConfig = {
        platformId: pid,
        apiType: body.apiType || 'custom',
        baseUrl: body.baseUrl || '',
        authType: body.authType || 'bearer',
        token: body.token || '',
        hasToken: Boolean(body.token),
        username: body.username || '',
        password: body.password || '',
        hasPassword: Boolean(body.password),
        clientId: body.clientId || '',
        clientSecret: body.clientSecret || '',
        hasClientSecret: Boolean(body.clientSecret),
        tenantId: body.tenantId || '',
        extraParams: body.extraParams || { query: {}, verifySsl: true },
        fieldMap: body.fieldMap || {},
        offboardEndpoint: body.offboardEndpoint || '',
        offboardMethod: body.offboardMethod || 'PATCH',
        offboardPayload: body.offboardPayload || '',
        syncEnabled: Boolean(body.syncEnabled),
        syncInterval: body.syncInterval || 24,
        updatedAt: nowIso(),
      };
      db.apiConfigs.push(created);
    } else {
      if (body.apiType !== undefined) existing.apiType = body.apiType;
      if (body.baseUrl !== undefined) existing.baseUrl = body.baseUrl;
      if (body.authType !== undefined) existing.authType = body.authType;
      if (body.token) existing.token = body.token;
      if (body.username !== undefined) existing.username = body.username;
      if (body.password) existing.password = body.password;
      if (body.clientId !== undefined) existing.clientId = body.clientId;
      if (body.clientSecret) existing.clientSecret = body.clientSecret;
      if (body.tenantId !== undefined) existing.tenantId = body.tenantId;
      if (body.extraParams !== undefined) existing.extraParams = body.extraParams;
      if (body.fieldMap !== undefined) existing.fieldMap = body.fieldMap;
      if (body.offboardEndpoint !== undefined) existing.offboardEndpoint = body.offboardEndpoint;
      if (body.offboardMethod !== undefined) existing.offboardMethod = body.offboardMethod;
      if (body.offboardPayload !== undefined) existing.offboardPayload = body.offboardPayload;
      if (body.syncEnabled !== undefined) existing.syncEnabled = body.syncEnabled;
      if (body.syncInterval !== undefined) existing.syncInterval = body.syncInterval;
      existing.updatedAt = nowIso();
    }
    addAudit(db, 'api_config', `Conector API actualizado para ${pid}`, authUser.email);
    writeDb(db);
    return jsonRes(getStateForAuth(db, authUser));
  }

  const platApiTestMatch = path.match(/^\/api\/platforms\/([^/]+)\/api\/(test|sync)$/);
  if (platApiTestMatch && method === 'POST') {
    const pid = decodeURIComponent(platApiTestMatch[1]);
    const action = platApiTestMatch[2];
    const cfg = db.apiConfigs.find((c) => c.platformId === pid);
    if (!cfg || !cfg.baseUrl) {
      return jsonRes({ ok: false, count: 0, msg: 'Configura primero la URL base del conector API.' });
    }
    const msg =
      action === 'test'
        ? 'En GitHub Pages (modo estático sin servidor Node) las llamadas directas a APIs internas están bloqueadas por CORS/red local.'
        : 'Sincronización API remota requiere servidor Node.js activo. Usa "Cargar planilla / Cruce" para consolidar datos en modo estático.';
    return jsonRes({ ok: false, count: 0, msg, result: { ok: false, msg }, state: getStateForAuth(db, authUser) });
  }

  if (/^\/api\/platforms\/[^/]+\/api\/offboard\//.test(path) && method === 'POST') {
    return jsonRes({
      result: {
        ok: false,
        msg: 'La baja remota vía API externa requiere servidor Node.js. Puedes revocar el acceso localmente desde el módulo Bajas.',
      },
      state: getStateForAuth(db, authUser),
    });
  }

  // Consolidate preview & commit
  if (path === '/api/consolidate/preview' && method === 'POST') {
    if (!hasPerm(authUser, 'plataformas', 'importar')) return jsonRes({ error: 'Sin permiso.' }, 403);
    const { platformId, rows } = parseBody<{ platformId?: string; rows?: ConsolidationRowInput[] }>(init);
    if (!platformId || !Array.isArray(rows)) return jsonRes({ error: 'Datos inválidos.' }, 400);

    const items: ConsolidationPreviewItem[] = [];
    let newUsers = 0;
    let linkedAccounts = 0;
    let offboardingsDetected = 0;
    let statusUpdates = 0;
    let unchanged = 0;

    for (const row of rows) {
      const email = (row.email || '').trim().toLowerCase();
      const rut = (row.rut || '').trim();
      if (!email && !rut) continue;
      const matched = db.users.find((u) => (email && u.email.toLowerCase() === email) || (rut && u.rut.toLowerCase() === rut.toLowerCase()));
      const incomingStatus = normalizeStatus(row.status);
      const username = (row.username || '').trim() || buildUsername(email || `${rut}@empresa.com`, platformId);
      const role = (row.role || '').trim() || 'Usuario Estándar';

      if (!matched) {
        if (incomingStatus === 'En proceso de baja' || incomingStatus === 'Inactivo') {
          offboardingsDetected++;
          items.push({
            email: email || `${rut}@empresa.com`,
            rut: rut || 'Sin RUT',
            name: (row.name || 'Colaborador').trim(),
            dept: (row.dept || 'General').trim(),
            position: (row.position || 'Colaborador').trim(),
            incomingStatus: 'En proceso de baja',
            action: 'CONSOLIDAR_BAJA',
            detail: `Nuevo registro marcado como baja desde ${platformId}`,
            username,
            role,
            reason: row.reason || 'Consolidación de bajas externas',
            offboardDate: row.offboardDate || new Date().toISOString().slice(0, 10),
          });
        } else {
          newUsers++;
          items.push({
            email: email || `${rut}@empresa.com`,
            rut: rut || 'Por asignar',
            name: (row.name || 'Nuevo Usuario').trim(),
            dept: (row.dept || 'General').trim(),
            position: (row.position || 'Colaborador').trim(),
            incomingStatus,
            action: 'CREAR_USUARIO',
            detail: `Crear usuario maestro y vincular cuenta en ${platformId}`,
            username,
            role,
          });
        }
        continue;
      }

      if ((incomingStatus === 'En proceso de baja' || incomingStatus === 'Inactivo') && matched.status !== 'Inactivo' && matched.status !== 'En proceso de baja') {
        offboardingsDetected++;
        items.push({
          email: matched.email,
          rut: matched.rut,
          name: matched.name,
          dept: matched.dept,
          position: matched.position,
          incomingStatus: 'En proceso de baja',
          action: 'CONSOLIDAR_BAJA',
          detail: `Baja detectada desde ${platformId} · Se marcarán ${matched.accounts.length} cuentas para revocar`,
          existingUserId: matched.id,
          username,
          role,
          reason: row.reason || `Baja reportada por ${platformId}`,
          offboardDate: row.offboardDate || new Date().toISOString().slice(0, 10),
        });
        continue;
      }

      if (!matched.accounts.some((a) => a.platformId === platformId)) {
        linkedAccounts++;
        items.push({
          email: matched.email,
          rut: matched.rut,
          name: matched.name,
          dept: matched.dept,
          position: matched.position,
          incomingStatus,
          action: 'VINCULAR_CUENTA',
          detail: `Asociar cuenta existente de ${platformId} (${username}) al perfil maestro`,
          existingUserId: matched.id,
          username,
          role,
        });
      } else if (matched.status !== incomingStatus && incomingStatus === 'Activo') {
        statusUpdates++;
        items.push({
          email: matched.email,
          rut: matched.rut,
          name: matched.name,
          dept: matched.dept,
          position: matched.position,
          incomingStatus,
          action: 'ACTUALIZAR_ESTADO',
          detail: `Actualizar estado de ${matched.status} → ${incomingStatus}`,
          existingUserId: matched.id,
          username,
          role,
        });
      } else {
        unchanged++;
        items.push({
          email: matched.email,
          rut: matched.rut,
          name: matched.name,
          dept: matched.dept,
          position: matched.position,
          incomingStatus: matched.status,
          action: 'SIN_CAMBIOS',
          detail: `Ya consolidado en ${platformId}`,
          existingUserId: matched.id,
          username,
          role,
        });
      }
    }

    const preview: ConsolidationPreviewResponse = {
      platformId,
      totalRows: items.length,
      summary: { newUsers, linkedAccounts, offboardingsDetected, statusUpdates, unchanged },
      items,
    };
    return jsonRes(preview);
  }

  if (path === '/api/consolidate/commit' && method === 'POST') {
    if (!hasPerm(authUser, 'plataformas', 'importar')) return jsonRes({ error: 'Sin permiso.' }, 403);
    const { platformId, items } = parseBody<{ platformId?: string; items?: ConsolidationPreviewItem[] }>(init);
    if (!platformId || !Array.isArray(items)) return jsonRes({ error: 'Datos inválidos.' }, 400);
    let createdCount = 0;
    let linkedCount = 0;
    let offboardedCount = 0;
    for (const item of items) {
      if (item.action === 'CREAR_USUARIO') {
        db.users.unshift({
          id: `u-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          rut: item.rut,
          name: item.name,
          email: item.email,
          dept: item.dept,
          position: item.position,
          status: item.incomingStatus,
          portalRole: 'USER',
          lastAccess: 'Consolidado',
          sourceMaster: platformId,
          updatedAt: nowIso(),
          accounts: [{ platformId, username: item.username, role: item.role, status: 'Activo', lastAccess: 'Sincronizado' }],
        });
        createdCount++;
      } else if (item.action === 'VINCULAR_CUENTA' && item.existingUserId) {
        const user = db.users.find((u) => u.id === item.existingUserId);
        if (user && !user.accounts.some((a) => a.platformId === platformId)) {
          user.accounts.push({ platformId, username: item.username, role: item.role, status: user.status === 'En proceso de baja' ? 'Pendiente revocar' : 'Activo', lastAccess: 'Sincronizado' });
          user.updatedAt = nowIso();
          linkedCount++;
        }
      } else if (item.action === 'ACTUALIZAR_ESTADO' && item.existingUserId) {
        const user = db.users.find((u) => u.id === item.existingUserId);
        if (user) {
          user.status = item.incomingStatus;
          user.updatedAt = nowIso();
        }
      } else if (item.action === 'CONSOLIDAR_BAJA') {
        let user = item.existingUserId ? db.users.find((u) => u.id === item.existingUserId) : undefined;
        if (!user) {
          user = {
            id: `u-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            rut: item.rut || 'Sin RUT',
            name: item.name,
            email: item.email,
            dept: item.dept,
            position: item.position,
            status: 'Inactivo',
            portalRole: 'USER',
            lastAccess: 'Desvinculado',
            sourceMaster: platformId,
            updatedAt: nowIso(),
            accounts: [],
          };
          db.users.unshift(user);
        }
        const pendingPlatforms = user.accounts.map((a) => a.platformId);
        for (const acc of user.accounts) acc.status = 'Pendiente revocar';
        user.status = pendingPlatforms.length > 0 ? 'En proceso de baja' : 'Inactivo';
        user.updatedAt = nowIso();
        if (!db.offboardings.some((o) => o.userId === user!.id && o.status === 'En proceso')) {
          db.offboardings.unshift({
            id: `off-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            userId: user.id,
            userName: user.name,
            email: user.email,
            rut: user.rut,
            dept: user.dept,
            offboardDate: item.offboardDate || new Date().toISOString().slice(0, 10),
            reason: item.reason || `Baja consolidada (${platformId})`,
            initiatedBy: authUser.username || authUser.email,
            pendingPlatforms,
            revokedPlatforms: [],
            status: pendingPlatforms.length > 0 ? 'En proceso' : 'Completado',
            completedAt: pendingPlatforms.length === 0 ? nowIso() : undefined,
          });
        }
        offboardedCount++;
      }
    }
    const plat = db.platforms.find((p) => p.id === platformId);
    if (plat) plat.lastSyncAt = nowIso();
    addAudit(db, 'consolidation', `Consolidación ${platformId}: ${createdCount} nuevos, ${linkedCount} vinculados, ${offboardedCount} bajas`, authUser.email);
    writeDb(db);
    return jsonRes(getStateForAuth(db, authUser));
  }

  // Sys-users & roles
  if (path === '/api/sys-users' && method === 'POST') {
    if (!hasPerm(authUser, 'configuracion', 'gestionar')) return jsonRes({ error: 'Sin permiso.' }, 403);
    const { username, fullName, email, roleId, password, mustChangePw } = parseBody<{
      username?: string; fullName?: string; email?: string; roleId?: string; password?: string; mustChangePw?: boolean;
    }>(init);
    const cleanUsername = (username || '').trim().toLowerCase();
    const cleanEmail = (email || '').trim().toLowerCase();
    const cleanPw = (password || '').trim();
    if (!cleanUsername || !fullName?.trim() || !cleanEmail || !roleId) {
      return jsonRes({ error: 'Usuario, nombre completo, email y rol son obligatorios.' }, 400);
    }
    if (cleanPw.length < 6) {
      return jsonRes({ error: 'La contraseña inicial debe tener al menos 6 caracteres.' }, 400);
    }
    if (db.sysUsers.some((u) => u.username.toLowerCase() === cleanUsername || u.email.toLowerCase() === cleanEmail)) {
      return jsonRes({ error: 'Ya existe un operador con ese username o email.' }, 409);
    }
    const su: SysUser = {
      id: `su-${Date.now()}`,
      username: cleanUsername,
      fullName: fullName.trim(),
      email: cleanEmail,
      roleId,
      active: true,
      mustChangePw: Boolean(mustChangePw),
      createdAt: nowIso(),
    };
    db.sysUsers.push(su);
    db.sysCredentials[su.id] = hashStaticPassword(cleanPw);
    addAudit(db, 'sys_user', `Operador '${su.username}' creado`, authUser.email);
    writeDb(db);
    return jsonRes(getStateForAuth(db, authUser), 201);
  }

  const suPatchMatch = path.match(/^\/api\/sys-users\/([^/]+)$/);
  if (suPatchMatch && method === 'PATCH') {
    if (!hasPerm(authUser, 'configuracion', 'gestionar')) return jsonRes({ error: 'Sin permiso.' }, 403);
    const id = decodeURIComponent(suPatchMatch[1]);
    const su = db.sysUsers.find((u) => u.id === id);
    if (!su) return jsonRes({ error: 'Operador no encontrado.' }, 404);
    const body = parseBody<{ fullName?: string; email?: string; roleId?: string; active?: boolean; newPassword?: string; mustChangePw?: boolean }>(init);
    if (body.fullName !== undefined) su.fullName = body.fullName.trim();
    if (body.email !== undefined) su.email = body.email.trim().toLowerCase();
    if (body.roleId !== undefined) su.roleId = body.roleId;
    if (body.active !== undefined) su.active = body.active;
    if (body.mustChangePw !== undefined) su.mustChangePw = body.mustChangePw;
    if (body.newPassword && body.newPassword.length >= 6) {
      db.sysCredentials[su.id] = hashStaticPassword(body.newPassword);
    }
    writeDb(db);
    return jsonRes(getStateForAuth(db, authUser));
  }

  const suToggleMatch = path.match(/^\/api\/sys-users\/([^/]+)\/toggle$/);
  if (suToggleMatch && method === 'POST') {
    if (!hasPerm(authUser, 'configuracion', 'gestionar')) return jsonRes({ error: 'Sin permiso.' }, 403);
    const id = decodeURIComponent(suToggleMatch[1]);
    const su = db.sysUsers.find((u) => u.id === id);
    if (!su) return jsonRes({ error: 'Operador no encontrado.' }, 404);
    if (su.id === authUser.id) return jsonRes({ error: 'No puedes desactivar tu propio usuario.' }, 400);
    su.active = !su.active;
    writeDb(db);
    return jsonRes(getStateForAuth(db, authUser));
  }

  if (path === '/api/sys-roles' && method === 'POST') {
    if (!hasPerm(authUser, 'configuracion', 'gestionar')) return jsonRes({ error: 'Sin permiso.' }, 403);
    const { name, description, permissions } = parseBody<{ name?: string; description?: string; permissions?: PermissionMatrix }>(init);
    if (!name?.trim()) return jsonRes({ error: 'El nombre del rol es obligatorio.' }, 400);
    db.sysRoles.push({
      id: `role-${Date.now()}`,
      name: name.trim(),
      description: (description || '').trim(),
      permissions: permissions || {},
      isSystem: false,
      createdAt: nowIso(),
    });
    writeDb(db);
    return jsonRes(getStateForAuth(db, authUser), 201);
  }

  const roleMatch = path.match(/^\/api\/sys-roles\/([^/]+)$/);
  if (roleMatch && method === 'PATCH') {
    if (!hasPerm(authUser, 'configuracion', 'gestionar')) return jsonRes({ error: 'Sin permiso.' }, 403);
    const rid = decodeURIComponent(roleMatch[1]);
    const role = db.sysRoles.find((r) => r.id === rid);
    if (!role) return jsonRes({ error: 'Rol no encontrado.' }, 404);
    const body = parseBody<Partial<SysRole>>(init);
    if (body.name !== undefined) role.name = body.name.trim();
    if (body.description !== undefined) role.description = body.description.trim();
    if (body.permissions !== undefined && !role.isSystem) role.permissions = body.permissions;
    writeDb(db);
    return jsonRes(getStateForAuth(db, authUser));
  }

  if (roleMatch && method === 'DELETE') {
    if (!hasPerm(authUser, 'configuracion', 'gestionar')) return jsonRes({ error: 'Sin permiso.' }, 403);
    const rid = decodeURIComponent(roleMatch[1]);
    const role = db.sysRoles.find((r) => r.id === rid);
    if (!role) return jsonRes({ error: 'Rol no encontrado.' }, 404);
    if (role.isSystem) return jsonRes({ error: 'No se pueden eliminar roles base.' }, 400);
    if (db.sysUsers.some((u) => u.roleId === rid)) return jsonRes({ error: 'El rol tiene operadores asignados.' }, 400);
    db.sysRoles = db.sysRoles.filter((r) => r.id !== rid);
    writeDb(db);
    return jsonRes(getStateForAuth(db, authUser));
  }

  // Settings, Backups & Reset
  if (path === '/api/settings' && method === 'PUT') {
    if (!hasPerm(authUser, 'configuracion', 'servicio')) return jsonRes({ error: 'Sin permiso.' }, 403);
    db.settings = { ...db.settings, ...parseBody<Partial<SystemSettings>>(init) };
    addAudit(db, 'settings_updated', 'Parámetros de configuración actualizados', authUser.email);
    writeDb(db);
    return jsonRes(getStateForAuth(db, authUser));
  }

  if (path === '/api/backups' && method === 'POST') {
    if (!hasPerm(authUser, 'configuracion', 'servicio')) return jsonRes({ error: 'Sin permiso.' }, 403);
    const { note } = parseBody<{ note?: string }>(init);
    const filename = makeBackup(db, 'manual', note || '');
    addAudit(db, 'backup_restore', `Respaldo creado: ${filename}`, authUser.email);
    writeDb(db);
    return jsonRes({ filename, state: getStateForAuth(db, authUser) }, 201);
  }

  const backupDlMatch = path.match(/^\/api\/backups\/([^/]+)\/download$/);
  if (backupDlMatch && method === 'GET') {
    if (!hasPerm(authUser, 'configuracion', 'servicio')) return jsonRes({ error: 'Sin permiso.' }, 403);
    const fname = decodeURIComponent(backupDlMatch[1]);
    const found = readBackups().find((b) => b.record.name === fname);
    if (!found) return jsonRes({ error: 'Respaldo no encontrado.' }, 404);
    return new Response(found.payload, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const backupRestoreMatch = path.match(/^\/api\/backups\/([^/]+)\/restore$/);
  if (backupRestoreMatch && method === 'POST') {
    if (!hasPerm(authUser, 'configuracion', 'servicio')) return jsonRes({ error: 'Sin permiso.' }, 403);
    const fname = decodeURIComponent(backupRestoreMatch[1]);
    const found = readBackups().find((b) => b.record.name === fname);
    if (!found) return jsonRes({ error: 'Respaldo no encontrado.' }, 404);
    const { what } = parseBody<{ what?: 'db' | 'config' | 'all' }>(init);
    const safetyBackup = makeBackup(db, 'pre-restauracion', `Antes de restaurar ${fname}`);
    const parsed = JSON.parse(found.payload) as { data: StaticDatabaseData };
    if (what === 'db' || what === 'all') {
      db.platforms = parsed.data.platforms || db.platforms;
      db.users = parsed.data.users || db.users;
      db.offboardings = parsed.data.offboardings || [];
      db.auditLogs = parsed.data.auditLogs || [];
      db.sysRoles = parsed.data.sysRoles || db.sysRoles;
      db.sysUsers = parsed.data.sysUsers || db.sysUsers;
    }
    if (what === 'config' || what === 'all') {
      if (parsed.data.settings) db.settings = { ...db.settings, ...parsed.data.settings };
    }
    writeDb(db);
    return jsonRes({ safetyBackup, state: getStateForAuth(db, authUser) });
  }

  const backupDelMatch = path.match(/^\/api\/backups\/([^/]+)$/);
  if (backupDelMatch && method === 'DELETE') {
    if (!hasPerm(authUser, 'configuracion', 'servicio')) return jsonRes({ error: 'Sin permiso.' }, 403);
    const fname = decodeURIComponent(backupDelMatch[1]);
    writeBackups(readBackups().filter((b) => b.record.name !== fname));
    return jsonRes(getStateForAuth(db, authUser));
  }

  if (path === '/api/reset' && method === 'POST') {
    if (!hasPerm(authUser, 'configuracion', 'servicio')) return jsonRes({ error: 'Sin permiso.' }, 403);
    makeBackup(db, 'pre-reset', 'Antes de restablecer datos iniciales');
    const fresh = buildSeedData();
    fresh.sessions = db.sessions;
    writeDb(fresh);
    return jsonRes(getStateForAuth(fresh, authUser));
  }

  // Assistant static fallback
  if (path === '/api/assistant/history' && method === 'GET') {
    return jsonRes({ recent: [] });
  }
  if (path === '/api/assistant/message' && method === 'POST') {
    return jsonRes({
      reply:
        'Estás visualizando UserSync en modo estático (sin servidor Node.js). El Asistente IA con Gemini requiere ejecutar el servidor Express (`server.ts`) con la variable `GEMINI_API_KEY` configurada. Todas las demás funciones (gestión de usuarios, plataformas, cruce 6 niveles, bajas, reportes, roles y respaldos locales) funcionan directamente en tu navegador.',
      proposals: [],
    });
  }

  return jsonRes({ error: `Ruta no soportada en modo estático: ${method} ${path}` }, 404);
}
