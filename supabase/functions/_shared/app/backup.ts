import { AppError } from '../context.ts';
import type { Ctx } from './repository.ts';

// Deliberately excludes profiles, credentials, provider settings, Auth, AI jobs,
// usage/budget/lease controls and resumable content-import job control tables.
// The SQL RPC has the same fixed contract; neither side accepts table names or
// column names supplied by a caller outside this allowlist.
const tables = {
  subjects: ['id', 'user_id', 'name', 'data'],
  documents: ['id', 'user_id', 'title', 'subject', 'kind', 'content_hash', 'status', 'data', 'created_at', 'updated_at'],
  document_pages: ['id', 'user_id', 'document_id', 'number', 'image_path', 'data', 'updated_at'],
  problems: ['id', 'user_id', 'document_id', 'number', 'page', 'data', 'created_at', 'updated_at'],
  problem_regions: ['id', 'user_id', 'problem_id', 'page', 'part', 'image_path', 'data'],
  concepts: ['id', 'user_id', 'subject', 'major', 'minor', 'name', 'canonical_key', 'data', 'created_at', 'updated_at'],
  problem_concepts: ['user_id', 'problem_id', 'concept_id'],
  concept_questions: ['id', 'user_id', 'concept_id', 'type', 'difficulty', 'review_status', 'data', 'created_at', 'updated_at'],
  question_options: ['id', 'user_id', 'question_id', 'position', 'data'],
  wrong_answers: ['id', 'user_id', 'problem_id', 'data', 'created_at', 'updated_at'],
  study_sessions: ['id', 'user_id', 'data', 'created_at', 'updated_at'],
  solve_sessions: ['id', 'user_id', 'data', 'created_at', 'updated_at'],
  study_results: ['id', 'user_id', 'session_id', 'item_id', 'concept_id', 'result', 'data', 'created_at'],
  review_schedules: ['id', 'user_id', 'problem_id', 'concept_id', 'due_at', 'data'],
  document_chapters: ['id', 'user_id', 'document_id', 'title', 'start_page', 'end_page', 'canonical_key', 'data', 'updated_at'],
  chapter_concepts: ['user_id', 'chapter_id', 'concept_id'],
  bank_question_concepts: ['user_id', 'question_id', 'concept_id'],
  bank_question_origins: ['id', 'user_id', 'question_id', 'document_id', 'chapter_id', 'purpose', 'data'],
  question_fingerprints: ['user_id', 'fingerprint', 'question_id'],
  imported_problem_analyses: ['id', 'user_id', 'document_id', 'chapter_id', 'q_number', 'pdf_page', 'problem_id', 'data'],
  problem_similarities: ['id', 'user_id', 'document_id', 'a', 'b', 'score', 'reason', 'content_hash'],
} as const;
type Table = keyof typeof tables;
type Row = Record<string, any>;
export type BackupPackage = {
  schemaVersion: 1;
  type: 'restudy-backup';
  ownerId: string;
  createdAt: string;
  originalsIncluded: false;
  sameAccountOnly: true;
  tables: Record<string, Row[]>;
};
const maxBytes = 20 * 1024 * 1024, maxRows = 50000, maxTableRows = 15000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const optional: Partial<Record<Table, string[]>> = {
  documents: ['content_hash'], document_pages: ['image_path'], study_results: ['concept_id'],
  review_schedules: ['problem_id', 'concept_id'], imported_problem_analyses: ['problem_id'],
};
const jsonColumns = new Set(['data', 'a', 'b']);
const numbers = new Set(['number', 'page', 'part', 'position', 'start_page', 'end_page', 'pdf_page', 'score']);
const uuidColumns = new Set(['user_id', 'document_id', 'problem_id', 'session_id', 'chapter_id']);
const textIdTables = new Set<Table>(['concepts', 'concept_questions']);
const keys: Partial<Record<Table, string[]>> = {
  problem_concepts: ['user_id', 'problem_id', 'concept_id'],
  chapter_concepts: ['user_id', 'chapter_id', 'concept_id'],
  bank_question_concepts: ['user_id', 'question_id', 'concept_id'],
  question_fingerprints: ['user_id', 'fingerprint'],
};
const secret = (key: string) => /^(apikey|password|accesstoken|refreshtoken|authorization|servicerole|servicerolekey|masterkey|credentials|aicredentials|ciphertext|privatekey|secretkey|supabasesecretkey|supabaseservicerolekey|signedurls?|url|originalurl|imageurl|fileurl|downloadurl|publicurl|proto|prototype|constructor)$/.test(key.replace(/[_-]/g, '').toLowerCase());
const pathKey = (key: string) => /^(originalpath|pdfpath|imagepath|imagepaths|storagepath|sourcefile|cropfiles|filepath|path)$/.test(key.replace(/[_-]/g, '').toLowerCase());
const ownerKey = (key: string) => ['user_id', 'userId', 'ownerId'].includes(key);
function fail(message = '백업 파일의 형식·소유자·참조 경로를 확인해 주세요.'): never { throw new AppError(message); }
function object(value: unknown): value is Row { return !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
function safePath(value: unknown, owner: string): boolean {
  return typeof value === 'string' && value.length <= 1000 && value.startsWith(owner + '/') && !/[\\%?#\u0000-\u001f]/.test(value) && value.split('/').every(part => !!part && part !== '.' && part !== '..');
}
function walk(value: unknown, owner: string, stripSecrets = false, depth = 0, budget = { nodes: 0 }): any {
  if (depth > 32 || ++budget.nodes > 300000) fail('백업 데이터가 너무 복잡합니다. 범위를 나누어 내보내세요.');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail(); return value; }
  if (typeof value === 'string') { if (value.length > 2 * 1024 * 1024) fail('백업 항목이 너무 큽니다.'); return value; }
  if (Array.isArray(value)) return value.map(child => walk(child, owner, stripSecrets, depth + 1, budget));
  if (!object(value)) fail();
  const clean: Row = {};
  for (const [key, child] of Object.entries(value)) {
    if (key.length > 200) fail();
    if (secret(key)) { if (stripSecrets) continue; fail('인증 정보나 임시 접근 URL이 포함된 파일은 복원할 수 없습니다.'); }
    if (ownerKey(key) && child !== owner) fail('다른 계정의 데이터는 복원할 수 없습니다.');
    if (pathKey(key) && child !== null && child !== '') {
      const paths = Array.isArray(child) ? child : [child];
      if (!paths.every(path => safePath(path, owner))) fail('백업의 원본 경로는 같은 계정의 비공개 파일만 참조할 수 있습니다.');
    }
    clean[key] = walk(child, owner, stripSecrets, depth + 1, budget);
  }
  return clean;
}
function validateRow(table: Table, row: unknown, owner: string) {
  if (!object(row) || Object.keys(row).some(key => !(tables[table] as readonly string[]).includes(key))) fail();
  const required = tables[table].filter(key => !['created_at', 'updated_at'].includes(key) && !optional[table]?.includes(key));
  for (const column of required) if (!(column in row) || row[column] === null) fail();
  for (const [column, value] of Object.entries(row)) {
    if (value === null) { if (!optional[table]?.includes(column)) fail(); continue; }
    if (jsonColumns.has(column)) { if (!object(value)) fail(); continue; }
    if (numbers.has(column)) {
      if (typeof value !== 'number' || !Number.isFinite(value) || (column !== 'score' && (!Number.isInteger(value) || value < (['part', 'position'].includes(column) ? 0 : 1))) || column === 'score' && (value < 0 || value > 1)) fail();
    } else if (typeof value !== 'string' || (!value.length && !['major', 'minor'].includes(column)) || value.length > 10000) fail();
    if ((uuidColumns.has(column) || column === 'id' && !textIdTables.has(table)) && (typeof value !== 'string' || !uuid.test(value))) fail();
    if (['created_at', 'updated_at', 'due_at'].includes(column) && (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))) fail();
    if (column === 'image_path' && !safePath(value, owner)) fail();
  }
  if (row.user_id !== owner) fail('백업을 만든 계정으로 로그인한 뒤 복원하세요.');
  if (table === 'problem_regions' && !row.problem_id || table === 'wrong_answers' && !row.problem_id) fail();
  if (table === 'document_chapters' && row.end_page < row.start_page) fail();
  if (table === 'bank_question_origins' && !['concept', 'practice', 'similar'].includes(row.purpose)) fail();
  return row;
}

export function validateBackup(input: unknown, owner: string): BackupPackage {
  if (!uuid.test(owner) || !object(input)) fail();
  let encoded: string;
  try { encoded = JSON.stringify(input); } catch { fail(); }
  if (new TextEncoder().encode(encoded).byteLength > maxBytes) fail('백업 파일은 20MB 이하만 복원할 수 있습니다.');
  const top = ['schemaVersion', 'type', 'ownerId', 'createdAt', 'originalsIncluded', 'sameAccountOnly', 'tables'];
  if (Object.keys(input).some(key => !top.includes(key)) || input.schemaVersion !== 1 || input.type !== 'restudy-backup' || input.ownerId !== owner || input.originalsIncluded !== false || input.sameAccountOnly !== true || typeof input.createdAt !== 'string' || !Number.isFinite(Date.parse(input.createdAt)) || !object(input.tables)) fail('이 계정에서 내보낸 RE:STUDY 데이터 백업을 선택하세요. 원본 파일은 별도 보관됩니다.');
  let count = 0;
  const cleaned: Record<string, Row[]> = {};
  for (const [name, rows] of Object.entries(input.tables)) {
    if (!Object.hasOwn(tables, name) || !Array.isArray(rows) || rows.length > maxTableRows || (count += rows.length) > maxRows) fail('지원하지 않는 테이블이 있거나 백업 항목이 너무 많습니다.');
    const table = name as Table, seen = new Set<string>();
    cleaned[table] = rows.map(value => {
      const row = validateRow(table, value, owner), key = JSON.stringify((keys[table] || ['id']).map(column => row[column]));
      if (seen.has(key)) fail('백업 파일에 중복된 ID가 있습니다.'); seen.add(key);
      return walk(row, owner);
    });
  }
  if (!Object.keys(cleaned).length) fail('백업에 테이블 목록이 없습니다.');
  return { schemaVersion: 1, type: 'restudy-backup', ownerId: owner, createdAt: input.createdAt, originalsIncluded: false, sameAccountOnly: true, tables: cleaned };
}

export async function exportData(ctx: Ctx, input: any = {}): Promise<{ filename: string; mimeType: string; content: string }> {
  if (input.includeOriginals === true || !['json', 'csv'].includes(input.format || 'json')) fail('JSON 또는 CSV 데이터 내보내기를 선택하세요. 원본 파일은 포함하지 않습니다.');
  const output: Record<string, Row[]> = {};
  let total = 0, bytes = 0;
  for (const name of Object.keys(tables) as Table[]) {
    output[name] = [];
    for (let offset = 0; ; offset += 1000) {
      const order = keys[name]?.filter(key => key !== 'user_id') || ['id'];
      let query = ctx.db.from(name).select(tables[name].join(',')).eq('user_id', ctx.user.id);
      for (const key of order) query = query.order(key, { ascending: true });
      const { data, error } = await query.range(offset, offset + 999);
      if (error || !Array.isArray(data)) throw new AppError('데이터를 내보내지 못했습니다. 연결 상태를 확인하세요.', 500);
      for (const row of data) {
        if (row.user_id !== ctx.user.id) fail();
        const projected = Object.fromEntries(tables[name].filter(column => column in row).map(column => [column, row[column]]));
        const clean = walk(projected, ctx.user.id, true);
        validateRow(name, clean, ctx.user.id);
        bytes += new TextEncoder().encode(JSON.stringify(clean)).byteLength;
        if (++total > maxRows || output[name].length >= maxTableRows || bytes > maxBytes) fail('백업 데이터가 20MB 또는 항목 한도를 넘습니다. 콘텐츠별 내보내기를 이용하세요.');
        output[name].push(clean);
      }
      if (data.length < 1000) break;
    }
  }
  const packageData: BackupPackage = { schemaVersion: 1, type: 'restudy-backup', ownerId: ctx.user.id, createdAt: new Date().toISOString(), originalsIncluded: false, sameAccountOnly: true, tables: output };
  const date = packageData.createdAt.slice(0, 10);
  if (input.format === 'csv') {
    const cell = (value: string) => '"' + (/^[=+@\-\t\r]/.test(value) ? "'" + value : value).replaceAll('"', '""') + '"';
    const content = '\uFEFFtable,record_json\r\n' + Object.entries(output).flatMap(([table, records]) => records.map(row => `${cell(table)},${cell(JSON.stringify(row))}`)).join('\r\n');
    return { filename: `restudy-data-${date}.csv`, mimeType: 'text/csv; charset=utf-8', content };
  }
  const content = JSON.stringify(packageData);
  if (new TextEncoder().encode(content).byteLength > maxBytes) fail('백업 데이터가 20MB 한도를 넘습니다.');
  return { filename: `restudy-backup-${date}.json`, mimeType: 'application/json', content };
}

export async function restoreData(ctx: Ctx, input: any): Promise<any> {
  const packageData = validateBackup(input?.package, ctx.user.id);
  const { data, error } = await ctx.admin.rpc('restore_restudy_backup', { p_user_id: ctx.user.id, p_package: packageData });
  if (error || !data || data.restored !== true) throw new AppError('데이터를 복원하지 못했습니다. ID·참조 충돌 또는 서버 준비 상태를 확인하세요. 기존 데이터는 변경하지 않았습니다.', 409);
  return { ...data, originalsIncluded: false, sameAccountOnly: true, notice: '기존 항목은 유지하고 누락된 ID만 복원했습니다. 원본 PDF·이미지는 백업에 포함되지 않으며 같은 계정의 Storage에 남아 있어야 열 수 있습니다.' };
}
