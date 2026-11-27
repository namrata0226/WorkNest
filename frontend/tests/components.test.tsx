import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { LoginChallenge } from '../src/context/AuthContext';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';
import { CalendarEvent, CalendarHoliday, LeaveCalendar, toFullCalendarEvents, VisibleRange } from '../src/components/LeaveCalendar';
import { Button, DataTable, Modal, Pagination, StatusBadge, ToastProvider, useConfirm, useToast } from '../src/components/ui';
import { ApprovalsPage } from '../src/pages/ApprovalsPage';
import { useInfiniteFetch } from '../src/hooks/useInfiniteFetch';
import { InfiniteLoader } from '../src/components/ui';
import { AppLayout } from '../src/layouts/AppLayout';
import { ItemModal } from '../src/components/planner/ItemModal';
import { ExpensesPage } from '../src/pages/ExpensesPage';
import { expenseSchema } from '../src/validations';
import { AuthProvider } from '../src/context/AuthContext';
import { EmployeeFormModal } from '../src/pages/admin/EmployeesPage';
import { ApplyLeavePage } from '../src/pages/ApplyLeavePage';
import { AccountPage, LoginPage } from '../src/pages/AuthPages';
import { AttendancePage, PunchCard } from '../src/pages/AttendancePage';
import { EmailActionPage } from '../src/pages/EmailActionPage';
import { SelfService } from '../src/pages/SelfServicePage';
import { LeaveTypesPage } from '../src/pages/admin/LeaveTypesPage';
import { RequireAuth, RequirePermission } from '../src/routes/AppRoutes';
import type { CurrentUser } from '../src/types';

const employee = { _id: 'e1', employeeId: 'EMP003', fullName: 'Sara Khan', email: 's@x.co', joiningDate: '2020-01-01', employmentStatus: 'ACTIVE', category: 'PERMANENT' };
const asEmployee: CurrentUser = { id: 'u1', email: 's@x.co', role: 'EMPLOYEE', permissions: [], mustChangePassword: false, employee: employee as CurrentUser['employee'] };

function mockApi(routes: Record<string, unknown>, user: CurrentUser | null = asEmployee) {
  const get = vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
    if (url === '/auth/me') {
      if (!user) throw Object.assign(new Error('401'), { response: { status: 401, data: {} } });
      return { data: { data: user } };
    }
    return { data: { data: routes[url] ?? [] } };
  });
  return { get };
}

function ShowLocation() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

const renderApp = (ui: React.ReactNode, path = '/') =>
  render(<MemoryRouter initialEntries={[path]}><AuthProvider><ToastProvider>{ui}</ToastProvider></AuthProvider></MemoryRouter>);

describe('route guards', () => {
  it('sends signed-out visitors to the login page', async () => {
    mockApi({}, null);
    renderApp(
      <Routes>
        <Route path="/login" element={<div>login screen</div>} />
        <Route path="/secret" element={<RequireAuth><div>secret</div></RequireAuth>} />
      </Routes>,
      '/secret',
    );
    expect(await screen.findByText('login screen')).toBeInTheDocument();
    expect(screen.queryByText('secret')).not.toBeInTheDocument();
  });

  it('hides a page from someone without the permission', async () => {
    mockApi({});
    renderApp(<RequireAuth><RequirePermission permission="reports:read"><div>reports</div></RequirePermission></RequireAuth>);
    expect(await screen.findByText(/do not have access/)).toBeInTheDocument();
    expect(screen.queryByText('reports')).not.toBeInTheDocument();
  });

  it('shows a page to someone with the permission', async () => {
    mockApi({}, { ...asEmployee, role: 'HR_ADMIN', permissions: ['reports:read'] });
    renderApp(<RequireAuth><RequirePermission permission="reports:read"><div>reports</div></RequirePermission></RequireAuth>);
    expect(await screen.findByText('reports')).toBeInTheDocument();
  });
});

describe('opening a link from an email', () => {
  const app = (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/" element={<RequireAuth><ShowLocation /></RequireAuth>} />
      <Route path="/approvals" element={<RequireAuth><ShowLocation /></RequireAuth>} />
    </Routes>
  );

  it('asks a signed-out person to sign in, then goes to the home screen', async () => {
    mockApi({}, null);
    mockLoginFlow();
    renderApp(app, '/approvals?request=abc123');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/Email/), 's@x.co');
    await user.type(screen.getByLabelText(/Password/), 'secret-pass-1');
    await user.click(screen.getByRole('button', { name: /sign in/i }));
    await user.click(await screen.findByRole('button', { name: 'Send OTP' }));
    // Typing the last digit submits by itself.
    await user.type(await screen.findByLabelText('Digit 1 of 6'), '123456');
    expect(await screen.findByTestId('location')).toHaveTextContent(/^\/$/);
  });

  it('opens the request directly when already signed in', async () => {
    mockApi({});
    renderApp(app, '/approvals?request=abc123');
    expect(await screen.findByTestId('location')).toHaveTextContent('/approvals?request=abc123');
  });
});

const CHALLENGE: LoginChallenge = {
  challengeToken: 'c'.repeat(43),
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  destination: 's*****@x.co',
};

/** Password, then a code, then verification, each answered as the server would. */
function mockLoginFlow(challenge: LoginChallenge = CHALLENGE) {
  return vi.spyOn(api, 'post').mockImplementation(async (url: string) => {
    if (url === '/auth/login') return { data: { data: challenge } };
    if (url === '/auth/otp/send') {
      return { data: { data: { destination: challenge.destination, resendAt: new Date(Date.now() + 30_000).toISOString(), codeExpiresAt: new Date(Date.now() + 300_000).toISOString() } } };
    }
    if (url === '/auth/otp/verify') return { data: { data: asEmployee } };
    throw new Error(`unexpected ${url}`);
  });
}

describe('login page', () => {
  it('emails the code with no mobile option, then shows six boxes and a 30 second resend timer', async () => {
    mockApi({}, null);
    const post = mockLoginFlow();
    renderApp(<LoginPage />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Email'), 's@x.co');
    await user.type(screen.getByLabelText('Password'), 'secret-pass-1');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('s*****@x.co')).toBeInTheDocument();
    expect(screen.queryByText(/mobile/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Send OTP' }));
    expect(post).toHaveBeenCalledWith('/auth/otp/send', { challengeToken: CHALLENGE.challengeToken });
    expect(await screen.findAllByLabelText(/Digit \d of 6/)).toHaveLength(6);
    expect(screen.getByText(/resend in/)).toHaveTextContent(/0:(30|29)/);
    expect(screen.queryByRole('button', { name: /resend OTP/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Verify OTP' })).toBeDisabled();
  });

  it('fills every box from a pasted code and signs in', async () => {
    mockApi({}, null);
    const post = mockLoginFlow();
    renderApp(<LoginPage />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Email'), 's@x.co');
    await user.type(screen.getByLabelText('Password'), 'secret-pass-1');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await user.click(await screen.findByRole('button', { name: 'Send OTP' }));
    await user.click(await screen.findByLabelText('Digit 1 of 6'));
    await user.paste('123456');
    expect(post).toHaveBeenCalledWith('/auth/otp/verify', { challengeToken: CHALLENGE.challengeToken, code: '123456' });
  });

  it('shows a countdown while the account is locked and keeps Sign in disabled', async () => {
    mockApi({}, null);
    const lockedUntil = new Date(Date.now() + 15 * 60_000).toISOString();
    vi.spyOn(api, 'post').mockRejectedValue({ response: { status: 423, data: { error: { code: 'ACCOUNT_LOCKED', message: 'Locked', meta: { lockedUntil } } } } });
    renderApp(<LoginPage />);
    await userEvent.type(await screen.findByLabelText('Email'), 'a@b.co');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText(/(15:00|14:59)/, { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Locked/ })).toBeDisabled();
  });

  it('validates before calling the server', async () => {
    mockApi({}, null);
    const post = vi.spyOn(api, 'post');
    renderApp(<LoginPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Email is required')).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it('shows the server message on failure', async () => {
    mockApi({}, null);
    vi.spyOn(api, 'post').mockRejectedValue({ response: { status: 401, data: { error: { message: 'Invalid email or password' } } } });
    renderApp(<LoginPage />);
    await userEvent.type(await screen.findByLabelText('Email'), 'a@b.co');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password');
  });
});

describe('employee form', () => {
  it('shows the saved team, manager and location once its options have loaded', async () => {
    mockApi({
      '/departments': [{ _id: 'd1', name: 'Engineering' }],
      '/locations': [{ _id: 'l1', name: 'Mumbai' }],
      '/leave-policies': [],
      '/employees': [{ _id: 'm1', fullName: 'A Manager', employeeId: 'EMP001' }],
    });
    const saved = { ...employee, gender: 'FEMALE', department: { _id: 'd1', name: 'Engineering' }, location: { _id: 'l1', name: 'Mumbai' }, reportingManager: { _id: 'm1', fullName: 'A Manager', employeeId: 'EMP001' } } as NonNullable<CurrentUser['employee']>;
    renderApp(<EmployeeFormModal employee={saved} onClose={() => undefined} onSaved={() => undefined} />);
    expect(await screen.findByLabelText(/^Team/)).toHaveValue('d1');
    expect(screen.getByLabelText(/Office location/)).toHaveValue('l1');
    expect(screen.getByLabelText(/Reporting manager/)).toHaveValue('m1');
    expect(screen.getByLabelText(/Gender/)).toHaveValue('FEMALE');
  });
});

describe('my account', () => {
  const female = { ...asEmployee, employee: { ...employee, gender: 'FEMALE', phone: '+91 98765 43210' } } as CurrentUser;

  it('shows gender, and "Not recorded" when there is none', async () => {
    mockApi({}, female);
    const { unmount } = renderApp(<AccountPage />);
    expect(await screen.findByText('Female')).toBeInTheDocument();
    unmount();
    mockApi({});
    renderApp(<AccountPage />);
    expect(await screen.findByText('Not recorded')).toBeInTheDocument();
  });

  it('updates only the name and phone, then shows the saved details', async () => {
    const { get } = mockApi({}, female);
    const patch = vi.spyOn(api, 'patch').mockResolvedValue({ data: { data: {} } });
    const user = userEvent.setup();
    renderApp(<AccountPage />);
    await user.click(await screen.findByRole('button', { name: 'Edit profile' }));
    expect(screen.queryByRole('combobox', { name: /Gender/ })).not.toBeInTheDocument();
    const name = screen.getByLabelText(/Full name/);
    await user.clear(name);
    await user.type(name, 'Sara K');
    const calls = get.mock.calls.length;
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/employees/me', { fullName: 'Sara K', phone: '+91 98765 43210' }));
    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(calls));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument());
  });

  it('checks the phone number before calling the server', async () => {
    mockApi({}, female);
    const patch = vi.spyOn(api, 'patch').mockClear();
    const user = userEvent.setup();
    renderApp(<AccountPage />);
    await user.click(await screen.findByRole('button', { name: 'Edit profile' }));
    const phone = screen.getByLabelText(/Phone/);
    await user.clear(phone);
    await user.type(phone, 'abc');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Enter a valid phone number')).toBeInTheDocument();
    expect(patch).not.toHaveBeenCalled();
  });
});

describe('attendance', () => {
  const today = (over: object = {}) => ({ date: '2030-03-04', punchIn: null, punchOut: null, workedMinutes: null, ...over });

  const mockToday = (states: object[]) => {
    let i = 0;
    vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
      if (url === '/auth/me') return { data: { data: asEmployee } };
      if (url === '/attendance/my/today') return { data: { data: states[Math.min(i, states.length - 1)] } };
      return { data: { data: [] } };
    });
    return { advance: () => { i++; } };
  };

  it('punches in without sending a time, then offers punch out', async () => {
    const { advance } = mockToday([today(), today({ punchIn: '09:30' })]);
    const post = vi.spyOn(api, 'post').mockClear().mockImplementation(async () => { advance(); return { data: { data: {} } }; });
    const user = userEvent.setup();
    renderApp(<PunchCard />);
    await user.click(await screen.findByRole('button', { name: 'Punch in' }));
    expect(post).toHaveBeenCalledWith('/attendance/punch-in', {});
    expect(await screen.findByRole('button', { name: 'Punch out' })).toBeInTheDocument();
    expect(screen.getByTestId('punch-in')).toHaveTextContent('09:30');
    expect(screen.queryByRole('button', { name: 'Punch in' })).not.toBeInTheDocument();
  });

  it('shows the day as finished after punching out', async () => {
    mockToday([today({ punchIn: '09:30', punchOut: '18:15', workedMinutes: 525 })]);
    renderApp(<PunchCard />);
    expect(await screen.findByText('Done for today')).toBeInTheDocument();
    expect(screen.getByText('8h 45m')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Punch/ })).not.toBeInTheDocument();
  });

  it('shows the server message when a punch is refused', async () => {
    mockToday([today()]);
    vi.spyOn(api, 'post').mockRejectedValue(Object.assign(new Error('x'), { isAxiosError: true, response: { status: 409, data: { error: { message: 'You have already punched in today' } } } }));
    const user = userEvent.setup();
    renderApp(<PunchCard />);
    await user.click(await screen.findByRole('button', { name: 'Punch in' }));
    expect(await screen.findByText('You have already punched in today')).toBeInTheDocument();
  });

  it('applies for work from home with only dates and a reason', async () => {
    mockToday([today()]);
    const post = vi.spyOn(api, 'post').mockClear().mockResolvedValue({ data: { data: {} } });
    const user = userEvent.setup();
    renderApp(<AttendancePage />);
    await user.click(await screen.findByRole('button', { name: 'Apply for work from home' }));
    fireEvent.change(screen.getByLabelText(/Start date/), { target: { value: '2030-03-05' } });
    await waitFor(() => expect(screen.getByLabelText(/End date/)).toHaveValue('2030-03-05'));
    await user.click(screen.getByRole('button', { name: 'Submit request' }));
    expect(await screen.findByText('A reason is required')).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText(/Reason/), 'Engineer visiting');
    await user.click(screen.getByRole('button', { name: 'Submit request' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/wfh', { startDate: '2030-03-05', endDate: '2030-03-05', reason: 'Engineer visiting' }));
  });
});

describe('deciding from an email', () => {
  const preview = { title: 'Leave request', employee: 'Sara Khan', decidable: true, lines: [{ label: 'Dates', value: '2030-03-04 to 2030-03-04' }] };
  const route = (_query: string) => <Routes><Route path="/email-action" element={<EmailActionPage />} /></Routes>;

  it('changes nothing until the button is pressed, then confirms', async () => {
    const post = vi.spyOn(api, 'post').mockClear().mockResolvedValue({ data: { data: preview } });
    mockApi({}, null);
    const user = userEvent.setup();
    renderApp(route(''), '/email-action?token=abc&decision=approve');
    await screen.findByText('From Sara Khan');
    expect(post.mock.calls.map(([u]) => u)).toEqual(['/email-actions/preview']);
    await user.click(screen.getByRole('button', { name: 'Confirm approval' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/email-actions/decide', { token: 'abc', decision: 'approve' }));
    expect(await screen.findByText(/Approved\. The employee has been told/)).toBeInTheDocument();
  });

  it('needs a reason to reject', async () => {
    const post = vi.spyOn(api, 'post').mockClear().mockResolvedValue({ data: { data: preview } });
    mockApi({}, null);
    const user = userEvent.setup();
    renderApp(route(''), '/email-action?token=abc&decision=reject');
    const confirm = await screen.findByRole('button', { name: 'Confirm rejection' });
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText(/Reason/), 'Team event');
    await user.click(confirm);
    await waitFor(() => expect(post).toHaveBeenCalledWith('/email-actions/decide', { token: 'abc', decision: 'reject', reason: 'Team event' }));
  });

  it('says so when the request was already decided', async () => {
    vi.spyOn(api, 'post').mockClear().mockResolvedValue({ data: { data: { ...preview, decidable: false } } });
    mockApi({}, null);
    renderApp(route(''), '/email-action?token=abc');
    expect(await screen.findByText(/already been decided/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Confirm/ })).not.toBeInTheDocument();
  });
});

describe('self-service', () => {
  it('saves details without re-sending an account number left blank', async () => {
    const put = vi.spyOn(api, 'put').mockClear().mockResolvedValue({ data: { data: {} } });
    mockApi({ '/me/details': { bank: { holderName: 'Sara', bankName: 'HDFC', ifsc: 'HDFC0001234', accountLast4: '6789' }, emergencyContacts: [], address: null } });
    const user = userEvent.setup();
    renderApp(<SelfService />);
    expect(await screen.findByText(/account ending 6789/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Update' }));
    await user.click(screen.getByRole('button', { name: 'Save details' }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(put.mock.calls[0][1]).toMatchObject({ bank: { holderName: 'Sara', ifsc: 'HDFC0001234' } });
    expect((put.mock.calls[0][1] as { bank: object }).bank).not.toHaveProperty('accountNumber');
  });

  it('lets an employee tick only their own checklist items', async () => {
    mockApi({ '/me/details': {}, '/me/checklists': [{ _id: 'c1', kind: 'ONBOARDING', items: [{ _id: 'i1', label: 'Submit ID proof', owner: 'EMPLOYEE', done: false, doneByName: null }, { _id: 'i2', label: 'Issue laptop', owner: 'HR', done: false, doneByName: null }] }] });
    renderApp(<SelfService />);
    expect(await screen.findByRole('checkbox', { name: 'Submit ID proof' })).toBeEnabled();
    expect(screen.getByRole('checkbox', { name: 'Issue laptop' })).toBeDisabled();
  });
});

describe('profile photo', () => {
  const photo = '/me/avatar?v=abc';
  const withPhoto = { ...asEmployee, avatarUrl: photo };

  beforeEach(() => {
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:photo'), revokeObjectURL: vi.fn() });
  });

  it('offers to add one, showing initials until then', async () => {
    mockApi({});
    renderApp(<AccountPage />);
    expect(await screen.findByRole('button', { name: 'Add photo' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove photo' })).not.toBeInTheDocument();
    expect(screen.getByText('SK')).toBeInTheDocument();
  });

  it('uploads the chosen image and then shows it', async () => {
    let current: CurrentUser = asEmployee;
    vi.spyOn(api, 'get').mockImplementation(async (url: string) => (url === '/auth/me' ? { data: { data: current } } : { data: new Blob() }));
    const put = vi.spyOn(api, 'put').mockImplementation(async () => { current = withPhoto; return { data: { data: withPhoto } }; });
    const user = userEvent.setup();
    renderApp(<AccountPage />);
    await screen.findByRole('button', { name: 'Add photo' });
    await user.upload(screen.getByLabelText('Choose a profile photo'), new File(['x'], 'me.png', { type: 'image/png' }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/me/avatar', expect.any(FormData)));
    expect(await screen.findByRole('img', { name: /profile photo/ })).toHaveAttribute('src', 'blob:photo');
    expect(screen.getByRole('button', { name: 'Change photo' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove photo' })).toBeInTheDocument();
  });

  it('removes it and goes back to initials', async () => {
    let current: CurrentUser = withPhoto;
    vi.spyOn(api, 'get').mockImplementation(async (url: string) => (url === '/auth/me' ? { data: { data: current } } : { data: new Blob() }));
    const del = vi.spyOn(api, 'delete').mockImplementation(async () => { current = asEmployee; return { data: { data: asEmployee } }; });
    const user = userEvent.setup();
    renderApp(<AccountPage />);
    await user.click(await screen.findByRole('button', { name: 'Remove photo' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove your profile photo?' });
    expect(del).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Remove photo' }));
    await waitFor(() => expect(del).toHaveBeenCalledWith('/me/avatar'));
    await screen.findByRole('button', { name: 'Add photo' });
    expect(screen.queryByRole('img', { name: /profile photo/ })).not.toBeInTheDocument();
  });

  it('shows the server message when an upload is refused, and keeps the photo', async () => {
    mockApi({}, withPhoto);
    vi.spyOn(api, 'put').mockRejectedValue(Object.assign(new Error('x'), { isAxiosError: true, response: { status: 422, data: { error: { message: 'A profile photo must be 2 MB or smaller' } } } }));
    const user = userEvent.setup();
    renderApp(<AccountPage />);
    await screen.findByRole('button', { name: 'Change photo' });
    await user.upload(screen.getByLabelText('Choose a profile photo'), new File(['x'], 'me.png', { type: 'image/png' }));
    expect(await screen.findByText('A profile photo must be 2 MB or smaller')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove photo' })).toBeInTheDocument();
  });
});

describe('removing an attachment', () => {
  const types = [{ _id: 't1', name: 'Casual Leave', code: 'CL', kind: 'STANDARD', isPaid: true, halfDayAllowed: true, requiresDocument: false, documentRequiredAfterDays: null, minNoticeDays: 0, description: null }];
  const pdf = () => new File(['%PDF-1.7'], 'note.pdf', { type: 'application/pdf' });

  it('deletes the upload, offers the picker again and submits without it', async () => {
    mockApi({ '/leave-types/available': types, '/leave-balances/my': [] });
    const post = vi.spyOn(api, 'post').mockImplementation(async (url: string) => {
      if (url === '/files') return { data: { data: { id: 'f1', originalName: 'note.pdf' } } };
      if (url === '/leaves/preview') return { data: { data: { totalDays: 1, dayBreakdown: [], excluded: [], documentRequired: false, halfDayAllowed: true, issues: [] } } };
      return { data: { data: { _id: 'r1', status: 'PENDING' } } };
    });
    const del = vi.spyOn(api, 'delete').mockResolvedValue({ data: { data: { deleted: true } } });
    renderApp(<RequireAuth><ApplyLeavePage /></RequireAuth>);
    const user = userEvent.setup();
    await screen.findByRole('option', { name: 'Casual Leave (CL)' });
    await user.selectOptions(screen.getByLabelText(/Leave type/), 't1');
    await user.upload(screen.getByLabelText(/Supporting document/), pdf());

    await user.click(await screen.findByRole('button', { name: 'Remove note.pdf' }));
    expect(del).toHaveBeenCalledWith('/files/f1');
    expect(screen.queryByText('note.pdf')).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Supporting document/)).toHaveAttribute('type', 'file');

    await waitFor(() => expect(screen.getByTestId('calculated-days')).toBeInTheDocument());
    await user.type(screen.getByLabelText(/Reason/), 'Family trip');
    await user.click(screen.getByRole('button', { name: 'Submit request' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/leaves', expect.anything(), expect.anything()));
    expect(post.mock.calls.find(([u]) => u === '/leaves')![1]).toMatchObject({ document: null });
  });

  it('keeps the attachment when it is submitted', async () => {
    mockApi({ '/leave-types/available': types, '/leave-balances/my': [] });
    vi.spyOn(api, 'post').mockResolvedValue({ data: { data: { id: 'f1', originalName: 'note.pdf' } } });
    const del = vi.spyOn(api, 'delete');
    renderApp(<RequireAuth><ApplyLeavePage /></RequireAuth>);
    const user = userEvent.setup();
    await user.upload(await screen.findByLabelText(/Supporting document/), pdf());
    expect(await screen.findByText('note.pdf')).toBeInTheDocument();
    expect(del).not.toHaveBeenCalled();
  });
});

describe('leave application form', () => {
  const types = [{ _id: 't1', name: 'Casual Leave', code: 'CL', kind: 'STANDARD', isPaid: true, halfDayAllowed: true, requiresDocument: false, documentRequiredAfterDays: null, minNoticeDays: 0, description: null }];
  const balances = [{ leaveType: { _id: 't1', name: 'Casual Leave', code: 'CL', color: '#000' }, isCompOff: false, year: 2030, available: 10 }];
  const preview = (over: object = {}) => ({ totalDays: 2, dayBreakdown: [], excluded: [{ date: '2030-03-02', reason: 'WEEKLY_OFF', label: 'Saturday' }], documentRequired: false, halfDayAllowed: true, issues: [], ...over });

  const fill = async () => {
    const user = userEvent.setup();
    await screen.findByRole('option', { name: 'Casual Leave (CL)' });
    await user.selectOptions(screen.getByLabelText(/Leave type/), 't1');
    return user;
  };

  it('fills in the employee and shows the duration the server calculated', async () => {
    mockApi({ '/leave-types/available': types, '/leave-balances/my': balances });
    vi.spyOn(api, 'post').mockResolvedValue({ data: { data: preview() } });
    renderApp(<RequireAuth><ApplyLeavePage /></RequireAuth>);
    await fill();
    expect(screen.getByDisplayValue('Sara Khan')).toBeDisabled();
    expect(screen.getByDisplayValue('EMP003')).toBeDisabled();
    await waitFor(() => expect(screen.getByTestId('calculated-days')).toHaveTextContent('2'));
    expect(screen.getByText('Saturday')).toBeInTheDocument();
  });

  it('never sends a day count, and sends an idempotency key', async () => {
    mockApi({ '/leave-types/available': types, '/leave-balances/my': balances });
    const post = vi.spyOn(api, 'post').mockImplementation(async (url: string) => (url === '/leaves/preview' ? { data: { data: preview() } } : { data: { data: { _id: 'r1' } } }));
    renderApp(<RequireAuth><ApplyLeavePage /></RequireAuth>);
    const user = await fill();
    await waitFor(() => expect(screen.getByTestId('calculated-days')).toBeInTheDocument());
    await user.type(screen.getByLabelText(/Reason/), 'Family trip');
    await user.click(screen.getByRole('button', { name: 'Submit request' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/leaves', expect.anything(), expect.anything()));
    const [, body, config] = post.mock.calls.find(([u]) => u === '/leaves')!;
    expect(body).not.toHaveProperty('totalDays');
    expect(body).not.toHaveProperty('status');
    expect((config as { headers: Record<string, string> }).headers['Idempotency-Key']).toBeTruthy();
  });

  it('blocks submission and explains when the server finds a problem', async () => {
    mockApi({ '/leave-types/available': types, '/leave-balances/my': balances });
    vi.spyOn(api, 'post').mockResolvedValue({ data: { data: preview({ totalDays: 0, issues: [{ path: 'startDate', message: 'The selected dates contain no working days' }] }) } });
    renderApp(<RequireAuth><ApplyLeavePage /></RequireAuth>);
    await fill();
    expect(await screen.findByText('The selected dates contain no working days')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Submit request' })).toBeDisabled();
  });

  it('keeps an ineligible type in the list, and explains and blocks once it is chosen', async () => {
    const reason = 'Paternity Leave is only available to male employees';
    const withPaternity = [...types, { ...types[0], _id: 't2', name: 'Paternity Leave', code: 'PAT', requiresApproval: false, ineligibleReason: reason }];
    mockApi({ '/leave-types/available': withPaternity, '/leave-balances/my': balances });
    const post = vi.spyOn(api, 'post').mockClear().mockResolvedValue({ data: { data: preview() } });
    renderApp(<RequireAuth><ApplyLeavePage /></RequireAuth>);
    const user = userEvent.setup();
    await screen.findByRole('option', { name: 'Paternity Leave (PAT)' });
    expect(screen.queryByText(reason)).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText(/Leave type/), 't2');
    expect(await screen.findByRole('alert')).toHaveTextContent(reason);
    expect(screen.getByRole('button', { name: 'Submit request' })).toBeDisabled();
    expect(screen.queryByText(/approved automatically/)).not.toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(post).not.toHaveBeenCalled();

    await user.selectOptions(screen.getByLabelText(/Leave type/), 't1');
    expect(await screen.findByTestId('calculated-days')).toHaveTextContent('2');
    expect(screen.queryByText(reason)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Submit request' })).toBeEnabled();
  });

  describe('dates', () => {
    const start = () => screen.getByLabelText(/Start date/);
    const end = () => screen.getByLabelText(/End date/);
    const pick = (input: HTMLElement, value: string) => fireEvent.change(input, { target: { value } });

    const open = async () => {
      mockApi({ '/leave-types/available': types, '/leave-balances/my': balances });
      vi.spyOn(api, 'post').mockResolvedValue({ data: { data: preview() } });
      renderApp(<RequireAuth><ApplyLeavePage /></RequireAuth>);
      await screen.findByRole('option', { name: 'Casual Leave (CL)' });
    };

    it('moves the end date with the start date until one has been chosen', async () => {
      await open();
      pick(start(), '2030-03-04');
      await waitFor(() => expect(end()).toHaveValue('2030-03-04'));
      pick(start(), '2030-03-01');
      await waitFor(() => expect(end()).toHaveValue('2030-03-01'));
    });

    it('keeps a chosen end date, unless the start date passes it', async () => {
      await open();
      pick(start(), '2030-03-04');
      await waitFor(() => expect(end()).toHaveValue('2030-03-04'));
      pick(end(), '2030-03-08');
      pick(start(), '2030-03-05');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(end()).toHaveValue('2030-03-08');
      pick(start(), '2030-03-11');
      await waitFor(() => expect(end()).toHaveValue('2030-03-11'));
    });

    it('explains and blocks an end date typed before the start date', async () => {
      await open();
      await userEvent.setup().selectOptions(screen.getByLabelText(/Leave type/), 't1');
      pick(start(), '2030-03-04');
      await screen.findByTestId('calculated-days');
      pick(end(), '2030-03-01');
      expect(await screen.findByText('The end date cannot be before the start date')).toBeInTheDocument();
      await waitFor(() => expect(screen.getByRole('button', { name: 'Submit request' })).toBeDisabled());
    });
  });

  describe('reason', () => {
    const auto = [...types, { ...types[0], _id: 't2', name: 'Menstrual Leave', code: 'MNL', requiresApproval: false }];

    const choose = async (id: string) => {
      mockApi({ '/leave-types/available': auto, '/leave-balances/my': balances });
      const post = vi.spyOn(api, 'post').mockClear().mockResolvedValue({ data: { data: { ...preview(), status: 'APPROVED' } } });
      renderApp(<RequireAuth><ApplyLeavePage /></RequireAuth>);
      const user = userEvent.setup();
      await screen.findByRole('option', { name: 'Menstrual Leave (MNL)' });
      await user.selectOptions(screen.getByLabelText(/Leave type/), id);
      await screen.findByTestId('calculated-days');
      return { user, post };
    };
    const submitted = (post: { mock: { calls: unknown[][] } }) => post.mock.calls.filter(([url]) => url === '/leaves');

    it('can be left empty on leave that is approved automatically', async () => {
      const { user, post } = await choose('t2');
      expect(screen.getByText('Optional for this leave.')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Submit request' }));
      await waitFor(() => expect(submitted(post)).toHaveLength(1));
      expect(submitted(post)[0][1]).toMatchObject({ leaveType: 't2', reason: null });
    });

    it('is still needed for leave that goes to an approver', async () => {
      const { user, post } = await choose('t1');
      expect(screen.queryByText('Optional for this leave.')).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Submit request' }));
      expect(await screen.findByText('A reason is required')).toBeInTheDocument();
      expect(submitted(post)).toHaveLength(0);
    });

    it('clears the error when switching to leave that does not need one', async () => {
      const { user } = await choose('t1');
      await user.click(screen.getByRole('button', { name: 'Submit request' }));
      await screen.findByText('A reason is required');
      await user.selectOptions(screen.getByLabelText(/Leave type/), 't2');
      await waitFor(() => expect(screen.queryByText('A reason is required')).not.toBeInTheDocument());
    });
  });

  it('asks for a document when the policy requires one', async () => {
    mockApi({ '/leave-types/available': types, '/leave-balances/my': balances });
    vi.spyOn(api, 'post').mockResolvedValue({ data: { data: preview({ documentRequired: true }) } });
    renderApp(<RequireAuth><ApplyLeavePage /></RequireAuth>);
    await fill();
    expect(await screen.findByText('This request needs a supporting document.')).toBeInTheDocument();
  });
});

const event = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: 'r1:0', requestId: 'r1', start: '2030-03-04', endExclusive: '2030-03-06', status: 'APPROVED', dayType: 'FULL', halfSession: null,
  employee: { fullName: 'Asha Rao', employeeId: 'E1', department: 'Eng' }, leaveType: { name: 'Casual', code: 'CL', color: '#0f766e' }, ...over,
});
const holiday: CalendarHoliday = { id: 'h1', name: 'Holi', date: '2030-03-20', category: 'FESTIVAL', isHalfDay: false };

describe('calendar', () => {
  it('names the employee and leave type, and marks pending and half days', () => {
    const [approved, pending, half] = toFullCalendarEvents([event(), event({ id: 'r2:0', status: 'PENDING' }), event({ id: 'r3:0', dayType: 'HALF', halfSession: 'FIRST' })], [], true);
    expect(approved.title).toBe('Asha Rao · CL');
    expect(approved.backgroundColor).toBe('#0f766e');
    expect(approved.classNames).toContain('leave-approved');
    expect(pending.title).toBe('Asha Rao · CL · pending');
    expect(pending.classNames).toContain('leave-pending');
    expect(half.title).toContain('1st half');
  });

  it('labels by leave type on a personal calendar', () => {
    expect(toFullCalendarEvents([event()], [], false)[0].title).toBe('Casual');
  });

  it('draws holidays as background markers on their date', () => {
    const [h] = toFullCalendarEvents([], [holiday], true);
    expect(h.display).toBe('background');
    expect(h.start).toBe('2030-03-20');
    expect(h.end).toBe('2030-03-21');
  });

  // Regression: an inline `locales` array once made datesSet fire on every render, looping through parent state.
  it('does not loop when the parent stores the range and passes new data', async () => {
    const onRange = vi.fn();
    function Parent() {
      const [range, setRange] = useState<VisibleRange | null>(null);
      const [events, setEvents] = useState<CalendarEvent[]>([]);
      return (
        <>
          <button onClick={() => setEvents([event({ start: range!.start, endExclusive: range!.end })])}>load</button>
          <LeaveCalendar events={events} holidays={[holiday]} onRange={(r) => { onRange(r); setRange(r); }} />
        </>
      );
    }
    render(<Parent />);
    await waitFor(() => expect(onRange).toHaveBeenCalled());
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(onRange).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByText('load'));
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(onRange).toHaveBeenCalledTimes(1);
    expect(onRange.mock.calls[0][0].month).toMatch(/^\d{4}-\d{2}$/);
  });

  it('reports navigation to a new month', async () => {
    const onRange = vi.fn();
    const { container } = render(<LeaveCalendar events={[]} holidays={[]} onRange={onRange} />);
    await waitFor(() => expect(onRange).toHaveBeenCalledTimes(1));
    await userEvent.click(container.querySelector('.fc-next-button')!);
    await waitFor(() => expect(onRange).toHaveBeenCalledTimes(2));
    expect(onRange.mock.calls[1][0].month).not.toBe(onRange.mock.calls[0][0].month);
  });
});

describe('shared components', () => {
  const columns = [{ header: 'Name', cell: (r: { n: string }) => r.n }];

  it('shows an empty message rather than an empty table', () => {
    render(<DataTable columns={columns} rows={[]} rowKey={(r) => r.n} empty="Nothing here" />);
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('opens a row by mouse and by keyboard', async () => {
    const onRowClick = vi.fn();
    render(<DataTable columns={columns} rows={[{ n: 'One' }]} rowKey={(r) => r.n} onRowClick={onRowClick} />);
    await userEvent.click(screen.getByText('One'));
    screen.getByText('One').closest('tr')!.focus();
    await userEvent.keyboard('{Enter}');
    expect(onRowClick).toHaveBeenCalledTimes(2);
  });

  it('disables paging at the ends and hides for one page', async () => {
    const onPage = vi.fn();
    const { rerender, container } = render(<Pagination meta={{ page: 1, limit: 10, total: 25, totalPages: 3 }} onPage={onPage} />);
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(onPage).toHaveBeenCalledWith(2);
    rerender(<Pagination meta={{ page: 1, limit: 10, total: 5, totalPages: 1 }} onPage={onPage} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('closes a dialog with Escape', async () => {
    const onClose = vi.fn();
    render(<Modal title="Title" onClose={onClose}>Body</Modal>);
    expect(screen.getByRole('dialog', { name: 'Title' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('gives each status a readable label', () => {
    render(<StatusBadge status="CANCELLATION_REQUESTED" />);
    expect(screen.getByText('Cancellation requested')).toBeInTheDocument();
  });
});

describe('buttons that start work', () => {
  it('runs an action once while it is still in progress', async () => {
    let finish!: () => void;
    const onClick = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<Button onClick={onClick}>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button, { detail: 2 });
    expect(onClick).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(button).toBeDisabled());
    await act(async () => finish());
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('ignores the second click of a double-click', () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Go</Button>);
    const button = screen.getByRole('button', { name: 'Go' });
    fireEvent.click(button, { detail: 1 });
    fireEvent.click(button, { detail: 2 });
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('confirmation dialog', () => {
  function Harness({ onResult }: { onResult: (ok: boolean) => void }) {
    const confirm = useConfirm();
    return <Button onClick={async () => onResult(await confirm({ title: 'Delete holiday?', confirmLabel: 'Delete', tone: 'danger' }))}>Open</Button>;
  }

  it.each([
    ['confirming', 'Delete', true],
    ['cancelling', 'Cancel', false],
  ])('resolves when %s', async (_name, press, expected) => {
    const onResult = vi.fn();
    const user = userEvent.setup();
    render(<ToastProvider><Harness onResult={onResult} /></ToastProvider>);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete holiday?' });
    await user.click(within(dialog).getByRole('button', { name: press }));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(expected));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes only the top dialog on Escape', async () => {
    const onResult = vi.fn();
    const outerClose = vi.fn();
    const user = userEvent.setup();
    render(<ToastProvider><Modal title="Outer" onClose={outerClose}><Harness onResult={onResult} /></Modal></ToastProvider>);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await screen.findByRole('dialog', { name: 'Delete holiday?' });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(false));
    expect(outerClose).not.toHaveBeenCalled();
  });
});

describe('toasts', () => {
  it('shows a dismissible message', async () => {
    function Trigger() {
      const toast = useToast();
      return <button type="button" onClick={() => toast('Saved')}>Toast</button>;
    }
    const user = userEvent.setup();
    render(<ToastProvider><Trigger /></ToastProvider>);
    await user.click(screen.getByRole('button', { name: 'Toast' }));
    const message = await screen.findByRole('status');
    expect(message).toHaveTextContent('Saved');
    await user.click(within(message).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });
});

describe('approvals', () => {
  const wfh = (status: string) => ({ _id: `w-${status}`, employee: { _id: 'e2', fullName: 'Ravi Rao', employeeId: 'EMP9' }, startDate: '2030-03-05', endDate: '2030-03-05', totalDays: 1, reason: 'Plumber', status, decidedByName: status === 'PENDING' ? null : 'Asha HR', rejectionReason: null });

  it('keeps decided requests in the list and shows their outcome instead of buttons', async () => {
    const get = vi.spyOn(api, 'get').mockImplementation(async (url: string, config?: { params?: unknown }) => {
      if (url === '/auth/me') return { data: { data: asEmployee } };
      if (url === '/wfh/pending') return { data: { data: (config?.params as { view?: string } | undefined)?.view === 'PENDING' ? [wfh('PENDING')] : [wfh('PENDING'), wfh('APPROVED'), wfh('REJECTED')] } };
      return { data: { data: [] } };
    });
    renderApp(<Routes><Route path="/approvals" element={<ApprovalsPage />} /></Routes>, '/approvals');
    const table = await screen.findByRole('table');
    expect(await within(table).findByText('Approved')).toBeInTheDocument();
    expect(within(table).getByText('Rejected')).toBeInTheDocument();
    expect(within(table).getAllByRole('button', { name: 'Approve' })).toHaveLength(1);
    expect(screen.getAllByText('by Asha HR')).toHaveLength(2);
    expect(get).toHaveBeenCalledWith('/wfh/pending', { params: { view: 'ALL' } });

    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });
});

describe('expense claims', () => {
  it('explains each limit in plain words', () => {
    const base = { category: 'TRAVEL' as const, expenseDate: '2030-03-05', description: 'Taxi' };
    const message = (v: object) => expenseSchema.safeParse({ ...base, ...v }).error?.issues[0]?.message;
    expect(message({ amount: 10_000_001 })).toBe('The amount cannot be more than ₹1,00,00,000');
    expect(message({ amount: 12.345 })).toBe('Use at most two decimal places');
    expect(message({ amount: 0 })).toBe('Enter an amount above zero');
    expect(message({ amount: 10, description: 'x'.repeat(1001) })).toBe('The description must be 1,000 characters or fewer');
  });

  it('shows the limit message as soon as it is passed', async () => {
    mockApi({});
    const user = userEvent.setup();
    renderApp(<ExpensesPage />);
    await user.click(await screen.findByRole('button', { name: 'New claim' }));
    await user.type(screen.getByLabelText(/Amount/), '20000000');
    expect(await screen.findByText('The amount cannot be more than ₹1,00,00,000')).toBeInTheDocument();
  });

  it('asks before cancelling a claim', async () => {
    const claim = { _id: 'x1', category: 'TRAVEL', expenseDate: '2030-03-05', amount: 250, description: 'Taxi', status: 'PENDING', receipt: null, rejectionReason: null };
    mockApi({ '/expenses/my': [claim] });
    const patch = vi.spyOn(api, 'patch').mockResolvedValue({ data: { data: {} } });
    const user = userEvent.setup();
    renderApp(<ExpensesPage />);
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancel this claim?' });
    await user.click(within(dialog).getByRole('button', { name: 'Keep claim' }));
    expect(patch).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel claim' }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/expenses/x1/cancel', {}));
  });
});

describe('password fields', () => {
  it('shows and hides the password with the eye button', async () => {
    mockApi({}, null);
    const user = userEvent.setup();
    renderApp(<LoginPage />);
    const field = await screen.findByLabelText('Password');
    await user.type(field, 'secret-pass-1');
    expect(field).toHaveAttribute('type', 'password');
    await user.click(screen.getByRole('button', { name: 'Show password' }));
    expect(field).toHaveAttribute('type', 'text');
    expect(field).toHaveValue('secret-pass-1');
    await user.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(field).toHaveAttribute('type', 'password');
  });
});

describe('adding to the calendar', () => {
  it('adds an event with its times and reminder', async () => {
    mockApi({});
    const post = vi.spyOn(api, 'post').mockResolvedValue({ data: { data: { _id: 'n1', date: '2030-03-05' } } });
    const onSaved = vi.fn();
    const user = userEvent.setup();
    renderApp(<ItemModal draft={{ kind: 'EVENT', date: '2030-03-05', startTime: '13:30', endTime: '14:30' }} onClose={() => undefined} onSaved={onSaved} />);
    await user.type(await screen.findByLabelText(/Title/), 'Design sync');
    await user.selectOptions(screen.getByLabelText(/^Reminder/), '10');
    await user.click(screen.getByRole('button', { name: 'Add event' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/calendar/items', expect.objectContaining({ kind: 'EVENT', title: 'Design sync', date: '2030-03-05', startTime: '13:30', endTime: '14:30', allDay: false, reminderMinutes: 10, visibility: 'PRIVATE' })));
    expect(onSaved).toHaveBeenCalled();
  });

  it('says what is wrong with the times before saving', async () => {
    mockApi({});
    const post = vi.spyOn(api, 'post').mockClear();
    const user = userEvent.setup();
    renderApp(<ItemModal draft={{ kind: 'EVENT', date: '2030-03-05', startTime: '15:00', endTime: '14:00' }} onClose={() => undefined} onSaved={() => undefined} />);
    await user.type(await screen.findByLabelText(/Title/), 'Retro');
    await user.click(screen.getByRole('button', { name: 'Add event' }));
    expect(await screen.findByText('The end time must be after the start time')).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it('adds a task with no due time as all day', async () => {
    mockApi({});
    const post = vi.spyOn(api, 'post').mockResolvedValue({ data: { data: { _id: 't1', date: '2030-03-05' } } });
    const user = userEvent.setup();
    renderApp(<ItemModal draft={{ kind: 'TASK', date: '2030-03-05', allDay: true }} onClose={() => undefined} onSaved={() => undefined} />);
    await user.type(await screen.findByLabelText(/Title/), 'Submit receipts');
    await user.click(screen.getByRole('button', { name: 'Add task' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/calendar/items', expect.objectContaining({ kind: 'TASK', allDay: true, startTime: null, endTime: null, reminderMinutes: null })));
  });
});

describe('header links', () => {
  const app = (
    <Routes>
      <Route element={<AppLayout />}>
        <Route path="/notifications" element={<div>notifications page</div>} />
        <Route path="/dashboard" element={<div>home page</div>} />
      </Route>
    </Routes>
  );

  it('highlights the bell and names the page while notifications are open', async () => {
    mockApi({ '/notifications/unread-count': { unread: 2 } });
    renderApp(app, '/notifications');
    const bell = await screen.findByRole('link', { name: /Notifications, \d+ unread/ });
    expect(bell).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('banner')).toHaveTextContent('Notifications');
  });

  it('does not highlight the bell elsewhere', async () => {
    mockApi({ '/notifications/unread-count': { unread: 0 } });
    renderApp(app, '/dashboard');
    await screen.findByText('home page');
    expect(screen.getByRole('link', { name: /Notifications, \d+ unread/ })).not.toHaveAttribute('aria-current');
  });
});

describe('infinite scroll', () => {
  const page = (n: number, total = 4, limit = 2) => ({ data: { data: [{ id: `r${(n - 1) * limit + 1}` }, { id: `r${(n - 1) * limit + 2}` }], meta: { page: n, limit, total, totalPages: Math.ceil(total / limit) } } });

  function List({ filter = '' }: { filter?: string }) {
    const list = useInfiniteFetch<{ id: string }[]>('/things', { filter }, { limit: 2 });
    return <><ul>{list.data?.map((r) => <li key={r.id}>{r.id}</li>)}</ul><InfiniteLoader list={list} /></>;
  }

  it('adds the next page to the end of the list, then says everything is shown', async () => {
    const get = vi.spyOn(api, 'get').mockImplementation(async (_url: string, config?: { params?: unknown }) => page((config?.params as { page: number }).page));
    const user = userEvent.setup();
    render(<List />);
    expect(await screen.findByText('r2')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('r4')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
    expect(screen.getByText('All 4 records shown')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    expect(get).toHaveBeenLastCalledWith('/things', { params: { filter: undefined, page: 2, limit: 2 } });
  });

  it('starts again from the first page when a filter changes', async () => {
    const get = vi.spyOn(api, 'get').mockImplementation(async (_url: string, config?: { params?: unknown }) => page((config?.params as { page: number }).page));
    const user = userEvent.setup();
    const { rerender } = render(<List />);
    await user.click(await screen.findByRole('button', { name: 'Load more' }));
    await screen.findByText('r4');
    rerender(<List filter="sick" />);
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(2));
    expect(get).toHaveBeenLastCalledWith('/things', { params: { filter: 'sick', page: 1, limit: 2 } });
  });

  it('keeps the totals of a wrapped response and joins its rows', async () => {
    vi.spyOn(api, 'get').mockImplementation(async (_url: string, config?: { params?: unknown }) => {
      const n = (config?.params as { page: number }).page;
      return { data: { data: { summary: { present: 7 }, rows: [{ id: `p${n}` }] }, meta: { page: n, limit: 1, total: 2, totalPages: 2 } } };
    });
    function Wrapped() {
      const list = useInfiniteFetch<{ summary: { present: number }; rows: { id: string }[] }>('/daily', {}, { limit: 1, rowsKey: 'rows' });
      return <><span>present {list.data?.summary.present}</span><span>{list.data?.rows.map((r) => r.id).join(',')}</span><InfiniteLoader list={list} /></>;
    }
    const user = userEvent.setup();
    render(<Wrapped />);
    await user.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('p1,p2')).toBeInTheDocument();
    expect(screen.getByText('present 7')).toBeInTheDocument();
  });
});

describe('editing my own profile', () => {
  it('gives an employee name and phone only', async () => {
    mockApi({});
    const user = userEvent.setup();
    renderApp(<AccountPage />);
    await user.click(await screen.findByRole('button', { name: 'Edit profile' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit profile' });
    expect(within(dialog).getByLabelText(/Full name/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/Phone/)).toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/Gender/)).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/^Email/)).not.toBeInTheDocument();
  });

  it('gives someone who manages employees every field, saved to their employee record', async () => {
    const admin: CurrentUser = { ...asEmployee, role: 'SUPER_ADMIN', permissions: ['employees:write', 'employees:read'] };
    mockApi({ '/departments': [{ _id: 'd1', name: 'Platform' }], '/locations': [], '/leave-policies': [], '/employees': [] }, admin);
    const put = vi.spyOn(api, 'put').mockResolvedValue({ data: { data: {} } });
    const user = userEvent.setup();
    renderApp(<AccountPage />);
    await user.click(await screen.findByRole('button', { name: 'Edit profile' }));
    const dialog = await screen.findByRole('dialog', { name: /Edit Sara Khan/ });
    for (const label of [/^Email/, /^Gender/, /^Team/, /^Designation/, /^Reporting manager/, /^Joining date/]) {
      expect(within(dialog).getByLabelText(label)).toBeInTheDocument();
    }
    await user.selectOptions(within(dialog).getByLabelText(/^Gender/), 'FEMALE');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/employees/e1', expect.objectContaining({ gender: 'FEMALE', email: 's@x.co' })));
  });
});

describe('deleting a leave type', () => {
  const study = { _id: 'lt1', name: 'Study Leave', code: 'STUD', kind: 'STANDARD', color: '#123456', isPaid: true, annualEntitlement: 3, monthlyAccrual: 0, carryForward: false, maxCarryForward: 0, halfDayAllowed: true, isActive: true, applicableCategories: [], applicableGenders: [] };

  it('asks first, then deletes and says so', async () => {
    mockApi({ '/leave-types': [study] });
    const del = vi.spyOn(api, 'delete').mockClear().mockResolvedValue({ data: { data: { deleted: true } } });
    renderApp(<LeaveTypesPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByText('Study Leave'));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('Delete Study Leave?')).toBeInTheDocument();
    expect(del).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Delete leave type' }));
    await waitFor(() => expect(del).toHaveBeenCalledWith('/leave-types/lt1'));
    expect(await screen.findByText('Study Leave deleted')).toBeInTheDocument();
  });

  it('shows why a type in use cannot be deleted and keeps the form open', async () => {
    mockApi({ '/leave-types': [study] });
    vi.spyOn(api, 'delete').mockClear().mockRejectedValue(Object.assign(new Error('x'), { isAxiosError: true, response: { status: 409, data: { error: { code: 'LEAVE_TYPE_IN_USE', message: 'Study Leave cannot be deleted because it has 2 leave applications. Mark it inactive instead.' } } } }));
    renderApp(<LeaveTypesPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByText('Study Leave'));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(await screen.findByRole('button', { name: 'Delete leave type' }));
    expect(await screen.findByText(/has 2 leave applications/)).toBeInTheDocument();
    expect(screen.getByText('Edit Study Leave')).toBeInTheDocument();
  });

  it('offers no delete when adding a new type', async () => {
    mockApi({ '/leave-types': [] });
    renderApp(<LeaveTypesPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add leave type' }));
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });
});
