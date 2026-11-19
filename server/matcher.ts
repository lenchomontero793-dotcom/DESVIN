import type { MatchMethod, Platform, PlatformImportRow, User } from '../src/types.ts';
import {
  addAudit,
  buildUsername,
  nowIso,
  type DatabaseData,
} from './db.ts';

export function normStr(s: string): string {
  if (!s) return '';
  return s
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ñ/g, 'n')
    .replace(/\s+/g, ' ');
}

export function normRut(s: string): string {
  if (!s) return '';
  return s.toLowerCase().replace(/[.\-\s]/g, '').trim();
}

export function normEmail(s: string): string {
  return (s || '').toLowerCase().trim();
}

export function splitNameVariants(fullName: string): string[] {
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

export interface DirectoryIndices {
  byEmail: Map<string, string>;
  byEmailLocal: Map<string, string>;
  byRut: Map<string, string>;
  byName: Map<string, string>;
}

export function buildDirectoryIndices(users: User[]): DirectoryIndices {
  const byEmail = new Map<string, string>();
  const byEmailLocal = new Map<string, string>();
  const byRut = new Map<string, string>();
  const byName = new Map<string, string>();

  for (const u of users) {
    if (u.email) {
      const em = normEmail(u.email);
      byEmail.set(em, u.id);
      const local = em.split('@')[0];
      if (local && local.length > 3) {
        byEmailLocal.set(local, u.id);
        const localFlat = local.replace(/[._-]/g, '');
        if (localFlat.length > 3) {
          byEmailLocal.set(localFlat, u.id);
        }
      }
    }
    if (u.rut) {
      const rn = normRut(u.rut);
      if (rn.length > 3) byRut.set(rn, u.id);
    }
    if (u.name) {
      for (const variant of splitNameVariants(u.name)) {
        byName.set(variant, u.id);
      }
    }
  }

  return { byEmail, byEmailLocal, byRut, byName };
}

export function matchRow6Levels(
  indices: DirectoryIndices,
  rawEmail: string,
  rawRut: string,
  rawName: string,
  rawAccount: string,
): { userId?: string; method?: MatchMethod } {
  // 1) Exact email
  if (rawEmail) {
    const em = normEmail(rawEmail);
    const id = indices.byEmail.get(em);
    if (id) return { userId: id, method: 'email' };
  }

  // 2) Partial email (local part before @)
  if (rawEmail) {
    const local = normEmail(rawEmail).split('@')[0] || '';
    const flatLocal = local.replace(/[._-]/g, '');
    if (local.length > 3) {
      const id = indices.byEmailLocal.get(local) || indices.byEmailLocal.get(flatLocal);
      if (id) return { userId: id, method: 'email_parcial' };
    }
  }

  // 3) Normalized RUT
  if (rawRut) {
    const rn = normRut(rawRut);
    if (rn.length > 3) {
      const id = indices.byRut.get(rn);
      if (id) return { userId: id, method: 'rut' };
    }
  }

  // 4) RUT from account_id
  if (rawAccount) {
    const rn = normRut(rawAccount);
    if (rn.length > 5) {
      const id = indices.byRut.get(rn);
      if (id) return { userId: id, method: 'rut_cuenta' };
    }
  }

  // 5) Normalized full name variants
  if (rawName) {
    for (const variant of splitNameVariants(rawName)) {
      const id = indices.byName.get(variant);
      if (id) return { userId: id, method: 'nombre' };
    }
  }

  // 6) account_id matching email local part
  if (rawAccount && rawAccount.trim().length > 3) {
    const acctNorm = normStr(rawAccount).replace(/\s+/g, '');
    const acctFlat = acctNorm.replace(/[._-]/g, '');
    const id = indices.byEmailLocal.get(acctNorm) || indices.byEmailLocal.get(acctFlat);
    if (id) return { userId: id, method: 'cuenta_usuario' };
  }

  return {};
}

export function runPlatformCrossImport(
  db: DatabaseData,
  platform: Platform,
  rows: Record<string, string>[],
  mode: 'reemplazar' | 'agregar',
  actor: string,
): { total: number; matched: number; unmatched: number } {
  const colEmail = new Set([
    'email', 'correo', 'mail', 'correo_electronico', 'correo electronico',
    'e-mail', 'upn', 'user principal name', 'username', 'login', 'usuario',
    'sf_username', 'user_email', 'useremail', 'emailaddress', 'email address',
  ]);
  const colName = new Set([
    'nombre', 'nombre completo', 'full_name', 'name', 'display name', 'displayname',
    'nombre_completo', 'apellido nombre', 'nombres', 'nombre usuario', 'fullname',
    'employeename', 'employee name', 'user name',
  ]);
  const colRut = new Set([
    'rut', 'rut/dni', 'dni', 'cedula', 'rut_dni', 'employee id', 'employeeid',
    'empleado_id', 'empleado id', 'sap_user', 'sap user', 'id_usuario',
    'id usuario', 'id_empleado', 'id empleado', 'codigo empleado', 'cod_empleado',
    'numero documento', 'num_doc', 'identification', 'rut empleado',
  ]);
  const colAccount = new Set([
    'account', 'cuenta', 'account_id', 'sap_id', 'sf_id', 'o365_id', 'codigo',
    'code', 'issue_id', 'user_id', 'userid', 'id', 'accountname', 'account name',
  ]);
  const colStatus = new Set([
    'estado', 'status', 'activo', 'active', 'habilitado', 'enabled', 'habilitada',
    'state', 'account status',
  ]);

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

  const pick = (row: Record<string, string>, candidates: Set<string>): string => {
    const normCandidates = new Set(Array.from(candidates).map((c) => normStr(c)));
    for (const [k, v] of Object.entries(row)) {
      if (normCandidates.has(normStr(k))) {
        return String(v ?? '').trim();
      }
    }
    return '';
  };

  const allCols = new Set([...colEmail, ...colName, ...colRut, ...colAccount, ...colStatus].map((c) => normStr(c)));

  if (mode === 'reemplazar') {
    db.platformImports = db.platformImports.filter((pi) => pi.platformId !== platform.id);
  }

  const indices = buildDirectoryIndices(db.users);
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

    const extras: Record<string, string> = {};
    for (const [k, v] of Object.entries(row)) {
      if (!allCols.has(normStr(k)) && String(v ?? '').trim()) {
        extras[k] = String(v).trim();
      }
    }

    const match = matchRow6Levels(indices, rawEmail, rawRut, rawName, rawAccount);
    const isMatched = Boolean(match.userId);

    if (isMatched && match.userId) {
      matchedCount++;
      const dirUser = db.users.find((u) => u.id === match.userId);
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
            role: extras.perfil || extras.rol || extras.role || 'Usuario Estándar',
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
      rawExtra: Object.keys(extras).length > 0 ? extras : undefined,
      matchedUserId: match.userId,
      matchMethod: match.method,
      matchStatus: isMatched ? 'encontrado' : 'no_encontrado',
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

  return {
    total: createdRows.length,
    matched: matchedCount,
    unmatched: unmatchedCount,
  };
}

export function runBulkDirectoryImport(
  db: DatabaseData,
  rows: Record<string, string>[],
  mode: 'omitir' | 'actualizar',
  actor: string,
): { ok: number; duplicates: number; errors: string[] } {
  const COL_MAP: Record<string, string[]> = {
    fullName: [
      'nombre', 'nombre completo', 'full_name', 'name', 'nombre_completo',
      'nombres', 'apellido nombre', 'employeename', 'employee name', 'display name', 'displayname',
    ],
    email: [
      'email', 'correo', 'mail', 'correo electronico', 'correo_electronico',
      'upn', 'e-mail', 'emailaddress', 'email address', 'correo corporativo',
    ],
    rut: ['rut', 'rut/dni', 'dni', 'cedula', 'rut_dni', 'identificacion', 'num_doc', 'numero documento', 'id_empleado', 'empleado_id'],
    dept: ['departamento', 'depto', 'area', 'department', 'area/depto', 'gerencia', 'division'],
    position: ['cargo', 'position', 'puesto', 'rol', 'titulo', 'titulo_cargo', 'job title'],
    manager: ['jefe', 'manager', 'jefatura', 'supervisor', 'jefe directo', 'reporta_a'],
    phone: ['telefono', 'phone', 'fono', 'celular', 'movil', 'telefono_celular'],
    hireDate: ['fecha contrato', 'fecha_contrato', 'hire_date', 'fecha ingreso', 'fecha_ingreso', 'fecha inicio', 'start date'],
    notes: ['notas', 'notes', 'observaciones', 'comentarios', 'descripcion'],
  };

  const findCol = (row: Record<string, string>, candidates: string[]): string => {
    const candSet = new Set(candidates.map((c) => normStr(c)));
    for (const [k, v] of Object.entries(row)) {
      if (candSet.has(normStr(k))) return String(v ?? '').trim();
    }
    return '';
  };

  const platLookup = new Map<string, Platform>();
  for (const p of db.platforms) {
    platLookup.set(normStr(p.id), p);
    platLookup.set(normStr(p.name), p);
  }

  let ok = 0;
  let duplicates = 0;
  const errors: string[] = [];

  rows.forEach((row, idx) => {
    const rowNum = idx + 2;
    const name = findCol(row, COL_MAP.fullName);
    const email = normEmail(findCol(row, COL_MAP.email));
    if (!name || !email) {
      errors.push(`Fila ${rowNum}: nombre o email vacío.`);
      return;
    }

    const rut = findCol(row, COL_MAP.rut);
    const dept = findCol(row, COL_MAP.dept) || 'General';
    const position = findCol(row, COL_MAP.position) || 'Colaborador';
    const manager = findCol(row, COL_MAP.manager);
    const phone = findCol(row, COL_MAP.phone);
    const hireDate = findCol(row, COL_MAP.hireDate);
    const notes = findCol(row, COL_MAP.notes);

    const detectedPlatforms: Platform[] = [];
    for (const [k, v] of Object.entries(row)) {
      const plat = platLookup.get(normStr(k));
      if (plat && /^(1|si|sí|yes|x|true|activo)$/i.test(String(v ?? '').trim())) {
        detectedPlatforms.push(plat);
      }
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
      if (manager) existing.manager = manager;
      if (phone) existing.phone = phone;
      if (hireDate) existing.hireDate = hireDate;
      if (notes) existing.notes = notes;
      for (const plat of detectedPlatforms) {
        if (!existing.accounts.some((a) => a.platformId === plat.id)) {
          existing.accounts.push({
            platformId: plat.id,
            username: buildUsername(email, plat.id),
            role: 'Usuario Estándar',
            status: 'Activo',
            lastAccess: 'Importado',
          });
        }
      }
      existing.updatedAt = nowIso();
      addAudit(db, 'user_created', `Importación masiva (actualización): ${existing.name}`, actor, existing.id);
      ok++;
    } else {
      const uid = `u-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const newUser: User = {
        id: uid,
        rut: rut || `20.${Math.floor(100 + Math.random() * 899)}.${Math.floor(100 + Math.random() * 899)}-K`,
        name,
        email,
        dept,
        position,
        manager: manager || undefined,
        phone: phone || undefined,
        hireDate: hireDate || undefined,
        notes: notes || undefined,
        status: 'Activo',
        portalRole: 'USER',
        accounts: detectedPlatforms.map((plat) => ({
          platformId: plat.id,
          username: buildUsername(email, plat.id),
          role: 'Usuario Estándar',
          status: 'Activo',
          lastAccess: 'Importado',
        })),
        lastAccess: 'Nunca',
        sourceMaster: 'Importación Masiva',
        updatedAt: nowIso(),
      };
      db.users.unshift(newUser);
      addAudit(db, 'user_created', `Importación masiva (alta): ${newUser.name}`, actor, uid);
      ok++;
    }
  });

  return { ok, duplicates, errors };
}
