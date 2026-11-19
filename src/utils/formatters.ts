import type { ConsolidationRowInput } from '../types';

export function formatRelativeTime(isoString: string): string {
  if (!isoString) return 'Nunca';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return isoString;
  const diffSec = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (diffSec < 60) return 'hace unos seg';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `hace ${diffMin} min`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `hace ${diffHr} h`;
  const diffDays = Math.floor(diffHr / 24);
  return `hace ${diffDays} d`;
}

export function formatUptime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

export function downloadCsv(filename: string, headers: string[], rows: (string | number)[][]): void {
  const escapeCell = (val: string | number): string => {
    const str = String(val ?? '');
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes(';')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const lines = [
    headers.map(escapeCell).join(','),
    ...rows.map((row) => row.map(escapeCell).join(',')),
  ];

  // UTF-8 BOM so Microsoft Excel renders Spanish accents properly
  const bom = '\uFEFF';
  const blob = new Blob([bom + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function downloadExcelSpreadsheet(
  filename: string,
  sheetName: string,
  headers: string[],
  rows: (string | number)[][],
  instructions?: [string, string][],
): void {
  const escXml = (val: string | number) =>
    String(val ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const safeSheet = escXml(sheetName.slice(0, 30) || 'Datos');
  const headerCells = headers
    .map((h) => `<Cell ss:StyleID="hdr"><Data ss:Type="String">${escXml(h)}</Data></Cell>`)
    .join('');

  const dataRows = rows
    .map(
      (r) =>
        `<Row>${r
          .map((cell) => `<Cell><Data ss:Type="String">${escXml(cell)}</Data></Cell>`)
          .join('')}</Row>`,
    )
    .join('');

  let instructionsSheet = '';
  if (instructions && instructions.length > 0) {
    const instRows = instructions
      .map(
        ([colA, colB], idx) =>
          `<Row>${`<Cell${idx === 0 ? ' ss:StyleID="title"' : ''}><Data ss:Type="String">${escXml(colA)}</Data></Cell><Cell><Data ss:Type="String">${escXml(colB)}</Data></Cell>`}</Row>`,
      )
      .join('');
    instructionsSheet = `
      <Worksheet ss:Name="Instrucciones">
        <Table>
          <Column ss:Width="200"/>
          <Column ss:Width="340"/>
          ${instRows}
        </Table>
      </Worksheet>`;
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Styles>
  <Style ss:ID="hdr">
   <Font ss:Bold="1" ss:Color="#FFFFFF"/>
   <Interior ss:Color="#185FA5" ss:Pattern="Solid"/>
  </Style>
  <Style ss:ID="title">
   <Font ss:Bold="1" ss:Size="12" ss:Color="#185FA5"/>
  </Style>
 </Styles>
 <Worksheet ss:Name="${safeSheet}">
  <Table>
   ${headers.map(() => '<Column ss:Width="135"/>').join('')}
   <Row>${headerCells}</Row>
   ${dataRows}
  </Table>
 </Worksheet>${instructionsSheet}
</Workbook>`;

  const blob = new Blob([xml], { type: 'application/vnd.ms-excel;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', filename.endsWith('.xls') ? filename : `${filename}.xls`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function splitDelimitedLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      out.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  out.push(current.trim());
  return out;
}

export function parseRawSpreadsheetText(rawText: string): Record<string, string>[] {
  const trimmed = rawText.trim().replace(/^\uFEFF/, '');
  if (!trimmed) return [];

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      return arr
        .filter((item) => item && typeof item === 'object')
        .map((item: Record<string, unknown>) => {
          const out: Record<string, string> = {};
          for (const [k, v] of Object.entries(item)) {
            out[k] = v === null || v === undefined ? '' : String(v).trim();
          }
          return out;
        });
    } catch {
      // fall through to CSV parser
    }
  }

  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];

  const first = lines[0];
  const delimiter = first.includes('\t')
    ? '\t'
    : first.includes(';') && !first.includes(',')
      ? ';'
      : ',';

  const headers = splitDelimitedLine(lines[0], delimiter);
  const normHeaders = headers.map((h) =>
    h
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim(),
  );

  const hasHeader = normHeaders.some((h) =>
    [
      'email',
      'correo',
      'nombre',
      'name',
      'rut',
      'dni',
      'estado',
      'status',
      'upn',
      'sap_user',
      'sf_username',
      'empleado_id',
      'usuario',
      'username',
      'id_usuario',
    ].some((token) => h.includes(token)),
  );

  const effectiveHeaders = hasHeader
    ? headers
    : ['nombre', 'email', 'rut', 'departamento', 'estado', 'usuario', 'rol'];
  const dataLines = hasHeader ? lines.slice(1) : lines;

  return dataLines.map((line) => {
    const cells = splitDelimitedLine(line, delimiter);
    const obj: Record<string, string> = {};
    effectiveHeaders.forEach((h, idx) => {
      const key = h || `col_${idx + 1}`;
      obj[key] = (cells[idx] ?? '').trim();
    });
    return obj;
  });
}

export function parseCsvText(rawText: string): ConsolidationRowInput[] {
  const trimmed = rawText.trim().replace(/^\uFEFF/, '');
  if (!trimmed) return [];

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      return arr
        .filter((item) => item && typeof item === 'object')
        .map((item: Record<string, unknown>) => ({
          rut: String(item.rut ?? item.dni ?? item.id ?? ''),
          name: String(item.name ?? item.nombre ?? item.fullName ?? ''),
          email: String(item.email ?? item.correo ?? item.mail ?? ''),
          dept: String(item.dept ?? item.departamento ?? item.area ?? 'General'),
          position: String(item.position ?? item.cargo ?? item.role ?? 'Colaborador'),
          status: String(item.status ?? item.estado ?? 'Activo'),
          username: String(item.username ?? item.usuario ?? ''),
          role: String(item.role ?? item.perfil ?? 'Usuario Estándar'),
          reason: item.reason ? String(item.reason) : item.motivo ? String(item.motivo) : undefined,
          offboardDate: item.offboardDate
            ? String(item.offboardDate)
            : item.fecha_baja
              ? String(item.fecha_baja)
              : undefined,
        }));
    } catch {
      // fall through
    }
  }

  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];

  const delimiter = lines[0].includes(';') && !lines[0].includes(',') ? ';' : ',';
  const rawHeaders = splitDelimitedLine(lines[0], delimiter).map((h) =>
    h
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim(),
  );

  const hasHeader = rawHeaders.some((h) =>
    ['email', 'correo', 'nombre', 'name', 'rut', 'dni', 'estado', 'status'].includes(h),
  );

  const dataLines = hasHeader ? lines.slice(1) : lines;
  const colIndex = (candidates: string[], fallback: number): number => {
    if (!hasHeader) return fallback;
    return rawHeaders.findIndex((h) => candidates.some((c) => h.includes(c)));
  };

  const idxName = colIndex(['nombre', 'name', 'colaborador'], 0);
  const idxEmail = colIndex(['email', 'correo', 'mail', 'upn'], 1);
  const idxRut = colIndex(['rut', 'dni', 'cedula', 'identificacion'], 2);
  const idxDept = colIndex(['depto', 'departamento', 'dept', 'area'], 3);
  const idxStatus = colIndex(['estado', 'status'], 4);
  const idxUsername = colIndex(['usuario', 'username', 'cuenta', 'sap_user', 'sf_username'], -1);
  const idxRole = colIndex(['rol', 'perfil', 'role'], -1);
  const idxPosition = colIndex(['cargo', 'puesto', 'position'], -1);
  const idxReason = colIndex(['motivo', 'reason'], -1);
  const idxDate = colIndex(['fecha_baja', 'fecha', 'offboard'], -1);

  return dataLines
    .map((line) => {
      const cells = splitDelimitedLine(line, delimiter);
      return {
        name: idxName >= 0 ? cells[idxName] ?? '' : '',
        email: idxEmail >= 0 ? cells[idxEmail] ?? '' : '',
        rut: idxRut >= 0 ? cells[idxRut] ?? '' : '',
        dept: idxDept >= 0 ? cells[idxDept] ?? 'General' : 'General',
        status: idxStatus >= 0 ? cells[idxStatus] ?? 'Activo' : 'Activo',
        username: idxUsername >= 0 ? cells[idxUsername] ?? '' : '',
        role: idxRole >= 0 ? cells[idxRole] ?? '' : '',
        position: idxPosition >= 0 ? cells[idxPosition] ?? '' : '',
        reason: idxReason >= 0 ? cells[idxReason] : undefined,
        offboardDate: idxDate >= 0 ? cells[idxDate] : undefined,
      };
    })
    .filter((r) => Boolean(r.email || r.rut || r.name));
}
