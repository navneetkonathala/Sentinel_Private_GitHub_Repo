# Sentinel login setup

The project uses a small Python server for account creation, login, and protected dashboard access. Run this server rather than hosting the HTML files as static files; static hosting would bypass the sign-in checks.

## Start locally

```sh
python3 auth_server.py
```

Open `http://127.0.0.1:8001`. New member accounts must use an email address ending exactly in `@iiits.in` and set a password of at least 8 characters. There is no OTP or email delivery step.

Registration checks the address suffix only. Without OTP or another identity provider, the site cannot confirm that a person owns the mailbox or is actually affiliated with the institute.

## Presenter account and sharing

On the first server start, the primary presenter account is created automatically. Sign in with `navneet.k26@iiits.in` and the requested demo password `demopass`. At the bottom of the dashboard, the primary presenter can open or close member access and add/remove other presenter accounts. Added presenters use `@iiits.in` addresses and receive the password set by the primary presenter; they can use the anomaly demo controls but cannot manage access or presenters.

The presenter email and password can be changed with `SENTINEL_ADMIN_EMAIL` and `SENTINEL_ADMIN_PASSWORD`. The accepted institute domain can be changed with `SENTINEL_INSTITUTE_DOMAIN`; the default is `iiits.in`. Change the demo password before hosting publicly.

## Storage and deployment

Accounts and the sharing switch are stored in `sentinel_auth.sqlite3` beside the server. Back up that file to preserve registrations. For public deployment, use HTTPS, keep the database on persistent private storage, and run this server behind a trusted HTTPS reverse proxy. Do not host the files directly from a static file server.
