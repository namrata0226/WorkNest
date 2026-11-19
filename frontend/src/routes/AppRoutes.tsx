import { lazy, ReactNode, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Loading, Note } from '../components/ui';
import { useAuth } from '../context/AuthContext';
import { AppLayout } from '../layouts/AppLayout';
import type { Permission } from '../types';

// Every page is loaded on demand so the first visit (the login screen) downloads only
// what it needs, and heavy pages — the FullCalendar views especially — stay out of the
// initial bundle until someone opens them.
const AnnouncementsPage = lazy(() => import('../pages/AnnouncementsPage').then((m) => ({ default: m.AnnouncementsPage })));
const AttendancePage = lazy(() => import('../pages/AttendancePage').then((m) => ({ default: m.AttendancePage })));
const EmailActionPage = lazy(() => import('../pages/EmailActionPage').then((m) => ({ default: m.EmailActionPage })));
const ExpensesPage = lazy(() => import('../pages/ExpensesPage').then((m) => ({ default: m.ExpensesPage })));
const TeamCalendarPage = lazy(() => import('../pages/TeamCalendarPage').then((m) => ({ default: m.TeamCalendarPage })));
const AccountPage = lazy(() => import('../pages/AuthPages').then((m) => ({ default: m.AccountPage })));
const ForgotPasswordPage = lazy(() => import('../pages/AuthPages').then((m) => ({ default: m.ForgotPasswordPage })));
const LoginPage = lazy(() => import('../pages/AuthPages').then((m) => ({ default: m.LoginPage })));
const ResetPasswordPage = lazy(() => import('../pages/AuthPages').then((m) => ({ default: m.ResetPasswordPage })));
const ApplyLeavePage = lazy(() => import('../pages/ApplyLeavePage').then((m) => ({ default: m.ApplyLeavePage })));
const ApprovalsPage = lazy(() => import('../pages/ApprovalsPage').then((m) => ({ default: m.ApprovalsPage })));
const BalancesPage = lazy(() => import('../pages/BalancesPage').then((m) => ({ default: m.BalancesPage })));
const CompOffPage = lazy(() => import('../pages/CompOffPage').then((m) => ({ default: m.CompOffPage })));
const DashboardPage = lazy(() => import('../pages/DashboardPage').then((m) => ({ default: m.DashboardPage })));
const HolidaysPage = lazy(() => import('../pages/HolidaysPage').then((m) => ({ default: m.HolidaysPage })));
const MyLeavesPage = lazy(() => import('../pages/MyLeavesPage').then((m) => ({ default: m.MyLeavesPage })));
const LeaveDetailPage = lazy(() => import('../pages/MyLeavesPage').then((m) => ({ default: m.LeaveDetailPage })));
const MyCalendarPage = lazy(() => import('../pages/MyCalendarPage').then((m) => ({ default: m.MyCalendarPage })));
const NotificationsPage = lazy(() => import('../pages/NotificationsPage').then((m) => ({ default: m.NotificationsPage })));

const ExpensesAdminPage = lazy(() => import('../pages/admin/ExpensesAdminPage').then((m) => ({ default: m.ExpensesAdminPage })));
const InsightsPage = lazy(() => import('../pages/admin/InsightsPage').then((m) => ({ default: m.InsightsPage })));
const PayrollPage = lazy(() => import('../pages/admin/PayrollPage').then((m) => ({ default: m.PayrollPage })));
const AttendanceAdminPage = lazy(() => import('../pages/admin/AttendanceAdminPage').then((m) => ({ default: m.AttendanceAdminPage })));
const TeamAttendancePage = lazy(() => import('../pages/admin/AttendanceAdminPage').then((m) => ({ default: m.TeamAttendancePage })));
const AuditPage = lazy(() => import('../pages/admin/AuditPage').then((m) => ({ default: m.AuditPage })));
const BalancesAdminPage = lazy(() => import('../pages/admin/BalancesAdminPage').then((m) => ({ default: m.BalancesAdminPage })));
const CompanyCalendarPage = lazy(() => import('../pages/admin/CompanyCalendarPage').then((m) => ({ default: m.CompanyCalendarPage })));
const CompOffAdminPage = lazy(() => import('../pages/admin/CompOffAdminPage').then((m) => ({ default: m.CompOffAdminPage })));
const EmployeeDetailPage = lazy(() => import('../pages/admin/EmployeeDetailPage').then((m) => ({ default: m.EmployeeDetailPage })));
const EmployeesPage = lazy(() => import('../pages/admin/EmployeesPage').then((m) => ({ default: m.EmployeesPage })));
const HolidaysAdminPage = lazy(() => import('../pages/admin/HolidaysAdminPage').then((m) => ({ default: m.HolidaysAdminPage })));
const LeaveTypesPage = lazy(() => import('../pages/admin/LeaveTypesPage').then((m) => ({ default: m.LeaveTypesPage })));
const OrgPage = lazy(() => import('../pages/admin/OrgPage').then((m) => ({ default: m.OrgPage })));
const PoliciesPage = lazy(() => import('../pages/admin/PoliciesPage').then((m) => ({ default: m.PoliciesPage })));
const ReportsPage = lazy(() => import('../pages/admin/ReportsPage').then((m) => ({ default: m.ReportsPage })));
const AdminsPage = lazy(() => import('../pages/super/AdminsPage').then((m) => ({ default: m.AdminsPage })));
const SettingsPage = lazy(() => import('../pages/super/SettingsPage').then((m) => ({ default: m.SettingsPage })));
const WorkflowsPage = lazy(() => import('../pages/super/WorkflowsPage').then((m) => ({ default: m.WorkflowsPage })));

/** A convenience for navigation only. Every one of these actions is enforced again by the API. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, ready } = useAuth();
  const location = useLocation();
  if (!ready) return <Loading />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <>{children}</>;
}

export function RequirePermission({ permission, children }: { permission: Permission; children: ReactNode }) {
  const { can } = useAuth();
  if (!can(permission)) return <Note>You do not have access to this page.</Note>;
  return <>{children}</>;
}

function RequireEmployee({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  if (!user?.employee) return <Note tone="amber">This account has no employee profile, so it has no personal leave.</Note>;
  return <>{children}</>;
}

function Home() {
  const { user, can } = useAuth();
  if (user?.employee) return <Navigate to="/dashboard" replace />;
  return <Navigate to={can('calendar:read') ? '/admin/calendar' : '/account'} replace />;
}

export function AppRoutes() {
  const emp = (el: ReactNode) => <RequireEmployee>{el}</RequireEmployee>;
  const perm = (permission: Permission, el: ReactNode) => <RequirePermission permission={permission}>{el}</RequirePermission>;
  return (
    <Suspense fallback={<Loading />}>
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/email-action" element={<EmailActionPage />} />
      <Route element={<RequireAuth><AppLayout /></RequireAuth>}>
        <Route index element={<Home />} />
        <Route path="dashboard" element={emp(<DashboardPage />)} />
        <Route path="apply" element={emp(<ApplyLeavePage />)} />
        <Route path="leaves" element={emp(<MyLeavesPage />)} />
        <Route path="leaves/:id" element={<LeaveDetailPage />} />
        <Route path="balances" element={emp(<BalancesPage />)} />
        <Route path="comp-off" element={emp(<CompOffPage />)} />
        <Route path="calendar" element={emp(<MyCalendarPage />)} />
        <Route path="attendance" element={emp(<AttendancePage />)} />
        <Route path="team-calendar" element={emp(<TeamCalendarPage />)} />
        <Route path="team-attendance" element={emp(<TeamAttendancePage />)} />
        <Route path="expenses" element={emp(<ExpensesPage />)} />
        <Route path="announcements" element={<AnnouncementsPage />} />
        <Route path="holidays" element={<HolidaysPage />} />
        <Route path="notifications" element={<NotificationsPage />} />
        <Route path="account" element={<AccountPage />} />
        <Route path="approvals" element={<ApprovalsPage />} />

        <Route path="admin/calendar" element={perm('calendar:read', <CompanyCalendarPage />)} />
        <Route path="admin/insights" element={perm('reports:read', <InsightsPage />)} />
        <Route path="admin/expenses" element={perm('expenses:manage', <ExpensesAdminPage />)} />
        <Route path="admin/payroll" element={perm('payroll:read', <PayrollPage />)} />
        <Route path="admin/attendance" element={perm('attendance:manage', <AttendanceAdminPage />)} />
        <Route path="admin/employees" element={perm('employees:read', <EmployeesPage />)} />
        <Route path="admin/employees/:id" element={perm('employees:read', <EmployeeDetailPage />)} />
        <Route path="admin/balances" element={perm('balances:read', <BalancesAdminPage />)} />
        <Route path="admin/comp-off" element={perm('compoff:manage', <CompOffAdminPage />)} />
        <Route path="admin/holidays" element={perm('holidays:manage', <HolidaysAdminPage />)} />
        <Route path="admin/leave-types" element={perm('leave_policy:manage', <LeaveTypesPage />)} />
        <Route path="admin/policies" element={perm('leave_policy:manage', <PoliciesPage />)} />
        <Route path="admin/org" element={perm('org:manage', <OrgPage />)} />
        <Route path="admin/reports" element={perm('reports:read', <ReportsPage />)} />
        <Route path="admin/audit" element={perm('audit:read', <AuditPage />)} />

        <Route path="super/admins" element={perm('admins:manage', <AdminsPage />)} />
        <Route path="super/workflows" element={perm('workflows:manage', <WorkflowsPage />)} />
        <Route path="super/settings" element={perm('settings:manage', <SettingsPage />)} />
        <Route path="*" element={<Note tone="amber">This page does not exist.</Note>} />
      </Route>
    </Routes>
    </Suspense>
  );
}
