# Deployment

`npm run db` is for development only. Production needs a managed or self-hosted MongoDB replica set with authentication and TLS.

## Recommended setup: GitHub, Render and Vercel

The screens are hosted on **Vercel** and the API on **Render**. Vercel forwards every `/api` request to Render, so the browser sees one website and the `SameSite=Strict` sign-in cookies keep working.

The API does not run on Vercel itself. Vercel functions accept at most 4.5 MB per request, below the 5 MB upload limit, and the API runs jobs every minute.

| Piece | Where | Config file |
|---|---|---|
| Screens | Vercel, Root Directory `frontend` | `frontend/vercel.json` |
| API and scheduled jobs | Render web service | `render.yaml` |
| Database | MongoDB Atlas | |
| Files | Cloudinary (required: Render's disk is wiped on every restart) | |

Render's free plan sleeps after 15 minutes without traffic. The first request then takes about a minute, and scheduled jobs (emails, reminders) do not run while it sleeps. Use a paid instance for real use.

`ORIGIN_SECRET` must be the same long random value in Vercel and Render. The API refuses any `/api` request without it, so nobody can reach Render directly and fake their IP address. Set `TRUST_PROXY=2` for the two proxies, Vercel and Render's load balancer, and check that the audit log records real visitor addresses.

## 1. MongoDB

Use MongoDB 7 or later as a replica set. MongoDB Atlas provides this by default, and a three-member set is the minimum for automatic failover.

Create a dedicated application user with only `readWrite` on the application database:

```js
db.getSiblingDB('leave_hub').createUser({
  user: 'leavehub_app',
  pwd: passwordPrompt(),
  roles: [{ role: 'readWrite', db: 'leave_hub' }],
});
```

Restrict network access to the application servers, and require TLS.

## 2. Environment

Copy `backend/.env.example` and set at least:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `MONGODB_URI` | The application user's connection string, with TLS |
| `JWT_ACCESS_SECRET` | A long random value: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`. The server refuses placeholder values. |
| `CORS_ORIGINS` | Your exact app origin |
| `APP_URL` | Your app URL, used in password links |
| `TRUST_PROXY` | The number of proxies in front of the app, usually `1`. Rate limits and audit IPs are wrong without this. |
| `UPLOAD_DIR` | A private, persistent, backed-up volume outside any web root |
| `CLIENT_DIST` | `../frontend/dist` to serve the app from Express |
| `SMTP_*`, `EMAIL_FROM` | For email. Without these, password resets cannot be delivered (see limits below). |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | To store new documents and profile photos in Cloudinary instead of `UPLOAD_DIR`. Files already in `UPLOAD_DIR` stay there and keep working, so keep that folder. |
| `CLAMAV_HOST`, `CLAMAV_REQUIRED` | For malware scanning (see limits below) |

Keep secrets in your platform's secret store. Never commit `.env`.

To send email, also tick **Also send notifications by email** under Company settings. Emails are queued and sent within about a minute, and need `JOBS_ENABLED=true` on at least one instance.

Also set `FIELD_ENCRYPTION_KEY`, which encrypts bank details. Back it up safely: if it is lost, saved account numbers cannot be read, and they must not be re-keyed by changing it.

Before relying on attendance or payroll, set **Attendance start date** under Company settings, so earlier days do not count as absences.

`EMAIL_REDIRECT_TO` sends every email to one address for testing, with a line saying who each was meant for. The server refuses to start in production with it set.

## 3. Build and start

```bash
npm ci
npm run build
npm run indexes --workspace backend   # builds every index; run on each release

# First deployment only. Creates baseline configuration and the first Super Admin, no demo data.
SEED_SUPERADMIN_EMAIL=you@company.com SEED_SUPERADMIN_PASSWORD='temporary-pass-1' npm run seed --workspace backend

npm start --workspace backend
```

`npm run seed` in production never creates demo employees. The first Super Admin must change the temporary password before doing anything else.

**Upgrading:** run the seed command again after a release that adds default leave types, such as Menstrual Leave. It adds what is missing and keeps existing settings. Then record each employee's gender, because Maternity, Paternity and Menstrual Leave are unavailable to anyone without one.

Then, in the app, set the company timezone under Company settings, review the leave types (several are inactive by default), add departments, locations and the year's holidays, and import employees.

## Outlook and Teams Out of office (optional)

When leave is approved, the server adds an **Out of office** event to the employee's Outlook calendar, and removes it if the leave is cancelled. Teams shows Out of office from that event. The event never names the leave type or reason. Half days use 09:00 to 13:00 and 13:00 to 18:00.

This needs a work Microsoft 365 organisation and an administrator. Personal Outlook accounts cannot be used. Each employee's WorkNest email must match their Microsoft sign-in name.

1. In the Microsoft Entra admin center, go to **App registrations > New registration** and name it `WorkNest`.
2. Copy the **Directory (tenant) ID** and **Application (client) ID** into `MS_TENANT_ID` and `MS_CLIENT_ID`.
3. Under **Certificates & secrets**, create a client secret and put its value in `MS_CLIENT_SECRET`. Secrets expire, so note the date and replace it in time.
4. Under **API permissions**, add Microsoft Graph **Application** permission `Calendars.ReadWrite`, then choose **Grant admin consent**.
5. Run `npm run indexes --workspace backend` and restart the server. It needs `JOBS_ENABLED=true`. Calendars are checked every minute, and approved leave that has not ended yet is added too.

`Calendars.ReadWrite` lets the app change **every** calendar in the organisation. To limit it, use [RBAC for Applications in Exchange Online](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac) with a scope covering employees' mailboxes, and remove the organisation-wide consent from step 4. Permission changes can take up to 2 hours to apply. Keep the client secret in your secret store.

## 4. HTTPS

Terminate TLS at a reverse proxy or load balancer and redirect HTTP to HTTPS. Cookies are `Secure` in production, so **sign-in will not work over plain HTTP** except on `localhost`. HSTS is sent by default.

## 5. Scheduled jobs

Jobs run inside the server when `JOBS_ENABLED=true`: daily entitlements, accrual, carry-forward, expiry and reminders, plus an email outbox every minute. With several instances, enable them on one. Duplicates are harmless because of idempotency keys, but they waste work.

## Security checklist

Handled by the application:

- [x] Argon2id password hashing, lockout after failed sign-ins, and rate limiting that counts only failed sign-ins per IP address
- [x] Short-lived access tokens, refresh rotation with reuse detection, server-side revocation
- [x] `HttpOnly`, `Secure`, `SameSite=Strict` cookies, with no tokens in `localStorage`
- [x] Permission checks on the server for every protected route; own-record scoping; `404` for records you may not see
- [x] Strict request schemas (mass assignment), operator rejection (NoSQL injection), body size limits
- [x] Helmet headers, explicit CORS allowlist, CSRF header check
- [x] Upload checks by file content, random stored names, authorised downloads only
- [x] Formula neutralisation in CSV and Excel exports
- [x] No stack traces or database errors in responses; structured logs with secrets redacted

Your responsibility at deployment:

- [ ] HTTPS everywhere, with `TRUST_PROXY` set correctly
- [ ] Least-privilege database user, TLS, and restricted network access
- [ ] Backups, tested by restoring them (below)
- [ ] `npm audit` and dependency updates on a schedule
- [ ] Monitoring on `/health`, logs and 5xx rates

## Backups and recovery

Back up both, because uploaded documents live outside the database:

1. **MongoDB:** continuous or daily backups (Atlas backups, or `mongodump --oplog` on a schedule). Keep at least 30 days.
2. **`UPLOAD_DIR`:** snapshot on the same schedule. Files in Cloudinary need their own backup: turn on backups in Cloudinary, or copy them out on a schedule.

Restore into a staging environment at least quarterly and check that sign-in and a balance reading work. A restore puts balances back as they were at that time, so re-enter any later changes; the audit log helps identify them.

## Data retention

Set these with your HR and legal advisers. Current behaviour:

| Data | Retention |
|---|---|
| Leave requests, ledgers, audit logs | Kept indefinitely, including after an employee is deactivated |
| Sessions | Removed 30 days after expiry (TTL index) |
| Password links | Removed about 24 hours after expiry (TTL index) |
| Notifications | Kept indefinitely |
| Uploaded documents | Kept indefinitely. A file uploaded but never attached to a request is not removed automatically. |

## Known limits

- **Payroll covers active employees and does not calculate pay.** It prepares day counts for your payroll process. People deactivated during a month are left out.
- **Buttons in approval emails work for anyone holding the email,** for 7 days or until used. They confirm on a page first and re-check the approver's current rights, but do not forward these emails. Turn off email to remove them.
- **The app installs on phones only over HTTPS.** It has no offline mode.
- **Rate limits are per process.** They are held in memory, so with several instances each has its own count. Use a shared store such as Redis for `express-rate-limit`, or enforce limits at the proxy.
- **Outlook and Teams have not been tested against a live Microsoft organisation.** The test suite uses a simulated Microsoft service. Apply for and approve a day of leave for one person, then check their calendar and Teams status, before relying on it. Teams can take a few minutes to update.
- **Email and ClamAV have not been tested against live services.** Both are implemented, but the test suite runs without an SMTP server or `clamd`. Send a test email and scan the EICAR test file before relying on them.
- **Without SMTP, password reset cannot reach users.** Admins can issue a one-time link from the employee's page instead.
- **Without ClamAV, uploads are checked by type but not scanned.** Records are marked `NOT_SCANNED`.
- **Forgot-password timing.** The response is identical for known and unknown accounts, but sending the email takes longer, so a careful attacker could measure the difference. Rate limiting reduces this.
- **`npm audit` reports moderate advisories** through `exceljs → archiver → glob → minimatch`. They concern untrusted glob patterns, and this path never receives any. npm's only offered fix downgrades `exceljs`. Review when `exceljs` publishes an update, or replace the library. `uuid` is pinned to a patched version through `overrides` and a direct dependency.
- **Leave type changes apply going forward.** Previous rules are kept in history for audit, and grants already posted are not recalculated. Date-specific rules belong in leave policies, which do honour effective dates.
- **Carry-forward expiry uses the leave type's setting.** A policy-level override of the expiry window is not applied.
- **Cancellation is all or nothing.** Cancelling part of an approved leave means cancelling it and applying again.
- **Holiday changes do not alter approved leave.** They do affect pending requests, which are recalculated when approved.
