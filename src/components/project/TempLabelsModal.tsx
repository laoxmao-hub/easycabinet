/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useRef, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Printer, Download, CreditCard, AlertCircle, RefreshCw } from 'lucide-react';
import QRCode from 'qrcode';
import { ProjectEntry, getModuleInstances, ModuleInstance } from '../../types';
import { buildAndSortTree } from '../../screens/ProjectManagementScreen';
import { doc, writeBatch, getDoc, setDoc } from 'firebase/firestore';
import { db, cleanUndefinedFields } from '../../lib/firebase';
import { batchUpdateProjectModules } from '../../lib/dualWrite';

export const getEntryTypeClassification = (entry: any): 'Thùng' | 'Cánh' | 'Đợt' | 'Mặt HK' | 'CTHT' => {
 const code = entry.moduleCode || '';
 const codeLower = code.toLowerCase();

 // Kiểm tra nếu gốc là "Thùng" (nếu cũ không phải Cánh/Mặt HK và không phải CTHT)
 const isOriginalCanhMatHK = codeLower.includes('mặt học kéo') || codeLower.includes('mat hoc keo') || codeLower.includes('cửa') || codeLower.includes('cua');
 const isOriginalCTHT = codeLower.includes('tấm hoàn thiện') || codeLower.includes('tam hoan thien') || codeLower.includes('hoàn thiện') || codeLower.includes('hoan thien') || codeLower.includes('ctht') || code.split('_').length >= 3;

 if (!isOriginalCanhMatHK && !isOriginalCTHT) {
 return 'Thùng';
 }

 // 1. Module nào có "Cánh" hoặc "Cửa" trong tên -> "Cánh"
 if (codeLower.includes('cánh') || codeLower.includes('canh') || codeLower.includes('cửa') || codeLower.includes('cua')) {
 return 'Cánh';
 }

 // 2. có "Đợt" trong tên -> "Đợt"
 if (codeLower.includes('đợt') || codeLower.includes('dot')) {
 return 'Đợt';
 }

 // 3. có "Mặt" trong tên -> "Mặt HK"
 if (codeLower.includes('mặt') || codeLower.includes('mat')) {
 return 'Mặt HK';
 }

 // 4. còn lại -> "CTHT"
 return 'CTHT';
};

export const getEntryType = (entry: any): 'Thùng' | 'Cánh' | 'Đợt' | 'Mặt HK' | 'CTHT' => {
 if (entry.classification) {
 return entry.classification;
 }
 return getEntryTypeClassification(entry);
};

interface TempLabelCanvasProps {
 labelId: string;
 module: ProjectEntry;
 projectCode: string;
 instance: ModuleInstance;
 totalQuantity: number;
 sttValue: string;
 onRenderComplete?: (labelId: string, dataUrl: string) => void;
}

export function TempLabelCanvas({ labelId, module, projectCode, instance, totalQuantity, sttValue, onRenderComplete }: TempLabelCanvasProps) {
 const canvasRef = useRef<HTMLCanvasElement | null>(null);
 const [imgUrl, setImgUrl] = useState<string>('');

 useEffect(() => {
 const canvas = canvasRef.current;
 if (!canvas) return;

 const draw = async () => {
 const ctx = canvas.getContext('2d');
 if (!ctx) return;

 // Reset canvas sang màu trắng tinh khiết
 ctx.fillStyle = '#FFFFFF';
 ctx.fillRect(0, 0, 600, 400);

 // Đường kẻ dọc phân cách trung tâm (Nới lỏng phần bên phải rộng hơn để chữ to hơn)
 // Đường dọc dời về bên trái (x = 245) để dành diện tích vô cùng rộng rãi cho chữ bên phải (340px)
 ctx.strokeStyle = '#000000';
 ctx.lineWidth = 3;
 ctx.beginPath();
 ctx.moveTo(245, 10);
 ctx.lineTo(245, 390);
 ctx.stroke();

 // Chuẩn bị chuỗi định danh cấu kiện (không hiển thị hậu tố -1/3 nữa vì đã có tỉ lệ đếm phía dưới)
 const printableCode = module.moduleCode;

 try {
 // Tăng margin lên 4 (Quiet Zone chuẩn tốt nhất cho quét QR) để tách biệt hạt QR khỏi viền xung quanh
 // Thiết lập cố định version và errorCorrectionLevel để mọi QR code đều có mật độ hạt và kích thước hạt đồng đều 100%
 // Nội dung QR code là ID của chính instance đó (ví dụ Cánh tủ|1 hoặc Module_A|1) (hoặc JSON object cho module kiểu bộ)
 const qrContent = module.moduleType === 'bo'
 ? (module.moduleCode || '')
 : instance.id;
 const qrDataUrl = await QRCode.toDataURL(qrContent, {
 version: 5,
 errorCorrectionLevel: 'M',
 margin: 4,
 width: 320,
 color: {
 dark: '#000000',
 light: '#FFFFFF'
 }
 });

 const qrImg = new Image();
 qrImg.src = qrDataUrl;
 await new Promise((resolve) => {
 qrImg.onload = resolve;
 qrImg.onerror = resolve;
 });

 // Vẽ mã QR ở vùng bên trái, co bóp một chút để có khoảng trắng an toàn tuyệt đối với viền đen
 // Toạ độ x: 18, y: 75, rộng dài: 210x210 (Diện tích trắng xung quanh cực kỳ thông thoáng)
 ctx.drawImage(qrImg, 18, 75, 210, 210);

 // Chữ phụ đề mã QR phía trên gọn gàng
 ctx.fillStyle = '#000000';
 ctx.font = 'bold 12px "Inter", sans-serif';
 ctx.textAlign = 'center';
 ctx.fillText(module.moduleType === 'bo' ? 'QUÉT MÃ QR CẢ BỘ' : 'QUÉT MÃ QR CẤU KIỆN', 123, 50);

 // Chữ mã cấu kiện ở dưới mã QR (Cho nhỏ bớt để tránh tranh chấp định vị QR của camera)
 ctx.font = 'bold 11px "Inter", sans-serif';
 ctx.fillText(printableCode, 123, 310);

 } catch (err) {
 console.error('Error QR:', err);
 }

 // Vẽ thông tin bên phải chi tiết - TẤT CẢ DÙNG MÀU ĐEN TUYỀN (#000000) ĐỂ IN NHIỆT KHÔNG BỊ MỜ RỖ
 ctx.textAlign = 'left';
 ctx.fillStyle = '#000000';

 // 1. Tên dự án (Size chữ lớn, đậm gắt)
 ctx.font = 'bold 12px "Inter", sans-serif';
 ctx.fillText('DỰ ÁN / PROJECT:', 260, 40);

 ctx.font = '900 24px "Inter", sans-serif';
 const projName = module.projectName || projectCode;
 // Vẽ chữ co dãn thông minh nếu tên dự án quá dài
 const displayProjName = projName.substring(0, 22) + (projName.length > 22 ? '..' : '');
 ctx.fillText(displayProjName, 260, 70);

 // 2. Khu vực / Cụm (Size to, dễ quan sát)
 ctx.font = 'bold 12px "Inter", sans-serif';
 ctx.fillText('CỤM / AREA CLUSTER:', 260, 100);

 ctx.font = '900 24px "Inter", sans-serif';
 const displayCluster = (module.cluster || 'CHƯA PHÂN CỤM').substring(0, 22);
 ctx.fillText(displayCluster, 260, 130);

 // 3. Mã cấu kiện / Module Code (SIZE SIÊU TO KHỔNG LỒ)
 ctx.font = 'bold 12px "Inter", sans-serif';
 ctx.fillText(`MÃ CẤU KIỆN (${getEntryType(module).toUpperCase()}):`, 260, 160);
 function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
 const words = text.split(' ');
 const lines = [];
 let line = '';

 for (let i = 0; i < words.length; i++) {
 const testLine = line ? line + ' ' + words[i] : words[i];
 const metrics = ctx.measureText(testLine);

 if (metrics.width > maxWidth && line) {
 lines.push(line);
 line = words[i];
 } else {
 line = testLine;
 }
 }

 lines.push(line);

 lines.forEach((l, index) => {
 ctx.fillText(l, x, y + index * lineHeight);
 });

 return lines.length;
 }
 const codeText = printableCode;
 if (codeText.length > 15) {
 ctx.font = '900 28px "Inter", sans-serif';
 } else {
 ctx.font = '900 36px "Inter", sans-serif';
 }
 // maxWidth = 300px, lineHeight = 28px
 wrapText(ctx, codeText, 260, 200, 360, 28);

 // 4. Kích thước (Size to rõ nét): Ưu tiên kích thước đóng gói (pWidth/pDepth/pHeight), nếu không có thì lấy kích thước mộc (width/depth/height/length) và không để trống
 const isThung = getEntryType(module) === 'Thùng';
 ctx.font = 'bold 12px "Inter", sans-serif';
 ctx.fillText(isThung ? 'KÍCH THƯỚC (W x D x H):' : 'KÍCH THƯỚC (DÀI x RỘNG x DÀY):', 260, 265);

 ctx.font = 'bold 22px "Inter", sans-serif';
 const w = module.width || module.length || module.pWidth || '0';
 const d = module.depth || module.pDepth || '0';
 const h = module.height || module.pHeight || '0';
 ctx.fillText(`${w} x ${d} x ${h} mm`, 260, 295);

 // 5. Số lượng / Số thứ tự tem tạm (Font khổng lồ màu đen đậm đặc dưới góc)
 ctx.font = 'bold 12px "Inter", sans-serif';
 ctx.fillText('SỐ LƯỢNG / PCS:', 260, 335);

 ctx.font = '900 36px "Inter", sans-serif';
 if (module.moduleType === 'bo') {
 ctx.fillText(`${totalQuantity} BỘ (SET)`, 260, 375);
 } else if (totalQuantity > 1) {
 ctx.fillText(`${instance.instanceIndex} / ${totalQuantity}`, 260, 375);
 } else {
 ctx.fillText(`${module.quantity || 1} CÁI (PCS)`, 260, 375);
 }

 // STT Tem Tạm ở góc dưới bên phải (sử dụng tempLabelIndex là số thứ tự cố định không đổi)
 ctx.textAlign = 'right';
 ctx.font = 'bold 12px "Inter", sans-serif';
 ctx.fillText('STT TEM TẠM:', 580, 335);

 ctx.font = '900 32px "Inter", sans-serif';
 ctx.fillText(sttValue, 580, 370);

 // Reset alignment
 ctx.textAlign = 'left';

 // Chữ bản quyền/Nhãn hiệu nho nhỏ góc cực viền trên máy in 40x60mm
 ctx.font = 'bold 9px "Inter", sans-serif';
 ctx.fillStyle = '#000000';
 ctx.textAlign = 'right';
 ctx.fillText('DRACO D&B © 2026', 585, 385);

 try {
 const dataUrl = canvas.toDataURL('image/png');
 setImgUrl(dataUrl);
 if (onRenderComplete) {
 onRenderComplete(labelId, dataUrl);
 }
 } catch (err) {
 console.error('Render error:', err);
 }
 };

 // Delay nhẹ để fonts load kịp
 const timer = setTimeout(() => {
 draw();
 }, 150);

 return () => clearTimeout(timer);
 }, [module, projectCode, labelId, instance, totalQuantity, sttValue]);

 const handleDownloadSingle = () => {
 if (!imgUrl) return;
 const a = document.createElement('a');
 a.href = imgUrl;
 const suffix = totalQuantity > 1 ? `_ST_${instance.instanceIndex}_OF_${totalQuantity}` : '';
 a.download = `TEM_TẠM_${module.moduleCode}${suffix}.png`;
 a.click();
 };

 return (
 <div className="bg-slate-100 border border-slate-200 rounded-lg p-4 flex flex-col items-center">
 <canvas ref={canvasRef} width={600} height={400} className="hidden" />

 {imgUrl ? (
 <img
 src={imgUrl}
 alt={module.moduleCode}
 className="w-full max-w-[280px] aspect-[1.5] border border-slate-300 bg-white shadow-sm rounded-lg"
 referrerPolicy="no-referrer"
 />
 ) : (
 <div className="w-[280px] h-[186px] flex flex-col items-center justify-center bg-slate-100 border border-slate-300 rounded-lg animate-pulse gap-2">
 <RefreshCw className="animate-spin text-indigo-500" size={18} />
 <span className="text-[10px] font-black uppercase text-slate-400">Đang khởi tạo tem...</span>
 </div>
 )}

 <div className="mt-3 flex items-center justify-between w-full">
 <span className="text-[10px] font-black text-slate-600 truncate max-w-[160px] uppercase">
 STT: {sttValue} - {module.moduleCode}
 </span>
 <button
 onClick={handleDownloadSingle}
 disabled={!imgUrl}
 className="flex items-center space-x-1 px-2.5 py-1.5 bg-white hover:bg-slate-100 border border-slate-200 rounded-lg text-[9px] font-black uppercase tracking-wider text-slate-700 shadow-sm transition-all active:scale-95 disabled:opacity-100"
 >
 <Download size={11} />
 <span>Tải ảnh</span>
 </button>
 </div>
 </div>
 );
}

// Sắp xếp ổn định tất cả các module trong dự án để đánh số thứ tự toàn cục
export function getStableSortedAllNormalInstances(allModules: ProjectEntry[]): Array<{ moduleId: string; instanceId: string }> {
 const sortedModules = [...allModules].sort((a, b) => {
 if ((a.sortIndex || 0) !== (b.sortIndex || 0)) {
 return (a.sortIndex || 0) - (b.sortIndex || 0);
 }
 const codeA = a.moduleCode || '';
 const codeB = b.moduleCode || '';
 if (codeA !== codeB) {
 return codeA.localeCompare(codeB);
 }
 return a.id.localeCompare(b.id);
 });

 const list: Array<{ moduleId: string; instanceId: string }> = [];
 sortedModules.forEach(m => {
 if (m.moduleType !== 'bo') {
 const insts = getModuleInstances(m);
 insts.forEach(inst => {
 list.push({
 moduleId: m.id,
 instanceId: inst.id
 });
 });
 }
 });
 return list;
}

interface TempLabelsModalProps {
 onClose: () => void;
 modules: ProjectEntry[];
 projectCode: string;
}

export function TempLabelsModal({ onClose, modules, projectCode }: TempLabelsModalProps) {
 const [renderedImages, setRenderedImages] = useState<{ [key: string]: string }>({});
 const [printType, setPrintType] = useState<'thung' | 'canh_mat_ctht' | 'filler_len'>('thung');
 const [searchTerm, setSearchTerm] = useState('');
 const [selectedCluster, setSelectedCluster] = useState('');

 // Lấy danh sách cụm (clusters) độc nhất từ các module thuộc dự án này để làm bộ lọc dropdown
 const clustersList = React.useMemo(() => {
 const listSet = new Set<string>();
 modules.forEach(m => {
 if (m.projectCode === projectCode && m.cluster) {
 listSet.add(m.cluster.trim());
 }
 });
 return Array.from(listSet).sort();
 }, [modules, projectCode]);

 // Bộ lọc reset cache ảnh render cũ khi tìm kiếm hoặc đổi bộ lọc
 const handlePrintTypeChange = (type: 'thung' | 'canh_mat_ctht' | 'filler_len') => {
 setPrintType(type);
 setRenderedImages({});
 };

 const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
 setSearchTerm(e.target.value);
 setRenderedImages({});
 };

 const handleClusterChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
 setSelectedCluster(e.target.value);
 setRenderedImages({});
 };

 // Tự động gán và lưu STT vĩnh viễn vào Firestore cho tất cả cấu kiện & bộ của dự án này chưa có STT độc lập theo từng hệ tem
 const sttAssignedRef = useRef(false);

 useEffect(() => {
 if (!modules || modules.length === 0 || !projectCode || sttAssignedRef.current) return;

 const assignSTTs = async () => {
 sttAssignedRef.current = true;
 try {
 // Lọc và sắp xếp các module theo đúng thứ tự hiển thị hiện tại trong danh sách (Sử dụng buildAndSortTree)
 const projectModules = modules.filter(m => m.projectCode === projectCode);
 const sortedProjectModules = buildAndSortTree([...projectModules].sort((a, b) => (a.sortIndex || 0) - (b.sortIndex || 0)));

 // Điểm hỗ trợ phân loại linh hoạt module vào đúng hệ tem (Trùng khớp 100% với bộ lọc hiển thị filteredModules)
 const getModuleSystemType = (m: ProjectEntry): 'thung' | 'canh_mat_ctht' | 'filler_len' | 'other' => {
 const type = getEntryType(m);
 const code = (m.moduleCode || '').toLowerCase();
 const isFillerOrLen = code.includes('filler') || code.includes('filter') || code.includes('len') || code.includes('thanh treo') || code.includes('thanh_treo');

 if (isFillerOrLen) {
 return 'filler_len';
 }

 // Hệ Thùng
 const isThung = type === 'Thùng';
 const hasDot = m.moduleCode?.toLowerCase().includes('đợt') || m.moduleCode?.toLowerCase().includes('dot');
 if (isThung && !hasDot) {
 return 'thung';
 }

 // Hệ Cánh, Mặt HK, CTHT
 const isTargetType = type === 'Cánh' || type === 'Mặt HK' || type === 'CTHT';
 if (isTargetType) {
 if (m.classification === 'Cánh' || m.classification === 'Mặt HK' || m.classification === 'CTHT') {
 return 'canh_mat_ctht';
 }
 const keywords = ['cánh', 'canh', 'cửa', 'cua', 'mặt', 'mat', 'hoàn thiện', 'hoan thien'];
 if (keywords.some(keyword => code.includes(keyword))) {
 return 'canh_mat_ctht';
 }
 }

 return 'other';
 };

 // Đọc tracker lịch sử từ Firestore
 let trackerData: any = {};
 const trackerRef = doc(db, 'project_stt_tracker', projectCode);
 try {
 const trackerSnap = await getDoc(trackerRef);
 if (trackerSnap.exists()) {
 trackerData = trackerSnap.data() || {};
 }
 } catch (trackerErr) {
 console.error('[STT Tem Tạm] Lỗi đọc project_stt_tracker:', trackerErr);
 }

 const systemTypes: ('thung' | 'canh_mat_ctht' | 'filler_len')[] = ['thung', 'canh_mat_ctht', 'filler_len'];
 const batchUpdates: Array<{ id: string; updateData: any }> = [];
 let hasChanges = false;

 // Đi qua từng hệ tem độc lập
 systemTypes.forEach(sysType => {
 const systemModules = sortedProjectModules.filter(m => getModuleSystemType(m) === sysType);

 let maxSttInClient = 0;

 // 1. Tìm STT lớn nhất hiện có trên client của hệ tem này
 systemModules.forEach(m => {
 if (m.moduleType === 'bo') {
 if (m.stt && typeof m.stt === 'number') {
 maxSttInClient = Math.max(maxSttInClient, m.stt);
 }
 } else {
 const insts = getModuleInstances(m);
 insts.forEach(inst => {
 if (inst.stt && typeof inst.stt === 'number') {
 maxSttInClient = Math.max(maxSttInClient, inst.stt);
 }
 });
 }
 });

 // 2. Lấy tối đa lịch sử của riêng hệ tem này
 const maxSttHistorical = trackerData[`maxStt_${sysType}`] || 0;
 let runningStt = Math.max(maxSttInClient, maxSttHistorical);

 // 3. Gán STT cho các cấu kiện chưa có STT thuộc hệ này
 systemModules.forEach(m => {
 if (m.moduleType === 'bo') {
 if (!m.stt) {
 runningStt += 1;
 hasChanges = true;
 batchUpdates.push({
 id: m.id,
 updateData: { stt: runningStt }
 });
 }
 } else {
 const insts = getModuleInstances(m);
 let instancesChanged = false;

 const updatedInsts = insts.map(inst => {
 if (!inst.stt) {
 runningStt += 1;
 instancesChanged = true;
 hasChanges = true;
 return {
 ...inst,
 stt: runningStt
 };
 }
 return inst;
 });

 if (instancesChanged || !m.instances || m.instances.length === 0) {
 batchUpdates.push({
 id: m.id,
 updateData: { instances: updatedInsts }
 });
 }
 }
 });

 // Cập nhật lại giá trị chạy vào trackerData
 trackerData[`maxStt_${sysType}`] = runningStt;
 });

 // 4. Thực hiện lưu Firestore nếu có bất kỳ sự thay đổi nào
 if (hasChanges && batchUpdates.length > 0) {
 await batchUpdateProjectModules(batchUpdates.map(update => ({
 moduleId: update.id,
 data: cleanUndefinedFields(update.updateData),
 projectCode
 })));

 // Đồng thời lưu toàn bộ tracker lịch sử phân chia theo hệ tem
 const trackerBatch = writeBatch(db);
 trackerBatch.set(trackerRef, cleanUndefinedFields({
 projectCode,
 ...trackerData,
 // bảo toàn maxStt cũ làm fallback nếu các mã cũ cần đọc
 maxStt: Math.max(trackerData.maxStt_thung || 0, trackerData.maxStt_canh_mat_ctht || 0, trackerData.maxStt_filler_len || 0)
 }));
 await trackerBatch.commit();

 console.log(`[STT Tem Tạm] Đã đồng bộ và lưu STT độc lập: Thùng(${trackerData.maxStt_thung || 0}), Cánh(${trackerData.maxStt_canh_mat_ctht || 0}), Filler(${trackerData.maxStt_filler_len || 0})`);
 }
 } catch (err) {
 console.error('[STT Tem Tạm] Lỗi khi xử lý STT:', err);
 sttAssignedRef.current = false; // reset cờ để thử lại nếu lỗi
 }
 };

 assignSTTs();
 }, [modules, projectCode]);

 const allSortedModules = React.useMemo(() => {
 return buildAndSortTree(modules);
 }, [modules]);

 const globalNormalInstanceMap = React.useMemo(() => {
 const map = new Map<string, number>();
 const list = getStableSortedAllNormalInstances(modules);
 list.forEach((item, idx) => {
 map.set(`${item.moduleId}_${item.instanceId}`, idx + 1);
 });
 return map;
 }, [modules]);

 const globalIndexMap = React.useMemo(() => {
 const map = new Map<string, number>();
 allSortedModules.forEach((m, idx) => {
 map.set(m.id, idx + 1);
 });
 return map;
 }, [allSortedModules]);

 const filteredModules = React.useMemo(() => {
 const sortedModules = [...modules].sort((a, b) => (a.sortIndex || 0) - (b.sortIndex || 0));
 const sorted = buildAndSortTree(sortedModules);
 return sorted.filter(m => {
 // 1. Phải trùng khớp projectCode
 if (m.projectCode !== projectCode) return false;

 // 2. Lọc theo từ khóa tìm kiếm (mã cấu kiện hoặc phân loại)
 if (searchTerm) {
 const cleanSearch = searchTerm.toLowerCase().trim();
 const codeMatch = (m.moduleCode || '').toLowerCase().includes(cleanSearch);
 const classificationMatch = (m.classification || '').toLowerCase().includes(cleanSearch);
 if (!codeMatch && !classificationMatch) return false;
 }

 // 3. Lọc theo cụm (cluster)
 if (selectedCluster) {
 const cleanCluster = (m.cluster || '').toLowerCase().trim();
 if (cleanCluster !== selectedCluster.toLowerCase().trim()) {
 return false;
 }
 }

 const type = getEntryType(m);
 const code = (m.moduleCode || '').toLowerCase();
 const isFillerLenLike = /(filler|filter|len|thanh\s*treo)/.test(code);

 if (printType === 'filler_len') {
 return isFillerLenLike;
 }

 // If it is Filler / Len / Thanh treo, it belongs to filler_len only, so exclude from other groups
 if (isFillerLenLike) {
 return false;
 }

 if (printType === 'thung') {
 const isThung = type === 'Thùng';
 const hasDot = m.moduleCode?.toLowerCase().includes('đợt') || m.moduleCode?.toLowerCase().includes('dot');
 return isThung && !hasDot;
 } else {
 const isTargetType = type === 'Cánh' || type === 'Mặt HK' || type === 'CTHT';
 if (!isTargetType) return false;

 // Nếu đã được phân loại rõ ràng qua trường classification (ví dụ import Excel gán trực tiếp) thì chấp nhận luôn
 if (m.classification === 'Cánh' || m.classification === 'Mặt HK' || m.classification === 'CTHT') {
 return true;
 }

 const codeLower = code;
 const keywords = ['cánh', 'canh', 'cửa', 'cua', 'mặt', 'mat', 'hoàn thiện', 'hoan thien'];
 return keywords.some(keyword => codeLower.includes(keyword));
 }
 });
 }, [modules, projectCode, printType, searchTerm, selectedCluster]);

 const labelItems = React.useMemo(() => {
 const items: Array<{
 id: string; // unique ID: `${module.id}_${instance.id}`
 module: ProjectEntry;
 instance: ModuleInstance;
 total: number;
 }> = [];

 filteredModules.forEach(m => {
 if (m.moduleType === 'bo') {
 const qty = m.quantity || 1;
 const fakeInst: ModuleInstance = {
 id: `${m.id}_bo_main`,
 instanceId: `${m.id}_bo_main`,
 instanceIndex: 1,
 tempLabelIndex: 1,
 qcDone: false,
 delivered: false
 };
 items.push({
 id: `${m.id}_bo_main`,
 module: m,
 instance: fakeInst,
 total: qty
 });
 } else {
 const insts = getModuleInstances(m);
 const totalCount = insts.length;
 insts.forEach(inst => {
 items.push({
 id: `${m.id}_${inst.id}`,
 module: m,
 instance: inst,
 total: totalCount
 });
 });
  }
  });

  // Sắp xếp theo STT để hiển thị đúng thứ tự trên bảng in
  items.sort((a, b) => {
  const sttA = a.module.moduleType === 'bo'
  ? (a.module.stt || globalIndexMap.get(a.module.id) || 1)
  : (a.instance.stt || a.instance.tempLabelIndex || 0);
  const sttB = b.module.moduleType === 'bo'
  ? (b.module.stt || globalIndexMap.get(b.module.id) || 1)
  : (b.instance.stt || b.instance.tempLabelIndex || 0);
  return Number(sttA) - Number(sttB);
  });

  return items;
 }, [filteredModules]);

 const isAllRendered = Object.keys(renderedImages).length === labelItems.length && labelItems.length > 0;

 const handleRenderComplete = (id: string, dataUrl: string) => {
 setRenderedImages(prev => ({
 ...prev,
 [id]: dataUrl
 }));
 };

 const handlePrintAll = () => {
 if (!isAllRendered) return;
 window.print();
 };

 return (
 <div className="fixed inset-0 z-100 overflow-y-auto flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs">
 <div className="bg-white rounded-lg max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col shadow-xl border border-slate-200">

 {/* Header */}
 <div className="p-4 bg-slate-100 border-b border-slate-100 flex items-center justify-between">
 <div className="flex items-center space-x-2.5">
 <CreditCard className="text-indigo-600" size={18} />
 <div>
 <h3 className="text-sm font-black text-slate-800 uppercase tracking-widest">
 Danh sách In Tem Tạm ({labelItems.length} tem / {filteredModules.length} cấu kiện)
 </h3>
 <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider mt-0.5">
 Dự án: {projectCode} • {printType === 'thung' ? 'Chỉ in hệ Thùng (không bao gồm "Đợt")' : printType === 'filler_len' ? 'Chỉ in hệ Filler, Len, Thanh treo' : 'Chỉ in hệ Cánh, Mặt học kéo, CTHT'}
 </p>
 </div>
 </div>
 <button
 onClick={onClose}
 className="p-1.5 bg-slate-200 text-slate-400 hover:text-slate-600 rounded-lg transition-all"
 >
 <X size={16} />
 </button>
 </div>

 {/* Filter Bar */}
 <div className="px-6 py-3.5 bg-slate-100 border-b border-slate-100 space-y-3 shrink-0">
 <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
 {/* Hệ tem */}
 <div className="flex items-center space-x-3">
 <span className="text-[10px] font-black uppercase text-slate-400 tracking-wider">Hệ tem cần in:</span>
 <div className="inline-flex rounded-lg p-0.5 bg-slate-100 space-x-1">
 <button
 onClick={() => handlePrintTypeChange('thung')}
 className={`px-3 py-1.5 text-[10px] font-black uppercase tracking-widest rounded-lg transition-all duration-200 cursor-pointer ${printType === 'thung'
 ? 'bg-indigo-600 text-white shadow-xs'
 : 'text-slate-600 hover:text-slate-800'
 }`}
 >
 Hệ Thùng
 </button>
 <button
 onClick={() => handlePrintTypeChange('canh_mat_ctht')}
 className={`px-3 py-1.5 text-[10px] font-black uppercase tracking-widest rounded-lg transition-all duration-200 cursor-pointer ${printType === 'canh_mat_ctht'
 ? 'bg-indigo-600 text-white shadow-xs'
 : 'text-slate-600 hover:text-slate-800'
 }`}
 >
 Cánh, Mặt HK, CTHT
 </button>
 <button
 onClick={() => handlePrintTypeChange('filler_len')}
 className={`px-3 py-1.5 text-[10px] font-black uppercase tracking-widest rounded-lg transition-all duration-200 cursor-pointer ${printType === 'filler_len'
 ? 'bg-indigo-600 text-white shadow-xs'
 : 'text-slate-600 hover:text-slate-800'
 }`}
 >
 Filler, Len, Thanh treo
 </button>
 </div>
 </div>
 <div className="text-[10px] font-black uppercase text-slate-400 tracking-wider">
 {labelItems.length} tem tương thích
 </div>
 </div>

 {/* Các bộ lọc bổ sung: Tên/Mã & Cụm */}
 <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2.5 border-t border-slate-200/40">
 {/* Lọc theo Tên/Mã */}
 <div className="flex flex-col space-y-1">
 <label className="text-[9px] font-black uppercase text-slate-400 tracking-wider">
 Tìm kiếm mã hoặc phân loại cấu kiện:
 </label>
 <input
 type="text"
 placeholder="Nhập mã hoặc loại cấu kiện cần in... (VD: KIT.T9, Cánh)"
 value={searchTerm}
 onChange={handleSearchChange}
 className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-xs outline-none focus:border-indigo-500 text-slate-800 shadow-xs transition-all leading-none placeholder:text-slate-400"
 />
 </div>

 {/* Lọc theo Cụm (Cluster) */}
 <div className="flex flex-col space-y-1">
 <label className="text-[9px] font-black uppercase text-slate-400 tracking-wider">
 Lọc theo Cụm khu vực (Area Cluster):
 </label>
 <select
 value={selectedCluster}
 onChange={handleClusterChange}
 className="w-full bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-xs outline-none focus:border-indigo-500 text-slate-800 shadow-xs transition-all cursor-pointer leading-relaxed"
 >
 <option value="">-- Tất cả các cụm --</option>
 {clustersList.map(clusterName => (
 <option key={clusterName} value={clusterName}>
 {clusterName}
 </option>
 ))}
 </select>
 </div>
 </div>
 </div>

 {/* Cảnh báo lưu ý */}
 <div className="px-6 py-3 bg-indigo-100/50 border-b border-indigo-100/50 flex items-start space-x-2.5">
 <AlertCircle className="text-indigo-600 shrink-0 mt-0.5" size={14} />
 <p className="text-[11px] text-indigo-700/90 font-medium leading-relaxed">
 Các nhãn được tự động vẽ với kích thước <span className="font-bold">600x400 pixels</span> chuẩn tỷ lệ 3:2. Khi in, mỗi con tem sẽ tự ngắt trang tuyệt đối chính xác. Vui lòng đợi tất cả mã QR xuất hiện đầy đủ trước khi thực hiện nhấn nút <span className="font-bold">In Toàn Bộ</span>.
 </p>
 </div>

 {/* Nội dung danh sách nhãn */}
 <div className="p-6 overflow-y-auto flex-1 bg-white grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-6">
 {labelItems.length > 0 ? (
 labelItems.map((item, idx) => {
 const sVal = item.module.moduleType === 'bo'
 ? `${item.module.stt || globalIndexMap.get(item.module.id) || 1}`
 : `${item.instance.stt || item.instance.tempLabelIndex}`;

 return (
 <TempLabelCanvas
 key={item.id}
 labelId={item.id}
 module={item.module}
 projectCode={projectCode}
 instance={item.instance}
 totalQuantity={item.total}
 sttValue={sVal}
 onRenderComplete={handleRenderComplete}
 />
 );
 })
 ) : (
 <div className="col-span-full py-12 text-center text-slate-400">
 <p className="text-xs font-black uppercase tracking-widest">Không có cấu kiện thỏa mãn điều kiện</p>
 <p className="text-[11px] mt-1">
 {printType === 'thung'
 ? 'Dự án này không có cấu kiện nào đạt tiêu chí (hệ "Thùng" và không chứa chữ "Đợt" trong mã).'
 : printType === 'filler_len'
 ? 'Dự án này không có cấu kiện nào đạt tiêu chí (hệ "Filler, Len, Thanh treo" - tên chứa "Filler", "Len" hoặc "Thanh treo").'
 : 'Dự án này không có cấu kiện nào đạt tiêu chí (hệ "Cánh", "Mặt HK" hoặc "CTHT").'}
 </p>
 </div>
 )}
 </div>

 {/* Footer */}
 <div className="p-4 bg-slate-100 border-t border-slate-100 flex items-center justify-between">
 <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest">
 {isAllRendered
 ? '✓ Tất cả tem đã tải xong'
 : labelItems.length > 0
 ? `Đang chuẩn bị: ${Object.keys(renderedImages).length}/${labelItems.length} tem...`
 : 'Trống'
 }
 </div>
 <div className="flex items-center space-x-2">
 <button
 onClick={onClose}
 className="px-4 py-2 border border-slate-200 text-slate-600 rounded-lg text-xs font-black uppercase tracking-widest hover:bg-slate-100 active:scale-95 transition-all"
 >
 Đóng
 </button>
 <button
 onClick={handlePrintAll}
 disabled={!isAllRendered}
 className="flex items-center space-x-2 px-5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-black uppercase tracking-widest active:scale-95 transition-all disabled:opacity-100 disabled:pointer-events-none shadow-md cursor-pointer"
 >
 <Printer size={14} />
 <span>In Toàn Bộ</span>
 </button>
 </div>
 </div>

 </div>

 {/* KHU VỰC IN ẨN CHỈ HIỂN THỊ KHI IN RA - DÙNG PORTAL ĐỂ ĐƯA RA TRỰC TIẾP BODY TRÁNH TRÙNG LẶP LAYOUT */}
 {isAllRendered && createPortal(
 <div id="print-labels-area" className="hidden print:block">
 <style dangerouslySetInnerHTML={{
 __html: `
 @media print {
 /* Ẩn hoàn toàn giao diện trang chính của phần ứng dụng để không bị chồng chéo hay chiếm dòng */
 #root {
 display: none !important;
 }
 
 /* Định hình khổ tem thermal 40x60mm (xoay ngang là width: 60mm, height: 40mm) */
 @page {
 size: 60mm 40mm;
 margin: 0 !important;
 }
 
 html, body {
 width: 60mm !important;
 height: 40mm !important;
 margin: 0 !important;
 padding: 0 !important;
 background: #ffffff !important;
 overflow: visible !important;
 }

 #print-labels-area {
 display: block !important;
 width: 60mm !important;
 height: auto !important;
 margin: 0 !important;
 padding: 0 !important;
 visibility: visible !important;
 }

 .print-card-item {
 display: block !important;
 width: 60mm !important;
 height: 40mm !important;
 page-break-inside: avoid !important;
 break-inside: avoid !important;
 page-break-after: always !important;
 break-after: page !important;
 margin: 0 !important;
 padding: 0 !important;
 box-sizing: border-box !important;
 background: #ffffff !important;
 }

 /* Ngăn thừa tờ trống ở cuối cùng */
 .print-card-item:last-child {
 page-break-after: avoid !important;
 break-after: avoid !important;
 }

 .print-card-img {
 width: 60mm !important;
 height: 40mm !important;
 display: block !important;
 object-fit: fill !important;
 margin: 0 !important;
 padding: 0 !important;
 /* Giúp hiển thị QR và chữ cực kỳ rõ nét khi in nhiệt, không bị nhòa */
 image-rendering: crisp-edges !important;
 image-rendering: pixelated !important;
 }
 }
 ` }} />
 {labelItems.map(item => renderedImages[item.id] && (
 <div key={`print-${item.id}`} className="print-card-item">
 <img
 src={renderedImages[item.id]}
 alt="PRINT TEM"
 className="print-card-img"
 referrerPolicy="no-referrer"
 />
 </div>
 ))}
 </div>,
 document.body
 )}
 </div>
 );
}
