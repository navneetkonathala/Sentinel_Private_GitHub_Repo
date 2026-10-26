# Sentinel — Utkrishta 2026, Challenge 2

Sentinel is a student prototype for adaptive time-series anomaly detection. It uses a permitted sliding-window adaptive-threshold approach: a rolling median and MAD estimate normal behavior, then a robust score labels unusual readings and supplies evidence.

## Run the website

Requirements: Python 3.9 or newer. The running website uses Python's standard library; no package installation is needed.

```sh
python3 auth_server.py
```

Open <http://127.0.0.1:8001>. Keep that terminal open while using the site. Do not run `python3 -m http.server`: the authenticated Python server must handle website requests.

The primary presenter account is initialized on first run. Its local demo credentials and configuration are documented in [AUTH_SETUP.md](AUTH_SETUP.md). The presenter can add presenter accounts and open/close member access from the bottom of the dashboard. Members register with an `@iiits.in` address and password; the domain is checked, but mailbox ownership is not verified.

### Demo accounts

The primary presenter administrator is:

- **Email:** `navneet.k26@iiits.in`
- **Password:** `demopass`

Example additional presenter credentials (for illustration only; this account is **not** pre-created):

- **Email:** `xyz@iiits.in`
- **Password:** `password`

The example uses the configured `@iiits.in` domain. To create this presenter account, the primary admin must add it in the dashboard; it is not seeded automatically. Ordinary members create their own accounts through **Create account**. Keep this repository private while it contains demo credentials, and change the administrator password before any public deployment.

## Run the Python detector by itself

```sh
python3 sentinel.py
```

`Sentinel.update(value)` accepts one numeric observation. Defaults: 51 accepted readings in the rolling window, 12 readings to warm up, and a robust-score threshold of 3.5. Flagged values are not added to the baseline.

## What the demo does—and does not do

- The website creates a random synthetic signal. It is not connected to a real-time database, company service, server packets, or the NAB dataset.
- Presenters can inject a synthetic anomaly, simulate drift, pause, and reset. Registered members get these controls only while member access is open.
- `sentinel.py` and the browser's JavaScript simulation are separate implementations with matching defaults. The website does not call the Python detector.
- The supplied workspace has no NAB subset or benchmark results. Do not present synthetic examples as measured performance.

## Project files

- `auth_server.py` — local login server, session handling, member access, presenter management.
- `sentinel.py` — Python streaming detector and sample run.
- `index.html`, `styles.css`, `app.js` — responsive dashboard and synthetic demonstration.
- `login.html`, `auth.css`, `auth.js` — sign-in and member registration pages.
- `code-explainer.html` — beginner-friendly method and demo guide.
- `make_deck.py`, `Sentinel_Challenge_2_Presentation.pptx` — deck source and the official 10-slide presentation.
- `Utkrishta 2026 Participant Problem Statements.pdf` — official challenge brief.
- `AUTH_SETUP.md` — authentication and local setup details.

## Private GitHub notes

Keep this repository private while it contains the demo admin credential. Change the default password before hosting anywhere public. The account database `sentinel_auth.sqlite3`, local `.env` files, Python caches, and editor/OS files are excluded by `.gitignore`; do not commit user records. Public deployment requires HTTPS, persistent private database storage, and an application server—not static hosting.

## Rebuild the presentation (optional)

The web app does not need the presentation package. To regenerate the PowerPoint on a machine with internet access:

```sh
python3 -m pip install -r requirements-deck.txt
python3 make_deck.py
```

