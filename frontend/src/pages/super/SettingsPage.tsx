import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { api, errorMessage, fieldErrors } from '../../api/client';
import { Button, Card, Checkbox, Field, Input, Loading, Note, PageHeader, useToast } from '../../components/ui';
import { useFetch } from '../../hooks/useFetch';

interface Settings {
  companyName: string;
  timezone: string;
  reserveBalanceOnPending: boolean;
  attendanceStartDate: string | null;
  security: { maxFailedLogins: number; lockoutMinutes: number; minPasswordLength: number };
  notifications: { emailEnabled: boolean; holidayReminderDays: number; approvalReminderDays: number; approvalEscalationDays: number; punchReminderEnabled: boolean; punchReminderTime: string };
}

export function SettingsPage() {
  const toast = useToast();
  const { data, loading, error } = useFetch<Settings>('/settings');
  const [formError, setFormError] = useState<string | null>(null);
  const { register, handleSubmit, reset, formState: { isSubmitting } } = useForm<Settings>();
  const num = { valueAsNumber: true };

  useEffect(() => {
    if (data) reset(data);
  }, [data, reset]);

  const onSubmit = async (v: Settings) => {
    setFormError(null);
    try {
      await api.put('/settings', {
        companyName: v.companyName,
        timezone: v.timezone,
        reserveBalanceOnPending: v.reserveBalanceOnPending,
        security: v.security,
        notifications: v.notifications,
      });
      toast('Settings saved');
    } catch (err) {
      const first = fieldErrors(err)[0];
      setFormError(first ? `${first.path}: ${first.message}` : errorMessage(err));
    }
  };

  if (loading && !data) return <Loading />;
  if (error) return <Note>{error}</Note>;

  return (
    <>
      <PageHeader title="Company settings" subtitle="Saturday and Sunday are always weekly offs and are never charged as leave." />
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        {formError && <Note>{formError}</Note>}
        <Card title="Company">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Company name"><Input {...register('companyName')} /></Field>
            <Field label="Timezone" hint="An IANA name such as Asia/Kolkata. It decides what counts as today."><Input {...register('timezone')} /></Field>
            <Field label="Attendance start date" hint="Days before this are not counted as absent or taken off pay."><Input type="date" {...register('attendanceStartDate', { setValueAs: (v) => v || null })} /></Field>
            <div className="sm:col-span-2">
              <Checkbox label="Hold balance while a request is pending" {...register('reserveBalanceOnPending')} />
              <p className="ml-5.5 mt-1 text-xs text-muted">Stops several pending requests from overspending together. Held days are shown separately from used days, and only approval deducts them.</p>
            </div>
          </div>
        </Card>
        <Card title="Security">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Failed sign-ins before lockout"><Input type="number" min={1} {...register('security.maxFailedLogins', num)} /></Field>
            <Field label="Lockout length (minutes)"><Input type="number" min={1} {...register('security.lockoutMinutes', num)} /></Field>
            <Field label="Minimum password length"><Input type="number" min={8} {...register('security.minPasswordLength', num)} /></Field>
          </div>
        </Card>
        <Card title="Notifications">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Holiday reminder (days before)"><Input type="number" min={0} {...register('notifications.holidayReminderDays', num)} /></Field>
            <Field label="Remind approvers after (days)"><Input type="number" min={1} {...register('notifications.approvalReminderDays', num)} /></Field>
            <Field label="Escalate to Super Admins after (days)"><Input type="number" min={1} {...register('notifications.approvalEscalationDays', num)} /></Field>
            <Field label="Forgot-to-punch reminder time" hint="Company time, on working days"><Input type="time" {...register('notifications.punchReminderTime')} /></Field>
            <div className="flex items-end pb-1"><Checkbox label="Remind people who have not punched in" {...register('notifications.punchReminderEnabled')} /></div>
            <div className="flex items-end pb-1">
              <Checkbox label="Also send notifications by email (needs SMTP configured on the server)" {...register('notifications.emailEnabled')} />
            </div>
          </div>
        </Card>
        <Button type="submit" variant="primary" loading={isSubmitting}>Save settings</Button>
      </form>
    </>
  );
}
