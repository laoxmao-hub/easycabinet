import React, { useState, useMemo, useEffect } from 'react';
import { 
 BarChart3, Layers, ClipboardCheck, TrendingUp, CheckCircle, AlertTriangle, 
 Package, Truck, Calendar, Sparkles, PieChart, LayoutDashboard, Clock, RefreshCw,
 TrendingDown, ShieldCheck, ListOrdered
} from 'lucide-react';
import { collection, query, orderBy, onSnapshot } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { ProjectEntry, getModuleInstances, getInstanceStageQc, getModuleQcAggregate } from '../types';

interface StatsScreenProps {
 projectEntries: ProjectEntry[];
 qcTickets?: any[];
 items?: any[];
}

function getBaseModuleId(id: string | null | undefined): string {
  if (!id) return '';
  const lastIndex = id.lastIndexOf('_');
  if (lastIndex !== -1) {
    const suffix = id.substring(lastIndex + 1);
    if (/^\d+$/.test(suffix)) {
      return id.substring(0, lastIndex);
    }
  }
  const lastPipeIndex = id.lastIndexOf('|');
  if (lastPipeIndex !== -1) {
    const suffix = id.substring(lastPipeIndex + 1);
    if (/^\d+$/.test(suffix)) {
      return id.substring(0, lastPipeIndex);
    }
  }
  return id;
}

export function StatsScreen({ projectEntries, qcTickets = [], items = [] }: StatsScreenProps) {
 const [selectedProjectFilter, setSelectedProjectFilter] = useState<string>('all');
 const [activeSegmentTab, setActiveSegmentTab] = useState<'today' | 'week' | 'month'>('today');

 const [selectedStage, setSelectedStage] = useState<'white' | 'paint' | 'finish' | 'pack' | 'delivery' | null>(null);
 const [selectedStageLabel, setSelectedStageLabel] = useState<string>('');
 const [instanceFilter, setInstanceFilter] = useState<'all' | 'pass' | 'fail'>('all');
 const [modalSearchQuery, setModalSearchQuery] = useState<string>('');
 const [selectedDetailInstance, setSelectedDetailInstance] = useState<any | null>(null);

 // States quản lý Modal xem danh sách cấu kiện cần QC
 const [showNeededQcModal, setShowNeededQcModal] = useState<boolean>(false);
 const [qcModalSearchQuery, setQcModalSearchQuery] = useState<string>('');
 const [qcStageFilter, setQcStageFilter] = useState<'all' | 'white' | 'paint' | 'finish' | 'pack'>('all');

 // State tải tất cả phiếu đóng gói để phục vụ bộ đếm "Kiện Đã Đóng Gói"
 const [packingLists, setPackingLists] = useState<any[]>([]);

 // --- localStorage cache cho packing stats (dùng chung key với PackingScreen) ---
 const PACKING_CACHE_KEY = 'draco_packing_lists_cache';
 const PACKING_TS_KEY = 'draco_packing_lists_ts';
 const CACHE_MAX_AGE_MS = 10 * 60 * 1000;

 // Load từ cache ngay lập tức
 useEffect(() => {
   try {
     const ts = Number(localStorage.getItem(PACKING_TS_KEY) || 0);
     if (Date.now() - ts <= CACHE_MAX_AGE_MS) {
       const raw = localStorage.getItem(PACKING_CACHE_KEY);
       if (raw) {
         const cached = JSON.parse(raw, (_key: string, val: any) => {
           if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(val)) return new Date(val);
           return val;
         });
         if (Array.isArray(cached) && cached.length > 0) setPackingLists(cached);
       }
     }
   } catch {}
 }, []);

 // Real-time listener
 useEffect(() => {
 const q = query(collection(db, 'packing'), orderBy('createdAt', 'desc'));
 const unsub = onSnapshot(q, (snapshot) => {
 const lists = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
 setPackingLists(lists);
 try {
   localStorage.setItem(PACKING_CACHE_KEY, JSON.stringify(lists));
   localStorage.setItem(PACKING_TS_KEY, String(Date.now()));
 } catch {}
 }, (err) => console.error("Error fetching packing lists for stats:", err));
 return unsub;
 }, []);

 const packingStats = useMemo(() => {
 let packed = 0;
 let total = 0;
 const now = new Date();
 const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

 const listToCount = selectedProjectFilter === 'all'
 ? packingLists
 : packingLists.filter(pl => pl.projectCode === selectedProjectFilter);

 listToCount.forEach(pl => {
 if (Array.isArray(pl.items)) {
 pl.items.forEach((item: any) => {
 const qty = item.quantity || 1;
 total += qty;

 // Chỉ đếm kiện đã đóng (packed hoặc packedQty > 0)
 const qtyPacked = item.packedQty || (item.packed ? qty : 0) || 0;
 if (qtyPacked > 0) {
 // Check theo ngày: lấy date từ packedAt hoặc item date
 let itemDate: Date | null = null;
 if (item.packedAt) {
 if (typeof item.packedAt.toDate === 'function') itemDate = item.packedAt.toDate();
 else if (item.packedAt.seconds) itemDate = new Date(item.packedAt.seconds * 1000);
 else { const d = new Date(item.packedAt); if (!isNaN(d.getTime())) itemDate = d; }
 }
 if (!itemDate && pl.completedAt) {
 if (typeof pl.completedAt.toDate === 'function') itemDate = pl.completedAt.toDate();
 else if (pl.completedAt.seconds) itemDate = new Date(pl.completedAt.seconds * 1000);
 else { const d = new Date(pl.completedAt); if (!isNaN(d.getTime())) itemDate = d; }
 }
 if (!itemDate && pl.createdAt) {
 if (typeof pl.createdAt.toDate === 'function') itemDate = pl.createdAt.toDate();
 else if (pl.createdAt.seconds) itemDate = new Date(pl.createdAt.seconds * 1000);
 else { const d = new Date(pl.createdAt); if (!isNaN(d.getTime())) itemDate = d; }
 }

 // Chỉ đếm kiện đóng trong ngày hôm nay
 if (itemDate && itemDate >= startOfToday) {
 packed += qtyPacked;
 }
 }
 });
 }
 });

 const pct = total > 0 ? Math.round((packed / total) * 100) : 0;
 return { packed, total, pct };
 }, [packingLists, selectedProjectFilter]);

 // Lọc ra các mã dự án duy nhất (chỉ dự án đang hoạt động)
 const uniqueProjects = useMemo(() => {
 const activeEntries = projectEntries.filter(pe => !pe.isCompleted);
 const codes = activeEntries.map(pe => pe.projectCode).filter((v): v is string => !!v);
 const set = new Set(codes);
 return Array.from(set).map(code => {
 const entry = activeEntries.find(pe => pe.projectCode === code);
 return {
 code,
 name: entry?.projectName || code
 };
 });
 }, [projectEntries]);

 // Các Entry được lọc theo Dự án (loại bỏ projects hoàn tất)
   const filteredEntries = useMemo(() => {
   const activeEntries = projectEntries.filter(pe => !pe.isCompleted);
   if (selectedProjectFilter === 'all') return activeEntries;
   return activeEntries.filter(pe => pe.projectCode === selectedProjectFilter);
   }, [projectEntries, selectedProjectFilter]);

  // Pre-compute: lấy instances + QC 1 lần duy nhất cho mỗi entry (tránh gọi lặp ở nhiều useMemo)
  const precomputedEntries = useMemo(() => {
  return filteredEntries.map(pe => {
  const instances = getModuleInstances(pe);
  const isAcc = pe.status?.toLowerCase().includes('phụ kiện') || pe.cluster?.toLowerCase().includes('phụ kiện');
  const isThung = !isAcc && (!pe.classification || pe.classification === 'Thùng');
  const isBo = pe.moduleType === 'bo';
  const aggWhite = getModuleQcAggregate(pe, 'white');
  const aggPaint = getModuleQcAggregate(pe, 'paint');
  const aggFinish = getModuleQcAggregate(pe, 'finish');
  return { pe, instances, isAcc, isThung, isBo, aggWhite, aggPaint, aggFinish };
  });
  }, [filteredEntries]);

  // Thống kê ERP Tổng quan
  const stats = useMemo(() => {
  let totalModules = 0;
  let totalAccessories = 0;
  let totalThung = 0;
  let packPassThung = 0;

  // Giai đoạn: White (Mộc), Paint (Sơn), Finish (Ráp)
  let whitePass = 0;
  let whiteFail = 0;
  let whitePending = 0;
  let whiteNone = 0;

  let paintPass = 0;
  let paintFail = 0;
  let paintPending = 0;
  let paintNone = 0;

  let finishPass = 0;
  let finishFail = 0;
  let finishPending = 0;
  let finishNone = 0;

  // Bóc tách khu vực (Area)
  const areaMap: { [key: string]: { pass: number; total: number } } = {};

  precomputedEntries.forEach(({ pe, instances, isAcc, isThung, isBo, aggWhite, aggPaint, aggFinish }) => {
  const qty = pe.quantity || 1;
  const area = pe.area || 'Chưa phân loại';
  if (!areaMap[area]) {
  areaMap[area] = { pass: 0, total: 0 };
  }

  if (isBo) {
  // Bo modules: dùng aggregate
  if (isAcc) { totalAccessories += qty; } else { totalModules += qty; }
  if (isThung) { totalThung += qty; }

  const wStatus = aggWhite?.status;
  if (wStatus === 'pass') whitePass += qty;
  else if (wStatus === 'fail') whiteFail += qty;
  else if (wStatus === 'pending') whitePending += qty;
  else whiteNone += qty;

  const pStatus = aggPaint?.status;
  if (pStatus === 'pass') paintPass += qty;
  else if (pStatus === 'fail') paintFail += qty;
  else if (pStatus === 'pending') paintPending += qty;
  else paintNone += qty;

  const fStatus = aggFinish?.status;
  if (fStatus === 'pass') finishPass += qty;
  else if (fStatus === 'fail') finishFail += qty;
  else if (fStatus === 'pending') finishPending += qty;
  else finishNone += qty;

  areaMap[area].total += qty;
  } else {
  // Normal modules: đếm theo instance
  instances.forEach(inst => {
  if (isAcc) { totalAccessories += 1; } else { totalModules += 1; }
  if (isThung) { totalThung += 1; }

  const wQc = getInstanceStageQc(inst, 'white', pe);
  if (wQc.status === 'pass') whitePass += 1;
  else if (wQc.status === 'fail') whiteFail += 1;
  else if (wQc.status === 'pending') whitePending += 1;
  else whiteNone += 1;

  const pQc = getInstanceStageQc(inst, 'paint', pe);
  if (pQc.status === 'pass') paintPass += 1;
  else if (pQc.status === 'fail') paintFail += 1;
  else if (pQc.status === 'pending') paintPending += 1;
  else paintNone += 1;

  const fQc = getInstanceStageQc(inst, 'finish', pe);
  if (fQc.status === 'pass') finishPass += 1;
  else if (fQc.status === 'fail') finishFail += 1;
  else if (fQc.status === 'pending') finishPending += 1;
  else finishNone += 1;

  areaMap[area].total += 1;
  });
  }
  });

 // Tính toán số liệu đóng gói: đếm từ packingLists, check theo ngày
 const filteredPackingLists = selectedProjectFilter === 'all'
 ? packingLists
 : packingLists.filter(pl => pl.projectCode === selectedProjectFilter);

 let packPass = 0;
 let packTotalQty = 0;
 const nowPack = new Date();
 const startOfTodayPack = new Date(nowPack.getFullYear(), nowPack.getMonth(), nowPack.getDate());

 filteredPackingLists.forEach(pl => {
 if (Array.isArray(pl.items)) {
 pl.items.forEach((item: any) => {
 const qty = item.quantity || 1;
 packTotalQty += qty;
 const qtyPacked = item.packedQty || (item.packed ? qty : 0) || 0;

 if (qtyPacked > 0) {
 // Check theo ngày
 let itemDate: Date | null = null;
 if (item.packedAt) {
 if (typeof item.packedAt.toDate === 'function') itemDate = item.packedAt.toDate();
 else if (item.packedAt.seconds) itemDate = new Date(item.packedAt.seconds * 1000);
 else { const d = new Date(item.packedAt); if (!isNaN(d.getTime())) itemDate = d; }
 }
 if (!itemDate && pl.completedAt) {
 if (typeof pl.completedAt.toDate === 'function') itemDate = pl.completedAt.toDate();
 else if (pl.completedAt.seconds) itemDate = new Date(pl.completedAt.seconds * 1000);
 else { const d = new Date(pl.completedAt); if (!isNaN(d.getTime())) itemDate = d; }
 }
 if (!itemDate && pl.createdAt) {
 if (typeof pl.createdAt.toDate === 'function') itemDate = pl.createdAt.toDate();
 else if (pl.createdAt.seconds) itemDate = new Date(pl.createdAt.seconds * 1000);
 else { const d = new Date(pl.createdAt); if (!isNaN(d.getTime())) itemDate = d; }
 }

 if (itemDate && itemDate >= startOfTodayPack) {
 packPass += qtyPacked;
 }
 }

 // Phân phối vào areaMap
 const matchedEntry = projectEntries.find(pe => pe.id === item.id || (pe.moduleCode || '').toLowerCase() === (item.name || '').toLowerCase());
 const area = matchedEntry?.area || 'Chưa phân loại';
 if (!areaMap[area]) {
 areaMap[area] = { pass: 0, total: 0 };
 }
 areaMap[area].pass += qtyPacked;
 });
 }
 });

 let packFail = 0;
 let packPending = Math.max(0, packTotalQty - packPass);
 let packNone = 0;

 const areasList = Object.entries(areaMap).map(([name, val]) => ({
 name,
 total: val.total,
 pass: val.pass,
 percent: val.total > 0 ? Math.round((val.pass / val.total) * 100) : 0
 })).sort((a, b) => b.total - a.total);

 // Tính toán lại các biến Pending thực sự từ các phiếu chờ kiểm (qcTickets) đang mở (status: 'pending')
 // Đảm bảo ánh xạ chính xác với trạng thái thực tế của cấu kiện trong bảng chính (projectEntries)
 let realWhitePending = 0;
 let realPaintPending = 0;
 let realFinishPending = 0;
 let realPackPending = 0;

 const activeTickets = qcTickets.filter(t => t.status === 'pending');
 activeTickets.forEach(ticket => {
 if (selectedProjectFilter !== 'all' && ticket.projectCode !== selectedProjectFilter) {
 return;
 }
 
 const stageField = ticket.stage === 'white' 
 ? 'qcWhite' 
 : (ticket.stage === 'paint' 
 ? 'qcPaint' 
 : (ticket.stage === 'finish' ? 'qcFinish' : 'qcPack'));

 ticket.modules?.forEach((m: any) => {
 const projectModule = projectEntries.find(pe => pe.id === m.id);
 const stageData = projectModule ? (projectModule as any)[stageField] : null;
 const currentRealStatus = stageData?.status || m.status || 'pending';

 if (currentRealStatus === 'pending' || currentRealStatus === 'none') {
 const qty = projectModule?.quantity || m.quantity || 1;
 const passed = currentRealStatus === 'pass' ? qty : (stageData?.passedQty || m.passedQty || 0);
 const remaining = Math.max(qty - passed, 0);
 
 if (ticket.stage === 'white') realWhitePending += remaining;
 else if (ticket.stage === 'paint') realPaintPending += remaining;
 else if (ticket.stage === 'finish') realFinishPending += remaining;
 else if (ticket.stage === 'pack') realPackPending += remaining;
 }
 });
 });

 whitePending = Math.max(whitePending, realWhitePending);
 paintPending = Math.max(paintPending, realPaintPending);
 finishPending = Math.max(finishPending, realFinishPending);
 packPending = Math.max(packPending, realPackPending);

 return {
 totalModules,
 totalAccessories,
 totalThung,
 packPassThung,
 white: { pass: whitePass, fail: whiteFail, pending: whitePending, none: whiteNone },
 paint: { pass: paintPass, fail: paintFail, pending: paintPending, none: paintNone },
 finish: { pass: finishPass, fail: finishFail, pending: finishPending, none: finishNone },
 pack: { pass: packPass, fail: packFail, pending: packPending, none: packNone },
 areasList
 };
 }, [filteredEntries, qcTickets, selectedProjectFilter, packingLists]);

 // Danh sách các cấu kiện cần QC (trạng thái pending ở các khâu)
 const neededQcItems = useMemo(() => {
   const list: Array<{
     id: string;
     projectCode: string;
     projectName: string;
     moduleCode: string;
     moduleName: string;
     unit: string;
     instanceId?: string;
     instanceIndex?: number;
     type: 'bo' | 'instance';
     stage: 'white' | 'paint' | 'finish' | 'pack';
     status: 'pending' | 'fail';
     by?: string;
     date?: any;
     notes?: string;
   }> = [];

   const activeTickets = qcTickets.filter(t => t.status === 'pending');
   activeTickets.forEach(ticket => {
     if (selectedProjectFilter !== 'all' && ticket.projectCode !== selectedProjectFilter) {
       return;
     }

     ticket.modules?.forEach((m: any) => {
       if (m.status !== 'pending') {
         return;
       }

       const baseId = getBaseModuleId(m.id);
       const pe = projectEntries.find(entry => entry.id === baseId || entry.moduleCode === m.moduleCode);
       
       const isAcc = pe?.status?.toLowerCase().includes('phụ kiện') || pe?.cluster?.toLowerCase().includes('phụ kiện');
       if (isAcc) return; // Bỏ qua phụ kiện

       const pCode = ticket.projectCode || pe?.projectCode || '';
       const pName = pe?.projectName || pCode;
       const mCode = m.moduleCode || pe?.moduleCode || '';
       const mName = pe ? ((pe as any).name || (pe as any).itemName || pe.moduleCode || '') : mCode;
       const unit = pe?.unit || 'Cái';

       let validDate: any = ticket.createdAt || ticket.updatedAt || null;

       list.push({
         id: `${ticket.id}-${m.id}-${ticket.stage}`,
         projectCode: pCode,
         projectName: pName,
         moduleCode: mCode,
         moduleName: mName,
         unit,
         instanceId: m.instanceIndex ? `${mCode}-${m.instanceIndex}` : m.id,
         instanceIndex: m.instanceIndex,
         type: pe?.moduleType === 'bo' ? 'bo' : 'instance',
         stage: ticket.stage,
         status: 'pending',
         by: ticket.createdBy || 'N/A',
         date: validDate,
         notes: m.qcNotes || ''
       });
     });
   });

   return list;
 }, [projectEntries, qcTickets, selectedProjectFilter]);

 const getDeliveryDate = (pe: any) => {
 let validDate: Date | null = null;
 if (Array.isArray(pe.statusHistory)) {
 for (let i = pe.statusHistory.length - 1; i >= 0; i--) {
 const logStr = pe.statusHistory[i];
 if (typeof logStr === 'string' && logStr.includes('|')) {
 const [text, tsStr] = logStr.split('|');
 if (
 text.includes('Giao Nhận') || 
 text.includes('Đã nhận') || 
 text.includes('Đang nhận') ||
 text.includes('Đã giao') ||
 text.includes('Đang giao')
 ) {
 const ts = parseInt(tsStr, 10);
 if (!isNaN(ts)) {
 validDate = new Date(ts);
 break;
 }
 }
 }
 }
 }
 if (!validDate && pe.updatedAt) {
 if (typeof pe.updatedAt.toDate === 'function') validDate = pe.updatedAt.toDate();
 else if (pe.updatedAt.seconds) validDate = new Date(pe.updatedAt.seconds * 1000);
 else {
 const d = new Date(pe.updatedAt);
 if (!isNaN(d.getTime())) validDate = d;
 }
 }
 if (!validDate && pe.createdAt) {
 if (typeof pe.createdAt.toDate === 'function') validDate = pe.createdAt.toDate();
 else if (pe.createdAt.seconds) validDate = new Date(pe.createdAt.seconds * 1000);
 else {
 const d = new Date(pe.createdAt);
 if (!isNaN(d.getTime())) validDate = d;
 }
 }
 return validDate;
 };

 // Bộ đếm năng suất % theo Ngày, Tuần, Tháng cho các khâu
 const parsedTimelineStats = useMemo(() => {
 const now = new Date();
 
 // Đầu ngày hôm nay
 const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
 
 // Đầu tuần này (Thứ hai)
 const startOfWeek = new Date(now);
 const day = startOfWeek.getDay();
 const diff = startOfWeek.getDate() - day + (day === 0 ? -6 : 1);
 startOfWeek.setDate(diff);
 startOfWeek.setHours(0, 0, 0, 0);
 
 // Đầu tháng này
 const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

 const getQCDate = (qcField: any, pe?: any, stageKey?: string) => {
 if (!qcField) return null;
 let validDate: Date | null = null;
 if (qcField.date) {
 if (typeof qcField.date.toDate === 'function') {
 validDate = qcField.date.toDate();
 } else if (qcField.date.seconds) {
 validDate = new Date(qcField.date.seconds * 1000);
 } else {
 const d = new Date(qcField.date);
 if (!isNaN(d.getTime())) {
 validDate = d;
 }
 }
 }
 if (!validDate && pe && stageKey && Array.isArray(pe.statusHistory)) {
 const stageKeywords: Record<string, string[]> = {
 white: ['QC Bạch', 'Bạch', 'qcWhite', 'Hàng Trắng'],
 paint: ['QC Sơn', 'Sơn', 'qcPaint', 'Hàng Sơn'],
 finish: ['QC Hoàn Thiện', 'Hoàn Thiện', 'qcFinish'],
 pack: ['QC Đóng Gói', 'Đóng Gói', 'qcPack']
 };
 const keywords = stageKeywords[stageKey] || [];
 for (let i = pe.statusHistory.length - 1; i >= 0; i--) {
 const logStr = pe.statusHistory[i];
 if (typeof logStr === 'string' && logStr.includes('|')) {
 const [text, tsStr] = logStr.split('|');
 const hasKeyword = keywords.some(kw => text.includes(kw));
 if (hasKeyword) {
 const ts = parseInt(tsStr, 10);
 if (!isNaN(ts)) {
 validDate = new Date(ts);
 break;
 }
 }
 }
 }
 }
 if (!validDate && pe) {
 if (stageKey === 'finish' && pe.qcDate) {
 if (typeof pe.qcDate.toDate === 'function') validDate = pe.qcDate.toDate();
 else if (pe.qcDate.seconds) validDate = new Date(pe.qcDate.seconds * 1000);
 else {
 const d = new Date(pe.qcDate);
 if (!isNaN(d.getTime())) validDate = d;
 }
 }
 if (!validDate && stageKey === 'finish' && pe.updatedAt) {
 if (typeof pe.updatedAt.toDate === 'function') validDate = pe.updatedAt.toDate();
 else if (pe.updatedAt.seconds) validDate = new Date(pe.updatedAt.seconds * 1000);
 else {
 const d = new Date(pe.updatedAt);
 if (!isNaN(d.getTime())) validDate = d;
 }
 }
 if (!validDate && pe.createdAt) {
 if (typeof pe.createdAt.toDate === 'function') validDate = pe.createdAt.toDate();
 else if (pe.createdAt.seconds) validDate = new Date(pe.createdAt.seconds * 1000);
 else {
 const d = new Date(pe.createdAt);
 if (!isNaN(d.getTime())) validDate = d;
 }
 }
 }
 return validDate;
 };

 const emptyStat = () => ({ pass: 0, fail: 0, total: 0 });

 const timeline = {
 today: { white: emptyStat(), paint: emptyStat(), finish: emptyStat(), pack: emptyStat(), delivery: emptyStat() },
 week: { white: emptyStat(), paint: emptyStat(), finish: emptyStat(), pack: emptyStat(), delivery: emptyStat() },
 month: { white: emptyStat(), paint: emptyStat(), finish: emptyStat(), pack: emptyStat(), delivery: emptyStat() }
 };

 filteredEntries.forEach(pe => {
 const processStage = (qcField: any, stageKey: 'white' | 'paint' | 'finish' | 'pack', isBo?: boolean, totalQty?: number) => {
 if (!qcField) return;
 // Bỏ qua QC từ sửa Excel (kể cả lịch sử cũ)
 if (
 qcField.viaExcel || 
 qcField.editedViaExcel || 
 typeof qcField.date === 'string' ||
 (qcField.by && qcField.by.includes('Excel')) ||
 (qcField.notes && qcField.notes.includes('Excel'))
 ) {
 return;
 }

 const date = getQCDate(qcField, pe, stageKey);
 if (!date) return;

 // Chỉ tính đóng gói do ĐG Leader hoàn tất bên trang Đóng Gói, không lẫn QC
 if (stageKey === 'pack') {
 const isDgLeader = qcField.by && (
 qcField.by.includes('ĐG Leader') || 
 qcField.by === 'Lê Ngọc Huy' || 
 qcField.by === 'Hệ Thống' ||
 (qcField.notes && (
 qcField.notes.toLowerCase().includes('đóng gói') ||
 qcField.notes.toLowerCase().includes('hoàn tất') ||
 qcField.notes.toLowerCase().includes('pass bù')
 ))
 ) && !qcField.by.includes('QC');
 if (!isDgLeader) return;
 }

 if (isBo) {
 const qtyPassed = qcField.passedQty || (qcField.status === 'pass' ? (totalQty || 1) : 0) || 0;
 const qtyFailed = qcField.status === 'fail' ? (totalQty || 1) - qtyPassed : 0;
 const qtyTotal = qtyPassed + qtyFailed;
 if (qtyTotal <= 0) return;

 // Hôm nay
 if (date >= startOfToday) {
 timeline.today[stageKey].pass += qtyPassed;
 timeline.today[stageKey].fail += qtyFailed;
 timeline.today[stageKey].total += qtyTotal;
 }
 // Tuần này
 if (date >= startOfWeek) {
 timeline.week[stageKey].pass += qtyPassed;
 timeline.week[stageKey].fail += qtyFailed;
 timeline.week[stageKey].total += qtyTotal;
 }
 // Tháng này
 if (date >= startOfMonth) {
 timeline.month[stageKey].pass += qtyPassed;
 timeline.month[stageKey].fail += qtyFailed;
 timeline.month[stageKey].total += qtyTotal;
 }
 } else {
 const isPass = qcField.status === 'pass';
 const isFail = qcField.status === 'fail';
 if (!isPass && !isFail) return; // Chỉ tính lượt đã kiểm tra

 // Hôm nay
 if (date >= startOfToday) {
 if (isPass) timeline.today[stageKey].pass += 1;
 if (isFail) timeline.today[stageKey].fail += 1;
 timeline.today[stageKey].total += 1;
 }
 // Tuần này
 if (date >= startOfWeek) {
 if (isPass) timeline.week[stageKey].pass += 1;
 if (isFail) timeline.week[stageKey].fail += 1;
 timeline.week[stageKey].total += 1;
 }
 // Tháng này
 if (date >= startOfMonth) {
 if (isPass) timeline.month[stageKey].pass += 1;
 if (isFail) timeline.month[stageKey].fail += 1;
 timeline.month[stageKey].total += 1;
 }
 }
 };

 if (pe.moduleType === 'bo') {
 const qty = pe.quantity || 1;
 processStage(pe.qcWhite, 'white', true, qty);
 processStage(pe.qcPaint, 'paint', true, qty);
 processStage(pe.qcFinish, 'finish', true, qty);
 } else {
 const instances = getModuleInstances(pe);
 instances.forEach(inst => {
 processStage(getInstanceStageQc(inst, 'white', pe), 'white');
 processStage(getInstanceStageQc(inst, 'paint', pe), 'paint');
 processStage(getInstanceStageQc(inst, 'finish', pe), 'finish');
 });
 }

 // Xử lý bộ đếm phát sinh cho khâu giao nhận (delivery) theo ngày, tuần, tháng
 const delivDate = getDeliveryDate(pe);
 if (delivDate && ((pe.receivedQuantity && pe.receivedQuantity > 0) || (pe.shippedQuantity && pe.shippedQuantity > 0))) {
 let qtyPassed = 0;
 let qtyTotal = 0;

 if (pe.moduleType === 'bo') {
 qtyPassed = pe.receivedQuantity || 0;
 qtyTotal = pe.quantity || 1;
 } else {
 const instances = getModuleInstances(pe);
 qtyPassed = instances.filter(inst => inst.delivered || (typeof pe.receivedQuantity === 'number' && inst.instanceIndex <= pe.receivedQuantity)).length;
 qtyTotal = instances.length || 1;
 }

 if (qtyPassed > 0) {
 // Hôm nay
 if (delivDate >= startOfToday) {
 timeline.today.delivery.pass += qtyPassed;
 timeline.today.delivery.total += qtyTotal;
 }
 // Tuần này
 if (delivDate >= startOfWeek) {
 timeline.week.delivery.pass += qtyPassed;
 timeline.week.delivery.total += qtyTotal;
 }
 // Tháng này
 if (delivDate >= startOfMonth) {
 timeline.month.delivery.pass += qtyPassed;
 timeline.month.delivery.total += qtyTotal;
 }
 }
 }

 });

 // Tính toán năng suất khâu đóng gói riêng biệt từ packingLists (chỉ đếm kiện đã đóng bên "Đóng Gói")
 const getPackingItemDate = (item: any, pl: any) => {
 if (item.packedAt) {
 if (typeof item.packedAt.toDate === 'function') return item.packedAt.toDate();
 if (item.packedAt.seconds) return new Date(item.packedAt.seconds * 1000);
 const d = new Date(item.packedAt);
 if (!isNaN(d.getTime())) return d;
 }
 if (pl.completedAt) {
 if (typeof pl.completedAt.toDate === 'function') return pl.completedAt.toDate();
 if (pl.completedAt.seconds) return new Date(pl.completedAt.seconds * 1000);
 const d = new Date(pl.completedAt);
 if (!isNaN(d.getTime())) return d;
 }
 if (pl.createdAt) {
 if (typeof pl.createdAt.toDate === 'function') return pl.createdAt.toDate();
 if (pl.createdAt.seconds) return new Date(pl.createdAt.seconds * 1000);
 const d = new Date(pl.createdAt);
 if (!isNaN(d.getTime())) return d;
 }
 return null;
 };

 const filteredPackingLists = selectedProjectFilter === 'all'
 ? packingLists
 : packingLists.filter(pl => pl.projectCode === selectedProjectFilter);

 filteredPackingLists.forEach(pl => {
 if (Array.isArray(pl.items)) {
 pl.items.forEach((item: any) => {
 const date = getPackingItemDate(item, pl);
 if (!date) return;

 const qty = item.quantity || 1;
 const qtyPacked = item.packedQty || (item.packed ? qty : 0) || 0;

 // Hôm nay
 if (date >= startOfToday) {
 timeline.today.pack.pass += qtyPacked;
 timeline.today.pack.total += qty;
 }
 // Tuần này
 if (date >= startOfWeek) {
 timeline.week.pack.pass += qtyPacked;
 timeline.week.pack.total += qty;
 }
 // Tháng này
 if (date >= startOfMonth) {
 timeline.month.pack.pass += qtyPacked;
 timeline.month.pack.total += qty;
 }
 });
 }
 });

 return timeline;
 }, [filteredEntries, packingLists, selectedProjectFilter]);

 // Hàm trích xuất chi tiết các instance được QC trong thời đoạn đã chọn
 const getStageInstances = (stageKey: 'white' | 'paint' | 'finish' | 'pack' | 'delivery', segment: 'today' | 'week' | 'month') => {
 const now = new Date();
 const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
 
 const startOfWeek = new Date(now);
 const day = startOfWeek.getDay();
 const diff = startOfWeek.getDate() - day + (day === 0 ? -6 : 1);
 startOfWeek.setDate(diff);
 startOfWeek.setHours(0, 0, 0, 0);
 
 const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
 const targetStartDate = segment === 'today' ? startOfToday : (segment === 'week' ? startOfWeek : startOfMonth);

 const getQCDate = (qcField: any, pe?: any, stageKey?: string) => {
 if (!qcField) return null;
 let validDate: Date | null = null;
 if (qcField.date) {
 if (typeof qcField.date.toDate === 'function') {
 validDate = qcField.date.toDate();
 } else if (qcField.date.seconds) {
 validDate = new Date(qcField.date.seconds * 1000);
 } else {
 const d = new Date(qcField.date);
 if (!isNaN(d.getTime())) {
 validDate = d;
 }
 }
 }
 if (!validDate && pe && stageKey && Array.isArray(pe.statusHistory)) {
 const stageKeywords: Record<string, string[]> = {
 white: ['QC Bạch', 'Bạch', 'qcWhite', 'Hàng Trắng'],
 paint: ['QC Sơn', 'Sơn', 'qcPaint', 'Hàng Sơn'],
 finish: ['QC Hoàn Thiện', 'Hoàn Thiện', 'qcFinish'],
 pack: ['QC Đóng Gói', 'Đóng Gói', 'qcPack']
 };
 const keywords = stageKeywords[stageKey] || [];
 for (let i = pe.statusHistory.length - 1; i >= 0; i--) {
 const logStr = pe.statusHistory[i];
 if (typeof logStr === 'string' && logStr.includes('|')) {
 const [text, tsStr] = logStr.split('|');
 const hasKeyword = keywords.some(kw => text.includes(kw));
 if (hasKeyword) {
 const ts = parseInt(tsStr, 10);
 if (!isNaN(ts)) {
 validDate = new Date(ts);
 break;
 }
 }
 }
 }
 }
 if (!validDate && pe) {
 if (stageKey === 'finish' && pe.qcDate) {
 if (typeof pe.qcDate.toDate === 'function') validDate = pe.qcDate.toDate();
 else if (pe.qcDate.seconds) validDate = new Date(pe.qcDate.seconds * 1000);
 else {
 const d = new Date(pe.qcDate);
 if (!isNaN(d.getTime())) validDate = d;
 }
 }
 if (!validDate && stageKey === 'finish' && pe.updatedAt) {
 if (typeof pe.updatedAt.toDate === 'function') validDate = pe.updatedAt.toDate();
 else if (pe.updatedAt.seconds) validDate = new Date(pe.updatedAt.seconds * 1000);
 else {
 const d = new Date(pe.updatedAt);
 if (!isNaN(d.getTime())) validDate = d;
 }
 }
 if (!validDate && pe.createdAt) {
 if (typeof pe.createdAt.toDate === 'function') validDate = pe.createdAt.toDate();
 else if (pe.createdAt.seconds) validDate = new Date(pe.createdAt.seconds * 1000);
 else {
 const d = new Date(pe.createdAt);
 if (!isNaN(d.getTime())) validDate = d;
 }
 }
 }
 return validDate;
 };

 const results: any[] = [];

 if (stageKey === 'pack') {
 const getPackingItemDate = (item: any, pl: any) => {
 if (item.packedAt) {
 if (typeof item.packedAt.toDate === 'function') return item.packedAt.toDate();
 if (item.packedAt.seconds) return new Date(item.packedAt.seconds * 1000);
 const d = new Date(item.packedAt);
 if (!isNaN(d.getTime())) return d;
 }
 if (pl.completedAt) {
 if (typeof pl.completedAt.toDate === 'function') return pl.completedAt.toDate();
 if (pl.completedAt.seconds) return new Date(pl.completedAt.seconds * 1000);
 const d = new Date(pl.completedAt);
 if (!isNaN(d.getTime())) return d;
 }
 if (pl.createdAt) {
 if (typeof pl.createdAt.toDate === 'function') return pl.createdAt.toDate();
 if (pl.createdAt.seconds) return new Date(pl.createdAt.seconds * 1000);
 const d = new Date(pl.createdAt);
 if (!isNaN(d.getTime())) return d;
 }
 return null;
 };

 const filteredPackingLists = selectedProjectFilter === 'all'
 ? packingLists
 : packingLists.filter(pl => pl.projectCode === selectedProjectFilter);

 filteredPackingLists.forEach(pl => {
 if (Array.isArray(pl.items)) {
 pl.items.forEach((item: any) => {
 const qtyPacked = item.packedQty || (item.packed ? item.quantity : 0) || 0;
 if (qtyPacked <= 0) return;

 const date = getPackingItemDate(item, pl);
 if (!date || date < targetStartDate) return;

 const matchedEntry = projectEntries.find(pe => pe.id === item.id || (pe.moduleCode?.toLowerCase() === item.name?.toLowerCase()));

 results.push({
 id: `${pl.id}-${item.id || item.name}-pack`,
 instanceId: item.id || item.name || 'N/A',
 moduleCode: matchedEntry?.moduleCode || item.name || '',
 name: (matchedEntry as any)?.name || (matchedEntry as any)?.itemName || item.name || '',
 projectCode: pl.projectCode || '',
 projectName: matchedEntry?.projectName || '',
 status: 'pass',
 by: item.packedBy || pl.userName || 'Đóng Gói Leader',
 date: date,
 notes: item.notes || `Đã đóng gói thực tế (bên Đóng Gói) ${qtyPacked}/${item.quantity || 1} kiện`,
 photos: item.photos || [],
 isBo: matchedEntry?.moduleType === 'bo',
 qty: qtyPacked
 });
 });
 }
 });

 return results.sort((a, b) => b.date.getTime() - a.date.getTime());
 }

 filteredEntries.forEach(pe => {
 if (stageKey === 'delivery') {
 if (pe.moduleType === 'bo') {
 if (pe.receivedQuantity && pe.receivedQuantity > 0) {
 const date = getDeliveryDate(pe);
 if (date && date >= targetStartDate) {
 results.push({
 id: `${pe.id}-bo-delivery`,
 instanceId: `Mã BO: ${pe.moduleCode} (Số lượng nhận: ${pe.receivedQuantity}/${pe.quantity})`,
 moduleCode: pe.moduleCode,
 name: (pe as any).name || (pe as any).itemName || pe.moduleCode || '',
 projectCode: pe.projectCode || '',
 projectName: pe.projectName || '',
 status: 'pass',
 by: 'Giao nhận',
 date: date,
 notes: `Đã nhận thành công ${pe.receivedQuantity}/${pe.quantity} bộ`,
 photos: [],
 isBo: true,
 qty: pe.receivedQuantity
 });
 }
 }
 } else {
 const instances = getModuleInstances(pe);
 instances.forEach(inst => {
 const isDelivered = inst.delivered || (typeof pe.receivedQuantity === 'number' && inst.instanceIndex <= pe.receivedQuantity);
 if (isDelivered) {
 const date = getDeliveryDate(pe);
 if (!date || date < targetStartDate) return;

 results.push({
 id: `${pe.id}-${inst.id || inst.instanceId}-delivery`,
 instanceId: inst.instanceId || inst.id,
 moduleCode: pe.moduleCode,
 name: (pe as any).name || (pe as any).itemName || pe.moduleCode || '',
 projectCode: pe.projectCode || '',
 projectName: pe.projectName || '',
 status: 'pass',
 by: 'Giao nhận',
 date: date,
 notes: 'Đã giao nhận thành công',
 photos: [],
 isBo: false,
 qty: 1
 });
 }
 });
 }
 return;
 }

 if (pe.moduleType === 'bo') {
 const qcField = pe[
 stageKey === 'white' ? 'qcWhite' : 
 (stageKey === 'paint' ? 'qcPaint' : 'qcFinish')
 ];
 if (!qcField) return;

 // Bỏ qua QC từ sửa Excel
 if (
 (qcField as any).viaExcel || 
 (qcField as any).editedViaExcel || 
 typeof qcField.date === 'string' ||
 (qcField.by && qcField.by.includes('Excel')) ||
 (qcField.notes && qcField.notes.includes('Excel'))
 ) {
 return;
 }

 const date = getQCDate(qcField, pe, stageKey);
 if (!date || date < targetStartDate) return;

 const isPass = qcField.status === 'pass';
 const isFail = qcField.status === 'fail';
 if (!isPass && !isFail) return;

 const qtyPassed = qcField.passedQty || (qcField.status === 'pass' ? (pe.quantity || 1) : 0) || 0;
 const qtyFailed = (pe.quantity || 1) - qtyPassed;

 if (qtyPassed > 0) {
 results.push({
 id: `${pe.moduleCode}-bo-pass`,
 instanceId: `Mã BO: ${pe.moduleCode} (Số lượng đạt: ${qtyPassed}/${pe.quantity})`,
 moduleCode: pe.moduleCode,
 name: (pe as any).name || (pe as any).itemName || pe.moduleCode || '',
 projectCode: pe.projectCode || '',
 projectName: pe.projectName || '',
 status: 'pass',
 by: qcField.by || 'Hệ thống',
 date: date,
 notes: qcField.notes || `Sản lượng đạt ${qtyPassed} cái`,
 photos: qcField.photos || [],
 isBo: true,
 qty: qtyPassed
 });
 }
 if (qtyFailed > 0) {
 results.push({
 id: `${pe.moduleCode}-bo-fail`,
 instanceId: `Mã BO: ${pe.moduleCode} (Số lượng lỗi: ${qtyFailed}/${pe.quantity})`,
 moduleCode: pe.moduleCode,
 name: (pe as any).name || (pe as any).itemName || pe.moduleCode || '',
 projectCode: pe.projectCode || '',
 projectName: pe.projectName || '',
 status: 'fail',
 by: qcField.by || 'Hệ thống',
 date: date,
 notes: qcField.notes || `Sản lượng lỗi ${qtyFailed} cái`,
 photos: qcField.photos || [],
 isBo: true,
 qty: qtyFailed
 });
 }
 } else {
 const instances = getModuleInstances(pe);
 instances.forEach(inst => {
 const qcField = getInstanceStageQc(inst, stageKey, pe);
 if (!qcField) return;

 // Bỏ qua QC từ sửa Excel
 if (
 (qcField as any).viaExcel || 
 (qcField as any).editedViaExcel || 
 typeof qcField.date === 'string' ||
 (qcField.by && qcField.by.includes('Excel')) ||
 (qcField.notes && qcField.notes.includes('Excel'))
 ) {
 return;
 }

 const date = getQCDate(qcField, pe, stageKey);
 if (!date || date < targetStartDate) return;

 const isPass = qcField.status === 'pass';
 const isFail = qcField.status === 'fail';
 if (!isPass && !isFail) return;

 results.push({
 id: `${pe.id}-${inst.id || inst.instanceId}`,
 instanceId: inst.instanceId || inst.id,
 moduleCode: pe.moduleCode,
 name: (pe as any).name || (pe as any).itemName || pe.moduleCode || '',
 projectCode: pe.projectCode || '',
 projectName: pe.projectName || '',
 status: qcField.status,
 by: qcField.by || 'Chưa rõ',
 date: date,
 notes: qcField.notes || '',
 photos: qcField.photos || [],
 isBo: false,
 qty: 1
 });
 });
 }
 });

 return results.sort((a, b) => b.date.getTime() - a.date.getTime());
 };

 // Tính toán tiến độ từng dự án để quản lý theo dõi dạng bảng
 // SẮP XẾP DỰ ÁN TỪ TIẾN ĐỘ CAO ĐẾN THẤP (bên cạnh tổng số lớn nhất, ưu tiên tỉ lệ hoàn thành)
 const projectProgressTable = useMemo(() => {
 const list: any[] = [];
 uniqueProjects.forEach(proj => {
 const projEntries = projectEntries.filter(pe => pe.projectCode === proj.code);
 let totalQ = 0;
 let whitePassed = 0;
 let paintPassed = 0;
 let finishPassed = 0;

 projEntries.forEach(pe => {
 if (pe.moduleType === 'bo') {
 const qty = pe.quantity || 1;
 totalQ += qty;
 whitePassed += pe.qcWhite?.passedQty || (pe.qcWhite?.status === 'pass' ? qty : 0) || 0;
 paintPassed += pe.qcPaint?.passedQty || (pe.qcPaint?.status === 'pass' ? qty : 0) || 0;
 finishPassed += pe.qcFinish?.passedQty || (pe.qcFinish?.status === 'pass' ? qty : 0) || 0;
 } else {
 const instances = getModuleInstances(pe);
 instances.forEach(inst => {
 totalQ += 1;
 if (getInstanceStageQc(inst, 'white', pe).status === 'pass') whitePassed += 1;
 if (getInstanceStageQc(inst, 'paint', pe).status === 'pass') paintPassed += 1;
 if (getInstanceStageQc(inst, 'finish', pe).status === 'pass') finishPassed += 1;
 });
 }
 });

 // Đếm số kiện đã đóng gói hoàn tất từ packingLists cho dự án này
 let packPassed = 0;
 const projPackingLists = packingLists.filter(pl => pl.projectCode === proj.code);
 projPackingLists.forEach(pl => {
 if (Array.isArray(pl.items)) {
 pl.items.forEach((item: any) => {
 if (item.packed) {
 packPassed += item.quantity || 1;
 } else if (typeof item.packedQty === 'number' && item.packedQty > 0) {
 packPassed += item.packedQty;
 }
 });
 }
 });

 if (totalQ > 0) {
 list.push({
 code: proj.code,
 name: proj.name,
 total: totalQ,
 whitePct: Math.round((whitePassed / totalQ) * 100),
 paintPct: Math.round((paintPassed / totalQ) * 100),
 finishPct: Math.round((finishPassed / totalQ) * 100),
 packPct: Math.round((packPassed / totalQ) * 100),
 // Chỉ số hoàn thành tổng hợp của dự án (trung bình đóng gói hoàn chỉnh)
 overallPct: Math.round((packPassed / totalQ) * 100)
 });
 }
 });

 // Sắp xếp các dự án từ tiến độ hoàn thành (overallPct) cao nhất đến thấp nhất
 return list.sort((a, b) => b.overallPct - a.overallPct);
 }, [projectEntries, uniqueProjects, packingLists]);

 // Biểu đồ xu hướng đóng gói 7 ngày qua
 const last7DaysData = useMemo(() => {
 const list = [];
 const getPackingListDate = (pl: any) => {
 if (!pl.createdAt) return null;
 if (typeof pl.createdAt.toDate === 'function') return pl.createdAt.toDate();
 if (pl.createdAt.seconds) return new Date(pl.createdAt.seconds * 1000);
 const d = new Date(pl.createdAt);
 return isNaN(d.getTime()) ? null : d;
 };

 const filteredPackingLists = selectedProjectFilter === 'all'
 ? packingLists
 : packingLists.filter(pl => pl.projectCode === selectedProjectFilter);

 for (let i = 6; i >= 0; i--) {
 const d = new Date();
 d.setDate(d.getDate() - i);
 const dateStr = `${d.getDate()}/${d.getMonth() + 1}`;
 const startOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
 const endOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
 
 let passCount = 0;
 filteredPackingLists.forEach(pl => {
 const date = getPackingListDate(pl);
 if (date && date >= startOfDay && date <= endOfDay) {
 if (Array.isArray(pl.items)) {
 pl.items.forEach((item: any) => {
 if (item.packed) {
 passCount += item.quantity || 1;
 } else if (typeof item.packedQty === 'number' && item.packedQty > 0) {
 passCount += item.packedQty;
 }
 });
 }
 }
 });
 list.push({ label: dateStr, count: passCount });
 }
 return list;
 }, [packingLists, selectedProjectFilter]);

 // Dữ liệu cho Bar Chart SVG: So sánh Đạt vs Lỗi giữa các khâu
 const barChartData = useMemo(() => {
 return [
 { name: 'Mộc', pass: stats.white.pass, fail: stats.white.fail },
 { name: 'Sơn', pass: stats.paint.pass, fail: stats.paint.fail },
 { name: 'Lắp ráp', pass: stats.finish.pass, fail: stats.finish.fail },
 { name: 'Đóng gói', pass: stats.pack.pass, fail: stats.pack.fail },
 ];
 }, [stats]);

 const maxValForBarChart = useMemo(() => {
 const vals = barChartData.flatMap(d => [d.pass, d.fail]);
 return Math.max(...vals, 10);
 }, [barChartData]);

 return (
 <div className="space-y-6 pb-20">
 {/* Header */}
 <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-100 pb-4">
 <div className="flex items-center gap-3">
 <div className="bg-indigo-100 border border-indigo-100 p-2.5 rounded-lg text-indigo-600 block">
 <LayoutDashboard size={22} />
 </div>
 <div>
 <h2 className="text-xl font-black text-slate-800 uppercase tracking-tight">Thống Kê Sản Xuất</h2>
 <p className="text-xs text-slate-400 font-bold uppercase tracking-wider mt-0.5">Báo cáo năng suất QC & tiến độ hoàn thành cấu kiện nội thất</p>
 </div>
 </div>

 {/* Bộ lọc dự án */}
 <div className="flex items-center gap-2">
 <span className="text-xs font-black text-slate-500 uppercase shrink-0">Dự án:</span>
 <select
 value={selectedProjectFilter}
 onChange={(e) => setSelectedProjectFilter(e.target.value)}
 className="bg-white border border-slate-300 py-2 px-3 text-xs font-black rounded-sm text-slate-700 uppercase outline-none focus:border-indigo-500 shadow-sm"
 >
 <option value="all">TẤT CẢ DỰ ÁN ({uniqueProjects.length})</option>
 {uniqueProjects.map(p => (
 <option key={p.code} value={p.code}>
 {p.code} - {p.name}
 </option>
 ))}
 </select>
 </div>
 </div>

 {/* Grid KPI chính */}
 <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
 {/* KPI 1 */}
 <div className="bg-white border border-slate-100 p-5 rounded-lg flex items-center justify-between shadow-sm relative overflow-hidden">
 <div className="space-y-1 z-10">
 <p className="text-[10px] font-black uppercase text-slate-400 tracking-widest leading-none">Cấu kiện (Modules)</p>
 <h3 className="text-3xl font-black text-slate-800 tracking-tight">{stats.totalModules}</h3>
 <p className="text-[10px] text-indigo-600 font-bold uppercase">Trong dây chuyền sản xuất</p>
 </div>
 <div className="text-indigo-400/15 absolute -right-3 -bottom-3 p-2 bg-indigo-100 rounded-full">
 <Layers size={90} />
 </div>
 </div>

 {/* KPI 2 */}
 <div className="bg-white border border-slate-100 p-5 rounded-lg flex items-center justify-between shadow-sm relative overflow-hidden font-sans">
 <div className="space-y-1 z-10">
 <p className="text-[10px] font-black uppercase text-slate-400 tracking-widest leading-none">Kiện Đã Đóng Gói</p>
 <h3 className="text-3xl font-black text-emerald-600 tracking-tight">{packingStats.packed}</h3>
 <p className="text-[10px] text-slate-400 font-bold uppercase">
 Tỷ lệ hoàn thành: <span className="text-emerald-600 font-extrabold">{packingStats.pct}%</span>
 <span className="block text-[8px] text-slate-500 font-medium mt-0.5 whitespace-nowrap">Tổng nhu cầu: {packingStats.total} kiện</span>
 </p>
 </div>
 <div className="text-emerald-400/15 absolute -right-3 -bottom-3 p-2 bg-emerald-100 rounded-full">
 <CheckCircle size={90} />
 </div>
 </div>

 {/* KPI 3 */}
 <div className="bg-white border border-slate-100 p-5 rounded-lg flex items-center justify-between shadow-sm relative overflow-hidden">
 <div className="space-y-1 z-10">
 <p className="text-[10px] font-black uppercase text-slate-400 tracking-widest leading-none">Phụ Kiện Đi Kèm</p>
 <h3 className="text-3xl font-black text-amber-600 tracking-tight">{stats.totalAccessories}</h3>
 <p className="text-[10px] text-slate-400 font-bold uppercase">Liên kết theo mã lắp ráp</p>
 </div>
 <div className="text-amber-400/15 absolute -right-3 -bottom-3 p-2 bg-amber-100 rounded-full">
 <Package size={90} />
 </div>
 </div>

 {/* KPI 4 */}
 <div 
 onClick={() => setShowNeededQcModal(true)}
 className="bg-white border border-slate-100 p-5 rounded-lg flex items-center justify-between shadow-sm relative overflow-hidden cursor-pointer hover:border-cyan-300 transition-all hover:shadow-md active:scale-95 group font-sans"
 >
 <div className="space-y-1 z-10">
 <p className="text-[10px] font-black uppercase text-slate-400 tracking-widest leading-none group-hover:text-cyan-600 transition-colors">Đang Kiểm Tra (QC)</p>
 <h3 className="text-3xl font-black text-cyan-600 tracking-tight">
 {neededQcItems.length}
 </h3>
 </div>
 <div className="text-cyan-400/20 absolute -right-3 -bottom-3 p-2 bg-cyan-100 rounded-full group-hover:scale-110 transition-transform">
 <Clock size={90} />
 </div>
 </div>
 </div>

 {/* BỘ ĐẾM NĂNG SUẤT % THEO NGÀY, TUẦN, NĂM CỦA CÁC KHÂU */}
 <div className="bg-white border border-slate-100 rounded-lg p-6 shadow-sm space-y-5">
 <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
 <div>
 <h3 className="text-xs font-black text-slate-900 uppercase tracking-widest flex items-center gap-2">
 <TrendingUp size={16} className="text-indigo-600" />
 Năng Suất Hoạt Động & Tỷ Lệ QC Đạt Theo Lịch Trình
 </h3>
 <p className="text-[10px] text-slate-400 font-bold uppercase mt-0.5">
 Tổng số cấu kiện đạt (PASS) và hiệu suất chất lượng trong các thời đoạn
 </p>
 </div>

 {/* Toggle Tab Ngày / Tuần / Năm */}
 <div className="flex bg-slate-100 p-0.5 rounded-sm max-w-[270px]">
 <button
 onClick={() => setActiveSegmentTab('today')}
 className={`flex-1 px-3.5 py-1.5 text-[10px] font-black uppercase transition-all whitespace-nowrap rounded-sm ${
 activeSegmentTab === 'today'
 ? 'bg-white text-indigo-600 shadow-sm'
 : 'text-slate-500 hover:text-slate-800'
 }`}
 >
 Hôm Nay
 </button>
 <button
 onClick={() => setActiveSegmentTab('week')}
 className={`flex-1 px-3.5 py-1.5 text-[10px] font-black uppercase transition-all whitespace-nowrap rounded-sm ${
 activeSegmentTab === 'week'
 ? 'bg-white text-indigo-600 shadow-sm'
 : 'text-slate-500 hover:text-slate-800'
 }`}
 >
 Tuần Này
 </button>
 <button
 onClick={() => setActiveSegmentTab('month')}
 className={`flex-1 px-3.5 py-1.5 text-[10px] font-black uppercase transition-all whitespace-nowrap rounded-sm ${
 activeSegmentTab === 'month'
 ? 'bg-white text-indigo-600 shadow-sm'
 : 'text-slate-500 hover:text-slate-800'
 }`}
 >
 Tháng Này
 </button>
 </div>
 </div>

 <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 pt-1">
 {/* 1. Mộc */}
 {(() => {
 const currentStat = parsedTimelineStats[activeSegmentTab].white;
 const pct = currentStat.total > 0 ? Math.round((currentStat.pass / currentStat.total) * 100) : 0;
 return (
 <div 
 onClick={() => {
 setSelectedStage('white');
 setSelectedStageLabel('Mộc Thô');
 setInstanceFilter('all');
 setModalSearchQuery('');
 setSelectedDetailInstance(null);
 }}
 className="bg-slate-100/50 hover:bg-slate-100/70 border border-slate-100 hover:border-indigo-300 p-4 rounded-lg space-y-3 transition-all cursor-pointer active:scale-[0.99] group shadow-sm hover:shadow"
 >
 <div className="flex items-center justify-between">
 <span className="text-[11px] font-black text-slate-700 uppercase tracking-wider block group-hover:text-indigo-600 transition-colors">1. KHÂU MỘC THÔ</span>
 <span className="text-indigo-600 font-extrabold text-xs">{currentStat.total > 0 ? `${pct}% đạt` : '0 lượt'}</span>
 </div>
 <div className="space-y-1">
 <div className="flex items-baseline gap-1.5">
 <span className="text-2xl font-black text-slate-800">{currentStat.pass}</span>
 <span className="text-[10px] text-slate-404 font-bold uppercase">CẤU KIỆN ĐẠT</span>
 </div>
 <div className="w-full bg-slate-200/60 h-1.5 rounded-sm overflow-hidden">
 <div className="bg-indigo-500 h-full transition-all duration-300" style={{ width: `${pct}%` }} />
 </div>
 </div>
 <div className="flex justify-between text-[10px] font-bold text-slate-404 uppercase pt-1 border-t border-slate-100/65 group-hover:border-indigo-100 transition-colors">
 <span>Tổng QC: <b className="text-slate-700">{currentStat.total}</b></span>
 <span>Lỗi: <b className="text-rose-500">{currentStat.fail}</b></span>
 </div>
 </div>
 );
 })()}

 {/* 2. Giao nhận */}
 {(() => {
 const currentStat = parsedTimelineStats[activeSegmentTab].delivery || { pass: 0, total: 0, fail: 0 };
 const pct = currentStat.total > 0 ? Math.round((currentStat.pass / currentStat.total) * 100) : 0;
 return (
 <div 
 onClick={() => {
 setSelectedStage('delivery');
 setSelectedStageLabel('Giao nhận');
 setInstanceFilter('all');
 setModalSearchQuery('');
 setSelectedDetailInstance(null);
 }}
 className="bg-slate-100/50 hover:bg-slate-100/70 border border-slate-100 hover:border-amber-300 p-4 rounded-lg space-y-3 transition-all cursor-pointer active:scale-[0.99] group shadow-sm hover:shadow"
 >
 <div className="flex items-center justify-between">
 <span className="text-[11px] font-black text-slate-700 uppercase tracking-wider block group-hover:text-amber-600 transition-colors">2. KHÂU GIAO NHẬN</span>
 <span className="text-amber-600 font-extrabold text-xs">{currentStat.total > 0 ? `${pct}% nhận` : '0 lượt'}</span>
 </div>
 <div className="space-y-1">
 <div className="flex items-baseline gap-1.5">
 <span className="text-2xl font-black text-slate-900">{currentStat.pass}</span>
 <span className="text-[10px] text-slate-404 font-bold uppercase">CẤU KIỆN NHẬN</span>
 </div>
 <div className="w-full bg-slate-200/60 h-1.5 rounded-lg overflow-hidden">
 <div className="bg-amber-500 h-full transition-all duration-300 rounded-lg" style={{ width: `${pct}%` }} />
 </div>
 </div>
 <div className="flex justify-between text-[10px] font-bold text-slate-404 uppercase pt-1 border-t border-slate-100/65 group-hover:border-amber-100 transition-colors">
 <span>Mục tiêu: <b className="text-slate-700">{currentStat.total}</b></span>
 <span>Chờ nhận: <b className="text-amber-600">{Math.max(0, currentStat.total - currentStat.pass)}</b></span>
 </div>
 </div>
 );
 })()}

 {/* 3. Sơn */}
 {(() => {
 const currentStat = parsedTimelineStats[activeSegmentTab].paint;
 const pct = currentStat.total > 0 ? Math.round((currentStat.pass / currentStat.total) * 100) : 0;
 return (
 <div 
 onClick={() => {
 setSelectedStage('paint');
 setSelectedStageLabel('Sơn Phủ');
 setInstanceFilter('all');
 setModalSearchQuery('');
 setSelectedDetailInstance(null);
 }}
 className="bg-slate-100/50 hover:bg-slate-100/70 border border-slate-100 hover:border-cyan-300 p-4 rounded-lg space-y-3 transition-all cursor-pointer active:scale-[0.99] group shadow-sm hover:shadow"
 >
 <div className="flex items-center justify-between">
 <span className="text-[11px] font-black text-slate-700 uppercase tracking-wider block group-hover:text-cyan-600 transition-colors">3. KHÂU SƠN PHỦ</span>
 <span className="text-cyan-600 font-extrabold text-xs">{currentStat.total > 0 ? `${pct}% đạt` : '0 lượt'}</span>
 </div>
 <div className="space-y-1">
 <div className="flex items-baseline gap-1.5">
 <span className="text-2xl font-black text-slate-800">{currentStat.pass}</span>
 <span className="text-[10px] text-slate-404 font-bold uppercase">CẤU KIỆN ĐẠT</span>
 </div>
 <div className="w-full bg-slate-200/60 h-1.5 rounded-sm overflow-hidden">
 <div className="bg-cyan-500 h-full transition-all duration-300" style={{ width: `${pct}%` }} />
 </div>
 </div>
 <div className="flex justify-between text-[10px] font-bold text-slate-404 uppercase pt-1 border-t border-slate-100/65 group-hover:border-cyan-100 transition-colors">
 <span>Tổng QC: <b className="text-slate-700">{currentStat.total}</b></span>
 <span>Lỗi: <b className="text-rose-500">{currentStat.fail}</b></span>
 </div>
 </div>
 );
 })()}

 {/* 4. Lắp ráp */}
 {(() => {
 const currentStat = parsedTimelineStats[activeSegmentTab].finish;
 const pct = currentStat.total > 0 ? Math.round((currentStat.pass / currentStat.total) * 100) : 0;
 return (
 <div 
 onClick={() => {
 setSelectedStage('finish');
 setSelectedStageLabel('Lắp Ráp');
 setInstanceFilter('all');
 setModalSearchQuery('');
 setSelectedDetailInstance(null);
 }}
 className="bg-slate-100/50 hover:bg-slate-100/70 border border-slate-100 hover:border-purple-300 p-4 rounded-lg space-y-3 transition-all cursor-pointer active:scale-[0.99] group shadow-sm hover:shadow"
 >
 <div className="flex items-center justify-between">
 <span className="text-[11px] font-black text-slate-700 uppercase tracking-wider block group-hover:text-purple-600 transition-colors">4. KHÂU LẮP RÁP</span>
 <span className="text-purple-600 font-extrabold text-xs">{currentStat.total > 0 ? `${pct}% đạt` : '0 lượt'}</span>
 </div>
 <div className="space-y-1">
 <div className="flex items-baseline gap-1.5">
 <span className="text-2xl font-black text-slate-800">{currentStat.pass}</span>
 <span className="text-[10px] text-slate-404 font-bold uppercase">CẤU KIỆN ĐẠT</span>
 </div>
 <div className="w-full bg-slate-200/60 h-1.5 rounded-sm overflow-hidden">
 <div className="bg-purple-500 h-full transition-all duration-300" style={{ width: `${pct}%` }} />
 </div>
 </div>
 <div className="flex justify-between text-[10px] font-bold text-slate-404 uppercase pt-1 border-t border-slate-100/65 group-hover:border-purple-100 transition-colors">
 <span>Tổng QC: <b className="text-slate-700">{currentStat.total}</b></span>
 <span>Lỗi: <b className="text-rose-500">{currentStat.fail}</b></span>
 </div>
 </div>
 );
 })()}

 {/* 5. Đóng gói */}
 {(() => {
 const currentStat = parsedTimelineStats[activeSegmentTab].pack;
 const pct = currentStat.total > 0 ? Math.round((currentStat.pass / currentStat.total) * 100) : 0;
 return (
 <div 
 onClick={() => {
 setSelectedStage('pack');
 setSelectedStageLabel('Đóng Gói');
 setInstanceFilter('all');
 setModalSearchQuery('');
 setSelectedDetailInstance(null);
 }}
 className="bg-slate-100/50 hover:bg-slate-100/70 border border-slate-100 hover:border-emerald-300 p-4 rounded-lg space-y-3 transition-all cursor-pointer active:scale-[0.99] group shadow-sm hover:shadow"
 >
 <div className="flex items-center justify-between">
 <span className="text-[11px] font-black text-slate-700 uppercase tracking-wider block group-hover:text-emerald-600 transition-colors">5. KHÂU ĐÓNG GÓI</span>
 <span className="text-emerald-600 font-extrabold text-xs">{currentStat.total > 0 ? `${pct}% đạt` : '0 lượt'}</span>
 </div>
 <div className="space-y-1">
 <div className="flex items-baseline gap-1.5">
 <span className="text-2xl font-black text-slate-800">{currentStat.pass}</span>
 <span className="text-[10px] text-slate-404 font-bold uppercase">CẤU KIỆN ĐẠT</span>
 </div>
 <div className="w-full bg-slate-200/60 h-1.5 rounded-sm overflow-hidden">
 <div className="bg-emerald-500 h-full transition-all duration-300" style={{ width: `${pct}%` }} />
 </div>
 </div>
 <div className="flex justify-between text-[10px] font-bold text-slate-404 uppercase pt-1 border-t border-slate-100/65 group-hover:border-emerald-100 transition-colors">
 <span>Tổng QC: <b className="text-slate-700">{currentStat.total}</b></span>
 <span>Lỗi: <b className="text-rose-500">{currentStat.fail}</b></span>
 </div>
 </div>
 );
 })()}
 </div>
 </div>

 {/* BIỂU ĐỒ - QUẢN LÝ ERP KHÔNG TRÙNG LẶP */}
 <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
 {/* Chart 1: Biểu đồ cột SVG so sánh Đạt & Lỗi 4 khâu */}
 <div className="bg-white border border-slate-100 rounded-lg p-6 shadow-sm space-y-4">
 <div>
 <h3 className="text-xs font-black text-slate-800 uppercase tracking-widest flex items-center gap-1.5">
 <PieChart size={15} className="text-indigo-600" />
 So Sánh Năng Suất Kiểm Định Theo Công Đoạn
 </h3>
 <p className="text-[10px] text-slate-400 font-bold uppercase mt-0.5">
 Tương quan cấu kiện ĐẠT (PASS) và LỖI (FAIL) lũy kế qua các khâu
 </p>
 </div>

 {/* SVG Bar Chart */}
 <div className="relative h-[220px] w-full pt-4 font-sans">
 <svg viewBox="0 0 500 220" className="w-full h-full">
 {/* Grid lines */}
 <line x1="50" y1="20" x2="480" y2="20" stroke="#f1f5f9" strokeWidth="1" />
 <line x1="50" y1="70" x2="480" y2="70" stroke="#f1f5f9" strokeWidth="1" />
 <line x1="50" y1="120" x2="480" y2="120" stroke="#f1f5f9" strokeWidth="1" />
 <line x1="50" y1="170" x2="480" y2="170" stroke="#94a3b8" strokeWidth="1" />

 {/* Y Axis labels */}
 <text x="15" y="24" className="text-[9px] fill-slate-400 font-bold" textAnchor="start">
 {Math.round(maxValForBarChart)}
 </text>
 <text x="15" y="74" className="text-[9px] fill-slate-400 font-bold" textAnchor="start">
 {Math.round(maxValForBarChart * 0.6)}
 </text>
 <text x="15" y="124" className="text-[9px] fill-slate-400 font-bold" textAnchor="start">
 {Math.round(maxValForBarChart * 0.3)}
 </text>
 <text x="15" y="174" className="text-[9px] fill-slate-400 font-bold" textAnchor="start">
 0
 </text>

 {/* Bars render */}
 {barChartData.map((d, index) => {
 const xBase = 80 + index * 105;
 const passHeight = maxValForBarChart > 0 ? (d.pass / maxValForBarChart) * 130 : 0;
 const failHeight = maxValForBarChart > 0 ? (d.fail / maxValForBarChart) * 130 : 0;
 
 // Y Coor
 const passY = 170 - passHeight;
 const failY = 170 - failHeight;

 return (
 <g key={d.name}>
 {/* Cột ĐẠT (Màu xanh Indigo mượt) */}
 <rect 
 x={xBase} 
 y={passY} 
 width="18" 
 height={Math.max(passHeight, 2)} 
 fill="#6366f1" 
 rx="2"
 className="transition-all hover:opacity-85 duration-300"
 />
 <text x={xBase + 9} y={Math.max(passY - 4, 15)} className="text-[9px] font-black fill-indigo-700" textAnchor="middle">
 {d.pass}
 </text>

 {/* Cột LỖI (Màu đỏ mộc) */}
 <rect 
 x={xBase + 23} 
 y={failY} 
 width="18" 
 height={Math.max(failHeight, 2)} 
 fill="#ef4444" 
 rx="2"
 className="transition-all hover:opacity-85 duration-300"
 />
 <text x={xBase + 32} y={Math.max(failY - 4, 15)} className="text-[9px] font-black fill-rose-700" textAnchor="middle">
 {d.fail}
 </text>

 {/* Nhãn trục X */}
 <text x={xBase + 20} y="192" className="text-[10px] font-black fill-slate-500 uppercase" textAnchor="middle">
 {d.name}
 </text>
 </g>
 );
 })}
 </svg>
 </div>

 {/* Chú giải */}
 <div className="flex items-center justify-center gap-6 pt-3 border-t border-slate-100 font-semibold text-[10px] text-slate-500 uppercase">
 <div className="flex items-center gap-2">
 <span className="w-3 h-3 bg-indigo-500 rounded-sm"></span>
 Cấu kiện Nghiệm thu ĐẠT (PASS)
 </div>
 <div className="flex items-center gap-2">
 <span className="w-3 h-3 bg-rose-500 rounded-sm"></span>
 Phát hiện sai sót LỖI (FAIL)
 </div>
 </div>
 </div>

 {/* Chart 2: Biểu đồ xu hướng đóng gói 7 ngày qua (SVG Area Chart) */}
 <div className="bg-white border border-slate-100 rounded-lg p-6 shadow-sm space-y-4">
 <div>
 <h3 className="text-xs font-black text-slate-800 uppercase tracking-widest flex items-center gap-1.5">
 <TrendingUp size={15} className="text-emerald-600" />
 Biểu Đồ Xu Hướng Đóng Gói Hoàn Thiện
 </h3>
 <p className="text-[10px] text-slate-400 font-bold uppercase mt-0.5">
 Sản lượng thùng hàng hoàn thành đóng gói xuất xưởng trong 7 ngày vừa qua
 </p>
 </div>

 {/* SVG Area Chart */}
 <div className="relative h-[220px] w-full pt-4 font-sans">
 {(() => {
 const maxCount = Math.max(...last7DaysData.map(d => d.count), 5);
 const points = last7DaysData.map((d, index) => {
 const x = 50 + index * 68;
 const y = 170 - (d.count / maxCount) * 130;
 return { x, y, label: d.label, count: d.count };
 });

 const areaPath = points.length > 0 
 ? `M ${points[0].x} 170 ` + points.map(p => `L ${p.x} ${p.y}`).join(' ') + ` L ${points[points.length - 1].x} 170 Z`
 : '';

 const linePath = points.length > 0
 ? points.map((p, index) => `${index === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')
 : '';

 return (
 <svg viewBox="0 0 500 220" className="w-full h-full">
 <defs>
 <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
 <stop offset="0%" stopColor="#10b981" stopOpacity="0.25" />
 <stop offset="100%" stopColor="#10b981" stopOpacity="0" />
 </linearGradient>
 </defs>

 {/* Lines background */}
 <line x1="50" y1="40" x2="470" y2="40" stroke="#f1f5f9" strokeWidth="1" />
 <line x1="50" y1="105" x2="470" y2="105" stroke="#f1f5f9" strokeWidth="1" />
 <line x1="50" y1="170" x2="470" y2="170" stroke="#cbd5e1" strokeWidth="1" />

 {/* Y Labels */}
 <text x="15" y="44" className="text-[9px] fill-slate-400 font-semibold" textAnchor="start">{maxCount}</text>
 <text x="15" y="109" className="text-[9px] fill-slate-400 font-semibold" textAnchor="start">{Math.round(maxCount / 2)}</text>
 <text x="15" y="174" className="text-[9px] fill-slate-400 font-semibold" textAnchor="start">0</text>

 {/* Area fill */}
 {areaPath && <path d={areaPath} fill="url(#areaGrad)" />}

 {/* TrendLine */}
 {linePath && <path d={linePath} fill="none" stroke="#10b981" strokeWidth="2.5" strokeLinecap="round" />}

 {/* Points on Line */}
 {points.map((p, index) => (
 <g key={index}>
 <circle 
 cx={p.x} 
 cy={p.y} 
 r="4" 
  fill="white"
 stroke="#10b981" 
 strokeWidth="2.5" 
 className="cursor-pointer hover:r-5 transition-all"
 />
 <text x={p.x} y={p.y - 8} className="text-[9px] font-black fill-emerald-800" textAnchor="middle">
 {p.count}
 </text>
 {/* X Label */}
 <text x={p.x} y="192" className="text-[9px] font-bold fill-slate-500 uppercase" textAnchor="middle">
 {p.label}
 </text>
 </g>
 ))}
 </svg>
 );
 })()}
 </div>

 <div className="bg-emerald-100/50 p-2 text-center rounded-sm text-[10px] font-bold text-emerald-800 uppercase">
 ⚡ Thống kê sản lượng thực tế hôm nay và 6 ngày trước của khâu đóng gói hoàn chỉnh
 </div>
 </div>
 </div>

 {/* TIẾN ĐỘ DỰ ÁN SẮP XẾP TỪ CAO ĐẾN THẤP */}
 <div className="grid grid-cols-1 gap-6">
 {/* Bảng Tiến độ các dự án nội thất */}
 <div className="bg-white border border-slate-100 rounded-lg p-6 shadow-sm space-y-4">
 <div className="flex items-center justify-between">
 <div>
 <h3 className="text-xs font-black text-slate-800 uppercase tracking-widest flex items-center gap-1.5">
 <ListOrdered size={15} className="text-indigo-600" />
 Tiến Độ Dự Án (Tiến độ cao xuôi thấp)
 </h3>
 <p className="text-[10px] text-slate-400 font-bold uppercase mt-0.5">
 Xếp hạng các dự án theo độ hoàn thiện Đóng gói đạt chuẩn để giao vận
 </p>
 </div>
 <span className="text-[10px] font-black text-indigo-600 bg-indigo-100 px-2 py-1 rounded-sm uppercase tracking-wider block">
 {projectProgressTable.length} dự án
 </span>
 </div>

 <div className="overflow-x-auto min-w-full">
 <table className="min-w-full text-xs font-sans">
 <thead>
 <tr className="bg-slate-100 text-slate-500 border-b border-slate-100 text-left uppercase text-[10px] font-black tracking-wider">
 <th className="p-3">Mã DA</th>
 <th className="p-3">Tên Dự Án</th>
 <th className="p-3 text-center">Mộc</th>
 <th className="p-3 text-center">Sơn</th>
 <th className="p-3 text-center">Ráp</th>
 <th className="p-3 text-center">Gói</th>
 <th className="p-3 text-center">Tiến Độ</th>
 </tr>
 </thead>
 <tbody className="divide-y divide-slate-100 font-semibold text-slate-700">
 {projectProgressTable.map((proj, idx) => (
 <tr key={proj.code} className="hover:bg-slate-100/50 transition-colors">
 <td className="p-3 whitespace-nowrap">
 <div className="flex items-center gap-1.5">
 <span className="text-[9px] font-black bg-slate-200 text-slate-600 w-3.5 h-3.5 flex items-center justify-center rounded-full leading-none">
 {idx + 1}
 </span>
 <span className="bg-slate-100 text-slate-700 px-2 py-0.5 rounded-sm font-black text-[10px] uppercase">
 {proj.code}
 </span>
 </div>
 </td>
 <td className="p-3 font-bold truncate max-w-[150px]" title={proj.name}>
 {proj.name}
 </td>
 <td className="p-3 text-center whitespace-nowrap">
 <div className="flex flex-col items-center gap-1">
 <span className="text-[11px] font-bold text-indigo-700">{proj.whitePct}%</span>
 <div className="w-12 bg-slate-100 h-1.5 rounded-sm">
 <div className="bg-indigo-500 h-full rounded-sm" style={{ width: `${proj.whitePct}%` }} />
 </div>
 </div>
 </td>
 <td className="p-3 text-center whitespace-nowrap">
 <div className="flex flex-col items-center gap-1">
 <span className="text-[11px] font-bold text-cyan-655">{proj.paintPct}%</span>
 <div className="w-12 bg-slate-100 h-1.5 rounded-sm">
 <div className="bg-cyan-500 h-full rounded-sm" style={{ width: `${proj.paintPct}%` }} />
 </div>
 </div>
 </td>
 <td className="p-3 text-center whitespace-nowrap">
 <div className="flex flex-col items-center gap-1">
 <span className="text-[11px] font-bold text-purple-700">{proj.finishPct}%</span>
 <div className="w-12 bg-slate-100 h-1.5 rounded-sm">
 <div className="bg-purple-500 h-full rounded-sm" style={{ width: `${proj.finishPct}%` }} />
 </div>
 </div>
 </td>
 <td className="p-3 text-center whitespace-nowrap">
 <div className="flex flex-col items-center gap-1">
 <span className="text-[11px] font-bold text-emerald-700">{proj.packPct}%</span>
 <div className="w-12 bg-slate-100 h-1.5 rounded-sm">
 <div className="bg-emerald-500 h-full rounded-sm" style={{ width: `${proj.packPct}%` }} />
 </div>
 </div>
 </td>
 <td className="p-3 text-center whitespace-nowrap">
 <span className={`px-2 py-1 rounded-sm text-[10px] font-black uppercase ${
 proj.overallPct === 100 
 ? 'bg-emerald-100 text-emerald-700' 
 : proj.overallPct > 55 
 ? 'bg-blue-100 text-blue-600' 
 : 'bg-amber-100 text-amber-605'
 }`}>
 {proj.overallPct}% DONE ({proj.total}M)
 </span>
 </td>
 </tr>
 ))}
 {projectProgressTable.length === 0 && (
 <tr>
 <td colSpan={7} className="p-6 text-center text-slate-400 uppercase text-[10px] font-bold tracking-wider">
 Chưa có dữ liệu dự án hợp lệ
 </td>
 </tr>
 )}
 </tbody>
 </table>
 </div>
 </div>
 </div>

 {/* QC Tickets và các phản ánh lỗi từ hệ thống */}
 <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
 {/* Danh sách Phiếu QC Đột Xuất và Công Việc */}
 <div className="bg-white border border-slate-100 rounded-lg p-6 shadow-sm col-span-2 space-y-4">
 <div>
 <h3 className="text-xs font-black text-slate-800 uppercase tracking-widest">Tiến Độ Phiếu QC Đang Chờ</h3>
 <p className="text-[10px] text-slate-405 font-bold uppercase mt-0.5">Trạng thái các phiếu kiểm QC công xưởng đang chờ xử lý</p>
 </div>

 <div className="space-y-2.5">
 {qcTickets.filter(t => t.status !== 'completed').slice(0, 5).map((ticket) => {
 const totalM = ticket.modules?.length || 0;
 const completedM = ticket.modules?.filter((m: any) => m.status === 'pass' || m.status === 'fail').length || 0;
 const pct = totalM > 0 ? Math.round((completedM / totalM) * 100) : 0;
 
 const stageLabels: { [key: string]: string } = {
 white: 'MỘC',
 paint: 'SƠN',
 finish: 'LẮP RÁP',
 pack: 'ĐÔNG GÓI'
 };

 return (
 <div key={ticket.id} className="flex items-center justify-between p-3 bg-slate-100/50 rounded-lg border border-slate-100 font-sans">
 <div className="flex flex-col gap-1 pr-4 min-w-0">
 <span className="text-[11px] font-black text-slate-800 uppercase truncate">
 {ticket.name}
 </span>
 <div className="flex flex-wrap items-center gap-2 text-[10px] text-slate-404 font-bold uppercase">
 <span>Dự án: <span className="text-slate-600">{ticket.projectCode}</span></span>
 <span>•</span>
 <span>Khâu: <span className="text-indigo-600 font-extrabold">{stageLabels[ticket.stage] || ticket.stage}</span></span>
 </div>
 </div>

 <div className="flex items-center gap-4 shrink-0">
 <div className="flex flex-col items-end gap-1">
 <span className="text-[10px] font-black text-slate-500 uppercase font-bold text-[9px]">TIẾN ĐỘ: {completedM}/{totalM} M</span>
 <div className="w-24 bg-slate-200 h-1.5 rounded-sm overflow-hidden">
 <div className="bg-indigo-500 h-full" style={{ width: `${pct}%` }} />
 </div>
 </div>
 <span className="bg-amber-100 text-amber-700 px-2.5 py-1 rounded-sm text-[10px] font-black uppercase tracking-wider">
 ĐANG KIỂM
 </span>
 </div>
 </div>
 );
 })}
 {qcTickets.filter(t => t.status !== 'completed').length === 0 && (
 <div className="py-8 text-center text-slate-400 uppercase text-[10px] font-bold tracking-wider bg-slate-100/30 rounded-lg border border-dashed border-slate-200">
 Tuyệt vời! Không có phiếu QC nào đang tồn đọng dở dang
 </div>
 )}
 </div>
 </div>

 {/* Khảo soát Lỗi QC & Sản xuất lỗi */}
 <div className="bg-white border border-slate-100 rounded-lg p-6 shadow-sm flex flex-col space-y-4">
 <div>
 <h3 className="text-xs font-black text-rose-600 uppercase tracking-widest flex items-center gap-1.5">
 <AlertTriangle size={15} /> Khắc Phục Lỗi Nội Thất dở dang
 </h3>
 <p className="text-[10px] text-slate-404 font-bold uppercase mt-0.5">Số lượng cấu kiện lỗi phát sinh dở dang chưa hoàn thiện</p>
 </div>

 <div className="flex-1 space-y-4 font-sans">
 <div className="grid grid-cols-2 gap-3">
 <div className="bg-rose-100/40 p-3 rounded-lg border border-rose-100 text-center">
 <p className="text-[10px] font-black text-rose-500 uppercase tracking-wider">QC Mộc Lỗi</p>
 <h4 className="text-2xl font-black text-rose-600 mt-1">{stats.white.fail}</h4>
 </div>
 <div className="bg-rose-100/40 p-3 rounded-lg border border-rose-100 text-center">
 <p className="text-[10px] font-black text-rose-500 uppercase tracking-wider">QC Sơn Lỗi</p>
 <h4 className="text-2xl font-black text-rose-600 mt-1">{stats.paint.fail}</h4>
 </div>
 <div className="bg-rose-100/40 p-3 rounded-lg border border-rose-100 text-center">
 <p className="text-[10px] font-black text-rose-500 uppercase tracking-wider">QC Ráp Lỗi</p>
 <h4 className="text-2xl font-black text-rose-600 mt-1">{stats.finish.fail}</h4>
 </div>
 <div className="bg-rose-100/40 p-3 rounded-lg border border-rose-100 text-center">
 <p className="text-[10px] font-black text-rose-500 uppercase tracking-wider">QC Gói Lỗi</p>
 <h4 className="text-2xl font-black text-rose-600 mt-1">{stats.pack.fail}</h4>
 </div>
 </div>

 <div className="bg-slate-100/55 p-3.5 rounded-lg border border-slate-200 leading-relaxed text-slate-550 font-medium text-[11px]">
 📌 <span className="font-bold text-slate-700">Khảo sát nội bộ:</span> Các cấu kiện đánh dấu <span className="text-rose-500 font-bold">LỖI</span> cần sửa chữa xong và cập nhật đạt QC hoặc đóng phiếu kiểm thì mới có thể bắt đầu đóng gói / giao vận. Hãy phối hợp tổ sơn và mộc để hoàn thiện hàng đầu ra xuất xưởng đúng hạn định.
 </div>
 </div>
 </div>
 </div>

 {/* MODAL CHI TIẾT DANH SÁCH INSTANCES ĐẠT/LỖI THEO KHÂU */}
 {selectedStage && (() => {
 const rawInstances = getStageInstances(selectedStage, activeSegmentTab);
 
 // Lọc theo search query và tab bộ lọc (all / pass / fail)
 const filteredInstances = rawInstances.filter(inst => {
 const matchTab = instanceFilter === 'all' ? true : (inst.status === instanceFilter);
 
 const q = modalSearchQuery.toLowerCase().trim();
 if (!q) return matchTab;

 const matchSearch = 
 inst.instanceId.toLowerCase().includes(q) ||
 inst.moduleCode.toLowerCase().includes(q) ||
 inst.name.toLowerCase().includes(q) ||
 inst.projectCode.toLowerCase().includes(q) ||
 inst.projectName.toLowerCase().includes(q) ||
 inst.by.toLowerCase().includes(q);

 return matchTab && matchSearch;
 });

 const segmentLabels = {
 today: 'Hôm Nay',
 week: 'Tuần Này',
 month: 'Tháng Này'
 };

 const totalSelected = filteredInstances.length;
 const passCount = rawInstances.filter(i => i.status === 'pass').length;
 const failCount = rawInstances.filter(i => i.status === 'fail').length;

 return (
 <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center z-100 p-4 animate-fade-in animate-duration-200">
 <div className="bg-white rounded-lg border border-slate-100 w-full max-w-4xl max-h-[85vh] flex flex-col shadow-xl">
 
 {/* Modal Header */}
 <div className="flex items-center justify-between p-4 border-b border-slate-100 bg-slate-100/70">
 <div className="flex items-center gap-2">
 <div className="p-1.5 bg-indigo-100 border border-indigo-100 rounded-sm text-indigo-600">
 <ClipboardCheck size={16} />
 </div>
 <div>
 <h3 className="text-sm font-black text-slate-800 uppercase tracking-tight">
 Chi Tiết Kiểm Định Khâu: {selectedStageLabel} ({segmentLabels[activeSegmentTab]})
 </h3>
 <p className="text-[10px] text-slate-404 font-bold uppercase mt-0.5">
 Danh sách nguồn {rawInstances.length} cấu kiện được kiểm nhân công
 </p>
 </div>
 </div>
 <button 
 onClick={() => setSelectedStage(null)}
 className="p-1 px-2 text-slate-404 hover:text-slate-800 font-extrabold uppercase rounded-sm border border-slate-200 hover:bg-slate-200 transition-colors text-xs font-sans"
 >
 Đóng
 </button>
 </div>

 {/* Modal Controls (Search & Filters) */}
 <div className="p-4 border-b border-slate-100 flex flex-col md:flex-row gap-4 items-center justify-between text-xs font-sans">
 {/* Search */}
 <div className="relative w-full md:w-80">
 <input
 type="text"
 placeholder="Tìm mã, cấu kiện, dự án, người quét..."
 value={modalSearchQuery}
 onChange={(e) => setModalSearchQuery(e.target.value)}
 className="w-full bg-slate-100 border border-slate-200 focus:bg-white text-slate-700 p-2 px-3 rounded-sm outline-none focus:border-indigo-500 font-medium"
 />
 </div>

 {/* Filter Tabs & Badges */}
 <div className="flex flex-wrap items-center gap-2">
 <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Hiển thị:</span>
 <div className="flex bg-slate-200/60 p-0.5 rounded-sm">
 <button
 onClick={() => setInstanceFilter('all')}
 className={`px-3 py-1 text-[10px] font-black uppercase rounded-sm transition-all ${
 instanceFilter === 'all' 
 ? 'bg-white text-slate-800 shadow-xs' 
 : 'text-slate-550 hover:text-slate-700'
 }`}
 >
 Tất Cả ({rawInstances.length})
 </button>
 <button
 onClick={() => setInstanceFilter('pass')}
 className={`px-3 py-1 text-[10px] font-black uppercase rounded-sm transition-all ${
 instanceFilter === 'pass' 
 ? 'bg-white text-emerald-600 shadow-xs' 
 : 'text-slate-550 hover:text-emerald-700'
 }`}
 >
 Đạt ({passCount})
 </button>
 <button
 onClick={() => setInstanceFilter('fail')}
 className={`px-3 py-1 text-[10px] font-black uppercase rounded-sm transition-all ${
 instanceFilter === 'fail' 
 ? 'bg-white text-rose-600 shadow-xs' 
 : 'text-slate-550 hover:text-rose-700'
 }`}
 >
 Lỗi ({failCount})
 </button>
 </div>
 </div>
 </div>

 {/* Modal Table / List */}
 <div className="flex-1 overflow-y-auto p-4">
 <div className="overflow-x-auto min-w-full">
 <table className="min-w-full text-xs font-sans text-left border-collapse">
 <thead>
 <tr className="bg-slate-100 border-b border-slate-100 text-[10px] font-black text-slate-400 uppercase tracking-wider">
 <th className="p-2.5">Dự Án</th>
 <th className="p-2.5">Cấu Kiện</th>
 <th className="p-2.5">Mã Kiện / ID</th>
 <th className="p-2.5 text-center">Kết Quả</th>
 <th className="p-2.5">Người Quét</th>
 <th className="p-2.5">Thời Gian</th>
 </tr>
 </thead>
 <tbody className="divide-y divide-slate-100 font-semibold text-slate-700">
 {filteredInstances.map((inst) => {
 const isExpanded = selectedDetailInstance?.id === inst.id && selectedDetailInstance?.status === inst.status;
 const dateStr = inst.date ? `${inst.date.getHours().toString().padStart(2, '0')}:${inst.date.getMinutes().toString().padStart(2, '0')} ${inst.date.getDate()}/${inst.date.getMonth() + 1}` : 'Chưa rõ';

 return (
 <React.Fragment key={`${inst.id}-${inst.status}`}>
 <tr 
 onClick={() => setSelectedDetailInstance(isExpanded ? null : inst)}
 className="hover:bg-slate-100/70 border-b border-slate-100 transition-colors cursor-pointer"
 >
 <td className="p-2.5 whitespace-nowrap">
 <span className="bg-slate-100 text-slate-700 px-1.5 py-0.5 rounded-sm font-black text-[9px] uppercase">
 {inst.projectCode}
 </span>
 </td>
 <td className="p-2.5 font-bold truncate max-w-[150px]" title={inst.name}>
 {inst.name}
 </td>
 <td className="p-2.5 truncate font-mono text-[11px] font-bold text-slate-500">
 {inst.instanceId}
 </td>
 <td className="p-2.5 text-center whitespace-nowrap">
 <span className={`inline-block px-1.5 py-0.5 rounded-sm text-[9px] font-black uppercase ${
 inst.status === 'pass' 
 ? 'bg-emerald-100 text-emerald-700' 
 : 'bg-rose-100 text-rose-700'
 }`}>
 {inst.status === 'pass' ? 'ĐẠT' : 'LỖI'}
 </span>
 </td>
 <td className="p-2.5 whitespace-nowrap font-medium text-slate-500">
 {inst.by}
 </td>
 <td className="p-2.5 whitespace-nowrap text-[10px] font-mono text-slate-400">
 {dateStr}
 </td>
 </tr>

 {/* Panel Chi Tiết Logs (Slide-down if expanded) */}
 {isExpanded && (
 <tr className="bg-slate-100/40">
 <td colSpan={6} className="p-3 bg-slate-100 border-t border-slate-100">
 <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs font-sans leading-relaxed text-slate-600 p-1.5">
 <div className="space-y-1 bg-white p-3 border border-slate-100 rounded-sm shadow-xs">
 <p className="text-[10px] font-black uppercase text-slate-400">Thông tin bổ sung</p>
 <p><span className="font-bold">Mã sản phẩm:</span> <span className="font-mono text-slate-700">{inst.moduleCode}</span></p>
 <p><span className="font-bold">Tên đầy đủ:</span> <span className="text-slate-700">{inst.name}</span></p>
 <p><span className="font-bold">Dự án:</span> <span className="font-bold text-slate-700">{inst.projectName || inst.projectCode}</span></p>
 {inst.qty > 1 && <p><span className="font-bold">Số lượng trong cụm (BO):</span> <span className="text-slate-800 font-bold">{inst.qty}</span></p>}
 {inst.notes && <p><span className="font-bold">Ghi chú khâu:</span> <span className="text-slate-700 italic bg-amber-100 px-1 py-0.5 border border-amber-100 rounded-sm">"{inst.notes}"</span></p>}
 </div>

 <div className="space-y-1.5 bg-white p-3 border border-slate-100 rounded-sm shadow-xs">
 <p className="text-[10px] font-black uppercase text-slate-400">Ảnh kiểm tra đính kèm ({inst.photos?.length || 0})</p>
 {inst.photos && inst.photos.length > 0 ? (
 <div className="grid grid-cols-3 gap-2 pt-1">
 {inst.photos.map((url: string, pIdx: number) => (
 <a key={pIdx} href={url} target="_blank" rel="referrer" className="relative block h-14 border border-slate-200 rounded-sm overflow-hidden hover:opacity-85 transition-opacity">
 <img src={url} alt="QC" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
 </a>
 ))}
 </div>
 ) : (
 <p className="text-[10px] font-bold text-slate-400 uppercase italic pt-1">Không có hình ảnh đính kèm cho cấu kiện này</p>
 )}
 </div>
 </div>
 </td>
 </tr>
 )}
 </React.Fragment>
 );
 })}
 {filteredInstances.length === 0 && (
 <tr>
 <td colSpan={6} className="p-8 text-center text-slate-400 uppercase text-[10px] font-bold tracking-widest leading-none">
 Không tìm thấy dữ liệu kiểm định phù hợp
 </td>
 </tr>
 )}
 </tbody>
 </table>
 </div>
 </div>

 {/* Modal Footer */}
 <div className="p-3 border-t border-slate-100 bg-slate-100 flex items-center justify-between font-sans">
 <span className="text-[10px] font-black text-slate-400 uppercase">
 Đang hiển thị {totalSelected}/{rawInstances.length} cấu kiện
 </span>
 <button
 onClick={() => setSelectedStage(null)}
 className="bg-indigo-600 hover:bg-indigo-700 text-white font-black uppercase text-[10px] px-3.5 py-2 rounded-sm active:scale-95 transition-all shadow-sm"
 >
 Xác nhận đóng màn hình đối chiếu
 </button>
 </div>

 </div>
 </div>
 );
 })()}

 {/* MODAL CHI TIẾT DANH SÁCH CẤU KIỆN ĐANG CẦN QC */}
 {showNeededQcModal && (() => {
 const filteredNeededQc = neededQcItems.filter(item => {
 // Lọc theo khâu
 const matchesStage = qcStageFilter === 'all' ? true : item.stage === qcStageFilter;
 
 // Lọc theo từ khóa
 const q = qcModalSearchQuery.toLowerCase().trim();
 if (!q) return matchesStage;
 
 return matchesStage && (
 item.moduleCode.toLowerCase().includes(q) ||
 item.moduleName.toLowerCase().includes(q) ||
 (item.instanceId && item.instanceId.toLowerCase().includes(q)) ||
 item.projectCode.toLowerCase().includes(q) ||
 item.projectName.toLowerCase().includes(q)
 );
 });

 const stageTranslations = {
 white: 'Mộc thô',
 paint: 'Sơn',
 finish: 'Ráp (Finish)',
 pack: 'Đóng gói'
 };

 return (
 <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center z-100 p-4 animate-fade-in animate-duration-200">
 <div className="bg-white rounded-lg border border-slate-100 w-full max-w-4xl max-h-[85vh] flex flex-col shadow-xl">
 
 {/* Modal Header */}
 <div className="flex items-center justify-between p-4 border-b border-slate-100 bg-slate-100/70">
 <div className="flex items-center gap-2">
 <div className="p-1.5 bg-cyan-100 border border-cyan-100 rounded-lg text-cyan-600">
 <Clock size={16} />
 </div>
 <div>
 <h3 className="text-sm font-black text-slate-800 uppercase tracking-tight">
 Danh Sách Cấu Kiện Chờ Kiểm Tra (QC)
 </h3>
 <p className="text-[10px] text-slate-400 font-bold uppercase mt-0.5">
 Tổng số: {neededQcItems.length} cấu kiện đang ở trạng thái chờ duyệt (Pending)
 </p>
 </div>
 </div>
 <button 
 onClick={() => {
 setShowNeededQcModal(false);
 setQcModalSearchQuery('');
 setQcStageFilter('all');
 }}
 className="p-1 px-2 text-slate-400 hover:text-slate-800 font-extrabold uppercase rounded-lg border border-slate-200 hover:bg-slate-100 transition-colors text-xs font-sans cursor-pointer"
 >
 Đóng
 </button>
 </div>

 {/* Modal Controls (Search & Filters) */}
 <div className="p-4 border-b border-slate-100 flex flex-col md:flex-row gap-4 items-center justify-between text-xs font-sans">
 {/* Search */}
 <div className="relative w-full md:w-80">
 <input
 type="text"
 placeholder="Tìm mã cấu kiện, tên cấu kiện, dự án..."
 value={qcModalSearchQuery}
 onChange={(e) => setQcModalSearchQuery(e.target.value)}
 className="w-full bg-slate-100 border border-slate-200 focus:bg-white text-slate-705 p-2 px-3 rounded-lg outline-none focus:border-indigo-500 font-medium text-xs font-sans"
 />
 </div>

 {/* Filter Tabs by Stage */}
 <div className="flex flex-wrap items-center gap-2">
 <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest font-sans">Khâu:</span>
 <div className="flex bg-slate-200/60 p-0.5 rounded-lg font-sans">
 <button
 onClick={() => setQcStageFilter('all')}
 className={`px-3 py-1 text-[10px] font-black uppercase rounded-lg transition-all cursor-pointer ${
 qcStageFilter === 'all' 
 ? 'bg-white text-slate-900 shadow-xs' 
 : 'text-slate-550 hover:text-slate-700'
 }`}
 >
 Tất Cả ({neededQcItems.length})
 </button>
 {(['white', 'paint', 'finish', 'pack'] as const).map((stg) => {
 const count = neededQcItems.filter(i => i.stage === stg).length;
 return (
 <button
 key={stg}
 onClick={() => setQcStageFilter(stg)}
 className={`px-3 py-1 text-[10px] font-black uppercase rounded-lg transition-all cursor-pointer ${
 qcStageFilter === stg 
 ? 'bg-indigo-600 text-white shadow-xs' 
 : 'text-slate-550 hover:text-slate-700'
 }`}
 >
 {stg === 'white' ? 'Mộc' : stg === 'paint' ? 'Sơn' : stg === 'finish' ? 'Ráp' : 'Gói'} ({count})
 </button>
 );
 })}
 </div>
 </div>
 </div>

 {/* Modal Table / List */}
 <div className="flex-1 overflow-y-auto p-4">
 <div className="overflow-x-auto min-w-full">
 <table className="min-w-full text-xs font-sans text-left border-collapse">
 <thead>
 <tr className="bg-slate-100 border-b border-slate-100 text-[10px] font-black text-slate-404 uppercase tracking-wider">
 <th className="p-2.5">Dự Án</th>
 <th className="p-2.5">Mã Sản Phẩm / ID</th>
 <th className="p-2.5">Cấu Kiện</th>
 <th className="p-2.5 text-center">Công Đoạn</th>
 <th className="p-2.5 text-center">Trạng Thái QC</th>
 <th className="p-2.5">Người Kiểm</th>
 <th className="p-2.5">Ghi Chú Lỗi</th>
 </tr>
 </thead>
 <tbody className="divide-y divide-slate-100 font-semibold text-slate-700 uppercase">
 {filteredNeededQc.map((item, index) => {
 return (
 <tr key={`${item.id}-${index}`} className="hover:bg-slate-100/70 border-b border-slate-100 transition-colors">
 <td className="p-2.5 whitespace-nowrap">
 <span className="bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded-lg font-black text-[9px] uppercase">
 {item.projectCode}
 </span>
 </td>
 <td className="p-2.5 font-mono text-[11px] font-bold text-slate-500 whitespace-nowrap">
 {item.instanceId || item.moduleCode}
 </td>
 <td className="p-2.5 font-bold max-w-[150px] truncate" title={item.moduleName}>
 {item.moduleName}
 </td>
 <td className="p-2.5 text-center whitespace-nowrap">
 <span className="px-2 py-0.5 bg-slate-100 text-slate-600 rounded-lg text-[10px] font-black">
 {stageTranslations[item.stage]}
 </span>
 </td>
 <td className="p-2.5 text-center whitespace-nowrap">
 <span className={`inline-block px-1.5 py-0.5 rounded-lg text-[9px] font-black uppercase ${
 item.status === 'pending'
 ? 'bg-amber-100 text-amber-700 border border-amber-200' 
 : 'bg-rose-100 text-rose-700 border border-rose-200'
 }`}>
 {item.status === 'pending' ? 'CHỜ DUYỆT' : 'QC LỖI'}
 </span>
 </td>
 <td className="p-2.5 whitespace-nowrap font-medium text-slate-500 normal-case">
 {item.by || 'Chưa rà soát'}
 </td>
 <td className="p-2.5 text-[10.5px] text-slate-400 italic normal-case max-w-[200px] truncate" title={item.notes}>
 {item.notes || 'Không ghi nhận'}
 </td>
 </tr>
 );
 })}
 {filteredNeededQc.length === 0 && (
 <tr>
 <td colSpan={7} className="p-8 text-center text-slate-404 uppercase text-[10px] font-bold tracking-widest leading-none">
 Không tìm thấy cấu kiện cần QC phù hợp với tiêu chí lọc
 </td>
 </tr>
 )}
 </tbody>
 </table>
 </div>
 </div>

 {/* Modal Footer */}
 <div className="p-3 border-t border-slate-100 bg-slate-100 flex items-center justify-between font-sans">
 <span className="text-[10px] font-black text-slate-400 uppercase">
 Đang hiển thị {filteredNeededQc.length}/{neededQcItems.length} cấu kiện
 </span>
 <button
 onClick={() => {
 setShowNeededQcModal(false);
 setQcModalSearchQuery('');
 setQcStageFilter('all');
 }}
 className="bg-indigo-600 hover:bg-indigo-700 text-white font-black uppercase text-[10px] px-3.5 py-2 rounded-lg active:scale-95 transition-all shadow-sm cursor-pointer"
 >
 Xác nhận đóng
 </button>
 </div>

 </div>
 </div>
 );
 })()}
 </div>
 );
}
