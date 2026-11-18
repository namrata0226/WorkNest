import { describe, expect, it } from 'vitest';
import { calculateLeaveDays, HolidayOccurrence } from '../src/services/leaveCalculation';
import { addDays, dayOfWeek, eachDay, isDateOnly, todayIn } from '../src/utils/dates';

const holiday = (date: string, over: Partial<HolidayOccurrence> = {}): HolidayOccurrence => ({ date, name: 'Holiday', category: 'NATIONAL', isHalfDay: false, halfDaySession: 'SECOND', ...over });
const calc = (startDate: string, endDate: string, holidays: HolidayOccurrence[] = [], dayType: 'FULL' | 'HALF' = 'FULL', halfSession?: 'FIRST' | 'SECOND') =>
  calculateLeaveDays({ startDate, endDate, dayType, halfSession, holidays });

describe('leave day calculation', () => {
  it('counts Friday to Monday as two days', () => {
    const r = calc('2030-03-01', '2030-03-04');
    expect(r.totalDays).toBe(2);
    expect(r.dayBreakdown.map((d) => d.date)).toEqual(['2030-03-01', '2030-03-04']);
  });

  it('never charges Saturday or Sunday', () => {
    expect(calc('2030-03-02', '2030-03-03').totalDays).toBe(0);
    expect(calc('2030-03-02', '2030-03-02').excluded[0].reason).toBe('WEEKLY_OFF');
  });

  it('excludes several weekends across a long range', () => {
    // Mon 4 March to Fri 29 March 2030: four full weeks of five days.
    expect(calc('2030-03-04', '2030-03-29').totalDays).toBe(20);
  });

  it('excludes a weekday holiday and ignores a holiday on a weekend', () => {
    expect(calc('2030-03-04', '2030-03-08', [holiday('2030-03-06')]).totalDays).toBe(4);
    expect(calc('2030-03-01', '2030-03-04', [holiday('2030-03-02')]).totalDays).toBe(2);
  });

  it('counts a half day as 0.5', () => {
    expect(calc('2030-03-04', '2030-03-04', [], 'HALF', 'FIRST').totalDays).toBe(0.5);
  });

  it('charges half a day when a half-day holiday falls inside a full-day leave', () => {
    const r = calc('2030-03-04', '2030-03-05', [holiday('2030-03-05', { isHalfDay: true })]);
    expect(r.totalDays).toBe(1.5);
    expect(r.excluded[0].reason).toBe('HALF_DAY_HOLIDAY');
  });

  it('charges nothing for taking off the half that is already a holiday, and 0.5 for the other half', () => {
    const h = [holiday('2030-03-05', { isHalfDay: true, halfDaySession: 'SECOND' })];
    expect(calc('2030-03-05', '2030-03-05', h, 'HALF', 'SECOND').totalDays).toBe(0);
    expect(calc('2030-03-05', '2030-03-05', h, 'HALF', 'FIRST').totalDays).toBe(0.5);
  });

  it('lets a full-day holiday win over a half-day holiday on the same date', () => {
    const r = calc('2030-03-05', '2030-03-05', [holiday('2030-03-05', { isHalfDay: true }), holiday('2030-03-05', { name: 'Full' })]);
    expect(r.totalDays).toBe(0);
  });

  it('splits a leave across years for per-year balances', () => {
    // Mon 30 Dec 2030 to Wed 1 Jan 2031.
    expect(calc('2030-12-30', '2031-01-01').byYear).toEqual([{ year: 2030, amount: 2 }, { year: 2031, amount: 1 }]);
  });

  it('handles a leap day', () => {
    expect(calc('2028-02-28', '2028-03-01').totalDays).toBe(3);
  });
});

describe('date-only helpers', () => {
  it('does not shift across daylight-saving changes in any server timezone', () => {
    const original = process.env.TZ;
    for (const tz of ['America/New_York', 'Asia/Kolkata', 'Pacific/Auckland']) {
      process.env.TZ = tz;
      // The US and NZ clock changes fall in these ranges.
      expect(eachDay('2030-03-09', '2030-03-11')).toEqual(['2030-03-09', '2030-03-10', '2030-03-11']);
      expect(addDays('2030-09-28', 2)).toBe('2030-09-30');
      expect(dayOfWeek('2030-03-02')).toBe(6);
    }
    process.env.TZ = original;
  });

  it('rejects impossible dates', () => {
    expect(isDateOnly('2030-02-30')).toBe(false);
    expect(isDateOnly('2030-2-3')).toBe(false);
    expect(isDateOnly('2028-02-29')).toBe(true);
  });

  it('reads today in the company timezone, not UTC', () => {
    const instant = new Date('2030-03-01T20:00:00Z');
    expect(todayIn('Asia/Kolkata', instant)).toBe('2030-03-02');
    expect(todayIn('America/New_York', instant)).toBe('2030-03-01');
  });
});
