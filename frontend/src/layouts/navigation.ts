import type { Permission } from '../types';

/** One tab inside a menu section. Each tab keeps its own address, so links in emails and notifications still work. */
export interface NavTab {
  to: string;
  label: string;
  permission?: Permission;
  /** Personal pages, for accounts with an employee profile. */
  employeeOnly?: boolean;
  managerOnly?: boolean;
  /** Other addresses that belong to this tab, such as a detail page. */
  also?: string[];
}

export interface NavSection {
  key: string;
  label: string;
  tabs: NavTab[];
  /** Shown only when the person has something to decide, or may approve. */
  approvals?: boolean;
}

export interface NavGroup {
  title: string;
  sections: NavSection[];
}

export const NAV: NavGroup[] = [
  {
    title: '',
    sections: [
      { key: 'home', label: 'Home', tabs: [{ to: '/dashboard', label: 'Home', employeeOnly: true }] },
      {
        key: 'leave',
        label: 'Leave',
        tabs: [
          { to: '/apply', label: 'Apply', employeeOnly: true },
          { to: '/leaves', label: 'My requests', employeeOnly: true, also: ['/leaves/'] },
          { to: '/balances', label: 'Balances', employeeOnly: true },
          { to: '/comp-off', label: 'Comp-Off', employeeOnly: true },
        ],
      },
      {
        key: 'calendar',
        label: 'Calendar',
        tabs: [
          { to: '/calendar', label: 'My calendar', employeeOnly: true },
          { to: '/team-calendar', label: 'Team', employeeOnly: true },
          { to: '/admin/calendar', label: 'Company', permission: 'calendar:read' },
          { to: '/holidays', label: 'Holidays' },
        ],
      },
      {
        key: 'attendance',
        label: 'Attendance',
        tabs: [
          { to: '/attendance', label: 'My attendance', employeeOnly: true },
          { to: '/team-attendance', label: 'My team', employeeOnly: true, managerOnly: true },
          { to: '/admin/attendance', label: 'Everyone', permission: 'attendance:manage' },
        ],
      },
      {
        key: 'expenses',
        label: 'Expenses',
        tabs: [
          { to: '/expenses', label: 'My claims', employeeOnly: true },
          { to: '/admin/expenses', label: 'All claims', permission: 'expenses:manage' },
        ],
      },
      { key: 'announcements', label: 'Announcements', tabs: [{ to: '/announcements', label: 'Announcements' }] },
    ],
  },
  {
    title: 'Manage',
    sections: [
      { key: 'approvals', label: 'Approvals', approvals: true, tabs: [{ to: '/approvals', label: 'Approvals' }] },
      {
        key: 'people',
        label: 'People',
        tabs: [
          { to: '/admin/employees', label: 'Employees', permission: 'employees:read', also: ['/admin/employees/'] },
          { to: '/admin/balances', label: 'Leave balances', permission: 'balances:read' },
          { to: '/admin/comp-off', label: 'Comp-Off requests', permission: 'compoff:manage' },
          { to: '/admin/payroll', label: 'Payroll', permission: 'payroll:read' },
        ],
      },
      {
        key: 'reports',
        label: 'Reports',
        tabs: [
          { to: '/admin/insights', label: 'HR dashboard', permission: 'reports:read' },
          { to: '/admin/reports', label: 'Reports', permission: 'reports:read' },
          { to: '/admin/audit', label: 'Audit log', permission: 'audit:read' },
        ],
      },
      {
        key: 'settings',
        label: 'Settings',
        tabs: [
          { to: '/super/settings', label: 'Company', permission: 'settings:manage' },
          { to: '/admin/holidays', label: 'Holidays', permission: 'holidays:manage' },
          { to: '/admin/leave-types', label: 'Leave types', permission: 'leave_policy:manage' },
          { to: '/admin/policies', label: 'Leave policies', permission: 'leave_policy:manage' },
          { to: '/admin/org', label: 'Departments & locations', permission: 'org:manage' },
          { to: '/super/workflows', label: 'Approval workflows', permission: 'workflows:manage' },
          { to: '/super/admins', label: 'Admin accounts', permission: 'admins:manage' },
        ],
      },
    ],
  },
];

export interface NavAccess {
  can: (p: Permission) => boolean;
  isEmployee: boolean;
  isManager: boolean;
  isApprover: boolean;
}

/** Hiding a tab is for tidiness only. Every page is protected again by its route and by the API. */
export function visibleNav(access: NavAccess): NavGroup[] {
  const tabVisible = (t: NavTab) =>
    (!t.permission || access.can(t.permission)) && (!t.employeeOnly || access.isEmployee) && (!t.managerOnly || access.isManager);
  return NAV.map((g) => ({
    ...g,
    sections: g.sections
      .filter((s) => !s.approvals || access.isApprover)
      .map((s) => ({ ...s, tabs: s.tabs.filter(tabVisible) }))
      .filter((s) => s.tabs.length),
  })).filter((g) => g.sections.length);
}

export const tabMatches = (tab: NavTab, pathname: string) =>
  pathname === tab.to || (tab.also ?? []).some((p) => pathname.startsWith(p));

export function sectionFor(groups: NavGroup[], pathname: string): NavSection | undefined {
  for (const g of groups) for (const s of g.sections) if (s.tabs.some((t) => tabMatches(t, pathname))) return s;
  return undefined;
}
