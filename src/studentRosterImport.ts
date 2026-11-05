export type StudentRosterRow = {
    name: string;
    phone: string;
    studentNumber: string;
};
/** Treat spreadsheet cells as data. Preserve numeric phones without scientific
 * notation, and show every normalized value before provisioning any account. */
export async function parseStudentRoster(file: File): Promise<StudentRosterRow[]> {
    if (file.size > 3 * 1024 * 1024)
        throw new Error('名单文件请控制在 3 MB 以内');
    const XLSX = await import('xlsx');
    const book = XLSX.read(await file.arrayBuffer(), { type: 'array', raw: true });
    const sheet = book.Sheets[book.SheetNames[0]];
    if (!sheet)
        throw new Error('文件中没有可读取的名单');
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: '' });
    return normalizeRosterMatrix(rows);
}
export function normalizeRosterMatrix(matrix: unknown[][]): StudentRosterRow[] {
    const rows = matrix.filter(row => row.some(v => String(v ?? '').trim()));
    if (!rows.length)
        throw new Error('名单为空');
    const header = rows[0].map(v => String(v ?? '').replace(/^\uFEFF/, '').trim()), name = header.findIndex(v => ['姓名', '学生姓名', 'name'].includes(v)), phone = header.findIndex(v => ['手机号', '手机号码', '手机', 'phone'].includes(v)), number = header.findIndex(v => ['学号', '学生学号', 'studentNumber'].includes(v));
    if (name < 0 || phone < 0)
        throw new Error('表头至少需要“姓名”和“手机号”，可另加“学号”');
    if (rows.length > 201)
        throw new Error('每批最多导入 200 名学生');
    return rows.slice(1).map((row, i) => { const n = String(row[name] ?? '').trim(), p = String(row[phone] ?? '').trim().replace(/^\+86/, '').replace(/[ -]/g, ''); if (!n || n.length > 80)
        throw new Error(`第 ${i + 2} 行姓名为空或过长`); if (!/^1[3-9]\d{9}$/.test(p))
        throw new Error(`第 ${i + 2} 行手机号格式不正确`); return { name: n, phone: p, studentNumber: number < 0 ? '' : String(row[number] ?? '').trim() }; });
}
