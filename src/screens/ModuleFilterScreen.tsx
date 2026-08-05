/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useMemo, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { 
 collection, doc, onSnapshot, query, setDoc, deleteDoc, orderBy, serverTimestamp, writeBatch 
} from 'firebase/firestore';
import { db, cleanUndefinedFields, handleFirestoreError, OperationType } from '../lib/firebase';
import { motion } from 'motion/react';
import {
 SlidersHorizontal, Search, RefreshCw, FileSymlink, Sparkles, HelpCircle, LayoutGrid, Info, Tag, Printer, Trash2, X
} from 'lucide-react';
import QRCode from 'qrcode';
import { ProjectEntry, matchSearchQuery, getModuleInstances, ModuleInstance, getModuleQcAggregate } from '../types';
import { formatProjectCode } from '../lib/formatters';
import { buildAndSortTree } from './ProjectManagementScreen';
import { getEntryType } from '../components/project/TempLabelsModal';
import data from '../../data.json';

interface ModuleFilterScreenProps {
 projectEntries: ProjectEntry[];
}

export function ModuleFilterScreen({ projectEntries }: ModuleFilterScreenProps) {
 // Mapping of module.id to its 1-based sequential temporary label range/number within its system
 const moduleTempLabelSeqMap = useMemo(() => {
 const groups = new Map<string, ProjectEntry[]>();
 projectEntries.forEach(entry => {
 if (entry.projectCode) {
 if (!groups.has(entry.projectCode)) {
 groups.set(entry.projectCode, []);
 }
 groups.get(entry.projectCode)!.push(entry);
 }
 });

 const isThungTemplate = (m: ProjectEntry) => {
 const type = getEntryType(m);
 const isThung = type === 'Thùng';
 const hasDot = m.moduleCode?.toLowerCase().includes('đợt') || m.moduleCode?.toLowerCase().includes('dot');
 return isThung && !hasDot;
 };

 const isCanhTemplate = (m: ProjectEntry) => {
 const type = getEntryType(m);
 const isTargetType = type === 'Cánh' || type === 'Mặt HK' || type === 'CTHT';
 if (!isTargetType) return false;

 // Nếu đã được phân loại rõ ràng qua trường classification (ví dụ import Excel gán trực tiếp) thì chấp nhận luôn
 if (m.classification === 'Cánh' || m.classification === 'Mặt HK' || m.classification === 'CTHT') {
 return true;
 }

 const code = m.moduleCode || '';
 const codeLower = code.toLowerCase();
 const keywords = ['cánh', 'canh', 'cửa', 'cua', 'mặt', 'mat', 'hoàn thiện', 'hoan thien'];
 return keywords.some(keyword => codeLower.includes(keyword));
 };

 const seqMap = new Map<string, { system: 'T' | 'C'; seq: string }>();
 groups.forEach((groupEntries) => {
 // Sắp xếp các entry theo sortIndex tăng dần y chang rawEntries trong ProjectManagementScreen để đồng bộ hoàn toàn
 const sortedGroupEntries = [...groupEntries].sort((a, b) => (a.sortIndex || 0) - (b.sortIndex || 0));
 const sorted = buildAndSortTree(sortedGroupEntries);

 // Thùng modules
 const thungModules = sorted.filter(isThungTemplate);
 let thungLabelCount = 0;
 thungModules.forEach(m => {
 const qty = typeof m.quantity === 'number' ? m.quantity : parseInt(m.quantity as any, 10);
 const count = qty > 1 ? qty : 1;
 const startSeq = thungLabelCount + 1;
 const endSeq = thungLabelCount + count;
 thungLabelCount += count;

 const seqStr = count > 1 ? `${startSeq}-${endSeq}` : `${startSeq}`;
 seqMap.set(m.id, { system: 'T', seq: seqStr });
 });

 // Cánh/Mặt/CTHT modules
 const canhModules = sorted.filter(isCanhTemplate);
 let canhLabelCount = 0;
 canhModules.forEach(m => {
 const qty = typeof m.quantity === 'number' ? m.quantity : parseInt(m.quantity as any, 10);
 const count = qty > 1 ? qty : 1;
 const startSeq = canhLabelCount + 1;
 const endSeq = canhLabelCount + count;
 canhLabelCount += count;

 const seqStr = count > 1 ? `${startSeq}-${endSeq}` : `${startSeq}`;
 seqMap.set(m.id, { system: 'C', seq: seqStr });
 });
 });

 return seqMap;
 }, [projectEntries]);

 // Filter States
 const [selectedProjectCode, setSelectedProjectCode] = useState<string>('');
 const [selectedType, setSelectedType] = useState<string>('');
 const [targetLength, setTargetLength] = useState<string>('');
 const [targetDepth, setTargetDepth] = useState<string>('');
 const [targetHeight, setTargetHeight] = useState<string>('18');
 const [searchPartName, setSearchPartName] = useState<string>('');
 const [isDeepFilter, setIsDeepFilter] = useState(false);

 // Saved labels state synced with Firestore in real-time
 const [savedLabels, setSavedLabels] = useState<any[]>([]);

 useEffect(() => {
 const q = query(collection(db, 'saved_labels'), orderBy('createdAt', 'asc'));
 const unsubscribe = onSnapshot(q, (snapshot) => {
 const labels: any[] = [];
 snapshot.forEach((doc) => {
 labels.push({
 id: doc.id,
 ...doc.data()
 });
 });
 setSavedLabels(labels);
 }, (error) => {
 console.error('Lỗi khi tải real-time danh sách tem đã lưu:', error);
 });
 return () => unsubscribe();
 }, []);
 const [printingLabels, setPrintingLabels] = useState<any[]>([]);

 // Function to create high quality label PNG matching the standard format from TempLabelsModal
 const generateLabelDataUrl = async (module: any, labelInfo: any, totalQuantity: number, sttValue: string, idx: number, prjDisplay: string, prjName: string) => {
 const canvas = document.createElement('canvas');
 canvas.width = 600;
 canvas.height = 400;
 const ctx = canvas.getContext('2d');
 if (!ctx) return '';

 // 1. Clear background
 ctx.fillStyle = '#FFFFFF';
 ctx.fillRect(0, 0, 600, 400);

 // 2. Center split line
 ctx.strokeStyle = '#000500';
 ctx.lineWidth = 3;
 ctx.beginPath();
 ctx.moveTo(245, 10);
 ctx.lineTo(245, 390);
 ctx.stroke();

 const printableCode = module.moduleCode || '';
 const classification = getEntryType(module);

 // 3. Draw QR Code
 try {
 const insts = getModuleInstances(module);
 const targetInst = insts[idx - 1] || insts[0];
 const qrContent = module.moduleType === 'bo'
 ? (module.moduleCode || '')
 : (targetInst ? targetInst.id : `${module.moduleCode || 'TEMP'}|${idx}`);

 const qrDataUrl = await QRCode.toDataURL(qrContent, {
 version: 5,
 errorCorrectionLevel: 'M',
 margin: 4,
 width: 320,
 color: { dark: '#000000', light: '#FFFFFF' }
 });

 const qrImg = new Image();
 qrImg.src = qrDataUrl;
 await new Promise((resolve) => {
 qrImg.onload = resolve;
 qrImg.onerror = resolve;
 });

 ctx.drawImage(qrImg, 18, 75, 210, 210);

 ctx.fillStyle = '#000000';
 ctx.font = 'bold 12px "Inter", sans-serif';
 ctx.textAlign = 'center';
 ctx.fillText(module.moduleType === 'bo' ? 'QUÉT MÃ QR CẢ BỘ' : 'QUÉT MÃ QR CẤU KIỆN', 123, 50);

 ctx.font = 'bold 11px "Inter", sans-serif';
 ctx.fillText(printableCode, 123, 310);
 } catch (err) {
 console.error('Failed to generate printer QR code:', err);
 }

 // 4. Right panel text labels
 ctx.textAlign = 'left';
 ctx.fillStyle = '#000000';

 // Project Name
 ctx.font = 'bold 12px "Inter", sans-serif';
 ctx.fillText('DỰ ÁN / PROJECT:', 260, 40);
 ctx.font = '900 24px "Inter", sans-serif';
 const displayProjName = prjName.substring(0, 22) + (prjName.length > 22 ? '..' : '');
 ctx.fillText(displayProjName, 260, 70);

 // Area cluster
 ctx.font = 'bold 12px "Inter", sans-serif';
 ctx.fillText('CỤM / AREA CLUSTER:', 260, 100);
 ctx.font = '900 24px "Inter", sans-serif';
 const displayCluster = (module.cluster || 'CHƯA PHÂN CỤM').substring(0, 22);
 ctx.fillText(displayCluster, 260, 130);

 // Module Code
 ctx.font = 'bold 12px "Inter", sans-serif';
 ctx.fillText(`MÃ CẤU KIỆN (${classification.toUpperCase()}):`, 260, 160);

 function wrapText(context: any, text: string, x: number, y: number, maxWidth: number, lineHeight: number) {
 const words = text.split(' ');
 const lines = [];
 let line = '';

 for (let i = 0; i < words.length; i++) {
 const testLine = line ? line + ' ' + words[i] : words[i];
 const metrics = context.measureText(testLine);

 if (metrics.width > maxWidth && line) {
 lines.push(line);
 line = words[i];
 } else {
 line = testLine;
 }
 }
 lines.push(line);
 lines.forEach((l, index) => {
 context.fillText(l, x, y + index * lineHeight);
 });
 }

 if (printableCode.length > 15) {
 ctx.font = '900 28px "Inter", sans-serif';
 } else {
 ctx.font = '900 36px "Inter", sans-serif';
 }
 wrapText(ctx, printableCode, 260, 200, 310, 28);

 // Size dimensions: Ưu tiên kích thước tổng (width/depth/height/length), nếu không có mới lấy kích thước đóng gói (pWidth/pDepth/pHeight) và không để trống
 const isThung = classification === 'Thùng';
 ctx.font = 'bold 12px "Inter", sans-serif';
 ctx.fillText(isThung ? 'KÍCH THƯỚC (W x D x H):' : 'KÍCH THƯỚC (DÀI x RỘNG x DÀY):', 260, 265);

 ctx.font = 'bold 22px "Inter", sans-serif';
 const w = module.width || module.length || module.pWidth || '0';
 const d = module.depth || module.pDepth || '0';
 const h = module.height || module.pHeight || '0';
 ctx.fillText(`${w} x ${d} x ${h} mm`, 260, 295);

 // Quantity / PCS
 ctx.font = 'bold 12px "Inter", sans-serif';
 ctx.fillText('SỐ LƯỢNG / PCS:', 260, 335);

 ctx.font = '900 36px "Inter", sans-serif';
 if (module.moduleType === 'bo') {
 ctx.fillText(`${totalQuantity} BỘ (SET)`, 260, 375);
 } else if (totalQuantity > 1) {
 ctx.fillText(`${idx} / ${totalQuantity}`, 260, 375);
 } else {
 ctx.fillText(`${module.quantity || 1} CÁI (PCS)`, 260, 375);
 }

 // Temporary Stamp Sequence Number
 ctx.textAlign = 'right';
 ctx.font = 'bold 12px "Inter", sans-serif';
 ctx.fillText('STT TEM TẠM:', 580, 335);

 ctx.font = '900 32px "Inter", sans-serif';
 ctx.fillText(sttValue, 580, 370);

 // Copyright Brand Mark
 ctx.textAlign = 'right';
 ctx.font = 'bold 9px "Inter", sans-serif';
 ctx.fillText('DRACO D&B © 2026', 585, 385);

 return canvas.toDataURL('image/png');
 };

 // Handler for saving stamp
 const handleSaveLabel = async (item: any) => {
 const module = item.module;
 const labelInfo = moduleTempLabelSeqMap.get(module.id);
 
 let sttDisplay = '';
 if (module.moduleType === 'bo') {
 if (module.stt) sttDisplay = `${module.stt}`;
 } else {
 const insts = module.instances || [];
 const stts = insts.map((i: any) => i.stt).filter((s: any): s is number => typeof s === 'number').sort((a: any, b: any) => a - b);
 if (stts.length > 0) {
 sttDisplay = stts.length > 1 
 ? `${stts[0]} - ${stts[stts.length - 1]}`
 : `${stts[0]}`;
 }
 }

 if (!sttDisplay && labelInfo) {
 sttDisplay = `${labelInfo.system}#${labelInfo.seq}`;
 }
 if (!sttDisplay) {
 sttDisplay = 'N/A';
 }

 const prjCode = module.projectCode;
 const prjDisplay = formatProjectCode(prjCode);
 const prjName = module.projectName || 'Dự án không tên';
 const totalQty = typeof module.quantity === 'number' ? module.quantity : parseInt(module.quantity as any, 10) || 1;

 // Support sequential index cycling based on the current saved count for this module code
 const currentCount = savedLabels.filter(l => l.moduleId === module.id).length;
 const nextIdx = (currentCount % totalQty) + 1;

 const dataUrl = await generateLabelDataUrl(
 module,
 labelInfo,
 totalQty,
 sttDisplay,
 nextIdx,
 prjDisplay,
 prjName
 );

 const labelId = `${module.id}_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
 const newLabel = {
 id: labelId,
 moduleId: module.id,
 moduleCode: module.moduleCode,
 projectName: prjName,
 displayProject: prjDisplay,
 dimensions: item.dimensions,
 sttValue: sttDisplay,
 idx: nextIdx,
 totalQty,
 dataUrl,
 createdAt: serverTimestamp()
 };

 try {
 await setDoc(doc(db, 'saved_labels', labelId), cleanUndefinedFields(newLabel));
 } catch (error) {
 handleFirestoreError(error, OperationType.WRITE, `saved_labels/${labelId}`);
 }
 };

 // Handler to print single saved label and delete it
 const handlePrintSingleLabel = (label: any) => {
 setPrintingLabels([label]);
 setTimeout(async () => {
 window.print();
 try {
 await deleteDoc(doc(db, 'saved_labels', label.id));
 } catch (err) {
 console.error('Lỗi khi xóa nhãn đã in:', err);
 }
 setPrintingLabels([]);
 }, 180);
 };

 // Handler to print all labels and clear lists
 const handlePrintAllLabels = () => {
 if (savedLabels.length === 0) return;
 setPrintingLabels(savedLabels);
 setTimeout(async () => {
 window.print();
 try {
 const batch = writeBatch(db);
 savedLabels.forEach(lab => {
 batch.delete(doc(db, 'saved_labels', lab.id));
 });
 await batch.commit();
 } catch (err) {
 console.error('Lỗi khi xóa tất cả nhãn đã in:', err);
 }
 setPrintingLabels([]);
 }, 180);
 };

 const handleDeleteLabel = async (id: string) => {
 try {
 await deleteDoc(doc(db, 'saved_labels', id));
 } catch (err) {
 console.error('Lỗi khi xóa nhãn:', err);
 }
 };

 const handleClearAllSaved = async () => {
 try {
 const batch = writeBatch(db);
 savedLabels.forEach(lab => {
 batch.delete(doc(db, 'saved_labels', lab.id));
 });
 await batch.commit();
 } catch (err) {
 console.error('Lỗi khi xóa sạch danh sách nhãn:', err);
 }
 };

 // Extract unique projects
 const uniqueProjects = useMemo(() => {
 const projectMap = new Map<string, string>();
 projectEntries.forEach(p => {
 if (p.projectCode) {
 projectMap.set(p.projectCode, p.projectName || 'Dự án không tên');
 }
 });
 return Array.from(projectMap.entries()).map(([code, name]) => ({
 code,
 name
 }));
 }, [projectEntries]);

 // Extract unique classifications
 const uniqueTypes = useMemo(() => {
 const typesSet = new Set<string>();
 projectEntries.forEach(p => {
 if (p.classification) {
 typesSet.add(p.classification);
 }
 });
 return Array.from(typesSet);
 }, [projectEntries]);

 // Reset function
 const handleReset = () => {
 setSelectedProjectCode('');
 setSelectedType('');
 setTargetLength('');
 setTargetDepth('');
 setTargetHeight('18');
 setSearchPartName('');
 setIsDeepFilter(false);
 };

 // Main match calculations
 const matchedResults = useMemo(() => {
 const L = Number(targetLength);
 const S = Number(targetDepth);
 const H_target = Number(targetHeight);

 // Nếu không có cả kích thước lẫn tên cấu kiện cần tìm, thì không trả về kết quả nào
 if (!searchPartName && (!targetLength || !targetDepth || !targetHeight)) {
 return [];
 }

 let filtered: any[] = [];

 if (isDeepFilter) {
 // Khi bật Lọc Sâu, tra cứu từ data.json
 // Map data.json entries to a format compatible with the matching logic
 filtered = data.map(item => ({
 id: item.qr,
 moduleCode: item.qr,
 projectName: 'Dữ liệu Lọc Sâu',
 projectCode: 'DEEP_FILTER',
 classification: 'Lọc Sâu',
 width: item.width,
 height: item.height,
 depth: 0, // data.json only has width/height
 quantity: item.count,
 // Dummy values for other required fields to prevent crashes in UI
 stt: null,
 instances: [],
 qcStatus: 'unknown',
 status: 'N/A'
 }));

 if (searchPartName) {
 const q = searchPartName.trim().toLowerCase();
 filtered = filtered.filter(m => m.moduleCode.toLowerCase().includes(q));
 }
 } else {
 // Logic mặc định: tra cứu từ projectEntries (Firestore)
 let base = projectEntries;
 if (selectedProjectCode) {
 base = base.filter(p => p.projectCode === selectedProjectCode);
 }
 if (selectedType) {
 base = base.filter(p => p.classification === selectedType);
 }

 if (searchPartName) {
 const q = searchPartName.trim().toLowerCase();
 base = base.filter(m => {
 return m.moduleCode && m.moduleCode.toLowerCase().includes(q);
 });
 }
 filtered = base;
 }

 const compiled = filtered.map(m => {
 const mW = m.width || m.pWidth || m.length || 0;
 const mD = m.depth || m.pDepth || 0;
 const mH = m.height || m.pHeight || 0;

 if (!searchPartName && mW === 0 && mD === 0 && mH === 0) {
 return null;
 }

 const activeTargets = {
 L: targetLength ? L : null,
 S: targetDepth ? S : null,
 H: targetHeight ? H_target : null
 };

 if (isDeepFilter) {
 const activeKeys = Object.keys(activeTargets).filter(k => activeTargets[k] !== null);

 if (activeKeys.length === 0) {
 return {
 module: m,
 bestPermLabel: 'Tất cả',
 matchedDims: [mW, 0, mH],
 deviation: 0,
 breakdown: { dL: 0, dS: 0, dH: 0 },
 dimensions: { mW, mD, mH }
 };
 }

 if (activeKeys.length === 1) {
 const targetVal = activeTargets[activeKeys[0] as 'L' | 'S' | 'H'];
 const devW = Math.abs(mW - targetVal!);
 const devH = Math.abs(mH - targetVal!);
 const minDev = Math.min(devW, devH);
 const matchedDim = devW < devH ? mW : mH;

 let breakdown = { dL: 0, dS: 0, dH: 0 };
 const delta = matchedDim - targetVal!;
 if (activeKeys[0] === 'L') breakdown.dL = delta;
 else if (activeKeys[0] === 'S') breakdown.dS = delta;
 else breakdown.dH = delta;

 return {
 module: m,
 bestPermLabel: `Khớp 1D (${activeKeys[0] === 'L' ? 'Dài' : activeKeys[0] === 'S' ? 'Rộng' : 'Cao'})`,
 matchedDims: [matchedDim, 0, 0],
 deviation: minDev,
 breakdown: breakdown,
 dimensions: { mW, mD, mH }
 };
 }

 const targets = [
 { pair: [activeTargets.L, activeTargets.S], label: 'Dài - Rộng' },
 { pair: [activeTargets.L, activeTargets.H], label: 'Dài - Cao' },
 { pair: [activeTargets.S, activeTargets.H], label: 'Rộng - Cao' },
 ];

 let minDev = Infinity;
 let bestLabel = 'Không khớp';
 let bestBreakdown = { dL: 0, dS: 0, dH: 0 };
 let matchedPair = [0, 0, 0];

 targets.forEach(t => {
 const [t1, t2] = t.pair;
 if (t1 === null && t2 === null) return;

 const trials = [
 { dims: [mW, mH], pair: [t1, t2] },
 { dims: [mH, mW], pair: [t1, t2] }
 ];

 trials.forEach(({ dims, pair }) => {
 let dev = 0;
 let d1 = 0, d2 = 0;
 if (pair[0] !== null) { d1 = dims[0] - pair[0]; dev += Math.abs(d1); }
 if (pair[1] !== null) { d2 = dims[1] - pair[1]; dev += Math.abs(d2); }

 if (dev < minDev) {
 minDev = dev;
 bestLabel = `Khớp 2D (${t.label})`;
 if (t.label === 'Dài - Rộng') bestBreakdown = { dL: d1, dS: d2, dH: 0 };
 if (t.label === 'Dài - Cao') bestBreakdown = { dL: d1, dS: 0, dH: d2 };
 if (t.label === 'Rộng - Cao') bestBreakdown = { dL: 0, dS: d1, dH: d2 };
 matchedPair = [dims[0], 0, dims[1]];
 }
 });
 });

 return {
 module: m,
 bestPermLabel: bestLabel,
 matchedDims: matchedPair,
 deviation: minDev,
 breakdown: bestBreakdown,
 dimensions: { mW, mD, mH }
 };
 }

 // Original 3D matching logic for Firestore data
 const permutations = [
 { label: 'Dài - Sâu - Cao (Mặc định)', mapping: [mW, mD, mH] },
 { label: 'Dài - Cao - Sâu (Xoay)', mapping: [mW, mH, mD] },
 { label: 'Sâu - Dài - Cao (Xoay)', mapping: [mD, mW, mH] },
 { label: 'Sâu - Cao - Dài (Xoay)', mapping: [mD, mH, mW] },
 { label: 'Cao - Dài - Sâu (Xoay)', mapping: [mH, mW, mD] },
 { label: 'Cao - Sâu - Dài (Xoay)', mapping: [mH, mD, mW] }
 ];

 let bestPerm = permutations[0];
 let minDeviation = Infinity;
 let breakdown = { dL: 0, dS: 0, dH: 0 };

 permutations.forEach(perm => {
 const [p1, p2, p3] = perm.mapping;
 let sumDev = 0;
 let dL = 0, dS = 0, dH = 0;

 if (activeTargets.L !== null) {
 dL = p1 - activeTargets.L;
 sumDev += Math.abs(dL);
 }
 if (activeTargets.S !== null) {
 dS = p2 - activeTargets.S;
 sumDev += Math.abs(dS);
 }
 if (activeTargets.H !== null) {
 dH = p3 - activeTargets.H;
 sumDev += Math.abs(dH);
 }

 if (sumDev < minDeviation) {
 minDeviation = sumDev;
 bestPerm = perm;
 breakdown = { dL, dS, dH };
 }
 });

 const hasSizeFields = !searchPartName && !!(targetLength || targetDepth || targetHeight);
 const computedDeviation = hasSizeFields ? minDeviation : 0;

 return {
 module: m,
 bestPermLabel: bestPerm.label,
 matchedDims: bestPerm.mapping,
 deviation: computedDeviation,
 breakdown: hasSizeFields ? breakdown : { dL: 0, dS: 0, dH: 0 },
 dimensions: { mW, mD, mH }
 };
 }).filter((x): x is NonNullable<typeof x> => {
 if (x === null) return false;
 const hasSizeFields = !searchPartName && !!(targetLength || targetDepth || targetHeight);
 if (!hasSizeFields) return true;
 return x.deviation < 10;
 });

 if (searchPartName) {
 return compiled.sort((a, b) => {
 const getMinStt = (m: any) => {
 if (m.stt) return m.stt;
 if (m.instances && m.instances.length > 0) {
 const stts = m.instances.map(inst => inst.stt).filter((s): s is number => typeof s === 'number');
 if (stts.length > 0) return Math.min(...stts);
 }
 return 999999;
 };
 return getMinStt(a.module) - getMinStt(b.module);
 }).slice(0, 30);
 }

 const sorted = compiled.sort((a, b) => a.deviation - b.deviation);
 return isDeepFilter ? sorted.slice(0, 30) : sorted.slice(0, 15);
 }, [projectEntries, selectedProjectCode, selectedType, targetLength, targetDepth, targetHeight, searchPartName, moduleTempLabelSeqMap, isDeepFilter]);

 return (
 <div className="pb-24">
 {/* Header */}
 <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
 <div>
 <h2 className="text-xl font-bold text-slate-800 flex items-center">
 <SlidersHorizontal size={24} className="mr-2 text-indigo-600 shrink-0" />
 Lọc & Tìm Kiếm Cấu Kiện Đồng Dạng
 </h2>
 <p className="text-[10px] text-slate-500 uppercase font-black tracking-tight mt-1">
 Tìm nhanh cấu kiện tương thích hình học dựa trên kích thước danh định
 </p>
 </div>
 </div>

 {/* Filter Flat Card */}
 <div className="bg-white rounded-lg border border-slate-200 p-4 lg:p-6 mb-6">
 <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
 {/* Project Choice */}
 <div className="flex flex-col space-y-1">
 <label className="text-[10px] font-black uppercase text-slate-400 tracking-wider">Chọn dự án</label>
 <select
 value={selectedProjectCode}
 onChange={e => setSelectedProjectCode(e.target.value)}
 className="bg-slate-100 border border-slate-200 text-slate-700 text-xs rounded-lg focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 block w-full p-2.5 transition-all outline-none"
 >
 <option value="">-- Tất cả dự án --</option>
 {uniqueProjects.map(p => (
 <option key={p.code} value={p.code}>
 {p.code} - {p.name}
 </option>
 ))}
 </select>
 </div>

 {/* Search Part Name */}
 <div className="flex flex-col space-y-1">
 <label className="text-[10px] font-black uppercase text-slate-400 tracking-wider">Tìm kiếm theo tên cấu kiện</label>
 <div className="relative">
 <input
 type="text"
 value={searchPartName}
 onChange={e => setSearchPartName(e.target.value)}
 placeholder="Nhập tên cấu kiện (Ví dụ: MOR026...)"
 className="bg-slate-100 border border-slate-200 text-slate-700 text-xs rounded-lg focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 block w-full p-2.5 transition-all outline-none font-mono"
 />
 {searchPartName && (
 <button
 type="button"
 onClick={() => setSearchPartName('')}
 className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 font-bold text-xs"
 >
 ✕
 </button>
 )}
 </div>
 </div>

 <div className="grid grid-cols-3 gap-3 lg:col-span-2">
 {/* Target Length / Dài */}
 <div className="flex flex-col space-y-1">
 <label className="text-[10px] font-black uppercase text-slate-400 tracking-wider flex items-center select-none">
 Dài (mm)
 </label>
 <div className="relative">
 <input
 type="number"
 value={targetLength || ''}
 onChange={e => setTargetLength(e.target.value)}
 placeholder="Ví dụ: 800"
 className="bg-slate-100 border border-slate-200 text-slate-700 !text-[14px] rounded-lg focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 block w-full p-3 outline-none font-mono h-10"
 />
 </div>
 </div>

 {/* Target Depth / Sâu */}
 <div className="flex flex-col space-y-1">
 <label className="text-[10px] font-black uppercase text-slate-400 tracking-wider select-none">
 Rộng (mm)
 </label>
 <input
 type="number"
 value={targetDepth || ''}
 onChange={e => setTargetDepth(e.target.value)}
 placeholder="Ví dụ: 600"
 className="bg-slate-100 border border-slate-200 text-slate-700 !text-[14px] rounded-lg focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 block w-full p-3 outline-none font-mono h-10"
 />
 </div>

 {/* Target Height / Cao */}
 <div className="flex flex-col space-y-1">
 <label className="text-[10px] font-black uppercase text-slate-400 tracking-wider select-none">
 Cao/Dày (mm)
 </label>
 <input
 type="number"
 value={targetHeight || ''}
 onChange={e => setTargetHeight(e.target.value)}
 placeholder="Ví dụ: 450"
 className="bg-slate-100 border border-slate-200 text-slate-700 !text-[14px] rounded-lg focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 block w-full p-3 outline-none font-mono h-10"
 />
 </div>
</div>
 </div>

 {/* Deep Filter Toggle */}
 <div className="mt-5 pt-4 border-t border-slate-100 flex items-center justify-between">
 <div className="flex items-center space-x-2">
 <div className={`p-1.5 rounded-lg ${isDeepFilter ? 'bg-indigo-100 text-indigo-600' : 'bg-slate-100 text-slate-400'}`}>
 <Sparkles size={16} />
 </div>
 <div className="flex flex-col">
 <span className="text-xs font-black uppercase text-slate-700 tracking-wider">Lọc Sâu (Deep Filter)</span>
 <span className="text-[10px] text-slate-400 font-medium">Tra cứu từ cơ sở dữ liệu mở rộng (data.json)</span>
 </div>
 </div>
 <button
 type="button"
 onClick={() => setIsDeepFilter(!isDeepFilter)}
 className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${
 isDeepFilter ? 'bg-indigo-600' : 'bg-slate-300'
 }`}
 >
 <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
 isDeepFilter ? 'translate-x-6' : 'translate-x-1'
 }`} />
 </button>
 </div>

 {/* Quick Choose Classification Block */}
 <div className="mt-5 pt-4 border-t border-slate-100 flex flex-col space-y-2">
 <label className="text-[10px] font-black uppercase text-slate-400 tracking-wider">Hạt nhân phân loại (Chọn nhanh)</label>
 <div className="flex flex-wrap gap-2">
 <button
 type="button"
 onClick={() => setSelectedType('')}
 className={`px-3 py-1.5 text-xs font-bold rounded-lg border uppercase transition-all duration-200 ${
 selectedType === ''
 ? 'bg-indigo-600 text-white border-indigo-600 shadow-xs'
 : 'bg-slate-100 text-slate-600 border-slate-200 hover:bg-slate-100 hover:text-slate-800'
 }`}
 >
 Tất cả loại
 </button>
 {uniqueTypes.map(t => {
 const displayLabel = t === 'Cánh' ? 'Cánh/Cửa' : t;
 return (
 <button
 key={t}
 type="button"
 onClick={() => setSelectedType(t)}
 className={`px-3 py-1.5 text-xs font-bold rounded-lg border uppercase transition-all duration-200 ${
 selectedType === t
 ? 'bg-indigo-600 text-white border-indigo-600 shadow-xs'
 : 'bg-slate-100 text-slate-600 border-slate-200 hover:bg-slate-100 hover:text-slate-800'
 }`}
 >
 {displayLabel}
 </button>
 );
 })}
 </div>
 </div>

 {/* Clear filter and guide indicator */}
 <div className="flex items-center justify-between mt-5 pt-4 border-t border-slate-100">
 <div className="flex items-center space-x-2 text-[10px] font-medium text-slate-500">
 <Info size={14} className="text-indigo-500 shrink-0" />
 <span>Hệ thống tự động tìm kể cả khi đảo chiều gá nắp (Dài ↔ Sâu ↔ Cao)</span>
 </div>
 <button
 onClick={handleReset}
 className="flex items-center space-x-1.5 px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-lg text-xs font-bold uppercase transition-all"
 >
 <RefreshCw size={13} />
 <span>Làm mới</span>
 </button>
 </div>
 </div>

 {/* Results Title Banner */}
 <div className="mb-4 flex items-center justify-between">
 <h3 className="text-xs font-black uppercase tracking-widest text-slate-700">
 Cấu kiện tương tự nhất ({matchedResults.length})
 </h3>
 {matchedResults.length > 0 && (
 <span className="bg-indigo-100 text-indigo-600 px-2 py-0.5 rounded-lg text-[9px] font-black uppercase tracking-wider border border-indigo-100">
 Sai số tối ưu
 </span>
 )}
 </div>

 {/* Results Container with permanent Saved Labels sidebar */}
 <div className="grid grid-cols-12 gap-6">
 {/* Left panel: search results */}
 <div className="col-span-12 lg:col-span-8">
 {matchedResults.length > 0 ? (
 <div className="grid grid-cols-1 md:grid-cols-2 gap-4" id="filter-results-list">
 {matchedResults.map((item, idx) => {
 const hasExactMatch = item.deviation === 0;
 const isVeryClose = item.deviation <= 10;
 
 // Format project information
 const prjCode = item.module.projectCode;
 const prjDisplay = formatProjectCode(prjCode);
 const prjName = item.module.projectName || 'Dự án không tên';

 return (
 <motion.div
 initial={{ opacity: 0, y: 5 }}
 animate={{ opacity: 1, y: 0 }}
 transition={{ duration: 0.15, delay: idx * 0.03 }}
 key={item.module.id}
 className={`bg-white rounded-lg border p-4 transition-all relative overflow-hidden flex flex-col justify-between ${
 hasExactMatch 
 ? 'border-emerald-200 ring-1 ring-emerald-500/15'
 : isVeryClose
 ? 'border-amber-200'
 : 'border-slate-200'
 }`}
 >
 {/* Score indicators */}
 <div className="flex items-start justify-between gap-2 mb-3">
 <div className="min-w-0">
 <div className="flex items-center gap-1.5 mb-1 text-slate-500 text-[10px] font-bold uppercase tracking-wider">
 <span className="truncate max-w-[150px]" title={`${prjDisplay} - ${prjName}`}>
 {prjDisplay}
 </span>
 </div>
 <h4 className="text-sm font-bold text-slate-900 flex items-center gap-2" title={item.module.moduleCode}>
 {(() => {
 const labelInfo = moduleTempLabelSeqMap.get(item.module.id);
 
 let sttDisplay = '';
 if (item.module.moduleType === 'bo') {
 if (item.module.stt) sttDisplay = item.module.stt;
 } else {
 const insts = item.module.instances || [];
 const stts = insts.map(i => i.stt).filter((s): s is number => typeof s === 'number').sort((a, b) => a - b);
 if (stts.length > 0) {
 sttDisplay = stts.length > 1 
 ? `${stts[0]} - ${stts[stts.length - 1]}`
 : `${stts[0]}`;
 }
 }
 
 if (!sttDisplay && labelInfo) {
 sttDisplay = `${labelInfo.system}#${labelInfo.seq}`;
 }
 
 if (!sttDisplay) return null;
 
 const bgClass = 'bg-indigo-100 text-indigo-700 border-indigo-100 shadow-sm';
 return (
 <span 
 className={`text-[11px] md:text-[13px] px-2.5 py-1 rounded-lg font-black shrink-0 font-mono border leading-none ${bgClass}`} 
 title="Số thứ tự Tem Tạm"
 >
 {sttDisplay}
 </span>
 );
 })()}
 <span className="min-w-0 font-extrabold text-slate-800 break-words">{item.module.moduleCode}</span>
 </h4>
 </div>
 
 {/* Deviation Score tag */}
 <div className="text-right shrink-0">
 <span className={`inline-block px-1.5 py-0.5 rounded-lg text-[9px] font-black uppercase tracking-widest leading-none border ${
 hasExactMatch
 ? 'bg-emerald-100 text-emerald-600 border-emerald-100'
 : isVeryClose
 ? 'bg-amber-100 text-amber-600 border-amber-100'
 : 'bg-indigo-100 text-indigo-600 border-indigo-100'
 }`}>
 {hasExactMatch ? 'CHUẨN 100%' : `LỆCH ${item.deviation} mm`}
 </span>
 </div>
 </div>

 {/* Dimensions Comparison Box */}
 <div className="bg-slate-100 border border-slate-100 p-2.5 rounded-lg mb-3">
 <div className="grid grid-cols-2 gap-2 text-center">
 <div>
 <p className="text-[8px] text-slate-400 font-black uppercase tracking-wider">KÍCH THƯỚC GỐC</p>
 <p className="text-[11px] font-mono font-black text-slate-700 mt-0.5">
 {item.dimensions.mW}x{item.dimensions.mD}x{item.dimensions.mH}
 </p>
 </div>
 <div>
 <p className="text-[8px] text-slate-400 font-black uppercase tracking-wider">CHIỀU KHỚP TỐT NHẤT</p>
 <p className="text-[11px] font-mono font-black text-indigo-600 mt-0.5">
 {item.matchedDims[0]}x{item.matchedDims[1]}x{item.matchedDims[2]}
 </p>
 </div>
 </div>
 
 {/* Matching strategy & Deviation detailed breakdown */}
 <div className="mt-2 pt-2 border-t border-slate-100 flex flex-col space-y-1">
 <div className="flex items-center justify-between text-[8px] font-black uppercase tracking-widest text-slate-400">
 <span>Kiểu gá:</span>
 <span className="text-indigo-600 font-bold">{item.bestPermLabel}</span>
 </div>
 <div className="flex items-center justify-between text-[9px] font-bold font-mono text-slate-500">
 <span>Lệch thành tố:</span>
 <span className="space-x-1.5">
 {targetLength && (
 <span className={item.breakdown.dL === 0 ? 'text-slate-400' : 'text-red-500 font-black'}>
 D:{item.breakdown.dL > 0 ? '+' : ''}{item.breakdown.dL}
 </span>
 )}
 {targetDepth && (
 <span className={item.breakdown.dS === 0 ? 'text-slate-400' : 'text-red-500 font-black'}>
 S:{item.breakdown.dS > 0 ? '+' : ''}{item.breakdown.dS}
 </span>
 )}
 {targetHeight && (
 <span className={item.breakdown.dH === 0 ? 'text-slate-400' : 'text-red-500 font-black'}>
 C:{item.breakdown.dH > 0 ? '+' : ''}{item.breakdown.dH}
 </span>
 )}
 </span>
 </div>
 </div>
 </div>

 {/* Project info, classification, and status badges */}
 <div className="flex items-center justify-between text-[10px] text-slate-400 border-t border-slate-100 pt-3 mt-1">
 <div className="flex items-center space-x-1.5 min-w-0">
 <span className="bg-slate-100 text-slate-600 px-1 py-0.5 rounded-lg text-[8px] font-black uppercase tracking-wider shrink-0">
 {item.module.classification === 'Cánh' ? 'Cánh/Cửa' : (item.module.classification || 'Mục')}
 </span>
 <span className="truncate text-[10px] text-slate-500 font-medium">SL: {item.module.quantity || 1}</span>
 </div>
 
 {/* Status Badge */}
  <span className={`px-1.5 py-0.5 rounded-lg text-[8px] font-black uppercase tracking-wider border shrink-0 ${
  getModuleQcAggregate(item.module, 'pack')?.status === 'pass' || item.module.status?.toLowerCase().includes('pass')
  ? 'bg-emerald-100 text-emerald-600 border-emerald-100'
  : item.module.status?.toLowerCase().includes('lỗi') || getModuleQcAggregate(item.module, 'pack')?.status === 'fail'
  ? 'bg-rose-100 text-rose-600 border-rose-100'
  : 'bg-slate-100 text-slate-400 border-slate-100'
  }`}>
  {getModuleQcAggregate(item.module, 'pack')?.status === 'pass' ? 'PASS' : getModuleQcAggregate(item.module, 'pack')?.status === 'fail' ? 'FAIL' : item.module.status || 'Chờ kiểm'}
  </span>
 </div>

 {/* Action to Save stamp */}
 <button
 onClick={() => handleSaveLabel(item)}
 className="mt-3 w-full py-2 bg-indigo-100 hover:bg-indigo-100 text-indigo-700 rounded-lg text-xs font-bold uppercase transition-all flex items-center justify-center space-x-1 border border-indigo-100 cursor-pointer"
 >
 <Tag size={13} />
 <span>Lưu tem tạm</span>
 </button>
 </motion.div>
 );
 })}
 </div>
 ) : (
 <div className="bg-white rounded-lg border border-slate-200 p-12 text-center" id="filter-results-empty">
 <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center text-slate-400 mx-auto mb-4 border border-slate-100">
 <Search size={20} />
 </div>
 <h4 className="text-sm font-bold text-slate-700 uppercase tracking-tight">Sẵn sàng lọc tìm kiếm</h4>
 <p className="text-xs text-slate-400 mt-1 max-w-sm mx-auto leading-relaxed">
 Vui lòng nhập đầy đủ cả 3 kích thước (mm) cho chiều dài, sâu và cao để tìm các cấu kiện đồng dạng gần khớp nhất.
 </p>
 </div>
 )}
 </div>

 {/* Right panel: saved labels list */}
 <div className="col-span-12 lg:col-span-4 bg-white border border-slate-200 rounded-lg p-4 h-fit sticky top-4 space-y-4 shadow-xs">
 <div className="flex items-center justify-between pb-3 border-b border-slate-100">
 <h4 className="text-xs font-black uppercase text-indigo-900 tracking-wider flex items-center space-x-1.5">
 <Tag size={14} className="text-indigo-600" />
 <span>Danh Sách Tem Đã Lưu ({savedLabels.length})</span>
 </h4>
 {savedLabels.length > 0 && (
 <button
 onClick={handleClearAllSaved}
 className="text-[10px] font-black uppercase text-slate-400 hover:text-rose-500 transition-colors"
 >
 Xóa hết
 </button>
 )}
 </div>

 {savedLabels.length > 0 ? (
 <>
 <div className="max-h-[350px] overflow-y-auto space-y-2.5 pr-1">
 {savedLabels.map((lab) => (
 <div key={lab.id} className="flex items-center justify-between p-3 bg-slate-100 border border-slate-100 rounded-lg">
 <div className="min-w-0 pr-2">
 <p className="text-[9px] font-black text-indigo-600 uppercase tracking-wider truncate">{lab.displayProject}</p>
 <h5 className="text-xs font-extrabold text-slate-800 truncate" title={lab.moduleCode}>{lab.moduleCode}</h5>
 <p className="text-[10px] font-mono text-slate-400 mt-0.5">
 KT: {lab.dimensions.mW}x{lab.dimensions.mD}x{lab.dimensions.mH} • {lab.idx}/{lab.totalQty}
 </p>
 </div>
 <div className="flex items-center space-x-1.5 shrink-0">
 <button
 onClick={() => handlePrintSingleLabel(lab)}
 className="p-1.5 bg-indigo-100 hover:bg-indigo-100 text-indigo-700 rounded-lg transition-all cursor-pointer border border-indigo-100"
 title="In tem tạm này"
 >
 <Printer size={13} />
 </button>
 <button
 onClick={() => handleDeleteLabel(lab.id)}
 className="p-1.5 bg-rose-100 hover:bg-rose-100 text-rose-600 rounded-lg transition-all cursor-pointer border border-rose-100"
 title="Xóa tem"
 >
 <X size={13} />
 </button>
 </div>
 </div>
 ))}
 </div>

 <button
 onClick={handlePrintAllLabels}
 className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-black uppercase tracking-wider transition-all flex items-center justify-center space-x-1.5 shadow-sm cursor-pointer"
 >
 <Printer size={15} />
 <span>In ({savedLabels.length}) tem đã lưu</span>
 </button>
 </>
 ) : (
 <div className="py-8 text-center text-slate-400">
 <div className="w-10 h-10 rounded-full bg-slate-100 flex items-center justify-center text-slate-300 mx-auto mb-2 border border-slate-100">
 <Tag size={16} />
 </div>
 <p className="text-[11px] font-bold text-slate-500 uppercase tracking-tight">Chưa có tem nào</p>
 <p className="text-[10px] text-slate-400 mt-1 max-w-[180px] mx-auto leading-relaxed">
 Nhấp nút <strong>"Lưu tem tạm"</strong> trên bất kỳ kết quả lọc nào ở cột trái để thêm tem vào bảng in nhanh tại đây.
 </p>
 </div>
 )}
 </div>
 </div>

 {/* Hidden printing layout inside a Portal */}
 {printingLabels.length > 0 && createPortal(
 <div id="print-labels-area">
 <style dangerouslySetInnerHTML={{ __html: `
 @media print {
 body *, html *, #root *, .pb-24 * {
 visibility: hidden !important;
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

 #print-labels-area, #print-labels-area * {
 visibility: visible !important;
 }

 #print-labels-area {
 position: absolute !important;
 left: 0 !important;
 top: 0 !important;
 display: block !important;
 width: 60mm !important;
 height: auto !important;
 margin: 0 !important;
 padding: 0 !important;
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
 image-rendering: crisp-edges !important;
 image-rendering: pixelated !important;
 }
 }
 ` }} />
 {printingLabels.map(item => item.dataUrl && (
 <div key={`print-filter-${item.id}`} className="print-card-item">
 <img
 src={item.dataUrl}
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

// Helper to get formatted code
function pWidthDisplayCode(code: string, entries: ProjectEntry[]): string {
 const prj = entries.find(e => e.projectCode === code);
 return formatProjectCode(code);
}
