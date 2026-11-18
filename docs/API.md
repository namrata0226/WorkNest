# API reference

Base path: `/api`. All bodies are JSON unless marked as a file upload.

## Conventions

**Authentication.** Sign in with `POST /auth/login`. Tokens are set as `HttpOnly`, `SameSite=Strict` cookies (`Secure` in production) and are never returned in a response body. Everything except the public auth routes needs a session.

**CSRF header.** Every state-changing request must send `X-Requested-With: WorkNest`, or it gets a `403`.

**Success response**

```json
{ "success": true, "data": {}, "meta": { "page": 1, "limit": 25, "total": 120, "totalPages": 5 } }
```

**Error response**

```json
{
  "success": false,
  "error": { "code": "VALIDATION_ERROR", "message": "Please correct the highlighted fields", "details": [{ "path": "email", "message": "Must be a valid email address" }] },
  "requestId": "b5c14389-9849-4e19-89f1-528d1e715b73"
}
```

| Status | Meaning |
|---|---|
| 400 | Invalid input, unknown field or disallowed key. Payloads are strict, so an extra field such as `role` or `totalDays` is rejected rather than ignored. |
| 401 | Not signed in, or the session expired |
| 403 | Signed in but not permitted |
| 404 | Not found. Also returned for records the caller may not see, so ids cannot be probed. |
| 409 | Conflict: already processed, overlapping dates or a duplicate |
| 413 | Body too large (limit 256 KB) |
| 422 | Well-formed but breaks a business rule, such as insufficient balance |
| 429 | Rate limited |

**Lists** accept `page`, `limit` (up to 200), `sort` and `order` (`asc` or `desc`). Sort fields outside each endpoint's allowlist fall back to its default.

**Dates** are `YYYY-MM-DD`.

**Idempotency.** `POST /leaves`, `POST /leave-balances/adjustment` and `POST /compoff/manual` accept an `Idempotency-Key` header (8 to 100 letters, digits, `-` or `_`). A retry with the same key returns the original result and posts nothing new.

## Endpoints

Access column: **Any** is any signed-in user, **Self** requires an employee profile and acts only on that person's own records, and a code such as `leave:approve` is the permission required.

### Authentication

| Method and path | Access | Notes |
|---|---|---|
| POST `/auth/login` | Public, rate limited | `{ email, password }` |
| POST `/auth/refresh` | Refresh cookie | Rotates the token. Replaying an old one revokes the session. |
| POST `/auth/logout` | Public | Revokes the session on the server |
| POST `/auth/forgot-password` | Public, rate limited | Same answer whether or not the account exists |
| POST `/auth/reset-password` | Public, rate limited | `{ token, password }`. Single use, expires in 1 hour (activation links in 72). |
| POST `/auth/change-password` | Any | `{ currentPassword, newPassword }`. Signs out other devices. |
| GET `/auth/me` | Any | Profile, role and effective permissions |

### Employees and organisation

| Method and path | Access | Notes |
|---|---|---|
| GET `/employees` | `employees:read` | Filters: `search`, `department`, `location`, `status` |
| POST `/employees` | `employees:write` | Returns `activationLink` when email is not configured |
| POST `/employees/import` | `employees:write` | File upload, field `file`, `.csv` or `.xlsx`. Reports errors per row. |
| GET `/employees/:id` | Self or `employees:read` | |
| PUT `/employees/:id` | `employees:write` | `employeeId` and `role` are not accepted. `gender` is `FEMALE`, `MALE`, `OTHER` or `null`. |
| PATCH `/employees/me` | Self | `{ fullName, phone }`. Any other field, including `gender`, `email`, `role` or `employeeId`, gets a `400`. |
| PATCH `/employees/:id/status` | `employees:write` | `{ status }`. `INACTIVE` ends sessions and withdraws pending requests. |
| POST `/employees/:id/activation-link` | `employees:write` | |
| GET `/departments`, `/locations` | Any | Names only |
| POST, PUT `/departments`, `/locations` | `org:manage` | |

### Leave

| Method and path | Access | Notes |
|---|---|---|
| POST `/leaves/preview` | Self | `{ leaveType, startDate, endDate, dayType, halfSession }`. Returns `totalDays`, `excluded`, `issues`. |
| POST `/leaves` | Self | Adds `reason`, `handoverNotes`, `document`. `reason` is required unless the leave is approved automatically. The server calculates the duration. |
| GET `/leaves/my` | Self | Filters: `status`, `leaveType`, `from`, `to` |
| GET `/leaves` | `leave:read_all` | Adds `employee`, `department`, `search` |
| GET `/leaves/:id` | Owner, their manager, or `leave:read_all` | Includes the current balance, plus `outlookEventId` and `outlookSyncError` when calendars are connected |
| PATCH `/leaves/:id/cancel` | Owner while pending; `leave:approve` otherwise | `{ reason? }`. Returns held or used days. |
| POST `/leaves/:id/cancellation-request` | Owner of approved leave | `{ reason }` |
| GET `/leave-types/available` | Self | Every active type with this employee's rules. `ineligibleReason` says why they cannot take it, or is `null` when they can. Applying for an ineligible type returns `422`. |

### Approvals

| Method and path | Access | Notes |
|---|---|---|
| GET `/approvals/pending` | Any | Scoped to what the caller can decide; oldest first |
| PATCH `/approvals/:id/approve` | Current step's approver | `{ comment? }` |
| PATCH `/approvals/:id/reject` | Current step's approver | `{ reason }`, required |
| PATCH `/approvals/:id/cancellation/approve` | `leave:approve` | `{ comment? }` |
| PATCH `/approvals/:id/cancellation/reject` | `leave:approve` | `{ reason }`, required |

Approvers: `leave:approve` holders may act on any step except a Super Admin step. A reporting manager may act on a manager step for their own reports. Nobody may decide their own request.

### Attendance and work from home

| Method and path | Access | Notes |
|---|---|---|
| POST `/attendance/punch-in`, `/attendance/punch-out` | Self | Empty body. The server records the time. `409` for a second punch. |
| GET `/attendance/my`, `/attendance/my/today` | Self | `month` (`YYYY-MM`). Each day has a `status`: `PRESENT`, `WFH`, `ON_LEAVE`, `HALF_LEAVE`, `HOLIDAY`, `WEEKEND`, `ABSENT`, `UPCOMING` or `NOT_EMPLOYED`. |
| GET `/attendance` | `attendance:manage` | One day for everyone. `date`, `department`, `search`. |
| GET `/attendance/employees/:employeeId` | `attendance:manage` | `month` |
| PUT `/attendance/employees/:employeeId/:date` | `attendance:manage` | `{ punchIn, punchOut?, note }`, times as `HH:mm`. Not your own record. Audited. |
| POST `/wfh` | Self | `{ startDate, endDate, reason }`. The server counts working days. |
| GET `/wfh/my` | Self | |
| GET `/wfh/pending` | Any | Scoped to what the caller can decide |
| PATCH `/wfh/:id/approve` | `leave:approve` or the reporting manager | Not your own request |
| PATCH `/wfh/:id/reject` | `leave:approve` or the reporting manager | `{ reason }`, required |
| PATCH `/wfh/:id/cancel` | Owner or `leave:approve` | Not once approved dates have passed |

### People

| Method and path | Access | Notes |
|---|---|---|
| POST `/attendance/corrections` | Self | `{ date, punchIn, punchOut?, reason }` |
| GET `/attendance/corrections/my`, PATCH `/attendance/corrections/:id/cancel` | Self | |
| GET `/attendance/corrections/pending` | Any | Scoped to what the caller can decide |
| PATCH `/attendance/corrections/:id/approve`, `/reject` | `attendance:manage` or the reporting manager | Not your own |
| GET `/attendance/export` | `attendance:manage` | `month`, `format`. A column per day: P, WFH, L, HL, H, W, A. |
| GET `/attendance/team`, `/attendance/team/:employeeId` | Reporting manager | Direct reports only, read only |
| GET `/calendar/team` | Self | `start`, `end`. Who is away, with no leave type or reason. |
| GET `/insights/hr` | `reports:read` | Today, leave trends, frequent absences |
| POST `/email-actions/preview`, `/email-actions/decide` | Token, rate limited | `{ token }`, and `decision`, `reason?` to decide. Single use, 7 days, re-checks the approver's rights. |
| GET `/employees/:id/avatar` | Any | A colleague's profile photo |
| GET, PUT `/me/details` | Self | Bank, emergency contacts, address. Only the last 4 account digits are returned. |
| GET `/employees/:id/details`, POST `.../details/reveal-bank` | `employee_private:read` | Audited |
| GET, POST `/me/documents`, DELETE `/me/documents/:id` | Self | Personal documents |
| GET, POST `/employees/:id/checklists`, items under it | `employees:read`, `employees:write` | `kind`: `ONBOARDING` or `EXIT` |
| GET `/me/checklists`, PATCH `/me/checklists/:id/items/:itemId` | Self | Only items owned by the employee |
| GET `/payroll`, `/payroll/export` | `payroll:read` | `month`, `department`, `format` |
| POST `/expenses`, GET `/expenses/my`, PATCH `/expenses/:id/cancel` | Self | `{ category, expenseDate, amount, description, receipt? }` |
| GET `/expenses/pending` | Any | Scoped to what the caller can decide |
| PATCH `/expenses/:id/approve`, `/reject` | `expenses:manage` or the reporting manager | Not your own |
| GET `/expenses`, PATCH `/expenses/:id/pay` | `expenses:manage` | |
| GET `/announcements`, POST `/announcements/:id/acknowledge` | Any | |
| POST `/announcements`, GET `.../readers`, DELETE `/announcements/:id` | `announcements:manage` | |

### Leave balances

| Method and path | Access | Notes |
|---|---|---|
| GET `/leave-balances/my`, `/my/transactions` | Self | `year` |
| GET `/leave-balances` | `balances:read` | Overview. Filters: `year`, `department`, `search` |
| GET `/leave-balances/:employeeId`, `/:employeeId/transactions` | `balances:read` | |
| POST `/leave-balances/adjustment` | `balances:adjust` | `{ employee, leaveType, year, amount, kind, reason }`. `kind`: `CREDIT`, `DEDUCTION`, `ADJUSTMENT`, `OPENING`. Steps of 0.25. |
| GET `/dashboard` | Self | Everything the employee dashboard shows |

### Comp-Off

| Method and path | Access | Notes |
|---|---|---|
| POST `/compoff` | Self | `{ workedDate, dayType, reason, document? }` |
| GET `/compoff/my` | Self | Summary, claims and transactions |
| GET `/compoff` | `compoff:manage` | Filters: `status`, `employee`, `search` |
| GET `/compoff/transactions` | `compoff:manage` | `employee` |
| GET `/compoff/employees/:employeeId` | `compoff:manage` | |
| POST `/compoff/manual` | `compoff:manage` | `{ employee, amount, reason, earnedDate?, expiresOn? }`. A negative amount deducts. |
| PATCH `/compoff/credits/:id/expiry` | `compoff:manage` | `{ expiresOn }` |
| PATCH `/compoff/:id/approve` | `compoff:manage` | `{ expiresOn?, comment? }` |
| PATCH `/compoff/:id/reject` | `compoff:manage` | `{ reason }`, required |
| PUT `/settings/compoff` | `compoff:manage` | Earning and validity rules |

### Holidays

| Method and path | Access | Notes |
|---|---|---|
| GET `/holidays` | Any | `year`, `category`. Shows the holidays applying to the caller. `scope=all` needs `holidays:manage`. |
| GET `/holidays/export` | `holidays:manage` | `year`, `format` |
| POST `/holidays`, PUT and DELETE `/holidays/:id` | `holidays:manage` | |
| POST `/holidays/import` | `holidays:manage` | File upload. Columns: Name, Date, Category, Description, Location, Department, Employee Group, Half Day, Recurring |
| POST `/holidays/copy` | `holidays:manage` | `{ fromYear, toYear }` |

### Calendar

| Method and path | Access | Notes |
|---|---|---|
| GET `/calendar/company` | `calendar:read` | `start`, `end`, `department`, `leaveType`, `status`, `search`. Returns `events` and `holidays`. |
| GET `/calendar/employee` | Self, or `calendar:read` with `employeeId` | `start`, `end` |
| GET `/calendar/summary` | `calendar:read` | `month`. Summary cards plus a paginated employee table. |
| GET `/calendar/export` | `calendar:read` | `month`, `format` (`xlsx` or `csv`) |

An event covers one run of charged days, so a Friday-to-Monday leave returns two events and never spans the weekend.

### Leave types, policies, workflows

| Method and path | Access |
|---|---|
| GET `/leave-types` | Any (active types only without the permission below) |
| POST `/leave-types`, PUT `/leave-types/:id` | `leave_policy:manage`. Includes `applicableGenders` (empty means everyone) and `maxRequestsPerMonth` (`null` means no limit). A breach returns `422` with code `MONTHLY_LIMIT_REACHED`. |
| GET, POST `/leave-policies`, PUT `/leave-policies/:id` | `leave_policy:manage` |
| GET, POST `/workflows`, PUT `/workflows/:id` | `workflows:manage` |

### Reports

| Method and path | Access | Notes |
|---|---|---|
| GET `/reports/:report` | `reports:read` | `monthly`, `annual`, `employee`, `department`, `balances`, `compoff`, `compoff-expiry`, `pending`, `holidays`, `cancellations` |
| GET `/reports/export` | `reports:read` | `report`, `format`, and the same filters |

Filters: `from`, `to`, `month`, `year`, `employee`, `department`, `leaveType`.

### Notifications, files, audit

| Method and path | Access | Notes |
|---|---|---|
| GET `/notifications`, `/notifications/unread-count` | Any | Own only |
| PATCH `/notifications/:id/read`, `/notifications/read-all` | Any | Own only |
| POST `/files` | Any | Upload, field `file`. PDF, PNG or JPEG, verified by content. Returns an `id` to pass as `document`. |
| GET `/files/:id` | Owner, approvers of the linked request | Downloads as an attachment |
| DELETE `/files/:id` | Owner | Removes an upload that is not attached to anything. `409` once it is attached to a submitted request. |
| GET, PUT, DELETE `/me/avatar` | Any | Your own profile photo only. PUT is a file upload, field `file`, PNG or JPEG up to 2 MB, and replaces any existing photo. PUT and DELETE return the updated profile. |
| GET `/audit-logs` | `audit:read` (HR events) or `audit:read_system` (everything) | Filters: `search`, `action`, `category`, `entityType`, `from`, `to` |

### Super Admin

| Method and path | Access | Notes |
|---|---|---|
| GET `/admins`, `/admins/permissions` | `admins:manage` | |
| POST `/admins` | `admins:manage` | `{ email \| employee, role, permissions? }` |
| PATCH `/admins/:id` | `admins:manage` | `{ role?, permissions?, isActive? }`. Not your own account. |
| GET, PUT `/settings` | `settings:manage` | Company, security and notification settings |
| GET `/settings/company` | Any | Name, timezone and Comp-Off rules |

## Roles

| Role | Permissions |
|---|---|
| Employee | None. Own records only. |
| HR/Admin | All, including `attendance:manage`, except `audit:read_system`, `admins:manage`, `settings:manage`, `workflows:manage`. A Super Admin can narrow this per account. |
| Super Admin | Everything |

Permissions are read from MongoDB on every request, so a change or deactivation applies immediately.
