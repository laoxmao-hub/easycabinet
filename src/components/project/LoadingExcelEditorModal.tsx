/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useMemo, useEffect, useRef } from 'react';
import { X, Save, Search, Loader2, Info, CheckCircle, Truck, Package, Plus, Trash2 } from 'lucide-react';
import {
  collection, addDoc, query, where, getDocs, deleteDoc, doc, updateDoc, serverTimestamp,
  writeBatch, setDoc
} from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { PKLOrder, PackingItem, ProjectEntry } from '../../types';
import { useAuth } from '../../lib/AuthContext';
import { useAlert } from '../../lib/AlertContext';
import { formatProjectCode } from '../../lib/formatters';
import { syncItemLoadedStatus, syncInstanceLoadInfo } from '../../lib/syncLoadedStatus';

const computeRawQR = (item: PackingItem): string => {
  const isCtht = item.subType === 'kienCTHT';
  const baseCode = item.name.includes('#') ? item.name.split('#')[0].trim() : item.name;
  const instIdx = item.instanceIndex;
  const totalInst = item.totalInstances;
  const instanceSuffix = totalInst && totalInst > 1 && instIdx ? `|${instIdx}` : '';
  if (isCtht && item.id) return `${item.id}|${item.name}`;
  return `${baseCode}${instanceSuffix}`;
};

interface LoadingExcelEditorModalProps {
  pkl: PKLOrder;
  allPackingItems: { item: PackingItem; packingDocId: string; projectCode?: string; projectName?: string }[];
  projectEntries: ProjectEntry[];
  onClose: () => void;
}

interface EditableLoadItem {
  id: string;
  name: string;
  projectCode: string;
  projectName: string;
  cluster: string;
  totalPackedQty: number;
  item: PackingItem;
  packingDocId: string;
  rawQR?: string;
}

export function LoadingExcelEditorModal({ pkl, allPackingItems, projectEntries, onClose }: LoadingExcelEditorModalProps) {
  const { user, userProfile } = useAuth();
  const { showSuccess, showError, showConfirm } = useAlert();
  const [loading, setLoading] = useState(false);
  const manualCounterRef = useRef(0);
  const [searchTerm, setSearchTerm] = useState('');
  const [projectFilter, setProjectFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [showManualInput, setShowManualInput] = useState(false);

  // Modal thêm kiện thủ công
  const [addModalProject, setAddModalProject] = useState('');
  const [addModalCluster, setAddModalCluster] = useState('');
  const [addModalSearch, setAddModalSearch] = useState('');
  const [addModalType, setAddModalType] = useState('');

  const [gridData, setGridData] = useState<EditableLoadItem[]>([]);
  const [initialGridData, setInitialGridData] = useState<EditableLoadItem[]>([]);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; row: EditableLoadItem } | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const skipNextEffectRef = useRef(false);

  useEffect(() => {
    // Skip rebuild sau khi save để list không bị nhấp nháy
    if (skipNextEffectRef.current) {
      skipNextEffectRef.current = false;
      return;
    }

    // Đọc items từ scanQRItems (items quét QR đã lưu trong PKL)
    const savedScanQR = (pkl as any).scanQRItems || [];
    const savedManual = (pkl as any).manualItems || [];
    const usedPackingDocIds = new Set<string>(); // track allPackingItem đã dùng

    // Iterate từ scanQRItems → mỗi scanQR map TỐI ĐA 1 allPackingItem
    // Tránh trùng lặp khi nhiều allPackingItems trùng tên
    const scanRows: EditableLoadItem[] = savedScanQR.map((s: any) => {
      // Ưu tiên 1: match theo ID
      let matchById = allPackingItems.find(e => e.item.packed && e.item.id && e.item.id === s.id);
      // Ưu tiên 2: match theo tên (chỉ 1 item)
      if (!matchById) {
        matchById = allPackingItems.find(e =>
          e.item.packed && e.item.id && e.item.name === s.name && !usedPackingDocIds.has(e.item.id!)
        );
      }
      if (matchById) {
        usedPackingDocIds.add(matchById.item.id!);
        const item = matchById.item;
        return {
          id: item.id || s.id,
          name: s.name || item.name,
          projectCode: matchById.projectCode || pkl.projectId || '',
          projectName: matchById.projectName || pkl.projectName || '',
          cluster: item.cluster || s.cluster || 'Khác',
          totalPackedQty: item.quantity || 1,
          item: item,
          packingDocId: matchById.packingDocId,
          rawQR: s.rawQR || item.rawQR || computeRawQR(item)
        };
      }
      // Fallback: scanQR item không match packing nào → dùng data từ scanQR
      return {
        id: s.id,
        name: s.name,
        projectCode: s.projectCode || pkl.projectId || '',
        projectName: s.projectName || pkl.projectName || '',
        cluster: s.cluster || 'Quét QR',
        totalPackedQty: 1,
        rawQR: s.rawQR || s.name,
        item: {
          id: s.id,
          name: s.name,
          quantity: 1,
          packed: true,
          subType: s.subType || 'kienModule',
          cluster: s.cluster || 'Quét QR',
        } as PackingItem,
        packingDocId: ''
      };
    });
    setGridData(scanRows);
    setInitialGridData(scanRows);

    // Restore manual items saved in PKL
    if (savedManual.length > 0) {
      const manualRows: EditableLoadItem[] = savedManual.map((m: any) => {
        const isCtht = m.subType === 'kienCTHT';
        return {
          id: m.id,
          name: m.name,
          projectCode: m.projectCode || pkl.projectId || '',
          projectName: m.projectName || pkl.projectName || '',
          cluster: m.cluster || (isCtht ? 'Chi tiết hỗ trợ' : 'Thu cong'),
          totalPackedQty: 1,
          rawQR: m.rawQR || computeRawQR({ name: m.name, subType: m.subType || 'kienModule', id: m.id } as PackingItem),
          item: {
            id: m.id,
            name: m.name,
            quantity: 1,
            packed: true,
            subType: m.subType || 'kienModule',
            cluster: m.cluster || (isCtht ? 'Chi tiết hỗ trợ' : 'Thủ công'),
            isExtra: isCtht,
          } as PackingItem,
          packingDocId: ''
        };
      });
      setGridData(prev => [...prev, ...manualRows]);
      setInitialGridData(prev => [...prev, ...manualRows]);
    }

  }, [allPackingItems, pkl]);

  const getRowSubType = (row: EditableLoadItem) => {
   const item = row.item as any;
   const st = item?.subType;
   if (st === 'kienCTHT') return 'kienCTHT';
   if (st === 'kienPhuKien') return 'kienPhuKien';
   return 'kienModule';
  };

  // Phân loại kiện theo subType (kienModule | kienCTHT | kienPhuKien)
  const getEntrySubType = (entry: { item: PackingItem }) => {
   const st = entry.item.subType;
   if (st === 'kienCTHT') return 'kienCTHT';
   if (st === 'kienPhuKien') return 'kienPhuKien';
   return 'kienModule';
  };

  // Khóa định danh kiện đã có trong PKL (scanQRItems + manualItems + gridData).
  // Dùng khóa đầy đủ (id|tên) + cụm + dự án — KHÔNG ẩn theo tên đơn thuần,
  // để kiện trùng tên ở cụm/dự án khác vẫn hiển thị đủ (không thiếu kiện bên đóng gói).
  const existingKeys = useMemo(() => {
    const savedScanQR = (pkl as any).scanQRItems || [];
    const savedManual = (pkl as any).manualItems || [];
    const keys = new Set<string>();
    const add = (id: any, name: any, cluster: any, projectCode: any) => {
      const identity = `${id || name || ''}|${cluster || ''}|${projectCode || ''}`;
      if (identity.trim()) keys.add(identity.toLowerCase());
    };
    savedScanQR.forEach((s: any) => add(s.id, s.name, s.cluster, s.projectCode));
    savedManual.forEach((m: any) => add(m.id, m.name, m.cluster, m.projectCode));
    gridData.forEach(r => add(r.item.id, r.name, r.cluster, r.projectCode));
    return keys;
  }, [pkl, gridData]);

  // Kiểm tra kiện đóng gói đã thật sự có trong PKL chưa (cùng id/tên + cụm + dự án)
  const isEntryExisting = (entry: { item: PackingItem; projectCode?: string }) => {
    const item = entry.item;
    const identity = `${item.id || item.name || ''}|${item.cluster || ''}|${entry.projectCode || ''}`;
    if (!identity.trim()) return false;
    return existingKeys.has(identity.toLowerCase());
  };

  const typeOrder: Record<string, number> = { kienModule: 0, kienCTHT: 1, kienPhuKien: 2 };

  const filteredRows = useMemo(() => {
    return gridData.filter(row => {
      if (projectFilter && row.projectCode !== projectFilter) return false;
      if (typeFilter) {
        const subType = getRowSubType(row);
        if (typeFilter === 'kienModule' && subType !== 'kienModule') return false;
        if (typeFilter === 'kienCTHT' && subType !== 'kienCTHT') return false;
        if (typeFilter === 'kienPhuKien' && subType !== 'kienPhuKien') return false;
      }
      if (searchTerm) {
        const lowerSearch = searchTerm.toLowerCase();
        return row.name.toLowerCase().includes(lowerSearch) ||
          row.cluster.toLowerCase().includes(lowerSearch) ||
          row.projectCode.toLowerCase().includes(lowerSearch);
      }
      return true;
    }).sort((a, b) => {
      const typeA = typeOrder[getRowSubType(a)] ?? 3;
      const typeB = typeOrder[getRowSubType(b)] ?? 3;
      if (typeA !== typeB) return typeA - typeB;
      const nameA = a.name || '';
      const nameB = b.name || '';
      return nameA.localeCompare(nameB, 'vi', { numeric: true, sensitivity: 'base' });
    });
  }, [gridData, searchTerm, projectFilter, typeFilter]);

  const changedCount = useMemo(() => {
    return gridData.filter(row => {
      const initial = initialGridData.find(i => i.id === row.id);
      if (!initial) return true; // item mới thêm
      return row.totalPackedQty !== initial.totalPackedQty || row.name !== initial.name || row.projectCode !== initial.projectCode;
    }).length;
  }, [gridData, initialGridData]);



  const toggleSelectAll = () => {
    const allVisibleIds = new Set(filteredRows.map(r => r.id));
    const allSelected = filteredRows.every(r => selectedIds.has(r.id));
    if (allSelected) {
      setSelectedIds(prev => {
        const next = new Set(prev);
        filteredRows.forEach(r => next.delete(r.id));
        return next;
      });
    } else {
      setSelectedIds(prev => new Set([...prev, ...allVisibleIds]));
    }
  };

  const toggleSelectRow = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    showConfirm({
      title: `XÓA ${selectedIds.size} KIỆN KHỎI PHIẾU`,
      message: `Bạn có chắc muốn xóa ${selectedIds.size} kiện đã chọn khỏi danh sách lên xe?`,
      onConfirm: async () => {
        setLoading(true);
        skipNextEffectRef.current = true;
        try {
          const rowsToDelete = gridData.filter(r => selectedIds.has(r.id));
          const pklRef = doc(db, 'loading', pkl.id);

          // 1. Xóa loading_histories cho tất cả rows
          for (const row of rowsToDelete) {
            const isManual = row.item.id?.startsWith('manual_');
            const q = isManual
              ? query(collection(db, 'loading_histories'), where('pklId', '==', pkl.id))
              : query(collection(db, 'loading_histories'), where('pklId', '==', pkl.id), where('packageName', '==', row.name));
            const snap = await getDocs(q);
            for (const historyDoc of isManual
              ? snap.docs.filter(d => (d.data().packageId || '').startsWith(row.item.id!))
              : snap.docs) {
              await deleteDoc(doc(db, 'loading_histories', historyDoc.id));
            }
          }

          // 2. Cập nhật PKL: xóa manualItems và scanQRItems
          const manualIds = rowsToDelete.filter(r => r.item.id?.startsWith('manual_')).map(r => r.item.id);
          const scanQRIds = rowsToDelete.filter(r => !r.item.id?.startsWith('manual_')).map(r => r.item.id);

          if (manualIds.length > 0) {
            const currentManual = (pkl as any).manualItems || [];
            const updatedManual = currentManual.filter((m: any) => !manualIds.includes(m.id));
            await updateDoc(pklRef, { manualItems: updatedManual });
          }

          if (scanQRIds.length > 0) {
            const currentScanQR = (pkl as any).scanQRItems || [];
            const updatedScanQR = currentScanQR.filter((s: any) => !scanQRIds.includes(s.id));
            await updateDoc(pklRef, { scanQRItems: updatedScanQR });

            for (const row of rowsToDelete.filter(r => !r.item.id?.startsWith('manual_'))) {
              // Sync theo tên kiện packing (row.item.name), không phải tên hiển thị
              syncItemLoadedStatus(row.item.name || row.name, false, '', row.projectCode || pkl.projectId || '', pkl.pklCode, pkl.id);
              syncInstanceLoadInfo(row.item.name || row.name, row.item.instanceIndex, row.projectCode || pkl.projectId || '', null, projectEntries);
            }
          }

          // 3. Cập nhật gridData 1 lần
          const deletedIds = new Set(rowsToDelete.map(r => r.id));
          setGridData(prev => prev.filter(r => !deletedIds.has(r.id)));
          setSelectedIds(new Set());
          showSuccess(`Đã xóa ${rowsToDelete.length} kiện khỏi danh sách.`);
        } catch (err: any) {
          showError("Lỗi khi xóa kiện: " + err.message);
        } finally {
          setLoading(false);
        }
      }
    });
  };

  const handleAddManualItem = (entry: { item: PackingItem; packingDocId: string; projectCode?: string; projectName?: string }) => {
    const matched = entry;
    const item = matched.item;
    const projectCode = matched.projectCode || pkl.projectId || '';
    const projectName = matched.projectName || pkl.projectName || '';
    const cluster = item.cluster || 'Thủ công';
    const isCtht = (item as any).subType === 'kienCTHT';

    const manualId = `manual_${Date.now()}_${manualCounterRef.current++}`;
    const newItem: EditableLoadItem = {
      id: manualId,
      name: item.name,
      projectCode,
      projectName,
      cluster,
      totalPackedQty: item.quantity || 1,
      item: {
        ...item,
        id: manualId,
        packed: true,
      } as PackingItem,
      packingDocId: matched.packingDocId || '',
      rawQR: item.rawQR || computeRawQR(item)
    };

    setGridData(prev => [...prev, newItem]);
  };

  // Xóa kiện khỏi danh sách lên xe (right-click trên STT)
  const handleRemoveFromPkl = async (row: EditableLoadItem) => {
    if (!row.item.id) return;
    setContextMenu(null);

    const isManual = row.item.id.startsWith('manual_');
    const pklRef = doc(db, 'loading', pkl.id);

    // Xóa loading_histories
    const q = isManual
      ? query(collection(db, 'loading_histories'), where('pklId', '==', pkl.id))
      : query(collection(db, 'loading_histories'), where('pklId', '==', pkl.id), where('packageName', '==', row.name));
    const snap = await getDocs(q);
    for (const historyDoc of isManual
      ? snap.docs.filter(d => (d.data().packageId || '').startsWith(row.item.id!))
      : snap.docs) {
      await deleteDoc(doc(db, 'loading_histories', historyDoc.id));
    }

    if (isManual) {
      // Xóa khỏi manualItems trên PKL
      const currentManual = (pkl as any).manualItems || [];
      const updatedManual = currentManual.filter((m: any) => m.id !== row.item.id);
      await updateDoc(pklRef, { manualItems: updatedManual });
    } else {
      // Xóa khỏi scanQRItems trên PKL
      const currentScanQR = (pkl as any).scanQRItems || [];
      const updatedScanQR = currentScanQR.filter((s: any) => s.id !== row.item.id);
      await updateDoc(pklRef, { scanQRItems: updatedScanQR });
      syncItemLoadedStatus(row.item.name || row.name, false, '', row.projectCode || pkl.projectId || '', pkl.pklCode, pkl.id);
      syncInstanceLoadInfo(row.item.name || row.name, row.item.instanceIndex, row.projectCode || pkl.projectId || '', null, projectEntries);
    }

    // Xóa khỏi gridData
    setGridData(prev => prev.filter(r => r.id !== row.id));
    showSuccess(`Đã xóa "${row.name}" khỏi danh sách lên xe.`);
  };

  // Đóng context menu khi click ngoài
  useEffect(() => {
    if (!contextMenu) return;
    const handleClick = () => setContextMenu(null);
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [contextMenu]);

  const handleSave = async () => {
    const changes = gridData.filter(row => {
      const initial = initialGridData.find(i => i.id === row.id);
      if (!initial) return true;
      return row.totalPackedQty !== initial.totalPackedQty || row.name !== initial.name || row.projectCode !== initial.projectCode;
    });
    if (changes.length === 0) {
      showSuccess('Không có thay đổi nào cần lưu.');
      return;
    }

    setLoading(true);
    skipNextEffectRef.current = true;
    try {
      const displayLabel = userProfile?.ten_that
        ? `${userProfile.ten_that} (${userProfile.chuc_danh || 'NV'})`
        : (user?.displayName || 'Anonymous');

      // ── Phase 1: Collect all writes into a batch ──
      let batch = writeBatch(db);
      let batchCount = 0;
      // Build scanQRItems từ gridData hiện tại (không dùng pkl.scanQRItems stale)
      const nonManualRows = gridData.filter(row => !row.item.id?.startsWith('manual_'));
      let newScanQRItems = nonManualRows.map(row => ({
        id: row.item.id,
        name: row.name,
        cluster: row.cluster || '',
        subType: (row.item as any).subType || 'kienModule',
        rawQR: row.rawQR || row.name,
        projectCode: row.projectCode || pkl.projectId || '',
        projectName: row.projectName || pkl.projectName || '',
      }));
      const syncPromises: Promise<void>[] = [];

      const flushBatch = async () => {
        if (batchCount > 0) {
          await batch.commit();
          batch = writeBatch(db);
          batchCount = 0;
        }
      };

      for (const row of changes) {
        const diff = row.totalPackedQty - 0;

        if (diff > 0) {
          for (let i = 0; i < diff; i++) {
            const ref = doc(collection(db, 'loading_histories'));
            batch.set(ref, {
              packageId: `${row.item.id}_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
              packageName: row.name,
              pklId: pkl.id,
              pklCode: pkl.pklCode,
              loadedBy: displayLabel,
              loadedAt: serverTimestamp(),
              verificationImages: [],
              projectCode: row.projectCode,
              projectName: row.projectName
            });
            batchCount++;
          }
          syncPromises.push(
            syncInstanceLoadInfo(row.item.name || row.name, row.item.instanceIndex, row.projectCode || pkl.projectId || '', {
              pklId: pkl.id!,
              pklCode: pkl.pklCode,
              loadedAt: new Date(),
              loadedBy: displayLabel,
              vehicleInfo: pkl.vehicleInfo,
            }, projectEntries)
          );
          if (!row.item.id?.startsWith('manual_') && !newScanQRItems.some((s: any) => s.name === row.name)) {
            newScanQRItems.push({
              id: row.item.id,
              name: row.name,
              cluster: row.cluster || '',
              subType: (row.item as any).subType || 'kienModule',
              rawQR: row.rawQR || row.name,
              projectCode: row.projectCode || pkl.projectId || '',
              projectName: row.projectName || pkl.projectName || '',
            });
            syncPromises.push(
              syncItemLoadedStatus(row.item.name || row.name, true, displayLabel, row.projectCode || pkl.projectId || '', pkl.pklCode, pkl.id)
            );
          }
        } else if (diff < 0) {
          const removeCount = Math.abs(diff);
          const isManual = row.item.id?.startsWith('manual_');
          const q = isManual
            ? query(collection(db, 'loading_histories'), where('pklId', '==', pkl.id))
            : query(collection(db, 'loading_histories'), where('pklId', '==', pkl.id), where('packageName', '==', row.name));
          const snap = await getDocs(q);
          const docsToDelete = isManual
            ? snap.docs.filter(d => (d.data().packageId || '').startsWith(row.item.id!)).slice(0, removeCount)
            : snap.docs.slice(0, removeCount);
          for (const historyDoc of docsToDelete) {
            batch.delete(doc(db, 'loading_histories', historyDoc.id));
            batchCount++;
          }
          newScanQRItems = newScanQRItems.filter((s: any) => s.name !== row.name);
          if (!row.item.id?.startsWith('manual_')) {
            syncPromises.push(
              syncItemLoadedStatus(row.item.name || row.name, false, '', row.projectCode || pkl.projectId || '', pkl.pklCode, pkl.id)
            );
            syncPromises.push(
              syncInstanceLoadInfo(row.item.name || row.name, row.item.instanceIndex, row.projectCode || pkl.projectId || '', null, projectEntries)
            );
          }
        }
      }

      // Save manual items + scanQRItems in one batch
      const manualItems = gridData.filter(row => row.item.id?.startsWith('manual_'));
      const manualPayload = manualItems.map(row => ({
        id: row.item.id,
        name: row.name,
        projectCode: row.projectCode,
        projectName: row.projectName,
        cluster: row.cluster,
        subType: (row.item as any).subType || 'kienModule',
        rawQR: row.rawQR || row.name,
      }));
      batch.update(doc(db, 'loading', pkl.id), { scanQRItems: newScanQRItems, manualItems: manualPayload });
      batchCount++;

      // Commit remaining batch
      await flushBatch();

      // ── Phase 2: Run sync operations in parallel ──
      await Promise.allSettled(syncPromises);

      // Activity log
      await addDoc(collection(db, 'activities'), {
        userId: user?.uid || 'system',
        userName: displayLabel,
        userEmail: user?.email || '',
        action: 'Cập nhật Excel lên xe',
        details: `Cập nhật nhanh excel xếp lên phương tiện cho phiếu Lên Hàng: ${pkl.pklCode} | Tác động ${changes.length} kiện gỗ`,
        projectCode: pkl.projectId,
        timestamp: serverTimestamp()
      });
      showSuccess(`Đã lưu thành công ${changes.length} thay đổi!`);
    } catch (err: any) {
      console.error("Lỗi cập nhật Excel bốc xếp:", err);
      showError("Lỗi hệ thống khi lưu bảng xếp xe: " + err.message);
    } finally {
      setLoading(false);
    }
  };

  const isCthtItem = (row: EditableLoadItem) => {
    const subType = (row.item as any)?.subType;
    return subType === 'kienCTHT';
  };

  // Chi tach section khi co filter loai cu the, con khong thi hien tat ca trong 1 list
  const showSections = typeFilter !== '';
  // Luon hien flat list, typeFilter chi loc du lieu
  return (
    <>
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[110] p-4 backdrop-blur-xs">
      <div className="bg-white w-[96vw] h-[92vh] rounded-xl border border-slate-200 flex flex-col overflow-hidden shadow-2xl">

        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-100 bg-white flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-indigo-100 text-indigo-600 rounded-lg">
              <Truck size={20} />
            </div>
            <div>
              <span className="text-[10px] font-black text-indigo-600 uppercase tracking-widest block">
                Bảng Excel Lên Xe - Phiếu Lên Hàng
              </span>
              <h3 className="text-base font-black text-slate-800 uppercase tracking-tight flex items-center gap-2">
                <span>XẾP XE NHANH:</span>
                <span className="text-indigo-600 font-mono text-sm tracking-wide">{pkl.pklCode}</span>
              </h3>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 bg-white hover:bg-slate-100 text-slate-600 rounded-lg text-[11px] font-black uppercase tracking-widest border border-slate-200 transition-all cursor-pointer"
            >
              Đóng
            </button>
            <button
              disabled={loading}
              onClick={handleSave}
              className="px-5 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:bg-emerald-600/50 text-white rounded-lg text-[11px] font-black uppercase tracking-widest transition-all shadow-md flex items-center justify-center space-x-2 cursor-pointer"
            >
              {loading ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
              <span>Lưu xếp xe ({changedCount})</span>
            </button>
          </div>
        </div>

        {/* Info bar */}
        <div className="px-6 py-2.5 bg-slate-100 border-b border-slate-100 flex items-center justify-between text-[11px] text-slate-500 font-bold">
          <div className="flex items-center gap-1.5 overflow-hidden">
            <Info size={14} className="text-indigo-500 shrink-0" />
            <span className="truncate">Chon kien tu danh sach ben duoi de them vao phieu len hang.</span>
          </div>
          <div className="shrink-0 flex items-center gap-4 text-slate-600">
            <span>Hiển thị: <strong className="text-indigo-600 font-extrabold">{filteredRows.length}/{gridData.length}</strong> kiện</span>
            <span className="text-amber-600 font-black">Có thay đổi: {changedCount} / {gridData.length} dòng</span>
          </div>
        </div>

        {/* Table */}
        <div className="flex-1 min-h-0 bg-slate-100 p-4 flex flex-col">
          <div className="flex-1 min-h-0 w-full bg-white border border-slate-200 rounded-xl shadow-xs flex flex-col overflow-hidden">

            {/* Search + Add manual */}
            <div className="p-3 border-b border-slate-100 bg-white flex items-center gap-3 shrink-0">
              <div className="relative w-full max-w-sm">
                <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-slate-400 pointer-events-none">
                  <Search size={14} />
                </span>
                <input
                  type="text"
                  className="w-full pl-9 pr-8 py-2 text-xs bg-slate-100 border border-slate-100 rounded-lg outline-none focus:border-indigo-500 font-bold uppercase"
                  placeholder="Tìm tên kiện, cụm..."
                  value={searchTerm}
                  onChange={e => setSearchTerm(e.target.value)}
                />
                {searchTerm && (
                  <button onClick={() => setSearchTerm('')} className="absolute inset-y-0 right-0 flex items-center pr-3 text-slate-400 hover:text-slate-600 cursor-pointer">
                    <X size={14} />
                  </button>
                )}
              </div>

              <button
                onClick={() => {
                  setShowManualInput(true);
                }}
                className="px-3 py-2 bg-emerald-100 hover:bg-emerald-200 text-emerald-700 rounded-lg text-[10px] font-black uppercase tracking-wider cursor-pointer flex items-center gap-1.5 shrink-0 border border-emerald-200 transition-all"
              >
                <Plus size={14} />
                Thêm kiện thủ công
              </button>

              {selectedIds.size > 0 && (
                <button
                  onClick={handleBulkDelete}
                  className="px-3 py-2 bg-rose-100 hover:bg-rose-200 text-rose-700 rounded-lg text-[10px] font-black uppercase tracking-wider cursor-pointer flex items-center gap-1.5 shrink-0 border border-rose-200 transition-all"
                >
                  <Trash2 size={14} />
                  Xóa ({selectedIds.size})
                </button>
              )}
            </div>

            {/* Spreadsheet */}
            <div className="flex-1 overflow-auto">
              <table className="w-full border-collapse table-fixed min-w-[1250px]">
                <thead>
                  <tr className="bg-slate-100 text-slate-500 text-[10px] font-black uppercase tracking-wider border-b border-slate-200">
                    <th className="sticky top-0 z-30 w-10 text-center border-r border-slate-300 py-3 bg-slate-100">
                      <input
                        type="checkbox"
                        checked={filteredRows.length > 0 && filteredRows.every(r => selectedIds.has(r.id))}
                        onChange={toggleSelectAll}
                        className="w-4 h-4 text-rose-600 border-slate-300 rounded-lg cursor-pointer"
                      />
                    </th>
                    <th className="sticky top-0 z-30 w-12 text-center border-r border-slate-300 py-3 bg-slate-100">STT</th>
                    <th className="sticky top-0 z-30 w-36 border-r border-slate-300 bg-slate-100">
                      <div className="px-3 py-1.5">
                        <span className="block text-[10px] font-black uppercase tracking-wider text-slate-500 mb-1">DỰ ÁN</span>
                        <select
                          value={projectFilter}
                          onChange={e => setProjectFilter(e.target.value)}
                          className="w-full px-2 py-1 text-[10px] bg-white border border-slate-200 rounded-md outline-none font-black uppercase tracking-wider cursor-pointer"
                        >
                          <option value="">TẤT CẢ</option>
                          {[...new Set(gridData.map(r => r.projectCode).filter(Boolean))].sort().map(code => (
                            <option key={code} value={code}>{formatProjectCode(code)}</option>
                          ))}
                        </select>
                      </div>
                    </th>
                    <th className="sticky top-0 z-30 w-36 border-r border-slate-300 bg-slate-100">
                      <div className="px-3 py-1.5">
                        <span className="block text-[10px] font-black uppercase tracking-wider text-slate-500 mb-1">KIỂU KIỆN</span>
                        <select
                          value={typeFilter}
                          onChange={e => setTypeFilter(e.target.value)}
                          className="w-full px-2 py-1 text-[10px] bg-white border border-slate-200 rounded-md outline-none font-black uppercase tracking-wider cursor-pointer"
                        >
                          <option value="">TẤT CẢ</option>
                          <option value="kienModule">MODULE</option>
                          <option value="kienCTHT">CTHT</option>
                          <option value="kienPhuKien">PHỤ KIỆN</option>
                        </select>
                      </div>
                    </th>
                    <th className="sticky top-0 z-30 w-44 text-left pl-3 border-r border-slate-300 bg-slate-100">Cụm (Cluster)</th>
                    <th className="sticky top-0 z-30 w-[400px] text-left pl-3 border-r border-slate-300 bg-slate-100">Mã / Tên Kiện Hàng</th>
                    <th className="sticky top-0 z-30 w-32 text-center border-r border-slate-300 bg-slate-100">SL ĐÃ ĐÓNG GÓI</th>
                  </tr>
                </thead>
                                <tbody className="divide-y divide-slate-100 text-xs font-semibold">
                  {filteredRows.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-24 text-center">
                        <Package size={44} className="text-slate-300 mx-auto mb-2" />
                        <p className="text-slate-400 text-xs font-black uppercase tracking-wider">Khong tim thai kien da dong goi nao phu hop</p>
                      </td>
                    </tr>
                  ) : (
                    filteredRows.map((row, idx) => {
                      const isDirty = row.totalPackedQty !== 0;
                      const subType = getRowSubType(row);
                      const typeBadge = subType === 'kienCTHT' ? { bg: 'bg-amber-100', text: 'text-amber-700', label: 'CTHT' }
                        : subType === 'kienPhuKien' ? { bg: 'bg-violet-100', text: 'text-violet-700', label: 'PK' }
                        : { bg: 'bg-blue-100', text: 'text-blue-700', label: 'MOD' };
                      return (
                        <tr key={row.id} className={`hover:bg-slate-100/70 transition-colors ${isDirty ? 'bg-amber-100/30' : ''} ${selectedIds.has(row.id) ? 'bg-rose-50/50' : ''}`}>
                          <td className="text-center py-2.5 border-r border-slate-200">
                            <input type="checkbox" checked={selectedIds.has(row.id)} onChange={() => toggleSelectRow(row.id)} className="w-4 h-4 text-rose-600 border-slate-300 rounded-lg cursor-pointer" />
                          </td>
                          <td className="text-center py-2.5 border-r border-slate-200 text-slate-400 font-mono text-[10px] select-none cursor-pointer"
                            onContextMenu={(e) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, row }); }}
                          >{idx + 1}</td>
                          <td className="p-3 border-r border-slate-200">
                            <span className="px-2 py-1 text-[9px] font-black uppercase bg-indigo-100 text-indigo-800 rounded-lg border border-indigo-100">{formatProjectCode(row.projectCode)}</span>
                          </td>
                          <td className="p-3 border-r border-slate-200">
                            <span className={`px-1.5 py-0.5 text-[8px] font-black uppercase rounded ${typeBadge.bg} ${typeBadge.text}`}>{typeBadge.label}</span>
                          </td>
                          <td className="p-3 border-slate-200 text-slate-500 uppercase font-black text-[10px] truncate">{row.cluster || "---"}</td>
                          <td className="p-3 border-r border-slate-200">
                            <span className="font-mono font-black text-slate-900 uppercase truncate block" title={row.name}>{row.name}</span>
                            {row.rawQR && (
                              <span className="block text-[9px] font-mono text-slate-400 truncate" title={row.rawQR}>{(row.rawQR || '').replace(/----.*----/, '').trim()}</span>
                            )}
                          </td>
                          <td className="text-center border-r border-slate-200 font-mono font-black text-[11px]">{row.totalPackedQty}</td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>

    {/* Context menu chuột phải trên STT */}
    {contextMenu && (
      <div
        className="fixed z-[300] bg-white border border-slate-200 rounded-xl shadow-2xl py-1.5 min-w-[240px]"
        style={{ left: contextMenu.x, top: contextMenu.y }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-3 py-2 border-b border-slate-100">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider">Kiện: {contextMenu.row.name}</p>
         
        </div>
        <button
          onClick={() => handleRemoveFromPkl(contextMenu.row)}
          className={`w-full px-3 py-2 text-left text-xs font-bold flex items-center gap-2 cursor-pointer transition-colors ${
            false
              ? 'text-amber-600 hover:bg-amber-50'
              : 'text-rose-600 hover:bg-rose-50'
          }`}
        >
          <Trash2 size={14} />
          {false ? 'Gỡ kiện đã lên xe' : 'Xóa khỏi danh sách lên xe'}
        </button>
      </div>
    )}

    {/* Modal thêm kiện thủ công */}
    {showManualInput && (
      <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[200] p-4 backdrop-blur-sm">
        <div className="bg-white w-full max-w-4xl rounded-xl shadow-2xl overflow-hidden flex flex-col border border-slate-200 max-h-[85vh]">
          {/* Header */}
          <div className="px-5 py-4 border-b border-slate-100 bg-white flex items-center justify-between">
            <h3 className="text-sm font-black text-slate-800 uppercase tracking-tight">Thêm kiện thủ công</h3>
            <button onClick={() => setShowManualInput(false)} className="p-1.5 text-slate-400 hover:text-rose-500 transition-colors cursor-pointer">
              <X size={18} />
            </button>
          </div>

          {/* Filters */}
          <div className="px-5 py-3 border-b border-slate-100 bg-slate-50 flex items-center gap-3">
            <select
              value={addModalProject}
              onChange={e => { setAddModalProject(e.target.value); setAddModalCluster(''); }}
              className="px-3 py-2 text-[10px] bg-white border border-slate-200 rounded-lg outline-none font-black uppercase tracking-wider cursor-pointer flex-1"
            >
              <option value="">TẤT CẢ DỰ ÁN</option>
              {[...new Set(allPackingItems.map(i => i.projectCode).filter(Boolean))].sort().map(code => (
                <option key={code} value={code}>{formatProjectCode(code)}</option>
              ))}
            </select>

            <select
              value={addModalCluster}
              onChange={e => setAddModalCluster(e.target.value)}
              className="px-3 py-2 text-[10px] bg-white border border-slate-200 rounded-lg outline-none font-black uppercase tracking-wider cursor-pointer flex-1"
            >
              <option value="">TẤT CẢ CỤM</option>
              {[...new Set(
                allPackingItems
                  .filter(i => !addModalProject || i.projectCode === addModalProject)
                  .map(i => i.item.cluster)
                  .filter(Boolean)
              )].sort().map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>

            <select
              value={addModalType}
              onChange={e => setAddModalType(e.target.value)}
              className="px-3 py-2 text-[10px] bg-white border border-slate-200 rounded-lg outline-none font-black uppercase tracking-wider cursor-pointer flex-1"
            >
              <option value="">TẤT CẢ KIỂU</option>
              <option value="kienModule">MODULE</option>
              <option value="kienCTHT">CTHT</option>
              <option value="kienPhuKien">PHỤ KIỆN</option>
            </select>

            <div className="relative flex-1">
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={addModalSearch}
                onChange={e => setAddModalSearch(e.target.value)}
                placeholder="Tìm tên kiện..."
                className="w-full pl-8 pr-3 py-2 text-xs bg-white border border-slate-200 rounded-lg outline-none font-bold uppercase"
              />
            </div>
          </div>

          {/* Item list */}
          <div className="flex-1 overflow-y-auto p-4 space-y-2">              {(() => {
                const filtered = allPackingItems.filter(entry => {
                  const item = entry.item;
                  if (addModalProject && entry.projectCode !== addModalProject) return false;
                  if (addModalCluster && item.cluster !== addModalCluster) return false;
                  if (addModalType && getEntrySubType(entry) !== addModalType) return false;
                  if (addModalSearch) {
                    const s = addModalSearch.toLowerCase();
                    const rawQr = ((item as any).rawQR || (item as any).rawQr || '').toLowerCase();
                    if (!(item.name || '').toLowerCase().includes(s) && !(item.cluster || '').toLowerCase().includes(s) && !rawQr.includes(s)) return false;
                  }
                  // Ẩn kiện đã có trong PKL (so theo khóa đầy đủ id/tên + cụm + dự án, không theo tên đơn thuần)
                  if (isEntryExisting(entry)) return false;
                  return true;
                });

              const seen = new Set<string>();
              const unique = filtered.filter(entry => {
                const key = (entry.item.id || entry.item.name || '').toLowerCase() + '|' + (entry.packingDocId || '') + '|' + getEntrySubType(entry);
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
              });

              if (unique.length === 0) {
                return <div className="py-12 text-center text-slate-400 text-xs font-bold">Không tìm thấy kiện phù hợp</div>;
              }

              return unique.map((entry, idx) => {
                const item = entry.item;
                const instanceMatch = (item.name || '').match(/#(\d+)\/(\d+)/);
                const instanceNum = instanceMatch ? instanceMatch[1] : null;
                const totalInstances = instanceMatch ? instanceMatch[2] : null;

                return (
                  <div key={idx} className="flex items-center gap-3 p-3 bg-slate-50 rounded-lg border border-slate-100 hover:bg-indigo-50 hover:border-indigo-200 transition-all cursor-pointer group"
                    onClick={() => handleAddManualItem(entry)}>
                    {/* Cột Dự án */}
                    <div className="w-20 shrink-0">
                      <span className="text-[9px] font-mono font-black text-indigo-700 bg-indigo-50 border border-indigo-100 px-1.5 py-0.5 rounded truncate block">{formatProjectCode(entry.projectCode)}</span>
                    </div>
                    {/* Cột Cụm */}
                    <div className="w-24 shrink-0">
                      <span className="text-[9px] font-bold text-slate-500 truncate block">{item.cluster || '—'}</span>
                    </div>
                    {/* Cột Tên kiện */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <div className="w-6 h-6 bg-indigo-100 text-indigo-600 rounded flex items-center justify-center shrink-0 text-[8px] font-black">
                          {instanceNum ? `#${instanceNum}` : <Package size={10} />}
                        </div>
                        <p className="text-xs font-black text-slate-800 truncate">{item.name}</p>
                      </div>
                    </div>
                    {/* Cột SL + Nút thêm */}
                    <div className="flex items-center gap-2 shrink-0">
                      {totalInstances && <span className="text-[9px] text-indigo-500 font-black">{instanceNum}/{totalInstances}</span>}
                      <span className="text-[9px] font-black text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full">×{item.quantity || 1}</span>
                      <Plus size={14} className="text-indigo-400 group-hover:text-indigo-600 transition-colors" />
                    </div>
                  </div>
                );
              });
            })()}
          </div>

          {/* Footer */}
          <div className="px-5 py-3 border-t border-slate-100 bg-slate-50 flex items-center justify-between">
            <button
              onClick={() => {
                const filtered = allPackingItems.filter(entry => {
                  const item = entry.item;
                  if (addModalProject && entry.projectCode !== addModalProject) return false;
                  if (addModalCluster && item.cluster !== addModalCluster) return false;
                  if (addModalType && getEntrySubType(entry) !== addModalType) return false;
                  if (addModalSearch) {
                    const s = addModalSearch.toLowerCase();
                    const rawQr = ((item as any).rawQR || (item as any).rawQr || '').toLowerCase();
                    if (!(item.name || '').toLowerCase().includes(s) && !(item.cluster || '').toLowerCase().includes(s) && !rawQr.includes(s)) return false;
                  }
                  if (isEntryExisting(entry)) return false;
                  return true;
                });
                const seen = new Set<string>();
                const unique = filtered.filter(entry => {
                  const key = (entry.item.id || entry.item.name || '').toLowerCase() + '|' + (entry.packingDocId || '') + '|' + getEntrySubType(entry);
                  if (seen.has(key)) return false;
                  seen.add(key);
                  return true;
                });
                unique.forEach(entry => handleAddManualItem(entry));
              }}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-black text-[10px] uppercase tracking-widest rounded-lg transition-all cursor-pointer active:scale-95 flex items-center gap-1.5"
            >
              <Plus size={12} />
              Thêm toàn bộ ({(() => {
                const filtered = allPackingItems.filter(entry => {
                  const item = entry.item;
                  if (addModalProject && entry.projectCode !== addModalProject) return false;
                  if (addModalCluster && item.cluster !== addModalCluster) return false;
                  if (addModalType && getEntrySubType(entry) !== addModalType) return false;
                  if (addModalSearch) {
                    const s = addModalSearch.toLowerCase();
                    const rawQr = ((item as any).rawQR || (item as any).rawQr || '').toLowerCase();
                    if (!(item.name || '').toLowerCase().includes(s) && !(item.cluster || '').toLowerCase().includes(s) && !rawQr.includes(s)) return false;
                  }
                  if (isEntryExisting(entry)) return false;
                  return true;
                });
                const seen = new Set<string>();
                return filtered.filter(entry => {
                  const key = (entry.item.id || entry.item.name || '').toLowerCase() + '|' + (entry.packingDocId || '') + '|' + getEntrySubType(entry);
                  if (seen.has(key)) return false;
                  seen.add(key);
                  return true;
                }).length;
              })()})
            </button>
            <button onClick={() => setShowManualInput(false)} className="px-4 py-2 text-slate-500 font-black text-[10px] uppercase tracking-widest hover:text-slate-700 transition-colors cursor-pointer">
              Đóng
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}
