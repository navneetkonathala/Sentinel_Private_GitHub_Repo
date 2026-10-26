# Sentinel — Utkrishta 2026, Challenge 2

Sentinel is a student prototype for NAB time-series anomaly detection. The dashboard trains a permitted unsupervised Isolation Forest on clean readings, scores each point, and shows evidence for detected or missed points.

## Run the website

Requirements: Python 3.9 or newer. The website and dependency-free Isolation Forest use Python's standard library; no ML package installation is needed.

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

`sentinel.py` uses the same dependency-free Isolation Forest as the website, implemented in `isolation_forest.py`. It collects at least 12 initial readings to train; it starts scoring each new reading after warm-up.

## Dataset and evaluation

- The challenge PDF specifies an organizer-prepared Numenta Anomaly Benchmark (NAB) subset with hidden test windows. That starter subset was not present in the supplied workspace.
- The website therefore loads the public NAB `ambient_temperature_system_failure.csv` example from Numenta's GitHub when online. It is real hourly office-temperature data, with published NAB anomaly windows; it is explicitly identified in the UI as stand-in data, not the hidden challenge subset.
- Use **Load challenge CSV** and **Load labels JSON** to replace the public example with the organizer-provided files. CSV columns must include `timestamp` and `value`; the labels JSON can use NAB's combined-windows format.
- The server trains 40 randomized trees (sample size 128, contamination 2%) on clean NAB samples. It excludes published anomaly windows from training and uses those labels only for evaluation.
- The dashboard reports event precision, recall, F1, detection delay, and server inference time. Scores depend on the loaded data; do not report public-example scores as hidden-test results.
- New readings are stored in `sentinel_auth.sqlite3` by signed-in account and scored by the trained model. Review predictions: confirmed-normal readings join the next training run; confirmed anomalies are stored but excluded from training. After a confirmation saves and the model refreshes, the review popup closes automatically.
- The alert table lists each flagged point and each missed point inside known NAB windows. New user readings have no automatic ground truth, so a person must review them before calling them true or false alerts.
- The browser sends the loaded series to the local authenticated server for training and scoring. User-entered readings persist in SQLite; challenge CSV contents are not stored as a dataset file.

## Project files

- `auth_server.py` — local login server, session handling, member access, presenter management.
- `sentinel.py` — standalone streaming interface and sample run using Isolation Forest.
- `isolation_forest.py` — shared dependency-free Isolation Forest implementation used by both the website and standalone detector.
- `index.html`, `styles.css`, `app.js` — responsive NAB dataset dashboard, CSV/labels loading, streaming replay, evidence, and benchmark metrics.
- `login.html`, `auth.css`, `auth.js` — sign-in and member registration pages.
- `code-explainer.html` — beginner-friendly method and demo guide.
- `Sentinel_Challenge_2_Presentation.pptx` — the official 10-slide presentation.
- `Utkrishta 2026 Participant Problem Statements.pdf` — official challenge brief.
- `AUTH_SETUP.md` — authentication and local setup details.

## Private GitHub notes

Keep this repository private while it contains the demo admin credential. Change the default password before hosting anywhere public. The account database `sentinel_auth.sqlite3`, local `.env` files, Python caches, and editor/OS files are excluded by `.gitignore`; do not commit user records. Public deployment requires HTTPS, persistent private database storage, and an application server—not static hosting.
