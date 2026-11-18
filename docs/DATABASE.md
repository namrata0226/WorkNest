# Database design

MongoDB 7, through Mongoose. The server refuses to start unless connected to a replica set, because the guarantees below depend on transactions.

## Collections

| Collection | Purpose | Key indexes |
|---|---|---|
| `users` | Login, role, permissions, lockout | `email` unique; `employee` unique (partial); `role + isActive` |
| `employees` | Directory record | `employeeId` unique; `email` unique; `department + employmentStatus`; `location + employmentStatus`; `reportingManager`; `fullName` |
| `departments`, `locations` | Reference data | `name` unique |
| `leaveTypes` | Default rules, with change history | `name` unique; `code` unique; `kind + isActive` |
| `leavePolicies` | Overrides by department, location, designation and category | `name` unique; `isActive + effectiveFrom` |
| `employeeLeavePolicies` | Assignment history with effective dates | `employee + effectiveFrom` |
| `leaveRequests` | Applications | `employee + startDate + endDate`; `status + startDate + endDate`; `startDate + endDate`; `employee + createdAt`; `status + currentApproverType + createdAt`; `dayBreakdown.date + status`; `employee + idempotencyKey` unique (partial) |
| `leaveTransactions` | Append-only ledger | `employee + leaveType + year + createdAt`; `leaveRequest`; `idempotencyKey` unique (partial) |
| `leaveBalances` | Projection of the ledger | `employee + leaveType + year` unique; `year + leaveType` |
| `compOffRequests` | Credit claims | `status + createdAt`; `employee + createdAt`; `employee + workedDate` unique for pending or approved |
| `compOffTransactions` | Ledger, where `CREDIT` rows are also lots | `employee + type + expiresOn`; `type + expiresOn + remaining`; `employee + createdAt`; `idempotencyKey` unique (partial) |
| `holidays` | Calendar | `date + name` unique; `date + locations`; `year + date`; `recurring + date` |
| `approvalWorkflows` | Approval steps | `name` unique; one default (partial unique) |
| `notifications` | In-app feed and email outbox | `recipient + createdAt`; `recipient + readAt`; `emailStatus + createdAt`; `dedupeKey` unique (partial) |
| `refreshTokens` | Sessions, with rotated token hashes | `currentTokenHash` unique; `user + revokedAt`; `usedTokenHashes`; `expiresAt` TTL |
| `passwordResetTokens` | Single-use link hashes | `tokenHash` unique; `expiresAt` TTL |
| `auditLogs` | Who did what | `createdAt`; `category + createdAt`; `entityType + entityId + createdAt`; `actor + createdAt`; `action + createdAt` |
| `companySettings` | Single global document | `key` unique |
| `attendanceRecords` | One punch record per person per day | `employee + date` unique; `date` |
| `attendanceCorrections` | Employees' correction requests | One open per `employee + date`; `status + createdAt` |
| `emailActionTokens` | Hashes behind email Approve and Reject buttons | `tokenHash` unique; `expiresAt` TTL |
| `employeeDetails` | Bank (account number encrypted), contacts, address | `employee` unique |
| `checklists` | Onboarding and exit | `employee + kind` unique |
| `expenseClaims` | Expense claims | `employee + createdAt`; `status + createdAt` |
| `announcements`, `announcementAcks` | Announcements and who confirmed them | `announcement + user` unique |
| `wfhRequests` | Work from home requests | `employee + startDate + endDate`; `status + createdAt` |
| `storedFiles` | Upload metadata, where each file is stored, and whether it is a document or profile photo | `storedName` unique; `owner` |

`autoIndex` is off in production. Run `npm run indexes --workspace backend` on each release.

## Leave balances

One ledger row per movement, whose signed `amount` is its effect on what the employee can use:

| Ledger type | Amount | Field it moves |
|---|---|---|
| `OPENING`, `ENTITLEMENT`, `ACCRUAL`, `CREDIT`, `CARRY_FORWARD`, `ADJUSTMENT` | Usually + | The matching field |
| `RESERVE` / `RELEASE` | − / + | `reserved` |
| `DEBIT` / `RESTORE` | − / + | `used` |
| `EXPIRY` | − | `expired` |

So:

```
available = openingBalance + entitlement + credited + carryForward + adjustments
            − used − reserved − expired
          = sum of ledger amounts
```

`postLedger` in `backend/src/services/balance.ts` is the only code that changes a balance. `reconcileBalance` proves the projection against the ledger, and the tests call it after concurrent operations.

Balances are per calendar year. A leave crossing 31 December is charged against each year separately. Annual entitlement is granted once per year, prorated for mid-year joiners where configured. Monthly accrual is granted once per elapsed month.

## Comp-Off

Each `CREDIT` row is a lot holding `remaining`, `reserved`, `used`, `expired` and `adjustedOut`. Leave draws on the earliest-expiring lots that are valid on each leave date, and the request records which lots it used, so every debit traces to its credit and expiry. Comp-Off is not stored in `leaveBalances`; the balance screens add it as its own row.

Expired days stay unavailable even before the nightly job sweeps them. Days held by a pending leave are not swept.

## Transactions and concurrency

These operations run in one transaction, together with their notification and audit rows: applying (when holding balance), approving, rejecting, cancelling, Comp-Off credit and use, and manual adjustments.

| Risk | Protection |
|---|---|
| Two approvers at once | Update guarded on `status` and `currentStep`. A write conflict retries the transaction, which then sees the new status and returns `409`. |
| Retried approval | Unique `idempotencyKey` on ledger rows such as `leave:<id>:debit:<year>` |
| Overlapping submissions | The transaction writes a counter on the employee first, so one employee's submissions serialise and the overlap check sees committed data |
| Overspending | `$inc` guarded by the available balance |
| Retried submission | Unique `employee + idempotencyKey` on the request |
| Duplicate entitlement | Unique grant key per employee, type and year or month |
| Duplicate Comp-Off claim | Unique index on employee and worked date for live claims |

## Dates

Leave, holiday, joining and expiry dates are `YYYY-MM-DD` strings. They sort correctly as text, and no timezone conversion can move them. "Today" is computed in the company timezone from settings. Timestamps such as `createdAt` are real instants.
