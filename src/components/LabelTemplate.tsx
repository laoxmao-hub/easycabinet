/**
 * Shared label template — SINGLE source of truth.
 * Both PackingScreen and PrinterStationScreen use generateLabelCardHtml().
 * Edit template here → both places update automatically.
 */

export interface LabelPayload {
  name: string;
  projectName: string;
  unit: string;
  area: string;
  cabinetType: string;
  w: string;
  d: string;
  h: string;
  weight: string;
  qrUrl?: string;
  instanceIndex?: number;
  totalInstances?: number;
  supplierDept?: string;
  deliveryAddress?: string;
  receiverName?: string;
  receiverPhone?: string;
  printDate?: string;
}

/**
 * Generate just the label card HTML (no page wrapper, no <style>).
 * This is the SINGLE source of truth for the label visual template.
 */
export function generateLabelCardHtml(
  payload: LabelPayload,
  sw: string = 'UNIT',
  formTemplate: string = 'mau1'
): string {
  const hasInstance = payload.totalInstances && payload.totalInstances > 1 && payload.instanceIndex;
  const cabinetDisplay = hasInstance && !payload.cabinetType?.includes('(')
    ? `${payload.cabinetType} (${payload.instanceIndex}/${payload.totalInstances})`
    : payload.cabinetType;

  const unitLabel = sw === 'CODE' ? 'CODE' : 'UNIT';

  if (formTemplate === 'mau2') {
    return `
  <div class="print-label-card">
    <div class="header-mau2">
      <div class="header-mid">
        <div class="header-mid-top">
          <div class="header-label">PROJECT</div>
          <div class="header-value">${payload.projectName}</div>
        </div>
        <div class="header-mid-bot">
          <div class="header-label">SUPPLIER</div>
          <div class="header-value">EASY CABINET</div>
        </div>
      </div>
      <div class="header-easy">
        <img src="https://res.cloudinary.com/dj7w4kp5m/image/upload/v1784541481/logo-easycabinet-transparent_hahs7u.png" />
      </div>
    </div>
    <div class="info-row">
      <div class="info-cell"><div class="info-title">${unitLabel}</div><div class="info-value">${payload.unit}</div></div>
      <div class="info-cell"><div class="info-title">AREA</div><div class="info-value">${payload.area}</div></div>
      <div class="info-cell"><div class="info-title">CABINET TYPE</div><div class="info-value">${cabinetDisplay}</div></div>
      <div class="qr-cell"><img src="${payload.qrUrl || ''}" /></div>
    </div>
    <div class="size-row">
      <div class="size-section">
        <div class="size-title">SIZE (MM)</div>
        <div class="size-grid">
          <div class="size-cell"><div class="size-k">W</div><div class="size-v">${payload.w}</div></div>
          <div class="size-cell"><div class="size-k">D</div><div class="size-v">${payload.d}</div></div>
          <div class="size-cell"><div class="size-k">H</div><div class="size-v">${payload.h}</div></div>
        </div>
      </div>
      <div class="weight-section">
        <div class="weight-title">WEIGHT</div>
        <div class="weight-value">${payload.weight} Kg</div>
      </div>
    </div>
    <div class="icons-row">
      <img src="https://res.cloudinary.com/dj7w4kp5m/image/upload/v1782286423/logochan_m2cj0i.jpg" />
    </div>
    <div class="footer">MADE IN VIETNAM</div>
  </div>`;
  }

  // ====================== MẪU BCONS ======================
  if (formTemplate === 'mauBcons') {
    const dateStr = new Date().toLocaleDateString('vi-VN');
    const rawName = payload.name || '';
    const unitPrefix = (rawName.match(/^([A-Z0-9]+)_/i) || [])[1] || payload.unit || '';
    const cleanName = rawName.replace(/^BCOA1_/i, '').replace(/#(\d+\/\d+)/g, '($1)');
    return `<div class="bcons-card">
  <!-- DRACO HEADER -->
  <div class="bcons-header">
  <img
              src="https://res.cloudinary.com/dj7w4kp5m/image/upload/v1785313584/logo2_y69rpm.png"
              alt="Logo"
              referrerPolicy="no-referrer"
            />
    
  </div>

  <!-- TITLE BOX -->
  <div class="bcons-title">
    TEM XUẤT XƯỞNG
  </div>

  <!-- INFO + QR ROW -->
  <div class="bcons-info-qr-row">
    <div class="bcons-info-left">
      <table class="bcons-info-table">
        <tr>
          <td class="bcons-label"><u><i>Dự án:</i></u></td>
          <td class="bcons-value">${payload.projectName || ''}</td>
        </tr>
        <tr>
          <td class="bcons-label"><u><i>BP xuất xưởng</i></u></td>
          <td class="bcons-value">${payload.supplierDept || 'Kho thành phẩm - DRACO'}</td>
        </tr>
        <tr>
          <td class="bcons-label"><u><i>Địa chỉ nhận hàng</i></u></td>
          <td class="bcons-value">${payload.deliveryAddress || ''}</td>
        </tr>
        <tr>
          <td class="bcons-label"><u><i>Người nhận:</i></u></td>
          <td class="bcons-value">${payload.receiverName || ''}</td>
        </tr>
        <tr>
          <td class="bcons-label"><u><i>SĐT:</i></u></td>
          <td class="bcons-value">${payload.receiverPhone || ''}</td>
        </tr>
        <tr>
          <td class="bcons-label"><u><i>Ngày:</i></u></td>
          <td class="bcons-value">${dateStr}</td>
        </tr>
      </table>
    </div>
    <div class="bcons-info-right">
      ${payload.qrUrl ? `<img class="bcons-qr-img" src="${payload.qrUrl}">` : ''}
    </div>
  </div>

  <!-- BIG CONTENT BOX -->
  <div class="bcons-box-wrapper">
    <div class="bcons-box">
      <table class="bcons-inner-table">
        <colgroup>
          <col style="width:44%">
          <col style="width:12%">
          <col style="width:12%">
          <col style="width:12%">
          <col style="width:20%">
        </colgroup>
        <thead>
          <tr>
            <th>Tên kiện hàng / Module</th>
            <th>W</th>
            <th>D</th>
            <th>H</th>
            <th>KL (Kg)</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style="font-weight:bold; font-size:12pt; text-align:center;">${cleanName}</td>
            <td style="text-align:center;">${payload.w || ''}</td>
            <td style="text-align:center;">${payload.d || ''}</td>
            <td style="text-align:center;">${payload.h || ''}</td>
            <td style="text-align:center; font-weight:bold;">${payload.weight || ''}</td>
          </tr>

          <tr>
            <td colspan="5" class="bcons-meta-row">
              <span><b>UNIT:</b> ${unitPrefix}</span>
              <span style="margin: 0 10px; color: #888;">|</span>
              <span><b>AREA:</b> ${payload.area || ''}</span>
              <span style="margin: 0 10px; color: #888;">|</span>
              <span><b>TYPE:</b> ${cabinetDisplay}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <div class="bcons-footer">MADE IN VIETNAM</div>
</div>`;
  }

  // ====================== MẪU 1 (mặc định) ======================
  return `
  <div class="print-label-card">
    <div class="header">
      <div class="header-jdb">
        <img src="https://res.cloudinary.com/dj7w4kp5m/image/upload/v1782285811/JDB_deqzgc.png" />
      </div>
      <div class="header-mid">
        <div class="header-mid-top">
          <div class="header-label">PROJECT</div>
          <div class="header-value">${payload.projectName}</div>
        </div>
        <div class="header-mid-bot">
          <div class="header-label">SUPPLIER</div>
          <div class="header-value">EASY CABINET</div>
        </div>
      </div>
      <div class="header-easy">
        <img src="https://res.cloudinary.com/dj7w4kp5m/image/upload/v1784541481/logo-easycabinet-transparent_hahs7u.png" />
      </div>
    </div>
    <div class="info-row">
      <div class="info-cell"><div class="info-title">${unitLabel}</div><div class="info-value">${payload.unit}</div></div>
      <div class="info-cell"><div class="info-title">AREA</div><div class="info-value">${payload.area}</div></div>
      <div class="info-cell"><div class="info-title">CABINET TYPE</div><div class="info-value">${cabinetDisplay}</div></div>
      <div class="qr-cell"><img src="${payload.qrUrl || ''}" /></div>
    </div>
    <div class="size-row">
      <div class="size-section">
        <div class="size-title">SIZE (MM)</div>
        <div class="size-grid">
          <div class="size-cell"><div class="size-k">W</div><div class="size-v">${payload.w}</div></div>
          <div class="size-cell"><div class="size-k">D</div><div class="size-v">${payload.d}</div></div>
          <div class="size-cell"><div class="size-k">H</div><div class="size-v">${payload.h}</div></div>
        </div>
      </div>
      <div class="weight-section">
        <div class="weight-title">WEIGHT</div>
        <div class="weight-value">${payload.weight} Kg</div>
      </div>
    </div>
    <div class="icons-row">
      <img src="https://res.cloudinary.com/dj7w4kp5m/image/upload/v1782286423/logochan_m2cj0i.jpg" />
    </div>
    <div class="footer">MADE IN VIETNAM</div>
  </div>`;
}

/**
 * Shared CSS for label rendering. Used by both PackingScreen and PrinterStationScreen.
 */
export const LABEL_CSS = `
  @page { size: A5 landscape; margin: 0; }
  #label-print-area, #label-print-area * {
    box-sizing: border-box;
  }

  @media screen {
    .print-page-wrapper {
      width: 210mm; height: 148mm;
      border: 1px dashed #ccc;
      margin-bottom: 10px;
      display: flex; align-items: center; justify-content: center;
    }
  }

  @media print {
    body { margin: 0; padding: 0; background: white; }
    .print-page-wrapper {
      width: 210mm !important;
      height: 148mm !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      box-sizing: border-box !important;
      page-break-after: always !important;
      break-after: page !important;
      page-break-inside: avoid !important;
      break-inside: avoid !important;
      margin: 0 !important;
      padding: 0 !important;
      background: white !important;
    }
    .print-page-wrapper:last-child {
      page-break-after: avoid !important;
      break-after: avoid !important;
    }
  }

  .print-label-card {
    width: 200mm;
    border: 3px solid black; padding: 6mm;
    display: flex; flex-direction: column;
    box-sizing: border-box;
  }

  .header {
    display: grid; grid-template-columns: 37mm 79mm 1fr;
    border: 1px solid black; min-height: 16mm;
  }
  .header-mau2 {
    display: grid; grid-template-columns: 79mm 1fr;
    border: 1px solid black; min-height: 16mm;
  }
  .header-jdb { display: flex; align-items: center; }
  .header-jdb img { width: 100%; height: auto; }
  .header-mid { border-left: 1px solid black; display: flex; flex-direction: column; }
  .header-mid-top, .header-mid-bot { display: flex; flex: 1; }
  .header-mid-top { border-bottom: 1px solid black; }
  .header-label {
    width: 32%; border-right: 1px solid black;
    display: flex; align-items: center; padding: 0 3px;
    font-weight: 900; font-size: 16px;
  }
  .header-value {
    flex: 1; display: flex; align-items: center; padding: 0 4px;
    font-weight: 700; font-size: 16px; text-transform: uppercase;
  }
  .header-easy { display: flex; align-items: center; justify-content: center; border-left: 1px solid black; }
  .header-easy img { width: 90%; height: auto; }

  .info-row {
    display: grid; grid-template-columns: 1fr 1.5fr 1.5fr 42mm;
    border-left: 1px solid black; border-right: 1px solid black; border-bottom: 1px solid black;
  }
  .info-cell { border-right: 1px solid black; display: flex; flex-direction: column; text-align: center; }
  .info-cell:last-of-type { border-right: none; }
  .info-title { border-bottom: 1px solid black; padding: 2px 0; font-weight: 900; font-size: 17px; }
  .info-value { flex: 1; display: flex; align-items: center; justify-content: center; font-size: 21px; font-weight: 700; text-transform: uppercase; }
  .qr-cell { display: flex; align-items: center; justify-content: center; padding: 2px; border-left: 1px solid black; }
  .qr-cell img { width: 100%; height: 100%; object-fit: contain; }

  .size-row {
    display: grid; grid-template-columns: 3fr 1fr;
    border-left: 1px solid black; border-right: 1px solid black; border-bottom: 1px solid black;
  }
  .size-section { border-right: 1px solid black; display: flex; flex-direction: column; }
  .size-title { border-bottom: 1px solid black; text-align: center; font-weight: 900; font-size: 17px; padding: 1px 0; }
  .size-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; flex: 1; }
  .size-cell { display: flex; flex-direction: column; align-items: center; justify-content: center; border-right: 1px solid black; }
  .size-cell:last-child { border-right: none; }
  .size-k { font-size: 16px; font-weight: 900; }
  .size-v { font-size: 16px; font-weight: 700; border-top: 1px solid black; width: 100%; text-align: center; padding: 1px 0; }
  .weight-section { display: flex; flex-direction: column; text-align: center; }
  .weight-title { border-bottom: 1px solid black; font-weight: 900; font-size: 17px; padding: 1px 0; }
  .weight-value { flex: 1; display: flex; align-items: center; justify-content: center; font-size: 21px; font-weight: 900; }

  .icons-row {
    border-left: 1px solid black; border-right: 1px solid black; border-bottom: 1px solid black;
    overflow: hidden; padding: 3mm 4mm;
  }
  .icons-row img { width: 95%; height: auto; display: block; margin: 0 auto; }

  .footer {
    border: 1px solid black; text-align: center;
    font-size: 17px; font-weight: 900; letter-spacing: 0.3em;
    text-transform: uppercase; padding: 1px 0;
  }

  /* ===== MẪU BCONS — A5 Landscape Table Layout ===== */
  .bcons-card {
    width: 200mm;
    min-height: 138mm;
    padding: 10px;
    border: 2px solid black;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    background: white;
    font-family: Arial, Helvetica, sans-serif;
  }

  /* DRACO HEADER */
  .bcons-header {
    margin-bottom: 10px;
    overflow: hidden;
  }

  .bcons-header img {
    width: 100%;
    height: auto;
    display: block;
  }

  .bcons-header-logo {
    background: #000000;
    color: #ffffff;
    padding: 8px 16px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    min-width: 170px;
  }

  .draco-logo-title {
    font-family: 'Times New Roman', Times, serif;
    font-size: 18pt;
    font-weight: bold;
    letter-spacing: 0.18em;
    color: #ffffff;
    line-height: 1;
  }

  .draco-logo-sub {
    font-family: Arial, sans-serif;
    font-size: 7.5pt;
    font-weight: 600;
    letter-spacing: 0.22em;
    color: #d4af37;
    margin-top: 4px;
    white-space: nowrap;
  }

  .bcons-header-info {
    flex: 1;
    padding: 4px 10px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    font-size: 8.5pt;
  }

  .info-row-1 {
    font-size: 8.5pt;
    color: #000;
    white-space: nowrap;
  }

  .info-row-2 {
    display: flex;
    justify-content: space-between;
    font-size: 8.5pt;
    color: #000;
    font-weight: 500;
  }

  .info-row-3 {
    display: flex;
    justify-content: space-between;
    font-size: 9pt;
    font-weight: bold;
    color: #d97706;
    letter-spacing: 0.02em;
  }

  /* TITLE BOX */
  .bcons-title {
    border: 2px solid #2563eb;
    color: #0000ff;
    font-size: 20pt;
    font-weight: bold;
    text-align: center;
    padding: 6px 0;
    margin-bottom: 10px;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  /* INFO TABLE */
  /* INFO + QR ROW */
  .bcons-info-qr-row {
    display: flex;
    align-items: stretch;
    gap: 10px;
    margin-bottom: 6px;
  }

  .bcons-info-left {
    flex: 1;
  }

  .bcons-info-right {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .bcons-info-table {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 0;
  }

  .bcons-info-table td {
    padding: 1px 0;
    vertical-align: middle;
  }

  .bcons-label {
    font-size: 11pt;
    color: #000;
    white-space: nowrap;
  }

  .bcons-value {
    font-size: 11pt;
    font-weight: bold;
    color: #000;
  }

  /* BIG BOTTOM BOX */
  .bcons-box-wrapper {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 8px 0;
  }

  .bcons-box {
    width: 100%;
  }

  .bcons-inner-table {
    width: 100%;
    border-collapse: collapse;
  }

  .bcons-inner-table th {
    border: 1px solid #000;
    background: #f1f5f9;
    text-align: center;
    padding: 6px 4px;
    font-size: 11pt;
    font-weight: bold;
  }

  .bcons-inner-table td {
    border: 1px solid #000;
    padding: 6px 4px;
    font-size: 11pt;
  }

  .bcons-meta-row {
    font-size: 11pt;
    padding: 6px 8px !important;
  }

  .bcons-qr-img {
    width: 132px;
    height: 132px;
    object-fit: contain;
    display: block;
  }

  .bcons-footer {
    text-align: center;
    font-weight: bold;
    font-size: 11pt;
    letter-spacing: 0.05em;
    padding: 6px 0 0 0;
  }
`;

/**
 * Generate full HTML page for iframe printing (PrinterStationScreen).
 * Uses generateLabelCardHtml + LABEL_CSS as single source of truth.
 */
export function generateLabelHtml(payload: LabelPayload, copies: number = 4, sw: string = 'UNIT', formTemplate: string = 'mau1'): string {
  const cardHtml = generateLabelCardHtml(payload, sw, formTemplate);
  return `<!DOCTYPE html>
<html>
<head>
<style>
${LABEL_CSS}
</style>
</head>
<body>
${Array(copies).fill(0).map((_, i) => `<div class="print-page-wrapper" key="${i}">${cardHtml}</div>`).join('\n')}
</body>
</html>`;
}
