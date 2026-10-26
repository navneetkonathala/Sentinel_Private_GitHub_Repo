"""Small local demo server with institute-domain registration and gated access.

This is a hackathon prototype; deploy behind HTTPS and replace the demo admin password before public use.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import time
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse


ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / "sentinel_auth.sqlite3"
HOST = os.environ.get("SENTINEL_HOST", "127.0.0.1")
PORT = int(os.environ.get("SENTINEL_PORT", "8001"))
ADMIN_EMAIL = os.environ.get("SENTINEL_ADMIN_EMAIL", "navneet.k26@iiits.in").strip().lower()
ADMIN_PASSWORD = os.environ.get("SENTINEL_ADMIN_PASSWORD", "demopass")
INSTITUTE_DOMAIN = os.environ.get("SENTINEL_INSTITUTE_DOMAIN", "iiits.in").strip().lower().lstrip("@")
SESSION_SECONDS = 60 * 60 * 12
LOGIN_FAILURES = {}
LOGIN_LOCK = threading.Lock()


def connect_db():
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    return db


def init_db():
    with connect_db() as db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS users (
                email TEXT PRIMARY KEY,
                password_salt BLOB NOT NULL,
                password_hash BLOB NOT NULL,
                role TEXT NOT NULL CHECK(role IN ('admin', 'presenter', 'member')),
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash BLOB PRIMARY KEY,
                email TEXT NOT NULL,
                expires_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS settings (
                name TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            INSERT OR IGNORE INTO settings(name, value) VALUES ('shared_access', '0');
        """)
        schema = db.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").fetchone()[0]
        if "presenter" not in schema:
            db.execute("ALTER TABLE users RENAME TO users_old")
            db.execute("""CREATE TABLE users (
                email TEXT PRIMARY KEY,
                password_salt BLOB NOT NULL,
                password_hash BLOB NOT NULL,
                role TEXT NOT NULL CHECK(role IN ('admin', 'presenter', 'member')),
                created_at INTEGER NOT NULL
            )""")
            db.execute("INSERT INTO users SELECT email,password_salt,password_hash,role,created_at FROM users_old")
            db.execute("DROP TABLE users_old")
        admin_salt = secrets.token_bytes(16)
        db.execute("INSERT OR IGNORE INTO users(email,password_salt,password_hash,role,created_at) VALUES(?,?,?,?,?)",
                   (ADMIN_EMAIL, admin_salt, password_hash(ADMIN_PASSWORD, admin_salt), "admin", int(time.time())))


def password_hash(password: str, salt: bytes) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 600_000)


class SentinelHandler(BaseHTTPRequestHandler):
    server_version = "SentinelDemo/1.0"

    def log_message(self, fmt, *args):
        # Keep request logs useful without logging request bodies or passwords.
        super().log_message(fmt, *args)

    def send_json(self, status: int, payload: dict, extra_headers: dict | None = None):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        if extra_headers:
            for key, value in extra_headers.items():
                self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length > 8192:
                return None
            return json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            return None

    def api_error(self, status: int, message: str, code: str = "error"):
        self.send_json(status, {"ok": False, "code": code, "message": message})

    def session_user(self):
        cookie = self.headers.get("Cookie", "")
        token = ""
        for part in cookie.split(";"):
            key, sep, value = part.strip().partition("=")
            if sep and key == "sentinel_session":
                token = value
                break
        if not token:
            return None
        token_hash = hashlib.sha256(token.encode()).digest()
        with connect_db() as db:
            row = db.execute(
                "SELECT users.email, users.role, sessions.expires_at FROM sessions "
                "JOIN users ON users.email=sessions.email WHERE sessions.token_hash=?",
                (token_hash,),
            ).fetchone()
            if row and row["expires_at"] > int(time.time()):
                return {"email": row["email"], "role": row["role"]}
            db.execute("DELETE FROM sessions WHERE token_hash=?", (token_hash,))
        return None

    def issue_session(self, email: str):
        token = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(token.encode()).digest()
        with connect_db() as db:
            db.execute("INSERT INTO sessions(token_hash,email,expires_at) VALUES(?,?,?)",
                       (token_hash, email, int(time.time()) + SESSION_SECONDS))
        secure = "; Secure" if self.headers.get("X-Forwarded-Proto", "").lower() == "https" else ""
        return {"Set-Cookie": f"sentinel_session={token}; HttpOnly; SameSite=Lax; Path=/; Max-Age={SESSION_SECONDS}{secure}"}

    def send_page(self, filename: str, status: int = 200):
        body = (ROOT / filename).read_bytes()
        content_type = "text/html; charset=utf-8" if filename.endswith(".html") else "text/plain; charset=utf-8"
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = unquote(urlparse(self.path).path)
        if path in ("/", "/login", "/login.html"):
            user = self.session_user()
            if user and (user["role"] in ("admin", "presenter") or self.shared_access()):
                self.send_response(302); self.send_header("Location", "/index.html"); self.end_headers(); return
            self.send_page("login.html"); return
        if path == "/api/session":
            user = self.session_user()
            self.send_json(200, {"ok": True, "user": user, "shared": self.shared_access()})
            return
        if path == "/api/admin/presenters":
            user = self.session_user()
            if not user or user["role"] != "admin":
                self.api_error(403, "Only the primary presenter can manage presenters.", "admin_only"); return
            with connect_db() as db:
                rows = db.execute("SELECT email, created_at FROM users WHERE role='presenter' ORDER BY email").fetchall()
            self.send_json(200, {"ok": True, "presenters": [dict(row) for row in rows]})
            return
        if path in ("/index.html", "/code-explainer.html"):
            user = self.session_user()
            if not user:
                self.send_response(302); self.send_header("Location", "/login.html"); self.end_headers(); return
            if user["role"] == "member" and not self.shared_access():
                self.send_response(302); self.send_header("Location", "/login.html?locked=1"); self.end_headers(); return
            self.send_page(path.lstrip("/")); return
        if path in ("/styles.css", "/app.js", "/auth.css", "/auth.js", "/manifest.webmanifest", "/icon.svg", "/sw.js", "/sentinel.py", "/Utkrishta 2026 Participant Problem Statements.pdf"):
            self.send_file(path.lstrip("/")); return
        self.send_error(404)

    def send_file(self, filename: str):
        file_path = ROOT / filename
        if not file_path.is_file():
            self.send_error(404); return
        content_type = {
            ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
            ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml",
            ".py": "text/plain; charset=utf-8", ".pdf": "application/pdf",
        }.get(file_path.suffix, "application/octet-stream")
        body = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def shared_access(self):
        with connect_db() as db:
            row = db.execute("SELECT value FROM settings WHERE name='shared_access'").fetchone()
            return bool(row and row["value"] == "1")

    def do_POST(self):
        path = urlparse(self.path).path
        data = self.read_json()
        if data is None:
            self.api_error(400, "Invalid request."); return
        if path == "/api/register":
            self.register(data); return
        if path == "/api/login":
            self.login(data); return
        if path == "/api/logout":
            self.logout(); return
        if path == "/api/admin/share":
            self.set_share(data); return
        if path == "/api/admin/presenters":
            self.add_presenter(data); return
        if path == "/api/admin/presenters/remove":
            self.remove_presenter(data); return
        self.api_error(404, "Not found.")

    def register(self, data):
        email = str(data.get("email", "")).strip().lower()
        password = str(data.get("password", ""))
        if len(email) > 254 or email.count("@") != 1 or any(char.isspace() for char in email) or len(password) < 8 or len(password) > 128:
            self.api_error(400, "Enter a valid email and a password of at least 8 characters."); return
        if email == ADMIN_EMAIL:
            self.api_error(403, "This address is reserved for the primary presenter account.", "admin_only"); return
        if email.rsplit("@", 1)[-1] != INSTITUTE_DOMAIN:
            self.api_error(403, f"Use your institute email ending in @{INSTITUTE_DOMAIN}.", "institute_email"); return
        with connect_db() as db:
            if db.execute("SELECT 1 FROM users WHERE email=?", (email,)).fetchone():
                self.api_error(409, "That email is already registered. Please log in.", "exists"); return
        salt = secrets.token_bytes(16)
        encoded_password = password_hash(password, salt)
        with connect_db() as db:
            db.execute("INSERT INTO users(email,password_salt,password_hash,role,created_at) VALUES(?,?,?,?,?)",
                       (email, salt, encoded_password, "member", int(time.time())))
        self.send_json(201, {"ok": True, "message": "Account created. You can now sign in."})

    def login(self, data):
        email = str(data.get("email", "")).strip().lower()
        password = str(data.get("password", ""))
        key = (self.client_address[0], email)
        now = int(time.time())
        with LOGIN_LOCK:
            attempts = [stamp for stamp in LOGIN_FAILURES.get(key, []) if now - stamp < 900]
            if len(attempts) >= 10:
                self.api_error(429, "Too many sign-in attempts. Please wait 15 minutes and try again.", "rate_limited"); return
        with connect_db() as db:
            user = db.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
        if not user or not hmac.compare_digest(password_hash(password, bytes(user["password_salt"])), bytes(user["password_hash"])):
            with LOGIN_LOCK:
                LOGIN_FAILURES[key] = attempts + [now]
            self.api_error(401, "Email or password is incorrect.", "invalid_login"); return
        with LOGIN_LOCK:
            LOGIN_FAILURES.pop(key, None)
        if user["role"] == "member" and not self.shared_access():
            self.send_json(403, {"ok": False, "code": "coming_soon", "message": "We’re sorry — the member website is still being built. Your account is saved; please check back when the presenter opens access."}); return
        self.send_json(200, {"ok": True, "user": {"email": email, "role": user["role"]}}, self.issue_session(email))

    def logout(self):
        cookie = self.headers.get("Cookie", "")
        token = next((part.strip().split("=", 1)[1] for part in cookie.split(";") if part.strip().startswith("sentinel_session=")), "")
        if token:
            with connect_db() as db:
                db.execute("DELETE FROM sessions WHERE token_hash=?", (hashlib.sha256(token.encode()).digest(),))
        self.send_json(200, {"ok": True}, {"Set-Cookie": "sentinel_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"})

    def set_share(self, data):
        user = self.session_user()
        if not user or user["role"] != "admin":
            self.api_error(403, "Only the presenter account can change access.", "admin_only"); return
        enabled = bool(data.get("enabled"))
        with connect_db() as db:
            db.execute("UPDATE settings SET value=? WHERE name='shared_access'", ("1" if enabled else "0",))
        self.send_json(200, {"ok": True, "shared": enabled,
                             "message": "Member access is open." if enabled else "Member access is closed."})

    def add_presenter(self, data):
        user = self.session_user()
        if not user or user["role"] != "admin":
            self.api_error(403, "Only the primary presenter can add presenters.", "admin_only"); return
        email = str(data.get("email", "")).strip().lower()
        password = str(data.get("password", ""))
        if len(email) > 254 or email.count("@") != 1 or any(char.isspace() for char in email):
            self.api_error(400, "Enter a valid institute email."); return
        if email.rsplit("@", 1)[-1] != INSTITUTE_DOMAIN:
            self.api_error(403, f"Use an email ending in @{INSTITUTE_DOMAIN}.", "institute_email"); return
        if len(password) < 8 or len(password) > 128:
            self.api_error(400, "Set a presenter password with at least 8 characters."); return
        if email == ADMIN_EMAIL:
            self.api_error(409, "That is the primary presenter account."); return
        salt = secrets.token_bytes(16)
        try:
            with connect_db() as db:
                db.execute("INSERT INTO users(email,password_salt,password_hash,role,created_at) VALUES(?,?,?,?,?)",
                           (email, salt, password_hash(password, salt), "presenter", int(time.time())))
        except sqlite3.IntegrityError:
            self.api_error(409, "An account with that email already exists.", "exists"); return
        self.send_json(201, {"ok": True, "message": "Presenter added. Share their email and password with them securely."})

    def remove_presenter(self, data):
        user = self.session_user()
        if not user or user["role"] != "admin":
            self.api_error(403, "Only the primary presenter can remove presenters.", "admin_only"); return
        email = str(data.get("email", "")).strip().lower()
        with connect_db() as db:
            db.execute("DELETE FROM sessions WHERE email=?", (email,))
            result = db.execute("DELETE FROM users WHERE email=? AND role='presenter'", (email,))
        if result.rowcount == 0:
            self.api_error(404, "Presenter account was not found."); return
        self.send_json(200, {"ok": True, "message": "Presenter access removed."})


if __name__ == "__main__":
    init_db()
    print(f"Sentinel auth demo at http://{HOST}:{PORT}")
    print(f"Institute members: *@{INSTITUTE_DOMAIN}; presenter: {ADMIN_EMAIL}")
    ThreadingHTTPServer((HOST, PORT), SentinelHandler).serve_forever()
