import { CompanySettings, ICompanySettings } from '../models/System';
import { todayIn } from '../utils/dates';
import { isDuplicateKeyError } from '../utils/transaction';

// A settings document saved before these existed does not hold them, and reads here skip schema defaults.
const NOTIFICATION_DEFAULTS = { approvalReminderDays: 2, approvalEscalationDays: 5, punchReminderEnabled: true, punchReminderTime: '11:00' };

export async function getSettings(): Promise<ICompanySettings> {
  const load = async () => {
    const doc = (await find())!;
    return { ...doc, attendanceStartDate: doc.attendanceStartDate ?? null, notifications: { ...NOTIFICATION_DEFAULTS, ...doc.notifications } };
  };
  const find = () =>
    CompanySettings.findOneAndUpdate(
      { key: 'global' },
      { $setOnInsert: { key: 'global' } },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
    ).lean<ICompanySettings>();
  try {
    return await load();
  } catch (err) {
    if (isDuplicateKeyError(err)) return load();
    throw err;
  }
}

/** "Today" is the company's calendar date, regardless of where the server runs. */
export async function companyToday(): Promise<string> {
  const settings = await getSettings();
  return todayIn(settings.timezone);
}
