import mongoose, { Types } from 'mongoose';
import supertest from 'supertest';
import { afterAll, beforeAll, beforeEach, inject } from 'vitest';
import { createApp } from '../src/app';
import { HR_ASSIGNABLE_PERMISSIONS, Role, ROLES } from '../src/constants';
import '../src/models';
import { Department, Employee, IEmployee, LeaveType, Location, User } from '../src/models';
import { hashPassword } from '../src/services/auth';
import { ensureBaseline } from '../src/services/baseline';

export const PASSWORD = 'Sup3r-Secret-Pass';
export const app = createApp();

/** Gives each test file its own database on the shared replica set, emptied before each test. */
export function useDatabase(name: string) {
  beforeAll(async () => {
    const uri = inject('mongoUri').replace('/?', `/${name}?`);
    await mongoose.connect(uri);
    for (const model of Object.values(mongoose.models)) {
      await model.createCollection().catch(() => undefined);
      await model.init();
    }
  });
  beforeEach(async () => {
    for (const model of Object.values(mongoose.models)) await model.deleteMany({});
  });
  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
}

let passwordHash: string | null = null;
let counter = 0;

export interface Person {
  employee: IEmployee;
  userId: Types.ObjectId;
  email: string;
}

export async function makePerson(opts: Partial<{ role: Role; name: string; manager: Types.ObjectId; location: Types.ObjectId; department: Types.ObjectId; joiningDate: string; category: IEmployee['category']; gender: IEmployee['gender'] }> = {}): Promise<Person> {
  passwordHash ??= await hashPassword(PASSWORD);
  counter++;
  const email = `person${counter}@test.local`;
  const userId = new Types.ObjectId();
  const employeeRef = new Types.ObjectId();
  await User.create({ _id: userId, email, passwordHash, role: opts.role ?? ROLES.EMPLOYEE, employee: employeeRef });
  const employee = await Employee.create({
    _id: employeeRef,
    employeeId: `T${counter}`,
    fullName: opts.name ?? `Person ${counter}`,
    email,
    joiningDate: opts.joiningDate ?? '2020-01-01',
    user: userId,
    reportingManager: opts.manager ?? null,
    location: opts.location ?? null,
    department: opts.department ?? null,
    category: opts.category ?? 'PERMANENT',
    gender: opts.gender ?? null,
  });
  return { employee: employee.toObject() as IEmployee, userId, email };
}

export async function makeSuperAdmin(): Promise<{ userId: Types.ObjectId; email: string }> {
  passwordHash ??= await hashPassword(PASSWORD);
  counter++;
  const email = `super${counter}@test.local`;
  const user = await User.create({ email, passwordHash, role: ROLES.SUPER_ADMIN });
  return { userId: user._id, email };
}

export type Agent = ReturnType<typeof agentFor> extends Promise<infer A> ? A : never;

/** A logged-in client holding real cookies, sending the CSRF header on every call. */
export async function agentFor(email: string, password = PASSWORD, target = app) {
  const agent = supertest.agent(target).set('X-Requested-With', 'WorkNest');
  const res = await agent.post('/api/auth/login').send({ email, password });
  if (res.status !== 200) throw new Error(`Login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  return agent;
}

export async function baseline() {
  return ensureBaseline('2026-01-01');
}

export const typeId = async (code: string) => String((await LeaveType.findOne({ code }).lean())!._id);
export const makeDepartment = async (name: string) => (await Department.create({ name }))._id;
export const makeLocation = async (name: string) => (await Location.create({ name }))._id;

/** Fixed dates in a future year keep tests independent of the clock. 2030-03-01 is a Friday. */
export const FRI = '2030-03-01';
export const MON = '2030-03-04';
export const TUE = '2030-03-05';
export const WED = '2030-03-06';
export const THU = '2030-03-07';

export const fullDay = (leaveType: string, startDate: string, endDate = startDate) => ({ leaveType, startDate, endDate, dayType: 'FULL', reason: 'Testing' });

export const hrPermissions = HR_ASSIGNABLE_PERMISSIONS;
