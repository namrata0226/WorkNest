import { useState } from 'react';
import { Badge, Card, DataTable, Note, PageHeader, Select } from '../components/ui';
import { useFetch } from '../hooks/useFetch';
import type { Holiday } from '../types';
import { currentYear, formatDay } from '../utils/date';
import { titleCase } from '../utils/labels';
import { yearOptions } from './BalancesPage';

export function HolidaysPage() {
  const [year, setYear] = useState(currentYear());
  const { data, loading, error } = useFetch<Holiday[]>('/holidays', { year });

  return (
    <>
      <PageHeader
        title="Company holidays"
        subtitle="The holidays that apply to you. These are not charged as leave, except optional holidays, which you can take as Optional Holiday leave."
        actions={
          <Select aria-label="Year" value={year} onChange={(e) => setYear(Number(e.target.value))}>
            {yearOptions().map((y) => <option key={y} value={y}>{y}</option>)}
          </Select>
        }
      />
      {error && <Note>{error}</Note>}
      <Card flush>
        <DataTable<Holiday>
          rows={data}
          loading={loading}
          rowKey={(h) => h._id + h.occurrenceDate}
          empty={`No holidays have been published for ${year}.`}
          columns={[
            { header: 'Date', cell: (h) => formatDay(h.occurrenceDate), className: 'whitespace-nowrap' },
            { header: 'Holiday', cell: (h) => <div><div className="font-medium">{h.name}</div>{h.description && <div className="text-xs text-muted">{h.description}</div>}</div> },
            { header: 'Category', cell: (h) => <Badge tone={h.category === 'OPTIONAL' ? 'sky' : 'gray'}>{titleCase(h.category)}</Badge> },
            { header: 'Day', cell: (h) => (h.isHalfDay ? `Half (${h.halfDaySession === 'FIRST' ? 'first' : 'second'})` : 'Full') },
          ]}
        />
      </Card>
    </>
  );
}
