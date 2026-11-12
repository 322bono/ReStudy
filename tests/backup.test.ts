import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { exportData, restoreData, validateBackup } from '../supabase/functions/_shared/app/backup';

const owner = '10000000-0000-4000-8000-000000000001';
const other = '20000000-0000-4000-8000-000000000002';
const documentId = '30000000-0000-4000-8000-000000000003';
const problemId = '40000000-0000-4000-8000-000000000004';
const sessionId = '50000000-0000-4000-8000-000000000005';
const backup = () => ({
  schemaVersion: 1,
  type: 'restudy-backup',
  ownerId: owner,
  createdAt: '2026-11-01T00:00:00.000Z',
  originalsIncluded: false,
  sameAccountOnly: true,
  tables: {
    documents: [{ id: documentId, user_id: owner, title: '내 자료', subject: '수학', kind: '문제집', status: 'ready', data: { pageCount: 2, originalPath: `${owner}/${documentId}/source/original.pdf` } }],
    problems: [{ id: problemId, user_id: owner, document_id: documentId, number: 47, page: 1, data: { answer: '3', regions: [{ page: 1, x: 0, y: 0, w: 1, h: 1 }] } }],
    solve_sessions: [{ id: sessionId, user_id: owner, data: { questionIds: [problemId], questionSnapshots: [{ id: problemId, materialId: documentId, answer: '3', imagePaths: [`${owner}/${documentId}/crops/original.png`] }], answers: { [problemId]: { result: 'correct' } }, drawings: {}, status: 'complete' } }],
  } as Record<string, any[]>,
});

// PostgREST is the external boundary; the exporter still performs its real
// owner filtering, pagination, projection, JSON sanitizing and CSV encoding.
function reader(tables: Record<string, any[]>) {
  const reads: string[] = [];
  return {
    reads,
    from(table: string) {
      reads.push(table);
      let requestedOwner = '';
      return { select() { return this; }, eq(column: string, value: string) { if (column === 'user_id') requestedOwner = value; return this; }, order() { return this; },
        async range(from: number, to: number) { return { data: (tables[table] || []).filter(row => row.user_id === requestedOwner).slice(from, to + 1), error: null }; } };
    },
  };
}

test('JSON export contains only owned learning data and excludes credentials and file contents', async () => {
  const tables = backup().tables;
  tables.documents.push({ ...tables.documents[0], id: crypto.randomUUID(), user_id: other });
  tables.documents[0].data.apiKey = 'must-not-leave-server';
  tables.documents[0].data.signedUrl = 'https://example.invalid/storage/v1/object/sign/file?token=secret';
  const db = reader({ ...tables, ai_credentials: [{ user_id: owner, ciphertext: 'secret' }] });
  const file = await exportData({ user: { id: owner }, db, admin: {} }, { format: 'json', includeOriginals: false });
  const result = JSON.parse(file.content);
  expect(file.mimeType).toBe('application/json');
  expect(result).toMatchObject({ schemaVersion: 1, type: 'restudy-backup', ownerId: owner, originalsIncluded: false, sameAccountOnly: true });
  expect(result.tables.documents).toHaveLength(1);
  expect(result.tables.solve_sessions[0].data.answers[problemId].result).toBe('correct');
  expect(result.tables.documents[0].data.originalPath).toBe(`${owner}/${documentId}/source/original.pdf`);
  expect(file.content).not.toContain('must-not-leave-server');
  expect(file.content).not.toContain('token=secret');
  expect(db.reads).not.toContain('ai_credentials');
  expect(Object.keys(result.tables)).not.toContain('profiles');
  expect(Object.keys(result.tables)).not.toContain('content_jobs');
});

test('export paginates without losing rows beyond the first PostgREST page', async () => {
  const documents = Array.from({ length: 1001 }, (_, i) => ({ ...backup().tables.documents[0], id: `30000000-0000-4000-8000-${String(i).padStart(12, '0')}` }));
  const file = await exportData({ user: { id: owner }, db: reader({ documents }), admin: {} }, { format: 'json' });
  expect(JSON.parse(file.content).tables.documents).toHaveLength(1001);
});

test('CSV export escapes multiline content and cannot introduce spreadsheet formulas', async () => {
  const tables = backup().tables;
  tables.documents[0].title = '=HYPERLINK("bad")\n다음 줄';
  const file = await exportData({ user: { id: owner }, db: reader(tables), admin: {} }, { format: 'csv' });
  expect(file.mimeType).toBe('text/csv; charset=utf-8');
  expect(file.content).toContain('table,record_json\r\n');
  expect(file.content).toContain('"documents","{""id""');
  expect(file.content).toContain('=HYPERLINK');
  expect(file.content).not.toMatch(/(?:^|\r\n)[=+@-]/);
  expect(file.filename).toMatch(/\.csv$/);
});

test('valid same-account backup preserves original IDs and session snapshots', () => {
  const result = validateBackup(backup(), owner);
  expect(result.tables.problems[0].id).toBe(problemId);
  expect(result.tables.solve_sessions[0].data.questionSnapshots[0].answer).toBe('3');
});

test('optional concept hierarchy labels can be empty without blocking backup/export', async () => {
  const p = backup();
  p.tables.concepts = [{ id: 'concept-1', user_id: owner, subject: '수학', major: '', minor: '', name: '함수', canonical_key: '수학|||함수', data: { definition: '정의' } }];
  expect(validateBackup(p, owner).tables.concepts[0].major).toBe('');
  const file = await exportData({ user: { id: owner }, db: reader(p.tables), admin: {} }, { format: 'json' });
  expect(JSON.parse(file.content).tables.concepts[0].minor).toBe('');
});

test.each([
  ['another account', (p: any) => { p.ownerId = other; }],
  ['another row owner', (p: any) => { p.tables.documents[0].user_id = other; }],
  ['unknown table', (p: any) => { p.tables.ai_credentials = []; }],
  ['unknown row column', (p: any) => { p.tables.documents[0].ciphertext = 'secret'; }],
  ['secret nested in session', (p: any) => { p.tables.solve_sessions[0].data.access_token = 'secret'; }],
  ['foreign private path', (p: any) => { p.tables.documents[0].data.originalPath = `${other}/${documentId}/a.pdf`; }],
  ['path traversal in snapshot', (p: any) => { p.tables.solve_sessions[0].data.questionSnapshots[0].imagePaths = [`${owner}/${documentId}/../other.png`]; }],
  ['encoded traversal', (p: any) => { p.tables.documents[0].data.originalPath = `${owner}/${documentId}/%2e%2e/other.pdf`; }],
  ['signed URL', (p: any) => { p.tables.documents[0].data.originalPath = 'https://example.invalid/file?token=secret'; }],
  ['duplicate IDs', (p: any) => { p.tables.documents.push(p.tables.documents[0]); }],
  ['invalid UUID', (p: any) => { p.tables.documents[0].id = 'not-a-uuid'; }],
  ['incomplete row', (p: any) => { delete p.tables.problems[0].document_id; }],
  ['missing required relationship', (p: any) => { p.tables.problem_regions = [{ id: crypto.randomUUID(), user_id: owner, page: 1, part: 0, image_path: `${owner}/${documentId}/crop.png`, data: {} }]; }],
  ['prototype payload', (p: any) => { p.tables.documents[0].data = JSON.parse('{"__proto__":{"polluted":true}}'); }],
  ['nonfinite JSON number', (p: any) => { p.tables.problems[0].page = Infinity; }],
])('restore rejects %s before any database mutation', async (_label, mutate) => {
  const p = backup(); mutate(p);
  let mutated = false;
  const ctx = { user: { id: owner }, db: {}, admin: { rpc: async () => { mutated = true; return { data: { restored: true }, error: null }; } } };
  await expect(restoreData(ctx, { package: p })).rejects.toThrow();
  expect(mutated).toBe(false);
});

test('restore rejects excessive depth and file size before calling PostgreSQL', async () => {
  const deep = backup(); let node: any = deep.tables.documents[0].data;
  for (let i = 0; i < 40; i++) { node.child = {}; node = node.child; }
  expect(() => validateBackup(deep, owner)).toThrow();
  const large = backup(); large.tables.documents[0].data.text = 'a'.repeat(21 * 1024 * 1024);
  expect(() => validateBackup(large, owner)).toThrow();
  const numerous = backup(); numerous.tables.documents = Array.from({ length: 15001 }, () => numerous.tables.documents[0]);
  expect(() => validateBackup(numerous, owner)).toThrow();
});

test('restore reports database failure instead of claiming partial success', async () => {
  const ctx = { user: { id: owner }, db: {}, admin: { rpc: async () => ({ data: null, error: { code: '23503' } }) } };
  await expect(restoreData(ctx, { package: backup() })).rejects.toThrow();
});

describe('insert-only restore transaction', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
      create schema auth;grant usage on schema auth to authenticated,service_role;
      create table auth.users(id uuid primary key,raw_user_meta_data jsonb default '{}',last_sign_in_at timestamptz);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(id uuid primary key,bucket_id text,name text);alter table storage.objects enable row level security;
      create function storage.foldername(text)returns text[]language sql as $$select string_to_array($1,'/')$$;`);
    for (const file of readdirSync('supabase/migrations').filter(f => f.endsWith('.sql')).sort()) await db.exec(readFileSync('supabase/migrations/' + file, 'utf8'));
    await db.exec(readFileSync('docs/sql/restore-restudy-backup.sql', 'utf8'));
    await db.exec(`insert into auth.users(id)values('${owner}'),('${other}');insert into profiles(id,user_id)values('${owner}','${owner}'),('${other}','${other}');`);
  }, 30000);
  afterAll(async () => { await db?.close(); });
  const restore = (p: any) => db.query<{ result: any }>('select restore_restudy_backup($1,$2) result', [owner, p]);

  test('restores missing content/history atomically and never overwrites current edited rows', async () => {
    const first = await restore(backup());
    expect(first.rows[0].result.inserted).toBe(3);
    await db.query(`update documents set title='사용자 수정',data=data||'{"userEdited":true}' where id=$1`, [documentId]);
    const repeated = await restore(backup());
    expect(repeated.rows[0].result.inserted).toBe(0);
    expect(repeated.rows[0].result.skipped).toBe(3);
    expect((await db.query<{ title: string }>('select title from documents where id=$1', [documentId])).rows[0].title).toBe('사용자 수정');
    expect((await db.query<{ data: any }>('select data from solve_sessions where id=$1', [sessionId])).rows[0].data.questionSnapshots[0].answer).toBe('3');
  });

  test('broken foreign references roll back every inserted row', async () => {
    const p = backup(), newDoc = '60000000-0000-4000-8000-000000000006';
    p.tables.documents[0].id = newDoc;
    p.tables.documents[0].data.originalPath = `${owner}/${newDoc}/source/original.pdf`;
    p.tables.problems[0].id = crypto.randomUUID();
    p.tables.problems[0].document_id = '70000000-0000-4000-8000-000000000007';
    await expect(restore(p)).rejects.toThrow();
    expect((await db.query('select id from documents where id=$1', [newDoc])).rows).toHaveLength(0);
  });

  test('RPC rejects owner/table/column/path tampering even when Edge validation is bypassed', async () => {
    for (const mutate of [
      (p: any) => { p.ownerId = other; },
      (p: any) => { p.tables.documents[0].user_id = other; },
      (p: any) => { p.tables.ai_credentials = []; },
      (p: any) => { p.tables.documents[0].ciphertext = 'bad'; },
      (p: any) => { p.tables.documents.push(p.tables.documents[0]); },
      (p: any) => { p.tables.solve_sessions[0].data.questionSnapshots[0].imagePaths = [`${other}/private.png`]; },
      (p: any) => { p.tables.solve_sessions[0].data.accessToken = 'bad'; },
    ]) {
      const p = backup(); mutate(p);
      await expect(restore(p)).rejects.toThrow();
    }
    await db.exec('set role authenticated');
    await expect(restore(backup())).rejects.toThrow();
    await db.exec('reset role');
  });

  test('same natural key with a different ID aborts rather than remapping or dropping children', async () => {
    const existingId = crypto.randomUUID(), restoredId = crypto.randomUUID();
    await db.query('insert into documents(id,user_id,title,subject,kind,content_hash)values($1,$2,$3,$4,$5,$6)', [existingId, owner, '현재 자료', '수학', '문제집', 'same-content-hash']);
    const p = backup(); p.tables = { documents: [{ ...p.tables.documents[0], id: restoredId, content_hash: 'same-content-hash', data: {} }] };
    await expect(restore(p)).rejects.toThrow();
    expect((await db.query('select id from documents where id=$1', [restoredId])).rows).toHaveLength(0);
    expect((await db.query('select id from documents where id=$1', [existingId])).rows).toHaveLength(1);
  });
});
