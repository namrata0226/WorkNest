import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarEvent, CalendarHoliday, CalendarLegend, LeaveCalendar, VisibleRange } from '../../components/LeaveCalendar';
import { Button, Card, DataTable, Input, Loading, Modal, Note, PageHeader, Pagination, Select, Stat, Tabs, useToast } from '../../components/ui';
import { useFetch } from '../../hooks/useFetch';
import { downloadFile } from '../../services/download';
import type { LeaveRequest, LeaveType, Named } from '../../types';
import { formatDate, formatMonth, todayString } from '../../utils/date';
import { ApprovalTrail, LeaveSummary } from '../MyLeavesPage';

interface SummaryRow {
  employeeRef: string;
  employeeName: string;
  employeeId: string;
  department: string;
  casual: number;
  sick: number;
  earned: number;
  compOff: number;
  other: number;
  total: number;
}

interface Summary {
  month: string;
  cards: {
    totalActiveEmployees: number;
    employeesOnLeaveThisMonth: number;
    employeesCurrentlyOnLeave: number;
    totalApprovedLeaveDays: number;
    pendingLeaveRequests: number;
    maxAbsence: { count: number; dates: string[] };
  };
  rows: SummaryRow[];
}

/** Holds typing back until it settles, so a search does not refetch on every keystroke. */
function useDebounced<T>(value: T, delay = 300): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

export function CompanyCalendarPage() {
  const toast = useToast();
  const [view, setView] = useState<'calendar' | 'table'>('calendar');
  const [range, setRange] = useState<VisibleRange | null>(null);
  const [searchText, setSearchText] = useState('');
  const search = useDebounced(searchText);
  const [department, setDepartment] = useState('');
  const [leaveType, setLeaveType] = useState('');
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [tablePage, setTablePage] = useState(1);
  const [tableMonth, setTableMonth] = useState(todayString().slice(0, 7));
  const [exporting, setExporting] = useState<string | null>(null);

  const departments = useFetch<Named[]>('/departments');
  const types = useFetch<LeaveType[]>('/leave-types');

  // The month on show follows the calendar, and the table's own picker when the table is open.
  const month = view === 'calendar' ? range?.month ?? todayString().slice(0, 7) : tableMonth;
  const filters = { department, leaveType, search };

  const calendar = useFetch<{ events: CalendarEvent[]; holidays: CalendarHoliday[] }>(
    range ? '/calendar/company' : null,
    range ? { start: range.start, end: range.end, status, ...filters } : undefined,
  );
  const summary = useFetch<Summary>('/calendar/summary', { month, ...filters, page: tablePage, limit: 50 });

  const onRange = (next: VisibleRange) => {
    setRange(next);
    setTableMonth(next.month);
  };

  const exportAs = async (format: 'xlsx' | 'csv') => {
    setExporting(format);
    try {
      await downloadFile('/calendar/export', { month, format, ...filters }, `leave-summary-${month}.${format}`);
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setExporting(null);
    }
  };

  const c = summary.data?.cards;
  const activeTypes = (types.data ?? []).filter((t) => t.isActive);

  return (
    <>
      <PageHeader
        title="Company Leave Calendar"
        subtitle={formatMonth(month)}
        actions={
          <>
            <Tabs value={view} onChange={setView} tabs={[{ value: 'calendar', label: 'Calendar' }, { value: 'table', label: 'Table' }]} />
            <Button loading={exporting === 'xlsx'} onClick={() => void exportAs('xlsx')}>Excel</Button>
            <Button loading={exporting === 'csv'} onClick={() => void exportAs('csv')}>CSV</Button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <Stat label="Active employees" value={c?.totalActiveEmployees ?? '–'} />
        <Stat label="On leave this month" value={c?.employeesOnLeaveThisMonth ?? '–'} />
        <Stat label="On leave today" value={c?.employeesCurrentlyOnLeave ?? '–'} tone="brand" />
        <Stat label="Approved leave days" value={c?.totalApprovedLeaveDays ?? '–'} />
        <Stat label="Pending requests" value={c?.pendingLeaveRequests ?? '–'} tone={c?.pendingLeaveRequests ? 'amber' : undefined} />
        <Stat
          label="Highest absence"
          value={c?.maxAbsence.count ? `${c.maxAbsence.count} people` : '–'}
          hint={c?.maxAbsence.dates.length ? `${formatDate(c.maxAbsence.dates[0])}${c.maxAbsence.dates.length > 1 ? ` +${c.maxAbsence.dates.length - 1} more` : ''}` : 'No leave this month'}
        />
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Input aria-label="Search by employee name or ID" placeholder="Search name or employee ID" value={searchText} onChange={(e) => { setSearchText(e.target.value); setTablePage(1); }} />
        <Select aria-label="Filter by department" value={department} onChange={(e) => { setDepartment(e.target.value); setTablePage(1); }}>
          <option value="">All departments</option>
          {departments.data?.map((d) => <option key={d._id} value={d._id}>{d.name}</option>)}
        </Select>
        <Select aria-label="Filter by leave type" value={leaveType} onChange={(e) => { setLeaveType(e.target.value); setTablePage(1); }}>
          <option value="">All leave types</option>
          {activeTypes.map((t) => <option key={t._id} value={t._id}>{t.name}</option>)}
        </Select>
        {view === 'calendar' ? (
          <Select aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Approved and pending</option>
            <option value="APPROVED">Approved only</option>
            <option value="PENDING">Pending only</option>
          </Select>
        ) : (
          <Input aria-label="Month" type="month" value={tableMonth} onChange={(e) => { if (e.target.value) { setTableMonth(e.target.value); setTablePage(1); } }} />
        )}
      </div>

      {(calendar.error || summary.error) && <div className="mt-3"><Note>{calendar.error ?? summary.error}</Note></div>}

      {/* The calendar stays mounted so it keeps its place when switching to the table and back. */}
      <div className={view === 'calendar' ? '' : 'hidden'}>
        <Card className="mt-3">
          <LeaveCalendar events={calendar.data?.events ?? []} holidays={calendar.data?.holidays ?? []} onRange={onRange} onEventClick={setSelected} />
          <div className="mt-3 border-t border-line pt-3"><CalendarLegend types={activeTypes} /></div>
        </Card>
      </div>

      {view === 'table' && (
        <Card className="mt-3" flush title={`Employee summary, ${formatMonth(month)}`}>
          <DataTable<SummaryRow>
            rows={summary.data?.rows}
            loading={summary.loading}
            rowKey={(r) => r.employeeRef}
            empty="No employees match."
            columns={[
              { header: 'Employee Name', cell: (r) => <Link className="font-medium hover:underline" to={`/admin/employees/${r.employeeRef}`}>{r.employeeName}</Link> },
              { header: 'Employee ID', cell: (r) => r.employeeId, className: 'text-muted' },
              { header: 'Department', cell: (r) => r.department || '—', className: 'text-muted' },
              { header: 'Casual Leave', align: 'right', cell: (r) => r.casual },
              { header: 'Sick Leave', align: 'right', cell: (r) => r.sick },
              { header: 'Earned Leave', align: 'right', cell: (r) => r.earned },
              { header: 'Comp-Off', align: 'right', cell: (r) => r.compOff },
              { header: 'Other', align: 'right', cell: (r) => r.other },
              { header: 'Total Leave Days', align: 'right', cell: (r) => <span className="font-semibold">{r.total}</span> },
            ]}
          />
          <Pagination meta={summary.meta} onPage={setTablePage} />
        </Card>
      )}

      {selected && <LeaveDetailsModal id={selected} onClose={() => setSelected(null)} />}
    </>
  );
}

function LeaveDetailsModal({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, loading, error } = useFetch<LeaveRequest>(`/leaves/${id}`);
  return (
    <Modal wide title="Leave details" onClose={onClose} footer={<Link to={`/approvals?request=${id}`}><Button variant="primary">Open in approvals</Button></Link>}>
      {loading && !data ? <Loading /> : error ? <Note>{error}</Note> : data && (
        <div className="grid gap-4 sm:grid-cols-[3fr_2fr]">
          <LeaveSummary request={data} />
          <div>
            <h3 className="mb-2 text-xs font-medium text-muted">Approval steps</h3>
            <ApprovalTrail request={data} />
          </div>
        </div>
      )}
    </Modal>
  );
}
