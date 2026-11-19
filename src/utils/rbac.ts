import type { AuthUser, PermissionModule, PortalRole } from '../types';

export type NavPage =
  | 'dashboard'
  | 'usuarios'
  | 'bajas'
  | 'validacion'
  | 'consolidar'
  | 'plataformas'
  | 'reportes'
  | 'audit'
  | 'asistente'
  | 'configuracion'
  | 'mi-perfil';

export const PERMS_CATALOG: Record<
  PermissionModule,
  { label: string; actions: Record<string, string> }
> = {
  usuarios: {
    label: 'Usuarios del directorio',
    actions: {
      ver: 'Ver usuarios',
      crear: 'Crear / importar usuarios',
      editar: 'Editar usuarios y accesos',
      eliminar: 'Dar de baja / revocar',
    },
  },
  plataformas: {
    label: 'Plataformas e integraciones',
    actions: {
      ver: 'Ver plataformas',
      crear: 'Agregar plataformas',
      editar: 'Editar plataformas y API',
      importar: 'Importar y cruzar planillas',
    },
  },
  reportes: {
    label: 'Reportes',
    actions: {
      ver: 'Ver reportes',
      exportar: 'Exportar reportes',
    },
  },
  bajas: {
    label: 'Bajas y desvinculaciones',
    actions: {
      ver: 'Ver bajas',
      gestionar: 'Gestionar y revocar bajas',
    },
  },
  audit: {
    label: 'Auditoría',
    actions: {
      ver: 'Ver Audit Log',
    },
  },
  configuracion: {
    label: 'Configuración y sistema',
    actions: {
      ver: 'Ver configuración',
      gestionar: 'Gestionar usuarios del sistema y roles',
      servicio: 'Configurar servicio y respaldos',
      asistente: 'Usar asistente IA',
    },
  },
};

export const ROLE_LABELS: Record<PortalRole, string> = {
  IT_ADMIN: 'Administrador TI',
  RRHH_MANAGER: 'Gestor RRHH',
  AUDITOR: 'Auditor / Seguridad',
  USER: 'Colaborador',
};

export const ROLE_DESCRIPTIONS: Record<PortalRole, string> = {
  IT_ADMIN: 'Control total: usuarios, bajas, consolidación, plataformas, APIs y configuración',
  RRHH_MANAGER: 'Gestión de altas, nómina, bajas, validación de cuentas y reportes',
  AUDITOR: 'Solo lectura: auditoría de inconsistencias, audit log, validación y reportes',
  USER: 'Portal personal: consulta de ficha corporativa y cuentas asignadas',
};

export function hasPerm(
  authUser: AuthUser | null | undefined,
  module: PermissionModule,
  action: string,
): boolean {
  if (!authUser) return false;
  if (authUser.permissions === '*') return true;
  return Boolean(authUser.permissions?.[module]?.[action]);
}

export function canManageUsers(authUser: AuthUser | null | undefined): boolean {
  return (
    hasPerm(authUser, 'usuarios', 'crear') ||
    hasPerm(authUser, 'usuarios', 'editar') ||
    hasPerm(authUser, 'bajas', 'gestionar')
  );
}

export function canManageSystem(authUser: AuthUser | null | undefined): boolean {
  return (
    hasPerm(authUser, 'configuracion', 'gestionar') ||
    hasPerm(authUser, 'configuracion', 'servicio') ||
    hasPerm(authUser, 'plataformas', 'editar')
  );
}

export function getAllowedPages(authUser: AuthUser | null | undefined): NavPage[] {
  if (!authUser) return [];
  if (authUser.kind === 'directory' && authUser.portalRole === 'USER') {
    return ['mi-perfil'];
  }

  const pages: NavPage[] = ['dashboard'];
  if (hasPerm(authUser, 'usuarios', 'ver')) pages.push('usuarios');
  if (hasPerm(authUser, 'bajas', 'ver')) pages.push('bajas');
  if (hasPerm(authUser, 'usuarios', 'ver') || hasPerm(authUser, 'plataformas', 'ver')) {
    pages.push('validacion');
  }
  if (hasPerm(authUser, 'plataformas', 'importar') || hasPerm(authUser, 'usuarios', 'crear')) {
    pages.push('consolidar');
  }
  if (hasPerm(authUser, 'plataformas', 'ver')) pages.push('plataformas');
  if (hasPerm(authUser, 'reportes', 'ver')) pages.push('reportes');
  if (hasPerm(authUser, 'audit', 'ver')) pages.push('audit');
  if (hasPerm(authUser, 'configuracion', 'asistente')) pages.push('asistente');
  if (hasPerm(authUser, 'configuracion', 'ver')) pages.push('configuracion');
  return pages;
}

export function getDefaultPage(authUser: AuthUser | null | undefined): NavPage {
  if (!authUser) return 'dashboard';
  if (authUser.kind === 'directory' && authUser.portalRole === 'USER') {
    return 'mi-perfil';
  }
  return 'dashboard';
}
