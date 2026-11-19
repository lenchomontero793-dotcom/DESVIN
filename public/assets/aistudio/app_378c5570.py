import os, sys, re, sqlite3, json, csv, io, webbrowser, threading, time, hashlib, secrets, shutil, zipfile, subprocess, tempfile, socket
import urllib.request, urllib.parse, urllib.error, ssl, base64
from datetime import datetime, date, timedelta
from functools import wraps
from flask import Flask, render_template, request, jsonify, redirect, url_for, send_file, flash, session, abort
from flask_login import LoginManager, UserMixin, login_user, logout_user, login_required, current_user
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer
from reportlab.lib.units import cm


# ═══════════════════════════════════════════════════════════════════════════════
# VERSIÓN, RUTAS DE DATOS Y CONFIGURACIÓN DEL SERVICIO
# Todo lo que es "dato" vive en data/  →  una actualización de código NUNCA lo toca.
# ═══════════════════════════════════════════════════════════════════════════════
APP_VERSION  = "1.6.0"
BASE_DIR     = os.path.dirname(os.path.abspath(__file__))
DATA_DIR     = os.environ.get("USERSYNC_DATA") or os.path.join(BASE_DIR, "data")
BACKUP_DIR   = os.path.join(DATA_DIR, "backups")
STAGING_DIR  = os.path.join(DATA_DIR, "staging")
CONFIG_PATH  = os.path.join(DATA_DIR, "config.json")
PENDING_FLAG = os.path.join(DATA_DIR, "pending_restart.json")
DB           = os.path.join(DATA_DIR, "usersync.db")
for _d in (DATA_DIR, BACKUP_DIR, STAGING_DIR):
    os.makedirs(_d, exist_ok=True)

RUNTIME = {"host": None, "port": None, "server": "flask",
           "boot_id": secrets.token_hex(4), "started": time.time()}

def migrate_legacy_db():
    """Versiones anteriores guardaban usersync.db junto al código. Lo movemos a data/ sin perder nada."""
    legacy = os.path.join(BASE_DIR, "usersync.db")
    if os.path.exists(legacy) and not os.path.exists(DB):
        src_c = sqlite3.connect(legacy)
        dst_c = sqlite3.connect(DB)
        try:
            src_c.backup(dst_c)          # lee también lo que estuviera pendiente en el WAL
        finally:
            dst_c.close(); src_c.close()
        os.replace(legacy, legacy + ".migrado")
        for ext in ("-wal", "-shm"):
            try: os.remove(legacy + ext)
            except OSError: pass
        print("[UserSync] Base de datos existente migrada a la carpeta data/ (copia original: usersync.db.migrado)")
migrate_legacy_db()

DEFAULT_CONFIG = {
    "host": "127.0.0.1", "port": 5000, "open_browser": True,
    "org_name": "Mi Empresa S.A.", "notify_email": "it-admin@empresa.com",
    "grace_days": 1, "session_hours": 8, "scheduler_check_minutes": 5,
    "backup_retention": 10, "secret_key": "",
    # Asistente IA (opcional). La clave nunca se envía al navegador ni se incluye en respaldos.
    "ai_provider": "none",                      # none | anthropic | ollama
    "ai_model": "claude-sonnet-5-5",
    "ai_api_key": "",
    "ai_ollama_url": "http://127.0.0.1:11434",
    "ai_ollama_model": "llama3.1",
}

def save_config(cfg):
    tmp = CONFIG_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    os.replace(tmp, CONFIG_PATH)

def load_config():
    cfg = dict(DEFAULT_CONFIG)
    try:
        with open(CONFIG_PATH, encoding="utf-8") as f:
            cfg.update(json.load(f))
    except FileNotFoundError:
        pass
    except Exception:
        pass                              # archivo dañado → valores por defecto
    if os.environ.get("USERSYNC_SECRET"):
        cfg["secret_key"] = os.environ["USERSYNC_SECRET"]
    if not cfg.get("secret_key"):
        cfg["secret_key"] = secrets.token_hex(32)   # persistente: las sesiones sobreviven a reinicios
        save_config(cfg)
    return cfg

CONFIG = load_config()

app = Flask(__name__)
app.secret_key = CONFIG["secret_key"]
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
app.config["PERMANENT_SESSION_LIFETIME"] = timedelta(hours=int(CONFIG.get("session_hours", 8)))
app.config["SESSION_COOKIE_HTTPONLY"] = True

login_manager = LoginManager(app)
login_manager.login_view = "login_page"
login_manager.login_message = "Debes iniciar sesión para acceder."

@app.template_filter('from_json')
def from_json_filter(s):
    try: return json.loads(s or '{}')
    except: return {}

# ── Permisos disponibles por módulo ─────────────────────────────────────────
PERMS = {
    "usuarios":    {"ver":"Ver usuarios",   "crear":"Crear usuarios",   "editar":"Editar usuarios",   "eliminar":"Eliminar/dar de baja"},
    "plataformas": {"ver":"Ver plataformas","crear":"Agregar plataformas","editar":"Editar plataformas","importar":"Importar planillas"},
    "reportes":    {"ver":"Ver reportes",   "exportar":"Exportar reportes"},
    "bajas":       {"ver":"Ver bajas",      "gestionar":"Gestionar bajas"},
    "configuracion":{"ver":"Ver configuracion","gestionar":"Gestionar sistema","servicio":"Configurar servicio y actualizaciones","asistente":"Usar el asistente IA"},
    "audit":       {"ver":"Ver audit log"},
}

class SysUser(UserMixin):
    def __init__(self, row):
        self.id       = row["id"]
        self.username = row["username"]
        self.full_name= row["full_name"]
        self.email    = row["email"]
        self.role_id  = row["role_id"]
        self.active   = row["active"]

    def get_id(self): return str(self.id)

@login_manager.user_loader
def load_user(uid):
    with get_db() as db:
        row = db.execute("SELECT * FROM sys_users WHERE id=? AND active=1", (uid,)).fetchone()
        return SysUser(row) if row else None

def hash_pw(pw): return hashlib.sha256(pw.encode()).hexdigest()

def has_perm(module, action):
    """Verifica si el usuario actual tiene un permiso específico."""
    if not current_user.is_authenticated: return False
    with get_db() as db:
        role = db.execute("SELECT permissions FROM sys_roles WHERE id=?", (current_user.role_id,)).fetchone()
        if not role: return False
        if role["permissions"] == "*": return True   # Superadmin
        perms = json.loads(role["permissions"] or "{}")
        return perms.get(module, {}).get(action, False)

def require_perm(module, action):
    """Decorador para proteger rutas por permiso."""
    def decorator(f):
        @wraps(f)
        @login_required
        def decorated(*args, **kwargs):
            if not has_perm(module, action):
                flash("No tienes permiso para realizar esta acción.", "danger")
                return redirect(url_for("dashboard"))
            return f(*args, **kwargs)
        return decorated
    return decorator
# DB se define arriba (carpeta data/)

PLATFORMS_DEFAULT = ["SAP", "Salesforce", "Office 365", "HCM", "ERP Propio", "Portal Clientes"]
DEPARTMENTS = ["TI", "RRHH", "Finanzas", "Ventas", "Operaciones", "Legal", "Gerencia"]
OFFBOARD_REASONS = ["Renuncia voluntaria", "Término de contrato", "Despido", "Jubilación", "Traslado", "Otro"]
PLATFORM_TYPES = ["ERP", "CRM", "Productividad", "RRHH", "Web", "BI", "Seguridad", "Comunicaciones", "Otro"]
PLATFORM_COLORS = ["#1E73BE","#00A1E0","#D83B01","#1E8E3E","#534AB7","#F29900",
                   "#E91E63","#009688","#795548","#607D8B","#FF5722","#3F51B5"]

def get_platforms():
    """Lee plataformas dinámicamente desde la DB."""
    try:
        with get_db() as db:
            rows = db.execute("SELECT name FROM platforms_config ORDER BY name").fetchall()
            return [r["name"] for r in rows]
    except:
        return PLATFORMS_DEFAULT

def get_platform_meta(name):
    """Retorna color y abreviatura de una plataforma."""
    DEFAULTS = {
        "SAP":             {"color":"#1E73BE","abbr":"SAP"},
        "Salesforce":      {"color":"#00A1E0","abbr":"SF"},
        "Office 365":      {"color":"#D83B01","abbr":"O365"},
        "HCM":             {"color":"#1E8E3E","abbr":"HCM"},
        "ERP Propio":      {"color":"#534AB7","abbr":"ERP"},
        "Portal Clientes": {"color":"#F29900","abbr":"WEB"},
    }
    if name in DEFAULTS:
        return DEFAULTS[name]
    try:
        with get_db() as db:
            cfg = db.execute("SELECT api_url FROM platforms_config WHERE name=?", (name,)).fetchone()
            if cfg and cfg["api_url"]:
                extra = json.loads(cfg["api_url"])
                return {"color": extra.get("color","#607D8B"), "abbr": extra.get("abbr", name[:3].upper())}
    except: pass
    return {"color":"#607D8B","abbr":name[:3].upper()}

def PLATFORMS():
    return get_platforms()

# ── Database ────────────────────────────────────────────────────────────────

def get_db():
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn

def init_db():
    with get_db() as db:
        db.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            full_name TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            rut TEXT,
            department TEXT,
            position TEXT,
            manager TEXT,
            phone TEXT,
            status TEXT DEFAULT 'Activo',
            hire_date TEXT,
            notes TEXT,
            created_at TEXT DEFAULT (datetime('now','localtime')),
            updated_at TEXT DEFAULT (datetime('now','localtime'))
        );
        CREATE TABLE IF NOT EXISTS user_platforms (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            platform TEXT NOT NULL,
            account_id TEXT,
            enabled INTEGER DEFAULT 1,
            granted_at TEXT DEFAULT (datetime('now','localtime')),
            revoked_at TEXT,
            FOREIGN KEY(user_id) REFERENCES users(id),
            UNIQUE(user_id, platform)
        );
        CREATE TABLE IF NOT EXISTS offboarding (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            reason TEXT,
            leave_date TEXT,
            status TEXT DEFAULT 'En proceso',
            initiated_by TEXT,
            completed_at TEXT,
            notes TEXT,
            created_at TEXT DEFAULT (datetime('now','localtime')),
            FOREIGN KEY(user_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            action TEXT NOT NULL,
            detail TEXT,
            performed_by TEXT DEFAULT 'Admin',
            created_at TEXT DEFAULT (datetime('now','localtime'))
        );
        CREATE TABLE IF NOT EXISTS platforms_config (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            type TEXT,
            api_url TEXT,
            status TEXT DEFAULT 'Operativo',
            last_sync TEXT,
            notes TEXT
        );
        CREATE TABLE IF NOT EXISTS platform_imports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            platform TEXT NOT NULL,
            raw_name TEXT,
            raw_email TEXT,
            raw_rut TEXT,
            raw_account_id TEXT,
            raw_status TEXT,
            raw_extra TEXT,
            matched_user_id INTEGER,
            match_method TEXT,
            match_status TEXT DEFAULT 'sin_cruce',
            imported_at TEXT DEFAULT (datetime('now','localtime')),
            FOREIGN KEY(matched_user_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS sys_roles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            description TEXT,
            permissions TEXT DEFAULT '{}',
            is_system INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now','localtime'))
        );
        CREATE TABLE IF NOT EXISTS sys_users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            full_name TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role_id INTEGER NOT NULL,
            active INTEGER DEFAULT 1,
            must_change_pw INTEGER DEFAULT 0,
            last_login TEXT,
            created_at TEXT DEFAULT (datetime('now','localtime')),
            FOREIGN KEY(role_id) REFERENCES sys_roles(id)
        );
        CREATE TABLE IF NOT EXISTS api_configs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            platform TEXT UNIQUE NOT NULL,
            api_type TEXT NOT NULL,
            base_url TEXT,
            auth_type TEXT DEFAULT 'bearer',
            token TEXT,
            username TEXT,
            password TEXT,
            client_id TEXT,
            client_secret TEXT,
            tenant_id TEXT,
            extra_params TEXT,
            field_map TEXT,
            offboard_endpoint TEXT,
            offboard_method TEXT DEFAULT 'PATCH',
            offboard_payload TEXT,
            sync_enabled INTEGER DEFAULT 0,
            sync_interval INTEGER DEFAULT 24,
            last_sync TEXT,
            last_sync_status TEXT,
            last_sync_count INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now','localtime')),
            updated_at TEXT DEFAULT (datetime('now','localtime'))
        );
        CREATE TABLE IF NOT EXISTS api_sync_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            platform TEXT NOT NULL,
            trigger TEXT DEFAULT 'manual',
            status TEXT,
            records_total INTEGER DEFAULT 0,
            records_matched INTEGER DEFAULT 0,
            records_new INTEGER DEFAULT 0,
            records_error INTEGER DEFAULT 0,
            detail TEXT,
            created_at TEXT DEFAULT (datetime('now','localtime'))
        );
        """)
        # Seed platform config
        for p in PLATFORMS_DEFAULT:
            db.execute("INSERT OR IGNORE INTO platforms_config(name, type, status) VALUES(?,?,?)",
                       (p, "ERP" if p in ("SAP","ERP Propio") else "CRM" if p=="Salesforce" else "Productividad" if p=="Office 365" else "RRHH" if p=="HCM" else "Web", "Operativo"))
        # ¿Primera instalación? Solo entonces se cargan datos de demostración y el usuario admin inicial.
        # En una instalación en uso NUNCA se vuelven a crear (ni se pisan estados) al reiniciar o actualizar.
        first_run = (db.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0 and
                     db.execute("SELECT COUNT(*) FROM sys_users").fetchone()[0] == 0)
        # El rol Superadmin siempre debe existir
        db.execute("INSERT OR IGNORE INTO sys_roles(id,name,description,permissions,is_system) VALUES(1,'Superadmin','Acceso total al sistema','*',1)")
        if first_run:
            # Seed sample users
            sample = [
                ("Ana García López","a.garcia@empresa.com","12.345.678-9","TI","Analista Senior","Carlos Jefe","2022-03-15",["SAP","Office 365","HCM","ERP Propio"]),
                ("Carlos Mendoza Ríos","c.mendoza@empresa.com","15.678.901-2","Ventas","Ejecutivo Comercial","Pedro Gerente","2021-07-01",["Salesforce","Office 365","HCM"]),
                ("María Fernández Vega","m.fernandez@empresa.com","9.876.543-1","Finanzas","Contadora","Luis Director","2020-01-10",["SAP","Office 365","HCM","ERP Propio","Portal Clientes"]),
                ("Roberto Silva Mora","r.silva@empresa.com","11.222.333-4","RRHH","Jefe de RRHH","Directora RRHH","2019-05-20",["Office 365","HCM"]),
                ("Claudia Vargas Pinto","c.vargas@empresa.com","16.789.012-3","Operaciones","Supervisora","Gerente Ops","2023-02-14",["SAP","HCM","ERP Propio"]),
                ("Pedro Ramos Díaz","p.ramos@empresa.com","7.654.321-K","TI","Desarrollador","Ana García","2018-11-03",["Office 365","HCM"]),
                ("Sofía Torres Ruiz","s.torres@empresa.com","13.456.789-0","Ventas","KAM","Pedro Gerente","2022-08-22",["Salesforce","Office 365","HCM","Portal Clientes"]),
                ("Diego Morales Jara","d.morales@empresa.com","14.567.890-1","Finanzas","Analista Jr","María Fernández","2024-01-08",[]),
                ("Laura Soto Muñoz","l.soto@empresa.com","10.111.222-3","Operaciones","Coordinadora","Gerente Ops","2021-04-19",["SAP","Office 365","HCM","ERP Propio","Salesforce"]),
                ("Javier Herrera Castro","j.herrera@empresa.com","8.999.888-7","TI","DevOps","Carlos Jefe","2020-09-07",["SAP","Office 365","HCM","ERP Propio","Salesforce","Portal Clientes"]),
            ]
            for name,email,rut,dept,pos,mgr,hire,plats in sample:
                cur = db.execute("SELECT id FROM users WHERE email=?", (email,))
                row = cur.fetchone()
                if row:
                    uid = row["id"]
                else:
                    cur = db.execute(
                        "INSERT INTO users(full_name,email,rut,department,position,manager,hire_date,status) VALUES(?,?,?,?,?,?,?,?)",
                        (name,email,rut,dept,pos,mgr,hire,"Activo"))
                    uid = cur.lastrowid
                for pl in plats:
                    db.execute("INSERT OR IGNORE INTO user_platforms(user_id,platform) VALUES(?,?)",(uid,pl))
            # Seed roles del sistema
            db.execute("INSERT OR IGNORE INTO sys_roles(id,name,description,permissions,is_system) VALUES(2,'Administrador','Gestión completa sin configuración del sistema',?,0)",
                       (json.dumps({"usuarios":{"ver":True,"crear":True,"editar":True,"eliminar":True},"plataformas":{"ver":True,"crear":True,"editar":True,"importar":True},"reportes":{"ver":True,"exportar":True},"bajas":{"ver":True,"gestionar":True},"audit":{"ver":True}}),))
            db.execute("INSERT OR IGNORE INTO sys_roles(id,name,description,permissions,is_system) VALUES(3,'Analista','Solo visualización y reportes',?,0)",
                       (json.dumps({"usuarios":{"ver":True},"plataformas":{"ver":True},"reportes":{"ver":True,"exportar":True},"bajas":{"ver":True},"audit":{"ver":True}}),))
            db.execute("INSERT OR IGNORE INTO sys_roles(id,name,description,permissions,is_system) VALUES(4,'RRHH','Gestión de usuarios y bajas',?,0)",
                       (json.dumps({"usuarios":{"ver":True,"crear":True,"editar":True},"bajas":{"ver":True,"gestionar":True},"reportes":{"ver":True,"exportar":True}}),))
            # Seed usuario admin
            import hashlib
            admin_hash = hashlib.sha256("admin123".encode()).hexdigest()
            db.execute("INSERT OR IGNORE INTO sys_users(username,full_name,email,password_hash,role_id,active,must_change_pw) VALUES(?,?,?,?,1,1,1)",
                       ("admin","Administrador del Sistema","admin@empresa.com", admin_hash))
            # Roberto en offboarding
            db.execute("UPDATE users SET status='En proceso de baja' WHERE email='r.silva@empresa.com'")
            r = db.execute("SELECT id FROM users WHERE email='r.silva@empresa.com'").fetchone()
            if r:
                db.execute("INSERT OR IGNORE INTO offboarding(user_id,reason,leave_date,status,initiated_by) VALUES(?,?,?,?,?)",
                           (r["id"],"Renuncia voluntaria",str(date.today()),"En proceso","Admin"))
        db.commit()
    run_migrations()

# ── Helpers ─────────────────────────────────────────────────────────────────

def log_action(db, user_id, action, detail):
    try:
        from flask_login import current_user
        performer = current_user.username if current_user and current_user.is_authenticated else "Sistema"
    except:
        performer = "Sistema"
    db.execute("INSERT INTO audit_log(user_id,action,detail,performed_by) VALUES(?,?,?,?)", (user_id, action, detail, performer))

def get_stats(db):
    total  = db.execute("SELECT COUNT(*) FROM users WHERE status='Activo'").fetchone()[0]
    bajas  = db.execute("SELECT COUNT(*) FROM offboarding WHERE status='En proceso'").fetchone()[0]
    plat_c = len(get_platforms())
    inact  = db.execute("SELECT COUNT(*) FROM users WHERE status='Inactivo'").fetchone()[0]
    return {"active": total, "offboarding": bajas, "platforms": plat_c, "inactive": inact}

# ── Routes ──────────────────────────────────────────────────────────────────


# ═══════════════════════════════════════════════════════════════════════════════
# API ENGINE — Conexión, sincronización y baja remota por plataforma
# ═══════════════════════════════════════════════════════════════════════════════

def api_request(url, method="GET", headers=None, payload=None, verify_ssl=True, timeout=20):
    """HTTP request usando solo stdlib (sin requests externo en producción)."""
    import urllib.request, urllib.error, ssl, json as _json
    ctx = ssl.create_default_context() if verify_ssl else ssl._create_unverified_context()
    data = _json.dumps(payload).encode() if payload else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=timeout) as r:
            body = r.read().decode("utf-8", errors="replace")
            return {"ok": True, "status": r.status, "body": body, "data": _json.loads(body) if body else {}}
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        return {"ok": False, "status": e.code, "body": body, "error": str(e)}
    except Exception as e:
        return {"ok": False, "status": 0, "body": "", "error": str(e)}

def build_auth_headers(cfg):
    """Construye headers de autenticación según tipo."""
    import base64 as _b64
    auth = cfg["auth_type"] or "bearer"
    if auth == "bearer":
        return {"Authorization": f"Bearer {cfg['token'] or ''}"}
    elif auth == "basic":
        cred = _b64.b64encode(f"{cfg['username']}:{cfg['password']}".encode()).decode()
        return {"Authorization": f"Basic {cred}"}
    elif auth == "apikey":
        return {"X-API-Key": cfg["token"] or ""}
    elif auth == "oauth2_cc":
        # Client Credentials — obtiene token
        token = get_oauth2_token(cfg)
        return {"Authorization": f"Bearer {token}"} if token else {}
    return {}

def get_oauth2_token(cfg):
    """OAuth2 Client Credentials flow."""
    import urllib.parse as _up
    tenant = cfg["tenant_id"] or "common"
    token_url = cfg["base_url"].rstrip("/") + "/oauth2/token" if cfg["api_type"] == "custom" else                 f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token"
    params = {
        "grant_type":    "client_credentials",
        "client_id":     cfg["client_id"] or "",
        "client_secret": cfg["client_secret"] or "",
        "scope":         "https://graph.microsoft.com/.default" if cfg["api_type"] == "office365" else "api",
    }
    import urllib.request as _ur, urllib.parse as _up, ssl as _ssl, json as _j
    data = _up.urlencode(params).encode()
    req = _ur.Request(token_url, data=data, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    try:
        ctx = _ssl._create_unverified_context()
        with _ur.urlopen(req, context=ctx, timeout=15) as r:
            return _j.loads(r.read()).get("access_token")
    except:
        return None

def parse_users_from_response(data_body, cfg):
    """Extrae lista de usuarios de la respuesta según tipo de API."""
    import json as _j
    try:
        body = _j.loads(data_body) if isinstance(data_body, str) else data_body
    except:
        return []
    api_type = cfg["api_type"]
    field_map = {}
    try:
        field_map = _j.loads(cfg["field_map"] or "{}")
    except:
        pass

    def extract_list(b):
        if isinstance(b, list): return b
        for k in ["value","data","users","results","items","records","employees","members"]:
            if k in b and isinstance(b[k], list): return b[k]
        return []

    users_raw = extract_list(body)

    # Campo mapping por tipo de API conocida
    DEFAULTS = {
        "office365":  {"email":"userPrincipalName","name":"displayName","id":"id","status":"accountEnabled"},
        "salesforce": {"email":"Email","name":"Name","id":"Id","status":"IsActive"},
        "sap":        {"email":"Email","name":"FullName","id":"UserName","status":"Locked"},
        "workday":    {"email":"Email_Work","name":"Worker_ID","id":"Employee_ID","status":"Active"},
        "custom":     {"email":"email","name":"name","id":"id","status":"status"},
    }
    mapping = {**DEFAULTS.get(api_type, DEFAULTS["custom"]), **field_map}

    def val(row, key):
        if not key: return ""
        parts = key.split(".")
        v = row
        for p in parts:
            if isinstance(v, dict): v = v.get(p, "")
            else: return ""
        return str(v).strip() if v is not None else ""

    result = []
    for row in users_raw:
        result.append({
            "email":  val(row, mapping.get("email","")),
            "name":   val(row, mapping.get("name","")),
            "id":     val(row, mapping.get("id","")),
            "status": val(row, mapping.get("status","")),
            "raw":    row,
        })
    return result

def do_api_sync(platform_name, trigger="manual"):
    """Ejecuta sincronización completa: llama API → cruza → guarda."""
    import json as _j
    result = {"ok": False, "total": 0, "matched": 0, "new": 0, "errors": 0, "msg": ""}
    with get_db() as db:
        cfg = db.execute("SELECT * FROM api_configs WHERE platform=?", (platform_name,)).fetchone()
        if not cfg:
            result["msg"] = "Sin configuración de API."
            return result
        if not cfg["base_url"]:
            result["msg"] = "URL base no configurada."
            return result

        # 1. Obtener headers auth
        headers = build_auth_headers(cfg)

        # 2. Llamar endpoint
        url = cfg["base_url"].rstrip("/")
        extra = {}
        try: extra = _j.loads(cfg["extra_params"] or "{}")
        except: pass
        if extra.get("query"):
            url += "?" + urllib.parse.urlencode(extra["query"])

        resp = api_request(url, headers=headers, verify_ssl=extra.get("verify_ssl", True))
        if not resp["ok"]:
            err = f"Error HTTP {resp['status']}: {resp.get('error','')}"
            db.execute("""INSERT INTO api_sync_log(platform,trigger,status,detail)
                          VALUES(?,?,?,?)""", (platform_name, trigger, "error", err))
            db.execute("""UPDATE api_configs SET last_sync=datetime('now','localtime'),
                          last_sync_status='error' WHERE platform=?""", (platform_name,))
            db.commit()
            result["msg"] = err
            return result

        # 3. Parsear usuarios
        users_api = parse_users_from_response(resp["body"], cfg)
        result["total"] = len(users_api)

        # 4. Cruce con directorio (mismo algoritmo que importación manual)
        users_by_email = {}
        users_by_rut   = {}
        users_by_name  = {}
        for u in db.execute("SELECT id,full_name,email,rut FROM users").fetchall():
            if u["email"]: users_by_email[u["email"].lower().strip()] = u["id"]
            if u["rut"]:
                rn = u["rut"].lower().replace(".","").replace("-","").strip()
                users_by_rut[rn] = u["id"]
            if u["full_name"]:
                nn = u["full_name"].lower().strip()
                nn = nn.replace("á","a").replace("é","e").replace("í","i").replace("ó","o").replace("ú","u").replace("ñ","n")
                users_by_name[nn] = u["id"]

        # Borrar registros previos API de esta plataforma en platform_imports
        db.execute("DELETE FROM platform_imports WHERE platform=? AND match_method LIKE 'api_%'", (platform_name,))

        matched = new_count = errors = 0
        for u in users_api:
            uid = None; method = None
            email = u["email"].lower().strip()
            if email and email in users_by_email:
                uid, method = users_by_email[email], "api_email"
            elif u["id"]:
                rn = u["id"].lower().replace(".","").replace("-","").strip()
                if rn in users_by_rut: uid, method = users_by_rut[rn], "api_rut"
            if not uid and u["name"]:
                nn = u["name"].lower().strip()
                nn = nn.replace("á","a").replace("é","e").replace("í","i").replace("ó","o").replace("ú","u").replace("ñ","n")
                if nn in users_by_name: uid, method = users_by_name[nn], "api_nombre"

            status = "activo" if str(u["status"]).lower() in ["true","1","activo","active","enabled","si","sí"] else "inactivo"

            if uid:
                matched += 1
                if status == "activo":
                    db.execute("""INSERT OR REPLACE INTO user_platforms(user_id,platform,account_id,enabled,granted_at)
                                  VALUES(?,?,?,1,datetime('now','localtime'))""", (uid, platform_name, u["id"]))
                else:
                    db.execute("""UPDATE user_platforms SET enabled=0,revoked_at=datetime('now','localtime')
                                  WHERE user_id=? AND platform=?""", (uid, platform_name))
                db.execute("""INSERT INTO platform_imports
                    (platform,raw_name,raw_email,raw_account_id,raw_status,matched_user_id,match_method,match_status)
                    VALUES(?,?,?,?,?,?,?,'encontrado')""",
                    (platform_name, u["name"], u["email"], u["id"], u["status"], uid, method))
            else:
                new_count += 1
                db.execute("""INSERT INTO platform_imports
                    (platform,raw_name,raw_email,raw_account_id,raw_status,match_status)
                    VALUES(?,?,?,?,?,'no_encontrado')""",
                    (platform_name, u["name"], u["email"], u["id"], u["status"]))

        # 5. Guardar log
        db.execute("""INSERT INTO api_sync_log(platform,trigger,status,records_total,records_matched,records_new,records_error,detail)
                      VALUES(?,?,'ok',?,?,?,?,?)""",
                   (platform_name, trigger, result["total"], matched, new_count, errors,
                    f"Sincronización exitosa desde API."))
        db.execute("""UPDATE api_configs SET last_sync=datetime('now','localtime'),
                      last_sync_status='ok', last_sync_count=? WHERE platform=?""",
                   (result["total"], platform_name))
        db.execute("UPDATE platforms_config SET last_sync=datetime('now','localtime') WHERE name=?", (platform_name,))
        db.commit()

        result.update({"ok":True,"matched":matched,"new":new_count,"errors":errors,
                        "msg":f"{result['total']} registros: {matched} cruzados, {new_count} sin cruce."})
        return result

def do_api_offboard(platform_name, account_id, user_display=""):
    """Ejecuta la baja del usuario en la plataforma remota vía API."""
    import json as _j
    with get_db() as db:
        cfg = db.execute("SELECT * FROM api_configs WHERE platform=?", (platform_name,)).fetchone()
        if not cfg or not cfg["offboard_endpoint"]:
            return {"ok": False, "msg": "Endpoint de baja no configurado."}
        headers = build_auth_headers(cfg)
        url = cfg["offboard_endpoint"].replace("{account_id}", account_id or "")
        try:
            payload = _j.loads((cfg["offboard_payload"] or "{}").replace("{account_id}", account_id or ""))
        except:
            payload = {}
        resp = api_request(url, method=cfg["offboard_method"] or "PATCH", headers=headers, payload=payload)
        status = "ok" if resp["ok"] else "error"
        db.execute("""INSERT INTO api_sync_log(platform,trigger,status,detail)
                      VALUES(?,'offboard',?,?)""",
                   (platform_name, status, f"Baja remota de '{user_display}' (id:{account_id}): HTTP {resp['status']}"))
        db.commit()
        return {"ok": resp["ok"], "status": resp["status"],
                "msg": f"HTTP {resp['status']}: {'Éxito' if resp['ok'] else resp.get('error','')}"}

# ── Scheduler para sincronización periódica ──────────────────────────────────
_scheduler_thread = None
_stop_scheduler   = threading.Event()

def _scheduler_loop():
    while not _stop_scheduler.is_set():
        try:
            with get_db() as db:
                configs = db.execute("""
                    SELECT platform, sync_interval, last_sync
                    FROM api_configs WHERE sync_enabled=1""").fetchall()
            for cfg in configs:
                try:
                    last = cfg["last_sync"]
                    interval_h = cfg["sync_interval"] or 24
                    if last:
                        import datetime as _dt
                        last_dt = _dt.datetime.strptime(last[:19], "%Y-%m-%d %H:%M:%S")
                        diff_h  = (_dt.datetime.now() - last_dt).total_seconds() / 3600
                        if diff_h < interval_h:
                            continue
                    do_api_sync(cfg["platform"], trigger="automatico")
                except Exception as e:
                    pass
        except Exception:
            pass
        _stop_scheduler.wait(max(1, int(CONFIG.get("scheduler_check_minutes", 5))) * 60)

def start_scheduler():
    global _scheduler_thread
    if _scheduler_thread and _scheduler_thread.is_alive():
        return
    _stop_scheduler.clear()
    _scheduler_thread = threading.Thread(target=_scheduler_loop, daemon=True)
    _scheduler_thread.start()

@app.route("/")
@login_required
def dashboard():
    with get_db() as db:
        stats = get_stats(db)
        plat_counts = []
        for p in get_platforms():
            cnt = db.execute("SELECT COUNT(*) FROM user_platforms WHERE platform=? AND enabled=1",(p,)).fetchone()[0]
            plat_counts.append({"name": p, "count": cnt})
        recent = db.execute("""
            SELECT a.action, a.detail, a.created_at, u.full_name
            FROM audit_log a LEFT JOIN users u ON a.user_id=u.id
            ORDER BY a.id DESC LIMIT 10""").fetchall()
        raw = db.execute("""
            SELECT u.id, u.full_name, u.email, GROUP_CONCAT(up.platform,', ') as plats
            FROM offboarding o
            JOIN users u ON o.user_id=u.id
            JOIN user_platforms up ON up.user_id=u.id AND up.enabled=1
            WHERE o.status='En proceso'
            GROUP BY u.id""").fetchall()
        alerts = [{"id": r["id"], "full_name": r["full_name"], "email": r["email"],
                   "plats_activos": r["plats"] or ""} for r in raw if r["plats"]]
    return render_template("dashboard.html", stats=stats, plat_counts=plat_counts,
                           recent=recent, alerts=alerts, active_page="dashboard")

@app.route("/usuarios")
@login_required
def usuarios():
    q      = request.args.get("q","")
    status = request.args.get("status","")
    dept   = request.args.get("dept","")
    plat   = request.args.get("platform","")
    sql = "SELECT DISTINCT u.* FROM users u"
    params = []
    if plat:
        sql += " JOIN user_platforms up ON up.user_id=u.id AND up.platform=? AND up.enabled=1"
        params.append(plat)
    sql += " WHERE 1=1"
    if q:
        sql += " AND (u.full_name LIKE ? OR u.email LIKE ? OR u.rut LIKE ?)"
        params += [f"%{q}%",f"%{q}%",f"%{q}%"]
    if status:
        sql += " AND u.status=?"
        params.append(status)
    if dept:
        sql += " AND u.department=?"
        params.append(dept)
    sql += " ORDER BY u.full_name"
    with get_db() as db:
        users = db.execute(sql, params).fetchall()
        users_with_plats = []
        for u in users:
            plats = db.execute("SELECT platform FROM user_platforms WHERE user_id=? AND enabled=1",(u["id"],)).fetchall()
            users_with_plats.append({"user": u, "platforms": [p["platform"] for p in plats]})
    return render_template("usuarios.html", users=users_with_plats, q=q, status=status,
                           dept=dept, platform=plat, departments=DEPARTMENTS,
                           all_platforms=get_platforms(), active_page="usuarios")

@app.route("/usuarios/nuevo", methods=["GET","POST"])
@login_required
def nuevo_usuario():
    if request.method == "POST":
        data = request.form
        plats = request.form.getlist("platforms")
        with get_db() as db:
            try:
                cur = db.execute(
                    "INSERT INTO users(full_name,email,rut,department,position,manager,phone,hire_date,status,notes) VALUES(?,?,?,?,?,?,?,?,?,?)",
                    (data["full_name"], data["email"], data.get("rut",""),
                     data.get("department",""), data.get("position",""),
                     data.get("manager",""), data.get("phone",""),
                     data.get("hire_date", str(date.today())), "Activo", data.get("notes","")))
                uid = cur.lastrowid
                for p in plats:
                    db.execute("INSERT OR IGNORE INTO user_platforms(user_id,platform) VALUES(?,?)",(uid,p))
                log_action(db, uid, "Alta de usuario", f"Usuario {data['full_name']} creado con acceso a: {', '.join(plats) or 'ninguna plataforma'}")
                db.commit()
                flash(f"Usuario {data['full_name']} creado exitosamente.", "success")
            except sqlite3.IntegrityError:
                flash("El email ya existe en el sistema.", "danger")
        return redirect(url_for("usuarios"))
    return render_template("form_usuario.html", user=None, all_platforms=get_platforms(),
                           departments=DEPARTMENTS, active_page="usuarios")

@app.route("/usuarios/<int:uid>")
@login_required
def ver_usuario(uid):
    with get_db() as db:
        u = db.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        if not u:
            return redirect(url_for("usuarios"))
        plats = db.execute("SELECT * FROM user_platforms WHERE user_id=? ORDER BY platform",(uid,)).fetchall()
        logs  = db.execute("SELECT * FROM audit_log WHERE user_id=? ORDER BY id DESC LIMIT 20",(uid,)).fetchall()
        ob    = db.execute("SELECT * FROM offboarding WHERE user_id=? ORDER BY id DESC LIMIT 1",(uid,)).fetchone()
    active_plats = {p["platform"] for p in plats if p["enabled"]}
    api_plats = {}
    for p in plats:
        if p["enabled"]:
            with get_db() as db2:
                ac = db2.execute("SELECT offboard_endpoint FROM api_configs WHERE platform=?",
                                 (p["platform"],)).fetchone()
            if ac and ac["offboard_endpoint"]:
                api_plats[p["platform"]] = p["account_id"] or ""
    return render_template("ver_usuario.html", u=u, plats=plats, logs=logs, ob=ob,
                           all_platforms=get_platforms(), active_plats=active_plats,
                           api_plats=api_plats, active_page="usuarios")

@app.route("/usuarios/<int:uid>/editar", methods=["GET","POST"])
@login_required
def editar_usuario(uid):
    with get_db() as db:
        u = db.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        plats_activos = {p["platform"] for p in db.execute(
            "SELECT platform FROM user_platforms WHERE user_id=? AND enabled=1",(uid,)).fetchall()}
    if request.method == "POST":
        data  = request.form
        plats = set(request.form.getlist("platforms"))
        with get_db() as db:
            db.execute("""UPDATE users SET full_name=?,email=?,rut=?,department=?,position=?,
                manager=?,phone=?,notes=?,updated_at=datetime('now','localtime') WHERE id=?""",
                (data["full_name"],data["email"],data.get("rut",""),data.get("department",""),
                 data.get("position",""),data.get("manager",""),data.get("phone",""),
                 data.get("notes",""),uid))
            # sync platforms
            added   = plats - plats_activos
            removed = plats_activos - plats
            for p in added:
                db.execute("INSERT OR REPLACE INTO user_platforms(user_id,platform,enabled,granted_at) VALUES(?,?,1,datetime('now','localtime'))",(uid,p))
            for p in removed:
                db.execute("UPDATE user_platforms SET enabled=0, revoked_at=datetime('now','localtime') WHERE user_id=? AND platform=?",(uid,p))
            changes = []
            if added:   changes.append(f"Acceso agregado: {', '.join(added)}")
            if removed: changes.append(f"Acceso removido: {', '.join(removed)}")
            log_action(db, uid, "Modificación de usuario", "; ".join(changes) if changes else "Datos actualizados")
            db.commit()
        flash("Usuario actualizado correctamente.", "success")
        return redirect(url_for("ver_usuario", uid=uid))
    return render_template("form_usuario.html", user=u, all_platforms=get_platforms(),
                           departments=DEPARTMENTS, plats_activos=plats_activos, active_page="usuarios")

@app.route("/usuarios/<int:uid>/baja", methods=["POST"])
def iniciar_baja(uid):
    reason     = request.form.get("reason","")
    leave_date = request.form.get("leave_date", str(date.today()))
    notes      = request.form.get("notes","")
    with get_db() as db:
        u = db.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        db.execute("UPDATE users SET status='En proceso de baja', updated_at=datetime('now','localtime') WHERE id=?", (uid,))
        db.execute("INSERT INTO offboarding(user_id,reason,leave_date,status,initiated_by,notes) VALUES(?,?,?,?,?,?)",
                   (uid, reason, leave_date, "En proceso", "Admin", notes))
        log_action(db, uid, "Inicio de baja", f"Motivo: {reason}. Fecha baja: {leave_date}")
        db.commit()
    flash(f"Proceso de baja iniciado para {u['full_name']}.", "warning")
    return redirect(url_for("ver_usuario", uid=uid))

@app.route("/usuarios/<int:uid>/revocar_todo", methods=["POST"])
def revocar_todo(uid):
    with get_db() as db:
        u = db.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        plats = db.execute("SELECT platform FROM user_platforms WHERE user_id=? AND enabled=1",(uid,)).fetchall()
        names = [p["platform"] for p in plats]
        db.execute("UPDATE user_platforms SET enabled=0, revoked_at=datetime('now','localtime') WHERE user_id=?", (uid,))
        db.execute("UPDATE offboarding SET status='Completado', completed_at=datetime('now','localtime') WHERE user_id=? AND status='En proceso'",(uid,))
        db.execute("UPDATE users SET status='Inactivo', updated_at=datetime('now','localtime') WHERE id=?", (uid,))
        log_action(db, uid, "Revocación masiva", f"Accesos revocados en: {', '.join(names)}")
        db.commit()
    flash(f"Todos los accesos de {u['full_name']} han sido revocados.", "success")
    return redirect(url_for("bajas"))

@app.route("/bajas")
@login_required
def bajas():
    filtro = request.args.get("filtro","En proceso")
    with get_db() as db:
        raw_rows = db.execute("""
            SELECT o.id, o.user_id, o.reason, o.leave_date, o.status,
                   o.initiated_by, o.completed_at, o.notes, o.created_at,
                   u.full_name, u.email, u.department,
                   GROUP_CONCAT(up.platform,', ') as plats_activos
            FROM offboarding o
            JOIN users u ON o.user_id=u.id
            LEFT JOIN user_platforms up ON up.user_id=u.id AND up.enabled=1
            WHERE (? = 'Todos' OR o.status=?)
            GROUP BY o.id ORDER BY o.created_at DESC""", (filtro, filtro)).fetchall()
        rows = [dict(r) for r in raw_rows]
        counts = {
            "En proceso": db.execute("SELECT COUNT(*) FROM offboarding WHERE status='En proceso'").fetchone()[0],
            "Completado":  db.execute("SELECT COUNT(*) FROM offboarding WHERE status='Completado'").fetchone()[0],
            "Todos":       db.execute("SELECT COUNT(*) FROM offboarding").fetchone()[0],
        }
    return render_template("bajas.html", rows=rows, filtro=filtro, counts=counts, active_page="bajas")

@app.route("/plataformas")
@login_required
def plataformas():
    with get_db() as db:
        configs = db.execute("SELECT * FROM platforms_config ORDER BY name").fetchall()
        data = []
        for c in configs:
            cnt     = db.execute("SELECT COUNT(*) FROM user_platforms WHERE platform=? AND enabled=1",(c["name"],)).fetchone()[0]
            i_total = db.execute("SELECT COUNT(*) FROM platform_imports WHERE platform=?",(c["name"],)).fetchone()[0]
            i_match = db.execute("SELECT COUNT(*) FROM platform_imports WHERE platform=? AND match_status='encontrado'",(c["name"],)).fetchone()[0]
            i_no    = db.execute("SELECT COUNT(*) FROM platform_imports WHERE platform=? AND match_status='no_encontrado'",(c["name"],)).fetchone()[0]
            meta    = get_platform_meta(c["name"])
            is_def  = c["name"] in PLATFORMS_DEFAULT
            api_cfg = db.execute("SELECT api_type,sync_enabled,last_sync,last_sync_status FROM api_configs WHERE platform=?",(c["name"],)).fetchone()
            data.append({"config": c, "user_count": cnt, "meta": meta, "is_default": is_def,
                         "import_total": i_total, "import_matched": i_match, "import_unmatched": i_no,
                         "api_cfg": dict(api_cfg) if api_cfg else None})
    return render_template("plataformas.html", data=data, active_page="plataformas")

@app.route("/plataformas/nueva", methods=["GET","POST"])
def nueva_plataforma():
    if request.method == "POST":
        name    = request.form.get("name","").strip()
        ptype   = request.form.get("type","Otro")
        color   = request.form.get("color","#1a73e8")
        abbr    = request.form.get("abbr","").strip().upper()
        notes   = request.form.get("notes","").strip()
        col_map = request.form.get("col_map","").strip()  # JSON columnas personalizadas

        if not name:
            flash("El nombre de la plataforma es obligatorio.", "danger")
            return redirect(url_for("nueva_plataforma"))

        with get_db() as db:
            existe = db.execute("SELECT id FROM platforms_config WHERE name=?", (name,)).fetchone()
            if existe:
                flash(f"Ya existe una plataforma llamada '{name}'.", "danger")
                return redirect(url_for("nueva_plataforma"))
            db.execute("""INSERT INTO platforms_config(name,type,status,notes,api_url)
                          VALUES(?,?,'Operativo',?,?)""",
                       (name, ptype, notes, json.dumps({"color":color,"abbr":abbr,"col_map":col_map})))
            log_action(db, None, "Nueva plataforma", f"Plataforma '{name}' creada (tipo: {ptype})")
            db.commit()
        flash(f"Plataforma '{name}' creada exitosamente. Ya puedes cargar usuarios desde ella.", "success")
        return redirect(url_for("plataformas"))

    return render_template("nueva_plataforma.html",
                           platform_types=PLATFORM_TYPES,
                           platform_colors=PLATFORM_COLORS,
                           active_page="plataformas")

@app.route("/plataformas/<name>/editar", methods=["GET","POST"])
def editar_plataforma(name):
    with get_db() as db:
        cfg = db.execute("SELECT * FROM platforms_config WHERE name=?", (name,)).fetchone()
    if not cfg:
        flash("Plataforma no encontrada.", "danger")
        return redirect(url_for("plataformas"))

    if request.method == "POST":
        ptype  = request.form.get("type","Otro")
        color  = request.form.get("color","#1a73e8")
        abbr   = request.form.get("abbr","").strip().upper()
        notes  = request.form.get("notes","").strip()
        status = request.form.get("status","Operativo")
        col_map= request.form.get("col_map","").strip()
        with get_db() as db:
            db.execute("""UPDATE platforms_config SET type=?,status=?,notes=?,
                          api_url=? WHERE name=?""",
                       (ptype, status, notes,
                        json.dumps({"color":color,"abbr":abbr,"col_map":col_map}), name))
            log_action(db, None, "Edición de plataforma", f"'{name}' actualizada")
            db.commit()
        flash(f"Plataforma '{name}' actualizada.", "success")
        return redirect(url_for("plataformas"))

    # Parse stored extra config
    extra = {}
    try:
        if cfg["api_url"]:
            extra = json.loads(cfg["api_url"])
    except:
        pass
    is_default = name in PLATFORMS_DEFAULT
    return render_template("nueva_plataforma.html", cfg=cfg, extra=extra,
                           is_default=is_default,
                           platform_types=PLATFORM_TYPES,
                           platform_colors=PLATFORM_COLORS,
                           active_page="plataformas")

@app.route("/plataformas/<name>/eliminar", methods=["POST"])
def eliminar_plataforma(name):
    with get_db() as db:
        # Verify it's not a default platform
        is_default = name in PLATFORMS_DEFAULT
        if is_default:
            flash(f"'{name}' es una plataforma predeterminada y no puede eliminarse.", "danger")
            return redirect(url_for("plataformas"))
        db.execute("DELETE FROM platform_imports WHERE platform=?", (name,))
        db.execute("DELETE FROM user_platforms WHERE platform=?", (name,))
        db.execute("DELETE FROM platforms_config WHERE name=?", (name,))
        log_action(db, None, "Eliminación de plataforma", f"'{name}' eliminada del sistema")
        db.commit()
    flash(f"Plataforma '{name}' eliminada correctamente.", "success")
    return redirect(url_for("plataformas"))

@app.route("/plataformas/<name>/sync", methods=["POST"])
def sync_platform(name):
    with get_db() as db:
        db.execute("UPDATE platforms_config SET last_sync=datetime('now','localtime') WHERE name=?",(name,))
        db.commit()
    return jsonify({"ok": True, "msg": f"{name} sincronizado correctamente"})

@app.route("/plataformas/<name>/importar", methods=["GET","POST"])
def importar_plataforma(name):
    if name not in get_platforms():
        flash("Plataforma no reconocida.", "danger")
        return redirect(url_for("plataformas"))

    if request.method == "GET":
        with get_db() as db:
            cfg      = db.execute("SELECT * FROM platforms_config WHERE name=?",(name,)).fetchone()
            total    = db.execute("SELECT COUNT(*) FROM platform_imports WHERE platform=?",(name,)).fetchone()[0]
            matched  = db.execute("SELECT COUNT(*) FROM platform_imports WHERE platform=? AND match_status='encontrado'",(name,)).fetchone()[0]
            unmatched= db.execute("SELECT COUNT(*) FROM platform_imports WHERE platform=? AND match_status='no_encontrado'",(name,)).fetchone()[0]
            last     = db.execute("SELECT MAX(imported_at) FROM platform_imports WHERE platform=?",(name,)).fetchone()[0]
        extra = {}
        try:
            if cfg and cfg["api_url"]: extra = json.loads(cfg["api_url"])
        except: pass
        is_default = name in PLATFORMS_DEFAULT
        return render_template("importar_plataforma.html", platform=name, cfg=cfg, extra=extra,
                               is_default=is_default, total=total, matched=matched,
                               unmatched=unmatched, last_import=last, active_page="plataformas")

    # POST — procesar archivo
    archivo = request.files.get("archivo")
    if not archivo or not archivo.filename.endswith((".xlsx",".xls",".csv")):
        flash("Debes subir un archivo .xlsx, .xls o .csv.", "danger")
        return redirect(url_for("importar_plataforma", name=name))

    try:
        if archivo.filename.endswith(".csv"):
            contenido = archivo.read().decode("utf-8-sig")
            reader = csv.DictReader(io.StringIO(contenido))
            filas = list(reader)
        else:
            import openpyxl
            wb = openpyxl.load_workbook(io.BytesIO(archivo.read()), data_only=True)
            ws = wb.active
            encabezados = [str(c.value).strip() if c.value else "" for c in next(ws.iter_rows(min_row=1, max_row=1))]
            filas = []
            for row in ws.iter_rows(min_row=2, values_only=True):
                if all(v is None for v in row):
                    continue
                filas.append({encabezados[i]: (str(v).strip() if v is not None else "") for i,v in enumerate(row)})
    except Exception as e:
        flash(f"Error al leer el archivo: {e}", "danger")
        return redirect(url_for("importar_plataforma", name=name))

    # ── Candidatos de columna por tipo de dato ──────────────────────────────
    COL_EMAIL   = {"email","correo","mail","correo_electronico","correo electronico",
                   "e-mail","upn","user principal name","username","login","usuario",
                   "sf_username","user_email","useremail","emailaddress","email address"}
    COL_NAME    = {"nombre","nombre completo","full_name","name","display name","displayname",
                   "nombre_completo","apellido nombre","nombres","nombre usuario","fullname",
                   "employeename","employee name","user name"}
    COL_RUT     = {"rut","rut/dni","dni","cedula","rut_dni","employee id","employeeid",
                   "empleado_id","empleado id","sap_user","sap user","id_usuario",
                   "id usuario","id_empleado","id empleado","codigo empleado","cod_empleado",
                   "numero documento","num_doc","identification","rut empleado"}
    COL_ACCOUNT = {"account","cuenta","account_id","sap_id","sf_id","o365_id","codigo",
                   "code","issue_id","user_id","userid","id","accountname","account name"}
    COL_STATUS  = {"estado","status","activo","active","habilitado","enabled","habilitada",
                   "state","account status"}

    # Leer col_map personalizado de la plataforma para ampliar candidatos
    try:
        with get_db() as _db:
            _cfg = _db.execute("SELECT api_url FROM platforms_config WHERE name=?",(name,)).fetchone()
            if _cfg and _cfg["api_url"]:
                _extra = json.loads(_cfg["api_url"])
                _col_map = _extra.get("col_map","")
                for col in _col_map.split(","):
                    col = col.strip().lower()
                    if not col: continue
                    if any(k in col for k in ["mail","correo","email","login","upn"]): COL_EMAIL.add(col)
                    elif any(k in col for k in ["nombre","name","display"]): COL_NAME.add(col)
                    elif any(k in col for k in ["rut","dni","id","cedula","empleado","employee"]): COL_RUT.add(col)
                    elif any(k in col for k in ["estado","status","activo","active"]): COL_STATUS.add(col)
                    else: COL_ACCOUNT.add(col)
    except: pass

    def norm_str(s):
        """Normaliza cadena: minúsculas, sin tildes, sin espacios extra."""
        if not s: return ""
        s = s.lower().strip()
        s = s.replace("á","a").replace("é","e").replace("í","i").replace("ó","o").replace("ú","u")
        s = s.replace("ä","a").replace("ë","e").replace("ï","i").replace("ö","o").replace("ü","u")
        s = s.replace("à","a").replace("è","e").replace("ì","i").replace("ò","o").replace("ù","u")
        s = s.replace("ñ","n")
        import re
        s = re.sub(r'\s+', ' ', s)
        return s

    def norm_rut(s):
        """Normaliza RUT: quita puntos, guiones, espacios."""
        if not s: return ""
        return s.lower().replace(".","").replace("-","").replace(" ","").strip()

    def norm_email(s):
        return s.lower().strip() if s else ""

    def pick(row, candidates):
        """Busca valor en fila usando candidatos de columna (flexible)."""
        for k in row:
            if norm_str(k) in {norm_str(c) for c in candidates}:
                v = row[k]
                return str(v).strip() if v else ""
        return ""

    def split_name_variants(full_name):
        """Genera variantes del nombre para cruce flexible."""
        s = norm_str(full_name)
        parts = s.split()
        variants = {s}
        if len(parts) >= 2:
            variants.add(" ".join(parts[:2]))           # primeras 2 palabras
            variants.add(" ".join([parts[-1]] + parts[:-1]))  # apellido primero
            if len(parts) >= 3:
                variants.add(f"{parts[0]} {parts[-1]}")  # nombre + último apellido
        return variants

    def extra_fields(row, skip_cols):
        skip = {norm_str(c) for c in skip_cols}
        extras = {k: v for k,v in row.items() if norm_str(k) not in skip and v}
        return json.dumps(extras, ensure_ascii=False) if extras else None

    # ── Borrar importaciones previas si modo = reemplazar ────────────────────
    reemplazar = request.form.get("modo","reemplazar") == "reemplazar"
    encontrados, no_encontrados, total_filas = 0, 0, 0

    with get_db() as db:
        if reemplazar:
            db.execute("DELETE FROM platform_imports WHERE platform=?", (name,))

        # ── Construir índices de cruce desde directorio de usuarios ──────────
        users_by_email  = {}   # email_norm        → id
        users_by_rut    = {}   # rut_norm          → id
        users_by_name   = {}   # nombre_norm       → id
        users_by_domain = {}   # parte antes de @  → id (cruce por usuario de correo)

        for u in db.execute("SELECT id, full_name, email, rut FROM users").fetchall():
            uid = u["id"]
            if u["email"]:
                em = norm_email(u["email"])
                users_by_email[em] = uid
                # También indexar la parte local del email (antes de @)
                local = em.split("@")[0]
                if local and len(local) > 3:
                    users_by_domain[local] = uid
            if u["rut"]:
                users_by_rut[norm_rut(u["rut"])] = uid
            if u["full_name"]:
                for variant in split_name_variants(u["full_name"]):
                    users_by_name[variant] = uid

        # ── Procesar cada fila ───────────────────────────────────────────────
        all_col_keys = COL_EMAIL | COL_NAME | COL_RUT | COL_ACCOUNT | COL_STATUS

        for fila in filas:
            total_filas += 1
            raw_email   = pick(fila, COL_EMAIL)
            raw_name    = pick(fila, COL_NAME)
            raw_rut     = pick(fila, COL_RUT)
            raw_account = pick(fila, COL_ACCOUNT)
            raw_status  = pick(fila, COL_STATUS)
            raw_extra   = extra_fields(fila, all_col_keys)

            matched_id, match_method = None, None

            # 1) Email exacto
            if raw_email:
                em = norm_email(raw_email)
                if em in users_by_email:
                    matched_id, match_method = users_by_email[em], "email"

            # 2) Email parcial (parte local: agarcia → a.garcia@empresa.com)
            if not matched_id and raw_email:
                local = norm_email(raw_email).split("@")[0]
                if local and len(local) > 3 and local in users_by_domain:
                    matched_id, match_method = users_by_domain[local], "email_parcial"

            # 3) RUT normalizado
            if not matched_id and raw_rut:
                rn = norm_rut(raw_rut)
                if rn and len(rn) > 3 and rn in users_by_rut:
                    matched_id, match_method = users_by_rut[rn], "rut"

            # 4) RUT desde columna de cuenta/ID (a veces el ID de SAP es el RUT)
            if not matched_id and raw_account:
                rn = norm_rut(raw_account)
                if rn and len(rn) > 5 and rn in users_by_rut:
                    matched_id, match_method = users_by_rut[rn], "rut_cuenta"

            # 5) Nombre normalizado (variantes)
            if not matched_id and raw_name:
                for variant in split_name_variants(raw_name):
                    if variant in users_by_name:
                        matched_id, match_method = users_by_name[variant], "nombre"
                        break

            # 6) Username del email como nombre (ej: "agarcia" puede ser parte del nombre)
            if not matched_id and raw_account and len(raw_account) > 3:
                acct_norm = norm_str(raw_account)
                if acct_norm in users_by_domain:
                    matched_id, match_method = users_by_domain[acct_norm], "cuenta_usuario"

            match_status = "encontrado" if matched_id else "no_encontrado"

            if matched_id:
                encontrados += 1
                db.execute("""INSERT OR REPLACE INTO user_platforms
                    (user_id, platform, account_id, enabled, granted_at)
                    VALUES (?,?,?,1,datetime('now','localtime'))""",
                    (matched_id, name, raw_account or raw_email or raw_rut))
            else:
                no_encontrados += 1

            db.execute("""INSERT INTO platform_imports
                (platform,raw_name,raw_email,raw_rut,raw_account_id,raw_status,raw_extra,
                 matched_user_id,match_method,match_status)
                VALUES (?,?,?,?,?,?,?,?,?,?)""",
                (name, raw_name, raw_email, raw_rut, raw_account,
                 raw_status, raw_extra, matched_id, match_method, match_status))

        db.execute("UPDATE platforms_config SET last_sync=datetime('now','localtime') WHERE name=?",(name,))
        log_action(db, None, f"Importacion plataforma {name}",
                   f"{total_filas} filas: {encontrados} cruzadas, {no_encontrados} sin cruce")
        db.commit()

    pct = round(encontrados/total_filas*100) if total_filas else 0
    flash(f"Importacion completada: {encontrados}/{total_filas} usuarios cruzados ({pct}%). "
          f"{no_encontrados} sin coincidencia — puedes vincularlos manualmente.",
          "success" if no_encontrados == 0 else "warning")
    return redirect(url_for("cruce_plataforma", name=name))

@app.route("/plataformas/<name>/cruce")
def cruce_plataforma(name):
    if name not in get_platforms():
        return redirect(url_for("plataformas"))
    filtro = request.args.get("filtro","todos")
    q = request.args.get("q","")
    with get_db() as db:
        base_sql = """
            SELECT pi.*, u.full_name as user_name, u.email as user_email,
                   u.department, u.status as user_status
            FROM platform_imports pi
            LEFT JOIN users u ON pi.matched_user_id = u.id
            WHERE pi.platform=?"""
        params = [name]
        if filtro == "encontrado":
            base_sql += " AND pi.match_status='encontrado'"
        elif filtro == "no_encontrado":
            base_sql += " AND pi.match_status='no_encontrado'"
        if q:
            base_sql += " AND (pi.raw_name LIKE ? OR pi.raw_email LIKE ? OR pi.raw_rut LIKE ?)"
            params += [f"%{q}%",f"%{q}%",f"%{q}%"]
        base_sql += " ORDER BY pi.match_status, pi.raw_name"
        rows = db.execute(base_sql, params).fetchall()
        counts = {
            "todos":         db.execute("SELECT COUNT(*) FROM platform_imports WHERE platform=?",(name,)).fetchone()[0],
            "encontrado":    db.execute("SELECT COUNT(*) FROM platform_imports WHERE platform=? AND match_status='encontrado'",(name,)).fetchone()[0],
            "no_encontrado": db.execute("SELECT COUNT(*) FROM platform_imports WHERE platform=? AND match_status='no_encontrado'",(name,)).fetchone()[0],
        }
        all_users = db.execute("SELECT id, full_name, email FROM users WHERE status IN ('Activo','Pendiente') ORDER BY full_name").fetchall()
    return render_template("cruce_plataforma.html", platform=name, rows=rows,
                           filtro=filtro, counts=counts, q=q,
                           all_users=all_users, active_page="plataformas")

@app.route("/plataformas/<name>/cruce/<int:import_id>/vincular", methods=["POST"])
def vincular_manual(name, import_id):
    user_id = request.form.get("user_id")
    if not user_id:
        flash("Selecciona un usuario para vincular.", "danger")
        return redirect(url_for("cruce_plataforma", name=name))
    with get_db() as db:
        pi = db.execute("SELECT * FROM platform_imports WHERE id=?", (import_id,)).fetchone()
        db.execute("""UPDATE platform_imports
            SET matched_user_id=?, match_method='manual', match_status='encontrado'
            WHERE id=?""", (user_id, import_id))
        db.execute("""INSERT OR REPLACE INTO user_platforms(user_id,platform,account_id,enabled,granted_at)
            VALUES(?,?,?,1,datetime('now','localtime'))""",
            (user_id, name, pi["raw_account_id"] or pi["raw_email"]))
        log_action(db, user_id, f"Vinculacion manual {name}", f"Registro importado vinculado manualmente")
        db.commit()
    flash("Usuario vinculado correctamente.", "success")
    return redirect(url_for("cruce_plataforma", name=name, filtro="no_encontrado"))

@app.route("/plataformas/<name>/plantilla")
def plantilla_plataforma(name):
    if name not in get_platforms():
        return "No encontrado", 404
    import openpyxl
    from openpyxl.styles import Font, PatternFill, Alignment

    PLATFORM_COLS = {
        "SAP":             ["sap_user","nombre","email","rut","perfil","mandante","grupo","estado"],
        "Salesforce":      ["sf_username","nombre","email","perfil","rol","licencia","estado","ultimo_acceso"],
        "Office 365":      ["upn","nombre","email","licencia","grupo","mfa_activo","estado"],
        "HCM":             ["empleado_id","nombre","email","rut","departamento","cargo","fecha_ingreso","estado"],
        "ERP Propio":      ["usuario","nombre","email","rut","modulo","rol","estado"],
        "Portal Clientes": ["username","nombre","email","empresa","plan","estado","ultimo_acceso"],
    }

    # Para plataformas personalizadas, leer col_map si existe
    default_cols = ["nombre","email","rut","id_usuario","rol","estado"]
    if name not in PLATFORM_COLS:
        try:
            with get_db() as db:
                cfg = db.execute("SELECT api_url FROM platforms_config WHERE name=?",(name,)).fetchone()
                if cfg and cfg["api_url"]:
                    extra = json.loads(cfg["api_url"])
                    col_map_str = extra.get("col_map","").strip()
                    if col_map_str:
                        custom_cols = [c.strip() for c in col_map_str.split(",") if c.strip()]
                        if custom_cols:
                            default_cols = custom_cols
        except: pass
    cols = PLATFORM_COLS.get(name, default_cols)

    # Obtener color dinámico
    meta  = get_platform_meta(name)
    color = meta["color"].lstrip("#")

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = name[:30]

    fill   = PatternFill("solid", fgColor=color)
    bold_w = Font(bold=True, color="FFFFFF", size=11)
    center = Alignment(horizontal="center", vertical="center")

    for i, col in enumerate(cols, 1):
        c = ws.cell(row=1, column=i, value=col)
        c.font = bold_w; c.fill = fill; c.alignment = center
        ws.column_dimensions[c.column_letter].width = 20

    # Filas de ejemplo para plataformas conocidas
    EJEMPLOS = {
        "SAP":             [["AGARCIA","Ana Garcia Lopez","a.garcia@empresa.com","12.345.678-9","MM_USER","100","GR_FINANCE","Activo"],
                            ["CMENDOZA","Carlos Mendoza","c.mendoza@empresa.com","15.678.901-2","SD_USER","100","GR_SALES","Activo"]],
        "Salesforce":      [["a.garcia@empresa.com","Ana Garcia Lopez","a.garcia@empresa.com","Standard User","Ventas","Salesforce","Activo","2024-01-10"],
                            ["c.mendoza@empresa.com","Carlos Mendoza","c.mendoza@empresa.com","Sales Rep","Ventas","Salesforce","Activo","2024-01-09"]],
        "Office 365":      [["a.garcia@empresa.com","Ana Garcia Lopez","a.garcia@empresa.com","E3","GrupoTI","Si","Activo"],
                            ["c.mendoza@empresa.com","Carlos Mendoza","c.mendoza@empresa.com","E1","GrupoVentas","Si","Activo"]],
        "HCM":             [["10001","Ana Garcia Lopez","a.garcia@empresa.com","12.345.678-9","TI","Analista Senior","2022-03-15","Activo"],
                            ["10002","Carlos Mendoza","c.mendoza@empresa.com","15.678.901-2","Ventas","Ejecutivo","2021-07-01","Activo"]],
        "ERP Propio":      [["agarcia","Ana Garcia Lopez","a.garcia@empresa.com","12.345.678-9","Inventario","Admin","Activo"],
                            ["cmendoza","Carlos Mendoza","c.mendoza@empresa.com","15.678.901-2","Ventas","Usuario","Activo"]],
        "Portal Clientes": [["agarcia","Ana Garcia Lopez","a.garcia@empresa.com","Empresa SA","Premium","Activo","2024-01-10"],
                            ["cmendoza","Carlos Mendoza","c.mendoza@empresa.com","Empresa SA","Basic","Activo","2024-01-08"]],
    }
    # Para plataformas custom, generar fila de ejemplo genérica
    if name not in EJEMPLOS:
        ejemplo_fila = []
        for col in cols:
            if "email" in col.lower():   ejemplo_fila.append("usuario@empresa.com")
            elif "nombre" in col.lower(): ejemplo_fila.append("Juan Pérez")
            elif "rut" in col.lower():    ejemplo_fila.append("12.345.678-9")
            elif "estado" in col.lower(): ejemplo_fila.append("Activo")
            elif "id" in col.lower():     ejemplo_fila.append("USR001")
            elif "rol" in col.lower():    ejemplo_fila.append("Usuario")
            else:                         ejemplo_fila.append("")
        EJEMPLOS[name] = [ejemplo_fila]

    for row_i, fila in enumerate(EJEMPLOS.get(name,[]), 2):
        for col_i, val in enumerate(fila, 1):
            ws.cell(row=row_i, column=col_i, value=val)

    # Hoja instrucciones
    wi = wb.create_sheet("Instrucciones")
    instrucciones = [
        [f"Plantilla de importacion para {name}"],
        [""],
        ["Esta plantilla es especifica para cargar usuarios desde el reporte de exportacion de " + name + "."],
        ["El sistema intentara cruzar cada fila con el directorio principal de usuarios usando:"],
        ["  1) Email (columna 'email' o similar)"],
        ["  2) RUT (columna 'rut', 'rut/dni', 'empleado_id', etc.)"],
        ["  3) Nombre completo (si coincide exactamente)"],
        [""],
        ["Los usuarios que no se crucen automaticamente podran vincularse manualmente desde la pantalla de cruce."],
        [""],
        ["COLUMNAS DE ESTA PLANTILLA:"],
    ] + [[c, ""] for c in cols]
    for r, fila in enumerate(instrucciones, 1):
        for c, val in enumerate(fila, 1):
            cell = wi.cell(row=r, column=c, value=val)
            if r == 1: cell.font = Font(bold=True, size=13, color=color)
        wi.column_dimensions["A"].width = 30
        wi.column_dimensions["B"].width = 40

    buf = io.BytesIO()
    wb.save(buf); buf.seek(0)
    safe_name = name.replace(" ","_").replace("/","_")
    return send_file(buf, mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                     download_name=f"plantilla_{safe_name}.xlsx", as_attachment=True)

@app.route("/reportes")
@login_required
def reportes():
    with get_db() as db:
        stats = get_stats(db)
    return render_template("reportes.html", stats=stats, active_page="reportes")

@app.route("/reportes/exportar")
def exportar_reporte():
    tipo   = request.args.get("tipo","usuarios")
    formato = request.args.get("formato","csv")

    with get_db() as db:
        if tipo == "usuarios":
            rows = db.execute("SELECT u.*, GROUP_CONCAT(up.platform,', ') as plataformas FROM users u LEFT JOIN user_platforms up ON up.user_id=u.id AND up.enabled=1 GROUP BY u.id ORDER BY u.full_name").fetchall()
            headers = ["ID","Nombre","Email","RUT","Departamento","Cargo","Manager","Teléfono","Estado","Fecha Contrato","Plataformas","Creado"]
            data    = [(r["id"],r["full_name"],r["email"],r["rut"],r["department"],r["position"],r["manager"],r["phone"],r["status"],r["hire_date"],r["plataformas"] or "",r["created_at"]) for r in rows]
            title   = "Inventario de Usuarios"
        elif tipo == "bajas":
            rows = db.execute("SELECT o.*,u.full_name,u.email,u.department FROM offboarding o JOIN users u ON o.user_id=u.id ORDER BY o.created_at DESC").fetchall()
            headers = ["ID","Usuario","Email","Departamento","Motivo","Fecha Baja","Estado","Iniciado por","Completado","Notas"]
            data    = [(r["id"],r["full_name"],r["email"],r["department"],r["reason"],r["leave_date"],r["status"],r["initiated_by"],r["completed_at"] or "",r["notes"] or "") for r in rows]
            title   = "Reporte de Bajas y Desvinculaciones"
        elif tipo == "plataformas":
            rows = db.execute("SELECT up.*,u.full_name,u.email,u.department FROM user_platforms up JOIN users u ON up.user_id=u.id ORDER BY up.platform,u.full_name").fetchall()
            headers = ["Plataforma","Usuario","Email","Departamento","Habilitado","Otorgado","Revocado"]
            data    = [(r["platform"],r["full_name"],r["email"],r["department"],"Sí" if r["enabled"] else "No",r["granted_at"],r["revoked_at"] or "") for r in rows]
            title   = "Accesos por Plataforma"
        elif tipo == "audit":
            rows = db.execute("SELECT a.*,u.full_name FROM audit_log a LEFT JOIN users u ON a.user_id=u.id ORDER BY a.id DESC").fetchall()
            headers = ["ID","Usuario","Acción","Detalle","Realizado por","Fecha"]
            data    = [(r["id"],r["full_name"] or "—",r["action"],r["detail"] or "",r["performed_by"],r["created_at"]) for r in rows]
            title   = "Audit Log"
        else:
            return "Tipo no válido", 400

    if formato == "csv":
        output = io.StringIO()
        w = csv.writer(output)
        w.writerow(headers)
        w.writerows(data)
        output.seek(0)
        bio = io.BytesIO(output.getvalue().encode("utf-8-sig"))
        bio.seek(0)
        return send_file(bio, mimetype="text/csv",
                         download_name=f"usersync_{tipo}_{date.today()}.csv",
                         as_attachment=True)

    elif formato == "pdf":
        buf = io.BytesIO()
        doc = SimpleDocTemplate(buf, pagesize=landscape(A4),
                                leftMargin=1.5*cm, rightMargin=1.5*cm,
                                topMargin=2*cm, bottomMargin=2*cm)
        styles = getSampleStyleSheet()
        elems  = []
        elems.append(Paragraph(f"<b>{title}</b>", ParagraphStyle("title", fontSize=16, spaceAfter=4)))
        elems.append(Paragraph(f"Generado: {datetime.now().strftime('%d/%m/%Y %H:%M')}  |  UserSync v1.0",
                               ParagraphStyle("sub", fontSize=9, textColor=colors.grey, spaceAfter=16)))
        elems.append(Spacer(1, 0.3*cm))
        tdata = [list(headers)] + [list(r) for r in data]
        col_w = [(landscape(A4)[0] - 3*cm) / len(headers)] * len(headers)
        t = Table(tdata, colWidths=col_w, repeatRows=1)
        t.setStyle(TableStyle([
            ("BACKGROUND",(0,0),(-1,0), colors.HexColor("#1a73e8")),
            ("TEXTCOLOR",(0,0),(-1,0), colors.white),
            ("FONTSIZE",(0,0),(-1,0), 9),
            ("FONTNAME",(0,0),(-1,0), "Helvetica-Bold"),
            ("FONTSIZE",(0,1),(-1,-1), 7.5),
            ("ROWBACKGROUNDS",(0,1),(-1,-1),[colors.white, colors.HexColor("#f5f8ff")]),
            ("GRID",(0,0),(-1,-1), 0.3, colors.HexColor("#dde3ed")),
            ("VALIGN",(0,0),(-1,-1),"MIDDLE"),
            ("LEFTPADDING",(0,0),(-1,-1), 4),
            ("RIGHTPADDING",(0,0),(-1,-1), 4),
            ("TOPPADDING",(0,0),(-1,-1), 4),
            ("BOTTOMPADDING",(0,0),(-1,-1), 4),
        ]))
        elems.append(t)
        doc.build(elems)
        buf.seek(0)
        return send_file(buf, mimetype="application/pdf",
                         download_name=f"usersync_{tipo}_{date.today()}.pdf",
                         as_attachment=True)

@app.route("/importar", methods=["GET","POST"])
def importar():
    if request.method == "GET":
        return render_template("importar.html", active_page="usuarios")

    archivo = request.files.get("archivo")
    if not archivo or not archivo.filename.endswith((".xlsx",".xls",".csv")):
        flash("Debes subir un archivo Excel (.xlsx/.xls) o CSV.", "danger")
        return redirect(url_for("importar"))

    modo = request.form.get("modo","omitir")  # omitir | actualizar

    filas_ok, filas_error, filas_dup = 0, 0, 0
    errores = []

    try:
        if archivo.filename.endswith(".csv"):
            contenido = archivo.read().decode("utf-8-sig")
            reader = csv.DictReader(io.StringIO(contenido))
            filas = list(reader)
        else:
            import openpyxl
            wb = openpyxl.load_workbook(io.BytesIO(archivo.read()), data_only=True)
            ws = wb.active
            encabezados = [str(c.value).strip() if c.value else "" for c in next(ws.iter_rows(min_row=1, max_row=1))]
            filas = []
            for row in ws.iter_rows(min_row=2, values_only=True):
                if all(v is None for v in row):
                    continue
                filas.append({encabezados[i]: (str(v).strip() if v is not None else "") for i,v in enumerate(row)})
    except Exception as e:
        flash(f"Error al leer el archivo: {e}", "danger")
        return redirect(url_for("importar"))

    # ── Función de normalización ─────────────────────────────────────────────
    def _norm(s):
        if not s: return ""
        s = s.lower().strip()
        for a,b in [("á","a"),("é","e"),("í","i"),("ó","o"),("ú","u"),
                    ("ä","a"),("ë","e"),("ï","i"),("ö","o"),("ü","u"),("ñ","n")]:
            s = s.replace(a,b)
        import re; return re.sub(r'\s+',' ',s)

    # Mapeo flexible de columnas (ampliado)
    COL_MAP = {
        "full_name":  ["nombre","nombre completo","full_name","name","nombre_completo",
                       "nombres","apellido nombre","employeename","employee name","display name","displayname"],
        "email":      ["email","correo","mail","correo electronico","correo_electronico",
                       "upn","e-mail","emailaddress","email address","correo corporativo"],
        "rut":        ["rut","rut/dni","dni","cedula","rut_dni","identificacion",
                       "num_doc","numero documento","id_empleado","empleado_id"],
        "department": ["departamento","depto","area","department","area/depto","gerencia","division"],
        "position":   ["cargo","position","puesto","rol","titulo","titulo_cargo","job title"],
        "manager":    ["jefe","manager","jefatura","supervisor","jefe directo","reporta_a"],
        "phone":      ["telefono","phone","fono","celular","movil","telefono_celular"],
        "hire_date":  ["fecha contrato","fecha_contrato","hire_date","fecha ingreso",
                       "fecha_ingreso","fecha inicio","fecha_inicio","start date"],
        "notes":      ["notas","notes","observaciones","comentarios","descripcion"],
    }
    # Plataformas permitidas
    PLAT_COLS = {p.lower(): p for p in get_platforms()}

    def find_col(row, candidates):
        cands_norm = {_norm(c) for c in candidates}
        for k in row:
            if _norm(k) in cands_norm:
                return row[k] or ""
        return ""

    with get_db() as db:
        for i, fila in enumerate(filas, start=2):
            nombre = find_col(fila, COL_MAP["full_name"]).strip()
            email  = find_col(fila, COL_MAP["email"]).strip().lower()
            if not nombre or not email:
                filas_error += 1
                errores.append(f"Fila {i}: nombre o email vacío.")
                continue

            rut    = find_col(fila, COL_MAP["rut"])
            dept   = find_col(fila, COL_MAP["department"])
            pos    = find_col(fila, COL_MAP["position"])
            mgr    = find_col(fila, COL_MAP["manager"])
            phone  = find_col(fila, COL_MAP["phone"])
            hire   = find_col(fila, COL_MAP["hire_date"])
            notes  = find_col(fila, COL_MAP["notes"])

            # Detectar plataformas marcadas en columnas extra
            plats_usuario = []
            for k, v in fila.items():
                kl = k.lower().strip()
                if kl in PLAT_COLS and str(v).strip().lower() in ("1","si","sí","yes","x","true","activo"):
                    plats_usuario.append(PLAT_COLS[kl])

            existente = db.execute("SELECT id FROM users WHERE email=?", (email,)).fetchone()

            if existente:
                if modo == "omitir":
                    filas_dup += 1
                    continue
                elif modo == "actualizar":
                    uid = existente["id"]
                    db.execute("""UPDATE users SET full_name=?,rut=?,department=?,position=?,
                        manager=?,phone=?,hire_date=?,notes=?,updated_at=datetime('now','localtime')
                        WHERE id=?""", (nombre,rut,dept,pos,mgr,phone,hire,notes,uid))
                    for p in plats_usuario:
                        db.execute("INSERT OR IGNORE INTO user_platforms(user_id,platform) VALUES(?,?)",(uid,p))
                    log_action(db, uid, "Importacion Excel (actualizacion)", f"Datos actualizados desde archivo")
                    filas_ok += 1
            else:
                try:
                    cur = db.execute(
                        "INSERT INTO users(full_name,email,rut,department,position,manager,phone,hire_date,notes,status) VALUES(?,?,?,?,?,?,?,?,?,?)",
                        (nombre,email,rut,dept,pos,mgr,phone,hire,notes,"Activo"))
                    uid = cur.lastrowid
                    for p in plats_usuario:
                        db.execute("INSERT OR IGNORE INTO user_platforms(user_id,platform) VALUES(?,?)",(uid,p))
                    log_action(db, uid, "Importacion Excel (alta)", f"Usuario importado desde archivo masivo")
                    filas_ok += 1
                except Exception as e:
                    filas_error += 1
                    errores.append(f"Fila {i} ({email}): {e}")
        db.commit()

    resumen = f"Importacion completada: {filas_ok} creados/actualizados, {filas_dup} duplicados omitidos, {filas_error} errores."
    flash(resumen, "success" if filas_error == 0 else "warning")
    if errores:
        for e in errores[:5]:
            flash(e, "danger")
    return redirect(url_for("usuarios"))

@app.route("/importar/plantilla")
def descargar_plantilla():
    import openpyxl
    from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Usuarios"

    encabezados = ["nombre","email","rut","departamento","cargo","jefe","telefono","fecha_contrato","notas"] + get_platforms()
    azul  = PatternFill("solid", fgColor="1a73e8")
    verde = PatternFill("solid", fgColor="34a853")
    bold_w = Font(bold=True, color="FFFFFF", size=11)
    bold_g = Font(bold=True, color="FFFFFF", size=10)
    borde  = Border(bottom=Side(style="thin",color="DADCE0"))
    center = Alignment(horizontal="center", vertical="center")

    for col, enc in enumerate(encabezados, 1):
        c = ws.cell(row=1, column=col, value=enc)
        c.font  = bold_w if col <= 9 else bold_g
        c.fill  = azul  if col <= 9 else verde
        c.alignment = center
        c.border = borde
        ws.column_dimensions[c.column_letter].width = 18

    # Filas de ejemplo
    ejemplos = [
        ["Ana Garcia Lopez","a.garcia@empresa.com","12.345.678-9","TI","Analista","Carlos Jefe","+56912345678","2023-01-15","","1","0","1","1","1","0"],
        ["Carlos Mendoza","c.mendoza@empresa.com","15.678.901-2","Ventas","Ejecutivo","Pedro Gerente","+56987654321","2022-06-01","","0","1","1","1","0","0"],
    ]
    for row_i, fila in enumerate(ejemplos, 2):
        for col_i, val in enumerate(fila, 1):
            ws.cell(row=row_i, column=col_i, value=val)

    # Hoja de instrucciones
    wi = wb.create_sheet("Instrucciones")
    instrucciones = [
        ["INSTRUCCIONES DE IMPORTACION"],
        [""],
        ["COLUMNAS OBLIGATORIAS:"],
        ["nombre", "Nombre completo del usuario"],
        ["email",  "Correo corporativo (debe ser unico)"],
        [""],
        ["COLUMNAS OPCIONALES:"],
        ["rut",           "RUT o numero de identificacion"],
        ["departamento",  "Area o departamento"],
        ["cargo",         "Puesto o rol del usuario"],
        ["jefe",          "Nombre del jefe directo"],
        ["telefono",      "Telefono de contacto"],
        ["fecha_contrato","Fecha de ingreso (YYYY-MM-DD)"],
        ["notas",         "Observaciones adicionales"],
        [""],
        ["COLUMNAS DE PLATAFORMAS (usar 1 = con acceso, 0 = sin acceso):"],
    ] + [[p, f"Acceso a {p}"] for p in get_platforms()]

    for r, fila in enumerate(instrucciones, 1):
        for c, val in enumerate(fila, 1):
            cell = wi.cell(row=r, column=c, value=val)
            if r == 1:
                cell.font = Font(bold=True, size=13, color="1a73e8")
            elif val in (["COLUMNAS OBLIGATORIAS:"],["COLUMNAS OPCIONALES:"],["COLUMNAS DE PLATAFORMAS (usar 1 = con acceso, 0 = sin acceso):"]) or (c==1 and r>2 and val):
                cell.font = Font(bold=True)
        wi.column_dimensions["A"].width = 30
        wi.column_dimensions["B"].width = 40

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return send_file(buf, mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                     download_name="plantilla_usuarios_usersync.xlsx", as_attachment=True)

@app.route("/bajas/nueva", methods=["GET","POST"])
def nueva_baja():
    if request.method == "POST":
        uid        = request.form.get("user_id")
        reason     = request.form.get("reason","")
        leave_date = request.form.get("leave_date", str(date.today()))
        notes      = request.form.get("notes","")
        if not uid:
            flash("Debes seleccionar un usuario.", "danger")
            return redirect(url_for("nueva_baja"))
        with get_db() as db:
            u = db.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
            if not u:
                flash("Usuario no encontrado.", "danger")
                return redirect(url_for("nueva_baja"))
            ya_existe = db.execute("SELECT id FROM offboarding WHERE user_id=? AND status='En proceso'", (uid,)).fetchone()
            if ya_existe:
                flash(f"{u['full_name']} ya tiene un proceso de baja activo.", "warning")
                return redirect(url_for("bajas"))
            db.execute("UPDATE users SET status='En proceso de baja', updated_at=datetime('now','localtime') WHERE id=?", (uid,))
            db.execute("INSERT INTO offboarding(user_id,reason,leave_date,status,initiated_by,notes) VALUES(?,?,?,?,?,?)",
                       (uid, reason, leave_date, "En proceso", "Admin", notes))
            log_action(db, uid, "Inicio de baja", f"Motivo: {reason}. Fecha baja: {leave_date}")
            db.commit()
        flash(f"Proceso de baja iniciado para {u['full_name']}.", "warning")
        return redirect(url_for("bajas"))

    # GET — buscar usuario
    q = request.args.get("q","")
    usuarios = []
    if q:
        with get_db() as db:
            usuarios = db.execute("""
                SELECT * FROM users
                WHERE status IN ('Activo','Pendiente')
                AND (full_name LIKE ? OR email LIKE ? OR rut LIKE ?)
                ORDER BY full_name LIMIT 20""",
                (f"%{q}%",f"%{q}%",f"%{q}%")).fetchall()
    return render_template("nueva_baja.html", usuarios=usuarios, q=q,
                           active_page="bajas", reasons=OFFBOARD_REASONS)

@app.route("/audit")
@login_required
def audit():
    with get_db() as db:
        logs = db.execute("""
            SELECT a.*,u.full_name FROM audit_log a
            LEFT JOIN users u ON a.user_id=u.id
            ORDER BY a.id DESC LIMIT 200""").fetchall()
    return render_template("audit.html", logs=logs, active_page="audit")

@app.route("/api/stats")
def api_stats():
    with get_db() as db:
        return jsonify(get_stats(db))

# ── AUTH ROUTES ─────────────────────────────────────────────────────────────

@app.route("/login", methods=["GET","POST"])
def login_page():
    if current_user.is_authenticated:
        return redirect(url_for("dashboard"))
    error = None
    if request.method == "POST":
        username = request.form.get("username","").strip().lower()
        password = request.form.get("password","")
        with get_db() as db:
            row = db.execute("SELECT * FROM sys_users WHERE (username=? OR email=?) AND active=1",
                             (username, username)).fetchone()
            if row and row["password_hash"] == hash_pw(password):
                user = SysUser(row)
                login_user(user, remember=request.form.get("remember")=="on")
                session.permanent = True
                db.execute("UPDATE sys_users SET last_login=datetime('now','localtime') WHERE id=?", (row["id"],))
                db.commit()
                log_action(db, None, "Login", f"Sesión iniciada: {row['username']}")
                db.commit()
                if row["must_change_pw"]:
                    flash("Debes cambiar tu contraseña antes de continuar.", "warning")
                    return redirect(url_for("cambiar_password"))
                nxt = request.args.get("next") or url_for("dashboard")
                return redirect(nxt)
            else:
                error = "Usuario o contraseña incorrectos."
    with get_db() as db:
        show_hint = db.execute("SELECT 1 FROM sys_users WHERE username='admin' AND must_change_pw=1 AND password_hash=?",
                               (hash_pw("admin123"),)).fetchone() is not None
    return render_template("login.html", error=error, show_hint=show_hint)

@app.route("/logout")
@login_required
def logout():
    with get_db() as db:
        log_action(db, None, "Logout", f"Sesión cerrada: {current_user.username}")
        db.commit()
    logout_user()
    flash("Sesión cerrada correctamente.", "success")
    return redirect(url_for("login_page"))

@app.route("/cambiar-password", methods=["GET","POST"])
@login_required
def cambiar_password():
    error = None
    if request.method == "POST":
        actual  = request.form.get("actual","")
        nueva   = request.form.get("nueva","")
        repite  = request.form.get("repite","")
        with get_db() as db:
            row = db.execute("SELECT password_hash FROM sys_users WHERE id=?", (current_user.id,)).fetchone()
            if row["password_hash"] != hash_pw(actual):
                error = "La contraseña actual no es correcta."
            elif len(nueva) < 6:
                error = "La nueva contraseña debe tener al menos 6 caracteres."
            elif nueva != repite:
                error = "Las contraseñas no coinciden."
            else:
                db.execute("UPDATE sys_users SET password_hash=?, must_change_pw=0 WHERE id=?",
                           (hash_pw(nueva), current_user.id))
                log_action(db, None, "Cambio de contraseña", f"Usuario {current_user.username} cambió su contraseña")
                db.commit()
                flash("Contraseña actualizada correctamente.", "success")
                return redirect(url_for("dashboard"))
    return render_template("cambiar_password.html", error=error, active_page="")

# ── CONFIGURACIÓN / ADMIN ROUTES ─────────────────────────────────────────────

@app.route("/configuracion")
@login_required
def configuracion():
    if not has_perm("configuracion","ver"):
        flash("Sin permiso para ver configuración.", "danger")
        return redirect(url_for("dashboard"))
    with get_db() as db:
        sys_users = db.execute("""
            SELECT su.*, sr.name as role_name
            FROM sys_users su JOIN sys_roles sr ON su.role_id=sr.id
            ORDER BY su.active DESC, su.full_name""").fetchall()
        roles = db.execute("SELECT * FROM sys_roles ORDER BY is_system DESC, name").fetchall()
    return render_template("configuracion.html", sys_users=sys_users, roles=roles,
                           perms=PERMS, can_service=has_perm("configuracion","servicio"), active_page="configuracion")

@app.route("/configuracion/usuarios/nuevo", methods=["GET","POST"])
@login_required
def nuevo_sys_user():
    if not has_perm("configuracion","gestionar"):
        flash("Sin permiso.", "danger"); return redirect(url_for("configuracion"))
    with get_db() as db:
        roles = db.execute("SELECT * FROM sys_roles ORDER BY name").fetchall()
    if request.method == "POST":
        username  = request.form.get("username","").strip().lower()
        full_name = request.form.get("full_name","").strip()
        email     = request.form.get("email","").strip().lower()
        role_id   = request.form.get("role_id")
        pw_temp   = request.form.get("password","").strip() or "Cambiar123"
        must_change = 1 if request.form.get("must_change") else 0
        if not username or not full_name or not email or not role_id:
            flash("Completa todos los campos obligatorios.", "danger")
            return render_template("form_sys_user.html", roles=roles, user=None, active_page="configuracion")
        with get_db() as db:
            try:
                db.execute("""INSERT INTO sys_users(username,full_name,email,password_hash,role_id,must_change_pw)
                              VALUES(?,?,?,?,?,?)""",
                           (username, full_name, email, hash_pw(pw_temp), role_id, must_change))
                log_action(db, None, "Nuevo usuario del sistema", f"Usuario {username} creado con rol {role_id}")
                db.commit()
                flash(f"Usuario '{username}' creado. Contraseña temporal: {pw_temp}", "success")
            except sqlite3.IntegrityError:
                flash("El username o email ya existe.", "danger")
        return redirect(url_for("configuracion"))
    return render_template("form_sys_user.html", roles=roles, user=None, active_page="configuracion")

@app.route("/configuracion/usuarios/<int:uid>/editar", methods=["GET","POST"])
@login_required
def editar_sys_user(uid):
    if not has_perm("configuracion","gestionar"):
        flash("Sin permiso.", "danger"); return redirect(url_for("configuracion"))
    with get_db() as db:
        u     = db.execute("SELECT * FROM sys_users WHERE id=?", (uid,)).fetchone()
        roles = db.execute("SELECT * FROM sys_roles ORDER BY name").fetchall()
    if not u:
        return redirect(url_for("configuracion"))
    if request.method == "POST":
        full_name = request.form.get("full_name","").strip()
        email     = request.form.get("email","").strip().lower()
        role_id   = request.form.get("role_id")
        active    = 1 if request.form.get("active") else 0
        new_pw    = request.form.get("new_password","").strip()
        must_change = 1 if request.form.get("must_change") else 0
        with get_db() as db:
            db.execute("""UPDATE sys_users SET full_name=?,email=?,role_id=?,active=?,must_change_pw=?
                          WHERE id=?""", (full_name, email, role_id, active, must_change, uid))
            if new_pw and len(new_pw) >= 6:
                db.execute("UPDATE sys_users SET password_hash=? WHERE id=?", (hash_pw(new_pw), uid))
                flash(f"Contraseña actualizada.", "success")
            log_action(db, None, "Edición usuario sistema", f"Usuario id={uid} actualizado")
            db.commit()
        flash("Usuario actualizado.", "success")
        return redirect(url_for("configuracion"))
    return render_template("form_sys_user.html", roles=roles, user=u, active_page="configuracion")

@app.route("/configuracion/usuarios/<int:uid>/toggle", methods=["POST"])
@login_required
def toggle_sys_user(uid):
    if not has_perm("configuracion","gestionar"):
        return jsonify({"ok":False})
    if uid == current_user.id:
        return jsonify({"ok":False,"msg":"No puedes desactivarte a ti mismo"})
    with get_db() as db:
        u = db.execute("SELECT active FROM sys_users WHERE id=?", (uid,)).fetchone()
        new_state = 0 if u["active"] else 1
        db.execute("UPDATE sys_users SET active=? WHERE id=?", (new_state, uid))
        log_action(db, None, "Toggle usuario sistema", f"Usuario id={uid} {'activado' if new_state else 'desactivado'}")
        db.commit()
    return jsonify({"ok":True, "active": new_state})

@app.route("/configuracion/roles/nuevo", methods=["GET","POST"])
@login_required
def nuevo_rol():
    if not has_perm("configuracion","gestionar"):
        flash("Sin permiso.", "danger"); return redirect(url_for("configuracion"))
    if request.method == "POST":
        name  = request.form.get("name","").strip()
        desc  = request.form.get("description","").strip()
        perms = {}
        for module in PERMS:
            perms[module] = {}
            for action in PERMS[module]:
                if request.form.get(f"perm_{module}_{action}"):
                    perms[module][action] = True
        with get_db() as db:
            try:
                db.execute("INSERT INTO sys_roles(name,description,permissions) VALUES(?,?,?)",
                           (name, desc, json.dumps(perms)))
                log_action(db, None, "Nuevo rol", f"Rol '{name}' creado")
                db.commit()
                flash(f"Rol '{name}' creado.", "success")
            except sqlite3.IntegrityError:
                flash("Ya existe un rol con ese nombre.", "danger")
        return redirect(url_for("configuracion"))
    return render_template("form_rol.html", rol=None, perms=PERMS, active_page="configuracion")

@app.route("/configuracion/roles/<int:rid>/editar", methods=["GET","POST"])
@login_required
def editar_rol(rid):
    if not has_perm("configuracion","gestionar"):
        flash("Sin permiso.", "danger"); return redirect(url_for("configuracion"))
    with get_db() as db:
        rol = db.execute("SELECT * FROM sys_roles WHERE id=?", (rid,)).fetchone()
    if not rol:
        return redirect(url_for("configuracion"))
    if request.method == "POST":
        name = request.form.get("name","").strip()
        desc = request.form.get("description","").strip()
        perms = {}
        for module in PERMS:
            perms[module] = {}
            for action in PERMS[module]:
                if request.form.get(f"perm_{module}_{action}"):
                    perms[module][action] = True
        with get_db() as db:
            db.execute("UPDATE sys_roles SET name=?,description=?,permissions=? WHERE id=?",
                       (name, desc, json.dumps(perms), rid))
            log_action(db, None, "Edición rol", f"Rol id={rid} actualizado")
            db.commit()
        flash("Rol actualizado.", "success")
        return redirect(url_for("configuracion"))
    current_perms = {}
    if rol["permissions"] != "*":
        try: current_perms = json.loads(rol["permissions"] or "{}")
        except: pass
    return render_template("form_rol.html", rol=rol, perms=PERMS,
                           current_perms=current_perms, active_page="configuracion")

@app.route("/configuracion/roles/<int:rid>/eliminar", methods=["POST"])
@login_required
def eliminar_rol(rid):
    if not has_perm("configuracion","gestionar"):
        flash("Sin permiso.", "danger"); return redirect(url_for("configuracion"))
    with get_db() as db:
        rol = db.execute("SELECT * FROM sys_roles WHERE id=?", (rid,)).fetchone()
        if not rol or rol["is_system"]:
            flash("No se puede eliminar un rol del sistema.", "danger")
            return redirect(url_for("configuracion"))
        in_use = db.execute("SELECT COUNT(*) FROM sys_users WHERE role_id=?", (rid,)).fetchone()[0]
        if in_use > 0:
            flash(f"No se puede eliminar: {in_use} usuario(s) tienen este rol asignado.", "danger")
            return redirect(url_for("configuracion"))
        db.execute("DELETE FROM sys_roles WHERE id=?", (rid,))
        log_action(db, None, "Eliminación rol", f"Rol '{rol['name']}' eliminado")
        db.commit()
    flash("Rol eliminado.", "success")
    return redirect(url_for("configuracion"))

@app.route("/api/me")
@login_required
def api_me():
    with get_db() as db:
        role = db.execute("SELECT name,permissions FROM sys_roles WHERE id=?", (current_user.role_id,)).fetchone()
    return jsonify({
        "username": current_user.username,
        "full_name": current_user.full_name,
        "role": role["name"] if role else "—",
        "is_superadmin": role["permissions"] == "*" if role else False,
    })


# ═══════════════════════════════════════════════════════════════════════════════
# RUTAS DE CONFIGURACIÓN API
# ═══════════════════════════════════════════════════════════════════════════════

@app.route("/plataformas/<name>/api", methods=["GET","POST"])
@login_required
def api_config(name):
    if name not in get_platforms():
        flash("Plataforma no encontrada.", "danger")
        return redirect(url_for("plataformas"))

    with get_db() as db:
        cfg = db.execute("SELECT * FROM api_configs WHERE platform=?", (name,)).fetchone()
        plat_cfg = db.execute("SELECT * FROM platforms_config WHERE name=?", (name,)).fetchone()
        logs = db.execute("""SELECT * FROM api_sync_log WHERE platform=?
                             ORDER BY id DESC LIMIT 20""", (name,)).fetchall()
        stats = {
            "total":   db.execute("SELECT COUNT(*) FROM platform_imports WHERE platform=?", (name,)).fetchone()[0],
            "matched": db.execute("SELECT COUNT(*) FROM platform_imports WHERE platform=? AND match_status='encontrado'", (name,)).fetchone()[0],
        }

    if request.method == "POST":
        form = request.form
        extra_params = {}
        query_keys = form.getlist("extra_key")
        query_vals = form.getlist("extra_val")
        if query_keys:
            extra_params["query"] = {k: v for k, v in zip(query_keys, query_vals) if k.strip()}

        # Field mapping
        fmap_keys = form.getlist("fmap_key")
        fmap_vals = form.getlist("fmap_val")
        field_map = {k.strip(): v.strip() for k, v in zip(fmap_keys, fmap_vals) if k.strip() and v.strip()}

        data = {
            "platform":          name,
            "api_type":          form.get("api_type","custom"),
            "base_url":          form.get("base_url","").strip(),
            "auth_type":         form.get("auth_type","bearer"),
            "token":             form.get("token","").strip(),
            "username":          form.get("api_username","").strip(),
            "password":          form.get("api_password","").strip(),
            "client_id":         form.get("client_id","").strip(),
            "client_secret":     form.get("client_secret","").strip(),
            "tenant_id":         form.get("tenant_id","").strip(),
            "extra_params":      json.dumps(extra_params),
            "field_map":         json.dumps(field_map),
            "offboard_endpoint": form.get("offboard_endpoint","").strip(),
            "offboard_method":   form.get("offboard_method","PATCH"),
            "offboard_payload":  form.get("offboard_payload","").strip(),
            "sync_enabled":      1 if form.get("sync_enabled") else 0,
            "sync_interval":     int(form.get("sync_interval",24) or 24),
        }
        with get_db() as db:
            if cfg:
                db.execute("""UPDATE api_configs SET
                    api_type=:api_type, base_url=:base_url, auth_type=:auth_type,
                    token=:token, username=:username, password=:password,
                    client_id=:client_id, client_secret=:client_secret, tenant_id=:tenant_id,
                    extra_params=:extra_params, field_map=:field_map,
                    offboard_endpoint=:offboard_endpoint, offboard_method=:offboard_method,
                    offboard_payload=:offboard_payload,
                    sync_enabled=:sync_enabled, sync_interval=:sync_interval,
                    updated_at=datetime('now','localtime')
                    WHERE platform=:platform""", data)
            else:
                db.execute("""INSERT INTO api_configs(
                    platform,api_type,base_url,auth_type,token,username,password,
                    client_id,client_secret,tenant_id,extra_params,field_map,
                    offboard_endpoint,offboard_method,offboard_payload,
                    sync_enabled,sync_interval)
                    VALUES(:platform,:api_type,:base_url,:auth_type,:token,:username,:password,
                    :client_id,:client_secret,:tenant_id,:extra_params,:field_map,
                    :offboard_endpoint,:offboard_method,:offboard_payload,
                    :sync_enabled,:sync_interval)""", data)
            log_action(db, None, f"Config API {name}", f"Configuración API actualizada ({data['api_type']})")
            db.commit()
        if data["sync_enabled"]:
            start_scheduler()
        flash(f"Configuración API de {name} guardada correctamente.", "success")
        return redirect(url_for("api_config", name=name))

    meta = get_platform_meta(name)
    return render_template("api_config.html", name=name, cfg=cfg, plat_cfg=plat_cfg,
                           logs=logs, stats=stats, meta=meta, active_page="plataformas")


@app.route("/plataformas/<name>/api/test", methods=["POST"])
@login_required
def api_test(name):
    """Prueba la conexión sin guardar."""
    with get_db() as db:
        cfg = db.execute("SELECT * FROM api_configs WHERE platform=?", (name,)).fetchone()
    if not cfg:
        return jsonify({"ok": False, "msg": "Guarda la configuración primero."})
    headers = build_auth_headers(cfg)
    resp = api_request(cfg["base_url"], headers=headers, timeout=10)
    if resp["ok"]:
        try:
            users = parse_users_from_response(resp["body"], cfg)
            return jsonify({"ok": True, "msg": f"Conexión exitosa. Se encontraron {len(users)} registros en la respuesta.", "count": len(users)})
        except:
            return jsonify({"ok": True, "msg": f"Conexión exitosa (HTTP {resp['status']}). Verifica el mapeo de campos.", "count": 0})
    return jsonify({"ok": False, "msg": f"Error HTTP {resp['status']}: {resp.get('error', resp['body'][:200])}"})


@app.route("/plataformas/<name>/api/sync", methods=["POST"])
@login_required
def api_sync_now(name):
    """Sincronización forzada desde la UI."""
    result = do_api_sync(name, trigger="forzado")
    if result["ok"]:
        flash(f"Sincronización completada: {result['msg']}", "success")
    else:
        flash(f"Error en sincronización: {result['msg']}", "danger")
    return redirect(url_for("api_config", name=name))


@app.route("/plataformas/<name>/api/offboard/<int:user_id>", methods=["POST"])
@login_required
def api_offboard_user(name, user_id):
    """Da de baja al usuario en la plataforma remota vía API."""
    with get_db() as db:
        # Obtener account_id del usuario en esta plataforma
        up = db.execute("""SELECT up.account_id, u.full_name, u.email
                           FROM user_platforms up JOIN users u ON up.user_id=u.id
                           WHERE up.user_id=? AND up.platform=?""", (user_id, name)).fetchone()
        if not up:
            flash("El usuario no tiene acceso activo en esta plataforma.", "danger")
            return redirect(url_for("ver_usuario", uid=user_id))

        # Ejecutar baja remota
        result = do_api_offboard(name, up["account_id"] or up["email"], up["full_name"])

        if result["ok"]:
            # Marcar como revocado localmente también
            db.execute("""UPDATE user_platforms SET enabled=0, revoked_at=datetime('now','localtime')
                          WHERE user_id=? AND platform=?""", (user_id, name))
            log_action(db, user_id, f"Baja remota en {name}",
                       f"Deshabilitado vía API. Respuesta: {result['msg']}")
            db.commit()
            flash(f"Usuario dado de baja en {name} correctamente. {result['msg']}", "success")
        else:
            flash(f"Error al dar de baja en {name}: {result['msg']}", "danger")

    return redirect(url_for("ver_usuario", uid=user_id))


@app.route("/api/sync-status")
@login_required
def api_sync_status():
    """JSON con estado de todas las APIs configuradas."""
    with get_db() as db:
        rows = db.execute("""SELECT a.platform, a.sync_enabled, a.sync_interval,
                                    a.last_sync, a.last_sync_status, a.last_sync_count,
                                    a.base_url
                             FROM api_configs a ORDER BY a.platform""").fetchall()
    return jsonify([dict(r) for r in rows])

# ═══════════════════════════════════════════════════════════════════════════════
# MIGRACIONES DE ESQUEMA
# Cada versión nueva puede traer cambios de base de datos. Se aplican UNA sola vez,
# en orden, dentro de una transacción y con respaldo automático previo.
# REGLA: nunca editar una migración ya publicada; solo agregar nuevas al final.
# ═══════════════════════════════════════════════════════════════════════════════

def add_column_if_missing(db, table, column, ddl):
    """Ayuda para migraciones: agrega una columna solo si todavía no existe."""
    cols = [r[1] for r in db.execute(f"PRAGMA table_info({table})").fetchall()]
    if column not in cols:
        db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")

def _m001_baseline(db):
    pass  # Esquema base de la versión 1.5.0

def _m002_asistente_ia(db):
    db.execute("""CREATE TABLE IF NOT EXISTS ai_proposals(
        id TEXT PRIMARY KEY, user_id INTEGER, action TEXT, params TEXT, before TEXT, summary TEXT,
        status TEXT DEFAULT 'pendiente', result TEXT,
        created_at TEXT DEFAULT (datetime('now','localtime')), applied_at TEXT)""")

MIGRATIONS = [
    (1, "Esquema base 1.5.0", _m001_baseline),
    (2, "Asistente IA: propuestas de cambio", _m002_asistente_ia),
    # (3, "Descripción del cambio", _m003_funcion),
]

def run_migrations():
    with get_db() as db:
        db.execute("""CREATE TABLE IF NOT EXISTS schema_version(
            version INTEGER PRIMARY KEY, description TEXT,
            applied_at TEXT DEFAULT (datetime('now','localtime')))""")
        db.execute("""CREATE TABLE IF NOT EXISTS update_history(
            id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, from_version TEXT, to_version TEXT,
            files_count INTEGER DEFAULT 0, backup_name TEXT, status TEXT DEFAULT 'ok',
            applied_by TEXT, notes TEXT,
            created_at TEXT DEFAULT (datetime('now','localtime')))""")
        db.commit()
        done = {r[0] for r in db.execute("SELECT version FROM schema_version").fetchall()}
    pending = sorted((m for m in MIGRATIONS if m[0] not in done), key=lambda m: m[0])
    if not pending:
        return []
    if done:  # la base ya tenía migraciones aplicadas = tiene datos reales → respaldo automático
        make_backup("pre-migracion", f"migraciones pendientes: {[m[0] for m in pending]}")
    applied = []
    for ver, desc, fn in pending:
        conn = get_db()
        try:
            conn.execute("BEGIN")
            fn(conn)
            conn.execute("INSERT INTO schema_version(version,description) VALUES(?,?)", (ver, desc))
            conn.commit()
            applied.append(ver)
        except Exception as e:
            conn.rollback()
            raise RuntimeError(f"Migración {ver} ({desc}) falló y fue revertida: {e}")
        finally:
            conn.close()
    return applied

# ═══════════════════════════════════════════════════════════════════════════════
# SEGURIDAD DE LAS RUTAS DE SERVICIO (permiso + CSRF)
# ═══════════════════════════════════════════════════════════════════════════════

def csrf_token():
    if "_csrf" not in session:
        session["_csrf"] = secrets.token_hex(16)
    return session["_csrf"]
app.jinja_env.globals["csrf_token"] = csrf_token

def check_csrf():
    tok = request.form.get("_csrf", "")
    if not tok or not secrets.compare_digest(tok, session.get("_csrf", "")):
        abort(400, "Token de seguridad inválido. Recarga la página e inténtalo de nuevo.")

def service_admin(f):
    @wraps(f)
    @login_required
    def wrapper(*a, **k):
        if not has_perm("configuracion", "servicio"):
            flash("No tienes permiso para administrar el servicio.", "danger")
            return redirect(url_for("dashboard"))
        return f(*a, **k)
    return wrapper

@app.context_processor
def inject_globals():
    can_ai = bool(current_user.is_authenticated and has_perm("configuracion", "asistente"))
    return {"APP_VERSION": APP_VERSION, "APP_CONFIG": CONFIG, "can_ai": can_ai}

@app.route("/health")
def health():
    return jsonify({"status": "ok", "version": APP_VERSION, "boot_id": RUNTIME["boot_id"]})

# ═══════════════════════════════════════════════════════════════════════════════
# RESPALDOS
# Un respaldo = ZIP con la base de datos (copia consistente) + el código vigente.
# ═══════════════════════════════════════════════════════════════════════════════

_CODE_EXT = {".py", ".html", ".css", ".js", ".txt", ".md", ".json",
             ".png", ".jpg", ".jpeg", ".ico", ".svg", ".woff", ".woff2", ".ttf"}
_SKIP_SUFFIX = (".pyc", ".db", ".db-wal", ".db-shm", ".migrado", ".bat", ".cmd", ".zip", ".us_new", ".tmp")

def human_size(n):
    n = float(n)
    for unit in ("B", "KB", "MB"):
        if n < 1024:
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} GB"

def port_free(host, port):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        if os.name != "nt":
            # Como hacen waitress/Flask: un puerto en TIME_WAIT (tras un reinicio) se puede reutilizar.
            # En Windows NO se activa: allí SO_REUSEADDR permitiría "pisar" un puerto realmente en uso.
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind((host, int(port)))
        return True
    except OSError:
        return False
    finally:
        s.close()

def iter_code_files():
    data_abs = os.path.abspath(DATA_DIR)
    for root, dirs, files in os.walk(BASE_DIR):
        dirs[:] = [d for d in dirs
                   if d not in ("data", "__pycache__", ".git") and not d.startswith("{")
                   and os.path.abspath(os.path.join(root, d)) != data_abs]
        for fn in files:
            if fn.endswith(_SKIP_SUFFIX):
                continue
            full = os.path.join(root, fn)
            yield full, os.path.relpath(full, BASE_DIR).replace("\\", "/")

def _backups_newest_first():
    zips = [f for f in os.listdir(BACKUP_DIR) if f.endswith(".zip")]
    return sorted(zips, key=lambda f: (os.path.getmtime(os.path.join(BACKUP_DIR, f)), f), reverse=True)

def prune_backups():
    zips = _backups_newest_first()
    keep = max(3, int(CONFIG.get("backup_retention", 10)))
    for old in zips[keep:]:
        try: os.remove(os.path.join(BACKUP_DIR, old))
        except OSError: pass

def make_backup(kind="manual", note=""):
    kind = re.sub(r"[^a-z\-]", "", kind.lower()) or "manual"
    base = f"{datetime.now().strftime('%Y%m%d_%H%M%S')}_{kind}_v{APP_VERSION}"
    name, i = base + ".zip", 2
    while os.path.exists(os.path.join(BACKUP_DIR, name)):      # dos respaldos en el mismo segundo no se pisan
        name, i = f"{base}-{i}.zip", i + 1
    path = os.path.join(BACKUP_DIR, name)
    fd, tmpdb = tempfile.mkstemp(suffix=".db"); os.close(fd)
    src_c, dst_c = sqlite3.connect(DB), sqlite3.connect(tmpdb)
    try:
        src_c.backup(dst_c)          # copia consistente aunque el servicio esté en uso
    finally:
        dst_c.close(); src_c.close()
    info = {"created": datetime.now().strftime("%Y-%m-%d %H:%M:%S"), "kind": kind,
            "version": APP_VERSION, "note": (note or "")[:120]}
    try:
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
            z.write(tmpdb, "db/usersync.db")
            safe_cfg = {k: v for k, v in CONFIG.items() if k not in ("secret_key", "ai_api_key")}
            z.writestr("config/config.json", json.dumps(safe_cfg, ensure_ascii=False, indent=2))
            for full, rel in iter_code_files():
                z.write(full, "code/" + rel)
            z.writestr("backup_info.json", json.dumps(info, ensure_ascii=False, indent=2))
    finally:
        try: os.remove(tmpdb)
        except OSError: pass
    prune_backups()
    return name

def list_backups():
    out = []
    for fn in _backups_newest_first():
        p = os.path.join(BACKUP_DIR, fn)
        info = {}
        try:
            with zipfile.ZipFile(p) as z:
                info = json.loads(z.read("backup_info.json"))
        except Exception:
            pass
        out.append({"name": fn, "size": human_size(os.path.getsize(p)),
                    "created": info.get("created") or datetime.fromtimestamp(os.path.getmtime(p)).strftime("%Y-%m-%d %H:%M:%S"),
                    "kind": info.get("kind", "?"), "version": info.get("version", "?"), "note": info.get("note", "")})
    return out

def backup_path(fname):
    if not re.fullmatch(r"[A-Za-z0-9_.\-]+\.zip", fname or ""):
        raise ValueError("Nombre de respaldo inválido.")
    p = os.path.join(BACKUP_DIR, fname)
    if not os.path.isfile(p):
        raise ValueError("El respaldo no existe.")
    return p

def _safe_rel(rel):
    parts = rel.replace("\\", "/").split("/")
    return bool(rel) and not rel.startswith("/") and ".." not in parts and ":" not in rel and parts[0] != "data"

def record_history(kind, from_v, to_v, files, backup, by, notes="", status="ok"):
    with get_db() as db:
        db.execute("""INSERT INTO update_history(kind,from_version,to_version,files_count,backup_name,status,applied_by,notes)
                      VALUES(?,?,?,?,?,?,?,?)""", (kind, from_v, to_v, files, backup, status, by, notes))
        db.commit()

def set_pending_restart(reason):
    with open(PENDING_FLAG, "w", encoding="utf-8") as f:
        json.dump({"since": datetime.now().strftime("%Y-%m-%d %H:%M:%S"), "reason": reason}, f)

def restore_backup(fname, what, by):
    """what: 'db' | 'code' | 'all'. Antes de restaurar se guarda un respaldo de seguridad del estado actual."""
    if what not in ("db", "code", "all"):
        raise ValueError("Opción de restauración inválida.")
    path = backup_path(fname)
    safety = make_backup("pre-restauracion", f"antes de restaurar {fname}")
    restored_code = 0
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        if what in ("db", "all"):
            if "db/usersync.db" not in names:
                raise ValueError("El respaldo no contiene base de datos.")
            fd, tmp = tempfile.mkstemp(suffix=".db"); os.close(fd)
            try:
                with open(tmp, "wb") as f:
                    f.write(z.read("db/usersync.db"))
                chk = sqlite3.connect(tmp)
                try:
                    ok = chk.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
                    has_users = chk.execute("SELECT 1 FROM sqlite_master WHERE name='users'").fetchone()
                finally:
                    chk.close()
                if not ok or not has_users:
                    raise ValueError("La base de datos del respaldo está dañada; no se restauró nada.")
                # El historial de versiones es información del servicio (no del negocio): se conserva al restaurar datos
                try:
                    with get_db() as db:
                        saved_hist = [dict(r) for r in db.execute("SELECT * FROM update_history").fetchall()]
                except sqlite3.Error:
                    saved_hist = []
                s_c, d_c = sqlite3.connect(tmp), sqlite3.connect(DB, timeout=30)
                try:
                    s_c.backup(d_c)
                finally:
                    d_c.close(); s_c.close()
                init_db()        # deja el esquema al día (tablas nuevas + migraciones) si el respaldo era de una versión anterior
                with get_db() as db:
                    db.execute("DELETE FROM update_history")
                    for h in saved_hist:
                        db.execute("""INSERT INTO update_history(id,kind,from_version,to_version,files_count,backup_name,status,applied_by,notes,created_at)
                                      VALUES(:id,:kind,:from_version,:to_version,:files_count,:backup_name,:status,:applied_by,:notes,:created_at)""", h)
                    db.commit()
            finally:
                try: os.remove(tmp)
                except OSError: pass
        if what in ("code", "all"):
            for n in names:
                if not n.startswith("code/") or n.endswith("/"):
                    continue
                rel = n[5:]
                if not _safe_rel(rel) or os.path.splitext(rel)[1].lower() not in _CODE_EXT:
                    continue
                dst = os.path.join(BASE_DIR, *rel.split("/"))
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                with open(dst + ".us_new", "wb") as f:
                    f.write(z.read(n))
                os.replace(dst + ".us_new", dst)
                restored_code += 1
    if restored_code:
        set_pending_restart(f"código restaurado desde {fname}")
    record_history("restauración", APP_VERSION, "", restored_code, safety, by, f"{what} desde {fname}")
    return {"safety": safety, "code_files": restored_code}

# ═══════════════════════════════════════════════════════════════════════════════
# ACTUALIZACIONES: validar paquete → autoprueba aislada → aplicar (con respaldo)
# ═══════════════════════════════════════════════════════════════════════════════

MAX_PACKAGE_MB = 50

def ver_tuple(v):
    return tuple(int(x) for x in re.findall(r"\d+", v or "0")) or (0,)

def _sha256_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()

def run_selftest_subprocess(code_dir):
    """Ejecuta la versión candidata en un proceso aparte, sobre una COPIA de la base de datos."""
    tmp_data = tempfile.mkdtemp(prefix="usersync_selftest_")
    try:
        s_c, d_c = sqlite3.connect(DB), sqlite3.connect(os.path.join(tmp_data, "usersync.db"))
        try:
            s_c.backup(d_c)
        finally:
            d_c.close(); s_c.close()
        env = dict(os.environ, USERSYNC_DATA=tmp_data, USERSYNC_SECRET="selftest", USERSYNC_SUPERVISED="0")
        proc = subprocess.run([sys.executable, os.path.join(code_dir, "app.py"), "--selftest"],
                              cwd=code_dir, env=env, capture_output=True, text=True, timeout=120)
        out = ((proc.stdout or "") + (proc.stderr or "")).strip()
        return proc.returncode == 0 and "SELFTEST_OK" in out, out[-3000:]
    except subprocess.TimeoutExpired:
        return False, "La autoprueba excedió el tiempo máximo (120 s)."
    finally:
        shutil.rmtree(tmp_data, ignore_errors=True)

def stage_update_package(file_storage, expected_sha=""):
    # limpiar preparaciones antiguas (> 24 h)
    for d in os.listdir(STAGING_DIR):
        p = os.path.join(STAGING_DIR, d)
        if os.path.isdir(p) and time.time() - os.path.getmtime(p) > 86400:
            shutil.rmtree(p, ignore_errors=True)

    data = file_storage.read()
    if len(data) > MAX_PACKAGE_MB * 1024 * 1024:
        raise ValueError(f"El paquete supera {MAX_PACKAGE_MB} MB.")
    sha = hashlib.sha256(data).hexdigest()
    expected_sha = (expected_sha or "").strip().lower()
    if expected_sha and expected_sha != sha:
        raise ValueError("El SHA-256 del archivo NO coincide con el indicado. El paquete pudo alterarse; no se usará.")

    stage_id = secrets.token_hex(8)
    sdir = os.path.join(STAGING_DIR, stage_id)
    pkg_dir, merged = os.path.join(sdir, "pkg"), os.path.join(sdir, "merged")
    os.makedirs(pkg_dir); os.makedirs(merged)
    zpath = os.path.join(sdir, "package.zip")
    with open(zpath, "wb") as f:
        f.write(data)

    files, skipped = [], []
    try:
        with zipfile.ZipFile(zpath) as z:
            infos = [i for i in z.infolist() if not i.is_dir()]
            names = [i.filename.replace("\\", "/") for i in infos]
            prefix = ""
            if "app.py" not in names:                      # permitir paquete dentro de una carpeta raíz
                tops = {n.split("/")[0] for n in names if "/" in n}
                if len(tops) == 1 and all(n.startswith(next(iter(tops)) + "/") for n in names):
                    prefix = next(iter(tops)) + "/"
            if sum(i.file_size for i in infos) > 150 * 1024 * 1024:
                raise ValueError("El contenido descomprimido es demasiado grande.")
            total = 0
            for info, n in zip(infos, names):
                rel = n[len(prefix):] if prefix and n.startswith(prefix) else n
                if not _safe_rel(rel):
                    if rel.split("/")[0] == "data":
                        skipped.append(rel + "  (carpeta de datos: protegida)"); continue
                    raise ValueError(f"Ruta no permitida dentro del paquete: {n}")
                parts = rel.split("/")
                low = rel.lower()
                if "__pycache__" in parts or low.endswith(_SKIP_SUFFIX):
                    skipped.append(rel + "  (tipo no actualizable)"); continue
                if os.path.splitext(rel)[1].lower() not in _CODE_EXT:
                    skipped.append(rel + "  (extensión no permitida)"); continue
                target = os.path.join(pkg_dir, *parts)
                os.makedirs(os.path.dirname(target), exist_ok=True)
                with z.open(info) as s_f, open(target, "wb") as d_f:
                    while True:
                        chunk = s_f.read(65536)
                        if not chunk: break
                        total += len(chunk)
                        if total > 150 * 1024 * 1024:
                            raise ValueError("El contenido descomprimido es demasiado grande.")
                        d_f.write(chunk)
                files.append(rel)
        if "app.py" not in files:
            raise ValueError("El paquete no contiene app.py en su raíz; no parece una versión de UserSync.")

        # Copia del código actual + capa del paquete = la versión candidata completa
        for full, rel in iter_code_files():
            dst = os.path.join(merged, *rel.split("/"))
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(full, dst)
        diff = []
        for rel in sorted(files):
            pkg_f = os.path.join(pkg_dir, *rel.split("/"))
            cur_f = os.path.join(BASE_DIR, *rel.split("/"))
            if not os.path.exists(cur_f): status = "nuevo"
            elif _sha256_file(pkg_f) == _sha256_file(cur_f): status = "igual"
            else: status = "modificado"
            diff.append({"path": rel, "status": status})
            dst = os.path.join(merged, *rel.split("/"))
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(pkg_f, dst)

        # 1) Sintaxis de todo el Python que trae el paquete
        syntax_errors = []
        for rel in files:
            if rel.endswith(".py"):
                p = os.path.join(pkg_dir, *rel.split("/"))
                try:
                    compile(open(p, encoding="utf-8").read(), rel, "exec")
                except SyntaxError as e:
                    syntax_errors.append(f"{rel}, línea {e.lineno}: {e.msg}")
                except UnicodeDecodeError:
                    syntax_errors.append(f"{rel}: no está codificado en UTF-8")

        new_version = "desconocida"
        m = re.search(r'^APP_VERSION\s*=\s*["\']([^"\']+)["\']',
                      open(os.path.join(merged, "app.py"), encoding="utf-8", errors="replace").read(), re.M)
        if m: new_version = m.group(1)
        notes = ""
        vj = os.path.join(pkg_dir, "version.json")
        if os.path.exists(vj):
            try: notes = str(json.load(open(vj, encoding="utf-8")).get("notes", ""))[:500]
            except Exception: pass

        warnings = []
        if new_version != "desconocida":
            if ver_tuple(new_version) == ver_tuple(APP_VERSION):
                warnings.append(f"El paquete tiene la misma versión que la instalada ({APP_VERSION}).")
            elif ver_tuple(new_version) < ver_tuple(APP_VERSION):
                warnings.append(f"El paquete es de una versión ANTERIOR ({new_version}) a la instalada ({APP_VERSION}).")
        if any(d["path"] == "requirements.txt" and d["status"] != "igual" for d in diff):
            warnings.append("Este paquete cambia las dependencias (requirements.txt). Si la autoprueba indica un módulo faltante, "
                            "ejecuta 'pip install -r requirements.txt' y vuelve a validar.")
        if not any(d["status"] != "igual" for d in diff):
            warnings.append("El paquete no cambia ningún archivo respecto a lo instalado.")

        # 2) Autoprueba aislada (solo si la sintaxis está bien)
        if syntax_errors:
            st_ok, st_out = False, "Errores de sintaxis:\n" + "\n".join(syntax_errors)
        else:
            st_ok, st_out = run_selftest_subprocess(merged)
        shutil.rmtree(merged, ignore_errors=True)

        report = {"stage_id": stage_id, "filename": getattr(file_storage, "filename", ""), "sha256": sha,
                  "size": human_size(len(data)), "current_version": APP_VERSION, "new_version": new_version,
                  "notes": notes, "files": diff, "skipped": skipped, "warnings": warnings,
                  "changed_count": sum(1 for d in diff if d["status"] != "igual"),
                  "selftest_ok": st_ok, "selftest_output": st_out,
                  "can_apply": bool(st_ok and any(d["status"] != "igual" for d in diff)),
                  "created": datetime.now().strftime("%Y-%m-%d %H:%M:%S")}
        with open(os.path.join(sdir, "report.json"), "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
        return report
    except Exception:
        shutil.rmtree(sdir, ignore_errors=True)
        raise

def load_stage_report(stage_id):
    if not re.fullmatch(r"[a-f0-9]{16}", stage_id or ""):
        return None
    p = os.path.join(STAGING_DIR, stage_id, "report.json")
    if not os.path.exists(p):
        return None
    with open(p, encoding="utf-8") as f:
        return json.load(f)

def apply_stage(stage_id, by):
    rep = load_stage_report(stage_id)
    if not rep:
        raise ValueError("La preparación de la actualización no existe o expiró. Vuelve a cargar el paquete.")
    if not rep["can_apply"]:
        raise ValueError("Este paquete no superó la validación y no puede aplicarse.")
    sdir = os.path.join(STAGING_DIR, stage_id)
    backup = make_backup("pre-actualizacion", f"antes de {rep['current_version']} → {rep['new_version']}")
    n = 0
    for f in rep["files"]:
        if f["status"] == "igual":
            continue
        src = os.path.join(sdir, "pkg", *f["path"].split("/"))
        dst = os.path.join(BASE_DIR, *f["path"].split("/"))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copyfile(src, dst + ".us_new")
        os.replace(dst + ".us_new", dst)
        n += 1
    set_pending_restart(f"actualización a {rep['new_version']}")
    record_history("actualización", rep["current_version"], rep["new_version"], n, backup, by, rep.get("notes", ""))
    shutil.rmtree(sdir, ignore_errors=True)
    return {"backup": backup, "files": n, "new_version": rep["new_version"]}

# ═══════════════════════════════════════════════════════════════════════════════
# REINICIO DEL SERVICIO
# ═══════════════════════════════════════════════════════════════════════════════

def restart_service():
    def _do():
        time.sleep(1.2)                                   # deja responder la página "Reiniciando…"
        if os.environ.get("USERSYNC_SUPERVISED") == "1":
            os._exit(3)                                   # INICIAR_USERSYNC.bat lo relanza al ver el código 3
        env = dict(os.environ, USERSYNC_RESTARTED="1")
        flags = getattr(subprocess, "CREATE_NEW_CONSOLE", 0) if os.name == "nt" else 0
        subprocess.Popen([sys.executable, os.path.join(BASE_DIR, "app.py")], env=env, cwd=BASE_DIR, creationflags=flags)
        os._exit(0)
    threading.Thread(target=_do, daemon=True).start()

# ═══════════════════════════════════════════════════════════════════════════════
# RUTAS: Configuración → Servicio y actualizaciones
# ═══════════════════════════════════════════════════════════════════════════════

@app.route("/configuracion/servicio")
@service_admin
def servicio():
    tab = request.args.get("tab", "parametros")
    staged = load_stage_report(request.args.get("stage", ""))
    with get_db() as db:
        history = db.execute("SELECT * FROM update_history ORDER BY id DESC LIMIT 20").fetchall()
        schema_v = db.execute("SELECT MAX(version) FROM schema_version").fetchone()[0]
    backups = list_backups()
    info = {"version": APP_VERSION, "schema": schema_v, "python": sys.version.split()[0],
            "os": f"{os.name} / {sys.platform}", "data_dir": DATA_DIR,
            "db_size": human_size(os.path.getsize(DB)) if os.path.exists(DB) else "—",
            "uptime": str(timedelta(seconds=int(time.time() - RUNTIME["started"]))),
            "supervised": os.environ.get("USERSYNC_SUPERVISED") == "1",
            "backups": len(backups)}
    safe_cfg = {k: v for k, v in CONFIG.items() if k not in ("secret_key", "ai_api_key")}
    return render_template("servicio.html", cfg=safe_cfg, runtime=RUNTIME, backups=backups,
                           ai_key_set=bool(_ai_key()),
                           ai_key_env=(not CONFIG.get("ai_api_key") and bool(os.environ.get("ANTHROPIC_API_KEY"))),
                           history=history, staged=staged, tab=tab, info=info,
                           pending=os.path.exists(PENDING_FLAG), active_page="configuracion")

SERVICE_PARAM_KEYS = ("org_name", "notify_email", "grace_days", "session_hours", "scheduler_check_minutes",
                      "backup_retention", "host", "port", "open_browser")

def validate_service_params(raw):
    """Valida un conjunto (parcial o completo) de parámetros del servicio.
    Devuelve (configuración_completa_resultante, errores). Es la ÚNICA validación: la usan la pantalla y el asistente IA."""
    errors = []
    def to_int(name, lo, hi, label):
        if name not in raw:
            return int(CONFIG[name])
        try:
            v = int(str(raw[name]).strip())
        except ValueError:
            errors.append(f"{label}: debe ser un número."); return None
        if not lo <= v <= hi:
            errors.append(f"{label}: debe estar entre {lo} y {hi}."); return None
        return v
    port      = to_int("port", 1, 65535, "Puerto")
    sess_h    = to_int("session_hours", 1, 168, "Duración de sesión (horas)")
    sched     = to_int("scheduler_check_minutes", 1, 60, "Revisión del programador (minutos)")
    retention = to_int("backup_retention", 3, 100, "Respaldos a conservar")
    grace     = to_int("grace_days", 0, 90, "Días de gracia")
    host      = raw.get("host", CONFIG["host"])
    if host not in ("127.0.0.1", "0.0.0.0"):
        errors.append("Interfaz de red no válida.")
    org   = str(raw.get("org_name", CONFIG["org_name"])).strip()[:80]
    email = str(raw.get("notify_email", CONFIG["notify_email"])).strip()[:120]
    if email and not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        errors.append("El email de notificación no es válido.")
    open_b = bool(raw["open_browser"]) if "open_browser" in raw else bool(CONFIG.get("open_browser", True))
    if (not errors and ("port" in raw or "host" in raw)
            and port != RUNTIME.get("port") and not port_free(host, port)):
        errors.append(f"El puerto {port} ya está en uso por otro programa. Elige otro.")
    clean = {"host": host, "port": port, "open_browser": open_b, "org_name": org, "notify_email": email,
             "grace_days": grace, "session_hours": sess_h, "scheduler_check_minutes": sched,
             "backup_retention": retention}
    return clean, errors

def apply_service_params(clean):
    """Guarda y activa los parámetros (ya validados). Devuelve True si hace falta reiniciar."""
    CONFIG.update(clean)
    save_config(CONFIG)
    app.config["PERMANENT_SESSION_LIFETIME"] = timedelta(hours=clean["session_hours"])    # efecto inmediato
    restart_needed = RUNTIME["port"] is not None and (clean["port"] != RUNTIME["port"] or clean["host"] != RUNTIME["host"])
    if restart_needed:
        set_pending_restart("cambio de puerto / interfaz de red")
    return restart_needed

@app.route("/configuracion/servicio/guardar", methods=["POST"])
@service_admin
def servicio_guardar():
    check_csrf()
    f = request.form
    raw = {k: f.get(k, "") for k in ("org_name", "notify_email", "grace_days", "session_hours",
                                      "scheduler_check_minutes", "backup_retention", "host", "port")}
    raw["open_browser"] = bool(f.get("open_browser"))
    clean, errors = validate_service_params(raw)
    if errors:
        for e in errors: flash(e, "danger")
        return redirect(url_for("servicio", tab="parametros"))
    restart_needed = apply_service_params(clean)
    with get_db() as db:
        log_action(db, None, "Configuración del servicio", f"Parámetros actualizados (host={clean['host']}, puerto={clean['port']})")
        db.commit()
    flash("Configuración guardada. " + ("El cambio de puerto/red se aplicará al reiniciar el servicio."
          if restart_needed else "Los cambios ya están activos."), "success")
    return redirect(url_for("servicio", tab="parametros"))

@app.route("/configuracion/servicio/reiniciar", methods=["POST"])
@service_admin
def servicio_reiniciar():
    check_csrf()
    with get_db() as db:
        log_action(db, None, "Reinicio del servicio", f"Solicitado por {current_user.username}")
        db.commit()
    target_port = int(CONFIG["port"])
    restart_service()
    return render_template("reiniciando.html", old_boot=RUNTIME["boot_id"], target_port=target_port,
                           same_port=(target_port == RUNTIME.get("port")))

@app.route("/configuracion/servicio/respaldo/crear", methods=["POST"])
@service_admin
def respaldo_crear():
    check_csrf()
    name = make_backup("manual", request.form.get("note", ""))
    with get_db() as db:
        log_action(db, None, "Respaldo manual", name); db.commit()
    flash(f"Respaldo creado: {name}", "success")
    return redirect(url_for("servicio", tab="respaldos"))

@app.route("/configuracion/servicio/respaldo/<fname>/descargar")
@service_admin
def respaldo_descargar(fname):
    try:
        p = backup_path(fname)
    except ValueError as e:
        flash(str(e), "danger"); return redirect(url_for("servicio", tab="respaldos"))
    return send_file(p, as_attachment=True, download_name=fname)

@app.route("/configuracion/servicio/respaldo/<fname>/restaurar", methods=["POST"])
@service_admin
def respaldo_restaurar(fname):
    check_csrf()
    what = request.form.get("what", "")
    try:
        res = restore_backup(fname, what, current_user.username)
    except (ValueError, zipfile.BadZipFile, sqlite3.Error) as e:
        flash(f"No se pudo restaurar: {e}", "danger")
        return redirect(url_for("servicio", tab="respaldos"))
    with get_db() as db:
        log_action(db, None, "Restauración", f"{what} desde {fname}"); db.commit()
    msg = f"Restauración completada ({'base de datos' if what=='db' else 'código' if what=='code' else 'base de datos y código'}). "
    msg += f"Se guardó un respaldo de seguridad del estado anterior: {res['safety']}."
    if res["code_files"]:
        msg += " Reinicia el servicio para activar el código restaurado."
    flash(msg, "success")
    return redirect(url_for("servicio", tab="respaldos"))

@app.route("/configuracion/servicio/respaldo/<fname>/eliminar", methods=["POST"])
@service_admin
def respaldo_eliminar(fname):
    check_csrf()
    try:
        os.remove(backup_path(fname))
        flash("Respaldo eliminado.", "success")
    except (ValueError, OSError) as e:
        flash(str(e), "danger")
    return redirect(url_for("servicio", tab="respaldos"))

@app.route("/configuracion/servicio/actualizar/validar", methods=["POST"])
@service_admin
def servicio_validar():
    check_csrf()
    fs = request.files.get("paquete")
    if not fs or not (fs.filename or "").lower().endswith(".zip"):
        flash("Selecciona un paquete de actualización (.zip).", "danger")
        return redirect(url_for("servicio", tab="actualizar"))
    try:
        rep = stage_update_package(fs, request.form.get("sha256", ""))
    except zipfile.BadZipFile:
        flash("El archivo no es un ZIP válido.", "danger")
        return redirect(url_for("servicio", tab="actualizar"))
    except ValueError as e:
        flash(str(e), "danger")
        return redirect(url_for("servicio", tab="actualizar"))
    return redirect(url_for("servicio", tab="actualizar", stage=rep["stage_id"]))

@app.route("/configuracion/servicio/actualizar/aplicar", methods=["POST"])
@service_admin
def servicio_aplicar():
    check_csrf()
    try:
        res = apply_stage(request.form.get("stage_id", ""), current_user.username)
    except ValueError as e:
        flash(str(e), "danger")
        return redirect(url_for("servicio", tab="actualizar"))
    with get_db() as db:
        log_action(db, None, "Actualización aplicada", f"{res['files']} archivo(s) → versión {res['new_version']} (respaldo: {res['backup']})")
        db.commit()
    flash(f"Actualización aplicada: {res['files']} archivo(s). Tus datos no se modificaron y quedó un respaldo previo ({res['backup']}). "
          f"Reinicia el servicio para activar la versión {res['new_version']}.", "success")
    return redirect(url_for("servicio", tab="actualizar"))

@app.route("/configuracion/servicio/actualizar/cancelar", methods=["POST"])
@service_admin
def servicio_cancelar():
    check_csrf()
    sid = request.form.get("stage_id", "")
    if re.fullmatch(r"[a-f0-9]{16}", sid):
        shutil.rmtree(os.path.join(STAGING_DIR, sid), ignore_errors=True)
    flash("Actualización cancelada. No se modificó nada.", "success")
    return redirect(url_for("servicio", tab="actualizar"))

# ═══════════════════════════════════════════════════════════════════════════════
# ASISTENTE IA
# Principios de seguridad:
#  1. La IA solo PROPONE. Cada cambio lo confirma una persona, uno por uno.
#  2. Solo existe una lista cerrada de acciones sobre PARÁMETROS (nada de código, URLs, credenciales ni datos de personas).
#  3. Cada propuesta se valida en el servidor con las mismas reglas que las pantallas y con los permisos del usuario.
#  4. Todo cambio queda en la auditoría y se puede deshacer.
#  5. Al proveedor solo se envían parámetros y conteos agregados: nunca usuarios, RUT, correos, claves ni tokens.
# ═══════════════════════════════════════════════════════════════════════════════

ANTHROPIC_URL = os.environ.get("USERSYNC_ANTHROPIC_URL", "https://api.anthropic.com/v1/messages")
AI_PROVIDERS = ("none", "anthropic", "ollama")
AI_MAX_MSG, AI_MAX_HISTORY, AI_PROPOSAL_TTL = 4000, 12, 3600

class AIError(Exception):
    pass

def _ai_key():
    return CONFIG.get("ai_api_key") or os.environ.get("ANTHROPIC_API_KEY", "")

def ai_is_configured():
    p = CONFIG.get("ai_provider", "none")
    return (p == "anthropic" and bool(_ai_key())) or p == "ollama"

def ai_effective_cfg(overrides=None):
    cfg = {"provider": CONFIG.get("ai_provider", "none"), "model": CONFIG.get("ai_model", ""),
           "key": _ai_key(), "ollama_url": CONFIG.get("ai_ollama_url", ""),
           "ollama_model": CONFIG.get("ai_ollama_model", "")}
    cfg.update({k: v for k, v in (overrides or {}).items() if v not in (None, "")})
    return cfg

def _http_json(url, headers=None, body=None, timeout=90):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method="POST" if body is not None else "GET")
    req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    ctx = ssl.create_default_context() if url.lower().startswith("https") else None
    host = urllib.parse.urlparse(url).netloc
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
            return json.loads(r.read().decode("utf-8", "replace") or "{}")
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            j = json.loads(e.read().decode("utf-8", "replace"))
            detail = (j.get("error") or {}).get("message") if isinstance(j.get("error"), dict) else str(j.get("error", ""))
        except Exception:
            pass
        detail = (detail or "")[:200]
        if e.code in (401, 403):
            raise AIError("El proveedor rechazó las credenciales (HTTP %d). Revisa la API key en Configuración → Servicio → Asistente IA." % e.code)
        if e.code == 404:
            raise AIError("No se encontró el modelo o la ruta en %s (HTTP 404). %s" % (host, detail))
        if e.code == 429:
            raise AIError("Se alcanzó el límite de uso del proveedor (HTTP 429). Espera un momento y reintenta.")
        raise AIError("El proveedor respondió con error HTTP %d. %s" % (e.code, detail))
    except urllib.error.URLError as e:
        raise AIError("No se pudo conectar con %s: %s" % (host, getattr(e, "reason", e)))
    except (TimeoutError, socket.timeout):
        raise AIError("El proveedor tardó demasiado en responder (más de %d s)." % timeout)
    except ValueError:
        raise AIError("La respuesta del proveedor no tiene el formato esperado.")

def llm_chat(system, messages, max_tokens=1500, timeout=90, cfg=None):
    cfg = cfg or ai_effective_cfg()
    p = cfg["provider"]
    if p == "anthropic":
        if not cfg["key"]:
            raise AIError("Falta la API key de Anthropic.")
        resp = _http_json(ANTHROPIC_URL, {"x-api-key": cfg["key"], "anthropic-version": "2023-06-01"},
                          {"model": cfg["model"], "max_tokens": max_tokens, "system": system, "messages": messages}, timeout)
        return "".join(b.get("text", "") for b in resp.get("content", []) if b.get("type") == "text")
    if p == "ollama":
        base = (cfg["ollama_url"] or "").rstrip("/")
        resp = _http_json(base + "/api/chat", {},
                          {"model": cfg["ollama_model"], "stream": False, "format": "json",
                           "messages": [{"role": "system", "content": system}] + messages,
                           "options": {"temperature": 0.2}}, timeout)
        return (resp.get("message") or {}).get("content", "")
    raise AIError("El asistente IA está desactivado. Actívalo en Configuración → Servicio → Asistente IA.")

# ── Contexto que se envía al modelo: solo parámetros y agregados ─────────────

def ai_build_context():
    with get_db() as db:
        plats = []
        for c in db.execute("SELECT * FROM platforms_config ORDER BY name").fetchall():
            meta, extra = get_platform_meta(c["name"]), {}
            try: extra = json.loads(c["api_url"] or "{}")
            except Exception: pass
            api = db.execute("""SELECT api_type,auth_type,sync_enabled,sync_interval,last_sync,last_sync_status,field_map
                                FROM api_configs WHERE platform=?""", (c["name"],)).fetchone()
            tot = db.execute("SELECT COUNT(*) FROM platform_imports WHERE platform=?", (c["name"],)).fetchone()[0]
            mat = db.execute("SELECT COUNT(*) FROM platform_imports WHERE platform=? AND match_status='encontrado'", (c["name"],)).fetchone()[0]
            api_info = None
            if api:
                try: fm = json.loads(api["field_map"] or "{}")
                except Exception: fm = {}
                api_info = {"tipo": api["api_type"], "autenticacion": api["auth_type"],
                            "sync_automatica": bool(api["sync_enabled"]), "intervalo_horas": api["sync_interval"],
                            "ultima_sync": api["last_sync"], "estado_ultima_sync": api["last_sync_status"], "mapeo_campos": fm}
            plats.append({"nombre": c["name"], "tipo": c["type"], "estado": c["status"],
                          "abreviatura": meta["abbr"], "color": meta["color"],
                          "es_predeterminada": c["name"] in PLATFORMS_DEFAULT,
                          "columnas_plantilla": extra.get("col_map", ""), "api": api_info,
                          "cruce": {"registros": tot, "cruzados": mat, "sin_cruce": tot - mat}})
        roles = []
        for r in db.execute("SELECT * FROM sys_roles ORDER BY id").fetchall():
            try: perms = "*" if r["permissions"] == "*" else json.loads(r["permissions"] or "{}")
            except Exception: perms = {}
            roles.append({"nombre": r["name"], "descripcion": r["description"] or "",
                          "es_del_sistema": bool(r["is_system"]), "permisos": perms})
    return {"servicio": {k: CONFIG.get(k) for k in SERVICE_PARAM_KEYS}, "plataformas": plats, "roles": roles}

_AI_SYSTEM = """Eres el asistente de configuración de UserSync (v__VERSION__), una aplicación local de gestión de identidades.
Ayudas al administrador a revisar y modificar PARÁMETROS de esta instalación. Respondes siempre en español, breve y claro.

REGLAS
1. Tú NO aplicas cambios: propones y el administrador los confirma uno a uno. Propón solo lo que el usuario pidió.
2. Usa únicamente los nombres de plataformas y roles que aparecen en el ESTADO ACTUAL. No inventes valores.
3. Si falta información o la petición es ambigua, pregunta y no propongas nada.
4. NO puedes: modificar código, URLs de API, credenciales, tokens o contraseñas; ver o modificar usuarios/empleados; eliminar plataformas o roles; reiniciar el servicio. Si te lo piden, explica en qué pantalla se hace o que requiere una actualización de código.
5. Nunca pidas ni repitas contraseñas, tokens o claves.
6. Advierte los riesgos relevantes (abrir el servicio a toda la red, dar permisos de servicio o gestión a un rol).
7. Las preguntas sobre el estado actual respóndelas con los datos de ESTADO ACTUAL, sin proponer cambios.

FORMATO: responde con UN SOLO objeto JSON y nada más:
{"message": "texto para el usuario", "proposals": [ {"action": "...", "params": {...}, "reason": "por qué"} ]}
"proposals" puede ir vacío. Máximo 6 propuestas.

ACCIONES DISPONIBLES
- set_service_params: params = subconjunto de {org_name (texto, máx 80), notify_email, grace_days (0-90), session_hours (1-168), scheduler_check_minutes (1-60), backup_retention (3-100), open_browser (true/false), host ("127.0.0.1" o "0.0.0.0"), port (1-65535)}. host y port requieren reiniciar el servicio.
- set_api_sync: params = {platform, sync_enabled (true/false), sync_interval (horas, 1-720)}. La plataforma debe tener API configurada.
- set_api_field_map: params = {platform, field_map: {campo: "ruta.del.campo.en.el.JSON"}}. Campos habituales: email, name, id, status. Un valor vacío quita el mapeo personalizado de ese campo.
- set_platform_meta: params = {platform, type, status ("Operativo"|"Mantenimiento"|"Deshabilitado"), abbr (máx 5 letras/números), color ("#RRGGBB"), notes, col_map ("col1,col2,...")}; incluye solo lo que cambia. En plataformas predeterminadas no se pueden cambiar abbr ni color.
- set_role_permissions: params = {role, permissions: {modulo: {accion: true/false}}}. Solo roles que no sean del sistema.
- create_role: params = {name, description, permissions: {modulo: {accion: true}}}
- create_backup: params = {note}

Tipos de plataforma válidos: __TYPES__
Catálogo de permisos (módulo: acciones): __PERMS__

ESTADO ACTUAL (JSON):
__CTX__
"""

def ai_system_prompt(ctx):
    return (_AI_SYSTEM.replace("__VERSION__", APP_VERSION)
            .replace("__TYPES__", ", ".join(PLATFORM_TYPES))
            .replace("__PERMS__", json.dumps({m: list(a.keys()) for m, a in PERMS.items()}, ensure_ascii=False))
            .replace("__CTX__", json.dumps(ctx, ensure_ascii=False, indent=1)))

def ai_clean_history(msgs):
    out = []
    for m in (msgs or [])[-AI_MAX_HISTORY:]:
        if not isinstance(m, dict):
            continue
        role, text = m.get("role"), str(m.get("content", ""))[:AI_MAX_MSG].strip()
        if role not in ("user", "assistant") or not text:
            continue
        if out and out[-1]["role"] == role:
            out[-1]["content"] += "\n" + text
        else:
            out.append({"role": role, "content": text})
    while out and out[0]["role"] != "user":
        out.pop(0)
    return out if out and out[-1]["role"] == "user" else None

def ai_parse_reply(text):
    t = (text or "").strip()
    t = re.sub(r"^```(?:json)?\s*|\s*```$", "", t).strip()
    obj = None
    try:
        obj = json.loads(t)
    except Exception:
        m = re.search(r"\{.*\}", t, re.S)
        if m:
            try: obj = json.loads(m.group(0))
            except Exception: obj = None
    if not isinstance(obj, dict):
        return (text or "").strip()[:AI_MAX_MSG], [], False
    props = obj.get("proposals") or []
    return str(obj.get("message", ""))[:AI_MAX_MSG], (props[:6] if isinstance(props, list) else []), True

# ── Acciones permitidas: preparar (validar + previsualizar) y aplicar ────────

def _to_bool(v):
    if isinstance(v, bool): return v
    return str(v).strip().lower() in ("1", "true", "si", "sí", "yes", "y", "on", "activar", "activada", "activo", "enabled")

def _fmt(v):
    if isinstance(v, bool): return "Sí" if v else "No"
    return "—" if v is None or v == "" else str(v)

def _new_prep():
    return {"errors": [], "warnings": [], "params": {}, "before": {}, "changes": [], "sensitive": False, "restart": False}

_SERVICE_LABELS = {"org_name": "Nombre de la organización", "notify_email": "Email de notificación",
                   "grace_days": "Días de gracia", "session_hours": "Duración de la sesión (h)",
                   "scheduler_check_minutes": "Revisión de sincronizaciones (min)",
                   "backup_retention": "Respaldos a conservar", "open_browser": "Abrir navegador al iniciar",
                   "host": "Acceso al servicio", "port": "Puerto"}

def ai_prep_service(p):
    r = _new_prep()
    unknown = sorted(str(k) for k in p if k not in SERVICE_PARAM_KEYS)
    if unknown:
        r["errors"].append("Parámetros no permitidos: " + ", ".join(unknown))
    raw = {k: p[k] for k in SERVICE_PARAM_KEYS if k in p}
    if not raw:
        r["errors"].append("La propuesta no indica ningún parámetro."); return r
    if "open_browser" in raw: raw["open_browser"] = _to_bool(raw["open_browser"])
    clean, errs = validate_service_params(raw)
    r["errors"] += errs
    if r["errors"]: return r
    for k in raw:
        if CONFIG.get(k) != clean[k]:
            r["changes"].append({"label": _SERVICE_LABELS[k], "current": _fmt(CONFIG.get(k)), "new": _fmt(clean[k])})
    r["params"] = {k: clean[k] for k in raw}
    r["before"] = {k: CONFIG.get(k) for k in raw}
    if any(CONFIG.get(k) != clean[k] for k in ("host", "port") if k in raw):
        r["restart"] = True
        r["warnings"].append("Este cambio requiere reiniciar el servicio para activarse.")
    if "host" in raw and clean["host"] == "0.0.0.0" and CONFIG.get("host") != "0.0.0.0":
        r["sensitive"] = True
        r["warnings"].append("Abre UserSync a toda la red por HTTP sin cifrar. Hazlo solo en una red interna de confianza.")
    return r

def _api_row(platform):
    with get_db() as db:
        return db.execute("SELECT * FROM api_configs WHERE platform=?", (platform,)).fetchone()

def ai_prep_api_sync(p):
    r = _new_prep()
    unknown = sorted(str(k) for k in p if k not in ("platform", "sync_enabled", "sync_interval"))
    if unknown: r["errors"].append("Parámetros no permitidos: " + ", ".join(unknown))
    platform = str(p.get("platform", "")).strip()
    row = _api_row(platform)
    if not row:
        r["errors"].append(f"La plataforma «{platform}» no existe o no tiene API configurada (Plataformas → Config. API).")
        return r
    new = {}
    if "sync_enabled" in p: new["sync_enabled"] = 1 if _to_bool(p["sync_enabled"]) else 0
    if "sync_interval" in p:
        try: iv = int(str(p["sync_interval"]).strip())
        except ValueError: iv = 0
        if not 1 <= iv <= 720: r["errors"].append("El intervalo debe estar entre 1 y 720 horas.")
        else: new["sync_interval"] = iv
    if not new and not r["errors"]: r["errors"].append("La propuesta no indica ningún cambio.")
    if r["errors"]: return r
    labels = {"sync_enabled": f"{platform}: sincronización automática", "sync_interval": f"{platform}: intervalo (horas)"}
    for k, v in new.items():
        cur = row[k]
        if k == "sync_enabled": cur, vv = bool(cur), bool(v)
        else: vv = v
        if cur != vv: r["changes"].append({"label": labels[k], "current": _fmt(cur), "new": _fmt(vv)})
    r["params"] = {"platform": platform, **new}
    r["before"] = {"platform": platform, **{k: row[k] for k in new}}
    return r

_FM_KEY = re.compile(r"[A-Za-z][A-Za-z0-9_]{0,30}")
_FM_VAL = re.compile(r"[A-Za-z0-9_.\-\[\]@$ ]{1,80}")

def ai_prep_field_map(p):
    r = _new_prep()
    unknown = sorted(str(k) for k in p if k not in ("platform", "field_map"))
    if unknown: r["errors"].append("Parámetros no permitidos: " + ", ".join(unknown))
    platform = str(p.get("platform", "")).strip()
    row = _api_row(platform)
    if not row:
        r["errors"].append(f"La plataforma «{platform}» no existe o no tiene API configurada."); return r
    fm = p.get("field_map")
    if not isinstance(fm, dict) or not fm:
        r["errors"].append("field_map debe indicar al menos un campo."); return r
    try: old = json.loads(row["field_map"] or "{}")
    except Exception: old = {}
    new = dict(old)
    for k, v in fm.items():
        k, v = str(k).strip(), ("" if v is None else str(v).strip())
        if not _FM_KEY.fullmatch(k): r["errors"].append(f"Nombre de campo no válido: «{k}»."); continue
        if v == "": new.pop(k, None)
        elif not _FM_VAL.fullmatch(v): r["errors"].append(f"Ruta de campo no válida para «{k}»: «{v}».")
        else: new[k] = v
    if r["errors"]: return r
    for k in sorted(set(old) | set(new)):
        if old.get(k) != new.get(k):
            r["changes"].append({"label": f"{platform}: campo «{k}»", "current": old.get(k) or "(valor por defecto)",
                                 "new": new.get(k) or "(valor por defecto)"})
    r["params"] = {"platform": platform, "field_map": new, "replace": True}
    r["before"] = {"platform": platform, "field_map": old, "replace": True}
    return r

_PLATFORM_STATUS = ("Operativo", "Mantenimiento", "Deshabilitado")

def ai_prep_platform_meta(p):
    r = _new_prep()
    allowed = ("platform", "type", "status", "abbr", "color", "notes", "col_map")
    unknown = sorted(str(k) for k in p if k not in allowed)
    if unknown: r["errors"].append("Parámetros no permitidos: " + ", ".join(unknown))
    platform = str(p.get("platform", "")).strip()
    with get_db() as db:
        row = db.execute("SELECT * FROM platforms_config WHERE name=?", (platform,)).fetchone()
    if not row:
        r["errors"].append(f"La plataforma «{platform}» no existe."); return r
    try: extra = json.loads(row["api_url"] or "{}")
    except Exception: extra = {}
    is_def, meta = platform in PLATFORMS_DEFAULT, get_platform_meta(platform)
    cur = {"type": row["type"], "status": row["status"], "notes": row["notes"] or "",
           "abbr": meta["abbr"], "color": meta["color"], "col_map": extra.get("col_map", "")}
    new = {}
    if "type" in p:
        m = [t for t in PLATFORM_TYPES if t.lower() == str(p["type"]).strip().lower()]
        if m: new["type"] = m[0]
        else: r["errors"].append("Tipo no válido. Opciones: " + ", ".join(PLATFORM_TYPES))
    if "status" in p:
        m = [t for t in _PLATFORM_STATUS if t.lower() == str(p["status"]).strip().lower()]
        if m: new["status"] = m[0]
        else: r["errors"].append("Estado no válido. Opciones: " + ", ".join(_PLATFORM_STATUS))
    if "abbr" in p:
        v = str(p["abbr"]).strip().upper()
        if is_def: r["errors"].append("Las plataformas predeterminadas tienen abreviatura fija.")
        elif not re.fullmatch(r"[A-Z0-9]{1,5}", v): r["errors"].append("La abreviatura debe tener 1 a 5 letras o números.")
        else: new["abbr"] = v
    if "color" in p:
        v = str(p["color"]).strip()
        if is_def: r["errors"].append("Las plataformas predeterminadas tienen color fijo.")
        elif not re.fullmatch(r"#[0-9A-Fa-f]{6}", v): r["errors"].append("El color debe tener formato #RRGGBB.")
        else: new["color"] = v.upper()
    if "notes" in p:
        v = str(p["notes"]).strip()
        if len(v) > 500: r["errors"].append("Las notas no pueden superar 500 caracteres.")
        else: new["notes"] = v
    if "col_map" in p:
        cols = [c.strip() for c in str(p["col_map"]).split(",") if c.strip()]
        if len(cols) > 40 or any(not re.fullmatch(r"[A-Za-z0-9_ .\-]{1,40}", c) for c in cols):
            r["errors"].append("col_map debe ser una lista de nombres de columna separados por coma.")
        else: new["col_map"] = ",".join(cols)
    if not new and not r["errors"]: r["errors"].append("La propuesta no indica ningún cambio.")
    if r["errors"]: return r
    labels = {"type": "Tipo", "status": "Estado", "abbr": "Abreviatura", "color": "Color", "notes": "Notas", "col_map": "Columnas de la plantilla"}
    for k, v in new.items():
        if cur[k] != v: r["changes"].append({"label": f"{platform}: {labels[k]}", "current": _fmt(cur[k]), "new": _fmt(v)})
    r["params"] = {"platform": platform, **new}
    r["before"] = {"platform": platform, **{k: cur[k] for k in new}}
    return r

def _validate_perm_map(perm_in, errors):
    out = {}
    if not isinstance(perm_in, dict) or not perm_in:
        errors.append("permissions debe indicar al menos un permiso."); return out
    for mod, acts in perm_in.items():
        if mod not in PERMS or not isinstance(acts, dict):
            errors.append(f"Módulo de permisos no válido: «{mod}»."); continue
        for act, val in acts.items():
            if act not in PERMS[mod]: errors.append(f"Acción no válida «{act}» en «{mod}».")
            else: out.setdefault(mod, {})[act] = _to_bool(val)
    return out

_SENSITIVE_PERMS = {("configuracion", "servicio"): "Permite instalar código y administrar el servicio.",
                    ("configuracion", "gestionar"): "Permite gestionar usuarios del sistema y roles.",
                    ("configuracion", "asistente"): "Permite usar el asistente IA."}

def ai_prep_role_permissions(p):
    r = _new_prep(); r["sensitive"] = True
    unknown = sorted(str(k) for k in p if k not in ("role", "permissions"))
    if unknown: r["errors"].append("Parámetros no permitidos: " + ", ".join(unknown))
    name = str(p.get("role", "")).strip()
    with get_db() as db:
        row = db.execute("SELECT * FROM sys_roles WHERE name=?", (name,)).fetchone()
        n_users = db.execute("SELECT COUNT(*) FROM sys_users WHERE role_id=?", (row["id"],)).fetchone()[0] if row else 0
    if not row:
        r["errors"].append(f"El rol «{name}» no existe."); return r
    if row["is_system"] or row["permissions"] == "*":
        r["errors"].append("Los roles del sistema no se pueden modificar desde el asistente."); return r
    change = _validate_perm_map(p.get("permissions"), r["errors"])
    if r["errors"]: return r
    try: old = json.loads(row["permissions"] or "{}")
    except Exception: old = {}
    new = {m: dict(a) for m, a in old.items()}
    for mod, acts in change.items():
        for act, val in acts.items():
            before_v = bool(old.get(mod, {}).get(act))
            if val: new.setdefault(mod, {})[act] = True
            else: new.get(mod, {}).pop(act, None)
            if before_v != val:
                r["changes"].append({"label": f"{name}: {PERMS[mod][act]}", "current": _fmt(before_v), "new": _fmt(val)})
                if val and (mod, act) in _SENSITIVE_PERMS:
                    r["warnings"].append(f"Permiso sensible «{PERMS[mod][act]}»: {_SENSITIVE_PERMS[(mod, act)]}")
    new = {m: a for m, a in new.items() if a}
    if n_users: r["warnings"].append(f"{n_users} usuario(s) del sistema tienen este rol y verán el cambio de inmediato.")
    r["params"] = {"role": name, "permissions": new, "replace": True}
    r["before"] = {"role": name, "permissions": old, "replace": True}
    return r

def ai_prep_create_role(p):
    r = _new_prep(); r["sensitive"] = True
    unknown = sorted(str(k) for k in p if k not in ("name", "description", "permissions"))
    if unknown: r["errors"].append("Parámetros no permitidos: " + ", ".join(unknown))
    name, desc = str(p.get("name", "")).strip(), str(p.get("description", "")).strip()[:120]
    if not re.fullmatch(r"[A-Za-z0-9 _.\-áéíóúÁÉÍÓÚñÑ]{2,40}", name):
        r["errors"].append("El nombre del rol debe tener entre 2 y 40 caracteres (letras, números, espacios).")
    with get_db() as db:
        if name and db.execute("SELECT 1 FROM sys_roles WHERE name=?", (name,)).fetchone():
            r["errors"].append(f"Ya existe un rol llamado «{name}».")
    perms = _validate_perm_map(p.get("permissions"), r["errors"])
    if r["errors"]: return r
    perms = {m: {a: True for a, v in acts.items() if v} for m, acts in perms.items()}
    perms = {m: a for m, a in perms.items() if a}
    labels = [PERMS[m][a] for m, acts in perms.items() for a in acts]
    r["changes"] = [{"label": "Nuevo rol", "current": "—", "new": name},
                    {"label": "Permisos", "current": "—", "new": ", ".join(labels) or "(ninguno)"}]
    for m, acts in perms.items():
        for a in acts:
            if (m, a) in _SENSITIVE_PERMS:
                r["warnings"].append(f"Permiso sensible «{PERMS[m][a]}»: {_SENSITIVE_PERMS[(m, a)]}")
    r["params"] = {"name": name, "description": desc, "permissions": perms}
    return r

def ai_prep_backup(p):
    r = _new_prep()
    note = str(p.get("note", "")).strip()[:120]
    r["changes"] = [{"label": "Respaldo", "current": "—", "new": "Se creará un respaldo (datos + código)" + (f": {note}" if note else "")}]
    r["params"] = {"note": note}
    return r

def ai_apply(action, p):
    """Aplica parámetros YA normalizados y validados. Devuelve {'message', 'restart'}."""
    if action == "set_service_params":
        clean, errs = validate_service_params(p)
        if errs: raise ValueError("; ".join(errs))
        return {"message": "Parámetros del servicio actualizados.", "restart": apply_service_params(clean)}
    if action == "set_api_sync":
        sets = {k: p[k] for k in ("sync_enabled", "sync_interval") if k in p}
        with get_db() as db:
            for k, v in sets.items():
                db.execute(f"UPDATE api_configs SET {k}=?, updated_at=datetime('now','localtime') WHERE platform=?", (v, p["platform"]))
            db.commit()
        if sets.get("sync_enabled"): start_scheduler()
        return {"message": f"Sincronización de {p['platform']} actualizada.", "restart": False}
    if action == "set_api_field_map":
        with get_db() as db:
            db.execute("UPDATE api_configs SET field_map=?, updated_at=datetime('now','localtime') WHERE platform=?",
                       (json.dumps(p["field_map"], ensure_ascii=False), p["platform"]))
            db.commit()
        return {"message": f"Mapeo de campos de {p['platform']} actualizado.", "restart": False}
    if action == "set_platform_meta":
        with get_db() as db:
            for k in ("type", "status", "notes"):
                if k in p: db.execute(f"UPDATE platforms_config SET {k}=? WHERE name=?", (p[k], p["platform"]))
            if any(k in p for k in ("abbr", "color", "col_map")):
                row = db.execute("SELECT api_url FROM platforms_config WHERE name=?", (p["platform"],)).fetchone()
                try: extra = json.loads(row["api_url"] or "{}")
                except Exception: extra = {}
                for k in ("abbr", "color", "col_map"):
                    if k in p: extra[k] = p[k]
                db.execute("UPDATE platforms_config SET api_url=? WHERE name=?", (json.dumps(extra), p["platform"]))
            db.commit()
        return {"message": f"Plataforma {p['platform']} actualizada.", "restart": False}
    if action == "set_role_permissions":
        with get_db() as db:
            db.execute("UPDATE sys_roles SET permissions=? WHERE name=? AND is_system=0", (json.dumps(p["permissions"]), p["role"]))
            db.commit()
        return {"message": f"Permisos del rol {p['role']} actualizados.", "restart": False}
    if action == "create_role":
        with get_db() as db:
            db.execute("INSERT INTO sys_roles(name,description,permissions) VALUES(?,?,?)",
                       (p["name"], p["description"], json.dumps(p["permissions"])))
            db.commit()
        return {"message": f"Rol {p['name']} creado.", "restart": False}
    if action == "create_backup":
        return {"message": "Respaldo creado: " + make_backup("manual", "Asistente IA: " + (p.get("note") or "respaldo solicitado")), "restart": False}
    raise ValueError("Acción no reconocida.")

AI_ACTIONS = {
    "set_service_params":   {"title": "Cambiar parámetros del servicio",  "prep": ai_prep_service,          "perm": ("configuracion", "servicio"),  "undo": True},
    "set_api_sync":         {"title": "Ajustar sincronización de API",    "prep": ai_prep_api_sync,         "perm": ("plataformas", "editar"),       "undo": True},
    "set_api_field_map":    {"title": "Ajustar mapeo de campos de API",   "prep": ai_prep_field_map,        "perm": ("plataformas", "editar"),       "undo": True},
    "set_platform_meta":    {"title": "Modificar datos de una plataforma","prep": ai_prep_platform_meta,    "perm": ("plataformas", "editar"),       "undo": True},
    "set_role_permissions": {"title": "Modificar permisos de un rol",     "prep": ai_prep_role_permissions, "perm": ("configuracion", "gestionar"), "undo": True},
    "create_role":          {"title": "Crear un rol",                     "prep": ai_prep_create_role,      "perm": ("configuracion", "gestionar"), "undo": True},
    "create_backup":        {"title": "Crear un respaldo",                "prep": ai_prep_backup,           "perm": ("configuracion", "servicio"),  "undo": False},
}

def ai_card_from_prep(spec_title, prep, reason, pid=None, action=None):
    return {"id": pid, "action": action, "title": spec_title, "reason": reason,
            "changes": prep["changes"], "warnings": prep["warnings"], "errors": prep["errors"],
            "sensitive": prep["sensitive"], "restart": prep["restart"],
            "can_apply": bool(pid) and not prep["errors"] and bool(prep["changes"])}

def ai_register_proposal(pr):
    """Valida una propuesta del modelo y, si es aplicable, la guarda en el servidor. El navegador solo recibe su id."""
    if not isinstance(pr, dict):
        return {"id": None, "title": "Propuesta no válida", "reason": "", "changes": [], "warnings": [],
                "errors": ["El asistente devolvió una propuesta con formato incorrecto."], "can_apply": False}
    action, params, reason = str(pr.get("action", "")), pr.get("params"), str(pr.get("reason", ""))[:300]
    spec = AI_ACTIONS.get(action)
    if not spec or not isinstance(params, dict):
        return {"id": None, "title": "Propuesta no permitida", "reason": reason, "changes": [], "warnings": [],
                "errors": [f"La acción «{action[:40]}» no está entre las permitidas para el asistente."], "can_apply": False}
    prep = spec["prep"](params)
    if not has_perm(*spec["perm"]):
        prep["errors"].append("Tu rol no tiene permiso para aplicar este tipo de cambio.")
    if prep["errors"] or not prep["changes"]:
        if not prep["errors"]:
            prep["warnings"].append("No hay nada que cambiar: ya tiene el valor indicado.")
        return ai_card_from_prep(spec["title"], prep, reason, None, action)
    pid = secrets.token_hex(8)
    summary = {"title": spec["title"], "reason": reason, "changes": prep["changes"], "warnings": prep["warnings"],
               "sensitive": prep["sensitive"], "restart": prep["restart"]}
    with get_db() as db:
        db.execute("INSERT INTO ai_proposals(id,user_id,action,params,before,summary) VALUES(?,?,?,?,?,?)",
                   (pid, current_user.id, action, json.dumps(params, ensure_ascii=False),
                    json.dumps(prep["before"], ensure_ascii=False), json.dumps(summary, ensure_ascii=False)))
        db.commit()
    return ai_card_from_prep(spec["title"], prep, reason, pid, action)

def _csrf_header_ok():
    tok = request.headers.get("X-CSRF-Token", "")
    return bool(tok) and secrets.compare_digest(tok, session.get("_csrf", ""))

def ai_user(f):
    @wraps(f)
    @login_required
    def wrapper(*a, **k):
        if not has_perm("configuracion", "asistente"):
            flash("No tienes permiso para usar el asistente IA.", "danger")
            return redirect(url_for("dashboard"))
        return f(*a, **k)
    return wrapper

def _ai_json_guard():
    if not current_user.is_authenticated or not has_perm("configuracion", "asistente"):
        return jsonify(ok=False, error="Sin permiso para usar el asistente IA."), 403
    if not _csrf_header_ok():
        return jsonify(ok=False, error="La sesión de seguridad expiró. Recarga la página."), 400
    return None

def _load_proposal(pid):
    if not re.fullmatch(r"[a-f0-9]{16}", pid or ""):
        return None
    with get_db() as db:
        return db.execute("SELECT * FROM ai_proposals WHERE id=? AND user_id=?", (pid, current_user.id)).fetchone()

def _proposal_expired(row):
    try:
        return time.time() - datetime.strptime(row["created_at"], "%Y-%m-%d %H:%M:%S").timestamp() > AI_PROPOSAL_TTL
    except Exception:
        return True

@app.route("/asistente")
@ai_user
def asistente():
    with get_db() as db:
        rows = db.execute("""SELECT id,action,summary,status,applied_at FROM ai_proposals
                             WHERE user_id=? AND status IN ('aplicada','deshecha')
                             ORDER BY applied_at DESC LIMIT 10""", (current_user.id,)).fetchall()
    recent = []
    for r in rows:
        try: s = json.loads(r["summary"])
        except Exception: s = {"title": r["action"], "changes": []}
        recent.append({"id": r["id"], "title": s.get("title", r["action"]), "changes": s.get("changes", []),
                       "status": r["status"], "applied_at": r["applied_at"],
                       "undoable": r["status"] == "aplicada" and AI_ACTIONS.get(r["action"], {}).get("undo", False)})
    p = CONFIG.get("ai_provider", "none")
    model = CONFIG.get("ai_model") if p == "anthropic" else CONFIG.get("ai_ollama_model") if p == "ollama" else ""
    return render_template("asistente.html", configured=ai_is_configured(), provider=p, model=model, recent=recent,
                           can_service=has_perm("configuracion", "servicio"), active_page="asistente")

@app.route("/asistente/mensaje", methods=["POST"])
def asistente_mensaje():
    g = _ai_json_guard()
    if g: return g
    hist = ai_clean_history((request.get_json(silent=True) or {}).get("messages"))
    if not hist:
        return jsonify(ok=False, error="Escribe un mensaje."), 400
    if not ai_is_configured():
        return jsonify(ok=False, error="El asistente IA no está configurado todavía (Configuración → Servicio → Asistente IA)."), 400
    try:
        raw = llm_chat(ai_system_prompt(ai_build_context()), hist)
    except AIError as e:
        return jsonify(ok=False, error=str(e)), 502
    msg, props, parsed = ai_parse_reply(raw)
    cards = [ai_register_proposal(pr) for pr in props]
    if not parsed:
        msg = (msg or "El modelo no devolvió una respuesta.") + "\n\n(El modelo no usó el formato esperado, así que no hay cambios para aplicar. Reformula la petición.)"
    with get_db() as db:
        log_action(db, None, "Consulta al asistente IA", f"{len(cards)} propuesta(s) generadas")
        db.commit()
    return jsonify(ok=True, reply=msg, assistant_turn=(raw or "")[:AI_MAX_MSG], proposals=cards)

@app.route("/asistente/propuesta/<pid>/aplicar", methods=["POST"])
def asistente_aplicar(pid):
    g = _ai_json_guard()
    if g: return g
    row = _load_proposal(pid)
    if not row: return jsonify(ok=False, error="La propuesta no existe."), 404
    if row["status"] != "pendiente": return jsonify(ok=False, error=f"La propuesta ya fue {row['status']}."), 409
    if _proposal_expired(row):
        with get_db() as db:
            db.execute("UPDATE ai_proposals SET status='expirada' WHERE id=?", (pid,)); db.commit()
        return jsonify(ok=False, error="La propuesta expiró (más de 1 hora). Pídesela de nuevo al asistente."), 410
    spec = AI_ACTIONS.get(row["action"])
    if not spec or not has_perm(*spec["perm"]):
        return jsonify(ok=False, error="Tu rol no tiene permiso para aplicar este cambio."), 403
    with get_db() as db:      # reclamar la propuesta: evita aplicarla dos veces con doble clic
        claimed = db.execute("UPDATE ai_proposals SET status='aplicando' WHERE id=? AND status='pendiente'", (pid,)).rowcount
        db.commit()
    if claimed != 1: return jsonify(ok=False, error="La propuesta ya está siendo procesada."), 409
    prep = spec["prep"](json.loads(row["params"]))        # el estado pudo cambiar: se vuelve a validar
    status_back = "pendiente"
    try:
        if prep["errors"]:
            return jsonify(ok=False, error="Ya no es aplicable: " + "; ".join(prep["errors"])), 409
        res = ai_apply(row["action"], prep["params"])
        status_back = "aplicada"
    except (ValueError, sqlite3.Error, OSError) as e:
        return jsonify(ok=False, error=f"No se pudo aplicar: {e}"), 400
    finally:
        with get_db() as db:
            if status_back == "aplicada":
                db.execute("UPDATE ai_proposals SET status='aplicada', applied_at=datetime('now','localtime'), before=?, result=? WHERE id=?",
                           (json.dumps(prep["before"], ensure_ascii=False), res["message"], pid))
                resumen = "; ".join(f"{c['label']}: {c['current']} → {c['new']}" for c in prep["changes"])[:400]
                log_action(db, None, "Asistente IA: cambio aplicado", f"{spec['title']} — {resumen}")
            else:
                db.execute("UPDATE ai_proposals SET status='pendiente' WHERE id=?", (pid,))
            db.commit()
    return jsonify(ok=True, message=res["message"], restart=res["restart"], undoable=spec["undo"])

@app.route("/asistente/propuesta/<pid>/descartar", methods=["POST"])
def asistente_descartar(pid):
    g = _ai_json_guard()
    if g: return g
    row = _load_proposal(pid)
    if not row or row["status"] != "pendiente": return jsonify(ok=False, error="La propuesta no está pendiente."), 409
    with get_db() as db:
        db.execute("UPDATE ai_proposals SET status='descartada' WHERE id=? AND status='pendiente'", (pid,)); db.commit()
    return jsonify(ok=True)

@app.route("/asistente/propuesta/<pid>/deshacer", methods=["POST"])
def asistente_deshacer(pid):
    g = _ai_json_guard()
    if g: return g
    row = _load_proposal(pid)
    spec = AI_ACTIONS.get(row["action"]) if row else None
    if not row or not spec or not spec["undo"] or row["status"] != "aplicada":
        return jsonify(ok=False, error="Este cambio no se puede deshacer."), 409
    if not has_perm(*spec["perm"]):
        return jsonify(ok=False, error="Tu rol no tiene permiso para deshacer este cambio."), 403
    try:
        if row["action"] == "create_role":
            name = str(json.loads(row["params"]).get("name", "")).strip()
            with get_db() as db:
                r = db.execute("SELECT id FROM sys_roles WHERE name=?", (name,)).fetchone()
                if r and db.execute("SELECT COUNT(*) FROM sys_users WHERE role_id=?", (r["id"],)).fetchone()[0]:
                    return jsonify(ok=False, error="No se puede deshacer: ya hay usuarios con ese rol. Reasígnalos primero."), 409
                db.execute("DELETE FROM sys_roles WHERE name=? AND is_system=0", (name,)); db.commit()
            msg = f"Rol {name} eliminado."
        else:
            msg = ai_apply(row["action"], json.loads(row["before"]))["message"].replace("actualiz", "restaur")
    except (ValueError, sqlite3.Error) as e:
        return jsonify(ok=False, error=f"No se pudo deshacer: {e}"), 400
    with get_db() as db:
        db.execute("UPDATE ai_proposals SET status='deshecha' WHERE id=?", (pid,))
        log_action(db, None, "Asistente IA: cambio deshecho", json.loads(row["summary"]).get("title", row["action"]))
        db.commit()
    return jsonify(ok=True, message="Cambio deshecho. " + msg)

# ── Configuración del proveedor (Configuración → Servicio → Asistente IA) ────

@app.route("/configuracion/servicio/asistente/guardar", methods=["POST"])
@service_admin
def asistente_guardar():
    check_csrf()
    f, errors = request.form, []
    provider = f.get("ai_provider", "none")
    if provider not in AI_PROVIDERS: errors.append("Proveedor no válido.")
    model = f.get("ai_model", "").strip()
    omodel = f.get("ai_ollama_model", "").strip()
    url = f.get("ai_ollama_url", "").strip().rstrip("/")
    if model and not re.fullmatch(r"[A-Za-z0-9_.:\-/]{1,100}", model): errors.append("Nombre de modelo no válido.")
    if omodel and not re.fullmatch(r"[A-Za-z0-9_.:\-/]{1,100}", omodel): errors.append("Nombre de modelo de Ollama no válido.")
    if url and not re.fullmatch(r"https?://[A-Za-z0-9_.\-]+(:\d{1,5})?", url): errors.append("La URL de Ollama debe ser como http://127.0.0.1:11434")
    key = f.get("ai_api_key", "").strip()
    if key and not re.fullmatch(r"[A-Za-z0-9_\-]{10,300}", key): errors.append("La API key tiene caracteres no válidos.")
    if errors:
        for e in errors: flash(e, "danger")
        return redirect(url_for("servicio", tab="asistente"))
    CONFIG["ai_provider"] = provider
    if model: CONFIG["ai_model"] = model
    if omodel: CONFIG["ai_ollama_model"] = omodel
    if url: CONFIG["ai_ollama_url"] = url
    if f.get("ai_clear_key"): CONFIG["ai_api_key"] = ""
    elif key: CONFIG["ai_api_key"] = key
    save_config(CONFIG)
    with get_db() as db:
        log_action(db, None, "Configuración del asistente IA", f"Proveedor: {provider}"); db.commit()
    flash("Configuración del asistente guardada." + ("" if provider == "none" or ai_is_configured() else " Falta la API key para poder usarlo."), "success")
    return redirect(url_for("servicio", tab="asistente"))

@app.route("/configuracion/servicio/asistente/probar", methods=["POST"])
@login_required
def asistente_probar():
    if not has_perm("configuracion", "servicio"):
        return jsonify(ok=False, msg="Sin permiso."), 403
    if not _csrf_header_ok():
        return jsonify(ok=False, msg="La sesión de seguridad expiró. Recarga la página."), 400
    d = request.get_json(silent=True) or {}
    cfg = ai_effective_cfg({"provider": d.get("provider"), "model": d.get("model"), "key": d.get("key"),
                            "ollama_url": d.get("ollama_url"), "ollama_model": d.get("ollama_model")})
    try:
        if cfg["provider"] == "anthropic":
            llm_chat("Responde únicamente con la palabra: ok", [{"role": "user", "content": "ping"}], max_tokens=16, timeout=30, cfg=cfg)
            return jsonify(ok=True, msg=f"Conexión correcta con Claude (modelo {cfg['model']}).")
        if cfg["provider"] == "ollama":
            base = cfg["ollama_url"].rstrip("/")
            if not re.fullmatch(r"https?://[A-Za-z0-9_.\-]+(:\d{1,5})?", base):
                return jsonify(ok=False, msg="La URL de Ollama no es válida.")
            tags = _http_json(base + "/api/tags", timeout=15)
            names = [m.get("name", "") for m in tags.get("models", [])]
            have = any(n == cfg["ollama_model"] or n.split(":")[0] == cfg["ollama_model"].split(":")[0] and ":" not in cfg["ollama_model"] for n in names)
            if not have:
                return jsonify(ok=False, msg=f"Ollama responde, pero el modelo «{cfg['ollama_model']}» no está instalado. Ejecuta: ollama pull {cfg['ollama_model']}. Instalados: {', '.join(names[:8]) or 'ninguno'}.")
            return jsonify(ok=True, msg=f"Conexión correcta con Ollama. Modelo «{cfg['ollama_model']}» disponible.")
        return jsonify(ok=False, msg="Elige un proveedor para probar.")
    except AIError as e:
        return jsonify(ok=False, msg=str(e))

# ═══════════════════════════════════════════════════════════════════════════════
# AUTOPRUEBA Y ARRANQUE
# ═══════════════════════════════════════════════════════════════════════════════

def run_selftest():
    """Usada al validar un paquete: arranca la app candidata sobre una copia de los datos y recorre las pantallas."""
    init_db()
    c = app.test_client()
    problems = []
    for url in ("/health", "/login"):
        if c.get(url).status_code != 200:
            problems.append(url)
    with get_db() as db:
        r = db.execute("SELECT id FROM sys_users WHERE active=1 ORDER BY role_id, id LIMIT 1").fetchone()
    if not r:
        problems.append("no hay usuarios del sistema activos")
    else:
        with c.session_transaction() as s:
            s["_user_id"] = str(r["id"])
        for url in ("/", "/usuarios", "/bajas", "/bajas/nueva", "/plataformas", "/reportes", "/audit",
                    "/importar", "/configuracion", "/configuracion/servicio", "/asistente"):
            code = c.get(url).status_code
            if code >= 500 or code == 404:
                problems.append(f"{url} → HTTP {code}")
    if problems:
        print("SELFTEST_FAIL: " + "; ".join(problems))
        return 1
    print(f"SELFTEST_OK version={APP_VERSION}")
    return 0

if __name__ == "__main__":
    if "--selftest" in sys.argv:
        sys.exit(run_selftest())
    init_db()
    restarted = os.environ.get("USERSYNC_RESTARTED") == "1"
    try: os.remove(PENDING_FLAG)
    except OSError: pass

    host, port = CONFIG["host"], int(CONFIG["port"])
    deadline = time.time() + (20 if restarted else 3)       # tras un reinicio, el puerto anterior puede tardar en liberarse
    while not port_free(host, port) and time.time() < deadline:
        time.sleep(0.5)
    if not port_free(host, port):
        if port != 5000 and port_free(host, 5000):
            print(f"[UserSync] AVISO: el puerto {port} está ocupado. Iniciando en el puerto 5000 (revisa Configuración → Servicio).")
            port = 5000
        else:
            print(f"[UserSync] ERROR: el puerto {port} está ocupado y no hay alternativa. Cierra el programa que lo usa o cambia el puerto.")
            sys.exit(2)
    RUNTIME.update(host=host, port=port)
    start_scheduler()

    try:
        from waitress import serve as _serve
    except ImportError:
        _serve = None
    RUNTIME["server"] = "waitress" if _serve else "flask"

    if CONFIG.get("open_browser", True) and not restarted:
        threading.Thread(target=lambda: (time.sleep(1.2), webbrowser.open(f"http://127.0.0.1:{port}")), daemon=True).start()
    print(f"[UserSync] v{APP_VERSION} escuchando en http://{host}:{port}  (servidor: {RUNTIME['server']})")
    if _serve:
        _serve(app, host=host, port=port, threads=8, ident="UserSync")
    else:
        app.run(host=host, port=port, debug=False, use_reloader=False)
