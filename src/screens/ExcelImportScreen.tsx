/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo } from 'react';
import { motion } from 'motion/react';
import { FileSpreadsheet, X, Upload, Table as TableIcon, Loader2, CheckCircle, ArrowLeft, RefreshCw, PlusCircle, Trash2, Plus, Settings, Eye, ChevronDown, ChevronUp, Check, AlertCircle } from 'lucide-react';
import { collection, addDoc, serverTimestamp, writeBatch, doc, setDoc, query, where, getDocs, orderBy, limit, getDoc } from 'firebase/firestore';
import { useAuth } from '../lib/AuthContext';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import * as XLSX from 'xlsx';
import { formatProjectName } from '../lib/formatters';

const makeShelfModuleCode = (parentCode: string): string => {
 const bldgRegex = /^(MED026_BLDG\d|BLDG\d)_(.+)$/i;
 const match = parentCode.match(bldgRegex);
 if (match) {
 return `${match[1]}_Đợt di động_${match[2]}`;
 }
 const firstUnderscore = parentCode.indexOf('_');
 if (firstUnderscore !== -1) {
 return parentCode.substring(0, firstUnderscore) + '_Đợt di động' + parentCode.substring(firstUnderscore);
 }
 return `Đợt di động_${parentCode}`;
};

// Bộ lọc tên cấu kiện bỏ qua khi nhập Excel
const SKIP_PATTERNS = ["Nóc_", "Hậu_", "Đáy_", "Chặn cánh_", "Chặn_", "Giằng nóc_", "Hông trái_", "Hông phải_", "Mặt_", "HK mặt", "Hk mặt", "mặt hỗ trợ", "mặt sau", "mặt trước", "mặt fix", "tăng dày", "hậu hk", "hông phải hk", "hông trái hk", "chân tăng", "tay nắm", "mặt hk"];
const shouldSkipPart = (name: string): boolean => {
 const cleanName = name.trim().toLowerCase();
 return SKIP_PATTERNS.some(pattern => cleanName.includes(pattern.toLowerCase()));
};

// Bộ lọc cho chức năng 2 & 3: chỉ nhập Cánh, Cửa, Mặt học kéo, Đợt; loại Chặn
const shouldImportPartV2 = (name: string): boolean => {
 const cleanName = name.trim().toLowerCase();
 if (cleanName.includes('chặn')) return false;
 const ALLOWED = ['cánh', 'cửa', 'mặt học kéo', 'đợt'];
 return ALLOWED.some(keyword => cleanName.includes(keyword));
};

const normalizeAccessoryName = (name: string): string => {
 return (name || '')
 .toLowerCase()
 .replace(/đ/g, 'd')
 .normalize('NFD')
 .replace(/[\u0300-\u036f]/g, '') // Khử dấu tiếng Việt
 .replace(/\s+/g, ' ') // Nén nhiều khoảng trắng thành 1 khoảng trắng duy nhất
 .trim();
};

const findHeaderRow = (sheetData: any[][]): { rowIndex: number; headers: string[] } => {
 const keywords = ['cum', 'cluster', 'module', 'ma', 'ky hieu', 'so luong', 'quantity', 'sl', 'kich thuoc', 'rong', 'sau', 'cao', 'phu kien', 'to'];
 let bestRow = 0;
 let maxScore = 0;
 let bestHeaders: string[] = [];

 for (let i = 0; i < Math.min(sheetData.length, 10); i++) {
 const row = sheetData[i] || [];
 let score = 0;
 const currentHeaders = row.map(cell => cell ? String(cell).trim() : '');
 currentHeaders.forEach(h => {
 const lh = normalizeAccessoryName(h);
 if (keywords.some(k => lh.includes(k))) {
 score++;
 }
 });
 if (score > maxScore) {
 maxScore = score;
 bestRow = i;
 bestHeaders = currentHeaders;
 }
 }

 if (maxScore === 0 && sheetData.length > 0) {
 return { rowIndex: 0, headers: sheetData[0].map(cell => cell ? String(cell).trim() : '') };
 }

 return { rowIndex: bestRow, headers: bestHeaders };
};

const parseDimensions = (text: string): { w: number; d: number; h: number } => {
 if (!text) return { w: 0, d: 0, h: 0 };
 const clean = String(text).replace(/\s/g, '').toLowerCase();
 const regex = /(\d+)(?:x|\*|-|\s)(\d+)(?:x|\*|-|\s)(\d+)/;
 const match = clean.match(regex);
 if (match) {
 return {
 w: Number(match[1]) || 0,
 d: Number(match[2]) || 0,
 h: Number(match[3]) || 0
 };
 }
 return { w: 0, d: 0, h: 0 };
};

const getModuleUniqueKey = (m: any): string => {
  const code = (m.moduleCode || '').trim().toLowerCase();
  const w = Number(m.width) || 0;
  const d = Number(m.depth) || 0;
  const h = Number(m.height) || 0;
  const pw = Number(m.pWidth) || 0;
  const pd = Number(m.pDepth) || 0;
  const ph = Number(m.pHeight) || 0;
  return `${code}|${w}|${d}|${h}|${pw}|${pd}|${ph}`;
};

const getEnrichedHeaders = (rawData: any[][], selectedHeaderIndex: number): string[] => {
 if (!rawData || rawData.length === 0) return [];
 const currentHeaders = (rawData[selectedHeaderIndex] || []).map(x => x ? String(x).trim() : '');
 
 // Dòng phía trên và phía dưới để xử lý merged cells dòng
 const prevHeaders = selectedHeaderIndex > 0 ? (rawData[selectedHeaderIndex - 1] || []).map(x => x ? String(x).trim() : '') : [];
 const nextHeaders = selectedHeaderIndex < rawData.length - 1 ? (rawData[selectedHeaderIndex + 1] || []).map(x => x ? String(x).trim() : '') : [];

 return currentHeaders.map((h, i) => {
 if (h) return h; // Nếu có sẵn giá trị ở dòng được chọn, lấy luôn
 // Nếu rỗng, kiểm tra dòng phía dưới (ví dụ từ tiêu đề gộp PHỤ KIỆN VẬT TƯ PHỤ)
 if (nextHeaders[i]) return nextHeaders[i];
 // Nếu vẫn rỗng, kiểm tra dòng phía trên (ví dụ từ dòng Module, Cụm bị trống ở dòng 2)
 if (prevHeaders[i]) return prevHeaders[i];
 return '';
 });
};


function DiffPreviewTabs({ diffResult, excludedModules, setExcludedModules }: {
 diffResult: { toUpdate: any[]; toCreate: any[]; toDelete: any[] };
 excludedModules: Set<string>;
 setExcludedModules: (fn: (prev: Set<string>) => Set<string>) => void;
}) {
 const [activeTab, setActiveTab] = useState<'create' | 'update' | 'delete'>('delete');

 const tabs = [
  { id: 'create' as const, label: 'Thêm mới', count: diffResult.toCreate.length, color: 'emerald' },
  { id: 'update' as const, label: 'Cập nhật', count: diffResult.toUpdate.length, color: 'blue' },
  { id: 'delete' as const, label: 'Xóa', count: diffResult.toDelete.length, color: 'rose' },
 ];

 const toggleExclude = (key: string) => {
  setExcludedModules(prev => {
   const next = new Set(prev);
   if (next.has(key)) next.delete(key);
   else next.add(key);
   return next;
  });
 };

 const activeItems = activeTab === 'create' ? diffResult.toCreate
  : activeTab === 'update' ? diffResult.toUpdate
  : diffResult.toDelete;

 return (
  <div className="space-y-4">
   {/* Tabs */}
   <div className="flex gap-2">
    {tabs.map(tab => (
     <button
      key={tab.id}
      onClick={() => setActiveTab(tab.id)}
      className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-[11px] font-black uppercase tracking-wider transition-all cursor-pointer ${
       activeTab === tab.id
        ? tab.color === 'emerald' ? 'bg-emerald-100 text-emerald-700 border border-emerald-200'
        : tab.color === 'blue' ? 'bg-blue-100 text-blue-700 border border-blue-200'
        : 'bg-rose-100 text-rose-700 border border-rose-200'
        : 'bg-slate-100 text-slate-500 border border-slate-200 hover:bg-slate-200'
      }`}
     >
      <span>{tab.label}</span>
      <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${
       tab.color === 'emerald' ? 'bg-emerald-200 text-emerald-800'
       : tab.color === 'blue' ? 'bg-blue-200 text-blue-800'
       : 'bg-rose-200 text-rose-800'
      }`}>
       {tab.count}
      </span>
     </button>
    ))}
   </div>

   {/* List */}
   <div className="border border-slate-200 rounded-lg overflow-hidden">
    <div className="max-h-[400px] overflow-y-auto">
     {activeItems.length === 0 ? (
      <div className="p-8 text-center text-slate-400">
       <p className="text-xs font-bold uppercase tracking-wider">
        {activeTab === 'create' && 'Không có module mới nào'}
        {activeTab === 'update' && 'Không có module cần cập nhật'}
        {activeTab === 'delete' && 'Không có module nào cần xóa'}
       </p>
      </div>
     ) : (
      <table className="w-full text-left">
       <thead className="bg-slate-100 sticky top-0">
        <tr className="text-[10px] font-black uppercase text-slate-400">
         <th className="px-3 py-2.5 w-10 text-center">
          {activeTab === 'delete' ? 'Loại trừ' : ''}
         </th>
         <th className="px-3 py-2.5">Module</th>
         <th className="px-3 py-2.5 w-28">Cụm</th>
         <th className="px-3 py-2.5 w-16 text-center">SL</th>
         <th className="px-3 py-2.5 w-24">Phân loại</th>
         {activeTab === 'delete' && <th className="px-3 py-2.5 w-20 text-center">Lý do giữ</th>}
        </tr>
       </thead>
       <tbody className="divide-y divide-slate-100">
        {activeItems.map((item: any, i: number) => {
         const key = getModuleUniqueKey(item);
         const isExcluded = excludedModules.has(key);
         return (
          <tr key={i} className={`text-xs ${isExcluded ? 'bg-amber-100/30' : 'hover:bg-slate-50'}`}>
           <td className="px-3 py-2 text-center">
            {activeTab === 'delete' ? (
             <button
              onClick={() => toggleExclude(key)}
              className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-all cursor-pointer ${
               isExcluded
                ? 'bg-amber-500 border-amber-500 text-white'
                : 'bg-white border-slate-300 hover:border-amber-400'
              }`}
              title={isExcluded ? 'Bỏ loại trừ (sẽ bị xóa)' : 'Loại trừ (giữ nguyên)'}
             >
              {isExcluded && <Check size={12} />}
             </button>
            ) : null}
           </td>
           <td className="px-3 py-2 font-mono font-bold text-indigo-700 whitespace-nowrap">{item.moduleCode || '—'}</td>
           <td className="px-3 py-2 text-slate-600 uppercase text-[10px]">{item.cluster || '—'}</td>
           <td className="px-3 py-2 text-center font-bold">{item.quantity || '—'}</td>
           <td className="px-3 py-2 text-[10px] text-slate-600">{item.classification || '—'}</td>
           {activeTab === 'delete' && (
            <td className="px-3 py-2 text-[10px]">
             {isExcluded ? (
              <span className="text-amber-600 font-bold">Đã loại trừ</span>
             ) : (
              <span className="text-slate-400">Thiếu trong Excel</span>
             )}
            </td>
           )}
          </tr>
         );
        })}
       </tbody>
      </table>
     )}
    </div>
   </div>

   {/* Summary for delete tab */}
   {activeTab === 'delete' && diffResult.toDelete.length > 0 && (
    <div className="bg-amber-100 border border-amber-200 rounded-lg p-3 flex items-center gap-3">
     <AlertCircle size={16} className="text-amber-600 shrink-0" />
     <p className="text-[10px] text-amber-700 font-bold">
      {excludedModules.size > 0
       ? `${diffResult.toDelete.length - excludedModules.size} module sẽ bị xóa, ${excludedModules.size} module được loại trừ (giữ nguyên).`
       : `Tất cả ${diffResult.toDelete.length} module sẽ bị xóa.`
      } Bấm vào ô "Loại trừ" để giữ lại module cụ thể.
     </p>
    </div>
   )}
  </div>
 );
}


export function ExcelImportScreen({ onComplete }: { onComplete: () => void, key?: string }) {
 const { user, role, roles, userProfile, hasRole } = useAuth();
 const [data, setData] = useState<any[]>([]);
 const [accumulatedData, setAccumulatedData] = useState<any[]>([]);
 const [accumulatedSources, setAccumulatedSources] = useState<{ type: string; label: string; count: number }[]>([]);
 const DEFAULT_EXCLUDE = 'nóc_,hậu_,đáy_,chặn cánh_,chặn_,giằng nóc_,hông trái_,hông phải_,mặt_,hk';
 const [excludePattern, setExcludePattern] = useState(DEFAULT_EXCLUDE);

 // Diff preview for accessories_update (function 4)
 const [diffResult, setDiffResult] = useState<{ toUpdate: any[]; toCreate: any[]; toDelete: any[] } | null>(null);
 const [excludedModules, setExcludedModules] = useState<Set<string>>(new Set());

 // Loại cấu kiện "có cha" → không bị xóa khi thiếu trong Excel mới
 const PROTECTED_CLASSIFICATIONS = new Set(['Cánh', 'Mặt HK', 'Đợt', 'Đợt di động', 'Len, Filler', 'Gia công ngoài', 'CTHT']);

 // Backfill cluster: row không có cụm → kế thừa từ row liền trước
 const backfillCluster = (rows: any[]) => {
 let lastCluster = '';
 for (const row of rows) {
 if (row.cluster && row.cluster.trim()) {
 lastCluster = row.cluster.trim();
 } else if (lastCluster) {
 row.cluster = lastCluster;
 }
 }
 return rows;
 };

 // Filtered data: loại trừ các dòng chứa pattern trong excludePattern + gộp accumulatedData
 const filteredData = useMemo(() => {
  const patterns = excludePattern.split(',').map(p => p.trim().toLowerCase()).filter(Boolean);

  // Gộp accumulatedData + data hiện tại
  const allData = [...accumulatedData, ...data];

  if (patterns.length === 0) return allData;
  return allData.filter(row => {
   const name = (row.moduleCode || '').toLowerCase();
   return !patterns.some(p => name.includes(p));
  });
 }, [data, accumulatedData, excludePattern]);

 // Tính diff cho accessories_update: so sánh filteredData với modules hiện có trong dự án
 const computeDiffForAccessoriesUpdate = async (projectCode: string, newModules: any[]) => {
  if (!projectCode || newModules.length === 0) return;
  try {
   const snapshot = await getDocs(collection(db, 'projectConfigs', projectCode, 'modules'));
   const existingModules: any[] = snapshot.docs.map(d => ({ ...d.data(), _docId: d.id }));

   const newKeys = new Set(newModules.map(r => getModuleUniqueKey(r)));
   const existingByKey = new Map<string, any>();
   existingModules.forEach(m => {
    if (m.moduleCode) existingByKey.set(getModuleUniqueKey(m), m);
   });

   const toUpdate: any[] = [];
   const toCreate: any[] = [];
   const toDelete: any[] = [];

   // Phân loại: module mới có trùng với module cũ không
   for (const row of newModules) {
    const key = getModuleUniqueKey(row);
    if (!key) continue;
    if (existingByKey.has(key)) {
     toUpdate.push(row);
    } else {
     toCreate.push(row);
    }
   }

   // Kiểm tra module cũ không có trong Excel mới → ứng viên xóa
   for (const [key, oldMod] of existingByKey) {
    if (!newKeys.has(key)) {
     const cls = oldMod.classification || determineClassification(oldMod.moduleCode || '', false);
     if (!PROTECTED_CLASSIFICATIONS.has(cls)) {
      toDelete.push(oldMod);
     }
     // Nếu là loại được bảo vệ → giữ nguyên, không thêm vào danh sách nào
    }
   }

   setDiffResult({ toUpdate, toCreate, toDelete });
   setExcludedModules(new Set());
  } catch (err) {
   console.error("Lỗi tính diff:", err);
  }
 };

 const [editingRowIndex, setEditingRowIndex] = useState<number | null>(null);
 const [tempRowAccessories, setTempRowAccessories] = useState<any[]>([]);
 const [newAccName, setNewAccName] = useState<string>('');
 const [newAccQty, setNewAccQty] = useState<number>(1);
 
 if (!hasRole('admin')) {
 return (
 <div className="p-12 text-center text-gray-400">
 <p className="text-sm font-black uppercase tracking-widest">Quyền truy cập bị từ chối</p>
 </div>
 );
 }
 const [projectInfo, setProjectInfo] = useState({ name: '', code: '', drawingUrl: '', assemblyDrawingUrl: '', glbUrl: '' });
 const [loading, setLoading] = useState(false);
 const [step, setStep] = useState(1);
 const [importMode, setImportMode] = useState<'new' | 'update'>('new');
 const [existingProjects, setExistingProjects] = useState<{name: string, code: string, drawingUrl: string, assemblyDrawingUrl: string, glbUrl: string}[]>([]);
 const [selectedProjectCode, setSelectedProjectCode] = useState('');

 // Excel BOM Mappings and Types
 const [importType, setImportType] = useState<'standard' | 'bom' | 'parts' | 'parts_v2' | 'accessories_update'>('bom');
 const [wb, setWb] = useState<XLSX.WorkBook | null>(null);
 const [sheetsList, setSheetsList] = useState<string[]>([]);
 const [fileError, setFileError] = useState<string | null>(null);

 // Reset về bước chọn file
 const resetToFileSelection = async (selectProjectCode?: string, newProject?: { name: string; code: string; drawingUrl?: string; assemblyDrawingUrl?: string; glbUrl?: string }) => {
   setStep(1);
   setData([]);
   setWb(null);
   setSheetsList([]);
   setFileError(null);
   setDiffResult(null);
   setExcludedModules(new Set());
   setAccumulatedData([]);
   setAccumulatedSources([]);
   if (newProject) {
     // Giữ nguyên projectInfo từ dự án vừa tạo để dùng tiếp cho chức năng 2/3
     setProjectInfo({
       name: newProject.name,
       code: newProject.code,
       drawingUrl: newProject.drawingUrl || '',
       assemblyDrawingUrl: newProject.assemblyDrawingUrl || '',
       glbUrl: newProject.glbUrl || ''
     });
     setExistingProjects(prev => {
       if (prev.some(p => p.code === newProject.code)) return prev;
       return [...prev, { name: newProject.name, code: newProject.code, drawingUrl: newProject.drawingUrl || '', assemblyDrawingUrl: newProject.assemblyDrawingUrl || '', glbUrl: newProject.glbUrl || '' }];
     });
   } else {
     setProjectInfo({ name: '', code: '', drawingUrl: '', assemblyDrawingUrl: '', glbUrl: '' });
   }
   // Refresh danh sách dự án
   await fetchExistingProjects();
   // Chọn dự án vừa tạo
   if (selectProjectCode) {
     setSelectedProjectCode(selectProjectCode);
   }
 };

 // Lưu dữ liệu hiện tại vào tích lũy và chuyển sang bước kế tiếp (chọn chức năng 2/3)
 const saveAndNextStep = () => {
  // Chỉ lưu data hiện tại (chưa include accumulatedData)
  const currentFiltered = (() => {
   const patterns = excludePattern.split(',').map(p => p.trim().toLowerCase()).filter(Boolean);
   if (patterns.length === 0) return data;
   return data.filter(row => {
    const name = (row.moduleCode || '').toLowerCase();
    return !patterns.some(p => name.includes(p));
   });
  })();

  if (currentFiltered.length === 0) return;

  const typeLabels: Record<string, string> = {
   'bom': 'Excel BOM (Chức năng 1)',
   'parts': 'Cấu kiện chi tiết (Chức năng 2)',
   'parts_v2': 'Cấu kiện mới (Chức năng 3)',
  };

  setAccumulatedData(prev => [...prev, ...currentFiltered]);
  setAccumulatedSources(prev => [...prev, {
   type: importType,
   label: typeLabels[importType] || importType,
   count: currentFiltered.length
  }]);

  if (projectInfo.code) {
    setSelectedProjectCode(projectInfo.code);
  }

  // Reset về bước 1 nhưng giữ nguyên projectInfo và accumulatedData
  setStep(1);
  setData([]);
  setWb(null);
  setSheetsList([]);
  setFileError(null);
  setDiffResult(null);
  setExcludedModules(new Set());
 };

 // Xóa 1 nguồn dữ liệu tích lũy
 const removeAccumulatedSource = (index: number) => {
  // Tính lại accumulatedData: xóa các dòng thuộc source bị xóa
  let chunkIdx = 0;
  const newAccumulated: any[] = [];
  const newSources: typeof accumulatedSources = [];
  let accIdx = 0;

  for (const src of accumulatedSources) {
   if (accIdx === index) {
    accIdx++;
    continue; // Bỏ qua source này
   }
   const chunk = accumulatedData.slice(chunkIdx, chunkIdx + src.count);
   newAccumulated.push(...chunk);
   newSources.push(src);
   chunkIdx += src.count;
   accIdx++;
  }

  setAccumulatedData(newAccumulated);
  setAccumulatedSources(newSources);
 };

 // Sheet 1 mappings (Modules and Accessories)
 const [sheet1Name, setSheet1Name] = useState<string>('');
 const [s1HeaderRow, setS1HeaderRow] = useState<number>(1);
 const [sheet1Headers, setSheet1Headers] = useState<string[]>([]);
 const [s1ClusterCol, setS1ClusterCol] = useState<string>('');
 const [s1ModuleCol, setS1ModuleCol] = useState<string>('');
 const [s1QuantityCol, setS1QuantityCol] = useState<string>('');
 const [s1AccessoriesStartCol, setS1AccessoriesStartCol] = useState<string>('');

 // Customized Multi-column Accessories configuration for BOM
 const [selectedAccessoryCols, setSelectedAccessoryCols] = useState<string[]>([]);
 const [accessoryStats, setAccessoryStats] = useState<{ [key: string]: { moduleCount: number; totalQty: number } }>({});

 const updateAccessoryStats = (workbook: XLSX.WorkBook | null, shName: string, hRow: number, startColName: string) => {
 if (!workbook || !shName || !startColName) {
 setAccessoryStats({});
 setSelectedAccessoryCols([]);
 return;
 }
 try {
 const ws = workbook.Sheets[shName];
 const data: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
 const hIdx = hRow - 1;
 if (hIdx < 0 || hIdx >= data.length) return;

 const headers = getEnrichedHeaders(data, hIdx);
 const startIdx = headers.indexOf(startColName);
 if (startIdx === -1) {
 setAccessoryStats({});
 setSelectedAccessoryCols([]);
 return;
 }

 const rows = data.slice(hIdx + 1);
 const newStats: { [key: string]: { moduleCount: number; totalQty: number } } = {};
 const activeCols: string[] = [];

 for (let i = startIdx; i < headers.length; i++) {
 const hName = headers[i];
 if (!hName) continue;
 
 let mCount = 0;
 let tQty = 0;
 
 rows.forEach(row => {
 const val = Number(row[i]) || 0;
 if (val > 0) {
 mCount++;
 tQty += val;
 }
 });

 newStats[hName] = { moduleCount: mCount, totalQty: tQty };
 activeCols.push(hName);
 }

 setAccessoryStats(newStats);
 setSelectedAccessoryCols(activeCols);
 } catch (err) {
 console.error("Lỗi tính chất thống kê phụ kiện:", err);
 }
 };

 // Sheet 2 mappings (Dimensions)
 const [sheet2Name, setSheet2Name] = useState<string>('');
 const [s2HeaderRow, setS2HeaderRow] = useState<number>(1);
 const [sheet2Headers, setSheet2Headers] = useState<string[]>([]);
 const [s2ClusterCol, setS2ClusterCol] = useState<string>('');
 const [s2ModuleCol, setS2ModuleCol] = useState<string>('');
 const [s2TotalQtyCol, setS2TotalQtyCol] = useState<string>('');
 const [s2DimType, setS2DimType] = useState<'separate' | 'single'>('single');
 const [s2WidthCol, setS2WidthCol] = useState<string>('');
 const [s2DepthCol, setS2DepthCol] = useState<string>('');
 const [s2HeightCol, setS2HeightCol] = useState<string>('');
 const [s2DimSingleCol, setS2DimSingleCol] = useState<string>('');

 const [s2PackDimType, setS2PackDimType] = useState<'separate' | 'single'>('single');
 const [s2PackWidthCol, setS2PackWidthCol] = useState<string>('');
 const [s2PackDepthCol, setS2PackDepthCol] = useState<string>('');
 const [s2PackHeightCol, setS2PackHeightCol] = useState<string>('');
 const [s2PackDimSingleCol, setS2PackDimSingleCol] = useState<string>('');

 // Initialize mappings helper when sheet index or header changes
 const applySheet1Headers = (sheetName: string, workbook: XLSX.WorkBook, customHeaderRow: number) => {
 if (!workbook || !sheetName) return;
 const ws = workbook.Sheets[sheetName];
 const rawData: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
 const hIdx = Math.max(0, customHeaderRow - 1);
 const headers = getEnrichedHeaders(rawData, hIdx);
 setSheet1Headers(headers);

 let cluster = '';
 let moduleCode = '';
 let qty = '';
 let accStart = '';

 headers.forEach(h => {
 const lh = h.toLowerCase();
 if (!cluster && (lh.includes('cụm') || lh.includes('cluster') || lh.includes('tổ'))) cluster = h;
 if (!moduleCode && (lh.includes('module') || lh.includes('mã hiệu') || lh.includes('ký hiệu') || lh.includes('mã tủ') || lh.includes('tên tủ'))) moduleCode = h;
 if (!qty && (lh.includes('số lượng') || lh.includes('sl') || lh.includes('qty') || lh.includes('tủ'))) qty = h;
 if (!accStart && (lh.includes('phụ kiện') || lh.includes('vật tư phụ') || lh.includes('khóa') || lh.includes('bản lề') || lh.includes('chốt') || lh.includes('tay nắm'))) accStart = h;
 });

 const finalAccStart = accStart || headers[3] || '';

 setS1ClusterCol(cluster || headers[0] || '');
 setS1ModuleCol(moduleCode || headers[1] || '');
 setS1QuantityCol(qty || headers[2] || '');
 setS1AccessoriesStartCol(finalAccStart);

 updateAccessoryStats(workbook, sheetName, customHeaderRow, finalAccStart);
 };

 const applySheet2Headers = (sheetName: string, workbook: XLSX.WorkBook, customHeaderRow: number) => {
 if (!workbook || !sheetName) return;
 const ws = workbook.Sheets[sheetName];
 const rawData: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
 const hIdx = Math.max(0, customHeaderRow - 1);
 const headers = getEnrichedHeaders(rawData, hIdx);
 setSheet2Headers(headers);

 let cluster = '';
 let moduleCode = '';
 let totalQty = '';
 let dimSingle = '';
 let packDimSingle = '';
 let wCol = '', dCol = '', hCol = '';
 let pwCol = '', pdCol = '', phCol = '';

 headers.forEach(h => {
 const lh = h.toLowerCase();
 if (!cluster && (lh.includes('cụm') || lh.includes('cluster') || lh.includes('tổ'))) cluster = h;
 if (!moduleCode && (lh.includes('module') || lh.includes('mã') || lh.includes('ký hiệu') || lh.includes('mã tủ') || lh.includes('tên tủ'))) moduleCode = h;
 if (!totalQty && (lh.includes('tổng số lượng') || lh.includes('tổng sl') || lh.includes('tổng cộng') || lh.includes('tổng qty'))) totalQty = h;

 if (!dimSingle && (lh.includes('kích thước tổng') || (lh.includes('kích thước') && !lh.includes('đóng gói') && !lh.includes('phủ bì') && !lh.includes('bao')) || lh.includes('kích thước thiết kế'))) {
 dimSingle = h;
 }
 if (!packDimSingle && (lh.includes('đóng gói') || lh.includes('phủ bì') || lh.includes('bao bì') || lh.includes('kích thước đg'))) {
 packDimSingle = h;
 }

 if (lh === 'rộng' || lh === 'w' || lh === 'width' || lh === 'chiều rộng') wCol = h;
 if (lh === 'sâu' || lh === 'd' || lh === 'depth' || lh === 'chiều sâu') dCol = h;
 if (lh === 'cao' || lh === 'h' || lh === 'height' || lh === 'chiều cao') hCol = h;

 if (lh.includes('rộng đóng gói') || lh.includes('w_pack') || lh.includes('rộng phủ bì')) pwCol = h;
 if (lh.includes('sâu đóng gói') || lh.includes('d_pack') || lh.includes('sâu phủ bì')) pdCol = h;
 if (lh.includes('cao đóng gói') || lh.includes('h_pack') || lh.includes('cao phủ bì')) phCol = h;
 });

 setS2ClusterCol(cluster || headers[0] || '');
 setS2ModuleCol(moduleCode || headers[1] || '');
 setS2TotalQtyCol(totalQty || headers[2] || '');

 if (dimSingle) {
 setS2DimType('single');
 setS2DimSingleCol(dimSingle);
 } else if (wCol && dCol && hCol) {
 setS2DimType('separate');
 setS2WidthCol(wCol);
 setS2DepthCol(dCol);
 setS2HeightCol(hCol);
 } else {
 setS2DimType('single');
 const defaultDim = headers.find(x => x.toLowerCase().includes('kích thước')) || '';
 setS2DimSingleCol(defaultDim);
 }

 if (packDimSingle) {
 setS2PackDimType('single');
 setS2PackDimSingleCol(packDimSingle);
 } else if (pwCol && pdCol && phCol) {
 setS2PackDimType('separate');
 setS2PackWidthCol(pwCol);
 setS2PackDepthCol(pdCol);
 setS2PackHeightCol(phCol);
 } else {
 setS2PackDimType('single');
 const defaultPack = headers.find(x => x.toLowerCase().includes('đóng gói') || x.toLowerCase().includes('phủ bì')) || '';
 setS2PackDimSingleCol(defaultPack);
 }
 };


 const handleUpdateRow = (index: number, field: string, value: any) => {
 setData(prev => prev.map((row, idx) => {
 if (idx === index) {
 return { ...row, [field]: value };
 }
 return row;
 }));
 };

 const handleAddRow = () => {
 const newRow = {
 cluster: '',
 moduleCode: '',
 quantity: 1,
 classification: '',
 width: 0,
 depth: 0,
 height: 0,
 pWidth: 0,
 pDepth: 0,
 pHeight: 0,
 accessories: [],
 notes: ''
 };
 setData(prev => [...prev, newRow]);
 };

 const handleDeleteRow = (index: number) => {
  setData(prev => prev.filter((_, idx) => idx !== index));
 };

 const handleDeleteRowById = (rowId: string) => {
  setData(prev => prev.filter(r => r.id !== rowId));
 };

 useEffect(() => {
  setExcludePattern(DEFAULT_EXCLUDE);
  if (importType === 'parts' || importType === 'parts_v2' || importType === 'accessories_update') {
   setImportMode('update');
  }
 }, [importType]);

 useEffect(() => {
 fetchExistingProjects();
 }, [user]);

 const fetchExistingProjects = async () => {
  try {
  const snapshot = await getDocs(collection(db, 'projectConfigs'));
  const projects: any[] = [];
  const codes = new Set();
  
  snapshot.docs.forEach(docSnap => {
   const d = docSnap.data();
   if (d.projectCode && !codes.has(d.projectCode) && !d.isCompleted) {
    codes.add(d.projectCode);
    projects.push({
     name: d.projectName,
     code: d.projectCode,
     drawingUrl: d.drawingUrl || '',
     assemblyDrawingUrl: d.assemblyDrawingUrl || '',
     glbUrl: d.glbUrl || ''
    });
   }
  });
  setExistingProjects(projects);
  } catch (error) {
  console.error("Error fetching projects:", error);
  }
 };

 const matchClustersWithProjectAndApply = async (projectCode: string, currentData: any[]) => {
  if (!projectCode || currentData.length === 0) return;
  try {
  setLoading(true);
  const snapshot = await getDocs(collection(db, 'projectConfigs', projectCode, 'modules'));
  const existingModules = snapshot.docs.map(doc => doc.data());

 const updatedData = currentData.map(item => {
 const cleanItemName = item.moduleCode.trim().toLowerCase();
 const match = existingModules.find(m => m.moduleCode && m.moduleCode.trim().toLowerCase() === cleanItemName);
 if (match) {
 return {
 ...item,
 cluster: match.cluster || 'Cấu kiện ngoài'
 };
 }
 return item;
 });

 setData(updatedData);
 } catch (error) {
 console.error("Lỗi so khớp Cụm:", error);
 } finally {
 setLoading(false);
 }
 };

 const handleProjectSelect = async (projectCode: string) => {
 const project = existingProjects.find(p => p.code === projectCode);
 if (project) {
 setProjectInfo({
 name: project.name,
 code: project.code,
 drawingUrl: project.drawingUrl,
 assemblyDrawingUrl: project.assemblyDrawingUrl || '',
 glbUrl: project.glbUrl
 });
 setSelectedProjectCode(projectCode);
 
 if (importType === 'parts' || importType === 'parts_v2') {
  await matchClustersWithProjectAndApply(projectCode, data);
  }
 } else {
 setSelectedProjectCode('');
 }
 };

 const determineClassification = (mCode: string, isShelf: boolean): string => {
 if (isShelf) return 'Đợt';
 const lowerCode = mCode.toLowerCase();
 if (
 lowerCode.includes('len') || 
 lowerCode.includes('filler') || 
 lowerCode.includes('fillter') || 
 lowerCode.includes('thanh treo') || 
 lowerCode.includes('thanh_treo')
 ) {
 return 'Len, Filler';
 }
 if (lowerCode.includes('gia công ngoài') || lowerCode.includes('gia cong ngoai')) {
 return 'Gia công ngoài';
 }
 if (lowerCode.includes('đợt di động') || lowerCode.includes('dot di dong') || lowerCode.includes('đợt dd') || lowerCode.includes('dot dd')) {
 return 'Đợt di động';
 }
 if (lowerCode.includes('mặt hoàn thiện') || lowerCode.includes('mặt hoan thien') || lowerCode.includes('mặt ht') || lowerCode.includes('mat hoan thien')) {
 return 'CTHT';
 }
 if (lowerCode.includes('hoàn thiện') || lowerCode.includes('hoan thien') || lowerCode.includes('ctht') || lowerCode.includes('tấm')) {
 return 'CTHT';
 }
 if (lowerCode.includes('mặt học kéo') || lowerCode.includes('mat hoc keo') || lowerCode.includes('mặt hk')) {
 return 'Mặt HK';
 }
 if (lowerCode.includes('mặt')) {
 return 'Mặt HK';
 }
 if (lowerCode.includes('cánh') || lowerCode.includes('cửa')) {
 return 'Cánh';
 }
 if (lowerCode.includes('đợt')) {
 return 'Đợt';
 }
 // Tên có đúng 1 _ và 1 . → Thùng (VD: BLDG1_KIT.T1)
 const underscoreCount = (mCode.match(/_/g) || []).length;
 const dotCount = (mCode.match(/\./g) || []).length;
 if (underscoreCount >= 1 && dotCount >= 1) {
 return 'Thùng';
 }
 return 'Thùng';
 };

 const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
 const file = e.target.files?.[0];
 if (!file) return;
 setFileError(null);

 const reader = new FileReader();
 reader.onload = async (evt) => {
 try {
 const bstr = evt.target?.result;
 const workbook = XLSX.read(bstr, { type: 'binary' });
 setWb(workbook);
 setSheetsList(workbook.SheetNames);

 if (workbook.SheetNames.length === 0) {
 throw new Error("File Excel không có sheet nào!");
 }

 if (importType === 'accessories_update') {
 // ===== EXCEL BOM: Copy 1:1 từ BOM import =====
 const analyzeSheet = (rawData: any[][]) => {
 let hasModule = false, hasDim = false, hasPack = false, hasAccessory = false;
 let moduleCol = -1, headerIdx = -1;
 for (let i = 0; i < Math.min(20, rawData.length); i++) {
 const row = rawData[i];
 for (let j = 0; j < row.length; j++) {
 const cell = String(row[j] || '').trim().toLowerCase();
 if (cell === 'module' || cell.includes('mã hiệu') || cell.includes('ký hiệu')) { hasModule = true; moduleCol = j; headerIdx = i; }
 if (cell.includes('kích thước tổng') || cell.includes('kích thước thiết kế') || cell === 'rộng' || cell === 'sâu' || cell === 'cao') hasDim = true;
 if (cell.includes('kích thước đóng gói') || cell.includes('phủ bì') || cell.includes('bao bì')) hasPack = true;
 if (cell.includes('phụ kiện') && cell.includes('vật tư phụ')) hasAccessory = true;
 }
 }
 return { hasModule, hasDim, hasPack, hasAccessory, moduleCol, headerIdx };
 };

 const sheetAnalyses = workbook.SheetNames.map(name => ({
 name,
 ...analyzeSheet(XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: '' }))
 }));

 const dimSheet = sheetAnalyses.find(s => s.hasModule && (s.hasDim || s.hasPack));
 const accSheet = sheetAnalyses.find(s => s.hasModule && s.hasAccessory && s.name !== dimSheet?.name);

 if (!dimSheet) {
 alert("Không tìm thấy sheet chứa Module và Kích thước!");
 return;
 }

 // ===== BƯỚC 1: Parse sheet kích thước =====
 const dimRaw: any[][] = XLSX.utils.sheet_to_json(workbook.Sheets[dimSheet.name], { header: 1, defval: '' });
 const dimHeaderIdx = dimSheet.headerIdx;
 const dimModuleCol = dimSheet.moduleCol;
 const dimHeaderRow = dimRaw[dimHeaderIdx] || [];
 const dimSubRow = dimRaw[dimHeaderIdx + 1] || [];
 let dimStartCol = -1, packStartCol = -1;

 for (let j = 0; j < dimHeaderRow.length; j++) {
 const cell = String(dimHeaderRow[j] || '').trim().toLowerCase();
 if (cell.includes('kích thước tổng') || cell.includes('kích thước thiết kế')) dimStartCol = j;
 if (cell.includes('kích thước đóng gói') || cell.includes('phủ bì') || cell.includes('bao bì')) packStartCol = j;
 }

 let dimW = -1, dimD = -1, dimH = -1, packW = -1, packD = -1, packH = -1;
 for (let j = 0; j < dimSubRow.length; j++) {
 const sub = String(dimSubRow[j] || '').trim().toLowerCase();
 if (sub === 'rộng' || sub === 'w' || sub.includes('width')) {
 if (dimStartCol >= 0 && j >= dimStartCol && (packStartCol < 0 || j < packStartCol)) { if (dimW === -1) dimW = j; }
 else if (packStartCol >= 0 && j >= packStartCol) { if (packW === -1) packW = j; }
 }
 if (sub === 'sâu' || sub === 'd' || sub.includes('depth')) {
 if (dimStartCol >= 0 && j >= dimStartCol && (packStartCol < 0 || j < packStartCol)) { if (dimD === -1) dimD = j; }
 else if (packStartCol >= 0 && j >= packStartCol) { if (packD === -1) packD = j; }
 }
 if (sub === 'cao' || sub === 'h' || sub.includes('height')) {
 if (dimStartCol >= 0 && j >= dimStartCol && (packStartCol < 0 || j < packStartCol)) { if (dimH === -1) dimH = j; }
 else if (packStartCol >= 0 && j >= packStartCol) { if (packH === -1) packH = j; }
 }
 }

 let dimQtyCol = -1, dimClusterCol = -1;
 for (let j = 0; j < dimSubRow.length; j++) {
 const cell = String(dimSubRow[j] || '').trim().toLowerCase();
 if (cell.includes('tổng số lượng') || cell.includes('tổng sl') || cell.includes('tổng cộng')) { dimQtyCol = j; break; }
 }
 if (dimQtyCol === -1) {
 for (let j = 0; j < dimHeaderRow.length; j++) {
 const cell = String(dimHeaderRow[j] || '').trim().toLowerCase();
 if (cell.includes('tổng số lượng') || cell.includes('tổng sl') || cell.includes('tổng cộng')) { dimQtyCol = j; break; }
 }
 }
 for (let j = 0; j < dimHeaderRow.length; j++) {
 const cell = String(dimHeaderRow[j] || '').trim().toLowerCase();
 if (cell === 'cụm' || cell.includes('cluster')) { dimClusterCol = j; break; }
 }
 if (dimClusterCol === -1) {
 for (let j = 0; j < dimSubRow.length; j++) {
 const cell = String(dimSubRow[j] || '').trim().toLowerCase();
 if (cell === 'cụm' || cell.includes('cluster')) { dimClusterCol = j; break; }
 }
 }

 const modulesMap = new Map<string, any>();
 let dimDataStart = dimHeaderIdx + 2;
 const firstDimVal = Number(dimRaw[dimDataStart]?.[dimModuleCol]) || 0;
 if (firstDimVal > 0 && firstDimVal < 100) dimDataStart++;

 for (let i = dimDataStart; i < dimRaw.length; i++) {
 const row = dimRaw[i];
 const mc = row[dimModuleCol] ? String(row[dimModuleCol]).trim() : '';
 if (!mc) continue;
 const key = mc.toLowerCase();
 const w = dimW >= 0 ? Number(row[dimW]) || 0 : 0;
 const d = dimD >= 0 ? Number(row[dimD]) || 0 : 0;
 const h = dimH >= 0 ? Number(row[dimH]) || 0 : 0;
 const pw = packW >= 0 ? Number(row[packW]) || 0 : 0;
 const pd = packD >= 0 ? Number(row[packD]) || 0 : 0;
 const ph = packH >= 0 ? Number(row[packH]) || 0 : 0;
 const qty = dimQtyCol >= 0 ? Number(row[dimQtyCol]) || 1 : 1;
 const cluster = dimClusterCol >= 0 ? String(row[dimClusterCol] || '').trim() : '';

 if (modulesMap.has(key)) {
 const existing = modulesMap.get(key);
 if (w > 0) existing.width = w; if (d > 0) existing.depth = d; if (h > 0) existing.height = h;
 if (pw > 0) existing.pWidth = pw; if (pd > 0) existing.pDepth = pd; if (ph > 0) existing.pHeight = ph;
 if (qty > 0) existing.quantity = Math.max(existing.quantity, qty);
 if (cluster && !existing.cluster) existing.cluster = cluster;
 } else {
 modulesMap.set(key, {
 id: doc(collection(db, 'projectConfigs')).id,
 moduleCode: mc, cluster, quantity: qty,
 classification: determineClassification(mc, false),
 width: w, depth: d, height: h, pWidth: pw, pDepth: pd, pHeight: ph,
 accessories: [], notes: ''
 });
 }
 }

 // ===== BƯỚC 2: Parse sheet phụ kiện =====
 if (accSheet) {
 const accRaw: any[][] = XLSX.utils.sheet_to_json(workbook.Sheets[accSheet.name], { header: 1, defval: '' });
 const accHeaderIdx = accSheet.headerIdx;
 const accModuleCol = accSheet.moduleCol;
 const accHeaderRow = accRaw[accHeaderIdx] || [];
 let accStartCol = -1;
 for (let j = 0; j < accHeaderRow.length; j++) {
 const cell = String(accHeaderRow[j] || '').trim().toLowerCase();
 if (cell.includes('phụ kiện') && cell.includes('vật tư phụ')) { accStartCol = j; break; }
 }
 let accEndCol = -1;
 if (accStartCol >= 0) {
 accEndCol = accStartCol;
 for (let j = accStartCol + 1; j < accHeaderRow.length; j++) {
 const cell = String(accHeaderRow[j] || '').trim().toLowerCase();
 if (cell.includes('vật tư chính') || cell.includes('ghi chú')) { accEndCol = j - 1; break; }
 if (cell !== '') accEndCol = j;
 }
 }
 if (accStartCol >= 0 && accEndCol >= accStartCol) {
 let accSubIdx = accHeaderIdx + 1;
 const accSubRow = accRaw[accSubIdx] || [];
 if (!accSubRow.slice(accStartCol, accEndCol + 1).some(c => String(c || '').trim() !== '')) accSubIdx = accHeaderIdx + 2;
 const accSubDataRow = accRaw[accSubIdx] || [];
 const accNames: string[] = [];
 for (let j = accStartCol; j <= accEndCol; j++) {
 accNames.push(String(accSubDataRow[j] || '').replace(/[\r\n]+/g, ' ').trim());
 }
 let accDataStart = accSubIdx + 1;
 const firstAccVal = Number(accRaw[accDataStart]?.[accModuleCol]) || 0;
 if (firstAccVal > 0 && firstAccVal < 100 && !isNaN(firstAccVal)) accDataStart++;

 for (let i = accDataStart; i < accRaw.length; i++) {
 const row = accRaw[i];
 const mc = row[accModuleCol] ? String(row[accModuleCol]).trim() : '';
 if (!mc) continue;
 if (mc.toLowerCase().includes('vật tư') || mc.toLowerCase().includes('tên sơn') || mc.toLowerCase().includes('số lượng')) continue;
 const key = mc.toLowerCase();
 const accessories: any[] = [];
 for (let j = 0; j < accNames.length; j++) {
 const val = Number(row[accStartCol + j]) || 0;
 const name = accNames[j];
 if (name && val > 0) {
 const n = normalizeAccessoryName(name);
 if (n.includes('chi dan canh')) continue;
 accessories.push({ name, quantity: val, issuedQuantity: 0, status: 'Chưa xuất kho' });
 }
 }
 const target = modulesMap.get(key);
 if (target) {
 accessories.forEach(newAcc => {
 const existAcc = target.accessories.find((a: any) => a.name.toLowerCase() === newAcc.name.toLowerCase());
 if (existAcc) existAcc.quantity += newAcc.quantity;
 else target.accessories.push(newAcc);
 });
 } else if (accessories.length > 0) {
 modulesMap.set(key, {
 id: doc(collection(db, 'projectConfigs')).id,
 moduleCode: mc,
 cluster: '', quantity: 1,
 classification: determineClassification(mc, false),
 width: 0, depth: 0, height: 0, pWidth: 0, pDepth: 0, pHeight: 0,
 accessories, notes: ''
 });
 }
 }
 }
 }

 const finalData = Array.from(modulesMap.values());
 let lastCluster = '';
 for (const row of finalData) {
 if (row.cluster && row.cluster.trim()) lastCluster = row.cluster.trim();
 else if (lastCluster) row.cluster = lastCluster;
 }

 if (finalData.length === 0) {
 alert("Không tìm thấy dữ liệu BOM hợp lệ!");
 return;
 }

 setData(backfillCluster(finalData));
 setStep(2);
 // Tính diff cho accessories_update
 if (importType === 'accessories_update' && selectedProjectCode) {
  computeDiffForAccessoriesUpdate(selectedProjectCode, backfillCluster(finalData));
 }
 return;
 }

 if (importType === 'bom') {
 // ===== BOM: Detect sheet theo NỘI DUNG cột, không theo tên =====

 // Helper: scan sheet headers để xác định loại sheet
 const analyzeSheet = (rawData: any[][]) => {
 let hasModule = false, hasDim = false, hasPack = false, hasAccessory = false;
 let moduleCol = -1, headerIdx = -1;
 for (let i = 0; i < Math.min(20, rawData.length); i++) {
 const row = rawData[i];
 for (let j = 0; j < row.length; j++) {
 const cell = String(row[j] || '').trim().toLowerCase();
 if (cell === 'module' || cell.includes('mã hiệu') || cell.includes('ký hiệu')) {
 hasModule = true;
 moduleCol = j;
 headerIdx = i;
 }
 if (cell.includes('kích thước tổng') || cell.includes('kích thước thiết kế') || cell === 'rộng' || cell === 'sâu' || cell === 'cao') hasDim = true;
 if (cell.includes('kích thước đóng gói') || cell.includes('phủ bì') || cell.includes('bao bì')) hasPack = true;
 if (cell.includes('phụ kiện') && cell.includes('vật tư phụ')) hasAccessory = true;
 }
 }
 return { hasModule, hasDim, hasPack, hasAccessory, moduleCol, headerIdx };
 };

 // Phân tích tất cả sheets
 const sheetAnalyses = workbook.SheetNames.map(name => ({
 name,
 ...analyzeSheet(XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: '' }))
 }));

 console.log('[BOM DEBUG] Sheet analyses:', sheetAnalyses.map(s => ({
 name: s.name, module: s.hasModule, dim: s.hasDim, pack: s.hasPack, acc: s.hasAccessory
 })));

 // Sheet có kích thước = nền tảng (có module + kích thước)
 const dimSheet = sheetAnalyses.find(s => s.hasModule && (s.hasDim || s.hasPack));
 // Sheet có phụ kiện = bổ sung
 const accSheet = sheetAnalyses.find(s => s.hasModule && s.hasAccessory && s.name !== dimSheet?.name);

 if (!dimSheet) {
 alert("Không tìm thấy sheet chứa Module và Kích thước! Vui lòng kiểm tra lại file Excel.");
 return;
 }

 // ===== BƯỚC 1: Parse sheet kích thước làm nền tảng =====
 const dimRaw: any[][] = XLSX.utils.sheet_to_json(workbook.Sheets[dimSheet.name], { header: 1, defval: '' });
 const dimHeaderIdx = dimSheet.headerIdx;
 const dimModuleCol = dimSheet.moduleCol;

 // Find dimension/pack columns from header and sub-header
 const dimHeaderRow = dimRaw[dimHeaderIdx] || [];
 const dimSubRow = dimRaw[dimHeaderIdx + 1] || [];
 let dimStartCol = -1, packStartCol = -1;

 for (let j = 0; j < dimHeaderRow.length; j++) {
 const cell = String(dimHeaderRow[j] || '').trim().toLowerCase();
 if (cell.includes('kích thước tổng') || cell.includes('kích thước thiết kế')) dimStartCol = j;
 if (cell.includes('kích thước đóng gói') || cell.includes('phủ bì') || cell.includes('bao bì')) packStartCol = j;
 }

 let dimW = -1, dimD = -1, dimH = -1, packW = -1, packD = -1, packH = -1;
 for (let j = 0; j < dimSubRow.length; j++) {
 const sub = String(dimSubRow[j] || '').trim().toLowerCase();
 if (sub === 'rộng' || sub === 'w' || sub.includes('width')) {
 if (dimStartCol >= 0 && j >= dimStartCol && (packStartCol < 0 || j < packStartCol)) { if (dimW === -1) dimW = j; }
 else if (packStartCol >= 0 && j >= packStartCol) { if (packW === -1) packW = j; }
 }
 if (sub === 'sâu' || sub === 'd' || sub.includes('depth')) {
 if (dimStartCol >= 0 && j >= dimStartCol && (packStartCol < 0 || j < packStartCol)) { if (dimD === -1) dimD = j; }
 else if (packStartCol >= 0 && j >= packStartCol) { if (packD === -1) packD = j; }
 }
 if (sub === 'cao' || sub === 'h' || sub.includes('height')) {
 if (dimStartCol >= 0 && j >= dimStartCol && (packStartCol < 0 || j < packStartCol)) { if (dimH === -1) dimH = j; }
 else if (packStartCol >= 0 && j >= packStartCol) { if (packH === -1) packH = j; }
 }
 }

 // Qty and cluster columns
 let dimQtyCol = -1, dimClusterCol = -1;
 for (let j = 0; j < dimSubRow.length; j++) {
 const cell = String(dimSubRow[j] || '').trim().toLowerCase();
 if (cell.includes('tổng số lượng') || cell.includes('tổng sl') || cell.includes('tổng cộng')) { dimQtyCol = j; break; }
 }
 if (dimQtyCol === -1) {
 for (let j = 0; j < dimHeaderRow.length; j++) {
 const cell = String(dimHeaderRow[j] || '').trim().toLowerCase();
 if (cell.includes('tổng số lượng') || cell.includes('tổng sl') || cell.includes('tổng cộng')) { dimQtyCol = j; break; }
 }
 }
 for (let j = 0; j < dimHeaderRow.length; j++) {
 const cell = String(dimHeaderRow[j] || '').trim().toLowerCase();
 if (cell === 'cụm' || cell.includes('cluster')) { dimClusterCol = j; break; }
 }
 // Also check sub-header for cluster
 if (dimClusterCol === -1) {
 for (let j = 0; j < dimSubRow.length; j++) {
 const cell = String(dimSubRow[j] || '').trim().toLowerCase();
 if (cell === 'cụm' || cell.includes('cluster')) { dimClusterCol = j; break; }
 }
 }

 // Parse dimension sheet data
 const modulesMap = new Map<string, any>();
 let dimDataStart = dimHeaderIdx + 2;
 const firstDimVal = Number(dimRaw[dimDataStart]?.[dimModuleCol]) || 0;
 if (firstDimVal > 0 && firstDimVal < 100) dimDataStart++;

 for (let i = dimDataStart; i < dimRaw.length; i++) {
 const row = dimRaw[i];
 const mc = row[dimModuleCol] ? String(row[dimModuleCol]).trim() : '';
 if (!mc) continue;

 const w = dimW >= 0 ? Number(row[dimW]) || 0 : 0;
 const d = dimD >= 0 ? Number(row[dimD]) || 0 : 0;
 const h = dimH >= 0 ? Number(row[dimH]) || 0 : 0;
 const pw = packW >= 0 ? Number(row[packW]) || 0 : 0;
 const pd = packD >= 0 ? Number(row[packD]) || 0 : 0;
 const ph = packH >= 0 ? Number(row[packH]) || 0 : 0;
 const qty = dimQtyCol >= 0 ? Number(row[dimQtyCol]) || 1 : 1;
 const cluster = dimClusterCol >= 0 ? String(row[dimClusterCol] || '').trim() : '';

 const key = `${mc.toLowerCase()}|${w}|${d}|${h}|${pw}|${pd}|${ph}`;

 if (modulesMap.has(key)) {
 const existing = modulesMap.get(key);
 if (w > 0) existing.width = w;
 if (d > 0) existing.depth = d;
 if (h > 0) existing.height = h;
 if (pw > 0) existing.pWidth = pw;
 if (pd > 0) existing.pDepth = pd;
 if (ph > 0) existing.pHeight = ph;
 if (qty > 0) existing.quantity = Math.max(existing.quantity, qty);
 if (cluster && !existing.cluster) existing.cluster = cluster;
 } else {
 modulesMap.set(key, {
 id: doc(collection(db, 'projectConfigs')).id,
 moduleCode: mc,
 cluster,
 quantity: qty,
 classification: determineClassification(mc, false),
 width: w, depth: d, height: h,
 pWidth: pw, pDepth: pd, pHeight: ph,
 accessories: [],
 notes: ''
 });
 }
 }

 console.log('[BOM DEBUG] Sheet kích thước:', dimSheet.name, '→ modules:', modulesMap.size);

 // ===== BƯỚC 2: Parse sheet phụ kiện → bổ sung accessories =====
 if (accSheet) {
 const accRaw: any[][] = XLSX.utils.sheet_to_json(workbook.Sheets[accSheet.name], { header: 1, defval: '' });
 const accHeaderIdx = accSheet.headerIdx;
 const accModuleCol = accSheet.moduleCol;
 const accHeaderRow = accRaw[accHeaderIdx] || [];

 // Find accessory start column
 let accStartCol = -1;
 for (let j = 0; j < accHeaderRow.length; j++) {
 const cell = String(accHeaderRow[j] || '').trim().toLowerCase();
 if (cell.includes('phụ kiện') && cell.includes('vật tư phụ')) { accStartCol = j; break; }
 }

 // Find accessory end column
 let accEndCol = -1;
 if (accStartCol >= 0) {
 accEndCol = accStartCol;
 for (let j = accStartCol + 1; j < accHeaderRow.length; j++) {
 const cell = String(accHeaderRow[j] || '').trim().toLowerCase();
 if (cell.includes('vật tư chính') || cell.includes('ghi chú')) { accEndCol = j - 1; break; }
 if (cell !== '') accEndCol = j;
 }
 }

 // Find cluster and qty columns
 let accClusterCol = -1, accQtyCol = -1;
 for (let j = 0; j < accHeaderRow.length; j++) {
 const cell = String(accHeaderRow[j] || '').trim().toLowerCase();
 if (accClusterCol === -1 && (cell === 'cụm' || cell.includes('cluster'))) accClusterCol = j;
 if (accQtyCol === -1 && (cell.includes('số lượng') || cell === 'sl' || cell.includes('tủ'))) accQtyCol = j;
 }

 if (accStartCol >= 0 && accEndCol >= accStartCol) {
 // Sub-header: accessory names
 let accSubIdx = accHeaderIdx + 1;
 const accSubRow = accRaw[accSubIdx] || [];
 if (!accSubRow.slice(accStartCol, accEndCol + 1).some(c => String(c || '').trim() !== '')) {
 accSubIdx = accHeaderIdx + 2;
 }
 const accSubDataRow = accRaw[accSubIdx] || [];
 const accNames: string[] = [];
 for (let j = accStartCol; j <= accEndCol; j++) {
 accNames.push(String(accSubDataRow[j] || '').replace(/[\r\n]+/g, ' ').trim());
 }

 let accDataStart = accSubIdx + 1;
 const firstAccVal = Number(accRaw[accDataStart]?.[accModuleCol]) || 0;
 if (firstAccVal > 0 && firstAccVal < 100 && !isNaN(firstAccVal)) accDataStart++;

 for (let i = accDataStart; i < accRaw.length; i++) {
 const row = accRaw[i];
 const mc = row[accModuleCol] ? String(row[accModuleCol]).trim() : '';
 if (!mc) continue;
 if (mc.toLowerCase().includes('vật tư') || mc.toLowerCase().includes('tên sơn') || mc.toLowerCase().includes('số lượng')) continue;

 const key = mc.toLowerCase();
 const accessories: any[] = [];
 for (let j = 0; j < accNames.length; j++) {
 const val = Number(row[accStartCol + j]) || 0;
 const name = accNames[j];
 if (name && val > 0) {
 const n = normalizeAccessoryName(name);
 if (n.includes('chi dan canh')) continue;
 accessories.push({ name, quantity: val, issuedQuantity: 0, status: 'Chưa xuất kho' });
 }
 }

 const matchingModules = Array.from(modulesMap.values()).filter((m: any) => m.moduleCode.toLowerCase() === key);
 if (matchingModules.length > 0) {
 matchingModules.forEach(target => {
 accessories.forEach(newAcc => {
 const existAcc = target.accessories.find((a: any) => a.name.toLowerCase() === newAcc.name.toLowerCase());
 if (existAcc) existAcc.quantity += newAcc.quantity;
 else target.accessories.push({ ...newAcc });
 });
 });
 } else if (accessories.length > 0) {
 modulesMap.set(key, {
 id: doc(collection(db, 'projectConfigs')).id,
 moduleCode: mc,
 cluster: accClusterCol >= 0 ? String(row[accClusterCol] || '').trim() : '',
 quantity: accQtyCol >= 0 ? Number(row[accQtyCol]) || 1 : 1,
 classification: determineClassification(mc, false),
 width: 0, depth: 0, height: 0,
 pWidth: 0, pDepth: 0, pHeight: 0,
 accessories,
 notes: 'Chỉ có trong Sheet phụ kiện'
 });
 }
 }

 console.log('[BOM DEBUG] Sau khi merge phụ kiện:', modulesMap.size, 'modules');
 }
 }

 const finalData = Array.from(modulesMap.values());

 // Backfill cluster: row không có cụm → kế thừa từ row liền trước
 let lastCluster = '';
 for (const row of finalData) {
 if (row.cluster && row.cluster.trim()) {
 lastCluster = row.cluster.trim();
 } else if (lastCluster) {
 row.cluster = lastCluster;
 }
 }

 if (finalData.length === 0) {
 alert("Không tìm thấy dữ liệu BOM hợp lệ!");
 return;
 }

 console.log('[BOM DEBUG] modules:', finalData.length, 'with dims:', finalData.filter(d => d.width || d.depth || d.height).length, 'sample:', finalData[0]?.moduleCode, finalData[0]?.width, finalData[0]?.depth, finalData[0]?.height, finalData[0]?.pWidth, finalData[0]?.pDepth, finalData[0]?.pHeight);
 setData(finalData);
 setStep(2);
 return;
 }

 // BOM / Parts / Standard flow below (legacy mapping UI)
 const s1Name = workbook.SheetNames[0];
 const s2Name = workbook.SheetNames.length > 1 ? workbook.SheetNames[1] : '';
 setSheet1Name(s1Name);
 setSheet2Name(s2Name);

 // Đọc dữ liệu thô để tự tìm Header và gợi ý mapping cho Sheet 1
 const ws1 = workbook.Sheets[s1Name];
 const data1: any[][] = XLSX.utils.sheet_to_json(ws1, { header: 1, defval: '' });
 
 let ws2Data: any[][] = [];
 if (s2Name) {
 const ws2 = workbook.Sheets[s2Name];
 ws2Data = XLSX.utils.sheet_to_json(ws2, { header: 1, defval: '' });
 }

 // Tự động gán cấu hình ánh xạ thông minh
 const s1Info = findHeaderRow(data1);
 setS1HeaderRow(s1Info.rowIndex + 1);
 const enrichedS1Headers = getEnrichedHeaders(data1, s1Info.rowIndex);
 setSheet1Headers(enrichedS1Headers);

 let clusterCol1 = '';
 let moduleCol1 = '';
 let qtyCol1 = '';
 let accStartCol1 = '';

 enrichedS1Headers.forEach((h) => {
 const lh = h.toLowerCase();
 if (!clusterCol1 && (lh.includes('cụm') || lh.includes('cluster') || lh.includes('tổ'))) {
 clusterCol1 = h;
 }
 if (!moduleCol1 && (lh.includes('module') || lh.includes('mã hiệu') || lh.includes('ký hiệu') || lh.includes('mã tủ') || lh.includes('tên tủ') || lh.includes('bản vẽ'))) {
 moduleCol1 = h;
 }
 if (!qtyCol1 && (lh.includes('số lượng') || lh.includes('sl') || lh.includes('qty') || lh.includes('tủ'))) {
 qtyCol1 = h;
 }
 if (!accStartCol1 && (lh.includes('phụ kiện') || lh.includes('vật tư phụ') || lh.includes('khóa') || lh.includes('bản lề') || lh.includes('chốt') || lh.includes('tay nắm'))) {
 accStartCol1 = h;
 }
 });

 setS1ClusterCol(clusterCol1 || enrichedS1Headers[0] || '');
 setS1ModuleCol(moduleCol1 || enrichedS1Headers[1] || '');
 setS1QuantityCol(qtyCol1 || enrichedS1Headers[2] || '');
 setS1AccessoriesStartCol(accStartCol1 || enrichedS1Headers[3] || '');

 if (ws2Data.length > 0) {
 const s2Info = findHeaderRow(ws2Data);
 setS2HeaderRow(s2Info.rowIndex + 1);
 const enrichedS2Headers = getEnrichedHeaders(ws2Data, s2Info.rowIndex);
 setSheet2Headers(enrichedS2Headers);

 let clusterCol2 = '';
 let moduleCol2 = '';
 let qtyCol2 = '';
 let dimCol2 = '';
 let packDimCol2 = '';
 let wCol = '', dCol = '', hCol = '';
 let pwCol = '', pdCol = '', phCol = '';

 enrichedS2Headers.forEach((h) => {
 const lh = h.toLowerCase();
 if (!clusterCol2 && (lh.includes('cụm') || lh.includes('cluster') || lh.includes('tổ'))) {
 clusterCol2 = h;
 }
 if (!moduleCol2 && (lh.includes('module') || lh.includes('mã') || lh.includes('ký hiệu') || lh.includes('mã tủ') || lh.includes('tên tủ'))) {
 moduleCol2 = h;
 }
 if (!qtyCol2 && (lh.includes('tổng số lượng') || lh.includes('tổng sl') || lh.includes('tổng cộng') || lh.includes('tổng qty'))) {
 qtyCol2 = h;
 }

 if (!dimCol2 && (lh.includes('kích thước tổng') || (lh.includes('kích thước') && !lh.includes('đóng gói') && !lh.includes('phủ bì') && !lh.includes('bao')) || lh.includes('kích thước thiết kế'))) {
 dimCol2 = h;
 }
 if (!packDimCol2 && (lh.includes('đóng gói') || lh.includes('phủ bì') || lh.includes('bao bì') || lh.includes('kích thước đg'))) {
 packDimCol2 = h;
 }

 if (lh === 'rộng' || lh === 'w' || lh === 'width' || lh === 'chiều rộng') wCol = h;
 if (lh === 'sâu' || lh === 'd' || lh === 'depth' || lh === 'chiều sâu') dCol = h;
 if (lh === 'cao' || lh === 'h' || lh === 'height' || lh === 'chiều cao') hCol = h;

 if (lh.includes('rộng đóng gói') || lh.includes('w_pack') || lh.includes('rộng phủ bì')) pwCol = h;
 if (lh.includes('sâu đóng gói') || lh.includes('d_pack') || lh.includes('sâu phủ bì')) pdCol = h;
 if (lh.includes('cao đóng gói') || lh.includes('h_pack') || lh.includes('cao phủ bì')) phCol = h;
 });

 setS2ClusterCol(clusterCol2 || enrichedS2Headers[0] || '');
 setS2ModuleCol(moduleCol2 || enrichedS2Headers[1] || '');
 setS2TotalQtyCol(qtyCol2 || enrichedS2Headers[2] || '');

 if (dimCol2) {
 setS2DimType('single');
 setS2DimSingleCol(dimCol2);
 } else if (wCol && dCol && hCol) {
 setS2DimType('separate');
 setS2WidthCol(wCol);
 setS2DepthCol(dCol);
 setS2HeightCol(hCol);
 } else {
 setS2DimType('single');
 const defaultDim = enrichedS2Headers.find(x => x.toLowerCase().includes('kích thước')) || '';
 setS2DimSingleCol(defaultDim);
 }

 if (packDimCol2) {
 setS2PackDimType('single');
 setS2PackDimSingleCol(packDimCol2);
 } else if (pwCol && pdCol && phCol) {
 setS2PackDimType('separate');
 setS2PackWidthCol(pwCol);
 setS2PackDepthCol(pdCol);
 setS2PackHeightCol(phCol);
 } else {
 setS2PackDimType('single');
 const defaultPack = enrichedS2Headers.find(x => x.toLowerCase().includes('đóng gói') || x.toLowerCase().includes('phủ bì')) || '';
 setS2PackDimSingleCol(defaultPack);
 }
 }

 // Nếu người dùng chọn loại Excel Cấu kiện (standard), cho chạy gộp trực tiếp luôn
 if (importType === 'parts_v2') {
  const s1Name = workbook.SheetNames[0];
  const ws = workbook.Sheets[s1Name];
  const rawData: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  const groupedMap = new Map<string, {
  name: string;
  width: number;
  depth: number;
  height: number;
  quantity: number;
  material: string;
  }>();

  rawData.forEach((row: any[]) => {
  if (!row || row.length < 13) return;

  // Mapping mới: C(2)=DÀI, d(3)=RỘNG, g(6)=DÀY, i(8)=VẬT LIỆU, M(12)=TÊN
  const width = Number(row[2]);
  const depth = Number(row[3]);
  const height = Number(row[6]);
  const material = String(row[8] || '').trim();
  const name = String(row[12] || '').trim();
  const quantity = 1;

  if (isNaN(width) || isNaN(depth) || isNaN(height) || name === '') return;
  if (!shouldImportPartV2(name)) return;

  const key = `${name.toLowerCase()}|${width}|${depth}|${height}`;
  const existing = groupedMap.get(key);
  if (existing) {
  existing.quantity += quantity;
  if (!existing.material && material) existing.material = material;
  } else {
  groupedMap.set(key, { name, width, depth, height, quantity, material });
  }
  });

  const tempMapped = Array.from(groupedMap.values()).map(item => {
  const entryId = doc(collection(db, 'projectConfigs')).id;
  const classification = determineClassification(item.name, false);
  return {
  id: entryId,
  cluster: 'Cấu kiện ngoài',
  moduleCode: item.name,
  quantity: item.quantity,
  classification,
  width: item.width,
  depth: item.depth,
  height: item.height,
  pWidth: item.width,
  pDepth: item.depth,
  pHeight: item.height,
  material: item.material,
  accessories: [],
  notes: 'Nhập từ Excel Cấu kiện mới (C/d/g/i/M)'
  } as any;
  });

  let mapped = [...tempMapped];
  if (selectedProjectCode) {
  try {
  setLoading(true);
  let existingModules: any[] = [];
  if (accumulatedData.length > 0) {
  existingModules = accumulatedData;
  } else {
  const snapshot = await getDocs(collection(db, 'projectConfigs', selectedProjectCode, 'modules'));
  existingModules = snapshot.docs.map(d => d.data());
  }
  mapped = tempMapped.map(item => {
  const match = existingModules.find(m => m.moduleCode && m.moduleCode.trim().toLowerCase() === item.moduleCode.trim().toLowerCase());
  return match ? { ...item, cluster: match.cluster || 'Cấu kiện ngoài' } : item;
  });
  } catch (err) {
  console.error("Lỗi tự động so khớp cụm:", err);
  } finally {
  setLoading(false);
  }
  }

  setData(backfillCluster(mapped));
  setStep(2);
  return;
 }

 if (importType === 'parts') {
 const s1Name = workbook.SheetNames[0];
 const ws = workbook.Sheets[s1Name];
 const rawData: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

 const groupedMap = new Map<string, {
 name: string;
 width: number;
 depth: number;
 height: number;
 quantity: number;
 material: string;
 }>();

 // Lưu toàn bộ raw data để lưu vào DB
 const allRawParts: any[] = [];

 rawData.forEach((row: any[]) => {
 if (!row || row.length < 6) return;

 const width = Number(row[0]);
 const depth = Number(row[1]);
 const height = Number(row[2]);
 const quantity = Number(row[3]);
 const material = String(row[4] || '').trim();
 const name = String(row[5] || '').trim();

 if (isNaN(width) || isNaN(depth) || isNaN(height) || isNaN(quantity) || quantity <= 0 || name === '') {
 return;
 }

 // Lưu toàn bộ raw data
 allRawParts.push({ width, depth, height, quantity, material, name });

  const classification = determineClassification(name, false);
  // Chỉ nhóm các module Cánh, Mặt HK, Đợt di động để import vào project
  if (classification !== 'Cánh' && classification !== 'Mặt HK' && classification !== 'Đợt di động') {
  return;
  }

  // Bỏ qua các cấu kiện không cần thiết
  const skipPartsPatterns = ["chặn", "mặt hỗ trợ", "mặt sau", "mặt trước", "mặt fix", "hk mặt"];
  if (skipPartsPatterns.some(p => name.trim().toLowerCase().includes(p))) {
  return;
  }

 const key = `${name.toLowerCase()}|${width}|${depth}|${height}`;
 const existing = groupedMap.get(key);
 if (existing) {
 existing.quantity += quantity;
 if (!existing.material && material) existing.material = material;
 } else {
 groupedMap.set(key, { name, width, depth, height, quantity, material });
 }
 });

 const tempMapped = Array.from(groupedMap.values()).map((item, idx) => {
 const entryId = doc(collection(db, 'projectConfigs')).id;
 const classification = determineClassification(item.name, false);
 return {
 id: entryId,
 cluster: 'Cấu kiện ngoài',
 moduleCode: item.name,
 quantity: item.quantity,
 classification,
 width: item.width,
 depth: item.depth,
 height: item.height,
 pWidth: item.width,
 pDepth: item.depth,
 pHeight: item.height,
 material: item.material,
 accessories: [],
 notes: 'Nhập từ Excel Cấu kiện chi tiết',
 // Chỉ lưu rawPartsData trên entry đầu tiên
 ...(idx === 0 ? { rawPartsData: allRawParts } : {})
 } as any;
 });

 let mapped = [...tempMapped];
 if (selectedProjectCode) {
  try {
  let existingModules: any[] = [];
  if (accumulatedData.length > 0) {
  existingModules = accumulatedData;
  } else {
  const snapshot = await getDocs(collection(db, 'projectConfigs', selectedProjectCode, 'modules'));
  existingModules = snapshot.docs.map(doc => doc.data());
  }
  mapped = tempMapped.map(item => {
  const cleanItemName = item.moduleCode.trim().toLowerCase();
  const match = existingModules.find(m => m.moduleCode && m.moduleCode.trim().toLowerCase() === cleanItemName);
  if (match) {
  return {
  ...item,
  cluster: match.cluster || 'Cấu kiện ngoài'
  };
  }
  return item;
  });
  } catch (err) {
  console.error("Lỗi tự động so khớp cụm:", err);
  }
 }

 setData(backfillCluster(mapped));
 setStep(2);
 }

 if (importType === 'standard') {
 const rows = data1.slice(1);
 const headers = data1[0];
 let lastCluster = '';
 const mapped = rows.flatMap((row: any[]) => {
 const currentCluster = row[0] ? String(row[0]).trim() : lastCluster;
 if (row[0]) lastCluster = currentCluster;

 const moduleCode = row[1] ? String(row[1]).trim() : '';
 const width = Number(row[2]) || 0;
 const depth = Number(row[3]) || 0;
 const height = Number(row[4]) || 0;
 const pWidth = Number(row[5]) || 0;
 const pDepth = Number(row[6]) || 0;
 const pHeight = Number(row[7]) || 0;
 const quantity = Number(row[8]) || 0;
 
 const accessories: any[] = [];
 let chotDotQty = 0;

 for (let i = 9; i < headers.length; i++) {
 const accHeader = headers[i];
 const accValue = Number(row[i]) || 0;
 
 if (accHeader && accValue > 0) {
 const accName = String(accHeader).replace(/[\r\n]+/g, ' ').trim();
 const normalized = normalizeAccessoryName(accName);
 
 if (normalized.includes('chot dot') || normalized.includes('cddd')) {
 chotDotQty += accValue;
 }

 const isShelfAcc = (normalized.includes('dot di dong')) &&
 !normalized.includes('chot');

 if (isShelfAcc) continue;

 accessories.push({
 name: accName,
 quantity: accValue,
 issuedQuantity: 0,
 status: 'Chưa xuất kho'
 });
 }
 }

 const parentId = doc(collection(db, 'projectConfigs')).id;
 const parentClass = determineClassification(moduleCode, false);

 const parentRow = {
 id: parentId,
 cluster: currentCluster,
 moduleCode,
 quantity,
 classification: parentClass,
 width,
 depth,
 height,
 pWidth,
 pDepth,
 pHeight,
 accessories,
 notes: ''
 };

 const results = [parentRow];

 const shelfQty = Math.floor(chotDotQty / 4);
 if (shelfQty > 0 && moduleCode) {
 const shelfModuleCode = makeShelfModuleCode(moduleCode);
 const shelfId = doc(collection(db, 'projectConfigs')).id;
 results.push({
 id: shelfId,
 parentId: '',
 parentModuleCode: '',
 cluster: currentCluster,
 moduleCode: shelfModuleCode,
 quantity: shelfQty,
 classification: 'Đợt',
 width: 0,
 depth: 0,
 height: 0,
 pWidth: 0,
 pDepth: 0,
 pHeight: 0,
 accessories: [],
 notes: `Tạo tự động từ chốt đợt di động của ${moduleCode}`
 } as any);
 }

 return results;
 }).filter(r => r.moduleCode && r.quantity > 0);

 setData(backfillCluster(mapped));
 setStep(2);
 }
 } catch (err: any) {
 setFileError(err.message || "Lỗi đọc tệp Excel. Vui lòng kiểm tra lại định dạng.");
 }
 };
 reader.readAsBinaryString(file);
 };

 const handleProcessAndPreview = async () => {
 if (!wb) {
 alert("Vui lòng chọn file Excel trước!");
 return;
 }

 try {
 if (importType === 'parts') {
 const s1Name = wb.SheetNames[0];
 const ws = wb.Sheets[s1Name];
 const rawData: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
 if (rawData.length < 2) {
 alert("File Excel trống hoặc không đủ dữ liệu dòng!");
 return;
 }

 const groupedMap = new Map<string, {
 name: string;
 width: number;
 depth: number;
 height: number;
 quantity: number;
 material: string;
 }>();

 rawData.forEach((row: any[]) => {
 if (!row || row.length < 6) return;

 // Thứ tự cột chuẩn: DÀI (row[0]), RỘNG (row[1]), DÀY (row[2]), SỐ LƯỢNG (row[3]), VẬT LIỆU (row[4]), TÊN (row[5])
 const width = Number(row[0]);
 const depth = Number(row[1]);
 const height = Number(row[2]);
 const quantity = Number(row[3]);
 const material = String(row[4] || '').trim();
 const name = String(row[5] || '').trim();

 if (isNaN(width) || isNaN(depth) || isNaN(height) || isNaN(quantity) || quantity <= 0 || name === '') {
 return; // skip headers or empty/invalid rows
 }

 if (!shouldImportPartV2(name)) {
 return; // skip
 }

 const key = `${name.toLowerCase()}|${width}|${depth}|${height}`;
 const existing = groupedMap.get(key);
 if (existing) {
 existing.quantity += quantity;
 if (!existing.material && material) {
 existing.material = material;
 }
 } else {
 groupedMap.set(key, {
 name,
 width,
 depth,
 height,
 quantity,
 material
 });
 }
 });

 const tempMapped = Array.from(groupedMap.values()).map(item => {
 const entryId = doc(collection(db, 'projectConfigs')).id;
 const classification = determineClassification(item.name, false);

 return {
 id: entryId,
 cluster: 'Cấu kiện ngoài',
 moduleCode: item.name,
 quantity: item.quantity,
 classification,
 width: item.width,
 depth: item.depth,
 height: item.height,
 pWidth: item.width,
 pDepth: item.depth,
 pHeight: item.height,
 material: item.material,
 accessories: [],
 notes: 'Nhập từ Excel Cấu kiện'
 } as any;
 });

 if (tempMapped.length === 0) {
 alert("Không tìm thấy dữ liệu cấu kiện hợp lệ!");
 return;
 }

 let mapped = [...tempMapped];
 if (selectedProjectCode) {
  try {
  setLoading(true);
  const snapshot = await getDocs(collection(db, 'projectConfigs', selectedProjectCode, 'modules'));
  const existingModules = snapshot.docs.map(doc => doc.data());
  mapped = tempMapped.map(item => {
  const cleanItemName = item.moduleCode.trim().toLowerCase();
  const match = existingModules.find(m => m.moduleCode && m.moduleCode.trim().toLowerCase() === cleanItemName);
  if (match) {
  return {
  ...item,
  cluster: match.cluster || 'Cấu kiện ngoài'
  };
  }
  return item;
  });
  } catch (err) {
  console.error("Lỗi tự động so khớp cụm:", err);
  } finally {
  setLoading(false);
  }
 }

  setData(backfillCluster(mapped));
  setStep(2);
  return;
  }

  if (importType === 'parts_v2') {
  const s1Name = wb.SheetNames[0];
  const ws = wb.Sheets[s1Name];
  const rawData: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  if (rawData.length < 2) {
  alert("File Excel trống hoặc không đủ dữ liệu dòng!");
  return;
  }

  const groupedMap = new Map<string, {
  name: string;
  width: number;
  depth: number;
  height: number;
  quantity: number;
  material: string;
  }>();

  rawData.forEach((row: any[]) => {
  if (!row || row.length < 13) return;

  // Thứ tự cột mới: C(index 2)=DÀI, d(index 3)=RỘNG, g(index 6)=DÀY, i(index 8)=VẬT LIỆU, M(index 12)=TÊN
  const width = Number(row[2]);
  const depth = Number(row[3]);
  const height = Number(row[6]);
  const material = String(row[8] || '').trim();
  const name = String(row[12] || '').trim();

  // Không có cột SỐ LƯỢNG riêng → mặc định 1
  const quantity = 1;

  if (isNaN(width) || isNaN(depth) || isNaN(height) || name === '') {
  return;
  }

  if (!shouldImportPartV2(name)) {
  return;
  }

  const key = `${name.toLowerCase()}|${width}|${depth}|${height}`;
  const existing = groupedMap.get(key);
  if (existing) {
  existing.quantity += quantity;
  if (!existing.material && material) {
  existing.material = material;
  }
  } else {
  groupedMap.set(key, {
  name,
  width,
  depth,
  height,
  quantity,
  material
  });
  }
  });

  const tempMapped = Array.from(groupedMap.values()).map(item => {
  const entryId = doc(collection(db, 'projectConfigs')).id;
  const classification = determineClassification(item.name, false);

  return {
  id: entryId,
  cluster: 'Cấu kiện ngoài',
  moduleCode: item.name,
  quantity: item.quantity,
  classification,
  width: item.width,
  depth: item.depth,
  height: item.height,
  pWidth: item.width,
  pDepth: item.depth,
  pHeight: item.height,
  material: item.material,
  accessories: [],
  notes: 'Nhập từ Excel Cấu kiện mới (C/d/g/i/M)'
  } as any;
  });

  if (tempMapped.length === 0) {
  alert("Không tìm thấy dữ liệu cấu kiện hợp lệ!");
  return;
  }

  let mapped = [...tempMapped];
  if (selectedProjectCode) {
  try {
  setLoading(true);
  const snapshot = await getDocs(collection(db, 'projectConfigs', selectedProjectCode, 'modules'));
  const existingModules = snapshot.docs.map(doc => doc.data());
  mapped = tempMapped.map(item => {
  const cleanItemName = item.moduleCode.trim().toLowerCase();
  const match = existingModules.find(m => m.moduleCode && m.moduleCode.trim().toLowerCase() === cleanItemName);
  if (match) {
  return {
  ...item,
  cluster: match.cluster || 'Cấu kiện ngoài'
  };
  }
  return item;
  });
  } catch (err) {
  console.error("Lỗi tự động so khớp cụm:", err);
  } finally {
  setLoading(false);
  }
  }

  setData(backfillCluster(mapped));
  setStep(2);
  return;
  }

  if (importType === 'standard') {
 // Tự động phân tích theo cấu trúc phẳng (1 sheet cũ)
 const s1Name = wb.SheetNames[0];
 const ws = wb.Sheets[s1Name];
 const jsonData: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
 if (jsonData.length < 2) {
 alert("File Excel trống hoặc không đủ dữ liệu dòng!");
 return;
 }

 const headers = jsonData[0];
 const rows = jsonData.slice(1);
 
 let lastCluster = '';
 const mapped = rows.flatMap((row: any[]) => {
 const currentCluster = row[0] ? String(row[0]).trim() : lastCluster;
 if (row[0]) lastCluster = currentCluster;

 const moduleCode = row[1] ? String(row[1]).trim() : '';
 const width = Number(row[2]) || 0;
 const depth = Number(row[3]) || 0;
 const height = Number(row[4]) || 0;
 const pWidth = Number(row[5]) || 0;
 const pDepth = Number(row[6]) || 0;
 const pHeight = Number(row[7]) || 0;
 const quantity = Number(row[8]) || 0;
 
 const accessories: any[] = [];
 let chotDotQty = 0;

 for (let i = 9; i < headers.length; i++) {
 const accHeader = headers[i];
 const accValue = Number(row[i]) || 0;
 
 if (accHeader && accValue > 0) {
 const accName = String(accHeader).replace(/[\r\n]+/g, ' ').trim();
 const normalized = normalizeAccessoryName(accName);
 
 if (normalized.includes('chot dot') || normalized.includes('cddd')) {
 chotDotQty += accValue;
 }

 const isShelfAcc = (normalized.includes('dot di dong')) &&
 !normalized.includes('chot');

 if (isShelfAcc) continue;

 accessories.push({
 name: accName,
 quantity: accValue,
 issuedQuantity: 0,
 status: 'Chưa xuất kho'
 });
 }
 }

 const parentId = doc(collection(db, 'projectConfigs')).id;
 const parentClass = determineClassification(moduleCode, false);

 const parentRow = {
 id: parentId,
 cluster: currentCluster,
 moduleCode,
 quantity,
 classification: parentClass,
 width,
 depth,
 height,
 pWidth,
 pDepth,
 pHeight,
 accessories,
 notes: ''
 };

 const results = [parentRow];

 const shelfQty = Math.floor(chotDotQty / 4);
 if (shelfQty > 0 && moduleCode) {
 const shelfModuleCode = makeShelfModuleCode(moduleCode);
 const shelfId = doc(collection(db, 'projectConfigs')).id;
 results.push({
 id: shelfId,
 parentId: '',
 parentModuleCode: '',
 cluster: currentCluster,
 moduleCode: shelfModuleCode,
 quantity: shelfQty,
 classification: 'Đợt',
 width: 0,
 depth: 0,
 height: 0,
 pWidth: 0,
 pDepth: 0,
 pHeight: 0,
 accessories: [],
 notes: `Tạo tự động từ chốt đợt di động của ${moduleCode}`
 } as any);
 }

 return results;
 }).filter(r => r.moduleCode && r.quantity > 0);

 if (mapped.length === 0) {
 alert("Không tìm thấy dữ liệu cấu kiện hợp lệ!");
 return;
 }

 setData(backfillCluster(mapped));
 setStep(2);
 } else {
 // CHẠY QUY TRÌNH BOM (2 SHEET) ĐỒNG BỘ ĐỘC QUYỀN
 if (!sheet1Name) {
 alert("Vui lòng chọn Sheet 1!");
 return;
 }

 const ws1 = wb.Sheets[sheet1Name];
 const data1: any[][] = XLSX.utils.sheet_to_json(ws1, { header: 1, defval: '' });
 
 let headerIndex1 = s1HeaderRow - 1;
 if (headerIndex1 < 0 || headerIndex1 >= data1.length) {
 alert("Dòng tiêu đề Sheet 1 không hợp lệ!");
 return;
 }

 const headers1 = getEnrichedHeaders(data1, headerIndex1);
 const rows1 = data1.slice(headerIndex1 + 1);

 const s1ClusterIdx = headers1.indexOf(s1ClusterCol);
 const s1ModuleIdx = headers1.indexOf(s1ModuleCol);
 const s1QtyIdx = headers1.indexOf(s1QuantityCol);
 const s1AccStartIdx = s1AccessoriesStartCol ? headers1.indexOf(s1AccessoriesStartCol) : -1;

 if (s1ModuleIdx === -1) {
 alert(`Không tìm thấy cột Module "${s1ModuleCol}" trong Sheet 1!`);
 return;
 }

 // Tạo Map gốc từ Sheet 1 (Lấy Cụm, Module, Số lượng và Phụ kiện)
 const s1Map = new Map<string, any>();
 let lastCluster1 = '';

 rows1.forEach((row) => {
 const rawModuleCode = row[s1ModuleIdx] ? String(row[s1ModuleIdx]).trim() : '';
 if (!rawModuleCode) return;

 const currentCluster = (s1ClusterIdx !== -1 && row[s1ClusterIdx]) 
 ? String(row[s1ClusterIdx]).trim() 
 : lastCluster1;
 if (s1ClusterIdx !== -1 && row[s1ClusterIdx]) {
 lastCluster1 = currentCluster;
 }

 const quantity = (s1QtyIdx !== -1 && row[s1QtyIdx]) ? (Number(row[s1QtyIdx]) || 1) : 1;

 // Đọc phụ kiện vật tư phụ kèm theo
 const accessories: any[] = [];
 if (s1AccStartIdx !== -1) {
 for (let i = s1AccStartIdx; i < headers1.length; i++) {
 const accName = headers1[i];
 if (!accName) continue;

 // Chỉ đọc nếu cột phụ kiện được người dùng tích chọn
 if (!selectedAccessoryCols.includes(accName)) continue;

 const accValue = Number(row[i]) || 0;
 if (accValue > 0) {
 const cleanedAccName = String(accName).replace(/[\r\n]+/g, ' ').trim();
 accessories.push({
 name: cleanedAccName,
 quantity: accValue,
 issuedQuantity: 0,
 status: 'Chưa xuất kho'
 });
 }
 }
 }

 const normCode = rawModuleCode.toLowerCase().replace(/\s/g, '');
 if (s1Map.has(normCode)) {
 const existing = s1Map.get(normCode);
 // Cộng dồn số lượng tủ của Module này
 existing.quantity += quantity;
 // Gộp danh sách phụ kiện
 accessories.forEach((newAcc) => {
 const existingAcc = existing.accessories.find((a: any) => a.name === newAcc.name);
 if (existingAcc) {
 existingAcc.quantity += newAcc.quantity;
 } else {
 existing.accessories.push(newAcc);
 }
 });
 } else {
 s1Map.set(normCode, {
 id: doc(collection(db, 'projectConfigs')).id,
 cluster: currentCluster,
 moduleCode: rawModuleCode,
 quantity,
 classification: determineClassification(rawModuleCode, false),
 width: 0,
 depth: 0,
 height: 0,
 pWidth: 0,
 pDepth: 0,
 pHeight: 0,
 accessories,
 notes: ''
 });
 }
 });

 // Đọc dữ liệu từ Sheet 2 (Lấy Kích thước tổng, kích thước đóng gói, tổng số lượng)
 const s2Map = new Map<string, any>();
 if (sheet2Name) {
 const ws2 = wb.Sheets[sheet2Name];
 const data2: any[][] = XLSX.utils.sheet_to_json(ws2, { header: 1, defval: '' });
 let headerIndex2 = s2HeaderRow - 1;
 
 if (headerIndex2 >= 0 && headerIndex2 < data2.length) {
 const headers2 = getEnrichedHeaders(data2, headerIndex2);
 const rows2 = data2.slice(headerIndex2 + 1);

 const s2ClusterIdx = headers2.indexOf(s2ClusterCol);
 const s2ModuleIdx = headers2.indexOf(s2ModuleCol);
 const s2TotalQtyIdx = headers2.indexOf(s2TotalQtyCol);

 // Kích thước tổng
 const s2WidthIdx = headers2.indexOf(s2WidthCol);
 const s2DepthIdx = headers2.indexOf(s2DepthCol);
 const s2HeightIdx = headers2.indexOf(s2HeightCol);
 const s2DimSingleIdx = headers2.indexOf(s2DimSingleCol);

 // Kích thước đóng gói
 const s2PackWidthIdx = headers2.indexOf(s2PackWidthCol);
 const s2PackDepthIdx = headers2.indexOf(s2PackDepthCol);
 const s2PackHeightIdx = headers2.indexOf(s2PackHeightCol);
 const s2PackDimSingleIdx = headers2.indexOf(s2PackDimSingleCol);

 if (s2ModuleIdx === -1) {
 alert(`Không tìm thấy cột Module/Tên tủ "${s2ModuleCol}" ở Sheet 2!`);
 return;
 }

 let lastCluster2 = '';

 rows2.forEach((row) => {
 const rawModuleCode = row[s2ModuleIdx] ? String(row[s2ModuleIdx]).trim() : '';
 if (!rawModuleCode) return;

 const normCode = rawModuleCode.toLowerCase().replace(/\s/g, '');

 const currentCluster = (s2ClusterIdx !== -1 && row[s2ClusterIdx])
 ? String(row[s2ClusterIdx]).trim()
 : lastCluster2;
 if (s2ClusterIdx !== -1 && row[s2ClusterIdx]) {
 lastCluster2 = currentCluster;
 }

 const totalQty = (s2TotalQtyIdx !== -1 && row[s2TotalQtyIdx]) ? (Number(row[s2TotalQtyIdx]) || 1) : 1;

 // Parsing dimensions
 let w = 0, d = 0, h = 0;
 if (s2DimType === 'separate' && s2WidthIdx !== -1 && s2DepthIdx !== -1 && s2HeightIdx !== -1) {
 w = Number(row[s2WidthIdx]) || 0;
 d = Number(row[s2DepthIdx]) || 0;
 h = Number(row[s2HeightIdx]) || 0;
 } else if (s2DimType === 'single' && s2DimSingleIdx !== -1) {
 const parsed = parseDimensions(String(row[s2DimSingleIdx]));
 w = parsed.w;
 d = parsed.d;
 h = parsed.h;
 }

 // Parsing packing dimensions
 let pw = 0, pd = 0, ph = 0;
 if (s2PackDimType === 'separate' && s2PackWidthIdx !== -1 && s2PackDepthIdx !== -1 && s2PackHeightIdx !== -1) {
 pw = Number(row[s2PackWidthIdx]) || 0;
 pd = Number(row[s2PackDepthIdx]) || 0;
 ph = Number(row[s2PackHeightIdx]) || 0;
 } else if (s2PackDimType === 'single' && s2PackDimSingleIdx !== -1) {
 const parsed = parseDimensions(String(row[s2PackDimSingleIdx]));
 pw = parsed.w;
 pd = parsed.d;
 ph = parsed.h;
 }

 if (s2Map.has(normCode)) {
 const existing = s2Map.get(normCode);
 existing.totalQty += totalQty;
 if (!existing.width && w) existing.width = w;
 if (!existing.depth && d) existing.depth = d;
 if (!existing.height && h) existing.height = h;
 if (!existing.pWidth && pw) existing.pWidth = pw;
 if (!existing.pDepth && pd) existing.pDepth = pd;
 if (!existing.pHeight && ph) existing.pHeight = ph;
 } else {
 s2Map.set(normCode, {
 cluster: currentCluster,
 moduleCode: rawModuleCode,
 totalQty,
 width: w,
 depth: d,
 height: h,
 pWidth: pw,
 pDepth: pd,
 pHeight: ph
 });
 }
 });
 }
 }

 // Đồng bộ 2 sheet và tạo dữ liệu phẳng để xem trước
 const finalData: any[] = [];

 // 1. Đồng bộ các module có trong Sheet 1
 s1Map.forEach((m1, normCode) => {
 const m2 = s2Map.get(normCode);
 if (m2) {
 m1.width = m2.width || m1.width;
 m1.depth = m2.depth || m1.depth;
 m1.height = m2.height || m1.height;
 m1.pWidth = m2.pWidth || m1.pWidth;
 m1.pDepth = m2.pDepth || m1.pDepth;
 m1.pHeight = m2.pHeight || m1.pHeight;
 if (m2.totalQty) m1.quantity = m2.totalQty;
 if (m2.cluster) m1.cluster = m2.cluster;
 }
 finalData.push(m1);
 });

 // 2. Thêm các module chỉ có trong Sheet 2 (nếu có để bảo đảm trọn vẹn)
 s2Map.forEach((m2, normCode) => {
 if (!s1Map.has(normCode)) {
 finalData.push({
 id: doc(collection(db, 'projectConfigs')).id,
 cluster: m2.cluster,
 moduleCode: m2.moduleCode,
 quantity: m2.totalQty || 1,
 classification: determineClassification(m2.moduleCode, false),
 width: m2.width,
 depth: m2.depth,
 height: m2.height,
 pWidth: m2.pWidth,
 pDepth: m2.pDepth,
 pHeight: m2.pHeight,
 accessories: [],
 notes: 'Chỉ có trong Sheet 2 kích thước'
 });
 }
 });

 if (finalData.length === 0) {
 alert("Không khớp được dữ liệu nào từ 2 sheet! Xin vui lòng kiểm tra lại cấu hình ánh xạ.");
 return;
 }

 setData(backfillCluster(finalData));
 setStep(2);
 }
 } catch (err: any) {
 alert("Lỗi phân tích & gộp dữ liệu: " + (err.message || String(err)));
 }
 };


 const handleImport = async () => {
  if (!user || filteredData.length === 0 || !projectInfo.name || !projectInfo.code) return;
  setLoading(true);
  
  try {
  let existingDocs: any[] = [];
  let targetProjectCode = '';

  if (importMode === 'update' && selectedProjectCode) {
  targetProjectCode = selectedProjectCode;
  const snapshot = await getDocs(collection(db, 'projectConfigs', targetProjectCode, 'modules'));
  existingDocs = snapshot.docs;
  } else {
  // Mode new: Check for existing project with same code to avoid duplicates
  try {
  const configSnap = await getDoc(doc(db, 'projectConfigs', projectInfo.code));
  if (configSnap.exists()) {
  existingDocs = [];
  targetProjectCode = projectInfo.code;
  } else {
  existingDocs = [];
  targetProjectCode = projectInfo.code;
  }
  } catch {
  targetProjectCode = projectInfo.code;
  }
  }

  const batch = writeBatch(db);

  // Write project config parent doc
  const rawPartsData = data.length > 0 && data[0].rawPartsData ? data[0].rawPartsData : [];
  const displayLabel = userProfile?.ten_that ? `${userProfile.ten_that} (${userProfile.chuc_danh || 'NV'})` : (user?.displayName || 'Anonymous');
  await setDoc(doc(db, 'projectConfigs', targetProjectCode), {
  projectName: projectInfo.name,
  projectCode: targetProjectCode,
  glbUrl: projectInfo.glbUrl || '',
  drawingUrl: projectInfo.drawingUrl || '',
  assemblyDrawingUrl: projectInfo.assemblyDrawingUrl || '',
  rawPartsData,
  createdAt: serverTimestamp(),
  createdBy: displayLabel
  }, { merge: true });

  // Lưu trữ cấu kiện cũ để bảo toàn STT nếu trùng mã
  const oldModulesMap = new Map<string, any>();
  const oldModuleDocsRefMap = new Map<string, string>();

  existingDocs.forEach((docSnap) => {
  const d = docSnap.data();
  if (d.moduleCode) {
 const keyClean = (importType === 'parts' || importType === 'parts_v2')
   ? `${d.moduleCode.trim().toLowerCase()}|${d.width || 0}|${d.depth || 0}|${d.height || 0}`
   : (importType === 'accessories_update' || importType === 'bom')
     ? getModuleUniqueKey(d)
     : d.moduleCode.trim().toLowerCase();
  oldModulesMap.set(keyClean, d);
  oldModuleDocsRefMap.set(keyClean, docSnap.id);
  }
  });

  // 1. Delete existing entries if any (Chỉ xóa trắng nếu KHÔNG phải import cấu kiện chi tiết - parts, parts_v2 và accessories_update)
  if (importType !== 'parts' && importType !== 'parts_v2' && importType !== 'accessories_update') {
  existingDocs.forEach((docSnap) => {
  batch.delete(docSnap.ref);
  });
  }

  // Special case: accessories_update (EXCEL BOM) — chép đè module có sẵn, tạo mới nếu chưa tồn tại
  if (importType === 'accessories_update') {
  let updatedCount = 0;
  let createdCount = 0;
  let deletedCount = 0;

  for (const row of filteredData) {
   const moduleCode = row.moduleCode ? row.moduleCode.trim() : '';
   if (!moduleCode) continue;

   const uniqueKey = getModuleUniqueKey(row);
   const existingDocId = oldModuleDocsRefMap.get(uniqueKey);
   const oldModule = oldModulesMap.get(uniqueKey);

   if (existingDocId) {
  // Chép đè thông tin từ Excel, giữ nguyên QC/status/instances
  const docRef = doc(db, 'projectConfigs', targetProjectCode, 'modules', existingDocId);
  const existingInstances = oldModule?.instances || [];
  const qty = row.quantity || oldModule?.quantity || 1;

  const instancesList = [];
  for (let i = 1; i <= qty; i++) {
   const oldInst = existingInstances.find((inst: any) => inst.instanceIndex === i);
   instancesList.push({
   id: `${moduleCode}|${i}`,
   instanceId: `${moduleCode}|${i}`,
   instanceIndex: i,
   tempLabelIndex: i,
   stt: oldInst?.stt || null,
   qcDone: oldInst?.qcDone || false,
   delivered: oldInst?.delivered || false,
   qcLogs: oldInst?.qcLogs || [],
   deliveryLogs: oldInst?.deliveryLogs || [],
   qcWhite: oldInst?.qcWhite || null,
   qcPaint: oldInst?.qcPaint || null,
   qcFinish: oldInst?.qcFinish || null,
   qcPack: oldInst?.qcPack || null,
   });
  }

  batch.update(docRef, {
   cluster: row.cluster || oldModule?.cluster || '',
   moduleCode: moduleCode,
   quantity: qty,
   width: row.width || oldModule?.width || 0,
   depth: row.depth || oldModule?.depth || 0,
   height: row.height || oldModule?.height || 0,
   pWidth: row.pWidth || oldModule?.pWidth || 0,
   pDepth: row.pDepth || oldModule?.pDepth || 0,
   pHeight: row.pHeight || oldModule?.pHeight || 0,
   accessories: row.accessories || oldModule?.accessories || [],
   classification: row.classification || oldModule?.classification || '',
   material: row.material || oldModule?.material || '',
   sortIndex: oldModule?.sortIndex !== undefined ? oldModule.sortIndex : updatedCount + createdCount,
   instances: instancesList,
   maxLabelIndex: qty,
  });
  updatedCount++;
   } else {
  // Tạo mới module nếu chưa tồn tại
  const newDocId = doc(collection(db, 'projectConfigs', targetProjectCode, 'modules')).id;
  const docRef = doc(db, 'projectConfigs', targetProjectCode, 'modules', newDocId);
  const qty = row.quantity || 1;

  const instancesList = [];
  for (let i = 1; i <= qty; i++) {
   instancesList.push({
   id: `${moduleCode}|${i}`,
   instanceId: `${moduleCode}|${i}`,
   instanceIndex: i,
   tempLabelIndex: i,
   stt: null,
   qcDone: false,
   delivered: false,
   qcLogs: [],
   deliveryLogs: [],
   });
  }

  batch.set(docRef, {
   projectName: projectInfo.name,
   projectCode: targetProjectCode,
   drawingUrl: projectInfo.drawingUrl || '',
   assemblyDrawingUrl: projectInfo.assemblyDrawingUrl || '',
   glbUrl: projectInfo.glbUrl || '',
   cluster: row.cluster || '',
   moduleCode: moduleCode,
   quantity: qty,
   width: row.width || 0,
   depth: row.depth || 0,
   height: row.height || 0,
   pWidth: row.pWidth || 0,
   pDepth: row.pDepth || 0,
   pHeight: row.pHeight || 0,
   accessories: row.accessories || [],
   classification: row.classification || '',
   material: row.material || '',
   status: '',
   statusHistory: [],
   ownerId: user.uid,
   notes: '',
   createdAt: serverTimestamp(),
   sortIndex: updatedCount + createdCount,
   instances: instancesList,
   maxLabelIndex: qty,
   moduleType: 'normal',
  });
  createdCount++;
   }
  }

  // Xóa module cũ không có trong Excel mới (trừ loại được bảo vệ & loại bị exclude)
  // Tạo set các moduleCode có trong Excel mới
  const newExcelKeys = new Set(
    filteredData.map(r => getModuleUniqueKey(r))
  );
  for (const docSnap of existingDocs) {
    const d = docSnap.data();
    const key = getModuleUniqueKey(d);
    if (!key) continue;
    // Nếu module này có trong Excel mới → đã xử lý ở trên, bỏ qua
    if (newExcelKeys.has(key)) continue;
    // Nếu là loại cấu kiện "có cha" (được bảo vệ) → giữ nguyên
    const cls = d.classification || determineClassification(d.moduleCode || '', false);
    if (PROTECTED_CLASSIFICATIONS.has(cls)) continue;
    // Nếu người dùng loại trừ → giữ nguyên
    const codeOnly = (d.moduleCode || '').trim().toLowerCase();
    if (excludedModules.has(key) || excludedModules.has(codeOnly)) continue;
    // Xóa
    batch.delete(docSnap.ref);
    deletedCount++;
  }

  await batch.commit();

  await addDoc(collection(db, 'activities'), {
  userId: user.uid,
  userName: displayLabel,
  userEmail: user.email,
  action: 'Cập nhật Excel BOM',
  details: `Cập nhật Excel BOM: ${updatedCount} cập nhật, ${createdCount} mới, ${deletedCount} xóa`,
  projectCode: targetProjectCode,
  timestamp: serverTimestamp()
  });

  alert(`Cập nhật Excel BOM thành công!\n- Đã cập nhật: ${updatedCount} module\n- Đã tạo mới: ${createdCount} module\n- Đã xóa: ${deletedCount} module`);
  resetToFileSelection(targetProjectCode, { name: projectInfo.name, code: targetProjectCode, drawingUrl: projectInfo.drawingUrl, assemblyDrawingUrl: projectInfo.assemblyDrawingUrl, glbUrl: projectInfo.glbUrl });
  return;
  }

  // 2. Delete old modules only for bom/standard (parts and parts_v2 keeps existing modules, merges via oldModulesMap below)
  if (importType !== 'parts' && importType !== 'parts_v2') {
    const oldModulesSnap = await getDocs(collection(db, 'projectConfigs', targetProjectCode, 'modules'));
    if (!oldModulesSnap.empty) {
      oldModulesSnap.docs.forEach(modDoc => batch.delete(modDoc.ref));
    }
  }

  // 3. Add new/update entries
  filteredData.forEach((row, idx) => {
 const cleanModCode = (importType === 'parts' || importType === 'parts_v2')
   ? `${row.moduleCode ? row.moduleCode.trim().toLowerCase() : ''}|${row.width || 0}|${row.depth || 0}|${row.height || 0}`
   : (row.moduleCode ? row.moduleCode.trim().toLowerCase() : '');
  let entryId = row.id;

  if ((importType === 'parts' || importType === 'parts_v2') && oldModuleDocsRefMap.has(cleanModCode)) {
  entryId = oldModuleDocsRefMap.get(cleanModCode)!;
  } else if (!entryId) {
  entryId = doc(collection(db, 'projectConfigs', targetProjectCode, 'modules')).id;
  }

  const docRef = doc(db, 'projectConfigs', targetProjectCode, 'modules', entryId);
  
  const oldModule = oldModulesMap.get(cleanModCode);
 const qty = ((importType === 'parts' || importType === 'parts_v2') && oldModule)
   ? Math.max(row.quantity || 1, oldModule.quantity || 0)
   : (row.quantity || 1);
  const oldModuleType = oldModule?.moduleType || 'normal';
  let finalModuleStt = oldModule?.stt || null;

  const instancesList = [];
  for (let i = 1; i <= qty; i++) {
  const oldInst = oldModule?.instances?.find((inst: any) => inst.instanceIndex === i);
  let assignedStt = oldInst?.stt || null;

  instancesList.push({
  id: `${row.moduleCode}|${i}`,
  instanceId: `${row.moduleCode}|${i}`,
  instanceIndex: i,
  tempLabelIndex: i,
  stt: assignedStt,
  qcDone: oldInst?.qcDone || false,
  delivered: oldInst?.delivered || false,
  qcLogs: oldInst?.qcLogs || [],
  deliveryLogs: oldInst?.deliveryLogs || []
  });
  }
  
  const mergedAccessories = (row.accessories || []).map((newAcc: any) => {
  const oldAcc = oldModule?.accessories?.find((oa: any) => oa.name === newAcc.name);
  if (oldAcc) {
  return {
  ...newAcc,
  issuedQuantity: oldAcc.issuedQuantity !== undefined ? oldAcc.issuedQuantity : newAcc.issuedQuantity,
  status: oldAcc.status || newAcc.status
  };
  }
  return newAcc;
  });

  const payload: any = {
  projectName: projectInfo.name,
  projectCode: targetProjectCode,
  drawingUrl: projectInfo.drawingUrl || '',
  assemblyDrawingUrl: projectInfo.assemblyDrawingUrl || '',
  glbUrl: projectInfo.glbUrl || '',
  cluster: row.cluster,
  moduleCode: row.moduleCode,
  quantity: qty,
  classification: row.classification || '',
  parentId: row.parentId || '',
  parentModuleCode: row.parentModuleCode || '',
  width: row.width || 0,
  depth: row.depth || 0,
  height: row.height || 0,
  pWidth: row.pWidth || 0,
  pDepth: row.pDepth || 0,
  pHeight: row.pHeight || 0,
  accessories: mergedAccessories,
  status: oldModule?.status || '',
  statusHistory: oldModule?.statusHistory || [],
  ownerId: row.notes ? 'system_shelf' : user.uid,
  notes: row.notes || '',
  createdAt: oldModule?.createdAt || serverTimestamp(),
  sortIndex: oldModule?.sortIndex !== undefined ? oldModule.sortIndex : idx,
  instances: instancesList,
  maxLabelIndex: qty,
  moduleType: oldModuleType,
  material: row.material || ''
  };

  if (oldModuleType === 'bo') {
  payload.stt = finalModuleStt;
  }

  // parts import: merge để giữ nguyên receivedQuantity, shippedQuantity, QC fields...
  // bom/standard: ghi đè toàn bộ (xóa cũ rồi thêm mới)
  batch.set(docRef, payload, (importType === 'parts' || importType === 'parts_v2') ? { merge: true } : undefined);
  });

  await batch.commit();

  // Log activity
  await addDoc(collection(db, 'activities'), {
  userId: user.uid,
  userName: displayLabel,
  userEmail: user.email,
  action: existingDocs.length === 0 ? 'Nhập Excel Dự Án' : 'Cập nhật Dự Án (Ghi đè)',
   details: `${existingDocs.length === 0 ? 'Tạo' : 'Cập nhật'} dự án: ${projectInfo.name} (${projectInfo.code}) | ${filteredData.length} module${filteredData.length !== data.length ? ` (lọc từ ${data.length})` : ''}`,
  projectCode: targetProjectCode,
  timestamp: serverTimestamp()
  });

  resetToFileSelection(targetProjectCode, { name: projectInfo.name, code: targetProjectCode, drawingUrl: projectInfo.drawingUrl, assemblyDrawingUrl: projectInfo.assemblyDrawingUrl, glbUrl: projectInfo.glbUrl });
  } catch (error) {
  handleFirestoreError(error, OperationType.CREATE, 'projectConfigs');
  } finally {
  setLoading(false);
  }
 };

 return (
 <div
 className="space-y-6 pb-24 lg:pb-8"
 id="excel-import-view"
 >
 {/* Content Header */}
 <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
 <div>
 <h1 className="text-3xl font-black text-slate-900 uppercase tracking-tight">Nhập Dữ Liệu Excel</h1>
 <p className="text-sm font-bold text-slate-400 uppercase tracking-widest mt-1">Khai báo dự án mới từ file bảng tính</p>
 </div>
 <button onClick={step === 1 ? onComplete : () => resetToFileSelection()} className="px-5 py-2.5 bg-slate-100 text-slate-600 rounded-lg text-[11px] font-black uppercase tracking-widest transition-all hover:bg-slate-200 flex items-center">
 <ArrowLeft size={16} className="mr-2" /> {step === 1 ? 'QUAY LẠI' : 'QUAY LẠI CHỌN FILE'}
 </button>
 </div>

 <div className={`bg-white rounded-lg border border-slate-200 mx-auto shadow-none overflow-hidden transition-all duration-300 ${step === 1 ? 'max-w-2xl' : 'max-w-6xl w-full'}`}>
 <div className="px-6 py-4 border-b border-slate-100 bg-slate-100">
 <h3 className="text-[10px] font-black uppercase text-slate-400 tracking-[0.2em]">
 {step === 1 ? (accumulatedSources.length > 0 ? 'Bước 2: Chọn File Excel Cấu Kiện' : 'Bước 1: Chọn File Excel BOM') : importType === 'accessories_update' ? 'Bước 2: Xác Nhận Cập Nhật Excel BOM' : 'Bước 2: Xem Trước & Xác Nhận'}
 </h3>
 </div>

 {step === 1 ? (
 <div className="p-8 lg:p-12 space-y-8">
 <div className="flex flex-col md:flex-row items-center gap-6 pb-6 border-b border-slate-100">
 <div className="w-16 h-16 bg-emerald-100 rounded-lg flex items-center justify-center text-emerald-600 border border-emerald-100 shrink-0">
 <FileSpreadsheet size={32} />
 </div>
 <div className="text-center md:text-left">
 <h3 className="text-lg font-black text-slate-900 uppercase tracking-tight">Khai báo / Nhập dữ liệu dự án</h3>
 <p className="text-xs font-bold text-slate-400 mt-1 italic uppercase tracking-widest">
  {accumulatedSources.length > 0 ? 'Bước 2: Nhập Excel cấu kiện chi tiết (Chức năng 2 hoặc 3)' : 'Bước 1: Nhập Excel BOM (Chức năng 1)'}
 </p>
 </div>
 </div>

 {/* Hiển thị dữ liệu đã tích lũy — Wizard Progress */}
 {accumulatedSources.length > 0 && (
  <div className="bg-indigo-100 border border-indigo-200 rounded-lg p-4 space-y-2">
   <div className="flex items-center gap-3">
    <CheckCircle size={16} className="text-indigo-600 shrink-0" />
    <span className="text-[11px] font-black uppercase tracking-wider text-indigo-700">
     Đã hoàn thành bước 1 — {accumulatedData.length} cấu kiện đã nhập
    </span>
   </div>
   <div className="flex flex-wrap gap-2">
    {accumulatedSources.map((src, idx) => (
     <div key={idx} className="flex items-center gap-1.5 bg-white border border-indigo-200 rounded-lg px-2.5 py-1 text-[10px]">
      <CheckCircle size={10} className="text-indigo-500" />
      <span className="font-bold text-indigo-700">{src.label}</span>
      <span className="text-slate-400">·</span>
      <span className="font-mono text-indigo-600">{src.count} module</span>
      <button
       type="button"
       onClick={() => removeAccumulatedSource(idx)}
       className="ml-1 p-0.5 hover:bg-rose-100 text-slate-400 hover:text-rose-600 rounded cursor-pointer"
      >
       <X size={11} />
      </button>
     </div>
    ))}
   </div>
   <p className="text-[10px] text-indigo-500 font-bold">
     Bây giờ hãy chọn <strong>Chức năng 2</strong> hoặc <strong>Chức năng 3</strong> để nhập thêm Excel cấu kiện chi tiết.
   </p>
  </div>
 )}

 {/* Type selector */}
 <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
 <div 
 onClick={() => {
 setImportType('bom');
 setWb(null);
 setSheetsList([]);
 }}
 className={`p-5 rounded-lg border-2 cursor-pointer transition-all ${importType === 'bom' ? 'border-emerald-500 bg-emerald-100/20' : 'border-slate-100 hover:border-slate-200 hover:bg-slate-100'}`}
 >
 <div className="flex items-center justify-between mb-2">
 <span className="text-[11px] font-black uppercase tracking-wider text-slate-800 font-bold">1. NHẬP EXCEL BOM (2 SHEET)</span>
 <input type="radio" checked={importType === 'bom'} onChange={() => {}} className="accent-emerald-600" />
 </div>
 <p className="text-xs text-slate-500 leading-relaxed font-bold">
 Thiết lập cấu trúc ánh xạ để nhập dự án mới:
 </p>
 <ul className="text-[10px] text-slate-400 mt-2 list-disc list-inside space-y-1 font-bold">
 <li>Sheet 1: Cụm, Module, Số lượng tủ, Phụ kiện vật tư phụ</li>
 <li>Sheet 2: Cụm, Module, Kích thước tổng, Kích thước đóng gói...</li>
 <li>Tự động đồng bộ và gộp dữ liệu nếu trùng tên Module (hàng loạt)</li>
 </ul>
 </div>

 <div 
 onClick={() => {
 setImportType('parts');
 setWb(null);
 setSheetsList([]);
 if (accumulatedSources.length > 0 && projectInfo.code) {
   setSelectedProjectCode(projectInfo.code);
 }
 }}
 className={`p-5 rounded-lg border-2 cursor-pointer transition-all ${importType === 'parts' ? 'border-emerald-500 bg-emerald-100/20' : 'border-slate-100 hover:border-slate-200 hover:bg-slate-100'}`}
 >
 <div className="flex items-center justify-between mb-2">
 <span className="text-[11px] font-black uppercase tracking-wider text-slate-800 font-bold">2. EXCEL CẤU KIỆN CHI TIẾT</span>
 <input type="radio" checked={importType === 'parts'} onChange={() => {}} className="accent-emerald-600" />
 </div>
 <p className="text-xs text-slate-500 leading-relaxed font-bold">
 Khai báo cấu kiện chi tiết theo thứ tự cột cố định: DÀI, RỘNG, DÀY, SỐ LƯỢNG, VẬT LIỆU, TÊN.
 </p>
 <ul className="text-[10px] text-slate-400 mt-2 list-disc list-inside space-y-1 font-bold">
 <li>Tự động cộng dồn số lượng nếu cùng tên và cùng kích thước.</li>
 <li>Tự động bỏ qua các tấm khung (Nóc_, Hậu_, Đáy_, Chặn cánh_, Giằng nóc_, Hông trái_, Hông phải_, Mặt_).</li>
 </ul>
 </div>

 <div
 onClick={() => {
 setImportType('parts_v2');
 setWb(null);
 setSheetsList([]);
 if (accumulatedSources.length > 0 && projectInfo.code) {
   setSelectedProjectCode(projectInfo.code);
 }
 }}
 className={`p-5 rounded-lg border-2 cursor-pointer transition-all ${importType === 'parts_v2' ? 'border-emerald-500 bg-emerald-100/20' : 'border-slate-100 hover:border-slate-200 hover:bg-slate-100'}`}
 >
 <div className="flex items-center justify-between mb-2">
 <span className="text-[11px] font-black uppercase tracking-wider text-slate-800 font-bold">3. EXCEL CẤU KIỆN MỚI</span>
 <input type="radio" checked={importType === 'parts_v2'} onChange={() => {}} className="accent-emerald-600" />
 </div>
 <p className="text-xs text-slate-500 leading-relaxed font-bold">
 Ánh xạ theo cột cố định: C→DÀI, d→RỘNG, g→DÀY, i→VẬT LIỆU, M→TÊN.
 </p>
 <ul className="text-[10px] text-slate-400 mt-2 list-disc list-inside space-y-1 font-bold">
 <li>Tự động cộng dồn số lượng nếu cùng tên và cùng kích thước.</li>
 <li>Tự động bỏ qua các tấm khung.</li>
 </ul>
 </div>

 <div 
 onClick={() => {
 setImportType('accessories_update');
 setWb(null);
 setSheetsList([]);
 }}
 className={`p-5 rounded-lg border-2 cursor-pointer transition-all ${importType === 'accessories_update' ? 'border-emerald-500 bg-emerald-100/20' : 'border-slate-100 hover:border-slate-200 hover:bg-slate-100'}`}
 >
 <div className="flex items-center justify-between mb-2">
 <span className="text-[11px] font-black uppercase tracking-wider text-slate-800 font-bold">4. CẬP NHẬT EXCEL BOM</span>
 <input type="radio" checked={importType === 'accessories_update'} onChange={() => {}} className="accent-emerald-600" />
 </div>
 <p className="text-xs text-slate-500 leading-relaxed font-bold">
 Chọn dự án, cập nhật lại excel bom — chép đè thông tin vào module có sẵn, tạo mới nếu chưa tồn tại:
 </p>
 <ul className="text-[10px] text-slate-400 mt-2 list-disc list-inside space-y-1 font-bold">
 <li>Cập nhật toàn bộ thông tin từ Excel BOM (kích thước, phụ kiện, cụm...)</li>
 <li>Giữ nguyên QC data, lịch sử trạng thái, số thứ tự</li>
 <li>Tự động tạo mới module nếu chưa có trong dự án</li>
 </ul>
 </div>
 </div>

 {/* Project Selection for parts / parts_v2 / accessories_update type (mandatory) */}
 {(importType === 'parts' || importType === 'parts_v2' || importType === 'accessories_update') && (
  accumulatedSources.length > 0 && projectInfo.code && (importType === 'parts' || importType === 'parts_v2') ? (
   <div className="space-y-3 p-5 rounded-lg border border-emerald-100 bg-emerald-100/10 w-full shadow-none">
    <div className="flex items-center space-x-2">
     <CheckCircle size={16} className="text-emerald-600 shrink-0" />
     <span className="text-[11px] font-black uppercase tracking-wider text-emerald-700 font-extrabold">
      Mặc định nhập chung với dữ liệu BOM Chức năng 1
     </span>
    </div>
    <div className="p-4 bg-white border border-emerald-100 rounded-lg">
     <p className="text-xs font-black text-slate-800 uppercase">Dự án: {projectInfo.name}</p>
     <p className="text-[10px] font-mono text-slate-500 mt-1 font-bold">Mã dự án: {projectInfo.code}</p>
    </div>
    <p className="text-[10px] text-slate-400 italic font-medium leading-relaxed">
     * Hệ thống tự động liên kết cấu kiện chi tiết với dự án mới khai báo ở bước trước. Bạn không cần chọn lại dự án.
    </p>
   </div>
  ) : (
   <div className="space-y-3 p-5 rounded-lg border border-indigo-100 bg-indigo-100/10 w-full shadow-none">
    <div className="flex items-center space-x-2">
     <span className="text-[11px] font-black uppercase tracking-wider text-indigo-700 font-extrabold">
      {importType === 'accessories_update' ? 'Chọn Dự Án Cần Cập Nhật Excel BOM (*)' : 'Chọn Dự Án Gốc Cần Bổ Sung Cấu Kiện Chi Tiết (*)'}
     </span>
    </div>
    <div className="flex flex-col space-y-2">
     <select
      value={selectedProjectCode || ''}
      id="project-selector-s1"
      onChange={(e) => {
       const code = e.target.value;
       setSelectedProjectCode(code);
       const p = existingProjects.find(x => x.code === code);
       if (p) {
        setProjectInfo({
         name: p.name,
         code: p.code,
         drawingUrl: p.drawingUrl || '',
         assemblyDrawingUrl: p.assemblyDrawingUrl || '',
         glbUrl: p.glbUrl || ''
        });
       } else {
        setProjectInfo({ name: '', code: '', drawingUrl: '', assemblyDrawingUrl: '', glbUrl: '' });
       }
      }}
      className="w-full px-3 py-2.5 text-xs bg-white border border-indigo-200 rounded-lg focus:outline-none focus:border-indigo-505 font-bold text-slate-700"
     >
      <option value="">-- Click để chọn Dự án nguồn --</option>
      {existingProjects.map((proj) => (
       <option key={proj.code} value={proj.code}>
        {proj.name} ({proj.code})
       </option>
      ))}
     </select>
     <p className="text-[10px] text-slate-400 italic font-medium leading-relaxed">
      * Bạn nhất định phải lựa chọn dự án trước khi thực hiện tải file cấu kiện chi tiết lên hệ thống để đảm bảo cấu kiện được tích hợp chuẩn xác.
     </p>
    </div>
   </div>
  )
 )}

 {/* Upload Area */}
 {(importType === 'parts' || importType === 'parts_v2' || importType === 'accessories_update') && !selectedProjectCode ? (
 <div className="w-full p-8 rounded-lg border border-slate-200 bg-slate-100 text-center text-slate-400 flex flex-col items-center justify-center space-y-2">
 <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
 {importType === 'accessories_update' ? 'Vui lòng chọn Dự án cần cập nhật ở danh sách phía trên trước' : 'Vui lòng chọn Dự án gốc ở danh sách phía trên trước'}
 </span>
 <span className="text-[10px] text-slate-400 font-semibold">
 Khu vực tải lên tệp Excel sẽ tự động hiển thị khi bạn đã chọn được dự án cần thao tác.
 </span>
 </div>
 ) : (
 <div className="flex flex-col items-center space-y-4 w-full">
 <label className="w-full flex flex-col items-center px-6 py-8 bg-slate-100 text-slate-400 rounded-lg border-2 border-dashed border-slate-200 cursor-pointer hover:border-emerald-600 hover:bg-emerald-100/50 transition-all">
 <Upload size={28} className="mb-2 text-slate-400" />
 <span className="text-xs font-black uppercase tracking-widest text-slate-600">
 {wb ? "ĐÃ CHỌN TỆP: Nhấp để thay đổi" : "Tải lên Tệp Excel của bạn"}
 </span>
 <span className="text-[10px] text-slate-400 mt-1 italic font-bold">Hỗ trợ định dạng .xlsx, .xls</span>
 <input type="file" className="hidden" accept=".xlsx, .xls" onChange={handleFileUpload} />
 </label>
 </div>
 )}

 {fileError && (
 <div className="text-xs font-bold text-red-500 bg-red-100 px-3 py-2 rounded-lg border border-red-100 w-full text-center">
 {fileError}
 </div>
 )}

 {wb && (importType === 'standard' || importType === 'parts' || importType === 'parts_v2' || importType === 'accessories_update') && (
 <div className="w-full max-w-md pt-2">
 <button 
 type="button"
 onClick={handleProcessAndPreview}
 className="w-full py-3.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-black uppercase tracking-widest rounded-lg flex items-center justify-center transition-all cursor-pointer shadow-md shadow-emerald-500/10 active:scale-[0.98]"
 >
 <CheckCircle size={16} className="mr-2" /> TIẾN HÀNH XỬ LÝ &amp; XEM TRƯỚC
 </button>
 </div>
 )}

 {/* Advanced Mapping Section for BOM — REMOVED: BOM now auto-parsed in handleFileUpload */}
 {false && importType === 'bom' && wb && sheetsList.length > 0 && (
 <div className="w-full bg-slate-100 p-5 rounded-lg border border-slate-100 space-y-6">
 <div className="flex items-center space-x-2 border-b border-slate-200/60 pb-2">
 <Settings className="text-emerald-500" size={16} />
 <span className="text-xs font-black uppercase tracking-wider text-slate-800 font-bold">
 Thiết Lập Ánh Xạ Dữ Liệu BOM
 </span>
 </div>

 <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
 {/* Sheet 1: BOM Specs */}
 <div className="space-y-3 p-4 bg-white rounded-lg border border-slate-200 shadow-none">
 <div className="text-[10px] font-black uppercase tracking-widest text-emerald-600 font-mono mb-2">
 Sheet 1: Cấu Kiện &amp; Phụ Kiện
 </div>

 <div>
 <label className="block text-[10px] font-black mb-1 uppercase tracking-wider text-slate-500 font-bold">Tên Sheet (*)</label>
 <select 
 value={sheet1Name} 
 onChange={(e) => {
 setSheet1Name(e.target.value);
 applySheet1Headers(e.target.value, wb, s1HeaderRow);
 }}
 className="w-full px-3 py-2 text-xs bg-slate-100 border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-emerald-500 font-bold text-slate-700"
 >
 <option value="">-- Chọn Sheet --</option>
 {sheetsList.map(s => <option key={s} value={s}>{s}</option>)}
 </select>
 </div>

 <div className="grid grid-cols-2 gap-2">
 <div>
 <label className="block text-[10px] font-black mb-1 uppercase tracking-wider text-slate-500 font-bold">Dòng Tiêu Đề</label>
 <input 
 type="number" 
 min="1" 
 value={s1HeaderRow} 
 onChange={(e) => {
 const v = Number(e.target.value) || 1;
 setS1HeaderRow(v);
 applySheet1Headers(sheet1Name, wb, v);
 }}
 className="w-full px-3 py-2 text-xs bg-slate-100 border border-slate-200 rounded-lg focus:outline-none font-bold text-slate-700"
 />
 </div>

 <div>
 <label className="block text-[10px] font-black mb-1 uppercase tracking-wider text-slate-500 font-bold">S.Lượng Tủ (Cột)</label>
 <select 
 value={s1QuantityCol} 
 onChange={(e) => setS1QuantityCol(e.target.value)}
 className="w-full px-2 py-2 text-xs bg-slate-100 border border-slate-200 rounded-lg font-bold text-slate-700"
 >
 <option value="">-- Chọn cột --</option>
 {sheet1Headers.map((h, idx) => <option key={`s1qty-${h}-${idx}`} value={h}>{h}</option>)}
 </select>
 </div>
 </div>

 <div className="grid grid-cols-2 gap-2">
 <div>
 <label className="block text-[10px] font-black mb-1 uppercase tracking-wider text-slate-500 font-bold">Cột Cụm / Cluster</label>
 <select 
 value={s1ClusterCol} 
 onChange={(e) => setS1ClusterCol(e.target.value)}
 className="w-full px-2 py-2 text-xs bg-slate-100 border border-slate-200 rounded-lg font-bold text-slate-700"
 >
 <option value="">-- Chọn cột --</option>
 {sheet1Headers.map((h, idx) => <option key={`s1clus-${h}-${idx}`} value={h}>{h}</option>)}
 </select>
 </div>

 <div>
 <label className="block text-[10px] font-black mb-1 uppercase tracking-wider text-slate-500 font-bold">Cột Module Code (*)</label>
 <select 
 value={s1ModuleCol} 
 onChange={(e) => setS1ModuleCol(e.target.value)}
 className="w-full px-2 py-2 text-xs bg-slate-100 border border-slate-200 rounded-lg font-bold text-slate-700"
 >
 <option value="">-- Chọn cột --</option>
 {sheet1Headers.map((h, idx) => <option key={`s1mod-${h}-${idx}`} value={h}>{h}</option>)}
 </select>
 </div>
 </div>

 <div>
 <label className="block text-[10px] font-black mb-1 uppercase tracking-wider text-slate-500 font-bold">Bắt đầu Phụ Kiện "Phụ kiện vật tư phụ" (*)</label>
 <select 
 value={s1AccessoriesStartCol} 
 onChange={(e) => {
 const val = e.target.value;
 setS1AccessoriesStartCol(val);
 updateAccessoryStats(wb, sheet1Name, s1HeaderRow, val);
 }}
 className="w-full px-2 py-2 text-xs bg-slate-100 border border-slate-200 rounded-lg font-bold text-slate-800 focus:outline-none focus:ring-1 focus:ring-emerald-500"
 >
 <option value="">-- Chọn cột --</option>
 {sheet1Headers.map((h, idx) => <option key={`s1acc-${h}-${idx}`} value={h}>{h}</option>)}
 </select>
 </div>

 {/* Hiển thị chi tiết thống kê và bộ lọc phụ kiện */}
 {Object.keys(accessoryStats).length > 0 && (
 <div className="mt-3 pt-3 border-t border-slate-100 space-y-3">
 <div className="flex items-center justify-between">
 <label className="block text-[10px] font-black uppercase tracking-wider text-emerald-600 font-mono">
 Cấu hình Phụ kiện ({selectedAccessoryCols.length}/{Object.keys(accessoryStats).length} cột)
 </label>
 <div className="flex space-x-2">
 <button
 type="button"
 onClick={() => setSelectedAccessoryCols(Object.keys(accessoryStats))}
 className="text-[9px] font-black uppercase tracking-widest text-emerald-600 hover:underline cursor-pointer"
 >
 Chọn hết
 </button>
 <span className="text-[9px] text-slate-300">|</span>
 <button
 type="button"
 onClick={() => setSelectedAccessoryCols([])}
 className="text-[9px] font-black uppercase tracking-widest text-rose-500 hover:underline cursor-pointer"
 >
 Bỏ hết
 </button>
 </div>
 </div>

 <div className="max-h-56 overflow-y-auto border border-slate-100 rounded-lg p-2 bg-slate-100/50 space-y-1.5 scrollbar-thin">
 {Object.entries(accessoryStats).map(([hName, stats]) => {
 const isChecked = selectedAccessoryCols.includes(hName);
 return (
 <div 
 key={`acc-cfg-${hName}`}
 className="flex items-center justify-between p-1.5 rounded-lg bg-white border border-slate-100/60 hover:bg-slate-200/10 transition-all text-[11px]"
 >
 <label className="flex items-center space-x-2.5 cursor-pointer flex-1 min-w-0 pr-2">
 <input 
 type="checkbox"
 checked={isChecked}
 onChange={(e) => {
 if (e.target.checked) {
 setSelectedAccessoryCols(prev => [...prev, hName]);
 } else {
 setSelectedAccessoryCols(prev => prev.filter(col => col !== hName));
 }
 }}
 className="rounded border-gray-300 text-emerald-600 focus:ring-emerald-500 h-3.5 w-3.5 accent-emerald-600 cursor-pointer"
 />
 <span className="font-bold text-slate-700 truncate max-w-[130px]" title={hName}>
 {hName}
 </span>
 </label>
 <div className="flex items-center space-x-2 shrink-0 font-mono text-[9px] font-bold">
 <span className="px-2 py-0.5 rounded-lg bg-slate-100 text-slate-500">
 {stats.moduleCount} module
 </span>
 <span className="px-2 py-0.5 rounded-lg bg-emerald-100 text-emerald-600">
 Σ {stats.totalQty}
 </span>
 </div>
 </div>
 );
 })}
 </div>
 </div>
 )}
 </div>

 {/* Sheet 2: Dimensions specs */}
 <div className="space-y-3 p-4 bg-white rounded-lg border border-slate-200 shadow-none">
 <div className="text-[10px] font-black uppercase tracking-widest text-[#6366f1] font-mono mb-2">
 Sheet 2: Kích Thước &amp; Tổng Sản Lượng
 </div>

 <div>
 <label className="block text-[10px] font-black mb-1 uppercase tracking-wider text-slate-500 font-bold">Tên Sheet (*)</label>
 <select 
 value={sheet2Name} 
 onChange={(e) => {
 setSheet2Name(e.target.value);
 applySheet2Headers(e.target.value, wb, s2HeaderRow);
 }}
 className="w-full px-3 py-2 text-xs bg-slate-100 border border-slate-200 rounded-lg font-bold text-slate-700"
 >
 <option value="">-- Chọn Sheet 2 --</option>
 {sheetsList.map(s => <option key={s} value={s}>{s}</option>)}
 </select>
 </div>

 <div className="grid grid-cols-2 gap-2">
 <div>
 <label className="block text-[10px] font-black mb-1 uppercase tracking-wider text-slate-500 font-bold">Dòng Tiêu Đề</label>
 <input 
 type="number" 
 min="1" 
 value={s2HeaderRow} 
 onChange={(e) => {
 const v = Number(e.target.value) || 1;
 setS2HeaderRow(v);
 applySheet2Headers(sheet2Name, wb, v);
 }}
 className="w-full px-3 py-2 text-xs bg-slate-100 border border-slate-200 rounded-lg"
 />
 </div>

 <div>
 <label className="block text-[10px] font-black mb-1 uppercase tracking-wider text-slate-500 font-bold">Cột Module/Tên Tủ (*)</label>
 <select 
 value={s2ModuleCol} 
 onChange={(e) => setS2ModuleCol(e.target.value)}
 className="w-full px-2 py-2 text-xs bg-slate-100 border border-slate-200 rounded-lg font-bold text-slate-700"
 >
 <option value="">-- Chọn cột --</option>
 {sheet2Headers.map((h, idx) => <option key={`s2mod-${h}-${idx}`} value={h}>{h}</option>)}
 </select>
 </div>
 </div>

 <div className="grid grid-cols-2 gap-2">
 <div>
 <label className="block text-[10px] font-black mb-1 uppercase tracking-wider text-slate-500 font-bold">Cột Cụm / Cluster</label>
 <select 
 value={s2ClusterCol} 
 onChange={(e) => setS2ClusterCol(e.target.value)}
 className="w-full px-2 py-2 text-xs bg-slate-100 border border-slate-200 rounded-lg font-bold text-slate-700"
 >
 <option value="">-- Chọn cột --</option>
 {sheet2Headers.map((h, idx) => <option key={`s2clus-${h}-${idx}`} value={h}>{h}</option>)}
 </select>
 </div>

 <div>
 <label className="block text-[10px] font-black mb-1 uppercase tracking-wider text-slate-500 font-bold">Cột Tổng Số Lượng (*)</label>
 <select 
 value={s2TotalQtyCol} 
 onChange={(e) => setS2TotalQtyCol(e.target.value)}
 className="w-full px-2 py-2 text-xs bg-slate-100 border border-slate-200 rounded-lg font-bold text-slate-700"
 >
 <option value="">-- Chọn cột --</option>
 {sheet2Headers.map((h, idx) => <option key={`s2qty-${h}-${idx}`} value={h}>{h}</option>)}
 </select>
 </div>
 </div>

 {/* Dimension config */}
 <div className="p-3 bg-slate-100 rounded-lg space-y-2">
 <div className="flex items-center justify-between">
 <span className="text-[10px] font-black text-slate-500 uppercase font-mono">Kích Thước Tổng</span>
 <div className="flex items-center space-x-2">
 <label className="text-[9px] font-bold text-slate-400">
 <input type="radio" checked={s2DimType === 'single'} onChange={() => setS2DimType('single')} className="mr-1 accent-indigo-550" />
 Gộp một cột
 </label>
 <label className="text-[9px] font-bold text-slate-400">
 <input type="radio" checked={s2DimType === 'separate'} onChange={() => setS2DimType('separate')} className="mr-1 accent-indigo-555" />
 3 cột R-S-C
 </label>
 </div>
 </div>

 {s2DimType === 'single' ? (
 <select 
 value={s2DimSingleCol} 
 onChange={(e) => setS2DimSingleCol(e.target.value)}
 className="w-full px-2 py-1.5 text-xs bg-white border border-slate-200 rounded-lg font-bold"
 >
 <option value="">-- Chọn cột (Vd: 600x800x1200) --</option>
 {sheet2Headers.map((h, idx) => <option key={`s2dims-${h}-${idx}`} value={h}>{h}</option>)}
 </select>
 ) : (
 <div className="grid grid-cols-3 gap-1">
 <select value={s2WidthCol} onChange={(e) => setS2WidthCol(e.target.value)} className="px-1 py-1 text-[10px] bg-white border border-slate-200 rounded-lg font-bold">
 <option value="">Rộng</option>
 {sheet2Headers.map((h, idx) => <option key={`s2dimw-${h}-${idx}`} value={h}>{h}</option>)}
 </select>
 <select value={s2DepthCol} onChange={(e) => setS2DepthCol(e.target.value)} className="px-1 py-1 text-[10px] bg-white border border-slate-200 rounded-lg font-bold">
 <option value="">Sâu</option>
 {sheet2Headers.map((h, idx) => <option key={`s2dimd-${h}-${idx}`} value={h}>{h}</option>)}
 </select>
 <select value={s2HeightCol} onChange={(e) => setS2HeightCol(e.target.value)} className="px-1 py-1 text-[10px] bg-white border border-slate-200 rounded-lg font-bold">
 <option value="">Cao</option>
 {sheet2Headers.map((h, idx) => <option key={`s2dimh-${h}-${idx}`} value={h}>{h}</option>)}
 </select>
 </div>
 )}
 </div>

 {/* Packing dimension config */}
 <div className="p-3 bg-slate-100 rounded-lg space-y-2">
 <div className="flex items-center justify-between">
 <span className="text-[10px] font-black text-slate-500 uppercase font-mono">Kích Thước Đóng Gói</span>
 <div className="flex items-center space-x-2">
 <label className="text-[9px] font-bold text-slate-400">
 <input type="radio" checked={s2PackDimType === 'single'} onChange={() => setS2PackDimType('single')} className="mr-1 accent-indigo-550" />
 Gộp một cột
 </label>
 <label className="text-[9px] font-bold text-slate-400">
 <input type="radio" checked={s2PackDimType === 'separate'} onChange={() => setS2PackDimType('separate')} className="mr-1 accent-indigo-555" />
 3 cột R-S-C
 </label>
 </div>
 </div>

 {s2PackDimType === 'single' ? (
 <select 
 value={s2PackDimSingleCol} 
 onChange={(e) => setS2PackDimSingleCol(e.target.value)}
 className="w-full px-2 py-1.5 text-xs bg-white border border-slate-200 rounded-lg font-bold"
 >
 <option value="">-- Chọn cột (Vd: 650x850x1250) --</option>
 {sheet2Headers.map((h, idx) => <option key={`s2pdims-${h}-${idx}`} value={h}>{h}</option>)}
 </select>
 ) : (
 <div className="grid grid-cols-3 gap-1">
 <select value={s2PackWidthCol} onChange={(e) => setS2PackWidthCol(e.target.value)} className="px-1 py-1 text-[10px] bg-white border border-slate-200 rounded-lg font-bold">
 <option value="">RộngĐG</option>
 {sheet2Headers.map((h, idx) => <option key={`s2pdimw-${h}-${idx}`} value={h}>{h}</option>)}
 </select>
 <select value={s2PackDepthCol} onChange={(e) => setS2PackDepthCol(e.target.value)} className="px-1 py-1 text-[10px] bg-white border border-slate-200 rounded-lg font-bold">
 <option value="">SâuĐG</option>
 {sheet2Headers.map((h, idx) => <option key={`s2pdimd-${h}-${idx}`} value={h}>{h}</option>)}
 </select>
 <select value={s2PackHeightCol} onChange={(e) => setS2PackHeightCol(e.target.value)} className="px-1 py-1 text-[10px] bg-white border border-slate-200 rounded-lg font-bold">
 <option value="">CaoĐG</option>
 {sheet2Headers.map((h, idx) => <option key={`s2pdimh-${h}-${idx}`} value={h}>{h}</option>)}
 </select>
 </div>
 )}
 </div>
 </div>
 </div>

 <div className="flex justify-end pt-2">
 <button 
 type="button"
 onClick={handleProcessAndPreview}
 className="px-6 py-3 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-black uppercase tracking-widest rounded-lg flex items-center transition-all cursor-pointer shadow-lg shadow-emerald-100 active:scale-[0.98]"
 >
 <CheckCircle size={16} className="mr-2" /> ĐỒNG BỘ DỮ LIỆU &amp; XEM TRƯỚC
 </button>
 </div>
 </div>
 )}

 {/* Separator */}
 <div className="flex items-center space-x-3 my-2 w-full max-w-md mx-auto">
 <div className="flex-1 border-t border-slate-100"></div>
 <span className="text-[9px] font-black uppercase tracking-widest text-slate-400 font-mono">Hoặc</span>
 <div className="flex-1 border-t border-slate-100"></div>
 </div>

 {/* Option 2: Manual Creation */}
 <div className="flex justify-center w-full">
 <button
 type="button"
 onClick={() => {
 setData([]);
 setProjectInfo({ name: '', code: '', drawingUrl: '', assemblyDrawingUrl: '', glbUrl: '' });
 setStep(2);
 setImportMode('new');
 }}
 className="w-full max-w-md py-4 bg-slate-100 hover:bg-slate-100 border border-slate-200 text-slate-700 rounded-lg text-xs font-black uppercase tracking-widest transition-all flex items-center justify-center space-x-2 cursor-pointer active:scale-[0.98]"
 >
 <PlusCircle size={16} className="text-indigo-600" />
 <span>Khởi tạo Dự Án Mới Thủ Công</span>
 </button>
 </div>

 <div className="w-full pt-6 border-t border-slate-100 grid grid-cols-2 lg:grid-cols-4 gap-3">
 {[
 { label: 'QUY TRÌNH BOM', val: 'Sheet 1 nạp phụ kiện, Sheet 2 nạp kích thước' },
 { label: 'ĐỒNG BỘ MODULE', val: 'Gộp tự động nếu trùng tên Module' },
 { label: 'TIÊU ĐỂ KHÔNG CỐ ĐỊNH', val: 'Cấu hình tiêu đề cột động thông minh' },
 { label: 'PC OPTIMIZED', val: 'Tìm và ghép chính xác trên trình duyệt' }
 ].map((item, i) => (
 <div key={i} className="p-3 bg-slate-100 rounded-lg text-center border border-slate-100/50">
 <span className="block text-[9px] font-black text-slate-900 uppercase tracking-wider mb-1 font-mono">{item.label}</span>
 <span className="block text-[8px] text-slate-400 font-bold leading-normal">{item.val}</span>
 </div>
 ))}
 </div>
 </div>
 ) : (
 <div className="p-8 space-y-8">
 {/* Mode Switcher Tabs */}
 {importType !== 'parts' && (
 <div className="flex bg-slate-100 p-1 rounded-lg mb-8">
 <button 
 onClick={() => setImportMode('new')}
 className={`flex-1 flex items-center justify-center space-x-2 py-3 text-[10px] font-black uppercase tracking-widest rounded-md transition-all ${importMode === 'new' ? 'bg-white text-emerald-600 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}
 >
 <PlusCircle size={14} />
 <span>Thiết lập Dự Án Mới</span>
 </button>
 <button 
 onClick={() => setImportMode('update')}
 className={`flex-1 flex items-center justify-center space-x-2 py-3 text-[10px] font-black uppercase tracking-widest rounded-md transition-all ${importMode === 'update' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}
 >
 <RefreshCw size={14} />
 <span>Cập Nhật Dữ Liệu Cũ</span>
 </button>
 </div>
 )}

 <div className="flex items-center space-x-6 p-5 bg-emerald-100 rounded-lg border border-emerald-100">
 <div className="w-12 h-12 bg-emerald-600 rounded-lg flex items-center justify-center text-white shrink-0 shadow-lg shadow-emerald-200">
 <CheckCircle size={24} />
 </div>
 <div>
 <h4 className="text-sm font-black text-emerald-800 uppercase tracking-widest mb-1 leading-none">Cấu trúc file hợp lệ</h4>
  <p className="text-xs text-emerald-600 font-bold uppercase tracking-tight">Đã xử lý {filteredData.length} hạng mục module{accumulatedData.length > 0 ? ` (${accumulatedData.length} tích lũy + ${data.length} mới)` : data.length !== filteredData.length ? ` (lọc từ ${data.length})` : ''}</p>
 </div>
 </div>

 {/* Diff Preview cho accessories_update */}
 {importType === 'accessories_update' && diffResult && (
  <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
   <div className="flex items-center justify-between border-b border-slate-100 pb-3">
    <h4 className="text-xs font-black uppercase tracking-widest text-slate-800">Tổng Quan Thay Đổi</h4>
    <span className="text-[10px] text-slate-400 font-mono font-bold">{selectedProjectCode}</span>
   </div>

   {/* Summary badges */}
   <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
    <div className="p-3 bg-blue-100 rounded-lg text-center">
     <span className="block text-lg font-black text-blue-700">{diffResult.toUpdate.length}</span>
     <span className="text-[10px] font-black text-blue-500 uppercase">Cập nhật</span>
    </div>
    <div className="p-3 bg-emerald-100 rounded-lg text-center">
     <span className="block text-lg font-black text-emerald-700">{diffResult.toCreate.length}</span>
     <span className="text-[10px] font-black text-emerald-500 uppercase">Tạo mới</span>
    </div>
    <div className="p-3 bg-rose-100 rounded-lg text-center">
     <span className="block text-lg font-black text-rose-700">{diffResult.toDelete.filter(d => !excludedModules.has(getModuleUniqueKey(d))).length}</span>
     <span className="text-[10px] font-black text-rose-500 uppercase">Xóa</span>
    </div>
    <div className="p-3 bg-slate-100 rounded-lg text-center">
     <span className="block text-lg font-black text-slate-700">{filteredData.length}</span>
     <span className="text-[10px] font-black text-slate-500 uppercase">Tổng Excel</span>
    </div>
   </div>

   {/* Danh sách xóa */}
   {diffResult.toDelete.length > 0 && (
    <div className="space-y-2">
     <div className="flex items-center justify-between">
      <span className="text-[10px] font-black uppercase tracking-wider text-rose-600">
       Cấu kiện sẽ XÓA ({diffResult.toDelete.filter(d => !excludedModules.has(getModuleUniqueKey(d))).length} /
       {diffResult.toDelete.length})
      </span>
      <button
       type="button"
       onClick={() => {
        const allKeys = new Set(diffResult!.toDelete.map(d => getModuleUniqueKey(d)));
        setExcludedModules(allKeys);
       }}
       className="text-[9px] font-black uppercase text-slate-400 hover:text-slate-600 cursor-pointer"
      >
       Loại trừ tất cả
      </button>
     </div>
     <div className="max-h-48 overflow-y-auto border border-slate-100 rounded-lg divide-y divide-slate-100">
      {diffResult.toDelete.map((mod) => {
       const key = getModuleUniqueKey(mod);
       const isExcluded = excludedModules.has(key);
       return (
        <div
         key={key}
         className={`flex items-center justify-between px-3 py-2 text-xs transition-all ${isExcluded ? 'bg-slate-100/50' : 'bg-white'}`}
        >
         <label className="flex items-center gap-2 cursor-pointer flex-1 min-w-0">
          <input
           type="checkbox"
           checked={!isExcluded}
           onChange={() => {
            setExcludedModules(prev => {
             const next = new Set(prev);
             if (isExcluded) next.delete(key);
             else next.add(key);
             return next;
            });
           }}
           className="accent-rose-600 h-3.5 w-3.5"
          />
          <span className={`font-mono font-bold truncate ${isExcluded ? 'text-slate-400 line-through' : 'text-slate-700'}`}>
           {mod.moduleCode} {mod.width || mod.depth || mod.height ? `(${mod.width || 0}x${mod.depth || 0}x${mod.height || 0})` : ''}
          </span>
         </label>
         <div className="flex items-center gap-2 shrink-0">
          <span className="text-[9px] text-slate-400 font-bold">{mod.classification || 'Thùng'}</span>
          {isExcluded && (
           <span className="px-1.5 py-0.5 bg-amber-100 text-amber-700 text-[9px] font-black rounded-lg">GIỮ</span>
          )}
         </div>
        </div>
       );
      })}
     </div>
    </div>
   )}

   {/* Danh sách cập nhật */}
   {diffResult.toUpdate.length > 0 && (
    <div className="space-y-1">
     <span className="text-[10px] font-black uppercase tracking-wider text-blue-600">
      Cấu kiện CẬP NHẬT ({diffResult.toUpdate.length})
     </span>
     <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto">
      {diffResult.toUpdate.map((mod) => (
       <span key={getModuleUniqueKey(mod)} className="px-2 py-0.5 bg-blue-100 text-blue-700 text-[10px] font-mono rounded-lg">
        {mod.moduleCode} {mod.width || mod.depth || mod.height ? `(${mod.width || 0}x${mod.depth || 0}x${mod.height || 0})` : ''}
       </span>
      ))}
     </div>
    </div>
   )}

   {/* Danh sách tạo mới */}
   {diffResult.toCreate.length > 0 && (
    <div className="space-y-1">
     <span className="text-[10px] font-black uppercase tracking-wider text-emerald-600">
      Cấu kiện TẠO MỚI ({diffResult.toCreate.length})
     </span>
     <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto">
      {diffResult.toCreate.map((mod) => (
       <span key={getModuleUniqueKey(mod)} className="px-2 py-0.5 bg-emerald-100 text-emerald-700 text-[10px] font-mono rounded-lg">
        {mod.moduleCode} {mod.width || mod.depth || mod.height ? `(${mod.width || 0}x${mod.depth || 0}x${mod.height || 0})` : ''}
       </span>
      ))}
     </div>
    </div>
   )}
  </div>
 )}

 <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
 {importMode === 'update' ? (
 <div className="col-span-1 sm:col-span-2 space-y-2">
 <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] block">Chọn Dự Án Gốc Cần Cập Nhật</label>
 <select 
 className="w-full border border-slate-200 rounded-lg px-4 py-3 text-sm focus:border-indigo-600 outline-none bg-slate-100 transition-all font-black uppercase tracking-widest"
 value={selectedProjectCode}
 onChange={e => handleProjectSelect(e.target.value)}
 >
 <option value="">-- CHỌN DỰ ÁN --</option>
 {existingProjects.map(p => (
 <option key={p.code} value={p.code}>{formatProjectName(p.name)} ({p.code})</option>
 ))}
 </select>
 </div>
 ) : null}
 <div className="space-y-2">
 <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] block">Tên Dự Án</label>
 <input 
 className="w-full border border-slate-200 rounded-lg px-4 py-3 text-sm font-black focus:border-indigo-600 outline-none bg-slate-100 transition-all uppercase"
 placeholder="VÍ DỤ: DỰ ÁN CHUNG CƯ A"
 value={projectInfo.name}
 readOnly={importMode === 'update'}
 onChange={e => setProjectInfo({...projectInfo, name: e.target.value})}
 />
 </div>
 <div className="space-y-2">
 <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] block">Mã Dự Án (Hiển thị)</label>
 <input 
 className="w-full border border-slate-200 rounded-lg px-4 py-3 text-sm font-black focus:border-indigo-600 outline-none bg-slate-100 transition-all uppercase"
 placeholder="DRACO-24-001"
 value={projectInfo.code}
 readOnly={importMode === 'update'}
 onChange={e => setProjectInfo({...projectInfo, code: e.target.value.toUpperCase().replace(/\s/g, '')})}
 />
 </div>
 </div>

 <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
 <div className="space-y-2">
 <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] block">Tài liệu Chi tiết (Link PDF)</label>
 <input 
 className="w-full border border-slate-200 rounded-lg px-4 py-3 text-xs font-medium focus:border-indigo-600 outline-none bg-slate-100 transition-all font-mono"
 placeholder="https://cloud.com/module.pdf"
 value={projectInfo.drawingUrl}
 onChange={e => setProjectInfo({...projectInfo, drawingUrl: e.target.value})}
 />
 </div>
 <div className="space-y-2">
 <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] block">Tài liệu Lắp ráp (Link PDF)</label>
 <input 
 className="w-full border border-slate-200 rounded-lg px-4 py-3 text-xs font-medium focus:border-indigo-600 outline-none bg-slate-100 transition-all font-mono"
 placeholder="https://cloud.com/assembly.pdf"
 value={projectInfo.assemblyDrawingUrl}
 onChange={e => setProjectInfo({...projectInfo, assemblyDrawingUrl: e.target.value})}
 />
 </div>
 </div>

 <div className="space-y-2">
 <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] block">Mô hình 3D Native (.glb Link)</label>
 <input 
 className="w-full border border-slate-200 rounded-lg px-4 py-3 text-xs font-medium focus:border-indigo-600 outline-none bg-slate-100 transition-all font-mono"
 placeholder="https://cloud.com/model.glb"
 value={projectInfo.glbUrl}
 onChange={e => setProjectInfo({...projectInfo, glbUrl: e.target.value})}
 />
 </div>

 <div className="bg-white border border-slate-200 rounded-lg overflow-hidden shadow-none">
 <div className="bg-slate-100 px-4 py-3 border-b border-slate-100 flex items-center justify-between gap-3">
  <div className="flex items-center">
   <TableIcon size={14} className="mr-3 text-slate-400 animate-pulse" />
   <span className="text-[11px] font-black text-slate-500 uppercase tracking-widest">Bảng Biên Tập Dữ Liệu Dự Án ({filteredData.length}{accumulatedData.length > 0 ? ` tổng` : `/${data.length}`} dòng)</span>
  </div>
  <div className="flex items-center gap-2">
   <span className="text-[10px] text-slate-400 font-bold whitespace-nowrap">Loại trừ:</span>
   <input
    type="text"
    value={excludePattern}
    onChange={e => setExcludePattern(e.target.value)}
    placeholder="nóc_,hậu_,chặn,..."
    className="px-3 py-1.5 text-[10px] border border-slate-200 rounded-lg w-64 font-mono focus:border-indigo-500 outline-none"
   />
   <button
    type="button"
    onClick={handleAddRow}
    className="px-3 py-1 bg-indigo-100 hover:bg-indigo-100 text-indigo-600 rounded-lg text-[10px] font-bold uppercase tracking-wider flex items-center space-x-1 border border-indigo-100 transition-all cursor-pointer"
   >
    <Plus size={12} />
    <span>THÊM DÒNG MỚI</span>
   </button>
  </div>
 </div>
 <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
 <table className="w-full text-left border-collapse min-w-[900px]">
 <thead>
 <tr className="bg-slate-100/50 text-[10px] font-black uppercase text-slate-400 border-b border-slate-100">
 <th className="px-3 py-2.5 w-12 text-center">STT</th>
 <th className="px-3 py-2.5 w-36">Cụm / Tổ</th>
 <th className="px-4 py-2.5">Module</th>
 <th className="px-3 py-2.5 w-24 text-center">S.Lượng</th>
 <th className="px-3 py-2.5 w-32">Phân loại</th>
 <th className="px-2 py-2.5 text-center text-[9px]">Rộng</th>
 <th className="px-2 py-2.5 text-center text-[9px]">Sâu</th>
 <th className="px-2 py-2.5 text-center text-[9px]">Cao</th>
 <th className="px-2 py-2.5 text-center text-[9px] text-indigo-400">Rộng ĐG</th>
 <th className="px-2 py-2.5 text-center text-[9px] text-indigo-400">Sâu ĐG</th>
 <th className="px-2 py-2.5 text-center text-[9px] text-indigo-400">Cao ĐG</th>
 {importType !== 'parts' && <th className="px-3 py-2.5 w-80">Phụ kiện đi kèm</th>}
 <th className="px-3 py-2.5 w-16 text-center">Xóa</th>
 </tr>
 </thead>
 <tbody className="divide-y divide-slate-100">
 {filteredData.map((r, i) => (
  <tr key={i} className="text-xs hover:bg-slate-100/50">
 <td className="px-3 py-1.5 text-center font-mono text-slate-400">{i + 1}</td>
 <td className="px-3 py-1.5 text-[11px] font-bold text-slate-700 uppercase">{r.cluster || '—'}</td>
 <td className="px-3 py-1.5 text-[11px] font-black text-indigo-700 font-mono whitespace-nowrap">{r.moduleCode || ''}</td>
 <td className="px-3 py-1.5 text-[11px] font-bold text-center text-slate-700">{r.quantity || 1}</td>
 <td className="px-3 py-1.5 text-[10px] font-bold text-slate-600">{r.classification || '—'}</td>
 <td className="px-1 py-1.5 text-[10px] font-mono text-center text-slate-600">{r.width || '—'}</td>
 <td className="px-1 py-1.5 text-[10px] font-mono text-center text-slate-600">{r.depth || '—'}</td>
 <td className="px-1 py-1.5 text-[10px] font-mono text-center text-slate-600">{r.height || '—'}</td>
 <td className="px-1 py-1.5 text-[10px] font-mono text-center text-indigo-500">{r.pWidth || '—'}</td>
 <td className="px-1 py-1.5 text-[10px] font-mono text-center text-indigo-500">{r.pDepth || '—'}</td>
 <td className="px-1 py-1.5 text-[10px] font-mono text-center text-indigo-500">{r.pHeight || '—'}</td>
 {importType !== 'parts' && (
 <td className="px-3 py-1.5">
 <div className="flex flex-col space-y-1.5">
 {r.accessories && r.accessories.length > 0 ? (
 <div className="flex flex-wrap gap-1 max-w-[210px] max-h-14 overflow-y-auto p-0.5 scrollbar-thin">
 {r.accessories.map((acc: any, aIdx: number) => (
 <span key={aIdx} className="px-1.5 py-0.5 rounded-lg bg-emerald-100 text-emerald-600 text-[10px] font-mono leading-none flex items-center gap-0.5 border border-emerald-100/50">
 <span className="truncate max-w-[90px] font-semibold" title={acc.name}>{acc.name}</span>:<strong>{acc.quantity}</strong>
 </span>
 ))}
 </div>
 ) : (
 <span className="text-[10px] text-slate-400 italic">Không có phụ kiện</span>
 )}
 <button
 type="button"
 onClick={() => {
 setEditingRowIndex(i);
 setTempRowAccessories(JSON.parse(JSON.stringify(r.accessories || [])));
 setNewAccName('');
 setNewAccQty(1);
 }}
 className="w-fit text-[10px] text-indigo-600 font-bold tracking-wide uppercase hover:underline flex items-center gap-1 cursor-pointer"
 >
 <Settings size={11} /> Chỉnh sửa ({r.accessories?.length || 0})
 </button>
 </div>
 </td>
 )}
 <td className="px-2 py-1.5 text-center">
 <button
 type="button"
   onClick={() => handleDeleteRowById(r.id)}
 className="p-1 hover:bg-rose-100 text-slate-400 hover:text-rose-600 rounded transition-all cursor-pointer"
 title="Xóa dòng này"
 >
 <Trash2 size={13} />
 </button>
 </td>
 </tr>
 ))}
 {filteredData.length === 0 && data.length > 0 && (
  <tr>
   <td colSpan={(importType === 'parts' || importType === 'parts_v2') ? 8 : 13} className="px-5 py-12 text-center text-slate-400">
    <p className="uppercase tracking-widest text-[10px] font-black">Tất cả {data.length} dòng đều bị loại trừ bởi bộ lọc.</p>
    <p className="text-[10px] text-slate-400 mt-1">Xoá hoặc sửa pattern loại trừ để hiển thị lại dữ liệu.</p>
   </td>
  </tr>
 )}
 {data.length === 0 && (
 <tr>
 <td colSpan={(importType === 'parts' || importType === 'parts_v2') ? 8 : 13} className="px-5 py-12 text-center text-slate-400">
 <p className="uppercase tracking-widest text-[10px] font-black">Chưa có module nào trong dự án.</p>
 <button
 type="button"
 onClick={handleAddRow}
 className="mt-3 mx-auto px-4 py-2 bg-indigo-100 hover:bg-indigo-100 text-indigo-700 rounded-sm text-[9px] font-black uppercase tracking-widest flex items-center space-x-1 border border-indigo-100 cursor-pointer"
 >
 <Plus size={12} className="mr-1" />
 <span>Bấm để thêm dòng module đầu tiên</span>
 </button>
 </td>
 </tr>
 )}
 </tbody>
 </table>
 </div>
 </div>

 {/* Diff Preview Modal — Xem trước thay đổi khi cập nhật Excel BOM */}
 {importType === 'accessories_update' && diffResult && (
  <div className="fixed inset-0 z-[200] flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4">
   <div className="w-full max-w-3xl bg-white rounded-lg shadow-2xl border border-slate-200 flex flex-col max-h-[85vh]">
    {/* Header */}
    <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 bg-slate-100 rounded-t-lg">
     <div>
      <h3 className="text-sm font-black uppercase tracking-widest text-slate-900">Xem trước thay đổi</h3>
      <p className="text-[10px] text-slate-500 font-bold mt-1">
       {diffResult.toCreate.length} thêm · {diffResult.toUpdate.length} cập nhật · {diffResult.toDelete.length} xóa
       {excludedModules.size > 0 && <span className="text-amber-600"> · {excludedModules.size} loại trừ</span>}
      </p>
     </div>
     <button
      onClick={() => setDiffResult(null)}
      className="p-2 hover:bg-slate-200 text-slate-400 hover:text-slate-600 rounded-lg transition-all cursor-pointer"
     >
      <X size={18} />
     </button>
    </div>

    {/* Body */}
    <div className="flex-1 overflow-y-auto p-6 space-y-5">
     {/* Tab selector */}
     <DiffPreviewTabs diffResult={diffResult} excludedModules={excludedModules} setExcludedModules={setExcludedModules} />
    </div>

    {/* Footer */}
    <div className="px-6 py-4 border-t border-slate-100 flex items-center justify-between bg-slate-100 rounded-b-lg">
     <button
      onClick={() => setDiffResult(null)}
      className="px-5 py-2.5 bg-white border border-slate-200 text-slate-600 rounded-lg text-[11px] font-black uppercase tracking-widest hover:bg-slate-100 transition-all cursor-pointer"
     >
      HỦY BỎ
     </button>
     <button
      onClick={() => {
       setDiffResult(null);
       handleImport();
      }}
      disabled={loading}
      className="px-6 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-[11px] font-black uppercase tracking-widest flex items-center gap-2 transition-all cursor-pointer disabled:opacity-50"
     >
      {loading ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle size={14} />}
      {loading ? 'Đang thực hiện...' : 'XÁC NHẬN THỰC HIỆN'}
     </button>
    </div>
   </div>
  </div>
 )}

 {/* Modal chỉnh sửa phụ kiện của một dòng */}
 {editingRowIndex !== null && (
 <div id="acc-edit-modal" className="fixed inset-0 z-100 flex items-center justify-center bg-slate-900/40 backdrop-blur-xs p-4 animate-fade-in">
 <div className="w-full max-w-lg bg-white rounded-lg shadow-2xl border border-slate-100 flex flex-col max-h-[85vh]">
 {/* Header */}
 <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
 <div>
 <h3 className="text-xs font-black uppercase tracking-widest text-slate-900">
 Cấu hình Phụ kiện đi kèm
 </h3>
 <p className="text-[10px] text-slate-400 font-bold mt-1 font-mono uppercase">
 Module: {data[editingRowIndex]?.moduleCode || 'N/A'}
 </p>
 </div>
 <button
 type="button"
 onClick={() => setEditingRowIndex(null)}
 className="p-1.5 hover:bg-slate-100 text-slate-400 hover:text-slate-600 rounded transition-all cursor-pointer"
 >
 <X size={16} />
 </button>
 </div>

 {/* Body */}
 <div className="flex-1 overflow-y-auto p-5 space-y-4">
 {/* Thêm phụ kiện mới */}
 <div id="new-acc-form" className="p-3.5 bg-slate-100 rounded-lg border border-slate-100 space-y-3">
 <span className="block text-[9px] font-black uppercase tracking-wider text-indigo-600 font-mono">
 Thêm phụ kiện mới vào module
 </span>
 <div className="grid grid-cols-12 gap-2">
 <div className="col-span-8">
 <input
 type="text"
 placeholder="Tên phụ kiện (Vd: Bản lề A DTC)"
 value={newAccName}
 onChange={(e) => setNewAccName(e.target.value)}
 className="w-full px-3 py-1.5 text-xs bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-indigo-500 font-semibold text-slate-700"
 />
 </div>
 <div className="col-span-4 flex gap-1">
 <input
 type="number"
 min="1"
 value={newAccQty}
 onChange={(e) => setNewAccQty(Math.max(1, Number(e.target.value) || 1))}
 className="w-16 px-2 py-1.5 text-xs bg-white border border-slate-200 rounded-lg text-center font-bold focus:outline-none focus:border-indigo-500"
 />
 <button
 type="button"
 onClick={() => {
 if (!newAccName.trim()) return;
 const match = tempRowAccessories.find(x => x.name.toLowerCase() === newAccName.trim().toLowerCase());
 if (match) {
 match.quantity += newAccQty;
 setTempRowAccessories([...tempRowAccessories]);
 } else {
 setTempRowAccessories([...tempRowAccessories, {
 name: newAccName.trim(),
 quantity: newAccQty,
 issuedQuantity: 0,
 status: 'Chưa xuất kho'
 }]);
 }
 setNewAccName('');
 setNewAccQty(1);
 }}
 className="flex-1 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold rounded-lg flex items-center justify-center transition-all cursor-pointer"
 >
 <Plus size={14} />
 </button>
 </div>
 </div>
 </div>

 {/* Danh sách phụ kiện hiện có */}
 <div className="space-y-2">
 <span className="block text-[9px] font-black uppercase tracking-wider text-slate-400 font-mono">
 Danh sách phụ kiện ({tempRowAccessories.length})
 </span>
 <div className="divide-y divide-slate-100 border border-slate-100 rounded-lg overflow-hidden max-h-60 overflow-y-auto">
 {tempRowAccessories.map((acc, aIdx) => (
 <div key={aIdx} className="flex items-center justify-between p-3 bg-white text-xs">
 <span className="font-bold text-slate-700 truncate max-w-[200px]" title={acc.name}>
 {acc.name}
 </span>
 <div className="flex items-center space-x-3">
 {/* Sửa số lượng */}
 <div className="flex items-center space-x-1">
 <button
 type="button"
 onClick={() => {
 const next = [...tempRowAccessories];
 next[aIdx].quantity = Math.max(1, next[aIdx].quantity - 1);
 setTempRowAccessories(next);
 }}
 className="w-6 h-6 rounded bg-slate-100 hover:bg-slate-200 text-slate-500 flex items-center justify-center font-bold text-xs cursor-pointer"
 >
 -
 </button>
 <span className="w-10 text-center font-bold font-mono text-slate-700">
 {acc.quantity}
 </span>
 <button
 type="button"
 onClick={() => {
 const next = [...tempRowAccessories];
 next[aIdx].quantity += 1;
 setTempRowAccessories(next);
 }}
 className="w-6 h-6 rounded bg-slate-100 hover:bg-slate-200 text-slate-500 flex items-center justify-center font-bold text-xs cursor-pointer"
 >
 +
 </button>
 </div>

 <button
 type="button"
 onClick={() => {
 setTempRowAccessories(tempRowAccessories.filter((_, idx) => idx !== aIdx));
 }}
 className="p-1 hover:bg-rose-100 text-slate-400 hover:text-rose-600 rounded transition-all cursor-pointer"
 title="Xóa phụ kiện khỏi module"
 >
 <Trash2 size={13} />
 </button>
 </div>
 </div>
 ))}
 {tempRowAccessories.length === 0 && (
 <div className="p-6 text-center text-slate-400 italic text-xs">
 Chưa cấu hình phụ kiện nào cho module này.
 </div>
 )}
 </div>
 </div>
 </div>

 {/* Footer */}
 <div className="px-5 py-4 border-t border-slate-100 flex justify-end space-x-2">
 <button
 type="button"
 onClick={() => setEditingRowIndex(null)}
 className="px-4 py-2 bg-slate-100 text-slate-605 rounded-lg text-xs font-black uppercase tracking-widest hover:bg-slate-200"
 >
 HỦY BỎ
 </button>
 <button
 type="button"
 onClick={() => {
 const nextData = [...data];
 nextData[editingRowIndex].accessories = tempRowAccessories;
 setData(nextData);
 setEditingRowIndex(null);
 }}
 className="px-5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-black uppercase tracking-widest flex items-center space-x-2 shadow-lg cursor-pointer"
 >
 <CheckCircle size={14} />
 <span>XÁC NHẬN</span>
 </button>
 </div>
 </div>
 </div>
 )}

 <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-3 pt-6 border-t border-slate-100">
 {(importType === 'parts' || importType === 'parts_v2') && !selectedProjectCode && (
 <span className="text-[10px] font-black tracking-widest text-rose-500 bg-rose-100 px-4 py-3 rounded-lg border border-rose-100 animate-pulse font-mono block text-center uppercase">
 Vui lòng chọn Dự Án Gốc cần cập nhật
 </span>
 )}
 {importType === 'accessories_update' && !selectedProjectCode && (
 <span className="text-[10px] font-black tracking-widest text-rose-500 bg-rose-100 px-4 py-3 rounded-lg border border-rose-100 animate-pulse font-mono block text-center uppercase">
 Vui lòng chọn Dự Án cần cập nhật Excel BOM
 </span>
 )}

 {/* Nút BƯỚC KẾ TIẾP — lưu dữ liệu và chuyển sang chọn chức năng 2/3 */}
 {importType !== 'accessories_update' && (
  <button
   onClick={saveAndNextStep}
   disabled={filteredData.length === 0}
   className="px-6 py-3.5 bg-indigo-600 text-white rounded-lg text-[11px] font-black uppercase tracking-widest transition-all hover:bg-indigo-700 disabled:opacity-50 font-bold flex items-center gap-2"
  >
   BƯỚC KẾ TIẾP
  </button>
 )}

 {/* Hiển thị tổng đã tích lũy */}
 {accumulatedSources.length > 0 && (
  <span className="text-[10px] font-black text-indigo-600 bg-indigo-100 px-3 py-2 rounded-lg font-mono whitespace-nowrap">
   Đã nhập: {accumulatedData.length} + {filteredData.length - accumulatedData.length} = {filteredData.length} module
  </span>
 )}

 <button
 onClick={() => { setStep(1); setExcludePattern(DEFAULT_EXCLUDE); setDiffResult(null); }}
 className="px-8 py-3.5 bg-slate-100 text-slate-600 rounded-lg text-[11px] font-black uppercase tracking-widest transition-all hover:bg-slate-200 font-bold"
 >
 QUAY LẠI CHỌN FILE
 </button>
 {importType === 'accessories_update' && selectedProjectCode && diffResult ? (
 <button
  disabled={loading || !projectInfo.name || !projectInfo.code}
  onClick={handleImport}
  className="px-8 py-3.5 bg-emerald-600 text-white rounded-lg text-[11px] font-black uppercase tracking-widest transition-all shadow-xl shadow-emerald-100 hover:bg-emerald-700 disabled:opacity-100 flex items-center justify-center space-x-3 active:scale-[0.98] font-bold"
 >
  {loading ? <Loader2 size={18} className="animate-spin" /> : <CheckCircle size={18} />}
  <span>{loading ? 'Đang thực hiện...' : `XÁC NHẬN (${diffResult.toCreate.length} thêm · ${diffResult.toUpdate.length} cập nhật · ${diffResult.toDelete.filter(d => !excludedModules.has(getModuleUniqueKey(d))).length} xóa)`}</span>
 </button>
 ) : importType === 'accessories_update' && selectedProjectCode ? (
 <button
  onClick={async () => {
   if (filteredData.length > 0 && selectedProjectCode) {
    await computeDiffForAccessoriesUpdate(selectedProjectCode, filteredData);
   }
  }}
  disabled={loading || !projectInfo.name || !projectInfo.code || filteredData.length === 0}
  className="px-8 py-3.5 bg-indigo-600 text-white rounded-lg text-[11px] font-black uppercase tracking-widest transition-all shadow-xl shadow-indigo-100 hover:bg-indigo-700 disabled:opacity-100 flex items-center justify-center space-x-3 active:scale-[0.98] font-bold"
 >
  <Eye size={18} />
  <span>XEM TRƯỚC THAY ĐỔI</span>
 </button>
 ) : (
 <button
 disabled={loading || !projectInfo.name || !projectInfo.code || ((importType === 'parts' || importType === 'parts_v2' || importType === 'accessories_update') && !selectedProjectCode)}
 onClick={handleImport}
 className="px-8 py-3.5 bg-emerald-600 text-white rounded-lg text-[11px] font-black uppercase tracking-widest transition-all shadow-xl shadow-emerald-100 hover:bg-emerald-700 disabled:opacity-100 flex items-center justify-center space-x-3 active:scale-[0.98] font-bold"
 >
 {loading ? <Loader2 size={18} className="animate-spin" /> : (
 <>
 <CheckCircle size={18} />
 <span>{accumulatedData.length > 0 ? 'TẠO DỰ ÁN' : 'XÁC NHẬN NHẬP DỰ LIỆU'}</span>
 </>
 )}
 </button>
 )}
 </div>
 </div>
 )}
 </div>
 </div>
 );
}
