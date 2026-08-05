/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'motion/react';
import { Layers, Inbox, Truck, Trash2, ArrowLeft, Pencil, CheckCircle, Loader2, Save, X, PlusCircle, ChevronRight, ChevronLeft, Camera, Image as ImageIcon, Plus, QrCode, Smartphone, Check, Search, Printer, Clock, ScanQrCode, RefreshCw, Code, Scale, CalendarDays } from 'lucide-react';
import QRCode from 'qrcode';
import { collection, query, where, onSnapshot, orderBy, doc, deleteDoc, updateDoc, addDoc, serverTimestamp, getDoc } from 'firebase/firestore';
import { useAuth } from '../lib/AuthContext';
import { useLanguage } from '../lib/LanguageContext';
import { db, handleFirestoreError, OperationType, cleanUndefinedFields, onCustomersSnapshot } from '../lib/firebase';
import { ProjectEntry, PackingList, PackingItem, matchSearchQuery, PKLOrder, getModuleQcAggregate, getModuleInstances } from '../types';
import { formatProjectCode, formatProjectName, getProjectGroupColor } from '../lib/formatters';
import { ScannerModal, ScannedResult } from '../components/ScannerModal';
import { PackingExcelEditorModal } from '../components/PackingExcelEditorModal';
import { generateLabelCardHtml, LABEL_CSS } from '../components/LabelTemplate';
import { uploadToCloudinary } from '../lib/cloudinary';
import { useAlert } from '../lib/AlertContext';
import { autoPassBuForPackage } from '../lib/qcPassBu';
import { addProjectModule, findProjectConfigId, updateProjectModule, batchUpdateProjectModules } from '../lib/dualWrite';
import * as XLSX from 'xlsx';

const getEntryType = (entry: ProjectEntry): 'Thùng' | 'Cánh' | 'Đợt' | 'Mặt HK' | 'CTHT' | 'Gia công ngoài' | 'Len, Filler' => {
  if (entry.classification) return entry.classification as any;
  const code = entry.moduleCode || '';
  return determineClassificationByName(code) as any;
};

const determineClassificationByName = (mCode: string): string => {
  const lower = mCode.toLowerCase();
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

// Tính trọng lượng tủ dựa trên kích thước 6 mặt
const calculateCabinetWeight = (wStr: string, dStr: string, hStr: string): string => {
  const w = parseFloat(wStr) || 0;
  const d = parseFloat(dStr) || 0;
  const h = parseFloat(hStr) || 0;

  if (w <= 0 || d <= 0 || h <= 0) return "0";

  const doorsAndBack = h * w * 18 * 3; // 2 cánh + 1 mặt sau
  const sides = h * d * 18 * 2;
  const topAndBottom = w * d * 18 * 2;

  const totalMm3 = doorsAndBack + sides + topAndBottom;
  const totalM3 = totalMm3 / 1000000000;
  const weightKg = totalM3 * 750 * 0.7; // Giảm 20% so với lý thuyết

  return (Math.round(weightKg * 10) / 10).toString();
};

// Helper: deduplicate items by id or name (cho counting trên list view cards)
const getDedupedItems = (list: PackingItem[]) => {
  const seen = new Set<string>();
  return list.filter(item => {
    const key = item.id || item.name || '';
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

// Số kiện đã đóng của 1 item — chặn packedQty vượt quantity
// (dữ liệu cũ có thể lưu packedQty sai > quantity, khiến bộ đếm như 123/23)
const getItemPackedCount = (item: PackingItem): number => {
  const qty = item.quantity || 0;
  const packedQty = typeof item.packedQty === 'number' ? item.packedQty : (item.packed ? qty : 0);
  return Math.max(0, Math.min(packedQty, qty));
};

// Helper: tính rawQR thống nhất cho kiện module/CTHT (không có ----EASYCABINET----)
const stripQrSuffix = (raw: string): string => raw.replace(/----.*----/, '').trim();
const computeRawQR = (item: PackingItem): string => {
  const isCtht = item.subType === 'kienCTHT';
  const baseCode = item.name.includes('#') ? item.name.split('#')[0].trim() : item.name;
  const instIdx = item.instanceIndex;
  const totalInst = item.totalInstances;
  const instanceSuffix = totalInst && totalInst > 1 && instIdx ? `|${instIdx}` : '';
  if (isCtht && item.id) return `${item.id}|${item.name}`;
  return `${baseCode}${instanceSuffix}`;
};

interface PackingScreenProps {
  projectEntries: ProjectEntry[];
  selectedPackingId: string | null;
  setSelectedPackingId: (id: string | null) => void;
  focusModuleName?: string | null;
  focusInstanceIndex?: number | null;
  clearFocusModuleName?: () => void;
  isGuest?: boolean;
  guestProjectCodes?: string[];
  onOpenCompletedProject?: (projectCode: string) => void;
}

export function PackingScreen({
  projectEntries,
  selectedPackingId,
  setSelectedPackingId,
  focusModuleName,
  focusInstanceIndex,
  clearFocusModuleName,
  isGuest = false,
  guestProjectCodes = [],
  onOpenCompletedProject,
}: PackingScreenProps) {
  const { user, userProfile, role, roles, hasRole } = useAuth();
  const { t } = useLanguage();
  const { showSuccess, showError, showConfirm } = useAlert();
  const [packingLists, setPackingLists] = useState<PackingList[]>([]);
  const [pklLists, setPklLists] = useState<PKLOrder[]>([]);
  const [customerProjectMap, setCustomerProjectMap] = useState<Record<string, string>>({});

  // Local states for list view only
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createMode, setCreateMode] = useState<'project' | 'manual' | null>(null);
  const [selectedProject, setSelectedProject] = useState('');
  const [selectableEntries, setSelectableEntries] = useState<ProjectEntry[]>([]);
  const [selectedEntriesForPack, setSelectedEntriesForPack] = useState<string[]>([]);
  const [packingFilter, setPackingFilter] = useState<'thung' | 'hang_son' | 'all'>('all');
  const [showCompletedProjects, setShowCompletedProjects] = useState(false);
  const [manualTitle, setManualTitle] = useState('');
  const [loading, setLoading] = useState(false);

  // Sắp xếp: phiếu chưa hoàn tất lên trên, đã hoàn tất xuống dưới
  const sortedPackingLists = useMemo(() => {
    return [...packingLists].sort((a, b) => {
      if (a.isCompleted === b.isCompleted) return 0;
      return a.isCompleted ? 1 : -1;
    });
  }, [packingLists]);

  // --- localStorage cache helpers for packing data ---
  const PACKING_CACHE_KEY = 'draco_packing_lists_cache';
  const PACKING_TS_KEY = 'draco_packing_lists_ts';
  const LOADING_CACHE_KEY = 'draco_pkl_lists_cache';
  const LOADING_TS_KEY = 'draco_pkl_lists_ts';
  const CUSTOMER_CACHE_KEY = 'draco_customer_project_map_cache';
  const CUSTOMER_TS_KEY = 'draco_customer_project_map_ts';
  const CACHE_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

  const readPackingCache = (): PackingList[] | null => {
    try {
      const ts = Number(localStorage.getItem(PACKING_TS_KEY) || 0);
      if (Date.now() - ts > CACHE_MAX_AGE_MS) return null;
      const raw = localStorage.getItem(PACKING_CACHE_KEY);
      if (!raw) return null;
      return JSON.parse(raw, (_key, val) => {
        if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(val)) return new Date(val);
        return val;
      });
    } catch { return null; }
  };

  const writePackingCache = (lists: PackingList[]) => {
    try {
      localStorage.setItem(PACKING_CACHE_KEY, JSON.stringify(lists));
      localStorage.setItem(PACKING_TS_KEY, String(Date.now()));
    } catch {}
  };

  const readPklCache = (): PKLOrder[] | null => {
    try {
      const ts = Number(localStorage.getItem(LOADING_TS_KEY) || 0);
      if (Date.now() - ts > CACHE_MAX_AGE_MS) return null;
      const raw = localStorage.getItem(LOADING_CACHE_KEY);
      if (!raw) return null;
      return JSON.parse(raw, (_key, val) => {
        if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(val)) return new Date(val);
        return val;
      });
    } catch { return null; }
  };

  const writePklCache = (lists: PKLOrder[]) => {
    try {
      localStorage.setItem(LOADING_CACHE_KEY, JSON.stringify(lists));
      localStorage.setItem(LOADING_TS_KEY, String(Date.now()));
    } catch {}
  };

  const readCustomerCache = (): Record<string, string> | null => {
    try {
      const ts = Number(localStorage.getItem(CUSTOMER_TS_KEY) || 0);
      if (Date.now() - ts > CACHE_MAX_AGE_MS) return null;
      const raw = localStorage.getItem(CUSTOMER_CACHE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  };

  const writeCustomerCache = (map: Record<string, string>) => {
    try {
      localStorage.setItem(CUSTOMER_CACHE_KEY, JSON.stringify(map));
      localStorage.setItem(CUSTOMER_TS_KEY, String(Date.now()));
    } catch {}
  };

  // Load from cache instantly on mount
  useEffect(() => {
    const cachedPacking = readPackingCache();
    if (cachedPacking) setPackingLists(cachedPacking);
    const cachedPkl = readPklCache();
    if (cachedPkl) {
      let lists = cachedPkl;
      if (isGuest && guestProjectCodes.length > 0) {
        lists = lists.filter(p =>
          guestProjectCodes.includes(p.projectId) ||
          p.projectId === 'all' ||
          guestProjectCodes.includes((p as any).projectCode || '')
        );
      }
      setPklLists(lists);
    }
    const cachedCustomer = readCustomerCache();
    if (cachedCustomer) setCustomerProjectMap(cachedCustomer);
  }, []);

  // Real-time: packing collection
  useEffect(() => {
    if (!user) return;
    const q = query(
      collection(db, 'packing'),
      orderBy('createdAt', 'desc')
    );
    const unsub = onSnapshot(q, (snapshot) => {
      let lists = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as PackingList));
      // Guest: chỉ hiện phiếu đóng gói có projectCode thuộc dự án mình
      if (isGuest && guestProjectCodes.length > 0) {
        lists = lists.filter(p => guestProjectCodes.includes(p.projectCode || ''));
      }
      setPackingLists(lists);
      writePackingCache(lists);
    }, (err) => handleFirestoreError(err, OperationType.GET, 'packing'));
    return unsub;
  }, [user, isGuest, guestProjectCodes]);

  // Real-time: loading (PKL) collection
  useEffect(() => {
    if (!user) return;
    const q = query(
      collection(db, 'loading'),
      orderBy('createdAt', 'desc')
    );
    const unsub = onSnapshot(q, (snapshot) => {
      let lists = snapshot.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() } as PKLOrder));
      if (isGuest && guestProjectCodes.length > 0) {
        lists = lists.filter(p =>
          guestProjectCodes.includes(p.projectId) ||
          p.projectId === 'all' ||
          guestProjectCodes.includes((p as any).projectCode || '')
        );
      }
      setPklLists(lists);
      writePklCache(lists);
    }, (err) => handleFirestoreError(err, OperationType.GET, 'loading'));
    return unsub;
  }, [user, isGuest, guestProjectCodes]);

  // Real-time: customers → project map
  useEffect(() => {
    const unsub = onCustomersSnapshot((data: any[]) => {
      const map: Record<string, string> = {};
      data.forEach((c) => {
        const projects = c.projects || c.projectCodes?.map((code: string) => ({ code, subCodes: [] })) || [];
        projects.forEach((p: any) => {
          (p.subCodes || []).forEach((sub: string) => {
            map[sub.toUpperCase()] = p.code;
          });
        });
      });
      setCustomerProjectMap(map);
      writeCustomerCache(map);
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    setPackingFilter('all');
  }, [selectedProject, createMode]);

  // Yêu cầu App load modules on-demand nếu đang mở project hoàn tất chưa load modules thật
  useEffect(() => {
    if (createMode === 'project' && selectedProject) {
      const hasCompletedPlaceholder = projectEntries.some(
        e => e.isCompleted && e.projectCode === selectedProject && e.id.startsWith('completed-')
      );
      if (hasCompletedPlaceholder) {
        onOpenCompletedProject?.(selectedProject);
      }
    }
  }, [createMode, selectedProject, projectEntries, onOpenCompletedProject]);

  useEffect(() => {
    if (createMode === 'project' && selectedProject) {
      let filtered = projectEntries.filter(e => e.projectCode === selectedProject);

      if (packingFilter === 'thung') {
        filtered = filtered.filter(e => getEntryType(e) === 'Thùng');
      } else if (packingFilter === 'hang_son') {
        filtered = filtered.filter(e => {
          const type = getEntryType(e);
          return type === 'Cánh' || type === 'Mặt HK' || type === 'CTHT';
        });
      }

      const sorted = [...filtered].sort((a, b) => (a.sortIndex || 0) - (b.sortIndex || 0));
      setSelectableEntries(sorted);
      setSelectedEntriesForPack(sorted.map(e => e.id)); // Default to all
    } else {
      setSelectableEntries([]);
      setSelectedEntriesForPack([]);
    }
  }, [createMode, selectedProject, packingFilter, projectEntries]);

  const projects = useMemo(() => {
    return Array.from(new Set(projectEntries.map(p => p.projectCode))).map(code => {
      const entry = projectEntries.find(p => p.projectCode === code);
      const isCompleted = projectEntries.filter(p => p.projectCode === code).some(p => (p as any).isCompleted);
      return { code, name: formatProjectName(entry?.projectName) || 'Không tên', isCompleted };
    }).filter(p => showCompletedProjects || !p.isCompleted).reverse();
  }, [projectEntries, showCompletedProjects]);

  const handleCreate = async (autoProjectCode?: string) => {
    if (!user) return;
    setLoading(true);
    try {
      let title = '';
      let items: PackingItem[] = [];
      let projectCode = '';

      if (createMode === 'project' || autoProjectCode) {
        const code = autoProjectCode || selectedProject;
        const p = projects.find(pr => pr.code === code);
        title = `${p?.name || code}`;
        projectCode = code;

        const entries = projectEntries.filter(e => e.projectCode === code);

        // Tach Thung, CTHT va Len/Filler
        const thungEntries = entries.filter(e => getEntryType(e) === 'Thùng');
        const cthtEntries = entries.filter(e => getEntryType(e) === 'CTHT' || getEntryType(e) === 'Len, Filler');

        // 1. Kien Module cho Thung
        const thungItems: PackingItem[] = thungEntries.flatMap(e => {
          const totalInstances = Number(e.quantity) || 1;

          return Array.from({ length: totalInstances }, (_, i) => {
            const chotDotAcc = e.accessories?.find(a => {
              const n = String(a.name).toLowerCase();
              return n.includes('chốt đợt di động') ||
                n.includes('chot dot di dong') ||
                n.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').includes('chot dot di dong');
            });
            const shelfQuantity = chotDotAcc ? Math.floor(Number(chotDotAcc.quantity) / 4) : 0;

            const accessories = (e.accessories?.map(a => ({ name: a.name, quantity: a.quantity, checked: false })) || [])
              .sort((a, b) => {
                const lowerA = a.name.toLowerCase();
                const lowerB = b.name.toLowerCase();
                const isShelfA = lowerA.includes('đợt di động') && !lowerA.includes('chốt');
                const isShelfB = lowerB.includes('đợt di động') && !lowerB.includes('chốt');
                const isPinA = lowerA.includes('chốt đợt');
                const isPinB = lowerB.includes('chốt đợt');

                if (isShelfA && !isShelfB) return -1;
                if (!isShelfA && isShelfB) return 1;
                if (isPinA && !isPinB) return -1;
                if (!isPinA && isPinB) return 1;
                return lowerA.localeCompare(lowerB);
              });
            if (shelfQuantity > 0) {
              const hasShelf = accessories.some(a => {
                const n = String(a.name).toLowerCase();
                return (n.includes('đợt di động') || n.includes('dot di dong')) && !n.includes('chốt') && !n.includes('chot');
              });
              if (!hasShelf) {
                accessories.push({ name: 'Đợt di động', quantity: shelfQuantity, checked: false });
              }
            }

            // Thêm tùy chọn "Gói hút ẩm"
            const hasDesiccant = accessories.some(a => {
              const n = String(a.name).toLowerCase();
              return n.includes('gói hút ẩm') || n.includes('goi hut am');
            });
            if (!hasDesiccant) {
              accessories.push({ name: 'Gói hút ẩm', quantity: 1, checked: false });
            }

            // Sắp xếp lại accessories để "Gói hút ẩm" nằm đúng vị trí
            accessories.sort((a, b) => {
              const lowerA = a.name.toLowerCase();
              const lowerB = b.name.toLowerCase();
              const isDesiccantA = lowerA.includes('hút ẩm') || lowerA.includes('hut am');
              const isDesiccantB = lowerB.includes('hút ẩm') || lowerB.includes('hut am');
              const isShelfA = lowerA.includes('đợt di động') && !lowerA.includes('chốt');
              const isShelfB = lowerB.includes('đợt di động') && !lowerB.includes('chốt');
              const isPinA = lowerA.includes('chốt đợt');
              const isPinB = lowerB.includes('chốt đợt');

              if (isShelfA && !isShelfB) return -1;
              if (!isShelfA && isShelfB) return 1;
              if (isPinA && !isPinB) return -1;
              if (!isPinA && isPinB) return 1;
              if (isDesiccantA && !isDesiccantB) return -1;
              if (!isDesiccantA && isDesiccantB) return 1;
              return lowerA.localeCompare(lowerB);
            });

            return {
              id: `${e.id}_${i}`,
              name: totalInstances > 1 ? `${e.moduleCode} #${i + 1}/${totalInstances}` : e.moduleCode,
              rawQR: totalInstances > 1 ? `${e.moduleCode}|${i + 1}` : e.moduleCode,
              cluster: e.cluster,
              subType: 'kienModule',
              quantity: 1,
              packed: false,
              packStatus: 'pending',
              hasMobileShelf: false,
              shelfQuantity: shelfQuantity,
              shelfChecked: false,
              accessoryChecked: false,
              w: String(e.pWidth || 0),
              d: String(e.pDepth || 0),
              h: String(e.pHeight || 0),
              weight: (() => {
                const pw = e.pWidth || 0;
                const pd = e.pDepth || 0;
                const ph = e.pHeight || 0;
                if (pw > 0 && pd > 0 && ph > 0) return parseFloat(calculateCabinetWeight(String(pw), String(pd), String(ph))) || 0;
                return 0;
              })(),
              accessories: accessories,
              instanceIndex: totalInstances > 1 ? i + 1 : undefined,
              totalInstances: totalInstances > 1 ? totalInstances : undefined,
              createdAt: Date.now(),
            };
          });
        });

        // 2. Kien CTHT gom theo cum (thanH treo gom rieng 1 kien "Wall Cabinet Hanger")
        const isLenFil = (e: ProjectEntry) => {
          const nameLower = (e.moduleCode || '').toLowerCase();
          return nameLower.includes('fil') || nameLower.includes('len');
        };
        const isThanhTreo = (e: ProjectEntry) => {
          const nameLower = (e.moduleCode || '').toLowerCase();
          return nameLower.includes('thanh treo');
        };

        const normalCthts = cthtEntries.filter(e => !isLenFil(e) && !isThanhTreo(e));
        const lenFilCthts = cthtEntries.filter(e => isLenFil(e));
        const thanhTreoCthts = cthtEntries.filter(e => isThanhTreo(e));

        const groupedByCluster: Record<string, ProjectEntry[]> = {};
        normalCthts.forEach(entry => {
          const cluster = entry.cluster || 'Khong phan cum';
          if (!groupedByCluster[cluster]) groupedByCluster[cluster] = [];
          groupedByCluster[cluster].push(entry);
        });
        if (lenFilCthts.length > 0) {
          groupedByCluster['LEN, FILLER'] = lenFilCthts;
        }
        if (thanhTreoCthts.length > 0) {
          groupedByCluster['Wall Cabinet Hanger'] = thanhTreoCthts;
        }

        // Helper: tạo 1 kiện CTHT từ danh sách entries
        const buildCthtKien = (cths: ProjectEntry[], baseName: string, baseCluster: string, idx: number, total: number): PackingItem => {
          const accs = cths.map(c => {
            const insts = getModuleInstances(c);
            const firstInst = insts.length > 0 ? insts[0] : null;
            return {
              name: c.moduleCode,
              quantity: c.quantity || 1,
              checked: false,
              entryId: c.id,
              tempLabelIndex: firstInst?.tempLabelIndex
            };
          });
          let wMax = 0, dMax = 0, totalPlates = 0;
          for (const c of cths) {
            const wVal = parseFloat(String(c.pWidth || c.width || c.length || 0)) || 0;
            const dVal = parseFloat(String(c.pDepth || c.depth || 0)) || 0;
            if (wVal > wMax) wMax = wVal;
            if (dVal > dMax) dMax = dVal;
            totalPlates += (c.quantity || 1);
          }
          const w = totalPlates > 0 ? Math.round(wMax) + 50 : 0;
          const d = totalPlates > 0 ? Math.round(dMax) + 50 : 0;
          const h = totalPlates > 0 ? totalPlates * 20 + 50 : 0;
          const weight = (w > 0 && d > 0 && h > 0) ? parseFloat(calculateCabinetWeight(String(w), String(d), String(h))) || 0 : 0;
          const suffix = total > 1 ? ` ${idx}/${total}` : '';
          const kienCluster = baseCluster === 'Wall Cabinet Hanger' ? 'KITCHEN' : baseCluster;
          const kienId = `ctht-auto-${baseCluster}-${Date.now()}-${idx}`;
          const kienName = `${baseName}${suffix}`;
          return {
            id: kienId,
            name: kienName,
            rawQR: `${kienId}|${kienName}`,
            quantity: 1,
            packed: false,
            packStatus: 'pending',
            subType: 'kienCTHT' as const,
            cluster: kienCluster,
            isExtra: true,
            w: String(w), d: String(d), h: String(h), weight,
            accessories: accs,
            createdAt: Date.now(),
          };
        };

        // Helper: chia mảng thành các chunk theo số lượng tối đa
        const chunkByCount = <T,>(arr: T[], maxPerChunk: number): T[][] => {
          const chunks: T[][] = [];
          for (let i = 0; i < arr.length; i += maxPerChunk) {
            chunks.push(arr.slice(i, i + maxPerChunk));
          }
          return chunks;
        };

        // Helper: tính trọng lượng 1 tấm ván đơn lẻ (W x D x T)
        const calcSinglePanelWeight = (w: number, d: number, thickness: number): number => {
          if (w <= 0 || d <= 0 || thickness <= 0) return 0;
          const volumeM3 = (w * d * thickness) / 1000000000;
          return volumeM3 * 750 * 0.7;
        };

        // Helper: chia mảng theo trọng lượng tối đa (greedy bin packing)
        const chunkByWeight = (entries: ProjectEntry[], maxWeight: number): ProjectEntry[][] => {
          if (entries.length === 0) return [];
          const entryWeights = entries.map(e => {
            const pw = parseFloat(String(e.pWidth || e.width || e.length || 0)) || 0;
            const pd = parseFloat(String(e.pDepth || e.depth || 0)) || 0;
            const qty = e.quantity || 1;
            if (pw > 0 && pd > 0) {
              return Math.round(calcSinglePanelWeight(pw, pd, 18) * qty * 10) / 10;
            }
            return 0;
          });

          const chunks: ProjectEntry[][] = [];
          let currentChunk: ProjectEntry[] = [];
          let currentWeight = 0;

          for (let i = 0; i < entries.length; i++) {
            const ew = entryWeights[i];
            if (currentChunk.length > 0 && currentWeight + ew > maxWeight && currentWeight > 0) {
              chunks.push(currentChunk);
              currentChunk = [];
              currentWeight = 0;
            }
            currentChunk.push(entries[i]);
            currentWeight += ew;
          }
          if (currentChunk.length > 0) chunks.push(currentChunk);
          return chunks;
        };

        const cthtKienItems: PackingItem[] = [];
        for (const [cluster, cthts] of Object.entries(groupedByCluster)) {
          const baseName = cluster === 'Wall Cabinet Hanger' ? 'Wall Cabinet Hanger' : cluster === 'LEN, FILLER' ? 'LEN, FILLER' : 'FINISHED PANEL';

          // Helper: lấy type từ moduleCode (phần sau dấu '.')
          const getType = (e: ProjectEntry): string => {
            const parts = (e.moduleCode || '').split('_');
            return parts.length > 1 ? parts[parts.length - 1].toUpperCase() : '';
          };

          // Sắp xếp CTHT theo type để ưu tiên gom cùng type vào chung 1 kiện
          const sortedCthts = [...cthts].sort((a, b) => {
            const typeA = getType(a);
            const typeB = getType(b);
            if (typeA !== typeB) return typeA.localeCompare(typeB);
            return (a.moduleCode || '').localeCompare(b.moduleCode || '');
          });

          // Chia chunks: entry có weight > 60kg sẽ được chia quantity thành nhiều kiện
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

            let remaining = qty;
            while (remaining > 0) {
              const spaceLeft = 60 - currentWeight;
              const maxFit = unitWeight > 0 ? Math.floor(spaceLeft / unitWeight) : remaining;
              const take = Math.min(remaining, Math.max(0, maxFit));

              if (take <= 0 && currentChunk.length > 0) {
                finalChunks.push({ entries: [...currentChunk], quantities: [...currentQtys] });
                currentChunk = [];
                currentQtys = [];
                currentWeight = 0;
                continue;
              }

              if (take < remaining) {
                currentChunk.push(entry);
                currentQtys.push(take);
                currentWeight += unitWeight * take;
                finalChunks.push({ entries: [...currentChunk], quantities: [...currentQtys] });
                currentChunk = [];
                currentQtys = [];
                currentWeight = 0;
                remaining -= take;
              } else {
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
            // Tạo bản sao entry với quantity đã chia
            const adjustedEntries = chunk.entries.map((e, i) => ({ ...e, quantity: chunk.quantities[i] }));
            cthtKienItems.push(buildCthtKien(adjustedEntries, baseName, cluster, idx + 1, total));
          });
        }

        items = [...thungItems, ...cthtKienItems];
      } else {
        title = manualTitle || 'Packing List Mới';
        items = [];
      }

      const displayLabel = userProfile?.ten_that ? `${userProfile.ten_that} (${userProfile.chuc_danh || 'NV'})` : (user?.displayName || 'Anonymous');

      const docRef = await addDoc(collection(db, 'packing'), {
        title,
        projectCode,
        items: cleanUndefinedFields(items),
        isCompleted: false,
        ownerId: user.uid,
        userName: displayLabel,
        createdAt: serverTimestamp()
      });

      // Thêm packStatus: 'pending' vào instances trong project cho các module nằm trong phiếu đóng gói
      const packedModuleMap = new Map<string, number[]>(); // moduleId → [instanceIndex]
      items.forEach(item => {
        if (item.id && item.subType === 'kienModule') {
          const moduleId = item.id.includes('_') ? item.id.split('_')[0] : item.id;
          if (moduleId && !moduleId.startsWith('ctht-')) {
            if (!packedModuleMap.has(moduleId)) packedModuleMap.set(moduleId, []);
            if (item.instanceIndex) {
              packedModuleMap.get(moduleId)!.push(item.instanceIndex);
            }
          }
        }
      });

      // Batch: chỉ đọc đúng modules cần update, 1 lần ghi batch
      if (packedModuleMap.size > 0) {
        try {
          const configId = await findProjectConfigId(projectCode);
          if (configId) {
            // Chỉ đọc các module có trong phiếu (không đọc toàn bộ project)
            const readPromises = Array.from(packedModuleMap.keys()).map(async (moduleId) => {
              try {
                const modDoc = await getDoc(doc(db, 'projectConfigs', configId, 'modules', moduleId));
                return { moduleId, exists: modDoc.exists(), data: modDoc.exists() ? modDoc.data() as ProjectEntry : null };
              } catch { return { moduleId, exists: false, data: null }; }
            });
            const modResults = await Promise.all(readPromises);

            const batchUpdates: { moduleId: string; data: Record<string, any>; projectCode: string }[] = [];

            modResults.forEach(({ moduleId, exists, data }) => {
              if (!exists || !data) return;
              const targetIndices = packedModuleMap.get(moduleId)!;
              const instances = getModuleInstances(data);
              const updatedInstances = instances.map((inst: any) => {
                if (targetIndices.length === 0 || targetIndices.includes(inst.instanceIndex)) {
                  return { ...inst, packStatus: 'pending' };
                }
                return inst;
              });
              batchUpdates.push({ moduleId, data: { instances: updatedInstances }, projectCode });
            });

            if (batchUpdates.length > 0) {
              await batchUpdateProjectModules(batchUpdates);
            }
          }
        } catch (err) {
          console.error('Lỗi batch cập nhật packStatus:', err);
        }
      }

      // Log activity
      await addDoc(collection(db, 'activities'), {
        userId: user.uid,
        userName: displayLabel,
        userEmail: user.email,
        action: 'Tạo Packing List',
        details: `Tạo: ${title} (${formatProjectCode(projectCode) || 'Cá nhân'})`,
        projectCode: projectCode,
        timestamp: serverTimestamp()
      });

      setShowCreateModal(false);
      setCreateMode(null);
      setManualTitle('');
      setSelectedProject('');

      // Auto-select the newly created list
      setSelectedPackingId(docRef.id);
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, 'packing');
    } finally {
      setLoading(false);
    }
  };

  // Try to find selected list. If no direct ID match, try to find by module code contained within
  const selectedList = packingLists.find(l => l.id === selectedPackingId) ||
    (selectedPackingId ? packingLists.find(l => l.items?.some(i => i.name === selectedPackingId)) : undefined);

  if (selectedList) {
    return (
      <PackingDetailScreen
        packingList={selectedList}
        onBack={() => setSelectedPackingId(null)}
        mode="packing"
        projectEntries={projectEntries}
        selectedPackingId={selectedPackingId}
        pklLists={pklLists}
        allPackingLists={packingLists}
        focusModuleName={focusModuleName}
        focusInstanceIndex={focusInstanceIndex}
        clearFocusModuleName={clearFocusModuleName}
        isGuest={isGuest}
      />
    );
  }

  return (
    <div className="space-y-8 py-4 lg:pb-8">
      {/* Content Header */}
      <div className="w-full flex items-center">
        <div className="ml-auto">
          {(hasRole('admin') || hasRole('mod_dg')) && (
            <button
              onClick={() => setShowCreateModal(true)}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded text-sm font-bold shadow transition-all flex items-center cursor-pointer"
            >
              <PlusCircle size={18} className="mr-1" />
              {t("TẠO MỚI")}
            </button>
          )}
        </div>
      </div>



      {(
        <>
          {/* Packing List Cards (Mobile) */}
          <div className="md:hidden space-y-3">
            {packingLists.length > 0 ? (
              sortedPackingLists.map((list) => (
                <div
                  key={list.id}
                  onClick={() => setSelectedPackingId(list.id || null)}
                  className="bg-white rounded-xl border border-gray-200 active:bg-gray-100 transition-all flex overflow-hidden"
                >
                  {(() => {
                    const groupCode = customerProjectMap[(list.projectCode || '').toUpperCase()] || '';
                    const color = getProjectGroupColor(groupCode);
                    return groupCode ? (
                      <div className={`w-10 shrink-0 flex items-center justify-center ${color.bg} ${color.text}`}>
                        <span className="text-[10px] font-black uppercase" style={{ writingMode: 'vertical-rl', textOrientation: 'mixed' }}>
                          {groupCode}
                        </span>
                      </div>
                    ) : null;
                  })()}
                  <div className="flex-1 p-4 flex items-center justify-between">
                    <div className="flex items-start space-x-3 min-w-0 flex-1">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <h4 className="text-sm font-black text-gray-900 truncate min-w-0">{formatProjectCode(list.projectCode)}</h4>
                          <span className={`text-[10px] font-black uppercase shrink-0 ${list.isCompleted ? "text-emerald-500" : "text-blue-500"}`}>
                            {getDedupedItems(list.items).reduce((sum, i) => sum + getItemPackedCount(i), 0)}/{getDedupedItems(list.items).reduce((sum, i) => sum + (i.quantity || 0), 0)} {t("KIỆN GÓI")}
                          </span>
                        </div>
                        <span className="text-[10px] font-mono text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded uppercase mt-1 inline-block">
                          {list.title || t("Cá nhân")}
                        </span>
                      </div>
                    </div>
                    <ChevronRight size={18} className="text-gray-300 ml-2 shrink-0" />
                  </div>
                </div>
              ))
            ) : (
              <div className="py-12 text-center bg-white rounded-xl border border-dashed border-gray-200">
                <Inbox size={40} className="mx-auto mb-2 opacity-10" />
                <p className="text-[10px] font-black uppercase text-gray-300">{t("Chưa có đóng gói nào")}</p>
              </div>
            )}
          </div>

          {/* AdminLTE Card for List (Desktop Only) */}
          <div className="hidden md:block bg-white rounded shadow-sm border-t-4 border-primary">
            <div className="px-4 py-3 border-b border-gray-100">
              <h3 className="text-sm font-bold uppercase text-gray-700">{t("Danh sách Packing")}</h3>
            </div>

            <div className="p-0 overflow-x-auto">
              {packingLists.length > 0 ? (
                <table className="w-full text-left border-collapse min-w-[700px]">
                  <thead>
                    <tr className="bg-gray-100 text-gray-500 text-[10px] font-bold uppercase tracking-wider border-b border-gray-100">
                      <th className="px-3 py-3 w-10 text-center">{t("Nhóm")}</th>
                      <th className="px-4 py-3">{t("Tên đóng gói")}</th>
                      <th className="px-4 py-3">{t("Dự án")}</th>
                      <th className="px-4 py-3 text-center">{t("Tiến độ")}</th>
                      <th className="px-4 py-3">{t("Trạng thái")}</th>
                    </tr>
                  </thead>

                  <tbody className="divide-y divide-gray-100">
                    {sortedPackingLists.map((list) => {
                      const groupCode = customerProjectMap[(list.projectCode || '').toUpperCase()] || '';
                      const color = getProjectGroupColor(groupCode);
                      return (
                      <tr
                        key={list.id}
                        onClick={() => setSelectedPackingId(list.id || null)}
                        className="hover:bg-blue-100/30 transition-colors group"
                      >
                        <td className="text-center border-r border-gray-100">
                          {groupCode ? (
                            <div className={`flex items-center justify-center h-full min-h-[52px] w-full ${color.bg} ${color.text}`}>
                              <span className="text-[11px] font-black uppercase tracking-wider writing-vertical" style={{ writingMode: 'vertical-rl', textOrientation: 'mixed' }}>
                                {groupCode}
                              </span>
                            </div>
                          ) : (
                            <span className="text-[10px] text-slate-300">—</span>
                          )}
                        </td>

                        <td className="px-4 py-3">
                          <span className="text-sm font-black text-gray-900">
                            {formatProjectCode(list.projectCode)}
                          </span>
                        </td>

                        <td className="px-4 py-3">
                          <span className="text-xs font-mono text-gray-500 bg-gray-100 px-2 py-0.5 rounded">
                            {list.title}
                          </span>
                        </td>

                        <td className="px-4 py-3 text-center">
                          <div className="flex flex-col items-center">
                            <span className="text-xs font-bold text-gray-600">
                              {getDedupedItems(list.items).reduce((sum, i) => sum + getItemPackedCount(i), 0)}/
                              {getDedupedItems(list.items).reduce((sum, i) => sum + (i.quantity || 0), 0)} {t("Kiện")}
                            </span>
                            
                          </div>
                        </td>

                        <td className="px-4 py-3">
                          <span
                            className={`text-[10px] font-bold px-2 py-0.5 rounded uppercase border ${list.isCompleted
                              ? "bg-emerald-100 text-emerald-600 border-emerald-100"
                              : "bg-blue-100 text-blue-600 border-blue-100"
                              }`}
                          >
                            {list.isCompleted ? t("Hoàn thành") : t("Đang xử lý")}
                          </span>
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              ) : (
                <div className="py-16 text-center text-gray-400">
                  <Inbox size={48} className="mx-auto mb-4 opacity-10" />
                  <p className="text-sm font-bold uppercase tracking-widest opacity-30">{t("Chưa có Packing List")}</p>
                </div>
              )}
            </div>
          </div>

        </>
      )}

      {showCreateModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[110] p-4 backdrop-blur-sm">
          <div className="bg-white w-full max-w-md rounded-lg shadow-2xl overflow-hidden flex flex-col border border-slate-200">
            <div className="p-5 border-b border-slate-100 bg-white flex items-center justify-between">
              <h3 className="text-base font-black text-slate-800 uppercase tracking-tight">{t("Tạo Phiếu Đóng Gói")}</h3>
              <button onClick={() => setShowCreateModal(false)} className="p-2 text-slate-400 hover:text-rose-500 transition-colors"><X size={20} /></button>
            </div>

            <div className="p-7 space-y-6 flex-1 overflow-y-auto">
              {!createMode ? (
                <div className="grid grid-cols-1 gap-4">
                  <button onClick={() => setCreateMode('project')} className="p-8 bg-indigo-100 text-indigo-600 rounded-lg font-black uppercase tracking-widest text-[11px] border border-indigo-100 flex flex-col items-center hover:bg-indigo-100 transition-all group">
                    <div className="w-16 h-16 bg-white rounded-lg flex items-center justify-center mb-4 border border-indigo-100 group-hover:scale-110 transition-transform shadow-sm">
                      <Layers size={32} />
                    </div>
                    Thiết lập theo dự án
                  </button>
                  <button onClick={() => setCreateMode('manual')} className="p-8 bg-emerald-100 text-emerald-600 rounded-lg font-black uppercase tracking-widest text-[11px] border border-emerald-100 flex flex-col items-center hover:bg-emerald-100 transition-all group">
                    <div className="w-16 h-16 bg-white rounded-lg flex items-center justify-center mb-4 border border-emerald-100 group-hover:scale-110 transition-transform shadow-sm">
                      <PlusCircle size={32} />
                    </div>
                    Nhập dữ liệu thủ công
                  </button>
                </div>
              ) : (
                <div className="space-y-6">
                  {createMode === 'project' ? (
                    <>
                      <div className="space-y-2">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none">Vào dự án</label>
                        <select
                          className="w-full border border-slate-200 bg-slate-100 rounded-lg px-4 py-3.5 text-sm font-black text-slate-800 focus:border-indigo-600 outline-none transition-all uppercase tracking-tight shadow-none"
                          value={selectedProject}
                          onChange={e => setSelectedProject(e.target.value)}
                        >
                          <option value="">-- CHỌN DỰ ÁN --</option>
                          {projects.map(p => <option key={p.code} value={p.code}>{p.code}: {p.name}</option>)}
                        </select>
                        <label className="flex items-center gap-2 cursor-pointer select-none">
                          <input
                            type="checkbox"
                            checked={showCompletedProjects}
                            onChange={e => setShowCompletedProjects(e.target.checked)}
                            className="w-4 h-4 text-indigo-600 border-slate-300 rounded-lg focus:ring-0 cursor-pointer"
                          />
                          <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Hiển thị dự án đã hoàn tất</span>
                        </label>
                      </div>

                      {selectedProject && (
                        <div className="flex items-center bg-slate-100 p-3 rounded-md text-[12px] text-slate-600 uppercase font-black tracking-widest">
                          <span className="w-1/2 text-left">
                            Thùng:{" "}
                            <strong className="text-blue-600">
                              {projectEntries.filter(
                                e => e.projectCode === selectedProject && getEntryType(e) === "Thùng"
                              ).length}
                            </strong>
                          </span>

                          <span className="w-1/2 text-right">
                            CTHT/Len-Filler:{" "}
                            <strong className="text-amber-600">
                              {projectEntries.filter(
                                e =>
                                  e.projectCode === selectedProject &&
                                  (getEntryType(e) === "CTHT" ||
                                    getEntryType(e) === "Len, Filler")
                              ).length}
                            </strong>
                          </span>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="space-y-2">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none">Mô tả đóng gói</label>
                      <input
                        className="w-full border border-slate-200 bg-slate-100 rounded-lg px-4 py-3.5 text-sm font-black text-slate-900 focus:border-indigo-600 outline-none transition-all uppercase placeholder:italic shadow-none"
                        placeholder="VD: PACKING SẢN PHẨM MẪU..."
                        value={manualTitle}
                        onChange={e => setManualTitle(e.target.value)}
                      />
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="flex bg-slate-100 border-t border-slate-100 p-5 space-x-3">
              {createMode ? (
                <>
                  <button onClick={() => setCreateMode(null)} className="flex-1 py-3 text-slate-400 font-black uppercase text-[10px] tracking-widest hover:text-indigo-600 transition-colors">Quay lại</button>
                  <button
                    disabled={loading || (createMode === 'project' && !selectedProject)}
                    onClick={() => createMode === 'project' ? handleCreate(selectedProject) : handleCreate()}
                    className="flex-[2] py-3.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-black uppercase tracking-widest text-xs shadow-xl shadow-indigo-100 active:scale-95 disabled:opacity-100 transition-all flex items-center justify-center"
                  >
                    {loading ? <Loader2 size={18} className="animate-spin" /> : 'Xác nhận khởi tạo'}
                  </button>
                </>
              ) : (
                <button onClick={() => setShowCreateModal(false)} className="w-full py-3.5 bg-slate-100 text-slate-600 rounded-lg font-black uppercase tracking-widest text-[10px] transition-all">Đóng</button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function syncPackingItemWithProjectEntry(item: PackingItem, matchedEntry: ProjectEntry): PackingItem {
  const updatedItem = { ...item };

  if (matchedEntry.moduleCode && updatedItem.name !== matchedEntry.moduleCode) {
    updatedItem.name = matchedEntry.moduleCode;
  }
  if (matchedEntry.cluster !== undefined) {
    updatedItem.cluster = matchedEntry.cluster;
  }

  const projAccs = matchedEntry.accessories || [];
  const currentAccs = item.accessories || [];

  const chotDotAcc = projAccs.find((a: any) => {
    const n = String(a.name).toLowerCase();
    return n.includes('chốt đợt di động') ||
      n.includes('chot dot di dong') ||
      n.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').includes('chot dot di dong');
  });
  const shelfQuantity = chotDotAcc ? Math.floor(Number(chotDotAcc.quantity) / 4) : 0;

  const syncedAccs: any[] = [];

  projAccs.forEach((pa: any) => {
    const existing = currentAccs.find(ca => ca.name.toLowerCase() === pa.name.toLowerCase());
    syncedAccs.push({
      name: pa.name,
      quantity: pa.quantity,
      checked: existing ? !!existing.checked : false
    });
  });

  if (shelfQuantity > 0) {
    const hasShelf = syncedAccs.some(a => {
      const n = String(a.name).toLowerCase();
      return (n.includes('đợt di động') || n.includes('dot di dong')) && !n.includes('chốt') && !n.includes('chot');
    });
    if (!hasShelf) {
      const existingShelf = currentAccs.find(ca => {
        const n = String(ca.name).toLowerCase();
        return (n.includes('đợt di động') || n.includes('dot di dong')) && !n.includes('chốt') && !n.includes('chot');
      });
      syncedAccs.push({
        name: 'Đợt di động',
        quantity: shelfQuantity,
        checked: existingShelf ? !!existingShelf.checked : false
      });
    }
  }

  const isSpecialOrCustom = (name: string) => {
    const lower = name.toLowerCase();
    if (lower.includes('hút ẩm') || lower.includes('hut am')) return true;
    const inProj = projAccs.some((pa: any) => pa.name.toLowerCase() === lower);
    const isShelf = (lower.includes('đợt di động') || lower.includes('dot di dong')) && !lower.includes('chốt') && !lower.includes('chot');
    return !inProj && !isShelf;
  };

  currentAccs.forEach(ca => {
    if (isSpecialOrCustom(ca.name)) {
      syncedAccs.push({ ...ca });
    }
  });

  syncedAccs.sort((a, b) => {
    const lowerA = a.name.toLowerCase();
    const lowerB = b.name.toLowerCase();
    const isDesiccantA = lowerA.includes('hút ẩm') || lowerA.includes('hut am');
    const isDesiccantB = lowerB.includes('hút ẩm') || lowerB.includes('hut am');
    const isShelfA = lowerA.includes('đợt di động') && !lowerA.includes('chốt');
    const isShelfB = lowerB.includes('đợt di động') && !lowerB.includes('chốt');
    const isPinA = lowerA.includes('chốt đợt');
    const isPinB = lowerB.includes('chốt đợt');

    if (isShelfA && !isShelfB) return -1;
    if (!isShelfA && isShelfB) return 1;
    if (isPinA && !isPinB) return -1;
    if (!isPinA && isPinB) return 1;
    if (isDesiccantA && !isDesiccantB) return -1;
    if (!isDesiccantA && isDesiccantB) return 1;
    return lowerA.localeCompare(lowerB);
  });

  updatedItem.accessories = syncedAccs;
  updatedItem.accessoryChecked = updatedItem.accessoryChecked && syncedAccs.every(a => a.checked);

  return updatedItem;
}

// Tên dự án mặc định cho tem in: ưu tiên tên dự án thực (projectName) theo mã dự án của phiếu đóng gói,
// fallback về tiêu đề phiếu, rồi mã dự án đã định dạng — để cột Dự Án (Project) luôn là dự án của phiếu
function resolveSlipProjectName(
  projectEntries: ProjectEntry[] | null | undefined,
  projectCode: string,
  packingList: PackingList,
  defaultProj = ''
): string {
  return (
    projectEntries?.find(e => e.projectCode === projectCode && e.projectName)?.projectName
    || packingList.title
    || formatProjectCode(projectCode)
    || defaultProj
    || ''
  );
}

function PrintQtyModal({ itemName, onConfirm, onClose }: { itemName: string; onConfirm: (qty: number) => void; onClose: () => void }) {
  const [qty, setQty] = useState(4);
  return (
    <div className="fixed inset-0 z-[210] bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-white rounded-lg border border-slate-200 shadow-2xl w-full max-w-xs p-6 space-y-5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-emerald-100 text-emerald-600 rounded-lg flex items-center justify-center">
            <ScanQrCode size={22} />
          </div>
          <div>
            <h3 className="text-sm font-black text-slate-800 uppercase tracking-tight">Số lượng tem</h3>
            <p className="text-[10px] text-slate-400 font-bold uppercase">{itemName}</p>
          </div>
        </div>
        <div className="flex items-center justify-center gap-4">
          <button onClick={() => setQty(q => Math.max(1, q - 1))} className="w-12 h-12 rounded-lg bg-slate-100 border border-slate-200 text-xl font-black text-slate-600 hover:bg-slate-200 active:scale-95 transition-all">-</button>
          <input type="number" min="1" value={qty} onChange={(e) => setQty(Math.max(1, parseInt(e.target.value) || 1))} className="w-20 text-center text-2xl font-black text-slate-800 border-b-2 border-indigo-500 outline-none bg-transparent" />
          <button onClick={() => setQty(q => q + 1)} className="w-12 h-12 rounded-lg bg-slate-100 border border-slate-200 text-xl font-black text-slate-600 hover:bg-slate-200 active:scale-95 transition-all">+</button>
        </div>
        <div className="flex gap-3">
          <button onClick={onClose} className="flex-1 py-3 bg-slate-100 text-slate-600 font-black text-[10px] uppercase rounded-lg border border-slate-200 hover:bg-slate-200 transition-all">Hủy</button>
          <button onClick={() => onConfirm(qty)} className="flex-1 py-3 bg-emerald-500 hover:bg-emerald-600 text-white font-black text-[10px] uppercase rounded-lg transition-all flex items-center justify-center gap-2">
            <Printer size={14} /> In {qty} tem
          </button>
        </div>
      </div>
    </div>
  );
}

interface PackingDetailScreenProps {
  packingList: PackingList;
  onBack: () => void;
  mode: 'packing' | 'loading';
  projectEntries: ProjectEntry[];
  selectedPackingId: string | null;
  pklLists?: PKLOrder[];
  allPackingLists?: PackingList[];
  focusModuleName?: string | null;
  focusInstanceIndex?: number | null;
  clearFocusModuleName?: () => void;
  isGuest?: boolean;
}

function PackingDetailScreen({ packingList, onBack, mode, projectEntries, selectedPackingId, pklLists = [], allPackingLists = [], focusModuleName, focusInstanceIndex, clearFocusModuleName, isGuest = false }: PackingDetailScreenProps) {
  const { user, userProfile, role, roles, hasRole } = useAuth();
  const { t } = useLanguage();
  const { showError, showSuccess } = useAlert();
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<PackingItem[]>(() => {
    const formattedItems = (packingList.items || []).map(item => {
      const matched = projectEntries.find(e => e.id === item.id || (e.moduleCode || '').toLowerCase() === (item.name || '').toLowerCase());
      if (matched) {
        return syncPackingItemWithProjectEntry(item, matched);
      }

      let accessories = item.accessories ? [...item.accessories] : [];

      // Kiểm tra và đẩy "Gói hút ẩm"
      const hasDesiccant = accessories.some(a => {
        const n = String(a.name).toLowerCase();
        return n.includes('gói hút ẩm') || n.includes('goi hut am');
      });
      if (!hasDesiccant) {
        accessories.push({ name: 'Gói hút ẩm', quantity: 1, checked: false });
      }

      // Xử lý đợt di động nếu là module
      if (item.subType === 'kienModule') {
        const chotDotAcc = accessories.find(a => {
          const n = String(a.name).toLowerCase();
          return n.includes('chốt đợt di động') ||
            n.includes('chot dot di dong') ||
            n.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').includes('chot dot di dong');
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

      // Sắp xếp accessories
      accessories.sort((a, b) => {
        const lowerA = a.name.toLowerCase();
        const lowerB = b.name.toLowerCase();
        const isDesiccantA = lowerA.includes('hút ẩm') || lowerA.includes('hut am');
        const isDesiccantB = lowerB.includes('hút ẩm') || lowerB.includes('hut am');
        const isShelfA = lowerA.includes('đợt di động') && !lowerA.includes('chốt');
        const isShelfB = lowerB.includes('đợt di động') && !lowerB.includes('chốt');
        const isPinA = lowerA.includes('chốt đợt');
        const isPinB = lowerB.includes('chốt đợt');

        if (isShelfA && !isShelfB) return -1;
        if (!isShelfA && isShelfB) return 1;
        if (isPinA && !isPinB) return -1;
        if (!isPinA && isPinB) return 1;
        if (isDesiccantA && !isDesiccantB) return -1;
        if (!isDesiccantA && isDesiccantB) return 1;
        return lowerA.localeCompare(lowerB);
      });

      return {
        ...item,
        accessories,
        accessoryChecked: item.accessoryChecked && accessories.every(a => a.checked)
      };
    });

    // Sắp xếp danh sách mặt hàng & chi tiết theo bảng chữ cái tiếng Việt và theo từng cụm
    formattedItems.sort((a, b) => {
      const clusterA = (a.cluster || '').toLowerCase();
      const clusterB = (b.cluster || '').toLowerCase();
      if (clusterA !== clusterB) {
        return clusterA.localeCompare(clusterB, 'vi');
      }
      return (a.name || '').localeCompare(b.name || '', 'vi', { numeric: true, sensitivity: 'base' });
    });

    return formattedItems;
  });

  const isItemLoaded = (item: PackingItem) => {
    if (item.loaded) return true;
    if (item.loadedPklCode) return true;
    if (item.id && pklLists.some(p => p.packageIds?.includes(item.id!))) return true;
    return false;
  };

  const getItemLoadedBy = (item: PackingItem) => {
    if (item.loaded && item.loadedBy) return item.loadedBy;
    return undefined;
  };

  const getItemPklCode = (item: PackingItem): string | undefined => {
    if (item.loadedPklCode) return item.loadedPklCode;
    // Fallback: lookup từ pklLists cho items cũ chưa sync
    if (item.id) {
      const pkl = pklLists.find(p => p.packageIds?.includes(item.id!));
      if (pkl) return pkl.pklCode || pkl.id || '';
    }
    return undefined;
  };

  const getEntryTypeLocal = (moduleCode: string): 'Thùng' | 'Cánh' | 'Đợt' | 'Mặt HK' | 'CTHT' | 'Gia công ngoài' => {
    const matched = projectEntries?.find(e => e.moduleCode === moduleCode);
    if (matched?.classification) {
      return matched.classification as any;
    }
    return determineClassificationByName(moduleCode);
  };

  const determineClassificationByName = (mCode: string): 'Thùng' | 'Cánh' | 'Đợt' | 'Mặt HK' | 'CTHT' | 'Gia công ngoài' => {
    const lower = mCode.toLowerCase();
    if (lower.includes('len') || lower.includes('filler') || lower.includes('fillter') || lower.includes('thanh treo')) return 'Len, Filler' as any;
    if (lower.includes('gia công ngoài') || lower.includes('gia cong ngoai')) return 'Gia công ngoài';
    if (lower.includes('đợt di động') || lower.includes('dot di dong')) return 'Đợt di động' as any;
    if (lower.includes('mặt hoàn thiện') || lower.includes('mặt hoan thien') || lower.includes('mặt ht')) return 'CTHT';
    if (lower.includes('hoàn thiện') || lower.includes('hoan thien') || lower.includes('ctht') || lower.includes('tấm')) return 'CTHT';
    if (lower.includes('mặt học kéo') || lower.includes('mat hoc keo') || lower.includes('mặt hk')) return 'Mặt HK';
    if (lower.includes('mặt')) return 'Mặt HK';
    if (lower.includes('cánh') || lower.includes('cửa')) return 'Cánh';
    if (lower.includes('đợt')) return 'Đợt';
    const underscoreCount = (mCode.match(/_/g) || []).length;
    const dotCount = (mCode.match(/\./g) || []).length;
    if (underscoreCount >= 1 && dotCount >= 1) return 'Thùng';
    return 'Thùng';
  };

  const isCthtItem = (item: PackingItem) => {
    return item.subType === 'kienCTHT';
  };

  const isPhuKienItem = (item: PackingItem) => {
    return item.subType === 'kienPhuKien';
  };

  const sortedItems = useMemo(() => {
    const deduped = getDedupedItems(items);
    return deduped.map((item, index) => ({ item, originalIndex: index }));
  }, [items]);

  const [listTab, setListTab] = useState<'thung' | 'ctht' | 'pk' | 'tatca'>('tatca');

  const filteredItems = useMemo(() => {
    if (listTab === 'tatca') {
      return sortedItems;
    }
    if (listTab === 'ctht') {
      return sortedItems.filter(({ item }) => isCthtItem(item));
    }
    if (listTab === 'pk') {
      return sortedItems.filter(({ item }) => isPhuKienItem(item));
    }
    // Tab 'thung' — Kiện Module: KHÔNG phải CTHT, KHÔNG phải PK, tên không có 2 _ liên tiếp
    return sortedItems.filter(({ item }) => !isCthtItem(item) && !isPhuKienItem(item) && (item.name || '').split('_').length <= 2);
  }, [sortedItems, listTab]);

  // Tự động đồng bộ thông tin cấu kiện đã có trong đóng gói (KHÔNG thêm mới tự động)
  useEffect(() => {
    if (!packingList.projectCode || !projectEntries || projectEntries.length === 0) return;

    const projectModules = projectEntries.filter(e => e.projectCode === packingList.projectCode);

    let changed = false;

    // Đồng bộ thông tin cấu kiện đã có (tên, cụm, phụ kiện)
    let synced = items.map(item => {
      const matched = projectModules.find(e => e.id === item.id || (e.moduleCode || '').toLowerCase() === (item.name || '').toLowerCase());
      if (!matched) return item;
      const result = syncPackingItemWithProjectEntry(item, matched);
      if (JSON.stringify(result) !== JSON.stringify(item)) changed = true;
      return result;
    });

    if (!changed) return;

    setItems(synced);

    if (packingList.id) {
      updateDoc(doc(db, 'packing', packingList.id), {
        items: cleanUndefinedFields(synced)
      }).catch(err => handleFirestoreError(err, OperationType.UPDATE, 'packing'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectEntries, packingList.projectCode, packingList.id]);

  // Tự động tính kích thước & trọng lượng cho các kiện còn thiếu khi vừa mở đóng gói
  useEffect(() => {
    if (!items || items.length === 0) return;
    const hasMissing = items.some(i => !i.w || i.w === '0' || !i.d || i.d === '0' || !i.h || i.h === '0');
    if (!hasMissing) return;
    autoGenerateCTHTData(items);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [packingList.id]);

  // Tự động bổ sung rawQR cho các kiện còn thiếu
  useEffect(() => {
    if (!items || items.length === 0) return;
    const missingQR = items.some(i => !i.rawQR);
    if (!missingQR) return;
    const updated = items.map(i => i.rawQR ? i : { ...i, rawQR: computeRawQR(i) });
    setItems(updated);
    if (packingList.id) {
      updateDoc(doc(db, 'packing', packingList.id), {
        items: cleanUndefinedFields(updated)
      }).catch(err => handleFirestoreError(err, OperationType.UPDATE, 'packing'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [packingList.id]);

  const [title, setTitle] = useState(packingList.title);
  const [showExcelEditor, setShowExcelEditor] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showRawData, setShowRawData] = useState(false);
  const [showDeleteByDateModal, setShowDeleteByDateModal] = useState(false);
  const [deleteByDate, setDeleteByDate] = useState('');
  const [deleteByDateSelectedIds, setDeleteByDateSelectedIds] = useState<Set<string>>(new Set());

  // States cho tính năng In Tem Thùng
  const [showPrintLabelModal, setShowPrintLabelModal] = useState(false);
  const [printCopies, setPrintCopies] = useState<number>(1);
  const [labelProjectName, setLabelProjectName] = useState("");
  const [labelProjectCode, setLabelProjectCode] = useState("");
  const [labelSupplierName, setLabelSupplierName] = useState("EASY CABINET");
  const [printMultiUnit, setPrintMultiUnit] = useState(false);
  const [formTemplate, setFormTemplate] = useState<'mau1' | 'mau2' | 'mauBcons'>('mau1');
  const [bconsDept, setBconsDept] = useState('Kho thành phẩm - DRACO');
  const [bconsAddress, setBconsAddress] = useState('');
  const [bconsReceiver, setBconsReceiver] = useState('');
  const [bconsPhone, setBconsPhone] = useState('');
  const [qrUrls, setQrUrls] = useState<Record<string, string>>({});
  const [printItems, setPrintItems] = useState<Array<{
    tempId: string;
    originalId: string;
    originalName: string;
    name: string;
    projectName: string;
    unit: string;
    area: string;
    cabinetType: string;
    w: string;
    d: string;
    h: string;
    weight: string;
    selected: boolean;
    instanceIndex?: number;
    totalInstances?: number;
    hasSavedLabel?: boolean;
  }>>([]);

  // States & helper memos for label filtering
  const [labelFilterSearch, setLabelFilterSearch] = useState("");
  const [labelFilterUnit, setLabelFilterUnit] = useState("all");
  const [labelFilterArea, setLabelFilterArea] = useState("all");
  const [labelFilterType, setLabelFilterType] = useState("all");
  const [labelFilterSelected, setLabelFilterSelected] = useState<"all" | "selected" | "unselected">("all");

  const uniqueUnits = useMemo(() => {
    const units = printItems.map(item => (item.unit || "").trim()).filter(Boolean);
    return Array.from(new Set(units)).sort();
  }, [printItems]);

  const uniqueAreas = useMemo(() => {
    const areas = printItems.map(item => (item.area || "").trim()).filter(Boolean);
    return Array.from(new Set(areas)).sort();
  }, [printItems]);

  const uniqueTypes = useMemo(() => {
    const types = printItems.map(item => (item.cabinetType || "").trim()).filter(Boolean);
    return Array.from(new Set(types)).sort();
  }, [printItems]);

  const filteredPrintItems = useMemo(() => {
    return printItems.filter(item => {
      if (labelFilterSearch) {
        const search = labelFilterSearch.toLowerCase();
        const matchesName = (item.name || "").toLowerCase().includes(search);
        const matchesOrig = (item.originalName || "").toLowerCase().includes(search);
        const matchesProj = (item.projectName || "").toLowerCase().includes(search);
        if (!matchesName && !matchesOrig && !matchesProj) return false;
      }
      if (labelFilterUnit !== "all") {
        if ((item.unit || "").trim() !== labelFilterUnit) return false;
      }
      if (labelFilterArea !== "all") {
        if ((item.area || "").trim() !== labelFilterArea) return false;
      }
      if (labelFilterType !== "all") {
        if ((item.cabinetType || "").trim() !== labelFilterType) return false;
      }
      if (labelFilterSelected === "selected" && !item.selected) return false;
      if (labelFilterSelected === "unselected" && item.selected) return false;
      return true;
    });
  }, [printItems, labelFilterSearch, labelFilterUnit, labelFilterArea, labelFilterType, labelFilterSelected]);

  const [activeCheckingIdx, setActiveCheckingIdx] = useState<number | null>(null);
  const [printSentForIdx, setPrintSentForIdx] = useState<number | null>(null);
  const [showPrintQtyModal, setShowPrintQtyModal] = useState(false);
  const [loadingConfirmIdx, setLoadingConfirmIdx] = useState<number | null>(null);
  const [scanErrorMessage, setScanErrorMessage] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState('');
  const [searchTerm, setSearchTerm] = useState((selectedPackingId && selectedPackingId.length < 20) ? selectedPackingId : '');
  const [showQRScanner, setShowQRScanner] = useState(false);
  const [showQRPrintScanner, setShowQRPrintScanner] = useState(false);
  const [qrPrintConfirmItem, setQrPrintConfirmItem] = useState<{ name: string; item: PackingItem; instanceIndex?: number; totalInstances?: number } | null>(null);
  const [qrPrintCopies, setQrPrintCopies] = useState(4);
  const [checkingType, setCheckingType] = useState<'product' | 'packing' | null>(null);
  const [isAdminEditingItemCheck, setIsAdminEditingItemCheck] = useState(false);
  const [isEditingCthtDraft, setIsEditingCthtDraft] = useState(false);
  const [currentImageIdx, setCurrentImageIdx] = useState(0);
  const [lightboxImageIdx, setLightboxImageIdx] = useState<number | null>(null);

  // Tự động mở modal đóng gói cho instance được focus từ bên ngoài
  const autoOpenRef = useRef(false);
  useEffect(() => {
    if (autoOpenRef.current) return;
    if (!focusModuleName || !items || items.length === 0) return;

    let idx = -1;

    // Ưu tiên tìm theo instance index chính xác (ví dụ MOR026 #2/2)
    if (focusInstanceIndex != null) {
      idx = items.findIndex(item => {
        const nameLower = (item.name || '').toLowerCase().trim();
        const moduleLower = focusModuleName.toLowerCase().trim();
        // Match: tên chứa module code VÀ có đúng instance index
        if (!nameLower.includes(moduleLower)) return false;
        // Kiểm tra instance index từ tên: "#2/2"
        const match = (item.name || '').match(/#(\d+)\//);
        const itemInstIdx = match ? parseInt(match[1]) : undefined;
        return itemInstIdx === focusInstanceIndex;
      });
    }

    // Fallback: tìm theo tên nếu chưa match theo instance
    if (idx === -1) {
      const focusLower = focusModuleName.toLowerCase();
      idx = items.findIndex(item =>
        item.name?.toLowerCase().includes(focusLower) ||
        item.id?.toLowerCase().includes(focusLower) ||
        (item.rawQR && item.rawQR.toLowerCase().includes(focusLower))
      );
    }

    if (idx >= 0) {
      autoOpenRef.current = true;
      setActiveCheckingIdx(idx);
      setSearchTerm(focusModuleName);
      // Xóa focusModuleName ngay sau khi dùng để tránh mở lại khi mở phiếu khác
      if (clearFocusModuleName) clearFocusModuleName();
    }
  }, [focusModuleName, focusInstanceIndex, items]);

  // Xóa searchTerm khi tắt modal đóng gói
  useEffect(() => {
    if (activeCheckingIdx === null && searchTerm) {
      setSearchTerm('');
    }
  }, [activeCheckingIdx]);

  const activeItemIsCtht = useMemo(() => {
    if (activeCheckingIdx === null || !items || !items[activeCheckingIdx]) return false;
    const item = items[activeCheckingIdx];
    return item.subType === 'kienCTHT';
  }, [activeCheckingIdx, items]);

  useEffect(() => {
    setIsEditingCthtDraft(false);
  }, [activeCheckingIdx]);

  // States & helper hooks for Accessory and CTHT packing feature
  const [showPackAccessoryModal, setShowPackAccessoryModal] = useState(false);
  const [accessoryName, setAccessoryName] = useState("");
  const [selectedAccessoryQuantities, setSelectedAccessoryQuantities] = useState<Record<string, number>>({});
  const [modalAccessories, setModalAccessories] = useState<{ name: string; maxQty: number; isCustom?: boolean }[]>([]);
  const [isAddingNewAccessory, setIsAddingNewAccessory] = useState(false);
  const [newAccessoryName, setNewAccessoryName] = useState("");
  const [newAccessoryQty, setNewAccessoryQty] = useState(1);
  const [addingAccessoryLoading, setAddingAccessoryLoading] = useState(false);

  const [showPackCTHTModal, setShowPackCTHTModal] = useState(false);
  const [cthtKienName, setCthtKienName] = useState("");
  const [cthtItemsSelected, setCthtItemsSelected] = useState<Record<string, { id: string, name: string, moduleCode: string, selectedQty: number, maxQty: number, isCustom?: boolean }>>({});
  const [cthtQrScannerOpen, setCthtQrScannerOpen] = useState(false);
  const [customCthtName, setCustomCthtName] = useState("");
  const [customCthtQty, setCustomCthtQty] = useState(1);
  const [isAddingCustomCtht, setIsAddingCustomCtht] = useState(false);
  const [showCthtManualModal, setShowCthtManualModal] = useState(false);
  const [cthtManualSearch, setCthtManualSearch] = useState('');
  const [cthtManualCluster, setCthtManualCluster] = useState('');

  const [accessorySearchTerm, setAccessorySearchTerm] = useState("");
  const [cthtSearchTerm, setCthtSearchTerm] = useState("");
  const [cthtSearchType, setCthtSearchType] = useState<string>("all");

  // Khởi tạo thông tin 1 căn/nhiều căn và mẫu tem từ packingList đã lưu
  useEffect(() => {
    // KHÔNG sync khi modal in tem đang mở — tránh ghi đè dữ liệu người dùng đang chỉnh sửa
    if (packingList && !showPrintLabelModal) {
      if ((packingList as any).printMultiUnit !== undefined) {
        setPrintMultiUnit((packingList as any).printMultiUnit);
      }
      if ((packingList as any).formTemplate) {
        setFormTemplate((packingList as any).formTemplate);
      }
      if ((packingList as any).bconsDept) setBconsDept((packingList as any).bconsDept);
      if ((packingList as any).bconsAddress) setBconsAddress((packingList as any).bconsAddress);
      if ((packingList as any).bconsReceiver) setBconsReceiver((packingList as any).bconsReceiver);
      if ((packingList as any).bconsPhone) setBconsPhone((packingList as any).bconsPhone);
      if ((packingList as any).labelProjectName) setLabelProjectName((packingList as any).labelProjectName);
      if ((packingList as any).labelProjectCode) setLabelProjectCode((packingList as any).labelProjectCode);
      if ((packingList as any).labelSupplierName) setLabelSupplierName((packingList as any).labelSupplierName);
    }
  }, [packingList, showPrintLabelModal]);

  // Lưu chế độ 1 căn/nhiều căn vào Firestore
  const handleToggleMultiUnit = async () => {
    if (!packingList?.id) return;
    const newValue = !printMultiUnit;
    setPrintMultiUnit(newValue);
    try {
      await updateDoc(doc(db, 'packing', packingList.id), {
        printMultiUnit: newValue
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, 'packing');
    }
  };

  // Lưu mẫu form tem vào Firestore
  const handleToggleFormTemplate = async (template: 'mau1' | 'mau2' | 'mauBcons') => {
    if (!packingList?.id || template === formTemplate) return;
    setFormTemplate(template);
    try {
      await updateDoc(doc(db, 'packing', packingList.id), {
        formTemplate: template
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, 'packing');
    }
  };

  // Lưu thông tin Bcons vào Firestore
  const saveBconsFields = async (fields: { bconsDept?: string; bconsAddress?: string; bconsReceiver?: string; bconsPhone?: string }) => {
    if (!packingList?.id) return;
    try {
      await updateDoc(doc(db, 'packing', packingList.id), fields);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, 'packing');
    }
  };

  // Lưu thông tin label (project name, code, supplier) vào Firestore
  const saveLabelFields = async (fields: { labelProjectName?: string; labelProjectCode?: string; labelSupplierName?: string }) => {
    if (!packingList?.id) return;
    try {
      await updateDoc(doc(db, 'packing', packingList.id), fields);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, 'packing');
    }
  };

  const allProjectCTHTs = useMemo(() => {
    if (!projectEntries || !packingList.projectCode) return [];
    return projectEntries.filter(entry =>
      entry.projectCode === packingList.projectCode &&
      getEntryType(entry) === 'CTHT'
    );
  }, [projectEntries, packingList.projectCode]);

  const [scanningForCthtKienIdx, setScanningForCthtKienIdx] = useState<number | null>(null);
  const [addCthtManualIdx, setAddCthtManualIdx] = useState<number | null>(null);

  const handleQRScanForExistingCthtKien = (result: ScannedResult) => {
    if (scanningForCthtKienIdx === null) return;
    const finalCode = result.cthtPackageId
      ? (result.moduleCode || '').trim()
      : (result.moduleCode || '').split('|')[0].trim();

    const matched = projectEntries.find(e =>
      e.projectCode === packingList.projectCode &&
      getEntryType(e) === 'CTHT' &&
      ((e.moduleCode || '').toLowerCase() === finalCode.toLowerCase() ||
        e.id === result.matchedId ||
        (e.moduleCode || '').toLowerCase().includes(finalCode.toLowerCase()))
    );

    if (matched) {
      const next = [...items];
      const targetItem = next[scanningForCthtKienIdx];
      const accs = [...(targetItem.accessories || [])];

      const exIdx = accs.findIndex(a => (a.name || '').toLowerCase() === (matched.moduleCode || '').toLowerCase());
      if (exIdx >= 0) {
        accs[exIdx].quantity += 1;
      } else {
        accs.push({
          name: matched.moduleCode,
          quantity: 1,
          checked: false
        });
      }
      targetItem.accessories = accs;
      // Tính lại kích thước khi phụ kiện thay đổi
      const dims = calculateCTHTKienDimensions(accs);
      if (dims.w > 0) {
        targetItem.w = String(dims.w);
        targetItem.d = String(dims.d);
        targetItem.h = String(dims.h);
        targetItem.weight = dims.weight;
      }
      setItems(next);
      setScanningForCthtKienIdx(null);
    } else {
      alert(`Mã quét "${finalCode}" không khớp với chi tiết CTHT nào của dự án này!`);
    }
  };

  const handleAddCthtManual = (entry: any) => {
    if (addCthtManualIdx === null) return;
    const next = [...items];
    const targetItem = next[addCthtManualIdx];
    const accs = [...(targetItem.accessories || [])];

    const exIdx = accs.findIndex(a => (a.name || '').toLowerCase() === (entry.moduleCode || '').toLowerCase());
    if (exIdx >= 0) {
      accs[exIdx].quantity += 1;
    } else {
      accs.push({
        name: entry.moduleCode,
        quantity: 1,
        checked: false
      });
    }
    targetItem.accessories = accs;
    // Tính lại kích thước khi phụ kiện thay đổi
    const dims = calculateCTHTKienDimensions(accs);
    if (dims.w > 0) {
      targetItem.w = String(dims.w);
      targetItem.d = String(dims.d);
      targetItem.h = String(dims.h);
      targetItem.weight = dims.weight;
    }
    targetItem.accessories = accs;
    setItems(next);
    setAddCthtManualIdx(null);
  };

  // Lọc phụ kiện của dự án
  const projectAccs = useMemo(() => {
    if (!projectEntries || !packingList.projectCode) return [];
    const accMap: Record<string, { name: string, maxQty: number }> = {};
    projectEntries
      .filter(entry => entry.projectCode === packingList.projectCode)
      .forEach(entry => {
        (entry.accessories || []).forEach(acc => {
          const key = acc.name.trim();
          if (accMap[key]) {
            accMap[key].maxQty += (acc.quantity || 0);
          } else {
            accMap[key] = {
              name: key,
              maxQty: acc.quantity || 0
            };
          }
        });
      });
    return Object.values(accMap);
  }, [projectEntries, packingList.projectCode]);

  // Lọc phụ kiện của dự án còn lại (chưa đóng gói đủ)
  const unpackedAccessories = useMemo(() => {
    if (!projectEntries || !packingList.projectCode) return [];

    const accMap: Record<string, { name: string, maxQty: number }> = {};
    projectEntries
      .filter(entry => entry.projectCode === packingList.projectCode)
      .forEach(entry => {
        (entry.accessories || []).forEach(acc => {
          const key = acc.name.trim();
          if (accMap[key]) {
            accMap[key].maxQty += (acc.quantity || 0);
          } else {
            accMap[key] = {
              name: key,
              maxQty: acc.quantity || 0
            };
          }
        });
      });

    const packedMap: Record<string, number> = {};
    items.forEach(item => {
      if (item.accessories && item.accessories.length > 0) {
        item.accessories.forEach(acc => {
          const key = acc.name.trim();
          packedMap[key] = (packedMap[key] || 0) + (acc.quantity || 0);
        });
      }
    });

    return Object.values(accMap).map(acc => {
      const packedQty = packedMap[acc.name] || 0;
      const remainingQty = Math.max(0, acc.maxQty - packedQty);
      return {
        ...acc,
        remainingQty,
        totalQty: acc.maxQty
      };
    }).filter(acc => acc.remainingQty > 0);
  }, [projectEntries, packingList.projectCode, items]);

  // Lọc các CTHT của dự án
  const availableCTHTs = useMemo(() => {
    if (!projectEntries || !packingList.projectCode) return [];
    return projectEntries.filter(entry =>
      entry.projectCode === packingList.projectCode &&
      getEntryType(entry) === 'CTHT'
    );
  }, [projectEntries, packingList.projectCode]);

  // Lọc các CTHT / Len, Filler của dự án chưa được đóng gói đủ số lượng
  const unpackedCTHTs = useMemo(() => {
    if (!projectEntries || !packingList.projectCode) return [];

    const rawCTHTs = projectEntries.filter(entry => {
      if (entry.projectCode !== packingList.projectCode) return false;
      const t = getEntryType(entry);
      if (t === 'CTHT' || t === 'Len, Filler') return true;
      return false;
    });

    return rawCTHTs.map(entry => {
      let packedQty = 0;
      const entryCode = (entry.moduleCode || '').toLowerCase().trim();
      const entryId = entry.id || '';

      items.forEach(item => {
        if (item.accessories && item.accessories.length > 0) {
          item.accessories.forEach(acc => {
            // Ưu tiên match theo entryId (chính xác), fallback về moduleCode
            const accEntryId = (acc as any).entryId || '';
            const accName = (acc.name || '').toLowerCase().trim();
            if ((entryId && accEntryId === entryId) || (!accEntryId && accName === entryCode)) {
              packedQty += (acc.quantity || 0);
            }
          });
        }
      });

      const totalQty = entry.quantity || 1;
      const remainingQty = Math.max(0, totalQty - packedQty);

      return {
        ...entry,
        isPacked: remainingQty <= 0,
        packedQty,
        remainingQty
      };
    }).filter(entry => entry.remainingQty > 0);
  }, [projectEntries, packingList.projectCode, items]);


  const visibleCTHTs = useMemo(() => {
    const term = cthtSearchTerm.trim().toLowerCase();
    const hasSearch = term !== "";
    return unpackedCTHTs.filter(entry => {
      // Lọc theo loại (CTHT / Len, Filler / Tất cả)
      if (cthtSearchType !== "all") {
        const t = getEntryType(entry);
        if (t !== cthtSearchType) return false;
      }
      const isMatched = hasSearch && (entry.moduleCode || '').toLowerCase().includes(term);
      const isSelected = (cthtItemsSelected[entry.id]?.selectedQty || 0) > 0;
      return isMatched || isSelected;
    });
  }, [unpackedCTHTs, cthtSearchTerm, cthtSearchType, cthtItemsSelected]);

  useEffect(() => {
    if (showPackAccessoryModal) {
      const existingCount = items.filter(i => i.name.startsWith("Phụ Kiện Kèm Theo")).length;
      const defaultName = existingCount === 0
        ? "Phụ Kiện Kèm Theo"
        : `Phụ Kiện Kèm Theo ${existingCount + 1}`;
      setAccessoryName(defaultName);

      const copy = unpackedAccessories.map(acc => ({ name: acc.name, maxQty: acc.remainingQty }));
      setModalAccessories(copy);

      const initialQty: Record<string, number> = {};
      unpackedAccessories.forEach(acc => {
        initialQty[acc.name] = 0; // Mặc định chọn 0, người dùng tự lọc và tăng lên
      });
      setSelectedAccessoryQuantities(initialQty);

      // Reset custom accessory states & search query
      setAccessorySearchTerm("");
      setIsAddingNewAccessory(false);
      setNewAccessoryName("");
      setNewAccessoryQty(1);
    }
  }, [showPackAccessoryModal, unpackedAccessories]);

  // Chỉ reset cluster/search khi modal MOỞ MỚI (false → true), không reset khi items thay đổi
  useEffect(() => {
    if (showPackCTHTModal) {
      setCthtSearchTerm("");
      setCthtManualCluster("");
      setCustomCthtName("");
      setCustomCthtQty(1);
      setIsAddingCustomCtht(false);
    }
  }, [showPackCTHTModal]);

  // Cập nhật danh sách items selected khi modal đang mở và data thay đổi
  useEffect(() => {
    if (showPackCTHTModal) {
      setCthtKienName("FINISHED PANEL");

      const init: Record<string, { id: string, name: string, moduleCode: string, selectedQty: number, maxQty: number, isCustom?: boolean }> = {};
      unpackedCTHTs.forEach(entry => {
        init[entry.id] = {
          id: entry.id,
          name: entry.projectName || entry.moduleCode,
          moduleCode: entry.moduleCode,
          selectedQty: 0,
          maxQty: entry.remainingQty
        };
      });
      // Giữ lại các chi tiết ngoài dự án đã thêm (isCustom) khi danh sách project CTHT thay đổi
      setCthtItemsSelected(prev => {
        const customs = Object.values(prev).filter(i => i.isCustom);
        const next: Record<string, { id: string, name: string, moduleCode: string, selectedQty: number, maxQty: number, isCustom?: boolean }> = { ...init };
        customs.forEach(c => { next[c.id] = c; });
        return next;
      });
    }
  }, [showPackCTHTModal, items, unpackedCTHTs]);

  // Tính kích thước aggregate cho kiện FINISHED PANEL từ tất cả chi tiết con
  // Công thức: W = max(pWidth/width/length) + 50, D = max(pDepth/depth) + 50, H = totalPlates * 20 + 50
  const calculateCTHTKienDimensions = (accessories: { name: string; quantity: number }[]): { w: number; d: number; h: number; weight: number } => {
    if (!accessories || accessories.length === 0) return { w: 0, d: 0, h: 0, weight: 0 };
    let wMax = 0;
    let dMax = 0;
    let totalPlates = 0;

    for (const acc of accessories) {
      const n = String(acc.name || '').toLowerCase();
      if (n.includes('hút ẩm') || n.includes('hut am')) continue;
      const entry = projectEntries.find(e => (e.moduleCode || '').trim().toLowerCase() === (acc.name || '').trim().toLowerCase() && e.projectCode === packingList.projectCode);
      if (entry) {
        const wVal = parseFloat(String(entry.pWidth || entry.width || entry.length || 0)) || 0;
        const dVal = parseFloat(String(entry.pDepth || entry.depth || 0)) || 0;
        if (wVal > wMax) wMax = wVal;
        if (dVal > dMax) dMax = dVal;
        totalPlates += (acc.quantity || 1);
      }
    }

    if (totalPlates === 0) return { w: 0, d: 0, h: 0, weight: 0 };
    const w = Math.round(wMax) + 50;
    const d = Math.round(dMax) + 50;
    const h = totalPlates * 20 + 50;
    const weight = parseFloat(calculateCabinetWeight(String(w), String(d), String(h))) || 0;
    return { w, d, h, weight };
  };

  // Áp dụng kích thước CTHT vào một item
  const applyCTHTDimensions = (item: PackingItem): PackingItem => {
    const isCthtKien = item.subType === 'kienCTHT';
    if (!isCthtKien || !item.accessories || item.accessories.length === 0) return item;
    const dims = calculateCTHTKienDimensions(item.accessories);
    if (dims.w <= 0) return item;
    return { ...item, w: String(dims.w), d: String(dims.d), h: String(dims.h), weight: dims.weight };
  };

  // Hàm bóc tách thông tin từ tên kiện gỗ
  const parseItemDimensionsAndInfo = (name: string) => {
    const n = name || '';
    let w = "0";
    let d = "0";
    let h = "0";
    let unit = "BLDG1";
    let area = "KITCHEN";
    let cabinetType = "";

    // 1. Thử bóc tách W, D, H
    // Định dạng phổ biến: W827 D660 H507 hoặc W827-D660-H507 hoặc W827*D660*H507
    const rPrefix = /W\s*(\d+)\s*D\s*(\d+)\s*H\s*(\d+)/i;
    const matchPrefix = n.match(rPrefix);
    if (matchPrefix) {
      w = matchPrefix[1];
      d = matchPrefix[2];
      h = matchPrefix[3];
    } else {
      // Định dạng: 827x660x507 hoặc 827*660*507 hoặc 827 x 660 x 507
      const rCross = /(\d+)\s*[xX*]\s*(\d+)\s*[xX*]\s*(\d+)/;
      const matchCross = n.match(rCross);
      if (matchCross) {
        w = matchCross[1];
        d = matchCross[2];
        h = matchCross[3];
      }
    }

    // 2. Bóc tách CABINET TYPE: split(".") và lấy đoạn sau
    const dotParts = n.split('.');
    if (dotParts.length > 1) {
      cabinetType = dotParts.slice(1).join('.').trim().toUpperCase();
      // Chuyển #X/Y thành (X/Y): ví dụ T1 #2/3 → T1 (2/3)
      cabinetType = cabinetType.replace(/#(\d+\/\d+)/g, '($1)');
    }

    // 3. Thử bóc tách AREA (Định dạng lại các mã quy chuẩn: COT -> COAT, KIT -> KITCHEN, vv. hoặc KITCHEN, BEDROOM...)
    const upperName = n.toUpperCase();
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
      matchedArea = "ISLAN";
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
      const matchArea = n.match(rArea);
      if (matchArea) {
        let areaVal = matchArea[1].toUpperCase();
        if (areaVal === 'BẾP') areaVal = 'KITCHEN';
        if (areaVal === 'NGỦ' || areaVal === 'LPN' || areaVal === 'PN') areaVal = 'BEDROOM';
        if (areaVal === 'KHÁCH' || areaVal === 'PK' || areaVal === 'LIVING') areaVal = 'LIVINGROOM';
        area = areaVal;
      }
    }

    // 4. Thử bóc tách UNIT (Mã tầng hoặc tòa nhà: BLDG1, L01, L1, P101, TẦNG 1...)
    // Không dùng ranh giới từ \b để tự do trích xuất "BLDG1" ra khỏi "MED026_BLDG1"
    const rUnit = /(BLDG\s*\d+|APARTMENT\s*\d+|ROOM\s*\d+|P\d{3}|L\d+|T\d+|BẦU|TẦNG\s*\d+)/i;
    const matchUnit = n.match(rUnit);
    if (matchUnit) {
      unit = matchUnit[1].toUpperCase().replace(/\s+/g, '');
    }

    return { w, d, h, unit, area, cabinetType };
  };

  const extractSubProjectCode = (projectCode: string): string => {
    if (!projectCode) return "";
    const clean = projectCode.trim();
    const parts = clean.split('_');
    let code = "";
    if (parts.length > 1) {
      code = parts[1].toUpperCase();
    } else {
      code = clean.toUpperCase();
    }
    // Chuyển đổi ELMB thành BLDG (Ví dụ: ELMB1 -> BLDG1)
    if (code.includes('ELMB')) {
      code = code.replace(/ELMB/g, 'BLDG');
    }
    return code;
  };

  // Thêm bộ chuyển đổi area thông minh cho các mã quy định
  const formatAreaName = (areaStr: string): string => {
    const aUpper = (areaStr || "").toUpperCase().trim();
    if (aUpper === 'COT') return 'COAT';
    if (aUpper === 'KIT') return 'KITCHEN';
    if (aUpper === 'ISL') return 'ISLAND';
    if (aUpper === 'LVR') return 'LIVING ROOM';
    if (aUpper === 'POWD') return 'POWDER ROOM';
    if (aUpper === 'BAT1') return 'BATH 1';
    if (aUpper === 'PRI') return 'PRIME VANITY';
    if (aUpper === 'LRB') return 'LR BAR';
    if (aUpper === 'ENP') return 'ENTRY PROFILE';
    if (aUpper === 'PRIB') return 'PRIME BATH';
    if (aUpper === 'BAT2') return 'BATH 2';
    return areaStr;
  };

  const autoGenerateCTHTData = async (currentItems: PackingItem[]): Promise<PackingItem[]> => {
    let changed = false;
    const isZeroOrEmpty = (val: any): boolean => {
      if (val === undefined || val === null) return true;
      const str = val.toString().trim();
      return str === "" || str === "0" || str === "0.0";
    };

    const nextItems = currentItems.map(item => {
      const itemName = item.name || '';
      const isCthtKien = item.subType === 'kienCTHT';
      const isCtht = isCthtItem(item) || isCthtKien;

      let updatedW = item.w;
      let updatedD = item.d;
      let updatedH = item.h;
      let updatedWeight = item.weight;

      const matchedEntry = projectEntries ? projectEntries.find(e => {
        const cleanModuleCode = (e.moduleCode || '').trim().toLowerCase();
        const cleanItemName = (item.name || '').trim().toLowerCase();
        return e.id === item.id ||
          cleanModuleCode === cleanItemName ||
          cleanItemName.includes(cleanModuleCode) ||
          cleanModuleCode.includes(cleanItemName);
      }) : undefined;

      const parsed = parseItemDimensionsAndInfo(item.name);
      let defaultW = parsed.w || "0";
      let defaultD = parsed.d || "0";
      let defaultH = parsed.h || "0";

      // Đồng bộ thông tin thông minh cho các kiện FINISHED PANEL dựa trên TẤT CẢ chi tiết con
      if (isCthtKien && item.accessories && item.accessories.length > 0) {
        const dims = calculateCTHTKienDimensions(item.accessories);
        if (dims.w > 0) {
          defaultW = String(dims.w);
          defaultD = String(dims.d);
          defaultH = String(dims.h);
        }
      }

      // Tự động điền kích thước cho kiện CTHT hoặc khi kích thước bất kỳ kiện nào bằng 0
      if (isCtht || isZeroOrEmpty(item.w) || isZeroOrEmpty(item.d) || isZeroOrEmpty(item.h)) {
        const candidateW = isZeroOrEmpty(item.w) ? (matchedEntry ? (matchedEntry.pWidth || matchedEntry.width || matchedEntry.length || defaultW) : defaultW) : item.w;
        const candidateD = isZeroOrEmpty(item.d) ? (matchedEntry ? (matchedEntry.pDepth || matchedEntry.depth || defaultD) : defaultD) : item.d;
        const candidateH = isZeroOrEmpty(item.h) ? (matchedEntry ? (matchedEntry.pHeight || matchedEntry.height || defaultH) : defaultH) : item.h;

        const finalW = candidateW ? candidateW.toString() : "0";
        const finalD = candidateD ? candidateD.toString() : "0";
        const finalH = candidateH ? candidateH.toString() : "0";

        if (item.w !== finalW || item.d !== finalD || item.h !== finalH) {
          updatedW = finalW;
          updatedD = finalD;
          updatedH = finalH;
          changed = true;
        }
      }

      // Tự động điền Trọng lượng nếu chưa có hoặc bằng 0 cho tất cả các kiện
      const currentW = updatedW || "0";
      const currentD = updatedD || "0";
      const currentH = updatedH || "0";

      if (isZeroOrEmpty(updatedWeight)) {
        const calcW = parseFloat(currentW) > 0 && parseFloat(currentD) > 0 && parseFloat(currentH) > 0
          ? parseFloat(calculateCabinetWeight(currentW, currentD, currentH))
          : 0;

        if (calcW > 0) {
          updatedWeight = calcW;
          changed = true;
        }
      }

      return {
        ...item,
        w: updatedW,
        d: updatedD,
        h: updatedH,
        weight: updatedWeight
      };
    });

    if (changed) {
      setItems(nextItems);
      if (packingList.id) {
        try {
          await updateDoc(doc(db, 'packing', packingList.id), {
            items: cleanUndefinedFields(nextItems)
          });
        } catch (e) {
          console.error("Lỗi tự động lưu kích thước và trọng lượng:", e);
        }
      }
    }
    return nextItems;
  };

  // Mở modal in tem thùng, nạp dữ liệu bóc tách sẵn
  const handleOpenPrintModal = async (customItems?: PackingItem[]) => {
    // Resolve projectCode từ projectEntries (field bên trong document) thay vì dùng document ID
    const resolvedProjectCode = projectEntries?.find(e => e.projectCode && (
      e.projectCode === packingList.projectCode ||
      packingList.items?.some(i => i.id === e.id || i.name === e.moduleCode)
    ))?.projectCode || packingList.projectCode || '';

    const defaultProj = formatProjectCode(resolvedProjectCode) || packingList.title || "";
    // Tên dự án của phiếu đóng gói — mặc định cho cột Dự Án (Project) của mọi kiện trong modal in tem
    const slipProjectName = resolveSlipProjectName(projectEntries, resolvedProjectCode, packingList, defaultProj);
    setLabelProjectName(slipProjectName);
    setLabelProjectCode((packingList as any).labelProjectCode || resolvedProjectCode);
    setLabelSupplierName((packingList as any).labelSupplierName || "EASY CABINET");

    const subProjCode = extractSubProjectCode(resolvedProjectCode);
    const mapped: any[] = [];

    const activeItems = customItems || items;

    activeItems.forEach((item, idx) => {
      const isCthtKien = item.subType === 'kienCTHT';

      // Thử tìm khớp cấu kiện trong projectEntries để lấy kích thước đóng gói chuẩn
      // (chỉ khớp trong cùng dự án của phiếu — tránh lấy nhầm tên dự án khác khi trùng tên module)
      const matchedEntry = projectEntries ? projectEntries.find(e => {
        if (resolvedProjectCode && e.projectCode && e.projectCode !== resolvedProjectCode) return false;
        const cleanModuleCode = (e.moduleCode || '').trim().toLowerCase();
        const cleanItemName = (item.name || '').trim().toLowerCase();
        return e.id === item.id ||
          cleanModuleCode === cleanItemName ||
          cleanItemName.includes(cleanModuleCode) ||
          cleanModuleCode.includes(cleanItemName);
      }) : undefined;

      // 1. Xác định tên dự án: mặc định theo dự án của phiếu đóng gói (packingList),
      //    chỉ dùng dữ liệu đã lưu/item khi phiếu không có thông tin dự án
      const pName = slipProjectName || item.projectName || "";

      let parsed = parseItemDimensionsAndInfo(item.name);

      let defaultW = parsed.w;
      let defaultD = parsed.d;
      let defaultH = parsed.h;
      let defaultUnit = parsed.unit;
      let defaultArea = parsed.area;

      // Đồng bộ thông tin thông minh cho các kiện FINISHED PANEL dựa trên TẤT CẢ chi tiết con
      if (isCthtKien && item.accessories && item.accessories.length > 0) {
        const dims = calculateCTHTKienDimensions(item.accessories);
        if (dims.w > 0) {
          defaultW = String(dims.w);
          defaultD = String(dims.d);
          defaultH = String(dims.h);
        }
        // Lấy unit/area từ chi tiết con đầu tiên
        for (const detail of item.accessories) {
          const n = String(detail.name || '').toLowerCase();
          if (n.includes('hút ẩm') || n.includes('hut am')) continue;
          const detailEntry = projectEntries ? projectEntries.find(e => (e.moduleCode || '').trim().toLowerCase() === (detail.name || '').trim().toLowerCase() && e.projectCode === resolvedProjectCode) : undefined;
          if (detailEntry) {
            const detailParsed = parseItemDimensionsAndInfo(detailEntry.moduleCode);
            defaultUnit = detailParsed.unit || defaultUnit;
            defaultArea = detailEntry.cluster || detailParsed.area || defaultArea;
            break;
          }
        }
      }

      const isZeroOrEmpty = (val: any): boolean => {
        if (val === undefined || val === null) return true;
        const str = val.toString().trim();
        return str === "" || str === "0" || str === "0.0";
      };

      // Xác định 2. kích thước chuẩn: Ưu tiên kích thước đóng gói (pWidth/pDepth/pHeight), tiếp đến mới là kích thước mộc (width/depth/height/length) và đảm bảo không để trống
      let w = !isZeroOrEmpty(item.w) ? item.w : (matchedEntry ? (matchedEntry.pWidth || matchedEntry.width || matchedEntry.length || defaultW) : defaultW);
      let d = !isZeroOrEmpty(item.d) ? item.d : (matchedEntry ? (matchedEntry.pDepth || matchedEntry.depth || defaultD) : defaultD);
      let h = !isZeroOrEmpty(item.h) ? item.h : (matchedEntry ? (matchedEntry.pHeight || matchedEntry.height || defaultH) : defaultH);

      w = w ? w.toString() : "0";
      d = d ? d.toString() : "0";
      h = h ? h.toString() : "0";

      // Xác định tên hiển thị tại TYPE — khớp với handlePrintLabel
      const itemNameClean = (item.name || '').trim();
      const finalCabinetType = isCthtKien
        ? itemNameClean.toUpperCase()
        : (parsed.cabinetType || subProjCode || '-');

      const matchedParsed = matchedEntry ? parseItemDimensionsAndInfo(matchedEntry.moduleCode) : null;

      const qty = item.quantity || 1;
      const initialWeight = calculateCabinetWeight(w, d, h);
      const saved = (item as any).savedLabelData as { projectName?: string; unit?: string; area?: string; cabinetType?: string; w?: string; d?: string; h?: string; weight?: string } | undefined;
      for (let k = 0; k < qty; k++) {
        const effectiveInstanceIndex = item.instanceIndex || (qty > 1 ? k + 1 : undefined);
        const effectiveTotalInstances = item.totalInstances || (qty > 1 ? qty : undefined);
        const instanceLabel = effectiveInstanceIndex && effectiveTotalInstances && effectiveTotalInstances > 1 && !finalCabinetType.includes(`(${effectiveInstanceIndex}/${effectiveTotalInstances})`)
          ? ` (${effectiveInstanceIndex}/${effectiveTotalInstances})`
          : (qty > 1 && !finalCabinetType.includes(`(${k + 1}/${qty})`) ? ` (${k + 1}/${qty})` : '');
        const autoCabinetType = finalCabinetType + instanceLabel;
        const autoWeight = !isZeroOrEmpty(item.weight) ? item.weight.toString() : (initialWeight !== "0" ? initialWeight : "0");

        // Ưu tiên savedLabelData cho unit/area/type, nhưng kích thước luôn lấy từ item (đã sync từ project)
        const finalUnit = saved?.unit || subProjCode || matchedParsed?.unit || defaultUnit || "-";
        const finalArea = saved?.area || formatAreaName(item.cluster || matchedEntry?.cluster || matchedParsed?.area || defaultArea || "-");
        const finalCabinType = saved?.cabinetType || autoCabinetType;
        const finalW = w;
        const finalD = d;
        const finalH = h;
        // Ưu tiên item.weight (đã lưu trong Firestore, chính xác nhất), sau đó mới saved/auto
        const finalWeight = !isZeroOrEmpty(item.weight) ? String(item.weight) : (saved?.weight || autoWeight);
        const finalProjectName = slipProjectName || saved?.projectName || pName;

        mapped.push({
          tempId: `${item.id || 'print'}-${idx}-${k}-${Date.now()}`,
          originalId: item.id || '',
          originalName: item.name,
          name: item.name,
          subType: item.subType,
          projectName: finalProjectName,
          unit: finalUnit,
          area: finalArea,
          cabinetType: finalCabinType,
          w: finalW,
          d: finalD,
          h: finalH,
          weight: finalWeight,
          selected: true,
          instanceIndex: effectiveInstanceIndex,
          totalInstances: effectiveTotalInstances,
          hasSavedLabel: !!saved,
        });
      }
    });

    setPrintItems(mapped);

    // Tạo mã QR Code song song — khớp logic với handlePrintLabel
    const urls: Record<string, string> = {};
    for (const item of mapped) {
      const isCthtKien = item.subType === 'kienCTHT';
      const baseCodeForQR = item.name.includes('#') ? item.name.split('#')[0].trim() : item.name;
      const instanceSuffix = item.totalInstances && item.totalInstances > 1 && item.instanceIndex ? `|${item.instanceIndex}` : '';
      const text = isCthtKien && item.originalId
        ? `${item.originalId}|${item.name}----EASYCABINET----`
        : `${baseCodeForQR}${instanceSuffix}----EASYCABINET----`;
      try {
        const url = await QRCode.toDataURL(text, {
          margin: 1,
          width: 150,
          color: {
            dark: '#000000',
            light: '#ffffff'
          }
        });
        urls[item.tempId] = url;
      } catch (err) {
        console.error("QR Code Generation Error:", err);
      }
    }
    setQrUrls(urls);
    setShowPrintLabelModal(true);
  };

  // Cập nhật lại mã QR Code cho một item cụ thể khi người dùng thay đổi tên kiện gỗ
  const updateSingleQR = async (tempId: string, nameValue: string) => {
    const targetItem = printItems.find(p => p.tempId === tempId);
    const isCthtKien = targetItem && (targetItem as any).subType === 'kienCTHT';
    const baseCodeForQR = nameValue.includes('#') ? nameValue.split('#')[0].trim() : nameValue;
    const instanceSuffix = targetItem && targetItem.totalInstances && targetItem.totalInstances > 1 && targetItem.instanceIndex ? `|${targetItem.instanceIndex}` : '';
    const text = isCthtKien && targetItem?.originalId
      ? `${targetItem.originalId}|${nameValue}----EASYCABINET----`
      : `${baseCodeForQR}${instanceSuffix}----EASYCABINET----`;
    try {
      const url = await QRCode.toDataURL(text, {
        margin: 1,
        width: 150,
        color: {
          dark: '#000000',
          light: '#ffffff'
        }
      });
      setQrUrls(prev => ({
        ...prev,
        [tempId]: url
      }));
    } catch (err) {
      console.error(err);
    }
  };

  const handleCreateAccessoryKien = async () => {
    const kName = accessoryName.trim() || "Phụ Kiện Kèm Theo";
    const currentAccNames = new Set(modalAccessories.map(a => a.name));
    const chosenAccs = Object.entries(selectedAccessoryQuantities)
      .filter(([name, qty]) => currentAccNames.has(name) && qty > 0)
      .map(([name, qty]) => ({ name, quantity: qty, checked: false }));

    if (chosenAccs.length === 0) {
      alert("Vui lòng chọn ít nhất một phụ kiện với số lượng lớn hơn 0!");
      return;
    }

    const newKien: PackingItem = {
      id: 'acc-' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
      name: kName,
      quantity: 1,
      packed: false,
      subType: 'kienPhuKien',
      cluster: 'Phụ kiện kèm theo',
      isExtra: true,
      accessories: chosenAccs,
      createdAt: Date.now(),
    };

    const nextItems = [...items, newKien];
    setItems(nextItems);
    setShowPackAccessoryModal(false);

    setLoading(true);
    try {
      const allPacked = nextItems.every(i => i.packed);
      await updateDoc(doc(db, 'packing', packingList.id), {
        items: cleanUndefinedFields(nextItems),
        isCompleted: allPacked
      });
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleAddNewAccessory = async () => {
    const cleanName = newAccessoryName.trim().toUpperCase();
    if (!cleanName) {
      alert("Vui lòng nhập tên phụ kiện!");
      return;
    }

    if (newAccessoryQty <= 0) {
      alert("Số lượng phải lớn hơn 0!");
      return;
    }

    if (modalAccessories.some(a => a.name === cleanName)) {
      alert("Phụ kiện này đã tồn tại trong danh sách!");
      return;
    }

    setAddingAccessoryLoading(true);
    try {
      if (user && packingList.projectCode) {
        const pName = (projectEntries || []).find(e => e.projectCode === packingList.projectCode)?.projectName || packingList.projectCode;
        const newAccessoryDoc = {
          projectName: pName,
          projectCode: packingList.projectCode,
          moduleCode: `PK-${cleanName}`,
          name: cleanName,
          classification: 'Phụ kiện' as any,
          quantity: 1,
          accessories: [{
            name: cleanName,
            quantity: newAccessoryQty,
            issuedQuantity: 0,
            status: 'Đóng gói thêm'
          }],
          createdAt: serverTimestamp(),
          ownerId: user.uid
        };

        await addDoc(collection(db, 'projectConfigs', packingList.projectCode, 'modules'), newAccessoryDoc);

        const configId = await findProjectConfigId(packingList.projectCode);
        if (configId) {
          await addProjectModule(configId, newAccessoryDoc);
        }

        await addDoc(collection(db, 'activities'), {
          userId: user.uid,
          userName: user.displayName || 'Anonymous',
          userEmail: user.email,
          action: 'Thêm phụ kiện đóng gói thêm',
          details: `Đóng gói thêm phụ kiện ${cleanName} (Số lượng: ${newAccessoryQty}) vào dự án ${packingList.projectCode}`,
          projectCode: packingList.projectCode,
          timestamp: serverTimestamp()
        });
      }

      setModalAccessories(prev => [...prev, { name: cleanName, maxQty: newAccessoryQty, isCustom: true }]);
      setSelectedAccessoryQuantities(prev => ({
        ...prev,
        [cleanName]: newAccessoryQty
      }));

      setNewAccessoryName("");
      setNewAccessoryQty(1);
      setIsAddingNewAccessory(false);
    } catch (err: any) {
      console.error(err);
      alert("Lỗi khi thêm phụ kiện dự án: " + err.message);
    } finally {
      setAddingAccessoryLoading(false);
    }
  };

  const handleDeleteModalAccessory = (accName: string) => {
    setModalAccessories(prev => prev.filter(a => a.name !== accName));
    setSelectedAccessoryQuantities(prev => {
      const copy = { ...prev };
      delete copy[accName];
      return copy;
    });
  };

  // Danh sách chi tiết hoàn thiện ngoài dự án đã thêm vào kiện
  const customCthtList = useMemo(() => Object.values(cthtItemsSelected).filter(i => i.isCustom), [cthtItemsSelected]);

  const handleAddCustomCtht = () => {
    const name = customCthtName.trim();
    if (!name) {
      alert("Vui lòng nhập tên chi tiết hoàn thiện!");
      return;
    }
    const qty = Math.max(1, customCthtQty || 1);
    const nameKey = name.toLowerCase();
    setCthtItemsSelected(prev => {
      // Gộp nếu đã có chi tiết cùng tên (tránh trùng dòng gây nhầm số lượng)
      const existingId = Object.keys(prev).find(k => prev[k].isCustom && (prev[k].moduleCode || '').toLowerCase() === nameKey);
      if (existingId) {
        const existing = prev[existingId];
        return {
          ...prev,
          [existingId]: {
            ...existing,
            selectedQty: Math.min(999, existing.selectedQty + qty),
            maxQty: Math.min(999, existing.maxQty + qty)
          }
        };
      }
      const customId = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      return {
        ...prev,
        [customId]: {
          id: customId,
          name,
          moduleCode: name,
          selectedQty: qty,
          maxQty: qty,
          isCustom: true
        }
      };
    });
    setCustomCthtName("");
    setCustomCthtQty(1);
  };

  const handleRemoveCustomCtht = (id: string) => {
    setCthtItemsSelected(prev => {
      const copy = { ...prev };
      delete copy[id];
      return copy;
    });
  };

  const handleAdjustCustomCthtQty = (id: string, delta: number) => {
    setCthtItemsSelected(prev => {
      const current = prev[id];
      if (!current) return prev;
      const nextQty = Math.max(1, Math.min(999, current.selectedQty + delta));
      return { ...prev, [id]: { ...current, selectedQty: nextQty } };
    });
  };

  const handleCreateCthtKien = async () => {
    const kName = cthtKienName.trim() || "FINISHED PANEL";
    const selectedList = Object.values(cthtItemsSelected).filter(item => item.selectedQty > 0);
    if (selectedList.length === 0) {
      alert("Vui lòng quét hoặc chọn tăng số lượng cho ít nhất 1 chi tiết CTHT để đóng gói!");
      return;
    }

    const rawAccessories = selectedList.map(item => {
      const entry = unpackedCTHTs.find(e => e.id === item.id) || unpackedCTHTs.find(e => e.moduleCode === item.moduleCode);
      const insts = entry ? getModuleInstances(entry) : [];
      const firstInst = insts.length > 0 ? insts[0] : null;
      return {
        name: item.moduleCode,
        quantity: item.selectedQty,
        checked: false,
        entryId: item.id,
        tempLabelIndex: firstInst?.tempLabelIndex
      };
    });

    const dims = calculateCTHTKienDimensions(rawAccessories);

    // Tính cluster của kiện mới
    const newCluster = (() => {
      const clusters = [...new Set(
        selectedList
          .map(s => unpackedCTHTs.find(e => e.id === s.id))
          .filter(Boolean)
          .map(e => (e!.cluster || '').trim())
          .filter(Boolean)
      )];
      return clusters.length > 0 ? clusters.join(' + ') : 'Chi tiết hỗ trợ';
    })();

    // Kiểm tra trùng tên + cụm, nếu có thì tự động thêm số đếm
    let finalName = kName;
    const sameNameAndCluster = items.filter(i =>
      i.name === kName && i.cluster === newCluster
    );
    if (sameNameAndCluster.length > 0) {
      finalName = `${kName} ${sameNameAndCluster.length}`;
    }

    const newKien: PackingItem = {
      id: 'ctht-' + Date.now(),
      name: finalName,
      quantity: 1,
      packed: false,
      packStatus: 'pending',
      subType: 'kienCTHT',
      cluster: newCluster,
      isExtra: true,
      w: String(dims.w),
      d: String(dims.d),
      h: String(dims.h),
      weight: dims.weight,
      accessories: rawAccessories,
      createdAt: Date.now(),
    };

    const nextItems = [...items, newKien];
    setItems(nextItems);
    setShowPackCTHTModal(false);

    setLoading(true);
    try {
      const allPacked = nextItems.every(i => i.packed);
      await updateDoc(doc(db, 'packing', packingList.id), {
        items: cleanUndefinedFields(nextItems),
        isCompleted: allPacked
      });
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleCthtQRScan = (result: ScannedResult) => {
    const finalCode = result.cthtPackageId
      ? (result.moduleCode || '').trim()
      : (result.moduleCode || '').split('|')[0].trim();

    // Tìm kiếm trong toàn bộ CTHT của dự án
    const matched = projectEntries.find(e =>
      e.projectCode === packingList.projectCode &&
      getEntryType(e) === 'CTHT' &&
      ((e.moduleCode || '').toLowerCase() === finalCode.toLowerCase() ||
        e.id === result.matchedId ||
        (e.moduleCode || '').toLowerCase().includes(finalCode.toLowerCase()))
    );

    if (matched) {
      setCthtItemsSelected(prev => {
        const current = prev[matched.id];
        if (current) {
          const nextQty = Math.min(current.maxQty, current.selectedQty + 1);
          return {
            ...prev,
            [matched.id]: {
              ...current,
              selectedQty: nextQty
            }
          };
        } else {
          // Thêm mới cấu kiện này vào danh sách lựa chọn nếu chưa tồn tại
          return {
            ...prev,
            [matched.id]: {
              id: matched.id,
              name: matched.projectName || matched.moduleCode,
              moduleCode: matched.moduleCode,
              selectedQty: 1,
              maxQty: matched.quantity || 1
            }
          };
        }
      });
      setCthtQrScannerOpen(false);
    } else {
      alert(`Mã quét "${finalCode}" không khớp với chi tiết CTHT nào của dự án này!`);
    }
  };

  const cameraInputRef = React.useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (checkingType && cameraInputRef.current) {
      cameraInputRef.current.click();
    }
  }, [checkingType]);

  useEffect(() => {
    const handleSave = () => updateList();
    const handleDelete = () => setShowDeleteConfirm(true);

    window.addEventListener('packing-save', handleSave);
    window.addEventListener('packing-delete', handleDelete);

    return () => {
      window.removeEventListener('packing-save', handleSave);
      window.removeEventListener('packing-delete', handleDelete);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, title]);

  const updateList = async () => {
    if (!user || !packingList.id) return;
    setLoading(true);
    try {
      const displayLabel = userProfile?.ten_that ? `${userProfile.ten_that} (${userProfile.chuc_danh || 'NV'})` : (user?.displayName || 'Anonymous');
      const allPacked = items.every(i => i.packed);
      await updateDoc(doc(db, 'packing', packingList.id), {
        title,
        items: cleanUndefinedFields(items),
        isCompleted: allPacked
      });

      await addDoc(collection(db, 'activities'), {
        userId: user.uid,
        userName: displayLabel,
        userEmail: user.email,
        action: 'Cập nhật Packing List',
        details: `Cập nhật: ${title}${allPacked ? ' (Hoàn thành)' : ''}`,
        projectCode: packingList.projectCode || '',
        timestamp: serverTimestamp()
      });

    } catch (error: any) {
      handleFirestoreError(error, OperationType.UPDATE, 'packing');
    } finally {
      setLoading(false);
    }
  };

  const deleteList = async () => {
    if (!user || !packingList.id) return;
    setLoading(true);
    try {
      await deleteDoc(doc(db, 'packing', packingList.id));

      await addDoc(collection(db, 'activities'), {
        userId: user.uid,
        userName: user.displayName || 'Anonymous',
        userEmail: user.email,
        action: 'Xoá Packing List',
        details: `Xoá: ${packingList.title}`,
        projectCode: packingList.projectCode || '',
        timestamp: serverTimestamp()
      });

      onBack();
    } catch (error: any) {
      handleFirestoreError(error, OperationType.DELETE, 'packing');
    } finally {
      setLoading(false);
    }
  };

  const [showSyncModal, setShowSyncModal] = useState(false);

  const handleSyncPackingList = async () => {
    if (!user || !packingList.id || !packingList.projectCode) return;

    setLoading(true);
    try {
      const displayLabel = userProfile?.ten_that ? `${userProfile.ten_that} (${userProfile.chuc_danh || 'NV'})` : (user?.displayName || 'Anonymous');
      const projectModules = projectEntries.filter(e => e.projectCode === packingList.projectCode);

      // 1. Update kích thước cho items đã có
      let syncedCount = 0;
      let addedCount = 0;
      const currentNames = new Set(items.map(i => (i.name || '').toLowerCase().trim()));
      const updatedItems = [...items];

      // Sync dimensions cho items hiện tại
      const syncedItems = updatedItems.map(item => {
        const matched = projectModules.find(e => e.id === item.id || (e.moduleCode || '').toLowerCase() === (item.name || '').toLowerCase());
        if (!matched) return item;

        const newW = String(matched.pWidth || matched.width || matched.length || 0);
        const newD = String(matched.pDepth || matched.depth || 0);
        const newH = String(matched.pHeight || matched.height || 0);

        if (newW !== item.w || newD !== item.d || newH !== item.h) {
          syncedCount++;
          const newWeight = (parseFloat(newW) > 0 && parseFloat(newD) > 0 && parseFloat(newH) > 0)
            ? parseFloat(calculateCabinetWeight(newW, newD, newH)) || item.weight
            : item.weight;
          return { ...item, w: newW, d: newD, h: newH, weight: newWeight };
        }
        return item;
      });

      // 2. Thêm kiện mới từ projectEntries nếu thiếu
      for (const entry of projectModules) {
        const entryName = (entry.moduleCode || '').toLowerCase().trim();
        if (!entryName || currentNames.has(entryName)) continue;

        const instances = getModuleInstances(entry);
        const totalInstances = instances.length || 1;
        const shelfQuantity = Math.floor(Number((entry.accessories || []).find((a: any) => {
          const n = String(a.name).toLowerCase();
          return n.includes('chốt đợt di động') || n.includes('chot dot di dong');
        })?.quantity || 0) / 4);

        for (let i = 0; i < totalInstances; i++) {
          const inst = instances[i];
          const newItemName = totalInstances > 1 ? `${entry.moduleCode} #${i + 1}/${totalInstances}` : entry.moduleCode;

          syncedItems.push({
            id: `${entry.id}_${i}`,
            name: newItemName,
            rawQR: totalInstances > 1 ? `${entry.moduleCode}|${i + 1}` : entry.moduleCode,
            cluster: entry.cluster,
            subType: 'kienModule' as const,
            quantity: 1,
            packed: false,
            packStatus: 'pending' as const,
            hasMobileShelf: false,
            shelfQuantity,
            shelfChecked: false,
            accessoryChecked: false,
            w: String(entry.pWidth || entry.width || entry.length || 0),
            d: String(entry.pDepth || entry.depth || 0),
            h: String(entry.pHeight || entry.height || 0),
            weight: (() => {
              const pw = entry.pWidth || entry.width || entry.length || 0;
              const pd = entry.pDepth || entry.depth || 0;
              const ph = entry.pHeight || entry.height || 0;
              if (pw > 0 && pd > 0 && ph > 0) return parseFloat(calculateCabinetWeight(String(pw), String(pd), String(ph))) || 0;
              return 0;
            })(),
            accessories: (entry.accessories || []).map((a: any) => ({ name: a.name, quantity: a.quantity, checked: false })),
            instanceIndex: totalInstances > 1 ? i + 1 : undefined,
            totalInstances: totalInstances > 1 ? totalInstances : undefined,
            createdAt: Date.now(),
          });
          addedCount++;
        }
      }

      if (syncedCount === 0 && addedCount === 0) {
        showSuccess('Phiếu đóng gói đã trùng khớp hoàn toàn với dự án!');
        setShowSyncModal(false);
        setLoading(false);
        return;
      }

      await updateDoc(doc(db, 'packing', packingList.id), {
        items: cleanUndefinedFields(syncedItems)
      });

      setItems(syncedItems);
      setShowSyncModal(false);

      await addDoc(collection(db, 'activities'), {
        userId: user.uid,
        userName: displayLabel,
        userEmail: user.email,
        action: 'Đồng bộ từ dự án',
        details: `Cập nhật ${syncedCount} kích thước, thêm ${addedCount} kiện mới`,
        projectCode: packingList.projectCode || '',
        timestamp: serverTimestamp()
      });

      showSuccess(`Đã đồng bộ: ${syncedCount} kích thước cập nhật, ${addedCount} kiện mới thêm`);
    } catch (error: any) {
      handleFirestoreError(error, OperationType.UPDATE, 'packing');
    } finally {
      setLoading(false);
    }
  };

  const handleSaveRawQR = async () => {
    if (!user || !packingList.id || items.length === 0) return;
    setLoading(true);
    try {
      const updatedItems = items.map(item => ({
        ...item,
        rawQR: computeRawQR(item)
      }));

      await updateDoc(doc(db, 'packing', packingList.id), {
        items: cleanUndefinedFields(updatedItems)
      });

      setItems(updatedItems);

      const displayLabel = userProfile?.ten_that ? `${userProfile.ten_that} (${userProfile.chuc_danh || 'NV'})` : (user?.displayName || 'Anonymous');
      await addDoc(collection(db, 'activities'), {
        userId: user.uid,
        userName: displayLabel,
        userEmail: user.email,
        action: 'Lưu rawQR',
        details: `Đã lưu mã QR thô cho ${updatedItems.length} kiện trong "${packingList.title}"`,
        projectCode: packingList.projectCode || '',
        timestamp: serverTimestamp()
      });

      showSuccess(`Đã lưu mã QR thô cho ${updatedItems.length} kiện!`);
    } catch (error: any) {
      handleFirestoreError(error, OperationType.UPDATE, 'packing');
    } finally {
      setLoading(false);
    }
  };

  // Tính lại cân nặng cho toàn bộ kiện Module và CTHT
  const handleRecalcWeight = async () => {
    if (!packingList?.id || items.length === 0) return;
    setLoading(true);
    try {
      const calcSinglePanelWeight = (w: number, d: number, thickness: number): number => {
        if (w <= 0 || d <= 0 || thickness <= 0) return 0;
        return (w * d * thickness) / 1000000000 * 750 * 0.7;
      };

      let updatedCount = 0;
      console.log('=== TÍNH LẠI CÂN NẶNG ===');
      const updatedItems = items.map(item => {
        const w = parseFloat(item.w) || 0;
        const d = parseFloat(item.d) || 0;
        const h = parseFloat(item.h) || 0;
        if (w <= 0 || d <= 0 || h <= 0) return item;

        if (item.subType === 'kienCTHT') {
          // CTHT: weight = tổng (tấm × W × D × 18 × 750) theo accessories
          let totalWeight = 0;
          const accs = item.accessories || [];
          for (const acc of accs) {
            const matchedEntry = projectEntries?.find(e => e.moduleCode === acc.name);
            if (matchedEntry) {
              const pw = parseFloat(String(matchedEntry.pWidth || matchedEntry.width || matchedEntry.length || 0)) || 0;
              const pd = parseFloat(String(matchedEntry.pDepth || matchedEntry.depth || 0)) || 0;
              const qty = acc.quantity || 1;
              totalWeight += calcSinglePanelWeight(pw, pd, 18) * qty;
            }
          }
          const newWeight = Math.round(totalWeight * 10) / 10;
          console.log(`[CTHT] ${item.name} | ${w}x${d}x${h} | ${item.weight}kg → ${newWeight}kg`);
          if (newWeight !== item.weight) {
            updatedCount++;
            return { ...item, weight: newWeight };
          }
        } else {
          // Module: weight = calculateCabinetWeight(w, d, h)
          const newWeight = parseFloat(calculateCabinetWeight(String(w), String(d), String(h))) || 0;
          console.log(`[Module] ${item.name} | ${w}x${d}x${h} | ${item.weight}kg → ${newWeight}kg`);
          if (newWeight !== item.weight) {
            updatedCount++;
            return { ...item, weight: newWeight };
          }
        }
        return item;
      });
      console.log(`=== Tổng: ${updatedCount} kiện thay đổi ===`);

      if (updatedCount === 0) {
        showSuccess('Tất cả cân nặng đã chính xác!');
        setLoading(false);
        return;
      }

      await updateDoc(doc(db, 'packing', packingList.id), {
        items: cleanUndefinedFields(updatedItems)
      });

      setItems(updatedItems);

      // Đồng bộ weight mới vào printItems (modal in tem)
      setPrintItems(prev => prev.map(pi => {
        const matched = updatedItems.find(item => item.name === pi.originalName);
        if (matched && String(matched.weight) !== pi.weight) {
          return { ...pi, weight: String(matched.weight) };
        }
        return pi;
      }));

      const displayLabel = userProfile?.ten_that ? `${userProfile.ten_that} (${userProfile.chuc_danh || 'NV'})` : (user?.displayName || 'Anonymous');
      await addDoc(collection(db, 'activities'), {
        userId: user.uid,
        userName: displayLabel,
        userEmail: user.email,
        action: 'Tính lại cân nặng',
        details: `Đã cập nhật cân nặng cho ${updatedCount}/${items.length} kiện`,
        projectCode: packingList.projectCode || '',
        timestamp: serverTimestamp()
      });

      showSuccess(`Đã tính lại cân nặng cho ${updatedCount}/${items.length} kiện!`);
    } catch (error: any) {
      handleFirestoreError(error, OperationType.UPDATE, 'packing');
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteByDate = async () => {
    if (!packingList?.id || deleteByDateSelectedIds.size === 0) return;
    const idsToDelete = Array.from(deleteByDateSelectedIds);

    setLoading(true);
    try {
      const nextItems = items.filter(i => !idsToDelete.includes(i.id || i.name));
      await updateDoc(doc(db, 'packing', packingList.id), {
        items: cleanUndefinedFields(nextItems)
      });
      setItems(nextItems);

      const displayLabel = userProfile?.ten_that ? `${userProfile.ten_that} (${userProfile.chuc_danh || 'NV'})` : (user?.displayName || 'Anonymous');
      await addDoc(collection(db, 'activities'), {
        userId: user.uid,
        userName: displayLabel,
        userEmail: user.email,
        action: 'Xoá kiện theo ngày',
        details: `Đã xoá ${idsToDelete.length} kiện ngày ${deleteByDate} khỏi phiếu ${packingList.title}`,
        projectCode: packingList.projectCode || '',
        timestamp: serverTimestamp()
      });

      showSuccess(`Đã xoá ${idsToDelete.length} kiện ngày ${deleteByDate}!`);
      setShowDeleteByDateModal(false);
      setDeleteByDateSelectedIds(new Set());
      setDeleteByDate('');
    } catch (error: any) {
      handleFirestoreError(error, OperationType.UPDATE, 'packing');
    } finally {
      setLoading(false);
    }
  };

  const thungCount = useMemo(() => sortedItems.filter(({ item }) => !isCthtItem(item) && !isPhuKienItem(item) && (item.name || '').split('_').length <= 2).length, [sortedItems]);
  const cthtCount = useMemo(() => sortedItems.filter(({ item }) => isCthtItem(item)).length, [sortedItems]);
  const pkCount = useMemo(() => sortedItems.filter(({ item }) => isPhuKienItem(item)).length, [sortedItems]);
  const totalCount = sortedItems.length;

  const isFullyQCPassed = (p: ProjectEntry) => {
    const typeLocal = getEntryTypeLocal(p.moduleCode);
    const isThungOrDot = typeLocal === 'Thùng' || typeLocal === 'Đợt';
    return (
      p.qcWhite?.status === 'pass' &&
      (isThungOrDot || p.qcPaint?.status === 'pass') &&
      p.qcFinish?.status === 'pass' &&
      p.qcPack?.status === 'pass'
    );
  };

  const toggleLoading = async (idx: number, forceConfirm: boolean = false) => {
    const item = items[idx];
    if (!item.packed) {
      setScanErrorMessage(`Cấu kiện "${item.name}" chưa đóng gói hoàn tất. Bản kiểm chưa được tích hoàn thiện ở khâu Đóng gói!`);
      return;
    }

    // Check for 4 QC stages
    const entry = projectEntries.find(e => e.id === item.id || (e.moduleCode || '').toLowerCase() === (item.name || '').toLowerCase());
    if (entry && !isFullyQCPassed(entry)) {
      let missing = [];
      const typeLocal = entry ? getEntryTypeLocal(entry.moduleCode) : 'CTHT';
      const isThungOrDot = typeLocal === 'Thùng' || typeLocal === 'Đợt';
      if (getModuleQcAggregate(entry, 'white')?.status !== 'pass') missing.push('Hàng Trắng');
      if (!isThungOrDot && getModuleQcAggregate(entry, 'paint')?.status !== 'pass') missing.push('Hàng Sơn');
      if (getModuleQcAggregate(entry, 'finish')?.status !== 'pass') missing.push('Hàng Hoàn Thiện');
      if (getModuleQcAggregate(entry, 'pack')?.status !== 'pass') missing.push('Hàng Đóng Gói');

      setScanErrorMessage(`Cấu kiện "${item.name}" chưa đạt đủ 4 công đoạn QC. Thiếu: ${missing.join(', ')}.`);
      return;
    }

    if (forceConfirm || !items[idx].loaded) {
      setLoadingConfirmIdx(idx);
      return;
    }

    // If already loaded and not forceConfirm, we allow untoggling directly or showing modal (Hạ xe)
    const newItems = [...items];
    const displayLabel = userProfile?.ten_that ? `${userProfile.ten_that} (${userProfile.chuc_danh || 'NV'})` : (user?.displayName || 'Unknown');
    newItems[idx].loaded = false;
    newItems[idx].loadedBy = undefined;
    setItems(newItems);

    setLoading(true);
    try {
      const allPacked = newItems.every(i => i.packed);
      await updateDoc(doc(db, 'packing', packingList.id), {
        items: cleanUndefinedFields(newItems),
        isCompleted: allPacked
      });
      await addDoc(collection(db, 'activities'), {
        userId: user?.uid || 'unknown',
        userName: displayLabel,
        userEmail: user?.email || '',
        action: 'Hạ xe kiện hàng',
        details: `Đã hạ xe cấu kiện: ${item.name}`,
        projectCode: packingList.projectCode || '',
        timestamp: serverTimestamp()
      });
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const confirmLoading = async (idx: number) => {
    const item = items[idx];
    const newItems = [...items];
    const displayLabel = userProfile?.ten_that ? `${userProfile.ten_that} (${userProfile.chuc_danh || 'NV'})` : (user?.displayName || 'Unknown');
    newItems[idx].loaded = true;
    newItems[idx].loadedBy = displayLabel;
    setItems(newItems);
    setLoadingConfirmIdx(null);

    setLoading(true);
    try {
      const allPacked = newItems.every(i => i.packed);
      await updateDoc(doc(db, 'packing', packingList.id), {
        items: cleanUndefinedFields(newItems),
        isCompleted: allPacked
      });
      await addDoc(collection(db, 'activities'), {
        userId: user?.uid || 'unknown',
        userName: displayLabel,
        userEmail: user?.email || '',
        action: 'Lên xe kiện hàng',
        details: `Đã lên xe cấu kiện: ${item.name}`,
        projectCode: packingList.projectCode || '',
        timestamp: serverTimestamp()
      });
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleQRScan = async (result: ScannedResult) => {
    // Detect CTHT format từ ScannerModal
    const cthtScanId = result.cthtPackageId || null;
    const finalCode = cthtScanId
      ? (result.moduleCode || '').trim()
      : (result.moduleCode || '').split('|')[0];
    const parentCode = result.parentModuleCode;

    // Helper: tách tên instance để lấy module code gốc (bỏ #1/3)
    const getBaseName = (name: string): string => {
      return name.includes('#') ? name.split('#')[0].trim() : name;
    };

    // Helper: lấy instance index từ item name (ví dụ "MODULE #2/3" -> 2)
    const getInstanceIdx = (name: string): number | undefined => {
      const match = name.match(/#(\d+)\//);
      return match ? parseInt(match[1]) : undefined;
    };

    // Lấy instance index từ QR result
    let scanInstanceIdx: number | undefined;
    if (result.instanceId) {
      const parts = result.instanceId.split('|');
      if (parts.length >= 2) {
        scanInstanceIdx = parseInt(parts[1]);
      }
    }

    // Helper check partial match safely to prevent mismatch such as T1 with T11
    const isPartialMatchSafe = (itemCode: string, scanCode: string): boolean => {
      const item = itemCode.toLowerCase().trim();
      const scan = scanCode.toLowerCase().trim();
      if (item === scan) return true;

      const isMatchWord = item.includes(scan) || scan.includes(item);
      if (!isMatchWord) return false;

      const itemNumbers = item.match(/\d+$/);
      const scanNumbers = scan.match(/\d+$/);
      if (itemNumbers && scanNumbers) {
        return itemNumbers[0] === scanNumbers[0];
      }
      return true;
    };

    // Tìm kiếm thông minh qua nhiều tiêu chí độc lập
    // Lượt 1: Tìm khớp hoàn toàn (Exact Match) - so sánh base name + full name + instance index + CTHT id
    let idx = items.findIndex(i => {
      // CTHT: match theo id
      if (cthtScanId && i.id === cthtScanId) return true;

      const baseName = getBaseName(i.name).toLowerCase().trim();
      const fullName = i.name.toLowerCase().trim();
      const finalCodeLower = finalCode.toLowerCase().trim();
      const parentCodeLower = parentCode ? parentCode.toLowerCase().trim() : '';
      const nameMatch = baseName === finalCodeLower || fullName === finalCodeLower ||
        (parentCodeLower !== '' && (baseName === parentCodeLower || fullName === parentCodeLower));

      if (!nameMatch) return false;

      // Nếu QR có instance index, match chính xác instance đó
      if (scanInstanceIdx != null) {
        return getInstanceIdx(i.name) === scanInstanceIdx;
      }
      return true;
    });

    // Lượt 2: Nếu không khớp hoàn toàn, thử khớp một phần (Partial Match)
    if (idx === -1) {
      idx = items.findIndex(i => {
        const baseName = getBaseName(i.name).toLowerCase().trim();
        const fullName = i.name.toLowerCase().trim();
        const finalCodeLower = finalCode.toLowerCase().trim();
        const parentCodeLower = parentCode ? parentCode.toLowerCase().trim() : '';

        let nameMatch = false;
        // So sánh cả base name và full name với finalCode
        if (isPartialMatchSafe(baseName, finalCodeLower) || isPartialMatchSafe(finalCodeLower, baseName)) nameMatch = true;
        if (isPartialMatchSafe(fullName, finalCodeLower) || isPartialMatchSafe(finalCodeLower, fullName)) nameMatch = true;
        if (parentCodeLower && (isPartialMatchSafe(baseName, parentCodeLower) || isPartialMatchSafe(parentCodeLower, baseName))) nameMatch = true;
        if (parentCodeLower && (isPartialMatchSafe(fullName, parentCodeLower) || isPartialMatchSafe(parentCodeLower, fullName))) nameMatch = true;

        if (!nameMatch) return false;

        if (scanInstanceIdx != null) {
          return getInstanceIdx(i.name) === scanInstanceIdx;
        }
        return true;
      });
    }

    setShowQRScanner(false);

    if (idx >= 0) {
      if (mode === 'loading') {
        const item = items[idx];
        if (!item.packed) {
          setScanErrorMessage(`Không thể cho lên xe! Kiện "${item.name}" chưa hoàn tất đóng gói.`);
          return;
        }

        // Kiểm tra QC 4 công đoạn (nếu có yêu cầu từ hệ thống, hoặc nếu muốn nhất quán với toggleLoading):
        const entry = projectEntries.find(e => e.id === item.id || (e.moduleCode || '').toLowerCase() === (item.name || '').toLowerCase());
        if (entry && !isFullyQCPassed(entry)) {
          let missing = [];
          const typeLocal = entry ? getEntryTypeLocal(entry.moduleCode) : 'CTHT';
          const isThungOrDot = typeLocal === 'Thùng' || typeLocal === 'Đợt';
          if (getModuleQcAggregate(entry, 'white')?.status !== 'pass') missing.push('Hàng Trắng');
          if (!isThungOrDot && getModuleQcAggregate(entry, 'paint')?.status !== 'pass') missing.push('Hàng Sơn');
          if (getModuleQcAggregate(entry, 'finish')?.status !== 'pass') missing.push('Hàng Hoàn Thiện');
          if (getModuleQcAggregate(entry, 'pack')?.status !== 'pass') missing.push('Hàng Đóng Gói');

          setScanErrorMessage(`Cấu kiện "${item.name}" chưa đạt đủ 4 công đoạn QC. Thiếu: ${missing.join(', ')}.`);
          return;
        }

        // Đánh dấu đã lên xe trực tiếp luôn
        const newItems = [...items];
        const displayLabel = userProfile?.ten_that ? `${userProfile.ten_that} (${userProfile.chuc_danh || 'NV'})` : (user?.displayName || 'Unknown');
        newItems[idx].loaded = true;
        newItems[idx].loadedBy = displayLabel;
        setItems(newItems);

        setLoading(true);
        try {
          const allPacked = newItems.every(i => i.packed);
          await updateDoc(doc(db, 'packing', packingList.id), {
            items: cleanUndefinedFields(newItems),
            isCompleted: allPacked
          });
          await addDoc(collection(db, 'activities'), {
            userId: user?.uid || 'unknown',
            userName: displayLabel,
            userEmail: user?.email || '',
            action: 'Quét QR Lên xe',
            details: `Đã dùng QR quét lên xe thành công kiện: ${item.name}`,
            projectCode: packingList.projectCode || '',
            timestamp: serverTimestamp()
          });
        } catch (err) {
          console.error(err);
        } finally {
          setLoading(false);
        }
      } else {
        // Mở ngay module kiểm và lọc tên
        setSearchTerm(''); // Xoá tìm kiếm để hiển thị đúng item trong danh sách
        setActiveCheckingIdx(idx);
        setIsAdminEditingItemCheck(!items[idx].packed);
        setCurrentImageIdx(0);
      }
    } else {
      alert(`Mã cấu kiện "${finalCode}" không tồn tại trong danh sách đóng gói đóng gói này. Vui lòng kiểm tra lại!`);
    }
  };

  // Quét QR → in tem thùng kiện đó
  const handleQRScanPrintLabel = async (result: ScannedResult) => {
    const finalCode = (result.moduleCode || '').split('|')[0];
    const parentCode = result.parentModuleCode;

    // Trích xuất instanceIndex từ instanceId (ví dụ: "ModuleName|1" → instanceIndex = 1)
    let scannedInstanceIndex: number | undefined = undefined;
    if (result.instanceId) {
      const instParts = result.instanceId.split('|');
      if (instParts.length >= 2) {
        const idx = parseInt(instParts[instParts.length - 1], 10);
        if (!isNaN(idx) && idx > 0) {
          scannedInstanceIndex = idx;
        }
      }
    }

    const isPartialMatchSafe = (a: string, b: string): boolean => {
      if (a === b) return true;
      if (!a.includes(b) && !b.includes(a)) return false;
      const aNum = a.match(/\d+$/);
      const bNum = b.match(/\d+$/);
      return aNum && bNum ? aNum[0] === bNum[0] : true;
    };

    let idx = items.findIndex(i => {
      if (result.matchedId && i.id === result.matchedId) return true;
      if (i.id && i.id === finalCode) return true;
      const itemNameLower = i.name.toLowerCase().trim();
      const finalCodeLower = finalCode.toLowerCase().trim();
      const parentCodeLower = parentCode ? parentCode.toLowerCase().trim() : '';
      return itemNameLower === finalCodeLower || (parentCodeLower !== '' && itemNameLower === parentCodeLower);
    });

    if (idx === -1) {
      idx = items.findIndex(i => {
        const itemNameLower = i.name.toLowerCase().trim();
        const finalCodeLower = finalCode.toLowerCase().trim();
        const parentCodeLower = parentCode ? parentCode.toLowerCase().trim() : '';
        return isPartialMatchSafe(itemNameLower, finalCodeLower) || isPartialMatchSafe(finalCodeLower, itemNameLower) ||
          (parentCodeLower && (isPartialMatchSafe(itemNameLower, parentCodeLower) || isPartialMatchSafe(parentCodeLower, itemNameLower)));
      });
    }

    setShowQRPrintScanner(false);

    if (idx >= 0) {
      const matchedItem = items[idx];
      // Ưu tiên lấy từ QR đã scan, sau đó từ printItems, cuối cùng dùng quantity
      const instanceIndex = scannedInstanceIndex || 1;
      const totalInstances = matchedItem.quantity || 1;

      setQrPrintConfirmItem({
        name: matchedItem.name,
        item: matchedItem,
        instanceIndex,
        totalInstances
      });
    } else {
      showError(`Mã "${finalCode.slice(0, 30)}" không tồn tại trong danh sách.`);
    }
  };

  const onPhotosCapturedMultiple = async (files: FileList) => {
    if (activeCheckingIdx === null) return;
    const fileArray = Array.from(files);

    setUploading(true);
    const uploadedUrls: string[] = [];

    try {
      for (let i = 0; i < fileArray.length; i++) {
        setUploadProgress(`Đang tải ảnh ${i + 1}/${fileArray.length}...`);
        const url = await uploadToCloudinary(fileArray[i], 'QC');
        if (url) {
          uploadedUrls.push(url);
        }
      }

      if (uploadedUrls.length > 0) {
        const newItems = [...items];
        const prevPhotos = newItems[activeCheckingIdx].photos || [];
        const nextPhotos = [...prevPhotos, ...uploadedUrls];
        newItems[activeCheckingIdx].photos = nextPhotos;
        // Gán fallback cho ảnh sản phẩm và ảnh đóng gói cũ
        if (nextPhotos.length > 0) {
          newItems[activeCheckingIdx].productImageUrl = nextPhotos[0];
        }
        if (nextPhotos.length > 1) {
          newItems[activeCheckingIdx].packingImageUrl = nextPhotos[1];
        }
        setItems(newItems);
      } else {
        alert("Có lỗi xảy ra khi tải ảnh lên. Hãy thử chọn lại!");
      }
    } catch (err) {
      console.error(err);
      alert("Không thể tải ảnh lên. Vui lòng kiểm tra lại đường truyền mạng!");
    } finally {
      setUploading(false);
      setUploadProgress('');
    }
  };

  // Lưu thông tin tem đã chỉnh sửa trở lại packing item
  const handleSaveLabelData = async () => {
    if (!packingList) return;
    setLoading(true);
    try {
      const updatedItems = [...items];
      for (const pi of printItems) {
        if (!pi.originalId) continue;
        const idx = updatedItems.findIndex(it => it.id === pi.originalId || it.name === pi.originalName);
        if (idx === -1) continue;
        updatedItems[idx] = {
          ...updatedItems[idx],
          savedLabelData: {
            projectName: pi.projectName,
            unit: pi.unit,
            area: pi.area,
            cabinetType: pi.cabinetType,
            w: pi.w,
            d: pi.d,
            h: pi.h,
            weight: pi.weight,
          },
        };
      }
      await updateDoc(doc(db, 'packing', packingList.id), {
        items: cleanUndefinedFields(updatedItems),
      });
      setItems(updatedItems);
      showSuccess('Đã lưu thông tin tem thành công!');
    } catch (err) {
      console.error('Save label data error:', err);
      handleFirestoreError(err, OperationType.UPDATE, 'packing');
    } finally {
      setLoading(false);
    }
  };

  // Xuất Excel phiếu đóng gói
  const handleExportPackingExcel = () => {
    const rows: any[][] = [];
    rows.push(['MÃ DỰ ÁN', 'TÊN DỰ ÁN', 'TÊN CỤM', 'TÊN KIỆN', 'TÊN TYPE', 'D (mm)', 'W (mm)', 'H (mm)', 'CÂN NẠNG (kg)', 'ẢNH']);

    items.forEach((item) => {
      const matchedEntry = projectEntries.find(e => e.id === item.id || (e.moduleCode || '').toLowerCase() === (item.name || '').toLowerCase());
      const projectCode = matchedEntry?.projectCode || packingList.projectCode || '';
      const projectName = matchedEntry?.projectName || packingList.title || '';
      const cluster = item.cluster || matchedEntry?.cluster || '-';
      const itemName = item.name || '-';
      const hasType = (item.name || '').includes('.');
      const cabinetType = hasType ? (item.name || '').split('.').pop()?.toUpperCase() || itemName : itemName;
      const d = item.d || '-';
      const w = item.w || '-';
      const h = item.h || '-';
      const weight = item.weight || '-';

      const allPhotos = [...new Set([
        ...(item.photos || []),
        item.productImageUrl,
        item.packingImageUrl,
      ].filter(Boolean))];
      const photoStr = allPhotos.length > 0 ? allPhotos.join('\n') : '-';

      rows.push([projectCode, projectName, cluster, itemName, cabinetType, d, w, h, weight, photoStr]);
    });

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(rows);

    ws['!cols'] = [
      { wch: 15 }, { wch: 25 }, { wch: 20 }, { wch: 35 }, { wch: 20 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 60 }
    ];

    XLSX.utils.book_append_sheet(wb, ws, 'Phiếu Đóng Gói');
    XLSX.writeFile(wb, `PhieuDongGoi_${packingList.title || packingList.id}_${new Date().toISOString().slice(0, 10)}.xlsx`);
    showSuccess('Đã xuất file Excel thành công!');
  };

  const handlePrintLabel = async (qty: number) => {
    const item = items[activeCheckingIdx];
    if (!item) return;
    const baseCode = item.name.includes('#') ? item.name.split('#')[0].trim() : item.name;
    // Chỉ khớp cấu kiện trong cùng dự án của phiếu để tránh lấy nhầm tên dự án khác
    const matchedEntry = projectEntries.find(e => {
      if (packingList.projectCode && e.projectCode && e.projectCode !== packingList.projectCode) return false;
      return (e.moduleCode || '').toLowerCase() === baseCode.toLowerCase();
    });
    const resolvedPC = matchedEntry?.projectCode || packingList.projectCode || '';

    const saved = item.savedLabelData as { projectName?: string; unit?: string; area?: string; cabinetType?: string; w?: string; d?: string; h?: string; weight?: string } | undefined;
    const parsedName = parseItemDimensionsAndInfo(baseCode);
    const instIdx = item.instanceIndex;
    const totalInst = item.totalInstances;

    const w = saved?.w || item.w || '0';
    const d = saved?.d || item.d || '0';
    const h = saved?.h || item.h || '0';
    const unit = saved?.unit || extractSubProjectCode(resolvedPC) || '-';
    const area = saved?.area || formatAreaName(item.cluster || matchedEntry?.cluster || '-');
    const isCthtKien = item.subType === 'kienCTHT';
    let cabinetType = saved?.cabinetType || (isCthtKien ? baseCode.toUpperCase() : (parsedName.cabinetType || extractSubProjectCode(resolvedPC) || '-'));
    if (instIdx && totalInst && totalInst > 1 && !cabinetType.includes(`(${instIdx}/${totalInst})`)) cabinetType = `${cabinetType} (${instIdx}/${totalInst})`;
    const weight = saved?.weight || item.weight?.toString() || '0';
    // Tên dự án mặc định theo dự án của phiếu đóng gói (packingList)
    const slipProjectName = resolveSlipProjectName(projectEntries, resolvedPC, packingList);
    const pName = slipProjectName || saved?.projectName || matchedEntry?.projectName || item.projectName || '';
    const instanceSuffix = totalInst && totalInst > 1 && instIdx ? `|${instIdx}` : '';
    const qrText = isCthtKien && item.id
      ? `${item.id}|${item.name}----EASYCABINET----`
      : `${baseCode}${instanceSuffix}----EASYCABINET----`;

    setPrintSentForIdx(activeCheckingIdx);
    setShowPrintQtyModal(false);

    try {
      const qrUrl = await QRCode.toDataURL(qrText, { margin: 1, width: 300, color: { dark: '#000000', light: '#ffffff' } });
      console.log('[handlePrintLabel] QR:', { qrText, name: item.name, isCthtKien, instIdx, totalInst, baseCode });
      await addDoc(collection(db, 'print_jobs'), {
        createdAt: serverTimestamp(),
        packageId: item.id || '',
        packageName: item.name,
        copies: qty,
        sw: printMultiUnit ? 'CODE' : 'UNIT',
        formTemplate,
        payload: { name: item.name, projectName: pName, unit, area, cabinetType, w, d, h, weight, qrText, qrUrl, supplierDept: bconsDept, deliveryAddress: bconsAddress, receiverName: bconsReceiver, receiverPhone: bconsPhone, printDate: new Date().toLocaleDateString('vi-VN'), ...(instIdx != null ? { instanceIndex: instIdx } : {}), ...(totalInst != null ? { totalInstances: totalInst } : {}) },
        pklCode: pklLists.find(p => p.packageIds?.includes(item.id || ''))?.pklCode || packingList.title || '',
      });
    } catch (err) {
      console.error('[handlePrintLabel] Lỗi gửi print job:', err);
      showError(`Không thể gửi lệnh in "${item.name}". Vui lòng thử lại.`);
    }
  };

  const saveDraftChecking = async (idx: number) => {
    if (idx === null || idx === undefined) return;
    const item = items[idx];
    const displayLabel = userProfile?.ten_that ? `${userProfile.ten_that} (${userProfile.chuc_danh || 'NV'})` : (user?.displayName || 'Unknown');
    const newItems = [...items];

    let targetQty = item.quantity;
    if (item.quantity > 1) {
      targetQty = typeof newItems[idx].packedQty === 'number' ? newItems[idx].packedQty : (newItems[idx].packed ? item.quantity : 0);
    } else {
      targetQty = item.packed ? 1 : 0;
    }

    newItems[idx].packedQty = targetQty;
    // can remain false as it's a partial draft
    newItems[idx].packed = false;
    newItems[idx].packedAt = Date.now();
    newItems[idx].packedBy = `${displayLabel} (Đang đóng gói: ${item.photos?.length || 0} ảnh, ${item.accessories?.filter(a => a.checked).length || 0}/${item.accessories?.length || 0} PK)`;

    setItems(newItems);
    setActiveCheckingIdx(null);
    setIsAdminEditingItemCheck(false);

    setLoading(true);
    try {
      const allPacked = newItems.every(i => i.packed);
      await updateDoc(doc(db, 'packing', packingList.id), {
        items: cleanUndefinedFields(newItems),
        isCompleted: allPacked
      });

      // Synchronize project status to 'Đang Đóng Gói' (Packing in progress) without saving draft history
      const matchedEntry = projectEntries ? projectEntries.find(e => e.id === item.id || (e.moduleCode || '').toLowerCase() === (item.name || '').toLowerCase()) : undefined;
      if (matchedEntry) {
        const newStatus = 'Đang Đóng Gói';
        if (matchedEntry.status !== newStatus) {
          await updateProjectModule(matchedEntry.id, {
            status: newStatus
          }, matchedEntry.projectCode);
        }
      }
    } catch (error: any) {
      handleFirestoreError(error, OperationType.UPDATE, 'packing');
    } finally {
      setLoading(false);
    }
  };

  const finishItemChecking = async (idx: number) => {
    const item = items[idx];
    // Check if everything is filled
    const needsAccCheck = item.accessories && item.accessories.length > 0;

    const accOk = !needsAccCheck || (item.accessories?.every(a => a.checked) && item.accessoryChecked);
    const isCtht = item && item.subType === 'kienCTHT';
    const hasPhotos = item.photos && item.photos.length >= 3;
    const hasOldPhotos = isCtht ? !!item.packingImageUrl : (!!item.productImageUrl && !!item.packingImageUrl);
    const photosOk = hasPhotos || hasOldPhotos;

    if (accOk && photosOk) {
      const displayLabel = userProfile?.ten_that ? `${userProfile.ten_that} (${userProfile.chuc_danh || 'NV'})` : (user?.displayName || 'Unknown');
      const newItems = [...items];

      let targetQty = item.quantity;
      if (item.quantity > 1) {
        // Nếu họ chưa bấm nút + / - (packedQty chưa được gán kiểu number), chúng ta tự động tăng bộ đếm thêm 1 từ lượng đã lưu trước đó
        if (typeof newItems[idx].packedQty !== 'number') {
          const currentSavedQty = item.packed ? item.quantity : 0;
          targetQty = Math.min(item.quantity, currentSavedQty + 1);
        } else {
          // Ngược lại, nếu họ đã bấm nút tăng/giảm thì dùng chính xác giá trị họ đã chỉnh
          targetQty = newItems[idx].packedQty;
        }
      } else {
        targetQty = 1;
      }

      newItems[idx].packedQty = targetQty;
      const isFullyPacked = targetQty === item.quantity;
      newItems[idx].packed = isFullyPacked;
      newItems[idx].packedAt = Date.now();

      if (isFullyPacked) {
        newItems[idx].packedBy = displayLabel;
      } else {
        newItems[idx].packedBy = `${displayLabel} (${targetQty}/${item.quantity})`;
      }

      setItems(newItems);
      setActiveCheckingIdx(null);

      setLoading(true);
      try {
        const allPacked = newItems.every(i => i.packed);
        await updateDoc(doc(db, 'packing', packingList.id), {
          items: cleanUndefinedFields(newItems),
          isCompleted: allPacked
        });

        // Đồng bộ trạng thái vào dự án
        const matchedEntry = projectEntries ? projectEntries.find(e => e.id === item.id || (e.moduleCode || '').toLowerCase() === (item.name || '').toLowerCase()) : undefined;
        if (matchedEntry) {
          const nextHistory = [...(matchedEntry.statusHistory || [])];
          const newStatus = isFullyPacked ? 'Đóng Gói' : 'Đang Đóng Gói';
          if (!nextHistory.length || nextHistory[nextHistory.length - 1].split('|')[0] !== newStatus) {
            nextHistory.push(`${newStatus} (${displayLabel} - ${targetQty}/${item.quantity})|${Date.now()}`);
          }

          const updateData: any = {
            status: newStatus,
            statusHistory: nextHistory
          };

          if (isFullyPacked) {
            // Cập nhật packStatus = 'done' + qcPack = 'pending' cho instance cụ thể
            try {
              const instConfigId = await findProjectConfigId(matchedEntry.projectCode || '');
              if (instConfigId) {
                const instDoc = await getDoc(doc(db, 'projectConfigs', instConfigId, 'modules', matchedEntry.id));
                if (instDoc.exists()) {
                  const instances = getModuleInstances(instDoc.data() as ProjectEntry);
                  const updatedInstances = instances.map((inst: any) => {
                    const itemInstIdx = item.instanceIndex || (() => {
                      const m = (item.name || '').match(/#(\d+)\//);
                      return m ? parseInt(m[1], 10) : undefined;
                    })();
                    const isTarget = (itemInstIdx != null && inst.instanceIndex === itemInstIdx) || instances.length === 1;
                    if (isTarget) {
                      return {
                        ...inst,
                        packStatus: 'done',
                        qcPack: {
                          status: 'pending',
                          by: displayLabel,
                          date: new Date(),
                          notes: '',
                          photos: [],
                        }
                      };
                    }
                    return inst;
                  });
                  await updateProjectModule(matchedEntry.id, { instances: updatedInstances }, matchedEntry.projectCode);
                }
              }
            } catch (pErr) {
              console.error("Lỗi cập nhật packStatus + qcPack:", pErr);
            }

            // Kiện Module: tự động pass bù các giai đoạn trước + cấu kiện con
            const isThung = matchedEntry.classification === 'Thùng' ||
              (matchedEntry.moduleCode || '').toLowerCase().includes('thung') ||
              (matchedEntry as any).moduleType === 'thung';
            if (isThung) {
              try {
                await autoPassBuForPackage(matchedEntry.id, {
                  uid: user?.uid,
                  email: user?.email,
                  displayName: displayLabel
                }, projectEntries || undefined);
              } catch (pErr) {
                console.error("Lỗi tự động pass bù Thùng:", pErr);
              }
            }

            // Kiện CTHT: tự động pass bù các giai đoạn trước cho các CTHT detail có trong kiện
            const isKienCtht = item.subType === 'kienCTHT';
            if (isKienCtht && item.accessories && item.accessories.length > 0) {
              try {
                const stages: Array<'qcWhite' | 'qcPaint' | 'qcFinish' | 'qcPack'> = ['qcWhite', 'qcPaint', 'qcFinish', 'qcPack'];
                const nowLocalDate = new Date();

                const cthtUpdates: { moduleId: string; data: Record<string, any>; projectCode: string }[] = [];

                for (const acc of item.accessories) {
                  if (!acc.name) continue;
                  const cthtEntry = projectEntries?.find(e =>
                    e.projectCode === packingList.projectCode &&
                    getEntryType(e) === 'CTHT' &&
                    ((e.moduleCode || '').toLowerCase().trim() === (acc.name || '').toLowerCase().trim())
                  );
                  if (!cthtEntry) continue;

                  const updateData: any = {};
                  stages.forEach(stageField => {
                    const currentStage = cthtEntry[stageField];
                    if (!currentStage || currentStage.status !== 'pass') {
                      updateData[stageField] = {
                        status: 'pass',
                        date: nowLocalDate,
                        by: displayLabel,
                        role: userProfile?.chuc_danh || 'Admin',
                        notes: `Tự động pass bù do nằm trong Kiện CTHT "${item.name}"`,
                        passedQty: acc.quantity || cthtEntry.quantity || 1
                      };
                    }
                  });

                  if (cthtEntry.instances && Array.isArray(cthtEntry.instances)) {
                    updateData.instances = cthtEntry.instances.map((inst: any) => {
                      const instCopy = { ...inst };
                      stages.forEach(stageField => {
                        const instStage = instCopy[stageField];
                        if (!instStage || instStage.status !== 'pass') {
                          instCopy[stageField] = {
                            status: 'pass',
                            date: nowLocalDate,
                            by: displayLabel,
                            notes: `Tự động pass bù theo Kiện CTHT`
                          };
                        }
                      });
                      let logs = instCopy.qcLogs || [];
                      stages.forEach(stage => {
                        if (!logs.some((l: any) => l.stage === stage.replace('qc', '').toLowerCase() && l.status === 'pass')) {
                          logs = logs.filter((l: any) => l.stage !== stage.replace('qc', '').toLowerCase());
                          logs.push({
                            stage: stage.replace('qc', '').toLowerCase(),
                            status: 'pass',
                            date: nowLocalDate,
                            by: displayLabel,
                            notes: 'Tự động pass bù theo Kiện CTHT'
                          });
                        }
                      });
                      instCopy.qcLogs = logs;
                      instCopy.qcDone = true;
                      return instCopy;
                    });
                  }

                  updateData.status = 'Đóng Gói';
                  updateData.receivedQuantity = acc.quantity || cthtEntry.quantity || 1;

                  const history = [...(cthtEntry.statusHistory || [])];
                  const statusText = `Đóng Gói: PASS (Tự động Pass bù theo Kiện CTHT "${item.name}" - ${displayLabel})`;
                  if (!history.length || !history[history.length - 1].includes('Tự động Pass bù theo Kiện CTHT')) {
                    history.push(`${statusText}|${Date.now()}`);
                  }
                  updateData.statusHistory = history;

                  cthtUpdates.push({ moduleId: cthtEntry.id, data: updateData, projectCode: cthtEntry.projectCode });
                }

                if (cthtUpdates.length > 0) {
                  await batchUpdateProjectModules(cthtUpdates);
                }
              } catch (pErr) {
                console.error("Lỗi tự động pass bù CTHT:", pErr);
              }
            }
          }

          await updateProjectModule(matchedEntry.id, updateData, matchedEntry.projectCode);
        }

        await addDoc(collection(db, 'activities'), {
          userId: user?.uid || 'unknown',
          userName: displayLabel,
          userEmail: user?.email || '',
          action: 'Cập nhật đóng gói',
          details: `Cập nhật đóng gói cấu kiện: ${item.name} (${targetQty}/${item.quantity})`,
          projectCode: packingList.projectCode || '',
          timestamp: serverTimestamp()
        });

      } catch (error: any) {
        handleFirestoreError(error, OperationType.UPDATE, 'packing');
      } finally {
        setLoading(false);
      }
    } else {
      alert("Vui lòng hoàn thành tất cả các bước kiểm tra và chụp đủ 2 ảnh trước khi xác nhận!");
    }
  };

  const filterItemsBySearch = (items: PackingItem[]) => {
    if (!searchTerm) return items;
    return items.filter(i =>
      matchSearchQuery(i.name, searchTerm) ||
      matchSearchQuery(i.cluster || '', searchTerm) ||
      (i.rawQR && matchSearchQuery(i.rawQR, searchTerm))
    );
  };

  const addItem = (subType: 'kienModule' | 'kienPhuKien') => {
    setItems([...items, {
      name: subType === 'kienModule' ? 'Module mới' : 'Phụ kiện mới',
      quantity: 1,
      packed: false,
      isExtra: true,
      subType,
      createdAt: Date.now(),
    }]);
  };

  const renderItemBoxes = (item: PackingItem) => {
    const qty = item.quantity || 1;
    const pQty = typeof item.packedQty === 'number' ? item.packedQty : (item.packed ? qty : 0);
    const boxes = [];
    for (let i = 0; i < qty; i++) {
      const isLit = i < pQty;
      boxes.push(
        <Inbox
          key={i}
          size={14}
          className={`${isLit ? 'text-emerald-500 fill-emerald-500/10' : 'text-slate-300'} transition-colors shrink-0`}
        />
      );
    }
    return (
      <div className="flex items-center gap-1 flex-wrap justify-center">
        {boxes}
        <span className="text-[10px] font-black text-slate-500 ml-1 font-mono">({pQty}/{qty} Kiện)</span>
      </div>
    );
  };

  const mainItemsList = items.filter(i => !i.isExtra);
  const extraItemsList = items.filter(i => i.isExtra);

  const renderItem = (item: PackingItem, actualIdx: number, displayIdx: number) => {
    const isFilteredOut = searchTerm &&
      !matchSearchQuery(item.name, searchTerm) &&
      !matchSearchQuery(item.cluster || '', searchTerm) &&
      !(item.rawQR && matchSearchQuery(item.rawQR, searchTerm));

    if (isFilteredOut) return null;

    if (mode === 'loading') {
      const loaded = isItemLoaded(item);
      return (
        <div
          key={actualIdx}
          onClick={() => {
            if (hasRole('admin') || hasRole('mod_dg') || userProfile?.chuc_danh === 'ĐG Leader') toggleLoading(actualIdx);
          }}
          className={`bg-white rounded-lg border p-3 md:p-2.5 flex items-center gap-3 md:gap-2 transition-all hover:bg-slate-100/40 relative overflow-hidden cursor-pointer ${loaded
            ? 'hover:border-orange-200'
            : 'hover:border-indigo-100'
            }`}
        >
          {/* Accent color bar */}
          <div className={`absolute left-0 top-0 bottom-0 w-1.5 md:w-1 ${loaded ? 'bg-orange-500' : 'bg-slate-300'}`} />

          <span className="shrink-0 w-7 text-center text-xs font-black text-slate-400">{displayIdx}</span>
          <span className={`shrink-0 w-7 h-7 flex items-center rounded border ${loaded ? 'bg-orange-100 text-orange-600 border-orange-200' : 'bg-slate-100 text-slate-400 border-slate-200'}`}>
            {loaded ? <Check size={14} /> : <X size={14} />}
          </span>
          <span className="shrink-0 w-28 md:w-24 text-[10px] md:text-[9px] font-black text-indigo-600 uppercase tracking-wider truncate" title={item.cluster || 'N/A'}>{item.cluster || 'N/A'}</span>
          <span className="min-w-0 flex-1 text-base md:text-sm font-black text-slate-800 uppercase tracking-tight truncate" title={item.name}>
            {item.name.includes('#') ? <>{item.name.split('#')[0].trim()}<span className="text-indigo-500 ml-0.5">#{item.name.split('#')[1]}</span></> : item.name}
          </span>
          {item.rawQR && <span className="block text-[9px] font-mono text-slate-400 truncate mt-0.5" title={item.rawQR}>{stripQrSuffix(item.rawQR)}</span>}
          <span className="shrink-0 text-[9px] font-mono text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded truncate max-w-[180px]" title={computeRawQR(item)}>{computeRawQR(item)}</span>
          <ChevronRight size={16} className="shrink-0 text-slate-300" />
        </div>
      );
    }

    return (
      <div
        key={actualIdx}
        onClick={() => {
          setActiveCheckingIdx(actualIdx);
          setPrintSentForIdx(null);
          setIsAdminEditingItemCheck(false);
          setCurrentImageIdx(0);
        }}
        className={`mb-1 bg-white rounded-lg p-3 md:p-2.5 flex items-center gap-3 md:gap-2 transition-all hover:bg-slate-100/40 relative overflow-hidden cursor-pointer ${item.packed
          ? 'hover:border-emerald-300'
          : 'hover:border-indigo-200'
          }`}
      >
        {/* Accent color bar */}
        <div className={`absolute left-0 top-0 bottom-0 w-1.5 md:w-1 ${item.packed ? 'bg-emerald-500' : 'bg-slate-300'}`} />

        <span className="shrink-0 w-7 text-center text-xs font-black text-slate-400">{displayIdx}</span>
        <span className={`shrink-0 w-7 h-7 flex items-center rounded border ${item.packed ? 'bg-emerald-100 text-emerald-600 border-emerald-200' : 'bg-slate-100 text-slate-400 border-slate-200'}`}>
          {item.packed ? <Check size={14} /> : <X size={14} />}
        </span>
        <span className="shrink-0 w-28 md:w-24 text-[10px] md:text-[9px] font-black text-indigo-600 uppercase tracking-wider truncate" title={item.cluster || 'N/A'}>{item.cluster || 'N/A'}</span>
        <span className="min-w-0 flex-1 text-base md:text-sm font-black text-slate-800 uppercase tracking-tight truncate" title={item.name}>
          {item.name.includes('#') ? <>{item.name.split('#')[0].trim()}<span className="text-indigo-500 ml-0.5">#{item.name.split('#')[1]}</span></> : item.name}
        </span>
        {item.rawQR && <span className="block text-[9px] font-mono text-slate-400 truncate mt-0.5" title={item.rawQR}>{stripQrSuffix(item.rawQR)}</span>}
        {(() => {
          const pklCode = getItemPklCode(item);
          if (pklCode) {
            return <span className="shrink-0 text-[9px] font-bold text-orange-600 bg-orange-100 px-1.5 py-0.5 rounded uppercase">{pklCode}</span>;
          }
          return null;
        })()}
        <ChevronRight size={16} className="shrink-0 text-slate-300" />
      </div>
    );
  };

  return (
    <div className="space-y-6 pb-24 lg:pb-8">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-200 pb-2">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="p-2 hover:bg-gray-100 rounded-lg transition-all active:scale-90"
          >
            <ArrowLeft size={20} className="text-gray-600" />
          </button>
          <Layers className="text-indigo-600" size={24} />
          <div>
            <h2 className="text-xl font-black text-gray-800 uppercase tracking-tight">
              {mode === 'loading' ? t("Chi Tiết Lên Xe") : t("Chi Tiết Đóng Gói")}
            </h2>
            <p className="text-[10px] text-gray-500 font-bold uppercase tracking-widest">{t("Dự án")}: {formatProjectCode(packingList.projectCode) || t("Cá nhân")}</p>
          </div>
          <button
            onClick={() => setShowRawData(true)}
            className="ml-2 p-2 hover:bg-gray-100 rounded-lg transition-all text-gray-400 hover:text-gray-600"
            title="Xem Raw Data"
          >
            <Code size={18} />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column: List Info & Actions */}

        <div className="lg:col-span-2 space-y-6">
          {/* Div 1: Search, QR, Tabs */}
          <div className="bg-white rounded-lg border border-gray-100 shadow-sm">
            <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
              <div className="flex items-center flex-1 max-w-sm mr-4 relative">
                <input
                  type="text"
                  placeholder={`        ${t("Tìm Module hoặc Khu vực...")}`}
                  className="w-full bg-gray-100 border border-gray-200 rounded-lg pl-10 pr-4 py-3 text-sm font-bold outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all"
                  value={searchTerm}
                  onChange={e => setSearchTerm(e.target.value)}
                />
                <div className="absolute left-3 text-gray-400"><Layers size={14} /></div>
              </div>
              {!isGuest && (
              <button
                onClick={() => setShowQRScanner(true)}
                className={`p-2.5 text-white rounded-lg shadow-md transition-all hover:scale-105 active:scale-95 flex items-center gap-1.5 px-3 ${mode === 'loading'
                  ? 'bg-orange-500 hover:bg-orange-600'
                  : 'bg-indigo-600 hover:bg-indigo-700'
                  }`}
              >
                <QrCode size={18} />
                <span className="text-[10px] font-black uppercase tracking-wider hidden sm:inline">
                  {mode === 'loading' ? t("Quét Lên Xe") : t("Quét Mã")}
                </span>
              </button>
              )}
            </div>

            {/* Tab Thùng / CTHT */}
            <div className="flex border-b border-gray-100 px-3">
              <button
                onClick={() => setListTab('tatca')}
                className={`px-4 py-2.5 text-[10px] font-black uppercase tracking-widest border-b-2 transition-all ${listTab === 'tatca'
                  ? 'border-gray-700 text-gray-700'
                  : 'border-transparent text-gray-400 hover:text-gray-600'
                  }`}
              >
                {t("Tất cả")} ({totalCount})
              </button>
              <button
                onClick={() => setListTab('thung')}
                className={`px-4 py-2.5 text-[10px] font-black uppercase tracking-widest border-b-2 transition-all ${listTab === 'thung'
                  ? 'border-indigo-600 text-indigo-600'
                  : 'border-transparent text-gray-400 hover:text-gray-600'
                  }`}
              >
                {t("Kiện Module")} ({thungCount})
              </button>
              <button
                onClick={() => setListTab('ctht')}
                className={`px-4 py-2.5 text-[10px] font-black uppercase tracking-widest border-b-2 transition-all ${listTab === 'ctht'
                  ? 'border-cyan-600 text-cyan-600'
                  : 'border-transparent text-gray-400 hover:text-gray-600'
                  }`}
              >
                {t("Kiện CTHT")} ({cthtCount})
              </button>
              <button
                onClick={() => setListTab('pk')}
                className={`px-4 py-2.5 text-[10px] font-black uppercase tracking-widest border-b-2 transition-all ${listTab === 'pk'
                  ? 'border-emerald-600 text-emerald-600'
                  : 'border-transparent text-gray-400 hover:text-gray-600'
                  }`}
              >
                {t("Kiện PK")} ({pkCount})
              </button>
            </div>
          </div>

          {/* Div 2: Danh sách kiện */}
          <div className="min-h-[400px]">
            {/* Mobile: list view */}
            <div className="lg:hidden">
              {filteredItems.map(({ item, originalIndex }, idx) => renderItem(item, originalIndex, idx + 1))}
            </div>
            {/* PC: table view with dimensions & weight */}
            <div className="hidden lg:block bg-white rounded-lg border border-gray-100 shadow-sm overflow-x-auto">
              <table className="w-full text-left border-collapse min-w-[800px]">
                <thead>
                  <tr className="bg-gray-50 text-gray-500 text-[10px] font-bold uppercase tracking-wider border-b border-gray-200">
                    <th className="px-3 py-2.5 w-10 text-center">#</th>
                    <th className="px-3 py-2.5 w-10 text-center">OK</th>
                    <th className="px-3 py-2.5 min-w-[80px]">{t("Cụm")}</th>
                    <th className="px-3 py-2.5 min-w-[160px]">{t("Tên Kiện")}</th>
                    <th className="px-3 py-2.5 w-28 text-center">{t("Kích thước")}</th>
                    <th className="px-3 py-2.5 w-30 text-center">{t("Cân (Kg)")}</th>
                    <th className="px-3 py-2.5 min-w-[100px]">{t("Phiếu Lên Hàng")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filteredItems.map(({ item, originalIndex }, idx) => {
                    const isFiltered = searchTerm &&
                      !matchSearchQuery(item.name, searchTerm) &&
                      !matchSearchQuery(item.cluster || '', searchTerm) &&
                      !(item.rawQR && matchSearchQuery(item.rawQR, searchTerm));
                    if (isFiltered) return null;
                    const pQty = typeof item.packedQty === 'number' ? item.packedQty : (item.packed ? item.quantity : 0);
                    return (
                      <tr
                        key={originalIndex}
                        onClick={() => {
                          setActiveCheckingIdx(originalIndex);
                          setPrintSentForIdx(null);
                          setIsAdminEditingItemCheck(!item.packed);
                          setCurrentImageIdx(0);
                        }}
                        className={`hover:bg-slate-50 transition-colors cursor-pointer ${item.packed ? 'bg-emerald-50/30' : ''}`}
                      >
                        <td className="px-3 py-2 text-center text-[10px] font-black text-slate-400">{idx + 1}</td>
                        <td className="px-3 py-2 text-center">
                          <span className={`inline-flex w-5 h-5 items-center justify-center rounded border ${item.packed ? 'bg-emerald-100 text-emerald-600 border-emerald-200' : 'bg-slate-100 text-slate-400 border-slate-200'}`}>
                            {item.packed ? <Check size={11} /> : <X size={11} />}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <span className="text-[9px] font-black text-indigo-600 uppercase tracking-wider truncate block" title={item.cluster || 'N/A'}>{item.cluster || 'N/A'}</span>
                        </td>
                        <td className="px-3 py-2">
                          <span className="text-xs font-black text-slate-800 uppercase tracking-tight truncate block" title={item.name}>
                            {item.name.includes('#') ? <>{item.name.split('#')[0].trim()}<span className="text-indigo-500 ml-0.5">#{item.name.split('#')[1]}</span></> : item.name}
                          </span>
                          {item.rawQR && <span className="text-[9px] font-mono text-slate-400 truncate block mt-0.5" title={item.rawQR}>{stripQrSuffix(item.rawQR)}</span>}
                        </td>
                        <td className="px-3 py-2 text-center">
                          {item.w && item.d && item.h && item.w !== '0' && item.d !== '0' && item.h !== '0' ? (
                            <span className="text-[10px] font-mono font-bold text-slate-600 bg-slate-100 px-1.5 py-0.5 rounded">{item.w}x{item.d}x{item.h}</span>
                          ) : (
                            <span className="text-[10px] text-slate-300">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-center">
                          {item.weight && item.weight > 0 ? (
                            <span className="text-[10px] font-mono font-bold text-slate-600">{item.weight}</span>
                          ) : (
                            <span className="text-[10px] text-slate-300">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {(() => {
                            const pklCode = getItemPklCode(item);
                            if (pklCode) {
                              return <span className="text-[10px] font-bold text-orange-600 bg-orange-100 px-1.5 py-0.5 rounded uppercase" title={pklCode}>{pklCode}</span>;
                            }
                            return <span className="text-[10px] text-slate-300">—</span>;
                          })()}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Right Column: Items Table */}
        <div className="lg:col-span-1 space-y-6">
          <div className="bg-white rounded-lg border border-gray-100 shadow-sm">
            <div className="px-4 py-3 border-b border-gray-100">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold uppercase text-gray-700">
                  {t("Thông tin chung")}
                </h3>

                {!isGuest && (
                <div className="flex items-center gap-2">
                <button
                  onClick={handleToggleMultiUnit}
                  className={`px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-wider border transition-all flex items-center gap-1.5 cursor-pointer ${printMultiUnit
                    ? 'bg-amber-500 hover:bg-amber-600 text-white border-amber-500'
                    : 'bg-indigo-500 hover:bg-indigo-600 text-white border-indigo-500'
                    }`}
                >
                  <Pencil size={12} />
                  <span>{printMultiUnit ? t('1 căn (CODE)') : t('Nhiều căn (UNIT)')}</span>
                </button>
                <select
                  value={formTemplate}
                  onChange={(e) => handleToggleFormTemplate(e.target.value as 'mau1' | 'mau2' | 'mauBcons')}
                  className="px-3 py-1.5 text-[10px] font-black uppercase tracking-wider bg-white border border-slate-200 rounded-lg outline-none focus:border-indigo-500 cursor-pointer"
                >
                  <option value="mau1">Mẫu 1</option>
                  <option value="mau2">Mẫu 2</option>
                  <option value="mauBcons">Mẫu Bcons</option>
                </select>
                </div>
                )}
              </div>
            </div>
            <div className="p-4 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1 col-span-2 md:col-span-1">
                  <label className="text-[10px] font-bold text-gray-400 uppercase">{t("Tiến độ tổng")}</label>
                  <p className={`text-xs font-bold uppercase ${packingList.isCompleted ? 'text-emerald-500' : 'text-blue-500'}`}>
                    {sortedItems.reduce((sum, { item }) => sum + getItemPackedCount(item), 0)}/{sortedItems.reduce((sum, { item }) => sum + (item.quantity || 0), 0)} {t("KIỆN ĐÃ ĐÓNG")}
                  </p>
                </div>
                {/* <div className="space-y-1 col-span-2 md:col-span-1">
                  <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest text-orange-500">{t("Tiến độ Lên Xe")}</label>
                  <p className="text-xs font-black uppercase text-orange-600">
                    {items.filter(i => isItemLoaded(i)).length}/{items.length} {t("KIỆN ĐÃ LÊN XE")}
                  </p>
                </div> */}
                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-gray-400 uppercase">{t("Kiện Module")}</label>
                  <p className="text-xs font-bold text-gray-800">
                    {sortedItems.filter(({ item }) => !isCthtItem(item) && !isPhuKienItem(item) && item.name !== 'Phụ Kiện Kèm Theo').reduce((sum, { item }) => sum + getItemPackedCount(item), 0)}/{sortedItems.filter(({ item }) => !isCthtItem(item) && !isPhuKienItem(item) && item.name !== 'Phụ Kiện Kèm Theo').reduce((sum, { item }) => sum + (item.quantity || 0), 0)} {t("Kiện")}
                  </p>
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-gray-400 uppercase">{t("Kiện CTHT")}</label>
                  <p className="text-xs font-bold text-gray-800">
                    {sortedItems.filter(({ item }) => isCthtItem(item)).reduce((sum, { item }) => sum + getItemPackedCount(item), 0)}/{sortedItems.filter(({ item }) => isCthtItem(item)).reduce((sum, { item }) => sum + (item.quantity || 0), 0)} {t("Kiện")}
                  </p>
                </div>
                <div className="space-y-1 col-span-2">
                  <label className="text-[10px] font-bold text-gray-400 uppercase">{t("Kiện Phụ Kiện")}</label>
                  <p className="text-xs font-bold text-gray-800">
                    {sortedItems.filter(({ item }) => isPhuKienItem(item)).reduce((sum, { item }) => sum + getItemPackedCount(item), 0)}/{sortedItems.filter(({ item }) => isPhuKienItem(item)).reduce((sum, { item }) => sum + (item.quantity || 0), 0)} {t("Kiện")}
                  </p>
                </div>
                <div className="space-y-1 col-span-2">
                  <label className="text-[10px] font-bold text-gray-400 uppercase">{t("Mã dự án")}</label>
                  <p className="text-xs font-bold text-gray-800 bg-gray-100 px-2 py-0.5 rounded inline-block">{formatProjectCode(packingList.projectCode) || 'N/A'}</p>
                </div>
                <div className="space-y-1 col-span-2">
                  <label className="text-[10px] font-bold text-gray-400 uppercase">{t("Tên dự án")}</label>
                  <div className="flex flex-wrap gap-1">
                    {(() => {
                      const projectNames = new Set<string>();
                      items.forEach(item => {
                        if (item.projectName) projectNames.add(item.projectName);
                      });
                      if (projectNames.size === 0) {
                        const fallback = (projectEntries || []).find(e => e.projectCode === packingList.projectCode)?.projectName || packingList.title || 'N/A';
                        projectNames.add(fallback);
                      }
                      return Array.from(projectNames).map((name, i) => (
                        <span key={i} className="text-[11px] font-bold text-gray-800 bg-gray-100 px-2 py-0.5 rounded inline-block">
                          {name}
                        </span>
                      ));
                    })()}
                  </div>
                </div>
              </div>

              {/* TRẠM MÁY IN LIÊN KẾT (A4) */}
              <div className="pt-4 border-t border-gray-100 flex flex-col space-y-2">
                {(hasRole('admin') || hasRole('mod_dg') || userProfile?.chuc_danh === 'ĐG Leader') && (
                  <div className="grid grid-cols-2 gap-2 mb-2">
                    <button
                      onClick={() => setShowPackAccessoryModal(true)}
                      className="py-2.5 bg-indigo-100 hover:bg-indigo-100 border border-indigo-300 text-indigo-700 rounded text-[10px] font-black uppercase tracking-wider transition-all flex items-center justify-center gap-1 cursor-pointer"
                    >
                      <span>📦 {t("Đóng Phụ Kiện")}</span>
                    </button>
                    <button
                      onClick={() => setShowPackCTHTModal(true)}
                      className="py-2.5 bg-cyan-100 hover:bg-cyan-100 border border-cyan-300 text-cyan-700 rounded text-[10px] font-black uppercase tracking-wider transition-all flex items-center justify-center gap-1 cursor-pointer"
                    >
                      <span>🔩 {t("Đóng CTHT")}</span>
                    </button>
                  </div>)}
                {(hasRole('admin') || hasRole('mod_dg') || hasRole('mod_thongke')) && (
                  <>
                    <button
                      onClick={async () => {
                        await autoGenerateCTHTData(items);
                        setShowExcelEditor(true);
                      }}
                      className="w-full py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-black uppercase tracking-wider transition-all flex items-center justify-center gap-1.5 cursor-pointer"
                    >
                      <Layers size={13} />
                      <span>{t("Sửa nhanh dạng Excel")}</span>
                    </button>
                  </>
                )}

                {/* Nút In tem thùng - chỉ admin */}
                {!isGuest && (
                <button
                  onClick={async () => {
                    const enrichedItems = await autoGenerateCTHTData(items);
                    handleOpenPrintModal(enrichedItems);
                  }}
                  className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-black uppercase tracking-wider transition-all flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <span>🖨️ {t("In tem thùng")}</span>
                </button>
                )}

                {/* Nút Xuất Excel phiếu đóng gói */}
                {!isGuest && (
                <button
                  onClick={handleExportPackingExcel}
                  className="w-full py-2.5 bg-teal-600 hover:bg-teal-700 text-white rounded-lg text-xs font-black uppercase tracking-wider transition-all flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <span>📊 Xuất Excel</span>
                </button>
                )}
                {items.every(i => i.packed) && !packingList.isCompleted && (hasRole('admin') || hasRole('mod_dg') || userProfile?.chuc_danh === 'ĐG Leader') && (
                  <button
                    onClick={updateList}
                    className="w-full py-4 bg-emerald-600 text-white rounded-2xl font-black uppercase text-xs shadow-xl shadow-emerald-200 animate-bounce"
                  >
                    {t("Hoàn tất toàn bộ List")}
                  </button>
                )}
                {(hasRole('admin') || hasRole('mod_dg')) && (
                  <div className="space-y-2">
                    <div className="grid grid-cols-4 gap-2">
                      <button
                        onClick={() => setShowSyncModal(true)}
                        disabled={loading}
                        className="py-2 bg-white text-indigo-600 border border-indigo-200 rounded text-xs font-bold uppercase hover:bg-indigo-50 transition-all flex items-center justify-center gap-1 cursor-pointer disabled:opacity-50"
                      >
                        {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                        Đồng bộ
                      </button>
                      <button
                        onClick={() => { setShowDeleteByDateModal(true); setDeleteByDateSelectedIds(new Set()); }}
                        disabled={loading}
                        className="py-2 bg-white text-rose-600 border border-rose-200 rounded text-xs font-bold uppercase hover:bg-rose-50 transition-all flex items-center justify-center gap-1 cursor-pointer disabled:opacity-50"
                      >
                        <CalendarDays size={12} />
                        Xoá ngày
                      </button>
                      <button
                        onClick={handleRecalcWeight}
                        disabled={loading}
                        className="py-2 bg-white text-emerald-600 border border-emerald-200 rounded text-xs font-bold uppercase hover:bg-emerald-50 transition-all flex items-center justify-center gap-1 cursor-pointer disabled:opacity-50"
                      >
                        <Scale size={12} />
                        Cân nặng
                      </button>
                      <button
                        onClick={() => setShowDeleteConfirm(true)}
                        className="py-2 bg-white text-red-500 border border-red-200 rounded text-xs font-bold uppercase hover:bg-red-100 transition-all flex items-center justify-center gap-1 cursor-pointer"
                      >
                        <Trash2 size={12} />
                        Xoá phiếu
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Detailed Packing Check Modal */}
      {activeCheckingIdx !== null && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[200] flex items-center justify-center p-4">
          <div className={`bg-white w-full rounded-lg overflow-hidden flex flex-col max-h-[92vh] shadow-2xl border border-slate-200 transition-all ${(items[activeCheckingIdx].packed && !isAdminEditingItemCheck) ? 'max-w-md md:max-w-6xl lg:max-w-7xl' : 'max-w-lg'
            }`}>
            {items[activeCheckingIdx].packed && !isAdminEditingItemCheck ? (
              <>
                {/* Header Chỉ Xem */}
                <div className="p-5 border-b border-slate-100 bg-white flex justify-between items-center shrink-0">
                  <div className="flex-1 min-w-0 pr-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="text-base font-black text-slate-800 uppercase tracking-tight truncate leading-tight">{items[activeCheckingIdx].name}</h3>
                      <span className="text-[8px] font-black px-1.5 py-0.5 rounded-sm bg-emerald-100 text-emerald-800 border border-emerald-200 uppercase shrink-0">{t("Đã Đóng Gói")}</span>
                    </div>
                    <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-0.5">{items[activeCheckingIdx].cluster || 'Khu vực N/A'}</p>
                    <div className="flex items-center gap-3 mt-1">
                      {items[activeCheckingIdx].w && items[activeCheckingIdx].d && items[activeCheckingIdx].h && (
                        <span className="text-[10px] font-mono font-bold text-slate-600 bg-slate-100 px-2 py-0.5 rounded">{items[activeCheckingIdx].w}x{items[activeCheckingIdx].d}x{items[activeCheckingIdx].h} mm</span>
                      )}
                      {items[activeCheckingIdx].weight && (
                        <span className="text-[10px] font-mono font-bold text-slate-600 bg-slate-100 px-2 py-0.5 rounded">{items[activeCheckingIdx].weight} kg</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {(hasRole('admin') || hasRole('mod_dg')) && (
                      <button
                        onClick={() => setIsAdminEditingItemCheck(true)}
                        className="p-2 bg-slate-100 hover:bg-indigo-100 text-slate-500 hover:text-indigo-600 border border-slate-200 rounded-lg transition-all hover:scale-105 active:scale-95 flex items-center justify-center cursor-pointer"
                        title="Chỉnh sửa cấu kiện (Chỉ có Admin thấy)"
                      >
                        <Pencil size={16} />
                      </button>
                    )}
                    <button onClick={() => setActiveCheckingIdx(null)} className="p-2 text-slate-400 hover:text-rose-500 transition-colors"><X size={20} /></button>
                  </div>
                </div>

                {/* Body Chỉ Xem */}
                <div className="flex-1 overflow-y-auto p-6 space-y-6 custom-scrollbar bg-white">
                  <div className="grid grid-cols-1 md:grid-cols-12 gap-6 items-start">
                    {/* Cột Trái: Thông tin hành động & Phụ kiện */}
                    <div className="md:col-span-5 space-y-5">
                      {/* Người xác nhận / Chữ ký */}
                      {items[activeCheckingIdx].packedBy && (
                        <div className="p-4 bg-emerald-100 border border-emerald-100/80 rounded-lg space-y-1">
                          <div className="flex items-center gap-2 text-emerald-700 text-[10px] font-black uppercase tracking-widest">
                            <CheckCircle size={12} /> {t("Xác nhận bởi:")}
                          </div>
                          <p className="text-sm font-black text-slate-800">{items[activeCheckingIdx].packedBy}</p>
                        </div>
                      )}

                      {/* Số lượng chỉ xem */}
                      {/* Phụ kiện chỉ xem */}
                      {items[activeCheckingIdx].accessories && items[activeCheckingIdx].accessories.length > 0 && (
                        <div className="space-y-4 pt-2">
                          <div className="flex items-center gap-3">
                            <div className="p-1.5 bg-indigo-100 text-indigo-600 rounded-md">
                              <Inbox size={14} />
                            </div>
                            <h4 className="text-[10px] font-black text-indigo-600 uppercase tracking-widest leading-none">
                              {(() => {
                                const item = items[activeCheckingIdx];
                                const isCtht = item && item.subType === 'kienCTHT';
                                return isCtht ? 'FINISHED PANEL' : t('Phụ kiện kèm theo (Đã xác nhận)');
                              })()}
                            </h4>
                          </div>
                          <div className="bg-slate-100 rounded-lg border border-slate-200 p-4 divide-y divide-slate-100/85">
                            {items[activeCheckingIdx].accessories.map((acc, aIdx) => {
                              const matchedAccEntry = projectEntries?.find(e => e.projectCode === packingList.projectCode && (e.moduleCode || '').toLowerCase().trim() === (acc.name || '').toLowerCase().trim());
                              return (
                              <div key={aIdx} className="flex items-center justify-between py-2 first:pt-0 last:pb-0">
                                <div className="flex items-center gap-2 min-w-0">
                                  <div className="w-5 h-5 rounded-full bg-emerald-100 text-emerald-500 flex items-center justify-center shrink-0">
                                    <CheckCircle size={12} />
                                  </div>
                                  <div className="min-w-0">
                                    <span className="text-xs font-bold text-slate-700 uppercase block truncate">{acc.name}</span>
                                    {matchedAccEntry?.id && <span className="text-[8px] font-mono text-slate-400 bg-slate-100 px-1 py-0.5 rounded block mt-0.5 w-fit">ID: {matchedAccEntry.id}</span>}
                                  </div>
                                </div>
                                {!activeItemIsCtht && (
                                  <span className="text-[10px] font-black font-mono text-indigo-600 bg-indigo-100/50 px-2 py-0.5 rounded-sm shrink-0">x{acc.quantity}</span>
                                )}
                              </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Cột Phải: Hình ảnh song song (2 ảnh trái phải cùng lúc trên PC) */}
                    <div className="md:col-span-7 space-y-4 pt-4 md:pt-0">
                      <div className="flex items-center gap-3 border-b border-slate-100 pb-3">
                        <div className="p-1.5 bg-blue-100 text-blue-600 rounded-md">
                          <Camera size={14} />
                        </div>
                        <h4 className="text-[10px] font-black text-blue-600 uppercase tracking-widest leading-none">{t("Hình ảnh thực tế")}</h4>
                      </div>

                      {(() => {
                        const item = items[activeCheckingIdx];
                        const availableImages: { url: string; label: string }[] = [];
                        if (item.photos && item.photos.length > 0) {
                          item.photos.forEach((photoUrl, pIdx) => {
                            availableImages.push({ url: photoUrl, label: `Ảnh ${pIdx + 1}` });
                          });
                        } else {
                          if (item.productImageUrl) availableImages.push({ url: item.productImageUrl, label: 'Ảnh Sản phẩm' });
                          if (item.packingImageUrl) availableImages.push({ url: item.packingImageUrl, label: 'Ảnh đóng gói' });
                        }

                        return (
                          <div className="space-y-4">
                            {availableImages.length > 0 ? (
                              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                                {availableImages.map((img, idx) => (
                                  <div key={idx} className="flex flex-col space-y-1">
                                    <span className="text-[9px] font-bold text-slate-400 uppercase tracking-widest text-center">{img.label}</span>
                                    <div className="aspect-video rounded border border-slate-200 bg-slate-100 flex items-center justify-center relative group shadow-sm overflow-hidden">
                                      <img
                                        src={img.url}
                                        alt={img.label}
                                        className="w-full h-full object-cover cursor-pointer hover:scale-105 transition-all duration-300"
                                        referrerPolicy="no-referrer"
                                        onClick={() => setLightboxImageIdx(idx)}
                                      />
                                      <div className="absolute top-1.5 right-1.5 bg-emerald-500 text-white p-0.5 rounded shadow"><Check size={8} /></div>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <div className="py-12 text-center text-slate-400">
                                <ImageIcon size={32} className="mx-auto mb-2 opacity-30" />
                                <span className="text-xs font-bold uppercase tracking-wider">{t("Chưa có ảnh nào")}</span>
                              </div>
                            )}
                            {availableImages.length > 0 && (
                              <p className="text-[9px] text-slate-400 font-bold text-center uppercase tracking-wider">{t("Bấm vào ảnh để xem kích thước đầy đủ & chuyển đổi trước/sau")}</p>
                            )}
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                </div>

                {/* Footer Chỉ Xem */}
                {!isGuest && (
                <div className="p-6 bg-slate-100 border-t border-slate-100 flex space-x-3 shrink-0">
                  {printSentForIdx === activeCheckingIdx ? (
                    <div className="flex-1 py-3.5 bg-emerald-100 text-emerald-700 font-black text-[10px] uppercase rounded-lg flex items-center justify-center gap-2">
                      <CheckCircle size={14} />
                      {t("Đã gửi in")}
                    </div>
                  ) : (
                    <button
                      onClick={() => setShowPrintQtyModal(true)}
                      className="flex-1 py-3.5 bg-emerald-500 hover:bg-emerald-600 text-white font-black text-[10px] uppercase rounded-lg transition-all tracking-widest cursor-pointer flex items-center justify-center gap-2"
                    >
                      <ScanQrCode size={14} />
                      {t("In tem")}
                    </button>
                  )}
                </div>
                )}
              </>
            ) : (
              <>
                {/* Header Đang Check */}
                <div className="p-5 border-b border-slate-200 bg-white flex justify-between items-center shrink-0">
                  <div className="flex-1 min-w-0 pr-3">
                    <h3 className="text-base font-black text-slate-800 uppercase tracking-tight truncate leading-tight">{items[activeCheckingIdx].name}</h3>
                    <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-0.5">{items[activeCheckingIdx].cluster || 'Khu vực N/A'}</p>
                    <div className="flex items-center gap-3 mt-1">
                      {items[activeCheckingIdx].w && items[activeCheckingIdx].d && items[activeCheckingIdx].h && (
                        <span className="text-[10px] font-mono font-bold text-slate-600 bg-slate-100 px-2 py-0.5 rounded">{items[activeCheckingIdx].w}x{items[activeCheckingIdx].d}x{items[activeCheckingIdx].h} mm</span>
                      )}
                      {items[activeCheckingIdx].weight && (
                        <span className="text-[10px] font-mono font-bold text-slate-600 bg-slate-100 px-2 py-0.5 rounded">{items[activeCheckingIdx].weight} kg</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {activeItemIsCtht && (hasRole('admin') || hasRole('mod_dg') || userProfile?.chuc_danh === 'ĐG Leader') && (
                      <button
                        type="button"
                        onClick={() => setIsEditingCthtDraft(!isEditingCthtDraft)}
                        className={`p-2 border rounded-lg transition-all hover:scale-105 active:scale-95 flex items-center justify-center cursor-pointer ${isEditingCthtDraft
                          ? 'bg-amber-500 text-white border-amber-500 shadow-md shadow-amber-100'
                          : 'bg-slate-100 hover:bg-slate-100 text-slate-500 border-slate-200'
                          }`}
                        title="Chỉnh sửa cấu tử đóng chung (Chỉ dành cho Admin & ĐG Leader)"
                      >
                        <Pencil size={16} />
                      </button>
                    )}
                    <button onClick={() => { saveDraftChecking(activeCheckingIdx); }} className="p-2 text-slate-400 hover:text-rose-500 transition-colors">
                      <X size={20} />
                    </button>
                  </div>
                </div>

                {/* Body Đang Check */}
                <div className="flex-1 overflow-y-auto p-6 space-y-6 custom-scrollbar bg-white">
                  {/* Step 1: Accessories hoặc CTHT Edit */}
                  {(activeItemIsCtht && isEditingCthtDraft) ? (
                    <div className="space-y-4">
                      {/* Tên kiện (nhập thủ công) */}
                      <div className="space-y-1.5 p-4 bg-slate-100 border border-slate-100 rounded-lg">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{t("Sửa tên kiện CTHT")}</label>
                        <input
                          type="text"
                          value={items[activeCheckingIdx].name}
                          onChange={(e) => {
                            const next = [...items];
                            next[activeCheckingIdx].name = e.target.value;
                            setItems(next);
                          }}
                          className="w-full px-3 py-1.5 bg-white border border-slate-200 rounded-lg text-xs font-semibold text-slate-800 uppercase outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500"
                        />
                      </div>

                      {/* Tên dự án */}
                      <div className="space-y-1.5 p-4 bg-slate-100 border border-slate-100 rounded-lg">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{t("Sửa tên dự án")}</label>
                        <input
                          type="text"
                          value={items[activeCheckingIdx].projectName || ''}
                          onChange={(e) => {
                            const next = [...items];
                            next[activeCheckingIdx].projectName = e.target.value;
                            setItems(next);
                          }}
                          className="w-full px-3 py-1.5 bg-white border border-slate-200 rounded-lg text-xs font-semibold text-slate-800 uppercase outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500"
                          placeholder={t("Nhập tên dự án (ví dụ: Dự án A)")}
                        />
                      </div>

                      {/* Tên cụm */}
                      <div className="space-y-1.5 p-4 bg-slate-100 border border-slate-100 rounded-lg">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Sửa tên cụm (Area)</label>
                        <input
                          type="text"
                          value={items[activeCheckingIdx].cluster || ''}
                          onChange={(e) => {
                            const next = [...items];
                            next[activeCheckingIdx].cluster = e.target.value;
                            setItems(next);
                          }}
                          className="w-full px-3 py-1.5 bg-white border border-slate-200 rounded-lg text-xs font-semibold text-slate-800 uppercase outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500"
                          placeholder="Nhập tên cụm (ví dụ: KITCHEN, COAT)"
                        />
                      </div>

                      <div className="p-4 bg-slate-100 rounded-lg border border-slate-200 space-y-3">
                        <div className="flex items-center justify-between border-b border-slate-200 pb-2">
                          <span className="text-xs font-black text-slate-700 uppercase tracking-tight">{t("Chi tiết FINISHED PANEL")}</span>
                          <span className="text-[10px] font-mono text-cyan-600 bg-cyan-100 px-2 py-0.5 rounded-full font-bold">
                            {(items[activeCheckingIdx].accessories || []).length} loại
                          </span>
                        </div>

                        {/* Danh sách các chi tiết con */}
                        <div className="space-y-2">
                          {items[activeCheckingIdx].accessories && items[activeCheckingIdx].accessories!.length > 0 ? (
                            items[activeCheckingIdx].accessories!.map((acc, aIdx) => {
                              const matchedAccEntry = projectEntries?.find(e => e.projectCode === packingList.projectCode && (e.moduleCode || '').toLowerCase().trim() === (acc.name || '').toLowerCase().trim());
                              return (
                              <div key={aIdx} className="flex items-center justify-between bg-white p-2 rounded-lg border border-slate-100">
                                <div className="min-w-0 flex-1">
                                  <span className="text-[10px] font-black text-slate-600 uppercase truncate block max-w-[150px] sm:max-w-[180px]" title={acc.name}>
                                    {acc.name}
                                  </span>
                                  {matchedAccEntry?.id && <span className="text-[8px] font-mono text-slate-400 bg-slate-100 px-1 py-0.5 rounded block mt-0.5 w-fit">ID: {matchedAccEntry.id}</span>}
                                </div>
                                <div className="flex items-center gap-1.5 shrink-0">
                                  {/* Giảm số lượng */}
                                  <button
                                    type="button"
                                    onClick={() => {
                                      const next = [...items];
                                      const accs = [...(next[activeCheckingIdx].accessories || [])];
                                      accs[aIdx].quantity = Math.max(1, accs[aIdx].quantity - 1);
                                      next[activeCheckingIdx].accessories = accs;
                                      const dims = calculateCTHTKienDimensions(accs);
                                      if (dims.w > 0) { next[activeCheckingIdx].w = String(dims.w); next[activeCheckingIdx].d = String(dims.d); next[activeCheckingIdx].h = String(dims.h); next[activeCheckingIdx].weight = dims.weight; }
                                      setItems(next);
                                    }}
                                    className="w-6 h-6 rounded border border-slate-200 flex items-center justify-center font-black text-slate-500 hover:bg-slate-100 text-xs transition-colors"
                                  >
                                    -
                                  </button>
                                  <span className="text-[10px] font-black min-w-[20px] text-center text-slate-800 font-mono flex items-center justify-center">
                                    {acc.quantity}
                                  </span>
                                  {/* Tăng số lượng */}
                                  <button
                                    type="button"
                                    onClick={() => {
                                      const next = [...items];
                                      const accs = [...(next[activeCheckingIdx].accessories || [])];
                                      accs[aIdx].quantity = accs[aIdx].quantity + 1;
                                      next[activeCheckingIdx].accessories = accs;
                                      const dims = calculateCTHTKienDimensions(accs);
                                      if (dims.w > 0) { next[activeCheckingIdx].w = String(dims.w); next[activeCheckingIdx].d = String(dims.d); next[activeCheckingIdx].h = String(dims.h); next[activeCheckingIdx].weight = dims.weight; }
                                      setItems(next);
                                    }}
                                    className="w-6 h-6 rounded border border-slate-200 flex items-center justify-center font-black text-slate-500 hover:bg-slate-100 text-xs transition-colors"
                                  >
                                    +
                                  </button>

                                  {/* Xoá khỏi kiện */}
                                  <button
                                    type="button"
                                    onClick={() => {
                                      if (confirm(`Bạn muốn xóa chi tiết "${acc.name}" khỏi kiện này?`)) {
                                        const next = [...items];
                                        const accs = (next[activeCheckingIdx].accessories || []).filter((_, idx) => idx !== aIdx);
                                        next[activeCheckingIdx].accessories = accs;
                                        const dims = calculateCTHTKienDimensions(accs);
                                        if (dims.w > 0) { next[activeCheckingIdx].w = String(dims.w); next[activeCheckingIdx].d = String(dims.d); next[activeCheckingIdx].h = String(dims.h); next[activeCheckingIdx].weight = dims.weight; }
                                        setItems(next);
                                      }
                                    }}
                                    className="w-6 h-6 rounded bg-rose-100 hover:bg-rose-100 text-rose-600 border border-rose-100 flex items-center justify-center transition-colors ml-1"
                                    title="Xóa khỏi kiện"
                                  >
                                    <X size={12} />
                                  </button>
                                </div>
                              </div>
                              );
                            })
                          ) : (
                            <p className="text-[10px] text-slate-400 text-center font-bold uppercase py-2">Chưa có chi tiết nào được gom vào kiện này</p>
                          )}
                        </div>

                        {/* Nút hành động */}
                        <div className="flex gap-2 pt-1 border-t border-slate-200">
                          <button
                            type="button"
                            onClick={() => setScanningForCthtKienIdx(activeCheckingIdx)}
                            className="flex-1 py-1.5 bg-cyan-600 hover:bg-cyan-700 text-white rounded-lg font-black text-[9px] uppercase tracking-wider flex items-center justify-center gap-1.5 transition-all shadow-md cursor-pointer"
                          >
                            <QrCode size={12} />
                            <span>Quét QR thêm</span>
                          </button>

                          <div className="relative flex-1">
                            {addCthtManualIdx === activeCheckingIdx ? (
                              <div className="absolute bottom-full right-0 mb-2 w-56 bg-white rounded-lg shadow-xl border border-slate-200 max-h-48 overflow-y-auto z-100 p-1 divide-y divide-slate-100">
                                <div className="p-1 text-center font-black text-[9px] text-slate-400 uppercase tracking-wider">Chọn CTHT của dự án</div>
                                {allProjectCTHTs.length > 0 ? (
                                  allProjectCTHTs.map((entry, idx) => (
                                    <button
                                      key={`${entry.id}-${idx}`}
                                      type="button"
                                      onClick={() => handleAddCthtManual(entry)}
                                      className="w-full text-left p-2 hover:bg-slate-100 font-bold text-[10px] text-slate-800 uppercase truncate cursor-pointer block"
                                    >
                                      {entry.moduleCode}
                                    </button>
                                  ))
                                ) : (
                                  <div className="p-2 text-center text-[9px] text-slate-400 font-bold uppercase">Không có cấu kiện CTHT nào</div>
                                )}
                              </div>
                            ) : null}

                            <button
                              type="button"
                              onClick={() => setAddCthtManualIdx(addCthtManualIdx === activeCheckingIdx ? null : activeCheckingIdx)}
                              className="w-full py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg font-black text-[9px] uppercase tracking-wider flex items-center justify-center gap-1 transition-all border border-slate-200 cursor-pointer"
                            >
                              <span>{addCthtManualIdx === activeCheckingIdx ? 'Đóng' : 'Thêm nhanh'}</span>
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : (
                    items[activeCheckingIdx].accessories && items[activeCheckingIdx].accessories.length > 0 && (
                      <div className="space-y-4">
                        <div className="flex items-center justify-between p-5 bg-slate-100 rounded-lg border border-slate-200">
                          <div className="flex items-center space-x-3">
                            <div className="w-10 h-10 bg-white rounded-lg flex items-center justify-center text-slate-400 border border-slate-200 shadow-sm"><Save size={20} /></div>
                            <span className="text-sm font-black text-slate-700 uppercase tracking-tight">
                              {activeItemIsCtht ? t('Chi tiết FINISHED PANEL') : t('Phụ kiện kèm theo (Đã xác nhận)')}
                            </span>
                          </div>
                          <div
                            className={`w-10 h-10 rounded-lg flex items-center justify-center transition-all ${items[activeCheckingIdx].accessoryChecked ? 'bg-emerald-500 text-white shadow-xl shadow-emerald-100' : 'bg-slate-100 text-slate-300'}`}
                          >
                            <CheckCircle size={20} />
                          </div>
                        </div>
                        <div className="ml-5 pl-5 border-l border-slate-200 space-y-3">
                          {items[activeCheckingIdx].accessories.map((acc, aIdx) => {
                            const matchedAccEntry = projectEntries?.find(e => e.projectCode === packingList.projectCode && (e.moduleCode || '').toLowerCase().trim() === (acc.name || '').toLowerCase().trim());
                            return (
                            <div key={aIdx} className="flex items-center justify-between group">
                              <div className="min-w-0">
                                <span className="text-[11px] font-black text-slate-500 uppercase tracking-tight transition-colors group-hover:text-indigo-600">
                                  {acc.name} (x{acc.quantity})
                                </span>
                                {matchedAccEntry?.id && <span className="text-[8px] font-mono text-slate-400 bg-slate-100 px-1 py-0.5 rounded block mt-0.5 w-fit">ID: {matchedAccEntry.id}</span>}
                              </div>
                              <button
                                onClick={() => {
                                  const next = [...items];
                                  const accs = [...(next[activeCheckingIdx].accessories || [])];
                                  accs[aIdx].checked = !accs[aIdx].checked;
                                  next[activeCheckingIdx].accessories = accs;
                                  next[activeCheckingIdx].accessoryChecked = accs.every(a => a.checked);
                                  setItems(next);
                                }}
                                className={`w-7 h-7 rounded border flex items-center justify-center transition-all ${acc.checked ? 'bg-emerald-100 border-emerald-300 text-emerald-600 shadow-sm' : 'bg-slate-100 border-slate-200 text-slate-300'}`}
                              >
                                <CheckCircle size={16} />
                              </button>
                            </div>
                            );
                          })}
                        </div>
                      </div>
                    )
                  )}

                  {/* Step 2: Upload Multiple Photos */}
                  {!isGuest && (
                  <div className="space-y-5 pt-4">
                    <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                      <div className="flex items-center gap-3">
                        <div className="p-1.5 bg-blue-100 text-blue-600 rounded-md">
                          <Camera size={14} />
                        </div>
                        <h4 className="text-[10px] font-black text-blue-600 uppercase tracking-widest leading-none">{t("Ảnh xác nhận đóng gói (Tối thiểu 3 ảnh)")}</h4>
                      </div>
                      {items[activeCheckingIdx].photos && items[activeCheckingIdx].photos!.length > 0 && (
                        <button
                          type="button"
                          onClick={() => {
                            if (confirm("Bạn muốn xóa toàn bộ ảnh hiện tại?")) {
                              const next = [...items];
                              next[activeCheckingIdx].photos = [];
                              next[activeCheckingIdx].productImageUrl = '';
                              next[activeCheckingIdx].packingImageUrl = '';
                              setItems(next);
                            }
                          }}
                          className="text-[9px] font-black text-rose-600 hover:underline uppercase cursor-pointer"
                        >
                          {t("Xóa hết ảnh")}
                        </button>
                      )}
                    </div>

                    <div className="space-y-4">
                      {/* Upload Button Triggers */}
                      <input
                        type="file"
                        id="multi-photo-uploader"
                        accept="image/*"
                        multiple
                        className="hidden"
                        onChange={(e) => {
                          if (e.target.files && e.target.files.length > 0) {
                            onPhotosCapturedMultiple(e.target.files);
                          }
                        }}
                      />

                      {uploading ? (
                        <div className="w-full py-8 border border-dashed border-indigo-200 bg-indigo-100/20 rounded-lg flex flex-col items-center justify-center animate-pulse">
                          <Loader2 size={32} className="animate-spin text-indigo-600 mb-2" />
                          <span className="text-xs font-bold text-indigo-600 uppercase tracking-wider">{uploadProgress || 'Đang tải ảnh lên...'}</span>
                        </div>
                      ) : (
                        <label
                          htmlFor="multi-photo-uploader"
                          className="w-full flex flex-col items-center justify-center p-6 border-2 border-dashed border-slate-200 rounded-lg hover:border-indigo-500 hover:bg-slate-100 cursor-pointer transition-all gap-2"
                        >
                          <Camera size={32} className="text-slate-400 mb-1" />
                          <span className="text-xs font-black text-slate-800 uppercase tracking-widest">
                            {items[activeCheckingIdx].photos && items[activeCheckingIdx].photos!.length > 0 ? t('Thêm / Thay đổi ảnh (Chọn từ 3 ảnh)') : t('Chụp / Chọn ảnh đóng gói (Tối thiểu 3 ảnh)')}
                          </span>
                          <span className="text-[10px] text-slate-400 italic text-center">
                            Bạn có thể dùng máy ảnh chụp trực tiếp hoặc chọn nhiều ảnh từ dải Gallery
                          </span>
                        </label>
                      )}

                      {/* Photo Previews */}
                      {(() => {
                        const item = items[activeCheckingIdx];
                        const isCthtItem = item.subType === 'kienCTHT';
                        console.log('[Photo Debug]', { name: item.name, subType: item.subType, isCthtItem, photosCount: item.photos?.length, productImageUrl: item.productImageUrl, packingImageUrl: item.packingImageUrl });
                        const displayPhotos = isCthtItem
                          ? (item.photos || [])
                          : (item.photos && item.photos.length > 0 ? item.photos : [item.productImageUrl, item.packingImageUrl].filter(Boolean) as string[]);

                        if (displayPhotos.length > 0) {
                          return (
                            <div className="space-y-2">
                              <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Danh sách ảnh đã chọn ({displayPhotos.length}):</span>
                              <div className="grid grid-cols-3 gap-3">
                                {displayPhotos.map((photoUrl, pIdx) => (
                                  <div key={pIdx} className="relative aspect-square rounded-lg border border-slate-200 bg-slate-100 overflow-hidden group">
                                    <img
                                      src={photoUrl}
                                      alt={`Preview ${pIdx + 1}`}
                                      className="w-full h-full object-cover cursor-pointer hover:opacity-90 transition-opacity"
                                      referrerPolicy="no-referrer"
                                      onClick={() => setLightboxImageIdx(pIdx)}
                                    />
                                    <div className="absolute top-1 right-1 bg-emerald-500 text-white p-0.5 rounded-lg shadow"><Check size={8} /></div>

                                    {/* Nút Xóa Ảnh Đơn Lẻ */}
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        if (confirm("Bạn có chắc chắn muốn xóa bức ảnh này?")) {
                                          const next = [...items];
                                          const currentPhotos = next[activeCheckingIdx].photos || [];
                                          const nextPhotos = currentPhotos.filter((_, idx) => idx !== pIdx);
                                          next[activeCheckingIdx].photos = nextPhotos;
                                          if (nextPhotos.length > 0) {
                                            next[activeCheckingIdx].productImageUrl = nextPhotos[0];
                                          } else {
                                            next[activeCheckingIdx].productImageUrl = '';
                                          }
                                          if (nextPhotos.length > 1) {
                                            next[activeCheckingIdx].packingImageUrl = nextPhotos[1];
                                          } else {
                                            next[activeCheckingIdx].packingImageUrl = '';
                                          }
                                          setItems(next);
                                        }
                                      }}
                                      className="absolute top-1 left-1 bg-rose-600/95 hover:bg-rose-700 text-white p-1 rounded-lg shadow-md cursor-pointer transition-all hover:scale-110 active:scale-95 z-10"
                                      title={t("Xóa ảnh này")}
                                    >
                                      <X size={10} />
                                    </button>

                                    <span className="absolute bottom-1 right-1 bg-black/60 text-white text-[8px] font-bold px-1.5 py-0.5 rounded-lg uppercase">Ảnh {pIdx + 1}</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          );
                        }
                        return null;
                      })()}
                    </div>
                  </div>
                  )}

                </div>

                {items[activeCheckingIdx].packedBy && (
                  <div className="px-6 py-2.5 bg-emerald-100 border-t border-emerald-100">
                    <p className="text-[10px] font-black text-emerald-600 uppercase tracking-widest text-center flex items-center justify-center gap-2">
                      <CheckCircle size={10} /> {t("Xác nhận bởi:")} {items[activeCheckingIdx].packedBy}
                    </p>
                  </div>
                )}

                {!isGuest && (
                <div className="p-6 bg-slate-100 border-t border-slate-100 flex space-x-3 shrink-0">
                  {printSentForIdx === activeCheckingIdx ? (
                    <div className="flex-1 py-3.5 bg-emerald-100 text-emerald-700 font-black text-[10px] uppercase rounded-lg flex items-center justify-center gap-2">
                      <CheckCircle size={14} />
                      {t("Đã gửi in")}
                    </div>
                  ) : (
                    <button
                      onClick={() => setShowPrintQtyModal(true)}
                      className="flex-1 py-3.5 bg-emerald-500 hover:bg-emerald-600 text-white font-black text-[10px] uppercase rounded-lg transition-all tracking-widest cursor-pointer flex items-center justify-center gap-2"
                    >
                      <ScanQrCode size={14} />
                      {t("In tem")}
                    </button>
                  )}
                  {items[activeCheckingIdx].packed ? (
                    <button
                      onClick={async () => {
                        const next = [...items];
                        const oldItem = next[activeCheckingIdx];
                        next[activeCheckingIdx].packed = false;
                        next[activeCheckingIdx].packedQty = 0;
                        next[activeCheckingIdx].packedBy = undefined;
                        next[activeCheckingIdx].packedAt = undefined;
                        setItems(next);
                        setActiveCheckingIdx(null);
                        setIsAdminEditingItemCheck(false);

                        setLoading(true);
                        try {
                          const allPacked = next.every(i => i.packed);
                          await updateDoc(doc(db, 'packing', packingList.id), {
                            items: cleanUndefinedFields(next),
                            isCompleted: allPacked
                          });

                          // Đồng bộ ngược trạng thái về QC Pass
                          const matchedEntry = projectEntries ? projectEntries.find(e => e.id === oldItem.id || (e.moduleCode || '').toLowerCase() === (oldItem.name || '').toLowerCase()) : undefined;
                          if (matchedEntry) {
                            const nextHistory = [...(matchedEntry.statusHistory || [])];
                            const newStatus = 'QC Pass';
                            if (!nextHistory.length || nextHistory[nextHistory.length - 1].split('|')[0] !== newStatus) {
                              nextHistory.push(`${newStatus}|${Date.now()}`);
                            }
                            await updateProjectModule(matchedEntry.id, {
                              status: newStatus,
                              statusHistory: nextHistory
                            }, matchedEntry.projectCode);
                          }
                        } catch (err) {
                          console.error(err);
                        } finally {
                          setLoading(false);
                        }
                      }}
                      className="flex-1 py-3.5 bg-rose-100 text-rose-600 border border-rose-200 rounded-lg font-black uppercase text-[10px] tracking-widest transition-all active:scale-95 cursor-pointer"
                    >
                      {t("Huỷ Trạng Thái")}
                    </button>
                  ) : (
                    <>
                      <button
                        onClick={() => {
                          saveDraftChecking(activeCheckingIdx);
                        }}
                        className="flex-1 py-3.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-black uppercase text-[10px] tracking-widest shadow-xl shadow-indigo-100 transition-all active:scale-95 cursor-pointer"
                      >
                        {t("Lưu Nháp & Thoát")}
                      </button>
                      {(() => {
                        const item = items[activeCheckingIdx];
                        const needsAccCheck = item.accessories && item.accessories.length > 0;
                        const accOk = !needsAccCheck || (item.accessories?.every(a => a.checked) && item.accessoryChecked);
                        const isCtht = item && item.subType === 'kienCTHT';

                        const hasPhotos = item.photos && item.photos.length >= 3;
                        const hasOldPhotos = isCtht ? !!item.packingImageUrl : (!!item.productImageUrl && !!item.packingImageUrl);
                        const photosOk = hasPhotos || hasOldPhotos;

                        if (accOk && photosOk) {
                          return (
                            <button
                              onClick={() => {
                                finishItemChecking(activeCheckingIdx);
                                setIsAdminEditingItemCheck(false);
                              }}
                              className="flex-1 py-3.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-black uppercase text-[10px] tracking-widest shadow-xl shadow-emerald-100 transition-all active:scale-95 cursor-pointer"
                            >
                              Xác nhận hoàn tất
                            </button>
                          );
                        }
                        return (
                          <div className="flex-1 py-3.5 bg-slate-200 text-slate-400 border border-transparent rounded-lg font-black uppercase text-[9px] tracking-widest flex items-center justify-center text-center leading-tight">
                            {t("CHƯA ĐỦ ĐIỀU KIỆN")}
                          </div>
                        );
                      })()}
                    </>
                  )}
                </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Lightbox Modal */}
      {lightboxImageIdx !== null && activeCheckingIdx !== null && (
        (() => {
          const item = items[activeCheckingIdx];
          const availableImages: { url: string; label: string }[] = [];
          if (item.photos && item.photos.length > 0) {
            item.photos.forEach((photoUrl, pIdx) => {
              availableImages.push({ url: photoUrl, label: `Ảnh ${pIdx + 1}` });
            });
          } else {
            if (item.productImageUrl) availableImages.push({ url: item.productImageUrl, label: 'Ảnh Sản phẩm' });
            if (item.packingImageUrl) availableImages.push({ url: item.packingImageUrl, label: 'Ảnh đóng gói' });
          }

          if (availableImages.length === 0 || lightboxImageIdx >= availableImages.length || lightboxImageIdx < 0) return null;

          const currentImg = availableImages[lightboxImageIdx];

          return (
            <div
              className="fixed inset-0 bg-black/95 z-[350] flex flex-col items-center justify-center p-4 text-white select-none"
              onClick={() => setLightboxImageIdx(null)}
            >
              {/* Top bar */}
              <div className="absolute top-0 left-0 right-0 p-5 flex justify-between items-center bg-gradient-to-b from-black/60 to-transparent">
                <div className="min-w-0 pr-4">
                  <span className="text-[10px] font-black uppercase tracking-widest px-2.5 py-1 rounded bg-white/10">{currentImg.label}</span>
                  <h4 className="text-sm font-black uppercase mt-1 truncate max-w-[280px] md:max-w-md">{item.name}</h4>
                </div>
                <button
                  onClick={() => setLightboxImageIdx(null)}
                  className="p-2 bg-white/10 hover:bg-rose-600 rounded-full text-white transition-all hover:scale-105 active:scale-95"
                >
                  <X size={24} />
                </button>
              </div>

              {/* Center Image */}
              <div className="relative max-w-4xl max-h-[75vh] w-full flex items-center justify-center p-2" onClick={(e) => e.stopPropagation()}>
                <img
                  src={currentImg.url}
                  alt={currentImg.label}
                  className="max-w-full max-h-[75vh] object-contain rounded-md shadow-2xl border border-white/5 animate-fade-in"
                  referrerPolicy="no-referrer"
                />

                {/* Previous / Next buttons */}
                {availableImages.length > 1 && (
                  <>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setLightboxImageIdx(prev => {
                          if (prev === null) return null;
                          return prev === 0 ? availableImages.length - 1 : prev - 1;
                        });
                      }}
                      className="absolute left-4 top-1/2 -translate-y-1/2 w-12 h-12 rounded-full bg-black/70 hover:bg-black/90 text-white flex items-center justify-center transition-all hover:scale-110 active:scale-95 border border-white/10 shadow-lg cursor-pointer"
                      title="Ảnh trước"
                    >
                      <ChevronLeft size={24} />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setLightboxImageIdx(prev => {
                          if (prev === null) return null;
                          return prev === availableImages.length - 1 ? 0 : prev + 1;
                        });
                      }}
                      className="absolute right-4 top-1/2 -translate-y-1/2 w-12 h-12 rounded-full bg-black/70 hover:bg-black/90 text-white flex items-center justify-center transition-all hover:scale-110 active:scale-95 border border-white/10 shadow-lg cursor-pointer"
                      title="Ảnh sau"
                    >
                      <ChevronRight size={24} />
                    </button>
                  </>
                )}
              </div>

              {/* Bottom indicator */}
              <div className="absolute bottom-6 text-xs text-white/60 font-mono tracking-widest font-black uppercase">
                {lightboxImageIdx + 1} / {availableImages.length}
              </div>
            </div>
          );
        })()
      )}
      {/* Loading Confirmation Modal */}
      {loadingConfirmIdx !== null && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[110] flex items-center justify-center p-4">
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-white w-full max-w-sm rounded-lg shadow-2xl overflow-hidden border border-slate-200"
          >
            <div className="p-8 text-center space-y-7">
              <div className={`w-20 h-20 rounded-lg flex items-center justify-center mx-auto transition-all ${isItemLoaded(items[loadingConfirmIdx]) ? 'bg-rose-100 text-rose-500 border border-rose-100' : 'bg-orange-100 text-orange-500 border border-orange-100 shadow-xl shadow-orange-100'}`}>
                <Truck size={40} />
              </div>
              <div className="space-y-2">
                <h3 className="text-xl font-black text-slate-800 uppercase tracking-tight leading-none px-4">
                  {isItemLoaded(items[loadingConfirmIdx]) ? 'Xác nhận hạ xe?' : 'Xác nhận lên xe?'}
                </h3>
                <div className={`h-1 w-12 mx-auto rounded-full ${isItemLoaded(items[loadingConfirmIdx]) ? 'bg-rose-500' : 'bg-orange-500'}`}></div>
              </div>

              <div className="bg-slate-100 p-5 rounded-lg border border-slate-100 space-y-2">
                <p className="text-sm font-black text-slate-800 uppercase tracking-tight">{items[loadingConfirmIdx].name}</p>
                <div className="flex items-center justify-center gap-2">
                  <span className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">{items[loadingConfirmIdx].cluster || 'Dữ liệu dự án'}</span>
                  <span className="w-1 h-1 bg-slate-300 rounded-full"></span>
                  <span className="text-[10px] text-indigo-600 font-black uppercase tracking-widest">Số lượng: {items[loadingConfirmIdx].quantity}</span>
                </div>
              </div>

              <div className="flex bg-slate-100 border-t border-slate-100 pt-5 space-x-3 mt-4 -mx-4 -mb-8 p-5">
                <button
                  onClick={() => setLoadingConfirmIdx(null)}
                  className="px-6 py-3.5 text-slate-600 font-black text-[10px] uppercase border border-slate-200 bg-white hover:bg-slate-100 rounded-lg transition-all tracking-widest"
                >
                  Bỏ qua
                </button>
                <button
                  onClick={() => {
                    if (isItemLoaded(items[loadingConfirmIdx!])) {
                      const newItems = [...items];
                      newItems[loadingConfirmIdx!].loaded = false;
                      newItems[loadingConfirmIdx!].loadedBy = undefined;
                      setItems(newItems);
                      setLoadingConfirmIdx(null);
                    } else {
                      confirmLoading(loadingConfirmIdx!);
                    }
                  }}
                  className={`flex-1 py-3.5 text-white rounded-lg font-black uppercase tracking-widest text-xs transition-all shadow-xl active:scale-95 ${isItemLoaded(items[loadingConfirmIdx]) ? 'bg-rose-600 hover:bg-rose-700 shadow-rose-100' : 'bg-orange-500 hover:bg-orange-600 shadow-orange-100'}`}
                >
                  {isItemLoaded(items[loadingConfirmIdx]) ? 'Hạ xe ngay' : 'Lên xe ngay'}
                </button>
              </div>
            </div>
          </motion.div>
        </div>
      )}

      {/* Scan Error Message Modal */}
      {scanErrorMessage && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[115] flex items-center justify-center p-4">
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-white w-full max-w-sm rounded-lg shadow-2xl overflow-hidden border border-slate-200"
          >
            <div className="p-8 text-center space-y-6">
              <div className="w-20 h-20 rounded-lg bg-rose-100 text-rose-500 border border-rose-100 flex items-center justify-center mx-auto">
                <X size={40} />
              </div>
              <div className="space-y-2">
                <h3 className="text-xl font-black text-slate-800 uppercase tracking-tight">
                  Thông báo quét mã
                </h3>
                <div className="h-1 w-12 mx-auto bg-rose-500 rounded-full"></div>
              </div>
              <p className="text-sm font-black text-slate-500 leading-relaxed uppercase tracking-tight">
                {scanErrorMessage}
              </p>

              <button
                onClick={() => setScanErrorMessage(null)}
                className="w-full py-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-black uppercase text-[11px] tracking-widest shadow-xl shadow-indigo-100 active:scale-95 transition-all"
              >
                Đã hiểu
              </button>
            </div>
          </motion.div>
        </div>
      )}

      {/* Unified Camera UI - Obsolete - Replaced by multi-photo uploader */}
      {checkingType && null}

      {/* Packing Excel Editor Overlay */}
      {showExcelEditor && (
        <PackingExcelEditorModal
          packingList={{ ...packingList, items: items }}
          projectEntries={projectEntries}
          pklLists={pklLists}
          unpackedCTHTs={unpackedCTHTs}
          onClose={() => setShowExcelEditor(false)}
          onItemsChange={(updatedItems) => setItems(updatedItems)}
          onSave={async (updatedItems) => {
            if (!user || !packingList.id) return;
            setLoading(true);
            try {
              const displayLabel = userProfile?.ten_that ? `${userProfile.ten_that} (${userProfile.chuc_danh || 'NV'})` : (user?.displayName || 'Anonymous');

              const finalItems = updatedItems.map(item => {
                if (item.packed && !item.packedAt) {
                  return { ...item, packedAt: Date.now() };
                } else if (!item.packed) {
                  const { packedAt, ...rest } = item;
                  return rest;
                }
                return item;
              });

              const allPacked = finalItems.every(i => i.packed);

              await updateDoc(doc(db, 'packing', packingList.id), {
                items: cleanUndefinedFields(finalItems),
                isCompleted: allPacked
              });

              // Apply updated items to react local state immediately so UI changes
              setItems(finalItems);

              // Chỉ update instances có packStatus thay đổi
              const projectId = packingList.projectCode || '';
              const changedModuleIds = new Set<string>();

              for (const newItem of finalItems) {
                const oldItem = items.find(i => i.id === newItem.id && i.instanceIndex === newItem.instanceIndex);
                // Chỉ xử lý nếu packed bị thay đổi
                if (oldItem && oldItem.packed !== newItem.packed && newItem.id) {
                  const rawId = newItem.id;
                  const moduleId = rawId.includes('_') ? rawId.split('_')[0] : rawId;
                  if (moduleId && !moduleId.startsWith('ctht-')) {
                    changedModuleIds.add(moduleId);
                  }
                }
              }

              if (changedModuleIds.size > 0) {
                const moduleUpdates = new Map<string, { instances: any[]; projectCode: string }>();

                for (const moduleId of changedModuleIds) {
                  try {
                    const instConfigId = await findProjectConfigId(projectId);
                    if (!instConfigId) continue;
                    const instDoc = await getDoc(doc(db, 'projectConfigs', instConfigId, 'modules', moduleId));
                    if (!instDoc.exists()) continue;

                    const instances = getModuleInstances(instDoc.data() as ProjectEntry);
                    const updatedInstances = instances.map((inst: any) => {
                      const matchedItem = finalItems.find(i => {
                        if (!i.id) return false;
                        const iModuleId = i.id.includes('_') ? i.id.split('_')[0] : i.id;
                        if (iModuleId !== moduleId) return false;
                        if (i.instanceIndex != null) return inst.instanceIndex === i.instanceIndex;
                        if (instances.length === 1) return true;
                        return false;
                      });

                      if (matchedItem) {
                        const newStatus = matchedItem.packed ? 'done' : 'pending';
                        if (inst.packStatus !== newStatus) {
                          const updated: any = { ...inst, packStatus: newStatus };
                          // Khi chuyển sang done, tự động set qcPack pending
                          if (newStatus === 'done' && (!inst.qcPack || inst.qcPack.status === 'none')) {
                            updated.qcPack = {
                              status: 'pending',
                              by: displayLabel,
                              date: new Date(),
                              notes: '',
                              photos: [],
                            };
                          }
                          return updated;
                        }
                      }
                      return inst;
                    });

                    const anyChanged = updatedInstances.some((inst, i) => inst.packStatus !== instances[i].packStatus);
                    if (anyChanged) {
                      moduleUpdates.set(moduleId, { instances: updatedInstances, projectCode: projectId });
                    }
                  } catch (err) {
                    console.error('Lỗi cập nhật packStatus:', err);
                  }
                }

                for (const [moduleId, data] of moduleUpdates) {
                  try {
                    await updateProjectModule(moduleId, { instances: data.instances }, data.projectCode);
                  } catch (err) {
                    console.error('Lỗi ghi packStatus:', err);
                  }
                }
              }

              await addDoc(collection(db, 'activities'), {
                userId: user.uid,
                userName: displayLabel,
                userEmail: user.email,
                action: 'Cập nhật Excel Đóng gói',
                details: `Cập nhật nhanh Excel danh sách cấu kiện: ${packingList.title}`,
                projectCode: packingList.projectCode || '',
                timestamp: serverTimestamp()
              });
            } catch (error: any) {
              handleFirestoreError(error, OperationType.UPDATE, 'packing');
            } finally {
              setLoading(false);
            }
          }}
        />
      )}

      {/* Sync Modal - Xác nhận đồng bộ từ dự án */}
      {showSyncModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
          <div className="bg-white w-full max-w-sm rounded-lg shadow-2xl overflow-hidden flex flex-col border border-slate-200">
            <div className="p-5 border-b border-slate-100 bg-white flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-indigo-100 text-indigo-600 rounded-lg flex items-center justify-center">
                  <RefreshCw size={20} />
                </div>
                <div>
                  <h3 className="text-sm font-black text-slate-800 uppercase tracking-tight">Đồng bộ từ dự án</h3>
                  <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">
                    {formatProjectCode(packingList.projectCode || '')}
                  </p>
                </div>
              </div>
              <button onClick={() => setShowSyncModal(false)} className="p-2 text-slate-400 hover:text-rose-500 transition-colors"><X size={20} /></button>
            </div>

            <div className="p-5 space-y-3">
              <div className="bg-indigo-50 border border-indigo-100 rounded-lg p-3 text-xs text-indigo-800 font-semibold leading-relaxed">
                <p className="font-extrabold uppercase text-[10px] mb-1">Nội dung đồng bộ:</p>
                <ul className="list-disc list-inside space-y-0.5">
                  <li>Cập nhật kích thước (W, D, H) từ dữ liệu dự án</li>
                  <li>Thêm kiện mới nếu thiếu trong phiếu</li>
                  <li>Giữ nguyên trạng thái đóng gói, hình ảnh, QC</li>
                </ul>
              </div>
            </div>

            <div className="p-4 border-t border-slate-100 bg-slate-50 flex gap-2">
              <button
                onClick={() => setShowSyncModal(false)}
                className="flex-1 py-3 bg-slate-200 text-slate-600 rounded-lg font-black uppercase text-[10px] tracking-widest hover:bg-slate-300 transition-all"
              >
                Hủy
              </button>
              <button
                onClick={handleSyncPackingList}
                disabled={loading}
                className="flex-1 py-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-black uppercase text-[10px] tracking-widest transition-all flex items-center justify-center gap-1.5 disabled:opacity-50"
              >
                {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                Đồng bộ ngay
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete By Date Modal */}
      {showDeleteByDateModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
          <div className="bg-white w-full max-w-lg rounded-lg shadow-2xl overflow-hidden flex flex-col border border-slate-200 max-h-[85vh]">
            <div className="p-4 border-b border-slate-100 bg-white flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-rose-100 text-rose-600 rounded-lg flex items-center justify-center">
                  <CalendarDays size={20} />
                </div>
                <div>
                  <h3 className="text-sm font-black text-slate-800 uppercase tracking-tight">Xoá kiện theo ngày</h3>
                  <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">
                    Chọn ngày và xoá các kiện được thêm ngày đó
                  </p>
                </div>
              </div>
              <button onClick={() => { setShowDeleteByDateModal(false); setDeleteByDateSelectedIds(new Set()); }} className="p-2 text-slate-400 hover:text-rose-500 transition-colors"><X size={20} /></button>
            </div>

            <div className="p-4 border-b border-slate-100 bg-slate-50">
              <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-1.5">Chọn ngày đóng gói</label>
              <input
                type="date"
                value={deleteByDate}
                onChange={e => { setDeleteByDate(e.target.value); setDeleteByDateSelectedIds(new Set()); }}
                className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm font-bold text-slate-700 outline-none focus:ring-2 focus:ring-rose-500/20 focus:border-rose-500 transition-all"
              />
              {deleteByDate && (() => {
                const matchedItems = items.filter(item => {
                  if (!item.createdAt) return false;
                  const d = new Date(item.createdAt);
                  return d.toISOString().slice(0, 10) === deleteByDate;
                });
                return (
                  <p className="text-[10px] font-bold text-slate-400 mt-2 uppercase tracking-widest">
                    Tìm thấy {matchedItems.length} kiện
                    {deleteByDateSelectedIds.size > 0 && ` — Đã chọn ${deleteByDateSelectedIds.size}`}
                  </p>
                );
              })()}
            </div>

            <div className="flex-1 overflow-y-auto p-2 min-h-[200px] max-h-[50vh]">
              {!deleteByDate ? (
                <div className="py-12 text-center text-slate-400">
                  <CalendarDays size={36} className="mx-auto mb-2 opacity-20" />
                  <p className="text-xs font-bold uppercase tracking-widest">Chọn ngày để hiển thị danh sách kiện</p>
                </div>
              ) : (() => {
                const matchedItems = items.filter(item => {
                  if (!item.createdAt) return false;
                  const d = new Date(item.createdAt);
                  return d.toISOString().slice(0, 10) === deleteByDate;
                });

                if (matchedItems.length === 0) {
                  return (
                    <div className="py-12 text-center text-slate-400">
                      <Inbox size={36} className="mx-auto mb-2 opacity-20" />
                      <p className="text-xs font-bold uppercase tracking-widest">Không có kiện nào đóng gói ngày này</p>
                    </div>
                  );
                }

                return (
                  <div className="space-y-1">
                    <div className="flex items-center justify-between px-2 py-1">
                      <span className="text-[10px] font-black text-slate-400 uppercase">Chọn tất cả ({matchedItems.length})</span>
                      <button
                        onClick={() => {
                          const allSelected = matchedItems.every(i => deleteByDateSelectedIds.has(i.id || i.name));
                          if (allSelected) {
                            setDeleteByDateSelectedIds(new Set());
                          } else {
                            setDeleteByDateSelectedIds(new Set(matchedItems.map(i => i.id || i.name)));
                          }
                        }}
                        className="text-[10px] font-bold text-rose-600 hover:underline cursor-pointer"
                      >
                        {matchedItems.every(i => deleteByDateSelectedIds.has(i.id || i.name)) ? 'Bỏ chọn' : 'Chọn tất cả'}
                      </button>
                    </div>
                    {matchedItems.map(item => {
                      const isSelected = deleteByDateSelectedIds.has(item.id || item.name);
                      return (
                        <button
                          key={item.id || item.name}
                          onClick={() => {
                            const key = item.id || item.name;
                            const next = new Set(deleteByDateSelectedIds);
                            if (next.has(key)) next.delete(key); else next.add(key);
                            setDeleteByDateSelectedIds(next);
                          }}
                          className={`w-full flex items-center gap-3 p-2.5 rounded-lg border transition-all text-left ${
                            isSelected
                              ? 'bg-rose-50 border-rose-300'
                              : 'bg-white border-slate-200 hover:border-slate-300'
                          }`}
                        >
                          <div className={`w-5 h-5 rounded flex items-center justify-center border ${
                            isSelected ? 'bg-rose-500 border-rose-500' : 'border-slate-300'
                          }`}>
                            {isSelected && <Check size={12} className="text-white" />}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className={`text-xs font-bold uppercase truncate ${isSelected ? 'text-rose-700' : 'text-slate-700'}`}>
                              {item.name}
                            </p>
                            <div className="flex items-center gap-2 mt-0.5">
                              {item.subType && (
                                <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
                                  item.subType === 'kienModule' ? 'bg-blue-100 text-blue-600' :
                                  item.subType === 'kienCTHT' ? 'bg-purple-100 text-purple-600' :
                                  'bg-orange-100 text-orange-600'
                                }`}>
                                  {item.subType === 'kienModule' ? 'Module' : item.subType === 'kienCTHT' ? 'CTHT' : 'PK'}
                                </span>
                              )}
                              {item.packed && <span className="text-[9px] font-bold text-emerald-600">Đã đóng gói</span>}
                            </div>
                          </div>
                          <Trash2 size={14} className={`${isSelected ? 'text-rose-500' : 'text-slate-300'} shrink-0`} />
                        </button>
                      );
                    })}
                  </div>
                );
              })()}
            </div>

            <div className="p-4 border-t border-slate-100 bg-slate-50 flex gap-2">
              <button
                onClick={() => { setShowDeleteByDateModal(false); setDeleteByDateSelectedIds(new Set()); }}
                className="flex-1 py-3 bg-slate-200 text-slate-600 rounded-lg font-black uppercase text-[10px] tracking-widest hover:bg-slate-300 transition-all"
              >
                Đóng
              </button>
              <button
                onClick={handleDeleteByDate}
                disabled={loading || deleteByDateSelectedIds.size === 0}
                className="flex-1 py-3 bg-red-600 hover:bg-red-700 text-white rounded-lg font-black uppercase text-[10px] tracking-widest transition-all flex items-center justify-center gap-1.5 disabled:opacity-50"
              >
                {loading ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                Xoá {deleteByDateSelectedIds.size > 0 ? `${deleteByDateSelectedIds.size} kiện` : ''}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Overlay */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[100] flex items-center justify-center p-6">
          <div className="bg-white rounded-3xl w-full max-w-xs p-6 shadow-2xl relative overflow-hidden">
            <div className="absolute top-0 left-0 w-full h-2 bg-red-500"></div>
            <div className="mb-6 text-center">
              <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <Trash2 size={32} className="text-red-600" />
              </div>
              <h3 className="text-lg font-black text-gray-800 uppercase tracking-tight mb-2">Xác nhận xoá?</h3>
              <p className="text-sm text-gray-500 leading-relaxed font-medium">Bạn có chắc muốn xoá Packing List này không? Hành động này không thể hoàn tác.</p>
            </div>
            <div className="flex flex-col space-y-3">
              <button
                onClick={deleteList}
                disabled={loading}
                className="w-full py-4 bg-red-600 text-white rounded-2xl font-black uppercase tracking-widest text-xs shadow-lg active:scale-95 disabled:opacity-100 flex items-center justify-center"
              >
                {loading ? <Loader2 size={18} className="animate-spin" /> : 'Đồng ý xoá'}
              </button>
              <button
                onClick={() => setShowDeleteConfirm(false)}
                disabled={loading}
                className="w-full py-4 bg-gray-100 text-gray-600 rounded-2xl font-black uppercase tracking-widest text-xs active:scale-95 disabled:opacity-100"
              >
                Huỷ bỏ
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal Đóng Kiện Phụ Kiện */}
      {showPackAccessoryModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[250] flex items-center justify-center p-4">
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-white w-full max-w-xl rounded-lg overflow-hidden flex flex-col max-h-[92vh] shadow-2xl border border-slate-200"
          >
            {/* Header */}
            <div className="p-5 border-b border-slate-100 bg-white flex justify-between items-center shrink-0">
              <div>
                <h3 className="text-base font-black text-slate-800 uppercase tracking-tight">Đóng Kiện Phụ Kiện</h3>
                <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest mt-0.5">Dự án: {formatProjectCode(packingList.projectCode)}</p>
              </div>
              <button
                onClick={() => setShowPackAccessoryModal(false)}
                className="p-1.5 hover:bg-slate-100 rounded-full transition-colors text-slate-400"
              >
                <X size={18} />
              </button>
            </div>

            {/* Content */}
            <div className="p-6 overflow-y-auto space-y-6 flex-1 bg-slate-100/50">
              {/* Tên kiện */}
              <div className="space-y-2">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Tên kiện Phụ kiện</label>
                <input
                  type="text"
                  placeholder="Ví dụ: Phụ Kiện Kèm Theo"
                  value={accessoryName}
                  onChange={e => setAccessoryName(e.target.value)}
                  className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm font-semibold text-slate-800 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none transition-all uppercase"
                />
              </div>

              {/* Bảng chọn phụ kiện */}
              <div className="space-y-4">
                <div className="flex justify-between items-center">
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Danh sách phụ kiện trong dự án</label>
                    <p className="text-[9px] text-gray-400 font-bold">Xoá phụ kiện không cần hoặc thêm phụ kiện mới đi kèm</p>
                  </div>
                  <span className="text-[10px] font-mono font-bold text-slate-500 bg-slate-100 px-2 py-0.5 rounded-full">
                    {modalAccessories.filter(acc => (acc.name || '').toLowerCase().includes(accessorySearchTerm.toLowerCase())).length} loại
                  </span>
                </div>

                {/* Bộ lọc tìm kiếm phụ kiện */}
                <div className="relative">
                  <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-slate-400 pointer-events-none">
                    <Search size={14} className="text-slate-400" />
                  </span>
                  <input
                    type="text"
                    placeholder="Tìm phụ kiện (ví dụ: Bản lề, Ray trượt...)"
                    value={accessorySearchTerm}
                    onChange={e => setAccessorySearchTerm(e.target.value)}
                    className="w-full pl-9 pr-8 py-2 bg-white border border-slate-200 rounded-lg text-xs font-semibold text-slate-800 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none transition-all uppercase"
                  />
                  {accessorySearchTerm && (
                    <button
                      type="button"
                      onClick={() => setAccessorySearchTerm("")}
                      className="absolute inset-y-0 right-0 flex items-center pr-3 text-slate-400 hover:text-slate-600 cursor-pointer"
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>

                {/* Form thêm phụ kiện mới phát sinh & đồng bộ */}
                {isAddingNewAccessory ? (
                  <div className="p-4 bg-indigo-100/40 border border-indigo-100 rounded-lg space-y-3">
                    <h4 className="text-[10px] font-black text-indigo-900 uppercase tracking-wider">Thêm phụ kiện mới phát sinh &amp; Đồng bộ dự án</h4>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div className="sm:col-span-2 space-y-1">
                        <label className="text-[9px] font-black text-slate-400 uppercase">Tên phụ kiện</label>
                        <input
                          type="text"
                          placeholder="Ví dụ: RAY GIẢM CHẤN, BẢN LỀ CONG..."
                          value={newAccessoryName}
                          onChange={e => setNewAccessoryName(e.target.value)}
                          className="w-full px-2 py-1.5 bg-white border border-slate-200 rounded text-xs font-bold text-slate-800 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none transition-all uppercase"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[9px] font-black text-slate-400 uppercase">Số lượng</label>
                        <input
                          type="number"
                          min={1}
                          value={newAccessoryQty}
                          onChange={e => setNewAccessoryQty(Math.max(1, parseInt(e.target.value) || 1))}
                          className="w-full px-2 py-1.5 bg-white border border-slate-200 rounded text-xs font-black font-mono text-indigo-600 outline-none focus:border-indigo-500"
                        />
                      </div>
                    </div>

                    <div className="flex justify-end gap-2 shrink-0 pt-1">
                      <button
                        type="button"
                        disabled={addingAccessoryLoading}
                        onClick={() => {
                          setIsAddingNewAccessory(false);
                          setNewAccessoryName("");
                          setNewAccessoryQty(1);
                        }}
                        className="px-3 py-1.5 border border-slate-200 bg-white hover:bg-slate-100 rounded-sm text-[10px] font-black uppercase text-slate-600 transition-all tracking-widest"
                      >
                        Huỷ
                      </button>
                      <button
                        type="button"
                        disabled={addingAccessoryLoading || !newAccessoryName.trim()}
                        onClick={handleAddNewAccessory}
                        className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-sm text-[10px] font-black uppercase transition-all tracking-widest flex items-center justify-center gap-1.5"
                      >
                        {addingAccessoryLoading ? (
                          <>
                            <Loader2 size={12} className="animate-spin" />
                            <span>Đang đồng bộ...</span>
                          </>
                        ) : (
                          <span>Đồng ý Thêm</span>
                        )}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={() => setIsAddingNewAccessory(true)}
                      className="px-3 py-2 bg-indigo-100 hover:bg-indigo-100 text-indigo-800 rounded-sm text-[10px] font-black uppercase tracking-widest transition-all border border-indigo-200/50 flex items-center gap-1.5 cursor-pointer shadow-sm shadow-indigo-100/30"
                    >
                      <Plus size={14} />
                      <span>Thêm Phụ Kiện</span>
                    </button>
                  </div>
                )}

                <div className="border border-slate-100 rounded-lg overflow-hidden bg-white divide-y divide-slate-100 max-h-[320px] overflow-y-auto">
                  {modalAccessories.filter(acc => (acc.name || '').toLowerCase().includes(accessorySearchTerm.toLowerCase())).length > 0 ? (
                    modalAccessories
                      .filter(acc => (acc.name || '').toLowerCase().includes(accessorySearchTerm.toLowerCase()))
                      .map((acc, idx) => (
                        <div key={idx} className="p-3 flex items-center justify-between gap-4 hover:bg-slate-100/50 transition-colors">
                          <div className="min-w-0 flex-1 flex items-center gap-2">
                            {/* Nút xoá phụ kiện khỏi kiện / danh sách đang hiển thị */}
                            <button
                              type="button"
                              onClick={() => handleDeleteModalAccessory(acc.name)}
                              className="p-1.5 hover:bg-red-100 text-slate-400 hover:text-red-500 rounded transition-colors shrink-0 cursor-pointer"
                              title="Kiện này không cần phụ kiện này"
                            >
                              <Trash2 size={14} />
                            </button>

                            <div className="min-w-0 flex-1">
                              <p className="text-xs font-bold text-slate-800 uppercase truncate flex items-center gap-1.5">
                                <span>{acc.name}</span>
                                {acc.isCustom && (
                                  <span className="text-[8px] bg-emerald-100 text-emerald-600 border border-emerald-100 px-1 py-0.5 rounded-sm font-black tracking-wide uppercase">Gói thêm</span>
                                )}
                              </p>
                              <p className="text-[10px] text-slate-400 font-bold uppercase">Tối đa trong dự án: {acc.maxQty}</p>
                            </div>
                          </div>

                          {/* Ô nhập số lượng thủ công kèm các phím bấm nhanh */}
                          <div className="flex items-center space-x-1.5 shrink-0">
                            <button
                              type="button"
                              onClick={() => setSelectedAccessoryQuantities(prev => ({
                                ...prev,
                                [acc.name]: Math.max(0, (prev[acc.name] || 0) - 1)
                              }))}
                              className="w-8 h-8 rounded-sm border border-slate-200 bg-white hover:bg-slate-100 text-slate-700 flex items-center justify-center transition-all cursor-pointer font-bold text-xs shrink-0"
                            >
                              -
                            </button>
                            <input
                              type="number"
                              min={0}
                              value={selectedAccessoryQuantities[acc.name] ?? 0}
                              onChange={e => {
                                const val = Math.max(0, parseInt(e.target.value) || 0);
                                setSelectedAccessoryQuantities(prev => ({
                                  ...prev,
                                  [acc.name]: val
                                }));
                              }}
                              className="w-14 px-1 py-1.5 text-center bg-white border border-slate-200 rounded-sm text-xs font-black font-mono text-indigo-700 focus:outline-none focus:border-indigo-500"
                              title="Số lượng gom thủ công"
                            />
                            <button
                              type="button"
                              onClick={() => setSelectedAccessoryQuantities(prev => ({
                                ...prev,
                                [acc.name]: (prev[acc.name] || 0) + 1
                              }))}
                              className="w-8 h-8 rounded-sm border border-slate-200 bg-white hover:bg-slate-100 text-slate-655 flex items-center justify-center transition-all cursor-pointer font-bold text-xs shrink-0"
                            >
                              +
                            </button>

                            <button
                              type="button"
                              onClick={() => setSelectedAccessoryQuantities(prev => ({
                                ...prev,
                                [acc.name]: acc.maxQty
                              }))}
                              className="px-2 py-2 bg-indigo-100 hover:bg-indigo-100 text-indigo-800 border border-indigo-200/50 rounded-sm text-[10px] font-black uppercase tracking-widest transition-all cursor-pointer shrink-0"
                              title="Nhập số lượng tối đa trong dự án"
                            >
                              Tối đa
                            </button>
                          </div>
                        </div>
                      ))
                  ) : (
                    <div className="p-8 text-center text-gray-400 border-t border-slate-100">
                      <p className="text-[10px] font-black uppercase text-slate-500 tracking-wider">{accessorySearchTerm ? "Không tìm thấy phụ kiện nào phù hợp" : "Không có phụ kiện nào hoạt động hoặc được giữ loại"}</p>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="p-5 bg-slate-100 border-t border-slate-100 flex space-x-3 shrink-0">
              <button
                type="button"
                onClick={() => setShowPackAccessoryModal(false)}
                className="flex-1 py-3 text-slate-600 font-black text-[10px] uppercase border border-slate-200 bg-white hover:bg-slate-100 rounded-lg transition-all tracking-widest"
              >
                Bỏ qua
              </button>
              <button
                type="button"
                onClick={handleCreateAccessoryKien}
                className="flex-1 py-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-black uppercase text-[10px] tracking-widest transition-all shadow-lg active:scale-95 text-center cursor-pointer"
              >
                Tạo Kiện Phụ Kiện
              </button>
            </div>
          </motion.div>
        </div>
      )}

      {/* Modal Đóng Kiện CTHT */}
      {showPackCTHTModal && !cthtQrScannerOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[250] flex items-center justify-center p-4">
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-white w-full max-w-lg rounded-lg overflow-hidden flex flex-col max-h-[90vh] shadow-2xl border border-slate-200"
          >
            {/* Header */}
            <div className="p-5 border-b border-slate-100 bg-white flex justify-between items-center shrink-0">
              <div>
                <h3 className="text-base font-black text-slate-800 uppercase tracking-tight">Đóng Kiện CTHT (Chi Tiết Hỗ Trợ)</h3>
                <p className="text-[10px] text-gray-405 font-bold uppercase tracking-widest mt-0.5">Dự án: {formatProjectCode(packingList.projectCode)}</p>
              </div>
              <button
                onClick={() => setShowPackCTHTModal(false)}
                className="p-1.5 hover:bg-slate-100 rounded-full transition-colors text-slate-400"
              >
                <X size={18} />
              </button>
            </div>

            {/* Content */}
            <div className="p-6 overflow-y-auto space-y-6 flex-1 bg-slate-100/50">
              {/* Tên cụm tự động từ CTHT đã chọn */}
              {(() => {
                const selectedEntries = Object.values(cthtItemsSelected)
                  .filter(s => s.selectedQty > 0)
                  .map(s => unpackedCTHTs.find(e => e.id === s.id))
                  .filter(Boolean);
                const clusterNames = [...new Set(selectedEntries.map(e => (e!.cluster || '').trim()).filter(Boolean))];
                if (clusterNames.length === 0) return null;
                return (
                  <div className="px-3 py-2 bg-indigo-50 border border-indigo-200 rounded-lg">
                    <p className="text-[10px] font-black text-indigo-400 uppercase tracking-widest mb-0.5">Cụm</p>
                    <p className="text-xs font-black text-indigo-700 uppercase">{clusterNames.join(' + ')}</p>
                  </div>
                );
              })()}

              {/* Tên kiện (nhập thủ công) */}
              <div className="space-y-2">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Tên kiện CTHT (Đặt thủ công)</label>
                <input
                  type="text"
                  placeholder="Ví dụ: Kiện CTHT 1"
                  value={cthtKienName}
                  onChange={e => setCthtKienName(e.target.value)}
                  className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm font-semibold text-slate-800 focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 outline-none transition-all uppercase"
                />
              </div>

              {/* Nút Quét QR + Thêm thủ công */}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setCthtQrScannerOpen(true)}
                  className="flex-1 px-4 py-3 bg-cyan-600 hover:bg-cyan-700 text-white rounded-lg text-xs font-black uppercase tracking-wider transition-all flex items-center justify-center gap-1.5 cursor-pointer shadow-md"
                >
                  <QrCode size={14} />
                  <span>Quét QR</span>
                </button>
                <button
                  type="button"
                  onClick={() => setShowCthtManualModal(true)}
                  className="flex-1 px-4 py-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-black uppercase tracking-wider transition-all flex items-center justify-center gap-1.5 cursor-pointer shadow-md"
                >
                  <Plus size={14} />
                  <span>Thêm CTHT</span>
                </button>
              </div>

              {/* Thêm chi tiết hoàn thiện ngoài dự án */}
              <div className="space-y-3">
                <div className="flex justify-between items-center">
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Chi tiết hoàn thiện ngoài dự án</label>
                    <p className="text-[9px] text-gray-400 font-bold">Tạo chi tiết tự do không nằm trong dự án, nhập tên và số lượng</p>
                  </div>
                  <span className="text-[10px] font-mono font-bold text-slate-500 bg-slate-100 px-2 py-0.5 rounded-full">
                    {customCthtList.length} loại
                  </span>
                </div>

                {/* Form thêm chi tiết mới */}
                {isAddingCustomCtht ? (
                  <div className="p-4 bg-cyan-100/40 border border-cyan-200 rounded-lg space-y-3">
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div className="sm:col-span-2 space-y-1">
                        <label className="text-[9px] font-black text-slate-400 uppercase">Tên chi tiết</label>
                        <input
                          type="text"
                          placeholder="VD: TẤM ỐP NHÀ BẾP, THANH NẸP..."
                          value={customCthtName}
                          onChange={e => setCustomCthtName(e.target.value)}
                          className="w-full px-2 py-1.5 bg-white border border-slate-200 rounded-lg text-xs font-bold text-slate-800 focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 outline-none transition-all uppercase"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[9px] font-black text-slate-400 uppercase">Số lượng</label>
                        <input
                          type="number"
                          min={1}
                          value={customCthtQty}
                          onChange={e => setCustomCthtQty(Math.max(1, parseInt(e.target.value) || 1))}
                          className="w-full px-2 py-1.5 bg-white border border-slate-200 rounded-lg text-xs font-black font-mono text-cyan-700 outline-none focus:border-cyan-500"
                        />
                      </div>
                    </div>

                    <div className="flex justify-end gap-2 shrink-0 pt-1">
                      <button
                        type="button"
                        onClick={() => { setIsAddingCustomCtht(false); setCustomCthtName(""); setCustomCthtQty(1); }}
                        className="px-3 py-1.5 border border-slate-200 bg-white hover:bg-slate-100 rounded-lg text-[10px] font-black uppercase text-slate-600 transition-all tracking-widest"
                      >
                        Huỷ
                      </button>
                      <button
                        type="button"
                        disabled={!customCthtName.trim()}
                        onClick={handleAddCustomCtht}
                        className="px-4 py-1.5 bg-cyan-600 hover:bg-cyan-700 text-white rounded-lg text-[10px] font-black uppercase transition-all tracking-widest flex items-center justify-center gap-1.5 disabled:opacity-50"
                      >
                        <Plus size={12} /> Thêm chi tiết
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={() => setIsAddingCustomCtht(true)}
                      className="px-3 py-2 bg-cyan-100 hover:bg-cyan-200 text-cyan-800 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all border border-cyan-200/50 flex items-center gap-1.5 cursor-pointer"
                    >
                      <Plus size={14} />
                      <span>Thêm Chi Tiết</span>
                    </button>
                  </div>
                )}

                {/* Danh sách chi tiết ngoài dự án đã thêm */}
                {customCthtList.length > 0 && (
                  <div className="border border-cyan-100 rounded-lg overflow-hidden bg-white divide-y divide-slate-100">
                    {customCthtList.map(item => (
                      <div key={item.id} className="p-3 flex items-center justify-between gap-4 hover:bg-cyan-50/40 transition-colors">
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-bold text-slate-800 uppercase truncate flex items-center gap-1.5">
                            <span>{item.moduleCode}</span>
                            <span className="text-[8px] bg-cyan-100 text-cyan-700 border border-cyan-200 px-1 py-0.5 rounded font-black tracking-wide uppercase">Ngoài dự án</span>
                          </p>
                          <p className="text-[10px] text-slate-400 font-bold uppercase">SL: {item.selectedQty}</p>
                        </div>
                        <div className="flex items-center space-x-1.5 shrink-0">
                          <button
                            type="button"
                            onClick={() => handleAdjustCustomCthtQty(item.id, -1)}
                            className="w-8 h-8 rounded-lg border border-slate-200 bg-white hover:bg-slate-100 text-slate-600 flex items-center justify-center transition-all cursor-pointer font-bold text-xs"
                          >
                            -
                          </button>
                          <span className="text-xs font-black w-8 text-center font-mono text-cyan-700">
                            {item.selectedQty}
                          </span>
                          <button
                            type="button"
                            onClick={() => handleAdjustCustomCthtQty(item.id, 1)}
                            className="w-8 h-8 rounded-lg border border-slate-200 bg-white hover:bg-slate-100 text-slate-600 flex items-center justify-center transition-all cursor-pointer font-bold text-xs"
                          >
                            +
                          </button>
                          <button
                            type="button"
                            onClick={() => handleRemoveCustomCtht(item.id)}
                            className="p-1.5 hover:bg-red-100 text-slate-400 hover:text-red-500 rounded transition-colors shrink-0 cursor-pointer"
                            title="Bỏ chi tiết này"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Bảng chọn CTHT */}
              <div className="space-y-3">
                <div className="flex justify-between items-center">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Danh sách CTHT / Len, Filler của dự án</label>
                  <span className="text-[10px] font-mono font-bold text-slate-500 bg-slate-100 px-2 py-0.5 rounded-full">
                    {visibleCTHTs.length} loại
                  </span>
                </div>

                {/* Bộ lọc */}
                <div className="flex gap-2">
                  <div className="flex-1 relative">
                    <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                    <input
                      type="text"
                      placeholder="Tìm mã / tên..."
                      value={cthtSearchTerm}
                      onChange={e => setCthtSearchTerm(e.target.value)}
                      className="w-full pl-8 pr-3 py-2 bg-white border border-slate-200 rounded-lg text-[11px] font-semibold text-slate-700 focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 outline-none transition-all"
                    />
                  </div>
                  <select
                    value={cthtSearchType}
                    onChange={e => setCthtSearchType(e.target.value)}
                    className="px-3 py-2 bg-white border border-slate-200 rounded-lg text-[10px] font-black text-slate-600 uppercase tracking-wider focus:border-cyan-500 outline-none cursor-pointer"
                  >
                    <option value="all">TẤT CẢ</option>
                    <option value="CTHT">CTHT</option>
                    <option value="Len, Filler">LEN, FILLER</option>
                  </select>
                </div>

                <div className="border border-slate-100 rounded-lg overflow-hidden bg-white divide-y divide-slate-100 max-h-[300px] overflow-y-auto">
                  {visibleCTHTs.length > 0 ? (
                    visibleCTHTs
                      .map((entry, idx) => {
                        const itemState = cthtItemsSelected[entry.id] || { selectedQty: 0, maxQty: entry.quantity || 1 };
                        return (
                          <div key={`${entry.id}-${idx}`} className="p-3 flex items-center justify-between gap-4 hover:bg-slate-100/50 transition-colors">
                            <div className="min-w-0 flex-1">
                              <p className="text-xs font-bold text-slate-800 uppercase truncate">{entry.moduleCode}</p>
                              <div className="flex items-center gap-2 mt-0.5">
                                <p className="text-[9px] font-mono text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded">ID: {entry.id}</p>
                                <p className="text-[10px] text-slate-400 font-bold uppercase">SL: {itemState.maxQty}</p>
                              </div>
                            </div>
                            <div className="flex items-center space-x-2">
                              <button
                                type="button"
                                onClick={() => setCthtItemsSelected(prev => {
                                  const current = prev[entry.id];
                                  if (!current) return prev;
                                  return {
                                    ...prev,
                                    [entry.id]: {
                                      ...current,
                                      selectedQty: Math.max(0, current.selectedQty - 1)
                                    }
                                  };
                                })}
                                className="w-8 h-8 rounded-lg border border-slate-200 bg-white hover:bg-slate-100 font-bold text-slate-600 flex items-center justify-center transition-all cursor-pointer shadow-xs active:scale-95"
                              >
                                -
                              </button>
                              <span className="text-xs font-black w-8 text-center font-mono text-slate-800">
                                {itemState.selectedQty}
                              </span>
                              <button
                                type="button"
                                onClick={() => setCthtItemsSelected(prev => {
                                  const current = prev[entry.id];
                                  if (!current) return prev;
                                  return {
                                    ...prev,
                                    [entry.id]: {
                                      ...current,
                                      selectedQty: Math.min(current.maxQty, current.selectedQty + 1)
                                    }
                                  };
                                })}
                                className="w-8 h-8 rounded-lg border border-slate-200 bg-white hover:bg-slate-100 font-bold text-slate-600 flex items-center justify-center transition-all cursor-pointer shadow-xs active:scale-95"
                              >
                                +
                              </button>
                            </div>
                          </div>
                        );
                      })
                  ) : (
                    <div className="p-8 text-center text-gray-400 border-t border-slate-100">
                      <p className="text-[10px] font-black uppercase text-slate-400">
                        {cthtSearchTerm ? "Không tìm thấy chi tiết CTHT nào phù hợp" : "Nhập từ khóa tìm kiếm hoặc quét QR để thêm linh kiện CTHT"}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="p-5 bg-slate-100 border-t border-slate-100 flex space-x-3 shrink-0">
              <button
                type="button"
                onClick={() => setShowPackCTHTModal(false)}
                className="flex-1 py-3 text-slate-600 font-black text-[10px] uppercase border border-slate-200 bg-white hover:bg-slate-100 rounded-lg transition-all tracking-widest"
              >
                Bỏ qua
              </button>
              <button
                type="button"
                onClick={handleCreateCthtKien}
                className="flex-1 py-3 bg-cyan-600 hover:bg-cyan-700 text-white rounded-lg font-black uppercase text-[10px] tracking-widest transition-all shadow-lg active:scale-95 text-center cursor-pointer"
              >
                Tạo Kiện CTHT
              </button>
            </div>
          </motion.div>
        </div>
      )}

      {cthtQrScannerOpen && (
        <ScannerModal
          onClose={() => setCthtQrScannerOpen(false)}
          onScan={handleCthtQRScan}
          projectEntries={projectEntries}
        />
      )}

      {/* Modal thêm CTHT thủ công */}
      {showCthtManualModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[260] flex items-center justify-center p-4">
          <div className="bg-white w-full max-w-md rounded-lg shadow-2xl overflow-hidden flex flex-col border border-slate-200 max-h-[80vh]">
            <div className="p-4 border-b border-slate-100 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 bg-indigo-100 text-indigo-600 rounded-lg flex items-center justify-center">
                  <Plus size={16} />
                </div>
                <div>
                  <h3 className="text-sm font-black text-slate-800 uppercase tracking-tight">Thêm CTHT thủ công</h3>
                  <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Chọn chi tiết CTHT chưa đóng gói</p>
                </div>
              </div>
              <button onClick={() => { setShowCthtManualModal(false); setCthtManualSearch(''); }} className="p-2 text-slate-400 hover:text-rose-500 transition-colors"><X size={18} /></button>
            </div>

            <div className="p-3 border-b border-slate-100 shrink-0 space-y-2">
              {/* Bộ lọc cụm */}
              {(() => {
                const addedIds = new Set(Object.keys(cthtItemsSelected).filter(k => cthtItemsSelected[k].selectedQty > 0));
                const clusters = [...new Set(unpackedCTHTs.filter(e => !addedIds.has(e.id)).map(e => e.cluster || '').filter(Boolean))].sort();
                return (
                  <select
                    value={cthtManualCluster}
                    onChange={e => setCthtManualCluster(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-100 border border-slate-200 rounded-lg text-xs font-black text-slate-700 focus:border-indigo-500 outline-none transition-all uppercase"
                  >
                    <option value="">Tất cả cụm</option>
                    {clusters.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                );
              })()}
              {/* Ô tìm kiếm */}
              <div className="relative">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  placeholder="Lọc theo tên chi tiết CTHT..."
                  value={cthtManualSearch}
                  onChange={e => setCthtManualSearch(e.target.value)}
                  className="w-full pl-9 pr-3 py-2 bg-slate-100 border border-slate-200 rounded-lg text-xs font-semibold text-slate-800 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none transition-all uppercase"
                  autoFocus
                />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-2 space-y-1">
              {(() => {
                // Lọc CTHT chưa added vào kiện hiện tại
                const addedIds = new Set(Object.keys(cthtItemsSelected).filter(k => cthtItemsSelected[k].selectedQty > 0));
                let cthts = unpackedCTHTs.filter(e => !addedIds.has(e.id));
                if (cthtManualCluster) {
                  cthts = cthts.filter(e => (e.cluster || '') === cthtManualCluster);
                }
                if (cthtManualSearch.trim()) {
                  const q = cthtManualSearch.toLowerCase().trim();
                  cthts = cthts.filter(e =>
                    (e.moduleCode || '').toLowerCase().includes(q) ||
                    (e.cluster || '').toLowerCase().includes(q)
                  );
                }
                if (cthts.length === 0) {
                  return (
                    <div className="py-10 text-center text-slate-400">
                      <Inbox size={32} className="mx-auto mb-2 opacity-20" />
                      <p className="text-xs font-bold uppercase tracking-widest">
                        {cthtManualSearch || cthtManualCluster ? 'Không tìm thấy chi tiết CTHT phù hợp' : 'Tất cả chi tiết CTHT đã được thêm'}
                      </p>
                    </div>
                  );
                }
                return cthts.map(entry => {
                  const itemState = cthtItemsSelected[entry.id] || { selectedQty: 0, maxQty: entry.quantity || 1 };
                  return (
                    <div
                      key={entry.id}
                      className="flex items-center justify-between p-3 bg-slate-50 hover:bg-indigo-50 border border-slate-100 hover:border-indigo-200 rounded-lg transition-all"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-black text-slate-800 uppercase truncate">{entry.moduleCode}</p>
                        <div className="flex items-center gap-2 mt-0.5">
                          {entry.cluster && <span className="text-[9px] font-bold text-indigo-500 bg-indigo-50 px-1.5 py-0.5 rounded">{entry.cluster}</span>}
                          <span className="text-[10px] text-slate-400 font-bold uppercase">SL: {itemState.maxQty}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0 ml-3">
                        <span className="text-xs font-black w-6 text-center font-mono text-indigo-600">{itemState.selectedQty}</span>
                        <button
                          type="button"
                          onClick={() => setCthtItemsSelected(prev => {
                            const current = prev[entry.id];
                            if (!current) return prev;
                            return { ...prev, [entry.id]: { ...current, selectedQty: Math.max(0, current.selectedQty - 1) } };
                          })}
                          className="w-7 h-7 rounded border border-slate-200 bg-white hover:bg-slate-100 font-bold text-slate-600 flex items-center justify-center transition-all cursor-pointer text-xs"
                        >-</button>
                        <button
                          type="button"
                          onClick={() => setCthtItemsSelected(prev => {
                            const current = prev[entry.id];
                            if (!current) return prev;
                            return { ...prev, [entry.id]: { ...current, selectedQty: Math.min(current.maxQty, current.selectedQty + 1) } };
                          })}
                          className="w-7 h-7 rounded bg-indigo-600 hover:bg-indigo-700 text-white font-bold flex items-center justify-center transition-all cursor-pointer text-xs shadow-sm"
                        >+</button>
                      </div>
                    </div>
                  );
                });
              })()}
            </div>

            <div className="p-3 border-t border-slate-100 bg-slate-50 shrink-0">
              <button
                onClick={() => { setShowCthtManualModal(false); setCthtManualSearch(''); }}
                className="w-full py-2.5 bg-slate-200 text-slate-600 rounded-lg font-black uppercase text-[10px] tracking-widest hover:bg-slate-300 transition-all"
              >
                Đóng
              </button>
            </div>
          </div>
        </div>
      )}

      {scanningForCthtKienIdx !== null && (
        <ScannerModal
          onClose={() => setScanningForCthtKienIdx(null)}
          onScan={handleQRScanForExistingCthtKien}
          projectEntries={projectEntries}
        />
      )}

      {showQRScanner && (
        <ScannerModal
          onClose={() => setShowQRScanner(false)}
          onScan={handleQRScan}
          projectEntries={projectEntries}
        />
      )}

      {showQRPrintScanner && (
        <ScannerModal
          onClose={() => setShowQRPrintScanner(false)}
          onScan={handleQRScanPrintLabel}
          projectEntries={projectEntries}
        />
      )}

      {showPrintQtyModal && activeCheckingIdx !== null && (
        <PrintQtyModal
          itemName={items[activeCheckingIdx]?.name || ''}
          onConfirm={(qty) => handlePrintLabel(qty)}
          onClose={() => setShowPrintQtyModal(false)}
        />
      )}

      {qrPrintConfirmItem && (
        <div className="fixed inset-0 z-[110] bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 no-print">
          <div className="bg-white rounded-lg border border-slate-200 shadow-2xl w-full max-w-sm p-6 space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-emerald-100 text-emerald-600 rounded-lg flex items-center justify-center">
                <ScanQrCode size={22} />
              </div>
              <div>
                <h3 className="text-sm font-black text-slate-800 uppercase tracking-tight">Xác nhận in tem</h3>
                <p className="text-[10px] text-slate-400 font-bold uppercase">Gửi tem đến Trạm in liên kết</p>
              </div>
            </div>
            <div className="bg-slate-100 border border-slate-200 rounded-lg p-3">
              <p className="text-[9px] font-black text-slate-400 uppercase tracking-wider">Kiện cần in</p>
              <p className="text-sm font-black text-slate-800 uppercase mt-0.5 break-all">{qrPrintConfirmItem.name}</p>
            </div>
            <div className="flex items-center gap-3">
              <label className="text-[10px] font-black text-slate-400 uppercase whitespace-nowrap">Số trang</label>
              <div className="flex items-center border border-slate-200 rounded-lg overflow-hidden">
                <button
                  onClick={() => setQrPrintCopies(Math.max(1, qrPrintCopies - 1))}
                  className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-600 font-bold text-sm cursor-pointer"
                >-</button>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={qrPrintCopies}
                  onChange={(e) => setQrPrintCopies(Math.max(1, Math.min(20, parseInt(e.target.value) || 1)))}
                  className="w-12 text-center text-sm font-black text-slate-800 border-x border-slate-200 focus:outline-none"
                />
                <button
                  onClick={() => setQrPrintCopies(Math.min(20, qrPrintCopies + 1))}
                  className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-600 font-bold text-sm cursor-pointer"
                >+</button>
              </div>
            </div>
            <div className="flex items-center gap-2 justify-end pt-1">
              <button
                onClick={() => setQrPrintConfirmItem(null)}
                className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-600 font-bold text-xs uppercase rounded-lg border border-slate-200 cursor-pointer"
              >
                Hủy
              </button>
              <button
                onClick={async () => {
                  const itemToPrint = qrPrintConfirmItem.item;
                  setQrPrintConfirmItem(null);

                  try {
                    setLoading(true);

                    // Resolve tên dự án — chỉ khớp cấu kiện trong cùng dự án của phiếu
                    const matchedEntry = projectEntries?.find(e => {
                      if (packingList.projectCode && e.projectCode && e.projectCode !== packingList.projectCode) return false;
                      return e.id === itemToPrint.id || (e.moduleCode || '').toLowerCase() === (itemToPrint.name || '').toLowerCase();
                    });
                    const resolvedPC = matchedEntry?.projectCode || packingList.projectCode || projectEntries?.find(e => e.projectCode)?.projectCode || '';

                    // Parse thông tin từ tên kiện
                    const parsed = parseItemDimensionsAndInfo(itemToPrint.name);

                    // Ưu tiên savedLabelData nếu có
                    const saved = (itemToPrint as any).savedLabelData as { projectName?: string; unit?: string; area?: string; cabinetType?: string; w?: string; d?: string; h?: string; weight?: string } | undefined;

                    const w = saved?.w || itemToPrint.w || parsed.w || '0';
                    const d = saved?.d || itemToPrint.d || parsed.d || '0';
                    const h = saved?.h || itemToPrint.h || parsed.h || '0';
                    const unit = saved?.unit || extractSubProjectCode(resolvedPC) || parsed.unit || '-';
                    const area = saved?.area || formatAreaName(itemToPrint.cluster || matchedEntry?.cluster || parsed.area || '-');

                    // Tìm instance info từ printItems (đã được generate trong handleOpenPrintModal)
                    const matchedPrintItem = printItems.find(p => p.originalName === itemToPrint.name || p.name === itemToPrint.name);

                    // instanceIndex: ưu tiên từ qrPrintConfirmItem (khi quét QR), sau đó matchedPrintItem
                    const instIdx = qrPrintConfirmItem?.instanceIndex ?? matchedPrintItem?.instanceIndex;
                    const totalInst = qrPrintConfirmItem?.totalInstances ?? matchedPrintItem?.totalInstances;

                    // cabinetType: ưu tiên từ savedLabelData → matchedPrintItem → parsed
                    let cabinetType = saved?.cabinetType || matchedPrintItem?.cabinetType || parsed.cabinetType || '-';
                    if (!matchedPrintItem && instIdx && totalInst && totalInst > 1 && !cabinetType.includes(`(${instIdx}/${totalInst})`)) {
                      cabinetType = `${cabinetType} (${instIdx}/${totalInst})`;
                    }
                    const weight = saved?.weight || itemToPrint.weight?.toString() || '0';
                    // Tên dự án mặc định theo dự án của phiếu đóng gói (packingList)
                    const slipProjectName = resolveSlipProjectName(projectEntries, resolvedPC, packingList);
                    const pName = slipProjectName || saved?.projectName || matchedEntry?.projectName || itemToPrint.projectName || formatProjectCode(resolvedPC) || packingList.title || '';

                    // Tạo QR — mã QR chứa tên kiện + info instance để phân biệt bản in
                    const isCthtPrint = itemToPrint.subType === 'kienCTHT';
                    const baseCodeForQR = itemToPrint.name.includes('#') ? itemToPrint.name.split('#')[0].trim() : itemToPrint.name;
                    const instanceSuffix = totalInst && totalInst > 1 && instIdx ? `|${instIdx}` : '';
                    const qrText = isCthtPrint && itemToPrint.id
                      ? `${itemToPrint.id}|${itemToPrint.name}----EASYCABINET----`
                      : `${baseCodeForQR}${instanceSuffix}----EASYCABINET----`;
                    const qrUrl = await QRCode.toDataURL(qrText, { margin: 1, width: 300, color: { dark: '#000000', light: '#ffffff' } });

                    // Ghi vào Firestore print_jobs — trạm in onSnapshot sẽ lấy ngay
                    await addDoc(collection(db, 'print_jobs'), {
                      createdAt: serverTimestamp(),
                      packageId: itemToPrint.id || '',
                      packageName: itemToPrint.name,
                      formTemplate,
                      payload: {
                        name: itemToPrint.name,
                        projectName: pName,
                        unit,
                        area,
                        cabinetType,
                        w, d, h,
                        weight,
                        qrText,
                        qrUrl,
                        printMultiUnit,
                        supplierDept: bconsDept,
                        deliveryAddress: bconsAddress,
                        receiverName: bconsReceiver,
                        receiverPhone: bconsPhone,
                        printDate: new Date().toLocaleDateString('vi-VN'),
                        ...(instIdx != null ? { instanceIndex: instIdx } : {}),
                        ...(totalInst != null ? { totalInstances: totalInst } : {})
                      },
                      pklCode: pklLists.find(p => p.packageIds?.includes(itemToPrint.id || ''))?.pklCode || packingList.title || '',
                      pklId: pklLists.find(p => p.packageIds?.includes(itemToPrint.id || ''))?.id || packingList.id,
                      copies: qrPrintCopies
                    });

                    setQrPrintConfirmItem(null);
                  } catch (err) {
                    console.error('Lỗi gửi print job:', err);
                    showError('Không thể gửi lệnh in. Vui lòng thử lại.');
                  } finally {
                    setLoading(false);
                  }
                }}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold text-xs uppercase rounded-lg shadow-sm flex items-center gap-1.5 cursor-pointer"
              >
                <Printer size={13} />
                <span>In ngay</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {showPrintLabelModal && (
        <div className="fixed inset-0 z-100 overflow-y-auto bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 no-print">
          <div className="bg-white rounded-lg shadow-xl border border-slate-200 w-full max-w-5xl overflow-hidden flex flex-col max-h-[90vh]">
            {/* Header */}
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-100">
              <div className="flex items-center gap-2">
                <span className="text-xl">🖨️</span>
                <div>
                  <h3 className="text-base font-black text-slate-800 uppercase tracking-tight">Cấu hình & In Tem Nhãn Thùng</h3>
                  <p className="text-xs text-gray-400 font-bold">Kiểm tra thông tin tem thùng và in ấn một cách linh hoạt</p>
                </div>
              </div>
              <button
                onClick={() => setShowPrintLabelModal(false)}
                className="p-1 px-2.5 bg-rose-100 hover:bg-rose-100 text-rose-600 rounded-lg font-black text-xs uppercase transition-all cursor-pointer"
              >
                Đóng
              </button>
            </div>

            {/* Body */}
            <div className="p-6 overflow-y-auto space-y-6 flex-1 text-xs">
              {/* Cấu hình chung */}
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4 bg-slate-100 p-4 rounded-lg">
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black text-slate-400 uppercase">DỰ ÁN (PROJECT CODE)</label>
                  <input
                    type="text"
                    value={labelProjectCode}
                    onChange={(e) => {
                      const code = e.target.value;
                      setLabelProjectCode(code);
                      const matchedEntry = projectEntries?.find(ent => ent.projectCode === code);
                      if (matchedEntry?.projectName) {
                        setLabelProjectName(matchedEntry.projectName);
                        setPrintItems(prev => prev.map(p => ({ ...p, projectName: matchedEntry.projectName })));
                      }
                    }}
                    onBlur={() => saveLabelFields({ labelProjectCode })}
                    className="w-full bg-white border border-slate-200 rounded-lg p-2 text-xs font-bold outline-none uppercase"
                    placeholder="Mã dự án..."
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black text-slate-400 uppercase">DỰ ÁN (PROJECT NAME)</label>
                  <input
                    type="text"
                    value={labelProjectName}
                    onChange={(e) => {
                      const name = e.target.value;
                      setLabelProjectName(name);
                      setPrintItems(prev => prev.map(p => ({ ...p, projectName: name })));
                    }}
                    onBlur={() => saveLabelFields({ labelProjectName })}
                    className="w-full bg-white border border-slate-200 rounded-lg p-2 text-xs font-bold outline-none uppercase"
                    placeholder="Nhập tên dự án..."
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black text-slate-400 uppercase">NHÀ CUNG CẤP (SUPPLIER)</label>
                  <input
                    type="text"
                    value={labelSupplierName}
                    onChange={(e) => setLabelSupplierName(e.target.value)}
                    onBlur={() => saveLabelFields({ labelSupplierName })}
                    className="w-full bg-white border border-slate-200 rounded-lg p-2 text-xs font-bold outline-none uppercase"
                    placeholder="Nhập tên nhà cung cấp..."
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black text-slate-400 uppercase">Số tờ cần in mỗi tem</label>
                  <div className="flex gap-2">
                    {[1, 2, 4].map((num) => (
                      <button
                        key={num}
                        type="button"
                        onClick={() => setPrintCopies(num)}
                        className={`flex-1 py-2 font-black text-xs uppercase tracking-wider rounded-lg transition-all border cursor-pointer ${printCopies === num
                          ? "bg-indigo-600 border-indigo-600 text-white shadow-xs"
                          : "bg-white border-slate-200 text-slate-600 hover:bg-slate-100"
                          }`}
                      >
                        {num} Tờ
                      </button>
                    ))}
                  </div>
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black text-slate-400 uppercase">Chế độ hiển thị UNIT</label>
                  <button
                    type="button"
                    onClick={() => setPrintMultiUnit(!printMultiUnit)}
                    className={`w-full py-2 font-black text-xs uppercase tracking-wider rounded-lg transition-all border cursor-pointer ${printMultiUnit
                      ? "bg-amber-500 border-amber-500 text-white shadow-xs"
                      : "bg-white border-slate-200 text-slate-600 hover:bg-slate-100"
                      }`}
                  >
                    {printMultiUnit ? '1 căn (hiện CODE)' : 'Nhiều căn (hiện UNIT)'}
                  </button>
                </div>
              </div>

              {/* Bcons-specific fields */}
              {formTemplate === 'mauBcons' && (
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4 bg-amber-100 p-4 rounded-lg border border-amber-200">
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-black text-amber-600 uppercase">BP xuất xưởng</label>
                    <input
                      type="text"
                      value={bconsDept}
                      onChange={(e) => setBconsDept(e.target.value)}
                      onBlur={() => saveBconsFields({ bconsDept })}
                      className="w-full bg-white border border-amber-200 rounded-lg p-2 text-xs font-bold outline-none uppercase"
                      placeholder="Kho thành phẩm - DRACO"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-black text-amber-600 uppercase">Địa chỉ nhận hàng</label>
                    <input
                      type="text"
                      value={bconsAddress}
                      onChange={(e) => setBconsAddress(e.target.value)}
                      onBlur={() => saveBconsFields({ bconsAddress })}
                      className="w-full bg-white border border-amber-200 rounded-lg p-2 text-xs font-bold outline-none uppercase"
                      placeholder="Nhập địa chỉ..."
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-black text-amber-600 uppercase">Người nhận</label>
                    <input
                      type="text"
                      value={bconsReceiver}
                      onChange={(e) => setBconsReceiver(e.target.value)}
                      onBlur={() => saveBconsFields({ bconsReceiver })}
                      className="w-full bg-white border border-amber-200 rounded-lg p-2 text-xs font-bold outline-none uppercase"
                      placeholder="Tên người nhận..."
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-black text-amber-600 uppercase">SĐT người nhận</label>
                    <input
                      type="text"
                      value={bconsPhone}
                      onChange={(e) => setBconsPhone(e.target.value)}
                      onBlur={() => saveBconsFields({ bconsPhone })}
                      className="w-full bg-white border border-amber-200 rounded-lg p-2 text-xs font-bold outline-none"
                      placeholder="SĐT..."
                    />
                  </div>
                </div>
              )}

              {/* Bộ lọc tem */}
              <div className="bg-slate-100 p-4 rounded-lg space-y-3">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm">🔍</span>
                  <span className="font-black text-[10px] text-slate-400 uppercase tracking-widest">Bộ lọc tìm kiếm & Phân loại tem</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-5 gap-3">
                  {/* Tìm kiếm tên */}
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-slate-500 uppercase">Tên kiện / Dự án / Mã</label>
                    <input
                      type="text"
                      value={labelFilterSearch}
                      onChange={(e) => setLabelFilterSearch(e.target.value)}
                      placeholder="Tìm theo tên..."
                      className="w-full bg-white border border-slate-200 rounded-lg p-2 text-xs font-semibold outline-none"
                    />
                  </div>

                  {/* Lọc Unit */}
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-slate-500 uppercase">Căn hộ (Unit)</label>
                    <select
                      value={labelFilterUnit}
                      onChange={(e) => setLabelFilterUnit(e.target.value)}
                      className="w-full bg-white border border-slate-200 rounded-lg p-2 text-xs font-semibold outline-none cursor-pointer"
                    >
                      <option value="all">Tất cả Unit</option>
                      {uniqueUnits.map(unit => (
                        <option key={unit} value={unit}>{unit}</option>
                      ))}
                    </select>
                  </div>

                  {/* Lọc Area */}
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-slate-500 uppercase">Khu vực (Area)</label>
                    <select
                      value={labelFilterArea}
                      onChange={(e) => setLabelFilterArea(e.target.value)}
                      className="w-full bg-white border border-slate-200 rounded-lg p-2 text-xs font-semibold outline-none cursor-pointer"
                    >
                      <option value="all">Tất cả Area</option>
                      {uniqueAreas.map(area => (
                        <option key={area} value={area}>{area}</option>
                      ))}
                    </select>
                  </div>

                  {/* Lọc Type */}
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-slate-500 uppercase">Loại tủ (Type)</label>
                    <select
                      value={labelFilterType}
                      onChange={(e) => setLabelFilterType(e.target.value)}
                      className="w-full bg-white border border-slate-200 rounded-lg p-2 text-xs font-semibold outline-none cursor-pointer"
                    >
                      <option value="all">Tất cả Type</option>
                      {uniqueTypes.map(type => (
                        <option key={type} value={type}>{type}</option>
                      ))}
                    </select>
                  </div>

                  {/* Lọc Trạng thái Chọn */}
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-slate-500 uppercase">Trạng thái in</label>
                    <select
                      value={labelFilterSelected}
                      onChange={(e) => setLabelFilterSelected(e.target.value as any)}
                      className="w-full bg-white border border-slate-200 rounded-lg p-2 text-xs font-semibold outline-none cursor-pointer"
                    >
                      <option value="all">Tất cả tem</option>
                      <option value="selected">Đã chọn in</option>
                      <option value="unselected">Chưa chọn in</option>
                    </select>
                  </div>
                </div>

                {/* Reset button if filtered */}
                {(labelFilterSearch || labelFilterUnit !== "all" || labelFilterArea !== "all" || labelFilterType !== "all" || labelFilterSelected !== "all") && (
                  <div className="flex justify-end pt-1">
                    <button
                      type="button"
                      onClick={() => {
                        setLabelFilterSearch("");
                        setLabelFilterUnit("all");
                        setLabelFilterArea("all");
                        setLabelFilterType("all");
                        setLabelFilterSelected("all");
                      }}
                      className="px-3 py-1.5 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded-lg text-[10px] font-black uppercase tracking-wider transition-all cursor-pointer"
                    >
                      Xóa bộ lọc
                    </button>
                  </div>
                )}
              </div>

              {/* Bảng danh sách cấu kiện */}
              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                    Danh sách kiện & Thông tin bóc tách {filteredPrintItems.length < printItems.length ? `(Hiển thị ${filteredPrintItems.length}/${printItems.length})` : ""}
                  </label>
                  <div className="flex gap-2">
                    <button
                      onClick={() => {
                        const matchIds = new Set(filteredPrintItems.map(i => i.tempId));
                        setPrintItems(prev => prev.map(item => matchIds.has(item.tempId) ? { ...item, selected: true } : item));
                      }}
                      className="text-[10px] font-bold text-indigo-600 hover:underline cursor-pointer"
                    >
                      Chọn tất cả {filteredPrintItems.length < printItems.length ? "đang lọc" : ""}
                    </button>
                    <span className="text-gray-300">|</span>
                    <button
                      onClick={() => {
                        const matchIds = new Set(filteredPrintItems.map(i => i.tempId));
                        setPrintItems(prev => prev.map(item => matchIds.has(item.tempId) ? { ...item, selected: false } : item));
                      }}
                      className="text-[10px] font-bold text-indigo-600 hover:underline cursor-pointer"
                    >
                      Bỏ chọn tất cả {filteredPrintItems.length < printItems.length ? "đang lọc" : ""}
                    </button>
                  </div>
                </div>

                <div className="border border-slate-200 rounded-lg overflow-hidden max-h-[350px] overflow-y-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="bg-slate-100 text-[10px] font-bold uppercase text-slate-500 border-b border-slate-200">
                        <th className="p-3 text-center w-12">In</th>
                        <th className="p-3 text-left min-w-[130px]">Dự án (Project)</th>
                        <th className="p-3 text-left min-w-[180px]">Tên Kiện hàng / Module</th>
                        <th className="p-3 text-center w-16">Unit</th>
                        <th className="p-3 text-center w-24">Area</th>
                        <th className="p-3 text-center w-16">Type</th>
                        <th className="p-3 text-center w-16">W</th>
                        <th className="p-3 text-center w-16">D</th>
                        <th className="p-3 text-center w-16">H</th>
                        <th className="p-3 text-center w-30">Cân (Kg)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 bg-white">
                      {filteredPrintItems.length === 0 ? (
                        <tr>
                          <td colSpan={10} className="p-8 text-center text-gray-400">
                            Không có tem nào khớp với bộ lọc đang chọn
                          </td>
                        </tr>
                      ) : (
                        filteredPrintItems.map((item) => (
                          <tr key={item.tempId} className={`hover:bg-slate-100/55 transition-all ${item.selected ? '' : 'opacity-40'}`}>
                            <td className="p-2 text-center">
                              <input
                                type="checkbox"
                                checked={item.selected}
                                onChange={(e) => {
                                  setPrintItems(prev => prev.map(p =>
                                    p.tempId === item.tempId ? { ...p, selected: e.target.checked } : p
                                  ));
                                }}
                                className="w-4 h-4 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500 cursor-pointer"
                              />
                            </td>
                            <td className="p-2">
                              <input
                                type="text"
                                value={item.projectName}
                                onChange={(e) => {
                                  setPrintItems(prev => prev.map(p =>
                                    p.tempId === item.tempId ? { ...p, projectName: e.target.value } : p
                                  ));
                                }}
                                className="w-full bg-slate-100 border border-transparent hover:border-slate-200 focus:border-indigo-500 focus:bg-white p-1 rounded-lg font-bold text-slate-800 uppercase outline-none"
                              />
                            </td>
                            <td className="p-2">
                              <input
                                type="text"
                                value={item.name}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  // Thử phân tích lại kích thước tự động nếu sửa tên
                                  const parsed = parseItemDimensionsAndInfo(val);
                                  // Thử tìm khớp cấu kiện trong projectEntries để lấy Cụm (cluster) chuẩn
                                  const matchedEntry = projectEntries ? projectEntries.find(ent => {
                                    const cleanModuleCode = (ent.moduleCode || '').trim().toLowerCase();
                                    const cleanItemName = (val || '').trim().toLowerCase();
                                    return cleanModuleCode === cleanItemName ||
                                      cleanItemName.includes(cleanModuleCode) ||
                                      cleanModuleCode.includes(cleanItemName);
                                  }) : undefined;
                                  const unitVal = extractSubProjectCode(packingList.projectCode) || parsed.unit || "-";
                                  const areaVal = formatAreaName(matchedEntry?.cluster || parsed.area);

                                  setPrintItems(prev => prev.map(p =>
                                    p.tempId === item.tempId ? {
                                      ...p,
                                      name: val,
                                      unit: unitVal,
                                      area: areaVal,
                                      cabinetType: parsed.cabinetType,
                                      w: parsed.w,
                                      d: parsed.d,
                                      h: parsed.h,
                                      weight: calculateCabinetWeight(parsed.w, parsed.d, parsed.h)
                                    } : p
                                  ));
                                  updateSingleQR(item.tempId, val);
                                }}
                                className="w-full bg-slate-100 border border-transparent hover:border-slate-200 focus:border-indigo-500 focus:bg-white p-1 rounded-lg font-semibold text-slate-800 uppercase outline-none"
                              />
                            </td>
                            <td className="p-2">
                              <input
                                type="text"
                                value={item.unit}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  setPrintItems(prev => prev.map(p =>
                                    p.tempId === item.tempId ? { ...p, unit: val } : p
                                  ));
                                }}
                                className="w-[60px] bg-transparent text-center border-b border-transparent focus:border-slate-300 uppercase outline-none px-1"
                              />
                            </td>
                            <td className="p-2">
                              <input
                                type="text"
                                value={item.area}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  setPrintItems(prev => prev.map(p =>
                                    p.tempId === item.tempId ? { ...p, area: val } : p
                                  ));
                                }}
                                className="w-[85px] bg-transparent text-center border-b border-transparent focus:border-slate-300 uppercase outline-none px-1"
                              />
                            </td>
                            <td className="p-2">
                              <input
                                type="text"
                                value={item.cabinetType}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  setPrintItems(prev => prev.map(p =>
                                    p.tempId === item.tempId ? { ...p, cabinetType: val } : p
                                  ));
                                }}
                                className="w-[60px] bg-transparent text-center border-b border-transparent focus:border-slate-300 uppercase outline-none px-1"
                              />
                            </td>
                            <td className="p-2">
                              <input
                                type="text"
                                value={item.w}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  setPrintItems(prev => prev.map(p =>
                                    p.tempId === item.tempId ? {
                                      ...p,
                                      w: val,
                                      weight: calculateCabinetWeight(val, p.d, p.h)
                                    } : p
                                  ));
                                }}
                                className="w-[45px] bg-transparent text-center border-b border-transparent focus:border-slate-300 outline-none px-1 font-mono"
                              />
                            </td>
                            <td className="p-2">
                              <input
                                type="text"
                                value={item.d}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  setPrintItems(prev => prev.map(p =>
                                    p.tempId === item.tempId ? {
                                      ...p,
                                      d: val,
                                      weight: calculateCabinetWeight(p.w, val, p.h)
                                    } : p
                                  ));
                                }}
                                className="w-[45px] bg-transparent text-center border-b border-transparent focus:border-slate-300 outline-none px-1 font-mono"
                              />
                            </td>
                            <td className="p-2">
                              <input
                                type="text"
                                value={item.h}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  setPrintItems(prev => prev.map(p =>
                                    p.tempId === item.tempId ? {
                                      ...p,
                                      h: val,
                                      weight: calculateCabinetWeight(p.w, p.d, val)
                                    } : p
                                  ));
                                }}
                                className="w-[45px] bg-transparent text-center border-b border-transparent focus:border-slate-300 outline-none px-1 font-mono"
                              />
                            </td>
                            <td className="p-2">
                              <input
                                type="text"
                                value={item.weight}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  setPrintItems(prev => prev.map(p =>
                                    p.tempId === item.tempId ? { ...p, weight: val } : p
                                  ));
                                }}
                                className="w-[55px] bg-transparent text-center border-b border-transparent focus:border-slate-300 outline-none px-1 font-mono font-bold"
                              />
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="px-6 py-4 border-t border-slate-200 flex items-center justify-between bg-slate-100">
              <span className="text-[10px] text-gray-400 font-bold uppercase">
                Số lượng tem được chọn: {filteredPrintItems.filter(i => i.selected).length} / {filteredPrintItems.length} cái (bộ lọc) | Tổng: {printItems.filter(i => i.selected).length} / {printItems.length} cái
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setShowPrintLabelModal(false)}
                  className="px-4 py-2 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded-lg font-bold text-xs uppercase transition-all cursor-pointer"
                >
                  Đóng
                </button>
                {!isGuest && (
                <button
                  type="button"
                  onClick={handleSaveLabelData}
                  className="px-4 py-2 bg-indigo-100 hover:bg-indigo-200 text-indigo-700 rounded-lg font-bold text-xs uppercase transition-all cursor-pointer flex items-center gap-1"
                >
                  <Save size={12} />
                  Lưu thông tin tem
                </button>
                )}
                <button
                  type="button"
                  disabled={filteredPrintItems.filter(i => i.selected).length === 0}
                  onClick={() => {
                    setTimeout(() => {
                      window.print();
                    }, 150);
                  }}
                  className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 disabled:text-slate-500 text-white rounded-lg font-black text-xs uppercase tracking-wider transition-all shadow-lg shadow-emerald-200 flex items-center gap-1 cursor-pointer"
                >
                  <span>🖨️ In Tem Ngay</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Vùng In tem hằn bằng CSS media print */}
      {showPrintLabelModal && createPortal(
        <div id="label-print-area" className="hidden">
          <style
            dangerouslySetInnerHTML={{
              __html: `
 @page { size: A5 landscape; margin: 0; }
 @media screen {
 #label-print-area {
 display: none !important;
 }
 }

 @media print {
 body > *:not(#label-print-area) {
 display: none !important;
 }
 #label-print-area {
 display: block !important;
 position: absolute !important;
 left: 0 !important;
 top: 0 !important;
 width: 210mm !important;
 height: auto !important;
 background: white !important;
 padding: 0 !important;
 margin: 0 !important;
 box-sizing: border-box !important;
 overflow: visible !important;
 }
 .print-page-wrapper:last-child {
 page-break-after: avoid !important;
 break-after: avoid !important;
 }
 .print-label-card img, .bcons-card img, .bcons-box img, .qr img {
 max-width: 100% !important;
 max-height: 100% !important;
 object-fit: contain !important;
 }
 * {
 -webkit-print-color-adjust: exact !important;
 print-color-adjust: exact !important;
 }
 #label-print-area .print-page-wrapper {
 width: 210mm !important;
 height: 148mm !important;
 display: flex !important;
 align-items: center !important;
 justify-content: center !important;
 box-sizing: border-box !important;
 page-break-after: always !important;
 break-after: page !important;
 page-break-inside: avoid !important;
 break-inside: avoid !important;
 margin: 0 !important;
 padding: 0 !important;
 background: white !important;
 }
 }
 `
            }}
          />
          <style>{LABEL_CSS}</style>

          {(() => {
            const selectedItemsToPrint = filteredPrintItems.filter(item => item.selected);
            const flatPrintList: Array<{ item: typeof selectedItemsToPrint[0]; copyIdx: number }> = [];
            selectedItemsToPrint.forEach(item => {
              for (let i = 0; i < printCopies; i++) {
                flatPrintList.push({ item, copyIdx: i });
              }
            });

            return flatPrintList.map(({ item, copyIdx }) => {
              const cardHtml = generateLabelCardHtml(
                {
                  name: item.name,
                  projectName: item.projectName,
                  unit: item.unit,
                  area: item.area,
                  cabinetType: item.cabinetType,
                  w: item.w,
                  d: item.d,
                  h: item.h,
                  weight: item.weight,
                  qrUrl: qrUrls[item.tempId],
                  supplierDept: bconsDept,
                  deliveryAddress: bconsAddress,
                  receiverName: bconsReceiver,
                  receiverPhone: bconsPhone,
                  printDate: new Date().toLocaleDateString('vi-VN'),
                },
                printMultiUnit ? 'CODE' : 'UNIT',
                formTemplate
              );
              return (
                <div
                  key={`print-real-wrapper-${item.tempId}-${copyIdx}`}
                  className="print-page-wrapper"
                  dangerouslySetInnerHTML={{ __html: cardHtml }}
                />
              );
            });
          })()}
        </div>,
        document.body
      )}

      {/* Raw Data Modal */}
      {showRawData && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[200] flex items-center justify-center p-4">
          <div className="bg-white rounded-lg w-full max-w-3xl max-h-[85vh] flex flex-col shadow-2xl border border-gray-200">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-gray-50 rounded-t-lg">
              <div className="flex items-center gap-2">
                <Code size={16} className="text-indigo-600" />
                <h3 className="text-sm font-black text-gray-800 uppercase tracking-tight">Raw Data — {packingList.title || packingList.id}</h3>
              </div>
              <button onClick={() => setShowRawData(false)} className="p-1.5 hover:bg-gray-200 rounded-lg transition-all">
                <X size={16} className="text-gray-500" />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-4">
              <pre className="text-[11px] font-mono text-gray-700 whitespace-pre-wrap break-all bg-gray-50 rounded-lg p-4 border border-gray-200">
                {JSON.stringify({ ...packingList, items }, null, 2)}
              </pre>
            </div>
            <div className="px-4 py-3 border-t border-gray-200 flex justify-end">
              <button
                onClick={() => {
                  navigator.clipboard.writeText(JSON.stringify({ ...packingList, items }, null, 2));
                  showSuccess('Đã copy raw data!');
                }}
                className="px-4 py-2 bg-indigo-600 text-white text-xs font-black uppercase tracking-wider rounded-lg hover:bg-indigo-700 transition-all flex items-center gap-2"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
                Copy
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}