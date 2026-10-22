# Secure administrator bootstrap — Animaxia backend

In production, **public registration always creates ordinary users**. Neither
the first registration nor an email listed in `ADMINEMAILS` can obtain admin
privileges through the public HTTP API.

## One-time deployment steps

1. Configure `AUTHSECRET` with a random value of at least 32 characters in
   the backend's secret manager. Never use the old deterministic fallback key.
2. Configure production SMTP (`SMTPURL`) and the correct public `APPURL`.
3. Register the operator account through the normal registration page.
4. Verify ownership of the email through its verification link.
5. On the backend server, set `ADMIN_BOOTSTRAP_EMAIL` to that **verified**
   account's address, then run:
   
   ```bash
   cd mini-services/animaxia-backend
   ADMIN_BOOTSTRAP_EMAIL="operator@example.org" \
      node scripts/bootstrap-admin.mjs operator@example.org
   ```

The CLI requires shell access to the backend and refuses unverified accounts.
It promotes exactly the approved address and revokes its existing refresh
tokens. The account must log in again to get a fresh session.

**Do not** expose the CLI as a public endpoint or commit production keys to Git.
After successful bootstrap, clear `ADMIN_BOOTSTRAP_EMAIL` from the shell/CI
environment. If production SMTP is unavailable, establish verifiable identity
and address ownership out of band; do not bypass the verification guard.

## Security tests

CI executes `tests/admin-bootstrap.test.mjs`: a new account using an address
from `ADMINEMAILS` must receive `role=user` in production and remain
unverified if SMTP is not configured. The resulting access token must not
authorize protected admin routes.

## Deployment considerations

- Apply schema migrations with a backup and rollback plan first.
- Rotate any exposed secrets from the Git history (deleting a tracked file
  does not erase old commits).
- The backend and edge-worker token verification must share an appropriate
  signing key. Review edge configuration separately before switching traffic.
- This operation does not deploy code or automatically create a verified
  account. Verify CI and deployment logs first.
