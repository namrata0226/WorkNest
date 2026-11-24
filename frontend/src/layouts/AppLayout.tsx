import { Suspense, useEffect, useState } from 'react';
import { Link, Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Avatar } from '../components/Avatar';
import { Icon, IconName, Logo } from '../components/icons';
import { Loading, useConfirm, useSingleFlight } from '../components/ui';
import { ROLE_LABEL } from '../utils/labels';
import { useAuth } from '../context/AuthContext';
import { useCalendarReminders } from '../hooks/useCalendarReminders';
import { useFetch } from '../hooks/useFetch';
import type { LeaveRequest } from '../types';
import { NavSection, sectionFor, tabMatches, visibleNav } from './navigation';


/** Pages that belong together share one menu entry, with a tab for each. */
function SectionTabs({ section, pathname }: { section: NavSection; pathname: string }) {
  return (
    <nav aria-label={section.label} className="-mt-1 mb-6 flex gap-1 overflow-x-auto border-b border-line">
      {section.tabs.map((tab) => {
        const active = tabMatches(tab, pathname);
        return (
          <Link
            key={tab.to}
            to={tab.to}
            aria-current={active ? 'page' : undefined}
            className={`-mb-px shrink-0 whitespace-nowrap border-b-2 px-3.5 py-2.5 text-[13px] font-medium transition-colors ${active ? 'border-brand text-brand' : 'border-transparent text-muted hover:border-line-strong hover:text-ink'}`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}

const POLL_MS = 60_000;

export function AppLayout() {
  const { user, logout, can } = useAuth();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const confirm = useConfirm();
  useCalendarReminders(Boolean(user));
  const [signOut, signingOut] = useSingleFlight(async () => {
    if (!(await confirm({ title: 'Sign out?', message: 'You will need to sign in again to use WorkNest.', confirmLabel: 'Sign out', tone: 'danger' }))) return;
    // The session is cleared locally even if the server call fails, so always go to the sign-in page.
    await logout().catch(() => undefined);
    navigate('/login');
  });
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

  const nav = visibleNav({ can, isEmployee: Boolean(user?.employee), isManager: Boolean(user?.isManager), isApprover });
  const current = sectionFor(nav, location.pathname);
  // Pages reached from the header rather than the menu, so the header shows where you are.
  const onNotifications = location.pathname.startsWith('/notifications');
  const onAccount = location.pathname.startsWith('/account');
  const headerTitle = current?.label ?? (onNotifications ? 'Notifications' : onAccount ? 'My account' : null);

  const name = user?.employee?.fullName ?? user?.email ?? '';
  const activeTab = current?.tabs.find((t) => tabMatches(t, location.pathname));

  const sidebar = (
    <nav aria-label="Main" className="flex h-full flex-col bg-nav text-[13px] text-white/75">
      <Link to="/" className="flex items-center gap-2.5 px-5 pb-5 pt-5 text-[16px] font-semibold tracking-tight text-white">
        <Logo />
        WorkNest
      </Link>
      <div className="flex-1 overflow-y-auto px-3">
        {nav.map((group) => (
          <div key={group.title} className="mb-5">
            <div className="mb-1.5 px-3 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-white/40">{group.title}</div>
            {group.sections.map((section) => {
              const active = section === current;
              return (
                <Link
                  key={section.key}
                  to={section.tabs[0].to}
                  aria-current={active ? 'page' : undefined}
                  className={`group relative mb-0.5 flex items-center gap-3 rounded-lg px-3 py-2 transition-colors ${active ? 'bg-white/10 font-medium text-white' : 'hover:bg-white/5 hover:text-white'}`}
                >
                  {active && <span aria-hidden className="absolute inset-y-2 left-0 w-[3px] rounded-r bg-[#9fd3c7]" />}
                  <Icon name={section.key as IconName} className={active ? 'text-[#9fd3c7]' : 'text-white/55 group-hover:text-white/80'} />
                  <span className="flex-1">{section.label}</span>
                  {section.approvals && pendingCount > 0 ? <span className="tnum rounded-full bg-amber-soft px-2 py-px text-[11px] font-semibold text-amber">{pendingCount}</span> : null}
                </Link>
              );
            })}
          </div>
        ))}
      </div>
      <div className="border-t border-white/10 p-3">
        <div className="flex items-center gap-2.5 rounded-lg px-2 py-2">
          <Link to="/account" aria-current={onAccount ? 'page' : undefined} className={`-mx-1 flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-1 py-0.5 hover:text-white ${onAccount ? 'bg-white/10 text-white' : ''}`} aria-label="My account">
            <Avatar url={user?.avatarUrl} name={name} />
            <span className="min-w-0">
              <span className="block truncate text-[13px] font-medium text-white">{name}</span>
              <span className="block truncate text-[11.5px] text-white/50">{ROLE_LABEL[user?.role ?? ''] ?? ''}</span>
            </span>
          </Link>
          <button type="button" title="Sign out" aria-label="Sign out" disabled={signingOut} onClick={() => void signOut()} className="rounded-md p-1.5 text-white/55 hover:bg-white/10 hover:text-white disabled:opacity-50">
            <Icon name="logout" size={17} />
          </button>
        </div>
      </div>
    </nav>
  );

  const unreadCount = unread.data?.unread ?? 0;

  return (
    <div className="flex h-full">
      <aside className="hidden w-60 shrink-0 md:block">{sidebar}</aside>
      {open && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-64 shadow-2xl">{sidebar}</aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-3 border-b border-line bg-surface/90 px-4 py-2.5 backdrop-blur sm:px-6">
          <div className="flex min-w-0 items-center gap-2">
            <button type="button" aria-label="Open menu" className="rounded-lg p-1.5 text-muted hover:bg-paper md:hidden" onClick={() => setOpen(true)}>
              <Icon name="menu" />
            </button>
            {headerTitle && (
              <div className="flex min-w-0 items-center gap-1.5 text-[13px]">
                <span className="font-semibold text-ink">{headerTitle}</span>
                {current && activeTab && current.tabs.length > 1 && (
                  <>
                    <span aria-hidden className="text-faint">/</span>
                    <span className="truncate text-muted">{activeTab.label}</span>
                  </>
                )}
              </div>
            )}
          </div>
          <div className="flex items-center gap-1">
            <Link
              to="/notifications"
              aria-label={`Notifications, ${unreadCount} unread`}
              aria-current={onNotifications ? 'page' : undefined}
              title="Notifications"
              className={`relative rounded-lg p-2 transition-colors ${onNotifications ? 'bg-brand-soft text-brand ring-1 ring-brand/25' : 'text-muted hover:bg-paper hover:text-ink'}`}
            >
              <Icon name="bell" />
              {unreadCount > 0 && <span className="tnum absolute -right-0.5 -top-0.5 min-w-[18px] rounded-full border-2 border-surface bg-rose px-1 text-center text-[10px] font-semibold leading-[14px] text-white">{unreadCount > 99 ? '99+' : unreadCount}</span>}
            </Link>
            <Link to="/account" aria-label="My account" aria-current={onAccount ? 'page' : undefined} className={`ml-1 flex items-center gap-2 rounded-lg px-1.5 py-1 text-[13px] text-muted hover:bg-paper md:hidden ${onAccount ? 'bg-brand-soft ring-1 ring-brand/25' : ''}`}>
              <Avatar url={user?.avatarUrl} name={name} />
            </Link>
            <button type="button" title="Sign out" aria-label="Sign out" disabled={signingOut} onClick={() => void signOut()} className="rounded-lg p-2 text-muted hover:bg-paper hover:text-ink disabled:opacity-50 md:hidden">
              <Icon name="logout" />
            </button>
          </div>
        </header>
        <main className="min-w-0 flex-1 overflow-y-auto px-4 py-6 sm:px-8">
          {/* The calendar uses the full width of large screens; other pages keep a readable line length. */}
          <div className={`mx-auto ${['/calendar', '/team-calendar'].includes(location.pathname) ? 'max-w-[1680px]' : 'max-w-6xl'}`}>
            {current && current.tabs.length > 1 && <SectionTabs section={current} pathname={location.pathname} />}
            {/* Pages load lazily (see AppRoutes), so show a spinner while one downloads. */}
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
    <div className="flex min-h-full">
      <aside className="relative hidden w-[44%] max-w-xl flex-col justify-between overflow-hidden bg-nav p-10 text-white lg:flex">
        <div aria-hidden className="pointer-events-none absolute -right-24 -top-24 h-80 w-80 rounded-full bg-brand/60 blur-3xl" />
        <div aria-hidden className="pointer-events-none absolute -bottom-32 -left-16 h-80 w-80 rounded-full bg-nav-soft blur-3xl" />
        <div className="relative flex items-center gap-2.5 text-[17px] font-semibold tracking-tight">
          <Logo size={32} />
          WorkNest
        </div>
        <div className="relative">
          <h2 className="max-w-sm text-[28px] font-semibold leading-tight tracking-tight">Leave, attendance and people, in one calm place.</h2>
          <ul className="mt-6 space-y-3 text-[14px] text-white/75">
            {['Apply for leave and see your balance at once', 'Approve requests straight from your email', 'Punch in, work from home and track attendance'].map((t) => (
              <li key={t} className="flex items-center gap-3">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white/10 text-[#9fd3c7]"><Icon name="check" size={14} /></span>
                {t}
              </li>
            ))}
          </ul>
        </div>
        <div className="relative flex items-center gap-2 text-[12px] text-white/45">
          <Icon name="shield" size={14} /> Secure sign-in over an encrypted connection
        </div>
      </aside>
      <div className="flex flex-1 items-center justify-center p-4 sm:p-8">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2.5 text-[17px] font-semibold tracking-tight lg:hidden">
            <Logo size={32} />
            WorkNest
          </div>
          <h1 className="text-[24px] font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-1 text-[13.5px] text-muted">{subtitle}</p>}
          <div className="mt-6 rounded-2xl border border-line bg-surface p-6 shadow-[0_1px_2px_rgba(16,24,40,0.04),0_8px_24px_-12px_rgba(16,24,40,0.12)]">{children}</div>
        </div>
      </div>
    </div>
  );
}
