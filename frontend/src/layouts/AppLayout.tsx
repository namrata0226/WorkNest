import { Suspense, useEffect, useState } from 'react';
import { Link, Navigate, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Avatar } from '../components/Avatar';
import { Loading } from '../components/ui';
import { useAuth } from '../context/AuthContext';
import { useFetch } from '../hooks/useFetch';
import type { LeaveRequest, Permission } from '../types';

interface NavItem { to: string; label: string; permission?: Permission; employeeOnly?: boolean; badge?: number }
interface NavGroup { title?: string; items: NavItem[] }

const POLL_MS = 60_000;

export function AppLayout() {
  const { user, logout, can } = useAuth();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const unread = useFetch<{ unread: number }>('/notifications/unread-count');
  const pending = useFetch<LeaveRequest[]>('/approvals/pending', { limit: 1 });
  const pendingWfh = useFetch<unknown[]>('/wfh/pending');
  const pendingCorrections = useFetch<unknown[]>('/attendance/corrections/pending');
  const pendingExpenses = useFetch<unknown[]>('/expenses/pending');
  const reloadUnread = unread.reload;
  const reloadPending = pending.reload;
  const reloadWfh = pendingWfh.reload;
  const reloadCorrections = pendingCorrections.reload;
  const reloadExpenses = pendingExpenses.reload;

  useEffect(() => setOpen(false), [location.pathname]);
  useEffect(() => {
    void reloadUnread();
    void reloadPending();
    void reloadWfh();
    void reloadCorrections();
    void reloadExpenses();
    const timer = setInterval(() => void reloadUnread(), POLL_MS);
    return () => clearInterval(timer);
  }, [location.pathname, reloadUnread, reloadPending, reloadWfh, reloadCorrections, reloadExpenses]);

  if (user?.mustChangePassword && location.pathname !== '/account') return <Navigate to="/account" replace />;

  const pendingCount = (pending.meta?.total ?? 0) + (pendingWfh.data?.length ?? 0) + (pendingCorrections.data?.length ?? 0) + (pendingExpenses.data?.length ?? 0);
  const isApprover = can('leave:approve') || pendingCount > 0;

  const groups: NavGroup[] = [
    {
      title: 'My leave',
      items: [
        { to: '/dashboard', label: 'Dashboard', employeeOnly: true },
        { to: '/apply', label: 'Apply for leave', employeeOnly: true },
        { to: '/leaves', label: 'My requests', employeeOnly: true },
        { to: '/balances', label: 'My balances', employeeOnly: true },
        { to: '/comp-off', label: 'Comp-Off', employeeOnly: true },
        { to: '/calendar', label: 'My calendar', employeeOnly: true },
        { to: '/attendance', label: 'Attendance', employeeOnly: true },
        { to: '/team-calendar', label: 'Team calendar', employeeOnly: true },
        { to: '/expenses', label: 'Expense claims', employeeOnly: true },
        { to: '/announcements', label: 'Announcements' },
        { to: '/holidays', label: 'Holidays', employeeOnly: true },
      ],
    },
    {
      title: 'People',
      items: [
        ...(isApprover ? [{ to: '/approvals', label: 'Approvals', badge: pendingCount }] : []),
        ...(user?.isManager ? [{ to: '/team-attendance', label: 'Team attendance' }] : []),
        { to: '/admin/insights', label: 'HR dashboard', permission: 'reports:read' as Permission },
        { to: '/admin/calendar', label: 'Company calendar', permission: 'calendar:read' as Permission },
        { to: '/admin/attendance', label: 'Attendance', permission: 'attendance:manage' as Permission },
        { to: '/admin/employees', label: 'Employees', permission: 'employees:read' as Permission },
        { to: '/admin/balances', label: 'Leave balances', permission: 'balances:read' as Permission },
        { to: '/admin/comp-off', label: 'Comp-Off requests', permission: 'compoff:manage' as Permission },
        { to: '/admin/expenses', label: 'Expense claims', permission: 'expenses:manage' as Permission },
        { to: '/admin/payroll', label: 'Payroll', permission: 'payroll:read' as Permission },
      ],
    },
    {
      title: 'Configuration',
      items: [
        { to: '/admin/holidays', label: 'Holiday calendar', permission: 'holidays:manage' },
        { to: '/admin/leave-types', label: 'Leave types', permission: 'leave_policy:manage' },
        { to: '/admin/policies', label: 'Leave policies', permission: 'leave_policy:manage' },
        { to: '/admin/org', label: 'Departments & locations', permission: 'org:manage' },
      ],
    },
    {
      title: 'Insight',
      items: [
        { to: '/admin/reports', label: 'Reports', permission: 'reports:read' },
        { to: '/admin/audit', label: 'Audit log', permission: 'audit:read' },
      ],
    },
    {
      title: 'Administration',
      items: [
        { to: '/super/admins', label: 'Admin accounts', permission: 'admins:manage' },
        { to: '/super/workflows', label: 'Approval workflows', permission: 'workflows:manage' },
        { to: '/super/settings', label: 'Company settings', permission: 'settings:manage' },
      ],
    },
  ];

  const visible = groups
    .map((g) => ({ ...g, items: g.items.filter((i) => (!i.permission || can(i.permission)) && (!i.employeeOnly || user?.employee)) }))
    .filter((g) => g.items.length);

  const sidebar = (
    <nav aria-label="Main" className="flex h-full flex-col overflow-y-auto bg-nav px-3 py-4 text-[13px] text-white/80">
      <Link to="/" className="mb-4 flex items-center gap-2 px-2 text-[15px] font-semibold text-white">
        <span aria-hidden className="flex h-6 w-6 items-center justify-center rounded bg-brand text-xs font-bold">L</span>
        WorkNest
      </Link>
      {visible.map((group) => (
        <div key={group.title} className="mb-4">
          <div className="mb-1 px-2 text-[11px] font-medium uppercase tracking-wider text-white/45">{group.title}</div>
          {group.items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => `flex items-center justify-between rounded-md px-2 py-1.5 ${isActive ? 'bg-nav-soft font-medium text-white' : 'hover:bg-nav-soft/60 hover:text-white'}`}
            >
              {item.label}
              {item.badge ? <span className="tnum rounded bg-amber-soft px-1.5 text-[11px] font-semibold text-amber">{item.badge}</span> : null}
            </NavLink>
          ))}
        </div>
      ))}
    </nav>
  );

  const unreadCount = unread.data?.unread ?? 0;

  return (
    <div className="flex h-full">
      <aside className="hidden w-56 shrink-0 md:block">{sidebar}</aside>
      {open && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-60">{sidebar}</aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-3 border-b border-line bg-surface px-4 py-2.5">
          <button type="button" aria-label="Open menu" className="rounded border border-line-strong px-2 py-1 md:hidden" onClick={() => setOpen(true)}>☰</button>
          <div className="min-w-0 flex-1" />
          <div className="flex items-center gap-1.5">
            <Link to="/notifications" aria-label={`Notifications, ${unreadCount} unread`} className="relative rounded-md px-2.5 py-1.5 text-[13px] text-muted hover:bg-paper">
              Notifications
              {unreadCount > 0 && <span className="tnum ml-1.5 rounded bg-rose px-1.5 text-[11px] font-semibold text-white">{unreadCount}</span>}
            </Link>
            <Link to="/account" aria-label="My account" className="flex items-center gap-2 rounded-md px-2 py-1 text-[13px] text-muted hover:bg-paper">
              <Avatar url={user?.avatarUrl} name={user?.employee?.fullName ?? user?.email ?? ''} />
              <span className="hidden sm:inline">{user?.employee?.fullName ?? user?.email}</span>
            </Link>
            <button type="button" className="rounded-md px-2.5 py-1.5 text-[13px] text-muted hover:bg-paper" onClick={() => void logout().then(() => navigate('/login'))}>Sign out</button>
          </div>
        </header>
        <main className="min-w-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
          <div className="mx-auto max-w-6xl">
            <Suspense fallback={<Loading />}>
              <Outlet />
            </Suspense>
          </div>
        </main>
      </div>
    </div>
  );
}

export function AuthLayout({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2 text-[15px] font-semibold">
          <span aria-hidden className="flex h-7 w-7 items-center justify-center rounded bg-brand text-sm font-bold text-white">L</span>
          WorkNest
        </div>
        <div className="rounded-lg border border-line bg-surface p-5">
          <h1 className="text-lg font-semibold">{title}</h1>
          {subtitle && <p className="mt-0.5 text-[13px] text-muted">{subtitle}</p>}
          <div className="mt-4">{children}</div>
        </div>
      </div>
    </div>
  );
}
