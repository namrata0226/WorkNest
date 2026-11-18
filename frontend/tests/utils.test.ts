import { describe, expect, it } from 'vitest';
import { addOneDay } from '../src/utils/calendar';
import { days, formatDate, formatMonth, formatRange, toDateOnly } from '../src/utils/date';
import { adjustmentSchema, compOffSchema, employeeSchema, holidaySchema, leaveSchema, loginSchema, resetSchema } from '../src/validations';

describe('date display', () => {
  it('shows the stored calendar date whatever the browser timezone', () => {
    for (const tz of ['Pacific/Honolulu', 'Asia/Kolkata', 'Pacific/Auckland']) {
      process.env.TZ = tz;
      expect(formatDate('2030-03-01')).toBe('1 Mar 2030');
      expect(formatMonth('2030-03')).toBe('March 2030');
    }
  });

  it('formats ranges compactly', () => {
    expect(formatRange('2030-03-01', '2030-03-01')).toBe('1 Mar 2030');
    expect(formatRange('2030-03-01', '2030-03-04')).toBe('1 Mar – 4 Mar 2030');
    expect(formatRange('2030-12-30', '2031-01-01')).toBe('30 Dec 2030 – 1 Jan 2031');
    expect(formatDate(null)).toBe('—');
  });

  it('reads a browser Date as its local calendar date', () => {
    expect(toDateOnly(new Date(2030, 2, 1, 23, 30))).toBe('2030-03-01');
  });

  it('crosses month and year ends', () => {
    expect(addOneDay('2030-12-31')).toBe('2031-01-01');
    expect(addOneDay('2028-02-28')).toBe('2028-02-29');
  });

  it('pluralises days', () => {
    expect(days(1)).toBe('1 day');
    expect(days(0.5)).toBe('0.5 days');
    expect(days(undefined)).toBe('0 days');
  });
});

const leave = { leaveType: 'x', startDate: '2030-03-01', endDate: '2030-03-04', dayType: 'FULL', reason: 'Trip' };
const errorsOf = (r: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) => r.error?.issues.map((i) => i.path.join('.')) ?? [];

describe('form validation', () => {
  it('accepts a valid leave application', () => {
    expect(leaveSchema.safeParse(leave).success).toBe(true);
  });

  it('rejects an end date before the start date', () => {
    expect(errorsOf(leaveSchema.safeParse({ ...leave, startDate: '2030-03-05' }))).toContain('endDate');
  });

  it('requires a reason and a leave type', () => {
    expect(errorsOf(leaveSchema.safeParse({ ...leave, reason: '   ' }))).toContain('reason');
    expect(errorsOf(leaveSchema.safeParse({ ...leave, leaveType: '' }))).toContain('leaveType');
  });

  it('enforces half-day rules', () => {
    const half = { ...leave, dayType: 'HALF', endDate: leave.startDate, halfSession: 'FIRST' };
    expect(leaveSchema.safeParse(half).success).toBe(true);
    expect(errorsOf(leaveSchema.safeParse({ ...half, endDate: '2030-03-04' }))).toContain('endDate');
    expect(errorsOf(leaveSchema.safeParse({ ...half, halfSession: null }))).toContain('halfSession');
  });

  it('validates email and passwords', () => {
    expect(errorsOf(loginSchema.safeParse({ email: 'nope', password: 'x' }))).toContain('email');
    expect(errorsOf(resetSchema.safeParse({ password: 'short1', confirm: 'short1' }))).toContain('password');
    expect(errorsOf(resetSchema.safeParse({ password: 'long-enough-pass-1', confirm: 'different-pass-1' }))).toContain('confirm');
    expect(resetSchema.safeParse({ password: 'long-enough-pass-1', confirm: 'long-enough-pass-1' }).success).toBe(true);
  });

  it('validates employee IDs and phone numbers', () => {
    const base = { employeeId: 'E-1', fullName: 'A', email: 'a@b.co', joiningDate: '2026-01-01', category: 'PERMANENT' };
    expect(employeeSchema.safeParse(base).success).toBe(true);
    expect(errorsOf(employeeSchema.safeParse({ ...base, employeeId: 'bad id!' }))).toContain('employeeId');
    expect(errorsOf(employeeSchema.safeParse({ ...base, phone: 'call me' }))).toContain('phone');
    expect(employeeSchema.safeParse({ ...base, phone: '' }).success).toBe(true);
  });

  it('accepts only quarter-day steps for adjustments, and never zero', () => {
    const base = { leaveType: 'x', year: 2030, kind: 'CREDIT', reason: 'Bonus' };
    expect(adjustmentSchema.safeParse({ ...base, amount: 1.25 }).success).toBe(true);
    expect(errorsOf(adjustmentSchema.safeParse({ ...base, amount: 1.1 }))).toContain('amount');
    expect(errorsOf(adjustmentSchema.safeParse({ ...base, amount: 0 }))).toContain('amount');
  });

  it('validates holidays and Comp-Off claims', () => {
    const h = { name: 'Day', date: '2030-01-26', category: 'NATIONAL', isHalfDay: false, halfDaySession: 'SECOND', recurring: true, locations: [], departments: [], employeeCategories: [] };
    expect(holidaySchema.safeParse(h).success).toBe(true);
    expect(errorsOf(holidaySchema.safeParse({ ...h, category: 'NOPE' }))).toContain('category');
    expect(errorsOf(compOffSchema.safeParse({ workedDate: '', dayType: 'FULL', reason: 'x' }))).toContain('workedDate');
  });
});

describe('menu', async () => {
  const { visibleNav, sectionFor } = await import('../src/layouts/navigation');
  const labels = (g: ReturnType<typeof visibleNav>) => g.flatMap((x) => x.sections.map((s) => `${s.label}:${s.tabs.map((t) => t.label).join('|')}`));

  it('gives an employee a short menu, with no admin pages', () => {
    const nav = visibleNav({ can: () => false, isEmployee: true, isManager: false, isApprover: false });
    expect(labels(nav)).toEqual([
      'Home:Home',
      'Leave:Apply|My requests|Balances|Comp-Off',
      'Calendar:My calendar|Team|Holidays',
      'Attendance:My attendance',
      'Expenses:My claims',
      'Announcements:Announcements',
    ]);
  });

  it('puts every calendar under one Calendar entry for HR', () => {
    const nav = visibleNav({ can: () => true, isEmployee: true, isManager: true, isApprover: true });
    expect(sectionFor(nav, '/admin/calendar')?.label).toBe('Calendar');
    expect(sectionFor(nav, '/team-calendar')?.label).toBe('Calendar');
    expect(sectionFor(nav, '/admin/employees/abc')?.label).toBe('People');
    expect(sectionFor(nav, '/leaves/abc')?.label).toBe('Leave');
    expect(nav.flatMap((g) => g.sections)).toHaveLength(10);
  });

  it('leaves out personal tabs for an account with no employee profile', () => {
    const nav = visibleNav({ can: () => true, isEmployee: false, isManager: false, isApprover: true });
    const calendar = nav.flatMap((g) => g.sections).find((s) => s.key === 'calendar')!;
    expect(calendar.tabs.map((t) => t.to)).toEqual(['/admin/calendar', '/holidays']);
    expect(nav.flatMap((g) => g.sections).some((s) => s.key === 'home')).toBe(false);
  });
});
