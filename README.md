# WorkNest

HR and leave management: leave applications, approvals, ledger-based balances, Comp-Off, a full-year holiday calendar and a company-wide leave calendar.

- **Frontend:** React, TypeScript, React Router, Tailwind CSS, Axios, React Hook Form, Zod, FullCalendar
- **Backend:** Node.js, Express 5, TypeScript, Zod, JWT
- **Database:** MongoDB 7 with Mongoose. A replica set is required because approvals and balance changes use transactions.

| Document | Contents |
|---|---|
| [docs/API.md](docs/API.md) | Every endpoint, with its access rule and error format |
| [docs/DATABASE.md](docs/DATABASE.md) | Collections, indexes and how balances stay correct |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Production setup, security checklist, backups, known limits |

## Run it locally

Needs Node.js 22 or later. No MongoDB or Docker install is required: `npm run db` downloads and runs a local replica set.

The code is in two folders: `backend/` (API and database scripts) and `frontend/` (React app).

From the project folder, install everything once. This covers both folders:

```bash
npm install
cp backend/.env.example backend/.env   # the defaults work for local development
```

Then open three terminals:

```bash
# Terminal 1: MongoDB replica set on port 27017, data kept in backend/.data
cd backend
npm run db

# Terminal 2: API on http://localhost:4000
cd backend
npm run dev

# Terminal 3: App on http://localhost:5173
cd frontend
npm run dev
```

Load the demo company once, with the database running:

```bash
cd backend
SEED_PASSWORD='choose-a-password-1' npm run seed
```

The same commands also work from the project folder: `npm run db`, `npm run dev:backend`, `npm run dev:frontend` and `npm run seed`.

Without `SEED_PASSWORD`, a random password is generated and printed.

| Role | Sign in as |
|---|---|
| Super Admin | `amudha.kaliamoorthi@leavehub.test` |
| HR/Admin and manager | `dinjit.dinesh@leavehub.test` |
| Employee | `namrata.kurariya@leavehub.test` |

If you have Docker, `docker compose up -d` can replace `npm run db`.

## Tests

```bash
npm test            # everything
npm run typecheck
```

Server tests run against a real MongoDB replica set, started automatically, because transactions, write conflicts and rollbacks are what they need to prove. They cover concurrent approvals, mid-transaction failures, access control, leave calculation, Comp-Off, calendar and report accuracy, uploads and rate limiting.

## How the important rules work

**Leave days are always calculated by the server.** The API rejects a client-supplied day count outright. The form shows a preview from the same code that enforces the rules, so what the employee sees is what is charged. Dates are stored as `YYYY-MM-DD` strings, so timezones cannot shift them.

**Saturday and Sunday are never charged.** This is fixed in the calculation, not configurable. Holidays are excluded only if they apply to that employee's location, department and category. Optional holidays stay working days unless taken as Optional Holiday leave.

**Balances come from a ledger.** Every change is an append-only row with a signed amount. The balance record is a projection, and `available` always equals the sum of the ledger.

**Pending is not used.** A pending request holds days in `reserved`, kept apart from `used`, so several pending requests cannot overspend together. Only approval deducts. Reject or cancel returns them. Super Admins can turn holds off.

**Approvals cannot double-deduct.** The status change and ledger rows share one transaction, a status guard stops a second decision, and unique idempotency keys on the ledger block a repeat posting. Six simultaneous approvals produce one success, five `409` responses and one deduction.

**Nobody decides their own request.** The server refuses it, whatever their role.

**Some leave depends on gender.** HR records gender on the employee's profile. Employees see theirs under My account and can update their own name and phone there, but not their gender, because it decides what leave they can take. Maternity and Menstrual Leave are for female employees and Paternity Leave for male employees. Someone with no gender recorded cannot take any of them. Super Admins and HR can change these rules under Leave types.

**Menstrual Leave is approved automatically.** It is one day, once per calendar month, and is deducted at once with no approver, so no reason is needed. Cancelling it frees that month again.

**Attendance is worked out, not stored.** A person's day comes from their punches, approved leave, approved work from home and holidays, so cancelling any of these corrects the day by itself. Punches use the server's clock in the company timezone, one record a day. Punching is done in the app for now, so it does not prove where someone is.

**Approved leave can show as Out of office in Outlook and Teams.** This is off until a Microsoft 365 administrator connects it (see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)). A Microsoft outage never affects approving or cancelling leave, and the calendar catches up afterwards.

## Project layout

```
frontend/src/   api, components, context, hooks, layouts, pages, routes, services, types, utils, validations
backend/src/   config, constants, controllers, jobs, middleware, models, routes, services, utils, validations
backend/scripts/   dev-db (local replica set), seed, sync-indexes
```
