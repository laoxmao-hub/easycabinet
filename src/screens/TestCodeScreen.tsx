/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect } from 'react';
import { motion } from 'motion/react';
import { Beaker, Play, CheckCircle, AlertCircle, Loader2, ArrowLeft, Trash2, FileSpreadsheet, Upload, Layers, Search, Database, Info, ExternalLink, Printer, Terminal, Code2, Sparkles, RefreshCw, Boxes, Image as ImageIcon, ClipboardCheck, X, QrCode } from 'lucide-react';
import { collection, getDocs, writeBatch, doc, deleteField, query, where, serverTimestamp, addDoc, updateDoc, getDoc } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType, cleanUndefinedFields } from '../lib/firebase';
import { ProjectEntry, Accessory, PackingList, PackingItem, getModuleInstances, getModuleQcAggregate } from '../types';
import { formatProjectCode, formatProjectName } from '../lib/formatters';
import * as XLSX from 'xlsx';
import { useAuth } from '../lib/AuthContext';
import { autoPassBuForPackage, autoPassBuForVirtualCTHT } from '../lib/qcPassBu';
import { findProjectConfigId } from '../lib/dualWrite';
import { getEntryType } from './ProjectManagementScreen';

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

const normalizeAccessoryName = (name: string): string => {
  return (name || '')
    .toLowerCase()
    .replace(/đ/g, 'd')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
};

// Component migrate collection packing_lists → loading
function MigrateCollectionButton() {
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [result, setResult] = useState<{ success: number; failed: number; errors: string[] } | null>(null);

  const handleMigrate = async () => {
    if (!confirm('Copy toàn bộ documents từ collection "packing_lists" sang "loading"?\n\nLưu ý: Document trùng ID sẽ bị ghi đè.')) return;

    setLoading(true);
    setResult(null);
    setProgress(null);

    try {
      // Đọc source collection
      const sourceSnap = await getDocs(collection(db, 'packing_lists'));
      if (sourceSnap.empty) {
        setResult({ success: 0, failed: 0, errors: ['Collection "packing_lists" trống hoặc không tồn tại'] });
        setLoading(false);
        return;
      }

      const total = sourceSnap.size;
      setProgress({ current: 0, total });

      let success = 0;
      let failed = 0;
      const errors: string[] = [];
      let batch = writeBatch(db);
      let count = 0;

      for (const docSnap of sourceSnap.docs) {
        try {
          const targetRef = doc(db, 'loading', docSnap.id);
          batch.set(targetRef, docSnap.data());
          count++;
          success++;

          // Commit mỗi 500 documents (Firestore limit)
          if (count % 500 === 0) {
            await batch.commit();
            setProgress({ current: success, total });
            batch = writeBatch(db);
          }
        } catch (err: any) {
          failed++;
          errors.push(`${docSnap.id}: ${err.message || err}`);
        }
      }

      // Commit phần còn lại
      if (count % 500 !== 0) {
        await batch.commit();
      }

      setProgress({ current: success, total });
      setResult({ success, failed, errors });
    } catch (err: any) {
      setResult({ success: 0, failed: 1, errors: [err.message || 'Lỗi không xác định'] });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-3">
      <button
        onClick={handleMigrate}
        disabled={loading}
        className="w-full px-5 py-3 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg text-xs font-black uppercase tracking-wider transition-all flex items-center justify-center gap-2 cursor-pointer active:scale-95"
      >
        {loading ? <Loader2 size={14} className="animate-spin" /> : <Database size={14} />}
        <span>{loading ? 'Đang migrate...' : 'Chạy migrate ngay'}</span>
      </button>

      {progress && (
        <div className="space-y-2">
          <div className="flex justify-between text-[10px] font-black text-slate-500 uppercase">
            <span>Tiến độ</span>
            <span>{progress.current}/{progress.total}</span>
          </div>
          <div className="w-full bg-slate-200 h-2 rounded-full overflow-hidden">
            <div
              className="bg-blue-600 h-full rounded-full transition-all duration-300"
              style={{ width: `${progress.total > 0 ? (progress.current / progress.total) * 100 : 0}%` }}
            />
          </div>
        </div>
      )}

      {result && (
        <div className={`p-4 rounded-lg border text-xs font-bold uppercase space-y-1.5 ${
          result.failed > 0 ? 'bg-amber-50 border-amber-200 text-amber-800' : 'bg-emerald-50 border-emerald-200 text-emerald-800'
        }`}>
          <p>Thành công: {result.success} documents</p>
          {result.failed > 0 && <p>Lỗi: {result.failed} documents</p>}
          {result.errors.length > 0 && (
            <div className="text-[10px] font-normal normal-case max-h-24 overflow-y-auto">
              {result.errors.slice(0, 20).map((e, i) => <div key={i}>• {e}</div>)}
            </div>
          )}
          {result.failed === 0 && result.success > 0 && (
            <p className="text-[10px] font-normal normal-case text-emerald-700">
              Hoàn tất! Hãy xóa collection "packing_lists" trên Firebase Console.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function TestCodeScreen() {
  const { user, userProfile } = useAuth();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{
    total: number;
    updated: number;
    skipped: number;
    error?: string;
  } | null>(null);

  // --- KHO VẬT TƯ IMPORT EXCEL STATES ---
  const [warehouseImportLoading, setWarehouseImportLoading] = useState(false);
  const [warehouseImportResult, setWarehouseImportResult] = useState<{
    total: number;
    successCount: number;
    errorCount: number;
    errors: string[];
  } | null>(null);
  const [warehouseImportFile, setWarehouseImportFile] = useState<File | null>(null);
  const warehouseFileInputRef = useRef<HTMLInputElement>(null);

  // --- CLOUDINARY CLEANUP STATES ---
  const [cloudinaryLoading, setCloudinaryLoading] = useState(false);
  const [cloudinaryResult, setCloudinaryResult] = useState<{
    totalCloudinary: number;
    usedUrls: number;
    orphanCount: number;
    orphanIds: string[];
    scannedCollections: string[];
  } | null>(null);
  const [cloudinaryDeleting, setCloudinaryDeleting] = useState(false);
  const [cloudinaryDeleteResult, setCloudinaryDeleteResult] = useState<{ deleted: number; failed: number; errors: string[] } | null>(null);

  // --- THEM rawQR vao loading_histories ---
  const [rawQrPklList, setRawQrPklList] = useState<any[]>([]);
  const [rawQrSelectedPkl, setRawQrSelectedPkl] = useState('');
  const [rawQrLoading, setRawQrLoading] = useState(false);
  const [rawQrResult, setRawQrResult] = useState<{ total: number; updated: number; skipped: number; errors: string[] } | null>(null);

  useEffect(() => {
    const loadPkl = async () => {
      const snap = await getDocs(collection(db, 'loading'));
      setRawQrPklList(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    };
    loadPkl();
  }, []);

  const handleInsertRawQr = async () => {
    if (!rawQrSelectedPkl) return;
    setRawQrLoading(true);
    setRawQrResult(null);

    try {
      const pklSnap = await getDoc(doc(db, 'loading', rawQrSelectedPkl));
      if (!pklSnap.exists()) {
        setRawQrResult({ total: 0, updated: 0, skipped: 0, errors: ['Phieu PKL khong ton tai'] });
        setRawQrLoading(false);
        return;
      }

      const pklData = pklSnap.data();
      const manualItems = (pklData as any).manualItems || [];
      const packageIds = pklData.packageIds || [];

      // Lay tat ca packing items
      const packingSnap = await getDocs(collection(db, 'packing'));
      const packingItems: Record<string, any> = {};
      packingSnap.docs.forEach(doc => {
        const list = doc.data();
        (list.items || []).forEach((item: any) => {
          packingItems[item.id] = { ...item, packingDocId: doc.id, projectCode: list.projectCode, projectName: list.projectName };
        });
      });

      let updated = 0;
      let skipped = 0;
      const errors: string[] = [];

      // 1. Cap nhat manualItems trong PKL
      const updatedManualItems = manualItems.map((item: any) => {
        if (item.rawQR) { skipped++; return item; }
        const pkgItem = packingItems[item.id] || packingItems[item.id?.split('_')[0]];
        if (pkgItem?.name) {
          updated++;
          const bc = pkgItem.name.includes('#') ? pkgItem.name.split('#')[0].trim() : pkgItem.name;
          const isCthtItem = pkgItem.subType === 'kienCTHT';
          const qrt = isCthtItem && pkgItem.id ? `${pkgItem.id}|${pkgItem.name}` : bc;
          return { ...item, rawQR: qrt };
        }
        skipped++;
        errors.push(`Khong tim thay rawQR cho manual item: ${item.name}`);
        return item;
      });

      // 2. Cap nhat packageIds items trong PKL - them rawQR vao manualItems
      for (const pkgId of packageIds) {
        if (pkgId.startsWith('manual_')) continue;
        const pkgItem = packingItems[pkgId] || packingItems[pkgId?.split('_')[0]];
        if (!pkgItem) {
          errors.push(`Khong tim thay packing item cho ID: ${pkgId}`);
          skipped++;
          continue;
        }
        // Kiem tra da co trong manualItems chua
        const existsInManual = updatedManualItems.some((m: any) => m.id === pkgId || m.name === pkgItem.name);
        if (existsInManual) { skipped++; continue; }

        if (pkgItem.name && !pkgItem.rawQR) {
          const bc2 = pkgItem.name.includes('#') ? pkgItem.name.split('#')[0].trim() : pkgItem.name;
          const isCtht2 = pkgItem.subType === 'kienCTHT';
          const qrt2 = isCtht2 && pkgItem.id ? `${pkgItem.id}|${pkgItem.name}` : bc2;
          updatedManualItems.push({
            id: pkgId,
            name: pkgItem.name,
            rawQR: qrt2,
            projectCode: pkgItem.projectCode || '',
            projectName: pkgItem.projectName || '',
            subType: pkgItem.subType || 'kienModule'
          });
        } else {
          skipped++;
        }
      }

      // 3. Luu lai vao Firestore
      await updateDoc(doc(db, 'loading', rawQrSelectedPkl), { manualItems: updatedManualItems });

      setRawQrResult({ total: manualItems.length + packageIds.length, updated, skipped, errors });
    } catch (err: any) {
      setRawQrResult({ total: 0, updated: 0, skipped: 0, errors: [err.message] });
    } finally {
      setRawQrLoading(false);
    }
  };

  const handleCloudinaryCleanup = async () => {
    setCloudinaryLoading(true);
    setCloudinaryResult(null);
    setCloudinaryDeleteResult(null);

    try {
      // Bước 1: Thu thập toàn bộ URL ảnh từ Firestore
      const allUrls = new Set<string>();
      const collections = ['projects', 'projectConfigs', 'packing', 'materials', 'qc_tickets', 'shipping_orders', 'users'];
      const scannedCollections: string[] = [];

      for (const colName of collections) {
        try {
          const snap = await getDocs(collection(db, colName));
          scannedCollections.push(colName);
          const docsToProcess = [...snap.docs];
          
          if (colName === 'projectConfigs') {
            for (const docSnap of snap.docs) {
              try {
                const subSnap = await getDocs(collection(db, 'projectConfigs', docSnap.id, 'modules'));
                docsToProcess.push(...subSnap.docs);
              } catch (subErr) {
                console.error(`Lỗi khi đọc modules cho projectConfig ${docSnap.id}:`, subErr);
              }
            }
          }

          docsToProcess.forEach(d => {
            const data = d.data();
            const extractUrls = (obj: any, prefix = '') => {
              if (!obj || typeof obj !== 'object') return;
              for (const [key, val] of Object.entries(obj)) {
                if (typeof val === 'string' && val.includes('cloudinary.com')) {
                  allUrls.add(val);
                } else if (Array.isArray(val)) {
                  val.forEach((item: any) => {
                    if (typeof item === 'string' && item.includes('cloudinary.com')) allUrls.add(item);
                    else if (typeof item === 'object') extractUrls(item, `${prefix}${key}.`);
                  });
                } else if (typeof val === 'object' && val !== null) {
                  extractUrls(val, `${prefix}${key}.`);
                }
              }
            };
            extractUrls(data);

            // instances array
            if (data.instances && Array.isArray(data.instances)) {
              data.instances.forEach((inst: any) => extractUrls(inst, 'instances.'));
            }
          });
        } catch (e) {
          // collection might not exist
        }
      }

      // Bước 2: Lấy toàn bộ ảnh từ Cloudinary
      let allCloudinaryResources: { public_id: string; secure_url: string }[] = [];
      let nextCursor: string | undefined;
      do {
        const url = `/api/cloudinary/list?max_results=500${nextCursor ? `&next_cursor=${nextCursor}` : ''}`;
        const resp = await fetch(url);
        const data = await resp.json();
        if (!data.success) throw new Error(data.error || 'Failed to list Cloudinary resources');
        allCloudinaryResources = allCloudinaryResources.concat(data.resources);
        nextCursor = data.next_cursor;
      } while (nextCursor);

      // Bước 3: So sánh — tìm ảnh trên Cloudinary nhưng không có URL nào trong Firestore match
      const usedUrls = new Set<string>();
      const orphanIds: string[] = [];

      for (const resource of allCloudinaryResources) {
        const isUsed = Array.from(allUrls).some(url => url.includes(resource.public_id));
        if (isUsed) {
          usedUrls.add(resource.public_id);
        } else {
          orphanIds.push(resource.public_id);
        }
      }

      setCloudinaryResult({
        totalCloudinary: allCloudinaryResources.length,
        usedUrls: usedUrls.size,
        orphanCount: orphanIds.length,
        orphanIds,
        scannedCollections,
      });
    } catch (err: any) {
      setCloudinaryResult({
        totalCloudinary: 0,
        usedUrls: 0,
        orphanCount: 0,
        orphanIds: [],
        scannedCollections: [],
      });
      alert('Lỗi quét Cloudinary: ' + (err.message || String(err)));
    } finally {
      setCloudinaryLoading(false);
    }
  };

  const handleDeleteOrphanImages = async () => {
    if (!cloudinaryResult || cloudinaryResult.orphanIds.length === 0) return;
    if (!confirm(`Xác nhận xóa ${cloudinaryResult.orphanIds.length} ảnh thừa trên Cloudinary?`)) return;

    setCloudinaryDeleting(true);
    setCloudinaryDeleteResult(null);

    try {
      const BATCH_SIZE = 20;
      let deleted = 0;
      let failed = 0;
      const errors: string[] = [];

      for (let i = 0; i < cloudinaryResult.orphanIds.length; i += BATCH_SIZE) {
        const batch = cloudinaryResult.orphanIds.slice(i, i + BATCH_SIZE);
        const resp = await fetch('/api/cloudinary/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ publicIds: batch }),
        });
        const data = await resp.json();
        if (data.success && data.results) {
          data.results.forEach((r: any) => {
            if (r.result === 'ok') deleted++;
            else { failed++; errors.push(`${r.id}: ${r.error || r.result}`); }
          });
        } else {
          failed += batch.length;
          errors.push(data.error || 'Unknown error');
        }
      }

      setCloudinaryDeleteResult({ deleted, failed, errors });
    } catch (err: any) {
      setCloudinaryDeleteResult({ deleted: 0, failed: cloudinaryResult.orphanIds.length, errors: [err.message || String(err)] });
    } finally {
      setCloudinaryDeleting(false);
    }
  };

  const handleWarehouseExcelUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setWarehouseImportFile(file);
      setWarehouseImportResult(null);
    }
  };

  const executeWarehouseImport = async () => {
    if (!warehouseImportFile) {
      alert("Vui lòng chọn file Excel!");
      return;
    }
    setWarehouseImportLoading(true);
    setWarehouseImportResult(null);

    try {
      const reader = new FileReader();
      reader.onload = async (evt) => {
        try {
          const bstr = evt.target?.result;
          const workbook = XLSX.read(bstr, { type: 'binary' });
          const sheetName = workbook.SheetNames[0];
          const worksheet = workbook.Sheets[sheetName];
          const rawData = XLSX.utils.sheet_to_json(worksheet) as any[];

          if (!rawData || rawData.length === 0) {
            throw new Error("File Excel trống hoặc không đúng định dạng!");
          }

          let successCount = 0;
          let errorCount = 0;
          const errors: string[] = [];
          const processedNames = new Set<string>();

          // Tải toàn bộ vật tư hiện tại
          const materialsRef = collection(db, 'materials');
          const materialsSnap = await getDocs(materialsRef);
          const existingMaterials = materialsSnap.docs.map(docSnap => ({
            id: docSnap.id,
            ...docSnap.data()
          })) as any[];

          const nameToMaterialMap = new Map<string, any>();
          existingMaterials.forEach(m => {
            if (m.name) {
              nameToMaterialMap.set(m.name.trim().toLowerCase(), m);
            }
          });

          // Tìm mã lớn nhất
          let maxNum = 0;
          existingMaterials.forEach(m => {
            const code = m.code || '';
            const numPart = code.replace('MAT-', '');
            const parsed = parseInt(numPart, 10);
            if (!isNaN(parsed) && parsed > maxNum) {
              maxNum = parsed;
            }
          });

          let batch = writeBatch(db);
          let opCount = 0;
          const nextTransactions: any[] = [];
          
          for (let i = 0; i < rawData.length; i++) {
            const row = rawData[i];
            const rowNum = i + 2;

            const nameRaw = row['Tên vật tư'] || row['Tên Vật Tư'] || row['materialName'] || row['Ten vat tu'] || row['Tên Vật tư'];
            const unitRaw = row['DVT'] || row['unit'] || row['Đơn vị tính'] || row['Đơn Vị Tính'] || 'Cái';
            const stockRaw = row['Tồn Cuối Kỳ'] || row['Tồn cuối kỳ'] || row['currentStock'] || row['Tồn Cuối'] || row['Tồn Cuối kỳ'] || 0;

            const name = typeof nameRaw === 'string' ? nameRaw.trim() : String(nameRaw || '').trim();
            const unit = typeof unitRaw === 'string' ? unitRaw.trim() : String(unitRaw || '').trim();
            const currentStock = Number(stockRaw) || 0;

            if (!name) {
              errorCount++;
              errors.push(`Dòng ${rowNum}: Thiếu tên vật tư.`);
              continue;
            }

            const nameLC = name.toLowerCase();
            if (processedNames.has(nameLC)) {
              errorCount++;
              errors.push(`Dòng ${rowNum}: Tên vật tư "${name}" bị lặp trong file excel.`);
              continue;
            }
            processedNames.add(nameLC);

            const existingMat = nameToMaterialMap.get(nameLC);
            if (existingMat) {
              const stockBefore = existingMat.currentStock || 0;
              const stockAfter = currentStock;
              const diff = stockAfter - stockBefore;

              const matDocRef = doc(db, 'materials', existingMat.id);
              batch.update(matDocRef, {
                currentStock: stockAfter,
                unit: unit
              });
              successCount++;
              opCount++;

              nextTransactions.push({
                materialId: existingMat.id,
                materialName: name,
                materialCode: existingMat.code,
                unit,
                type: 'IMPORT_INITIAL',
                quantity: diff,
                stockBefore,
                stockAfter,
                note: `Cập nhật tồn kho bằng excel (File: ${warehouseImportFile.name})`,
                createdBy: userProfile?.displayName || 'Thủ kho',
                createdByEmail: userProfile?.email || 'vattu@dracox.com',
                createdAt: new Date().toISOString()
              });
            } else {
              maxNum++;
              const newCode = `MAT-${String(maxNum).padStart(5, '0')}`;
              const newMatRef = doc(collection(db, 'materials'));

              batch.set(newMatRef, {
                code: newCode,
                name,
                unit,
                category: 'Khác',
                currentStock,
                minStock: 5,
                status: 'active',
                createdAt: new Date().toISOString()
              });
              successCount++;
              opCount++;

              nextTransactions.push({
                materialId: newMatRef.id,
                materialName: name,
                materialCode: newCode,
                unit,
                type: 'IMPORT_INITIAL',
                quantity: currentStock,
                stockBefore: 0,
                stockAfter: currentStock,
                note: `Khởi tạo số tồn ban đầu bằng excel (File: ${warehouseImportFile.name})`,
                createdBy: userProfile?.displayName || 'Thủ kho',
                createdByEmail: userProfile?.email || 'vattu@dracox.com',
                createdAt: new Date().toISOString()
              });
            }

            if (opCount >= 400) {
              await batch.commit();
              batch = writeBatch(db);
              opCount = 0;
            }
          }

          if (opCount > 0) {
            await batch.commit();
          }

          // Ghi các transaction biến thiên
          let txBatch = writeBatch(db);
          let txOpCount = 0;
          for (const tx of nextTransactions) {
            const txRef = doc(collection(db, 'stockTransactions'));
            txBatch.set(txRef, tx);
            txOpCount++;
            if (txOpCount >= 400) {
              await txBatch.commit();
              txBatch = writeBatch(db);
              txOpCount = 0;
            }
          }
          if (txOpCount > 0) {
            await txBatch.commit();
          }

          // Log hoạt động chung
          await addDoc(collection(db, 'activities'), {
            userId: userProfile?.uid || 'system',
            userName: userProfile?.displayName || 'Thủ kho',
            userEmail: userProfile?.email || 'admin@dracox2.com',
            action: 'Import Excel Vật Tư Kho',
            details: `Đã nhập và đồng bộ kho hàng thành công từ tệp "${warehouseImportFile.name}". Thành công: ${successCount} dòng, Lỗi: ${errorCount} dòng.`,
            projectCode: 'KHO_VATTU',
            timestamp: serverTimestamp()
          });

          setWarehouseImportResult({
            total: rawData.length,
            successCount,
            errorCount,
            errors
          });

          if (warehouseFileInputRef.current) {
            warehouseFileInputRef.current.value = '';
          }
          setWarehouseImportFile(null);
        } catch (ex: any) {
          console.error(ex);
          alert(`Lỗi phân tích file Excel: ${ex.message || String(ex)}`);
        } finally {
          setWarehouseImportLoading(false);
        }
      };
      reader.readAsBinaryString(warehouseImportFile);
    } catch (err: any) {
      console.error(err);
      alert(`Lỗi: ${err.message || String(err)}`);
      setWarehouseImportLoading(false);
    }
  };

  const [paintLoading, setPaintLoading] = useState(false);
  const [paintResult, setPaintResult] = useState<{
    total: number;
    inserted: number;
    updated: number;
    error?: string;
  } | null>(null);
  
  const [excelPreviewData, setExcelPreviewData] = useState<{
    moduleCode: string;
    dai: number;
    rong: number;
    day: number;
    classification: 'Cánh' | 'Mặt HK' | 'CTHT';
    material: string;
    quantity: number;
  }[]>([]);
  
  const [existingProjects, setExistingProjects] = useState<{ projectCode: string; projectName: string; displayCode?: string; configId?: string }[]>([]);
  const [selectedProjectCode, setSelectedProjectCode] = useState<string>('auto');

  // Firebase Backup (Export & Import) States
  const [exportLoading, setExportLoading] = useState(false);
  const [exportResult, setExportResult] = useState<{ success: boolean; timestamp?: Date; error?: string } | null>(null);
  
  const [importLoading, setImportLoading] = useState(false);
  const [importResult, setImportResult] = useState<{ success: boolean; importedCount?: number; deletedCount?: number; error?: string } | null>(null);
  const [importPreview, setImportPreview] = useState<Record<string, any[]> | null>(null);
  const [selectedCollections, setSelectedCollections] = useState<string[]>([]);
  const [importMode, setImportMode] = useState<'merge' | 'nuke'>('merge');
  const importFileInputRef = useRef<HTMLInputElement>(null);

  const [showConfirmFastPass, setShowConfirmFastPass] = useState(false);
  const [showConfirmResetQc, setShowConfirmResetQc] = useState(false);
  const [resetQcLoading, setResetQcLoading] = useState(false);
  const [resetQcProjectCode, setResetQcProjectCode] = useState<string>('');
  const [resetQcResult, setResetQcResult] = useState<{
    total: number;
    updated: number;
    skipped: number;
    error?: string;
  } | null>(null);

  // States for deleting QC data of entire module
  const [deleteQcProjectCode, setDeleteQcProjectCode] = useState<string>('');
  const [deleteQcStage, setDeleteQcStage] = useState<string>('all');
  const [deleteQcLoading, setDeleteQcLoading] = useState(false);
  const [showConfirmDeleteQc, setShowConfirmDeleteQc] = useState(false);
  const [deleteQcResult, setDeleteQcResult] = useState<{
    total: number;
    updated: number;
    error?: string;
  } | null>(null);

  // --- SET PENDING INSTANCE STATES ---
  const [setPendingProjectCode, setSetPendingProjectCode] = useState<string>('');
  const [setPendingStage, setSetPendingStage] = useState<string>('white');
  const [setPendingLoading, setSetPendingLoading] = useState(false);
  const [showConfirmSetPending, setShowConfirmSetPending] = useState(false);
  const [setPendingResult, setSetPendingResult] = useState<{
    total: number;
    pending: number;
    skipped: number;
    error?: string;
  } | null>(null);

  // Synchronize packing pass automatic States
  const [packPassLoading, setPackPassLoading] = useState(false);
  const [showConfirmPackPass, setShowConfirmPackPass] = useState(false);
  const [packPassResult, setPackPassResult] = useState<{
    total: number;
    updated: number;
    error?: string;
  } | null>(null);

  // Migrate to Single Instance Model States
  const [migrateLoading, setMigrateLoading] = useState(false);
  const [showConfirmMigrate, setShowConfirmMigrate] = useState(false);
  const [migrateResult, setMigrateResult] = useState<{
    total: number;
    migrated: number;
    error?: string;
  } | null>(null);

  // Auto Receive + Pass All Stages States
  const [autoReceivePassLoading, setAutoReceivePassLoading] = useState(false);
  const [showConfirmAutoReceivePass, setShowConfirmAutoReceivePass] = useState(false);
  const [autoReceivePassProjectCode, setAutoReceivePassProjectCode] = useState<string>('');
  const [autoReceivePassResult, setAutoReceivePassResult] = useState<{
    totalModules: number;
    updatedModules: number;
    totalInstances: number;
    updatedInstances: number;
    error?: string;
  } | null>(null);

  // Reset STT Tool States
  const [resetSttLoading, setResetSttLoading] = useState(false);
  const [showConfirmResetStt, setShowConfirmResetStt] = useState(false);
  const [resetSttProjectCode, setResetSttProjectCode] = useState<string>('');
  const [resetSttResult, setResetSttResult] = useState<{
    totalModules: number;
    totalInstances: number;
    error?: string;
  } | null>(null);

  // Test Gom Phieu Hang Son States
  const [testPaintLoading, setTestPaintLoading] = useState(false);
  const [testPaintResult, setTestPaintResult] = useState<string | null>(null);

  const runMigrateInstances = async () => {
    setMigrateLoading(true);
    setMigrateResult(null);
    setShowConfirmMigrate(false);
    try {
      const configSnap = await getDocs(collection(db, 'projectConfigs'));
      const allDocs: { id: string; data: ProjectEntry; configId: string; projectCode: string }[] = [];
      for (const cfgDoc of configSnap.docs) {
        const cfgData = cfgDoc.data();
        const configId = cfgDoc.id;
        const pCode = cfgData.projectCode || cfgDoc.id;
        const modSnap = await getDocs(collection(db, 'projectConfigs', configId, 'modules'));
        modSnap.docs.forEach(d => {
          allDocs.push({ id: d.id, data: d.data() as ProjectEntry, configId, projectCode: pCode });
        });
      }
      let migratedCount = 0;

      let batch = writeBatch(db);
      let operationCount = 0;

      for (const d of allDocs) {
        const entry = d.data;
        let needsUpdate = false;
        let updatedInstances: any[] = [];

        if (!entry.instances || entry.instances.length === 0) {
          // Trường hợp 1: Cấu kiện chưa có instances nào, khởi tạo mới và kế thừa toàn bộ 4 giai đoạn QC
          needsUpdate = true;
          const qty = entry.quantity || 1;
          const list: any[] = [];
          const recQty = entry.receivedQuantity || 0;
          for (let i = 1; i <= qty; i++) {
            const isRec = recQty >= i;
            list.push({
              id: `${entry.moduleCode}|${i}`,
              instanceId: `${entry.moduleCode}|${i}`,
              instanceIndex: i,
              tempLabelIndex: i,
              delivered: isRec || false,
              deliveryLogs: isRec ? [{
                type: 'receive',
                date: null,
                by: 'System Migrate',
                notes: 'Migrated'
              }] : []
            });
          }
          updatedInstances = list;
        } else {
          // Trường hợp 2: Đã có instances, kiểm tra và kế thừa/đồng bộ 4 giai đoạn QC gốc nếu thiếu trên các instance
          let hasChange = false;
          updatedInstances = entry.instances.map(inst => {
            const updatedInst = { ...inst };
            return updatedInst;
          });
          
          if (hasChange) {
            needsUpdate = true;
          }
        }
        
        if (needsUpdate) {
          batch.update(doc(db, 'projectConfigs', d.configId, 'modules', d.id), {
            instances: updatedInstances,
            maxLabelIndex: entry.maxLabelIndex || entry.quantity || 1
          });
          
          migratedCount++;
          operationCount++;
          
          if (operationCount >= 450) {
            await batch.commit();
            batch = writeBatch(db);
            operationCount = 0;
          }
        }
      }
      
      if (operationCount > 0) {
        await batch.commit();
      }
      
      setMigrateResult({
        total: allDocs.length,
        migrated: migratedCount
      });
      
      await addDoc(collection(db, 'activities'), {
        userId: 'system_testcode',
        userName: 'Hệ thống Quản trị',
        userEmail: 'admin@system.com',
        action: 'Migrate sang instances duy nhất',
        details: `Đã hoàn thành rà soát và migrate thành công cho ${migratedCount}/${allDocs.length} cấu kiện sang mô hình instances mới.`,
        projectCode: 'SYSTEM',
        timestamp: serverTimestamp()
      });
    } catch (err: any) {
      console.error("Lỗi khi migrate sang instances:", err);
      setMigrateResult({
        total: 0,
        migrated: 0,
        error: err.message || String(err)
      });
    } finally {
      setMigrateLoading(false);
    }
  };

  const runTestPaintGomPhieu = async () => {
    setTestPaintLoading(true);
    setTestPaintResult(null);
    try {
      const today = new Date();
      const dd = String(today.getDate()).padStart(2, '0');
      const mm = String(today.getMonth() + 1).padStart(2, '0');
      const yyyy = today.getFullYear();
      const dateString = `${dd}/${mm}/${yyyy}`;

      // 1. Tải toàn bộ cấu kiện
      const configSnap = await getDocs(collection(db, 'projectConfigs'));
      const allEntries: any[] = [];
      for (const cfgDoc of configSnap.docs) {
        const configId = cfgDoc.id;
        const pCode = cfgDoc.data().projectCode || cfgDoc.id;
        const modSnap = await getDocs(collection(db, 'projectConfigs', configId, 'modules'));
        modSnap.docs.forEach(d => allEntries.push({ id: d.id, ...d.data(), configId, projectCode: pCode }));
      }

      // Tìm xem có instances nào có qcPaint ngày hôm nay không
      let todayPaintInstancesCount = 0;
      allEntries.forEach(entry => {
        if (entry.instances && entry.instances.length > 0) {
          entry.instances.forEach((inst: any) => {
            const instQcPaint = inst.qcPaint;
            if (instQcPaint && (instQcPaint.status === 'pass' || instQcPaint.status === 'fail')) {
              if (instQcPaint.date) {
                const dateObj = instQcPaint.date.seconds
                  ? new Date(instQcPaint.date.seconds * 1000)
                  : new Date(instQcPaint.date);
                if (
                  dateObj.getDate() === today.getDate() &&
                  dateObj.getMonth() === today.getMonth() &&
                  dateObj.getFullYear() === today.getFullYear()
                ) {
                  todayPaintInstancesCount++;
                }
              }
            }
          });
        }
      });

      // Nếu không có cấu kiện nào được QC Paint hôm nay, tự động giả lập QC Paint cho 2 cấu kiện dở dang của dự án hiện có
      if (todayPaintInstancesCount === 0 && allEntries.length > 0) {
        const targetsForMock = allEntries.slice(0, 2);
        for (const target of targetsForMock) {
          let updatedInstances = target.instances || [];
          if (!updatedInstances || updatedInstances.length === 0) {
            const qty = target.quantity || 1;
            const list: any[] = [];
            for (let i = 1; i <= qty; i++) {
              list.push({
                id: `${target.moduleCode}|${i}`,
                instanceId: `${target.moduleCode}|${i}`,
                instanceIndex: i,
                tempLabelIndex: i,
                qcDone: false,
                delivered: false
              });
            }
            updatedInstances = list;
          }

          const mockStatus = Math.random() > 0.4 ? 'pass' : 'fail';
          updatedInstances[0] = {
            ...updatedInstances[0],
            qcPaint: {
              status: mockStatus,
              date: new Date().toISOString(),
              by: 'Kiểm thử viên',
              notes: 'Kiểm thử tự động trên trang TestCode'
            }
          };

          await updateDoc(doc(db, 'projectConfigs', target.configId, 'modules', target.id), cleanUndefinedFields({
            instances: updatedInstances
          }));
        }

        const reConfigSnap = await getDocs(collection(db, 'projectConfigs'));
        allEntries.length = 0;
        for (const cfgDoc of reConfigSnap.docs) {
          const configId = cfgDoc.id;
          const pCode = cfgDoc.data().projectCode || cfgDoc.id;
          const modSnap = await getDocs(collection(db, 'projectConfigs', configId, 'modules'));
          modSnap.docs.forEach(d => allEntries.push({ id: d.id, ...d.data(), configId, projectCode: pCode }));
        }
      }

      // Nhóm theo projectCode để xử lý phiếu cho từng dự án
      const projectsGroup: Record<string, { projectName: string; instances: any[] }> = {};

      allEntries.forEach(entry => {
        const pCode = entry.projectCode;
        const pName = entry.projectName || pCode;

        if (!projectsGroup[pCode]) {
          projectsGroup[pCode] = { projectName: pName, instances: [] };
        }

        if (entry.instances && entry.instances.length > 0) {
          entry.instances.forEach((inst: any) => {
            const instQcPaint = inst.qcPaint;
            if (instQcPaint && (instQcPaint.status === 'pass' || instQcPaint.status === 'fail')) {
              let isToday = false;
              if (instQcPaint.date) {
                const dateObj = instQcPaint.date.seconds
                  ? new Date(instQcPaint.date.seconds * 1000)
                  : new Date(instQcPaint.date);
                if (
                  dateObj.getDate() === today.getDate() &&
                  dateObj.getMonth() === today.getMonth() &&
                  dateObj.getFullYear() === today.getFullYear()
                ) {
                  isToday = true;
                }
              }
              if (isToday) {
                projectsGroup[pCode].instances.push({
                  id: inst.instanceId || inst.id,
                  instanceId: inst.instanceId || inst.id,
                  moduleCode: entry.moduleCode,
                  cluster: entry.cluster || 'N/A',
                  quantity: 1,
                  status: instQcPaint.status,
                  qcNotes: instQcPaint.notes || '',
                  qcPhotos: instQcPaint.photos || [],
                  qcBy: instQcPaint.by || 'Hệ thống Test',
                  qcDate: new Date(instQcPaint.date.seconds ? instQcPaint.date.seconds * 1000 : instQcPaint.date).toISOString(),
                  timestamp: Date.now()
                });
              }
            }
          });
        }
      });

      let updatedCount = 0;
      let createdCount = 0;
      let totalGomCount = 0;

      for (const [pCode, data] of Object.entries(projectsGroup)) {
        if (data.instances.length === 0) continue;

        const ticketName = `Hàng Sơn - ${data.projectName} - Phiếu kiểm ngày ${dateString}`;

        const ticketsQuery = query(
          collection(db, 'qc_tickets'),
          where('projectCode', '==', pCode),
          where('stage', '==', 'paint'),
          where('name', '==', ticketName)
        );
        const querySnapshot = await getDocs(ticketsQuery);

        if (!querySnapshot.empty) {
          const existingTicketDoc = querySnapshot.docs[0];
          const existingTicketData = existingTicketDoc.data();
          const existingModules = existingTicketData.modules || [];

          const mergedModules = [...existingModules];
          data.instances.forEach(newInst => {
            const existingIdx = mergedModules.findIndex(
              (m: any) => m.instanceId === newInst.instanceId || m.id === newInst.id
            );
            if (existingIdx !== -1) {
              mergedModules[existingIdx] = {
                ...mergedModules[existingIdx],
                status: newInst.status,
                qcNotes: newInst.qcNotes,
                qcPhotos: newInst.qcPhotos,
                qcBy: newInst.qcBy,
                qcDate: newInst.qcDate,
                timestamp: newInst.timestamp
              };
            } else {
              mergedModules.push(newInst);
            }
          });

          await updateDoc(
            doc(db, 'qc_tickets', existingTicketDoc.id),
            cleanUndefinedFields({
              modules: mergedModules
            })
          );
          updatedCount++;
          totalGomCount += data.instances.length;
        } else {
          const newTicket = {
            name: ticketName,
            projectCode: pCode,
            projectName: data.projectName,
            stage: 'paint',
            status: 'pending',
            createdBy: 'Kiểm thử viên',
            createdByEmail: 'test@system.com',
            createdAt: new Date(),
            ownerId: 'test_user',
            isAutoPaint: true,
            modules: data.instances
          };
          await addDoc(collection(db, 'qc_tickets'), cleanUndefinedFields(newTicket));
          createdCount++;
          totalGomCount += data.instances.length;
        }
      }

      setTestPaintResult(`✓ Khởi chạy hoàn tất! Đã tự động tạo mới ${createdCount} phiếu và cập nhật/gom thành công ${updatedCount} phiếu kiểm hàng sơn ngày hôm nay. Tổng cộng gom ${totalGomCount} cấu kiện/instances.`);
    } catch (err: any) {
      console.error('Lỗi kiểm thử gom phiếu hàng sơn:', err);
      setTestPaintResult(`Lỗi: ${err.message || String(err)}`);
    } finally {
      setTestPaintLoading(false);
    }
  };

  const runTestPaintCompleteAllToday = async () => {
    setTestPaintLoading(true);
    setTestPaintResult(null);
    try {
      const today = new Date();
      const dd = String(today.getDate()).padStart(2, '0');
      const mm = String(today.getMonth() + 1).padStart(2, '0');
      const yyyy = today.getFullYear();
      const dateString = `${dd}/${mm}/${yyyy}`;

      const snap = await getDocs(collection(db, 'qc_tickets'));
      let completedCount = 0;

      for (const d of snap.docs) {
        const data = d.data();
        if (
          data.stage === 'paint' &&
          data.status === 'pending' &&
          data.name &&
          data.name.includes(`Phiếu kiểm ngày ${dateString}`)
        ) {
          await updateDoc(doc(db, 'qc_tickets', d.id), { status: 'completed' });
          completedCount++;
        }
      }

      setTestPaintResult(`✓ Đã chuyển đổi trạng thái "Hoàn tất" của ${completedCount} phiếu kiểm Hàng Sơn ngày hôm nay thành công (Giả lập sang ngày mới).`);
    } catch (err: any) {
      console.error('Lỗi chuyển trạng thái hoàn tất:', err);
      setTestPaintResult(`Lỗi: ${err.message || String(err)}`);
    } finally {
      setTestPaintLoading(false);
    }
  };

  // --- BASE64 CLEANER TOOL STATES & HELPERS ---
  interface Base64FoundItem {
    id: string;
    collectionName: string;
    docTitle: string;
    fieldPath: string;
    sizeKb: number;
    previewVal: string;
  }

  const [base64ScanLoading, setBase64ScanLoading] = useState(false);
  const [base64PurgeLoading, setBase64PurgeLoading] = useState(false);
  const [base64TargetCollections, setBase64TargetCollections] = useState<string[]>(['projects', 'projectConfigs']);
  const [base64FoundItems, setBase64FoundItems] = useState<Base64FoundItem[]>([]);
  const [base64ScanSummary, setBase64ScanSummary] = useState<{
    scannedDocs: number;
    foundDocs: number;
    totalSizeMb: number;
  } | null>(null);
  const [base64PurgeResult, setBase64PurgeResult] = useState<string | null>(null);

  const deleteNestedKey = (obj: any, path: string) => {
    const keys = path.replace(/\[(\d+)\]/g, '.$1').split('.');
    let current = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      if (current[key] === undefined) {
        return;
      }
      current = current[key];
    }
    const lastKey = keys[keys.length - 1];
    if (Array.isArray(current)) {
      const index = parseInt(lastKey, 10);
      if (!isNaN(index)) {
        current.splice(index, 1);
      }
    } else {
      delete current[lastKey];
    }
  };

  const runBase64Scan = async () => {
    setBase64ScanLoading(true);
    setBase64FoundItems([]);
    setBase64ScanSummary(null);
    setBase64PurgeResult(null);

    let scannedDocs = 0;
    const found: Base64FoundItem[] = [];

    try {
      for (const colName of base64TargetCollections) {
        const snap = await getDocs(collection(db, colName));
        scannedDocs += snap.size;

        const docsToProcess: { id: string; col: string; data: any; title: string }[] = [];

        snap.docs.forEach((docSnap) => {
          const data = docSnap.data();
          const docId = docSnap.id;
          let docTitle = docId;
          if (colName === 'projects') {
            docTitle = `Cấu kiện: ${data.moduleCode || ''} (Dự án: ${data.projectCode || ''})`;
          } else if (colName === 'projectConfigs') {
            docTitle = `Dự án: ${data.projectName || ''} (${data.projectCode || ''})`;
          } else if (colName === 'materials') {
            docTitle = `Vật tư: ${data.name || ''} (${data.code || ''})`;
          } else if (colName === 'qc_tickets') {
            docTitle = `Phiếu QC: ${data.name || ''} (Mã QC: ${data.ticketCode || ''})`;
          }
          docsToProcess.push({ id: docId, col: colName, data, title: docTitle });
        });

        if (colName === 'projectConfigs') {
          for (const docSnap of snap.docs) {
            try {
              const subSnap = await getDocs(collection(db, 'projectConfigs', docSnap.id, 'modules'));
              scannedDocs += subSnap.size;
              subSnap.docs.forEach(modSnap => {
                const mData = modSnap.data();
                docsToProcess.push({
                  id: modSnap.id,
                  col: `projectConfigs/${docSnap.id}/modules`,
                  data: mData,
                  title: `Cấu kiện: ${mData.moduleCode || ''} (Dự án: ${docSnap.id})`
                });
              });
            } catch (subErr) {
              console.error(subErr);
            }
          }
        }

        docsToProcess.forEach(({ id: docId, col: itemColName, data, title: docTitle }) => {
          const checkBase64 = (val: any, path: string) => {
            if (!val) return;
            if (typeof val === 'string') {
              if (val.startsWith('data:image/') || (val.length > 500 && val.includes(';base64,'))) {
                const sizeKb = Math.round(val.length * 0.75 / 1024);
                found.push({
                  id: docId,
                  collectionName: itemColName,
                  docTitle,
                  fieldPath: path,
                  sizeKb,
                  previewVal: val.substring(0, 80) + '...'
                });
              }
            } else if (Array.isArray(val)) {
              val.forEach((item, idx) => {
                checkBase64(item, `${path}[${idx}]`);
              });
            } else if (typeof val === 'object') {
              Object.keys(val).forEach((key) => {
                checkBase64(val[key], path ? `${path}.${key}` : key);
              });
            }
          };

          Object.keys(data).forEach((key) => {
            checkBase64(data[key], key);
          });
        });
      }

      const foundDocsSet = new Set(found.map(f => `${f.collectionName}/${f.id}`));
      const totalSizeKb = found.reduce((sum, item) => sum + item.sizeKb, 0);
      
      setBase64FoundItems(found);
      setBase64ScanSummary({
        scannedDocs,
        foundDocs: foundDocsSet.size,
        totalSizeMb: Number((totalSizeKb / 1024).toFixed(2))
      });
    } catch (error: any) {
      console.error("Lỗi quét base64:", error);
      alert(`Đã xảy ra lỗi khi quét cơ sở dữ liệu: ${error.message || String(error)}`);
    } finally {
      setBase64ScanLoading(false);
    }
  };

  const runBase64Purge = async () => {
    if (base64FoundItems.length === 0) {
      alert("Không có trường dữ liệu base64 nào để dọn dẹp!");
      return;
    }

    if (!confirm(`Bạn có chắc chắn muốn XÓA VĨNH VIỄN ${base64FoundItems.length} trường ảnh Base64 đang chiếm dụng dung lượng? Hành động này không thể khôi phục!`)) {
      return;
    }

    setBase64PurgeLoading(true);
    setBase64PurgeResult(null);

    let successCount = 0;
    let failCount = 0;

    try {
      const docGroups: Record<string, { col: string; paths: string[] }> = {};
      base64FoundItems.forEach((item) => {
        const key = `${item.collectionName}/${item.id}`;
        if (!docGroups[key]) {
          docGroups[key] = { col: item.collectionName, paths: [] };
        }
        docGroups[key].paths.push(item.fieldPath);
      });

      for (const [groupKey, group] of Object.entries(docGroups)) {
        const [colName, docId] = groupKey.split('/');
        try {
          const docRef = doc(db, colName, docId);
          const latestSnap = await getDoc(docRef);
          
          if (latestSnap.exists()) {
            const freshData = latestSnap.data();
            
            group.paths.forEach((path) => {
              deleteNestedKey(freshData, path);
            });

            await updateDoc(docRef, freshData);
            successCount += group.paths.length;
          } else {
            failCount += group.paths.length;
          }
        } catch (err) {
          console.error(`Lỗi dọn dẹp document ${groupKey}:`, err);
          failCount += group.paths.length;
        }
      }

      setBase64PurgeResult(`Đã dọn dẹp thành công ${successCount} trường dữ liệu ảnh Base64. Thất bại: ${failCount}.`);
      await runBase64Scan();
    } catch (error: any) {
      console.error("Lỗi dọn dẹp hàng loạt:", error);
      alert(`Đã xảy ra lỗi trong quá trình dọn dẹp: ${error.message || String(error)}`);
    } finally {
      setBase64PurgeLoading(false);
    }
  };

  const runSingleBase64Purge = async (item: Base64FoundItem) => {
    if (!confirm(`Xóa trường "${item.fieldPath}" của tài liệu này?`)) {
      return;
    }

    try {
      const docRef = doc(db, item.collectionName, item.id);
      const latestSnap = await getDoc(docRef);
      if (latestSnap.exists()) {
        const freshData = latestSnap.data();
        deleteNestedKey(freshData, item.fieldPath);
        await updateDoc(docRef, freshData);
        alert("Đã xóa thành công!");
        await runBase64Scan();
      }
    } catch (err: any) {
      console.error(err);
      alert("Lỗi xóa: " + err.message);
    }
  };

  // --- PACKING CONVERSION STATES ---
  const [convProjectCode, setConvProjectCode] = useState('');
  const [convPackingLists, setConvPackingLists] = useState<PackingList[]>([]);
  const [convSelectedList, setConvSelectedList] = useState<PackingList | null>(null);
  const [convPreview, setConvPreview] = useState<{ before: PackingItem[]; after: PackingItem[] } | null>(null);
  const [convLoading, setConvLoading] = useState(false);
  const [convResult, setConvResult] = useState<{ success: boolean; message: string } | null>(null);
  const [convProjectEntries, setConvProjectEntries] = useState<ProjectEntry[]>([]);

  React.useEffect(() => {
    if (!convProjectCode) {
      setConvPackingLists([]);
      setConvSelectedList(null);
      setConvPreview(null);
      setConvProjectEntries([]);
      return;
    }
    const loadData = async () => {
      try {
        const [packingSnap, configSnap] = await Promise.all([
          getDocs(query(collection(db, 'packing'), where('projectCode', '==', convProjectCode))),
          getDocs(query(collection(db, 'projectConfigs'), where('projectCode', '==', convProjectCode))),
        ]);
        const lists = packingSnap.docs.map(d => ({ id: d.id, ...d.data() } as PackingList));
        lists.sort((a: any, b: any) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
        setConvPackingLists(lists);

        const entries: ProjectEntry[] = [];
        for (const cfgDoc of configSnap.docs) {
          const modSnap = await getDocs(collection(db, 'projectConfigs', cfgDoc.id, 'modules'));
          modSnap.docs.forEach(d => entries.push({ id: d.id, ...d.data() } as ProjectEntry));
        }
        setConvProjectEntries(entries);
        setConvSelectedList(null);
        setConvPreview(null);
      } catch (err) {
        console.error('Lỗi tải dữ liệu:', err);
      }
    };
    loadData();
  }, [convProjectCode]);

  const getInstancePhotos = (item: PackingItem, instanceIdx: number, total: number): { photos: string[]; productImageUrl?: string; packingImageUrl?: string } => {
    const basePhotos = item.photos || [];
    const baseProduct = item.productImageUrl;
    const basePacking = item.packingImageUrl;

    if (basePhotos.length > 0 || baseProduct || basePacking) {
      return { photos: basePhotos, productImageUrl: baseProduct, packingImageUrl: basePacking };
    }

    const moduleId = item.id?.includes('_') ? item.id.split('_')[0] : item.id;
    if (!moduleId) return { photos: [], productImageUrl: undefined, packingImageUrl: undefined };

    const entry = convProjectEntries.find(e => e.id === moduleId);
    if (!entry) return { photos: [], productImageUrl: undefined, packingImageUrl: undefined };

    const inst = entry.instances?.find(ins => ins.instanceIndex === instanceIdx);
    if (!inst) return { photos: [], productImageUrl: undefined, packingImageUrl: undefined };

    const qcPhotos: string[] = [];
    [inst.qcWhite, inst.qcPaint, inst.qcFinish, inst.qcPack].forEach(qc => {
      if (qc?.photos?.length) qcPhotos.push(...qc.photos);
    });
    inst.qcLogs?.forEach(log => { if (log.photos?.length) qcPhotos.push(...log.photos); });

    const unique = [...new Set(qcPhotos.filter(Boolean))];
    return {
      photos: unique,
      productImageUrl: unique[0] || undefined,
      packingImageUrl: unique[1] || undefined,
    };
  };

  const computeConversionPreview = (list: PackingList) => {
    const before: PackingItem[] = [];
    const after: PackingItem[] = [];
    for (const item of list.items) {
      const isCtht = item.subType === 'kienCTHT' || item.subType === 'kienPhuKien';
      const needsConversion = !isCtht && item.quantity > 1;
      if (needsConversion) {
        before.push(item);
        const total = item.quantity;
        for (let i = 0; i < total; i++) {
          const instancePhotos = getInstancePhotos(item, i + 1, total);
          after.push({
            ...item,
            id: item.id ? `${item.id}_${i}` : undefined,
            name: `${item.name} #${i + 1}/${total}`,
            quantity: 1,
            packed: i < (item.packedQty ?? (item.packed ? total : 0)),
            packedQty: undefined,
            instanceIndex: i + 1,
            totalInstances: total,
            photos: instancePhotos.photos.length > 0 ? instancePhotos.photos : (item.photos || []),
            productImageUrl: instancePhotos.productImageUrl || item.productImageUrl,
            packingImageUrl: instancePhotos.packingImageUrl || item.packingImageUrl,
          });
        }
      } else {
        after.push(item);
      }
    }
    setConvPreview({ before, after });
  };

  const handleConvertPacking = async () => {
    if (!convPreview || !convSelectedList || !convProjectCode) return;
    setConvLoading(true);
    setConvResult(null);
    try {
      const displayLabel = userProfile?.ten_that
        ? `${userProfile.ten_that} (${userProfile.chuc_danh || 'NV'})`
        : (user?.displayName || 'System');
      const items = convPreview.after;
      const newTitle = `${convSelectedList.title} [Chuyển Instance]`;
      const docRef = await addDoc(collection(db, 'packing'), {
        title: newTitle,
        projectCode: convProjectCode,
        items: cleanUndefinedFields(items),
        isCompleted: false,
        ownerId: user?.uid || 'system',
        userName: displayLabel,
        createdAt: serverTimestamp(),
      });
      setConvResult({ success: true, message: `Tạo phiếu mới thành công! ID: ${docRef.id}` });
    } catch (err: any) {
      setConvResult({ success: false, message: `Lỗi: ${err.message || String(err)}` });
    } finally {
      setConvLoading(false);
    }
  };

  // --- Admin Print Report States ---
  const [reportProjectCode, setReportProjectCode] = useState<string>('');
  const [reportType, setReportType] = useState<'qc_tickets' | 'project_details' | 'packing_details'>('qc_tickets');
  
  // Lists fetched based on selections
  const [projectTickets, setProjectTickets] = useState<any[]>([]);
  const [projectPackingLists, setProjectPackingLists] = useState<any[]>([]);
  const [projectModules, setProjectModules] = useState<any[]>([]);
  
  // Selected items to print
  const [selectedPrintTicket, setSelectedPrintTicket] = useState<any | null>(null);
  const [selectedPrintPacking, setSelectedPrintPacking] = useState<any | null>(null);
  
  // Loading states
  const [reportLoading, setReportLoading] = useState<boolean>(false);

  React.useEffect(() => {
    if (!reportProjectCode) {
      setProjectTickets([]);
      setProjectPackingLists([]);
      setProjectModules([]);
      setSelectedPrintTicket(null);
      setSelectedPrintPacking(null);
      return;
    }

    const loadReportData = async () => {
      setReportLoading(true);
      try {
        const targetProj = existingProjects.find(p => p.projectCode === reportProjectCode);
        const configId = targetProj?.configId || reportProjectCode;

        if (reportType === 'qc_tickets') {
          const ref = collection(db, 'qc_tickets');
          const snap = await getDocs(query(ref, where('projectCode', '==', reportProjectCode)));
          const tickets = snap.docs.map(d => ({ id: d.id, ...d.data() } as any));
          tickets.sort((a, b) => {
            const tA = a.createdAt?.seconds || (a.createdAt instanceof Date ? a.createdAt.getTime() / 1000 : 0);
            const tB = b.createdAt?.seconds || (b.createdAt instanceof Date ? b.createdAt.getTime() / 1000 : 0);
            return tB - tA; // Mới nhất trước
          });
          setProjectTickets(tickets);
          if (tickets.length > 0) {
            setSelectedPrintTicket(tickets[0]);
          } else {
            setSelectedPrintTicket(null);
          }
        } else if (reportType === 'project_details') {
          const modulesSnap = await getDocs(collection(db, 'projectConfigs', configId, 'modules'));
          const modules = modulesSnap.docs.map(d => ({ id: d.id, ...d.data() } as any));
          setProjectModules(modules);
        } else if (reportType === 'packing_details') {
          const ref = collection(db, 'packing');
          const snap = await getDocs(query(ref, where('projectCode', '==', reportProjectCode)));
          const packingLists = snap.docs.map(d => ({ id: d.id, ...d.data() } as any));
          packingLists.sort((a, b) => {
            const tA = a.createdAt?.seconds || (a.createdAt instanceof Date ? a.createdAt.getTime() / 1000 : 0);
            const tB = b.createdAt?.seconds || (b.createdAt instanceof Date ? b.createdAt.getTime() / 1000 : 0);
            return tB - tA; // Mới nhất trước
          });
          setProjectPackingLists(packingLists);
          if (packingLists.length > 0) {
            setSelectedPrintPacking(packingLists[0]);
          } else {
            setSelectedPrintPacking(null);
          }
        }
      } catch (err) {
        console.error("Lỗi khi tải dữ liệu báo cáo:", err);
      } finally {
        setReportLoading(false);
      }
    };

    loadReportData();
  }, [reportProjectCode, reportType]);

  // --- CHỨC NĂNG BACKUP TOÀN BỘ DATA FIREBASE (EXPORT) ---
  const exportAllCollections = async () => {
    setExportLoading(true);
    setExportResult(null);
    try {
      const collectionsToBackup = [
        'projects',
        'qc_tickets',
        'packing',
        'activities',
        'users',
        'shipping_orders',
        'export_proposals',
        'quick_scan_lists',
        'items'
      ];
      
      const backupData: Record<string, any[]> = {};
      
      await Promise.all(collectionsToBackup.map(async (colName) => {
        try {
          const snap = await getDocs(collection(db, colName));
          backupData[colName] = snap.docs.map(docSnap => ({
            id: docSnap.id,
            ...docSnap.data()
          }));
        } catch (e) {
          console.error(`Không thể sao lưu collection ${colName}:`, e);
          backupData[colName] = []; // Tiếp tục với các collection khác
        }
      }));
      
      const jsonString = JSON.stringify(backupData, null, 2);
      const blob = new Blob([jsonString], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `firebase_backup_${new Date().toISOString().slice(0, 10)}_${Date.now()}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      
      // Ghi hoạt động vào log
      await addDoc(collection(db, 'activities'), {
        userId: 'system_testcode',
        userName: 'Hệ thống Quản trị',
        userEmail: 'admin@system.com',
        action: 'Sao lưu dữ liệu Firebase (Export)',
        details: `Trích xuất và tải xuống file sao lưu chứa các bảng dữ liệu thành công.`,
        projectCode: 'SYSTEM',
        timestamp: serverTimestamp()
      });

      setExportResult({ success: true, timestamp: new Date() });
    } catch (error: any) {
      console.error("Lỗi khi backup Firebase:", error);
      setExportResult({ success: false, error: error.message || String(error) });
    } finally {
      setExportLoading(false);
    }
  };

  // Search Module Data States & Handler
  const [searchModuleName, setSearchModuleName] = useState('');
  const [searchResult, setSearchResult] = useState<any[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [expandedSearchId, setExpandedSearchId] = useState<string | null>(null);

  const handleSearchModule = async () => {
    if (!searchModuleName.trim()) {
      setSearchError("Vui lòng nhập mã hoặc tên Module!");
      return;
    }
    setSearchLoading(true);
    setSearchResult([]);
    setSearchError(null);
    try {
      const code = searchModuleName.trim();
      const configSnap = await getDocs(collection(db, 'projectConfigs'));
      const allModules: any[] = [];
      for (const cfgDoc of configSnap.docs) {
        const configId = cfgDoc.id;
        const pCode = cfgDoc.data().projectCode || cfgDoc.id;
        const modSnap = await getDocs(collection(db, 'projectConfigs', configId, 'modules'));
        modSnap.docs.forEach(d => allModules.push({ id: d.id, data: d.data(), configId, projectCode: pCode }));
      }

      const resultsMap = new Map<string, any>();
      for (const m of allModules) {
        const mc = m.data.moduleCode || '';
        if (mc === code || mc === code.toUpperCase() || mc === code.toLowerCase()) {
          resultsMap.set(m.id, { id: m.id, configId: m.configId, projectCode: m.projectCode, ...m.data });
        }
      }

      if (resultsMap.size === 0 && code.length >= 3) {
        const upperCode = code.toUpperCase();
        for (const m of allModules) {
          const mc = (m.data.moduleCode || '').toUpperCase();
          if (mc >= upperCode && mc <= upperCode + '\uf8ff') {
            resultsMap.set(m.id, { id: m.id, configId: m.configId, projectCode: m.projectCode, ...m.data });
          }
        }
      }

      const finalDocs = Array.from(resultsMap.values());
      if (finalDocs.length === 0) {
        setSearchError("Không tìm thấy dữ liệu nào khớp với thông tin đã nhập.");
      } else {
        setSearchResult(finalDocs);
        if (finalDocs.length === 1) {
          setExpandedSearchId(finalDocs[0].id);
        }
      }
    } catch (err: any) {
      console.error("Lỗi khi tìm kiếm module:", err);
      setSearchError(err.message || String(err));
    } finally {
      setSearchLoading(false);
    }
  };

  // --- CHỨC NĂNG BACKUP TOÀN BỘ DATA FIREBASE (IMPORT) ---
  const handleJsonUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    setImportResult(null);
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const parsedData = JSON.parse(evt.target?.result as string);
        if (typeof parsedData !== 'object' || parsedData === null || Array.isArray(parsedData)) {
          throw new Error("File backup không đúng định dạng JSON object chứa các bảng.");
        }
        setImportPreview(parsedData);
        setSelectedCollections(Object.keys(parsedData));
      } catch (err: any) {
        console.error(err);
        setImportResult({ success: false, error: err.message || 'Lỗi đọc file JSON' });
      }
    };
    reader.readAsText(file);
  };

  const reviveTimestamps = (obj: any): any => {
    if (obj === null || obj === undefined) return obj;
    if (Array.isArray(obj)) {
      return obj.map(item => reviveTimestamps(item));
    }
    if (typeof obj === 'object') {
      if (typeof obj.seconds === 'number' && typeof obj.nanoseconds === 'number' && Object.keys(obj).length === 2) {
        return new Date(obj.seconds * 1000);
      }
      const keys = Object.keys(obj);
      if (keys.includes('_seconds') && keys.includes('_nanoseconds')) {
        return new Date(obj._seconds * 1000);
      }
      const newObj: any = {};
      for (const key in obj) {
        newObj[key] = reviveTimestamps(obj[key]);
      }
      return newObj;
    }
    return obj;
  };

  const executeImport = async () => {
    if (!importPreview) return;
    setImportLoading(true);
    setImportResult(null);
    
    try {
      let deletedCount = 0;
      let importedCount = 0;
      
      for (const colName of selectedCollections) {
        const items = importPreview[colName] || [];
        if (items.length === 0) continue;
        
        // Nuke chế độ: Xoá sạch dữ liệu cũ
        if (importMode === 'nuke') {
          const currentSnap = await getDocs(collection(db, colName));
          const currentDocs = currentSnap.docs;
          
          const batchSize = 100;
          for (let i = 0; i < currentDocs.length; i += batchSize) {
            const batch = writeBatch(db);
            const chunk = currentDocs.slice(i, i + batchSize);
            chunk.forEach(docSnap => {
              batch.delete(docSnap.ref);
              deletedCount++;
            });
            await batch.commit();
          }
        }
        
        // Import các document từ backup
        const batchSize = 100;
        for (let i = 0; i < items.length; i += batchSize) {
          const batch = writeBatch(db);
          const chunk = items.slice(i, i + batchSize);
          
          chunk.forEach(item => {
            const { id, ...itemData } = item;
            const revivedItemData = reviveTimestamps(itemData);
            
            if (id) {
              batch.set(doc(db, colName, id), revivedItemData);
            } else {
              batch.set(doc(collection(db, colName)), revivedItemData);
            }
            importedCount++;
          });
          
          await batch.commit();
        }
      }
      
      // Log hoạt động
      await addDoc(collection(db, 'activities'), {
        userId: 'system_testcode',
        userName: 'Hệ thống Quản trị',
        userEmail: 'admin@system.com',
        action: 'Khôi phục dữ liệu Firebase (Import)',
        details: `Khôi phục thành công. Đã nạp: ${importedCount} bản ghi, đã xoá: ${deletedCount} bản ghi cũ (chế độ ${importMode === 'nuke' ? 'Khôi phục hoàn toàn' : 'Ghi đè theo ID'}).`,
        projectCode: 'SYSTEM',
        timestamp: serverTimestamp()
      });
      
      setImportResult({
        success: true,
        importedCount,
        deletedCount
      });
      setImportPreview(null);
      if (importFileInputRef.current) importFileInputRef.current.value = '';
      
    } catch (error: any) {
      console.error("Lỗi khi import dữ liệu Firebase:", error);
      setImportResult({
        success: false,
        error: error.message || String(error)
      });
    } finally {
      setImportLoading(false);
    }
  };

  React.useEffect(() => {
    const fetchExistingProjects = async () => {
      try {
        const projectsRef = collection(db, 'projectConfigs');
        const snapshot = await getDocs(projectsRef);
        const uniqueMap = new Map<string, string>();
        snapshot.docs.forEach(docSnap => {
          const data = docSnap.data();
          const code = data.projectCode || docSnap.id;
          const name = data.projectName || data.displayName || `Dự án ${code}`;
          if (!uniqueMap.has(code.toLowerCase())) {
            uniqueMap.set(code.toLowerCase(), name);
          }
        });
        const list = Array.from(uniqueMap.entries()).map(([codeLower, name]) => {
          const matchDoc = snapshot.docs.find(d => (d.data().projectCode || d.id)?.toLowerCase() === codeLower);
          const origCode = (matchDoc?.data().projectCode || matchDoc?.id) || codeLower.toUpperCase();
          const displayCode = matchDoc?.data().displayCode || '';
          return {
            projectCode: origCode,
            projectName: name,
            displayCode,
            configId: matchDoc?.id || origCode
          };
        });
        list.sort((a, b) => (a.displayCode || a.projectCode).localeCompare(b.displayCode || b.projectCode));
        setExistingProjects(list);
      } catch (err) {
        console.error("Lỗi lấy danh sách dự án:", err);
      }
    };
    fetchExistingProjects();
  }, []);
  
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handlePaintExcelUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setPaintLoading(true);
    setPaintResult(null);
    setExcelPreviewData([]);

    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const bstr = evt.target?.result;
        const wb = XLSX.read(bstr, { type: 'binary' });
        const wsname = wb.SheetNames[0];
        const ws = wb.Sheets[wsname];
        
        // Đọc dữ liệu ra dạng mảng 2 chiều
        const jsonData: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
        if (jsonData.length < 1) {
          throw new Error('File không có dữ liệu hợp lệ');
        }

        const groupMap = new Map<string, {
          moduleCode: string;
          dai: number;
          rong: number;
          day: number;
          classification: 'Cánh' | 'Mặt HK' | 'CTHT';
          material: string;
          quantity: number;
        }>();
        
        for (let r = 0; r < jsonData.length; r++) {
          const row = jsonData[r];
          if (!row || row.length < 1) continue;

          const moduleCode = String(row[0] || '').trim();
          if (!moduleCode) continue;

          // Bỏ qua dòng tiêu đề có chứa các từ khóa tiêu đề cột
          const col1Str = String(row[1] || '').trim().toLowerCase();
          const col0Str = moduleCode.toLowerCase();
          if (
            col0Str.includes('stt') || col0Str.includes('tên') || col0Str.includes('ten') || col0Str.includes('module') ||
            col1Str.includes('dài') || col1Str.includes('dai') || col1Str.includes('rộng') || col1Str.includes('rong') || 
            col1Str.includes('dày') || col1Str.includes('day') || col1Str.includes('kích thước') || col1Str.includes('chiều')
          ) {
            continue;
          }

          // Trích xuất kích thước cột 2 (Dài), cột 3 (Rộng), cột 4 (Dày), cột 5 (Vật liệu)
          const dai = Number(row[1]) || 0;
          const rong = Number(row[2]) || 0;
          const day = Number(row[3]) || 0;
          const material = row[4] ? String(row[4]).trim() : '';

          // Nếu tất cả kích thước đều không hợp lệ (không phải số hoặc = 0) và cột 1 rỗng, bỏ qua
          if (dai === 0 && rong === 0 && day === 0 && isNaN(Number(row[1]))) {
            continue;
          }

          // Định dạng phân loại:
          // Nếu tên chứa "cánh" hoặc "cửa" -> "Cánh"
          // Nếu tên chứa "mặt" hoặc "mat" (ví dụ mặt hộc kéo) -> "Mặt HK"
          // Còn lại -> "CTHT"
          const codeLower = moduleCode.toLowerCase();
          let classification: 'Cánh' | 'Mặt HK' | 'CTHT' = 'CTHT';
          if (codeLower.includes('cánh') || codeLower.includes('canh') || codeLower.includes('cửa') || codeLower.includes('cua')) {
            classification = 'Cánh';
          } else if (codeLower.includes('mặt') || codeLower.includes('mat')) {
            classification = 'Mặt HK';
          }

          const groupKey = moduleCode.toLowerCase();
          if (groupMap.has(groupKey)) {
            const existing = groupMap.get(groupKey)!;
            existing.quantity += 1;
            // Nếu có vật liệu mới hoặc kích thước thì giữ nguyên hoặc ưu tiên lấy cái có giá trị
            if (!existing.material && material) {
              existing.material = material;
            }
          } else {
            groupMap.set(groupKey, {
              moduleCode,
              dai,
              rong,
              day,
              classification,
              material,
              quantity: 1
            });
          }
        }

        const parsed = Array.from(groupMap.values());

        if (parsed.length === 0) {
          throw new Error('Không trích xuất được dòng dữ liệu module hợp lệ nào (Cột 1: Tên Module, Cột 2 3 4: Dài Rộng Dày, Cột 5: Vật liệu)');
        }

        setExcelPreviewData(parsed);
      } catch (err: any) {
        console.error(err);
        setPaintResult({
          total: 0,
          inserted: 0,
          updated: 0,
          error: err.message || 'Lỗi không xác định khi đọc file Excel'
        });
      } finally {
        setPaintLoading(false);
      }
    };
    reader.readAsBinaryString(file);
  };

  const handleConfirmExcelImport = async () => {
    if (excelPreviewData.length === 0) return;
    setPaintLoading(true);
    setPaintResult(null);

    try {
      const configSnap = await getDocs(collection(db, 'projectConfigs'));
      const existingEntries: { id: string; data: any; projectCode: string }[] = [];
      for (const cfgDoc of configSnap.docs) {
        const pCode = cfgDoc.data().projectCode || cfgDoc.id;
        const modSnap = await getDocs(collection(db, 'projectConfigs', pCode, 'modules'));
        modSnap.docs.forEach(docSnap => {
          existingEntries.push({
            id: docSnap.id,
            data: docSnap.data() as any,
            projectCode: pCode
          });
        });
      }
      
      const entryMap = new Map<string, any>();
      const projectNamesMap = new Map<string, string>();
      existingEntries.forEach(entry => {
        const key = `${entry.data.projectCode}___${entry.data.moduleCode}`.toLowerCase();
        entryMap.set(key, entry);
        if (entry.data.projectCode && entry.data.projectName) {
          projectNamesMap.set(entry.data.projectCode.toLowerCase(), entry.data.projectName);
        }
      });

      const batchSize = 100;
      let batch = writeBatch(db);
      let countInBatch = 0;
      let inserted = 0;
      let updated = 0;

      for (const rec of excelPreviewData) {
        let projectCode = '';
        let resolvedProjectName = '';

        if (selectedProjectCode && selectedProjectCode !== 'auto') {
          projectCode = selectedProjectCode;
          const targetProj = existingProjects.find(p => p.projectCode === selectedProjectCode);
          resolvedProjectName = targetProj ? targetProj.projectName : `Dự án ${projectCode}`;
        } else {
          // Tự động quyết định theo Cụm/mã module hoặc mặc định MED026_BLDG1
          const codeUpper = rec.moduleCode.toUpperCase();
          if (codeUpper.includes('BLDG1')) {
            projectCode = 'MED026_BLDG1';
          } else if (codeUpper.includes('BLDG2')) {
            projectCode = 'MED026_BLDG2';
          } else if (codeUpper.includes('BLDG3')) {
            projectCode = 'MED026_BLDG3';
          } else {
            projectCode = 'MED026_BLDG1';
          }
          resolvedProjectName = projectNamesMap.get(projectCode.toLowerCase()) || `Dự án ${projectCode}`;
        }

        let determinedCluster = '';
        const mCodeUpper = rec.moduleCode.toUpperCase();
        if (mCodeUpper.includes('KIT')) {
          determinedCluster = 'KITCHEN';
        } else if (mCodeUpper.includes('ISL')) {
          determinedCluster = 'ISLAN';
        } else if (mCodeUpper.includes('COT')) {
          determinedCluster = 'COAT';
        } else if (mCodeUpper.includes('LVR')) {
          determinedCluster = 'LIVING ROOM';
        } else if (mCodeUpper.includes('POWD')) {
          determinedCluster = 'POWDER';
        } else if (mCodeUpper.includes('BAT1')) {
          determinedCluster = 'BATH1';
        } else if (mCodeUpper.includes('PRI')) {
          determinedCluster = 'PRIME VANITY';
        }

        const key = `${projectCode}___${rec.moduleCode}`.toLowerCase();
        const existingDoc = entryMap.get(key);

        if (existingDoc) {
          // Cộng dồn số lượng đã có của module cũ trong DB
          const currentQty = Number(existingDoc.data.quantity) || 1;
          const newQty = currentQty + rec.quantity;

          batch.update(doc(db, 'projectConfigs', existingDoc.projectCode, 'modules', existingDoc.id), {
            width: rec.dai,
            depth: rec.rong,
            height: rec.day,
            pWidth: rec.dai,
            pDepth: rec.rong,
            pHeight: rec.day,
            classification: rec.classification,
            material: rec.material || existingDoc.data.material || 'Hàng sơn',
            notes: rec.material || existingDoc.data.notes || 'Cập nhật từ Excel hàng sơn',
            cluster: determinedCluster || existingDoc.data.cluster || '',
            quantity: newQty
          });
          updated++;
        } else {
          // Tạo mới
          const newDocRef = doc(collection(db, 'projectConfigs', projectCode, 'modules'));
          batch.set(newDocRef, {
            projectName: resolvedProjectName,
            projectCode: projectCode,
            displayCode: projectCode.replace("MED026_", ""),
            drawingUrl: '',
            assemblyDrawingUrl: '',
            glbUrl: '',
            cluster: determinedCluster,
            moduleCode: rec.moduleCode,
            quantity: rec.quantity,
            width: rec.dai,
            depth: rec.rong,
            height: rec.day,
            pWidth: rec.dai,
            pDepth: rec.rong,
            pHeight: rec.day,
            accessories: [],
            status: '',
            statusHistory: [],
            ownerId: 'system_excel_paint',
            createdAt: new Date(),
            material: rec.material || 'Hàng sơn nhập từ Excel',
            notes: rec.material || 'Tạo tự động từ Excel hàng sơn',
            classification: rec.classification
          });
          inserted++;
        }

        countInBatch++;
        if (countInBatch >= batchSize) {
          await batch.commit();
          batch = writeBatch(db);
          countInBatch = 0;
        }
      }

      if (countInBatch > 0) {
        await batch.commit();
      }

      // Tính tổng số lượng cộng dồn thành công
      const totalProcessed = excelPreviewData.reduce((acc, current) => acc + current.quantity, 0);

      setPaintResult({
        total: totalProcessed,
        inserted,
        updated
      });
      setExcelPreviewData([]);
    } catch (err: any) {
      console.error(err);
      setPaintResult({
        total: 0,
        inserted: 0,
        updated: 0,
        error: err.message || 'Lỗi không xác định khi lưu vào database'
      });
    } finally {
      setPaintLoading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const normalizeStr = (str: string) => {
    return String(str).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
  };

  // Đã loại bỏ module dọn dẹp trạng thái "Chưa nhận" & "Chưa nhận hàng" để phục vụ các module nghiệp vụ đồng bộ chính

  const getEntryTypeLocal = (moduleCode: string, entry?: any): 'Thùng' | 'Cánh' | 'Đợt' | 'Đợt di động' | 'Mặt HK' | 'CTHT' => {
    if (entry?.classification) {
      return entry.classification;
    }
    const codeLower = (moduleCode || '').toLowerCase();
    
    const isOriginalCanhMatHK = codeLower.includes('mặt học kéo') || codeLower.includes('mat hoc keo') || codeLower.includes('cửa') || codeLower.includes('cua');
    const isOriginalCTHT = codeLower.includes('tấm hoàn thiện') || codeLower.includes('tam hoan thien') || codeLower.includes('hoàn thiện') || codeLower.includes('hoan thien') || codeLower.includes('ctht') || (moduleCode || '').split('_').length >= 3;
    
    if (!isOriginalCanhMatHK && !isOriginalCTHT) {
      return 'Thùng';
    }
    
    if (codeLower.includes('cánh') || codeLower.includes('canh') || codeLower.includes('cửa') || codeLower.includes('cua')) {
      return 'Cánh';
    }
    if (codeLower.includes('đợt') || codeLower.includes('dot')) {
      return 'Đợt';
    }
    if (codeLower.includes('mặt') || codeLower.includes('mat')) {
      return 'Mặt HK';
    }
    return 'CTHT';
  };

  // --- PASS BÙ KIỆN ĐÃ ĐÓNG GÓI HOÀN TẤT STATES & LOGIC ---
  const [packFilterProjCode, setPackFilterProjCode] = useState<string>('all');
  const [packedPackages, setPackedPackages] = useState<ProjectEntry[]>([]);
  const [packFilterLoading, setPackFilterLoading] = useState(false);
  const [packPassBuLoading, setPackPassBuLoading] = useState(false);
  const [packPassBuResult, setPackPassBuResult] = useState<string | null>(null);

  const handleLoadPackedPackages = async () => {
    setPackFilterLoading(true);
    setPackPassBuResult(null);
    try {
      const list: ProjectEntry[] = [];

      if (packFilterProjCode === 'all') {
        const configSnap = await getDocs(collection(db, 'projectConfigs'));
        for (const cfgDoc of configSnap.docs) {
          const pCode = cfgDoc.data().projectCode || cfgDoc.id;
          const modSnap = await getDocs(collection(db, 'projectConfigs', pCode, 'modules'));
          modSnap.docs.forEach(d => {
            const item = { id: d.id, ...d.data() } as ProjectEntry;
            const isThung = item.classification === 'Thùng' ||
                            item.moduleCode.toLowerCase().includes('thung') ||
                            (item as any).moduleType === 'thung';
            const isCompletedPacking = item.status === 'Đóng Gói' || item.qcPack?.status === 'pass';
            if (isThung && isCompletedPacking) {
              list.push(item);
            }
          });
        }
      } else {
        const modSnap = await getDocs(collection(db, 'projectConfigs', packFilterProjCode, 'modules'));
        modSnap.docs.forEach(d => {
          const item = { id: d.id, ...d.data() } as ProjectEntry;
          const isThung = item.classification === 'Thùng' ||
                          item.moduleCode.toLowerCase().includes('thung') ||
                          (item as any).moduleType === 'thung';
          const isCompletedPacking = item.status === 'Đóng Gói' || item.qcPack?.status === 'pass';
          if (isThung && isCompletedPacking) {
            list.push(item);
          }
        });
      }
      
      // Sắp xếp danh sách
      list.sort((a, b) => a.moduleCode.localeCompare(b.moduleCode));
      setPackedPackages(list);
      if (list.length === 0) {
        setPackPassBuResult("Không tìm thấy kiện/thùng nào đã đóng gói hoàn tất cần xử lý.");
      } else {
        setPackPassBuResult(`Đã tìm thấy ${list.length} kiện/thùng đóng gói hoàn tất.`);
      }
    } catch (err: any) {
      console.error(err);
      setPackPassBuResult(`Lỗi tải danh mục: ${err.message || String(err)}`);
    } finally {
      setPackFilterLoading(false);
    }
  };

  const handleExecuteSinglePassBu = async (pkg: ProjectEntry) => {
    setPackPassBuLoading(true);
    try {
      const res = await autoPassBuForPackage(pkg.id, {
        uid: user?.uid,
        email: user?.email,
        displayName: userProfile?.ten_that || user?.displayName || 'NV Thử Nghiệm'
      });
      if (res.success) {
        // Tự động quét và pass bù luôn các CTHT ảo của dự án này
        const cthtRes = await autoPassBuForVirtualCTHT(pkg.projectCode, {
          uid: user?.uid,
          email: user?.email,
          displayName: userProfile?.ten_that || user?.displayName || 'NV Thử Nghiệm'
        });
        
        let msg = res.message;
        if (cthtRes.success && cthtRes.updatedCount > 0) {
          msg += `\nĐồng thời tự động pass bù thành công cho ${cthtRes.updatedCount} cấu kiện CTHT thuộc Kiện CTHT ảo bên đóng gói của dự án ${pkg.projectCode}.`;
        }
        alert(msg);
        await handleLoadPackedPackages();
      } else {
        alert(`Thất bại: ${res.message}`);
      }
    } catch (err: any) {
      alert(`Lỗi thực thi: ${err.message || String(err)}`);
    } finally {
      setPackPassBuLoading(false);
    }
  };

  const handleExecuteAllPassBu = async () => {
    if (packedPackages.length === 0) return;
    if (!window.confirm(`Xác nhận chạy PASS BÙ ĐỒNG LOẠT cho toàn bộ ${packedPackages.length} kiện đã đóng gói hoàn tất và các cấu kiện con ghép nối?`)) {
      return;
    }
    setPackPassBuLoading(true);
    let successCount = 0;
    try {
      for (const pkg of packedPackages) {
        const res = await autoPassBuForPackage(pkg.id, {
          uid: user?.uid,
          email: user?.email,
          displayName: userProfile?.ten_that || user?.displayName || 'NV Thử Nghiệm'
        }, packedPackages);
        if (res.success) {
          successCount++;
        }
      }
      
      // Chạy thêm pass bù cho các CTHT nằm trong Kiện CTHT ảo bên đóng gói
      const cthtRes = await autoPassBuForVirtualCTHT(packFilterProjCode, {
        uid: user?.uid,
        email: user?.email,
        displayName: userProfile?.ten_that || user?.displayName || 'NV Thử Nghiệm'
      });

      if (cthtRes.success) {
        if (cthtRes.updatedCount > 0) {
          alert(`Đã hoàn tất chạy PASS BÙ thành công: ${successCount}/${packedPackages.length} kiện.\nĐồng thời tự động pass bù thành công cho ${cthtRes.updatedCount} cấu kiện CTHT từ các Kiện CTHT ảo bên đóng gói.`);
        } else {
          alert(`Đã hoàn tất chạy PASS BÙ thành công: ${successCount}/${packedPackages.length} kiện.`);
        }
      } else {
        alert(`Hoàn tất pass bù kiện chính (${successCount}/${packedPackages.length}), nhưng có lỗi xử lý Kiện CTHT ảo: ${cthtRes.message}`);
      }

      await handleLoadPackedPackages();
    } catch (err: any) {
      alert(`Lỗi trong quá trình chạy hàng loạt: ${err.message || String(err)}`);
    } finally {
      setPackPassBuLoading(false);
    }
  };

  const [fastPassLoading, setFastPassLoading] = useState(false);
  const [fastPassProjectCode, setFastPassProjectCode] = useState<string>('all');
  const [fastPassResult, setFastPassResult] = useState<{
    total: number;
    updated: number;
    skipped: number;
    error?: string;
  } | null>(null);

  const runFastPassWhiteForMedina = async () => {
    setFastPassLoading(true);
    setFastPassResult(null);
    setShowConfirmFastPass(false);
    let updatedCount = 0;
    let skippedCount = 0;
    let totalDocs = 0;

    try {
      const configSnap = await getDocs(collection(db, 'projectConfigs'));
      const allModuleDocs: { id: string; data: ProjectEntry; configId: string; projectCode: string }[] = [];
      for (const cfgDoc of configSnap.docs) {
        const configId = cfgDoc.id;
        const pCode = cfgDoc.data().projectCode || cfgDoc.id;
        const modSnap = await getDocs(collection(db, 'projectConfigs', configId, 'modules'));
        modSnap.docs.forEach(d => {
          allModuleDocs.push({ id: d.id, data: d.data() as ProjectEntry, configId, projectCode: pCode });
        });
      }
      totalDocs = allModuleDocs.length;

      const batchSize = 500;
      let batch = writeBatch(db);
      let countInBatch = 0;

      // Regex so khớp với moduleCode bắt đầu bằng BLDG (có thể có số thứ tự ở đầu ví dụ 74. hoặc mã dự án ví dụ MED026_)
      const bldgRegex = /^(?:\d+\.)?(?:[a-zA-Z0-9]+_)?BLDG/i;

      for (const d of allModuleDocs) {
        const data = d.data as ProjectEntry;
        const configId = d.configId;
        const projectCode = d.projectCode;
        const moduleCode = data.moduleCode || '';
        
        // Kiểm tra xem có đúng dự án được chọn không (nếu không chọn all)
        if (fastPassProjectCode !== 'all' && 
            projectCode.toLowerCase() !== fastPassProjectCode.toLowerCase() && 
            configId.toLowerCase() !== fastPassProjectCode.toLowerCase()) {
          skippedCount++;
          continue;
        }

        // Lấy instances và chỉ pass những instance CHƯA pass hàng trắng
        const currentInstances = getModuleInstances(data);
        let hasUnpasssed = false;
        const updatedInstances = currentInstances.map((inst: any) => {
          if (inst.qcWhite?.status === 'pass') return inst; // Đã pass rồi thì giữ nguyên
          hasUnpasssed = true;
          const currentLogs = inst.qcLogs || [];
          const instStageData = {
            status: 'pass' as const,
            date: new Date().toISOString(),
            by: 'Hệ thống (Pass nhanh)',
            notes: 'Pass nhanh Hàng Trắng',
            photos: [],
            checkedCriteria: {},
          };
          return {
            ...inst,
            qcWhite: instStageData,
            qcLogs: [
              ...currentLogs.filter((log: any) => log.stage !== 'white'),
              {
                stage: 'white',
                status: 'pass' as const,
                date: new Date().toISOString(),
                by: 'Hệ thống (Pass nhanh)',
                notes: 'Pass nhanh Hàng Trắng',
                photos: []
              }
            ]
          };
        });

        // Chỉ update nếu có instance chưa pass
        if (!hasUnpasssed) {
          skippedCount++;
          continue;
        }

        const history = [...(data.statusHistory || [])];
        history.push(`QC Hàng Trắng: PASS (Hệ thống - Pass nhanh)|${Date.now()}`);

        batch.update(doc(db, 'projectConfigs', d.configId, 'modules', d.id), {
          qcWhite: deleteField(),
          qcPaint: deleteField(),
          qcFinish: deleteField(),
          qcPack: deleteField(),
          qcPass: deleteField(),
          qcStatus: deleteField(),
          qcNotes: deleteField(),
          qcPhotos: deleteField(),
          qcDate: deleteField(),
          qcBy: deleteField(),
          qcRole: deleteField(),
          qcCheckedCriteria: deleteField(),
          qcCriterionPhotos: deleteField(),
          status: 'QC Hàng Trắng: PASS',
          statusHistory: history,
          instances: updatedInstances
        });

        updatedCount++;
        countInBatch++;

        if (countInBatch >= batchSize) {
          await batch.commit();
          batch = writeBatch(db);
          countInBatch = 0;
        }
      }

      if (countInBatch > 0) {
        await batch.commit();
      }

      setFastPassResult({
        total: totalDocs,
        updated: updatedCount,
        skipped: skippedCount
      });
      alert(`Đã hoàn tất Pass nhanh QC Hàng Trắng!\n- Tổng số cấu kiện quét được: ${totalDocs}\n- Đã cập nhật thành công: ${updatedCount} cấu kiện\n- Bỏ qua (đã pass trước đó hoặc không thuộc dự án): ${skippedCount}`);
    } catch (error) {
      console.error("Fast pass error:", error);
      setFastPassResult({
        total: totalDocs,
        updated: updatedCount,
        skipped: skippedCount,
        error: error instanceof Error ? error.message : String(error)
      });
      alert(`Đã xảy ra lỗi trong quá trình Pass nhanh QC: ${error instanceof Error ? error.message : String(error)}`);
      handleFirestoreError(error, OperationType.WRITE, 'projects/fast_pass');
    } finally {
      setFastPassLoading(false);
    }
  };

  const runAutoReceiveAndPassAllStages = async () => {
    if (!autoReceivePassProjectCode) {
      alert('Vui lòng chọn dự án!');
      return;
    }
    if (!window.confirm(`Xác nhận TỰ ĐỘNG:\n1. Đánh dấu ĐÃ NHẬN ĐỦ (receivedQuantity = quantity) cho toàn bộ cấu kiện\n2. PASS TẤT CẢ giai đoạn QC (Hàng Trắng, Hàng Sơn, Hoàn Thiện, Đóng Gói) cho TOÀN BỘ instance\n\nDự án: ${autoReceivePassProjectCode === 'all' ? 'TOÀN BỘ' : autoReceivePassProjectCode}\n\nLưu ý: Chỉ áp dụng cho cấu kiện CHƯA nhận đủ và/hoặc chưa pass giai đoạn tương ứng.`)) {
      return;
    }

    setAutoReceivePassLoading(true);
    setAutoReceivePassResult(null);
    let totalModules = 0;
    let updatedModules = 0;
    let totalInstances = 0;
    let instancePassCount = 0;

    try {
      const configSnap = await getDocs(collection(db, 'projectConfigs'));
      const batchSize = 500;
      let batch = writeBatch(db);
      let countInBatch = 0;

      for (const cfgDoc of configSnap.docs) {
        const configId = cfgDoc.id;
        const pCode = cfgDoc.data().projectCode || cfgDoc.id;

        // Filter by project if not 'all'
        if (autoReceivePassProjectCode !== 'all' &&
            pCode.toLowerCase() !== autoReceivePassProjectCode.toLowerCase() &&
            configId.toLowerCase() !== autoReceivePassProjectCode.toLowerCase()) {
          continue;
        }

        const modSnap = await getDocs(collection(db, 'projectConfigs', configId, 'modules'));

        for (const modDoc of modSnap.docs) {
          const data = modDoc.data() as ProjectEntry;
          totalModules++;
          const currentInstances = getModuleInstances(data);
          totalInstances += currentInstances.length;

          let moduleChanged = false;

          // 1. Auto receive: set receivedQuantity = quantity if not fully received
          const qty = Number(data.quantity) || 0;
          const received = Number(data.receivedQuantity) || 0;
          let newReceivedQuantity = data.receivedQuantity;
          let newStatus = data.status;
          const history = [...(data.statusHistory || [])];

          if (qty > 0 && received < qty) {
            newReceivedQuantity = qty;
            const isFullyReceived = true;
            const newRecvStatus = 'Giao Nhận - Đã nhận';
            if (!history.length || history[history.length - 1].split('|')[0] !== newRecvStatus) {
              history.push(`${newRecvStatus}|${Date.now()}`);
            }
            newStatus = 'Giao Nhận - Đã nhận';
            moduleChanged = true;
          }

          // 2. Pass all QC stages on all instances
          const allStages = ['white', 'paint', 'finish', 'pack'];
          let moduleInstancePassCount = 0;
          const updatedInstances = currentInstances.map((inst: any) => {
            let instChanged = false;
            const currentLogs = inst.qcLogs || [];
            let newLogs = [...currentLogs];

            const updatedInst = { ...inst };

            for (const stage of allStages) {
              const stageData = inst[`qc${stage.charAt(0).toUpperCase() + stage.slice(1)}`];
              if (!stageData || stageData.status !== 'pass') {
                const stageLabel = stage === 'white' ? 'Hàng Trắng' :
                  stage === 'paint' ? 'Hàng Sơn' :
                  stage === 'finish' ? 'Hoàn Thiện' : 'Đóng Gói';
                const instStageData = {
                  status: 'pass' as const,
                  date: new Date().toISOString(),
                  by: 'Hệ thống (Auto Bù)',
                  notes: `Auto pass bù ${stageLabel}`,
                  photos: [] as string[],
                };
                updatedInst[`qc${stage.charAt(0).toUpperCase() + stage.slice(1)}`] = instStageData;

                newLogs = [
                  ...newLogs.filter((log: any) => log.stage !== stage),
                  {
                    stage,
                    status: 'pass' as const,
                    date: new Date().toISOString(),
                    by: 'Hệ thống (Auto Bù)',
                    notes: `Auto pass bù ${stageLabel}`,
                    photos: []
                  }
                ];
                instChanged = true;
              }
            }

            if (instChanged) {
              updatedInst.qcLogs = newLogs;
              moduleInstancePassCount++;
            }

            return updatedInst;
          });

          if (moduleChanged || moduleInstancePassCount > 0) {
            const moduleUpdate: any = {
              instances: updatedInstances,
              statusHistory: history,
            };
            if (newReceivedQuantity !== data.receivedQuantity) {
              moduleUpdate.receivedQuantity = newReceivedQuantity;
            }
            if (newStatus !== data.status) {
              moduleUpdate.status = newStatus;
            }

            batch.update(doc(db, 'projectConfigs', configId, 'modules', modDoc.id), moduleUpdate);
            updatedModules++;
            instancePassCount += moduleInstancePassCount;
            countInBatch++;

            if (countInBatch >= batchSize) {
              await batch.commit();
              batch = writeBatch(db);
              countInBatch = 0;
            }
          }
        }
      }

      if (countInBatch > 0) {
        await batch.commit();
      }

      setAutoReceivePassResult({
        totalModules,
        updatedModules,
        totalInstances,
        updatedInstances: instancePassCount,
      });
      alert(`Hoàn tất tự động bù nhận + pass QC!\n- Tổng module: ${totalModules}\n- Đã cập nhật: ${updatedModules} module\n- Tổng instance: ${totalInstances}\n- Instance đã pass bù: ${instancePassCount}`);
    } catch (error) {
      console.error('Auto receive + pass error:', error);
      setAutoReceivePassResult({
        totalModules,
        updatedModules,
        totalInstances,
        updatedInstances: instancePassCount,
        error: error instanceof Error ? error.message : String(error)
      });
      alert(`Lỗi: ${error instanceof Error ? error.message : String(error)}`);
      handleFirestoreError(error, OperationType.WRITE, 'projects/auto_receive_pass');
    } finally {
      setAutoReceivePassLoading(false);
    }
  };

  const runResetFastPass = async () => {
    setResetQcLoading(true);
    setResetQcResult(null);
    setShowConfirmResetQc(false);
    let updatedCount = 0;
    let skippedCount = 0;
    let totalDocs = 0;

    try {
      if (!resetQcProjectCode) {
        throw new Error("Vui lòng chọn một dự án cụ thể!");
      }

      const configSnap = await getDocs(collection(db, 'projectConfigs'));
      const allModuleDocs: { id: string; data: ProjectEntry; configId: string; projectCode: string }[] = [];
      for (const cfgDoc of configSnap.docs) {
        const configId = cfgDoc.id;
        const pCode = cfgDoc.data().projectCode || cfgDoc.id;
        if (resetQcProjectCode !== 'all' && 
            pCode.toLowerCase() !== resetQcProjectCode.toLowerCase() && 
            configId.toLowerCase() !== resetQcProjectCode.toLowerCase()) {
          continue;
        }
        let q = query(collection(db, 'projectConfigs', configId, 'modules'));
        const modSnap = await getDocs(q);
        modSnap.docs.forEach(d => {
          allModuleDocs.push({ id: d.id, data: d.data() as ProjectEntry, configId, projectCode: pCode });
        });
      }
      totalDocs = allModuleDocs.length;

      const batchSize = 500;
      let batch = writeBatch(db);
      let countInBatch = 0;

      for (const d of allModuleDocs) {
        const data = d.data as ProjectEntry;
        const moduleCode = data.moduleCode || '';
        
        const entryType = getEntryTypeLocal(moduleCode, data);
        const isTargetType = entryType !== 'Thùng' && entryType !== 'Đợt';

        if (isTargetType) {
          const hasQcInfo = 
            data.qcWhite !== undefined || 
            data.qcPaint !== undefined || 
            data.qcPass !== undefined || 
            data.qcStatus !== undefined ||
            (data.instances && data.instances.some((inst: any) => 
              inst.qcWhite !== undefined || 
              inst.qcPaint !== undefined || 
              inst.qcFinish !== undefined || 
              inst.qcPack !== undefined || 
              (inst.qcLogs && inst.qcLogs.length > 0)
            ));
          
          if (hasQcInfo) {
            const updateFields: any = {
              qcWhite: deleteField(),
              qcPaint: deleteField(),
              qcPass: deleteField(),
              qcStatus: deleteField(),
              qcNotes: deleteField(),
              qcPhotos: deleteField(),
              qcDate: deleteField(),
              qcBy: deleteField(),
              qcRole: deleteField()
            };

            if (data.instances && data.instances.length > 0) {
              updateFields.instances = data.instances.map((inst: any) => {
                const newInst = { ...inst };
                delete newInst.qcWhite;
                delete newInst.qcPaint;
                delete newInst.qcFinish;
                delete newInst.qcPack;
                if (newInst.qcLogs && Array.isArray(newInst.qcLogs)) {
                  newInst.qcLogs = newInst.qcLogs.filter((log: any) => 
                    log.stage !== 'white' && log.stage !== 'paint' && log.stage !== 'finish' && log.stage !== 'pack'
                  );
                }
                return newInst;
              });
            }

            batch.update(doc(db, 'projectConfigs', d.configId, 'modules', d.id), updateFields);

            updatedCount++;
            countInBatch++;

            if (countInBatch >= batchSize) {
              await batch.commit();
              batch = writeBatch(db);
              countInBatch = 0;
            }
          } else {
            skippedCount++;
          }
        } else {
          skippedCount++;
        }
      }

      if (countInBatch > 0) {
        await batch.commit();
      }

      await addDoc(collection(db, 'activities'), {
        userId: 'system_testcode',
        userName: 'Hệ thống Quản trị',
        userEmail: 'admin@system.com',
        action: 'Xóa pass nhanh',
        details: `Đã xóa trạng thái PASS nhanh cho các cấu kiện không phải Thùng và Đợt thuộc dự án ${resetQcProjectCode === 'all' ? 'TẤT CẢ' : resetQcProjectCode}. Đã reset ${updatedCount} cấu kiện.`,
        projectCode: resetQcProjectCode === 'all' ? 'SYSTEM' : resetQcProjectCode,
        timestamp: serverTimestamp()
      });

      setResetQcResult({
        total: totalDocs,
        updated: updatedCount,
        skipped: skippedCount
      });
    } catch (error) {
      console.error("Lỗi xóa pass nhanh:", error);
      setResetQcResult({
        total: totalDocs,
        updated: updatedCount,
        skipped: skippedCount,
        error: error instanceof Error ? error.message : String(error)
      });
      handleFirestoreError(error, OperationType.WRITE, 'projects/reset_fast_pass');
    } finally {
      setResetQcLoading(false);
    }
  };

  const runDeleteQcModule = async () => {
    setDeleteQcLoading(true);
    setDeleteQcResult(null);
    setShowConfirmDeleteQc(false);
    let updatedCount = 0;

    try {
      if (!deleteQcProjectCode) {
        throw new Error("Vui lòng chọn một dự án cụ thể hoặc tất cả dự án!");
      }

      const configSnap = await getDocs(collection(db, 'projectConfigs'));
      const allModuleDocs: { id: string; data: any; configId: string; projectCode: string }[] = [];
      for (const cfgDoc of configSnap.docs) {
        const configId = cfgDoc.id;
        const pCode = cfgDoc.data().projectCode || cfgDoc.id;
        if (deleteQcProjectCode !== 'all' && 
            pCode.toLowerCase() !== deleteQcProjectCode.toLowerCase() && 
            configId.toLowerCase() !== deleteQcProjectCode.toLowerCase()) {
          continue;
        }
        let q = query(collection(db, 'projectConfigs', configId, 'modules'));
        const modSnap = await getDocs(q);
        modSnap.docs.forEach(d => {
          allModuleDocs.push({ id: d.id, data: d.data(), configId, projectCode: pCode });
        });
      }

      const snapshot = { size: allModuleDocs.length };
      const batchSize = 500;
      let batch = writeBatch(db);
      let countInBatch = 0;

      for (const d of allModuleDocs) {
        const data = d.data;
        const updateFields: any = {};

        // 1. Determine local variables for stage status
        let finalQcWhite = data.qcWhite;
        let finalQcPaint = data.qcPaint;
        let finalQcFinish = data.qcFinish;
        let finalQcPack = data.qcPack;

        // Luôn dọn dẹp các trường QC ở cấp độ root module vì tất cả xử lý ở instance
        updateFields.qcWhite = deleteField();
        updateFields.qcPaint = deleteField();
        updateFields.qcFinish = deleteField();
        updateFields.qcPack = deleteField();
        updateFields.qcPass = deleteField();
        updateFields.qcStatus = deleteField();
        updateFields.qcNotes = deleteField();
        updateFields.qcPhotos = deleteField();
        updateFields.qcDate = deleteField();
        updateFields.qcBy = deleteField();
        updateFields.qcRole = deleteField();
        updateFields.qcCheckedCriteria = deleteField();
        updateFields.qcCriterionPhotos = deleteField();

        if (deleteQcStage === 'white') {
          finalQcWhite = undefined;
        } else if (deleteQcStage === 'paint') {
          finalQcPaint = undefined;
        } else if (deleteQcStage === 'finish') {
          finalQcFinish = undefined;
        } else if (deleteQcStage === 'pack') {
          finalQcPack = undefined;
        } else if (deleteQcStage === 'all') {
          finalQcWhite = undefined;
          finalQcPaint = undefined;
          finalQcFinish = undefined;
          finalQcPack = undefined;
        }

        // 2. Handle sub-instances in the document
        if (data.instances && data.instances.length > 0) {
          const updatedInstances = data.instances.map((inst: any) => {
            const newInst = { ...inst };
            if (deleteQcStage === 'white') {
              newInst.qcWhite = deleteField() as any;
              if (newInst.qcLogs && Array.isArray(newInst.qcLogs)) {
                newInst.qcLogs = newInst.qcLogs.filter((log: any) => log.stage !== 'white');
              }
            } else if (deleteQcStage === 'paint') {
              newInst.qcPaint = deleteField() as any;
              if (newInst.qcLogs && Array.isArray(newInst.qcLogs)) {
                newInst.qcLogs = newInst.qcLogs.filter((log: any) => log.stage !== 'paint');
              }
            } else if (deleteQcStage === 'finish') {
              newInst.qcFinish = deleteField() as any;
              if (newInst.qcLogs && Array.isArray(newInst.qcLogs)) {
                newInst.qcLogs = newInst.qcLogs.filter((log: any) => log.stage !== 'finish');
              }
            } else if (deleteQcStage === 'pack') {
              newInst.qcPack = deleteField() as any;
              if (newInst.qcLogs && Array.isArray(newInst.qcLogs)) {
                newInst.qcLogs = newInst.qcLogs.filter((log: any) => log.stage !== 'pack');
              }
            } else if (deleteQcStage === 'all') {
              newInst.qcWhite = deleteField() as any;
              newInst.qcPaint = deleteField() as any;
              newInst.qcFinish = deleteField() as any;
              newInst.qcPack = deleteField() as any;
              newInst.qcStatus = deleteField() as any;
              newInst.qcDone = deleteField() as any;
              newInst.qcNotes = deleteField() as any;
              newInst.qcPhotos = deleteField() as any;
              newInst.qcLogs = deleteField() as any;
            }
            return newInst;
          });
          updateFields.instances = updatedInstances;
        }

        // If total reset, reset display name status
        if (deleteQcStage === 'all') {
          if (data.status && (data.status.includes('QC ') || data.status.includes('PASS') || data.status.includes('FAIL'))) {
            updateFields.status = 'Chờ kiểm';
          }
        }

        // Check if any change actually happens (avoid useless writes)
        const hasChanges = Object.keys(updateFields).length > 0;
        if (hasChanges) {
          batch.update(doc(db, 'projectConfigs', d.configId, 'modules', d.id), updateFields);
          updatedCount++;
          countInBatch++;

          if (countInBatch >= batchSize) {
            await batch.commit();
            batch = writeBatch(db);
            countInBatch = 0;
          }
        }
      }

      if (countInBatch > 0) {
        await batch.commit();
      }

      // Xóa module khỏi phiếu QC tương ứng (để badge không hiện "pending" nữa)
      const stagesToClean = deleteQcStage === 'all' ? ['white', 'paint', 'finish', 'pack'] : [deleteQcStage];
      const ticketSnap = await getDocs(query(
        collection(db, 'qc_tickets'),
        where('stage', 'in', stagesToClean),
        where('status', '==', 'pending')
      ));

      let ticketsUpdated = 0;
      for (const ticketDoc of ticketSnap.docs) {
        const ticketData = ticketDoc.data();
        const ticketProjectCode = ticketData.projectCode || '';
        // Chỉ xử lý phiếu thuộc dự án đang xóa
        if (deleteQcProjectCode !== 'all' &&
            ticketProjectCode.toLowerCase() !== deleteQcProjectCode.toLowerCase()) {
          continue;
        }

        const modulesInTicket = ticketData.modules || [];
        if (modulesInTicket.length === 0) continue;

        // Lọc bỏ các module thuộc dự án đang xóa
        const moduleIdsToRemove = new Set(
          allModuleDocs.map(d => d.id)
        );
        const filteredModules = modulesInTicket.filter((m: any) =>
          !moduleIdsToRemove.has(m.moduleId)
        );

        if (filteredModules.length !== modulesInTicket.length) {
          await updateDoc(doc(db, 'qc_tickets', ticketDoc.id), {
            modules: filteredModules
          });
          ticketsUpdated++;
        }
      }

      await addDoc(collection(db, 'activities'), {
        userId: 'system_testcode',
        userName: 'Hệ thống Quản trị',
        userEmail: 'admin@system.com',
        action: 'Xóa QC hàng toàn bộ module',
        details: `Đã xóa dữ liệu QC cho dự án [${deleteQcProjectCode}]. Giai đoạn: ${deleteQcStage}. Đã cập nhật ${updatedCount} cấu kiện, ${ticketsUpdated} phiếu QC.`,
        projectCode: deleteQcProjectCode === 'all' ? 'SYSTEM' : deleteQcProjectCode,
        timestamp: serverTimestamp()
      });

      setDeleteQcResult({
        total: snapshot.size,
        updated: updatedCount
      });

    } catch (err: any) {
      console.error("Lỗi xóa QC hàng toàn bộ module:", err);
      setDeleteQcResult({
        total: 0,
        updated: 0,
        error: err.message || "Đã xảy ra lỗi không xác định!"
      });
    } finally {
      setDeleteQcLoading(false);
    }
  };

  const STAGE_FIELD_MAP: Record<string, string> = {
    white: 'qcWhite',
    paint: 'qcPaint',
    finish: 'qcFinish',
    pack: 'qcPack',
  };

  const runSetPendingInstance = async () => {
    if (!setPendingProjectCode) {
      alert("Vui lòng chọn dự án!");
      return;
    }
    setSetPendingLoading(true);
    setSetPendingResult(null);
    setShowConfirmSetPending(false);

    try {
      // Ưu tiên dùng configId từ existingProjects nếu có
      const existing = existingProjects.find(p => p.projectCode === setPendingProjectCode);
      const configId = existing?.configId || await findProjectConfigId(setPendingProjectCode);
      if (!configId) {
        setSetPendingResult({ total: 0, pending: 0, skipped: 0, error: 'Không tìm thấy dự án!' });
        return;
      }

      const stageField = STAGE_FIELD_MAP[setPendingStage];
      if (!stageField) {
        setSetPendingResult({ total: 0, pending: 0, skipped: 0, error: 'Giai đoạn không hợp lệ!' });
        return;
      }

      const modulesSnap = await getDocs(collection(db, 'projectConfigs', configId, 'modules'));
      let totalCount = 0;
      let pendingCount = 0;
      let skippedCount = 0;

      let batch = writeBatch(db);
      let opCount = 0;

      for (const modDoc of modulesSnap.docs) {
        const entry = modDoc.data() as ProjectEntry;

        // Giai đoạn Hoàn thiện: chỉ set pending cho Thùng
        if (setPendingStage === 'finish') {
          const entryType = getEntryType(entry);
          if (entryType !== 'Thùng') {
            skippedCount++;
            continue;
          }
        }

        const instances = getModuleInstances(entry);

        // === Xử lý instance-level ===
        let hasInstanceChange = false;
        let updatedInstances = instances;

        if (instances.length > 0) {
          updatedInstances = instances.map(inst => {
            totalCount++;
            const stageData = (inst as any)[stageField];
            if (stageData?.status === 'pass') {
              skippedCount++;
              return inst;
            }
            if (stageData?.status === 'pending') {
              skippedCount++;
              return inst;
            }
            pendingCount++;
            hasInstanceChange = true;
            return {
              ...inst,
              [stageField]: {
                status: 'pending',
                by: 'Admin TestCode',
                date: new Date(),
                notes: '',
                photos: []
              }
            };
          });
        }

        // === Xử lý module-level (bao gồm Thùng/moduleType=bo) ===
        let hasModuleChange = false;
        const moduleStageData = (entry as any)[stageField];

        // Set pending cho module-level nếu chưa pass và chưa pending
        if (moduleStageData?.status !== 'pass' && moduleStageData?.status !== 'pending') {
          totalCount++;
          // Nếu module ko có instances (Thùng/bo), set pending ở module-level
          if (instances.length === 0) {
            pendingCount++;
          } else if (!hasInstanceChange) {
            // Nếu instances đều pass/pending nhưng module-level chưa set → vẫn set
            pendingCount++;
          } else {
            pendingCount--; // Đã đếm ở instance-level, không đếm lại
          }
          hasModuleChange = true;
        } else if (moduleStageData?.status === 'pass' || moduleStageData?.status === 'pending') {
          skippedCount++;
        }

        if (hasInstanceChange || hasModuleChange) {
          const updateData: Record<string, any> = {};
          if (hasInstanceChange) {
            updateData.instances = updatedInstances;
          }
          if (hasModuleChange) {
            updateData[stageField] = {
              status: 'pending',
              by: 'Admin TestCode',
              date: new Date(),
              notes: '',
              photos: []
            };
          }
          batch.update(doc(db, 'projectConfigs', configId, 'modules', modDoc.id), updateData);
          opCount++;
          if (opCount >= 450) {
            await batch.commit();
            batch = writeBatch(db);
            opCount = 0;
          }
        }
      }

      if (opCount > 0) {
        await batch.commit();
      }

      await addDoc(collection(db, 'activities'), {
        userId: 'system_testcode',
        userName: 'Hệ thống Quản trị',
        userEmail: 'admin@system.com',
        action: 'Set Pending Instance QC',
        details: `Đã set pending giai đoạn [${setPendingStage.toUpperCase()}] cho ${pendingCount} instance/module trong dự án ${setPendingProjectCode}. Bỏ qua ${skippedCount} instance đã pass/pending.`,
        projectCode: setPendingProjectCode,
        timestamp: serverTimestamp()
      });

      setSetPendingResult({
        total: totalCount,
        pending: pendingCount,
        skipped: skippedCount
      });
    } catch (err: any) {
      console.error('Lỗi set pending instance:', err);
      setSetPendingResult({ total: 0, pending: 0, skipped: 0, error: err.message || 'Đã xảy ra lỗi!' });
    } finally {
      setSetPendingLoading(false);
    }
  };

  const runResetStt = async () => {
    if (!resetSttProjectCode) {
      alert("Vui lòng chọn một dự án cụ thể trước!");
      return;
    }

    setResetSttLoading(true);
    setResetSttResult(null);
    setShowConfirmResetStt(false);

    try {
      const targetProj = existingProjects.find(p => p.projectCode === resetSttProjectCode);
      const configId = targetProj?.configId || resetSttProjectCode;

      // 1. Fetch all modules of target project
      const q = query(collection(db, 'projectConfigs', configId, 'modules'));
      const querySnap = await getDocs(q);

      let totalModules = 0;
      let totalInstances = 0;

      let batch = writeBatch(db);
      let opCount = 0;

      for (const d of querySnap.docs) {
        const entry = d.data() as any;
        const updateData: any = {};
        let hasChanges = false;

        // If 'bo' moduleType, reset top-level 'stt' and 'tempPrintOrder'
        if (entry.moduleType === 'bo') {
          if (entry.stt !== undefined && entry.stt !== null) {
            updateData.stt = null;
            hasChanges = true;
          }
          if (entry.tempPrintOrder !== undefined && entry.tempPrintOrder !== null) {
            updateData.tempPrintOrder = null;
            hasChanges = true;
          }
          totalInstances += 1;
        } else {
          // If normal moduleType, map through 'instances' and reset each instance's 'stt' and 'tempPrintOrder'
          const insts = entry.instances || [];
          let instsChanged = false;

          const updatedInsts = insts.map((inst: any) => {
            let itemChanged = false;
            const copy = { ...inst };

            if (copy.stt !== undefined && copy.stt !== null) {
              copy.stt = null;
              itemChanged = true;
            }
            if (copy.tempPrintOrder !== undefined && copy.tempPrintOrder !== null) {
              copy.tempPrintOrder = null;
              itemChanged = true;
            }

            if (itemChanged) {
              instsChanged = true;
              totalInstances += 1;
            }
            return copy;
          });

          if (instsChanged) {
            updateData.instances = updatedInsts;
            hasChanges = true;
          }
        }

        // Also clean up top-level 'stt' and 'tempPrintOrder' if mistakenly present in normal modules
        if (entry.moduleType !== 'bo') {
          if (entry.stt !== undefined && entry.stt !== null) {
            updateData.stt = null;
            hasChanges = true;
          }
          if (entry.tempPrintOrder !== undefined && entry.tempPrintOrder !== null) {
            updateData.tempPrintOrder = null;
            hasChanges = true;
          }
        }

        if (hasChanges) {
          totalModules += 1;
          batch.update(doc(db, 'projectConfigs', configId, 'modules', d.id), updateData);
          opCount += 1;

          if (opCount >= 400) {
            await batch.commit();
            batch = writeBatch(db);
            opCount = 0;
          }
        }
      }

      // 2. Delete stt tracker document to allow restart from 1
      const trackerRef = doc(db, 'project_stt_tracker', resetSttProjectCode);
      batch.delete(trackerRef);
      opCount += 1;

      if (opCount > 0) {
        await batch.commit();
      }

      // Log system operation
      try {
        const targetProj = existingProjects.find(p => p.projectCode === resetSttProjectCode);
        const nameDisplay = targetProj ? targetProj.projectName : resetSttProjectCode;
        await addDoc(collection(db, 'activities'), {
          userId: 'system_testcode',
          userName: 'Hệ thống Quản trị',
          userEmail: 'admin@system.com',
          action: 'Reset STT Tem Tạm',
          details: `Đã reset toàn bộ Số thứ tự (stt) cho dự án [${resetSttProjectCode}] - ${nameDisplay}. Số lượng module xử lý: ${totalModules}, Số lượng instance xử lý: ${totalInstances}.`,
          projectCode: resetSttProjectCode,
          timestamp: serverTimestamp()
        });
      } catch (logErr) {
        console.error('Lỗi khi lưu activity log:', logErr);
      }

      setResetSttResult({
        totalModules,
        totalInstances
      });

    } catch (error: any) {
      console.error('Lỗi khi hiển thị/reset STT:', error);
      setResetSttResult({
        totalModules: 0,
        totalInstances: 0,
        error: error instanceof Error ? error.message : String(error)
      });
      handleFirestoreError(error, OperationType.WRITE, `projects/reset_stt/${resetSttProjectCode}`);
    } finally {
      setResetSttLoading(false);
    }
  };

  const runPassUnpassedPackedItems = async () => {
    setPackPassLoading(true);
    setPackPassResult(null);
    setShowConfirmPackPass(false);
    let updatedCount = 0;
    let totalChecked = 0;

    try {
      // 1. Fetch all project entries
      const configSnap = await getDocs(collection(db, 'projectConfigs'));
      const projectDocs: { id: string; data: any; projectCode: string }[] = [];
      for (const cfgDoc of configSnap.docs) {
        const pCode = cfgDoc.data().projectCode || cfgDoc.id;
        const modSnap = await getDocs(collection(db, 'projectConfigs', pCode, 'modules'));
        modSnap.docs.forEach(d => {
          projectDocs.push({ id: d.id, data: d.data(), projectCode: pCode });
        });
      }

      // 2. Fetch all packing list documents
      const packingRef = collection(db, 'packing');
      const packingSnapshot = await getDocs(packingRef);
      const packingLists = packingSnapshot.docs.map(docSnap => ({
        id: docSnap.id,
        ...docSnap.data()
      })) as any[];

      // Tình trạng: Tập hợp tất cả các module có thông tin "đã đóng gói" (packed: true) trong danh sách đóng gói
      const packedModuleSet = new Set<string>();   // Lưu ID dự án đã được đóng gói chuẩn
      const packedModuleByNameSet = new Set<string>(); // Lưu mã/tên cấu kiện đã được đóng gói

      packingLists.forEach(pl => {
        if (pl.items && Array.isArray(pl.items)) {
          pl.items.forEach((item: any) => {
            if (item.packed === true || (typeof item.packedQty === 'number' && item.packedQty >= item.quantity)) {
              if (item.id) {
                packedModuleSet.add(item.id);
              }
              if (item.name) {
                packedModuleByNameSet.add(item.name.toLowerCase().trim());
              }
            }
          });
        }
      });

      // 3. Tiến hành duyệt toàn bộ dự án
      const batchSize = 500;
      let batch = writeBatch(db);
      let countInBatch = 0;

      for (const pDoc of projectDocs) {
        const data = pDoc.data as ProjectEntry;
        const entryId = pDoc.id;
        const entryStatus = data.status || '';
        const moduleName = (data.moduleCode || '').toLowerCase().trim();

        const isPackedInSystem = 
          entryStatus === 'Đóng Gói' || 
          packedModuleSet.has(entryId) || 
          packedModuleByNameSet.has(moduleName);

        const isAlreadyPassed = getModuleQcAggregate(data, 'pack')?.status === 'pass';

        if (isPackedInSystem) {
          totalChecked++;
          if (!isAlreadyPassed) {
            const nextHistory = [...(data.statusHistory || [])];
            // Thêm lịch sử trạng thái nếu chưa có Đóng Gói
            if (entryStatus !== 'Đóng Gói') {
              if (!nextHistory.length || nextHistory[nextHistory.length - 1].split('|')[0] !== 'Đóng Gói') {
                nextHistory.push(`Đóng Gói (Đồng bộ QC Đóng gói)|${Date.now()}`);
              }
            }

            const currentInstances = getModuleInstances(data);
            const updatedInstances = currentInstances.map((inst: any) => {
              const currentLogs = inst.qcLogs || [];
              const instStageData = {
                status: 'pass' as const,
                date: new Date().toISOString(),
                by: 'Lê Ngọc Huy',
                notes: 'Pass tự động từ trang Tool (Đã đóng gói)',
                photos: [],
                checkedCriteria: {},
              };
              return {
                ...inst,
                qcPack: instStageData,
                qcLogs: [
                  ...currentLogs.filter((log: any) => log.stage !== 'pack'),
                  {
                    stage: 'pack',
                    status: 'pass' as const,
                    date: new Date().toISOString(),
                    by: 'Lê Ngọc Huy',
                    notes: 'Pass tự động từ trang Tool (Đã đóng gói)',
                    photos: []
                  }
                ]
              };
            });

            const docRef = doc(db, 'projectConfigs', pDoc.projectCode, 'modules', entryId);
            batch.update(docRef, {
              status: 'Đóng Gói',
              statusHistory: nextHistory,
              qcWhite: deleteField(),
              qcPaint: deleteField(),
              qcFinish: deleteField(),
              qcPack: deleteField(),
              qcPass: deleteField(),
              qcStatus: deleteField(),
              qcNotes: deleteField(),
              qcPhotos: deleteField(),
              qcDate: deleteField(),
              qcBy: deleteField(),
              qcRole: deleteField(),
              qcCheckedCriteria: deleteField(),
              qcCriterionPhotos: deleteField(),
              instances: updatedInstances
            });

            updatedCount++;
            countInBatch++;

            if (countInBatch >= batchSize) {
              await batch.commit();
              batch = writeBatch(db);
              countInBatch = 0;
            }
          }
        }
      }

      if (countInBatch > 0) {
        await batch.commit();
      }

      // Ghi nhận lịch sử hoạt động
      await addDoc(collection(db, 'activities'), {
        userId: 'system_testcode',
        userName: 'Hệ thống Quản trị',
        userEmail: 'admin@system.com',
        action: 'Pass đóng gói hàng loạt',
        details: `Đồng bộ QC PASS Đóng gói cho các cấu kiện đã lắp ráp/đóng gói hoàn tất. Đã duyệt ${totalChecked} cấu kiện, cập nhật thành công ${updatedCount} cấu kiện chưa được PASS QC Đóng gói trước đó. Người duyệt mặc định: Lê Ngọc Huy.`,
        projectCode: 'SYSTEM',
        timestamp: serverTimestamp()
      });

      setPackPassResult({
        total: totalChecked,
        updated: updatedCount
      });

    } catch (error: any) {
      console.error(error);
      setPackPassResult({
        total: totalChecked,
        updated: updatedCount,
        error: error.message || String(error)
      });
      handleFirestoreError(error, OperationType.WRITE, 'projects/sync_pack_pass');
    } finally {
      setPackPassLoading(false);
    }
  };

  const [reclassifyLoading, setReclassifyLoading] = useState(false);
  const [reclassifyProjectCode, setReclassifyProjectCode] = useState<string>('all');
  const [reclassifyResult, setReclassifyResult] = useState<{
    totalChecked: number;
    totalUpdated: number;
    totalCreated: number;
    totalWithPins: number;
    error?: string;
  } | null>(null);

  const handleReclassifyAll = async () => {
    setReclassifyLoading(true);
    setReclassifyResult(null);
    try {
      const configSnap = await getDocs(collection(db, 'projectConfigs'));
      const allDocs: { id: string; data: ProjectEntry; projectCode: string }[] = [];
      for (const cfgDoc of configSnap.docs) {
        const pCode = cfgDoc.data().projectCode || cfgDoc.id;
        let q = query(collection(db, 'projectConfigs', pCode, 'modules'));
        if (reclassifyProjectCode !== 'all') {
          q = query(collection(db, 'projectConfigs', pCode, 'modules'), where('projectCode', '==', reclassifyProjectCode));
        }
        const modSnap = await getDocs(q);
        modSnap.docs.forEach(d => {
          allDocs.push({ id: d.id, data: d.data() as ProjectEntry, projectCode: pCode });
        });
      }
      const docs = allDocs;
      
      const batchSize = 400;
      let batch = writeBatch(db);
      let countInBatch = 0;
      let updatedCount = 0;
      let createdCount = 0;
      let totalWithPins = 0;
      
      const existingKeys = new Set<string>();
      for (const d of docs) {
        const entry = d.data as ProjectEntry;
        if (entry.projectCode && entry.moduleCode) {
          existingKeys.add(`${entry.projectCode}::${entry.moduleCode.trim()}`);
        }
      }
      
      for (const d of docs) {
        const entry = d.data as ProjectEntry;
        const code = entry.moduleCode || '';
        const codeLower = code.toLowerCase();
        
        let computedClass: 'Thùng' | 'Cánh' | 'Đợt' | 'Mặt HK' | 'CTHT';
        if (codeLower.includes('cánh') || codeLower.includes('canh') || codeLower.includes('cửa') || codeLower.includes('cua')) {
          computedClass = 'Cánh';
        } else if (codeLower.includes('đợt') || codeLower.includes('dot')) {
          computedClass = 'Đợt';
        } else if (codeLower.includes('mặt') || codeLower.includes('mat')) {
          computedClass = 'Mặt HK';
        } else {
          const isOriginalCTHT = codeLower.includes('tấm hoàn thiện') || codeLower.includes('tam hoan thien') || codeLower.includes('hoàn thiện') || codeLower.includes('hoan thien') || codeLower.includes('ctht') || code.split('_').length >= 3;
          if (isOriginalCTHT) {
            computedClass = 'CTHT';
          } else {
            computedClass = 'Thùng';
          }
        }
        
        if (entry.classification !== computedClass) {
          batch.update(doc(db, 'projectConfigs', d.projectCode, 'modules', d.id), {
            classification: computedClass
          });
          updatedCount++;
          countInBatch++;
          
          if (countInBatch >= batchSize) {
            await batch.commit();
            batch = writeBatch(db);
            countInBatch = 0;
          }
        }

        // Tự tạo module cho Đợt nếu module cha có chứa Chốt đợt di động mà không có Đợt di động
        const chotDotQty = (entry.accessories && Array.isArray(entry.accessories))
          ? entry.accessories.reduce((sumVal: number, acc: any) => {
              const nameRaw = acc.name || '';
              const normalized = normalizeAccessoryName(nameRaw);
              const isChotDot = 
                normalized.includes('chot dot') || 
                normalized.includes('cddd') || 
                normalized.includes('cddd');
              if (isChotDot) {
                return sumVal + (Number(acc.quantity) || 0);
              }
              return sumVal;
            }, 0)
          : 0;

        if (chotDotQty > 0 && entry.projectCode && entry.moduleCode) {
          totalWithPins++;
          const shelfModuleCode = makeShelfModuleCode(entry.moduleCode);
          const lookupKey = `${entry.projectCode}::${shelfModuleCode}`;
          
          if (!existingKeys.has(lookupKey)) {
            const shelfQty = Math.floor(chotDotQty / 4);
            const finalShelfQty = shelfQty > 0 ? shelfQty : 1;
          const newDocRef = doc(collection(db, 'projectConfigs', entry.projectCode, 'modules'));
            
            batch.set(newDocRef, {
              projectName: entry.projectName || '',
              projectCode: entry.projectCode,
              displayCode: entry.moduleCode || entry.projectCode,
              drawingUrl: entry.drawingUrl || '',
              assemblyDrawingUrl: entry.assemblyDrawingUrl || '',
              glbUrl: entry.glbUrl || '',
              cluster: entry.cluster || '',
              moduleCode: shelfModuleCode,
              quantity: finalShelfQty,
              classification: 'Đợt',
              width: 0,
              depth: 0,
              height: 0,
              pWidth: 0,
              pDepth: 0,
              pHeight: 0,
              accessories: [],
              status: '',
              statusHistory: [],
              ownerId: 'system_shelf',
              notes: `Tạo tự động từ chốt đợt di động của ${entry.moduleCode}`,
              createdAt: serverTimestamp(),
              sortIndex: (entry.sortIndex || 0) + 1
            });
            
            existingKeys.add(lookupKey);
            createdCount++;
            countInBatch++;
            
            if (countInBatch >= batchSize) {
              await batch.commit();
              batch = writeBatch(db);
              countInBatch = 0;
            }
          }
        }
      }
      
      if (countInBatch > 0) {
        await batch.commit();
      }
      
      setReclassifyResult({
        totalChecked: docs.length,
        totalUpdated: updatedCount,
        totalCreated: createdCount,
        totalWithPins
      });
    } catch (err: any) {
      console.error("Lỗi phân loại lại modules và tạo đợt di động:", err);
      setReclassifyResult({
        totalChecked: 0,
        totalUpdated: 0,
        totalCreated: 0,
        totalWithPins: 0,
        error: err.message || String(err)
      });
    } finally {
      setReclassifyLoading(false);
    }
  };

  const formatReportDate = (timestamp: any): string => {
    if (!timestamp) return '---';
    if (timestamp.seconds) {
      return new Date(timestamp.seconds * 1000).toLocaleString('vi-VN');
    }
    if (timestamp instanceof Date) {
      return timestamp.toLocaleString('vi-VN');
    }
    return String(timestamp);
  };

  const renderPrintTicket = () => {
    if (!selectedPrintTicket) {
      return (
        <div className="text-center py-12 text-slate-400 font-extrabold uppercase text-xs tracking-wider">
          Vui lòng chọn hoặc tạo mới một phiếu chờ kiểm để in.
        </div>
      );
    }
    
    return (
      <div className="space-y-6">
        {/* Header */}
        <div className="flex justify-between items-start border-b-2 border-slate-900 pb-4">
          <div>
            <h4 className="text-xs font-black text-slate-500 uppercase tracking-widest">HỆ THỐNG PHÂN XƯỞNG DRACO X2</h4>
            <p className="text-[10px] font-bold text-slate-400">BỘ PHẬN KIỂM SOÁT CHẤT LƯỢNG (QC)</p>
          </div>
          <div className="text-right">
            <h4 className="text-xs font-black text-indigo-600 uppercase tracking-wide">MÃ PHIẾU: #{selectedPrintTicket.id?.substring(0, 8).toUpperCase()}</h4>
            <p className="text-[10px] font-bold text-slate-400">Xuất báo cáo: {new Date().toLocaleDateString('vi-VN')}</p>
          </div>
        </div>

        {/* Title */}
        <div className="text-center my-6">
          <h2 className="text-lg font-black text-slate-900 uppercase tracking-widest">PHIẾU YÊU CẦU KIỂM TRA CHẤT LƯỢNG</h2>
          <p className="text-xs text-slate-500 font-bold uppercase mt-1">Trạng thái: CHỜ KIỂM DUYỆT (PENDING)</p>
        </div>

        {/* Metadata Info */}
        <div className="grid grid-cols-2 gap-4 bg-slate-50 p-4 rounded-lg border border-slate-100 text-xs text-slate-700">
          <div>
            <p className="font-medium text-slate-500">Dự án:</p>
            <p className="font-black text-slate-900 uppercase">{selectedPrintTicket.projectCode}</p>
          </div>
          <div>
            <p className="font-medium text-slate-500">Công đoạn kiểm tra:</p>
            <p className="font-black text-indigo-600 uppercase">{selectedPrintTicket.stage === 'qc_tho' ? 'QC Thô' : selectedPrintTicket.stage === 'qc_son' ? 'QC Sơn' : selectedPrintTicket.stage === 'qc_hoanthien' ? 'QC Hoàn thiện' : selectedPrintTicket.stage === 'qc_donggoi' ? 'QC Đóng gói' : selectedPrintTicket.stage || 'N/A'}</p>
          </div>
          <div>
            <p className="font-medium text-slate-500">Người lập phiếu:</p>
            <p className="font-bold text-slate-800">{selectedPrintTicket.createdBy || selectedPrintTicket.createdByEmail || 'Hệ thống'}</p>
          </div>
          <div>
            <p className="font-medium text-slate-500">Thời gian khởi tạo:</p>
            <p className="font-bold text-slate-800">{formatReportDate(selectedPrintTicket.createdAt)}</p>
          </div>
        </div>

        {/* Table of items */}
        <div className="mt-6">
          <table className="w-full text-xs text-left text-slate-500 border-collapse">
            <thead>
              <tr className="bg-slate-100 font-black border-y border-slate-900 text-slate-800 uppercase tracking-wider text-[10px]">
                <th className="py-2.5 px-2 w-12 text-center">STT</th>
                <th className="py-2.5 px-3">Mã Cấu Kiện (Module Code)</th>
                <th className="py-2.5 px-3">Phân Cụm (Cluster)</th>
                <th className="py-2.5 px-3 text-center">Số Lượng Yêu Cầu</th>
                <th className="py-2.5 px-3 border-l border-slate-200">Kết quả QC</th>
                <th className="py-2.5 px-3 border-l border-slate-200">Ghi chú lỗi / Kỹ thuật</th>
              </tr>
            </thead>
            <tbody>
              {(selectedPrintTicket.modules || []).map((m: any, idx: number) => (
                <tr key={idx} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="py-3 px-2 text-center text-slate-700 font-bold">{idx + 1}</td>
                  <td className="py-3 px-3 text-slate-900 font-black font-mono">{m.moduleCode}</td>
                  <td className="py-3 px-3 uppercase text-[10px] font-black">{m.cluster || 'N/A'}</td>
                  <td className="py-3 px-3 text-center text-slate-900 font-black">{m.quantity || 1} Pcs</td>
                  <td className="py-3 px-3 border-l border-slate-200 text-slate-300 font-bold uppercase text-[10px] italic">[ &nbsp; ] Đạt &nbsp; [ &nbsp; ] Lỗi</td>
                  <td className="py-3 px-3 border-l border-slate-200 text-slate-300 italic text-[10px]">[ ............................................. ]</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Signature Section */}
        <div className="grid grid-cols-3 gap-4 text-center mt-12 pt-8 border-t border-dotted border-slate-200 text-xs">
          <div>
            <p className="font-extrabold uppercase text-slate-500 tracking-wider">Người yêu cầu kiểm</p>
            <p className="text-[10px] text-slate-400 italic mb-12">(Ký & ghi rõ họ tên)</p>
            <p className="font-semibold text-slate-800 text-[11px]">{selectedPrintTicket.createdBy || selectedPrintTicket.createdByEmail || '.................................'}</p>
          </div>
          <div>
            <p className="font-extrabold uppercase text-slate-500 tracking-wider">Nhân viên Giám sát QC</p>
            <p className="text-[10px] text-slate-400 italic mb-12">(Ký & ghi rõ họ tên)</p>
            <p className="font-bold text-slate-300">............................................</p>
          </div>
          <div>
            <p className="font-extrabold uppercase text-slate-500 tracking-wider">Ban quản đốc/Kỹ thuật</p>
            <p className="text-[10px] text-slate-400 italic mb-12">(Ký duyệt & đóng dấu)</p>
            <p className="font-bold text-slate-300">............................................</p>
          </div>
        </div>
      </div>
    );
  };

  const renderPrintProject = () => {
    if (projectModules.length === 0) {
      return (
        <div className="text-center py-12 text-slate-400 font-extrabold uppercase text-xs tracking-wider">
          Không có dữ liệu cấu kiện hoặc dự án. Vui lòng chọn một dự án hợp lệ.
        </div>
      );
    }

    const totalEntries = projectModules.length;
    const totalQuantity = projectModules.reduce((sum, m) => sum + (Number(m.quantity) || 0), 0);
    
    const classMap = new Map<string, { count: number, qty: number }>();
    projectModules.forEach(m => {
      const classification = m.classification || 'Phát sinh';
      if (!classMap.has(classification)) {
        classMap.set(classification, { count: 0, qty: 0 });
      }
      const stat = classMap.get(classification)!;
      stat.count += 1;
      stat.qty += Number(m.quantity) || 0;
    });

    return (
      <div className="space-y-6">
        {/* Header */}
        <div className="flex justify-between items-start border-b-2 border-slate-900 pb-4">
          <div>
            <h4 className="text-xs font-black text-slate-500 uppercase tracking-widest">HỆ THỐNG SẢN XUẤT DRACO X2</h4>
            <p className="text-[10px] font-bold text-slate-400">BỘ PHẬN QUẢN LÝ DỰ ÁN & THIẾT KẾ KỸ THUẬT</p>
          </div>
          <div className="text-right">
            <h4 className="text-xs font-black text-indigo-600 uppercase tracking-wide">MÃ DỰ ÁN: {reportProjectCode}</h4>
            <p className="text-[10px] font-bold text-slate-400">Ngày xuất: {new Date().toLocaleDateString('vi-VN')}</p>
          </div>
        </div>

        {/* Title */}
        <div className="text-center my-6">
          <h2 className="text-lg font-black text-slate-900 uppercase tracking-widest">BẢNG KÊ CHI TIẾT CẤU KIỆN DỰ ÁN</h2>
          <p className="text-xs text-slate-500 font-extrabold uppercase mt-1">Dự án: {formatProjectName(projectModules[0]?.projectName) || reportProjectCode}</p>
        </div>

        {/* Stats Cards Breakdown */}
        <div className="grid grid-cols-4 gap-4 bg-slate-50 p-4 rounded-lg border border-slate-100 text-xs text-slate-700">
          <div className="text-center py-1 border-r border-slate-200">
            <span className="block font-medium text-slate-400 uppercase tracking-wider text-[9px] mb-0.5">Tổng loại cấu kiện</span>
            <span className="text-base font-black text-indigo-600">{totalEntries}</span>
          </div>
          <div className="text-center py-1 border-r border-slate-200">
            <span className="block font-medium text-slate-400 uppercase tracking-wider text-[9px] mb-0.5">Tổng số lượng (Pcs)</span>
            <span className="text-base font-black text-emerald-600">{totalQuantity}</span>
          </div>
          <div className="text-center py-1 border-r border-slate-200">
            <span className="block font-medium text-slate-400 uppercase tracking-wider text-[9px] mb-0.5">Mã hiển thị dự án</span>
            <span className="text-base font-black text-slate-700 uppercase">{projectModules[0]?.displayCode || reportProjectCode}</span>
          </div>
          <div className="text-center py-1 flex items-center justify-center">
            <span className="text-[9px] font-semibold text-slate-600 leading-tight">
              {Array.from(classMap.entries()).map(([cls, stat]) => `${cls}: ${stat.qty}`).join(' | ')}
            </span>
          </div>
        </div>

        {/* Table of items */}
        <div className="mt-6">
          <table className="w-full text-xs text-left text-slate-500 border-collapse">
            <thead>
              <tr className="bg-slate-100 font-black border-y border-slate-900 text-slate-800 uppercase tracking-wider text-[9px]">
                <th className="py-2 px-1 w-10 text-center">STT</th>
                <th className="py-2 px-2">Mã cấu kiện</th>
                <th className="py-2 px-2">Phân loại</th>
                <th className="py-2 px-2 uppercase text-center">Phân cụm</th>
                <th className="py-2 px-2 text-center">Kích thước (D x R x Dày)</th>
                <th className="py-2 px-2 text-center">Số lượng</th>
                <th className="py-2 px-2 text-right">Trạng thái hiện tại</th>
              </tr>
            </thead>
            <tbody>
              {projectModules.map((m: any, idx: number) => (
                <tr key={idx} className="border-b border-slate-100 hover:bg-slate-50 text-[11px]">
                  <td className="py-2 px-1 text-center font-bold text-slate-500">{idx + 1}</td>
                  <td className="py-2 px-2 font-black text-slate-900 font-mono">{m.moduleCode}</td>
                  <td className="py-2 px-2 font-extrabold uppercase text-slate-600 text-[10px]">{m.classification || 'Chưa XL'}</td>
                  <td className="py-2 px-2 text-center font-black uppercase text-slate-500 text-[10px]">{m.cluster || 'N/A'}</td>
                  <td className="py-2 px-2 text-center font-bold text-slate-700 font-mono">{m.Dai || m.dai || '0'} x {m.Rong || m.rong || '0'} x {m.Day || m.day || '0'} mm</td>
                  <td className="py-2 px-2 text-center font-black text-indigo-600">{m.quantity || 1} Pcs</td>
                  <td className="py-2 px-2 text-right font-black text-slate-500 text-[10px] uppercase tracking-tighter">{m.status || 'Chưa nhận'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Signature Section */}
        <div className="grid grid-cols-3 gap-4 text-center mt-12 pt-8 border-t border-dotted border-slate-200 text-xs">
          <div>
            <p className="font-extrabold uppercase text-slate-500 tracking-wider">Người lập biểu kê</p>
            <p className="text-[10px] text-slate-400 italic mb-12">(Ký & ghi rõ họ tên)</p>
            <p className="font-bold text-slate-300">............................................</p>
          </div>
          <div>
            <p className="font-extrabold uppercase text-slate-500 tracking-wider">Kiểm soát Kỹ thuật</p>
            <p className="text-[10px] text-slate-400 italic mb-12">(Ký & ghi rõ họ tên)</p>
            <p className="font-bold text-slate-300">............................................</p>
          </div>
          <div>
            <p className="font-extrabold uppercase text-slate-500 tracking-wider">Giám đốc quản lý dự án</p>
            <p className="text-[10px] text-slate-400 italic mb-12">(Ký duyệt & đóng dấu)</p>
            <p className="font-bold text-slate-300">............................................</p>
          </div>
        </div>
      </div>
    );
  };

  const renderPrintPacking = () => {
    if (!selectedPrintPacking) {
      return (
        <div className="text-center py-12 text-slate-400 font-extrabold uppercase text-xs tracking-wider">
          Vui lòng chọn hoặc tạo mới một Packing List phục vụ in ấn.
        </div>
      );
    }

    return (
      <div className="space-y-6">
        {/* Header */}
        <div className="flex justify-between items-start border-b-2 border-slate-900 pb-4">
          <div>
            <h4 className="text-xs font-black text-slate-500 uppercase tracking-widest">HỆ THỐNG KHO VẬN VÀ LOGISTICS DRACO X2</h4>
            <p className="text-[10px] font-bold text-slate-400">PHÒNG QUẢN LÝ KHO THÀNH PHẨM & ĐÓNG GÓI</p>
          </div>
          <div className="text-right">
            <h4 className="text-xs font-black text-indigo-600 uppercase tracking-wide">MÃ PACKING ID: #{selectedPrintPacking.id?.substring(0, 8).toUpperCase()}</h4>
            <p className="text-[10px] font-bold text-slate-400">Ngày in: {new Date().toLocaleDateString('vi-VN')}</p>
          </div>
        </div>

        {/* Title */}
        <div className="text-center my-6">
          <h2 className="text-lg font-black text-slate-900 uppercase tracking-widest">PHIẾU ĐÓNG GÓI CHI TIẾT (PACKING LIST SLIP)</h2>
          <p className="text-xs text-slate-500 font-extrabold uppercase mt-1">{selectedPrintPacking.title}</p>
        </div>

        {/* Metadata Info */}
        <div className="grid grid-cols-2 gap-4 bg-slate-50 p-4 rounded-lg border border-slate-100 text-xs text-slate-700">
          <div>
            <p className="font-medium text-slate-500">Mã Dự án Gốc:</p>
            <p className="font-black text-slate-900 uppercase">{selectedPrintPacking.projectCode || 'N/A'}</p>
          </div>
          <div>
            <p className="font-medium text-slate-500">Người thực hiện đóng gói:</p>
            <p className="font-black text-slate-900 uppercase">{selectedPrintPacking.userName || 'Kho vận Admin'}</p>
          </div>
          <div>
            <p className="font-medium text-slate-500">Thời gian tạo phiếu:</p>
            <p className="font-bold text-slate-800">{formatReportDate(selectedPrintPacking.createdAt)}</p>
          </div>
          <div>
            <p className="font-medium text-slate-500 font-bold">Tổng quan đóng gói:</p>
            <p className={`font-black uppercase text-[10px] ${selectedPrintPacking.isCompleted ? 'text-emerald-600' : 'text-amber-500'}`}>
              {selectedPrintPacking.isCompleted ? 'HOÀN THÀNH - ĐÃ ĐÓNG GÓI TẤT CẢ' : 'CHƯA HOÀN THÀNH (ĐANG ĐÓNG GÓI)'}
            </p>
          </div>
        </div>

        {/* Table of items */}
        <div className="mt-6">
          <table className="w-full text-xs text-left text-slate-500 border-collapse">
            <thead>
              <tr className="bg-slate-100 font-black border-y border-slate-900 text-slate-800 uppercase tracking-wider text-[10px]">
                <th className="py-2.5 px-2 w-12 text-center">STT</th>
                <th className="py-2.5 px-3">Tên Cấu Kiện / Phụ Kiện (Item Description)</th>
                <th className="py-2.5 px-3 uppercase text-center">Phân cụm</th>
                <th className="py-2.5 px-3 text-center">Số Lượng Đáng Kể</th>
                <th className="py-2.5 px-3 text-center">Trạng Thái Đóng</th>
                <th className="py-2.5 px-3 text-right">Chi tiết đợt / Phụ kiện</th>
              </tr>
            </thead>
            <tbody>
              {(selectedPrintPacking.items || []).map((item: any, idx: number) => {
                const hasAccessories = item.accessories && item.accessories.length > 0;
                return (
                  <tr key={idx} className="border-b border-slate-100 hover:bg-slate-50 text-[11px]">
                    <td className="py-2.5 px-2 text-center text-slate-600 font-bold">{idx + 1}</td>
                    <td className="py-2.5 px-3">
                      <div className="font-black text-slate-900 font-mono leading-tight">{item.name}</div>
                      {item.type && <span className="text-[9px] uppercase font-bold text-slate-400 tracking-wider">Loại: {item.type}</span>}
                    </td>
                    <td className="py-2.5 px-3 text-center font-black uppercase text-slate-500 text-[10px]">{item.cluster || 'Phổ thông'}</td>
                    <td className="py-2.5 px-3 text-center font-black text-slate-900">{item.quantity || 1} cái</td>
                    <td className="py-2.5 px-3 text-center">
                      <span className={`px-2 py-0.5 rounded-sm font-black text-[9px] uppercase ${item.packed ? 'bg-emerald-50 text-emerald-700 border border-emerald-100' : 'bg-red-50 text-red-600'}`}>
                        {item.packed ? 'Đã đóng xếp' : 'Chưa đóng'}
                      </span>
                    </td>
                    <td className="py-2.5 px-3 text-right text-slate-500 text-[10px] italic">
                      {hasAccessories ? (
                        <div className="space-y-0.5 bg-slate-50/50 p-1.5 rounded border border-slate-100 text-[9px]">
                          {item.accessories.map((acc: any, aidx: number) => (
                            <div key={aidx} className="flex justify-between gap-2">
                              <span>{acc.name}:</span>
                              <span className="font-black font-sans shrink-0">{acc.quantity} cái {acc.checked ? '✓' : '✗'}</span>
                            </div>
                          ))}
                        </div>
                      ) : item.hasMobileShelf ? (
                        <span>Đợt di động ({item.shelfQuantity || 0} cái)</span>
                      ) : (
                        '---'
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Signature Section */}
        <div className="grid grid-cols-3 gap-4 text-center mt-12 pt-8 border-t border-dotted border-slate-200 text-xs">
          <div>
            <p className="font-extrabold uppercase text-slate-500 tracking-wider">Thủ kho đóng gói</p>
            <p className="text-[10px] text-slate-400 italic mb-12">(Ký & ghi rõ họ tên)</p>
            <p className="font-bold text-slate-300">............................................</p>
          </div>
          <div>
            <p className="font-extrabold uppercase text-slate-500 tracking-wider">Đại diện giao nhận</p>
            <p className="text-[10px] text-slate-400 italic mb-12">(Ký tên & xác nhận)</p>
            <p className="font-bold text-slate-300">............................................</p>
          </div>
          <div>
            <p className="font-extrabold uppercase text-slate-500 tracking-wider">Phụ trách Logistics</p>
            <p className="text-[10px] text-slate-400 italic mb-12">(Ký duyệt & duyệt xuất kho)</p>
            <p className="font-bold text-slate-300">............................................</p>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center space-x-3 mb-6">
        <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center text-white shadow-lg">
          <Beaker size={24} />
        </div>
        <div>
          <h2 className="text-xl font-black text-gray-800 uppercase tracking-tight">Test Code & Migration</h2>
          <p className="text-xs font-bold text-gray-400 uppercase">Công cụ bảo trì dữ liệu hệ thống</p>
        </div>
      </div>

      {/* KHỐI TRA CỨU TOÀN BỘ DATA CỦA MỘT MODULE */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-white rounded-lg shadow-sm border border-slate-100 overflow-hidden"
      >
        <div className="p-6 border-b border-gray-50 bg-indigo-50/20">
          <h3 className="font-black text-indigo-950 uppercase tracking-widest text-sm flex items-center space-x-2">
            <Database size={16} className="text-indigo-600" />
            <span>Tra cứu toàn bộ dữ liệu của Module</span>
          </h3>
          <p className="text-xs text-slate-400 font-bold uppercase mt-1">Tìm kiếm và hiển thị toàn bộ hồ sơ Firestore của một cấu kiện / Module</p>
        </div>
        <div className="p-6 space-y-6">
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="flex-1 relative">
              <span className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                <Search size={18} />
              </span>
              <input
                type="text"
                placeholder="Nhập chính xác mã Module (VD: MED026_BLDG1_KIT_01 hoặc 01) ..."
                value={searchModuleName}
                onChange={(e) => setSearchModuleName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSearchModule();
                }}
                className="w-full bg-slate-50 border border-slate-200 rounded-sm pl-11 pr-4 py-3.5 text-sm font-bold text-slate-800 outline-none placeholder-slate-400 focus:border-indigo-500 focus:bg-white transition-all shadow-inner"
              />
            </div>
            <button
              onClick={handleSearchModule}
              disabled={searchLoading}
              className="px-6 py-3.5 bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-200 disabled:text-slate-400 text-white text-xs font-black uppercase tracking-widest rounded-sm transition-all flex items-center justify-center gap-2 shadow-md shadow-indigo-600/10 cursor-pointer active:scale-95 shrink-0"
            >
              {searchLoading ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  <span>Đang tìm kiếm...</span>
                </>
              ) : (
                <>
                  <Search size={16} />
                  <span>Tìm kiếm</span>
                </>
              )}
            </button>
          </div>

          {searchError && (
            <div className="p-4 bg-rose-50 border border-rose-100 rounded-sm text-xs font-bold uppercase text-rose-800 flex items-center space-x-2.5">
              <AlertCircle size={16} className="text-rose-600 shrink-0" />
              <span>{searchError}</span>
            </div>
          )}

          {searchResult.length > 0 && (
            <div className="space-y-4 font-sans text-sm">
              <div className="flex items-center justify-between text-[11px] font-black text-slate-400 uppercase tracking-wider pb-2 border-b border-slate-100">
                <span>Kết quả tìm kiếm ({searchResult.length})</span>
                <span>Bấm vào đề mục để mở rộng / thu gọn chi tiết</span>
              </div>

              <div className="space-y-3">
                {searchResult.map((entry) => {
                  const isExpanded = expandedSearchId === entry.id;
                  const moduleType = getEntryTypeLocal(entry.moduleCode);
                  return (
                    <div
                      key={entry.id}
                      className="border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden bg-white dark:bg-slate-900 shadow-sm"
                    >
                      {/* Accordion Header */}
                      <div
                        onClick={() => setExpandedSearchId(isExpanded ? null : entry.id)}
                        className="p-4 bg-slate-50 hover:bg-indigo-50/30 cursor-pointer flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 transition-all border-b border-transparent"
                      >
                        <div className="space-y-1">
                          <div className="flex items-center space-x-2">
                            <span className="font-black text-slate-800 text-sm font-mono tracking-tight">{entry.moduleCode}</span>
                            <span className={`px-2 py-0.5 text-[9px] font-black uppercase rounded-sm ${
                              (moduleType === 'Thùng' || moduleType === 'Đợt di động') ? 'bg-blue-50 text-blue-700' : 'bg-amber-50 text-amber-700'
                            }`}>
                              {moduleType}
                            </span>
                          </div>
                          <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wide">
                            Dự án: {formatProjectName(entry.projectName)} ({entry.displayCode || entry.projectCode})
                          </div>
                        </div>

                        <div className="flex items-center gap-3 shrink-0">
                          <span className={`text-[10px] font-black uppercase px-2.5 py-1 rounded-sm border ${
                            entry.status?.includes('Đã nhận') ? 'bg-emerald-50 text-emerald-700 border-emerald-100' :
                            entry.status?.includes('Đang nhận') ? 'bg-amber-50 text-cyan-700 border-amber-100' :
                            'bg-slate-100 text-slate-600 border-slate-200'
                          }`}>
                            {entry.status || 'Chưa nhận'}
                          </span>
                          <span className="text-[10px] font-mono font-black text-slate-500 uppercase bg-slate-200/60 px-2 py-1 rounded-sm">
                            SL: {entry.receivedQuantity || 0} / {entry.quantity || 0} Trực quan
                          </span>
                        </div>
                      </div>

                      {/* Accordion Content */}
                      {isExpanded && (
                        <div className="p-6 space-y-6 border-t border-slate-100 bg-white">
                          {/* Bento Attributes Grid */}
                          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                            {/* Cột 1: Thông số cơ bản */}
                            <div className="p-4 bg-slate-100/50 rounded-lg space-y-3 border border-slate-100">
                              <h4 className="text-[10px] font-black text-indigo-900 uppercase tracking-widest flex items-center gap-1.5 border-b border-indigo-100 pb-1.5 matches">
                                <Info size={12} />
                                <span>Thông tin hành chính</span>
                              </h4>
                              <div className="space-y-2 text-[11px] font-bold uppercase text-slate-600">
                                <div className="flex justify-between"><span className="text-slate-400 font-medium">Document ID:</span> <span className="font-mono text-slate-800">{entry.id}</span></div>
                                <div className="flex justify-between"><span className="text-slate-400 font-medium">Mã Module:</span> <span className="text-slate-800 font-mono">{entry.moduleCode}</span></div>
                                <div className="flex justify-between"><span className="text-slate-400 font-medium">Mã Dự án:</span> <span className="text-slate-800">{entry.projectCode}</span></div>
                                <div className="flex justify-between"><span className="text-slate-400 font-medium">Tên Dự án:</span> <span className="text-slate-800 normal-case">{formatProjectName(entry.projectName)}</span></div>
                                <div className="flex justify-between"><span className="text-slate-400 font-medium">Cụm (Cluster):</span> <span className="text-slate-800 font-mono">{entry.cluster || '(Chưa gán)'}</span></div>
                                <div className="flex justify-between"><span className="text-slate-400 font-medium">Vật liệu:</span> <span className="text-slate-800">{entry.material || '(Trống)'}</span></div>
                                <div className="flex justify-between"><span className="text-slate-400 font-medium">Người tạo:</span> <span className="text-slate-800">{entry.ownerId || 'system'}</span></div>
                              </div>
                            </div>

                            {/* Cột 2: Kích thước & Số lượng */}
                            <div className="p-4 bg-slate-100/50 rounded-lg space-y-3 border border-slate-100">
                              <h4 className="text-[10px] font-black text-indigo-900 uppercase tracking-widest flex items-center gap-1.5 border-b border-indigo-100 pb-1.5">
                                <Layers size={12} />
                                <span>Kích thước & Sản lượng</span>
                              </h4>
                              <div className="space-y-2 text-[11px] font-bold uppercase text-slate-600">
                                {moduleType === 'Thùng' ? (
                                  <>
                                    <div className="flex justify-between"><span className="text-slate-400 font-medium">Kích thước TK:</span> <span className="text-slate-800 font-mono">{entry.width || 0} x {entry.depth || 0} x {entry.height || 0}</span></div>
                                    <div className="flex justify-between"><span className="text-slate-400 font-medium font-sans">Kích thước PB:</span> <span className="text-slate-800 font-mono">{entry.pWidth || 0} x {entry.pDepth || 0} x {entry.pHeight || 0}</span></div>
                                  </>
                                ) : (
                                  <div className="flex justify-between"><span className="text-slate-400 font-medium">Kích thước D-R-D:</span> <span className="text-slate-800 font-mono">{entry.width || 0} x {entry.depth || 0} x {entry.height || 0}</span></div>
                                )}
                                <div className="border-t border-slate-200/50 my-1.5"></div>
                                <div className="flex justify-between"><span className="text-slate-400 font-medium">SL Thiết kế:</span> <span className="text-indigo-700 text-xs font-black">{entry.quantity || 0} cái</span></div>
                                <div className="flex justify-between"><span className="text-slate-400 font-medium">SL Nhận hàng:</span> <span className="text-emerald-700 text-xs font-black">{entry.receivedQuantity || 0} cái</span></div>
                                <div className="flex justify-between"><span className="text-slate-400 font-medium">Trạng thái:</span> <span className="text-slate-800 text-[10px]">{entry.status || 'Chưa nhận'}</span></div>
                              </div>
                            </div>

                            {/* Cột 3: Quản lý Chất lượng QC */}
                            <div className="p-4 bg-slate-100/50 rounded-lg space-y-3 border border-slate-100">
                              <h4 className="text-[10px] font-black text-indigo-900 uppercase tracking-widest flex items-center gap-1.5 border-b border-indigo-100 pb-1.5 font-bold">
                                <CheckCircle size={12} />
                                <span>Quản lý Chất lượng QC</span>
                              </h4>
                              <div className="space-y-2 text-[11px] font-bold uppercase text-slate-600">
                                <div className="flex justify-between items-center"><span className="text-slate-400 font-medium">QC Pass Toàn bộ:</span> <span className={`px-1.5 py-0.5 rounded-sm text-[9px] font-black ${getModuleQcAggregate(entry, 'pack')?.status === 'pass' ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'}`}>{getModuleQcAggregate(entry, 'pack')?.status === 'pass' ? 'ĐÃ ĐẠT' : 'CHƯA ĐẠT'}</span></div>
                                <div className="border-t border-slate-200/50 my-1.5"></div>
                                <div className="space-y-1 bg-white p-2 border border-slate-100 rounded-sm">
                                  <p className="text-[9px] font-black text-slate-400">QC HẰNG TRẮNG:</p>
                                  {getModuleQcAggregate(entry, 'white') ? (
                                    <div className="text-[10px] leading-tight text-slate-700 font-medium">
                                      <p className="font-extrabold uppercase text-indigo-700">Trạng thái: {getModuleQcAggregate(entry, 'white')?.status}</p>
                                      <p className="text-slate-400 text-[9px] font-bold">Bởi: {getModuleQcAggregate(entry, 'white')?.by || 'N/A'}</p>
                                      <p className="text-slate-400 text-[9px] font-bold font-mono">Ngày: {getModuleQcAggregate(entry, 'white')?.date ? new Date(getModuleQcAggregate(entry, 'white')?.date).toLocaleDateString('vi-VN') : 'N/A'}</p>
                                    </div>
                                  ) : (
                                    <span className="text-slate-400 text-[10px] italic">Chưa QC Hàng trắng</span>
                                  )}
                                </div>
                                <div className="space-y-1 bg-white p-2 border border-slate-100 rounded-sm">
                                  <p className="text-[9px] font-black text-slate-400">QC Hằng Sơn:</p>
                                  {getModuleQcAggregate(entry, 'paint') ? (
                                    <div className="text-[10px] leading-tight text-slate-700 font-medium">
                                      <p className="font-extrabold uppercase text-amber-700">Trạng thái: {getModuleQcAggregate(entry, 'paint')?.status}</p>
                                      <p className="text-slate-400 text-[9px] font-bold">Bởi: {getModuleQcAggregate(entry, 'paint')?.by || 'N/A'}</p>
                                      <p className="text-slate-400 text-[9px] font-bold font-mono">Ngày: {getModuleQcAggregate(entry, 'paint')?.date ? new Date(getModuleQcAggregate(entry, 'paint')?.date).toLocaleDateString('vi-VN') : 'N/A'}</p>
                                    </div>
                                  ) : (
                                    <span className="text-slate-400 text-[10px] italic">Chưa QC Hàng sơn</span>
                                  )}
                                </div>
                              </div>
                            </div>
                          </div>

                          {/* Phụ kiện & Bản vẽ đính kèm */}
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {/* Phụ kiện đính kèm */}
                            <div className="p-4 bg-slate-50 border border-slate-100 rounded-lg space-y-2">
                              <h5 className="text-[10px] font-black text-slate-800 uppercase tracking-widest border-b border-slate-200 pb-1.5">
                                Danh sách Phụ kiện ({entry.accessories?.length || 0})
                              </h5>
                              {entry.accessories && entry.accessories.length > 0 ? (
                                <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
                                  {entry.accessories.map((acc: any, index: number) => (
                                    <div key={index} className="flex justify-between items-center text-[11px] font-bold uppercase text-slate-700 bg-white p-2 border border-slate-100 rounded-sm">
                                      <span>{acc.name}</span>
                                      <span className="font-mono text-indigo-700 font-extrabold bg-indigo-50 px-2 py-0.5 rounded-sm">{acc.quantity} cái</span>
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <p className="text-xs text-slate-450 italic">Không có phụ kiện nào đi kèm.</p>
                              )}
                            </div>

                            {/* Bản vẽ thiết kế */}
                            <div className="p-4 bg-slate-50 border border-slate-100 rounded-lg space-y-2 flex flex-col justify-between">
                              <div>
                                <h5 className="text-[10px] font-black text-slate-800 uppercase tracking-widest border-b border-slate-200 pb-1.5 mb-2.5">
                                  Liên kết thiết kế & File 3D
                                </h5>
                                <div className="space-y-2 text-[11px] font-bold">
                                  <div className="flex justify-between items-center bg-white p-2 border border-slate-100 rounded-sm">
                                    <span className="text-slate-400 uppercase">Bản vẽ 2D:</span>
                                    {entry.drawingUrl ? (
                                      <a href={entry.drawingUrl} target="_blank" rel="noopener noreferrer" className="text-indigo-600 hover:underline flex items-center gap-1">
                                        <span>Xem Bản Vẽ</span>
                                        <ExternalLink size={12} />
                                      </a>
                                    ) : <span className="text-slate-400 italic">Trống</span>}
                                  </div>
                                  <div className="flex justify-between items-center bg-white p-2 border border-slate-100 rounded-sm">
                                    <span className="text-slate-400 uppercase">Hình lắp ráp:</span>
                                    {entry.assemblyDrawingUrl ? (
                                      <a href={entry.assemblyDrawingUrl} target="_blank" rel="noopener noreferrer" className="text-indigo-600 hover:underline flex items-center gap-1">
                                        <span>Xem Bản Vẽ</span>
                                        <ExternalLink size={12} />
                                      </a>
                                    ) : <span className="text-slate-400 italic">Trống</span>}
                                  </div>
                                  <div className="flex justify-between items-center bg-white p-2 border border-slate-100 rounded-sm">
                                    <span className="text-slate-400 uppercase">Tệp 3D (GLB):</span>
                                    {entry.glbUrl ? (
                                      <span className="text-slate-800 break-all font-mono font-normal">{entry.glbUrl}</span>
                                    ) : <span className="text-slate-400 italic">Trống</span>}
                                  </div>
                                </div>
                              </div>
                            </div>
                          </div>

                          {/* Raw Firestore JSON Viewer */}
                          <div className="space-y-2">
                            <div className="flex items-center justify-between">
                              <h5 className="text-[10px] font-black text-indigo-950 uppercase tracking-widest">
                                Firestore JSON Data của Module
                              </h5>
                              <button
                                onClick={() => {
                                  navigator.clipboard.writeText(JSON.stringify(entry, null, 2));
                                  alert("Đã copy dữ liệu JSON vào Clipboard!");
                                }}
                                className="px-2.5 py-1 text-[9px] font-black uppercase text-indigo-700 bg-indigo-50 border border-indigo-100 rounded-sm hover:bg-slate-100 transition-all flex items-center gap-1 cursor-pointer"
                              >
                                <span>Copy JSON</span>
                              </button>
                            </div>
                            <pre className="text-[11px] font-mono bg-slate-900 border border-slate-950 text-slate-100 p-4 rounded-sm overflow-x-auto max-h-96 leading-relaxed shadow-inner">
                              {JSON.stringify(entry, null, 2)}
                            </pre>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </motion.div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-white rounded-lg shadow-sm border border-gray-100 overflow-hidden md:col-span-2"
        >
          <div className="p-6 border-b border-gray-50 bg-emerald-50/30">
            <h3 className="font-black text-emerald-950 uppercase tracking-widest text-sm flex items-center space-x-2">
              <Database size={16} className="text-emerald-700 font-bold" />
              <span>Sao lưu & Khôi phục dữ liệu Firebase (Backup & Restore)</span>
            </h3>
          </div>
          <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Cột Trái - EXPORT SAO LƯU */}
            <div className="space-y-4 border-r border-slate-100 pr-0 md:pr-6">
              <h4 className="text-xs font-black text-emerald-900 uppercase tracking-wider flex items-center gap-1.5 border-b border-slate-100 pb-2">
                <span className="w-2 h-2 bg-emerald-500 rounded-full"></span>
                Tải xuống bản sao lưu (Export Backup)
              </h4>
              <p className="text-xs text-gray-500 leading-relaxed font-medium">
                Hệ thống sẽ tổng hợp toàn bộ các bảng dữ liệu trên Cloud Firebase Firestore bao gồm: Dự án, Phiếu QC, Danh sách đóng gói, Nhật ký hoạt động, Hàng giao nhận, Người dùng, danh mục, v.v. và xuất ra một file JSON được chuẩn hóa.
              </p>
              
              {exportResult && (
                <div className={`p-4 rounded border text-xs font-bold leading-normal ${
                  exportResult.success ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-rose-50 border-rose-200 text-rose-800'
                }`}>
                  {exportResult.success ? (
                    <p>✓ Sao lưu thành công! Đã tự động tạo và tải xuống file JSON lúc {exportResult.timestamp?.toLocaleTimeString()}.</p>
                  ) : (
                    <p>Lỗi: {exportResult.error}</p>
                  )}
                </div>
              )}

              <button
                onClick={exportAllCollections}
                disabled={exportLoading}
                className="w-full py-4 rounded-sm font-black uppercase tracking-widest text-xs shadow-lg transition-all active:scale-95 flex items-center justify-center space-x-3 bg-emerald-600 hover:bg-emerald-700 text-white shadow-emerald-600/20 disabled:bg-gray-200 disabled:text-gray-400 cursor-pointer"
              >
                {exportLoading ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    <span>Đang trích xuất dữ liệu...</span>
                  </>
                ) : (
                  <>
                    <Database size={14} className="shrink-0" />
                    <span>Tải dữ liệu sao lưu (JSON)</span>
                  </>
                )}
              </button>
            </div>

            {/* Cột Phải - IMPORT KHÔI PHỤC */}
            <div className="space-y-4 select-none">
              <h4 className="text-xs font-black text-slate-800 uppercase tracking-wider flex items-center gap-1.5 border-b border-slate-100 pb-2">
                <span className="w-2 h-2 bg-amber-500 rounded-full"></span>
                Nạp dữ liệu từ file (Import Restore)
              </h4>
              <p className="text-xs text-gray-500 leading-relaxed font-medium">
                Tải lên một file `.json` đã được backup từ trước để khôi phục cơ sở dữ liệu. Vui lòng chọn chế độ khôi phục thích hợp.
              </p>

              <div className="space-y-3 bg-slate-50 p-4 border border-slate-100 rounded">
                <div className="space-y-1">
                  <label className="text-[10px] font-black text-slate-700 uppercase tracking-widest block">
                    1. Chọn File sao lưu (.json):
                  </label>
                  <input
                    type="file"
                    accept=".json"
                    ref={importFileInputRef}
                    onChange={handleJsonUpload}
                    className="w-full text-xs text-slate-500 file:mr-2 file:py-1 file:px-2 file:rounded-sm file:border-0 file:text-[10px] file:font-black file:uppercase file:bg-amber-100 file:text-amber-800 hover:file:bg-amber-200 cursor-pointer outline-none"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-[10px] font-black text-slate-700 uppercase tracking-widest block">
                    2. Chế độ khôi phục:
                  </label>
                  <select
                    value={importMode}
                    onChange={(e) => setImportMode(e.target.value as 'merge' | 'nuke')}
                    className="w-full bg-white border border-slate-200 rounded-sm px-2.5 py-1.5 text-[11px] font-bold text-slate-800 outline-none cursor-pointer"
                  >
                    <option value="merge">Đè theo ID & Giữ nguyên bản ghi khác</option>
                    <option value="nuke">Khôi phục hoàn toàn (Xóa bảng cũ trước khi thêm)</option>
                  </select>
                </div>
              </div>

              {importPreview && (
                <div className="p-3.5 bg-amber-50 border border-amber-200 rounded text-[11px] space-y-2">
                  <p className="font-bold text-amber-900 uppercase">✓ Đọc file sao lưu thành công!</p>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-slate-600 font-bold uppercase text-[9px] tracking-tight">
                    {Object.entries(importPreview).map(([col, list]) => (
                      <p key={col} className="truncate">
                        • {col}: <span className="font-black text-slate-800">{Array.isArray(list) ? list.length : 0}</span> dòng
                      </p>
                    ))}
                  </div>

                  <div className="pt-2 flex gap-3">
                    <button
                      onClick={() => {
                        setImportPreview(null);
                        if (importFileInputRef.current) importFileInputRef.current.value = '';
                      }}
                      className="flex-1 py-1.5 bg-slate-200 hover:bg-slate-300 text-slate-700 text-[10px] font-black uppercase rounded-sm transition-all"
                    >
                      Bỏ chọn
                    </button>
                    <button
                      onClick={executeImport}
                      disabled={importLoading}
                      className="flex-1 py-1.5 bg-amber-600 hover:bg-amber-700 text-white text-[10px] font-black uppercase rounded-sm transition-all flex items-center justify-center gap-1 shadow-lg shadow-amber-600/10 cursor-pointer"
                    >
                      {importLoading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                      <span>Bắt đầu Import</span>
                    </button>
                  </div>
                </div>
              )}

              {importResult && (
                <div className={`p-4 rounded border text-xs font-bold leading-normal ${
                  importResult.success ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-rose-50 border-rose-200 text-rose-800'
                }`}>
                  {importResult.success ? (
                    <>
                      <p>✓ Khôi phục thành công!</p>
                      <ul className="list-disc pl-4 mt-1 font-medium text-slate-600">
                        <li>Đã import: {importResult.importedCount} bản ghi.</li>
                        {importResult.deletedCount! > 0 && <li>Đã xoá: {importResult.deletedCount} bản ghi cũ dư thừa.</li>}
                      </ul>
                    </>
                  ) : (
                    <p>Lỗi khôi phục: {importResult.error}</p>
                  )}
                </div>
              )}
            </div>
          </div>
        </motion.div>


        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-white rounded-lg shadow-sm border border-gray-100 overflow-hidden md:col-span-2"
        >
          <div className="p-6 border-b border-gray-50 bg-indigo-50/20">
            <h3 className="font-black text-indigo-950 uppercase tracking-widest text-sm flex items-center space-x-2">
              <FileSpreadsheet size={16} className="text-indigo-600 font-bold" />
              <span>Nhập Dữ Liệu Kho Ban Đầu Từ Excel</span>
            </h3>
          </div>
          <div className="p-6 space-y-6">
            <p className="text-xs text-gray-500 leading-relaxed font-medium">
              Chức năng này cho phép tải lên bảng Excel vật tư kho ban đầu. Hệ thống sẽ phân tích các cột <code className="bg-slate-100 px-1 py-0.5 rounded text-indigo-600 font-mono">Tên vật tư</code>, <code className="bg-slate-100 px-1 py-0.5 rounded text-indigo-600 font-mono">DVT</code>, và <code className="bg-slate-100 px-1 py-0.5 rounded text-indigo-600 font-mono">Tồn Cuối Kỳ</code>. 
              Nếu vật tư chưa tồn tại trong danh mục trung tâm, hệ thống tự động sinh mã <code className="bg-slate-100 px-1 py-0.5 rounded text-indigo-600 font-mono">MAT-XXXXX</code> và khởi tạo. Nếu đã tồn tại, số lượng tồn kho sẽ được cập nhật. Hệ thống lưu lại lịch sử giao dịch ban đầu (<code className="bg-slate-100 px-1 py-0.5 rounded text-indigo-600 font-mono">IMPORT_INITIAL</code>).
            </p>

            <div className="bg-slate-50 p-6 border border-gray-100 rounded-lg space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-xs font-black text-slate-700 uppercase block">
                    Chọn File Excel Vật Tư (.xlsx, .xls):
                  </label>
                  <input
                    type="file"
                    accept=".xlsx, .xls"
                    ref={warehouseFileInputRef}
                    onChange={handleWarehouseExcelUpload}
                    className="w-full text-xs text-slate-500 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-xs file:font-bold file:bg-indigo-100 file:text-indigo-800 hover:file:bg-indigo-200 cursor-pointer outline-none"
                  />
                </div>
                
                <div className="flex items-end">
                  <button
                    onClick={executeWarehouseImport}
                    disabled={warehouseImportLoading || !warehouseImportFile}
                    className="w-full py-2.5 rounded-lg font-black uppercase tracking-wider text-xs shadow-md transition-all active:scale-95 flex items-center justify-center space-x-2 bg-indigo-600 hover:bg-indigo-700 text-white shadow-indigo-600/10 disabled:bg-gray-100 disabled:text-gray-400 cursor-pointer"
                  >
                    {warehouseImportLoading ? (
                      <>
                        <Loader2 size={16} className="animate-spin" />
                        <span>Đang xử lý dữ liệu...</span>
                      </>
                    ) : (
                      <>
                        <Upload size={14} className="shrink-0" />
                        <span>Tiến Hành Import Dữ Liệu</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>

            {warehouseImportResult && (
              <div className="space-y-3 p-4 rounded-lg border border-gray-100 bg-slate-50 text-xs text-left">
                <div className="flex items-center gap-2">
                  <CheckCircle size={16} className="text-emerald-600" />
                  <span className="font-bold text-slate-800 uppercase tracking-wide">
                    Kết Quả Import Cập Nhật Kho
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-4 bg-white p-3 border border-gray-100 rounded-lg text-center">
                  <div>
                    <p className="text-[10px] text-gray-400 font-extrabold uppercase">Tổng Số Dòng</p>
                    <p className="text-lg font-black text-indigo-900">{warehouseImportResult.total}</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-emerald-500 font-extrabold uppercase">Thành Công</p>
                    <p className="text-lg font-black text-emerald-600">{warehouseImportResult.successCount}</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-rose-500 font-extrabold uppercase">Dòng Lỗi</p>
                    <p className="text-lg font-black text-rose-600">{warehouseImportResult.errorCount}</p>
                  </div>
                </div>

                {warehouseImportResult.errors.length > 0 && (
                  <div className="space-y-1">
                    <p className="font-extrabold text-rose-600 uppercase text-[10px]">Chi tiết các lỗi dòng:</p>
                    <div className="max-h-36 overflow-y-auto bg-rose-50/50 p-2 border border-rose-100 rounded-lg space-y-1 font-mono text-[10px] leading-relaxed text-rose-800">
                      {warehouseImportResult.errors.map((err, idx) => (
                        <p key={idx}>• {err}</p>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </motion.div>


        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden"
        >
          <div className="p-6 border-b border-gray-50 bg-amber-50/30">
            <h3 className="font-black text-amber-900 uppercase tracking-widest text-sm flex items-center space-x-2">
              <CheckCircle size={16} className="text-amber-600" />
              <span>Pass nhanh Hàng Trắng (QC)</span>
            </h3>
          </div>
          <div className="p-6 space-y-4">
            <p className="text-sm text-gray-600 leading-relaxed font-medium">
              Tự động đánh dấu <strong className="text-emerald-600">PASS công đoạn Hàng Trắng (qcWhite)</strong> cho các cấu kiện chưa được QC:
              <br />
              • <strong className="text-amber-600">Nếu chọn Dự án cụ thể:</strong> Pass TOÀN BỘ cấu kiện (bao gồm cả Thùng, Cánh, Mặt HK, CTHT, Đợt...) thuộc dự án đó.
              <br />
              • <strong className="text-amber-600">Nếu chọn "Toàn bộ Dự án":</strong> Pass TOÀN BỘ cấu kiện (bao gồm cả Thùng, Cánh, Mặt HK, CTHT, Đợt...) thuộc TẤT CẢ các dự án hiện có.
            </p>
            
            <div className="space-y-1.5 bg-slate-50 border border-slate-100 p-4 rounded-xl">
              <label className="text-[10px] font-black text-amber-800 uppercase tracking-widest block">
                Chọn Dự án Mục tiêu:
              </label>
              <select
                value={fastPassProjectCode}
                onChange={(e) => setFastPassProjectCode(e.target.value)}
                className="w-full bg-white border border-slate-200 rounded-xl px-4 py-3 text-xs font-black text-slate-800 outline-none uppercase tracking-tight shadow-sm focus:border-amber-500 transition-all cursor-pointer"
              >
                <option value="all">-- Áp dụng cho Toàn bộ Dự án --</option>
                {existingProjects.map((p) => (
                  <option key={p.projectCode} value={p.projectCode}>
                    {p.displayCode || formatProjectCode(p.projectCode)} - {formatProjectName(p.projectName)}
                  </option>
                ))}
              </select>
            </div>

            <div className="bg-amber-50 border border-amber-200 p-4 rounded-xl">
              <div className="flex space-x-3">
                <AlertCircle size={20} className="text-amber-500 shrink-0" />
                <p className="text-[10px] font-black text-amber-700 uppercase italic leading-tight">
                  Tác vụ hàng loạt: Tự động pass công đoạn qcWhite cho cấu kiện. Giúp tăng tốc quy trình sản xuất và cập nhật dữ liệu.
                </p>
              </div>
            </div>

            {showConfirmFastPass ? (
              <div className="bg-amber-50 border border-amber-200 p-4 rounded-xl space-y-3">
                <p className="text-xs font-bold text-amber-900 uppercase">
                  {fastPassProjectCode === 'all' 
                    ? 'XÁC NHẬN: Tự động PASS HÀNG TRẮNG cho TOÀN BỘ cấu kiện thuộc TẤT CẢ các dự án?'
                    : `XÁC NHẬN: Tự động PASS HÀNG TRẮNG cho TOÀN BỘ cấu kiện thuộc dự án [${fastPassProjectCode}]?`}
                </p>
                <div className="flex gap-3">
                  <button
                    onClick={() => setShowConfirmFastPass(false)}
                    className="flex-1 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-black uppercase rounded-lg transition-all"
                  >
                    Hủy bỏ
                  </button>
                  <button
                    onClick={runFastPassWhiteForMedina}
                    disabled={fastPassLoading}
                    className="flex-1 py-2.5 bg-amber-500 hover:bg-amber-600 text-white text-xs font-black uppercase rounded-lg transition-all flex items-center justify-center gap-2 shadow-lg shadow-amber-500/20"
                  >
                    {fastPassLoading ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle size={14} />}
                    <span>Xác nhận Pass</span>
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setShowConfirmFastPass(true)}
                disabled={fastPassLoading}
                className="w-full py-4 rounded-xl font-black uppercase tracking-widest text-sm shadow-lg transition-all active:scale-95 flex items-center justify-center space-x-3 bg-amber-500 hover:bg-amber-600 text-white shadow-amber-500/20 disabled:bg-gray-200 disabled:text-gray-400 cursor-pointer"
              >
                <>
                  <CheckCircle size={16} />
                  <span>Bắt đầu Pass nhanh</span>
                </>
              </button>
            )}
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden"
        >
          <div className="p-6 border-b border-gray-50 bg-emerald-50/30">
            <h3 className="font-black text-emerald-900 uppercase tracking-widest text-sm flex items-center space-x-2">
              <CheckCircle size={16} className="text-emerald-600" />
              <span>Tự Động Bù Nhận + Pass Tất Cả Giai Đoạn QC</span>
            </h3>
          </div>
          <div className="p-6 space-y-4">
            <p className="text-sm text-gray-600 leading-relaxed font-medium">
              Tự động thực hiện <strong className="text-emerald-600">2 bước</strong> cho dự án được chọn:
              <br />
              • <strong className="text-emerald-600">Bước 1 - Bù nhận:</strong> Đặt <code className="bg-slate-100 px-1 py-0.5 rounded text-emerald-600 font-mono">receivedQuantity = quantity</code> cho toàn bộ cấu kiện (đã nhận đủ).
              <br />
              • <strong className="text-emerald-600">Bước 2 - Pass bù QC:</strong> Tự động PASS tất cả 4 giai đoạn QC (Hàng Trắng, Hàng Sơn, Hoàn Thiện, Đóng Gói) cho <strong className="text-emerald-600">mỗi instance</strong> chưa pass giai đoạn tương ứng.
            </p>

            <div className="space-y-1.5 bg-slate-50 border border-slate-100 p-4 rounded-xl">
              <label className="text-[10px] font-black text-emerald-800 uppercase tracking-widest block">
                Chọn Dự án Mục tiêu:
              </label>
              <select
                value={autoReceivePassProjectCode}
                onChange={(e) => setAutoReceivePassProjectCode(e.target.value)}
                className="w-full bg-white border border-slate-200 rounded-xl px-4 py-3 text-xs font-black text-slate-800 outline-none uppercase tracking-tight shadow-sm focus:border-emerald-500 transition-all cursor-pointer"
              >
                <option value="">-- Chọn Dự án cụ thể --</option>
                <option value="all">-- Áp dụng cho Toàn bộ Dự án --</option>
                {existingProjects.map((p) => (
                  <option key={p.projectCode} value={p.projectCode}>
                    {p.displayCode || formatProjectCode(p.projectCode)} - {formatProjectName(p.projectName)}
                  </option>
                ))}
              </select>
            </div>

            <div className="bg-emerald-50 border border-emerald-200 p-4 rounded-xl">
              <div className="flex space-x-3">
                <AlertCircle size={20} className="text-emerald-500 shrink-0" />
                <p className="text-[10px] font-black text-emerald-700 uppercase italic leading-tight">
                  Tác vụ hàng loạt: Tự động bù nhận + pass QC toàn bộ giai đoạn. Dùng khi cần đẩy nhanh dữ liệu cho dự án.
                </p>
              </div>
            </div>

            {showConfirmAutoReceivePass ? (
              <div className="bg-emerald-50 border border-emerald-200 p-4 rounded-xl space-y-3">
                <p className="text-xs font-bold text-emerald-900 uppercase">
                  {autoReceivePassProjectCode === 'all'
                    ? 'XÁC NHẬN: Tự động bù nhận + pass toàn bộ giai đoạn QC cho TOÀN BỘ dự án?'
                    : `XÁC NHẬN: Tự động bù nhận + pass toàn bộ giai đoạn QC cho dự án [${autoReceivePassProjectCode}]?`}
                </p>
                <div className="flex gap-3">
                  <button
                    onClick={() => setShowConfirmAutoReceivePass(false)}
                    className="flex-1 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-black uppercase rounded-lg transition-all"
                  >
                    Hủy bỏ
                  </button>
                  <button
                    onClick={runAutoReceiveAndPassAllStages}
                    disabled={autoReceivePassLoading}
                    className="flex-1 py-2.5 bg-emerald-500 hover:bg-emerald-600 text-white text-xs font-black uppercase rounded-lg transition-all flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/20"
                  >
                    {autoReceivePassLoading ? (
                      <><Loader2 size={14} className="animate-spin" /> Đang xử lý...</>
                    ) : (
                      <><CheckCircle size={14} /> Xác nhận</>
                    )}
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setShowConfirmAutoReceivePass(true)}
                disabled={!autoReceivePassProjectCode || autoReceivePassLoading}
                className="w-full py-3 bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-300 text-white text-xs font-black uppercase rounded-xl transition-all shadow-lg shadow-emerald-500/20"
              >
                Chạy Tự Động Bù Nhận + Pass QC
              </button>
            )}

            {autoReceivePassResult && (
              <div className={`p-4 rounded-xl border ${autoReceivePassResult.error ? 'bg-red-50 border-red-200' : 'bg-emerald-50 border-emerald-200'}`}>
                <h4 className={`font-black uppercase tracking-tight text-sm mb-2 ${autoReceivePassResult.error ? 'text-red-800' : 'text-emerald-800'}`}>
                  {autoReceivePassResult.error ? 'Lỗi' : 'Kết quả Tự động Bù Nhận + Pass QC'}
                </h4>
                {autoReceivePassResult.error ? (
                  <p className="text-xs text-red-600 font-medium">{autoReceivePassResult.error}</p>
                ) : (
                  <div className="text-xs font-medium space-y-1">
                    <p>Tổng module: <strong>{autoReceivePassResult.totalModules}</strong></p>
                    <p>Đã cập nhật: <strong>{autoReceivePassResult.updatedModules}</strong> module</p>
                    <p>Tổng instance: <strong>{autoReceivePassResult.totalInstances}</strong></p>
                    <p>Instance đã pass bù: <strong>{autoReceivePassResult.updatedInstances}</strong></p>
                  </div>
                )}
              </div>
            )}
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-white rounded-lg shadow-sm border border-gray-100 overflow-hidden"
        >
          <div className="p-6 border-b border-gray-50 bg-rose-50/30">
            <h3 className="font-black text-rose-900 uppercase tracking-widest text-sm flex items-center space-x-2">
              <Trash2 size={16} className="text-rose-600" />
              <span>Xóa PASS nhanh cho Cánh, Mặt HK & CTHT</span>
            </h3>
          </div>
          <div className="p-6 space-y-4">
            <p className="text-sm text-gray-600 leading-relaxed font-semibold">
              Xóa bỏ trạng thái PASS của các giai đoạn QC cho các cấu kiện phụ thuộc loại <strong className="text-indigo-600">Cánh</strong>, <strong className="text-indigo-600">Mặt HK</strong> và <strong className="text-indigo-600">CTHT</strong> (Không tác động đến Hộp/Thùng và Đợt di động).
            </p>
            
            <div className="space-y-1.5 bg-slate-50 border border-slate-100 p-4 rounded-lg">
              <label className="text-[10px] font-black text-rose-800 uppercase tracking-widest block">
                Chọn Dự án Mục tiêu:
              </label>
              <select
                value={resetQcProjectCode}
                onChange={(e) => setResetQcProjectCode(e.target.value)}
                className="w-full bg-white border border-slate-200 rounded-sm px-4 py-3 text-xs font-black text-slate-800 outline-none uppercase tracking-tight shadow-sm focus:border-rose-500 transition-all cursor-pointer"
              >
                <option value="">-- Chọn Dự án cụ thể --</option>
                <option value="all">-- Áp dụng cho Toàn bộ Dự án --</option>
                {existingProjects.map((p) => (
                  <option key={p.projectCode} value={p.projectCode}>
                    {p.displayCode || formatProjectCode(p.projectCode)} - {formatProjectName(p.projectName)}
                  </option>
                ))}
              </select>
            </div>

            <div className="bg-rose-50 border border-rose-100 p-4 rounded-lg">
              <div className="flex space-x-3">
                <AlertCircle size={20} className="text-rose-500 shrink-0" />
                <p className="text-[10px] font-black text-rose-700 uppercase italic leading-tight">
                  Chú ý: Hành động này không thể hoàn tác. Trạng thái của các cấu kiện phụ thuộc thỏa mãn điều kiện sẽ được gỡ bỏ hoàn toàn khỏi dự án đã chọn.
                </p>
              </div>
            </div>

            {showConfirmResetQc ? (
              <div className="bg-rose-50/50 border border-rose-200 p-4 rounded-lg space-y-3">
                <p className="text-xs font-bold text-rose-900 uppercase">
                  {resetQcProjectCode === 'all' 
                    ? 'XÁC NHẬN: Xóa PASS tất cả Cánh, Mặt HK & CTHT của TẤT CẢ dự án?'
                    : `XÁC NHẬN: Xóa PASS tất cả Cánh, Mặt HK & CTHT của dự án [${resetQcProjectCode}]?`}
                </p>
                <div className="flex gap-3">
                  <button
                    onClick={() => setShowConfirmResetQc(false)}
                    className="flex-1 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-black uppercase rounded-sm transition-all"
                  >
                    Hủy bỏ
                  </button>
                  <button
                    onClick={runResetFastPass}
                    disabled={resetQcLoading}
                    className="flex-1 py-2.5 bg-rose-600 hover:bg-rose-700 text-white text-xs font-black uppercase rounded-sm transition-all flex items-center justify-center gap-2 shadow-lg shadow-rose-500/20"
                  >
                    {resetQcLoading ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                    <span>Xác nhận Xóa</span>
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => {
                  if (!resetQcProjectCode) {
                    alert("Vui lòng chọn một dự án trước!");
                    return;
                  }
                  setShowConfirmResetQc(true);
                }}
                disabled={resetQcLoading || !resetQcProjectCode}
                className="w-full py-4 rounded-sm font-black uppercase tracking-widest text-sm shadow-lg transition-all active:scale-95 flex items-center justify-center space-x-3 bg-rose-600 hover:bg-rose-700 text-white shadow-rose-600/20 disabled:bg-gray-200 disabled:text-gray-400 cursor-pointer"
              >
                <>
                  <Trash2 size={16} />
                  <span>Xóa toàn bộ PASS nhanh</span>
                </>
              </button>
            )}
          </div>
        </motion.div>

        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-white rounded-lg shadow-sm border border-slate-100 overflow-hidden"
        >
          <div className="p-6 border-b border-gray-50 bg-rose-50/20">
            <h3 className="font-black text-rose-950 uppercase tracking-widest text-sm flex items-center space-x-2">
              <Trash2 size={16} className="text-rose-600" />
              <span>Xóa QC toàn bộ Module & Cấu kiện</span>
            </h3>
            <p className="text-xs text-slate-400 font-bold uppercase mt-1">Gỡ bỏ hoàn toàn dữ liệu QC của tất cả cấu kiện thuộc dự án được lựa chọn</p>
          </div>
          <div className="p-6 space-y-4">
            <p className="text-sm text-gray-650 leading-relaxed font-semibold">
              Xóa bỏ triệt để thông tin kiểm định QC (gồm kết quả, người đánh giá, mô tả lỗi, hình ảnh đính kèm và lịch sử lỗi chi tiết ở cả danh mục chính lẫn các thực thể con/instance). Cho phép tái kiểm định hoàn chỉnh từ đầu.
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1.5 bg-slate-50 border border-slate-100 p-4 rounded-lg">
                <label className="text-[10px] font-black text-rose-950 uppercase tracking-widest block font-bold">
                  Chọn Dự án Mục tiêu:
                </label>
                <select
                  value={deleteQcProjectCode}
                  onChange={(e) => setDeleteQcProjectCode(e.target.value)}
                  className="w-full bg-white border border-slate-200 rounded-lg px-4 py-3 text-xs font-black text-slate-800 outline-none uppercase tracking-tight shadow-sm focus:border-rose-500 transition-all cursor-pointer font-bold"
                >
                  <option value="">-- Chọn Dự án cụ thể --</option>
                  <option value="all">-- Áp dụng cho Toàn bộ Dự án --</option>
                  {existingProjects.map((p) => (
                    <option key={p.projectCode} value={p.projectCode}>
                      {p.displayCode || formatProjectCode(p.projectCode)} - {formatProjectName(p.projectName)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5 bg-slate-50 border border-slate-100 p-4 rounded-lg">
                <label className="text-[10px] font-black text-rose-950 uppercase tracking-widest block font-bold">
                  Chọn Giai đoạn cần xóa:
                </label>
                <select
                  value={deleteQcStage}
                  onChange={(e) => setDeleteQcStage(e.target.value)}
                  className="w-full bg-white border border-slate-200 rounded-lg px-4 py-3 text-xs font-black text-slate-800 outline-none uppercase tracking-tight shadow-sm focus:border-rose-500 transition-all cursor-pointer font-bold"
                >
                  <option value="all">Tất cả giai đoạn (Reset Toàn Bộ)</option>
                  <option value="white">QC Hàng Trắng (qcWhite)</option>
                  <option value="paint">QC Hàng Sơn (qcPaint)</option>
                  <option value="finish">QC Hoàn Thiện (qcFinish)</option>
                  <option value="pack">QC Đóng Gói (qcPack)</option>
                </select>
              </div>
            </div>

            <div className="bg-rose-50 border border-rose-100 p-4 rounded-lg">
              <div className="flex space-x-3">
                <AlertCircle size={20} className="text-rose-500 shrink-0" />
                <p className="text-[10px] font-black text-rose-700 uppercase italic leading-tight font-sans">
                  Chú ý: Thao tác bảo trì này rất nhạy cảm và không thể đảo ngược. Hệ thống sẽ dọn sạch toàn bộ trường QC được chọn, khôi phục trạng thái hiển thị về "Chờ kiểm" nếu thực hiện xóa tất cả giai đoạn.
                </p>
              </div>
            </div>

            {deleteQcResult && (
              <div className={`p-4 rounded-lg border text-xs font-bold uppercase space-y-1.5 ${
                deleteQcResult.error ? 'bg-rose-50 border-rose-200 text-rose-800' : 'bg-emerald-50 border-emerald-200 text-emerald-800'
              }`}>
                {deleteQcResult.error ? (
                  <p>Lỗi: {deleteQcResult.error}</p>
                ) : (
                  <>
                    <p className="text-emerald-800 font-extrabold font-bold">✓ Đã xóa dữ liệu QC thành công!</p>
                    <p>✓ Dự án tác động: {deleteQcProjectCode === 'all' ? 'TẤT CẢ DỰ ÁN' : deleteQcProjectCode}</p>
                    <p>✓ Giai đoạn xử lý: {deleteQcStage === 'all' ? 'Toàn bộ công đoạn' : deleteQcStage.toUpperCase()}</p>
                    <p>✓ Số lượng Module/Cấu kiện được cập nhật: {deleteQcResult.updated} / {deleteQcResult.total}</p>
                  </>
                )}
              </div>
            )}

            {showConfirmDeleteQc ? (
              <div className="bg-rose-50/50 border border-rose-200 p-4 rounded-lg space-y-3">
                <div className="text-xs font-bold text-rose-950 uppercase font-mono">
                  XÁC NHẬN: Bạn có chắc chắn muốn xóa dữ liệu QC [{deleteQcStage === 'all' ? 'TẤT CẢ CÔNG ĐOẠN' : deleteQcStage.toUpperCase()}] của dự án {deleteQcProjectCode === 'all' ? 'TẤT CẢ DỰ ÁN' : `[${deleteQcProjectCode}]`} không?
                </div>
                <div className="flex gap-3">
                  <button
                    onClick={() => setShowConfirmDeleteQc(false)}
                    className="flex-1 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-black uppercase rounded-lg transition-all"
                  >
                    Hủy bỏ
                  </button>
                  <button
                    onClick={runDeleteQcModule}
                    disabled={deleteQcLoading}
                    className="flex-1 py-2.5 bg-rose-600 hover:bg-rose-700 text-white text-xs font-black uppercase rounded-lg transition-all flex items-center justify-center gap-2 shadow-lg shadow-rose-500/20"
                  >
                    {deleteQcLoading ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                    <span>Xác nhận thực hiện</span>
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => {
                  if (!deleteQcProjectCode) {
                    alert("Vui lòng chọn dự án cần xóa QC!");
                    return;
                  }
                  setShowConfirmDeleteQc(true);
                }}
                disabled={deleteQcLoading || !deleteQcProjectCode}
                className="w-full py-4 rounded-lg font-black uppercase tracking-widest text-sm shadow-md hover:shadow-lg transition-all active:scale-[0.98] flex items-center justify-center space-x-3 bg-rose-600 hover:bg-rose-700 text-white shadow-rose-600/10 disabled:bg-gray-100 disabled:text-gray-400 cursor-pointer select-none"
              >
                <Trash2 size={16} />
                <span>Xóa QC toàn bộ Module</span>
              </button>
            )}
          </div>
        </motion.div>

        {/* SET PENDING INSTANCE QC */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-white rounded-lg shadow-sm border border-slate-100 overflow-hidden"
        >
          <div className="p-6 border-b border-gray-50 bg-amber-50/30">
            <h3 className="font-black text-amber-950 uppercase tracking-widest text-sm flex items-center space-x-2">
              <ClipboardCheck size={16} className="text-amber-600" />
              <span>Set Pending Instance QC</span>
            </h3>
            <p className="text-xs text-slate-400 font-bold uppercase mt-1">Đặt trạng thái "Chờ kiểm" cho từng instance theo giai đoạn — bỏ qua instance đã Pass</p>
          </div>
          <div className="p-6 space-y-4">
            <p className="text-sm text-gray-650 leading-relaxed font-semibold">
              Đặt trạng thái QC thành <strong className="text-amber-700">pending (Chờ kiểm)</strong> cho từng instance của toàn bộ cấu kiện trong dự án. Instance đã <strong className="text-emerald-700">Pass</strong> hoặc đang <strong className="text-blue-700">Pending</strong> sẽ được bỏ qua.
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1.5 bg-slate-50 border border-slate-100 p-4 rounded-lg">
                <label className="text-[10px] font-black text-amber-950 uppercase tracking-widest block font-bold">
                  Chọn Dự án:
                </label>
                <select
                  value={setPendingProjectCode}
                  onChange={(e) => setSetPendingProjectCode(e.target.value)}
                  className="w-full bg-white border border-slate-200 rounded-lg px-4 py-3 text-xs font-black text-slate-800 outline-none uppercase tracking-tight shadow-sm focus:border-amber-500 transition-all cursor-pointer font-bold"
                >
                  <option value="">-- Chọn Dự án --</option>
                  {existingProjects.map((p) => (
                    <option key={p.projectCode} value={p.projectCode}>
                      {p.displayCode || formatProjectCode(p.projectCode)} - {formatProjectName(p.projectName)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5 bg-slate-50 border border-slate-100 p-4 rounded-lg">
                <label className="text-[10px] font-black text-amber-950 uppercase tracking-widest block font-bold">
                  Chọn Giai đoạn QC:
                </label>
                <select
                  value={setPendingStage}
                  onChange={(e) => setSetPendingStage(e.target.value)}
                  className="w-full bg-white border border-slate-200 rounded-lg px-4 py-3 text-xs font-black text-slate-800 outline-none uppercase tracking-tight shadow-sm focus:border-amber-500 transition-all cursor-pointer font-bold"
                >
                  <option value="white">QC Hàng Trắng (qcWhite)</option>
                  <option value="paint">QC Hàng Sơn (qcPaint)</option>
                  <option value="finish">QC Hoàn Thiện (qcFinish)</option>
                  <option value="pack">QC Đóng Gói (qcPack)</option>
                </select>
              </div>
            </div>

            <div className="bg-amber-50 border border-amber-100 p-4 rounded-lg">
              <div className="flex space-x-3">
                <AlertCircle size={20} className="text-amber-500 shrink-0" />
                <p className="text-[10px] font-black text-amber-700 uppercase italic leading-tight font-sans">
                  Thao tác sẽ set trạng thái pending cho instance chưa pass/pending. Instance đã Pass sẽ được giữ nguyên. Hãy chắc chắn chọn đúng dự án và giai đoạn.
                </p>
              </div>
            </div>

            {setPendingResult && (
              <div className={`p-4 rounded-lg border text-xs font-bold uppercase space-y-1.5 ${
                setPendingResult.error ? 'bg-rose-50 border-rose-200 text-rose-800' : 'bg-emerald-50 border-emerald-200 text-emerald-800'
              }`}>
                {setPendingResult.error ? (
                  <p>Lỗi: {setPendingResult.error}</p>
                ) : (
                  <>
                    <p className="text-emerald-800 font-extrabold font-bold">✓ Set Pending thành công!</p>
                    <p>✓ Tổng instance kiểm tra: {setPendingResult.total}</p>
                    <p>✓ Đã set pending: <span className="text-amber-700">{setPendingResult.pending}</span> instance</p>
                    <p>✓ Bỏ qua (đã pass/pending): <span className="text-slate-600">{setPendingResult.skipped}</span> instance</p>
                  </>
                )}
              </div>
            )}

            {showConfirmSetPending ? (
              <div className="bg-amber-50/50 border border-amber-200 p-4 rounded-lg space-y-3">
                <div className="text-xs font-bold text-amber-950 uppercase font-mono">
                  XÁC NHẬN: Set trạng thái PENDING giai đoạn [{setPendingStage.toUpperCase()}] cho toàn bộ instance trong dự án [{setPendingProjectCode}]? Instance đã Pass sẽ được giữ nguyên.
                </div>
                <div className="flex gap-3">
                  <button
                    onClick={() => setShowConfirmSetPending(false)}
                    className="flex-1 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-black uppercase rounded-lg transition-all"
                  >
                    Hủy bỏ
                  </button>
                  <button
                    onClick={runSetPendingInstance}
                    disabled={setPendingLoading}
                    className="flex-1 py-2.5 bg-amber-600 hover:bg-amber-700 text-white text-xs font-black uppercase rounded-lg transition-all flex items-center justify-center gap-2 shadow-lg shadow-amber-500/20"
                  >
                    {setPendingLoading ? <Loader2 size={14} className="animate-spin" /> : <ClipboardCheck size={14} />}
                    <span>Xác nhận thực hiện</span>
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => {
                  if (!setPendingProjectCode) {
                    alert("Vui lòng chọn dự án!");
                    return;
                  }
                  setShowConfirmSetPending(true);
                }}
                disabled={setPendingLoading || !setPendingProjectCode}
                className="w-full py-4 rounded-lg font-black uppercase tracking-widest text-sm shadow-md hover:shadow-lg transition-all active:scale-[0.98] flex items-center justify-center space-x-3 bg-amber-600 hover:bg-amber-700 text-white shadow-amber-600/10 disabled:bg-gray-100 disabled:text-gray-400 cursor-pointer select-none"
              >
                <ClipboardCheck size={16} />
                <span>Set Pending Instance QC</span>
              </button>
            )}
          </div>
        </motion.div>



        {/* BẮT ĐẦU PHẦN TỰ ĐỘNG LỌC KIỆN ĐÃ ĐÓNG GÓI VÀ PASS BÙ */}
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-white rounded-lg shadow-sm border border-gray-100 overflow-hidden md:col-span-2"
        >
          <div className="p-6 border-b border-gray-50 bg-indigo-50/20">
            <h3 className="font-black text-indigo-950 uppercase tracking-widest text-sm flex items-center space-x-2">
              <Boxes size={16} className="text-indigo-600" />
              <span>Duyệt Pass Bù Kiện Đóng Gói & Module Con</span>
            </h3>
            <p className="text-xs text-slate-400 font-bold uppercase mt-1">Lọc các kiện hàng đã hoàn tất đóng gói, tự động Pass bù các công đoạn QC trước (Mộc, Sơn, Ráp) và tất cả công đoạn của các Module con sau ghép nối</p>
          </div>
          <div className="p-6 space-y-4">
            <div className="flex flex-col sm:flex-row gap-3 items-end">
              <div className="flex-1 space-y-1.5">
                <label className="text-[10px] font-black text-slate-800 uppercase tracking-widest block font-bold">
                  Lọc theo Dự án:
                </label>
                <select
                  value={packFilterProjCode}
                  onChange={(e) => setPackFilterProjCode(e.target.value)}
                  className="w-full bg-white border border-slate-200 rounded-lg px-4 py-3 text-xs font-bold text-slate-800 outline-none uppercase tracking-tight shadow-sm focus:border-indigo-500 transition-all cursor-pointer"
                >
                  <option value="all">-- TOÀN BỘ DỰ ÁN --</option>
                  {existingProjects.map((p) => (
                    <option key={p.projectCode} value={p.projectCode}>
                      [{p.displayCode || formatProjectCode(p.projectCode)}] {formatProjectName(p.projectName)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex gap-2 w-full sm:w-auto">
                <button
                  onClick={handleLoadPackedPackages}
                  disabled={packFilterLoading}
                  className="flex-1 sm:flex-initial px-6 py-3.5 bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-200 text-white rounded-lg text-xs font-black uppercase tracking-wider flex items-center justify-center gap-2 cursor-pointer transition-all active:scale-95 shadow-sm"
                >
                  {packFilterLoading ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
                  <span>Lọc Kiện Hoàn Tất</span>
                </button>
                {packedPackages.length > 0 && (
                  <button
                    onClick={handleExecuteAllPassBu}
                    disabled={packPassBuLoading}
                    className="flex-1 sm:flex-initial px-6 py-3.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-200 text-white rounded-lg text-xs font-black uppercase tracking-wider flex items-center justify-center gap-2 cursor-pointer transition-all active:scale-95 shadow-sm"
                  >
                    {packPassBuLoading ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle size={14} />}
                    <span>Pass Bù Tất Cả ({packedPackages.length})</span>
                  </button>
                )}
              </div>
            </div>

            {packPassBuResult && (
              <div className="p-4 bg-slate-50 border border-slate-100 rounded-lg text-xs font-bold uppercase text-slate-700">
                {packPassBuResult}
              </div>
            )}

            {packedPackages.length > 0 && (
              <div className="border border-slate-100 rounded-lg overflow-hidden">
                <div className="bg-slate-50 px-4 py-3 border-b border-slate-100 grid grid-cols-12 gap-3 text-[10px] font-black text-slate-500 uppercase tracking-widest leading-none font-bold">
                  <div className="col-span-3">Mã Kiện (Thùng)</div>
                  <div className="col-span-2">Dự Án</div>
                  <div className="col-span-5">Trạng Thái Công Đoạn QC</div>
                  <div className="col-span-2 text-right">Lệnh</div>
                </div>
                <div className="divide-y divide-slate-100 max-h-96 overflow-y-auto">
                  {packedPackages.map((pkg) => (
                    <div key={pkg.id} className="px-4 py-3.5 grid grid-cols-12 gap-3 items-center hover:bg-slate-50/50 transition-all text-xs font-bold uppercase text-slate-800">
                      <div className="col-span-3 flex flex-col">
                        <span className="font-extrabold text-slate-900 tracking-tight">{pkg.moduleCode}</span>
                        <span className="text-[10px] text-indigo-500 font-medium normal-case">Số lượng: {pkg.quantity}</span>
                      </div>
                      <div className="col-span-2 text-slate-500 font-mono text-[11px] tracking-tight">{pkg.projectCode}</div>
                      <div className="col-span-5 flex flex-wrap gap-1.5 items-center">
                        {/* White status */}
                        <span className={`px-2 py-1 rounded-md text-[9px] font-extrabold flex items-center gap-1 ${
                          pkg.qcWhite?.status === 'pass' ? 'bg-emerald-50 text-emerald-700 border border-emerald-100' : 'bg-slate-100 text-slate-400 border border-slate-200'
                        }`}>
                          Mộc: {pkg.qcWhite?.status === 'pass' ? 'PASS' : 'CHƯA'}
                        </span>
                        {/* Paint status */}
                        <span className={`px-2 py-1 rounded-md text-[9px] font-extrabold flex items-center gap-1 ${
                          pkg.qcPaint?.status === 'pass' ? 'bg-emerald-50 text-emerald-700 border border-emerald-100' : 'bg-slate-100 text-slate-400 border border-slate-200'
                        }`}>
                          Sơn: {pkg.qcPaint?.status === 'pass' ? 'PASS' : 'CHƯA'}
                        </span>
                        {/* Finish status */}
                        <span className={`px-2 py-1 rounded-md text-[9px] font-extrabold flex items-center gap-1 ${
                          pkg.qcFinish?.status === 'pass' ? 'bg-emerald-50 text-emerald-700 border border-emerald-100' : 'bg-slate-100 text-slate-400 border border-slate-200'
                        }`}>
                          Ráp: {pkg.qcFinish?.status === 'pass' ? 'PASS' : 'CHƯA'}
                        </span>
                        {/* Pack status */}
                        <span className={`px-2 py-1 rounded-md text-[9px] font-extrabold flex items-center gap-1 ${
                          pkg.qcPack?.status === 'pass' ? 'bg-indigo-50 text-indigo-700 border border-indigo-100 animate-pulse' : 'bg-slate-100 text-slate-400 border border-slate-200'
                        }`}>
                          Đóng gói: {pkg.qcPack?.status === 'pass' ? 'PASS' : 'CHƯA'}
                        </span>
                      </div>
                      <div className="col-span-2 text-right">
                        <button
                          onClick={() => handleExecuteSinglePassBu(pkg)}
                          disabled={packPassBuLoading}
                          className="px-3 py-1.5 bg-indigo-50 hover:bg-indigo-100 disabled:opacity-50 text-indigo-600 rounded-lg text-[10px] font-black uppercase tracking-wider transition-all cursor-pointer"
                        >
                          Chạy bù
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </motion.div>
        {/* KẾT THÚC PHẦN TỰ ĐỘNG LỌC KIỆN ĐÃ ĐÓNG GÓI VÀ PASS BÙ */}

        {/* TẠO PHIẾU KIỂM HÀNG SƠN */}
        {fastPassResult && (
          <motion.div 
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            className={`bg-white rounded-2xl shadow-sm border p-6 flex flex-col justify-center space-y-6 ${fastPassResult.error ? 'border-red-100' : 'border-amber-100'}`}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-3">
                {fastPassResult.error ? (
                  <div className="w-10 h-10 bg-red-100 text-red-600 rounded-full flex items-center justify-center">
                    <AlertCircle size={24} />
                  </div>
                ) : (
                  <div className="w-10 h-10 bg-amber-100 text-amber-600 rounded-full flex items-center justify-center">
                    <CheckCircle size={24} />
                  </div>
                )}
                <div>
                  <h4 className="font-black text-gray-800 uppercase tracking-tight">Kết quả Pass nhanh Hàng Trắng</h4>
                  <p className="text-[10px] text-gray-400 font-bold uppercase">{new Date().toLocaleString()}</p>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div className="text-center p-3 bg-gray-50 rounded-xl">
                <p className="text-[10px] font-black text-gray-400 uppercase mb-1 font-sans">Tổng cơ sở dữ liệu</p>
                <p className="text-xl font-black text-gray-800">{fastPassResult.total}</p>
              </div>
              <div className="text-center p-3 bg-amber-50 rounded-xl">
                <p className="text-[10px] font-black text-amber-600 uppercase mb-1 font-sans">Đã Pass thành công</p>
                <p className="text-xl font-black text-amber-600">{fastPassResult.updated}</p>
              </div>
              <div className="text-center p-3 bg-blue-50 rounded-xl">
                <p className="text-[10px] font-black text-blue-450 uppercase mb-1 font-sans">Bỏ qua / Không đổi</p>
                <p className="text-xl font-black text-blue-600">{fastPassResult.skipped}</p>
              </div>
            </div>

            {fastPassResult.error && (
              <div className="p-3 bg-red-50 text-red-600 rounded-xl text-[10px] font-bold font-mono">
                Lỗi: {fastPassResult.error}
              </div>
            )}
          </motion.div>
        )}

        {resetQcResult && (
          <motion.div 
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            className={`bg-white rounded-lg shadow-sm border p-6 flex flex-col justify-center space-y-6 ${resetQcResult.error ? 'border-red-100' : 'border-rose-100'}`}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-3">
                {resetQcResult.error ? (
                  <div className="w-10 h-10 bg-red-100 text-red-600 rounded-full flex items-center justify-center">
                    <AlertCircle size={24} />
                  </div>
                ) : (
                  <div className="w-10 h-10 bg-rose-100 text-rose-600 rounded-full flex items-center justify-center">
                    <Trash2 size={24} className="text-rose-600" />
                  </div>
                )}
                <div>
                  <h4 className="font-black text-gray-800 uppercase tracking-tight">Kết quả xóa PASS nhanh</h4>
                  <p className="text-[10px] text-gray-400 font-bold uppercase">{new Date().toLocaleString()}</p>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div className="text-center p-3 bg-gray-50 rounded-xl">
                <p className="text-[10px] font-black text-gray-400 uppercase mb-1 font-sans">Tổng số quét</p>
                <p className="text-xl font-black text-gray-800">{resetQcResult.total}</p>
              </div>
              <div className="text-center p-3 bg-rose-50 rounded-xl">
                <p className="text-[10px] font-black text-rose-600 uppercase mb-1 font-sans">Đã Reset PASS</p>
                <p className="text-xl font-black text-rose-600">{resetQcResult.updated}</p>
              </div>
              <div className="text-center p-3 bg-blue-50 rounded-xl">
                <p className="text-[10px] font-black text-blue-450 uppercase mb-1 font-sans">Bỏ qua / Giữ nguyên</p>
                <p className="text-xl font-black text-blue-600">{resetQcResult.skipped}</p>
              </div>
            </div>

            {resetQcResult.error && (
              <div className="p-3 bg-red-50 text-red-600 rounded-xl text-[10px] font-bold font-mono">
                Lỗi: {resetQcResult.error}
              </div>
            )}
          </motion.div>
        )}

        {paintResult && (
          <motion.div 
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            className={`bg-white rounded-2xl shadow-sm border p-6 flex flex-col justify-center space-y-6 ${paintResult.error ? 'border-red-100' : 'border-emerald-100'}`}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-3">
                {paintResult.error ? (
                  <div className="w-10 h-10 bg-red-100 text-red-600 rounded-full flex items-center justify-center">
                    <AlertCircle size={24} />
                  </div>
                ) : (
                  <div className="w-10 h-10 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center">
                    <CheckCircle size={24} />
                  </div>
                )}
                <div>
                  <h4 className="font-black text-gray-800 uppercase tracking-tight">Kết quả nhập excel hàng sơn</h4>
                  <p className="text-[10px] text-gray-400 font-bold uppercase">{new Date().toLocaleString()}</p>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div className="text-center p-3 bg-gray-50 rounded-xl">
                <p className="text-[10px] font-black text-gray-400 uppercase mb-1">Tổng cộng</p>
                <p className="text-xl font-black text-gray-800">{paintResult.total}</p>
              </div>
              <div className="text-center p-3 bg-emerald-50 rounded-xl">
                <p className="text-[10px] font-black text-emerald-400 uppercase mb-1">Thêm mới (set)</p>
                <p className="text-xl font-black text-emerald-600">{paintResult.inserted}</p>
              </div>
              <div className="text-center p-3 bg-blue-50 rounded-xl">
                <p className="text-[10px] font-black text-blue-400 uppercase mb-1">Cập nhật (update)</p>
                <p className="text-xl font-black text-blue-600">{paintResult.updated}</p>
              </div>
            </div>

            {paintResult.error && (
              <div className="p-3 bg-red-50 text-red-600 rounded-xl text-[10px] font-bold font-mono">
                Lỗi: {paintResult.error}
              </div>
            )}
          </motion.div>
        )}

        {result && (
          <motion.div 
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            className={`bg-white rounded-2xl shadow-sm border p-6 flex flex-col justify-center space-y-6 ${result.error ? 'border-red-100' : 'border-emerald-100'}`}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-3">
                {result.error ? (
                  <div className="w-10 h-10 bg-red-100 text-red-600 rounded-full flex items-center justify-center">
                    <AlertCircle size={24} />
                  </div>
                ) : (
                  <div className="w-10 h-10 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center">
                    <CheckCircle size={24} />
                  </div>
                )}
                <div>
                  <h4 className="font-black text-gray-800 uppercase tracking-tight">Kết quả xử lý</h4>
                  <p className="text-[10px] text-gray-400 font-bold uppercase">{new Date().toLocaleString()}</p>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div className="text-center p-3 bg-gray-50 rounded-xl">
                <p className="text-[10px] font-black text-gray-400 uppercase mb-1">Tổng cộng</p>
                <p className="text-xl font-black text-gray-800">{result.total}</p>
              </div>
              <div className="text-center p-3 bg-emerald-50 rounded-xl">
                <p className="text-[10px] font-black text-emerald-400 uppercase mb-1">Cập nhật</p>
                <p className="text-xl font-black text-emerald-600">{result.updated}</p>
              </div>
              <div className="text-center p-3 bg-blue-50 rounded-xl">
                <p className="text-[10px] font-black text-blue-400 uppercase mb-1">Bỏ qua</p>
                <p className="text-xl font-black text-blue-600">{result.skipped}</p>
              </div>
            </div>

            {result.error && (
              <div className="p-3 bg-red-50 text-red-600 rounded-xl text-[10px] font-bold font-mono">
                Lỗi: {result.error}
              </div>
            )}
          </motion.div>
        )}

        {/* KHỐI IN BÁO CÁO ADMIN CHUYÊN NGHIỆP */}
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden col-span-1 md:col-span-2 w-full mt-6"
        >
          <div className="p-6 border-b border-gray-50 bg-indigo-50/20">
            <h3 className="font-black text-indigo-950 uppercase tracking-widest text-sm flex items-center space-x-2">
              <Printer size={16} className="text-indigo-600" />
              <span>Trung tâm Xuất Báo cáo & In ấn (Chỉ Admin)</span>
            </h3>
            <p className="text-xs text-slate-400 font-bold uppercase mt-1">Xuất bản tài liệu, in báo cáo chất lượng thiết kế, phiếu QC và Packing List bảo mật</p>
          </div>
          
          <div className="p-6 space-y-6">
            {/* Lựa chọn Dự án và Các cài đặt báo cáo */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 bg-slate-50 p-4 border border-slate-100 rounded-xl">
              <div className="space-y-1.5 flex flex-col justify-between">
                <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block font-bold leading-none">
                  1. Chọn Dự án lập báo cáo:
                </label>
                <select
                  value={reportProjectCode}
                  onChange={(e) => setReportProjectCode(e.target.value)}
                  className="w-full bg-white border border-slate-200 text-slate-800 text-xs font-bold rounded-sm px-3 py-2.5 outline-none focus:border-indigo-500 transition-all shadow-sm"
                >
                  <option value="">-- Chọn Dự án mục tiêu --</option>
                  {existingProjects.map((p) => (
                    <option key={p.projectCode} value={p.projectCode}>
                      {p.displayCode || formatProjectCode(p.projectCode)}: {formatProjectName(p.projectName)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5 flex flex-col justify-between">
                <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block font-bold leading-none">
                  2. Chọn Loại báo cáo xuất bản:
                </label>
                <div className="flex bg-white border border-slate-200 rounded-sm p-1 gap-1">
                  <button
                    onClick={() => {
                      setReportType('qc_tickets');
                      setSelectedPrintTicket(null);
                    }}
                    className={`flex-1 text-[10px] font-black uppercase py-1.5 rounded-sm transition-all focus:outline-none cursor-pointer ${
                      reportType === 'qc_tickets' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-500 hover:text-slate-800 hover:bg-slate-50'
                    }`}
                  >
                    Phiếu QC
                  </button>
                  <button
                    onClick={() => {
                      setReportType('project_details');
                    }}
                    className={`flex-1 text-[10px] font-black uppercase py-1.5 rounded-sm transition-all focus:outline-none cursor-pointer ${
                      reportType === 'project_details' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-500 hover:text-slate-800 hover:bg-slate-50'
                    }`}
                  >
                    Cấu kiện
                  </button>
                  <button
                    onClick={() => {
                      setReportType('packing_details');
                      setSelectedPrintPacking(null);
                    }}
                    className={`flex-1 text-[10px] font-black uppercase py-1.5 rounded-sm transition-all focus:outline-none cursor-pointer ${
                      reportType === 'packing_details' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-500 hover:text-slate-800 hover:bg-slate-50'
                    }`}
                  >
                    Packing
                  </button>
                </div>
              </div>

              <div className="space-y-1.5 flex flex-col justify-between">
                <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block font-bold leading-none">
                  3. Tài liệu in chi tiết:
                </label>
                {reportType === 'qc_tickets' ? (
                  <select
                    value={selectedPrintTicket ? selectedPrintTicket.id : ''}
                    onChange={(e) => {
                      const t = projectTickets.find(x => x.id === e.target.value);
                      setSelectedPrintTicket(t || null);
                    }}
                    disabled={projectTickets.length === 0}
                    className="w-full bg-white border border-slate-200 text-slate-800 text-xs font-bold rounded-sm px-3 py-2.5 outline-none focus:border-indigo-500 transition-all shadow-sm disabled:bg-gray-100 disabled:text-gray-400"
                  >
                    {projectTickets.length > 0 ? (
                      projectTickets.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name || `Phiếu QC ${t.id.substring(0,6).toUpperCase()}`} ({t.modules?.length || 0} Modules)
                        </option>
                      ))
                    ) : (
                      <option value="">Không có phiếu QC nào</option>
                    )}
                  </select>
                ) : reportType === 'project_details' ? (
                  <div className="bg-white border border-slate-200 rounded-sm px-3 py-2.5 text-xs font-bold text-indigo-700 flex items-center gap-1.5 shadow-sm">
                    <CheckCircle size={14} className="text-emerald-500 shrink-0" />
                    <span>Hồ sơ: {projectModules.length} cấu kiện</span>
                  </div>
                ) : (
                  <select
                    value={selectedPrintPacking ? selectedPrintPacking.id : ''}
                    onChange={(e) => {
                      const p = projectPackingLists.find(x => x.id === e.target.value);
                      setSelectedPrintPacking(p || null);
                    }}
                    disabled={projectPackingLists.length === 0}
                    className="w-full bg-white border border-slate-200 text-slate-800 text-xs font-bold rounded-sm px-3 py-2.5 outline-none focus:border-indigo-500 transition-all shadow-sm disabled:bg-gray-100 disabled:text-gray-400"
                  >
                    {projectPackingLists.length > 0 ? (
                      projectPackingLists.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.title} ({p.items?.length || 0} mục)
                        </option>
                      ))
                    ) : (
                      <option value="">Không có Packing List nào</option>
                    )}
                  </select>
                )}
              </div>
            </div>

            {/* Bảng Preview Tài Liệu & Hành động In */}
            {reportLoading ? (
              <div className="flex flex-col items-center justify-center py-20 bg-slate-50 rounded-xl border border-dotted border-slate-200 space-y-3">
                <Loader2 size={32} className="text-indigo-600 animate-spin" />
                <span className="text-xs font-black uppercase text-slate-450">Đang kéo dữ liệu kiểm tra từ Cloud...</span>
              </div>
            ) : reportProjectCode ? (
              <div className="space-y-4">
                {/* Thanh điều khiển in */}
                <div className="flex justify-between items-center bg-indigo-50/50 border border-indigo-100 p-3.5 rounded-xl">
                  <div>
                    <h4 className="text-[11px] font-black text-indigo-900 uppercase">Chế độ xem trước văn bản in (Review Document)</h4>
                    <p className="text-[10px] text-indigo-500 font-medium">Bấm lệnh in phía dưới để kết nối máy in nội bộ hoặc lưu file PDF để nộp báo cáo.</p>
                  </div>
                  <button
                    onClick={() => {
                      window.print();
                    }}
                    className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white text-[10px] font-black uppercase tracking-widest rounded-sm transition-all focus:outline-none flex items-center gap-1.5 shadow-md shadow-indigo-500/10 active:scale-95 cursor-pointer"
                  >
                    <Printer size={14} />
                    <span>In báo cáo</span>
                  </button>
                </div>

                {/* Printable Document Simulated Canvas */}
                <div className="bg-slate-100 p-4 sm:p-10 rounded-2xl border border-slate-200/80 overflow-x-auto">
                  <div 
                    id="admin-print-report-area"
                    className="bg-white text-slate-900 mx-auto max-w-4xl p-8 sm:p-12 shadow-xl border border-slate-200 font-sans tracking-normal leading-relaxed rounded-sm"
                  >
                    {/* Dynamic print-only styling overrides */}
                    <style>{`
                      @media print {
                        /* Định dạng trang và lề in */
                        @page {
                          size: A4 portrait;
                          margin: 15mm;
                        }

                        /* Giải phóng toàn bộ các thẻ cha để cho phép hiển thị chiều cao tự nhiên và ngắt trang */
                        html, body, #root, #root > div, .min-h-screen, main, .app-container, div {
                          overflow: visible !important;
                          height: auto !important;
                          min-height: 0 !important;
                          max-height: none !important;
                          position: static !important;
                          transform: none !important;
                          filter: none !important;
                          box-shadow: none !important;
                        }

                        /* Ẩn mọi phần tử phụ trợ khác của trang web */
                        body * {
                          visibility: hidden;
                        }

                        /* Chỉ hiển thị vùng báo cáo cần in */
                        #admin-print-report-area, #admin-print-report-area * {
                          visibility: visible !important;
                        }

                        /* Cho vùng in phủ tuyệt đối lên toàn bộ tài liệu in */
                        #admin-print-report-area {
                          position: absolute !important;
                          left: 0 !important;
                          top: 0 !important;
                          width: 100% !important;
                          height: auto !important;
                          background: white !important;
                          color: black !important;
                          padding: 5mm 0 !important;
                          margin: 0 !important;
                          box-shadow: none !important;
                          border: none !important;
                          overflow: visible !important;
                          display: block !important;
                        }

                        /* Chống ngắt trang nửa chừng trong dòng bảng và các thành phần chữ ký */
                        tr {
                          page-break-inside: avoid !important;
                          break-inside: avoid !important;
                        }
                        
                        thead {
                          display: table-header-group !important;
                        }

                        .print-keep-together {
                          page-break-inside: avoid !important;
                          break-inside: avoid !important;
                        }
                      }
                    `}</style>

                    {reportType === 'qc_tickets' && renderPrintTicket()}
                    {reportType === 'project_details' && renderPrintProject()}
                    {reportType === 'packing_details' && renderPrintPacking()}
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-16 bg-slate-50 border border-dotted border-slate-200 rounded-2xl text-center space-y-2">
                <div className="w-12 h-12 rounded-lg bg-slate-101 flex items-center justify-center text-slate-400">
                  <Printer size={24} />
                </div>
                <h4 className="text-xs font-black uppercase text-slate-700">Chưa có dự án nào được chọn</h4>
                <p className="text-[11px] text-gray-400 max-w-xs font-medium">Vui lòng chọn hoặc tìm kiếm mã dự án tại mục số 1 phía trên để tổng hợp dữ liệu in ấn báo cáo.</p>
              </div>
            )}
          </div>
        </motion.div>
      </div>

      {/* KHỐI CLOUDINARY CLEANUP */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-white rounded-lg shadow-sm border border-slate-100 overflow-hidden mt-6"
      >
        <div className="p-6 border-b border-gray-50 bg-rose-50/30">
          <h3 className="font-black text-rose-900 uppercase tracking-widest text-sm flex items-center space-x-2">
            <ImageIcon size={16} className="text-rose-600" />
            <span>Dọn dẹp ảnh thừa trên Cloudinary</span>
          </h3>
          <p className="text-xs text-slate-400 font-bold uppercase mt-1">Quét toàn bộ Firestore, tìm ảnh Cloudinary không còn link nào trong dự án → xóa tự động</p>
        </div>
        <div className="p-6 space-y-4">
          <div className="flex gap-2">
            <button
              onClick={handleCloudinaryCleanup}
              disabled={cloudinaryLoading}
              className="flex-1 px-5 py-3 bg-rose-600 hover:bg-rose-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg text-xs font-black uppercase tracking-wider transition-all flex items-center justify-center gap-2 cursor-pointer active:scale-95"
            >
              {cloudinaryLoading ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
              <span>{cloudinaryLoading ? 'Đang quét...' : 'Quét ảnh thừa'}</span>
            </button>
            {cloudinaryResult && cloudinaryResult.orphanCount > 0 && (
              <button
                onClick={handleDeleteOrphanImages}
                disabled={cloudinaryDeleting}
                className="px-5 py-3 bg-red-600 hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg text-xs font-black uppercase tracking-wider transition-all flex items-center justify-center gap-2 cursor-pointer active:scale-95"
              >
                {cloudinaryDeleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                <span>{cloudinaryDeleting ? 'Đang xóa...' : `Xóa ${cloudinaryResult.orphanCount} ảnh`}</span>
              </button>
            )}
          </div>

          {cloudinaryResult && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="text-center p-3 bg-slate-50 rounded-lg border border-slate-100">
                  <p className="text-[10px] font-black text-slate-400 uppercase mb-1">Cloudinary</p>
                  <p className="text-lg font-black text-slate-800">{cloudinaryResult.totalCloudinary}</p>
                </div>
                <div className="text-center p-3 bg-emerald-50 rounded-lg border border-emerald-100">
                  <p className="text-[10px] font-black text-emerald-500 uppercase mb-1">Đang dùng</p>
                  <p className="text-lg font-black text-emerald-700">{cloudinaryResult.usedUrls}</p>
                </div>
                <div className="text-center p-3 bg-rose-50 rounded-lg border border-rose-100">
                  <p className="text-[10px] font-black text-rose-500 uppercase mb-1">Ảnh thừa</p>
                  <p className="text-lg font-black text-rose-700">{cloudinaryResult.orphanCount}</p>
                </div>
                <div className="text-center p-3 bg-blue-50 rounded-lg border border-blue-100">
                  <p className="text-[10px] font-black text-blue-500 uppercase mb-1">Collections</p>
                  <p className="text-lg font-black text-blue-700">{cloudinaryResult.scannedCollections.length}</p>
                </div>
              </div>
              <div className="text-[10px] text-slate-500 font-medium">
                Đã quét: {cloudinaryResult.scannedCollections.join(', ')}
              </div>
              {cloudinaryResult.orphanCount > 0 && (
                <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800 font-medium max-h-32 overflow-y-auto">
                  <p className="font-black uppercase mb-1 text-[10px]">Danh sách ảnh thừa (tối đa 100 đầu tiên):</p>
                  {cloudinaryResult.orphanIds.slice(0, 100).map((id, i) => (
                    <div key={i} className="font-mono text-[10px] truncate py-0.5 border-b border-amber-100">{id}</div>
                  ))}
                  {cloudinaryResult.orphanIds.length > 100 && <p className="text-amber-600 font-black mt-1">... và {cloudinaryResult.orphanIds.length - 100} ảnh nữa</p>}
                </div>
              )}
              {cloudinaryResult.orphanCount === 0 && (
                <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-xs text-emerald-700 font-bold">
                  Tất cả ảnh trên Cloudinary đều đang được sử dụng. Không có ảnh thừa!
                </div>
              )}
            </div>
          )}

          {cloudinaryDeleteResult && (
            <div className={`p-4 rounded-lg border text-xs font-bold uppercase space-y-1.5 ${
              cloudinaryDeleteResult.failed > 0 ? 'bg-amber-50 border-amber-200 text-amber-800' : 'bg-emerald-50 border-emerald-200 text-emerald-800'
            }`}>
              <p>Đã xóa thành công: {cloudinaryDeleteResult.deleted} ảnh</p>
              {cloudinaryDeleteResult.failed > 0 && <p>Lỗi: {cloudinaryDeleteResult.failed} ảnh</p>}
              {cloudinaryDeleteResult.errors.length > 0 && (
                <div className="text-[10px] font-normal normal-case max-h-24 overflow-y-auto">
                  {cloudinaryDeleteResult.errors.slice(0, 20).map((e, i) => <div key={i}>• {e}</div>)}
                </div>
              )}
            </div>
          )}
        </div>
      </motion.div>

      {/* MIGRATE COLLECTION: packing_lists → loading */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-white rounded-lg border border-slate-200 shadow-sm overflow-hidden"
      >
        <div className="p-6 border-b border-slate-100 bg-gradient-to-r from-blue-50 to-white">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center">
              <Database size={20} className="text-blue-600" />
            </div>
            <div>
              <h3 className="text-sm font-black text-slate-800 uppercase tracking-tight">
                Migrate Collection
              </h3>
              <p className="text-xs text-slate-400 font-bold uppercase mt-1">Copy packing_lists → loading</p>
            </div>
          </div>
        </div>
        <div className="p-6 space-y-4">
          <MigrateCollectionButton />
        </div>
      </motion.div>

      {/* CHUYỂN ĐỔI PACKING: Phiếu cũ → Instance mới */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-white rounded-lg border border-slate-200 shadow-sm overflow-hidden"
      >
        <div className="p-6 border-b border-slate-100 bg-gradient-to-r from-violet-50 to-white">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-violet-100 rounded-lg flex items-center justify-center">
              <Layers size={20} className="text-violet-600" />
            </div>
            <div>
              <h3 className="text-sm font-black text-slate-800 uppercase tracking-tight">
                Chuyển Packing → Instance
              </h3>
              <p className="text-xs text-slate-400 font-bold uppercase mt-1">Phiếu cũ đếm số lượng → Tách riêng từng instance</p>
            </div>
          </div>
        </div>
        <div className="p-6 space-y-4">
          {/* Chọn dự án */}
          <div className="space-y-1.5">
            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Chọn dự án</label>
            <select
              value={convProjectCode}
              onChange={e => { setConvProjectCode(e.target.value); setConvResult(null); }}
              className="w-full border border-slate-200 bg-slate-100 rounded-lg px-4 py-3 text-sm font-black text-slate-800 focus:border-violet-500 outline-none transition-all uppercase tracking-tight"
            >
              <option value="">-- CHỌN DỰ ÁN --</option>
              {existingProjects.map(p => (
                <option key={p.projectCode} value={p.projectCode}>
                  {p.displayCode || p.projectCode}: {p.projectName}
                </option>
              ))}
            </select>
          </div>

          {/* Chọn phiếu packing */}
          {convProjectCode && (
            <div className="space-y-1.5">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Chọn phiếu packing</label>
              <select
                value={convSelectedList?.id || ''}
                onChange={e => {
                  const list = convPackingLists.find(l => l.id === e.target.value);
                  setConvSelectedList(list || null);
                  setConvPreview(null);
                  setConvResult(null);
                  if (list) computeConversionPreview(list);
                }}
                disabled={convPackingLists.length === 0}
                className="w-full border border-slate-200 bg-slate-100 rounded-lg px-4 py-3 text-sm font-black text-slate-800 focus:border-violet-500 outline-none transition-all uppercase tracking-tight disabled:opacity-50"
              >
                {convPackingLists.length > 0 ? (
                  convPackingLists.map(l => (
                    <option key={l.id} value={l.id}>
                      {l.title} ({l.items?.length || 0} mục)
                    </option>
                  ))
                ) : (
                  <option value="">Không có phiếu packing</option>
                )}
              </select>
            </div>
          )}

          {/* Preview kết quả chuyển đổi */}
          {convPreview && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="text-center p-3 bg-amber-50 rounded-lg border border-amber-100">
                  <p className="text-[10px] font-black text-amber-500 uppercase mb-1">Trước chuyển đổi</p>
                  <p className="text-lg font-black text-amber-700">{convPreview.before.length} mục</p>
                  <p className="text-[10px] text-amber-600 font-bold">({convPreview.before.reduce((s, i) => s + i.quantity, 0)} tổng SL)</p>
                </div>
                <div className="text-center p-3 bg-violet-50 rounded-lg border border-violet-100">
                  <p className="text-[10px] font-black text-violet-500 uppercase mb-1">Sau chuyển đổi</p>
                  <p className="text-lg font-black text-violet-700">{convPreview.after.length} mục</p>
                  <p className="text-[10px] text-violet-600 font-bold">(tách riêng instance)</p>
                </div>
              </div>

              {/* Danh sách chi tiết trước/sau */}
              <div className="max-h-64 overflow-y-auto border border-slate-200 rounded-lg">
                <table className="w-full text-xs">
                  <thead className="bg-slate-100 sticky top-0">
                    <tr>
                      <th className="text-left p-2 font-black text-slate-500 uppercase text-[10px]">Module</th>
                      <th className="text-center p-2 font-black text-slate-500 uppercase text-[10px] w-16">SL cũ</th>
                      <th className="text-center p-2 font-black text-slate-500 uppercase text-[10px] w-16">Sau</th>
                      <th className="text-center p-2 font-black text-slate-500 uppercase text-[10px] w-20">Trạng thái</th>
                    </tr>
                  </thead>
                  <tbody>
                    {convPreview.before.map((item, i) => {
                      const total = item.quantity;
                      const packedCount = item.packedQty ?? (item.packed ? total : 0);
                      return (
                        <tr key={i} className="border-t border-slate-100">
                          <td className="p-2 font-bold text-slate-700 truncate max-w-[180px]">
                            {item.name}
                            {(item.photos?.length || 0) > 0 && (
                              <span className="ml-1 text-[9px] font-black text-sky-500 bg-sky-100 px-1 py-0.5 rounded-lg">{item.photos!.length} ảnh</span>
                            )}
                          </td>
                          <td className="p-2 text-center font-black text-amber-600">{item.quantity}</td>
                          <td className="p-2 text-center font-black text-violet-600">{total}x #1/{total}</td>
                          <td className="p-2 text-center">
                            {packedCount > 0
                              ? <span className="text-[10px] font-black text-emerald-600 bg-emerald-100 px-1.5 py-0.5 rounded-lg">{packedCount}/{total}</span>
                              : <span className="text-[10px] font-black text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded-lg">0/{total}</span>
                            }
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {convPreview.before.length === 0 && (
                <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-lg text-center">
                  <p className="text-xs font-black text-emerald-600">Phiếu đã ở dạng instance. Không cần chuyển đổi.</p>
                </div>
              )}

              {/* Nút chuyển đổi */}
              {convPreview.before.length > 0 && (
                <button
                  onClick={handleConvertPacking}
                  disabled={convLoading}
                  className="w-full py-3 bg-violet-600 hover:bg-violet-700 text-white rounded-lg font-black uppercase text-[10px] tracking-widest transition-all shadow-lg active:scale-95 disabled:opacity-50 flex items-center justify-center gap-2 cursor-pointer"
                >
                  {convLoading ? (
                    <><Loader2 size={14} className="animate-spin" /> Đang chuyển đổi...</>
                  ) : (
                    <><Layers size={14} /> Tạo phiếu mới (Chuyển Instance)</>
                  )}
                </button>
              )}
            </div>
          )}

          {/* Kết quả */}
          {convResult && (
            <div className={`p-4 rounded-lg border text-xs font-bold uppercase space-y-1.5 ${
              convResult.success
                ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                : 'bg-rose-50 border-rose-200 text-rose-800'
            }`}>
              {convResult.message}
            </div>
          )}
        </div>
      </motion.div>

      {/* THEM rawQR vao loading_histories */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-white rounded-lg shadow-sm border border-slate-100 overflow-hidden"
      >
        <div className="p-6 border-b border-gray-50 bg-violet-50/20">
          <h3 className="font-black text-violet-950 uppercase tracking-widest text-sm flex items-center space-x-2">
            <QrCode size={16} className="text-violet-600" />
            <span>Them rawQR vao loading_histories</span>
          </h3>
          <p className="text-xs text-slate-400 font-bold uppercase mt-1">Chon phieu PKL de bo sung rawQR vao cac kien trong phieu (manualItems + packageIds)</p>
        </div>
        <div className="p-6 space-y-4">
          <div className="flex flex-col sm:flex-row gap-3">
            <select
              value={rawQrSelectedPkl}
              onChange={e => setRawQrSelectedPkl(e.target.value)}
              className="flex-1 bg-slate-50 border border-slate-200 rounded-sm px-4 py-3 text-sm font-bold text-slate-800 outline-none focus:border-violet-500 transition-all"
            >
              <option value="">-- Chon phieu PKL --</option>
              {rawQrPklList.map((p: any) => (
                <option key={p.id} value={p.id}>{p.pklCode} - {p.projectName}</option>
              ))}
            </select>
            <button
              onClick={handleInsertRawQr}
              disabled={!rawQrSelectedPkl || rawQrLoading}
              className="px-6 py-3 bg-violet-600 hover:bg-violet-700 disabled:bg-slate-200 disabled:text-slate-400 text-white text-xs font-black uppercase tracking-widest rounded-sm transition-all flex items-center justify-center gap-2 shadow-md cursor-pointer active:scale-95 shrink-0"
            >
              {rawQrLoading ? <><Loader2 size={16} className="animate-spin" /> Dang xu ly...</> : <><QrCode size={16} /> Them rawQR</>}
            </button>
          </div>

          {rawQrResult && (
            <div className={`p-4 rounded-lg text-xs font-bold ${rawQrResult.errors.length > 0 ? 'bg-amber-50 text-amber-700 border border-amber-200' : 'bg-emerald-50 text-emerald-700 border border-emerald-200'}`}>
              <div className="flex items-center gap-4 mb-2">
                <span>Tong: <strong>{rawQrResult.total}</strong></span>
                <span>Da cap nhat: <strong className="text-emerald-600">{rawQrResult.updated}</strong></span>
                <span>Bo qua: <strong>{rawQrResult.skipped}</strong></span>
              </div>
              {rawQrResult.errors.length > 0 && (
                <div className="mt-2 space-y-1">
                  {rawQrResult.errors.map((err, i) => (
                    <div key={i} className="text-amber-600">- {err}</div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </motion.div>

    </div>
  );
}
