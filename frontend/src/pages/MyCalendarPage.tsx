import { Planner } from '../components/planner/Planner';

/** The full calendar: your own events and tasks, company-wide events, your leave and your holidays. */
export function MyCalendarPage() {
  return (
    <>
      {/* The calendar's own header names the period, so the page title is for screen readers only. */}
      <h1 className="sr-only">Calendar</h1>
      <Planner />
    </>
  );
}
