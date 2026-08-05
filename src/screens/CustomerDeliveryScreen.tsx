import React, { useState, useEffect } from 'react';
import {
  Check, X, QrCode, ArrowLeft, Loader2, Search, Edit3, Save, AlertCircle, Share2, Info, UserCheck, CheckCircle2, Box, Printer, Image as ImageIcon, ScanQrCode, Cuboid, ChevronLeft, ChevronRight
} from 'lucide-react';
import { doc, onSnapshot, updateDoc, getDoc, getDocs, collection, query, where } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { findProjectConfigId, updateProjectModule } from '../lib/dualWrite';
import { ScannerModal, ScannedResult } from '../components/ScannerModal';
import { useAuth } from '../lib/AuthContext';
import { getModuleQcAggregate, getModuleInstances } from '../types';
import { motion, AnimatePresence } from 'motion/react';
import { ModuleThreeViewer, preCheckModuleInGlb } from '../components/project/ModuleThreeViewer';
import { useGLTF } from '@react-three/drei';
import { formatProjectCode } from '../lib/formatters';

interface CustomerDeliveryScreenProps {
  packingId: string;
  onBack: () => void;
}

export function CustomerDeliveryScreen({ packingId, onBack }: CustomerDeliveryScreenProps) {
  const { user } = useAuth();
  const [packing, setPacking] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [showScanner, setShowScanner] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeItem, setActiveItem] = useState<any | null>(null);
  const [editingNotes, setEditingNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [scanMessage, setScanMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);
  const [shareCopied, setShareCopied] = useState(false);

  const [loadingHistories, setLoadingHistories] = useState<any[]>([]);
  const [allPackingItems, setAllPackingItems] = useState<any[]>([]);
  const [projects, setProjects] = useState<any[]>([]);

  // State for detail modal
  const [selectedDetailItem, setSelectedDetailItem] = useState<any | null>(null);
  const [lightboxImages, setLightboxImages] = useState<string[]>([]);
  const [lightboxStartIndex, setLightboxStartIndex] = useState(0);
  const [hasGlbMatch, setHasGlbMatch] = useState(false);

  // Pre-check GLB + preload when detail modal opens
  useEffect(() => {
    if (!selectedDetailItem?.glbUrl || !selectedDetailItem?.name) {
      setHasGlbMatch(false);
      return;
    }
    const glbUrl = selectedDetailItem.glbUrl.trim();
    let cancelled = false;

    // Preload into drei cache so ModuleThreeViewer renders instantly
    useGLTF.preload(glbUrl);

    setHasGlbMatch(false);
    preCheckModuleInGlb(glbUrl, selectedDetailItem.name).then(found => {
      if (!cancelled) setHasGlbMatch(found);
    });
    return () => { cancelled = true; };
  }, [selectedDetailItem]);

  // Sync packing list in real-time
  useEffect(() => {
    if (!packingId) return;
    const docRef = doc(db, 'loading', packingId);
    const unsub = onSnapshot(docRef, (docSnap) => {
      if (docSnap.exists()) {
        setPacking({ id: docSnap.id, ...docSnap.data() });
      } else {
        setPacking(null);
      }
      setLoading(false);
    }, (error) => {
      console.warn("Error loading PKL list for package handover:", error);
      setLoading(false);
    });

    return unsub;
  }, [packingId]);

  // Sync loading_histories in real-time for this PKL
  useEffect(() => {
    if (!packingId) return;
    const q = query(
      collection(db, 'loading_histories'),
      where('pklId', '==', packingId)
    );
    const unsub = onSnapshot(q, (snapshot) => {
      const histories = snapshot.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));
      setLoadingHistories(histories);
    }, (error) => {
      console.warn("Error loaded loading histories for handover:", error);
    });

    return unsub;
  }, [packingId]);

  // Sync packing details matching the bundle name
  useEffect(() => {
    const q = query(collection(db, 'packing'));
    const unsub = onSnapshot(q, (snapshot) => {
      const lists = snapshot.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() } as any));
      const allItems: any[] = [];
      lists.forEach(list => {
        if (list.items) {
          list.items.forEach((it: any) => {
            allItems.push({
              item: it,
              packingDocId: list.id,
              projectCode: list.projectCode || '',
              projectName: list.projectName || ''
            });
          });
        }
      });
      setAllPackingItems(allItems);
    }, (error) => {
      console.warn("Error loaded packing details:", error);
    });

    return unsub;
  }, []);

  // Sync projects list to retrieve entries and QC reports
  useEffect(() => {
    const q = query(collection(db, 'projectConfigs'));
    const unsub = onSnapshot(q, (snapshot) => {
      setProjects(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
    }, (error) => {
      console.warn("Error synchronized project logs:", error);
    });

    return unsub;
  }, []);

  // Sync editing notes if active entry changes
  useEffect(() => {
    if (activeItem) {
      setEditingNotes(activeItem.customerReceivedNotes || '');
    } else {
      setEditingNotes('');
    }
  }, [activeItem]);

  const parseItemDimensionsAndInfo = (name: string) => {
    let w = "0";
    let d = "0";
    let h = "0";
    let unit = "BLDG1";
    let area = "KITCHEN";
    let cabinetType = "T1";

    const rPrefix = /W\s*(\d+)\s*D\s*(\d+)\s*H\s*(\d+)/i;
    const matchPrefix = name.match(rPrefix);
    if (matchPrefix) {
      w = matchPrefix[1];
      d = matchPrefix[2];
      h = matchPrefix[3];
    } else {
      const rCross = /(\d+)\s*[xX*]\s*(\d+)\s*[xX*]\s*(\d+)/;
      const matchCross = name.match(rCross);
      if (matchCross) {
        w = matchCross[1];
        d = matchCross[2];
        h = matchCross[3];
      }
    }

    const rType = /\b(T\d+|MC\d+|B\d+|U\d+|D\d+|A\d+)\b/i;
    const matchType = name.match(rType);
    if (matchType) {
      cabinetType = matchType[1].toUpperCase();
    }

    const upperName = name.toUpperCase();
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
    }

    if (matchedArea) {
      area = matchedArea;
    } else {
      const rArea = /\b(KITCHEN|BEDROOM|LIVING|WC|TOILET|LPN|PK|PN|DINING|BẾP|KHÁCH|NGỦ)\b/i;
      const matchArea = name.match(rArea);
      if (matchArea) {
        let areaVal = matchArea[1].toUpperCase();
        if (areaVal === 'BẾP') areaVal = 'KITCHEN';
        if (areaVal === 'NGỦ' || areaVal === 'LPN' || areaVal === 'PN') areaVal = 'BEDROOM';
        area = areaVal;
      }
    }

    const rUnit = /(BLDG\s*\d+|APARTMENT\s*\d+|ROOM\s*\d+|P\d{3}|L\d+|T\d+|BẦU|TẦNG\s*\d+)/i;
    const matchUnit = name.match(rUnit);
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
    if (code.includes('ELMB')) {
      code = code.replace(/ELMB/g, 'BLDG');
    }
    return code;
  };

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

  const calculateCabinetWeight = (wStr: string, dStr: string, hStr: string): string => {
    const w = parseFloat(wStr) || 0;
    const d = parseFloat(dStr) || 0;
    const h = parseFloat(hStr) || 0;

    if (w <= 0 || d <= 0 || h <= 0) return "0";

    const doorsAndBack = h * w * 18 * 2;
    const sides = h * d * 18 * 2;
    const topAndBottom = w * d * 18 * 2;

    const totalMm3 = doorsAndBack + sides + topAndBottom;
    const totalM3 = totalMm3 / 1000000000;
    const weightKg = totalM3 * 750;

    return (Math.round(weightKg * 10) / 10).toString();
  };

  const computedItems = React.useMemo(() => {
    const grouped: Record<string, {
      name: string;
      projectName: string;
      displayName: string;
      glbUrl: string;
      isCtht: boolean;
      cluster: string;
      unit: string;
      cabinetType: string;
      quantity: number;
      receivedCount: number;
      weight: number;
      dimensions: string;
      customerReceived: boolean;
      histories: any[];
      accessories: any[];
      matchedEntry: any;
      matchedPkg: any;
    }> = {};

    loadingHistories.forEach(history => {
      const nameKey = history.packageName || '';
      if (!nameKey) return;

      if (!grouped[nameKey]) {
        const matchedPkg = allPackingItems.find(x => x.item && x.item.name === nameKey);
        const item = matchedPkg?.item;
        const pkgProjectCode = history.projectCode || matchedPkg?.projectCode || packing?.projectCode || '';
        const pkgProjectName = history.projectName || matchedPkg?.projectName || packing?.projectName || '';

        const isCthtKien = item?.subType === 'kienCTHT';

        // UNIT: lấy BLDGx từ projectCode
        let displayUnit = '-';
        if (pkgProjectCode) {
          const parts = pkgProjectCode.toUpperCase().split('_');
          const bldgPart = parts.find((p: string) => /ELMB|BLDG/.test(p));
          if (bldgPart) {
            displayUnit = bldgPart.replace(/ELMB/g, 'BLDG').replace(/\d+$/, '').replace(/BLDG$/, 'BLDG');
            const num = bldgPart.match(/(\d+)/);
            if (num) displayUnit += num[1];
          } else {
            displayUnit = pkgProjectCode.split('_')[0] || '-';
          }
        }

        // AREA: ưu tiên từ packing item, rồi parse từ tên
        let displayArea = item?.cluster || '-';
        if (displayArea === '-' || !displayArea) {
          const parsed = parseItemDimensionsAndInfo(nameKey);
          displayArea = formatAreaName(parsed.area || '-');
        } else {
          displayArea = formatAreaName(displayArea);
        }

        // CABINET TYPE: tách sau dấu .
        let cabinetType = nameKey;
        if (!isCthtKien) {
          const dotIdx = nameKey.lastIndexOf('.');
          if (dotIdx >= 0) {
            cabinetType = nameKey.substring(dotIdx + 1).trim().toUpperCase();
          } else {
            const nameParts = nameKey.split('_');
            cabinetType = nameParts.length > 1 ? nameParts.slice(1).join('_').toUpperCase() : nameKey;
          }
        }

        // W D H: ưu tiên từ packing item
        let w = item?.w || '0';
        let d = item?.d || '0';
        let h = item?.h || '0';
        if ((!w || w === '0') && (!d || d === '0') && (!h || h === '0')) {
          const parsed = parseItemDimensionsAndInfo(nameKey);
          w = parsed.w || '0';
          d = parsed.d || '0';
          h = parsed.h || '0';
        }

        // WEIGHT: ưu tiên từ packing item
        const initialWeight = calculateCabinetWeight(w, d, h);
        const displayWeight = item?.weight ? item.weight : (initialWeight !== "0" ? parseFloat(initialWeight) : 0);

        // Matched entry cho QC photos & project name
        const matchedEntry = (item && projects?.find((e: any) => e.id === item.id)) || null;

        // Tách projectCode sạch: MED026_BLDG2_9713 → MED026_BLDG2
        let lookupCode = '';
        if (pkgProjectCode) {
          const parts = pkgProjectCode.split('_');
          const bldgIdx = parts.findIndex((p: string) => /ELMB|BLDG/i.test(p));
          lookupCode = bldgIdx >= 0 ? parts.slice(0, bldgIdx + 1).join('_') : parts.slice(0, 2).join('_');
        }
        console.log('[CustomerDelivery] type:', isCthtKien ? 'CTHT' : 'standard', '| name:', nameKey);

        // Resolve tên dự án từ projectConfigs
        const matchedProject = lookupCode ? projects?.find((p: any) => p.projectCode === lookupCode) : null;
        let projectName = matchedProject?.projectName || '';
        if (!projectName) {
          projectName = matchedEntry?.projectName || pkgProjectName || formatProjectCode(pkgProjectCode) || packing?.projectName || '';
        }

        // Resolve glbUrl từ projectConfigs
        const glbUrl = matchedProject?.glbUrl || '';

        const displayName = [projectName, displayArea, cabinetType].filter(Boolean).join(' - ') || nameKey;

        const dimensions = `${w} x ${d} x ${h} mm`;

        const accessories: any[] = [];
        if (item?.accessories) {
          item.accessories.forEach((acc: any) => {
            accessories.push({
              name: acc.name,
              quantity: acc.quantity
            });
          });
        }

        grouped[nameKey] = {
          name: nameKey,
          projectName,
          displayName,
          glbUrl,
          isCtht: isCthtKien,
          cluster: displayArea,
          unit: displayUnit,
          cabinetType: cabinetType || "-",
          quantity: 0,
          receivedCount: 0,
          weight: Number(displayWeight) || 0,
          dimensions,
          customerReceived: false,
          histories: [],
          accessories,
          matchedEntry,
          matchedPkg
        };
      }

      grouped[nameKey].quantity += 1;
      grouped[nameKey].histories.push(history);
      if (history.customerReceived) {
        grouped[nameKey].receivedCount += 1;
      }
    });

    Object.values(grouped).forEach(g => {
      g.customerReceived = g.receivedCount >= g.quantity;
    });

    // Sắp xếp theo Cụm (cluster) trước, nếu cùng cụm thì sắp xếp theo Tên cấu kiện (name) theo alphabetti
    return Object.values(grouped).sort((a, b) => {
      const clusterA = (a.cluster || '').trim().toLowerCase();
      const clusterB = (b.cluster || '').trim().toLowerCase();

      if (clusterA !== clusterB) {
        if (clusterA === '-' || clusterA === '') return 1;
        if (clusterB === '-' || clusterB === '') return -1;
        return clusterA.localeCompare(clusterB, 'vi');
      }

      const nameA = (a.name || '').trim().toLowerCase();
      const nameB = (b.name || '').trim().toLowerCase();
      return nameA.localeCompare(nameB, 'vi');
    });
  }, [loadingHistories, allPackingItems, projects, packing]);

  // Filter items
  const filteredItems = computedItems.filter((item) => {
    if (!searchQuery) return true;
    const search = searchQuery.toLowerCase();
    return (item.displayName || '').toLowerCase().includes(search) ||
      (item.cluster && (item.cluster || '').toLowerCase().includes(search)) ||
      (item.unit && (item.unit || '').toLowerCase().includes(search));
  });

  const totalCount = loadingHistories.length;
  const receivedCount = loadingHistories.filter((h: any) => h.customerReceived).length;
  const progressPercent = totalCount > 0 ? Math.round((receivedCount / totalCount) * 100) : 0;

  // Handle client receiving confirmation for a specific loading_history document at real-time
  const handleHistoryClientReceive = async (historyId: string, notes?: string, customBy?: string) => {
    setIsSubmitting(true);
    try {
      const clientName = customBy || user?.displayName || user?.email || 'Customer';
      const docRef = doc(db, 'loading_histories', historyId);

      await updateDoc(docRef, {
        customerReceived: true,
        customerReceivedBy: clientName,
        customerReceivedAt: new Date().toISOString(),
        customerReceivedNotes: notes || 'Verified and received in complete conditions'
      });

      setScanMessage({
        type: 'success',
        text: `Handover recorded successfully`
      });
      setTimeout(() => setScanMessage(null), 4000);
    } catch (err) {
      console.error("Error updating client receipt:", err);
      setScanMessage({
        type: 'error',
        text: `Failed to save record. System error.`
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  // Scan handler for package tags QR code
  const handleScanPackage = async (result: ScannedResult) => {
    if (!packing || !loadingHistories.length) return;
    const scannedText = (result.rawCode || result.moduleCode || '').trim();

    if (!scannedText) {
      setScanMessage({ type: 'error', text: 'Scanned code is empty!' });
      return;
    }

    // Strip print postfix if applicable
    const cleanScanned = scannedText.split('----')[0].trim();

    // Find loading histories matching this package name
    const eligibleHistories = loadingHistories.filter((h: any) => {
      const cleanName = (h.packageName || '').trim();
      return cleanName === cleanScanned || cleanName.toLowerCase() === (cleanScanned || '').toLowerCase() || (cleanName && scannedText.includes(cleanName));
    });

    if (eligibleHistories.length === 0) {
      setScanMessage({
        type: 'error',
        text: `Scanned item QR "${cleanScanned.slice(0, 25)}" not present in this loading list!`
      });
      return;
    }

    // Find matching computed item to open detail modal
    const matchedItem = computedItems.find(item => item.name === cleanScanned || item.name.toLowerCase() === cleanScanned.toLowerCase());
    const allReceived = eligibleHistories.every((h: any) => h.customerReceived);

    // Close scanner
    setShowScanner(false);

    // Open detail modal for this item
    if (matchedItem) {
      setSelectedDetailItem(matchedItem);
    }

    // If not all received, confirm receipt and show toast
    if (!allReceived) {
      const pendingHistory = eligibleHistories.find((h: any) => !h.customerReceived);
      if (pendingHistory) {
        await handleHistoryClientReceive(pendingHistory.id, 'Verified via QR Code scan', user?.displayName || user?.email || 'Customer');

        // Sync instance delivery to projectConfigs: mark first undelivered instance as delivered
        try {
          const historyProjectCode = pendingHistory.projectCode || '';
          const historyPackageName = pendingHistory.packageName || cleanScanned;

          if (historyProjectCode && historyPackageName) {
            const configId = await findProjectConfigId(historyProjectCode);
            if (configId) {
              // Query module by moduleCode in the project's modules subcollection
              const modulesQ = query(
                collection(db, 'projectConfigs', configId, 'modules'),
                where('moduleCode', '==', historyPackageName)
              );
              const modulesSnap = await getDocs(modulesQ);
              if (!modulesSnap.empty) {
                const modDoc = modulesSnap.docs[0];
                const entryData = modDoc.data() as any;
                const currentInstances = getModuleInstances(entryData);
                const clientName = user?.displayName || user?.email || 'Customer';
                const newDeliveryLog = {
                  type: 'receive' as const,
                  date: new Date(),
                  by: clientName,
                  notes: 'Nhận từ khách qua QR scan'
                };

                // Find first undelivered instance and mark only that one
                let nextReceived = entryData.receivedQuantity || 0;
                let markedOne = false;
                const updatedInstances = currentInstances.map(inst => {
                  if (!inst.delivered && !markedOne) {
                    markedOne = true;
                    nextReceived += 1;
                    return { ...inst, delivered: true, deliveryLogs: [...(inst.deliveryLogs || []), newDeliveryLog] };
                  }
                  return inst;
                });

                // Only update if we actually marked an instance
                if (markedOne) {
                  const isFullyReceived = nextReceived >= entryData.quantity;
                  const newStatus = isFullyReceived ? 'Giao Nhận - Đã nhận' : 'Giao Nhận - Đang nhận';
                  const historyArr = [...(entryData.statusHistory || [])];
                  if (!historyArr.length || historyArr[historyArr.length - 1].split('|')[0] !== newStatus) {
                    historyArr.push(`${newStatus}|${Date.now()}`);
                  }

                  await updateProjectModule(modDoc.id, {
                    instances: updatedInstances,
                    receivedQuantity: nextReceived,
                    status: newStatus,
                    statusHistory: historyArr
                  }, historyProjectCode);
                }
              }
            }
          }
        } catch (syncErr) {
          console.error('[CustomerDelivery] Failed to sync instance to project:', syncErr);
        }
      }
    }
    // If all received, just open modal (no toast)
  };

  const handleShareLink = () => {
    const link = `${window.location.origin}/?customer_delivery=${packingId}`;
    navigator.clipboard.writeText(link).then(() => {
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 3000);
    }).catch(err => {
      console.error("Link copying error:", err);
    });
  };

  // Get QC photos from instances (pass only, exclude fail) + packing photos
  const computeItemPhotos = (gItem: any) => {
    const photos: string[] = [];

    // 1. QC photos from instances (pass only)
    const entry = gItem.matchedEntry;
    if (entry) {
      const instances = getModuleInstances(entry);
      instances.forEach(inst => {
        ['qcFinish', 'qcPack'].forEach(field => {
          const qc = (inst as any)[field];
          if (qc?.status === 'pass' && Array.isArray(qc.photos)) {
            qc.photos.forEach((img: string) => {
              if (img && !photos.includes(img)) photos.push(img);
            });
          }
        });
      });
    }

    // 2. Packing photos from packing collection
    if (gItem.matchedPkg?.item?.photos && Array.isArray(gItem.matchedPkg.item.photos)) {
      gItem.matchedPkg.item.photos.forEach((img: string) => {
        if (img && !photos.includes(img)) photos.push(img);
      });
    }

    return photos;
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-100 flex flex-col items-center justify-center space-y-4" id="delivery-customer-loading">
        <Loader2 className="animate-spin text-indigo-600" size={32} />
        <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Loading Handover Packing List...</p>
      </div>
    );
  }

  if (!packing) {
    return (
      <div className="min-h-screen bg-slate-100 flex flex-col items-center justify-center p-6 text-center space-y-6" id="delivery-customer-not-found">
        <AlertCircle size={48} className="text-rose-500" />
        <div className="space-y-2">
          <h2 className="text-xl font-black text-slate-800 uppercase tracking-tight font-sans">Handover Document Not Found</h2>
          <p className="text-xs text-slate-500 max-w-sm mx-auto leading-relaxed font-bold uppercase">
            The requested certificate may have been removed or link is outdated. Check connections.
          </p>
        </div>
        <button
          onClick={onBack}
          className="border border-slate-200 bg-white hover:bg-slate-100 text-slate-700 font-extrabold py-2 px-4 rounded-lg text-xs uppercase tracking-wider transition-all active:scale-95 cursor-pointer"
        >
          Return Home
        </button>
      </div>
    );
  }

  const currentPklCode = packing.pklCode || packing.id;

  return (
    <div className="min-h-screen bg-slate-100/50 pb-20 font-sans" id="customer-delivery-screen">
      {/* CSS in cho biểu mẫu A4 tiếng Anh */}
      <style dangerouslySetInnerHTML={{
        __html: `
 @media print {
 body {
 background: white !important;
 color: black !important;
 font-family: system-ui, -apple-system, sans-serif !important;
 padding: 4mm !important;
 box-sizing: border-box !important;
 }
 #customer-delivery-screen {
 background: transparent !important;
 padding: 0 !important;
 }
 .no-print {
 display: none !important;
 }
 .print-visible {
 display: block !important;
 }
 table {
 width: 100% !important;
 border-collapse: collapse !important;
 margin-top: 10px !important;
 }
 th, td {
 border: 0.5px solid #000 !important;
 padding: 4px 6px !important;
 text-align: left !important;
 font-size: 8.5pt !important;
 line-height: 1.2 !important;
 }
 th {
 background-color: #f3f4f6 !important;
 font-weight: bold !important;
 text-transform: uppercase !important;
 }
 @page {
 size: A4 portrait !important;
 margin: 5mm !important;
 }
 }
 `}} />

      {/* Giao diện tương tác thường - Ẩn khi In */}
      <div className="no-print">
        {/* Header phẳng bo tròn */}
        <div className="bg-white border-b border-slate-100 sticky top-0 z-40 px-4 py-3.5 shadow-xs">
          <div className="max-w-4xl mx-auto flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <button
                onClick={onBack}
                className="p-2 hover:bg-slate-100 rounded-lg text-slate-500 transition-colors cursor-pointer"
                title="Go Back"
              >
                <ArrowLeft size={18} />
              </button>
              <div>
                <h1 className="text-base font-black text-slate-800 uppercase tracking-tight flex items-center gap-2">
                  <span>Client Delivery Confirmation</span>
                  <span className="text-[10px] bg-indigo-100 text-indigo-700 border border-indigo-100 px-2 py-0.5 rounded-lg font-extrabold uppercase">
                    Handover Status
                  </span>
                </h1>
                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider mt-0.5">
                  PKL CODE: {currentPklCode}
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="max-w-4xl mx-auto px-4 py-6 space-y-6">
          {/* Banner tiến độ */}
          <div className="bg-white border border-slate-100 p-5 rounded-lg shadow-xs space-y-3.5">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
              <div>
                <h2 className="text-sm font-black text-slate-800 uppercase tracking-tight">Handover Handshake Progress</h2>
                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider mt-0.5">
                  Scan box-level tags to confirm successful delivery receipts at physical loading spot.
                </p>
              </div>
              <div className="text-right">
                <span className="text-xl font-black text-indigo-600 font-sans">{receivedCount}</span>
                <span className="text-xs font-bold text-slate-400"> / {totalCount} Packages</span>
              </div>
            </div>

            {/* Thanh Tiến Độ */}
            <div className="w-full bg-slate-100 h-2.5 rounded-lg overflow-hidden">
              <div
                className="bg-indigo-600 h-full rounded-lg transition-all duration-500"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            <div className="flex items-center justify-between text-[10px] text-slate-400 font-black uppercase tracking-wider pt-1">
              <span>Pending checklist: {totalCount - receivedCount} units</span>
              <span className="text-indigo-600">{progressPercent}% Receipt Verified</span>
            </div>
          </div>

          {/* Hướng dẫn chỉ QR */}
          <div className="bg-indigo-100/50 border border-indigo-100 p-4 rounded-lg flex items-start gap-3 text-xs text-indigo-900 font-semibold leading-relaxed">
            <QrCode className="text-indigo-600 shrink-0 mt-0.5" size={16} />
            <div className="space-y-1">
              <p className="font-extrabold uppercase tracking-wide text-indigo-900">Verification Protocol Required</p>
              <p>For high-quality wood cabinets compliance, receipt verification must be confirmed via physical QR scanning on the cabinet. Tap any cargo row below to review unit specifications, subcomponents, and approved QC photos records.</p>
            </div>
          </div>

          {/* Thông báo quét / lưu */}
          <AnimatePresence>
            {scanMessage && (
              <motion.div
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className={`p-3.5 rounded-lg border text-xs font-bold uppercase tracking-wide flex items-center gap-2 ${scanMessage.type === 'success'
                  ? 'bg-emerald-100 border-emerald-200 text-emerald-800'
                  : 'bg-rose-100 border-rose-300 text-rose-800'
                  }`}
              >
                <Info size={14} />
                <span>{scanMessage.text}</span>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Bộ lọc kiện tìm kiếm */}
          <div className="bg-white border border-slate-100 rounded-lg p-4 shadow-xs flex items-center gap-3 sticky top-[52px] z-30">
            <Search size={16} className="text-slate-400 shrink-0" />
            <input
              type="text"
              placeholder="Search by package name, area, apartment unit..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-transparent focus:outline-none text-xs font-bold text-slate-700 placeholder:text-slate-300"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="p-1 hover:bg-slate-100 rounded-lg text-slate-400 cursor-pointer"
              >
                <X size={14} />
              </button>
            )}
          </div>

          {/* Danh sách các kiện */}
          <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
            {filteredItems.length === 0 ? (
              <div className="p-12 text-center text-slate-400 text-xs font-bold uppercase tracking-widest">
                No matching package found in this delivery ledger.
              </div>
            ) : (
              <>
                {/* Header */}
                <div className="hidden sm:grid grid-cols-12 gap-2 px-4 py-2.5 bg-slate-100/50 border-b border-slate-100 text-[9px] font-black uppercase text-slate-400 tracking-widest">
                  <div className="col-span-1 text-center">#</div>
                  <div className="col-span-1 text-center">Status</div>
                  <div className="col-span-5">Cabinet Name / Cargo Label</div>
                  <div className="col-span-2">Area Zone</div>
                  <div className="col-span-2">Dimensions</div>
                  <div className="col-span-1 text-center">Units</div>
                </div>

                {/* Rows */}
                <div className="divide-y divide-slate-100">
                  {filteredItems.map((item, idx) => {
                    const isReceived = item.customerReceived;
                    return (
                      <div
                        key={idx}
                        onClick={() => setSelectedDetailItem(item)}
                        className={`px-4 py-3 flex items-center gap-3 cursor-pointer transition-all hover:bg-slate-50 ${
                          isReceived ? 'bg-emerald-50/30' : ''
                        }`}
                      >
                        {/* # */}
                        <div className="hidden sm:flex w-8 shrink-0 justify-center text-[11px] font-mono text-slate-400">
                          {idx + 1}
                        </div>

                        {/* Status check */}
                        <div className="shrink-0">
                          {isReceived ? (
                            <div className="w-12 h-12 rounded-full bg-emerald-500 flex items-center justify-center">
                              <Check size={16} className="text-white" strokeWidth={3} />
                            </div>
                          ) : (
                            <div className="w-12 h-12 rounded-full border-2 border-slate-200 flex items-center justify-center">
                              <span className="text-[12px] font-black text-slate-300">{item.receivedCount}/{item.quantity}</span>
                            </div>
                          )}
                        </div>

                        {/* Name + Unit */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <h3 className="text-md font-black text-slate-800 uppercase truncate">
                              {item.unit} - {item.cluster} - {item.cabinetType}
                            </h3>
                          </div>
                          <div className="flex items-center gap-1.5 mt-0.5 flex-wrap sm:hidden">
                            {item.projectName && (
                              <span className="text-[8px] bg-indigo-50 text-indigo-600 px-1.5 py-0.5 rounded font-bold uppercase">
                                {item.projectName}
                              </span>
                            )}
                            <span className="text-[8px] text-slate-400 font-bold">
                              {item.dimensions}
                            </span>
                          </div>
                        </div>

                        {/* Area (desktop) */}
                        <div className="hidden sm:block col-span-2 text-xs font-bold text-slate-600 uppercase truncate">
                          <div>
                            {item.unit && item.unit !== '-' && (
                              <span className="text-indigo-600">{item.unit}</span>
                            )}
                            {item.unit && item.unit !== '-' && ' - '}
                            {item.cluster || '—'}
                          </div>
                          {item.cabinetType && item.cabinetType !== '-' && (
                            <div className="text-[10px] text-amber-600 font-semibold">{item.cabinetType}</div>
                          )}
                        </div>

                        {/* Dimensions (desktop) */}
                        <div className="hidden sm:block col-span-2 text-[11px] font-mono text-slate-500">
                          {item.dimensions}
                        </div>


                        {/* Chevron */}
                        <div className="shrink-0">
                          <svg className="w-4 h-4 text-slate-300" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>

          {/* Thẻ Thông Tin Doanh Nghiệp Phát Hành */}
          <div className="bg-white border border-slate-100 rounded-lg p-5 shadow-xs space-y-4 relative overflow-hidden">
            <div className="absolute top-0 right-0 w-24 h-24 bg-indigo-100/40 rounded-full blur-2xl pointer-events-none" />
            <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 border-b border-slate-100 pb-4">
              <div className="flex items-center space-x-3.5">
                <div className="flex items-center gap-2">
                  <img src="https://res.cloudinary.com/dj7w4kp5m/image/upload/v1782285811/JDB_deqzgc.png" className="h-10 w-auto object-contain" referrerPolicy="no-referrer" />
                  <div className="h-6 w-[1px] bg-slate-200" />
                  <img src="https://res.cloudinary.com/dj7w4kp5m/image/upload/v1782285810/easycabinet_bnayvg.png" className="h-10 w-auto object-contain" referrerPolicy="no-referrer" />
                </div>
              </div>
              <div className="text-left md:text-right">
                <span className="text-[10px] font-black tracking-widest text-indigo-600 uppercase block">ISSUING DELIVERY OFFICE</span>
                <span className="text-xs font-black text-slate-800 uppercase tracking-tight">DRACO DESIGN & BUILD / EASY CABINET</span>
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-[11px] text-slate-500 leading-relaxed font-semibold">
              <div className="space-y-1.5">
                <p>📍 <strong className="text-slate-700">HQ Office:</strong> 3rd Floor, Draco Building, No 12, Road 8, Him Lam Area, Tan Hung Ward, District 7, HCMC</p>
                <p>🏭 <strong className="text-slate-700">Factory:</strong> Plot B2, Road 4, Hiep Phuoc Industrial Zone, Nha Be, HCMC</p>
                <p>📇 <strong className="text-slate-700">Tax Identification:</strong> 0314283944</p>
              </div>
              <div className="space-y-1.5 md:pl-6 border-t md:border-t-0 md:border-l border-slate-100 pt-2.5 md:pt-0">
                <p>📞 <strong className="text-slate-700">Hotline:</strong> 1900 633 915</p>
                <p>✉️ <strong className="text-slate-700">Email Contact:</strong> info@dracocons.vn</p>
                <p>🌐 <strong className="text-slate-700">Website:</strong> <a href="https://dracocons.vn" target="_blank" rel="noopener noreferrer" className="text-indigo-600 hover:underline">www.dracocons.vn</a></p>
              </div>
            </div>
          </div>
        </div>

        {/* Bottom Navigation Bar */}
        <nav className="bg-white border-t border-slate-200 fixed bottom-0 left-0 right-0 z-100 lg:hidden min-h-[60px] pb-safe shadow-[0_-4px_20px_-10px_rgba(0,0,0,0.1)] no-print">
          <div className="mx-auto w-full max-w-lg flex items-center justify-around h-14 px-2">
            <button
              onClick={onBack}
              className="w-1/5 h-full flex flex-col items-center justify-center space-y-0.5 text-slate-400 active:text-indigo-600 transition-colors cursor-pointer"
            >
              <ArrowLeft size={18} />
              <span className="text-[9px] font-black uppercase tracking-tight">Back</span>
            </button>

            <button
              onClick={handleShareLink}
              className={`w-1/5 h-full flex flex-col items-center justify-center space-y-0.5 transition-colors cursor-pointer ${shareCopied ? 'text-emerald-600' : 'text-slate-400 active:text-indigo-600'}`}
            >
              <Share2 size={18} />
              <span className="text-[9px] font-black uppercase tracking-tight">{shareCopied ? 'Copied' : 'Share'}</span>
            </button>

            <div className="relative w-1/5 flex justify-center -mt-6">
              <button
                onClick={() => setShowScanner(true)}
                className="w-20 h-20 rounded-full flex flex-col items-center justify-center space-y-0.5 transition-all shadow-lg active:scale-90 cursor-pointer z-100 border-4 border-slate-100 bg-indigo-500 hover:bg-indigo-600 text-white shadow-slate-300"
                title="Scan QR Code"
              >
                <ScanQrCode size={30} className="animate-pulse" />
              </button>
            </div>

            <button
              onClick={() => window.print()}
              className="w-1/5 h-full flex flex-col items-center justify-center space-y-0.5 text-slate-400 active:text-indigo-600 transition-colors cursor-pointer"
            >
              <Printer size={18} />
              <span className="text-[9px] font-black uppercase tracking-tight">Print</span>
            </button>

            <button
              onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
              className="w-1/5 h-full flex flex-col items-center justify-center space-y-0.5 text-slate-400 active:text-indigo-600 transition-colors cursor-pointer"
            >
              <div className="relative">
                <CheckCircle2 size={18} />
                {totalCount - receivedCount > 0 && (
                  <span className="absolute -top-1.5 -right-1.5 bg-amber-500 text-white text-[8px] font-black w-4 h-4 rounded-full flex items-center justify-center border border-white">
                    {totalCount - receivedCount}
                  </span>
                )}
              </div>
              <span className="text-[9px] font-black uppercase tracking-tight">{progressPercent}%</span>
            </button>
          </div>
        </nav>
      </div>

      {/* MODAL IN PHIẾU NHẬN HÀNG - CHỈ HIỂN THỊ KHI IN (@media print) */}
        <div className="bg-white text-black p-4 space-y-6 print-visible" style={{ fontFamily: 'system-ui, -apple-system, sans-serif', display: 'none' }}>
          <div className="flex justify-between items-start border-b border-black pb-3 mb-3">
            <div>
              <h2 style={{ fontSize: '12pt', fontWeight: 'bold', margin: 0, textTransform: 'uppercase' }}>DRACO DESIGN & BUILD</h2>
              <p style={{ fontSize: '8.5pt', color: '#4b5563', margin: '2px 0 0 0' }}>DRACO WOOD FURNITURE AND HIGH-END ACCESSORIES</p>
              <p style={{ fontSize: '7.5pt', color: '#6b7280', margin: '2px 0 0 0' }}>Tan Hueng Ward, District 7, Ho Chi Minh City</p>
            </div>
            <div style={{ textAlign: 'right' }}>
              <p style={{ fontSize: '10pt', fontWeight: 'bold', fontFamily: 'monospace', margin: 0 }}>DRACO-DELIVERY-{currentPklCode}</p>
              <p style={{ fontSize: '8.5pt', color: '#4b5563', margin: '2px 0 0 0' }}>Date Printed: {new Date().toLocaleDateString('en-US')}</p>
            </div>
          </div>

          <div style={{ textAlign: 'center', margin: '15px 0' }}>
            <h1 style={{ fontSize: '15pt', fontWeight: 'bold', margin: '0 0 2px 0', textTransform: 'uppercase' }}>DELIVERY HANDOVER & CONFIRMATION RECEIPT</h1>
            <p style={{ fontSize: '9pt', color: '#4b5563', fontStyle: 'italic', margin: 0 }}>(CARGO DELIVERY REPORT AND CLIENT ACCEPTANCE LOGS)</p>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px', fontSize: '9pt', marginBottom: '15px', border: '1px solid #d1d5db', padding: '10px', borderRadius: '8px', backgroundColor: '#f9fafb' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <div><strong style={{ display: 'inline-block', width: '130px', color: '#4b5563' }}>Docket ID:</strong> <span style={{ fontWeight: 'bold', textDecoration: 'underline' }}>{currentPklCode}</span></div>
              <div><strong style={{ display: 'inline-block', width: '130px', color: '#4b5563' }}>Main Project Name:</strong> <span style={{ fontWeight: '600' }}>{packing.projectName || 'Draco Prime Projects'}</span></div>
              <div><strong style={{ display: 'inline-block', width: '130px', color: '#4b5563' }}>Vehicle Number:</strong> <span style={{ fontWeight: '600' }}>{packing.vehicleInfo || 'N/A'}</span></div>
              <div><strong style={{ display: 'inline-block', width: '130px', color: '#4b5563' }}>Driver:</strong> <span style={{ fontWeight: '600' }}>{packing.driverName || 'N/A'}</span></div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <div><strong style={{ display: 'inline-block', width: '130px', color: '#4b5563' }}>Issuer Name:</strong> <span>{packing.createdBy || 'Staff Office'}</span></div>
              <div><strong style={{ display: 'inline-block', width: '130px', color: '#4b5563' }}>Registered Date:</strong> <span>{packing.createdAt ? new Date(packing.createdAt.seconds * 1000).toLocaleDateString('en-US') : new Date().toLocaleDateString('en-US')}</span></div>
              <div><strong style={{ display: 'inline-block', width: '130px', color: '#4b5563' }}>Total Cargo Loaded:</strong> <span style={{ fontWeight: 'bold' }}>{totalCount} Packages</span></div>
              <div><strong style={{ display: 'inline-block', width: '130px', color: '#4b5563' }}>Client Confirmed:</strong> <span style={{ fontWeight: 'bold', color: '#16a34a' }}>{receivedCount} units / {totalCount} ({progressPercent}%)</span></div>
            </div>
          </div>

          {packing.note && (
            <div style={{ fontSize: '8.5pt', color: '#374151', fontStyle: 'italic', marginBottom: '15px', padding: '8px', borderLeft: '3px solid #6366f1', backgroundColor: '#f5f7ff' }}>
              <strong>Internal Delivery Remarks:</strong> {packing.note}
            </div>
          )}

          <table>
            <thead>
              <tr>
                <th style={{ width: '30px', textAlign: 'center' }}>NO</th>
                <th>CABINET NAME / CARGO LABEL</th>
                <th style={{ width: '60px', textAlign: 'center' }}>UNIT</th>
                <th style={{ width: '110px' }}>AREA ZONE</th>
                <th style={{ width: '100px' }}>CABINET TYPE</th>
                <th style={{ width: '130px' }}>DIMENSIONS</th>
                <th style={{ width: '60px', textAlign: 'right' }}>MASS</th>
                <th style={{ width: '50px', textAlign: 'center' }}>LOADED</th>
                <th style={{ width: '50px', textAlign: 'center' }}>RECEIVED</th>
                <th style={{ width: '80px', textAlign: 'center' }}>STATUS</th>
              </tr>
            </thead>
            <tbody>
              {computedItems.length === 0 ? (
                <tr>
                  <td colSpan={10} style={{ textAlign: 'center', padding: '15px', color: '#6b7280', fontStyle: 'italic' }}>
                    No packing units specified or loaded on this register.
                  </td>
                </tr>
              ) : (
                computedItems.map((item, idx) => (
                  <tr key={idx} style={{ backgroundColor: '#ffffff' }}>
                    <td style={{ textAlign: 'center', fontWeight: 'bold' }}>{idx + 1}</td>
                    <td style={{ fontWeight: 'bold', color: '#111827' }}>{item.projectName || item.name}</td>
                    <td style={{ textAlign: 'center', fontWeight: '600' }}>{item.unit}</td>
                    <td>{item.cluster}</td>
                    <td style={{ fontWeight: '600', color: '#4b5563' }}>{item.cabinetType}</td>
                    <td style={{ fontFamily: 'monospace', fontSize: '8pt' }}>{item.dimensions}</td>
                    <td style={{ textAlign: 'right' }}>{item.weight > 0 ? `${item.weight} kg` : '-'}</td>
                    <td style={{ textAlign: 'center', fontWeight: 'bold' }}>{item.quantity}</td>
                    <td style={{ textAlign: 'center', fontWeight: 'bold', color: '#16a34a' }}>{item.receivedCount}</td>
                    <td style={{ textAlign: 'center', fontWeight: 'bold', fontSize: '7.5pt', color: item.customerReceived ? '#16a34a' : '#ea580c' }}>
                      {item.customerReceived ? 'DELIVERED' : 'PENDING'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>

          <div style={{ marginTop: '50px', display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', textAlign: 'center', fontSize: '8.5pt' }}>
            <div>
              <p style={{ fontWeight: 'bold', margin: '0 0 2px 0' }}>DRACO Company Representative</p>
              <p style={{ fontSize: '7.5pt', color: '#6b7280', margin: 0, fontStyle: 'italic' }}>(Sign & Print Full Name)</p>
              <div style={{ height: '55px' }}></div>
            </div>
            <div>
              <p style={{ fontWeight: 'bold', margin: '0 0 2px 0' }}>Transport / Driver Captain</p>
              <p style={{ fontSize: '7.5pt', color: '#6b7280', margin: 0, fontStyle: 'italic' }}>(Sign & Print Full Name)</p>
              <div style={{ height: '55px' }}></div>
            </div>
            <div>
              <p style={{ fontWeight: 'bold', margin: '0 0 2px 0' }}>Client / Receiver Authorization</p>
              <p style={{ fontSize: '7.5pt', color: '#6b7280', margin: 0, fontStyle: 'italic' }}>(Sign, Seal & Date)</p>
              <div style={{ height: '55px' }}></div>
              <p style={{ fontWeight: 'bold', margin: 0, textDecoration: 'underline' }}>{user?.displayName || 'Customer Signee'}</p>
            </div>
          </div>
        </div>

      <div className="no-print">
        {/* DETAIL MODAL FOR CARGO AND SPECIFICATIONS (No QC fail photos) */}
        <AnimatePresence>
          {selectedDetailItem && (
            <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-100">
              <motion.div
                initial={{ scale: 0.95, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.95, opacity: 0 }}
                className="bg-white rounded-lg border border-slate-200 shadow-2xl w-full max-w-2xl overflow-hidden max-h-[90vh] flex flex-col no-print"
              >
                {/* Modal Header */}
                <div className="flex items-center justify-between border-b border-slate-100 p-4 shrink-0 bg-slate-100">
                  <div className="space-y-0.5">
                    <h3 className="text-sm font-black text-slate-800 uppercase tracking-tight flex items-center gap-1.5">
                      <Box className="text-indigo-600" size={16} />
                      <span>Package Specifications</span>
                    </h3>
                    <p className="text-md text-slate-400 font-bold uppercase tracking-wider pl-2">
                      {selectedDetailItem.projectName} - {selectedDetailItem.unit}
                    </p>
                  </div>
                  <button
                    onClick={() => setSelectedDetailItem(null)}
                    className="p-1 hover:bg-slate-200 rounded-lg text-slate-400 hover:text-slate-700 transition-colors cursor-pointer"
                  >
                    <X size={20} />
                  </button>
                </div>

                {/* Scrollable specs and images body */}
                <div className="p-5 overflow-y-auto space-y-6">
                  {/* Specs Section */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                    <div className="bg-slate-100 p-2.5 rounded-lg border border-slate-100">
                      <span className="text-[9px] font-black text-slate-400 uppercase tracking-wide">Zone Area</span>
                      <p className="text-xs font-bold text-slate-700 uppercase mt-0.5">{selectedDetailItem.cluster || '-'}</p>
                    </div>
                    <div className="bg-slate-100 p-2.5 rounded-lg border border-slate-100">
                      <span className="text-[9px] font-black text-slate-400 uppercase tracking-wide">Type</span>
                      <p className="text-xs font-bold text-slate-700 uppercase mt-0.5">{selectedDetailItem.cabinetType || '-'}</p>
                    </div>
                    <div className="bg-slate-100 p-2.5 rounded-lg border border-slate-100">
                      <span className="text-[9px] font-black text-slate-400 uppercase tracking-wide">Dimensions (W x D x H)</span>
                      <p className="text-xs font-bold text-slate-700 uppercase mt-0.5 font-mono">{selectedDetailItem.dimensions || '-'}</p>
                    </div>
                    <div className="bg-slate-100 p-2.5 rounded-lg border border-slate-100">
                      <span className="text-[9px] font-black text-slate-400 uppercase tracking-wide">Package Weight</span>
                      <p className="text-xs font-bold text-slate-700 uppercase mt-0.5">{selectedDetailItem.weight > 0 ? `${selectedDetailItem.weight} kg` : 'N/A'}</p>
                    </div>
                  </div>

                  {/* Mô hình 3D - chỉ hiện khi tìm thấy object trong GLB */}
                  {(() => {
                    if (!hasGlbMatch) return null;
                    const projectGlbUrl = (selectedDetailItem.glbUrl || '').trim();
                    if (!projectGlbUrl) return null;
                    return (
                      <div className="space-y-2.5">
                        <div className="flex items-center gap-2 border-b border-slate-200 pb-2">
                          <Cuboid size={14} className="text-indigo-600" />
                          <h4 className="text-[10px] font-black text-slate-800 uppercase tracking-widest leading-none">
                            3D CAD View
                          </h4>
                        </div>
                        <ModuleThreeViewer
                          url={projectGlbUrl}
                          moduleName={selectedDetailItem.name}
                        />
                      </div>
                    );
                  })()}

                  {/* Received Logs */}
                  <div className="space-y-2">
                    <h4 className="text-[10px] font-black uppercase tracking-wider text-slate-400">Activity & Verification Logs</h4>
                    <div className="border border-slate-100 rounded-lg divide-y divide-slate-100 text-xs text-slate-600 bg-slate-100/40 p-1">
                      {selectedDetailItem.histories.map((hist: any, hIdx: number) => (
                        <div key={hist.id} className="p-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
                          <div>
                            <p className="font-extrabold text-slate-800">Package Instance Unit #{hIdx + 1}</p>
                            <p className="text-[11px] text-slate-500 mt-0.5">Barcode reference tags matching this particular piece</p>
                          </div>
                          <div className="text-right">
                            {hist.customerReceived ? (
                              <span className="text-[9px] bg-emerald-100 text-emerald-800 border border-emerald-100 px-2 py-0.5 rounded-lg font-black uppercase">
                                ✓ Received by {hist.customerReceivedBy}
                              </span>
                            ) : (
                              <span className="text-[9px] bg-slate-100 text-slate-400 border border-slate-200 px-2 py-0.5 rounded-lg font-black uppercase">
                                Awaiting Verification Scan
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Sub components - accessories */}
                  {selectedDetailItem.accessories && selectedDetailItem.accessories.length > 0 && (
                    <div className="space-y-2">
                      <h4 className="text-[10px] font-black uppercase tracking-wider text-slate-400">Included Core Hardware & Subcomponents</h4>
                      <div className="border border-slate-200 rounded-lg overflow-hidden">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="bg-slate-100 border-b border-slate-200">
                              <th className="p-2 text-left font-bold text-slate-600 uppercase">Component Barcode / Details</th>
                              <th className="p-2 text-center font-bold text-slate-600 uppercase w-24">QTY</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {selectedDetailItem.accessories.map((acc: any, index: number) => (
                              <tr key={index} className="hover:bg-slate-100/50">
                                <td className="p-2.5 font-bold text-slate-700">{acc.name}</td>
                                <td className="p-2.5 text-center font-black text-slate-800 bg-slate-100/30">{acc.quantity}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* Gallery Images section (No QC Fail items) */}
                  <div className="space-y-2">
                    <h4 className="text-[10px] font-black uppercase tracking-wider text-slate-400 flex items-center justify-between">
                      <span>Approved Image Gallery (Excluding QC Fails)</span>
                      <span className="text-[9px] bg-indigo-100 text-indigo-700 border border-indigo-100 px-1.5 py-0.5 rounded-lg">
                        {computeItemPhotos(selectedDetailItem).length} Available
                      </span>
                    </h4>

                    {(() => {
                      const photos = computeItemPhotos(selectedDetailItem);
                      if (photos.length === 0) {
                        return (
                          <div className="p-8 border border-dashed border-slate-200 rounded-lg text-center text-xs text-slate-400 font-bold uppercase tracking-wide">
                            No pass photos or verified loading images captured for this package yet.
                          </div>
                        );
                      }
                      return (
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                          {photos.map((src: string, pIdx: number) => (
                            <div
                              key={pIdx}
                              onClick={() => { setLightboxImages(photos); setLightboxStartIndex(pIdx); }}
                              className="relative aspect-square bg-slate-100 rounded-lg overflow-hidden border border-slate-200 cursor-zoom-in group hover:opacity-90 transition-all shadow-xs"
                            >
                              <img
                                src={src}
                                alt={`QC Pass Verification ${pIdx + 1}`}
                                className="w-full h-full object-cover"
                                referrerPolicy="no-referrer"
                              />
                              <div className="absolute inset-0 bg-slate-905/20 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                                <span className="text-[9px] bg-white text-slate-755 border border-slate-200 font-black uppercase px-2 py-1 rounded-lg">
                                  Zoom In
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                      );
                    })()}
                  </div>
                </div>

                {/* Footer */}
                <div className="border-t border-slate-100 p-4 bg-slate-100 shrink-0 text-right flex items-center justify-between">
                  <span className="text-[10px] font-bold text-slate-400">
                    Click outer background to escape spec views.
                  </span>
                  <button
                    onClick={() => setSelectedDetailItem(null)}
                    className="px-4 py-1.5 bg-slate-800 hover:bg-slate-900 text-white rounded-lg text-xs font-black uppercase cursor-pointer"
                  >
                    Close Specification
                  </button>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        {/* LIGHTBOX FOR ZOOM IMAGE */}
        <AnimatePresence>
          {lightboxImages.length > 0 && (
            <div
              className="fixed inset-0 bg-black/90 backdrop-blur-xs z-[200] flex flex-col items-center justify-center p-4 no-print"
              onClick={() => setLightboxImages([])}
            >
              {/* Header */}
              <div className="w-full max-w-4xl flex items-center justify-between text-white p-2 shrink-0">
                <span className="text-xs font-black uppercase tracking-wider font-mono">
                  {lightboxStartIndex + 1} / {lightboxImages.length}
                </span>
                <button
                  onClick={() => setLightboxImages([])}
                  className="p-2 hover:bg-white/10 rounded-full transition-all text-gray-300 hover:text-white cursor-pointer"
                >
                  <X size={24} />
                </button>
              </div>

              {/* Image + Nav */}
              <div className="relative w-full max-w-4xl flex items-center justify-center p-2 flex-1 min-h-0">
                {lightboxImages.length > 1 && (
                  <button
                    onClick={(e) => { e.stopPropagation(); setLightboxStartIndex((prev) => (prev - 1 + lightboxImages.length) % lightboxImages.length); }}
                    className="absolute left-2 p-3 bg-black/50 hover:bg-black/70 text-white rounded-full transition-all border border-white/10 z-20 cursor-pointer"
                  >
                    <ChevronLeft size={28} />
                  </button>
                )}
                {lightboxImages[lightboxStartIndex] && (
                  <img
                    key={lightboxStartIndex}
                    src={lightboxImages[lightboxStartIndex]}
                    alt="Zoom"
                    className="max-w-full max-h-[80vh] object-contain rounded-lg shadow-2xl"
                    referrerPolicy="no-referrer"
                  />
                )}
                {lightboxImages.length > 1 && (
                  <button
                    onClick={(e) => { e.stopPropagation(); setLightboxStartIndex((prev) => (prev + 1) % lightboxImages.length); }}
                    className="absolute right-2 p-3 bg-black/50 hover:bg-black/70 text-white rounded-full transition-all border border-white/10 z-20 cursor-pointer"
                  >
                    <ChevronRight size={28} />
                  </button>
                )}
              </div>

              {/* Thumbnails */}
              {lightboxImages.length > 1 && (
                <div className="flex gap-2 max-w-[85vw] overflow-x-auto py-2 px-4 bg-black/40 backdrop-blur-sm rounded-full border border-white/5 shrink-0">
                  {lightboxImages.map((img, i) => (
                    <img
                      key={i}
                      src={img}
                      className={`w-9 h-9 object-cover rounded-md cursor-pointer border transition-all ${
                        i === lightboxStartIndex
                          ? 'border-indigo-500 scale-105 ring-2 ring-indigo-500/30'
                          : 'border-white/10 opacity-60 hover:opacity-100'
                      }`}
                      onClick={(e) => { e.stopPropagation(); setLightboxStartIndex(i); }}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </AnimatePresence>

        {/* Modal Cập nhật ghi chú cho khách */}
        <AnimatePresence>
          {activeItem && (
            <div className="fixed inset-0 bg-slate-900/55 backdrop-blur-xs flex items-center justify-center p-4 z-100 no-print">
              <div className="bg-white rounded-lg border border-slate-200 shadow-2xl w-full max-w-md p-6 space-y-4">
                <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                  <h3 className="text-sm font-black text-slate-800 uppercase tracking-tight flex items-center gap-1.5">
                    <Edit3 size={15} />
                    <span>Item Handover remarks</span>
                  </h3>
                  <button
                    onClick={() => setActiveItem(null)}
                    className="p-1 hover:bg-slate-100 rounded-lg text-slate-400 cursor-pointer"
                  >
                    <X size={18} />
                  </button>
                </div>

                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase text-slate-400 tracking-wider block">
                    Package: {activeItem.packageName}
                  </label>
                  <textarea
                    value={editingNotes}
                    onChange={(e) => setEditingNotes(e.target.value)}
                    placeholder="E.g., No scratches, packaging intact, complete units..."
                    className="w-full bg-slate-100 border border-slate-200 rounded-lg p-3 text-xs font-bold focus:outline-none focus:border-indigo-600 focus:bg-white min-h-[90px]"
                  />
                </div>

                <div className="flex items-center gap-2 pt-2 justify-end">
                  <button
                    type="button"
                    onClick={() => setActiveItem(null)}
                    className="px-4 py-2 hover:bg-slate-100 text-slate-500 font-bold text-xs uppercase rounded-lg border border-slate-200 cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={isSubmitting}
                    onClick={async () => {
                      await handleHistoryClientReceive(activeItem.id, editingNotes, activeItem.customerReceivedBy);
                      setActiveItem(null);
                    }}
                    className="px-4 py-2 bg-indigo-600 hover:bg-slate-900 text-white font-extrabold text-xs uppercase rounded-lg shadow-sm flex items-center gap-1.5 cursor-pointer"
                  >
                    {isSubmitting ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                    <span>Save remarks</span>
                  </button>
                </div>
              </div>
            </div>
          )}
        </AnimatePresence>

        {/* Máy quét QR Scan nhận hàng */}
        {showScanner && (
          <ScannerModal
            onClose={() => setShowScanner(false)}
            onScan={handleScanPackage}
            projectEntries={[]}
          />
        )}
      </div>
      );
    </div>
  )
}
