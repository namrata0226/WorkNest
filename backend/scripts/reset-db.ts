/**
 * Wipes the database and starts again with the standard setup and two Super Admins:
 * Amudha Kaliamoorthi (top of the hierarchy) and Dinjit Dinesh, who reports to her.
 *
 * Destructive and irreversible. It refuses to run unless RESET_CONFIRM is set to the database's name:
 *   RESET_CONFIRM=<db name> npm run reset --workspace backend
 */
import { randomBytes } from 'crypto';
import mongoose, { Types } from 'mongoose';
import { connectDb, disconnectDb } from '../src/config/db';
import { ROLES } from '../src/constants';
import '../src/models';
import { CompanySettings, Employee, User } from '../src/models';
import { hashPassword } from '../src/services/auth';
import { ensureBaseline } from '../src/services/baseline';
import { companyToday, getSettings } from '../src/services/settings';

const ACCOUNTS = [
  { employeeId: 'EMP001', fullName: 'Amudha Kaliamoorthi', email: 'amudha.kaliamoorthi@worknest.local', designation: null },
  { employeeId: 'EMP002', fullName: 'Dinjit Dinesh', email: 'dinjit.dinesh@worknest.local', designation: 'Manager' },
];

async function main() {
  await connectDb();
  const db = mongoose.connection.db!;
  const name = db.databaseName;
  if (process.env.RESET_CONFIRM !== name) {
    console.error(`Refusing to wipe "${name}". Set RESET_CONFIRM=${name} to confirm.`);
    process.exitCode = 1;
    return;
  }

  const before = await db.listCollections().toArray();
  console.log(`Wiping "${name}" (${before.length} collections)…`);
  await db.dropDatabase();
  // Dropping removes the indexes too, including the unique ones that keep data consistent.
  await mongoose.connection.syncIndexes();

  const today = await companyToday();
  await ensureBaseline(today);
  // Attendance starts now, so the days before this reset are not reported as absences.
  await getSettings();
  await CompanySettings.updateOne({ key: 'global' }, { $set: { attendanceStartDate: today } });

  const password = `Start-${randomBytes(6).toString('hex')}1`;
  const passwordHash = await hashPassword(password);
  const created: Types.ObjectId[] = [];
  for (const a of ACCOUNTS) {
    const userId = new Types.ObjectId();
    const employeeRef = new Types.ObjectId();
    // Both are Super Admins, so they have the same rights. Each must choose their own password at first sign-in.
    await User.create({ _id: userId, email: a.email, passwordHash, role: ROLES.SUPER_ADMIN, employee: employeeRef, mustChangePassword: true });
    await Employee.create({ _id: employeeRef, employeeId: a.employeeId, fullName: a.fullName, email: a.email, designation: a.designation, joiningDate: today, user: userId });
    created.push(employeeRef);
  }
  // Dinjit's leave goes to Amudha. Amudha has nobody above her, so hers is approved automatically.
  await Employee.updateOne({ _id: created[1] }, { reportingManager: created[0] });

  console.log('\nDone. Sign in with:');
  for (const a of ACCOUNTS) console.log(`  ${a.fullName.padEnd(20)} ${a.email}`);
  console.log(`\nTemporary password for both: ${password}`);
  console.log('Both are asked to set a new password at first sign-in. This password is not shown again.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => disconnectDb());
