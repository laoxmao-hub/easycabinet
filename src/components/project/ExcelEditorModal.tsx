import React, { useState, useMemo, useEffect } from 'react';
import { X, Save, Search, RefreshCw, Loader2, Info, Plus, Trash2, Check } from 'lucide-react';
import { doc, writeBatch, collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType, cleanUndefinedFields } from '../../lib/firebase';
import { useAuth } from '../../lib/AuthContext';
import { ProjectEntry, convertProjectEntryType, syncModuleInstances, getModuleQcAggregate, getModuleInstances } from '../../types';
import { batchDeleteProjectModules, batchUpdateProjectModules, addProjectModule, findProjectConfigId, setProjectEntriesCache } from '../../lib/dualWrite';
import { getEntryType } from '../../screens/ProjectManagementScreen';

interface ExcelEditorModalProps {
 projectCode: string | null;
 projectName: string;
 projectEntries: ProjectEntry[];
 onClose: () => void;
 setProjectEntries?: React.Dispatch<React.SetStateAction<ProjectEntry[]>>;
}

const CLASSIFICATIONS = ['Thùng', 'Cánh', 'Đợt', 'Mặt HK', 'CTHT', 'Gia công ngoài'] as const;

const getEntryTypeLocal = (moduleCode: string, entry?: any): 'Thùng' | 'Cánh' | 'Đợt' | 'Mặt HK' | 'CTHT' | 'Gia công ngoài' => {
 if (entry?.classification) return entry.classification;
 const code = (moduleCode || '').toUpperCase();
 if (code.includes('-GCN') || code.includes('GIA CONG') || code.includes('GIACONG') || code.includes('OUTSOURCE')) return 'Gia công ngoài';
 if (code.includes('-C') || code.endsWith('C')) return 'Cánh';
 if (code.includes('-D') || code.includes('-DOC') || code.endsWith('D')) return 'Đợt';
 if (code.includes('-MHK') || code.includes('-M') || code.endsWith('M')) return 'Mặt HK';
 if (code.includes('-CTHT') || code.includes('-T') || code.endsWith('T')) return 'CTHT';
 return 'Thùng';
};

const STATUS_OPTIONS = [
 'Chưa nhận',
 'Giao Nhận - Đã nhận',
 'Giao Nhận - Đang giao',
 'Giao Nhận - Chưa có',
 'Giao Nhận - Gửi lại X1',
 'Nguội - Sơn - Làm Nguội',
 'Nguội - Sơn - Đã Sơn',
 'Nguội - Sơn - Đang Defect',
 'Lắp Ráp - Đang Lắp',
 'Lắp Ráp - Dựng Mẫu',
 'Lắp Ráp - Chờ PK',
 'Đóng Gói - Đang Đóng',
 'Đóng Gói - Chờ Lệnh',
 'Giao Xe - Đã Packing',
 'Giao Xe - Chờ Lệnh',
];

export function ExcelEditorModal({ projectCode, projectName, projectEntries, onClose, setProjectEntries }: ExcelEditorModalProps) {
 const { user, userProfile } = useAuth();
 const [loading, setLoading] = useState(false);
 const [searchTerm, setSearchTerm] = useState('');
 const [clusterFilter, setClusterFilter] = useState('');
 const [classFilter, setClassFilter] = useState('');
 const [saveSuccess, setSaveSuccess] = useState(false);

  useEffect(() => {
    if (projectEntries && projectEntries.length > 0) {
      setProjectEntriesCache(projectEntries);
    }
  }, [projectEntries]);

 // Clone current entries to local editable state with robust defaults
 const [gridData, setGridData] = useState<ProjectEntry[]>(() => {
 // Deduplicate by id first (safety net)
 const seen = new Set<string>();
 const deduped = projectEntries.filter(item => {
  if (seen.has(item.id)) return false;
  seen.add(item.id);
  return true;
 });
 const mapped = [...deduped].map(item => ({
 ...item,
 classification: item.classification || getEntryType(item)
 }));

 // Backfill cluster TRƯỚC sort: row trống → kế thừa từ row trước (theo thứ tự DB)
 let lastCluster = '';
 for (const row of mapped) {
 if (row.cluster && row.cluster.trim()) {
 lastCluster = row.cluster.trim();
 } else if (lastCluster) {
 row.cluster = lastCluster;
 }
 }

 const sorted = mapped.sort((a, b) => (a.sortIndex || 0) - (b.sortIndex || 0));
 return sorted;
 });

 // Track unique clusters in current project
 const availableClusters = useMemo(() => {
 const set = new Set<string>();
 projectEntries.forEach(entry => {
 if (entry.cluster && entry.cluster.trim()) {
 set.add(entry.cluster.trim());
 }
 });
 return Array.from(set).sort();
 }, [projectEntries]);

 // Track modified row IDs to optimize Firestore batch saves
 const [dirtyRowIds, setDirtyRowIds] = useState<Set<string>>(new Set());

 const [contextMenu, setContextMenu] = useState<{
 x: number;
 y: number;
 entry: ProjectEntry;
 index: number;
 } | null>(null);

 const [deletedRowIds, setDeletedRowIds] = useState<Set<string>>(new Set());

 // Handle cell edits
 const handleCellChange = (id: string, field: keyof ProjectEntry, value: any) => {
 setGridData(prev => prev.map(item => {
 if (item.id === id) {
 if (field === 'moduleType') {
 return convertProjectEntryType(item, value);
 }
 if (field === 'quantity') {
 const newQty = Number(value) || 1;
 const { instances: updatedInstances, maxLabelIndex } = syncModuleInstances(
 item.instances,
 newQty,
 item.moduleCode || '',
 item
 );
 return {
 ...item,
 quantity: newQty,
 instances: updatedInstances,
 maxLabelIndex: maxLabelIndex
 };
 }
 if (field === 'moduleCode') {
 const newCode = value || '';
 const updatedInstances = (item.instances || []).map(inst => ({
 ...inst,
 id: `${newCode}|${inst.instanceIndex}`,
 instanceId: `${newCode}|${inst.instanceIndex}`
 }));
 return { ...item, moduleCode: newCode, instances: updatedInstances };
 }
 return { ...item, [field]: value };
 }
 return item;
 }));
 setDirtyRowIds(prev => {
 const next = new Set(prev);
 next.add(id);
 return next;
 });
 };

 const buildQcFieldValLocal = (currentFieldVal: any, newStatus: string) => {
 if (newStatus === 'none') {
 return null;
 }
 if (currentFieldVal?.status === newStatus) {
 return {
 ...currentFieldVal,
 viaExcel: true,
 editedViaExcel: true
 };
 }
 const displayLabel = userProfile?.ten_that
 ? `${userProfile.ten_that} (${userProfile.chuc_danh || 'NV'})`
 : (user?.displayName || user?.email || 'Hệ thống (Sửa thủ công)');
 return {
 status: newStatus,
 date: new Date().toISOString(),
 by: displayLabel,
 role: 'QC',
 viaExcel: true,
 editedViaExcel: true,
 issue: currentFieldVal?.issue || '',
 image: currentFieldVal?.image || ''
 };
 };

 const handleQcChange = (id: string, field: 'qcWhite' | 'qcPaint' | 'qcFinish' | 'qcPack', value: any) => {
 setGridData(prev => prev.map(item => {
 if (item.id === id) {
 const updatedVal = buildQcFieldValLocal(item[field], value);

 const history = [...(item.statusHistory || [])];
 const statusLabelMap: Record<string, string> = { none: 'Chưa QC', pending: 'Chờ kiểm', pass: 'PASS', fail: 'FAIL' };
 const stageLabelMap: Record<string, string> = { qcWhite: 'Hàng Trắng', qcPaint: 'Hàng Sơn', qcFinish: 'Hoàn Thiện', qcPack: 'Đóng Gói' };
 const displayLabel = userProfile?.ten_that
 ? `${userProfile.ten_that}`
 : (user?.displayName || user?.email || 'Admin');

 history.push(`Sửa Excel QC ${stageLabelMap[field]} -> ${statusLabelMap[value] || value} (${displayLabel})|${Date.now()}`);

 const currentInstances = getModuleInstances(item);
 const updatedInstances = currentInstances.map(inst => ({
 ...inst,
 [field]: updatedVal ? { ...updatedVal } : null
 }));

 return {
 ...item,
 [field]: updatedVal ? { ...updatedVal } : null,
 instances: updatedInstances,
 statusHistory: history
 };
 }
 return item;
 }));
 setDirtyRowIds(prev => {
 const next = new Set(prev);
 next.add(id);
 return next;
 });
 };

 const handleSTTContextMenu = (e: React.MouseEvent, entry: ProjectEntry, index: number) => {
 e.preventDefault();
 setContextMenu({
 x: e.clientX,
 y: e.clientY,
 entry,
 index
 });
 };

 const handleAddRowOption = (position: 'above' | 'below', index: number) => {
 const referenceRow = filteredRows[index];
 if (!referenceRow) return;

 const actualIndex = gridData.findIndex(item => item.id === referenceRow.id);
 if (actualIndex === -1) return;

 const newId = 'new_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
 const newRow: ProjectEntry = {
 id: newId,
 projectCode: projectCode || '',
 projectName: projectName || '',
 moduleCode: '',
 cluster: referenceRow.cluster || '',
 classification: 'Thùng',
 quantity: 1,
 width: 0,
 depth: 0,
 height: 0,
 pWidth: 0,
 pDepth: 0,
 pHeight: 0,
 drawingUrl: '',
 assemblyDrawingUrl: '',
 glbUrl: '',
 receivedQuantity: 0,
 shippedQuantity: 0,
 material: referenceRow.material || '',
 status: '',
 moduleType: 'normal',
 accessories: [],
 ownerId: user?.uid || '',
 createdAt: new Date(),
 };

 setGridData(prev => {
 const copy = [...prev];
 const insertAtIdx = position === 'above' ? actualIndex : actualIndex + 1;
 copy.splice(insertAtIdx, 0, newRow);
 return copy;
 });

 setDirtyRowIds(prev => {
 const next = new Set(prev);
 next.add(newId);
 return next;
 });

 setContextMenu(null);
 };

 const handleDeleteRowOption = (index: number) => {
 const referenceRow = filteredRows[index];
 if (!referenceRow) return;

 const actualIndex = gridData.findIndex(item => item.id === referenceRow.id);
 if (actualIndex === -1) return;

 const targetRow = gridData[actualIndex];

 if (!targetRow.id.startsWith('new_')) {
 setDeletedRowIds(prev => {
 const next = new Set(prev);
 next.add(targetRow.id);
 return next;
 });
 }

 setGridData(prev => prev.filter(item => item.id !== targetRow.id));

 setDirtyRowIds(prev => {
 const next = new Set(prev);
 next.delete(targetRow.id);
 return next;
 });

 setContextMenu(null);
 };

 // Filtered rows
 const filteredRows = useMemo(() => {
 const term = searchTerm.toLowerCase().trim();
 return gridData.filter(item => {
 // 1. Search term filter
 if (term) {
 const matchesTerm = (
 item.moduleCode.toLowerCase().includes(term) ||
 (item.cluster || '').toLowerCase().includes(term) ||
 (item.material || '').toLowerCase().includes(term)
 );
 if (!matchesTerm) return false;
 }

 // 2. Classification filter
 if (classFilter) {
 if (item.classification !== classFilter) return false;
 }

 // 3. Cluster filter
 if (clusterFilter) {
 if ((item.cluster || '').trim() !== clusterFilter.trim()) return false;
 }

 return true;
 });
 }, [gridData, searchTerm, classFilter, clusterFilter]);

 // Bulk save changes to Firestore
 const handleSave = async () => {
 if (!user || !projectCode) return;
 if (dirtyRowIds.size === 0 && deletedRowIds.size === 0) {
 return;
 }

 setLoading(true);
 setSaveSuccess(false);
 try {
 const updatedModulesList: string[] = [];

 // Xử lý xóa cấu kiện
 if (deletedRowIds.size > 0) {
 await batchDeleteProjectModules(Array.from(deletedRowIds), projectCode || undefined);
 }

 // Xử lý cập nhật cấu kiện
 const updates: { moduleId: string; data: Record<string, any>; projectCode?: string }[] = [];
 const newModules: { tempId: string; payload: any }[] = [];

 gridData.forEach(item => {
 if (dirtyRowIds.has(item.id)) {
 updatedModulesList.push(item.moduleCode || 'Mới');

 const isNew = item.id.startsWith('new_');

 const payload: any = {
 projectCode: projectCode,
 projectName: projectName,
 moduleCode: item.moduleCode || '',
 cluster: item.cluster || '',
 classification: item.classification || 'Thùng',
 quantity: Number(item.quantity) || 0,
 width: Number(item.width) || 0,
 depth: Number(item.depth) || 0,
 height: Number(item.height) || 0,
 pWidth: Number(item.pWidth) || 0,
 pDepth: Number(item.pDepth) || 0,
 pHeight: Number(item.pHeight) || 0,
 drawingUrl: item.drawingUrl || '',
 assemblyDrawingUrl: item.assemblyDrawingUrl || '',
 glbUrl: item.glbUrl || '',
 receivedQuantity: Number(item.receivedQuantity) || 0,
 shippedQuantity: Number(item.shippedQuantity) || 0,
 material: item.material || '',
 status: item.status || '',
 moduleType: item.moduleType || 'normal',
 instances: item.instances === null ? null : (item.instances || []),
 maxLabelIndex: item.maxLabelIndex !== undefined ? item.maxLabelIndex : null,
 qcWhite: item.qcWhite || null,
 qcPaint: item.qcPaint || null,
 qcFinish: item.qcFinish || null,
 qcPack: item.qcPack || null,
 statusHistory: item.statusHistory || [],
 };

 if (isNew) {
 newModules.push({
 tempId: item.id,
 payload: cleanUndefinedFields({
 ...payload,
 accessories: item.accessories || [],
 createdAt: serverTimestamp(),
 ownerId: user?.uid || '',
 })
 });
 } else {
 updates.push({ moduleId: item.id, data: cleanUndefinedFields(payload), projectCode });
 }
 }
 });

 if (updates.length > 0) {
 await batchUpdateProjectModules(updates);
 }

 // Create new modules
 const tempIdToRealIdMap = new Map<string, string>();
 const savedNewModules: ProjectEntry[] = [];
 
 if (newModules.length > 0 && projectCode) {
 const configId = await findProjectConfigId(projectCode);
 const configIdToUse = configId || projectCode;
 const batch = writeBatch(db);
 
 newModules.forEach(({ tempId, payload }) => {
 const moduleRef = doc(collection(db, 'projectConfigs', configIdToUse, 'modules'));
 const docId = moduleRef.id;
 
 const newEntry = {
 ...payload,
 id: docId,
 configId: configIdToUse,
 createdAt: new Date(),
 } as ProjectEntry;

 const { id, ...firestorePayload } = newEntry;
 batch.set(moduleRef, firestorePayload);
 savedNewModules.push(newEntry);
 tempIdToRealIdMap.set(tempId, docId);
 });
 await batch.commit();
 }

 // Local grid data after saving
 const nextGridData = gridData
 .filter(item => !deletedRowIds.has(item.id))
 .map(item => {
 if (tempIdToRealIdMap.has(item.id)) {
 return {
 ...item,
 id: tempIdToRealIdMap.get(item.id)!
 };
 }
 return item;
 });

 // Auto-sort: gán sortIndex theo thứ tự alphabet (cluster → moduleCode) của dữ liệu mới
 let sortUpdates: { moduleId: string; data: { sortIndex: number }; projectCode: string }[] = [];
 if (projectCode) {
 const sortedNextGridData = [...nextGridData].sort((a, b) => {
 const ca = (a.cluster || '').localeCompare(b.cluster || '', 'vi', { numeric: true });
 if (ca !== 0) return ca;
 return (a.moduleCode || '').localeCompare(b.moduleCode || '', 'vi', { numeric: true });
 });

 sortUpdates = sortedNextGridData.map((entry, idx) => ({
 moduleId: entry.id,
 data: { sortIndex: idx },
 projectCode
 }));

 if (sortUpdates.length > 0) {
 await batchUpdateProjectModules(sortUpdates);
 }
 }

 // Apply sortIndex updates to the final gridData state
 const finalGridData = nextGridData.map(item => {
 const sortIdxUpdate = sortUpdates.find(s => s.moduleId === item.id);
 return {
 ...item,
 sortIndex: sortIdxUpdate ? sortIdxUpdate.data.sortIndex : item.sortIndex
 };
 });

 // Update local grid data state   // Deduplicate gridData by id (safety net for any race condition)
   const dedupedGrid = finalGridData.filter((item, idx, arr) => arr.findIndex(x => x.id === item.id) === idx);
   setGridData(dedupedGrid);

   // Sync to parent/global state so changes are immediately displayed in the UI without reloading
 if (setProjectEntries) {
 setProjectEntries(prev => {
 // 1. Remove deleted entries
 let updated = prev.filter(e => !deletedRowIds.has(e.id));

 // 2. Map existing entries to their updated versions
 updated = updated.map(e => {
 if (e.projectCode === projectCode) {
 const edited = finalGridData.find(g => g.id === e.id);
 if (edited) {
 return {
 ...e,
 ...edited,
 };
 }
 }
 return e;
 });     // 3. Append newly created entries (skip if already present from step 2)
     const existingIds = new Set(updated.map(e => e.id));
     const newSavedItems = finalGridData.filter(item => {
      const realId = tempIdToRealIdMap.get(item.id) || item.id;
      return !existingIds.has(realId);
     });

     if (newSavedItems.length > 0) {
      updated.push(...newSavedItems);
     }

 // 4. Update the global dual-write cache as well
 setProjectEntriesCache(updated);

 return updated;
 });
 }

 // Log activity
 const displayLabel = userProfile?.ten_that
 ? `${userProfile.ten_that} (${userProfile.chuc_danh || 'NV'})`
 : (user?.displayName || 'Anonymous');

 let actionDesc = '';
 if (dirtyRowIds.size > 0 && deletedRowIds.size > 0) {
 actionDesc = `Chỉnh sửa Excel (${dirtyRowIds.size} dòng) và xóa ${deletedRowIds.size} dòng trong dự án ${projectCode}`;
 } else if (dirtyRowIds.size > 0) {
 actionDesc = `Chỉnh sửa Excel (${dirtyRowIds.size} dòng) trong dự án ${projectCode}`;
 } else {
 actionDesc = `Xóa ${deletedRowIds.size} dòng trong dự án ${projectCode}`;
 }

 await addDoc(collection(db, 'activities'), {
 userId: user?.uid,
 userName: displayLabel,
 userEmail: user?.email || '',
 action: 'Chỉnh sửa Excel',
 details: actionDesc,
 projectCode,
 timestamp: serverTimestamp()
 });

 setDirtyRowIds(new Set());
 setDeletedRowIds(new Set());
 setSaveSuccess(true);
 setTimeout(() => setSaveSuccess(false), 4000);
 } catch (error) {
 console.error(error);
 handleFirestoreError(error, OperationType.UPDATE, 'projects/activities');
 } finally {
 setLoading(false);
 }
 };

 return (
 <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[110] p-4 backdrop-blur-sm">
 <div className="bg-white w-[96vw] h-[92vh] rounded-lg border border-slate-200 flex flex-col overflow-hidden shadow-2xl">

 {/* Header toolbar */}
 <div className="px-6 py-4 border-b border-slate-100 bg-white flex flex-col sm:flex-row sm:items-center justify-between gap-4">
 <div className="flex flex-col">
 <span className="text-[10px] font-black text-indigo-600 uppercase tracking-widest">
 Giao diện chỉnh sửa nhanh (Dành cho PC)
 </span>
 <h3 className="text-base font-black text-slate-800 uppercase tracking-tight flex items-center gap-2">
 <span>BẢNG EXCEL DỰ ÁN:</span>
 <span className="text-indigo-600 font-mono">{projectCode}</span>
 <span className="text-slate-400 font-normal text-sm">— {projectName}</span>
 </h3>
 </div>

 <div className="flex flex-wrap items-center gap-3">
  {saveSuccess && (
  <div className="px-3 py-2 bg-emerald-100 border border-emerald-200 text-emerald-800 text-[11px] font-bold rounded-lg flex items-center gap-1.5 animate-pulse">
  <Check size={14} className="text-emerald-600 shrink-0" />
  <span>Lưu thành công & Đồng bộ dữ liệu!</span>
  </div>
  )}
 {/* Close Button */}
 <button
 onClick={onClose}
 className="px-4 py-2 bg-slate-100 hover:bg-slate-100 text-slate-600 rounded-lg text-[11px] font-black uppercase tracking-widest border border-slate-200 transition-all cursor-pointer"
 >
 Đóng
 </button>

 {/* Save Button */}
 <button
 disabled={loading || (dirtyRowIds.size === 0 && deletedRowIds.size === 0)}
 onClick={handleSave}
 className="px-5 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:bg-emerald-600/50 text-white rounded-lg text-[11px] font-black uppercase tracking-widest transition-all shadow-lg flex items-center justify-center space-x-2 cursor-pointer"
 >
 {loading ? (
 <Loader2 size={13} className="animate-spin" />
 ) : (
 <Save size={13} />
 )}
 <span>Lưu thay đổi ({dirtyRowIds.size + deletedRowIds.size})</span>
 </button>
 </div>
 </div>

 {/* Info bar */}
 <div className="px-6 py-2 bg-slate-100 border-b border-slate-100 flex items-center justify-between text-[11px] text-slate-500 font-medium font-sans">
 <div className="flex items-center gap-1.5 overflow-hidden">
 <Info size={14} className="text-indigo-500 shrink-0" />
 <span className="truncate">Chỉnh sửa trực tiếp vào các ô bên dưới. Click chuột phải cột STT để thêm/xóa dòng. Cập nhật được lưu đồng loạt khi nhấn nút lưu.</span>
 </div>
 <div className="shrink-0 flex items-center gap-4">
 <span>Hiển thị: <strong className="text-indigo-600 font-black">{filteredRows.length}/{gridData.length}</strong> dòng</span>
 <span className="text-amber-600 font-bold">Đã sửa: {dirtyRowIds.size} dòng</span>
 {deletedRowIds.size > 0 && <span className="text-rose-600 font-bold">Đã xóa: {deletedRowIds.size} dòng</span>}
 </div>
 </div>

 {/* Spreadsheets Body */}
 <div className="flex-1 min-h-0 bg-slate-100 p-4 flex flex-col">
 <div className="flex-1 min-h-0 w-full bg-white border border-slate-200 rounded-lg shadow-sm flex flex-col overflow-hidden">
 <div className="flex-1 overflow-auto">
 <table className="w-full border-collapse table-fixed min-w-[1500px]">
 <thead>
 {/* Hàng bộ lọc trực quan nằm ngay trên tên các cột tương ứng */}
 <tr className="bg-slate-100 border-b border-slate-200">
 <td className="sticky top-0 left-0 z-40 w-12 text-center border-r border-slate-200 py-1.5 bg-slate-100">
 <span className="text-[9px] font-black tracking-widest text-slate-400 uppercase">LỌC</span>
 </td>
 <td className="sticky top-0 left-12 z-40 w-[300px] p-1 border-r border-slate-200 bg-slate-100 shadow-[2px_0_5px_rgba(0,0,0,0.05)]">
 <div className="relative w-full">
 <span className="absolute inset-y-0 left-0 flex items-center pl-2.5 text-slate-400 pointer-events-none">
 <Search size={11} />
 </span>
 <input
 type="text"
 className="w-full pl-6 pr-2 py-0.5 text-[11px] bg-white border border-slate-200 rounded-lg outline-none focus:border-indigo-500 font-medium h-7"
 placeholder="Tìm mã / vật liệu..."
 value={searchTerm}
 onChange={e => setSearchTerm(e.target.value)}
 />
 </div>
 </td>
 <td className="sticky top-0 z-30 w-32 p-1 border-r border-slate-200 bg-slate-100">
 <select
 value={classFilter}
 onChange={e => setClassFilter(e.target.value)}
 className="w-full px-1.5 py-0.5 text-[11px] bg-white border border-slate-200 rounded-lg outline-none focus:border-indigo-500 font-black uppercase tracking-tight cursor-pointer h-7"
 >
 <option value="">TẤT CẢ PHÂN LOẠI</option>
 {CLASSIFICATIONS.map(opt => (
 <option key={opt} value={opt}>{opt.toUpperCase()}</option>
 ))}
 </select>
 </td>
 {/* Ô trống cho cột Kiểu để bộ lọc căn chỉnh chính xác */}
 <td className="sticky top-0 z-30 w-24 p-1 border-r border-slate-200 bg-slate-100"></td>
 <td className="sticky top-0 z-30 w-44 p-1 border-r border-slate-200 bg-slate-100">
 <select
 value={clusterFilter}
 onChange={e => setClusterFilter(e.target.value)}
 className="w-full px-1.5 py-0.5 text-[11px] bg-white border border-slate-200 rounded-lg outline-none focus:border-indigo-500 font-black uppercase tracking-tight cursor-pointer h-7"
 >
 <option value="">TẤT CẢ CỤM</option>
 {availableClusters.map(opt => (
 <option key={opt} value={opt}>{opt.toUpperCase()}</option>
 ))}
 </select>
 </td>
 <td colSpan={9} className="sticky top-0 z-30 bg-slate-100 border-b border-slate-200"></td>
 </tr>

 <tr className="bg-slate-100 text-slate-500 text-[10px] font-black uppercase tracking-wider border-b border-slate-200 font-sans">
 <th className="sticky top-[38px] left-0 z-40 w-12 text-center border-r border-slate-300 py-2 select-none bg-slate-100" title="Click chuột phải vào ô STT của dòng để Thêm hoặc Xóa dòng">STT</th>
 <th className="sticky top-[38px] left-12 z-40 w-[300px] text-left pl-3 border-r border-slate-300 bg-slate-100 shadow-[2px_0_5px_rgba(0,0,0,0.05)]">Mã Module</th>
 <th className="sticky top-[38px] z-30 w-32 text-left pl-3 border-r border-slate-300 bg-slate-100">Phân Loại</th>
 <th className="sticky top-[38px] z-30 w-24 text-left pl-3 border-r border-slate-300 bg-slate-100 justify-center">Kiểu</th>
 <th className="sticky top-[38px] z-30 w-44 text-left pl-3 border-r border-slate-300 bg-slate-100">Cụm</th>
 <th className="sticky top-[38px] z-30 w-16 text-center border-r border-slate-300 bg-slate-100">SL</th>
 <th className="sticky top-[38px] z-30 w-24 text-center border-r border-slate-300 bg-slate-100">Đã Nhận</th>
 <th className="sticky top-[38px] z-30 w-24 text-right pr-3 border-r border-slate-300 bg-slate-100">Dài/Rộng</th>
 <th className="sticky top-[38px] z-30 w-24 text-right pr-3 border-r border-slate-300 bg-slate-100">Rộng/Sâu</th>
 <th className="sticky top-[38px] z-30 w-24 text-right pr-3 border-r border-slate-300 bg-slate-100">Dày/Cao</th>
 <th className="sticky top-[38px] z-30 w-32 text-center border-r border-slate-300 bg-slate-100">QC Trắng</th>
 <th className="sticky top-[38px] z-30 w-32 text-center border-r border-slate-300 bg-slate-100">QC Sơn</th>
 <th className="sticky top-[38px] z-30 w-32 text-center border-r border-slate-300 bg-slate-100">QC H.Thiện</th>
 <th className="sticky top-[38px] z-30 w-32 text-center bg-slate-100">QC Đóng Gói</th>
 </tr>
 </thead>
 <tbody className="divide-y divide-slate-200 text-xs font-medium">
 {filteredRows.map((entry, idx) => {
 const isDirty = dirtyRowIds.has(entry.id);
 const isThung = (entry.classification || 'Thùng') === 'Thùng';
 const isContextMenuActive = contextMenu && contextMenu.entry.id === entry.id;
 return (
 <tr
 key={entry.id}
 className={`group/tr hover:bg-slate-100/80 transition-colors ${isDirty ? 'bg-amber-100/40' : ''
 } ${isContextMenuActive ? 'bg-indigo-100/70 border-y-indigo-300' : ''
 }`}
 >
 {/* STT */}
 <td
 onContextMenu={(e) => handleSTTContextMenu(e, entry, idx)}
 className={`sticky left-0 z-20 w-12 text-center py-1.5 border-r border-slate-200 font-mono text-[10px] cursor-context-menu select-none font-bold transition-all ${isContextMenuActive
 ? 'bg-indigo-600 text-white'
 : isDirty
 ? 'bg-amber-100 text-amber-900'
 : 'bg-white text-slate-400 group-hover/tr:bg-slate-105'
 }`}
 title="Click chuột phải để Thêm hoặc Xóa dòng dữ liệu này"
 >
 {idx + 1}
 </td>

 {/* Mã Module */}
 <td className={`sticky left-12 z-20 w-[300px] border-r border-slate-200 p-1 shadow-[2px_0_5px_rgba(0,0,0,0.05)] transition-all ${isContextMenuActive
 ? 'bg-indigo-100'
 : isDirty
 ? 'bg-amber-100/90'
 : 'bg-white group-hover/tr:bg-slate-100/80'
 }`}>
 <input
 type="text"
 value={entry.moduleCode}
 onChange={e => handleCellChange(entry.id, 'moduleCode', e.target.value)}
 className="w-full px-2 py-1 bg-transparent border border-transparent hover:border-slate-200 focus:border-indigo-500 focus:bg-white outline-none rounded-lg transition-all text-slate-900 uppercase font-bold tracking-tight"
 />
 </td>

 {/* Phân loại */}
 <td className="border-r border-slate-200 p-1">
 <select
 value={entry.classification || 'Thùng'}
 onChange={e => handleCellChange(entry.id, 'classification', e.target.value)}
 className="w-full px-1.5 py-1 bg-transparent border border-transparent hover:border-slate-200 focus:border-indigo-500 focus:bg-white outline-none rounded-lg transition-all font-black text-indigo-700 uppercase tracking-tight"
 >
 {CLASSIFICATIONS.map(opt => (
 <option key={opt} value={opt} className="bg-white text-slate-800">{opt}</option>
 ))}
 </select>
 </td>

 {/* Kiểu */}
 <td className="border-r border-slate-200 p-1">
 <select
 value={entry.moduleType || 'normal'}
 onChange={e => handleCellChange(entry.id, 'moduleType', e.target.value)}
 className="w-full px-1.5 py-1 bg-transparent border border-transparent hover:border-slate-200 focus:border-indigo-500 focus:bg-white outline-none rounded-lg transition-all font-semibold uppercase tracking-tight text-slate-700"
 >
 <option value="normal" className="bg-white text-slate-800">Thường</option>
 <option value="bo" className="bg-white text-slate-800">Bộ</option>
 </select>
 </td>

 {/* Cụm */}
 <td className="border-r border-slate-200 p-1">
 <input
 type="text"
 value={entry.cluster || ''}
 list={`clusters-list-${entry.id}`}
 onChange={e => handleCellChange(entry.id, 'cluster', e.target.value)}
 className="w-full px-2 py-1 bg-transparent border border-transparent hover:border-slate-200 focus:border-indigo-500 focus:bg-white outline-none rounded-lg transition-all font-semibold text-slate-900"
 placeholder="Chọn/Nhập cụm..."
 />
 <datalist id={`clusters-list-${entry.id}`}>
 {Array.from(new Set([...availableClusters].map(c => c.trim())))
 .filter(Boolean)
 .map(opt => (
 <option key={opt} value={opt} />
 ))}
 </datalist>
 </td>

 {/* Số lượng */}
 <td className="border-r border-slate-200 p-1">
 <input
 type="number"
 value={entry.quantity}
 onChange={e => handleCellChange(entry.id, 'quantity', Number(e.target.value))}
 className="[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none w-full px-2 py-1 bg-transparent border border-transparent hover:border-slate-200 focus:border-indigo-500 focus:bg-white outline-none rounded-lg transition-all text-center font-bold text-slate-900"
 />
 </td>

 {/* Đã Nhận */}
 <td className="border-r border-slate-200 p-1">
 <input
 type="number"
 value={entry.receivedQuantity || 0}
 onChange={e => handleCellChange(entry.id, 'receivedQuantity', Number(e.target.value))}
 className="[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none w-full px-2 py-1 bg-transparent border border-transparent hover:border-slate-200 focus:border-indigo-500 focus:bg-white outline-none rounded-lg transition-all text-center font-bold text-slate-700 lg:text-xs"
 />
 </td>

 {/* Dài/Rộng */}
 <td className="border-r border-slate-200 p-1">
 <div className="flex items-center">
 <input
 type="number"
 value={entry.width || 0}
 onChange={e => handleCellChange(entry.id, 'width', Number(e.target.value))}
 className="[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none w-full px-2 py-1 bg-transparent border border-transparent hover:border-slate-200 focus:border-indigo-500 focus:bg-white outline-none rounded-lg transition-all text-right font-mono text-slate-800"
 />
 <span className="text-[9px] text-slate-400 pr-1 select-none">mm</span>
 </div>
 </td>

 {/* Rộng/Sâu */}
 <td className="border-r border-slate-200 p-1">
 <div className="flex items-center">
 <input
 type="number"
 value={entry.depth || 0}
 onChange={e => handleCellChange(entry.id, 'depth', Number(e.target.value))}
 className="[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none w-full px-2 py-1 bg-transparent border border-transparent hover:border-slate-200 focus:border-indigo-500 focus:bg-white outline-none rounded-lg transition-all text-right font-mono text-slate-800"
 />
 <span className="text-[9px] text-slate-400 pr-1 select-none">mm</span>
 </div>
 </td>

 {/* Dày/Cao */}
 <td className="border-r border-slate-200 p-1">
 <div className="flex items-center">
 <input
 type="number"
 value={entry.height || 0}
 onChange={e => handleCellChange(entry.id, 'height', Number(e.target.value))}
 className="[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none w-full px-2 py-1 bg-transparent border border-transparent hover:border-slate-200 focus:border-indigo-500 focus:bg-white outline-none rounded-lg transition-all text-right font-mono text-slate-800"
 />
 <span className="text-[9px] text-slate-400 pr-1 select-none">mm</span>
 </div>
 </td>

 {/* QC Trắng */}
 <td className="border-r border-slate-200 p-1">
 <select
 value={getModuleQcAggregate(entry, 'white')?.status || 'none'}
 onChange={e => handleQcChange(entry.id, 'qcWhite', e.target.value)}
 className={`w-full px-2 py-1 bg-transparent border border-transparent hover:border-slate-200 outline-none rounded-lg transition-all uppercase font-bold text-[11px] text-center ${(getModuleQcAggregate(entry, 'white')?.status || 'none') === 'pass'
 ? 'text-emerald-700 font-extrabold bg-emerald-100'
 : (getModuleQcAggregate(entry, 'white')?.status || 'none') === 'fail'
 ? 'text-rose-700 font-extrabold bg-rose-100'
 : (getModuleQcAggregate(entry, 'white')?.status || 'none') === 'pending'
 ? 'text-amber-600 font-bold bg-amber-100'
 : 'text-slate-400 font-medium'
 }`}
 >
 <option value="none" className="bg-white text-slate-800">— CHƯA QC —</option>
 <option value="pending" className="bg-white text-amber-600">CHỜ KIỂM</option>
 <option value="pass" className="bg-white text-emerald-600 font-bold">ĐẠT (PASS)</option>
 <option value="fail" className="bg-white text-rose-600 font-bold">LỖI (FAIL)</option>
 </select>
 </td>

 {/* QC Sơn */}
 <td className="border-r border-slate-200 p-1">
 <select
 value={getModuleQcAggregate(entry, 'paint')?.status || 'none'}
 onChange={e => handleQcChange(entry.id, 'qcPaint', e.target.value)}
 className={`w-full px-2 py-1 bg-transparent border border-transparent hover:border-slate-200 outline-none rounded-lg transition-all uppercase font-bold text-[11px] text-center ${(getModuleQcAggregate(entry, 'paint')?.status || 'none') === 'pass'
 ? 'text-emerald-700 font-extrabold bg-emerald-100'
 : (getModuleQcAggregate(entry, 'paint')?.status || 'none') === 'fail'
 ? 'text-rose-700 font-extrabold bg-rose-100'
 : (getModuleQcAggregate(entry, 'paint')?.status || 'none') === 'pending'
 ? 'text-amber-600 font-bold bg-amber-100'
 : 'text-slate-400 font-medium'
 }`}
 >
 <option value="none" className="bg-white text-slate-800">— CHƯA QC —</option>
 <option value="pending" className="bg-white text-amber-600">CHỜ KIỂM</option>
 <option value="pass" className="bg-white text-emerald-600 font-bold">ĐẠT (PASS)</option>
 <option value="fail" className="bg-white text-rose-600 font-bold">LỖI (FAIL)</option>
 </select>
 </td>

 {/* QC Hoàn Thiện */}
 <td className="border-r border-slate-200 p-1">
 <select
 value={getModuleQcAggregate(entry, 'finish')?.status || 'none'}
 onChange={e => handleQcChange(entry.id, 'qcFinish', e.target.value)}
 className={`w-full px-2 py-1 bg-transparent border border-transparent hover:border-slate-200 outline-none rounded-lg transition-all uppercase font-bold text-[11px] text-center ${(getModuleQcAggregate(entry, 'finish')?.status || 'none') === 'pass'
 ? 'text-emerald-700 font-extrabold bg-emerald-100'
 : (getModuleQcAggregate(entry, 'finish')?.status || 'none') === 'fail'
 ? 'text-rose-700 font-extrabold bg-rose-100'
 : (getModuleQcAggregate(entry, 'finish')?.status || 'none') === 'pending'
 ? 'text-amber-600 font-bold bg-amber-100'
 : 'text-slate-400 font-medium'
 }`}
 >
 <option value="none" className="bg-white text-slate-800">— CHƯA QC —</option>
 <option value="pending" className="bg-white text-amber-600">CHỜ KIỂM</option>
 <option value="pass" className="bg-white text-emerald-600 font-bold">ĐẠT (PASS)</option>
 <option value="fail" className="bg-white text-rose-600 font-bold">LỖI (FAIL)</option>
 </select>
 </td>

 {/* QC Đóng Gói */}
 <td className="p-1">
 <select
 value={getModuleQcAggregate(entry, 'pack')?.status || 'none'}
 onChange={e => handleQcChange(entry.id, 'qcPack', e.target.value)}
 className={`w-full px-2 py-1 bg-transparent border border-transparent hover:border-slate-200 outline-none rounded-lg transition-all uppercase font-bold text-[11px] text-center ${(getModuleQcAggregate(entry, 'pack')?.status || 'none') === 'pass'
 ? 'text-emerald-700 font-extrabold bg-emerald-100'
 : (getModuleQcAggregate(entry, 'pack')?.status || 'none') === 'fail'
 ? 'text-rose-700 font-extrabold bg-rose-100'
 : (getModuleQcAggregate(entry, 'pack')?.status || 'none') === 'pending'
 ? 'text-amber-600 font-bold bg-amber-100'
 : 'text-slate-400 font-medium'
 }`}
 >
 <option value="none" className="bg-white text-slate-800">— CHƯA QC —</option>
 <option value="pending" className="bg-white text-amber-600">CHỜ KIỂM</option>
 <option value="pass" className="bg-white text-emerald-600 font-bold">ĐẠT (PASS)</option>
 <option value="fail" className="bg-white text-rose-600 font-bold">LỖI (FAIL)</option>
 </select>
 </td>
 </tr>
 );
 })}
 </tbody>
 </table>
 </div>
 </div>
 </div>

 </div>

 {contextMenu && (
 <>
 {/* Backdrop layer to click outside to close */}
 <div
 className="fixed inset-0 z-[115]"
 onClick={() => setContextMenu(null)}
 onContextMenu={(e) => {
 e.preventDefault();
 setContextMenu(null);
 }}
 />

 {/* Context Menu list */}
 <div
 className="fixed bg-white border border-slate-200 rounded-lg shadow-xl z-[120] py-1.5 w-52 text-[10px] font-black uppercase tracking-wider text-slate-700 select-none animate-in fade-in duration-100"
 style={{
 top: contextMenu.y,
 left: contextMenu.x
 }}
 >
 <div className="px-3 py-1 text-[9px] font-bold text-slate-400 border-b border-slate-100 pb-1.5 mb-1 tracking-widest text-center truncate">
 {contextMenu.entry.moduleCode ? `Cấu kiện: ${contextMenu.entry.moduleCode}` : `Dòng mới (STT: ${contextMenu.index + 1})`}
 </div>

 <button
 type="button"
 onClick={() => handleAddRowOption('above', contextMenu.index)}
 className="w-full text-left px-3.5 py-2 hover:bg-indigo-100 hover:text-indigo-600 flex items-center gap-2 cursor-pointer transition-colors"
 >
 <Plus size={12} className="text-emerald-500" />
 <span>Chèn phía trên dòng #{contextMenu.index + 1}</span>
 </button>

 <button
 type="button"
 onClick={() => handleAddRowOption('below', contextMenu.index)}
 className="w-full text-left px-3.5 py-2 hover:bg-indigo-100 hover:text-indigo-600 flex items-center gap-2 cursor-pointer transition-colors"
 >
 <Plus size={12} className="text-emerald-500" />
 <span>Chèn phía dưới dòng #{contextMenu.index + 1}</span>
 </button>

 <div className="border-t border-slate-100 my-1"></div>

 <button
 type="button"
 onClick={() => handleDeleteRowOption(contextMenu.index)}
 className="w-full text-left px-3.5 py-2 hover:bg-rose-100 hover:text-rose-600 flex items-center gap-2 cursor-pointer transition-colors"
 >
 <Trash2 size={12} className="text-rose-500" />
 <span>Xóa dòng #{contextMenu.index + 1} này</span>
 </button>
 </div>
 </>
 )}
 </div>
 );
}
