/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface ParsedQR {
 moduleId?: string;
 instanceId?: string;
 legacyCode?: string;
 cncid?: string;
 moduleCode?: string;
 cthtId?: string;
}

/**
 * Phân tích dữ liệu thô từ mã QR quét được.
 * Hỗ trợ các định dạng:
 * 1. Dạng 1 (CNC thô): 26.MOR026_ENT.T1 (cncid = 26, moduleCode = MOR026_ENT.T1)
 * 2. Dạng 2 (Cấu kiện lắp ráp): MOR026_ENT.T1|1 (moduleCode = MOR026_ENT.T1, instanceIndex = 1)
 * 3. JSON mới: {"moduleId": "abc", "instanceId": "Cánh tủ|2"}
 * 4. Text mới: moduleId=abc|instanceId=Cánh tủ|2
 * 5. Legacy (cũ): Chỉ chứa mã code thông thường
 */
export function parseQRCode(rawCode: string): ParsedQR {
 const trimmedTemp = rawCode.trim();
 // 1. Loại bỏ hậu tố ----EASYCABINET---- hoặc |DRACO DESIGN & BUILD
 let trimmed = trimmedTemp.replace(/----?DRACO DESIGN\s*&\s*BUILD----?$/i, '').trim();
 if (!trimmed) return {};

 // 1b. CTHT format: ${id}|${name} (id bắt đầu bằng ctht-)
 const cthtMatch = trimmed.match(/^(ctht-\d+)\|(.+)$/);
 if (cthtMatch) {
   return {
     moduleId: cthtMatch[2].trim(),
     moduleCode: cthtMatch[2].trim(),
     instanceId: cthtMatch[0],
     cthtId: cthtMatch[1].trim(),
   };
 }

 // 1. Kiểm tra định dạng text mới: moduleId=abc|instanceId=Cánh tủ|2
 const newFormatMatch = trimmed.match(/^moduleId=([^|]+)\|instanceId=(.+)$/);
 if (newFormatMatch) {
  return {
   moduleId: newFormatMatch[1].trim(),
   instanceId: newFormatMatch[2].trim(),
  };
 }

 // 2. Kiểm tra định dạng JSON
 if (trimmed.startsWith('{')) {
  try {
   const parsed = JSON.parse(trimmed);
   if (parsed.moduleId) {
    return {
     moduleId: String(parsed.moduleId).trim(),
     instanceId: parsed.instanceId ? String(parsed.instanceId).trim() : undefined,
    };
   }
  } catch (e) {
   // Bỏ qua lỗi JSON parse
  }
 }

 // 3. Tách phần CNC ID nếu có (ví dụ: "26.MOR026_ENT.T1|1" hoặc "26.MOR026_ENT.T1")
 let cncid: string | undefined = undefined;
 let remaining = trimmed;
 const cncMatch = trimmed.match(/^(\d+)\.(.+)$/);
 if (cncMatch) {
  const cncVal = cncMatch[1].trim();
  const rest = cncMatch[2].trim();
  // Đảm bảo phần còn lại không phải là số đơn thuần để tránh nhầm lẫn các định dạng khác
  if (rest.includes('_') || rest.includes('.') || rest.includes('|') || isNaN(Number(rest))) {
   cncid = cncVal;
   remaining = rest;
  }
 }

 // 4. Kiểm tra cấu kiện lắp ráp có index (ví dụ: "MOR026_ENT.T1|1")
 const instanceMatch = remaining.match(/^([^|]+)\|(\d+)$/);
 if (instanceMatch) {
  const modCode = instanceMatch[1].trim();
  const instIndex = instanceMatch[2].trim();
  return {
   moduleId: modCode,
   moduleCode: modCode,
   instanceId: `${modCode}|${instIndex}`, // Chuẩn hóa ID instance thành "ModuleCode|Index"
   cncid: cncid,
  };
 }

 // Fallback: tách theo dấu '='
 const parts = remaining.split('=');
 if (parts.length >= 2) {
  const key = parts[0];
  const rest = parts.slice(1).join('=');
  if (key === 'moduleId') {
   return { moduleId: rest.trim(), cncid: cncid };
  }
 }

 // Nếu không khớp, trả về legacy code
 return { legacyCode: remaining, moduleId: remaining, cncid: cncid };
}
