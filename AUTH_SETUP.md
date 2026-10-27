# Sentinel login setup

The project uses a small Python server for account creation, login, and protected dashboard access. Run this server rather than hosting the HTML files as static files; static hosting would bypass the sign-in checks.

## Start locally

```sh
python3 auth_server.py
```

Open `http://127.0.0.1:8001`. New member accounts must use an email address ending exactly in `@iiits.in` and set a password of at least 8 characters. There is no OTP or email delivery step.

Registration checks the address suffix only. Without OTP or another identity provider, the site cannot confirm that a person owns the mailbox or is actually affiliated with the institute.

## Presenter account and sharing

On the first server start, the primary presenter account is created automatically. For local development only, sign in with `navneet.k26@iiits.in` and the demo password `demopass`. Do not use this demo password outside local development. At the bottom of the dashboard, the primary presenter can open or close member access and add/remove other presenter accounts. Added presenters use `@iiits.in` addresses and receive the password set by the primary presenter; they can use the detector but cannot manage access or presenters.

The presenter email and password can be changed with `SENTINEL_ADMIN_EMAIL` and `SENTINEL_ADMIN_PASSWORD`. The accepted institute domain can be changed with `SENTINEL_INSTITUTE_DOMAIN`; the default is `iiits.in`.

## Storage

Accounts, the sharing switch, and each user's submitted numeric readings are stored in `sentinel_auth.sqlite3` beside the server by default. Set `SENTINEL_DB_PATH` to use another database file. Reading records are scoped to the signed-in email. The model is held in server memory and retrained from the public NAB series plus that user's confirmed-normal readings. Back up the database to preserve accounts and inputs.
