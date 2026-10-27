"""Small local demo server with institute-domain registration and gated access.

This is a hackathon prototype; replace the demo admin password before using it outside local development.
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
import math
from statistics import median
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

from isolation_forest import IsolationForest, features


ROOT = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("SENTINEL_DB_PATH", str(ROOT / "sentinel_auth.sqlite3")))
HOST = os.environ.get("SENTINEL_HOST", "127.0.0.1")
PORT = int(os.environ.get("SENTINEL_PORT", os.environ.get("PORT", "8001")))
ADMIN_EMAIL = os.environ.get("SENTINEL_ADMIN_EMAIL", "navneet.k26@iiits.in").strip().lower()
ADMIN_PASSWORD = os.environ.get("SENTINEL_ADMIN_PASSWORD", "demopass")
INSTITUTE_DOMAIN = os.environ.get("SENTINEL_INSTITUTE_DOMAIN", "iiits.in").strip().lower().lstrip("@")
SESSION_SECONDS = 60 * 60 * 12
LOGIN_FAILURES = {}
LOGIN_LOCK = threading.Lock()
MODEL_CACHE = {}


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
            CREATE TABLE IF NOT EXISTS observations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                value REAL NOT NULL,
                score REAL NOT NULL,
                predicted_anomaly INTEGER NOT NULL,
                review_label TEXT CHECK(review_label IN ('normal','anomaly') OR review_label IS NULL),
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS observations_by_user_time ON observations(email, timestamp, id);
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
            if length > 2_000_000:
                return None
            return json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            return None

    def api_error(self, status: int, message: str, code: str = "error"):
        self.send_json(status, {"ok": False, "code": code, "message": message})

    def api_user(self):
        user = self.session_user()
        if not user:
            self.api_error(401, "Please sign in again.", "unauthorized")
            return None
        if user["role"] == "member" and not self.shared_access():
            self.api_error(403, "Member access is currently closed.", "access_closed")
            return None
        return user

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
        if path == "/api/observations":
            user = self.api_user()
            if not user:
                return
            with connect_db() as db:
                rows = db.execute("SELECT id,timestamp,value,score,predicted_anomaly,review_label,created_at FROM observations WHERE email=? ORDER BY timestamp,id", (user["email"],)).fetchall()
            self.send_json(200, {"ok": True, "observations": [dict(row) for row in rows]})
            return
        if path in ("/index.html", "/code-explainer.html"):
            user = self.session_user()
            if not user:
                self.send_response(302); self.send_header("Location", "/login.html"); self.end_headers(); return
            if user["role"] == "member" and not self.shared_access():
                self.send_response(302); self.send_header("Location", "/login.html?locked=1"); self.end_headers(); return
            self.send_page(path.lstrip("/")); return
        if path in ("/styles.css", "/app.js", "/auth.css", "/auth.js", "/manifest.webmanifest", "/icon.svg", "/sw.js", "/sentinel.py", "/isolation_forest.py", "/Utkrishta 2026 Participant Problem Statements.pdf"):
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
        if path == "/api/model/train":
            self.train_model(data); return
        if path == "/api/observations":
            self.add_observation(data); return
        if path == "/api/observations/review":
            self.review_observation(data); return
        self.api_error(404, "Not found.")

    @staticmethod
    def parse_timestamp(value):
        try:
            parsed = datetime.fromisoformat(str(value).strip().replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=__import__("datetime").timezone.utc)
            return parsed.timestamp()
        except (TypeError, ValueError, OverflowError):
            return None

    def train_model(self, data):
        user = self.api_user()
        if not user:
            return
        raw_rows = data.get("rows")
        raw_windows = data.get("windows", [])
        if not isinstance(raw_rows, list) or len(raw_rows) < 100 or len(raw_rows) > 25000:
            self.api_error(400, "Load a time-series CSV with between 100 and 25,000 readings first.", "invalid_dataset")
            return
        if not isinstance(raw_windows, list) or len(raw_windows) > 1000:
            self.api_error(400, "The anomaly-window labels are not in a supported format.", "invalid_labels")
            return
        rows = []
        for item in raw_rows:
            if not isinstance(item, dict):
                self.api_error(400, "Each data row needs a timestamp and numeric value.", "invalid_dataset")
                return
            timestamp = self.parse_timestamp(item.get("timestamp"))
            try:
                value = float(item.get("value"))
            except (TypeError, ValueError):
                value = float("nan")
            if timestamp is None or not math.isfinite(value):
                self.api_error(400, "Dataset timestamps and values must be valid numbers.", "invalid_dataset")
                return
            rows.append({"timestamp": str(item["timestamp"]), "time": timestamp, "value": value})
        rows.sort(key=lambda row: row["time"])
        windows = []
        for item in raw_windows:
            try:
                start = self.parse_timestamp(item.get("start"))
                end = self.parse_timestamp(item.get("end"))
            except AttributeError:
                start = end = None
            if start is None or end is None or end < start:
                self.api_error(400, "Anomaly windows need valid start and end timestamps.", "invalid_labels")
                return
            windows.append((start, end))

        is_labeled = lambda timestamp: any(start <= timestamp <= end for start, end in windows)
        training = []
        clean_history = []
        for row in rows:
            vector = features(row["value"], clean_history)
            if not is_labeled(row["time"]):
                training.append(vector)
                clean_history.append(row["value"])
                if len(clean_history) > 24:
                    clean_history.pop(0)
        nab_context = clean_history[-24:]
        with connect_db() as db:
            user_rows = db.execute("SELECT timestamp,value FROM observations WHERE email=? AND review_label='normal' ORDER BY timestamp,id", (user["email"],)).fetchall()
        for stored in user_rows:
            value = float(stored["value"])
            training.append(features(value, clean_history))
            clean_history.append(value)
            if len(clean_history) > 24:
                clean_history.pop(0)
        try:
            seed = int(hashlib.sha256(user["email"].encode()).hexdigest()[:8], 16)
            forest = IsolationForest(trees=40, sample_size=128, contamination=0.02, seed=seed).fit(training)
        except (ValueError, RuntimeError) as error:
            self.api_error(400, str(error), "training_failed")
            return

        # Replay in chronological order. A flagged point is withheld from the
        # context so one anomaly cannot teach the detector that it is normal.
        replay_history = []
        predictions = []
        inference_start = time.perf_counter()
        for row in rows:
            vector = features(row["value"], replay_history)
            score = forest.score(vector)
            flagged = score >= forest.threshold
            truth = is_labeled(row["time"])
            predictions.append({
                "timestamp": row["timestamp"], "value": row["value"],
                "score": round(score, 5), "anomaly": flagged, "truth": truth,
                "truth_known": bool(windows),
                "false_positive": bool(windows) and flagged and not truth,
                "missed": bool(windows) and truth and not flagged,
                "baseline": round(median(replay_history), 4) if replay_history else row["value"],
            })
            if not flagged:
                replay_history.append(row["value"])
                if len(replay_history) > 24:
                    replay_history.pop(0)
        inference_ms = (time.perf_counter() - inference_start) * 1000 / len(rows)

        matched = [next((point for point in predictions if point["anomaly"] and self.parse_timestamp(point["timestamp"]) >= start and self.parse_timestamp(point["timestamp"]) <= end), None) for start, end in windows]
        tp = sum(point is not None for point in matched)
        fn = len(windows) - tp
        runs = []
        for index, point in enumerate(predictions):
            if not point["anomaly"]:
                continue
            if not runs or index - runs[-1][-1] > 2:
                runs.append([index])
            else:
                runs[-1].append(index)
        # Keep point rows lean in the API, but use parsed timestamps for event metrics.
        prediction_times = [self.parse_timestamp(point["timestamp"]) for point in predictions]
        false_runs = sum(not any(any(start <= prediction_times[index] <= end for index in run) for start, end in windows) for run in runs)
        fp = false_runs
        precision = tp / (tp + fp) if tp + fp else 0.0
        recall = tp / (tp + fn) if tp + fn else 0.0
        f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
        delays = []
        for (start, end), first in zip(windows, matched):
            if first:
                delays.append((self.parse_timestamp(first["timestamp"]) - start) / 60.0)
        MODEL_CACHE[user["email"]] = {"forest": forest, "history": nab_context, "trained_at": int(time.time())}
        self.send_json(200, {
            "ok": True,
            "model": "Isolation Forest",
            "trees": forest.trees,
            "sample_size": min(forest.sample_size, forest.training_count),
            "threshold": round(forest.threshold, 5),
            "training_count": forest.training_count,
            "user_training_count": len(user_rows),
            "contamination": forest.contamination,
            "predictions": predictions,
            "metrics": {"precision": precision, "recall": recall, "event_f1": f1,
                        "tp": tp, "fp": fp, "fn": fn,
                        "mean_delay_minutes": sum(delays) / len(delays) if delays else None,
                        "inference_ms_per_sample": inference_ms},
        })

    def add_observation(self, data):
        user = self.api_user()
        if not user:
            return
        cached = MODEL_CACHE.get(user["email"])
        if not cached:
            self.api_error(409, "Train the model on the loaded NAB dataset before submitting readings.", "model_not_trained")
            return
        timestamp = self.parse_timestamp(data.get("timestamp"))
        try:
            value = float(data.get("value"))
        except (TypeError, ValueError):
            value = float("nan")
        if timestamp is None or not math.isfinite(value):
            self.api_error(400, "Enter a valid timestamp and numeric reading.", "invalid_reading")
            return
        with connect_db() as db:
            recent = db.execute("SELECT timestamp,value,predicted_anomaly,review_label FROM observations WHERE email=? ORDER BY timestamp DESC,id DESC LIMIT 24", (user["email"],)).fetchall()
            recent = [row for row in reversed(recent) if row["review_label"] != "anomaly" and not row["predicted_anomaly"]]
            history = [float(value) for value in cached["history"]]
            history.extend(float(row["value"]) for row in recent)
            vector = features(value, history[-24:])
            forest = cached["forest"]
            score = forest.score(vector)
            flagged = score >= forest.threshold
            cursor = db.execute("INSERT INTO observations(email,timestamp,value,score,predicted_anomaly,review_label,created_at) VALUES(?,?,?,?,?,NULL,?)",
                                (user["email"], str(data["timestamp"]), value, score, int(flagged), int(time.time())))
            observation_id = cursor.lastrowid
        self.send_json(201, {"ok": True, "observation": {"id": observation_id, "timestamp": str(data["timestamp"]), "value": value,
                         "score": round(score, 5), "anomaly": flagged,
                         "training_candidate": not flagged,
                         "message": "Unusual reading flagged by Isolation Forest." if flagged else "Reading is within the learned pattern; confirm it as normal to include it in the next training run."}})

    def review_observation(self, data):
        user = self.api_user()
        if not user:
            return
        try:
            observation_id = int(data.get("id"))
        except (TypeError, ValueError):
            self.api_error(400, "Choose a valid reading to review.", "invalid_id")
            return
        label = data.get("label")
        if label not in ("normal", "anomaly"):
            self.api_error(400, "Review the reading as normal or anomaly.", "invalid_label")
            return
        with connect_db() as db:
            result = db.execute("UPDATE observations SET review_label=? WHERE id=? AND email=?", (label, observation_id, user["email"]))
        if not result.rowcount:
            self.api_error(404, "That saved reading was not found.", "not_found")
            return
        MODEL_CACHE.pop(user["email"], None)
        self.send_json(200, {"ok": True, "message": "Review saved. Train again to include confirmed-normal readings."})

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
