import { GoogleGenAI, Type } from '@google/genai';
import crypto from 'crypto';
import type {
  AiProposalCard,
  AiProposalChange,
  AuthUser,
  PlatformStatus,
  PlatformType,
} from '../src/types.ts';
import {
  APP_VERSION,
  addAudit,
  hasPerm,
  makeBackup,
  nowIso,
  pruneBackups,
  writeDb,
  type DatabaseData,
  type StoredAiProposal,
} from './db.ts';

const AI_PROPOSAL_TTL_MS = 3600 * 1000;
const AI_MAX_MSG = 4000;

const VALID_PLATFORM_TYPES: PlatformType[] = [
  'ERP',
  'CRM',
  'Productividad',
  'RRHH',
  'Web',
  'Propia',
  'BI',
  'Seguridad',
  'Comunicaciones',
  'Otro',
];

const VALID_PLATFORM_STATUS: PlatformStatus[] = [
  'Operativo',
  'Mantenimiento',
  'Desconectado',
  'Deshabilitado',
];

const PERM_LABELS: Record<string, Record<string, string>> = {
  usuarios: {
    ver: 'Ver usuarios',
    crear: 'Crear usuarios',
    editar: 'Editar usuarios',
    eliminar: 'Eliminar/dar de baja',
  },
  plataformas: {
    ver: 'Ver plataformas',
    crear: 'Agregar plataformas',
    editar: 'Editar plataformas y API',
    importar: 'Importar planillas',
  },
  reportes: { ver: 'Ver reportes', exportar: 'Exportar reportes' },
  bajas: { ver: 'Ver bajas', gestionar: 'Gestionar bajas' },
  audit: { ver: 'Ver audit log' },
  configuracion: {
    ver: 'Ver configuración',
    gestionar: 'Gestionar sistema y roles',
    servicio: 'Configurar servicio y respaldos',
    asistente: 'Usar asistente IA',
  },
};

const SENSITIVE_PERMS: Record<string, string> = {
  'configuracion.servicio': 'Permite administrar parámetros del servicio, respaldos y restauraciones.',
  'configuracion.gestionar': 'Permite gestionar operadores del sistema y modificar roles.',
  'configuracion.asistente': 'Permite consultar y generar propuestas en el asistente IA.',
};

interface PrepResult {
  errors: string[];
  warnings: string[];
  params: Record<string, unknown>;
  before: Record<string, unknown>;
  changes: AiProposalChange[];
  sensitive: boolean;
  restart: boolean;
}

function newPrep(): PrepResult {
  return {
    errors: [],
    warnings: [],
    params: {},
    before: {},
    changes: [],
    sensitive: false,
    restart: false,
  };
}

function toBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  return ['1', 'true', 'si', 'sí', 'yes', 'y', 'on', 'activar', 'activada', 'activo', 'enabled'].includes(
    String(v ?? '').trim().toLowerCase(),
  );
}

function fmtVal(v: unknown): string {
  if (typeof v === 'boolean') return v ? 'Sí' : 'No';
  if (v === null || v === undefined || v === '') return '—';
  return String(v);
}

/* ── Sanitized Context (Zero PII, Zero Credentials) ───────────────────── */
export function aiBuildContext(db: DatabaseData) {
  const plats = db.platforms.map((p) => {
    const api = db.apiConfigs.find((c) => c.platformId === p.id);
    const imports = db.platformImports.filter((pi) => pi.platformId === p.id);
    const matched = imports.filter((pi) => pi.matchStatus === 'encontrado').length;
    return {
      nombre: p.id,
      etiqueta: p.name,
      tipo: p.type,
      estado: p.status,
      abreviatura: p.abbr,
      color: p.colorHex,
      es_predeterminada: Boolean(p.isDefault),
      obligatoria_activos: p.requiredForActive,
      columnas_plantilla: p.colMap || '',
      api: api
        ? {
            tipo: api.apiType,
            autenticacion: api.authType,
            sync_automatica: api.syncEnabled,
            intervalo_horas: api.syncInterval,
            ultima_sync: api.lastSync || null,
            estado_ultima_sync: api.lastSyncStatus || null,
            mapeo_campos: api.fieldMap || {},
          }
        : null,
      cruce: {
        registros: imports.length,
        cruzados: matched,
        sin_cruce: imports.length - matched,
      },
    };
  });

  const roles = db.sysRoles.map((r) => ({
    nombre: r.name,
    descripcion: r.description,
    es_del_sistema: r.isSystem,
    permisos: r.permissions,
  }));

  const stats = {
    total_identidades: db.users.length,
    activos: db.users.filter((u) => u.status === 'Activo').length,
    en_baja: db.users.filter((u) => u.status === 'En proceso de baja').length,
    inactivos: db.users.filter((u) => u.status === 'Inactivo').length,
    bajas_abiertas: db.offboardings.filter((o) => o.status === 'En proceso').length,
  };

  return {
    servicio: {
      org_name: db.settings.orgName,
      notify_email: db.settings.alertEmail,
      grace_days: db.settings.graceDays,
      session_hours: db.settings.sessionHours,
      scheduler_check_minutes: db.settings.schedulerCheckMinutes,
      backup_retention: db.settings.backupRetention,
      sync_frequency: db.settings.syncFrequency,
      auth_mode: db.settings.authMode,
      auto_flag_offboarding: db.settings.autoFlagOffboarding,
    },
    resumen_agregado: stats,
    plataformas: plats,
    roles,
  };
}

function buildSystemInstruction(db: DatabaseData): string {
  const ctx = aiBuildContext(db);
  return `Eres el asistente de configuración de UserSync (v${APP_VERSION}), una plataforma corporativa de gestión de identidades y consolidación de accesos.
Ayudas al administrador a revisar y proponer ajustes sobre PARÁMETROS del sistema. Responde siempre en español, claro, conciso y profesional.

REGLAS ESTRICTAS:
1. Tú NO aplicas cambios directamente: propones y el administrador confirma o descarta cada propuesta. Propón únicamente lo que el usuario pidió.
2. Usa únicamente los nombres de plataformas ("nombre") y roles que aparecen en el ESTADO ACTUAL. No inventes identificadores.
3. Si falta información o la petición es ambigua, pregunta en "message" y deja "proposals" vacío.
4. NO puedes modificar código fuente, URLs de API, contraseñas, tokens, credenciales, ni ver/editar datos personales de colaboradores. Si te piden algo fuera de tu alcance, explica brevemente en qué pantalla del sistema se realiza.
5. Nunca pidas ni menciones claves, secretos o tokens.
6. Advierte riesgos relevantes (ej. asignar permisos sensibles de servicio o gestión de roles).
7. Las consultas informativas sobre el estado actual respóndelas usando el ESTADO ACTUAL con "proposals": [].

ACCIONES DISPONIBLES (coloca los parámetros en "paramsJson" como JSON válido):
- set_service_params: subconjunto de { org_name (máx 80), notify_email (email), grace_days (0-90), session_hours (1-168), scheduler_check_minutes (1-60), backup_retention (3-100), auto_flag_offboarding (true/false) }.
- set_api_sync: { platform, sync_enabled (true/false), sync_interval (1-720 horas) }. Solo plataformas con API configurada.
- set_api_field_map: { platform, field_map: { campo: "ruta.en.json" } }. Campos comunes: email, name, id, status. Valor vacío "" elimina el mapeo.
- set_platform_meta: { platform, type, status ("Operativo"|"Mantenimiento"|"Desconectado"|"Deshabilitado"), abbr (1-5 alfanum), color ("#RRGGBB"), notes, col_map ("col1,col2,..."), required_for_active (true/false) }. En plataformas predeterminadas no se cambian abbr ni color.
- set_role_permissions: { role, permissions: { modulo: { accion: true/false } } }. Solo roles que no sean del sistema (es_del_sistema = false).
- create_role: { name, description, permissions: { modulo: { accion: true } } }.
- create_backup: { note }.

Tipos válidos: ${VALID_PLATFORM_TYPES.join(', ')}
Catálogo de permisos: ${JSON.stringify(
    Object.fromEntries(Object.entries(PERM_LABELS).map(([m, acts]) => [m, Object.keys(acts)])),
  )}

ESTADO ACTUAL (JSON):
${JSON.stringify(ctx)}`;
}

/* ── Preparation & Validation per Action ──────────────────────────────── */

function prepServiceParams(db: DatabaseData, p: Record<string, unknown>): PrepResult {
  const r = newPrep();
  const allowed = new Set([
    'org_name',
    'notify_email',
    'grace_days',
    'session_hours',
    'scheduler_check_minutes',
    'backup_retention',
    'auto_flag_offboarding',
  ]);
  const unknown = Object.keys(p).filter((k) => !allowed.has(k));
  if (unknown.length > 0) r.errors.push(`Parámetros no permitidos: ${unknown.join(', ')}`);

  const clean: Record<string, unknown> = {};
  if ('org_name' in p) {
    const v = String(p.org_name ?? '').trim();
    if (!v || v.length > 80) r.errors.push('org_name debe tener entre 1 y 80 caracteres.');
    else clean.orgName = v;
  }
  if ('notify_email' in p) {
    const v = String(p.notify_email ?? '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) r.errors.push('notify_email debe ser un correo válido.');
    else clean.alertEmail = v;
  }
  if ('grace_days' in p) {
    const n = Number(p.grace_days);
    if (!Number.isInteger(n) || n < 0 || n > 90) r.errors.push('grace_days debe estar entre 0 y 90.');
    else clean.graceDays = n;
  }
  if ('session_hours' in p) {
    const n = Number(p.session_hours);
    if (!Number.isInteger(n) || n < 1 || n > 168) r.errors.push('session_hours debe estar entre 1 y 168.');
    else clean.sessionHours = n;
  }
  if ('scheduler_check_minutes' in p) {
    const n = Number(p.scheduler_check_minutes);
    if (!Number.isInteger(n) || n < 1 || n > 60) r.errors.push('scheduler_check_minutes debe estar entre 1 y 60.');
    else clean.schedulerCheckMinutes = n;
  }
  if ('backup_retention' in p) {
    const n = Number(p.backup_retention);
    if (!Number.isInteger(n) || n < 3 || n > 100) r.errors.push('backup_retention debe estar entre 3 y 100.');
    else clean.backupRetention = n;
  }
  if ('auto_flag_offboarding' in p) {
    clean.autoFlagOffboarding = toBool(p.auto_flag_offboarding);
  }

  if (Object.keys(clean).length === 0 && r.errors.length === 0) {
    r.errors.push('La propuesta no indica ningún parámetro válido.');
  }
  if (r.errors.length > 0) return r;

  const labels: Record<string, string> = {
    orgName: 'Nombre de la organización',
    alertEmail: 'Email de notificaciones',
    graceDays: 'Días de gracia en bajas',
    sessionHours: 'Duración de la sesión (h)',
    schedulerCheckMinutes: 'Frecuencia revisión scheduler (min)',
    backupRetention: 'Respaldos a conservar',
    autoFlagOffboarding: 'Marcar bajas automáticamente',
  };

  for (const [k, val] of Object.entries(clean)) {
    const cur = (db.settings as unknown as Record<string, unknown>)[k];
    if (cur !== val) {
      r.changes.push({ label: labels[k] || k, current: fmtVal(cur), new: fmtVal(val) });
      r.params[k] = val;
      r.before[k] = cur;
    }
  }
  return r;
}

function prepApiSync(db: DatabaseData, p: Record<string, unknown>): PrepResult {
  const r = newPrep();
  const platform = String(p.platform ?? '').trim();
  const cfg = db.apiConfigs.find((c) => c.platformId.toLowerCase() === platform.toLowerCase());
  if (!cfg) {
    r.errors.push(`La plataforma «${platform}» no existe o no tiene API configurada.`);
    return r;
  }
  const updates: Record<string, unknown> = {};
  if ('sync_enabled' in p) updates.syncEnabled = toBool(p.sync_enabled);
  if ('sync_interval' in p) {
    const iv = Number(p.sync_interval);
    if (!Number.isInteger(iv) || iv < 1 || iv > 720) {
      r.errors.push('El intervalo de sincronización debe estar entre 1 y 720 horas.');
    } else {
      updates.syncInterval = iv;
    }
  }
  if (r.errors.length > 0) return r;
  if (updates.syncEnabled !== undefined && cfg.syncEnabled !== updates.syncEnabled) {
    r.changes.push({
      label: `${cfg.platformId}: sincronización automática`,
      current: fmtVal(cfg.syncEnabled),
      new: fmtVal(updates.syncEnabled),
    });
  }
  if (updates.syncInterval !== undefined && cfg.syncInterval !== updates.syncInterval) {
    r.changes.push({
      label: `${cfg.platformId}: intervalo (horas)`,
      current: fmtVal(cfg.syncInterval),
      new: fmtVal(updates.syncInterval),
    });
  }
  r.params = { platformId: cfg.platformId, ...updates };
  r.before = { platformId: cfg.platformId, syncEnabled: cfg.syncEnabled, syncInterval: cfg.syncInterval };
  return r;
}

function prepApiFieldMap(db: DatabaseData, p: Record<string, unknown>): PrepResult {
  const r = newPrep();
  const platform = String(p.platform ?? '').trim();
  const cfg = db.apiConfigs.find((c) => c.platformId.toLowerCase() === platform.toLowerCase());
  if (!cfg) {
    r.errors.push(`La plataforma «${platform}» no existe o no tiene API configurada.`);
    return r;
  }
  const fm = p.field_map;
  if (!fm || typeof fm !== 'object' || Array.isArray(fm)) {
    r.errors.push('field_map debe ser un objeto con rutas JSON.');
    return r;
  }
  const oldMap = { ...(cfg.fieldMap || {}) };
  const newMap = { ...oldMap };
  for (const [kRaw, vRaw] of Object.entries(fm as Record<string, unknown>)) {
    const k = kRaw.trim();
    const v = vRaw === null || vRaw === undefined ? '' : String(vRaw).trim();
    if (!/^[A-Za-z][A-Za-z0-9_]{0,30}$/.test(k)) {
      r.errors.push(`Nombre de campo inválido: «${k}».`);
      continue;
    }
    if (v === '') {
      delete newMap[k];
    } else if (!/^[A-Za-z0-9_.\-\[\]@$ ]{1,80}$/.test(v)) {
      r.errors.push(`Ruta de campo inválida para «${k}»: «${v}».`);
    } else {
      newMap[k] = v;
    }
  }
  if (r.errors.length > 0) return r;

  const allKeys = Array.from(new Set([...Object.keys(oldMap), ...Object.keys(newMap)])).sort();
  for (const k of allKeys) {
    if (oldMap[k] !== newMap[k]) {
      r.changes.push({
        label: `${cfg.platformId}: campo «${k}»`,
        current: oldMap[k] || '(por defecto)',
        new: newMap[k] || '(por defecto)',
      });
    }
  }
  r.params = { platformId: cfg.platformId, fieldMap: newMap };
  r.before = { platformId: cfg.platformId, fieldMap: oldMap };
  return r;
}

function prepPlatformMeta(db: DatabaseData, p: Record<string, unknown>): PrepResult {
  const r = newPrep();
  const platformName = String(p.platform ?? '').trim();
  const plat = db.platforms.find(
    (pl) => pl.id.toLowerCase() === platformName.toLowerCase() || pl.name.toLowerCase() === platformName.toLowerCase(),
  );
  if (!plat) {
    r.errors.push(`La plataforma «${platformName}» no existe.`);
    return r;
  }

  const next: Record<string, unknown> = {};
  const prev: Record<string, unknown> = {};

  if ('type' in p) {
    const matched = VALID_PLATFORM_TYPES.find((t) => t.toLowerCase() === String(p.type).trim().toLowerCase());
    if (!matched) r.errors.push(`Tipo inválido. Opciones: ${VALID_PLATFORM_TYPES.join(', ')}`);
    else {
      next.type = matched;
      prev.type = plat.type;
    }
  }
  if ('status' in p) {
    const matched = VALID_PLATFORM_STATUS.find((s) => s.toLowerCase() === String(p.status).trim().toLowerCase());
    if (!matched) r.errors.push(`Estado inválido. Opciones: ${VALID_PLATFORM_STATUS.join(', ')}`);
    else {
      next.status = matched;
      prev.status = plat.status;
    }
  }
  if ('abbr' in p) {
    const v = String(p.abbr ?? '').trim().toUpperCase();
    if (plat.isDefault) r.errors.push('Las plataformas predeterminadas tienen abreviatura fija.');
    else if (!/^[A-Z0-9]{1,5}$/.test(v)) r.errors.push('La abreviatura debe tener de 1 a 5 caracteres alfanuméricos.');
    else {
      next.abbr = v;
      prev.abbr = plat.abbr;
    }
  }
  if ('color' in p) {
    const v = String(p.color ?? '').trim().toUpperCase();
    if (plat.isDefault) r.errors.push('Las plataformas predeterminadas tienen color fijo.');
    else if (!/^#[0-9A-F]{6}$/.test(v)) r.errors.push('El color debe tener formato #RRGGBB.');
    else {
      next.colorHex = v;
      prev.colorHex = plat.colorHex;
    }
  }
  if ('notes' in p) {
    const v = String(p.notes ?? '').trim();
    if (v.length > 500) r.errors.push('Las notas no pueden superar 500 caracteres.');
    else {
      next.notes = v;
      prev.notes = plat.notes || '';
    }
  }
  if ('col_map' in p) {
    const cols = String(p.col_map ?? '')
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);
    if (cols.length > 40) r.errors.push('Máximo 40 columnas en col_map.');
    else {
      next.colMap = cols.join(',');
      prev.colMap = plat.colMap || '';
    }
  }
  if ('required_for_active' in p) {
    next.requiredForActive = toBool(p.required_for_active);
    prev.requiredForActive = plat.requiredForActive;
  }

  if (r.errors.length > 0) return r;

  const labels: Record<string, string> = {
    type: 'Tipo',
    status: 'Estado',
    abbr: 'Abreviatura',
    colorHex: 'Color',
    notes: 'Notas',
    colMap: 'Columnas de plantilla',
    requiredForActive: 'Obligatoria para activos',
  };

  for (const [k, v] of Object.entries(next)) {
    if (prev[k] !== v) {
      r.changes.push({ label: `${plat.id}: ${labels[k] || k}`, current: fmtVal(prev[k]), new: fmtVal(v) });
    }
  }
  r.params = { platformId: plat.id, ...next };
  r.before = { platformId: plat.id, ...prev };
  return r;
}

function validatePermMap(permIn: unknown, errors: string[]): Record<string, Record<string, boolean>> {
  const out: Record<string, Record<string, boolean>> = {};
  if (!permIn || typeof permIn !== 'object' || Array.isArray(permIn)) {
    errors.push('permissions debe indicar al menos un permiso.');
    return out;
  }
  for (const [mod, acts] of Object.entries(permIn as Record<string, unknown>)) {
    if (!(mod in PERM_LABELS) || !acts || typeof acts !== 'object' || Array.isArray(acts)) {
      errors.push(`Módulo de permisos inválido: «${mod}».`);
      continue;
    }
    for (const [act, val] of Object.entries(acts as Record<string, unknown>)) {
      if (!(act in PERM_LABELS[mod])) {
        errors.push(`Acción inválida «${act}» en «${mod}».`);
      } else {
        out[mod] = out[mod] || {};
        out[mod][act] = toBool(val);
      }
    }
  }
  return out;
}

function prepRolePermissions(db: DatabaseData, p: Record<string, unknown>): PrepResult {
  const r = newPrep();
  r.sensitive = true;
  const roleName = String(p.role ?? '').trim();
  const role = db.sysRoles.find((sr) => sr.name.toLowerCase() === roleName.toLowerCase());
  if (!role) {
    r.errors.push(`El rol «${roleName}» no existe.`);
    return r;
  }
  if (role.isSystem || role.permissions === '*') {
    r.errors.push('Los roles del sistema (Superadmin) no se pueden modificar desde el asistente.');
    return r;
  }

  const delta = validatePermMap(p.permissions, r.errors);
  if (r.errors.length > 0) return r;

  const oldPerms: Record<string, Record<string, boolean>> =
    typeof role.permissions === 'object' && role.permissions ? JSON.parse(JSON.stringify(role.permissions)) : {};
  const newPerms: Record<string, Record<string, boolean>> = JSON.parse(JSON.stringify(oldPerms));

  for (const [mod, acts] of Object.entries(delta)) {
    for (const [act, val] of Object.entries(acts)) {
      const prevVal = Boolean(oldPerms[mod]?.[act]);
      if (val) {
        newPerms[mod] = newPerms[mod] || {};
        newPerms[mod][act] = true;
      } else if (newPerms[mod]) {
        delete newPerms[mod][act];
        if (Object.keys(newPerms[mod]).length === 0) delete newPerms[mod];
      }
      if (prevVal !== val) {
        r.changes.push({
          label: `${role.name}: ${PERM_LABELS[mod][act]}`,
          current: fmtVal(prevVal),
          new: fmtVal(val),
        });
        if (val && SENSITIVE_PERMS[`${mod}.${act}`]) {
          r.warnings.push(`Permiso sensible «${PERM_LABELS[mod][act]}»: ${SENSITIVE_PERMS[`${mod}.${act}`]}`);
        }
      }
    }
  }

  const usersCount = db.sysUsers.filter((su) => su.roleId === role.id).length;
  if (usersCount > 0) {
    r.warnings.push(`${usersCount} operador(es) tienen asignado este rol y recibirán el cambio de inmediato.`);
  }
  r.params = { roleId: role.id, roleName: role.name, permissions: newPerms };
  r.before = { roleId: role.id, roleName: role.name, permissions: oldPerms };
  return r;
}

function prepCreateRole(db: DatabaseData, p: Record<string, unknown>): PrepResult {
  const r = newPrep();
  r.sensitive = true;
  const name = String(p.name ?? '').trim();
  const description = String(p.description ?? '').trim().slice(0, 120);
  if (!/^[A-Za-z0-9 _.\-áéíóúÁÉÍÓÚñÑ]{2,40}$/.test(name)) {
    r.errors.push('El nombre del rol debe tener entre 2 y 40 caracteres.');
  }
  if (db.sysRoles.some((sr) => sr.name.toLowerCase() === name.toLowerCase())) {
    r.errors.push(`Ya existe un rol llamado «${name}».`);
  }
  const parsedPerms = validatePermMap(p.permissions, r.errors);
  if (r.errors.length > 0) return r;

  const cleanPerms: Record<string, Record<string, boolean>> = {};
  const permDescriptions: string[] = [];
  for (const [mod, acts] of Object.entries(parsedPerms)) {
    for (const [act, val] of Object.entries(acts)) {
      if (val) {
        cleanPerms[mod] = cleanPerms[mod] || {};
        cleanPerms[mod][act] = true;
        permDescriptions.push(PERM_LABELS[mod][act]);
        if (SENSITIVE_PERMS[`${mod}.${act}`]) {
          r.warnings.push(`Permiso sensible «${PERM_LABELS[mod][act]}»: ${SENSITIVE_PERMS[`${mod}.${act}`]}`);
        }
      }
    }
  }
  r.changes = [
    { label: 'Nuevo rol', current: '—', new: name },
    { label: 'Permisos asignados', current: '—', new: permDescriptions.join(', ') || '(ninguno)' },
  ];
  r.params = { name, description, permissions: cleanPerms };
  return r;
}

function prepCreateBackup(p: Record<string, unknown>): PrepResult {
  const r = newPrep();
  const note = String(p.note ?? '').trim().slice(0, 120);
  r.changes = [
    {
      label: 'Respaldo completo del sistema',
      current: '—',
      new: `Crear snapshot JSON en data/backups/${note ? ` (${note})` : ''}`,
    },
  ];
  r.params = { note };
  return r;
}

interface ActionSpec {
  title: string;
  perm: [string, string];
  undo: boolean;
  prep: (db: DatabaseData, p: Record<string, unknown>) => PrepResult;
}

const AI_ACTIONS: Record<string, ActionSpec> = {
  set_service_params: {
    title: 'Cambiar parámetros del servicio',
    perm: ['configuracion', 'servicio'],
    undo: true,
    prep: prepServiceParams,
  },
  set_api_sync: {
    title: 'Ajustar sincronización automática de API',
    perm: ['plataformas', 'editar'],
    undo: true,
    prep: prepApiSync,
  },
  set_api_field_map: {
    title: 'Ajustar mapeo de campos de API',
    perm: ['plataformas', 'editar'],
    undo: true,
    prep: prepApiFieldMap,
  },
  set_platform_meta: {
    title: 'Modificar metadatos de plataforma',
    perm: ['plataformas', 'editar'],
    undo: true,
    prep: prepPlatformMeta,
  },
  set_role_permissions: {
    title: 'Modificar permisos de rol',
    perm: ['configuracion', 'gestionar'],
    undo: true,
    prep: prepRolePermissions,
  },
  create_role: {
    title: 'Crear nuevo rol de acceso',
    perm: ['configuracion', 'gestionar'],
    undo: true,
    prep: prepCreateRole,
  },
  create_backup: {
    title: 'Crear respaldo del sistema',
    perm: ['configuracion', 'servicio'],
    undo: false,
    prep: (_db, p) => prepCreateBackup(p),
  },
};

function applyValidatedAction(db: DatabaseData, action: string, p: Record<string, unknown>): { message: string } {
  if (action === 'set_service_params') {
    for (const [k, v] of Object.entries(p)) {
      (db.settings as unknown as Record<string, unknown>)[k] = v;
    }
    if (typeof p.backupRetention === 'number') pruneBackups(p.backupRetention);
    return { message: 'Parámetros del servicio actualizados.' };
  }
  if (action === 'set_api_sync') {
    const cfg = db.apiConfigs.find((c) => c.platformId === p.platformId);
    if (!cfg) throw new Error('Configuración API no encontrada.');
    if (typeof p.syncEnabled === 'boolean') cfg.syncEnabled = p.syncEnabled;
    if (typeof p.syncInterval === 'number') cfg.syncInterval = p.syncInterval;
    cfg.updatedAt = nowIso();
    return { message: `Sincronización automática de ${cfg.platformId} actualizada.` };
  }
  if (action === 'set_api_field_map') {
    const cfg = db.apiConfigs.find((c) => c.platformId === p.platformId);
    if (!cfg) throw new Error('Configuración API no encontrada.');
    cfg.fieldMap = (p.fieldMap as Record<string, string>) || {};
    cfg.updatedAt = nowIso();
    return { message: `Mapeo de campos de ${cfg.platformId} actualizado.` };
  }
  if (action === 'set_platform_meta') {
    const plat = db.platforms.find((pl) => pl.id === p.platformId);
    if (!plat) throw new Error('Plataforma no encontrada.');
    if (p.type) plat.type = p.type as PlatformType;
    if (p.status) plat.status = p.status as PlatformStatus;
    if (p.abbr) plat.abbr = String(p.abbr);
    if (p.colorHex) plat.colorHex = String(p.colorHex);
    if ('notes' in p) plat.notes = String(p.notes ?? '');
    if ('colMap' in p) plat.colMap = String(p.colMap ?? '');
    if (typeof p.requiredForActive === 'boolean') plat.requiredForActive = p.requiredForActive;
    return { message: `Metadatos de ${plat.name} actualizados.` };
  }
  if (action === 'set_role_permissions') {
    const role = db.sysRoles.find((sr) => sr.id === p.roleId);
    if (!role || role.isSystem) throw new Error('Rol no editable.');
    role.permissions = (p.permissions as Record<string, Record<string, boolean>>) || {};
    return { message: `Permisos del rol ${role.name} actualizados.` };
  }
  if (action === 'create_role') {
    const name = String(p.name);
    if (db.sysRoles.some((sr) => sr.name.toLowerCase() === name.toLowerCase())) {
      throw new Error(`Ya existe un rol llamado «${name}».`);
    }
    db.sysRoles.push({
      id: `role-${Date.now()}`,
      name,
      description: String(p.description || ''),
      permissions: (p.permissions as Record<string, Record<string, boolean>>) || {},
      isSystem: false,
      createdAt: nowIso(),
    });
    return { message: `Rol «${name}» creado correctamente.` };
  }
  if (action === 'create_backup') {
    const fname = makeBackup(db, 'manual', `Asistente IA: ${String(p.note || 'respaldo solicitado')}`);
    return { message: `Respaldo creado: ${fname}` };
  }
  throw new Error('Acción no reconocida.');
}

function registerProposal(
  db: DatabaseData,
  authUser: AuthUser,
  rawAction: string,
  rawParams: Record<string, unknown>,
  rawReason: string,
): AiProposalCard {
  const action = String(rawAction || '').trim();
  const reason = String(rawReason || '').slice(0, 300);
  const spec = AI_ACTIONS[action];
  if (!spec) {
    return {
      id: null,
      action,
      title: 'Propuesta no permitida',
      reason,
      changes: [],
      warnings: [],
      errors: [`La acción «${action}» no está dentro del catálogo permitido.`],
      sensitive: false,
      restart: false,
      canApply: false,
    };
  }

  const prep = spec.prep(db, rawParams);
  if (!hasPerm(authUser, spec.perm[0], spec.perm[1])) {
    prep.errors.push('Tu rol actual no tiene permisos suficientes para aplicar este cambio.');
  }
  if (prep.errors.length > 0 || prep.changes.length === 0) {
    if (prep.errors.length === 0) {
      prep.warnings.push('No hay diferencias que aplicar respecto al estado actual.');
    }
    return {
      id: null,
      action,
      title: spec.title,
      reason,
      changes: prep.changes,
      warnings: prep.warnings,
      errors: prep.errors,
      sensitive: prep.sensitive,
      restart: prep.restart,
      canApply: false,
    };
  }

  const pid = crypto.randomBytes(8).toString('hex');
  const stored: StoredAiProposal = {
    id: pid,
    userId: authUser.id,
    action,
    params: rawParams,
    before: prep.before,
    summary: {
      title: spec.title,
      reason,
      changes: prep.changes,
      warnings: prep.warnings,
      sensitive: prep.sensitive,
      restart: prep.restart,
    },
    status: 'pendiente',
    createdAt: nowIso(),
  };

  db.aiProposals = [stored, ...db.aiProposals].slice(0, 100);
  return {
    id: pid,
    action,
    title: spec.title,
    reason,
    changes: prep.changes,
    warnings: prep.warnings,
    errors: [],
    sensitive: prep.sensitive,
    restart: prep.restart,
    canApply: true,
    status: 'pendiente',
    undoable: spec.undo,
  };
}

/* ── Public Assistant Handlers ────────────────────────────────────────── */

export function getAssistantHistory(db: DatabaseData, authUser: AuthUser): AiProposalCard[] {
  return db.aiProposals
    .filter((p) => p.userId === authUser.id && (p.status === 'aplicada' || p.status === 'deshecha'))
    .slice(0, 12)
    .map((p) => ({
      id: p.id,
      action: p.action,
      title: p.summary.title,
      reason: p.summary.reason,
      changes: p.summary.changes,
      warnings: p.summary.warnings,
      errors: [],
      sensitive: p.summary.sensitive,
      restart: p.summary.restart,
      canApply: false,
      status: p.status,
      undoable: p.status === 'aplicada' && Boolean(AI_ACTIONS[p.action]?.undo),
      appliedAt: p.appliedAt,
    }));
}

export async function runAssistantChat(
  db: DatabaseData,
  authUser: AuthUser,
  messages: { role: 'user' | 'assistant'; content: string }[],
): Promise<{ reply: string; proposals: AiProposalCard[] }> {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY no está configurada en el servidor. Configura el secreto en AI Studio para habilitar el asistente.',
    );
  }

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
  });

  const cleanHistory = messages
    .slice(-10)
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content.slice(0, AI_MAX_MSG) }],
    }));

  if (cleanHistory.length === 0) {
    throw new Error('Escribe una consulta para el asistente.');
  }

  const response = await ai.models.generateContent({
    model: 'gemini-4-hydrogen',
    contents: cleanHistory,
    config: {
      systemInstruction: buildSystemInstruction(db),
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          message: {
            type: Type.STRING,
            description: 'Respuesta clara y breve en español para el administrador.',
          },
          proposals: {
            type: Type.ARRAY,
            description: 'Lista opcional de cambios propuestos (máximo 6). Vacía si solo es consulta.',
            items: {
              type: Type.OBJECT,
              properties: {
                action: { type: Type.STRING, description: 'Nombre exacto de la acción permitida.' },
                reason: { type: Type.STRING, description: 'Explicación breve del porqué del cambio.' },
                paramsJson: {
                  type: Type.STRING,
                  description: 'Objeto JSON serializado con los parámetros exactos de la acción.',
                },
              },
              required: ['action', 'reason', 'paramsJson'],
            },
          },
        },
        required: ['message', 'proposals'],
      },
    },
  });

  const rawText = (response.text || '').trim();
  let parsed: { message?: string; proposals?: { action: string; reason: string; paramsJson: string }[] } = {};
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return {
      reply: rawText.slice(0, AI_MAX_MSG) || 'No se recibió una respuesta estructurada del modelo.',
      proposals: [],
    };
  }

  const cards: AiProposalCard[] = [];
  const rawProps = Array.isArray(parsed.proposals) ? parsed.proposals.slice(0, 6) : [];
  for (const pr of rawProps) {
    let paramsObj: Record<string, unknown> = {};
    try {
      const candidate = JSON.parse(pr.paramsJson || '{}');
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
        paramsObj = candidate as Record<string, unknown>;
      }
    } catch {
      paramsObj = {};
    }
    cards.push(registerProposal(db, authUser, pr.action, paramsObj, pr.reason));
  }

  addAudit(db, 'ai_assistant', `Consulta al asistente IA (${cards.length} propuesta(s) generadas)`, authUser.email);
  writeDb(db);

  return {
    reply: String(parsed.message || '').slice(0, AI_MAX_MSG),
    proposals: cards,
  };
}

export function applyProposal(
  db: DatabaseData,
  authUser: AuthUser,
  proposalId: string,
): { message: string; undoable: boolean } {
  const row = db.aiProposals.find((p) => p.id === proposalId && p.userId === authUser.id);
  if (!row) throw new Error('Propuesta no encontrada.');
  if (row.status !== 'pendiente') throw new Error(`La propuesta ya fue ${row.status}.`);
  if (Date.now() - new Date(row.createdAt).getTime() > AI_PROPOSAL_TTL_MS) {
    row.status = 'expirada';
    writeDb(db);
    throw new Error('La propuesta expiró (más de 1 hora). Solicítala nuevamente al asistente.');
  }

  const spec = AI_ACTIONS[row.action];
  if (!spec || !hasPerm(authUser, spec.perm[0], spec.perm[1])) {
    throw new Error('Tu rol no tiene permiso para aplicar este cambio.');
  }

  const prep = spec.prep(db, row.params);
  if (prep.errors.length > 0) {
    throw new Error(`La propuesta ya no es aplicable: ${prep.errors.join('; ')}`);
  }

  const res = applyValidatedAction(db, row.action, prep.params);
  row.status = 'aplicada';
  row.appliedAt = nowIso();
  row.before = prep.before;
  row.result = res.message;

  const summaryStr = prep.changes.map((c) => `${c.label}: ${c.current} → ${c.new}`).join('; ').slice(0, 350);
  addAudit(db, 'ai_assistant', `Asistente IA aplicado (${spec.title}): ${summaryStr}`, authUser.email);
  writeDb(db);

  return { message: res.message, undoable: spec.undo };
}

export function discardProposal(db: DatabaseData, authUser: AuthUser, proposalId: string): void {
  const row = db.aiProposals.find((p) => p.id === proposalId && p.userId === authUser.id);
  if (!row || row.status !== 'pendiente') throw new Error('La propuesta no está pendiente.');
  row.status = 'descartada';
  writeDb(db);
}

export function undoProposal(
  db: DatabaseData,
  authUser: AuthUser,
  proposalId: string,
): { message: string } {
  const row = db.aiProposals.find((p) => p.id === proposalId && p.userId === authUser.id);
  const spec = row ? AI_ACTIONS[row.action] : undefined;
  if (!row || !spec || !spec.undo || row.status !== 'aplicada') {
    throw new Error('Este cambio no se puede deshacer.');
  }
  if (!hasPerm(authUser, spec.perm[0], spec.perm[1])) {
    throw new Error('Tu rol no tiene permiso para deshacer este cambio.');
  }

  if (row.action === 'create_role') {
    const roleName = String(row.params.name ?? '');
    const role = db.sysRoles.find((r) => r.name.toLowerCase() === roleName.toLowerCase());
    if (role) {
      const inUse = db.sysUsers.filter((su) => su.roleId === role.id).length;
      if (inUse > 0) {
        throw new Error(`No se puede deshacer: ${inUse} operador(es) están usando el rol «${role.name}».`);
      }
      db.sysRoles = db.sysRoles.filter((r) => r.id !== role.id);
    }
  } else {
    applyValidatedAction(db, row.action, row.before);
  }

  row.status = 'deshecha';
  addAudit(db, 'ai_assistant', `Cambio de Asistente IA deshecho: ${row.summary.title}`, authUser.email);
  writeDb(db);
  return { message: `Cambio deshecho: ${row.summary.title}` };
}
