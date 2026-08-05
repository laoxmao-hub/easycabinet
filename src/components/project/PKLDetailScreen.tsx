import React, { useState, useEffect, useRef } from 'react';
// createPortal removed - no longer needed
import { motion, AnimatePresence } from 'motion/react';
import {
 ArrowLeft, Truck, User, Calendar, Trash2, QrCode, Plus, CheckCircle, Check,
 Camera, AlertTriangle, FileText, Info, Loader2, Play,
  RefreshCw, Settings, Share2, Clock
} from 'lucide-react';
import {
  collection, query, where, onSnapshot, doc, setDoc, updateDoc, deleteDoc, addDoc, serverTimestamp, getDocs, getDoc
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType, cleanUndefinedFields } from '../../lib/firebase';
import { useAuth } from '../../lib/AuthContext';
import { useAlert } from '../../lib/AlertContext';
import { MultiImageUploader } from '../MultiImageUploader';
import { ScannerModal, ScannedResult } from '../ScannerModal';
import { LoadingExcelEditorModal } from './LoadingExcelEditorModal';
import { PKLOrder, LoadingHistory, ProjectEntry, PackingItem } from '../../types';
import { formatProjectCode } from '../../lib/formatters';
import { syncItemLoadedStatus, syncInstanceLoadInfo } from '../../lib/syncLoadedStatus';
import * as XLSX from 'xlsx';

// Chuẩn hóa rawQR khi xếp kiện lên hàng:
// Bỏ hậu tố "#X/Y" khỏi phần tên, giữ lại "|instanceIndex".
// Ví dụ: "CFS026_BQT #1/6|1" → "CFS026_BQT|1"; "CFS026_BQT #1/6" → "CFS026_BQT".
const normalizeLoadRawQR = (value: string | undefined | null): string => {
  // Bỏ junk "----EASYCABINET----" để giữ phần QR thực
  const raw = (value || '').trim().replace(/----.*----/, '').trim();
  if (!raw) return raw;
  const instMatch = raw.match(/\|(\d+)$/);
  // Chỉ lấy index từ "#X/Y" khi chuỗi không chứa "|" (bảo vệ format CTHT "id|name")
  const hashMatch = !raw.includes('|') ? raw.match(/#(\d+)\//) : null;
  const basePart = instMatch ? raw.slice(0, raw.length - instMatch[0].length) : raw;
  const baseCode = basePart.replace(/\s*#\d+\/\d+$/, '').trim();
  const idx = instMatch ? instMatch[1] : hashMatch ? hashMatch[1] : null;
  return idx ? `${baseCode}|${idx}` : baseCode;
};

// Quyết định tên kiện hiển thị khi xếp lên hàng:
// - Kiện module có "#X/Y" (vd "CFS026_BQT #1/6") hoặc kiện CTHT → giữ nguyên tên kiện packing.
// - QR dạng "prefix.product|N" → tên sản phẩm + số instance: "cfs026_light.pendant light|1" → "PENDANT LIGHT 1".
const resolveLoadDisplayName = (item: PackingItem, rawQrData?: string): string => {
  const itemName = (item?.name || '').trim();
  // Module có "#X/Y" → giữ nguyên tên kiện (không suy lại từ QR)
  if (/#\d+\/\d+/.test(itemName)) return itemName;
  // Kiện CTHT → giữ nguyên tên packing (tránh biến "ctht-xxx|FINISHED PANEL 2" thành tên khác)
  const isCtht = item?.subType === 'kienCTHT' || /^ctht-/i.test(itemName) || itemName.includes('|');
  if (isCtht) return itemName;
  // Còn lại → suy tên sản phẩm + instance từ QR (fallback về tên packing)
  return deriveLoadDisplayName(rawQrData || itemName) || itemName;
};

// Suy tên kiện hiển thị khi quét QR xếp lên hàng:
// - Tên đã có "#X/Y" (ví dụ "CFS026_BQT #1/6") → giữ nguyên tên.
// - QR "code|N" không có "#" → tên sản phẩm (phần sau dấu "." cuối, viết hoa) + số instance:
//   "cfs026_light.pendant light|1" → "PENDANT LIGHT 1".
// - Không có instance → trả về phần tên.
const deriveLoadDisplayName = (value: string): string => {
  const raw = (value || '').trim().replace(/----.*----/, '').trim();
  if (!raw) return raw;
  const instMatch = raw.match(/\|(\d+)$/);
  const namePart = instMatch ? raw.slice(0, raw.length - instMatch[0].length).trim() : raw;
  if (/#\d+\/\d+/.test(namePart)) return namePart;
  // Không có instance index → giữ nguyên chuỗi (bảo vệ CTHT "id|name")
  if (!instMatch) return namePart;
  const dotIdx = namePart.lastIndexOf('.');
  const productName = (dotIdx >= 0 ? namePart.substring(dotIdx + 1) : namePart).trim().toUpperCase();
  return `${productName} ${instMatch[1]}`;
};

interface PKLDetailScreenProps {
 pkl: PKLOrder;
 onBack: () => void;
 projectEntries: ProjectEntry[];
 isGuest?: boolean;
}

export function PKLDetailScreen({
 pkl,
 onBack,
 projectEntries,
 isGuest = false,
}: PKLDetailScreenProps) {
 const { user, userProfile, role, roles, hasRole } = useAuth();
 const { showAlert, showSuccess, showError, showWarning, showConfirm } = useAlert();

 // State
 const [currentPkl, setCurrentPkl] = useState<PKLOrder>(pkl);
 const [allPackingItems, setAllPackingItems] = useState<{ item: PackingItem; packingDocId: string; projectCode?: string; projectName?: string }[]>([]);
 const [loadingHistories, setLoadingHistories] = useState<LoadingHistory[]>([]);
 const [isQrScannerOpen, setIsQrScannerOpen] = useState(false);
 const [showLoadingExcelEditor, setShowLoadingExcelEditor] = useState(false);
 const [isSelectModalOpen, setIsSelectModalOpen] = useState(false);
 const [isVerifyModalOpen, setIsVerifyModalOpen] = useState(false);
 const [selectedItemToVerify, setSelectedItemToVerify] = useState<{ item: PackingItem; packingDocId: string; projectCode?: string; projectName?: string } | null>(null);
 const [verificationImages, setVerificationImages] = useState<string[]>([]);
 const [isSavingLoading, setIsSavingLoading] = useState(false);
  const [centeredToast, setCenteredToast] = useState<{ show: boolean; message: string }>({ show: false, message: '' });

 // Search state inside Modal chọn kiện
 const [selectSearchTerm, setSelectSearchTerm] = useState('');



 // Bulk loading states
 const [isBulkLoadModalOpen, setIsBulkLoadModalOpen] = useState(false);
 const [bulkItemsToLoad, setBulkItemsToLoad] = useState<{ item: PackingItem; packingDocId: string; projectCode?: string; projectName?: string }[]>([]);
 const [bulkVerificationImages, setBulkVerificationImages] = useState<string[]>([]);

 // States for Editing PKL Info inside details view
 const [isEditModalOpen, setIsEditModalOpen] = useState(false);
 const [editVehicleInfo, setEditVehicleInfo] = useState('');
 const [editNote, setEditNote] = useState('');
 const [editProjectName, setEditProjectName] = useState('');
 const [editProjectCodes, setEditProjectCodes] = useState<string[]>([]);
 const [editProjectCodeInput, setEditProjectCodeInput] = useState('');

 // Print report state
 const handleExportExcel = () => {
 const dateStr = new Date().toLocaleDateString('vi-VN');
 const projName = currentPkl.projectName || currentPkl.projectId || 'N/A';
 const title = `PACKINGLIST ${projName} ${dateStr}`;

 // Tính toán trước rồi mới sort
 const computedRows = reportItems.map((item) => {
 const matchedPkg = allPackingItems.find(x => x.item.name === item.name);
 const pkg = matchedPkg?.item;

 const dVal = pkg?.d || item.dimensions?.split(' x ')[1] || '0';
 const wVal = pkg?.w || item.dimensions?.split(' x ')[0] || '0';
 const hVal = pkg?.h || item.dimensions?.split(' x ')[2] || '0';
 const weight = Number(pkg?.weight || item.weight || 0);

 const dNum = parseFloat(String(dVal)) || 0;
 const wNum = parseFloat(String(wVal)) || 0;
 const hNum = parseFloat(String(hVal)) || 0;
 const cbm = (dNum * wNum * hNum) / 1000000000;
 const qty = item.quantity || 1;

 let unit = item.unit || '-';
 const nameParts = item.name.split('_');
 if (nameParts.length > 0) {
 let raw = nameParts[0].toUpperCase().trim();
 raw = raw.replace(/ELMB/gi, 'BLDG').replace(/BLMB/gi, 'BLDG').replace(/ELM/gi, 'BLDG');
 unit = raw;
 }

 let cabinetType = item.name;
 const dotIdx = item.name.lastIndexOf('.');
 if (dotIdx >= 0) {
 cabinetType = item.name.substring(dotIdx + 1).trim().toUpperCase();
 } else if (nameParts.length > 1) {
 cabinetType = nameParts.slice(1).join('_').toUpperCase();
 }

 const projectCode = item.projectCode || '-';
 const project = item.projectName || projName;
 const area = item.cluster || '-';

 return { projectCode, project, unit, area, cabinetType, dNum, wNum, hNum, weight, qty, cbm };
 });

 // Sort: PROJECT > CỤM > TÊN
 computedRows.sort((a, b) => {
 const pA = a.project.toLowerCase();
 const pB = b.project.toLowerCase();
 if (pA !== pB) return pA.localeCompare(pB, 'vi');

 const aA = a.area.toLowerCase();
 const aB = b.area.toLowerCase();
 if (aA !== aB) return aA.localeCompare(aB, 'vi');

 const cA = a.cabinetType.toLowerCase();
 const cB = b.cabinetType.toLowerCase();
 return cA.localeCompare(cB, 'vi', { numeric: true });
 });

 let totalQty = 0;
 let totalWeight = 0;
 let totalCBM = 0;

 const rows: any[][] = [];
 rows.push(['', '', title, '', '', '', '', '', '', '', '', '', '']);
 rows.push([]);
 rows.push(['STT', 'PROJECT', 'UNIT', 'AREA', 'CABINET TYPE/\nPRODUCT NAME', 'DIMENSIONS', '', '', "Q'TY", 'GROSS WEIGHT\n(Kg)', 'CBM\n(M3)', 'NOTE', '']);
 rows.push(['', '', '', '', '', 'D', 'W', 'H', '', '', '', '', '']);

 computedRows.forEach((r, idx) => {
 totalQty += r.qty;
 totalWeight += r.weight * r.qty;
 totalCBM += r.cbm * r.qty;
 rows.push([
 idx + 1, r.project, r.unit, r.area, r.cabinetType,
 r.dNum || '', r.wNum || '', r.hNum || '', r.qty,
 r.weight || '', r.cbm > 0 ? Math.round(r.cbm * 10000) / 10000 : '', ''
 ]);
 });

 rows.push(['', '', '', '', '', '', 'TOTAL', '', totalQty, Math.round(totalWeight * 10) / 10, Math.round(totalCBM * 10000) / 10000, '', '']);

 const wb = XLSX.utils.book_new();
 const ws = XLSX.utils.aoa_to_sheet(rows);

 // Áp dụng màu sắc cho header (rows 2-3) - vàng cam FFC000
 const headerStyle = { patternType: 'solid' as const, fgColor: { rgb: 'FFC000' } };
 for (let c = 0; c <= 12; c++) {
 const addr2 = XLSX.utils.encode_cell({ r: 2, c });
 const addr3 = XLSX.utils.encode_cell({ r: 3, c });
 if (ws[addr2]) ws[addr2].s = headerStyle;
 if (ws[addr3]) ws[addr3].s = headerStyle;
 }

 // Màu cho TOTAL row - vàng sáng FFFF00
 const totalStyle = { patternType: 'solid' as const, fgColor: { rgb: 'FFFF00' } };
 const totalRowIdx = rows.length - 1;
 for (let c = 5; c <= 10; c++) {
 const addr = XLSX.utils.encode_cell({ r: totalRowIdx, c });
 if (ws[addr]) ws[addr].s = totalStyle;
 }

 ws['!merges'] = [
 { s: { r: 0, c: 2 }, e: { r: 0, c: 11 } },
 { s: { r: 2, c: 0 }, e: { r: 3, c: 0 } },
 { s: { r: 2, c: 1 }, e: { r: 3, c: 1 } },
 { s: { r: 2, c: 2 }, e: { r: 3, c: 2 } },
 { s: { r: 2, c: 3 }, e: { r: 3, c: 3 } },
 { s: { r: 2, c: 4 }, e: { r: 3, c: 4 } },
 { s: { r: 2, c: 5 }, e: { r: 2, c: 7 } },
 { s: { r: 2, c: 8 }, e: { r: 3, c: 8 } },
 { s: { r: 2, c: 9 }, e: { r: 3, c: 9 } },
 { s: { r: 2, c: 10 }, e: { r: 3, c: 10 } },
 { s: { r: 2, c: 11 }, e: { r: 3, c: 11 } },
 { s: { r: totalRowIdx, c: 5 }, e: { r: totalRowIdx, c: 7 } },
 ];

 ws['!cols'] = [
 { wch: 5 }, { wch: 22 }, { wch: 10 }, { wch: 16 }, { wch: 22 },
 { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 6 }, { wch: 14 },
 { wch: 10 }, { wch: 12 }, { wch: 5 }
 ];

 XLSX.utils.book_append_sheet(wb, ws, 'Packing List');
 XLSX.writeFile(wb, `PKL_${currentPkl.pklCode || 'Report'}_${new Date().toISOString().slice(0, 10)}.xlsx`);
 showSuccess('Đã xuất file Excel thành công!');
 };

  const [isSyncing, setIsSyncing] = useState(false);
  const scanLockRef = useRef(false);

  const handleClearCthtRawQR = async () => {
  if (!user || !currentPkl.id) return;
  showConfirm({
  title: "XÓA RAWQR KIỆN CTHT",
  message: "Xóa rawQR của tất cả kiện CTHT (rawQR bắt đầu bằng 'ctht-') trong phiếu lên hàng?",
  onConfirm: async () => {
  setIsSyncing(true);
  try {
  const currentManual = [...((currentPkl as any).manualItems || [])];
  const currentScanQR = [...((currentPkl as any).scanQRItems || [])];
  let clearedCount = 0;

  for (let i = 0; i < currentManual.length; i++) {
    if ((currentManual[i].rawQR || '').toLowerCase().startsWith('ctht-')) {
    console.log(`[CTHT-QR] Xóa rawQR: "${currentManual[i].name}" "${currentManual[i].rawQR}"`);
    currentManual[i] = { ...currentManual[i], rawQR: '' };
    clearedCount++;
    }
  }
  for (let i = 0; i < currentScanQR.length; i++) {
    if ((currentScanQR[i].rawQR || '').toLowerCase().startsWith('ctht-')) {
    console.log(`[CTHT-QR] Xóa rawQR: "${currentScanQR[i].name}" "${currentScanQR[i].rawQR}"`);
    currentScanQR[i] = { ...currentScanQR[i], rawQR: '' };
    clearedCount++;
    }
  }

  if (clearedCount > 0) {
    await setDoc(doc(db, 'loading', currentPkl.id), {
    scanQRItems: currentScanQR,
    manualItems: currentManual,
    }, { merge: true });
    showSuccess(`Đã xóa rawQR cho ${clearedCount} kiện CTHT!`);
  } else {
    showSuccess('Không có kiện CTHT nào cần xóa rawQR.');
  }
  } catch (err: any) {
  console.error('[CTHT-QR] Clear error:', err);
  showError('Lỗi xóa rawQR: ' + err.message);
  } finally {
  setIsSyncing(false);
  }
  }
  });
  };

  // Đồng bộ rawQR: duyệt từng kiện trong danh sách kiện lên Hàng,
  // tìm cụm + kiện tương ứng bên đóng gói rồi cập nhật rawQR để đồng bộ với nhau.
  const handleSyncRawQR = async () => {
  if (!user || !currentPkl.id) return;
  showConfirm({
  title: "ĐỒNG BỘ RAWQR + THÔNG TIN PHIẾU LÊN HÀNG",
  message: "Duyệt từng kiện trong phiếu lên hàng: tìm cụm + kiện tương ứng bên đóng gói, đồng bộ rawQR từ đóng gói và ghi thông tin phiếu lên hàng vào kiện bên đóng gói (giống khi quét QR xếp kiện)?",
  onConfirm: async () => {
  setIsSyncing(true);
  try {
  const manualItems = [...((currentPkl as any).manualItems || [])];
  const scanQRItems = [...((currentPkl as any).scanQRItems || [])];
  let updatedCount = 0;
  let notFoundCount = 0;

  const normalize = (val: string) => (val || '').trim().toLowerCase();
  const displayLabel = userProfile?.ten_that
  ? `${userProfile.ten_that} (${userProfile.chuc_danh || 'NV'})`
  : (user?.displayName || 'Anonymous');

  // Tìm kiện tương ứng bên đóng gói theo mã dự án + cụm + tên
  const findPackingMatch = (loadedItem: any): { item: PackingItem; packingDocId: string; projectCode?: string; projectName?: string } | null => {
  // Khớp theo id kiện đóng gói (mạnh nhất)
  if (loadedItem.id) {
  const byId = allPackingItems.find(x => x.item?.id === loadedItem.id);
  if (byId) return byId;
  }
  const loadedName = normalize(loadedItem.name);
  if (!loadedName) return null;
  const loadedCluster = normalize(loadedItem.cluster);
  const loadedProjectCode = normalize(loadedItem.projectCode) || normalize(currentPkl.projectId);
  // Ưu tiên 1: khớp chính xác mã dự án + cụm + tên
  if (loadedProjectCode) {
  const projClusterMatch = allPackingItems.find(x =>
  normalize(x.projectCode || '') === loadedProjectCode &&
  normalize(x.item?.name || '') === loadedName &&
  normalize(x.item?.cluster || '') === loadedCluster
  );
  if (projClusterMatch) return projClusterMatch;
  }
  // Ưu tiên 2: khớp cụm + tên (không cần mã dự án)
  const clusterMatch = allPackingItems.find(x =>
  normalize(x.item?.name || '') === loadedName &&
  normalize(x.item?.cluster || '') === loadedCluster
  );
  if (clusterMatch) return clusterMatch;
  // Ưu tiên 3: khớp mã dự án + tên
  if (loadedProjectCode) {
  const projNameMatch = allPackingItems.find(x =>
  normalize(x.projectCode || '') === loadedProjectCode &&
  normalize(x.item?.name || '') === loadedName
  );
  if (projNameMatch) return projNameMatch;
  }

  // Fallback an toàn: chỉ khớp tên khi kiện lên hàng không có cụm,
  // hoặc khi có đúng 1 kiện đóng gói trùng tên (tránh sync nhầm kiện).
  if (!loadedCluster) {
  const byName = allPackingItems.find(x => normalize(x.item?.name || '') === loadedName);
  if (byName) return byName;
  } else {
  const nameMatches = allPackingItems.filter(x => normalize(x.item?.name || '') === loadedName);
  if (nameMatches.length === 1) {
  return nameMatches[0];
  }
  }
  return null;
  };

  // Gom các kiện cần ghi thông tin phiếu lên hàng theo từng phiếu đóng gói,
  // ghi đúng kiện theo id (tránh sync nhầm kiện CTHT trùng tên ở các cụm khác nhau).
  const packingByDoc: Record<string, { itemId?: string }[]> = {};

  // Ghi trực tiếp thông tin phiếu lên hàng vào ĐÚNG kiện bên đóng gói theo id.
  // Mỗi phiếu đóng gói chỉ đọc/ghi 1 lần để tránh ghi đè lẫn nhau (lost update).
  const markPackingItemsLoaded = async () => {
  for (const [packingDocId, matches] of Object.entries(packingByDoc)) {
  const packSnap = await getDoc(doc(db, 'packing', packingDocId));
  if (!packSnap.exists()) continue;
  const packItems = (packSnap.data() as any)?.items || [];
  const updatedPackItems = [...packItems];
  let changed = false;
  for (const m of matches) {
  const pIdx = updatedPackItems.findIndex((it: any) => it.id === m.itemId);
  if (pIdx === -1) continue;
  updatedPackItems[pIdx] = {
  ...updatedPackItems[pIdx],
  loaded: true,
  loadedBy: displayLabel,
  loadedPklCode: currentPkl.pklCode,
  loadedPklId: currentPkl.id,
  };
  changed = true;
  }
  if (changed) {
  await updateDoc(doc(db, 'packing', packingDocId), { items: updatedPackItems });
  }
  }
  };

  const syncPromises: Promise<void>[] = [];

  const syncItems = (arr: any[]) => {
  for (let i = 0; i < arr.length; i++) {
  const matched = findPackingMatch(arr[i]);
  // Không tìm thấy kiện tương ứng bên đóng gói → đếm vào notFound
  if (!matched) {
  notFoundCount++;
  continue;
  }
  const pkgProjectCode = matched.projectCode || arr[i].projectCode || currentPkl.projectId || '';
  const itemName = arr[i].name || matched.item.name || '';
  // 1. Đồng bộ rawQR từ đóng gói vào kiện lên hàng (nếu kiện đóng gói có rawQR)
  const pkgRawQR = matched.item?.rawQR || '';
  if (pkgRawQR && arr[i].rawQR !== pkgRawQR) {
  arr[i] = { ...arr[i], rawQR: normalizeLoadRawQR(pkgRawQR) };
  updatedCount++;
  }
  // 2. Gom kiện để ghi thông tin phiếu lên hàng vào ĐÚNG kiện bên đóng gói theo id
  if (matched.packingDocId) {
  if (!packingByDoc[matched.packingDocId]) packingByDoc[matched.packingDocId] = [];
  packingByDoc[matched.packingDocId].push({ itemId: matched.item?.id });
  }
  // 3. Ghi loadInfo vào instance tương ứng trong project config (giống khi quét QR)
  syncPromises.push(syncInstanceLoadInfo(itemName, matched.item.instanceIndex, pkgProjectCode, {
  pklId: currentPkl.id!,
  pklCode: currentPkl.pklCode,
  loadedAt: new Date(),
  loadedBy: displayLabel,
  vehicleInfo: currentPkl.vehicleInfo
  }, projectEntries));
  }
  };
  syncItems(manualItems);
  syncItems(scanQRItems);

  await markPackingItemsLoaded();
  await Promise.allSettled(syncPromises);

  if (updatedCount === 0 && notFoundCount === 0) {
  showSuccess('Tất cả kiện đã khớp rawQR và thông tin phiếu lên hàng đã được ghi vào đóng gói.');
  return;
  }
  if (updatedCount === 0 && notFoundCount > 0) {
  showWarning(`Không tìm thấy kiện đóng gói tương ứng cho ${notFoundCount} kiện. Kiểm tra lại cụm/tên kiện lên hàng.`);
  return;
  }

  await updateDoc(doc(db, 'loading', currentPkl.id), cleanUndefinedFields({
  manualItems,
  scanQRItems,
  }));

  showSuccess(notFoundCount > 0
  ? `Đã đồng bộ rawQR cho ${updatedCount} kiện và ghi thông tin phiếu vào đóng gói. ${notFoundCount} kiện chưa tìm thấy tương ứng bên đóng gói.`
  : `Đã đồng bộ rawQR và ghi thông tin phiếu lên hàng vào đóng gói cho ${updatedCount} kiện!`);
  } catch (err: any) {
  console.error('[SYNC-RAWQR] Error:', err);
  showError('Lỗi đồng bộ rawQR: ' + err.message);
  } finally {
  setIsSyncing(false);
  }
  }
  });
  };


 useEffect(() => {
 if (isEditModalOpen) {
 setEditVehicleInfo(currentPkl.vehicleInfo || '');
 setEditNote(currentPkl.note || '');
 setEditProjectName(currentPkl.projectName || '');
 setEditProjectCodes(currentPkl.projectCodes || []);
 setEditProjectCodeInput('');
 }
 }, [isEditModalOpen, currentPkl]);

 // Lưu cấu hình vào localStorage
 // Hàm bóc tách thông tin từ tên kiện gỗ
 const parseItemDimensionsAndInfo = (name: string) => {
 let w = "0";
 let d = "0";
 let h = "0";
 let unit = "BLDG1";
 let area = "KITCHEN";
 let cabinetType = "T1";

 const rPrefix = /W\s*(\d+)\s*D\s*(\d+)\s*H\s*(\d+)/i;
 const matchPrefix = (name || '').match(rPrefix);
 if (matchPrefix) {
 w = matchPrefix[1];
 d = matchPrefix[2];
 h = matchPrefix[3];
 } else {
 const rCross = /(\d+)\s*[xX*]\s*(\d+)\s*[xX*]\s*(\d+)/;
 const matchCross = (name || '').match(rCross);
 if (matchCross) {
 w = matchCross[1];
 d = matchCross[2];
 h = matchCross[3];
 }
 }

 const rType = /\b(T\d+|MC\d+|B\d+|U\d+|D\d+|A\d+)\b/i;
 const matchType = (name || '').match(rType);
 if (matchType) {
 cabinetType = matchType[1].toUpperCase();
 } else {
 const rTypeBeforeW = /\b([a-zA-Z]+\d+)\s+W\d+/i;
 const matchTypeW = (name || '').match(rTypeBeforeW);
 if (matchTypeW) {
 cabinetType = matchTypeW[1].toUpperCase();
 }
 }

 const upperName = (name || '').toUpperCase();
 let matchedArea = "";
 if (upperName.includes("PRIB")) {
 matchedArea = "PRIME BATH";
 } else if (upperName.includes("PRI")) {
 matchedArea = "PRIME VANITY";
 } else if (upperName.includes("BAT1")) {
 matchedArea = "BATH 1";
 } else if (upperName.includes("BAT2")) {
 matchedArea = "BATH 2";
 } else if (upperName.includes("COT")) {
 matchedArea = "COAT";
 } else if (upperName.includes("KIT")) {
 matchedArea = "KITCHEN";
 } else if (upperName.includes("ISL")) {
 matchedArea = "ISLAND";
 } else if (upperName.includes("LVR")) {
 matchedArea = "LIVING ROOM";
 } else if (upperName.includes("POWD")) {
 matchedArea = "POWDER ROOM";
 } else if (upperName.includes("LRB")) {
 matchedArea = "LR BAR";
 } else if (upperName.includes("ENP")) {
 matchedArea = "ENTRY PROFILE";
 }

 if (matchedArea) {
 area = matchedArea;
 } else {
 const rArea = /\b(KITCHEN|BEDROOM|LIVING|WC|TOILET|LPN|PK|PN|DINING|BẾP|KHÁCH|NGỦ)\b/i;
 const matchArea = (name || '').match(rArea);
 if (matchArea) {
 let areaVal = matchArea[1].toUpperCase();
 if (areaVal === 'BẾP') areaVal = 'KITCHEN';
 if (areaVal === 'NGỦ' || areaVal === 'LPN' || areaVal === 'PN') areaVal = 'BEDROOM';
 if (areaVal === 'KHÁCH' || areaVal === 'PK' || areaVal === 'LIVING') areaVal = 'LIVINGROOM';
 area = areaVal;
 }
 }

 const rUnit = /(BLDG\s*\d+|APARTMENT\s*\d+|ROOM\s*\d+|P\d{3}|L\d+|T\d+|BẦU|TẦNG\s*\d+)/i;
 const matchUnit = (name || '').match(rUnit);
 if (matchUnit) {
 unit = matchUnit[1].toUpperCase().replace(/\s+/g, '');
 }

 return { w, d, h, unit, area, cabinetType };
 };

 const handleDeletePkl = () => {
 if (!hasRole('admin')) {
 showError("Chỉ tài khoản Admin mới có quyền xóa phiếu lên hàng này.");
 return;
 }

 showConfirm({
 title: "XÓA PHIẾU LÊN HÀNG (PKL)",
 message: `Bạn có chắc chắn muốn xóa vĩnh viễn phiếu PKL "${currentPkl.pklCode}" không? Thao tác này sẽ dỡ bỏ toàn bộ tất cả kiện hàng trên xe.`,
 onConfirm: async () => {
 setIsSavingLoading(true);
 try {
 if (!currentPkl.id) return;
 const q = query(
 collection(db, 'loading_histories'),
 where('pklId', '==', currentPkl.id)
 );
 const snap = await getDocs(q);
 const deletePromises = snap.docs.map(historyDoc => deleteDoc(doc(db, 'loading_histories', historyDoc.id)));
 await Promise.all(deletePromises);

 await deleteDoc(doc(db, 'loading', currentPkl.id));

 const displayLabel = userProfile?.ten_that
 ? `${userProfile.ten_that} (${userProfile.chuc_danh || 'NV'})`
 : (user?.displayName || 'Anonymous');

 await addDoc(collection(db, 'activities'), {
 userId: user?.uid || 'system',
 userName: displayLabel,
 userEmail: user?.email || '',
 action: 'Xóa phiếu PKL',
 details: `Xóa vĩnh viễn phiếu lên hàng PKL: ${currentPkl.pklCode} thuộc dự án ${currentPkl.projectId}`,
 projectCode: currentPkl.projectId,
 timestamp: serverTimestamp()
 });

 showSuccess(`Đã xóa thành công phiếu PKL ${currentPkl.pklCode}.`);
 onBack();
 } catch (error: any) {
 console.error(error);
 showError("Lỗi hệ thống khi xóa phiếu PKL: " + error.message);
 } finally {
 setIsSavingLoading(false);
 }
 }
 });
 };

 const handleSaveEdit = async () => {
 if (!user || !currentPkl.id) return;
 setIsSavingLoading(true);
 try {
 await updateDoc(doc(db, 'loading', currentPkl.id), {
 vehicleInfo: editVehicleInfo,
 note: editNote,
 projectName: editProjectName || currentPkl.projectName || '',
 projectCodes: editProjectCodes,
 });

 const displayLabel = userProfile?.ten_that
 ? `${userProfile.ten_that} (${userProfile.chuc_danh || 'NV'})`
 : (user.displayName || 'Anonymous');

 await addDoc(collection(db, 'activities'), {
 userId: user.uid,
 userName: displayLabel,
 userEmail: user.email,
 action: 'Cập nhật phiếu PKL',
 details: `Cập nhật PKL ${currentPkl.pklCode}: Sửa thông tin xe/tài xế trong chi tiết phiếu`,
 projectCode: currentPkl.projectId,
 timestamp: serverTimestamp()
 });

 setIsEditModalOpen(false);
 showSuccess("Đã cập nhật thông tin phiếu PKL thành công.");
 } catch (error) {
 handleFirestoreError(error, OperationType.UPDATE, 'loading');
 } finally {
 setIsSavingLoading(false);
 }
 };

 // 1. Đồng bộ thông tin PKL này trong realtime
 useEffect(() => {
 if (!pkl.id) return;
 const unsub = onSnapshot(doc(db, 'loading', pkl.id), (docSnap) => {
 if (docSnap.exists()) {
 setCurrentPkl({ id: docSnap.id, ...docSnap.data() } as PKLOrder);
 }
 });
 return unsub;
 }, [pkl.id]);

 // 2. Tải kiện đã đóng gói - loc theo gioi han du an cua phieu PKL
 useEffect(() => {
 const q = query(
 collection(db, 'packing')
 );
 const unsub = onSnapshot(q, (snapshot) => {
 const lists = snapshot.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() } as any));
 const pklProjectCodes = (currentPkl.projectCodes || []).map(c => c.toLowerCase().trim());
 const hasProjectLimit = pklProjectCodes.length > 0 && !pklProjectCodes.includes('all');
 const allItems: { item: PackingItem; packingDocId: string; projectCode?: string; projectName?: string }[] = [];
 lists.forEach(list => {
 const listPC = (list.projectCode || '').toLowerCase().trim();
 if (hasProjectLimit && listPC && !pklProjectCodes.includes(listPC)) {
 return;
 }
 if (list.items) {
 list.items.forEach((it: PackingItem) => {
 allItems.push({
 item: it,
 packingDocId: list.id,
 projectCode: list.projectCode || '',
 projectName: list.projectName || ''
 });
 });
 }
 });
 setAllPackingItems(allItems as any);
 }, (err) => handleFirestoreError(err, OperationType.GET, 'packing'));
 return unsub;
 }, [currentPkl.projectCodes]);

 // 3. Tải lịch sử lên xe của PKL hiện tại
 useEffect(() => {
 if (!currentPkl.id) return;
 const q = query(
 collection(db, 'loading_histories'),
 where('pklId', '==', currentPkl.id)
 );
 const unsub = onSnapshot(q, (snapshot) => {
 const histories = snapshot.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() } as LoadingHistory));
 setLoadingHistories(histories);
 }, (err) => handleFirestoreError(err, OperationType.GET, 'loading_histories'));
 return unsub;
 }, [currentPkl.id]);

 // Lấy ra danh sách các ID kiện đã được xếp trong PKL bất kỳ (để chặn bốc trùng)
 // Thực tế, để chính xác, ta sẽ truy vấn tất cả loading_histories
 const [allLoadedPackageIds, setAllLoadedPackageIds] = useState<string[]>([]);
 useEffect(() => {
 const unsub = onSnapshot(collection(db, 'loading_histories'), (snapshot) => {
 const ids = snapshot.docs.map(docSnap => docSnap.data().packageId as string);
 setAllLoadedPackageIds(ids);
 });
 return unsub;
 }, []);



 // Update ảnh tổng thể Overall Images của xe
 const handleOverallImagesChange = async (newImages: string[]) => {
 if (!currentPkl.id) return;
 try {
 await updateDoc(doc(db, 'loading', currentPkl.id), {
 overallImages: newImages
 });
 showSuccess("Đã cập nhật ảnh tổng thể phương tiện thành công.");
 } catch (err) {
 showError("Có lỗi xảy ra khi lưu ảnh phương tiện.");
 }
 };

 // Mở modal xác minh ảnh chụp khi xếp hàng
 const triggerVerifyPackage = (item: PackingItem, packingDocId: string) => {
 setSelectedItemToVerify({ item, packingDocId });
 setVerificationImages([]);
 setIsVerifyModalOpen(true);
 };



 // Xử lý logic xếp kiện lên xe (Lưu Lịch sử & Update mảng PKL)
 const handleConfirmLoadToVehicle = async () => {
 if (!user || !selectedItemToVerify || !currentPkl.id) return;

 const item = selectedItemToVerify.item;

 setIsSavingLoading(true);
 try {
 const displayLabel = userProfile?.ten_that
 ? `${userProfile.ten_that} (${userProfile.chuc_danh || 'NV'})`
 : (user.displayName || 'Anonymous');

 const matchedPkgInfo = allPackingItems.find(x => x.item.id === item.id);
 const pkgProjectCode = (matchedPkgInfo as any)?.projectCode || currentPkl.projectId || '';
 const pkgProjectName = (matchedPkgInfo as any)?.projectName || currentPkl.projectName || '';
 const rawQrData = item.rawQR || '';

 await addDoc(collection(db, 'loading_histories'), {
 packageId: `${item.id}_${Date.now()}`,
 packageName: item.name,
 pklId: currentPkl.id,
 pklCode: currentPkl.pklCode,
 loadedBy: displayLabel,
 loadedAt: serverTimestamp(),
 verificationImages: verificationImages,
 projectCode: pkgProjectCode,
 projectName: pkgProjectName,
 rawQrData: normalizeLoadRawQR(rawQrData || item.name)
 });

  // Lưu metadata kiện vào manualItems
  const existingManual = (currentPkl as any).manualItems || [];
  if (!existingManual.some((m: any) => m.id === item.id)) {
    const currentProjectCodes = currentPkl.projectCodes || [];
    const manualEntry = {
      id: item.id,
      name: item.name,
      cluster: item.cluster || '',
      subType: item.subType || 'kienModule',
      rawQR: normalizeLoadRawQR(item.rawQR || rawQrData || item.name),
      projectCode: pkgProjectCode,
      projectName: pkgProjectName,
    };
    const updateData: any = {
      manualItems: [...existingManual, manualEntry]
    };
    if (pkgProjectCode && !currentProjectCodes.includes(pkgProjectCode)) {
      updateData.projectCodes = [...currentProjectCodes, pkgProjectCode];
    }
    await updateDoc(doc(db, 'loading', currentPkl.id), cleanUndefinedFields(updateData));

    syncItemLoadedStatus(item.name, true, displayLabel, pkgProjectCode, currentPkl.pklCode, currentPkl.id);
  }

 syncInstanceLoadInfo(item.name, item.instanceIndex, pkgProjectCode, {
   pklId: currentPkl.id!,
   pklCode: currentPkl.pklCode,
   loadedAt: new Date(),
   loadedBy: displayLabel,
   vehicleInfo: currentPkl.vehicleInfo,
 }, projectEntries);

 await addDoc(collection(db, 'activities'), {
 userId: user.uid,
 userName: displayLabel,
 userEmail: user.email,
 action: 'Xếp kiện lên xe',
 details: `PKL: ${currentPkl.pklCode} | Chất kiện: ${item.name} (${item.cluster || 'N/A'})`,
 projectCode: currentPkl.projectId,
 timestamp: serverTimestamp()
 });

 setCenteredToast({ show: true, message: `Đã xếp kiện "${item.name}" lên xe!` });
 setTimeout(() => setCenteredToast({ show: false, message: '' }), 2500);

 setIsVerifyModalOpen(false);
 setSelectedItemToVerify(null);
 setVerificationImages([]);
 } catch (err: any) {
 console.error(err);
 showError("Lỗi hệ thống khi bốc xếp lên xe: " + err.message);
 } finally {
 setIsSavingLoading(false);
 }
 };

 // Xử lý xếp HÀNG LOẠT nhiều kiện cùng tên lên xe
 const handleBulkConfirmLoad = async () => {
 if (!user || bulkItemsToLoad.length === 0 || !currentPkl.id) return;

 if (bulkVerificationImages.length === 0) {
 showWarning("Yêu cầu chụp/tải lên tối thiểu 1 ảnh xác minh trước khi xếp hàng loạt lên xe.");
 return;
 }

 setIsSavingLoading(true);
 try {
 const displayLabel = userProfile?.ten_that
 ? `${userProfile.ten_that} (${userProfile.chuc_danh || 'NV'})`
 : (user.displayName || 'Anonymous');

 const loadedIds: string[] = [];
 const loadedNames: string[] = [];

  for (const entry of bulkItemsToLoad) {
  const pkgProjectCode = entry.projectCode || currentPkl.projectId || '';
  const pkgProjectName = entry.projectName || currentPkl.projectName || '';

  await addDoc(collection(db, 'loading_histories'), {
  packageId: entry.item.id,
  packageName: entry.item.name,
  pklId: currentPkl.id,
  pklCode: currentPkl.pklCode,
  loadedBy: displayLabel,
  loadedAt: serverTimestamp(),
  verificationImages: bulkVerificationImages,
  projectCode: pkgProjectCode,
  projectName: pkgProjectName,
    rawQrData: normalizeLoadRawQR(entry.item.rawQR || entry.item.name)
  });

  loadedIds.push(entry.item.id);
  loadedNames.push(entry.item.name);
  }

  // Update manualItems trên PKL
  const existingManual = (currentPkl as any).manualItems || [];
  const newManualEntries = bulkItemsToLoad
    .filter(entry => !existingManual.some((m: any) => m.id === entry.item.id))
    .map(entry => ({
      id: entry.item.id,
      name: entry.item.name,
      cluster: entry.item.cluster || '',
      subType: entry.item.subType || 'kienModule',
      rawQR: normalizeLoadRawQR(entry.item.rawQR || entry.item.name),
      projectCode: entry.projectCode || currentPkl.projectId || '',
      projectName: entry.projectName || currentPkl.projectName || '',
    }));
  const bulkUpdateData: any = {};
  if (newManualEntries.length > 0) {
    bulkUpdateData.manualItems = [...existingManual, ...newManualEntries];
  }
  // Tự thêm projectCodes từ các kiện xếp hàng loạt
  const currentProjectCodes = currentPkl.projectCodes || [];
  const newProjectCodes = bulkItemsToLoad
    .map(e => e.projectCode || currentPkl.projectId || '')
    .filter(code => code && !currentProjectCodes.includes(code));
  if (newProjectCodes.length > 0) {
    bulkUpdateData.projectCodes = [...currentProjectCodes, ...newProjectCodes];
  }

  await updateDoc(doc(db, 'loading', currentPkl.id), cleanUndefinedFields(bulkUpdateData));

 // Đồng bộ trạng thái loaded sang phiếu vận đơn
 for (const entry of bulkItemsToLoad) {
  syncItemLoadedStatus(entry.item.name, true, displayLabel, entry.projectCode || currentPkl.projectId || '', currentPkl.pklCode, currentPkl.id);
 syncInstanceLoadInfo(entry.item.name, entry.item.instanceIndex, entry.projectCode || currentPkl.projectId || '', {
   pklId: currentPkl.id!,
   pklCode: currentPkl.pklCode,
   loadedAt: new Date(),
   loadedBy: displayLabel,
   vehicleInfo: currentPkl.vehicleInfo,
 }, projectEntries);
 }

 // Log activity
 const uniqueNames = [...new Set(loadedNames)];
 await addDoc(collection(db, 'activities'), {
 userId: user.uid,
 userName: displayLabel,
 userEmail: user.email,
 action: 'Xếp kiện lên xe (hàng loạt)',
 details: `PKL: ${currentPkl.pklCode} | Đã xếp ${loadedIds.length} kiện: ${uniqueNames.join(', ')}`,
 projectCode: currentPkl.projectId,
 timestamp: serverTimestamp()
 });

 showSuccess(`Đã xếp thành công ${loadedIds.length} kiện "${uniqueNames[0]}" lên xe!`);

 setIsBulkLoadModalOpen(false);
 setBulkItemsToLoad([]);
 setBulkVerificationImages([]);
 } catch (err: any) {
 console.error(err);
 showError("Lỗi hệ thống khi bốc xếp hàng loạt: " + err.message);
 } finally {
 setIsSavingLoading(false);
 }
 };

  // Xóa kiện khỏi PKL (Hủy bốc)
  const handleRemoveFromPkl = async (packageId: string, packageName: string) => {
  showConfirm({
  title: "HỦY BỐC KIỆN KHỎI XE",
  message: `Bạn có chắc chắn muốn dỡ kiện "${packageName}" khỏi vận xe và xóa khỏi danh sách PKL này không?`,
  onConfirm: async () => {
  try {
  if (!currentPkl.id) return;
  // 1. Tìm và xóa trong collection loading_histories
  // Query theo pklId rồi filter packageName client-side (tránh cần composite index)
  const q = query(
  collection(db, 'loading_histories'),
  where('pklId', '==', currentPkl.id)
  );
  const snap = await getDocs(q);
  const toDelete = snap.docs.filter(d => d.data().packageName === packageName);
  const deletePromises = toDelete.map(historyDoc => deleteDoc(doc(db, 'loading_histories', historyDoc.id)));
  await Promise.all(deletePromises);

 // 2. Xóa khỏi manualItems hoặc scanQRItems
 const existingManual = (currentPkl as any).manualItems || [];
 const existingScanQR = (currentPkl as any).scanQRItems || [];
 const removeUpdate: any = {};
 if (existingManual.some((m: any) => m.id === packageId)) {
   removeUpdate.manualItems = existingManual.filter((m: any) => m.id !== packageId);
 }
 if (existingScanQR.some((s: any) => s.id === packageId)) {
   removeUpdate.scanQRItems = existingScanQR.filter((s: any) => s.id !== packageId);
 }
 if (Object.keys(removeUpdate).length > 0) {
   await updateDoc(doc(db, 'loading', currentPkl.id), cleanUndefinedFields(removeUpdate));
 }

 // Đồng bộ trạng thái loaded sang phiếu vận đơn
  syncItemLoadedStatus(packageName, false, '', currentPkl.projectId || '', currentPkl.pklCode, currentPkl.id);
  syncInstanceLoadInfo(packageName, undefined, currentPkl.projectId || '', null, projectEntries);

 // 3. Log activity
 const displayLabel = userProfile?.ten_that
 ? `${userProfile.ten_that} (${userProfile.chuc_danh || 'NV'})`
 : (user?.displayName || 'Anonymous');
 await addDoc(collection(db, 'activities'), {
 userId: user?.uid || 'system',
 userName: displayLabel,
 userEmail: user?.email || '',
 action: 'Hạ kiện khỏi xe',
 details: `Hạ kiện: ${packageName} khỏi PKL: ${currentPkl.pklCode}`,
 projectCode: currentPkl.projectId,
 timestamp: serverTimestamp()
 });

 showSuccess(`Đã dỡ kiện ${packageName} khỏi xe tải.`);
 } catch (err) {
 showError("Không thể hạ kiện khỏi xe: " + err);
 }
 }
 });
 };

 // Xử lý quét QR - hỗ trợ nhiều kiện cùng tên
  const loadItemDirectly = async (item: PackingItem, packingDocId: string, rawQrData?: string) => {
  if (!user || !currentPkl.id) return;

  setIsSavingLoading(true);
  try {
  const displayLabel = userProfile?.ten_that
  ? `${userProfile.ten_that} (${userProfile.chuc_danh || 'NV'})`
  : (user.displayName || 'Anonymous');

  const matchedPkgInfo = allPackingItems.find(x => x.item.id === item.id);
  const pkgProjectCode = (matchedPkgInfo as any)?.projectCode || currentPkl.projectId || '';
  const pkgProjectName = (matchedPkgInfo as any)?.projectName || currentPkl.projectName || '';

  await addDoc(collection(db, 'loading_histories'), {
  packageId: `${item.id}_${Date.now()}`,
  packageName: resolveLoadDisplayName(item, rawQrData),
  pklId: currentPkl.id,
  pklCode: currentPkl.pklCode,
  loadedBy: displayLabel,
  loadedAt: serverTimestamp(),
  verificationImages: [],
  projectCode: pkgProjectCode,
  projectName: pkgProjectName,
  rawQrData: normalizeLoadRawQR(rawQrData || item.name)
  });

  const existingScanQR = (currentPkl as any).scanQRItems || [];
  if (!existingScanQR.some((s: any) => s.id === item.id)) {
  const currentProjectCodes = currentPkl.projectCodes || [];
  const scanEntry = {
    id: item.id,
    name: resolveLoadDisplayName(item, rawQrData),
    cluster: item.cluster || '',
    subType: item.subType || 'kienModule',
    rawQR: normalizeLoadRawQR(rawQrData || item.rawQR || item.name),
    projectCode: pkgProjectCode,
    projectName: pkgProjectName,
  };
  const updateData: any = {
    scanQRItems: [...existingScanQR, scanEntry]
  };
  if (pkgProjectCode && !currentProjectCodes.includes(pkgProjectCode)) {
    updateData.projectCodes = [...currentProjectCodes, pkgProjectCode];
  }
  await updateDoc(doc(db, 'loading', currentPkl.id), cleanUndefinedFields(updateData));

    syncItemLoadedStatus(item.name, true, displayLabel, pkgProjectCode, currentPkl.pklCode, currentPkl.id);
  }

  syncInstanceLoadInfo(item.name, item.instanceIndex, pkgProjectCode, {
    pklId: currentPkl.id!,
    pklCode: currentPkl.pklCode,
    loadedAt: new Date(),
    loadedBy: displayLabel,
    vehicleInfo: currentPkl.vehicleInfo,
  }, projectEntries);

 await addDoc(collection(db, 'activities'), {
 userId: user.uid,
 userName: displayLabel,
 userEmail: user.email,
 action: 'Xếp kiện lên xe',
 details: `PKL: ${currentPkl.pklCode} | Chất kiện: ${item.name} (${item.cluster || 'N/A'})`,
 projectCode: currentPkl.projectId,
 timestamp: serverTimestamp()
 });

 showSuccess(`Đã xếp kiện ${item.name} lên xe!`);
 } catch (err: any) {
 console.error(err);
 showError("Lỗi hệ thống khi bốc xếp lên xe: " + err.message);
 } finally {
 setIsSavingLoading(false);
 }
 };

  const handleQRScan = (result: ScannedResult) => {
  if (scanLockRef.current) return;
  scanLockRef.current = true;
  setTimeout(() => { scanLockRef.current = false; }, 1500);
  setIsQrScannerOpen(false);

  let rawName = (result.rawCode || result.moduleCode || '').trim();
  if (rawName.includes('----')) {
  rawName = rawName.split('----')[0].trim();
  }

  // Bước 1: Match theo rawQR chính xác
  let allMatched = allPackingItems.filter(entry => {
  const itemRawQR = ((entry.item as any)?.rawQR || '').toLowerCase().trim();
  return itemRawQR && itemRawQR === rawName.toLowerCase().trim();
  });

  // Bước 2: Fallback theo tên
  // QR "BCOA1_BẾP.T7|1" → base="BCOA1_BẾP.T7", instanceIndex=1
  // → so với kiện packing name "BCOA1_BẾP.T7 #1/2"
  if (allMatched.length === 0) {
  const cleaned = rawName.replace(/\|\d+$/, '').trim().toLowerCase();
  const instanceMatch = rawName.match(/\|(\d+)$/);
  const scanInstanceIdx = instanceMatch ? parseInt(instanceMatch[1], 10) : null;

  allMatched = allPackingItems.filter(entry => {
    const itemName = (entry.item?.name || '').toLowerCase().trim();
    const baseName = itemName.replace(/\s*#\d+\/\d+$/, '').trim();

    // Match base name: "BCOA1_BẾP.T7" == "BCOA1_BẾP.T7"
    if (baseName !== cleaned) return false;

    // Nếu QR có |N → so N với #N/... trong tên kiện packing
    if (scanInstanceIdx != null) {
      const packingInstMatch = itemName.match(/#(\d+)\//);
      if (packingInstMatch) {
        return parseInt(packingInstMatch[1], 10) === scanInstanceIdx;
      }
    }

    // Không có |N → match base name là đủ (lấy kiện đầu tiên khớp base)
    return true;
  });
  }

  if (allMatched.length > 0) {
  const target = allMatched[0];
  loadItemDirectly(target.item, target.packingDocId, rawName);
  } else {
  loadRawQrCode(rawName, result);
  }
  };

 // Xử lý quét QR không khớp kiện trong packing → lưu trực tiếp mã QR thô
 const loadRawQrCode = async (rawName: string, scanResult: ScannedResult) => {
 if (!user || !currentPkl.id) return;

 setIsSavingLoading(true);
 try {
 const displayLabel = userProfile?.ten_that
 ? `${userProfile.ten_that} (${userProfile.chuc_danh || 'NV'})`
 : (user?.displayName || 'Anonymous');

 const displayName = deriveLoadDisplayName(rawName || scanResult.rawCode || scanResult.moduleCode || '');
 const rawQrData = normalizeLoadRawQR(scanResult.rawCode || rawName);

 const rawPkgId = `raw_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

 await addDoc(collection(db, 'loading_histories'), {
 packageId: rawPkgId,
  packageName: displayName || 'QR KHONG XAC DINH',
 pklId: currentPkl.id,
 pklCode: currentPkl.pklCode,
 loadedBy: displayLabel,
 loadedAt: serverTimestamp(),
 verificationImages: [],
 projectCode: currentPkl.projectId || '',
 projectName: currentPkl.projectName || '',
 rawQrData: rawQrData,
 isRawQr: true
 });

  // Lưu metadata kiện thô vào scanQRItems
  const existingScanQR = (currentPkl as any).scanQRItems || [];
  const scanEntry = {
  id: rawPkgId,
  name: displayName || 'QR KHONG XAC DINH',
  cluster: '',
  subType: 'kienModule',
  rawQR: rawQrData,
  projectCode: currentPkl.projectId || '',
  projectName: currentPkl.projectName || '',
  };
  await updateDoc(doc(db, 'loading', currentPkl.id), {
  scanQRItems: [...existingScanQR, scanEntry]
  });

  await addDoc(collection(db, 'activities'), {
 userId: user.uid,
 userName: displayLabel,
 userEmail: user.email,
 action: 'Xếp kiện lên xe (QR thô)',
 details: `PKL: ${currentPkl.pklCode} | Quét QR thô: ${rawName}`,
 projectCode: currentPkl.projectId,
 timestamp: serverTimestamp()
 });  setCenteredToast({ show: true, message: `Đã thêm kiện "${displayName}" thành công!` });
 setTimeout(() => setCenteredToast({ show: false, message: '' }), 2500);
 } catch (err: any) {
 console.error(err);
 showError("Lỗi khi lưu mã QR: " + err.message);
 } finally {
 setIsSavingLoading(false);
 }
 };

  // Danh sách rawQR đã có trong phiếu lên hàng (dùng để ẩn kiện trùng)
 const loadedRawQRCodes = React.useMemo(() => {
   const set = new Set<string>();
   loadingHistories.forEach(h => {
     const raw = (h as any).rawQrData;
     if (raw) set.add(String(raw).toLowerCase().trim());
   });
   return set;
 }, [loadingHistories]);

 // Danh sách các kiện đã HOÀN TẤT đóng gói và còn số lượng để xếp lên xe
 const eligibleManualItems = (() => {
 const seen = new Set<string>();
 const allSavedItemIds = new Set([
   ...((currentPkl as any).manualItems || []).map((m: any) => m.id),
   ...((currentPkl as any).scanQRItems || []).map((s: any) => s.id)
 ]);
 return allPackingItems.filter(entry => {
 const name = (entry.item?.name || '').toLowerCase();
 if (seen.has(name)) return false;
 seen.add(name);
 // Ẩn nếu đã có trong manualItems hoặc scanQRItems
 if (allSavedItemIds.has(entry.item.id || '')) return false;
 // Ẩn nếu rawQR đã có trong loading_histories (trùng khi quét QR)
 if (entry.item?.rawQR && loadedRawQRCodes.has(entry.item.rawQR.toLowerCase().trim())) return false;
 return entry.item?.packed;
 });
 })();

 // Tìm kiếm kiện trong Modal thủ công
 const filteredEligibleItems = eligibleManualItems.filter(entry => {
 const search = selectSearchTerm.toLowerCase();
 return (entry.item?.name || '').toLowerCase().includes(search) ||
 (entry.item?.cluster || '').toLowerCase().includes(search) ||
 (entry.item?.rawQR || '').toLowerCase().includes(search);
 });

 const isPklProjectAll = !currentPkl.projectId || currentPkl.projectId === 'all';
 const totalToLoadCount = React.useMemo(() => {
 return allPackingItems
 .filter(i => i.item?.packed && (isPklProjectAll || i.projectCode === currentPkl.projectId))
 .reduce((sum, i) => sum + (i.item?.quantity || 1), 0);
 }, [allPackingItems, currentPkl.projectId, isPklProjectAll]);

  const loadedCount = React.useMemo(() => {
  const manualCount = ((currentPkl as any).manualItems || []).length;
  const scanQRCount = ((currentPkl as any).scanQRItems || []).length;
  return manualCount + scanQRCount;
  }, [(currentPkl as any).manualItems, (currentPkl as any).scanQRItems]);

 const reportItems = React.useMemo(() => {
 const grouped: Record<string, {
 projectCode: string;
 projectName: string;
 unit: string;
 cluster: string;
 name: string;
 quantity: number;
 dimensions: string;
 weight: number;
 isCtht: boolean;
 subItems: { name: string; quantity: number }[];
 }> = {};

 // Helper: populate grouped entry from a name + optional item
 const ensureGrouped = (nameKey: string, matchedPkg?: { item: PackingItem; packingDocId: string; projectCode?: string; projectName?: string }) => {
 if (grouped[nameKey]) return;

 const item = matchedPkg?.item;

 const isCthtKien = item?.subType === 'kienCTHT';

 const matchedEntry = projectEntries ? projectEntries.find(e => {
 const cleanModuleCode = (e.moduleCode || '').trim().toLowerCase();
 const cleanItemName = (nameKey || '').trim().toLowerCase();
 return (item && e.id === item.id) ||
 cleanModuleCode === cleanItemName ||
 cleanItemName.includes(cleanModuleCode) ||
 cleanModuleCode.includes(cleanItemName);
 }) : null;

 let parsed = parseItemDimensionsAndInfo(nameKey);
 let defaultW = parsed.w;
 let defaultD = parsed.d;
 let defaultH = parsed.h;
 let defaultUnit = parsed.unit;
 let defaultArea = parsed.area;

 const w = matchedEntry ? (matchedEntry.pWidth || matchedEntry.width || matchedEntry.length || defaultW).toString() : defaultW;
 const d = matchedEntry ? (matchedEntry.pDepth || matchedEntry.depth || defaultD).toString() : defaultD;
 const h = matchedEntry ? (matchedEntry.pHeight || matchedEntry.height || defaultH).toString() : defaultH;

 const dimensions = `${w} x ${d} x ${h} mm`;
 const matchedParsed = matchedEntry ? parseItemDimensionsAndInfo(matchedEntry.moduleCode) : null;

 let displayUnit = matchedParsed?.unit || defaultUnit || "-";
 let displayArea = matchedParsed?.area || defaultArea || "-";
 const displayWeight = item && item.weight ? item.weight : 0;

 if (displayUnit.toUpperCase().includes('ELMB1') || displayUnit.toUpperCase().includes('BLDG1') || displayUnit.toUpperCase().includes('BLMB1') || nameKey.toUpperCase().includes('ELMB1') || nameKey.toUpperCase().includes('BLDG1')) {
 displayUnit = 'BLDG1';
 }

 const isCtht = isCthtKien ||
 displayArea.toLowerCase().includes('chi tiết hỗ trợ') ||
 displayArea.toLowerCase().includes('cấu kiện phụ') ||
 displayArea.toLowerCase().includes('ctht');

 const subItems: { name: string; quantity: number }[] = [];
 if (item?.accessories) {
 item.accessories.forEach(acc => {
 subItems.push({ name: acc.name, quantity: acc.quantity });
 });
 }

 const itemProjectName = (matchedPkg as any)?.projectName;
 const itemProjectCode = (matchedPkg as any)?.projectCode;
 const defaultProj = itemProjectName ? `${formatProjectCode(itemProjectCode)} - ${itemProjectName}` : (formatProjectCode(currentPkl.projectId) || currentPkl.projectName || "");
 let projectName = matchedEntry?.projectName || defaultProj;
 let projectCode = matchedEntry?.projectCode || itemProjectCode || currentPkl.projectId || '-';

 if (projectCode.toUpperCase().includes('ELM026') || projectName.includes('Nhiều Dự Án / Liên Kết') || projectName.includes('Nhiều Dự án')) {
 projectName = '1619 ELMHURST';
 }

 grouped[nameKey] = {
 projectCode,
 projectName,
 unit: displayUnit,
 cluster: displayArea,
 name: nameKey,
 quantity: 0,
 dimensions,
 weight: Number(displayWeight) || 0,
 isCtht,
 subItems
 };
 };

 // 1. Populate from ALL items in the PKL's manualItems + scanQRItems
 const allSavedReportItems = [...((currentPkl as any).manualItems || []), ...((currentPkl as any).scanQRItems || [])];
 allSavedReportItems.forEach(savedItem => {
 const matched = allPackingItems.find(x => x.item.id === savedItem.id) || allPackingItems.find(x => (x.item.name || '').toLowerCase() === (savedItem.name || '').toLowerCase());
 if (matched) {
 ensureGrouped(matched.item.name, matched);
 if (grouped[matched.item.name]) {
 grouped[matched.item.name].quantity += (matched.item.quantity || 1);
 }
 } else {
 ensureGrouped(savedItem.name);
 if (grouped[savedItem.name]) {
 grouped[savedItem.name].quantity += 1;
 }
 }
 });

 // 2. Include items from loading_histories that may not be in manualItems/scanQRItems (raw QR items)
 loadingHistories.forEach(history => {
 const pkgName = history.packageName;
 if (pkgName && !grouped[pkgName.toLowerCase()]) {
 ensureGrouped(pkgName, allPackingItems.find(x => x.item.name === pkgName));
 }
 });

 return Object.values(grouped).sort((a, b) => {
 const projA = (a.projectName || a.projectCode || '').toLowerCase();
 const projB = (b.projectName || b.projectCode || '').toLowerCase();
 if (projA !== projB) return projA.localeCompare(projB, 'vi');

 const unitA = (a.unit || '').toLowerCase();
 const unitB = (b.unit || '').toLowerCase();
 if (unitA !== unitB) return unitA.localeCompare(unitB, 'vi', { numeric: true });

 const areaA = (a.cluster || '').toLowerCase();
 const areaB = (b.cluster || '').toLowerCase();
 if (areaA !== areaB) return areaA.localeCompare(areaB, 'vi');

 const cabA = (a.name.lastIndexOf('.') >= 0 ? a.name.substring(a.name.lastIndexOf('.') + 1) : a.name).toLowerCase();
 const cabB = (b.name.lastIndexOf('.') >= 0 ? b.name.substring(b.name.lastIndexOf('.') + 1) : b.name).toLowerCase();
 return cabA.localeCompare(cabB, 'vi', { numeric: true });
 });
 }, [loadingHistories, allPackingItems, projectEntries, currentPkl]);

 return (
 <div className="space-y-6 pb-24 font-sans">
 {/* Header Điều khiển */}
 <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
 <button
 onClick={onBack}
 className="flex items-center text-slate-600 hover:text-indigo-600 font-bold text-sm cursor-pointer transition-colors"
 >
 <ArrowLeft size={18} className="mr-1.5" />
 QUAY LẠI DANH SÁCH
 </button>

 <div className="flex items-center gap-2">
 {!isGuest && (
 <>
 <button
 onClick={handleExportExcel}
 className="px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white font-black text-xs uppercase tracking-wider rounded-lg shadow cursor-pointer transition flex items-center gap-1.5"
 >
 <FileText size={14} />
 XUẤT EXCEL
 </button>

  <button
  onClick={handleClearCthtRawQR}
  disabled={isSyncing}
  className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white font-black text-xs uppercase tracking-wider rounded-lg shadow cursor-pointer transition flex items-center gap-1.5 disabled:opacity-50"
  >
  <Trash2 size={14} />
  XÓA RAWQR CTHT
  </button>

  <button
  onClick={handleSyncRawQR}
  disabled={isSyncing}
  className="px-4 py-2 bg-sky-600 hover:bg-sky-700 text-white font-black text-xs uppercase tracking-wider rounded-lg shadow cursor-pointer transition flex items-center gap-1.5 disabled:opacity-50"
  >
  <RefreshCw size={14} className={isSyncing ? 'animate-spin' : ''} />
  ĐỒNG BỘ RAWQR
  </button>

  <button
  onClick={() => setShowLoadingExcelEditor(true)}
 className="px-3.5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-black uppercase tracking-wider shadow flex items-center cursor-pointer transition active:scale-95 gap-1.5"
 >
 <FileText size={16} />
 Bảng Excel Lên Xe
 </button>

 <button
 onClick={() => setIsEditModalOpen(true)}
 className="px-4 py-2 bg-amber-500 hover:bg-amber-600 text-white font-black text-xs uppercase tracking-wider rounded-lg shadow cursor-pointer transition flex items-center gap-1.5"
 >
 <Settings size={14} />
 </button>
 </>
 )}

 {hasRole('admin') && (
 <button
 onClick={handleDeletePkl}
 className="px-4 py-2 bg-red-100 hover:bg-red-600 text-red-700 hover:text-white font-black text-xs uppercase tracking-wider rounded-lg transition-colors cursor-pointer flex items-center gap-1.5"
 >
 <Trash2 size={14} />
 </button>
 )}
 </div>
 </div>

 {/* Grid thông tin chung PKL */}
 <div className="bg-white border border-slate-100 rounded-xl p-6 shadow-xs grid grid-cols-1 md:grid-cols-3 gap-6 relative overflow-hidden">
 <div className="space-y-3">
 <div className="flex items-center gap-1.5 text-indigo-600">
 <Truck size={20} />
 <h3 className="text-base font-black uppercase tracking-tight">Thông Tin Vận Đơn</h3>
 </div>
 <div className="space-y-2 text-sm text-slate-600">
 <div>
 <span className="text-xs font-bold text-slate-400 block">Mã PKL</span>
 <span className="font-mono font-extrabold text-slate-900 text-base">{currentPkl.pklCode}</span>
 </div>
 <div>
 <span className="text-xs font-bold text-slate-400 block">Dự án</span>
 {(() => {
 const codes = (currentPkl.projectCodes || []).filter(c => c !== 'all');
 if (codes.length > 0) {
 const badgeColors = [
 { bg: 'bg-indigo-100', text: 'text-indigo-800', border: 'border-indigo-200' },
 { bg: 'bg-emerald-100', text: 'text-emerald-800', border: 'border-emerald-200' },
 { bg: 'bg-amber-100', text: 'text-amber-800', border: 'border-amber-200' },
 { bg: 'bg-rose-100', text: 'text-rose-800', border: 'border-rose-200' },
 { bg: 'bg-cyan-100', text: 'text-cyan-800', border: 'border-cyan-200' },
 { bg: 'bg-violet-100', text: 'text-violet-800', border: 'border-violet-200' },
 { bg: 'bg-pink-100', text: 'text-pink-800', border: 'border-pink-200' },
 { bg: 'bg-teal-100', text: 'text-teal-800', border: 'border-teal-200' },
 ];
 return (
 <div className="flex flex-wrap gap-1 mt-0.5">
 {codes.map((code, idx) => {
 const c = badgeColors[idx % badgeColors.length];
 return (
 <span key={code} className={`px-2.5 py-1 text-xs font-black ${c.bg} ${c.text} rounded-lg border ${c.border} uppercase tracking-wider`}>
 {code}
 </span>
 );
 })}
 </div>
 );
 }
 return <span className="font-bold text-slate-800">{formatProjectCode(currentPkl.projectId)} - {currentPkl.projectName}</span>;
 })()}
 </div>
 </div>
 </div>

 <div className="space-y-3">
 <div className="flex items-center gap-1.5 text-indigo-600">
 <User size={20} />
 <h3 className="text-base font-black uppercase tracking-tight">Phương Tiện</h3>
 </div>
 <div className="space-y-2 text-sm text-slate-600">
 <div>
 <span className="text-xs font-bold text-slate-400 block">Thông tin xe</span>
 <span className="font-bold text-slate-900">{currentPkl.vehicleInfo || '(Chưa có)'}</span>
 </div>
 </div>
 </div>

 <div className="space-y-3">
 <div className="flex items-center gap-1.5 text-indigo-600">
 <Calendar size={20} />
 <h3 className="text-base font-black uppercase tracking-tight">Thông tin Phụ</h3>
 </div>
 <div className="space-y-2 text-sm text-slate-600">
 <div>
 <span className="text-xs font-bold text-slate-400 block">Ghi chú</span>
 <span className="font-medium text-slate-900">{currentPkl.note || 'Không có ghi chú'}</span>
 </div>
 <div>
 <span className="text-xs font-bold text-slate-400 block">Người lập phiếu</span>
 <span className="font-bold text-indigo-600">{currentPkl.createdBy}</span>
 </div>
 </div>
 </div>
 </div>



 {/* Grid bốc hàng và Ảnh phương tiện */}
 <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
 {/* Hàng bên trái: Thao tác bốc hàng & Danh sách kiện đã xếp (2 phần 3) */}
 <div className="lg:col-span-2 space-y-6">

 {(currentPkl.status === 'open' || !currentPkl.status) && !isGuest && (
 <button
 onClick={() => setIsQrScannerOpen(true)}
 className="w-full px-4 py-3 bg-indigo-600 text-white rounded-xl text-sm font-black uppercase tracking-wider shadow-lg shadow-indigo-600/20 hover:bg-indigo-700 flex items-center justify-center cursor-pointer transition active:scale-[0.98] gap-2"
 >
 <QrCode size={20} />
 Quét QR Lên Xe
 </button>
 )}

 <div className="bg-white border border-slate-100 rounded-xl p-6 shadow-xs space-y-6">
 <div>
 <h3 className="text-base font-black uppercase tracking-tight text-slate-800">Danh Sách Kiện Bốc Trên Xe</h3>
 <p className="text-xs text-slate-400 font-bold">Thao tác quét mã QR hoặc chọn thủ công các cấu kiện</p>
 </div>

 {/* Thống kê tiến độ bốc xếp */}
 <div className="p-4 bg-slate-100 rounded-lg border border-slate-100 flex items-center justify-between">
 <div>
 <span className="text-xs font-bold text-slate-400">Tiến độ lên hàng:</span>
 <div className="text-sm font-bold text-slate-800 mt-0.5">Đã bốc lên xe</div>
 </div>
 <div className="text-right">
 <span className="text-4xl font-black text-indigo-600 leading-none">{loadedCount}</span>
 <span className="text-xs font-bold text-slate-400 block mt-1">kiện</span>
 </div>
 </div>

 {/* List kien da boc - doc tu manualItems + scanQRItems */}
 {(() => {
 const savedManual = (currentPkl as any).manualItems || [];
 const savedScanQR = (currentPkl as any).scanQRItems || [];
const loadedManual = savedManual.map((m: any) => ({
        item: { id: m.id, name: m.name, quantity: 1, packed: true, subType: m.subType, cluster: m.cluster, rawQR: m.rawQR || '' } as any as PackingItem,
        packingDocId: '',
        projectCode: m.projectCode || currentPkl.projectId || '',
        projectName: m.projectName || currentPkl.projectName || ''
      }));
  const loadedScanQR = savedScanQR.map((s: any) => ({
        item: { id: s.id, name: s.name, quantity: 1, packed: true, subType: s.subType, cluster: s.cluster, rawQR: s.rawQR || '' } as any as PackingItem,
        packingDocId: '',
        projectCode: s.projectCode || currentPkl.projectId || '',
        projectName: s.projectName || currentPkl.projectName || ''
      }));

 const loadedItems = [...loadedManual, ...loadedScanQR];

 if (loadedItems.length === 0) {
 return (
 <div className="py-12 text-center rounded-lg border border-dashed border-slate-200">
 <FileText size={40} className="mx-auto mb-2 opacity-15 text-slate-400" />
 <p className="text-xs text-slate-400 font-extrabold uppercase tracking-wide">Chua co kien nao duoc boc len xe</p>
 {currentPkl.status === 'open' && (
 <p className="text-[10px] text-slate-500 mt-1">Su dung nut "Quet QR Len Xe" hoac "Bang Excel Len Xe" o tren de chat hang</p>
 )}
 </div>
 );
 }

 const projectColors: Record<string, { bg: string; text: string; border: string; bar: string }> = {};
 const colorPalette = [
 { bg: 'bg-indigo-100', text: 'text-indigo-800', border: 'border-indigo-200', bar: 'bg-indigo-500' },
 { bg: 'bg-emerald-100', text: 'text-emerald-800', border: 'border-emerald-200', bar: 'bg-emerald-500' },
 { bg: 'bg-amber-100', text: 'text-amber-800', border: 'border-amber-200', bar: 'bg-amber-500' },
 { bg: 'bg-rose-100', text: 'text-rose-800', border: 'border-rose-200', bar: 'bg-rose-500' },
 { bg: 'bg-cyan-100', text: 'text-cyan-800', border: 'border-cyan-200', bar: 'bg-cyan-500' },
 { bg: 'bg-violet-100', text: 'text-violet-800', border: 'border-violet-200', bar: 'bg-violet-500' },
 { bg: 'bg-pink-100', text: 'text-pink-800', border: 'border-pink-200', bar: 'bg-pink-500' },
 { bg: 'bg-teal-100', text: 'text-teal-800', border: 'border-teal-200', bar: 'bg-teal-500' },
 ];
 let colorIdx = 0;
 const getColor = (pc: string) => {
 if (!pc) return colorPalette[0];
 if (!projectColors[pc]) { projectColors[pc] = colorPalette[colorIdx % colorPalette.length]; colorIdx++; }
 return projectColors[pc];
 };

 return (
  <div className="space-y-1.5">
  {loadedItems.map((entry, idx) => {
  const pc = entry.projectCode || '';
  const colors = getColor(pc);
  const item = entry.item;

  // Kiểm tra rawQR có khớp với đóng gói không
  const itemRawQR = ((item as any).rawQR || '').replace(/----.*----/, '').trim().toLowerCase();
  const matchedPkg = itemRawQR ? allPackingItems.find(e => {
    const pkgRawQR = ((e.item as any)?.rawQR || '').replace(/----.*----/, '').trim().toLowerCase();
    return pkgRawQR && pkgRawQR === itemRawQR;
  }) : null;
  const isLinked = !!matchedPkg;

  return (
  <div key={item.id || idx} className="bg-white rounded-lg border border-slate-100 p-3 flex items-center gap-3 transition-all hover:bg-slate-100/40 relative overflow-hidden">
   <div className={`absolute left-0 top-0 bottom-0 w-1 ${colors.bar}`} />
   <span className="shrink-0 w-7 text-center text-xs font-black text-slate-400">{idx + 1}</span>
   {pc && (
   <span className={`shrink-0 px-2 py-1 text-[9px] font-black uppercase tracking-wider ${colors.bg} ${colors.text} rounded-lg border ${colors.border}`}>
   {formatProjectCode(pc)}
   </span>
   )}
   {item.cluster ? (
   <span className="shrink-0 w-24 px-2 py-1 text-[9px] font-bold uppercase tracking-wider bg-slate-100 text-slate-500 rounded-lg border border-slate-200 truncate text-center" title={item.cluster}>
   {item.cluster}
   </span>
   ) : (
   <span className="shrink-0 w-24" />
   )}
   <div className="min-w-0 flex-1">
               <span className="text-sm font-black text-slate-800 uppercase tracking-tight truncate block" title={item.name}>
                 {(() => {
                   const hashIdx = (item.name || '').lastIndexOf('#');
                   if (hashIdx > 0) {
                     return <>{item.name.substring(0, hashIdx)}<span className="text-indigo-500">{item.name.substring(hashIdx)}</span></>;
                   }
                   return item.name;
                 })()}
               </span>
               {(item as any).rawQR && (
                 <span className="block text-[9px] font-mono text-slate-400 truncate mt-0.5" title={(item as any).rawQR}>
                   {((item as any).rawQR || '').replace(/----.*----/, '').trim()}
                 </span>
               )}
             </div>
  {isLinked ? (
    <CheckCircle size={16} className="shrink-0 text-emerald-500" title="Đã liên kết rawQR với đóng gói" />
  ) : (
    <CheckCircle size={16} className="shrink-0 text-orange-400" title="rawQR chưa khớp — Bấm Đồng bộ để cập nhật" />
  )}
  {(currentPkl.status === 'open' || !currentPkl.status) && (
 <button
 onClick={() => handleRemoveFromPkl(item.id || '', item.name)}
 className="shrink-0 p-1.5 bg-slate-100 hover:bg-rose-100 text-slate-400 hover:text-rose-600 rounded-lg transition-colors cursor-pointer"
 title="Huy boc khoi xe"
 >
 <Trash2 size={14} />
 </button>
 )}
 </div>
 );
 })}
 </div>
 );
 })()}
 </div>
 </div>

 {/* Cột bên phải: Ảnh phương tiện & hàng hóa (1 phần 3) */}
 {!isGuest && (
 <div className="space-y-6">

 <div className="bg-white border border-slate-100 rounded-xl p-6 shadow-xs space-y-4">
 <div>
 <h3 className="text-base font-black uppercase tracking-tight text-slate-800">Ảnh Phương Tiện, Chằng Buộc</h3>
 <p className="text-xs text-slate-400 font-bold">Chụp toàn cảnh xe tải, container chứa hàng, chằng buộc hàng hóa để giám sát</p>
 </div>

 <MultiImageUploader
 images={currentPkl.overallImages || []}
 onChange={handleOverallImagesChange}
 label="Ảnh chụp xe tải và dây buộc"
 disabled={currentPkl.status === 'closed'}
 />
 </div>
 </div>
 )}
  </div>

  {/* QR Scanner Modal (Bốc hàng) */}
 {isQrScannerOpen && (
 <ScannerModal
 onClose={() => setIsQrScannerOpen(false)}
 onScan={handleQRScan}
 projectEntries={projectEntries}
 />
 )}



 {/* Verify Loading Modal (Yêu cầu ít nhất 1 ảnh xác minh) */}
 {isVerifyModalOpen && selectedItemToVerify && (
 <div className="fixed inset-0 z-100 overflow-y-auto bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
 <div className="bg-white border border-slate-100 rounded-xl shadow-xl w-full max-w-xl overflow-hidden flex flex-col">
 <div className="px-6 py-4 border-b border-slate-200 bg-slate-100 flex justify-between items-center">
 <div className="flex items-center gap-2">
 <span className="text-base">📦</span>
 <div>
 <h3 className="text-sm font-black text-slate-800 uppercase tracking-tight">Xác Nhận Xếp Kiện Lên Xe</h3>
 <p className="text-xs text-slate-400 font-bold">Xác minh tình trạng của kiện {selectedItemToVerify.item.name} khi xếp hàng</p>
 </div>
 </div>
 <button
 onClick={() => setIsVerifyModalOpen(false)}
 className="text-slate-400 hover:text-slate-600 cursor-pointer"
 >
 <Plus size={20} className="rotate-45" />
 </button>
 </div>

 <div className="p-6 space-y-6">
 <div className="p-3.5 bg-blue-100 text-blue-700 border border-blue-100 rounded-lg text-xs flex gap-2">
 <Info className="w-5 h-5 shrink-0" />
 <div>
 <span className="font-bold">Hình ảnh xác minh (không bắt buộc):</span> Bạn có thể chụp ảnh hiện trạng kiện gỗ nếu muốn giám sát, hoặc bỏ qua để xếp lên xe ngay.
 </div>
 </div>

 <div className="space-y-1.5">
 <span className="text-xs font-bold text-slate-400">Kiện gỗ:</span>
 <div className="text-sm font-black text-slate-900">
 {selectedItemToVerify.item.name} ({selectedItemToVerify.item.cluster || 'No cluster'})
 </div>
 </div>

 {/* Multi image uploader for verification */}
 <MultiImageUploader
 images={verificationImages}
 onChange={setVerificationImages}
 maxImages={5}
 label="Chụp ảnh xác minh kiện gỗ dập"
 />
 </div>

 {/* Footer */}
 <div className="px-6 py-4 border-t border-slate-100 bg-slate-100 flex items-center justify-end gap-3">
 <button
 onClick={() => setIsVerifyModalOpen(false)}
 className="px-4 py-2 bg-white border border-slate-200 rounded-lg text-xs font-bold text-slate-700 hover:bg-slate-100 transition cursor-pointer"
 >
 HỦY BỎ
 </button>

 <button
 onClick={handleConfirmLoadToVehicle}
 disabled={isSavingLoading}
 className="px-4 py-2 rounded-lg text-xs font-black uppercase tracking-wider text-white shadow transition flex items-center gap-1.5 cursor-pointer bg-indigo-600 hover:bg-indigo-700 active:scale-95 disabled:opacity-100"
 >
 {isSavingLoading ? (
 <>
 <Loader2 className="w-3.5 h-3.5 animate-spin" />
 ĐANG XẾP HÀNG...
 </>
 ) : (
 <>
 <CheckCircle size={15} />
 XÁC NHẬN LÊN XE
 </>
 )}
 </button>
 </div>
 </div>
 </div>
 )}

 {/* Bulk Load Modal - Xếp hàng loạt nhiều kiện cùng tên */}
 {isBulkLoadModalOpen && bulkItemsToLoad.length > 0 && (
 <div className="fixed inset-0 z-100 overflow-y-auto bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
 <div className="bg-white border border-slate-100 rounded-xl shadow-xl w-full max-w-xl max-h-[85vh] overflow-hidden flex flex-col">
 <div className="px-6 py-4 border-b border-slate-100 bg-indigo-100 flex justify-between items-center">
 <div className="flex items-center gap-2">
 <CheckCircle size={20} className="text-indigo-600" />
 <div>
 <h3 className="text-sm font-black text-slate-800 uppercase tracking-tight">
 Xếp Hàng Loạt {bulkItemsToLoad.length} Kiện
 </h3>
 <p className="text-xs text-slate-400 font-bold">
 Tất cả kiện "{bulkItemsToLoad[0].item.name}" đã đóng gói sẽ được xếp lên xe
 </p>
 </div>
 </div>
 <button
 onClick={() => { setIsBulkLoadModalOpen(false); setBulkItemsToLoad([]); setBulkVerificationImages([]); }}
 className="text-slate-400 hover:text-slate-600 cursor-pointer"
 >
 <Plus size={20} className="rotate-45" />
 </button>
 </div>

 <div className="p-6 space-y-4 overflow-y-auto flex-1">
 <div className="p-3 bg-indigo-100 text-indigo-700 border border-indigo-100 rounded-lg text-xs flex gap-2">
 <Info className="w-5 h-5 shrink-0" />
 <span className="font-bold">
 Phát hiện {bulkItemsToLoad.length} kiện cùng tên từ bên đóng gói. Tất cả kiện đã đóng gói và chưa lên xe sẽ được xếp cùng lúc.
 </span>
 </div>

 <div className="space-y-2 max-h-[200px] overflow-y-auto">
 {bulkItemsToLoad.map((entry) => (
 <div key={entry.item.id} className="p-3 bg-slate-100 rounded-lg border border-slate-100 flex items-center justify-between">
 <div>
 <p className="text-sm font-black text-slate-800">{entry.item.name}</p>
 <p className="text-[10px] text-slate-400 font-bold mt-0.5">
 Cụm: {entry.item.cluster || 'N/A'}
 {entry.item.weight ? ` | Trọng lượng: ${entry.item.weight}kg` : ''}
 </p>
 </div>
 <span className="px-2 py-0.5 text-[9px] font-black uppercase bg-emerald-100 text-emerald-700 rounded-lg border border-emerald-100">
 SẴN SÀNG
 </span>
 </div>
 ))}
 </div>

 <div className="pt-2">
 <span className="text-xs font-bold text-slate-400 block mb-1.5">Ảnh xác minh (tối thiểu 1 ảnh):</span>
 <MultiImageUploader
 images={bulkVerificationImages}
 onChange={setBulkVerificationImages}
 maxImages={5}
 label="Chụp ảnh xác minh kiện gỗ"
 />
 </div>
 </div>

 <div className="px-6 py-4 border-t border-slate-100 bg-slate-100 flex items-center justify-between">
 <span className="text-xs font-bold text-slate-400">
 Tổng: {bulkItemsToLoad.length} kiện
 </span>
 <div className="flex items-center gap-3">
 <button
 onClick={() => { setIsBulkLoadModalOpen(false); setBulkItemsToLoad([]); setBulkVerificationImages([]); }}
 className="px-4 py-2 bg-white border border-slate-200 rounded-lg text-xs font-bold text-slate-700 hover:bg-slate-100 transition cursor-pointer"
 >
 HỦY BỎ
 </button>
 <button
 onClick={handleBulkConfirmLoad}
 disabled={isSavingLoading || bulkVerificationImages.length === 0}
 className={`px-4 py-2 rounded-lg text-xs font-black uppercase tracking-wider text-white shadow transition flex items-center gap-1.5 cursor-pointer ${bulkVerificationImages.length === 0 ? 'bg-indigo-300 cursor-not-allowed' : 'bg-indigo-600 hover:bg-indigo-700 active:scale-95'
 }`}
 >
 {isSavingLoading ? (
 <>
 <Loader2 className="w-3.5 h-3.5 animate-spin" />
 ĐANG XẾP {bulkItemsToLoad.length} KIỆN...
 </>
 ) : (
 <>
 <CheckCircle size={15} />
 XẾP TẤT CẢ {bulkItemsToLoad.length} KIỆN LÊN XE
 </>
 )}
 </button>
 </div>
 </div>
 </div>
 </div>
 )}

 {showLoadingExcelEditor && (
 <LoadingExcelEditorModal
 pkl={currentPkl}
 allPackingItems={allPackingItems}
 projectEntries={projectEntries}
 onClose={() => setShowLoadingExcelEditor(false)}
 />
 )}

 {/* Modal Chỉnh Sửa PKL */}
 {isEditModalOpen && (
 <div className="fixed inset-0 z-100 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
 <div className="bg-white border border-slate-100 rounded-xl shadow-2xl w-full max-w-md overflow-hidden flex flex-col font-sans">
 <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
 <h3 className="text-sm font-black text-slate-900 uppercase tracking-tight">Sửa Thông Tin Phiếu Lên Hàng</h3>
 <button
 onClick={() => setIsEditModalOpen(false)}
 className="text-slate-400 hover:text-rose-500 cursor-pointer"
 >
 <Plus size={20} className="rotate-45" />
 </button>
 </div>

 <div className="p-6 space-y-4 overflow-y-auto max-h-[70vh]">
 <div className="space-y-1.5">
 <label className="text-[10px] font-black uppercase text-slate-400 tracking-wider block">Mã PKL</label>
 <input
 type="text"
 value={currentPkl.pklCode}
 disabled
 className="w-full border border-slate-200 bg-slate-100 rounded-lg px-3.5 py-2.5 text-sm font-bold cursor-not-allowed uppercase"
 />
 </div>

 <div className="space-y-1.5">
 <label className="text-[10px] font-black uppercase text-slate-400 tracking-wider">Tên Đợt Hàng</label>
 <input
 type="text"
 placeholder="Tên đợt hàng"
 value={editProjectName}
 onChange={(e) => setEditProjectName(e.target.value)}
 className="w-full border border-slate-200 rounded-lg px-3.5 py-2.5 text-sm font-bold focus:ring-2 focus:ring-indigo-500 focus:outline-none"
 />
 </div>

 <div className="space-y-1.5">
 <label className="text-[10px] font-black uppercase text-slate-400 tracking-wider">Mã Dự Án Trong Phiếu</label>
 <div className="flex flex-wrap gap-1.5 mb-2">
 {editProjectCodes.map(code => (
 <span key={code} className="inline-flex items-center gap-1 text-[10px] font-black px-2 py-1 bg-indigo-100 text-indigo-700 rounded-lg uppercase tracking-widest">
 {code}
 <button onClick={() => setEditProjectCodes(editProjectCodes.filter(c => c !== code))} className="hover:text-indigo-900 cursor-pointer">
 <Plus size={10} className="rotate-45" />
 </button>
 </span>
 ))}
 {editProjectCodes.length === 0 && (
 <span className="text-[10px] text-slate-300 italic">Chưa có mã dự án</span>
 )}
 </div>
 <div className="flex gap-2">
 <input
 type="text"
 placeholder="Nhập mã dự án"
 value={editProjectCodeInput}
 onChange={(e) => setEditProjectCodeInput(e.target.value)}
 onKeyDown={(e) => {
 if (e.key === 'Enter' && editProjectCodeInput.trim()) {
 if (!editProjectCodes.includes(editProjectCodeInput.trim())) {
 setEditProjectCodes([...editProjectCodes, editProjectCodeInput.trim()]);
 }
 setEditProjectCodeInput('');
 }
 }}
 className="flex-1 border border-slate-200 rounded-lg px-3.5 py-2.5 text-sm font-bold focus:ring-2 focus:ring-indigo-500 focus:outline-none uppercase"
 />
 <button
 type="button"
 onClick={() => {
 if (editProjectCodeInput.trim() && !editProjectCodes.includes(editProjectCodeInput.trim())) {
 setEditProjectCodes([...editProjectCodes, editProjectCodeInput.trim()]);
 setEditProjectCodeInput('');
 }
 }}
 className="px-3 py-2 bg-indigo-100 hover:bg-indigo-200 text-indigo-600 rounded-lg text-xs font-bold cursor-pointer"
 >
 Thêm
 </button>
 </div>
 </div>

 <div className="space-y-1.5">
 <label className="text-[10px] font-black uppercase text-slate-400 tracking-wider">Thông Tin Xe Vận Chuyển</label>
 <input
 type="text"
 placeholder="VD: Xe tải 5T - BKS 29C-123.45"
 value={editVehicleInfo}
 onChange={(e) => setEditVehicleInfo(e.target.value)}
 className="w-full border border-slate-200 rounded-lg px-3.5 py-2.5 text-sm font-bold focus:ring-2 focus:ring-indigo-500 focus:outline-none"
 />
 </div>

 <div className="space-y-1.5">
 <label className="text-[10px] font-black uppercase text-slate-400 tracking-wider">Ghi Chú</label>
 <textarea
 placeholder="VD: Giao hàng đợt 1..."
 value={editNote}
 onChange={(e) => setEditNote(e.target.value)}
 rows={2}
 className="w-full border border-slate-200 rounded-lg px-3.5 py-2.5 text-sm font-medium focus:ring-2 focus:ring-indigo-500 focus:outline-none"
 />
 </div>
 </div>

 <div className="px-6 py-4 bg-slate-100 border-t border-slate-100 flex items-center justify-end gap-3">
 <button
 onClick={() => setIsEditModalOpen(false)}
 className="px-4 py-2 bg-white border border-slate-200 rounded-lg text-xs font-bold text-slate-700 hover:bg-slate-100 cursor-pointer"
 >
 HỦY
 </button>
 <button
 onClick={handleSaveEdit}
 disabled={isSavingLoading}
 className="px-4 py-2 bg-indigo-600 hover:bg-indigo-800 text-white font-black uppercase tracking-wider text-xs rounded-lg shadow active:scale-95 disabled:opacity-100 flex items-center justify-center gap-1 cursor-pointer"
 >
 {isSavingLoading ? <Loader2 size={14} className="animate-spin" /> : 'CẬP NHẬT'}
 </button>
 </div>
 </div>
 </div>
 )}

  {/* Centered Toast for QR Scan */}
 <AnimatePresence>
 {centeredToast.show && (
 <motion.div
 initial={{ opacity: 0, scale: 0.85, y: 0 }}
 animate={{ opacity: 1, scale: 1, y: 0 }}
 exit={{ opacity: 0, scale: 0.85, y: 0 }}
 transition={{ type: 'spring', damping: 20, stiffness: 300 }}
 className="fixed inset-0 z-[200] flex items-center justify-center pointer-events-none"
 >
 <div className="bg-emerald-600 text-white px-8 py-5 rounded-xl shadow-2xl border border-emerald-500 flex items-center gap-3 max-w-sm">
 <CheckCircle size={28} className="shrink-0" />
 <span className="text-sm font-black uppercase tracking-wide leading-snug">{centeredToast.message}</span>
 </div>
 </motion.div>
 )}
 </AnimatePresence>
 </div>
 );
}
