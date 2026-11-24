import { Router } from 'express';
import { z } from 'zod';
import { PERMISSIONS as P } from '../constants';
import * as attendanceC from '../controllers/attendance.controller';
import * as authC from '../controllers/auth.controller';
import * as calendarItemC from '../controllers/calendarItem.controller';
import * as balanceC from '../controllers/balance.controller';
import * as compOffC from '../controllers/compoff.controller';
import * as employeeC from '../controllers/employee.controller';
import * as holidayC from '../controllers/holiday.controller';
import * as insightC from '../controllers/insight.controller';
import * as leaveC from '../controllers/leave.controller';
import * as peopleC from '../controllers/people.controller';
import * as policyC from '../controllers/policy.controller';
import * as systemC from '../controllers/system.controller';
import { authenticate, requireAnyPermission, requireEmployeeProfile, requirePermission } from '../middleware/auth';
import { createLimiters } from '../middleware/security';
import { documentUpload, importUpload } from '../middleware/upload';
import { dateOnly, idParams, objectId, validate } from '../middleware/validate';
import * as v from '../validations';

export function buildApiRouter(limits: ReturnType<typeof createLimiters>): Router {
  const api = Router();
  const employeeIdParams = z.object({ employeeId: objectId });

  /* Authentication */
  const auth = Router();
  auth.post('/login', limits.login, validate({ body: v.loginBody }), authC.login);
  auth.post('/refresh', limits.sensitive, authC.refresh);
  auth.post('/logout', authC.logout);
  auth.post('/forgot-password', limits.auth, validate({ body: v.forgotBody }), authC.forgotPassword);
  auth.post('/reset-password', limits.auth, validate({ body: v.resetBody }), authC.resetPassword);
  auth.post('/change-password', limits.auth, authenticate, validate({ body: v.changePasswordBody }), authC.changePassword);
  auth.get('/me', authenticate, authC.me);
  api.use('/auth', auth);

  /* Decisions from an email link, where the token stands in for a session. */
  api.post('/email-actions/preview', limits.auth, validate({ body: v.emailPreviewBody }), peopleC.emailPreview);
  api.post('/email-actions/decide', limits.auth, validate({ body: v.emailDecideBody }), peopleC.emailDecide);

  // Everything below this line requires a valid session.
  api.use(authenticate);

  /* Dashboard */
  api.get('/dashboard', requireEmployeeProfile, balanceC.dashboard);

  /* Employees */
  const employees = Router();
  employees.get('/', requirePermission(P.EMPLOYEES_READ), validate({ query: v.employeeListQuery }), employeeC.list);
  employees.post('/', requirePermission(P.EMPLOYEES_WRITE), validate({ body: v.employeeCreateBody }), employeeC.create);
  employees.post('/import', limits.sensitive, requirePermission(P.EMPLOYEES_WRITE), importUpload, employeeC.importFile);
  employees.patch('/me', limits.sensitive, requireEmployeeProfile, validate({ body: v.employeeProfileBody }), employeeC.updateOwnProfile);
  employees.get('/:id/avatar', validate({ params: idParams }), peopleC.employeeAvatar);
  employees.get('/:id/details', requirePermission(P.EMPLOYEE_PRIVATE_READ), validate({ params: idParams }), peopleC.employeeDetails);
  employees.post('/:id/details/reveal-bank', limits.sensitive, requirePermission(P.EMPLOYEE_PRIVATE_READ), validate({ params: idParams, body: v.emptyBody }), peopleC.revealBank);
  employees.get('/:id/checklists', requirePermission(P.EMPLOYEES_READ), validate({ params: idParams }), peopleC.employeeChecklists);
  employees.post('/:id/checklists', requirePermission(P.EMPLOYEES_WRITE), validate({ params: idParams, body: v.checklistStartBody }), peopleC.startChecklist);
  employees.post('/:id/checklists/:checklistId/items', requirePermission(P.EMPLOYEES_WRITE), validate({ params: idParams.extend({ checklistId: objectId }), body: v.checklistItemBody }), peopleC.addItem);
  employees.patch('/:id/checklists/:checklistId/items/:itemId', requirePermission(P.EMPLOYEES_WRITE), validate({ params: idParams.extend({ checklistId: objectId, itemId: objectId }), body: v.checklistDoneBody }), peopleC.setItem);
  employees.get('/:id', validate({ params: idParams }), employeeC.getOne);
  employees.put('/:id', requirePermission(P.EMPLOYEES_WRITE), validate({ params: idParams, body: v.employeeUpdateBody }), employeeC.update);
  employees.patch('/:id/status', requirePermission(P.EMPLOYEES_WRITE), validate({ params: idParams, body: v.employeeStatusBody }), employeeC.setStatus);
  employees.post('/:id/activation-link', limits.sensitive, requirePermission(P.EMPLOYEES_WRITE), validate({ params: idParams }), employeeC.sendActivation);
  api.use('/employees', employees);

  /* Departments and locations. Names are readable by everyone; editing needs org:manage. */
  api.get('/departments', employeeC.listDepartments);
  api.post('/departments', requirePermission(P.ORG_MANAGE), validate({ body: v.departmentBody }), employeeC.createDepartment);
  api.put('/departments/:id', requirePermission(P.ORG_MANAGE), validate({ params: idParams, body: v.departmentBody.partial() }), employeeC.updateDepartment);
  api.get('/locations', employeeC.listLocations);
  api.post('/locations', requirePermission(P.ORG_MANAGE), validate({ body: v.locationBody }), employeeC.createLocation);
  api.put('/locations/:id', requirePermission(P.ORG_MANAGE), validate({ params: idParams, body: v.locationBody.partial() }), employeeC.updateLocation);

  /* Attendance. Everything under /my acts only on the signed-in employee. */
  const attendance = Router();
  attendance.get('/my', requireEmployeeProfile, validate({ query: v.attendanceMonthQuery }), attendanceC.myMonth);
  attendance.get('/my/today', requireEmployeeProfile, attendanceC.myToday);
  attendance.post('/punch-in', limits.sensitive, requireEmployeeProfile, validate({ body: v.emptyBody }), attendanceC.punchIn);
  attendance.post('/punch-out', limits.sensitive, requireEmployeeProfile, validate({ body: v.emptyBody }), attendanceC.punchOut);
  attendance.post('/corrections', limits.sensitive, requireEmployeeProfile, validate({ body: v.correctionRequestBody }), peopleC.requestCorrection);
  attendance.get('/corrections/my', requireEmployeeProfile, peopleC.myCorrections);
  attendance.get('/corrections/pending', validate({ query: v.approvalViewQuery }), peopleC.pendingCorrections);
  attendance.patch('/corrections/:id/approve', limits.sensitive, validate({ params: idParams, body: v.emptyBody }), peopleC.approveCorrection);
  attendance.patch('/corrections/:id/reject', limits.sensitive, validate({ params: idParams, body: v.reasonBody }), peopleC.rejectCorrection);
  attendance.patch('/corrections/:id/cancel', limits.sensitive, requireEmployeeProfile, validate({ params: idParams, body: v.emptyBody }), peopleC.cancelCorrection);
  attendance.get('/export', requirePermission(P.ATTENDANCE_MANAGE), validate({ query: v.attendanceExportQuery }), peopleC.exportAttendance);
  attendance.get('/team', requireEmployeeProfile, validate({ query: v.teamDailyQuery }), peopleC.teamDaily);
  attendance.get('/team/:employeeId', requireEmployeeProfile, validate({ params: employeeIdParams, query: v.attendanceMonthQuery }), peopleC.teamMonth);
  attendance.get('/', requirePermission(P.ATTENDANCE_MANAGE), validate({ query: v.attendanceDailyQuery }), attendanceC.daily);
  attendance.get('/employees/:employeeId', requirePermission(P.ATTENDANCE_MANAGE), validate({ params: employeeIdParams, query: v.attendanceMonthQuery }), attendanceC.employeeMonth);
  attendance.put('/employees/:employeeId/:date', limits.sensitive, requirePermission(P.ATTENDANCE_MANAGE), validate({ params: employeeIdParams.extend({ date: dateOnly }), body: v.attendanceCorrectionBody }), attendanceC.correct);
  api.use('/attendance', attendance);

  /* Work from home. Whether the caller may decide a specific request is checked in the service. */
  const wfh = Router();
  wfh.post('/', limits.sensitive, requireEmployeeProfile, validate({ body: v.wfhApplyBody }), attendanceC.applyWfh);
  wfh.get('/my', requireEmployeeProfile, validate({ query: v.wfhListQuery }), attendanceC.myWfh);
  wfh.get('/pending', validate({ query: v.approvalViewQuery }), attendanceC.pendingWfh);
  wfh.patch('/:id/approve', limits.sensitive, validate({ params: idParams, body: v.emptyBody }), attendanceC.approveWfh);
  wfh.patch('/:id/reject', limits.sensitive, validate({ params: idParams, body: v.reasonBody }), attendanceC.rejectWfh);
  wfh.patch('/:id/cancel', limits.sensitive, validate({ params: idParams, body: v.emptyBody }), attendanceC.cancelWfh);
  api.use('/wfh', wfh);

  /* Insight and the team calendar */
  api.get('/insights/hr', requirePermission(P.REPORTS_READ), peopleC.insights);
  api.get('/calendar/team', requireEmployeeProfile, validate({ query: v.dateRangeQuery }), peopleC.calendar);

  /* Self-service: acts only on the signed-in employee */
  const me = Router();
  me.get('/details', requireEmployeeProfile, peopleC.myDetails);
  me.put('/details', limits.sensitive, requireEmployeeProfile, validate({ body: v.employeeDetailsBody }), peopleC.saveMyDetails);
  me.get('/documents', requireEmployeeProfile, peopleC.myDocuments);
  me.post('/documents', limits.sensitive, requireEmployeeProfile, documentUpload, peopleC.uploadMyDocument);
  me.delete('/documents/:id', limits.sensitive, requireEmployeeProfile, validate({ params: idParams }), peopleC.deleteMyDocument);
  me.get('/checklists', requireEmployeeProfile, peopleC.myChecklists);
  me.patch('/checklists/:id/items/:itemId', limits.sensitive, requireEmployeeProfile, validate({ params: idParams.extend({ itemId: objectId }), body: v.checklistDoneBody }), peopleC.setMyItem);
  api.use('/me', me);

  /* Payroll preparation */
  api.get('/payroll', requirePermission(P.PAYROLL_READ), validate({ query: v.payrollQuery }), peopleC.payroll);
  api.get('/payroll/export', requirePermission(P.PAYROLL_READ), validate({ query: v.payrollExportQuery }), peopleC.exportPayroll);

  /* Expenses. Whether the caller may decide a specific claim is checked in the service. */
  const expenses = Router();
  expenses.post('/', limits.sensitive, requireEmployeeProfile, validate({ body: v.expenseBody }), peopleC.submitExpense);
  expenses.get('/my', requireEmployeeProfile, validate({ query: v.wfhListQuery }), peopleC.myExpenses);
  expenses.get('/pending', validate({ query: v.approvalViewQuery }), peopleC.pendingExpenses);
  expenses.get('/', requirePermission(P.EXPENSES_MANAGE), validate({ query: v.expenseListQuery }), peopleC.allExpenses);
  expenses.patch('/:id/approve', limits.sensitive, validate({ params: idParams, body: v.emptyBody }), peopleC.approveExpense);
  expenses.patch('/:id/reject', limits.sensitive, validate({ params: idParams, body: v.reasonBody }), peopleC.rejectExpense);
  expenses.patch('/:id/pay', limits.sensitive, requirePermission(P.EXPENSES_MANAGE), validate({ params: idParams, body: v.emptyBody }), peopleC.payExpense);
  expenses.patch('/:id/cancel', limits.sensitive, requireEmployeeProfile, validate({ params: idParams, body: v.emptyBody }), peopleC.cancelExpense);
  api.use('/expenses', expenses);

  /* Announcements and policies */
  const announcements = Router();
  announcements.get('/', peopleC.listAnnouncements);
  announcements.post('/', limits.sensitive, requirePermission(P.ANNOUNCEMENTS_MANAGE), validate({ body: v.announcementBody }), peopleC.publishAnnouncement);
  announcements.post('/:id/acknowledge', limits.sensitive, validate({ params: idParams, body: v.emptyBody }), peopleC.acknowledge);
  announcements.get('/:id/readers', requirePermission(P.ANNOUNCEMENTS_MANAGE), validate({ params: idParams }), peopleC.readers);
  announcements.delete('/:id', limits.sensitive, requirePermission(P.ANNOUNCEMENTS_MANAGE), validate({ params: idParams }), peopleC.deleteAnnouncement);
  api.use('/announcements', announcements);

  /* Leave */
  const leaves = Router();
  leaves.post('/preview', requireEmployeeProfile, validate({ body: v.leaveFieldsBody }), leaveC.preview);
  leaves.post('/', limits.sensitive, requireEmployeeProfile, validate({ body: v.leaveApplyBody }), leaveC.apply);
  leaves.get('/my', requireEmployeeProfile, validate({ query: v.myLeavesQuery }), leaveC.listMine);
  leaves.get('/', requirePermission(P.LEAVE_READ_ALL), validate({ query: v.allLeavesQuery }), leaveC.listAll);
  leaves.get('/:id', validate({ params: idParams }), leaveC.getOne);
  leaves.patch('/:id/cancel', limits.sensitive, validate({ params: idParams, body: v.optionalReasonBody }), leaveC.cancel);
  leaves.post('/:id/cancellation-request', limits.sensitive, requireEmployeeProfile, validate({ params: idParams, body: v.reasonBody }), leaveC.requestCancellation);
  api.use('/leaves', leaves);

  /* Approvals. Whether the caller may act on a specific request is decided in the service. */
  const approvals = Router();
  approvals.get('/pending', validate({ query: v.approvalsQuery }), leaveC.pendingApprovals);
  approvals.patch('/:id/approve', limits.sensitive, validate({ params: idParams, body: v.commentBody }), leaveC.approve);
  approvals.patch('/:id/reject', limits.sensitive, validate({ params: idParams, body: v.reasonBody }), leaveC.reject);
  approvals.patch('/:id/cancellation/approve', limits.sensitive, requirePermission(P.LEAVE_APPROVE), validate({ params: idParams, body: v.commentBody }), leaveC.approveCancellation);
  approvals.patch('/:id/cancellation/reject', limits.sensitive, requirePermission(P.LEAVE_APPROVE), validate({ params: idParams, body: v.reasonBody }), leaveC.rejectCancellation);
  api.use('/approvals', approvals);

  /* Leave balances */
  const balances = Router();
  balances.get('/', requirePermission(P.BALANCES_READ), validate({ query: v.balanceListQuery }), balanceC.overview);
  balances.get('/my', requireEmployeeProfile, validate({ query: v.yearQuery }), balanceC.myBalances);
  balances.get('/my/transactions', requireEmployeeProfile, validate({ query: v.transactionsQuery }), balanceC.myTransactions);
  balances.post('/adjustment', limits.sensitive, requirePermission(P.BALANCES_ADJUST), validate({ body: v.adjustmentBody }), balanceC.adjustment);
  balances.get('/:employeeId', requirePermission(P.BALANCES_READ), validate({ params: employeeIdParams, query: v.yearQuery }), balanceC.employeeBalances);
  balances.get('/:employeeId/transactions', requirePermission(P.BALANCES_READ), validate({ params: employeeIdParams, query: v.transactionsQuery }), balanceC.employeeTransactions);
  api.use('/leave-balances', balances);

  /* Comp-Off */
  const compOff = Router();
  compOff.post('/', limits.sensitive, requireEmployeeProfile, validate({ body: v.compOffApplyBody }), compOffC.apply);
  compOff.get('/my', requireEmployeeProfile, compOffC.mine);
  compOff.get('/', requirePermission(P.COMPOFF_MANAGE), validate({ query: v.compOffListQuery }), compOffC.list);
  compOff.get('/transactions', requirePermission(P.COMPOFF_MANAGE), validate({ query: v.compOffTxQuery }), compOffC.transactions);
  compOff.post('/manual', limits.sensitive, requirePermission(P.COMPOFF_MANAGE), validate({ body: v.compOffAdjustBody }), compOffC.adjust);
  compOff.patch('/credits/:id/expiry', requirePermission(P.COMPOFF_MANAGE), validate({ params: idParams, body: v.compOffExpiryBody }), compOffC.setExpiry);
  compOff.get('/employees/:employeeId', requirePermission(P.COMPOFF_MANAGE), validate({ params: employeeIdParams }), compOffC.employeeSummary);
  compOff.patch('/:id/approve', limits.sensitive, requirePermission(P.COMPOFF_MANAGE), validate({ params: idParams, body: v.compOffApproveBody }), compOffC.approve);
  compOff.patch('/:id/reject', limits.sensitive, requirePermission(P.COMPOFF_MANAGE), validate({ params: idParams, body: v.reasonBody }), compOffC.reject);
  api.use('/compoff', compOff);

  /* Holidays */
  const holidays = Router();
  holidays.get('/', validate({ query: v.holidayListQuery }), holidayC.list);
  holidays.get('/export', requirePermission(P.HOLIDAYS_MANAGE), validate({ query: v.holidayExportQuery }), holidayC.exportList);
  holidays.post('/', requirePermission(P.HOLIDAYS_MANAGE), validate({ body: v.holidayBody }), holidayC.create_);
  holidays.post('/import', limits.sensitive, requirePermission(P.HOLIDAYS_MANAGE), importUpload, holidayC.importFile);
  holidays.post('/copy', requirePermission(P.HOLIDAYS_MANAGE), validate({ body: v.holidayCopyBody }), holidayC.copyYear);
  holidays.put('/:id', requirePermission(P.HOLIDAYS_MANAGE), validate({ params: idParams, body: v.holidayUpdateBody }), holidayC.update);
  holidays.delete('/:id', requirePermission(P.HOLIDAYS_MANAGE), validate({ params: idParams }), holidayC.remove);
  api.use('/holidays', holidays);

  /* Calendar */
  const calendar = Router();
  calendar.get('/company', requirePermission(P.CALENDAR_READ), validate({ query: v.calendarQuery }), insightC.company);
  calendar.get('/employee', validate({ query: v.calendarQuery }), insightC.employee);
  // Everyone's own events and tasks, plus company-wide ones.
  calendar.get('/items', validate({ query: v.dateRangeQuery }), calendarItemC.list);
  calendar.post('/items', limits.sensitive, validate({ body: v.calendarItemBody }), calendarItemC.create);
  calendar.put('/items/:id', limits.sensitive, validate({ params: idParams, body: v.calendarItemBody }), calendarItemC.update);
  calendar.patch('/items/:id/done', limits.sensitive, validate({ params: idParams, body: v.calendarItemDoneBody }), calendarItemC.setDone);
  calendar.delete('/items/:id', limits.sensitive, validate({ params: idParams }), calendarItemC.remove);
  calendar.get('/summary', requirePermission(P.CALENDAR_READ), validate({ query: v.summaryQuery }), insightC.summary);
  calendar.get('/summary/details', requirePermission(P.CALENDAR_READ), validate({ query: v.summaryDetailsQuery }), insightC.summaryDetail);
  calendar.get('/export', requirePermission(P.CALENDAR_READ), validate({ query: v.calendarExportQuery }), insightC.exportCalendar);
  api.use('/calendar', calendar);

  /* Leave types and policies */
  api.get('/leave-types', policyC.listTypes);
  api.get('/leave-types/available', requireEmployeeProfile, leaveC.availableTypes);
  api.post('/leave-types', requirePermission(P.LEAVE_POLICY_MANAGE), validate({ body: v.leaveTypeCreateBody }), policyC.createType);
  api.put('/leave-types/:id', requirePermission(P.LEAVE_POLICY_MANAGE), validate({ params: idParams, body: v.leaveTypeUpdateBody }), policyC.updateType);
  api.get('/leave-policies', requirePermission(P.LEAVE_POLICY_MANAGE), policyC.listPolicies);
  api.post('/leave-policies', requirePermission(P.LEAVE_POLICY_MANAGE), validate({ body: v.policyCreateBody }), policyC.createPolicy);
  api.put('/leave-policies/:id', requirePermission(P.LEAVE_POLICY_MANAGE), validate({ params: idParams, body: v.policyUpdateBody }), policyC.updatePolicy);

  /* Reports */
  const reports = Router();
  reports.use(requirePermission(P.REPORTS_READ));
  reports.get('/export', validate({ query: v.reportExportQuery }), insightC.exportReport);
  reports.get('/:report', validate({ params: v.reportParams, query: v.reportQuery }), insightC.report);
  api.use('/reports', reports);

  /* Audit */
  api.get('/audit-logs', requireAnyPermission(P.AUDIT_READ, P.AUDIT_READ_SYSTEM), validate({ query: v.auditQuery }), insightC.auditLogs);

  /* Notifications */
  api.get('/notifications', validate({ query: v.notificationQuery }), systemC.listNotifications);
  api.get('/notifications/unread-count', systemC.unreadCount);
  api.patch('/notifications/read-all', systemC.markAllRead);
  api.patch('/notifications/:id/read', validate({ params: idParams }), systemC.markRead);

  /* Files */
  api.post('/files', limits.sensitive, documentUpload, systemC.uploadFile);
  api.get('/files/:id', validate({ params: idParams }), systemC.downloadFile);
  api.delete('/files/:id', validate({ params: idParams }), systemC.deleteFile);
  api.get('/me/avatar', systemC.getOwnAvatar);
  api.put('/me/avatar', limits.sensitive, documentUpload, systemC.uploadOwnAvatar);
  api.delete('/me/avatar', limits.sensitive, systemC.deleteOwnAvatar);

  /* Settings, workflows and administrative accounts */
  api.get('/settings/company', systemC.getCompanyInfo);
  api.put('/settings/compoff', requirePermission(P.COMPOFF_MANAGE), validate({ body: v.compOffSettingsBody }), systemC.updateCompOffRules);
  api.get('/settings', requirePermission(P.SETTINGS_MANAGE), systemC.getAllSettings);
  api.put('/settings', requirePermission(P.SETTINGS_MANAGE), validate({ body: v.settingsBody }), systemC.updateSettings);

  api.get('/workflows', requirePermission(P.WORKFLOWS_MANAGE), policyC.listWorkflows);
  api.post('/workflows', requirePermission(P.WORKFLOWS_MANAGE), validate({ body: v.workflowCreateBody }), policyC.createWorkflow);
  api.put('/workflows/:id', requirePermission(P.WORKFLOWS_MANAGE), validate({ params: idParams, body: v.workflowUpdateBody }), policyC.updateWorkflow);

  const admins = Router();
  admins.use(limits.sensitive, requirePermission(P.ADMINS_MANAGE));
  admins.get('/permissions', systemC.permissionCatalog);
  admins.get('/', validate({ query: v.adminListQuery }), systemC.listAdmins);
  admins.post('/', validate({ body: v.adminCreateBody }), systemC.createAdmin);
  admins.patch('/:id', validate({ params: idParams, body: v.adminUpdateBody }), systemC.updateAdmin);
  api.use('/admins', admins);

  return api;
}
