import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { api, applyServerErrors } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import type { CalendarItem, CalendarItemColor, CalendarItemKind } from '../../types';
import { fromMinutes, toMinutes } from '../../utils/planner';
import { CalendarItemForm, calendarItemSchema } from '../../validations';
import { Button, Checkbox, cx, Field, Input, Modal, Note, Select, Textarea, useToast } from '../ui';
import { TONES } from './tones';

export interface ItemDraft {
  kind: CalendarItemKind;
  date: string;
  startTime?: string;
  endTime?: string;
  allDay?: boolean;
}

const REMINDERS = [
  { value: '', label: 'No reminder' },
  { value: '0', label: 'At start time' },
  { value: '5', label: '5 minutes before' },
  { value: '10', label: '10 minutes before' },
  { value: '15', label: '15 minutes before' },
  { value: '30', label: '30 minutes before' },
  { value: '60', label: '1 hour before' },
  { value: '1440', label: '1 day before' },
];

const COLORS: CalendarItemColor[] = ['brand', 'sky', 'violet', 'amber', 'rose', 'slate'];

/** Adds or edits one event or task. `item` set means editing. */
export function ItemModal({ item, draft, onClose, onSaved }: { item?: CalendarItem; draft?: ItemDraft; onClose: () => void; onSaved: (saved: CalendarItem) => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const [formError, setFormError] = useState<string | null>(null);
  const start = item?.startTime ?? draft?.startTime ?? '09:00';
  const { register, handleSubmit, watch, setValue, setError, control, formState: { errors, isSubmitting } } = useForm<CalendarItemForm>({
    resolver: zodResolver(calendarItemSchema),
    defaultValues: {
      kind: item?.kind ?? draft?.kind ?? 'EVENT',
      title: item?.title ?? '',
      date: item?.date ?? draft?.date,
      endDate: item && item.endDate !== item.date ? item.endDate : '',
      allDay: item?.allDay ?? draft?.allDay ?? false,
      startTime: start,
      endTime: item?.endTime ?? draft?.endTime ?? fromMinutes(toMinutes(start) + 60),
      location: item?.location ?? '',
      description: item?.description ?? '',
      color: item?.color ?? (draft?.kind === 'TASK' ? 'amber' : 'brand'),
      visibility: item?.visibility ?? 'PRIVATE',
      reminder: item?.reminderMinutes == null ? '' : String(item.reminderMinutes),
    },
  });
  const kind = watch('kind');
  const allDay = watch('allDay');
  const isTask = kind === 'TASK';
  const canPublish = can('announcements:manage');

  const onSubmit = async (v: CalendarItemForm) => {
    setFormError(null);
    const timed = !v.allDay;
    const body = {
      kind: v.kind,
      title: v.title,
      description: v.description?.trim() || null,
      location: isTask ? null : v.location?.trim() || null,
      date: v.date,
      endDate: !timed && !isTask && v.endDate ? v.endDate : null,
      allDay: v.allDay,
      startTime: timed ? v.startTime || null : null,
      endTime: timed && !isTask ? v.endTime || null : null,
      color: v.color,
      visibility: v.visibility,
      reminderMinutes: timed && v.reminder !== '' ? Number(v.reminder) : null,
    };
    try {
      const res = item ? await api.put(`/calendar/items/${item._id}`, body) : await api.post('/calendar/items', body);
      toast(item ? `${isTask ? 'Task' : 'Event'} updated` : `${isTask ? 'Task' : 'Event'} added`);
      onSaved(res.data.data);
    } catch (err) {
      setFormError(applyServerErrors(err, setError, ['title', 'date', 'endDate', 'startTime', 'endTime', 'location', 'description'] as const));
    }
  };

  const noun = isTask ? 'task' : 'event';
  return (
    <Modal
      title={item ? `Edit ${noun}` : `New ${noun}`}
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="item-form" loading={isSubmitting}>{item ? 'Save changes' : `Add ${noun}`}</Button></>}
    >
      <form id="item-form" className="space-y-3" onSubmit={handleSubmit(onSubmit)} noValidate>
        {formError && <Note>{formError}</Note>}
        {!item && (
          <div role="radiogroup" aria-label="Type" className="inline-flex rounded-lg bg-paper p-0.5">
            {(['EVENT', 'TASK'] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={kind === k}
                onClick={() => { setValue('kind', k); if (k === 'TASK' && watch('color') === 'brand') setValue('color', 'amber'); }}
                className={cx('rounded-md px-4 py-1.5 text-[13px] font-medium transition-all', kind === k ? 'bg-surface text-brand shadow-[0_1px_2px_rgba(16,24,40,0.1)]' : 'text-muted hover:text-ink')}
              >
                {k === 'EVENT' ? 'Event' : 'Task'}
              </button>
            ))}
          </div>
        )}
        <Field label="Title" required error={errors.title?.message}>
          <Input autoFocus placeholder={isTask ? 'e.g. Submit travel receipts' : 'e.g. Design sync'} {...register('title')} />
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={isTask ? 'Due date' : allDay ? 'Start date' : 'Date'} required error={errors.date?.message}><Input type="date" {...register('date')} /></Field>
          {!isTask && allDay && <Field label="End date" hint="Leave blank for one day" error={errors.endDate?.message}><Input type="date" {...register('endDate')} /></Field>}
          {!allDay && (
            <Field label={isTask ? 'Due time' : 'Starts'} required error={errors.startTime?.message}><Input type="time" {...register('startTime')} /></Field>
          )}
          {!allDay && !isTask && <Field label="Ends" required error={errors.endTime?.message}><Input type="time" {...register('endTime')} /></Field>}
        </div>
        <Checkbox label={isTask ? 'No due time' : 'All day'} {...register('allDay')} />

        {!isTask && <Field label="Location" error={errors.location?.message}><Input placeholder="Room, address or meeting link" {...register('location')} /></Field>}
        <Field label={isTask ? 'Notes' : 'About this event'} error={errors.description?.message}><Textarea rows={3} {...register('description')} /></Field>

        <div className="grid gap-3 sm:grid-cols-2">
          {!allDay && (
            <Field label="Reminder" hint="Shown in WorkNest while you are signed in">
              <Select {...register('reminder')}>{REMINDERS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}</Select>
            </Field>
          )}
          {canPublish && (
            <Field label="Who can see it">
              <Select {...register('visibility')}>
                <option value="PRIVATE">Only me</option>
                <option value="COMPANY">Everyone in the company</option>
              </Select>
            </Field>
          )}
        </div>

        <div>
          <span className="mb-1.5 block text-xs font-medium text-muted">Colour</span>
          <Controller
            control={control}
            name="color"
            render={({ field }) => (
              <div role="radiogroup" aria-label="Colour" className="flex gap-2">
                {COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    role="radio"
                    aria-checked={field.value === c}
                    aria-label={TONES[c].label}
                    title={TONES[c].label}
                    onClick={() => field.onChange(c)}
                    className={cx('h-7 w-7 rounded-full border-2 transition-transform hover:scale-110', TONES[c].swatch, field.value === c ? 'border-ink ring-2 ring-surface ring-inset' : 'border-transparent')}
                  />
                ))}
              </div>
            )}
          />
        </div>
      </form>
    </Modal>
  );
}
