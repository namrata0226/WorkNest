import { zodResolver } from '@hookform/resolvers/zod';
import { useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { z } from 'zod';
import { api, applyServerErrors, errorMessage } from '../api/client';
import { Avatar } from '../components/Avatar';
import { Button, Card, Field, Input, Modal, Note, PageHeader, PasswordInput, StatusBadge, useConfirm, useToast } from '../components/ui';
import { useAuth } from '../context/AuthContext';
import { AuthLayout } from '../layouts/AppLayout';
import { uploadAvatar } from '../services/download';
import { SelfService } from './SelfServicePage';
import { EmployeeFormModal } from './admin/EmployeesPage';
import { formatDate } from '../utils/date';
import type { Employee } from '../types';
import { ROLE_LABEL, titleCase } from '../utils/labels';
import { changePasswordSchema, forgotSchema, LoginForm, loginSchema, ProfileForm, profileSchema, resetSchema } from '../validations';

export function LoginPage() {
  const { user, ready, login } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<LoginForm>({ resolver: zodResolver(loginSchema) });

  // Signing in sets the user, and every sign-in lands on the home screen, whatever page sent them here.
  if (ready && user) return <Navigate to="/" replace />;

  const onSubmit = async (values: LoginForm) => {
    setError(null);
    try {
      await login(values.email, values.password);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <AuthLayout title="Sign in" subtitle="Use your work email">
      <form className="space-y-3" onSubmit={handleSubmit(onSubmit)} noValidate>
        {error && <Note>{error}</Note>}
        <Field label="Email" error={errors.email?.message}>
          <Input type="email" autoComplete="username" autoFocus {...register('email')} />
        </Field>
        <Field label="Password" error={errors.password?.message}>
          <PasswordInput autoComplete="current-password" {...register('password')} />
        </Field>
        <Button type="submit" variant="primary" className="w-full" loading={isSubmitting}>Sign in</Button>
        <p className="text-center text-xs"><Link className="text-brand hover:underline" to="/forgot-password">Forgot your password?</Link></p>
      </form>
    </AuthLayout>
  );
}

export function ForgotPasswordPage() {
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<{ email: string }>({ resolver: zodResolver(forgotSchema) });

  const onSubmit = async (values: { email: string }) => {
    setError(null);
    try {
      const res = await api.post('/auth/forgot-password', values);
      setSent(res.data.data.message);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <AuthLayout title="Reset your password" subtitle="We will email you a one-time link">
      {sent ? (
        <Note tone="green">{sent}</Note>
      ) : (
        <form className="space-y-3" onSubmit={handleSubmit(onSubmit)} noValidate>
          {error && <Note>{error}</Note>}
          <Field label="Email" error={errors.email?.message}><Input type="email" autoFocus {...register('email')} /></Field>
          <Button type="submit" variant="primary" className="w-full" loading={isSubmitting}>Send reset link</Button>
        </form>
      )}
      <p className="mt-3 text-center text-xs"><Link className="text-brand hover:underline" to="/login">Back to sign in</Link></p>
    </AuthLayout>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<z.infer<typeof resetSchema>>({ resolver: zodResolver(resetSchema) });

  const onSubmit = async (values: z.infer<typeof resetSchema>) => {
    setError(null);
    try {
      await api.post('/auth/reset-password', { token, password: values.password });
      setDone(true);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <AuthLayout title="Set a new password">
      {done ? (
        <Note tone="green">Your password is set. <Link className="underline" to="/login">Sign in</Link>.</Note>
      ) : !token ? (
        <Note>This link is missing its token. Ask for a new one.</Note>
      ) : (
        <form className="space-y-3" onSubmit={handleSubmit(onSubmit)} noValidate>
          {error && <Note>{error}</Note>}
          <Field label="New password" hint="At least 10 characters, with a letter and a number" error={errors.password?.message}>
            <PasswordInput autoComplete="new-password" autoFocus {...register('password')} />
          </Field>
          <Field label="Confirm password" error={errors.confirm?.message}>
            <PasswordInput autoComplete="new-password" {...register('confirm')} />
          </Field>
          <Button type="submit" variant="primary" className="w-full" loading={isSubmitting}>Save password</Button>
        </form>
      )}
    </AuthLayout>
  );
}

const PROFILE_FIELDS = ['fullName', 'phone'] as const;

function EditProfileModal({ employee, onClose, onSaved }: { employee: Employee; onClose: () => void; onSaved: () => Promise<void> }) {
  const [formError, setFormError] = useState<string | null>(null);
  const { register, handleSubmit, setError, formState: { errors, isSubmitting } } = useForm<ProfileForm>({
    resolver: zodResolver(profileSchema),
    defaultValues: { fullName: employee.fullName, phone: employee.phone ?? '' },
  });

  const onSubmit = async (v: ProfileForm) => {
    setFormError(null);
    try {
      await api.patch('/employees/me', { fullName: v.fullName, phone: v.phone || null });
      await onSaved();
    } catch (err) {
      setFormError(applyServerErrors(err, setError, PROFILE_FIELDS));
    }
  };

  return (
    <Modal
      title="Edit profile"
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="profile-form" loading={isSubmitting}>Save changes</Button></>}
    >
      <form id="profile-form" className="space-y-3" onSubmit={handleSubmit(onSubmit)} noValidate>
        {formError && <Note>{formError}</Note>}
        <Field label="Full name" required error={errors.fullName?.message}><Input {...register('fullName')} /></Field>
        <Field label="Phone" error={errors.phone?.message}><Input type="tel" autoComplete="tel" {...register('phone')} /></Field>
        <p className="text-xs text-muted">Ask HR to change anything else, including your email, gender or team.</p>
      </form>
    </Modal>
  );
}

function ProfilePhoto() {
  const { user, refreshProfile } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const hasPhoto = Boolean(user?.avatarUrl);
  const removePhoto = async () => {
    if (!(await confirm({ title: 'Remove your profile photo?', message: 'Your initials will show instead. You can add a new photo at any time.', confirmLabel: 'Remove photo', tone: 'danger' }))) return;
    await run(() => api.delete('/me/avatar'), 'Profile photo removed');
  };

  const run = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await work();
      await refreshProfile();
      toast(done);
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <div className="mb-4 flex items-center gap-4 border-b border-line pb-4">
      <Avatar url={user?.avatarUrl} name={user?.employee?.fullName ?? user?.email ?? ''} size="large" />
      <div>
        <input ref={fileRef} type="file" accept="image/png,image/jpeg" hidden aria-label="Choose a profile photo" onChange={(ev) => { const file = ev.target.files?.[0]; if (file) void run(() => uploadAvatar(file), hasPhoto ? 'Profile photo changed' : 'Profile photo added'); }} />
        <div className="flex flex-wrap gap-2">
          <Button small loading={busy} onClick={() => fileRef.current?.click()}>{hasPhoto ? 'Change photo' : 'Add photo'}</Button>
          {hasPhoto && <Button small disabled={busy} onClick={() => removePhoto()}>Remove photo</Button>}
        </div>
        <p className="mt-1.5 text-xs text-faint">PNG or JPEG, up to 2 MB</p>
      </div>
    </div>
  );
}

export function AccountPage() {
  const { user, refreshProfile, can } = useAuth();
  // People who manage employees can already change every detail on the People page, including their own.
  const canEditAll = can('employees:write');
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm<z.infer<typeof changePasswordSchema>>({ resolver: zodResolver(changePasswordSchema) });
  const e = user?.employee;

  const onSubmit = async (values: z.infer<typeof changePasswordSchema>) => {
    setError(null);
    try {
      await api.post('/auth/change-password', { currentPassword: values.currentPassword, newPassword: values.newPassword });
      reset();
      await refreshProfile();
      toast('Password changed. Your other devices were signed out.');
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const rows: [string, React.ReactNode][] = e
    ? [
        ['Employee ID', e.employeeId], ['Name', e.fullName], ['Email', e.email], ['Phone', e.phone ?? '—'], ['Gender', e.gender ? titleCase(e.gender) : 'Not recorded'],
        ['Team', e.department?.name ?? '—'], ['Designation', e.designation ?? '—'], ['Reporting manager', e.reportingManager?.fullName ?? '—'],
        ['Location', e.location?.name ?? '—'], ['Joined', formatDate(e.joiningDate)], ['Status', <StatusBadge key="s" status={e.employmentStatus} />],
      ]
    : [['Email', user?.email], ['Role', ROLE_LABEL[user?.role ?? ''] ?? user?.role]];

  return (
    <>
      <PageHeader title="My account" subtitle={e ? (canEditAll ? 'You can update all of your details.' : 'You can update your name and phone. Ask HR to correct anything else, including your gender or email.') : 'Ask HR to correct anything here.'} />
      {user?.mustChangePassword && <div className="mb-4"><Note tone="amber">Change your temporary password to continue using WorkNest.</Note></div>}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Profile" actions={e && <Button small onClick={() => setEditing(true)}>Edit profile</Button>}>
          <ProfilePhoto />
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-[13px]">
            {rows.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-muted">{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </Card>
        <Card title="Change password">
          <form className="space-y-3" onSubmit={handleSubmit(onSubmit)} noValidate>
            {error && <Note>{error}</Note>}
            <Field label="Current password" error={errors.currentPassword?.message}><PasswordInput autoComplete="current-password" {...register('currentPassword')} /></Field>
            <Field label="New password" hint="At least 10 characters, with a letter and a number" error={errors.newPassword?.message}><PasswordInput autoComplete="new-password" {...register('newPassword')} /></Field>
            <Field label="Confirm password" error={errors.confirm?.message}><PasswordInput autoComplete="new-password" {...register('confirm')} /></Field>
            <Button type="submit" variant="primary" loading={isSubmitting}>Change password</Button>
          </form>
        </Card>
      </div>
      {e && <SelfService />}
      {editing && e && canEditAll && (
        <EmployeeFormModal
          employee={e as Employee}
          onClose={() => setEditing(false)}
          onSaved={async () => { await refreshProfile(); setEditing(false); toast('Profile updated'); }}
        />
      )}
      {editing && e && !canEditAll && (
        <EditProfileModal
          employee={e}
          onClose={() => setEditing(false)}
          onSaved={async () => { await refreshProfile(); setEditing(false); toast('Profile updated'); }}
        />
      )}
    </>
  );
}
