/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useMemo, useEffect } from 'react';
import { X, Save, Search, Loader2, Info, Plus, Trash2, Package, Layers, CheckCircle, Check, Edit, ChevronLeft, ChevronRight } from 'lucide-react';
import { PackingList, PackingItem, ProjectEntry, PKLOrder, matchSearchQuery } from '../types';
import { useAuth } from '../lib/AuthContext';

const getEntryTypeLocal = (entry: ProjectEntry): string => {
  if (entry.classification) return entry.classification;
  const lower = (entry.moduleCode || '').toLowerCase();
  if (lower.includes('len') || lower.includes('filler') || lower.includes('fillter') || lower.includes('thanh treo')) return 'Len, Filler';
  if (lower.includes('gia công ngoài') || lower.includes('gia cong ngoai')) return 'Gia công ngoài';
  if (lower.includes('đợt di động') || lower.includes('dot di dong')) return 'Đợt di động';
  if (lower.includes('mặt hoàn thiện') || lower.includes('mặt hoan thien') || lower.includes('mặt ht')) return 'CTHT';
  if (lower.includes('hoàn thiện') || lower.includes('hoan thien') || lower.includes('ctht') || lower.includes('tấm')) return 'CTHT';
  if (lower.includes('mặt học kéo') || lower.includes('mat hoc keo') || lower.includes('mặt hk')) return 'Mặt HK';
  if (lower.includes('mặt')) return 'Mặt HK';
  if (lower.includes('cánh') || lower.includes('cửa')) return 'Cánh';
  if (lower.includes('đợt')) return 'Đợt';
  return 'Thùng';
};

interface PackingExcelEditorModalProps {
 packingList: PackingList;
 projectEntries?: ProjectEntry[];
 pklLists?: PKLOrder[];
 unpackedCTHTs?: (ProjectEntry & { isPacked: boolean; remainingQty: number })[];
 onClose: () => void;
 onSave: (updatedItems: PackingItem[]) => Promise<void>;
 onItemsChange?: (updatedItems: PackingItem[]) => void;
}

interface EditablePackingItem extends PackingItem {
 tempId: string;
}

// Helper to parse dimensions from part or module name
function parseItemDimensionsAndInfo(name: string) {
 const n = name || '';
 let w = "0";
 let d = "0";
 let h = "0";
 let unit = "BLDG1";
 let area = "KITCHEN";
 let cabinetType = "T1";

 const rPrefix = /W\s*(\d+)\s*D\s*(\d+)\s*H\s*(\d+)/i;
 const matchPrefix = n.match(rPrefix);
 if (matchPrefix) {
 w = matchPrefix[1];
 d = matchPrefix[2];
 h = matchPrefix[3];
 } else {
 const rCross = /(\d+)\s*[xX*]\s*(\d+)\s*[xX*]\s*(\d+)/;
 const matchCross = n.match(rCross);
 if (matchCross) {
 w = matchCross[1];
 d = matchCross[2];
 h = matchCross[3];
 }
 }
 return { w, d, h, unit, area, cabinetType };
}

// Helper to calculate weight from cabinet dimensions
function calculateCabinetWeight(wStr: string, dStr: string, hStr: string): string {
 const w = parseFloat(wStr) || 0;
 const d = parseFloat(dStr) || 0;
 const h = parseFloat(hStr) || 0;

 if (w <= 0 || d <= 0 || h <= 0) return "0";

  const doorsAndBack = h * w * 18 * 2;
  const sides = h * d * 18 * 2;
  const topAndBottom = w * d * 18 * 2;

  const totalMm3 = doorsAndBack + sides + topAndBottom;
  const totalM3 = totalMm3 / 1000000000;
  const weightKg = totalM3 * 750 * 0.7;

 return (Math.round(weightKg * 10) / 10).toString();
}

const isZeroOrEmpty = (val: any) => {
 if (val === undefined || val === null) return true;
 const str = val.toString().trim();
 return str === "" || str === "0" || str === "0.0";
};

export function PackingExcelEditorModal({ packingList, projectEntries, pklLists = [], unpackedCTHTs = [], onClose, onSave, onItemsChange }: PackingExcelEditorModalProps) {
 const { userProfile, user } = useAuth();
 const [loading, setLoading] = useState(false);
 const [activeTab, setActiveTab] = useState<'thung' | 'ctht'>('thung');

 // Search state for Tab Thùng
 const [searchTerm, setSearchTerm] = useState('');
 const [statusFilter, setStatusFilter] = useState<string>(''); // 'all', 'unpacked', 'packed', 'loaded'
 const [clusterFilter, setClusterFilter] = useState('');
 const [subTypeFilter, setSubTypeFilter] = useState<string>('');

 // Search state for Tab CTHT
 const [cthtSearch, setCthtSearch] = useState('');
 const [kienSearch, setKienSearch] = useState('');

 // Status for Save changes notice
 const [saveStatus, setSaveStatus] = useState<'idle' | 'success' | 'error'>('idle');

 // Quantity dialog for dragging CTHT items
 const [showQtySelector, setShowQtySelector] = useState<{
 entryId: string;
 kienId: string;
 maxAvailable: number;
 defaultQty: number;
 } | null>(null);

 // Local grid items with temporary unique ID
 const [gridData, setGridData] = useState<EditablePackingItem[]>(() => {
 // Deduplicate truoc khi khoi tao
 const seen = new Set<string>();
 const uniqueItems = (packingList.items || []).filter(item => {
 const key = item.id || item.name || '';
 if (seen.has(key)) return false;
 seen.add(key);
 return true;
 });
 const formatted = uniqueItems.map((item, idx) => {
 let accessories = item.accessories ? [...item.accessories] : [];

 const hasDesiccant = accessories.some(a => {
 const n = String(a.name).toLowerCase();
 return n.includes('gói hút ẩm') || n.includes('goi hut am');
 });
 if (!hasDesiccant) {
 accessories.push({ name: 'Gói hút ẩm', quantity: 1, checked: false });
 }

 if (item.subType === 'kienModule' || !item.subType) {
 const chotDotAcc = accessories.find(a => {
 const n = String(a.name).toLowerCase();
 return n.includes('chốt đợt di động') || n.includes('chot dot di dong');
 });

 if (chotDotAcc) {
 const shelfQuantity = Math.floor(Number(chotDotAcc.quantity) / 4);
 if (shelfQuantity > 0) {
 const hasShelf = accessories.some(a => {
 const n = String(a.name).toLowerCase();
 return (n.includes('đợt di động') || n.includes('dot di dong')) && !n.includes('chốt') && !n.includes('chot');
 });
 if (!hasShelf) {
 accessories.push({ name: 'Đợt di động', quantity: shelfQuantity, checked: false });
 }
 }
 }
 }

 accessories.sort((a, b) => {
 const lowerA = (a.name || '').toLowerCase();
 const lowerB = (b.name || '').toLowerCase();
 const isDesiccantA = lowerA.includes('hút ẩm') || lowerA.includes('hut am');
 const isDesiccantB = lowerB.includes('hút ẩm') || lowerB.includes('hut am');
 const isShelfA = lowerA.includes('đợt di động') && !lowerA.includes('chốt');
 const isShelfB = lowerB.includes('đợt di động') && !lowerB.includes('chốt');

 if (isShelfA && !isShelfB) return -1;
 if (!isShelfA && isShelfB) return 1;
 if (isDesiccantA && !isDesiccantB) return -1;
 if (!isDesiccantA && isDesiccantB) return 1;
 return lowerA.localeCompare(lowerB);
 });

 const matchedEntry = projectEntries ? projectEntries.find(e => e.id === item.id || (e.moduleCode || '').toLowerCase() === (item.name || '').toLowerCase()) : undefined;
 const parsed = parseItemDimensionsAndInfo(item.name);
 const defaultW = parsed.w;
 const defaultD = parsed.d;
 const defaultH = parsed.h;

 const w = !isZeroOrEmpty(item.w) ? item.w : (matchedEntry ? (matchedEntry.pWidth || matchedEntry.width || matchedEntry.length || defaultW).toString() : defaultW);
 const d = !isZeroOrEmpty(item.d) ? item.d : (matchedEntry ? (matchedEntry.pDepth || matchedEntry.depth || defaultD).toString() : defaultD);
 const h = !isZeroOrEmpty(item.h) ? item.h : (matchedEntry ? (matchedEntry.pHeight || matchedEntry.height || defaultH).toString() : defaultH);

 // Auto-generate weight if w/d/h are available but weight is empty
 const weight = !isZeroOrEmpty(item.weight) ? Number(item.weight) : (parseFloat(w) > 0 && parseFloat(d) > 0 && parseFloat(h) > 0 ? parseFloat(calculateCabinetWeight(w, d, h)) : 0);

 // Merge photos from all sources
 const mergedPhotos = [...new Set([
   ...(item.photos || []),
   item.productImageUrl,
   item.packingImageUrl,
 ].filter(Boolean))];

 return {
 ...item,
 tempId: `${item.id || 'item'}_${idx}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
 subType: item.subType || 'kienModule',
 cluster: item.cluster || '',
 w,
 d,
 h,
 weight,
 photos: mergedPhotos.length > 0 ? mergedPhotos : undefined,
 accessories,
 accessoryChecked: item.accessoryChecked && accessories.every(a => a.checked)
 };
 });

 if (projectEntries && projectEntries.length > 0) {
 const entryIdToIndex = new Map<string, number>();
 projectEntries.forEach((entry, idx) => {
 entryIdToIndex.set(entry.id, idx);
 });

 formatted.sort((a, b) => {
 const idxA = a.id ? entryIdToIndex.get(a.id) : undefined;
 const indexA = idxA !== undefined ? idxA : projectEntries.findIndex(e => e.moduleCode === a.name);

 const idxB = b.id ? entryIdToIndex.get(b.id) : undefined;
 const indexB = idxB !== undefined ? idxB : projectEntries.findIndex(e => e.moduleCode === b.name);

 if (indexA !== -1 && indexB !== -1) return indexA - indexB;
 if (indexA !== -1) return -1;
 if (indexB !== -1) return 1;
 return (a.name || '').localeCompare(b.name || '');
 });
 }

 // Đồng bộ trạng thái loaded từ PKL orders
 if (pklLists && pklLists.length > 0) {
 const loadedIds = new Set<string>();
 pklLists.forEach(pkl => {
 (pkl.packageIds || []).forEach(id => loadedIds.add(id));
 });
 formatted.forEach(item => {
 if (item.id && loadedIds.has(item.id)) {
 item.loaded = true;
 }
 });
 }

 return formatted;
 });

  // State to track modified and deleted rows for Tab Thùng
  const [dirtyRowIds, setDirtyRowIds] = useState<Set<string>>(new Set());
  const [deletedRowIds, setDeletedRowIds] = useState<Set<string>>(new Set());
  const [selectedRowIds, setSelectedRowIds] = useState<Set<string>>(new Set());
  const [photoLightbox, setPhotoLightbox] = useState<{ images: string[]; index: number } | null>(null);

 // Tab 2 (CTHT) States & Logic trực quan
 const cthtProjectEntries = useMemo(() => {
   if (!projectEntries) return [];
   return projectEntries.filter(entry => {
     if (packingList.projectCode && entry.projectCode !== packingList.projectCode) return false;
     if (getEntryTypeLocal(entry) === 'CTHT') return true;
     return false;
   });
 }, [projectEntries, packingList.projectCode]);

 interface CthtKien {
 id: string;
 name: string;
 cluster?: string;
 packed: boolean;
 loaded: boolean;
 packedBy?: string;
 loadedBy?: string;
 packedQty?: number;
 items: {
 entryId: string;
 moduleCode: string;
 quantity: number;
 entry: ProjectEntry;
 }[];
 }

 const [cthtKiens, setCthtKiens] = useState<CthtKien[]>([]);
 const [cthtInitialized, setCthtInitialized] = useState(false);
 const [activeKienId, setActiveKienId] = useState<string | null>(null);
 const [isCthtDirty, setIsCthtDirty] = useState(false);
 const [isCreatingKien, setIsCreatingKien] = useState(false);
 const [tempKienName, setTempKienName] = useState('');

 const [showCreateKienModal, setShowCreateKienModal] = useState(false);
 const [newKienName, setNewKienName] = useState('');
 const [newKienCluster, setNewKienCluster] = useState('Chi tiết hỗ trợ');

 const [editingKien, setEditingKien] = useState<CthtKien | null>(null);
 const [editKienName, setEditKienName] = useState('');
 const [editKienCluster, setEditKienCluster] = useState('');

  // Tự động tính kích thước đóng gói — weight theo tổng số tấm thực tế
  const calculateKienDimensions = (items: CthtKien['items']) => {
  if (items.length === 0) return { w: 0, d: 0, h: 0, plates: 0, weight: 0 };
  const wArr = items.map(it => {
  const length = parseFloat(String(it.entry.pWidth || it.entry.width || it.entry.length || 0));
  return isNaN(length) ? 0 : length;
  });
  const wMax = Math.max(...wArr, 0);

  const dArr = items.map(it => {
  const width = parseFloat(String(it.entry.pDepth || it.entry.depth || 0));
  return isNaN(width) ? 0 : width;
  });
  const dMax = Math.max(...dArr, 0);

  // Weight: tổng (số tấm × W × D × 18mm × 750 kg/m³)
  let totalWeight = 0;
  for (const it of items) {
    const pw = parseFloat(String(it.entry.pWidth || it.entry.width || it.entry.length || 0)) || 0;
    const pd = parseFloat(String(it.entry.pDepth || it.entry.depth || 0)) || 0;
    const qty = it.quantity || 1;
    if (pw > 0 && pd > 0) {
      totalWeight += (pw * pd * 18 * qty) / 1000000000 * 750 * 0.7;
    }
  }

  const totalPlates = items.reduce((acc, it) => acc + (it.quantity || 0), 0);
  const hTotal = totalPlates * 20;

  return {
  w: Math.round(wMax) + 50,
  d: Math.round(dMax) + 50,
  h: Math.round(hTotal) + 50,
  plates: totalPlates,
  weight: Math.round(totalWeight * 10) / 10
  };
  };

 // Nhận diện kiện CTHT (hỗ trợ cả format cũ và mới)
 const isCthtKien = (item: PackingItem) => {
   if (item.subType === 'kienCTHT') return true;
   const name = (item.name || '').toLowerCase();
   if (name.startsWith('kiện ctht') || name.startsWith('kien ctht')) return true;
   if (name.startsWith('finished panel') || name.includes('finished panel')) return true;
   if ((item.cluster || '').toLowerCase() === 'chi tiết hỗ trợ' && (item.accessories || []).length > 0) return true;
   return false;
 };

 // Khởi tạo cthtKiens từ gridData ban đầu
 useEffect(() => {
   if (cthtInitialized) return;
   if (cthtProjectEntries.length === 0) return;

   const detailItems = gridData.filter(item => isCthtKien(item));
   if (detailItems.length === 0) {
     setCthtInitialized(true);
     return;
   }
   const initialKiens: CthtKien[] = detailItems.map(item => {
     const kienItems: CthtKien['items'] = [];

     (item.accessories || []).forEach(acc => {
       const accLower = (acc.name || '').toLowerCase();
       if (accLower.includes('hút ẩm') || accLower.includes('hut am')) {
         return; // Bỏ qua gói hút ẩm trong kiện CTHT của Tab 2
       }
       // Tìm theo acc.id trước, sau đó fallback tìm theo acc.name chuẩn hóa trim()
       const foundEntry = (acc as any).id ? cthtProjectEntries.find(e => e.id === (acc as any).id) : undefined;
       const fallbackEntry = foundEntry || cthtProjectEntries.find(e => (e.moduleCode || '').trim().toLowerCase() === (acc.name || '').trim().toLowerCase());
       
       if (fallbackEntry) {
         kienItems.push({
           entryId: fallbackEntry.id,
           moduleCode: fallbackEntry.moduleCode,
           quantity: acc.quantity || 1,
           entry: fallbackEntry
         });
       } else {
         const dummyEntry: ProjectEntry = {
           id: `dummy_${acc.name}_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
           projectName: packingList.title || '',
           projectCode: packingList.projectCode || '',
           moduleCode: acc.name,
           classification: 'CTHT',
           quantity: acc.quantity || 1,
           length: 0,
           width: 0,
           height: 0,
           pWidth: 0,
           pDepth: 0,
           pHeight: 0,
           cluster: 'Hỗ trợ',
           ownerId: packingList.ownerId || '',
           createdAt: new Date()
         };
         kienItems.push({
           entryId: dummyEntry.id,
           moduleCode: acc.name,
           quantity: acc.quantity || 1,
           entry: dummyEntry
         });
       }
     });

     return {
       id: item.id || `kien_ctht_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
       name: item.name,
       cluster: item.cluster || 'Chi tiết hỗ trợ',
       packed: item.packed || false,
       loaded: item.loaded || false,
       packedBy: item.packedBy || '',
       loadedBy: item.loadedBy || '',
       items: kienItems
     };
   });

   setCthtKiens(initialKiens);
   if (initialKiens.length > 0) {
     setActiveKienId(initialKiens[0].id);
   }
   setCthtInitialized(true);
 }, [gridData, cthtProjectEntries, cthtInitialized, packingList]);

 // Khi projectEntries lazy-load xong → cập nhật dummy entries bằng real entries
 useEffect(() => {
   if (!cthtInitialized || cthtProjectEntries.length === 0) return;

   setCthtKiens(prev => {
     let changed = false;
     const next = prev.map(kien => {
       const updatedItems = kien.items.map(it => {
         if (!it.entryId.startsWith('dummy_')) return it;
         const realEntry = cthtProjectEntries.find(e =>
           e.id === it.entryId ||
           (e.moduleCode || '').trim().toLowerCase() === it.moduleCode.trim().toLowerCase()
         );
         if (realEntry) {
           changed = true;
           return { entryId: realEntry.id, moduleCode: realEntry.moduleCode, quantity: it.quantity, entry: realEntry };
         }
         return it;
       });
       if (changed) return { ...kien, items: updatedItems };
       return kien;
     });
     return changed ? next : prev;
   });
 }, [cthtProjectEntries, cthtInitialized]);

 // Đồng bộ thời gian thực từ cthtKiens (TAB CẤU KIỆN CTHT) qua gridData (TAB THÙNG & PHỤ KIỆN)
 useEffect(() => {
   if (!cthtInitialized) return;

   setGridData(prevGrid => {
     let changed = false;
     const nextGrid = prevGrid.map(item => {
       if (isCthtKien(item)) {
         const kien = cthtKiens.find(k => k.id === item.id);
         if (kien) {
           const dims = calculateKienDimensions(kien.items);
           const autoW = dims.w.toString();
           const autoD = dims.d.toString();
           const autoH = dims.h.toString();
           const autoWeight = parseFloat(calculateCabinetWeight(autoW, autoD, autoH)) || 0;

           const isWChanged = item.w !== autoW;
           const isDChanged = item.d !== autoD;
           const isHChanged = item.h !== autoH;
           const isWeightChanged = item.weight !== autoWeight;
           const isNameChanged = item.name !== kien.name;
           const isClusterChanged = item.cluster !== kien.cluster;

           const nextAccs = kien.items.map(it => ({
             id: it.entryId,
             name: it.moduleCode,
             quantity: it.quantity,
             checked: false
           }));

           // Kiểm tra xem danh sách accessories thực tế có khác biệt không
           const prevAccs = item.accessories || [];
           const isAccessoriesChanged = JSON.stringify(prevAccs.map(a => ({ id: (a as any).id, name: a.name, qty: a.quantity }))) !== 
                                        JSON.stringify(nextAccs.map(a => ({ id: a.id, name: a.name, qty: a.quantity })));

           if (isWChanged || isDChanged || isHChanged || isWeightChanged || isNameChanged || isClusterChanged || isAccessoriesChanged) {
             changed = true;
             return {
               ...item,
               name: kien.name,
               cluster: kien.cluster || item.cluster,
               w: autoW,
               d: autoD,
               h: autoH,
               weight: autoWeight,
               accessories: nextAccs
             };
           }
         }
       }
       return item;
     });

     // Thêm mới kiện gỗ vừa tạo từ Tab CTHT vào Grid Thùng
     const existingIds = new Set(prevGrid.map(item => item.id));
     const newKiens = cthtKiens.filter(k => !existingIds.has(k.id));
     if (newKiens.length > 0) {
       changed = true;
       newKiens.forEach(k => {
         const dims = calculateKienDimensions(k.items);
         const autoW = dims.w.toString();
         const autoD = dims.d.toString();
         const autoH = dims.h.toString();
         const autoWeight = parseFloat(calculateCabinetWeight(autoW, autoD, autoH)) || 0;
         
         nextGrid.push({
           id: k.id,
           tempId: k.id,
           name: k.name,
           quantity: 1,
           packed: k.packed || false,
           loaded: k.loaded || false,
           packedQty: k.packed ? 1 : 0,
           packedBy: k.packedBy || '',
           loadedBy: k.loadedBy || '',
           subType: 'kienCTHT',
           cluster: k.cluster || 'Chi tiết hỗ trợ',
           isExtra: true,
           w: autoW,
           d: autoD,
           h: autoH,
           weight: autoWeight,
           accessories: k.items.map(it => ({
             id: it.entryId,
             name: it.moduleCode,
             quantity: it.quantity,
             checked: false
           }))
         });
       });
     }

     // Xóa các kiện bị tháo gỡ hoàn toàn
     const activeKienIds = new Set(cthtKiens.map(k => k.id));
     const filteredGrid = nextGrid.filter(item => {
       if (isCthtKien(item) && !activeKienIds.has(item.id)) {
         changed = true;
         return false;
       }
       return true;
     });

     return changed ? filteredGrid : prevGrid;
   });
 }, [cthtKiens, cthtInitialized]);

 // Các hàm thao tác gán ghép trực quan
 const handleAddEntryToKien = (entryId: string, kienId: string, quantityToMove?: number) => {
 const entry = cthtProjectEntries.find(e => e.id === entryId);
 if (!entry) return;

 const totalQty = entry.quantity || 1;
 let currentAssignedInOthers = 0;
 cthtKiens.forEach(k => {
 if (k.id !== kienId) {
 k.items.forEach(it => {
 if (it.entryId === entryId) {
 currentAssignedInOthers += it.quantity;
 }
 });
 }
 });

 const maxAvailable = Math.max(0, totalQty - currentAssignedInOthers);
 if (maxAvailable <= 0) return;

 const moveQty = quantityToMove !== undefined ? Math.min(quantityToMove, maxAvailable) : maxAvailable;
 if (moveQty <= 0) return;

 setCthtKiens(prev => {
 const next = prev.map(k => {
 if (k.id !== kienId) return k;

 const existingItemIdx = k.items.findIndex(it => it.entryId === entryId);
 const updatedItems = [...k.items];

 if (existingItemIdx !== -1) {
 const newQty = updatedItems[existingItemIdx].quantity + moveQty;
 updatedItems[existingItemIdx] = {
 ...updatedItems[existingItemIdx],
 quantity: Math.min(newQty, totalQty - currentAssignedInOthers)
 };
 } else {
 updatedItems.push({
 entryId,
 moduleCode: entry.moduleCode,
 quantity: moveQty,
 entry
 });
 }

 return { ...k, items: updatedItems };
 });

 // Đồng bộ ngay về PackingScreen để unpackedCTHTs cập nhật
 if (onItemsChange) {
   const allItems = gridData;
   const updatedAllItems = allItems.map(item => {
     const kien = next.find(k => k.id === item.id);
     if (!kien) return item;
     return { ...item, accessories: kien.items.map(it => ({ name: it.moduleCode, quantity: it.quantity, checked: false, entryId: it.entryId })) };
   });
   onItemsChange(updatedAllItems);
 }

 return next;
 });
 setIsCthtDirty(true);
 };

 const handleUpdateQtyInKien = (kienId: string, entryId: string, delta: number) => {
 const nextKiens = cthtKiens.map(k => {
 if (k.id !== kienId) return k;

 const updatedItems = k.items.map(it => {
 if (it.entryId !== entryId) return it;

 const totalQty = it.entry.quantity || 1;
 let currentAssignedInOthers = 0;
 cthtKiens.forEach(otherK => {
 if (otherK.id !== kienId) {
   otherK.items.forEach(otherIt => {
     if (otherIt.entryId === entryId) {
       currentAssignedInOthers += otherIt.quantity;
     }
   });
 }
 });

 const maxAvailable = totalQty - currentAssignedInOthers;
 const newQty = Math.max(0, Math.min(maxAvailable, it.quantity + delta));
 return { ...it, quantity: newQty };
 }).filter(it => it.quantity > 0);

 return { ...k, items: updatedItems };
 });
 setCthtKiens(nextKiens);
 setIsCthtDirty(true);

 if (onItemsChange) {
   const allItems = gridData;
   const updatedAllItems = allItems.map(item => {
     const kien = nextKiens.find(k => k.id === item.id);
     if (!kien) return item;
     return { ...item, accessories: kien.items.map(it => ({ name: it.moduleCode, quantity: it.quantity, checked: false, entryId: it.entryId })) };
   });
   onItemsChange(updatedAllItems);
 }
 };

 const handleRemoveEntryFromKien = (kienId: string, entryId: string) => {
 const nextKiens = cthtKiens.map(k => {
 if (k.id !== kienId) return k;
 return {
   ...k,
   items: k.items.filter(it => it.entryId !== entryId)
 };
 });
 setCthtKiens(nextKiens);
 setIsCthtDirty(true);

 if (onItemsChange) {
   const allItems = gridData;
   const updatedAllItems = allItems.map(item => {
     const kien = nextKiens.find(k => k.id === item.id);
     if (!kien) return item;
     return { ...item, accessories: kien.items.map(it => ({ name: it.moduleCode, quantity: it.quantity, checked: false, entryId: it.entryId })) };
   });
   onItemsChange(updatedAllItems);
 }
 };

 const handleCreateNewKien = (name: string, cluster: string = 'Chi tiết hỗ trợ') => {
 const cleanName = name.trim().toUpperCase();
 if (!cleanName) return;

 const isDup = cthtKiens.some(k => k.name.toUpperCase() === cleanName);
 if (isDup) {
 alert("Tên kiện CTHT này đã tồn tại!");
 return;
 }

 const newKien: CthtKien = {
 id: `ctht_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
 name: cleanName,
 cluster: cluster.trim() || 'Chi tiết hỗ trợ',
 packed: false,
 loaded: false,
 packedBy: '',
 loadedBy: '',
 items: []
 };

 setCthtKiens(prev => [...prev, newKien]);
 setActiveKienId(newKien.id);
 setIsCthtDirty(true);
 };

 const handleSaveEditKien = () => {
 const cleanName = editKienName.trim().toUpperCase();
 if (!cleanName) return;

 if (!editingKien) return;

 const isDup = cthtKiens.some(k => k.id !== editingKien.id && k.name.toUpperCase() === cleanName);
 if (isDup) {
 alert("Tên kiện CTHT này đã tồn tại!");
 return;
 }

 setCthtKiens(prev => prev.map(k => {
 if (k.id !== editingKien.id) return k;
 return {
 ...k,
 name: cleanName,
 cluster: editKienCluster.trim() || 'Chi tiết hỗ trợ'
 };
 }));
 setIsCthtDirty(true);
 setEditingKien(null);
 };

 const handleDeleteKien = (kienId: string) => {
 const nextKiens = cthtKiens.filter(k => k.id !== kienId);
 setCthtKiens(nextKiens);
 if (activeKienId === kienId) {
   setActiveKienId(null);
 }
 setIsCthtDirty(true);

 // Dong bo ve PackingScreen de unpackedCTHTs cap nhat
 if (onItemsChange) {
   const allItems = gridData;
   const updatedAllItems = allItems
     .filter(item => item.id !== kienId)
     .map(item => {
       const kien = nextKiens.find(k => k.id === item.id);
       if (!kien) return item;
       return { ...item, accessories: kien.items.map(it => ({ name: it.moduleCode, quantity: it.quantity, checked: false, entryId: it.entryId })) };
     });
   onItemsChange(updatedAllItems);
 }
 };

 const generateNextKienName = () => {
 let maxNum = 0;
 cthtKiens.forEach(k => {
 const parts = k.name.trim().toUpperCase().split(/\s+/);
 const lastPart = parts[parts.length - 1];
 const num = parseInt(lastPart);
 if (!isNaN(num) && num > maxNum) {
 maxNum = num;
 }
 });
  return `KIỆN CTHT ${maxNum + 1}`;
  };

  // Tự động tạo kiện CTHT theo logic giống lúc tạo phiếu đóng gói
  const handleAutoGenerateCtht = () => {
    const entriesToAssign = unpackedCTHTs.filter(e => (e.remainingQty || 0) > 0);
    if (entriesToAssign.length === 0) return;

    const calcSinglePanelWeight = (w: number, d: number, thickness: number): number => {
      if (w <= 0 || d <= 0 || thickness <= 0) return 0;
      return (w * d * thickness) / 1000000000 * 750 * 0.7;
    };

    const isLenFil = (e: ProjectEntry) => {
      const n = (e.moduleCode || '').toLowerCase();
      return n.includes('fil') || n.includes('len');
    };
    const isThanhTreo = (e: ProjectEntry) => {
      const n = (e.moduleCode || '').toLowerCase();
      return n.includes('thanh treo');
    };

    const normalCthts = entriesToAssign.filter(e => !isLenFil(e) && !isThanhTreo(e));
    const lenFilCthts = entriesToAssign.filter(e => isLenFil(e));
    const thanhTreoCthts = entriesToAssign.filter(e => isThanhTreo(e));

    const groupedByCluster: Record<string, ProjectEntry[]> = {};
    normalCthts.forEach(entry => {
      const cluster = entry.cluster || 'Khong phan cum';
      if (!groupedByCluster[cluster]) groupedByCluster[cluster] = [];
      groupedByCluster[cluster].push(entry);
    });
    if (lenFilCthts.length > 0) groupedByCluster['LEN, FILLER'] = lenFilCthts;
    if (thanhTreoCthts.length > 0) groupedByCluster['Wall Cabinet Hanger'] = thanhTreoCthts;

    const newKiens: CthtKien[] = [];
    let kienCounter = cthtKiens.length;

    for (const [cluster, cthts] of Object.entries(groupedByCluster)) {
      const baseName = cluster === 'Wall Cabinet Hanger' ? 'Wall Cabinet Hanger' : cluster === 'LEN, FILLER' ? 'LEN, FILLER' : 'FINISHED PANEL';

      const sortedCthts = [...cthts].sort((a, b) => {
        const partsA = (a.moduleCode || '').split('_');
        const partsB = (b.moduleCode || '').split('_');
        const typeA = partsA.length > 1 ? partsA[partsA.length - 1].toUpperCase() : '';
        const typeB = partsB.length > 1 ? partsB[partsB.length - 1].toUpperCase() : '';
        if (typeA !== typeB) return typeA.localeCompare(typeB);
        return (a.moduleCode || '').localeCompare(b.moduleCode || '');
      });

      const finalChunks: { entries: ProjectEntry[]; quantities: number[] }[] = [];
      let currentChunk: ProjectEntry[] = [];
      let currentQtys: number[] = [];
      let currentWeight = 0;

      for (const entry of sortedCthts) {
        const pw = parseFloat(String(entry.pWidth || entry.width || entry.length || 0)) || 0;
        const pd = parseFloat(String(entry.pDepth || entry.depth || 0)) || 0;
        const qty = entry.quantity || 1;
        const unitWeight = (pw > 0 && pd > 0) ? Math.round(calcSinglePanelWeight(pw, pd, 18) * 10) / 10 : 0;
        const entryTotalWeight = unitWeight * qty;

        if (entryTotalWeight <= 0) {
          currentChunk.push(entry);
          currentQtys.push(qty);
          continue;
        }

        // Tính số tấm còn vừa 60kg
        let remaining = qty;
        while (remaining > 0) {
          const spaceLeft = 60 - currentWeight;
          const maxFit = unitWeight > 0 ? Math.floor(spaceLeft / unitWeight) : remaining;
          const take = Math.min(remaining, Math.max(0, maxFit));

          if (take <= 0 && currentChunk.length > 0) {
            // Đầy rồi → lưu chunk hiện tại, mở chunk mới
            finalChunks.push({ entries: [...currentChunk], quantities: [...currentQtys] });
            currentChunk = [];
            currentQtys = [];
            currentWeight = 0;
            continue;
          }

          if (take < remaining) {
            // Chỉ lấy 1 phần → lưu chunk hiện tại, phần còn lại tiếp tục
            currentChunk.push(entry);
            currentQtys.push(take);
            currentWeight += unitWeight * take;
            finalChunks.push({ entries: [...currentChunk], quantities: [...currentQtys] });
            currentChunk = [];
            currentQtys = [];
            currentWeight = 0;
            remaining -= take;
          } else {
            // Lấy hết
            currentChunk.push(entry);
            currentQtys.push(take);
            currentWeight += unitWeight * take;
            remaining -= take;
          }
        }
      }
      if (currentChunk.length > 0) finalChunks.push({ entries: [...currentChunk], quantities: [...currentQtys] });

      const total = finalChunks.length;
      finalChunks.forEach((chunk, idx) => {
        kienCounter++;
        const suffix = total > 1 ? ` ${idx + 1}/${total}` : '';
        const kienCluster = cluster === 'Wall Cabinet Hanger' ? 'KITCHEN' : cluster;
        const kienId = `ctht-auto-${cluster}-${Date.now()}-${idx}`;
        const kienName = `${baseName}${suffix}`;

        newKiens.push({
          id: kienId,
          name: kienName,
          cluster: kienCluster,
          packed: false,
          loaded: false,
          items: chunk.entries.map((c, i) => ({
            entryId: c.id,
            moduleCode: c.moduleCode,
            quantity: chunk.quantities[i] || c.quantity || 1,
            entry: c,
          })),
        });
      });
    }

    if (newKiens.length > 0) {
      setCthtKiens(prev => [...prev, ...newKiens]);
      setIsCthtDirty(true);
      // Đồng bộ về PackingScreen
      if (onItemsChange) {
        const allItems = gridData;
        const newPackingItems: PackingItem[] = newKiens.map(k => {
          const accs = k.items.map(it => ({ name: it.moduleCode, quantity: it.quantity, checked: false, entryId: it.entryId }));
          const dims = calculateKienDimensions(k.items);
          return {
            id: k.id,
            name: k.name,
            rawQR: `${k.id}|${k.name}`,
            quantity: 1,
            packed: false,
            packStatus: 'pending',
            subType: 'kienCTHT',
            cluster: k.cluster,
            isExtra: true,
            w: String(dims.w), d: String(dims.d), h: String(dims.h),
            weight: dims.weight,
            accessories: accs,
          };
        });
        onItemsChange([...allItems, ...newPackingItems]);
      }
    }
  };

  const calculateCabinetWeightLocal = (wStr: string, dStr: string, hStr: string): string => {
    const w = parseFloat(wStr) || 0;
    const d = parseFloat(dStr) || 0;
    const h = parseFloat(hStr) || 0;
    if (w <= 0 || d <= 0 || h <= 0) return "0";
    const doorsAndBack = h * w * 18 * 3;
    const sides = h * d * 18 * 2;
    const topAndBottom = w * d * 18 * 2;
    const totalMm3 = doorsAndBack + sides + topAndBottom;
    const totalM3 = totalMm3 / 1000000000;
    const weightKg = totalM3 * 750 * 0.7;
    return (Math.round(weightKg * 10) / 10).toString();
  };

  const handleDragStart = (e: React.DragEvent, entryId: string) => {
 e.dataTransfer.setData('text/plain', entryId);
 };

 const handleDropOnKien = (e: React.DragEvent, kienId: string) => {
 e.preventDefault();
 const entryId = e.dataTransfer.getData('text/plain');
 if (entryId) {
 const entry = cthtProjectEntries.find(ent => ent.id === entryId);
 if (entry) {
 // Tính maxAvailable
 const totalQty = entry.quantity || 1;
 let currentAssignedInOthers = 0;
 cthtKiens.forEach(k => {
 k.items.forEach(it => {
 if (it.entryId === entryId) {
 currentAssignedInOthers += it.quantity;
 }
 });
 });
 const maxAvailable = Math.max(0, totalQty - currentAssignedInOthers);
 if (maxAvailable > 1) {
 setShowQtySelector({
 entryId,
 kienId,
 maxAvailable,
 defaultQty: maxAvailable
 });
 } else if (maxAvailable === 1) {
 handleAddEntryToKien(entryId, kienId, 1);
 }
 }
 }
 };

 // Các CTHT chưa được đóng gói (Bên phải)
 const unassignedCthtEntries = useMemo(() => {
 // Dung truc tiep unpackedCTHTs tu父 component (single source of truth)
 const list = unpackedCTHTs.map(entry => ({
   entry,
   totalQty: entry.quantity || 1,
   assignedQty: (entry.quantity || 1) - (entry.remainingQty || 0),
   remainingQty: entry.remainingQty || 0
 }));

 // Xep theo thu tu chu cai va theo cum
 const sortedList = [...list].sort((a, b) => {
   const clusterA = (a.entry.cluster || '').toLowerCase();
   const clusterB = (b.entry.cluster || '').toLowerCase();
   if (clusterA !== clusterB) {
     return clusterA.localeCompare(clusterB, 'vi');
   }
   const codeA = (a.entry.moduleCode || '').toLowerCase();
   const codeB = (b.entry.moduleCode || '').toLowerCase();
   return codeA.localeCompare(codeB, 'vi');
 });

 if (cthtSearch) {
   const lowerSearch = cthtSearch.toLowerCase();
   return sortedList.filter(item =>
     item.entry.moduleCode?.toLowerCase().includes(lowerSearch) ||
     (item.entry.cluster || '').toLowerCase().includes(lowerSearch)
   );
 }

 return sortedList;
 }, [unpackedCTHTs, cthtSearch]);

 // Lọc kiện theo tên/mã cấu kiện tìm kiếm
 const filteredCthtKiens = useMemo(() => {
 if (!kienSearch.trim()) return cthtKiens;
 const q = kienSearch.trim().toLowerCase();
 return cthtKiens.filter(kien => {
 if (kien.name.toLowerCase().includes(q)) return true;
 return kien.items.some(it =>
 (it.moduleCode || '').toLowerCase().includes(q) ||
 (it.entry?.cluster || '').toLowerCase().includes(q)
 );
 });
 }, [cthtKiens, kienSearch]);


 // Context Menu for right click on STT in Tab Thung
 const [contextMenu, setContextMenu] = useState<{
 x: number;
 y: number;
 index: number;
 item: EditablePackingItem;
 } | null>(null);

 // Extract all unique clusters
 const availableClusters = useMemo(() => {
 const list = gridData
 .map(item => item.cluster || '')
 .filter(c => c.trim().length > 0);
 return Array.from(new Set(list));
 }, [gridData]);

 const handleCellChange = (tempId: string, field: keyof EditablePackingItem, value: any) => {
 setGridData(prev => prev.map(item => {
 if (item.tempId !== tempId) return item;

 const updated = { ...item, [field]: value };

 // Chặn NaN khi sửa cột weight (Firestore từ chối lưu NaN)
 if (field === 'weight' && updated.weight !== undefined && !Number.isFinite(Number(updated.weight))) {
   updated.weight = undefined;
 }

 // Khi đổi subType sang kienCTHT → thêm vào cthtKiens và set cluster
 if (field === 'subType' && value === 'kienCTHT') {
   if (!updated.cluster || updated.cluster === 'Thủ công') {
     updated.cluster = 'Chi tiết hỗ trợ';
   }
   const existingKien = cthtKiens.find(k => k.id === item.id);
   if (!existingKien) {
    setCthtKiens(prev => [...prev, {
     id: item.id || `ctht_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
     name: item.name || 'KIỆN CTHT MỚI',
     cluster: item.cluster || 'Chi tiết hỗ trợ',
     packed: item.packed || false,
     loaded: item.loaded || false,
     packedBy: item.packedBy || '',
     loadedBy: item.loadedBy || '',
     items: []
    }]);
    setActiveKienId(item.id);
   }
 }

 // Khi đổi subType sang kienPhuKien → set cluster và isExtra
 if (field === 'subType' && value === 'kienPhuKien') {
   updated.isExtra = true;
   updated.cluster = 'Phụ kiện kèm theo';
 }

 // Khi đổi subType từ kienCTHT/kienPhuKien sang loại khác → xóa khỏi cthtKiens
 if (field === 'subType' && value !== 'kienCTHT' && value !== 'kienPhuKien') {
   const existingKien = cthtKiens.find(k => k.id === item.id);
   if (existingKien) {
    setCthtKiens(prev => prev.filter(k => k.id !== item.id));
    if (activeKienId === item.id) setActiveKienId(null);
   }
 }

 if (field === 'w' || field === 'd' || field === 'h') {
 const nextW = field === 'w' ? value : (item.w || '0');
 const nextD = field === 'd' ? value : (item.d || '0');
 const nextH = field === 'h' ? value : (item.h || '0');
 const weightStr = calculateCabinetWeight(nextW, nextD, nextH);
 updated.weight = parseFloat(weightStr) || 0;
 }

 const displayLabel = userProfile?.ten_that
 ? `${userProfile.ten_that} (${userProfile.chuc_danh || 'NV'})`
 : (user?.displayName || 'Anonymous');

 if (field === 'quantity') {
 const nextQty = value;
 if (item.packed) {
 updated.packedQty = nextQty;
 } else {
 updated.packedQty = 0;
 }
 }

 if (field === 'packed') {
 if (value) {
 updated.packedBy = item.packedBy || displayLabel;
 updated.packedQty = item.quantity || 1;
 } else {
 updated.packedBy = '';
 updated.packedQty = 0;
 updated.loaded = false;
 updated.loadedBy = '';
 }
 }

 if (field === 'loaded') {
 if (value) {
 updated.loadedBy = item.loadedBy || displayLabel;
 updated.packed = true;
 updated.packedBy = item.packedBy || displayLabel;
 updated.packedQty = item.quantity || 1;
 } else {
 updated.loadedBy = '';
 }
 }

 return updated;
 }));

 setDirtyRowIds(prev => {
 const next = new Set(prev);
 next.add(tempId);
 return next;
 });
 };

 const handleAddRowOption = (direction: 'above' | 'below', index: number) => {
 const newTempId = `new_item_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const newItem: EditablePackingItem = {
  id: newTempId,
  tempId: newTempId,
  name: 'Mặt hàng mới',
  quantity: 1,
  packed: false,
  loaded: false,
  isExtra: true,
  subType: 'kienModule',
  cluster: 'Cấu kiện ngoài',
  packedBy: '',
  loadedBy: '',
  createdAt: Date.now()
  };

  const targetIdx = direction === 'above' ? index : index + 1;
 const next = [...gridData];
 next.splice(targetIdx, 0, newItem);
 setGridData(next);

 setDirtyRowIds(prev => {
 const nextSet = new Set(prev);
 nextSet.add(newTempId);
 return nextSet;
 });

 setContextMenu(null);
 };

 const handleDeleteRowOption = (index: number) => {
 const targetItem = gridData[index];
 if (!targetItem) return;

 setDeletedRowIds(prev => {
 const next = new Set(prev);
 next.add(targetItem.tempId);
 return next;
 });

 setDirtyRowIds(prev => {
 const next = new Set(prev);
 next.delete(targetItem.tempId);
 return next;
 });

 const next = [...gridData];
 next.splice(index, 1);
 setGridData(next);

 setContextMenu(null);
 };

 const handleDeleteRowByTempId = (tempId: string) => {
 const idx = gridData.findIndex(item => item.tempId === tempId);
 if (idx === -1) return;
 handleDeleteRowOption(idx);
 };

 const handleBulkDeleteSelected = () => {
 if (selectedRowIds.size === 0) return;
 const toDelete = [...selectedRowIds];
 setDeletedRowIds(prev => {
   const next = new Set(prev);
   toDelete.forEach(id => next.add(id));
   return next;
 });
 setDirtyRowIds(prev => {
   const next = new Set(prev);
   toDelete.forEach(id => next.delete(id));
   return next;
 });
 setGridData(prev => prev.filter(item => !selectedRowIds.has(item.tempId)));
 setSelectedRowIds(new Set());
 };

 const handleAppendRow = () => {
 const newTempId = `new_item_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const newItem: EditablePackingItem = {
  id: newTempId,
  tempId: newTempId,
  name: 'Mã mọc hoặc Phụ kiện...',
  quantity: 1,
  packed: false,
  loaded: false,
  isExtra: true,
  subType: 'kienModule',
  cluster: 'Cấu kiện ngoài',
  packedBy: '',
  loadedBy: '',
  createdAt: Date.now()
  };

  setGridData(prev => [...prev, newItem]);
 setDirtyRowIds(prev => {
 const next = new Set(prev);
 next.add(newTempId);
 return next;
 });
 };

 const handleSTTContextMenu = (e: React.MouseEvent, item: EditablePackingItem, index: number) => {
 e.preventDefault();
 setContextMenu({
 x: e.clientX,
 y: e.clientY,
 index,
 item
 });
 };

 // Filter grid rows for Tab Thùng (Structural items)
 const filteredThungRows = useMemo(() => {
 const list = gridData.filter(item => {
 if (searchTerm) {
 const matchesName = matchSearchQuery(item.name || '', searchTerm);
 const matchesCluster = matchSearchQuery(item.cluster || '', searchTerm);
 if (!matchesName && !matchesCluster) return false;
 }

 if (subTypeFilter) {
   const itemSubType = item.subType || 'kienModule';
   if (itemSubType !== subTypeFilter) return false;
 }
 if (clusterFilter && item.cluster !== clusterFilter) return false;

 if (statusFilter) {
 if (statusFilter === 'unpacked' && item.packed) return false;
 if (statusFilter === 'packed' && (!item.packed || item.loaded)) return false;
 if (statusFilter === 'loaded' && !item.loaded) return false;
 }

  return true;
  });

  return list;
  }, [gridData, searchTerm, subTypeFilter, clusterFilter, statusFilter]);

 // Save changes
 const handleSave = async () => {
 setLoading(true);
 try {
 // 0. Đồng bộ edits từ gridData vào cthtKiens trước khi lưu
 // (Khi user sửa kiện CTHT trong tab Thùng, edits chỉ nằm trong gridData)
 const syncedCthtKiens = cthtKiens.map(k => {
 const gridItem = gridData.find(g => g.id === k.id && g.subType === 'kienCTHT');
 if (!gridItem) return k;
 return {
 ...k,
 name: gridItem.name || k.name,
 cluster: gridItem.cluster || k.cluster,
 packed: gridItem.packed ?? k.packed,
 loaded: gridItem.loaded ?? k.loaded,
 packedQty: gridItem.packedQty ?? k.packedQty,
 packedBy: gridItem.packedBy || k.packedBy,
 loadedBy: gridItem.loadedBy || k.loadedBy,
 };
 });

 // 1. Lọc bỏ kiện CTHT và item đã xóa
 const baseItems: PackingItem[] = gridData
 .filter(item => item.subType !== 'kienCTHT' && !deletedRowIds.has(item.tempId))
 .map(item => {
 const { tempId, ...rawItem } = item;
 return rawItem;
 })
 // Deduplicate theo id (giữ nguyên dòng mới chưa có id để không bị nuốt mất)
 .filter((item, idx, arr) => {
   if (!item.id) return true;
   return arr.findIndex(x => x.id === item.id) === idx;
 })
 .sort((a, b) => {
 const clusterA = (a.cluster || '').toLowerCase();
 const clusterB = (b.cluster || '').toLowerCase();
 if (clusterA !== clusterB) return clusterA.localeCompare(clusterB, 'vi');
 return (a.name || '').localeCompare(b.name || '', 'vi');
 });

 // 2. Tạo các PackingItem từ cthtKiens đã sync
 const nextCthtKiens: PackingItem[] = syncedCthtKiens
 .filter(k => k.items.length > 0)
 .map(k => {
 // Tìm ô dữ liệu thô đã sửa ở gridData (nếu có) để giữ nguyên các cột tùy biến (ghi chú, gói hút ấm, v.v.)
 const originalGridItem = gridData.find(item => item.id === k.id && item.subType === 'kienCTHT');

 // Tính kích thước tự động
 const dims = calculateKienDimensions(k.items);

 const displayLabel = userProfile?.ten_that
 ? `${userProfile.ten_that} (${userProfile.chuc_danh || 'NV'})`
 : (user?.displayName || 'Anonymous');

 // Đóng gói mảng accessories cho kiện CTHT
 const accessories = k.items.map(it => ({
   id: it.entryId,
   name: it.moduleCode,
   quantity: it.quantity,
   checked: false
 }));

 const isPacked = originalGridItem ? (originalGridItem.packed || k.packed) : k.packed;
 const isLoaded = originalGridItem ? (originalGridItem.loaded || k.loaded) : k.loaded;

 const finalW = !isZeroOrEmpty(originalGridItem?.w) ? originalGridItem!.w.toString() : dims.w.toString();
 const finalD = !isZeroOrEmpty(originalGridItem?.d) ? originalGridItem!.d.toString() : dims.d.toString();
 const finalH = !isZeroOrEmpty(originalGridItem?.h) ? originalGridItem!.h.toString() : dims.h.toString();
  const finalWeight = !isZeroOrEmpty(originalGridItem?.weight) 
  ? Number(originalGridItem!.weight) 
  : dims.weight;

 return {
 ...originalGridItem,
 id: k.id,
 name: k.name,
 quantity: originalGridItem?.quantity ?? 1,
 packed: isPacked,
 loaded: isLoaded,
 packedQty: isPacked ? (originalGridItem?.quantity ?? 1) : 0,
 packedBy: isPacked ? (originalGridItem?.packedBy || k.packedBy || displayLabel) : '',
 loadedBy: isLoaded ? (originalGridItem?.loadedBy || k.loadedBy || displayLabel) : '',
 subType: 'kienCTHT',
 cluster: k.cluster || originalGridItem?.cluster || 'Chi tiết hỗ trợ',
 isExtra: true,
 w: finalW,
 d: finalD,
 h: finalH,
 weight: finalWeight,
 accessories: accessories,
 createdAt: originalGridItem?.createdAt || Date.now()
 };
 });

 // 2b. Giữ lại kiện CTHT trong gridData chưa được đồng bộ vào cthtKiens
 // (tránh mất dữ liệu khi cthtKiens chưa khởi tạo kịp do projectEntries load chậm)
 const syncedIds = new Set(syncedCthtKiens.map(k => k.id));
 const fallbackCthtItems: PackingItem[] = gridData
   .filter(item => item.subType === 'kienCTHT' && !deletedRowIds.has(item.tempId) && !syncedIds.has(item.id))
   .map(item => {
     const { tempId, ...rawItem } = item;
     return rawItem;
   });

 // 3. Kết hợp lại, sắp xếp và lưu (chặn NaN ở cột weight — Firestore không chấp nhận NaN)
 const finalItems = [...baseItems, ...fallbackCthtItems, ...nextCthtKiens]
   .map(item => ({
     ...item,
     weight: Number.isFinite(Number(item.weight)) ? Number(item.weight) : undefined
   }))
   .sort((a, b) => {
     const clusterA = (a.cluster || '').toLowerCase();
     const clusterB = (b.cluster || '').toLowerCase();
     if (clusterA !== clusterB) return clusterA.localeCompare(clusterB, 'vi');
     return (a.name || '').localeCompare(b.name || '', 'vi');
   });
 await onSave(finalItems);
 
 // Đồng bộ lại gridData cục bộ với tempId để người dùng sửa tiếp không bị lỗi
 const remappedGridData = finalItems.map((item, idx) => {
 const existing = gridData.find(g => g.id === item.id);
 return {
 ...item,
 tempId: existing?.tempId || `${item.id || 'item'}_${idx}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
 };
 });
 setGridData(remappedGridData);
 setDirtyRowIds(new Set());
 setDeletedRowIds(new Set());
 setIsCthtDirty(false);
 setSaveStatus('success');
 setTimeout(() => setSaveStatus('idle'), 3000);
 } catch (err: any) {
 console.error("Lỗi khi lưu bảng Excel:", err);
 alert("Lỗi khi lưu: " + (err?.message || 'Không xác định') + ". Dữ liệu chưa được lưu vào servidor.");
 } finally {
 setLoading(false);
 }
 };

 return (
 <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[110] p-4 backdrop-blur-xs">
 <div className="bg-white w-[96vw] h-[92vh] rounded-xl border border-slate-200 flex flex-col overflow-hidden shadow-2xl">

 {/* Header Toolbar */}
 <div className="px-6 py-4 border-b border-slate-100 bg-white flex flex-col sm:flex-row sm:items-center justify-between gap-4">
 <div className="flex flex-col">
 <span className="text-[10px] font-black text-indigo-600 uppercase tracking-widest">
 Giao diện chỉnh sửa chi tiết (Dành cho PC)
 </span>
 <h3 className="text-base font-black text-slate-800 uppercase tracking-tight flex items-center gap-2">
 <span>BẢNG EXCEL ĐÓNG GÓI:</span>
 <span className="text-indigo-600 font-mono text-sm tracking-wide">{packingList.title}</span>
 </h3>
 </div>

 <div className="flex flex-wrap items-center gap-3">
 {/* Tabs selector */}
 <div className="flex bg-slate-100 p-1 rounded-lg border border-slate-200/60 mr-3">
 <button
 type="button"
 onClick={() => setActiveTab('thung')}
 className={`px-4 py-1.5 rounded-lg text-xs font-black uppercase tracking-wider transition-all cursor-pointer ${activeTab === 'thung'
 ? 'bg-white text-indigo-600 shadow-xs'
 : 'text-slate-500 hover:text-slate-700'
 }`}
 >
 TAB THÙNG & PHỤ KIỆN
 </button>
 <button
 type="button"
 onClick={() => setActiveTab('ctht')}
 className={`px-4 py-1.5 rounded-lg text-xs font-black uppercase tracking-wider transition-all cursor-pointer ${activeTab === 'ctht'
 ? 'bg-white text-indigo-600 shadow-xs'
 : 'text-slate-500 hover:text-slate-700'
 }`}
 >
 TAB CẤU KIỆN CTHT ({cthtProjectEntries.length})
 </button>
 </div>

 {/* Select All / Bulk Delete buttons */}
 {activeTab === 'thung' && (
 <div className="flex items-center gap-2 mr-3">
   <button
     type="button"
     onClick={() => {
       const allFiltered = filteredThungRows.every(item => selectedRowIds.has(item.tempId));
       if (allFiltered) {
         setSelectedRowIds(new Set());
       } else {
         setSelectedRowIds(new Set(filteredThungRows.map(item => item.tempId)));
       }
     }}
     className="px-3 py-1.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 rounded-lg text-[10px] font-black uppercase tracking-wider border border-indigo-200 transition-all cursor-pointer flex items-center gap-1"
   >
     <Check size={12} />
     Chọn nhanh ({filteredThungRows.length})
   </button>
   {selectedRowIds.size > 0 && (
     <button
       type="button"
       onClick={handleBulkDeleteSelected}
       className="px-3 py-1.5 bg-rose-50 hover:bg-rose-100 text-rose-700 rounded-lg text-[10px] font-black uppercase tracking-wider border border-rose-200 transition-all cursor-pointer flex items-center gap-1"
     >
       <Trash2 size={12} />
       Xoá ({selectedRowIds.size})
     </button>
   )}
 </div>
 )}

 {/* Close Button */}
 <button
 onClick={onClose}
 className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-[11px] font-black uppercase tracking-widest border border-slate-200 transition-all cursor-pointer"
 >
 Đóng
 </button>

 {/* Save Button */}
 <button
 disabled={loading}
 onClick={handleSave}
 className={`px-5 py-2 rounded-lg text-[11px] font-black uppercase tracking-widest transition-all shadow-md flex items-center justify-center space-x-2 cursor-pointer ${
 saveStatus === 'success' 
 ? 'bg-emerald-600 hover:bg-emerald-700 text-white' 
 : 'bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-600/50 text-white'
 }`}
 >
 {loading ? (
 <Loader2 size={13} className="animate-spin" />
 ) : saveStatus === 'success' ? (
 <CheckCircle size={13} />
 ) : (
 <Save size={13} />
 )}
 <span>
 {saveStatus === 'success' 
 ? 'Đã lưu thành công!' 
 : `Lưu thay đổi (${dirtyRowIds.size + deletedRowIds.size + (isCthtDirty ? 1 : 0)})`}
 </span>
 </button>
 </div>
 </div>

 {/* Info bar */}
 <div className="px-6 py-2.5 bg-slate-100 border-b border-slate-100 flex items-center justify-between text-[11px] text-slate-555 font-bold font-sans">
 <div className="flex items-center gap-1.5 overflow-hidden">
 <Info size={14} className="text-indigo-500 shrink-0" />
 <span className="truncate">
 {activeTab === 'thung'
 ? "Chỉnh sửa trực tiếp thông tin kiện thùng/phụ kiện. Click chuột phải cột STT để chèn hoặc xóa dòng."
 : "Gõ Tên kiện CTHT ở cột bên trái để gán cấu kiện CTHT đó vào kiện chung. Các cấu kiện cùng tên kiện sẽ tự động đóng gói chung."
 }
 </span>
 </div>
 <div className="shrink-0 flex items-center gap-4">
 {activeTab === 'thung' ? (
 <>
 <span>Hiển thị: <strong className="text-indigo-600 font-black">{filteredThungRows.length}/{gridData.filter(i => i.subType !== 'kienCTHT').length}</strong> kiện</span>
 {selectedRowIds.size > 0 && <span className="text-indigo-600 font-black">Chọn: {selectedRowIds.size}</span>}
 <span className="text-amber-600 font-black">Chỉnh sửa: {dirtyRowIds.size}</span>
 {deletedRowIds.size > 0 && <span className="text-rose-600 font-extrabold">Đã xóa: {deletedRowIds.size}</span>}
 </>
 ) : (
 <>
 <span>Cấu kiện chờ đóng gói: <strong className="text-amber-600 font-black">{unassignedCthtEntries.length}/{cthtProjectEntries.length}</strong> chi tiết</span>
 {isCthtDirty && <span className="text-amber-600 font-black">Có thay đổi ghép nhóm</span>}
 </>
 )}
 </div>
 </div>

 {/* Tab content area */}
 <div className="flex-1 min-h-0 bg-slate-100 p-4 flex flex-col">
 <div className="flex-1 min-h-0 w-full bg-white border border-slate-200 rounded-xl shadow-sm flex flex-col overflow-hidden">

 {activeTab === 'thung' ? (
 /* TAB THÙNG & PHỤ KIỆN */
 <div className="flex-1 overflow-auto">
 <table className="w-full border-collapse table-fixed min-w-[1480px]">
 <thead>
 <tr className="bg-slate-100 border-b border-slate-200">
 <td className="sticky top-0 z-30 w-12 text-center border-r border-slate-200 py-1.5 bg-slate-200">
 <span className="text-[9px] font-black tracking-widest text-slate-500 uppercase">LỌC</span>
 </td>
 <td className='w-9'></td>
 <td className="sticky top-0 z-30 w-44 p-1 border-r border-slate-200 bg-slate-100">
 <select
 value={clusterFilter}
 onChange={e => setClusterFilter(e.target.value)}
 className="w-full px-1.5 py-1 text-[11px] bg-white border border-slate-200 rounded-lg outline-none focus:border-indigo-500 font-black uppercase tracking-tight cursor-pointer h-7"
 >
 <option value="">TẤT CẢ CỤM</option>
 {availableClusters.map(opt => (
 <option key={opt} value={opt}>{opt.toUpperCase()}</option>
 ))}
 </select>
 </td>
 <td className="sticky top-0 z-30 w-[350px] p-1 border-r border-slate-200 bg-slate-100">
 <div className="relative w-full">
 <span className="absolute inset-y-0 left-0 flex items-center pl-2.5 text-slate-400 pointer-events-none">
 <Search size={11} />
 </span>
 <input
 type="text"
 className="w-full pl-6 pr-2 py-1 text-[11px] bg-white border border-slate-200 rounded-lg outline-none focus:border-indigo-500 font-medium h-7"
 placeholder="Tìm tên / mã mộc..."
 value={searchTerm}
 onChange={e => setSearchTerm(e.target.value)}
 />
 </div>
 </td>
 <td className="sticky top-0 z-30 w-32 p-1 border-r border-slate-200 bg-slate-100">
 <select
 value={subTypeFilter}
 onChange={e => setSubTypeFilter(e.target.value)}
 className="w-full px-1.5 py-1 text-[11px] bg-white border border-slate-200 rounded-lg outline-none focus:border-indigo-500 font-black uppercase tracking-tight cursor-pointer h-7"
 >
 <option value="">TẤT CẢ KIỂU</option>
 <option value="kienModule">MODULE</option>
 <option value="kienCTHT">CTHT</option>
 <option value="kienPhuKien">PHỤ KIỆN</option>
 </select>
 </td>
 <td className="sticky top-0 z-30 bg-slate-100 border-r border-slate-200" style={{ width: 72, minWidth: 72, maxWidth: 72 }}></td>
 <td className="sticky top-0 z-30 bg-slate-100 border-r border-slate-200" style={{ width: 72, minWidth: 72, maxWidth: 72 }}></td>
 <td className="sticky top-0 z-30 bg-slate-100 border-r border-slate-200" style={{ width: 72, minWidth: 72, maxWidth: 72 }}></td>
 <td className="sticky top-0 z-30 bg-slate-100 border-r border-slate-200" style={{ width: 80, minWidth: 80, maxWidth: 80 }}></td>
 <td className="sticky top-0 z-30 bg-slate-100 border-r border-slate-200" style={{ width: 56, minWidth: 56, maxWidth: 56 }}></td>
 <td className="sticky top-0 z-30 bg-slate-100 border-r border-slate-200" style={{ width: 140, minWidth: 140, maxWidth: 140 }}></td>
 <td className="sticky top-0 z-30 p-1 bg-slate-100" style={{ width: 340, minWidth: 340 }}>
 <select
 value={statusFilter}
 onChange={e => setStatusFilter(e.target.value)}
 className="w-full px-1.5 py-1 text-[11px] bg-white border border-slate-200 rounded-lg outline-none focus:border-indigo-500 font-black uppercase tracking-tight cursor-pointer h-7"
 >
 <option value="">TẤT CẢ TRẠNG THÁI</option>
 <option value="unpacked">CHƯA ĐÓNG GÓI</option>
 <option value="packed">CHƯA LÊN XE</option>
 <option value="loaded">ĐÃ LÊN XE</option>
 </select>
 </td>
 </tr>

 <tr className="bg-slate-100 text-slate-555 text-[10px] font-black uppercase tracking-wider border-b border-slate-200 font-sans">
 <th className="sticky top-[38px] z-30 w-10 text-center border-r border-slate-300 py-2.5 select-none bg-slate-100">
   <input
     type="checkbox"
     checked={filteredThungRows.length > 0 && filteredThungRows.every(item => selectedRowIds.has(item.tempId))}
     onChange={() => {
       const allSelected = filteredThungRows.every(item => selectedRowIds.has(item.tempId));
       if (allSelected) {
         setSelectedRowIds(new Set());
       } else {
         setSelectedRowIds(new Set(filteredThungRows.map(item => item.tempId)));
       }
     }}
     className="w-3.5 h-3.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
   />
 </th>
 <th className="sticky top-[38px] z-30 text-center border-r border-slate-300 py-2.5 select-none bg-slate-100" title="Click chuột phải để Thêm/Xóa dòng" style={{ width: 72, minWidth: 72, maxWidth: 72 }}>STT</th>
 <th className="sticky top-[38px] z-30 w-44 text-left pl-3 border-r border-slate-300 bg-slate-100">Cụm</th>
 <th className="sticky top-[38px] z-30 w-[350px] text-left pl-3 border-r border-slate-300 bg-slate-100">Mã / Tên Cấu Kiện Vận Đơn</th>
 <th className="sticky top-[38px] z-30 w-36 text-left pl-3 border-r border-slate-300 bg-slate-100">Kiểu Cấu Kiện</th>
 <th className="sticky top-[38px] z-30 text-center border-r border-slate-300 bg-slate-100" style={{ width: 72, minWidth: 72, maxWidth: 72 }}>Rộng W</th>
 <th className="sticky top-[38px] z-30 text-center border-r border-slate-300 bg-slate-100" style={{ width: 72, minWidth: 72, maxWidth: 72 }}>Sâu D</th>
 <th className="sticky top-[38px] z-30 text-center border-r border-slate-300 bg-slate-100 font-sans" style={{ width: 72, minWidth: 72, maxWidth: 72 }}>Cao H</th>
 <th className="sticky top-[38px] z-30 text-center border-r border-slate-300 bg-slate-100" style={{ width: 80, minWidth: 80, maxWidth: 80 }}>Nặng (Kg)</th>
 <th className="sticky top-[38px] z-30 text-center border-r border-slate-300 bg-slate-100" style={{ width: 56, minWidth: 56, maxWidth: 56 }}>SL</th>
 <th className="sticky top-[38px] z-30 text-center border-r border-slate-300 bg-slate-100" style={{ width: 140, minWidth: 140, maxWidth: 140 }}>Ảnh</th>
 <th className="sticky top-[38px] z-30 text-left pl-3 bg-slate-100" style={{ width: 340, minWidth: 340 }}>Đóng Gói / Lên Xe</th>
 </tr>
 </thead>
 <tbody className="divide-y divide-slate-200 text-xs font-semibold">
 {filteredThungRows.map((item, idx) => {
 const isDirty = dirtyRowIds.has(item.tempId);
 const isContextMenuActive = contextMenu && contextMenu.item.tempId === item.tempId;

 return (
 <tr
 key={item.tempId}
 className={`hover:bg-slate-100/80 transition-colors ${isDirty ? 'bg-amber-100/40' : ''
 } ${isContextMenuActive ? 'bg-indigo-100/70' : ''
 }`}
 >
 <td
   className={`text-center py-2 border-r border-slate-200 w-10 select-none ${isContextMenuActive ? 'bg-indigo-600' : ''}`}
 >
   <input
     type="checkbox"
     checked={selectedRowIds.has(item.tempId)}
     onChange={() => {
       const next = new Set(selectedRowIds);
       if (next.has(item.tempId)) next.delete(item.tempId); else next.add(item.tempId);
       setSelectedRowIds(next);
     }}
     className="w-3.5 h-3.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
   />
 </td>
 <td
   onContextMenu={(e) => handleSTTContextMenu(e, item, idx)}
   className={`text-center py-2.5 border-r border-slate-200 w-9 text-slate-400 font-mono text-[10px] cursor-context-menu select-none font-black transition-all ${isContextMenuActive
   ? 'bg-indigo-600 text-white'
   : 'hover:bg-indigo-55 hover:text-indigo-600'
   }`}
   title="STT - Chuột phải để Chèn/Xóa dán"
 >
   {idx + 1}
 </td>

 <td className="p-1 border-r border-slate-200">
 <input
 type="text"
 value={item.cluster || ''}
 placeholder="Cụm, Khu vực..."
 onChange={(e) => handleCellChange(item.tempId, 'cluster', e.target.value)}
 className="w-full bg-transparent px-2.5 py-1.5 outline-none text-[11px] text-slate-705 border border-transparent rounded-lg focus:border-indigo-500 focus:bg-white transition-all uppercase font-bold"
 />
 </td>
 <td className="p-1 border-r border-slate-200">
 <input
 type="text"
 value={item.name || ''}
 onChange={(e) => handleCellChange(item.tempId, 'name', e.target.value)}
 className="w-full bg-transparent px-2.5 py-1.5 outline-none text-[11px] font-black uppercase text-slate-900 border border-transparent rounded-lg focus:border-indigo-500 focus:bg-white transition-all font-mono"
 />
 </td>

 <td className="p-1 border-r border-slate-200">
 <select
 value={item.subType || 'kienModule'}
 onChange={(e) => handleCellChange(item.tempId, 'subType', e.target.value)}
 className="w-full bg-transparent px-2 py-1.5 outline-none text-[10px] font-black uppercase text-slate-700 select-none cursor-pointer border border-transparent rounded-lg focus:border-indigo-500 focus:bg-white transition-all"
 >
 <option value="kienModule" className="bg-white font-bold">Kiện Module</option>
 <option value="kienCTHT" className="bg-white font-sans">Kiện CTHT</option>
 <option value="kienPhuKien" className="bg-white font-sans">Kiện Phụ Kiện</option>
 </select>
 </td>

 <td className="p-1 border-r border-slate-200" style={{ width: 72, minWidth: 72, maxWidth: 72 }}>
 <input
 type="text"
 value={item.w || ''}
 placeholder="0"
 onChange={(e) => handleCellChange(item.tempId, 'w', e.target.value)}
 className="w-full bg-transparent text-center px-1.5 py-1.5 font-bold text-slate-900 outline-none border border-transparent rounded-lg focus:border-indigo-500 focus:bg-white transition-all font-mono"
 />
 </td>

 <td className="p-1 border-r border-slate-200" style={{ width: 72, minWidth: 72, maxWidth: 72 }}>
 <input
 type="text"
 value={item.d || ''}
 placeholder="0"
 onChange={(e) => handleCellChange(item.tempId, 'd', e.target.value)}
 className="w-full bg-transparent text-center px-1.5 py-1.5 font-bold text-slate-900 outline-none border border-transparent rounded-lg focus:border-indigo-500 focus:bg-white transition-all font-mono"
 />
 </td>

 <td className="p-1 border-r border-slate-200" style={{ width: 72, minWidth: 72, maxWidth: 72 }}>
 <input
 type="text"
 value={item.h || ''}
 placeholder="0"
 onChange={(e) => handleCellChange(item.tempId, 'h', e.target.value)}
 className="w-full bg-transparent text-center px-1.5 py-1.5 font-bold text-slate-900 outline-none border border-transparent rounded-lg focus:border-indigo-500 focus:bg-white transition-all font-mono"
 />
 </td>

 <td className="p-1 border-r border-slate-200" style={{ width: 80, minWidth: 80, maxWidth: 80 }}>
 <input
 type="number"
 min="0"
 step="0.1"
 value={item.weight ?? ''}
 placeholder="0"
 onChange={(e) => handleCellChange(item.tempId, 'weight', e.target.value === '' ? undefined : parseFloat(e.target.value))}
 className="w-full bg-transparent text-center px-1.5 py-1.5 font-bold text-slate-900 outline-none border border-transparent rounded-lg focus:border-indigo-500 focus:bg-white transition-all font-mono"
 />
 </td>

 <td className="p-1 border-r border-slate-200" style={{ width: 56, minWidth: 56, maxWidth: 56 }}>
 <input
 type="number"
 min="1"
 value={item.quantity || 1}
 onChange={(e) => handleCellChange(item.tempId, 'quantity', Math.max(1, parseInt(e.target.value) || 1))}
 className="w-full bg-transparent text-center px-1.5 py-1.5 font-black text-slate-900 outline-none border border-transparent rounded-lg focus:border-indigo-500 focus:bg-white transition-all font-mono"
 />
 </td>

 <td className="p-1 border-r border-slate-200" style={{ width: 140, minWidth: 140, maxWidth: 140 }}>
   {(() => {
     const photos = (item.photos || []).filter(Boolean);
     return (
       <div className="flex flex-col gap-0.5 py-0.5">
         <div className="flex items-center gap-1 overflow-x-auto scrollbar-hide">
           {photos.map((url, pi) => (
             <div key={pi} className="relative group shrink-0">
               <button
                 type="button"
                 onClick={() => setPhotoLightbox({ images: photos, index: pi })}
                 className="w-9 h-9 rounded border border-slate-200 overflow-hidden hover:border-indigo-400 transition-all cursor-pointer"
               >
                 <img src={url} alt="" className="w-full h-full object-cover" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
               </button>
               <button
                 type="button"
                 onClick={() => {
                   const next = photos.filter((_: string, i: number) => i !== pi);
                   handleCellChange(item.tempId, 'photos', next);
                 }}
                 className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-red-500 text-white rounded-full flex items-center justify-center text-[8px] font-bold opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
               >×</button>
             </div>
           ))}
           {photos.length === 0 && <span className="text-[9px] text-slate-300 italic">—</span>}
         </div>
         <input
           type="text"
           placeholder="Dán link ảnh Enter để thêm..."
           className="w-full bg-slate-50 px-1.5 py-0.5 text-[9px] text-slate-500 border border-slate-200 rounded outline-none focus:border-indigo-400 transition-all font-mono"
           onKeyDown={(e) => {
             if (e.key === 'Enter' && (e.target as HTMLInputElement).value.trim()) {
               const url = (e.target as HTMLInputElement).value.trim();
               handleCellChange(item.tempId, 'photos', [...photos, url]);
               (e.target as HTMLInputElement).value = '';
             }
           }}
         />
       </div>
     );
   })()}
 </td>

 <td className="py-1 px-3" style={{ width: 340, minWidth: 340 }}>
 <div className="flex items-center gap-4">
 <label className="flex items-center gap-1.5 cursor-pointer select-none">
 <input
 type="checkbox"
 checked={!!item.packed}
 onChange={(e) => handleCellChange(item.tempId, 'packed', e.target.checked)}
 className="w-4 h-4 text-indigo-600 border-slate-300 rounded-lg focus:ring-0 cursor-pointer"
 />
 <span className={`text-[10px] font-black uppercase ${item.packed ? 'text-emerald-600' : 'text-slate-400'}`}>
 GÓI ({item.packed ? 'ĐÃ ĐÓNG' : 'CHƯA'})
 </span>
 </label>

 <label className="flex items-center gap-1.5 cursor-pointer select-none">
 <input
 type="checkbox"
 checked={!!item.loaded}
 onChange={(e) => handleCellChange(item.tempId, 'loaded', e.target.checked)}
 className="w-4 h-4 text-indigo-700 border-slate-300 rounded-lg focus:ring-0 cursor-pointer"
 />
 <span className={`text-[10px] font-black uppercase ${item.loaded ? 'text-orange-600' : 'text-slate-400'}`}>
 XUẤT ({item.loaded ? 'XE' : 'KHO'})
 </span>
 </label>
 </div>
 </td>
 </tr>
 );
 })}
 </tbody>
 </table>
 </div>
 ) : (
 /* TAB CHI TIẾT CTHT - GIẢI PHÁP TRỰC QUAN 2 BỘ PHẬN TRÁI PHẢI */
 <div className="flex-1 overflow-hidden flex flex-row w-400 m-auto">

 {/* 1. BÊN TRÁI: DANH SÁCH CÁC KIỆN CTHT ĐÃ ĐÓNG GÓI */}
 <div className="w-5/10 border-r border-slate-200 flex flex-col h-full bg-slate-100/50">
 {/* Header cột trái */}
 <div className="p-4 border-b border-slate-200 bg-white flex justify-between items-center shrink-0">
 <div>
 <h4 className="text-xs font-black text-slate-900 uppercase tracking-wider flex items-center gap-1.5">
 <Package size={14} className="text-indigo-600" />
 <span>KIỆN CTHT ĐÃ GÓI ({cthtKiens.length})</span>
 </h4>
 <p className="text-[10px] text-slate-400 font-bold mt-0.5">
 Kéo thả cấu kiện vào kiện gỗ, hoặc click chọn kiện để ghép nhanh.
 </p>
 </div>
 <div className="shrink-0 flex items-center gap-1.5">
 <div className="relative w-48">
 <span className="absolute inset-y-0 left-0 flex items-center pl-2 text-slate-400 pointer-events-none">
 <Search size={12} />
 </span>
 <input
 type="text"
 className="w-full pl-7 pr-6 py-1.5 text-[11px] bg-slate-100 border border-slate-200 rounded-lg outline-none focus:border-indigo-500 font-bold uppercase transition-all"
 placeholder="Tìm cấu kiện..."
 value={kienSearch}
 onChange={e => setKienSearch(e.target.value)}
 />
 {kienSearch && (
 <button
 onClick={() => setKienSearch('')}
 className="absolute inset-y-0 right-0 flex items-center pr-2 text-slate-400 hover:text-slate-600 cursor-pointer"
 >
 <X size={11} />
 </button>
 )}
 </div>
 <button
 onClick={() => {
   setNewKienName(generateNextKienName());
   setNewKienCluster('Chi tiết hỗ trợ');
   setShowCreateKienModal(true);
 }}
 className="py-1.5 px-3 bg-indigo-100 hover:bg-indigo-100 text-indigo-700 border border-indigo-100 rounded-lg text-xs font-black uppercase tracking-wider transition-all flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap"
 >
 <Plus size={13} />
 <span>MỚI</span>
 </button>
 <button
 onClick={handleAutoGenerateCtht}
 disabled={unassignedCthtEntries.length === 0}
 className="py-1.5 px-3 bg-emerald-100 hover:bg-emerald-200 text-emerald-700 border border-emerald-200 rounded-lg text-xs font-black uppercase tracking-wider transition-all flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
 >
 <Layers size={13} />
 <span>TỰ ĐỘNG ({unassignedCthtEntries.length})</span>
 </button>
 </div>
 </div>

 {/* Danh sách các kiện đã đóng gói */}
 <div className="flex-1 overflow-y-auto p-4 space-y-3">
 {filteredCthtKiens.map((kien) => {
 const dims = calculateKienDimensions(kien.items);
 const isActive = activeKienId === kien.id;

 return (
 <div
 key={kien.id}
 onClick={() => setActiveKienId(kien.id)}
 onDragOver={(e) => e.preventDefault()}
 onDrop={(e) => handleDropOnKien(e, kien.id)}
 className={`bg-white border rounded-xl overflow-hidden shadow-xs transition-all duration-200 cursor-pointer ${isActive
 ? 'border-indigo-500 ring-2 ring-indigo-500/20'
 : 'border-slate-300 hover:border-slate-400'
 }`}
 >
 {/* Header của Kiện */}
 <div className={`px-4 py-2 border-b flex items-center justify-between gap-2 transition-colors ${isActive ? 'bg-indigo-100/40 border-indigo-200' : 'bg-slate-100/60 border-slate-200'
 }`}>
 <div className="flex items-center gap-1.5 flex-wrap flex-1 min-w-0">
 <Package size={14} className={isActive ? "text-indigo-600 shrink-0" : "text-slate-400 shrink-0"} />
 <span className="font-extrabold text-slate-900 uppercase tracking-tight text-xs py-0.5 shrink-0">
 {kien.name}
 </span>

 {(() => {
 const clusterToShow = kien.cluster || Array.from(new Set(kien.items.map(it => it.entry?.cluster).filter(Boolean))).join(', ');
 if (clusterToShow) {
 return (
 <span className="text-[10px] text-emerald-700 font-bold bg-emerald-100 px-1.5 py-0.5 rounded border border-emerald-100/30 shrink-0">
 Cụm: {clusterToShow}
 </span>
 );
 }
 return null;
 })()}

 <span className="text-[10px] text-slate-400 font-bold font-mono shrink-0">({kien.items.length})</span>
 {kien.items.length > 0 && (
 <span className="text-[10px] text-indigo-700 font-mono font-black bg-indigo-100 px-1.5 py-0.5 rounded-lg border border-indigo-100/30 shrink-0" title="Kích thước tự động WxDxH">
 📏 {dims.w}x{dims.d}x{dims.h}
 </span>
 )}
 </div>

 <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
 <button
 onClick={(e) => {
 e.stopPropagation();
 setEditingKien(kien);
 setEditKienName(kien.name);
 setEditKienCluster(kien.cluster || 'Chi tiết hỗ trợ');
 }}
 className="p-1 hover:bg-indigo-100 hover:text-indigo-600 text-slate-400 rounded-lg transition-all cursor-pointer"
 title="Chỉnh sửa kiện"
 >
 <Edit size={13} />
 </button>
 <button
 onClick={() => handleDeleteKien(kien.id)}
 className="p-1 hover:bg-rose-100 hover:text-rose-600 text-slate-400 rounded-lg transition-all cursor-pointer"
 title="Xóa kiện"
 >
 <Trash2 size={13} />
 </button>
 </div>
 </div>

 {/* Vùng chi tiết */}
 <div className="p-3 space-y-2" onClick={(e) => e.stopPropagation()}>
 {/* Cấu kiện bên trong kiện */}
 {kien.items.length > 0 ? (
 <div className="divide-y divide-slate-100 border border-slate-100 rounded-lg overflow-hidden">
 {[...kien.items].sort((a, b) => {
 const clusterA = (a.entry?.cluster || '').toLowerCase();
 const clusterB = (b.entry?.cluster || '').toLowerCase();
 if (clusterA !== clusterB) {
 return clusterA.localeCompare(clusterB, 'vi');
 }
 const codeA = (a.moduleCode || '').toLowerCase();
 const codeB = (b.moduleCode || '').toLowerCase();
 return codeA.localeCompare(codeB, 'vi');
 }).map((it, idx) => {
 const isHighlighted = kienSearch.trim() && (
 (it.moduleCode || '').toLowerCase().includes(kienSearch.trim().toLowerCase()) ||
 (it.entry?.cluster || '').toLowerCase().includes(kienSearch.trim().toLowerCase())
 );
 return (
 <div
 key={`${it.entryId}_${idx}`}
 className={`flex items-center justify-between gap-3 px-3 py-1.5 text-xs transition-colors ${isHighlighted ? 'bg-amber-100' : 'bg-white hover:bg-slate-100/40'}`}
 >
 <div className="flex items-center gap-2">
 <span className="px-1.5 py-0.5 bg-slate-100 text-slate-500 text-[9px] font-black uppercase tracking-wider rounded w-26 hidden xl:inline-block">
 {it.entry.cluster}
 </span>
 <p
 className="font-mono font-black text-slate-900 uppercase"
 title={it.moduleCode}
 >
 {it.moduleCode}
 </p>

 <p className="text-[9px] text-slate-400 font-bold font-mono">
 KT mộc: {(it.entry.pWidth || it.entry.width || it.entry.length || 0)}x
 {(it.entry.pDepth || it.entry.depth || 0)}x
 {(it.entry.pHeight || it.entry.height || 0)} mm
 </p>
 </div>

 <div className="flex items-center gap-2 shrink-0">
 {/* Tăng giảm số lượng */}
 <div className="flex items-center border border-slate-200 rounded-lg overflow-hidden bg-slate-100 h-6">
 <button
 type="button"
 onClick={() => handleUpdateQtyInKien(kien.id, it.entryId, -1)}
 className="px-2 h-full text-slate-500 hover:bg-slate-200 font-bold select-none cursor-pointer text-xs"
 >
 -
 </button>
 <span className="px-2 font-mono font-black text-slate-900 text-[10px]">
 {it.quantity}
 </span>
 <button
 type="button"
 onClick={() => handleUpdateQtyInKien(kien.id, it.entryId, 1)}
 className="px-2 h-full text-slate-500 hover:bg-slate-200 font-bold select-none cursor-pointer text-xs"
 >
 +
 </button>
 </div>

 <button
 type="button"
 onClick={() => handleRemoveEntryFromKien(kien.id, it.entryId)}
 className="p-1 hover:bg-rose-100 hover:text-rose-600 text-slate-500 rounded-lg transition-all cursor-pointer"
 title="Tháo ra"
 >
 <X size={12} />
 </button>
 </div>
 </div>
 );
 })}
 </div>
 ) : (
 <div className="border border-dashed border-slate-200 rounded-xl py-5 text-center text-[10px] text-slate-400 font-bold uppercase tracking-wide bg-slate-100/20">
 📦 Kiện rỗng. Kéo thả cấu kiện vào đây hoặc click Ghép ở bên phải.
 </div>
 )}
 </div>
 </div>
 );
 })}

 {cthtKiens.length === 0 && (
 <div className="py-20 text-center flex flex-col items-center justify-center border border-dashed border-slate-200 rounded-xl">
 <Layers size={36} className="text-slate-300 mb-2" />
 <p className="text-slate-400 text-xs font-black uppercase tracking-wider">Chưa tạo kiện CTHT nào</p>
 <button
 onClick={() => {
 setTempKienName(generateNextKienName());
 setIsCreatingKien(true);
 }}
 className="mt-3 px-3 py-1.5 bg-indigo-700 hover:bg-indigo-700 text-white rounded-lg text-[10px] font-black uppercase tracking-widest transition-all cursor-pointer"
 >
 TẠO KIỆN ĐẦU TIÊN
 </button>
 </div>
 )}
 </div>
 </div>

 {/* 2. BÊN PHẢI: CHI TIẾT CTHT CHƯA ĐÓNG GÓI */}
 <div className="w-5/12 flex flex-col h-full bg-slate-55/10">
 {/* Header cột phải */}
 <div className="p-4 border-b border-slate-200 bg-white flex flex-col gap-2.5 shrink-0">
 <div className="flex justify-between items-center">
 <h4 className="text-xs font-black text-slate-900 uppercase tracking-wider flex items-center gap-1.5">
 <Layers size={14} className="text-amber-500" />
 <span>CTHT CHƯA ĐÓNG ({unassignedCthtEntries.length})</span>
 </h4>
 <span className="text-[9px] bg-amber-100 text-amber-700 px-2 py-0.5 font-sans font-black tracking-widest uppercase rounded-lg border border-amber-100 shrink-0">
 Chờ đóng gói
 </span>
 </div>

 {/* Ô tìm kiếm cột phải */}
 <div className="relative w-full">
 <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-slate-400 pointer-events-none">
 <Search size={13} />
 </span>
 <input
 type="text"
 className="w-full pl-9 pr-8 py-1.5 text-xs bg-slate-100 border border-slate-200 rounded-lg outline-none focus:border-indigo-500 font-bold uppercase transition-all"
 placeholder="Tìm theo tên mộc, khu vực..."
 value={cthtSearch}
 onChange={e => setCthtSearch(e.target.value)}
 />
 {cthtSearch && (
 <button
 onClick={() => setCthtSearch('')}
 className="absolute inset-y-0 right-0 flex items-center pr-3 text-slate-400 hover:text-slate-600 cursor-pointer"
 >
 <X size={13} />
 </button>
 )}
 </div>
 </div>

 {/* Danh sách chưa đóng gói */}
 <div className="flex-1 overflow-y-auto p-4 space-y-1.5">
 {unassignedCthtEntries.map((item, idx) => {
 const entry = item.entry;

 return (
 <div
 key={`${entry.id}-${idx}`}
 draggable
 onDragStart={(e) => handleDragStart(e, entry.id)}
 className="bg-white border border-slate-200 hover:border-indigo-400 rounded-lg px-2.5 py-1.5 shadow-3xs cursor-grab active:cursor-grabbing transition-all flex items-center justify-between gap-2 group"
 >
 {/* Tên cấu kiện, Kích thước, Số lượng */}
 <div className="flex items-center gap-2 min-w-0 flex-1">
 {entry.cluster && (
 <span className="px-1.5 py-0.5 bg-slate-100 text-slate-500 text-[9px] font-black uppercase tracking-wider rounded w-26 hidden xl:inline-block">
 {entry.cluster}
 </span>
 )}
 <span className="font-mono font-black text-slate-800 uppercase tracking-tight text-xs w-70 group-hover:text-indigo-700 transition-colors" title={entry.moduleCode}>
 {entry.moduleCode}
 </span>
 <span className="text-[10px] text-amber-600 bg-amber-100 px-1.5 py-0.5 rounded font-black font-mono shrink-0">
 {item.remainingQty}/{item.totalQty} tấm
 </span>
 <span className="text-[10px] text-slate-400 font-mono font-bold bg-slate-100 px-1.5 py-0.5 rounded truncate" title="Kích thước mộc">
 {(entry.pWidth || entry.length || entry.width || 0)}x{(entry.pDepth || entry.depth || 0)}x{(entry.pHeight || entry.height || 0)}
 </span>
 </div>

 <button
 type="button"
 onClick={() => {
 const targetKienId = activeKienId || (cthtKiens.length > 0 ? cthtKiens[0].id : null);
 if (item.remainingQty > 1) {
 if (targetKienId) {
 setShowQtySelector({
 entryId: entry.id,
 kienId: targetKienId,
 maxAvailable: item.remainingQty,
 defaultQty: item.remainingQty
 });
 } else {
 // Chưa có kiện nào cả, tạo kiện mới luôn và bọc lấy toàn bộ số lượng
 const name = generateNextKienName();
 const newKienId = `ctht_${Date.now()}`;
 const newKien: CthtKien = {
 id: newKienId,
 name: name,
 packed: false,
 loaded: false,
 packedBy: '',
 loadedBy: '',
 items: [{
 entryId: entry.id,
 moduleCode: entry.moduleCode,
 quantity: item.remainingQty,
 entry
 }]
 };
 setCthtKiens(prev => [...prev, newKien]);
 setActiveKienId(newKienId);
 setIsCthtDirty(true);
 }
 } else {
 if (targetKienId) {
 handleAddEntryToKien(entry.id, targetKienId, 1);
 } else {
 const name = generateNextKienName();
 const newKienId = `ctht_${Date.now()}`;
 const newKien: CthtKien = {
 id: newKienId,
 name: name,
 packed: false,
 loaded: false,
 packedBy: '',
 loadedBy: '',
 items: [{
 entryId: entry.id,
 moduleCode: entry.moduleCode,
 quantity: 1,
 entry
 }]
 };
 setCthtKiens(prev => [...prev, newKien]);
 setActiveKienId(newKienId);
 setIsCthtDirty(true);
 }
 }
 }}
 className="px-2 py-0.5 bg-indigo-700 hover:bg-indigo-700 active:scale-95 text-white rounded text-[10px] font-black uppercase tracking-wider transition-all flex items-center justify-center gap-0.5 shrink-0 cursor-pointer"
 title="Xếp vào kiện đang chọn"
 >
 <span>GHÉP</span>
 <span>➔</span>
 </button>
 </div>
 );
 })}

 {unassignedCthtEntries.length === 0 && (
 <div className="py-20 text-center flex flex-col items-center justify-center border border-dashed border-slate-200 rounded-xl bg-slate-100/10">
 <CheckCircle size={36} className="text-emerald-500 mb-2 animate-pulse" />
 <p className="text-slate-500 text-xs font-black uppercase tracking-widest leading-relaxed">
 ĐÃ ĐÓNG GÓI XONG!<br />Không còn cấu kiện thô chờ gối.
 </p>
 </div>
 )}
 </div>
 </div>

 </div>
 )}

 </div>
 </div>
 </div>

 {/* Context Menu for right click on STT */}
 {contextMenu && (
 <>
 <div
 className="fixed inset-0 z-[115]"
 onClick={() => setContextMenu(null)}
 onContextMenu={(e) => {
 e.preventDefault();
 setContextMenu(null);
 }}
 />
 <div
 className="fixed bg-white border border-slate-200 rounded-lg shadow-xl z-[120] py-2 w-56 text-[10px] font-black uppercase tracking-wider text-slate-700 select-none animate-in fade-in duration-100"
 style={{
 top: contextMenu.y,
 left: contextMenu.x
 }}
 >
 <div className="px-3.5 py-1.5 text-[9px] font-black text-slate-400 border-b border-slate-100 pb-2 mb-1 tracking-widest text-center truncate">
 {contextMenu.item.name ? `Kiện: ${contextMenu.item.name}` : `Dòng mới (STT: ${contextMenu.index + 1})`}
 </div>

 <button
 type="button"
 onClick={() => { const gi = gridData.findIndex(item => item.tempId === contextMenu.item.tempId); if (gi !== -1) handleAddRowOption('above', gi); }}
 className="w-full text-left px-4 py-2 text-slate-705 hover:bg-slate-100 flex items-center gap-2 cursor-pointer transition-colors font-extrabold rounded-lg"
 >
 <Plus size={12} className="text-indigo-505" />
 <span>Chèn phía trên dòng #{contextMenu.index + 1}</span>
 </button>

 <button
 type="button"
 onClick={() => { const gi = gridData.findIndex(item => item.tempId === contextMenu.item.tempId); if (gi !== -1) handleAddRowOption('below', gi); }}
 className="w-full text-left px-4 py-2 text-slate-705 hover:bg-slate-100 flex items-center gap-2 cursor-pointer transition-colors font-extrabold rounded-lg"
 >
 <Plus size={12} className="text-indigo-505" />
 <span>Chèn phía dưới dòng #{contextMenu.index + 1}</span>
 </button>

 <div className="border-t border-slate-100 my-1"></div>

 <button
 type="button"
 onClick={() => handleDeleteRowByTempId(contextMenu.item.tempId)}
 className="w-full text-left px-4 py-2 hover:bg-rose-100 text-rose-600 flex items-center gap-2 cursor-pointer transition-colors font-extrabold rounded-lg"
 >
 <Trash2 size={12} className="text-rose-500" />
 <span>Xóa dòng #{contextMenu.index + 1} này</span>
 </button>
 </div>
 </>
 )}

 {/* Select Quantity Modal */}
 {showQtySelector && (
 <div className="fixed inset-0 bg-black/60 z-[200] flex items-center justify-center p-4">
 <div className="bg-white w-full max-w-sm rounded-lg shadow-2xl overflow-hidden border border-slate-200 p-6 space-y-4">
 <h3 className="text-sm font-black text-slate-800 uppercase tracking-wider">
 Chọn số lượng xếp vào kiện
 </h3>
 <div className="space-y-1">
 <p className="text-xs text-slate-500">Số lượng tối đa có thể xếp: <strong className="text-indigo-600 font-mono">{showQtySelector.maxAvailable}</strong> tấm</p>
 <div className="flex items-center gap-2 mt-2">
 <button
 type="button"
 onClick={() => {
 setShowQtySelector(prev => prev ? { ...prev, defaultQty: Math.max(1, prev.defaultQty - 1) } : null);
 }}
 className="w-9 h-9 border border-slate-200 bg-slate-100 hover:bg-slate-100 text-slate-700 rounded-lg text-lg font-black transition-all cursor-pointer"
 >
 -
 </button>
 <input
 type="number"
 min="1"
 max={showQtySelector.maxAvailable}
 value={showQtySelector.defaultQty}
 onChange={(e) => {
 const val = Math.max(1, Math.min(showQtySelector.maxAvailable, parseInt(e.target.value) || 1));
 setShowQtySelector(prev => prev ? { ...prev, defaultQty: val } : null);
 }}
 className="flex-1 text-center px-3 py-2 border border-slate-200 bg-white rounded-lg text-sm text-slate-800 font-mono font-black"
 autoFocus
 onKeyDown={(e) => {
 if (e.key === 'Enter') {
 handleAddEntryToKien(showQtySelector.entryId, showQtySelector.kienId, showQtySelector.defaultQty);
 setShowQtySelector(null);
 }
 }}
 />
 <button
 type="button"
 onClick={() => {
 setShowQtySelector(prev => prev ? { ...prev, defaultQty: Math.min(prev.maxAvailable, prev.defaultQty + 1) } : null);
 }}
 className="w-9 h-9 border border-slate-200 bg-slate-100 hover:bg-slate-100 text-slate-700 rounded-lg text-lg font-black transition-all cursor-pointer"
 >
 +
 </button>
 </div>
 </div>
 <div className="flex justify-end gap-2 pt-2">
 <button
 onClick={() => setShowQtySelector(null)}
 className="px-4 py-2 border border-slate-200 hover:bg-slate-100 text-slate-500 rounded-lg text-[11px] font-black uppercase transition-all"
 >
 Hủy
 </button>
 <button
 onClick={() => {
 handleAddEntryToKien(showQtySelector.entryId, showQtySelector.kienId, showQtySelector.defaultQty);
 setShowQtySelector(null);
 }}
 className="px-5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-[11px] font-black uppercase transition-all"
 >
 Xác nhận
 </button>
 </div>
 </div>
 </div>
 )}

 {/* Create Kien Modal */}
 {showCreateKienModal && (
 <div className="fixed inset-0 bg-black/60 z-[200] flex items-center justify-center p-4 backdrop-blur-xs">
 <div className="bg-white w-full max-w-sm rounded-[10px] shadow-2xl overflow-hidden border border-slate-200 p-6 space-y-4">
 <h3 className="text-sm font-black text-slate-900 uppercase tracking-wider flex items-center gap-2">
 <Package size={16} className="text-indigo-600" />
 <span>Tạo kiện gỗ CTHT mới</span>
 </h3>
 
 <div className="space-y-3">
 <div>
 <label className="block text-[10px] font-black text-slate-400 uppercase tracking-wider mb-1">Tên kiện gỗ</label>
 <input
 type="text"
 autoFocus
 value={newKienName}
 onChange={(e) => setNewKienName(e.target.value.toUpperCase())}
 className="w-full px-3 py-2 text-xs bg-slate-100 border border-slate-200 rounded-lg outline-none focus:border-indigo-500 font-extrabold uppercase transition-all"
 placeholder="Ví dụ: KIỆN CTHT..."
 onKeyDown={(e) => {
 if (e.key === 'Enter') {
 handleCreateNewKien(newKienName, newKienCluster);
 setShowCreateKienModal(false);
 }
 }}
 />
 </div>

 <div>
 <label className="block text-[10px] font-black text-slate-400 uppercase tracking-wider mb-1">Tên cụm</label>
 <input
 type="text"
 value={newKienCluster}
 onChange={(e) => setNewKienCluster(e.target.value)}
 className="w-full px-3 py-2 text-xs bg-slate-100 border border-slate-200 rounded-lg outline-none focus:border-indigo-500 font-bold transition-all"
 placeholder="Ví dụ: Chi tiết hỗ trợ, Cụm A..."
 onKeyDown={(e) => {
 if (e.key === 'Enter') {
 handleCreateNewKien(newKienName, newKienCluster);
 setShowCreateKienModal(false);
 }
 }}
 />
 </div>
 </div>

 <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
 <button
 type="button"
 onClick={() => setShowCreateKienModal(false)}
 className="px-4 py-2 border border-slate-200 hover:bg-slate-100 text-slate-500 rounded-lg text-[11px] font-black uppercase transition-all cursor-pointer"
 >
 Hủy
 </button>
 <button
 type="button"
 onClick={() => {
 handleCreateNewKien(newKienName, newKienCluster);
 setShowCreateKienModal(false);
 }}
 className="px-5 py-2 bg-indigo-700 hover:bg-indigo-700 text-white rounded-lg text-[11px] font-black uppercase transition-all cursor-pointer"
 >
 Tạo kiện
 </button>
 </div>
 </div>
 </div>
 )}

 {/* Edit Kien Modal */}
 {editingKien && (
 <div className="fixed inset-0 bg-black/60 z-[200] flex items-center justify-center p-4 backdrop-blur-xs">
 <div className="bg-white w-full max-w-sm rounded-[10px] shadow-2xl overflow-hidden border border-slate-200 p-6 space-y-4">
 <h3 className="text-sm font-black text-slate-900 uppercase tracking-wider flex items-center gap-2">
 <Edit size={16} className="text-indigo-600" />
 <span>Chỉnh sửa kiện gỗ CTHT</span>
 </h3>

 <div className="space-y-3">
 <div>
 <label className="block text-[10px] font-black text-slate-400 uppercase tracking-wider mb-1">Tên kiện gỗ</label>
 <input
 type="text"
 autoFocus
 value={editKienName}
 onChange={(e) => setEditKienName(e.target.value.toUpperCase())}
 className="w-full px-3 py-2 text-xs bg-slate-100 border border-slate-200 rounded-lg outline-none focus:border-indigo-500 font-extrabold uppercase transition-all"
 placeholder="Ví dụ: KIỆN CTHT..."
 onKeyDown={(e) => {
 if (e.key === 'Enter') {
 handleSaveEditKien();
 }
 }}
 />
 </div>

 <div>
 <label className="block text-[10px] font-black text-slate-400 uppercase tracking-wider mb-1">Tên cụm</label>
 <input
 type="text"
 value={editKienCluster}
 onChange={(e) => setEditKienCluster(e.target.value)}
 className="w-full px-3 py-2 text-xs bg-slate-100 border border-slate-200 rounded-lg outline-none focus:border-indigo-500 font-bold transition-all"
 placeholder="Ví dụ: Chi tiết hỗ trợ, Cụm A..."
 onKeyDown={(e) => {
 if (e.key === 'Enter') {
 handleSaveEditKien();
 }
 }}
 />
 </div>
 </div>

 <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
 <button
 type="button"
 onClick={() => setEditingKien(null)}
 className="px-4 py-2 border border-slate-200 hover:bg-slate-100 text-slate-500 rounded-lg text-[11px] font-black uppercase transition-all cursor-pointer"
 >
 Hủy
 </button>
 <button
 type="button"
 onClick={handleSaveEditKien}
 className="px-5 py-2 bg-indigo-700 hover:bg-indigo-700 text-white rounded-lg text-[11px] font-black uppercase transition-all cursor-pointer"
 >
 Lưu thay đổi
 </button>
 </div>
 </div>
 </div>
 )}

 {/* Photo Lightbox */}
 {photoLightbox && (
   <div className="fixed inset-0 bg-black/80 z-[300] flex flex-col items-center justify-center" onClick={(e) => { if (e.target === e.currentTarget) setPhotoLightbox(null); }}>
     <div className="w-full flex items-center justify-between text-white p-3">
       <span className="text-xs font-black uppercase tracking-wider font-mono">{photoLightbox.index + 1} / {photoLightbox.images.length}</span>
       <button onClick={() => setPhotoLightbox(null)} className="p-2 hover:bg-white/10 rounded-full transition-all text-gray-300 hover:text-white cursor-pointer"><X size={24} /></button>
     </div>
     <div className="relative w-full flex items-center justify-center p-2">
       {photoLightbox.images.length > 1 && (
         <button onClick={() => setPhotoLightbox(prev => prev ? { ...prev, index: (prev.index - 1 + prev.images.length) % prev.images.length } : null)} className="absolute left-4 p-3 bg-black/50 hover:bg-black/70 text-white rounded-full transition-all border border-white/10 z-20 cursor-pointer"><ChevronLeft size={28} /></button>
       )}
       {photoLightbox.images[photoLightbox.index] && (
         <img key={photoLightbox.index} src={photoLightbox.images[photoLightbox.index]} className="max-w-full max-h-[80vh] object-contain rounded-lg shadow-2xl" />
       )}
       {photoLightbox.images.length > 1 && (
         <button onClick={() => setPhotoLightbox(prev => prev ? { ...prev, index: (prev.index + 1) % prev.images.length } : null)} className="absolute right-4 p-3 bg-black/50 hover:bg-black/70 text-white rounded-full transition-all border border-white/10 z-20 cursor-pointer"><ChevronRight size={28} /></button>
       )}
     </div>
   </div>
 )}
 </div>
 );
}
