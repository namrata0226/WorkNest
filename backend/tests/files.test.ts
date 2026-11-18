import { promises as fs } from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { StoredFile } from '../src/models';
import { uploadRoot } from '../src/services/file';
import { agentFor, Agent, baseline, FRI, fullDay, makePerson, Person, typeId, useDatabase } from './helpers';

useDatabase('files');

const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(100, 0x20)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100)]);
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(100)]);

let emp: Person;
let empAgent: Agent;
let hrAgent: Agent;

beforeEach(async () => {
  await baseline();
  emp = await makePerson();
  empAgent = await agentFor(emp.email);
  hrAgent = await agentFor((await makePerson({ role: 'HR_ADMIN' })).email);
});

const upload = (buffer: Buffer, filename: string, contentType: string, agent = empAgent) =>
  agent.post('/api/files').attach('file', buffer, { filename, contentType });

describe('upload validation', () => {
  it('accepts a genuine PDF and PNG', async () => {
    expect((await upload(PDF, 'note.pdf', 'application/pdf')).status).toBe(201);
    expect((await upload(PNG, 'scan.png', 'image/png')).status).toBe(201);
  });

  it('rejects an executable, even disguised as a PDF', async () => {
    for (const [name, type] of [['virus.exe', 'application/octet-stream'], ['virus.pdf', 'application/pdf']]) {
      const res = await upload(EXE, name, type);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('INVALID_FILE_TYPE');
    }
  });

  it('rejects a mismatch between bytes, extension and declared type', async () => {
    expect((await upload(PDF, 'note.png', 'image/png')).status).toBe(422);
    expect((await upload(PDF, 'note.pdf', 'image/png')).status).toBe(422);
    expect((await upload(PNG, 'scan.html', 'text/html')).status).toBe(422);
  });

  it('rejects oversized files', async () => {
    const big = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(6 * 1024 * 1024)]);
    const res = await upload(big, 'big.pdf', 'application/pdf');
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/too large/);
  });

  it('stores under a random name outside any public path, with a cleaned display name', async () => {
    const res = await upload(PDF, '../../etc/pass wd<script>.pdf', 'application/pdf');
    expect(res.status).toBe(201);
    const doc = await StoredFile.findById(res.body.data.id).lean();
    expect(doc!.storedName).toMatch(/^[0-9a-f-]{36}\.pdf$/);
    expect(doc!.originalName).not.toMatch(/[/<>]/);
    await expect(fs.access(path.join(uploadRoot(), doc!.storedName))).resolves.toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(doc!.storedName);
  });
});

describe('download authorization', () => {
  it('lets the owner download with safe headers', async () => {
    const id = (await upload(PDF, 'note.pdf', 'application/pdf')).body.data.id;
    const res = await empAgent.get(`/api/files/${id}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/^attachment/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('hides a file from other employees', async () => {
    const id = (await upload(PDF, 'note.pdf', 'application/pdf')).body.data.id;
    const other = await agentFor((await makePerson()).email);
    expect((await other.get(`/api/files/${id}`)).status).toBe(404);
  });

  it('lets HR and the manager read a file attached to a leave, but HR not an unattached one', async () => {
    const manager = await makePerson();
    const report = await makePerson({ manager: manager.employee._id });
    const reportAgent = await agentFor(report.email);
    const id = (await upload(PDF, 'note.pdf', 'application/pdf', reportAgent)).body.data.id;
    expect((await hrAgent.get(`/api/files/${id}`)).status).toBe(404);

    const res = await reportAgent.post('/api/leaves').send({ ...fullDay(await typeId('CL'), FRI), document: id });
    expect(res.status).toBe(201);
    expect((await hrAgent.get(`/api/files/${id}`)).status).toBe(200);
    expect((await (await agentFor(manager.email)).get(`/api/files/${id}`)).status).toBe(200);
  });
});

describe('removing an upload', () => {
  it('deletes the record and the file for its owner', async () => {
    const id = (await upload(PDF, 'note.pdf', 'application/pdf')).body.data.id;
    const { storedName } = (await StoredFile.findById(id).lean())!;
    const res = await empAgent.delete(`/api/files/${id}`);
    expect(res.status).toBe(200);
    expect(await StoredFile.findById(id).lean()).toBeNull();
    await expect(fs.access(path.join(uploadRoot(), storedName))).rejects.toThrow();
    expect((await empAgent.get(`/api/files/${id}`)).status).toBe(404);
  });

  it('hides the file from anyone else, including HR', async () => {
    const id = (await upload(PDF, 'note.pdf', 'application/pdf')).body.data.id;
    expect((await hrAgent.delete(`/api/files/${id}`)).status).toBe(404);
    expect(await StoredFile.findById(id).lean()).not.toBeNull();
  });

  it('refuses once the file is attached to a submitted request', async () => {
    const id = (await upload(PDF, 'note.pdf', 'application/pdf')).body.data.id;
    expect((await empAgent.post('/api/leaves').send({ ...fullDay(await typeId('CL'), FRI), document: id })).status).toBe(201);
    const res = await empAgent.delete(`/api/files/${id}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('FILE_IN_USE');
    expect(await StoredFile.findById(id).lean()).not.toBeNull();
  });

  it('needs the CSRF header', async () => {
    const id = (await upload(PDF, 'note.pdf', 'application/pdf')).body.data.id;
    const res = await empAgent.delete(`/api/files/${id}`).set('X-Requested-With', '');
    expect(res.status).toBe(403);
  });
});
