import crypto from 'crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'fs';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import type {
  ApiAuthType,
  ApiType,
  AuthUser,
  ConsolidationPreviewItem,
  ConsolidationPreviewResponse,
  ConsolidationRowInput,
  OffboardingRecord,
  PermissionMatrix,
  Platform,
  PlatformAccount,
  PortalRole,
  SysRole,
  SysUser,
  SystemSettings,
  User,
  UserStatus,
} from './src/types.ts';
import {
  addAudit,
  buildSeedData,
  buildUsername,
  getStateForAuth,
  hasPerm,
  hashPassword,
  makeBackup,
  normalizeStatus,
  nowIso,
  pruneBackups,
  readDb,
  restoreBackup,
  toAuthUserFromDirectory,
  toAuthUserFromSys,
  validateBackupFilename,
  verifyPassword,
  writeDb,
  type StoredApiConfig,
} from './server/db.ts';
import { runBulkDirectoryImport, runPlatformCrossImport } from './server/matcher.ts';
import { doApiOffboard, doApiSync, startApiScheduler, testApiConnection } from './server/apiEngine.ts';
import {
  applyProposal,
  discardProposal,
  getAssistantHistory,
  runAssistantChat,
  undoProposal,
} from './server/assistant.ts';

const PORT = 3000;

interface AuthenticatedRequest extends Request {
  authUser?: AuthUser;
  authToken?: string;
}

function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization || '';
  const queryToken = typeof req.query.token === 'string' ? req.query.token.trim() : '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : queryToken;
  if (!token) {
    res.status(401).json({ error: 'Sesión no iniciada. Por favor ingresa con tu usuario corporativo.' });
    return;
  }

  const db = readDb();
  const session = db.sessions.find((s) => s.token === token);
  if (!session) {
    res.status(401).json({ error: 'Sesión expirada o inválida.' });
    return;
  }

  const maxHours = Math.max(1, db.settings.sessionHours || 8);
  const ageHours = (Date.now() - new Date(session.createdAt).getTime()) / (1000 * 3600);
  if (ageHours > maxHours) {
    db.sessions = db.sessions.filter((s) => s.token !== token);
    writeDb(db);
    res.status(401).json({ error: 'Tu sesión expiró por tiempo máximo de inactividad.' });
    return;
  }

  let authUser: AuthUser | null = null;
  if (session.kind === 'sys') {
    const su = db.sysUsers.find((u) => u.id === session.userId);
    if (!su || !su.active) {
      res.status(403).json({ error: 'Tu usuario de sistema está desactivado.' });
      return;
    }
    authUser = toAuthUserFromSys(su, db.sysRoles, db.users);
  } else {
    const dirUser = db.users.find((u) => u.id === session.userId);
    if (!dirUser || dirUser.status === 'Inactivo') {
      res.status(403).json({ error: 'Tu cuenta está inactiva o ha sido desvinculada.' });
      return;
    }
    authUser = toAuthUserFromDirectory(dirUser, db.sysRoles);
  }

  req.authUser = authUser;
  req.authToken = token;
  next();
}

function requirePerm(module: string, action: string) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.authUser) {
      res.status(401).json({ error: 'No autenticado.' });
      return;
    }
    if (req.authUser.mustChangePw) {
      res.status(403).json({ error: 'Debes cambiar tu contraseña temporal antes de operar el sistema.' });
      return;
    }
    if (!hasPerm(req.authUser, module, action)) {
      res.status(403).json({ error: 'Tu rol de acceso no tiene permisos para ejecutar esta acción.' });
      return;
    }
    next();
  };
}

async function startServer(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '8mb' }));

  readDb();
  startApiScheduler();

  /* --- AUTHENTICATION ENDPOINTS --- */
  app.post('/api/auth/login', (req, res) => {
    const { identifier, email, username, password } = req.body as {
      identifier?: string;
      email?: string;
      username?: string;
      password?: string;
    };
    const rawId = (identifier || email || username || '').trim().toLowerCase();
    if (!rawId || !password) {
      res.status(400).json({ error: 'Ingresa tu usuario o correo corporativo y contraseña.' });
      return;
    }

    const db = readDb();

    // 1. Check System Users (by username OR email)
    const sysUser = db.sysUsers.find(
      (u) => u.username.toLowerCase() === rawId || u.email.toLowerCase() === rawId,
    );
    if (sysUser) {
      const storedHash = db.sysCredentials[sysUser.id];
      if (!storedHash || !verifyPassword(password, storedHash)) {
        res.status(401).json({ error: 'Credenciales inválidas. Verifica tu usuario o contraseña.' });
        return;
      }
      if (!sysUser.active) {
        res.status(403).json({ error: 'Tu usuario del sistema está desactivado.' });
        return;
      }

      const token = crypto.randomBytes(32).toString('hex');
      db.sessions.push({ token, userId: sysUser.id, kind: 'sys', createdAt: nowIso() });
      if (db.sessions.length > 150) db.sessions = db.sessions.slice(-150);
      sysUser.lastLogin = nowIso();

      const authUser = toAuthUserFromSys(sysUser, db.sysRoles, db.users);
      addAudit(db, 'auth_login', `Inicio de sesión operador (${sysUser.username} · ${authUser.roleName})`, sysUser.email);
      writeDb(db);
      res.json({ token, user: authUser });
      return;
    }

    // 2. Fall back to Corporate Directory Users (by email)
    const dirUser = db.users.find((u) => u.email.toLowerCase() === rawId);
    if (!dirUser) {
      res.status(401).json({ error: 'Credenciales inválidas. Verifica tu usuario/correo o contraseña.' });
      return;
    }

    const storedHash = db.credentials[dirUser.id];
    if (!storedHash || !verifyPassword(password, storedHash)) {
      res.status(401).json({ error: 'Credenciales inválidas. Verifica tu usuario/correo o contraseña.' });
      return;
    }

    if (dirUser.status === 'Inactivo') {
      res.status(403).json({ error: 'Cuenta inactiva o desvinculada. El acceso al portal ha sido revocado.' });
      return;
    }

    const token = crypto.randomBytes(32).toString('hex');
    db.sessions.push({ token, userId: dirUser.id, kind: 'directory', createdAt: nowIso() });
    if (db.sessions.length > 150) db.sessions = db.sessions.slice(-150);
    dirUser.lastAccess = 'En línea ahora';

    const authUser = toAuthUserFromDirectory(dirUser, db.sysRoles);
    addAudit(db, 'auth_login', `Inicio de sesión portal (${authUser.roleName})`, dirUser.email, dirUser.id);
    writeDb(db);
    res.json({ token, user: authUser });
  });

  app.get('/api/auth/me', requireAuth, (req: AuthenticatedRequest, res) => {
    res.json({ user: req.authUser! });
  });

  app.post('/api/auth/change-password', requireAuth, (req: AuthenticatedRequest, res) => {
    const { currentPassword, newPassword } = req.body as {
      currentPassword?: string;
      newPassword?: string;
    };
    if (!currentPassword || !newPassword || newPassword.length < 6) {
      res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres.' });
      return;
    }

    const db = readDb();
    const auth = req.authUser!;
    if (auth.kind === 'sys') {
      const su = db.sysUsers.find((u) => u.id === auth.id);
      const hash = db.sysCredentials[auth.id];
      if (!su || !hash || !verifyPassword(currentPassword, hash)) {
        res.status(401).json({ error: 'La contraseña actual es incorrecta.' });
        return;
      }
      db.sysCredentials[su.id] = hashPassword(newPassword);
      su.mustChangePw = false;
      addAudit(db, 'password_changed', `Contraseña actualizada por ${su.username}`, su.email);
      writeDb(db);
      res.json({ user: toAuthUserFromSys(su, db.sysRoles, db.users) });
      return;
    }

    const dir = db.users.find((u) => u.id === auth.id);
    const hash = db.credentials[auth.id];
    if (!dir || !hash || !verifyPassword(currentPassword, hash)) {
      res.status(401).json({ error: 'La contraseña actual es incorrecta.' });
      return;
    }
    db.credentials[dir.id] = hashPassword(newPassword);
    addAudit(db, 'password_changed', `Contraseña actualizada por ${dir.name}`, dir.email, dir.id);
    writeDb(db);
    res.json({ user: toAuthUserFromDirectory(dir, db.sysRoles) });
  });

  app.post('/api/auth/logout', requireAuth, (req: AuthenticatedRequest, res) => {
    const db = readDb();
    db.sessions = db.sessions.filter((s) => s.token !== req.authToken);
    writeDb(db);
    res.json({ ok: true });
  });

  /* --- DOMAIN STATE --- */
  app.get('/api/state', requireAuth, (req: AuthenticatedRequest, res) => {
    const db = readDb();
    res.json(getStateForAuth(db, req.authUser!));
  });

  /* --- DIRECTORY USERS --- */
  app.post('/api/users', requireAuth, requirePerm('usuarios', 'crear'), (req: AuthenticatedRequest, res) => {
    const db = readDb();
    const {
      name,
      email,
      rut,
      dept,
      position,
      manager,
      phone,
      hireDate,
      notes,
      status,
      platformIds,
      portalRole,
      password,
    } = req.body as {
      name: string;
      email: string;
      rut?: string;
      dept: string;
      position?: string;
      manager?: string;
      phone?: string;
      hireDate?: string;
      notes?: string;
      status?: UserStatus;
      platformIds?: string[];
      portalRole?: PortalRole;
      password?: string;
    };

    if (!name || !email) {
      res.status(400).json({ error: 'Nombre y email son obligatorios.' });
      return;
    }

    const exists = db.users.some((u) => u.email.toLowerCase() === email.trim().toLowerCase());
    if (exists) {
      res.status(409).json({ error: 'Ya existe un usuario consolidado con ese email.' });
      return;
    }

    let assignedRole: PortalRole = portalRole || 'USER';
    if (assignedRole === 'IT_ADMIN' && req.authUser!.permissions !== '*') {
      assignedRole = 'USER';
    }

    const selectedIds = Array.isArray(platformIds) ? platformIds : [];
    const accounts: PlatformAccount[] = selectedIds.map((pid) => ({
      platformId: pid,
      username: buildUsername(email.trim(), pid),
      role: 'Usuario Estándar',
      status: 'Activo',
      lastAccess: 'Recién aprovisionado',
    }));

    const newUser: User = {
      id: `u-${Date.now()}`,
      rut: (rut || '').trim() || `20.${Math.floor(100 + Math.random() * 899)}.${Math.floor(100 + Math.random() * 899)}-K`,
      name: name.trim(),
      email: email.trim().toLowerCase(),
      dept: dept || 'TI',
      position: (position || '').trim() || 'Colaborador',
      manager: (manager || '').trim() || undefined,
      phone: (phone || '').trim() || undefined,
      hireDate: (hireDate || '').trim() || new Date().toISOString().slice(0, 10),
      notes: (notes || '').trim() || undefined,
      status: status || 'Activo',
      portalRole: assignedRole,
      accounts,
      lastAccess: 'Nunca',
      sourceMaster: 'Creación Manual',
      updatedAt: nowIso(),
    };

    db.users.unshift(newUser);
    if ((password || '').trim().length >= 6) {
      db.credentials[newUser.id] = hashPassword(password!.trim());
    }
    addAudit(
      db,
      'user_created',
      `${newUser.name} creado (${assignedRole}) y consolidado en ${accounts.length} plataforma(s)`,
      req.authUser!.email,
      newUser.id,
    );
    writeDb(db);
    res.status(201).json(getStateForAuth(db, req.authUser!));
  });

  app.patch('/api/users/:id', requireAuth, requirePerm('usuarios', 'editar'), (req: AuthenticatedRequest, res) => {
    const db = readDb();
    const user = db.users.find((u) => u.id === req.params.id);
    if (!user) {
      res.status(404).json({ error: 'Usuario no encontrado.' });
      return;
    }

    const { name, email, rut, dept, position, manager, phone, hireDate, notes, status, portalRole } =
      req.body as Partial<User>;
    if (name !== undefined) user.name = name.trim();
    if (email !== undefined) user.email = email.trim().toLowerCase();
    if (rut !== undefined) user.rut = rut.trim();
    if (dept !== undefined) user.dept = dept;
    if (position !== undefined) user.position = position.trim();
    if (manager !== undefined) user.manager = manager.trim() || undefined;
    if (phone !== undefined) user.phone = phone.trim() || undefined;
    if (hireDate !== undefined) user.hireDate = hireDate.trim() || undefined;
    if (notes !== undefined) user.notes = notes.trim() || undefined;
    if (status !== undefined) user.status = status;
    if (portalRole !== undefined && (req.authUser!.permissions === '*' || req.authUser!.portalRole === 'IT_ADMIN')) {
      user.portalRole = portalRole;
    }
    user.updatedAt = nowIso();

    addAudit(db, 'access_granted', `Ficha actualizada para ${user.name} (${user.dept})`, req.authUser!.email, user.id);
    writeDb(db);
    res.json(getStateForAuth(db, req.authUser!));
  });

  app.post('/api/users/:id/toggle-platform', requireAuth, requirePerm('usuarios', 'editar'), (req: AuthenticatedRequest, res) => {
    const db = readDb();
    const user = db.users.find((u) => u.id === req.params.id);
    if (!user) {
      res.status(404).json({ error: 'Usuario no encontrado.' });
      return;
    }

    const { platformId, enable, role } = req.body as {
      platformId: string;
      enable: boolean;
      role?: string;
    };

    const platform = db.platforms.find((p) => p.id === platformId);
    if (!platform) {
      res.status(404).json({ error: 'Plataforma no encontrada.' });
      return;
    }

    if (enable) {
      const existing = user.accounts.find((a) => a.platformId === platformId);
      if (existing) {
        existing.status = 'Activo';
        if (role) existing.role = role;
      } else {
        user.accounts.push({
          platformId,
          username: buildUsername(user.email, platformId),
          role: role || 'Usuario Estándar',
          status: 'Activo',
          lastAccess: 'Hoy',
        });
      }
      addAudit(db, 'access_granted', `${user.name}: acceso habilitado en ${platform.name}`, req.authUser!.email, user.id);
    } else {
      user.accounts = user.accounts.filter((a) => a.platformId !== platformId);
      const off = db.offboardings.find((o) => o.userId === user.id && o.status === 'En proceso');
      if (off) {
        off.pendingPlatforms = off.pendingPlatforms.filter((p) => p !== platformId);
        if (!off.revokedPlatforms.includes(platformId)) {
          off.revokedPlatforms.push(platformId);
        }
        if (off.pendingPlatforms.length === 0) {
          off.status = 'Completado';
          off.completedAt = nowIso();
          user.status = 'Inactivo';
          addAudit(db, 'offboarding_completed', `Desvinculación completada para ${user.name}`, req.authUser!.email, user.id);
        }
      }
      addAudit(db, 'access_revoked', `${user.name}: acceso revocado en ${platform.name}`, req.authUser!.email, user.id);
    }

    user.updatedAt = nowIso();
    writeDb(db);
    res.json(getStateForAuth(db, req.authUser!));
  });

  app.post('/api/users/bulk-import', requireAuth, requirePerm('usuarios', 'crear'), (req: AuthenticatedRequest, res) => {
    const db = readDb();
    const { rows, mode } = req.body as {
      rows: Record<string, string>[];
      mode?: 'omitir' | 'actualizar';
    };
    if (!Array.isArray(rows) || rows.length === 0) {
      res.status(400).json({ error: 'No se detectaron filas válidas en el archivo.' });
      return;
    }
    const summary = runBulkDirectoryImport(db, rows, mode === 'actualizar' ? 'actualizar' : 'omitir', req.authUser!.email);
    writeDb(db);
    res.json({ summary, state: getStateForAuth(db, req.authUser!) });
  });

  /* --- OFFBOARDINGS --- */
  app.post('/api/offboardings', requireAuth, requirePerm('bajas', 'gestionar'), (req: AuthenticatedRequest, res) => {
    const db = readDb();
    const { userId, reason, offboardDate, notes } = req.body as {
      userId: string;
      reason: string;
      offboardDate?: string;
      notes?: string;
    };

    const user = db.users.find((u) => u.id === userId);
    if (!user) {
      res.status(404).json({ error: 'Usuario no encontrado.' });
      return;
    }

    const existingOpen = db.offboardings.find((o) => o.userId === userId && o.status === 'En proceso');
    if (existingOpen) {
      res.status(409).json({ error: 'Este usuario ya tiene un proceso de baja en curso.' });
      return;
    }

    const activePlatformIds = user.accounts.map((a) => a.platformId);
    for (const acc of user.accounts) {
      acc.status = 'Pendiente revocar';
    }

    user.status = activePlatformIds.length > 0 ? 'En proceso de baja' : 'Inactivo';
    user.updatedAt = nowIso();

    const record: OffboardingRecord = {
      id: `off-${Date.now()}`,
      userId: user.id,
      userName: user.name,
      email: user.email,
      rut: user.rut,
      dept: user.dept,
      offboardDate: offboardDate || new Date().toISOString().slice(0, 10),
      reason: reason || 'Renuncia voluntaria',
      notes: (notes || '').trim() || undefined,
      initiatedBy: req.authUser!.username || req.authUser!.email,
      pendingPlatforms: [...activePlatformIds],
      revokedPlatforms: [],
      status: activePlatformIds.length > 0 ? 'En proceso' : 'Completado',
      completedAt: activePlatformIds.length === 0 ? nowIso() : undefined,
    };

    db.offboardings.unshift(record);
    addAudit(
      db,
      'offboarding_started',
      `Baja iniciada para ${user.name} (${record.reason}) · ${activePlatformIds.length} accesos por revocar`,
      req.authUser!.email,
      user.id,
    );
    writeDb(db);
    res.status(201).json(getStateForAuth(db, req.authUser!));
  });

  app.post('/api/offboardings/:id/revoke', requireAuth, requirePerm('bajas', 'gestionar'), (req: AuthenticatedRequest, res) => {
    const db = readDb();
    const off = db.offboardings.find((o) => o.id === req.params.id);
    if (!off) {
      res.status(404).json({ error: 'Registro de baja no encontrado.' });
      return;
    }

    const { platformId, all } = req.body as { platformId?: string; all?: boolean };
    const user = db.users.find((u) => u.id === off.userId);

    if (all) {
      const revokedNow = [...off.pendingPlatforms];
      off.revokedPlatforms = Array.from(new Set([...off.revokedPlatforms, ...revokedNow]));
      off.pendingPlatforms = [];
      off.status = 'Completado';
      off.completedAt = nowIso();
      if (user) {
        user.accounts = [];
        user.status = 'Inactivo';
        user.updatedAt = nowIso();
      }
      addAudit(
        db,
        'offboarding_completed',
        `${off.userName}: todos los accesos revocados (${revokedNow.join(', ') || 'ninguno'})`,
        req.authUser!.email,
        off.userId,
      );
    } else if (platformId) {
      off.pendingPlatforms = off.pendingPlatforms.filter((p) => p !== platformId);
      if (!off.revokedPlatforms.includes(platformId)) {
        off.revokedPlatforms.push(platformId);
      }
      if (user) {
        user.accounts = user.accounts.filter((a) => a.platformId !== platformId);
        user.updatedAt = nowIso();
      }
      addAudit(db, 'access_revoked', `${off.userName}: acceso ${platformId} revocado en baja`, req.authUser!.email, off.userId);
      if (off.pendingPlatforms.length === 0) {
        off.status = 'Completado';
        off.completedAt = nowIso();
        if (user) user.status = 'Inactivo';
        addAudit(db, 'offboarding_completed', `Desvinculación completada para ${off.userName}`, req.authUser!.email, off.userId);
      }
    }

    writeDb(db);
    res.json(getStateForAuth(db, req.authUser!));
  });

  /* --- PLATFORMS, CROSS-MATCH IMPORTS & API ENGINE --- */
  app.post('/api/platforms', requireAuth, requirePerm('plataformas', 'crear'), (req: AuthenticatedRequest, res) => {
    const db = readDb();
    const { id, name, abbr, colorHex, type, endpoint, syncMode, requiredForActive, colMap, notes } =
      req.body as Partial<Platform>;
    if (!name) {
      res.status(400).json({ error: 'El nombre de la plataforma es obligatorio.' });
      return;
    }
    const cleanId = (id || name).trim();
    if (db.platforms.some((p) => p.id.toLowerCase() === cleanId.toLowerCase())) {
      res.status(409).json({ error: 'Ya existe una plataforma con ese identificador.' });
      return;
    }

    const platform: Platform = {
      id: cleanId,
      name: name.trim(),
      abbr: (abbr || name.slice(0, 3)).toUpperCase().slice(0, 5),
      colorHex: colorHex || '#2563EB',
      type: type || 'Propia',
      status: 'Operativo',
      lastSyncAt: nowIso(),
      endpoint: endpoint || `https://${cleanId.toLowerCase().replace(/\s+/g, '-')}.empresa.local/api/users`,
      syncMode: syncMode || 'Manual',
      requiredForActive: Boolean(requiredForActive),
      colMap: colMap?.trim() || undefined,
      notes: notes?.trim() || undefined,
      isDefault: false,
    };

    db.platforms.push(platform);
    addAudit(db, 'platform_synced', `Nueva plataforma integrada: ${platform.name} (${platform.type})`, req.authUser!.email);
    writeDb(db);
    res.status(201).json(getStateForAuth(db, req.authUser!));
  });

  app.patch('/api/platforms/:id', requireAuth, requirePerm('plataformas', 'editar'), (req: AuthenticatedRequest, res) => {
    const db = readDb();
    const platform = db.platforms.find((p) => p.id === req.params.id);
    if (!platform) {
      res.status(404).json({ error: 'Plataforma no encontrada.' });
      return;
    }

    const { name, abbr, colorHex, type, status, endpoint, syncMode, requiredForActive, colMap, notes } =
      req.body as Partial<Platform>;
    if (name !== undefined) platform.name = name.trim();
    if (abbr !== undefined && !platform.isDefault) platform.abbr = abbr.trim().toUpperCase().slice(0, 5);
    if (colorHex !== undefined && !platform.isDefault) platform.colorHex = colorHex.trim();
    if (type !== undefined) platform.type = type;
    if (status !== undefined) platform.status = status;
    if (endpoint !== undefined) platform.endpoint = endpoint.trim();
    if (syncMode !== undefined) platform.syncMode = syncMode;
    if (requiredForActive !== undefined) platform.requiredForActive = requiredForActive;
    if (colMap !== undefined) platform.colMap = colMap.trim() || undefined;
    if (notes !== undefined) platform.notes = notes.trim() || undefined;

    addAudit(db, 'settings_updated', `Configuración actualizada para plataforma ${platform.name}`, req.authUser!.email);
    writeDb(db);
    res.json(getStateForAuth(db, req.authUser!));
  });

  app.delete('/api/platforms/:id', requireAuth, requirePerm('plataformas', 'editar'), (req: AuthenticatedRequest, res) => {
    const db = readDb();
    const platform = db.platforms.find((p) => p.id === req.params.id);
    if (!platform) {
      res.status(404).json({ error: 'Plataforma no encontrada.' });
      return;
    }
    if (platform.isDefault) {
      res.status(400).json({ error: `'${platform.name}' es una plataforma predeterminada y no puede eliminarse.` });
      return;
    }
    db.platforms = db.platforms.filter((p) => p.id !== platform.id);
    db.platformImports = db.platformImports.filter((pi) => pi.platformId !== platform.id);
    db.apiConfigs = db.apiConfigs.filter((c) => c.platformId !== platform.id);
    db.apiSyncLogs = db.apiSyncLogs.filter((l) => l.platformId !== platform.id);
    for (const u of db.users) {
      u.accounts = u.accounts.filter((a) => a.platformId !== platform.id);
    }
    addAudit(db, 'settings_updated', `Plataforma personalizada eliminada: ${platform.name}`, req.authUser!.email);
    writeDb(db);
    res.json(getStateForAuth(db, req.authUser!));
  });

  app.post('/api/platforms/:id/sync', requireAuth, requirePerm('plataformas', 'editar'), (req: AuthenticatedRequest, res) => {
    const db = readDb();
    const platform = db.platforms.find((p) => p.id === req.params.id);
    if (!platform) {
      res.status(404).json({ error: 'Plataforma no encontrada.' });
      return;
    }
    platform.lastSyncAt = nowIso();
    const count = db.users.filter((u) => u.accounts.some((a) => a.platformId === platform.id)).length;
    addAudit(db, 'platform_synced', `Sincronización ${platform.name} completada (${count} cuentas validadas)`, req.authUser!.email);
    writeDb(db);
    res.json(getStateForAuth(db, req.authUser!));
  });

  app.post('/api/platforms/:id/imports', requireAuth, requirePerm('plataformas', 'importar'), (req: AuthenticatedRequest, res) => {
    const db = readDb();
    const platform = db.platforms.find((p) => p.id === req.params.id);
    if (!platform) {
      res.status(404).json({ error: 'Plataforma no encontrada.' });
      return;
    }
    const { rows, mode } = req.body as { rows: Record<string, string>[]; mode?: 'reemplazar' | 'agregar' };
    if (!Array.isArray(rows) || rows.length === 0) {
      res.status(400).json({ error: 'La planilla no contiene filas válidas para cruzar.' });
      return;
    }
    const summary = runPlatformCrossImport(
      db,
      platform,
      rows,
      mode === 'agregar' ? 'agregar' : 'reemplazar',
      req.authUser!.email,
    );
    writeDb(db);
    res.json({ summary, state: getStateForAuth(db, req.authUser!) });
  });

  app.post('/api/platforms/:id/imports/:importId/link', requireAuth, requirePerm('plataformas', 'importar'), (req: AuthenticatedRequest, res) => {
    const db = readDb();
    const platform = db.platforms.find((p) => p.id === req.params.id);
    const imp = db.platformImports.find((pi) => pi.id === req.params.importId && pi.platformId === req.params.id);
    if (!platform || !imp) {
      res.status(404).json({ error: 'Registro importado o plataforma no encontrada.' });
      return;
    }
    const { userId } = req.body as { userId?: string };
    const user = db.users.find((u) => u.id === userId);
    if (!user) {
      res.status(404).json({ error: 'Usuario del directorio no encontrado.' });
      return;
    }

    imp.matchedUserId = user.id;
    imp.matchMethod = 'manual';
    imp.matchStatus = 'encontrado';

    const existing = user.accounts.find((a) => a.platformId === platform.id);
    const acctName = imp.rawAccountId || imp.rawEmail || buildUsername(user.email, platform.id);
    if (existing) {
      existing.username = acctName;
      existing.status = 'Activo';
      existing.lastAccess = 'Vinculado manual';
    } else {
      user.accounts.push({
        platformId: platform.id,
        username: acctName,
        role: imp.rawExtra?.perfil || imp.rawExtra?.rol || 'Usuario Estándar',
        status: 'Activo',
        lastAccess: 'Vinculado manual',
      });
    }
    user.updatedAt = nowIso();
    addAudit(
      db,
      'manual_link',
      `Vinculación manual en ${platform.name}: '${imp.rawName || imp.rawEmail || imp.rawAccountId}' → ${user.name}`,
      req.authUser!.email,
      user.id,
    );
    writeDb(db);
    res.json(getStateForAuth(db, req.authUser!));
  });

  app.put('/api/platforms/:id/api', requireAuth, requirePerm('plataformas', 'editar'), (req: AuthenticatedRequest, res) => {
    const db = readDb();
    const platform = db.platforms.find((p) => p.id === req.params.id);
    if (!platform) {
      res.status(404).json({ error: 'Plataforma no encontrada.' });
      return;
    }
    const body = req.body as {
      apiType?: ApiType;
      baseUrl?: string;
      authType?: ApiAuthType;
      token?: string;
      username?: string;
      password?: string;
      clientId?: string;
      clientSecret?: string;
      tenantId?: string;
      extraParams?: { query?: Record<string, string>; verifySsl?: boolean };
      fieldMap?: Record<string, string>;
      offboardEndpoint?: string;
      offboardMethod?: 'PATCH' | 'PUT' | 'POST' | 'DELETE';
      offboardPayload?: string;
      syncEnabled?: boolean;
      syncInterval?: number;
    };

    const existing = db.apiConfigs.find((c) => c.platformId === platform.id);
    const nextCfg: StoredApiConfig = {
      platformId: platform.id,
      apiType: body.apiType || existing?.apiType || 'custom',
      baseUrl: (body.baseUrl ?? existing?.baseUrl ?? '').trim(),
      authType: body.authType || existing?.authType || 'bearer',
      token: body.token && body.token.trim() ? body.token.trim() : existing?.token || '',
      username: (body.username ?? existing?.username ?? '').trim(),
      password: body.password && body.password.trim() ? body.password.trim() : existing?.password || '',
      clientId: (body.clientId ?? existing?.clientId ?? '').trim(),
      clientSecret:
        body.clientSecret && body.clientSecret.trim() ? body.clientSecret.trim() : existing?.clientSecret || '',
      tenantId: (body.tenantId ?? existing?.tenantId ?? '').trim(),
      extraParams: body.extraParams || existing?.extraParams || { query: {}, verifySsl: true },
      fieldMap: body.fieldMap || existing?.fieldMap || {},
      offboardEndpoint: (body.offboardEndpoint ?? existing?.offboardEndpoint ?? '').trim(),
      offboardMethod: body.offboardMethod || existing?.offboardMethod || 'PATCH',
      offboardPayload: (body.offboardPayload ?? existing?.offboardPayload ?? '').trim(),
      syncEnabled: Boolean(body.syncEnabled),
      syncInterval: Math.max(1, Math.min(720, Number(body.syncInterval) || 24)),
      lastSync: existing?.lastSync,
      lastSyncStatus: existing?.lastSyncStatus,
      lastSyncCount: existing?.lastSyncCount,
      updatedAt: nowIso(),
    };

    if (existing) {
      Object.assign(existing, nextCfg);
    } else {
      db.apiConfigs.push(nextCfg);
    }

    if (nextCfg.baseUrl) platform.endpoint = nextCfg.baseUrl;
    platform.syncMode = nextCfg.syncEnabled ? 'Automática' : platform.syncMode;

    addAudit(db, 'api_config', `Configuración API actualizada para ${platform.name} (${nextCfg.apiType})`, req.authUser!.email);
    writeDb(db);
    res.json(getStateForAuth(db, req.authUser!));
  });

  app.post('/api/platforms/:id/api/test', requireAuth, requirePerm('plataformas', 'editar'), async (req: AuthenticatedRequest, res) => {
    const db = readDb();
    const cfg = db.apiConfigs.find((c) => c.platformId === req.params.id);
    if (!cfg) {
      res.status(400).json({ ok: false, msg: 'Guarda la configuración de la API primero.' });
      return;
    }
    const result = await testApiConnection(cfg);
    res.json(result);
  });

  app.post('/api/platforms/:id/api/sync', requireAuth, requirePerm('plataformas', 'editar'), async (req: AuthenticatedRequest, res) => {
    const db = readDb();
    const result = await doApiSync(db, req.params.id, 'forzado', req.authUser!.email);
    res.json({ result, state: getStateForAuth(db, req.authUser!) });
  });

  app.post('/api/platforms/:id/api/offboard/:userId', requireAuth, requirePerm('bajas', 'gestionar'), async (req: AuthenticatedRequest, res) => {
    const db = readDb();
    const result = await doApiOffboard(db, req.params.id, req.params.userId, req.authUser!.email);
    res.status(result.ok ? 200 : 502).json({ result, state: getStateForAuth(db, req.authUser!) });
  });

  /* --- CONSOLIDATION PREVIEW & COMMIT --- */
  app.post('/api/consolidate/preview', requireAuth, requirePerm('plataformas', 'importar'), (req, res) => {
    const db = readDb();
    const { platformId, rows } = req.body as {
      platformId: string;
      rows: ConsolidationRowInput[];
    };

    if (!platformId || !Array.isArray(rows)) {
      res.status(400).json({ error: 'Debe indicar plataforma de origen y filas válidas.' });
      return;
    }

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

      const matched = db.users.find(
        (u) => (email && u.email.toLowerCase() === email) || (rut && u.rut.toLowerCase() === rut.toLowerCase()),
      );

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

      if (incomingStatus === 'En proceso de baja' || incomingStatus === 'Inactivo') {
        if (matched.status !== 'Inactivo' && matched.status !== 'En proceso de baja') {
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
      }

      const hasAccount = matched.accounts.some((a) => a.platformId === platformId);
      if (!hasAccount) {
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
      summary: {
        newUsers,
        linkedAccounts,
        offboardingsDetected,
        statusUpdates,
        unchanged,
      },
      items,
    };

    res.json(preview);
  });

  app.post('/api/consolidate/commit', requireAuth, requirePerm('plataformas', 'importar'), (req: AuthenticatedRequest, res) => {
    const db = readDb();
    const { platformId, items } = req.body as {
      platformId: string;
      items: ConsolidationPreviewItem[];
    };

    if (!platformId || !Array.isArray(items)) {
      res.status(400).json({ error: 'Datos de consolidación inválidos.' });
      return;
    }

    let createdCount = 0;
    let linkedCount = 0;
    let offboardedCount = 0;

    for (const item of items) {
      if (item.action === 'SIN_CAMBIOS') continue;

      if (item.action === 'CREAR_USUARIO') {
        const newId = `u-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const newUser: User = {
          id: newId,
          rut: item.rut || 'Por asignar',
          name: item.name,
          email: item.email,
          dept: item.dept,
          position: item.position,
          status: item.incomingStatus,
          portalRole: 'USER',
          lastAccess: 'Consolidado',
          sourceMaster: platformId,
          updatedAt: nowIso(),
          accounts: [
            {
              platformId,
              username: item.username,
              role: item.role,
              status: 'Activo',
              lastAccess: 'Sincronizado',
            },
          ],
        };
        db.users.unshift(newUser);
        createdCount++;
      } else if (item.action === 'VINCULAR_CUENTA' && item.existingUserId) {
        const user = db.users.find((u) => u.id === item.existingUserId);
        if (user && !user.accounts.some((a) => a.platformId === platformId)) {
          user.accounts.push({
            platformId,
            username: item.username,
            role: item.role,
            status: user.status === 'En proceso de baja' ? 'Pendiente revocar' : 'Activo',
            lastAccess: 'Sincronizado',
          });
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
          const newId = `u-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          user = {
            id: newId,
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
        for (const acc of user.accounts) {
          acc.status = 'Pendiente revocar';
        }
        user.status = pendingPlatforms.length > 0 ? 'En proceso de baja' : 'Inactivo';
        user.updatedAt = nowIso();

        const hasOpenOff = db.offboardings.some((o) => o.userId === user!.id && o.status === 'En proceso');
        if (!hasOpenOff) {
          db.offboardings.unshift({
            id: `off-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            userId: user.id,
            userName: user.name,
            email: user.email,
            rut: user.rut,
            dept: user.dept,
            offboardDate: item.offboardDate || new Date().toISOString().slice(0, 10),
            reason: item.reason || `Baja consolidada (${platformId})`,
            initiatedBy: req.authUser!.username || req.authUser!.email,
            pendingPlatforms,
            revokedPlatforms: [],
            status: pendingPlatforms.length > 0 ? 'En proceso' : 'Completado',
            completedAt: pendingPlatforms.length === 0 ? nowIso() : undefined,
          });
        }
        offboardedCount++;
      }
    }

    const platform = db.platforms.find((p) => p.id === platformId);
    if (platform) platform.lastSyncAt = nowIso();

    addAudit(
      db,
      'consolidation',
      `Consolidación ${platformId}: ${createdCount} nuevos, ${linkedCount} vinculados, ${offboardedCount} bajas procesadas`,
      req.authUser!.email,
    );
    writeDb(db);
    res.json(getStateForAuth(db, req.authUser!));
  });

  /* --- SYSTEM USERS & ROLES --- */
  app.post('/api/sys-users', requireAuth, requirePerm('configuracion', 'gestionar'), (req: AuthenticatedRequest, res) => {
    const db = readDb();
    const { username, fullName, email, roleId, password, mustChangePw } = req.body as {
      username?: string;
      fullName?: string;
      email?: string;
      roleId?: string;
      password?: string;
      mustChangePw?: boolean;
    };

    const cleanUsername = (username || '').trim().toLowerCase();
    const cleanEmail = (email || '').trim().toLowerCase();
    if (!cleanUsername || !fullName?.trim() || !cleanEmail || !roleId) {
      res.status(400).json({ error: 'Usuario, nombre completo, email y rol son obligatorios.' });
      return;
    }
    if (db.sysUsers.some((u) => u.username.toLowerCase() === cleanUsername || u.email.toLowerCase() === cleanEmail)) {
      res.status(409).json({ error: 'Ya existe un operador del sistema con ese username o email.' });
      return;
    }
    const role = db.sysRoles.find((r) => r.id === roleId);
    if (!role) {
      res.status(404).json({ error: 'El rol seleccionado no existe.' });
      return;
    }

    const cleanPassword = (password || '').trim();
    if (cleanPassword.length < 6) {
      res.status(400).json({ error: 'La contraseña inicial debe tener al menos 6 caracteres.' });
      return;
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
    db.sysCredentials[su.id] = hashPassword(cleanPassword);
    addAudit(db, 'sys_user', `Operador '${su.username}' creado con rol ${role.name}`, req.authUser!.email);
    writeDb(db);
    res.status(201).json(getStateForAuth(db, req.authUser!));
  });

  app.patch('/api/sys-users/:id', requireAuth, requirePerm('configuracion', 'gestionar'), (req: AuthenticatedRequest, res) => {
    const db = readDb();
    const su = db.sysUsers.find((u) => u.id === req.params.id);
    if (!su) {
      res.status(404).json({ error: 'Operador no encontrado.' });
      return;
    }
    const { fullName, email, roleId, active, newPassword, mustChangePw } = req.body as {
      fullName?: string;
      email?: string;
      roleId?: string;
      active?: boolean;
      newPassword?: string;
      mustChangePw?: boolean;
    };
    if (fullName !== undefined) su.fullName = fullName.trim();
    if (email !== undefined) su.email = email.trim().toLowerCase();
    if (roleId !== undefined) su.roleId = roleId;
    if (active !== undefined) {
      if (!active && su.id === req.authUser!.id) {
        res.status(400).json({ error: 'No puedes desactivar tu propia cuenta.' });
        return;
      }
      su.active = active;
    }
    if (mustChangePw !== undefined) su.mustChangePw = mustChangePw;
    if (newPassword && newPassword.trim().length >= 6) {
      db.sysCredentials[su.id] = hashPassword(newPassword.trim());
    }
    addAudit(db, 'sys_user', `Operador '${su.username}' actualizado`, req.authUser!.email);
    writeDb(db);
    res.json(getStateForAuth(db, req.authUser!));
  });

  app.post('/api/sys-users/:id/toggle', requireAuth, requirePerm('configuracion', 'gestionar'), (req: AuthenticatedRequest, res) => {
    const db = readDb();
    const su = db.sysUsers.find((u) => u.id === req.params.id);
    if (!su) {
      res.status(404).json({ error: 'Operador no encontrado.' });
      return;
    }
    if (su.id === req.authUser!.id) {
      res.status(400).json({ error: 'No puedes desactivarte a ti mismo.' });
      return;
    }
    su.active = !su.active;
    addAudit(db, 'sys_user', `Operador '${su.username}' ${su.active ? 'activado' : 'desactivado'}`, req.authUser!.email);
    writeDb(db);
    res.json(getStateForAuth(db, req.authUser!));
  });

  app.post('/api/sys-roles', requireAuth, requirePerm('configuracion', 'gestionar'), (req: AuthenticatedRequest, res) => {
    const db = readDb();
    const { name, description, permissions } = req.body as {
      name?: string;
      description?: string;
      permissions?: PermissionMatrix;
    };
    const cleanName = (name || '').trim();
    if (!cleanName) {
      res.status(400).json({ error: 'El nombre del rol es obligatorio.' });
      return;
    }
    if (db.sysRoles.some((r) => r.name.toLowerCase() === cleanName.toLowerCase())) {
      res.status(409).json({ error: 'Ya existe un rol con ese nombre.' });
      return;
    }
    const role: SysRole = {
      id: `role-${Date.now()}`,
      name: cleanName,
      description: (description || '').trim(),
      permissions: permissions || {},
      isSystem: false,
      createdAt: nowIso(),
    };
    db.sysRoles.push(role);
    addAudit(db, 'sys_role', `Nuevo rol personalizado creado: '${role.name}'`, req.authUser!.email);
    writeDb(db);
    res.status(201).json(getStateForAuth(db, req.authUser!));
  });

  app.patch('/api/sys-roles/:id', requireAuth, requirePerm('configuracion', 'gestionar'), (req: AuthenticatedRequest, res) => {
    const db = readDb();
    const role = db.sysRoles.find((r) => r.id === req.params.id);
    if (!role) {
      res.status(404).json({ error: 'Rol no encontrado.' });
      return;
    }
    if (role.isSystem) {
      res.status(400).json({ error: 'El rol del sistema (Superadmin) no puede modificarse.' });
      return;
    }
    const { name, description, permissions } = req.body as Partial<SysRole>;
    if (name !== undefined) role.name = name.trim();
    if (description !== undefined) role.description = description.trim();
    if (permissions !== undefined) role.permissions = permissions;
    addAudit(db, 'sys_role', `Permisos del rol '${role.name}' actualizados`, req.authUser!.email);
    writeDb(db);
    res.json(getStateForAuth(db, req.authUser!));
  });

  app.delete('/api/sys-roles/:id', requireAuth, requirePerm('configuracion', 'gestionar'), (req: AuthenticatedRequest, res) => {
    const db = readDb();
    const role = db.sysRoles.find((r) => r.id === req.params.id);
    if (!role || role.isSystem) {
      res.status(400).json({ error: 'No se puede eliminar un rol del sistema.' });
      return;
    }
    const inUse = db.sysUsers.filter((su) => su.roleId === role.id).length;
    if (inUse > 0) {
      res.status(400).json({ error: `No se puede eliminar: ${inUse} operador(es) tienen este rol asignado.` });
      return;
    }
    db.sysRoles = db.sysRoles.filter((r) => r.id !== role.id);
    addAudit(db, 'sys_role', `Rol eliminado: '${role.name}'`, req.authUser!.email);
    writeDb(db);
    res.json(getStateForAuth(db, req.authUser!));
  });

  /* --- SETTINGS, SERVICE & BACKUPS --- */
  app.put('/api/settings', requireAuth, requirePerm('configuracion', 'servicio'), (req: AuthenticatedRequest, res) => {
    const db = readDb();
    const patch = req.body as Partial<SystemSettings>;
    db.settings = { ...db.settings, ...patch };
    pruneBackups(db.settings.backupRetention);
    addAudit(db, 'settings_updated', 'Parámetros de servicio y sincronización actualizados', req.authUser!.email);
    writeDb(db);
    res.json(getStateForAuth(db, req.authUser!));
  });

  app.post('/api/backups', requireAuth, requirePerm('configuracion', 'servicio'), (req: AuthenticatedRequest, res) => {
    const db = readDb();
    const { note } = req.body as { note?: string };
    const filename = makeBackup(db, 'manual', note || 'Respaldo manual desde portal');
    addAudit(db, 'backup_restore', `Respaldo manual creado: ${filename}`, req.authUser!.email);
    writeDb(db);
    res.status(201).json({ filename, state: getStateForAuth(db, req.authUser!) });
  });

  app.get('/api/backups/:name/download', requireAuth, requirePerm('configuracion', 'servicio'), (req, res) => {
    try {
      const fullPath = validateBackupFilename(req.params.name);
      res.download(fullPath, req.params.name);
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : 'Respaldo no encontrado.' });
    }
  });

  app.post('/api/backups/:name/restore', requireAuth, requirePerm('configuracion', 'servicio'), (req: AuthenticatedRequest, res) => {
    const db = readDb();
    const { what } = req.body as { what?: 'db' | 'config' | 'all' };
    try {
      const result = restoreBackup(db, req.params.name, what || 'all', req.authUser!.email);
      res.json({ safetyBackup: result.safetyBackup, state: getStateForAuth(db, req.authUser!) });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'No se pudo restaurar el respaldo.' });
    }
  });

  app.delete('/api/backups/:name', requireAuth, requirePerm('configuracion', 'servicio'), (req: AuthenticatedRequest, res) => {
    const db = readDb();
    try {
      const fullPath = validateBackupFilename(req.params.name);
      fs.unlinkSync(fullPath);
      addAudit(db, 'backup_restore', `Respaldo eliminado: ${req.params.name}`, req.authUser!.email);
      writeDb(db);
      res.json(getStateForAuth(db, req.authUser!));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'No se pudo eliminar el respaldo.' });
    }
  });

  app.post('/api/reset', requireAuth, requirePerm('configuracion', 'servicio'), (req: AuthenticatedRequest, res) => {
    const currentDb = readDb();
    makeBackup(currentDb, 'pre-reset', 'Respaldo automático antes de restablecer datos demo');
    const seed = buildSeedData();
    const activeToken = req.authToken!;
    const kind = req.authUser!.kind;
    seed.sessions.push({
      token: activeToken,
      userId: kind === 'sys' ? 'su-admin' : 'u-1',
      kind,
      createdAt: nowIso(),
    });
    writeDb(seed);
    const activeAuth =
      kind === 'sys'
        ? toAuthUserFromSys(seed.sysUsers[0], seed.sysRoles, seed.users)
        : toAuthUserFromDirectory(seed.users[0], seed.sysRoles);
    res.json(getStateForAuth(seed, activeAuth));
  });

  /* --- AI CONFIGURATION ASSISTANT --- */
  app.get('/api/assistant/history', requireAuth, requirePerm('configuracion', 'asistente'), (req: AuthenticatedRequest, res) => {
    const db = readDb();
    res.json({
      aiConfigured: Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim()),
      recent: getAssistantHistory(db, req.authUser!),
    });
  });

  app.post('/api/assistant/message', requireAuth, requirePerm('configuracion', 'asistente'), async (req: AuthenticatedRequest, res) => {
    const db = readDb();
    const { messages } = req.body as {
      messages?: { role: 'user' | 'assistant'; content: string }[];
    };
    try {
      const result = await runAssistantChat(db, req.authUser!, messages || []);
      res.json(result);
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'No se pudo consultar al asistente IA.',
      });
    }
  });

  app.post('/api/assistant/proposals/:id/apply', requireAuth, requirePerm('configuracion', 'asistente'), (req: AuthenticatedRequest, res) => {
    const db = readDb();
    try {
      const result = applyProposal(db, req.authUser!, req.params.id);
      res.json({ ...result, state: getStateForAuth(db, req.authUser!) });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'No se pudo aplicar la propuesta.' });
    }
  });

  app.post('/api/assistant/proposals/:id/discard', requireAuth, requirePerm('configuracion', 'asistente'), (req: AuthenticatedRequest, res) => {
    const db = readDb();
    try {
      discardProposal(db, req.authUser!, req.params.id);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'No se pudo descartar la propuesta.' });
    }
  });

  app.post('/api/assistant/proposals/:id/undo', requireAuth, requirePerm('configuracion', 'asistente'), (req: AuthenticatedRequest, res) => {
    const db = readDb();
    try {
      const result = undoProposal(db, req.authUser!, req.params.id);
      res.json({ ...result, state: getStateForAuth(db, req.authUser!) });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'No se pudo deshacer el cambio.' });
    }
  });

  /* --- VITE DEV / STATIC PRODUCTION --- */
  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`UserSync server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start UserSync server:', err);
  process.exit(1);
});
