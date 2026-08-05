/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
 ScanQrCode,
 X,
 Package,
 Ruler,
 Boxes,
 Info,
 CheckCircle,
 AlertTriangle,
 AlertCircle,
 Camera,
 Loader2,
 Save,
 XCircle,
 Plus,
 ClipboardCheck,
 MessageSquare,
 Image as ImageIcon,
 History,
 Layers,
 CheckSquare,
 Check,
 Zap,
 AlertOctagon,
 Cuboid,
 ChevronLeft,
 ChevronRight,
} from "lucide-react";
import { ScannerModal, ScannedResult } from "../components/ScannerModal";
import { ProjectEntry, getModuleInstances, getModuleQcAggregate } from "../types";
import { QcStageBadges } from "../components/QcStageBadges";
import { useAuth } from "../lib/AuthContext";
import {
  doc,
  updateDoc,
  serverTimestamp,
  addDoc,
  collection,
  collectionGroup,
  query,
  where,
  getDocs,
  getDoc,
  onSnapshot,
  orderBy,
} from "firebase/firestore";
import {
 db,
 handleFirestoreError,
 OperationType,
 cleanUndefinedFields,
} from "../lib/firebase";
import { updateProjectModule } from "../lib/dualWrite";
import { getParentCodeCandidate } from "./ProjectManagementScreen";
import { getEntryType, getQCCriteria, QCCriterion } from "../lib/qcCriteria";
import { uploadToCloudinary } from "../lib/cloudinary";
import { QCCameraModal } from "./QCInspectionScreen";
import { ModuleDetailModal } from "../components/project/ModuleDetailModal";
import { ModuleThreeViewer } from "../components/project/ModuleThreeViewer";
import { autoPassBuForPackage } from "../lib/qcPassBu";

interface QuickScannerScreenProps {
 projectEntries?: ProjectEntry[];
 setProjectEntries?: (entries: ProjectEntry[] | ((prev: ProjectEntry[]) => ProjectEntry[])) => void;
 setPendingQCAction?: (
 action: { moduleId: string; stageId: string } | null,
 ) => void;
 setParentActiveTab?: (tab: any) => void;
 onBack?: () => void;
}

const getEntryTypeLocal = (
 moduleCode: string,
 entry?: any,
): "Thùng" | "Cánh" | "Đợt" | "Đợt di động" | "Mặt HK" | "CTHT" | "Gia công ngoài" => {
 return getEntryType(entry || { moduleCode });
};

const makeShelfModuleCode = (parentCode: string): string => {
 const bldgRegex = /^(MED026_BLDG\d|BLDG\d)_(.+)$/i;
 const match = parentCode.match(bldgRegex);
 if (match) {
 return `${match[1]}_Đợt di động_${match[2]}`;
 }
 const firstUnderscore = parentCode.indexOf("_");
 if (firstUnderscore !== -1) {
 return (
 parentCode.substring(0, firstUnderscore) +
 "_Đợt di động" +
 parentCode.substring(firstUnderscore)
 );
 }
 return `Đợt di động_${parentCode}`;
};

export function getBaseModuleId(id: string | null | undefined): string {
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

export function QuickScannerScreen({
 projectEntries: propsProjectEntries,
 setProjectEntries,
 setPendingQCAction,
 setParentActiveTab,
 onBack,
}: QuickScannerScreenProps) {
 const { user, userProfile, role, roles, hasRole } = useAuth();
 const isQC = hasRole("admin") || hasRole("qc") || hasRole("mod_qc");
 // Am thanh beep khi quet QR thanh cong
 const playSuccessBeep = () => {
 try {
 const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
 const now = audioCtx.currentTime;
 const osc1 = audioCtx.createOscillator();
 const gain1 = audioCtx.createGain();
 osc1.type = 'sine';
 osc1.frequency.setValueAtTime(880, now);
 gain1.gain.setValueAtTime(0.3, now);
 gain1.gain.exponentialRampToValueAtTime(0.01, now + 0.15);
 osc1.connect(gain1);
 gain1.connect(audioCtx.destination);
 osc1.start(now);
 osc1.stop(now + 0.15);
 const osc2 = audioCtx.createOscillator();
 const gain2 = audioCtx.createGain();
 osc2.type = 'sine';
 osc2.frequency.setValueAtTime(1175, now + 0.1);
 gain2.gain.setValueAtTime(0, now);
 gain2.gain.setValueAtTime(0.3, now + 0.1);
 gain2.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
 osc2.connect(gain2);
 gain2.connect(audioCtx.destination);
 osc2.start(now + 0.1);
 osc2.stop(now + 0.3);
 } catch (e) {}
 };



  const [localProjectEntries, setLocalProjectEntries] = useState<ProjectEntry[]>([]);
  const [localQcTickets, setLocalQcTickets] = useState<any[]>([]);

  useEffect(() => {
  if (propsProjectEntries && propsProjectEntries.length > 0) {
  setLocalProjectEntries(propsProjectEntries);
  return;
  }
  const unsubConfigs = onSnapshot(collection(db, "projectConfigs"), async (configSnap) => {
  const allModules: ProjectEntry[] = [];
  for (const configDoc of configSnap.docs) {
  const config = configDoc.data();
  const modulesSnap = await getDocs(collection(db, "projectConfigs", configDoc.id, "modules"));
  modulesSnap.docs.forEach(modDoc => {
  allModules.push({
  ...modDoc.data(),
  id: modDoc.id,
  configId: configDoc.id,
  projectName: config.projectName || '',
  projectCode: config.projectCode || '',
  glbUrl: config.glbUrl || '',
  drawingUrl: config.drawingUrl || '',
  assemblyDrawingUrl: config.assemblyDrawingUrl || '',
  } as ProjectEntry);
  });
  }
  setLocalProjectEntries(allModules);
  }, (err) => {
  console.error("Lỗi đồng bộ danh sách dự án trong Scanner Screen:", err);
  });
  return () => unsubConfigs();
  }, [propsProjectEntries]);

  useEffect(() => {
  const unsub = onSnapshot(collection(db, "qc_tickets"), (snap) => {
  setLocalQcTickets(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  }, (err) => {
  console.warn("Lỗi tải qc_tickets trong QuickScanner:", err);
  });
  return () => unsub();
  }, []);

  const projectEntries = localProjectEntries;

  // Flag chặn onSnapshot overwrite trong lúc save QC
  const isSavingRef = useRef(false);

  const [showScanner, setShowScanner] = useState(true);
 const [result, setResult] = useState<ScannedResult | null>(null);
 const [scanCount, setScanCount] = useState(0);
 const [isLookingUp, setIsLookingUp] = useState(false);

 // Real-time synchronization state of scanned module
 const [scannedEntry, setScannedEntry] = useState<ProjectEntry | null>(null);
 const [packingPhotos, setPackingPhotos] = useState<string[]>([]);
 const [lightboxImages, setLightboxImages] = useState<string[]>([]);
 const [lightboxStartIndex, setLightboxStartIndex] = useState<number>(0);

 useEffect(() => {
 if (!scannedEntry) {
 setPackingPhotos([]);
 return;
 }
 const cleanCode = scannedEntry.moduleCode.replace(/\s*#\d+\/\d+$/, '').trim().toLowerCase();
 // Lấy instanceIndex từ kết quả quét (nếu có)
 let scannedInstIdx: number | undefined;
 if (result?.instanceId) {
  const parts = result.instanceId.split('|');
  if (parts.length >= 2) scannedInstIdx = parseInt(parts[1]);
 }
 const q = query(collection(db, "packing"));
 const unsub = onSnapshot(
 q,
 (snap) => {
 const photos: string[] = [];
 snap.docs.forEach((d) => {
 const list = d.data() as any;
 (list.items || []).forEach((item: any) => {
 const itemName = (item.name || '').toLowerCase().trim();
 const itemCode = itemName.replace(/\s*#\d+\/\d+$/, '').trim();
 if (itemCode === cleanCode || itemName.includes(cleanCode) || cleanCode.includes(itemCode)) {
  // Nếu có instance index từ QR, chỉ lấy ảnh của instance đó
  if (scannedInstIdx != null && item.instanceIndex != null && item.instanceIndex !== scannedInstIdx) return;
  if (item.photos?.length) {
   photos.push(...item.photos.filter(Boolean));
  }
  if (item.packingImageUrl) {
   photos.push(item.packingImageUrl);
  }
 }
 });
 });
 setPackingPhotos([...new Set(photos)]);
 },
 () => setPackingPhotos([]),
 );
 return unsub;
 }, [scannedEntry?.id, result?.instanceId]);

 const [showDetailModal, setShowDetailModal] = useState(false);
 const [selectedChildModule, setSelectedChildModule] =
 useState<ProjectEntry | null>(null);
 const [selectedAssemblyChildren, setSelectedAssemblyChildren] = useState<
 Record<string, boolean>
 >({});
 const [assemblyQuantities, setAssemblyQuantities] = useState<
 Record<string, number>
 >({});
 const [savingAssembly, setSavingAssembly] = useState(false);

 const projectAccessories = React.useMemo(() => {
 if (!localProjectEntries || localProjectEntries.length === 0) return [];
 const accs = new Set<string>();
 localProjectEntries.forEach((entry) => {
 if (entry.accessories) {
 entry.accessories.forEach((acc) => {
 if (acc.name) accs.add(acc.name);
 });
 }
 });
 return Array.from(accs);
 }, [localProjectEntries]);

 // States for QC inspection modal
 const [isQCModalOpen, setIsQCModalOpen] = useState(false);
 const [activeStage, setActiveStage] = useState<any | null>(null);
 const [qcStatus, setQcStatus] = useState<"none" | "pass" | "fail">("none");
 const [qcNotes, setQcNotes] = useState("");
 const [qcPhotos, setQcPhotos] = useState<string[]>([]);
 const [qcInspectedQty, setQcInspectedQty] = useState("");
 const [uploading, setUploading] = useState(false);
 const [modalLoading, setModalLoading] = useState(false);
 const [criterionPhotos, setCriterionPhotos] = useState<
 Record<string, string[]>
 >({});
 const [criterionUploading, setCriterionUploading] = useState<
 Record<string, boolean>
 >({});

 // Giao diện tinh gọn tối ưu cho mobile
 const [activeTab, setActiveTab] = useState<
 "overview" | "timeline" | "criteria"
 >("overview");
 const [criteriaStage, setCriteriaStage] = useState<
 "white" | "paint" | "finish" | "pack"
 >("white");
 const [checkedCriteria, setCheckedCriteria] = useState<
 Record<string, boolean>
 >({});
 const [cameraActiveCriId, setCameraActiveCriId] = useState<string | null>(
 null,
 );

 // Trạng thái cho Action nhanh góc dưới bên phải & Báo lỗi QC
 const [isQuickActionOpen, setIsQuickActionOpen] = useState(false);
 const [showReportErrorModal, setShowReportErrorModal] = useState(false);
 const [errorStage, setErrorStage] = useState<
 "white" | "paint" | "finish" | "pack"
 >("white");
 const [errorDescription, setErrorDescription] = useState("");
 const [errorPhotos, setErrorPhotos] = useState<string[]>([]);
 const [errorUploading, setErrorUploading] = useState(false);

 // Hàm tải lên nhiều ảnh lỗi cùng lúc
 const handleErrorPhotoUpload = async (files: FileList) => {
 setErrorUploading(true);
 const urls: string[] = [];
 for (let i = 0; i < files.length; i++) {
 const file = files[i];
 try {
 const url = await uploadToCloudinary(file, 'QC');
 urls.push(url);
 } catch (err) {
 console.error("Lỗi tải lên ảnh lỗi QC:", err);
 }
 }
 setErrorPhotos((prev) => [...prev, ...urls]);
 setErrorUploading(false);
 };

 // Hàm gỡ một ảnh lỗi đã chọn
 const removeErrorPhoto = (index: number) => {
 setErrorPhotos((prev) => prev.filter((_, idx) => idx !== index));
 };

 const isLR2Leader = userProfile?.chuc_danh === "LR2 Leader";
 // Hàm gửi báo cáo lỗi QC
 const handleSubmitQCError = async () => {
 if (!scannedEntry) return;
 if (!errorDescription.trim()) {
 alert("Vui lòng nhập mô tả lỗi QC!");
 return;
 }

 try {
 setModalLoading(true);

 const stageConfigMap = {
 white: { field: "qcWhite", label: "Hàng Trắng" },
 paint: { field: "qcPaint", label: "Hàng Sơn" },
 finish: { field: "qcFinish", label: "Hoàn Thiện" },
 pack: { field: "qcPack", label: "Đóng Gói" },
 };

 const selectedStageConfig = stageConfigMap[errorStage];
 const displayLabel = userProfile?.ten_that
 ? `${userProfile.ten_that}`
 : user?.displayName || user?.email || "Người kiểm định";
 const roleLabel =
 userProfile?.chuc_danh ||
 (hasRole("admin") ? "Quản trị viên" : "QC");

 const qcData = {
 status: "fail",
 notes: errorDescription,
 photos: errorPhotos,
 date: new Date(),
 by: displayLabel,
 role: roleLabel,
 checkedCriteria: {},
 criterionPhotos: {},
 passedItems: [],
 passedQty: 0,
 };

  const currentInstances = scannedEntry.instances && scannedEntry.instances.length > 0
  ? scannedEntry.instances
  : getModuleInstances(scannedEntry);

  const scannedInstanceId = result?.instanceId;

  const updatedInstances = currentInstances.map((inst: any) => {
  const isTarget = !scannedInstanceId || inst.id === scannedInstanceId || inst.instanceId === scannedInstanceId;
  if (isTarget) {
  const currentLogs = inst.qcLogs || [];
  return {
  ...inst,
  [selectedStageConfig.field]: {
  status: "fail" as const,
  date: new Date(),
  by: displayLabel,
  notes: errorDescription,
  photos: errorPhotos,
  },
  qcStatus: "fail" as const,
  qcNotes: errorDescription,
  qcPhotos: errorPhotos,
  qcDate: new Date(),
  qcBy: displayLabel,
  qcLogs: [
  ...currentLogs.filter((log: any) => log.stage !== errorStage),
  {
  stage: errorStage,
  status: "fail" as const,
  date: new Date(),
  by: displayLabel,
  notes: errorDescription,
  photos: errorPhotos,
  }
  ]
  };
  }
  return inst;
  });

  const hasInstances = updatedInstances && updatedInstances.length > 0;

  const updateData: any = {
  instances: updatedInstances,
  ...(hasInstances ? {} : {
  [`${selectedStageConfig.field}`]: qcData,
  qcNotes: errorDescription,
  qcPhotos: errorPhotos,
  qcDate: serverTimestamp(),
  qcBy: displayLabel,
  qcRole: roleLabel,
  }),
  qcPass: false,
  qcStatus: "fail",
  };

 const statusText = `QC ${selectedStageConfig.label}: FAIL (Báo lỗi QC)`;
 const history = [...(scannedEntry.statusHistory || [])];
 history.push(`${statusText} (${displayLabel})|${Date.now()}`);
 updateData.statusHistory = history;
 updateData.status = statusText;

  // Update Firestore dự án
  await updateProjectModule(
  scannedEntry.id,
  cleanUndefinedFields(updateData),
  scannedEntry.projectCode,
  );

  // Đồng bộ projectEntries ở App.tsx để Management tab cập nhật ngay
  setProjectEntries?.(prev =>
  prev.map(e => e.id === scannedEntry.id ? { ...e, ...updateData } as ProjectEntry : e)
  );

 // Lưu Log hoạt động
 await addDoc(
 collection(db, "activities"),
 cleanUndefinedFields({
 userId: user?.uid,
 userName: displayLabel,
 userEmail: user?.email || "",
 action: `Báo lỗi QC ${selectedStageConfig.label}`,
 details: `Cấu kiện ${scannedEntry.moduleCode}: Báo lỗi QC thất bại. Mô tả: ${errorDescription}`,
 projectCode: scannedEntry.projectCode,
 moduleCode: scannedEntry.moduleCode,
 timestamp: serverTimestamp(),
 }),
 );

 // Đồng bộ vào QC tickets chứa module này ở trạng thái pending
 try {
 const ticketsRef = collection(db, "qc_tickets");
 const q = query(ticketsRef, where("status", "==", "pending"));
 const querySnapshot = await getDocs(q);

 const batchPromises = querySnapshot.docs.map(
 async (ticketDoc) => {
 const ticketData = ticketDoc.data();
 const ticketModules = ticketData.modules || [];

 let hasChanges = false;
 const updatedModules = ticketModules.map((m: any) => {
 if (m.id === scannedEntry.id || getBaseModuleId(m.id) === scannedEntry.id) {
 hasChanges = true;
 return {
 ...m,
 status: "fail",
 qcNotes: errorDescription,
 qcPhotos: errorPhotos,
 };
 }
 return m;
 });

 if (hasChanges) {
 const allInspected = updatedModules.every(
 (m: any) =>
 m.status === "pass" || m.status === "fail",
 );
 const ticketStatus = allInspected
 ? "completed"
 : "pending";

 await updateDoc(
 doc(db, "qc_tickets", ticketDoc.id),
 cleanUndefinedFields({
 modules: updatedModules,
 status: ticketStatus,
 }),
 );
 }
 },
 );
 await Promise.all(batchPromises);
 } catch (ticketSyncErr) {
 console.error(
 "Lỗi đồng bộ báo lỗi vào QC Tickets:",
 ticketSyncErr,
 );
 }

 // Reset form & đóng modal
 setErrorDescription("");
 setErrorPhotos([]);
 setShowReportErrorModal(false);
 setIsQuickActionOpen(false);
 alert("Báo cáo lỗi QC thành công!");
 } catch (err) {
 console.error("Lỗi khi báo cáo QC thất bại:", err);
 alert(
 "Đã xảy ra lỗi khi báo cáo lỗi QC: " +
 (err instanceof Error ? err.message : String(err)),
 );
 } finally {
 setModalLoading(false);
 }
 };

 const normalizeScannedCode = (rawText: string) => {
 let cleanCode = rawText.trim();
 if (!cleanCode) return cleanCode;

 if (cleanCode.includes("|")) {
 cleanCode = cleanCode.split("|")[0].trim();
 }

 const suffixRegex = /-(\d+)\/(\d+)$/;
 if (suffixRegex.test(cleanCode)) {
 cleanCode = cleanCode.replace(suffixRegex, "").trim();
 }

 return cleanCode.replace(/^\d+\./, "").trim();
 };

 // Bổ sung thông tin config (projectName/projectCode/...) cho module lấy từ Firestore
 const enrichModuleWithConfig = async (
 data: any,
 id: string,
 configId?: string,
 ): Promise<ProjectEntry | null> => {
 if (!configId) return null;
 try {
 const configSnap = await getDoc(doc(db, "projectConfigs", configId));
 const config = configSnap.exists() ? configSnap.data() : {};
 return {
 ...data,
 id,
 configId,
 projectName: config.projectName || "",
 projectCode: config.projectCode || "",
 projectOrder: config.projectOrder,
 glbUrl: config.glbUrl || "",
 drawingUrl: config.drawingUrl || "",
 assemblyDrawingUrl: config.assemblyDrawingUrl || "",
 isCompleted: config.isCompleted || false,
 } as ProjectEntry;
 } catch (err) {
 console.warn("Lỗi đọc config cho module:", err);
 return null;
 }
 };

 // Tra cứu module trực tiếp từ Firestore khi QR không khớp projectEntries
 // (vd: module thuộc project hoàn tất chưa được load on-demand) — đảm bảo
 // nút quét QR vẫn truy xuất được đầy đủ thông tin instances.
 const fetchEntryByModuleCode = async (
 moduleCode: string,
 ): Promise<ProjectEntry | null> => {
 if (!moduleCode) return null;

 // Bước 1: collectionGroup theo moduleCode — 1 query duy nhất, nhanh nhất
 try {
 const q = query(
 collectionGroup(db, "modules"),
 where("moduleCode", "==", moduleCode),
 );
 const snap = await getDocs(q);
 if (!snap.empty) {
 // Có thể nhiều project trùng moduleCode → ưu tiên module thuộc
 // project đang hoạt động (QR thường dùng cho module đang sản xuất)
 const candidates: (ProjectEntry | null)[] = [];
 for (const modDoc of snap.docs) {
 const configId = modDoc.ref.parent.parent?.id;
 const entry = await enrichModuleWithConfig(
 modDoc.data(),
 modDoc.id,
 configId,
 );
 if (entry) candidates.push(entry);
 }
 const activeEntry = candidates.find((c) => c && !c.isCompleted);
 return activeEntry || candidates[0] || null;
 }
 } catch (err) {
 console.warn(
 "[QuickScanner] collectionGroup lookup failed (index may be missing), trying per-config:",
 err,
 );
 }

 // Bước 2: Fallback — duyệt từng projectConfigs (dùng khi thiếu index collectionGroup)
 try {
 const configsSnap = await getDocs(collection(db, "projectConfigs"));
 for (const configDoc of configsSnap.docs) {
 try {
 const modulesSnap = await getDocs(
 query(
 collection(db, "projectConfigs", configDoc.id, "modules"),
 where("moduleCode", "==", moduleCode),
 ),
 );
 if (!modulesSnap.empty) {
 const modDoc = modulesSnap.docs[0];
 const entry = await enrichModuleWithConfig(
 modDoc.data(),
 modDoc.id,
 configDoc.id,
 );
 if (entry) return entry;
 }
 } catch {
 // config này lỗi — bỏ qua, thử config tiếp theo
 }
 }
 } catch (err) {
 console.warn("[QuickScanner] Per-config lookup failed:", err);
 }
 return null;
 };

 const getMatchedEntry = (res: ScannedResult | null) => {
  if (!res) return null;
  if (res.matchedId) {
  const match = projectEntries.find((e) => e.id === res.matchedId);
  if (match) return match;
  }
 const rawText = normalizeScannedCode(
 res.rawCode || res.moduleCode || "",
 );
 if (!rawText) return null;

 // Bước 1: 20.ELMB1_Cánh phải_KIT.T2 -> ELMB1_Cánh phải_KIT.T2 (Bỏ phần số định danh <số>.)
 let entry =
 projectEntries.find(
 (e) => (e.moduleCode || "").toLowerCase() === rawText.toLowerCase(),
 ) || null;

 // Bước 2: Nếu ELMB1_Cánh phải_KIT.T2 không tìm thấy sẽ đổi -> ELMB1_KIT.T2 (Tách và ghép đầu - cuối)
 if (!entry) {
 const parts = rawText.split("_");
 if (parts.length >= 2) {
 const step2Code = `${parts[0]}_${parts[parts.length - 1]}`;
 entry =
 projectEntries.find(
 (e) =>
 (e.moduleCode || "").toLowerCase() ===
 step2Code.toLowerCase(),
 ) || null;
 }
 }

  // Bước 3: Nếu không thấy, trả về null để báo lỗi
  return entry;
  };

  // Live Firebase Synchronizer of Scanned Module
  useEffect(() => {
  // Guard hủy async tra cứu khi user scan QR khác trong lúc fetch đang chạy
  let cancelled = false;
  if (!result) {
  setScannedEntry(null);
  setIsLookingUp(false);
  return;
  }

  setIsLookingUp(true);

  // Xử lý CTHT QR code có package ID
  if (result.cthtPackageId) {
    const loadCthtPackage = async () => {
      try {
        // Query packing collection to find the package with this ID
        const packingQuery = query(collection(db, "packing"));
        const packingSnap = await getDocs(packingQuery);
        for (const packingDoc of packingSnap.docs) {
          const packingData = packingDoc.data();
          const items = packingData.items || [];
          const matchedItem = items.find((item: any) => item.id === result.cthtPackageId);
          if (matchedItem) {
            // Tạo virtual entry từ CTHT/Phụ kiện package
            const itemSubType = matchedItem.subType || 'kienCTHT';
            const virtualEntry: ProjectEntry = {
              id: matchedItem.id,
              moduleCode: matchedItem.name || result.moduleCode,
              projectName: packingData.projectName || '',
              projectCode: packingData.projectCode || '',
              quantity: matchedItem.quantity || 1,
              receivedQuantity: 0,
              shippedQuantity: 0,
              classification: (itemSubType === 'kienPhuKien' ? 'Phụ Kiện' : 'CTHT') as any,
              cluster: matchedItem.cluster || '',
              pWidth: Number(matchedItem.w) || 0,
              pDepth: Number(matchedItem.d) || 0,
              pHeight: Number(matchedItem.h) || 0,
              width: Number(matchedItem.w) || 0,
              depth: Number(matchedItem.d) || 0,
              height: Number(matchedItem.h) || 0,
              instances: [],
              accessories: matchedItem.accessories || [],
              status: 'Chờ QC',
              statusHistory: [],
              createdAt: new Date(),
              sortIndex: 0,
              ownerId: '',
              configId: packingDoc.id
            };
            setScannedEntry(virtualEntry);
            playSuccessBeep();
            setShowDetailModal(false);
            return;
          }
        }
        // Không tìm thấy → fallback về logic cũ
        const matched = getMatchedEntry(result);
        if (!matched) {
          setScannedEntry(null);
          setIsLookingUp(false);
          return;
        }
        const freshMatch = propsProjectEntries?.find(e => e.id === matched.id) || matched;
        setScannedEntry(freshMatch);
        playSuccessBeep();
        setIsLookingUp(false);
        setShowDetailModal(false);
      } catch (err) {
        console.error("Lỗi tải kiện CTHT:", err);
        setScannedEntry(null);
        setIsLookingUp(false);
      }
    };
    loadCthtPackage();
    return;
  }

  const matched = getMatchedEntry(result);
  if (!matched) {
    // Không khớp projectEntries (vd: module thuộc project hoàn tất chưa load on-demand)
    // → tra cứu trực tiếp từ Firestore để vẫn hiển thị được thông tin instances.
    (async () => {
      try {
        const rawText = normalizeScannedCode(
          result.rawCode || result.moduleCode || "",
        );
        let fallbackEntry = rawText
          ? await fetchEntryByModuleCode(rawText)
          : null;
        // Heuristic giống getMatchedEntry: ghép phần đầu-cuối (ELMB1_KIT.T2)
        if (!fallbackEntry && rawText) {
          const parts = rawText.split("_");
          if (parts.length >= 2) {
            fallbackEntry = await fetchEntryByModuleCode(
              `${parts[0]}_${parts[parts.length - 1]}`,
            );
          }
        }
        // Bỏ qua kết quả cũ nếu user đã scan QR khác trong lúc fetch
        if (cancelled) return;
        if (fallbackEntry) {
          setScannedEntry(fallbackEntry);
          playSuccessBeep();
          setShowDetailModal(false);
        } else {
          setScannedEntry(null);
        }
      } catch (err) {
        console.warn("Lỗi tra cứu module từ Firestore:", err);
        if (!cancelled) setScannedEntry(null);
      } finally {
        setIsLookingUp(false);
      }
    })();
    return;
  }

  // Set initial từ projectEntries (đã sync từ Excel/QC save)
  const freshMatch = propsProjectEntries?.find(e => e.id === matched.id) || matched;
  setScannedEntry(freshMatch);
  playSuccessBeep();
  setIsLookingUp(false);
  setShowDetailModal(false);

  // onSnapshot cho real-time updates + force fresh read mỗi scan
  const moduleRef = doc(db, "projectConfigs", matched.projectCode, "modules", matched.id);
  const configRef = doc(db, "projectConfigs", matched.projectCode);
  const unsubscribe = onSnapshot(
  moduleRef,
  async (docSnap) => {
  if (docSnap.exists() && !isSavingRef.current) {
  const configSnap = await getDoc(configRef);
  const configData = configSnap.exists() ? configSnap.data() : {};
  setScannedEntry(prev => {
  const firestoreData = docSnap.data() || {};
  return {
  ...(prev || {}),
  ...firestoreData,
  id: docSnap.id,
  projectCode: (prev as any)?.projectCode || configData.projectCode || matched.projectCode,
  glbUrl: configData.glbUrl || (prev as any)?.glbUrl || '',
  projectName: configData.projectName || (prev as any)?.projectName || '',
  drawingUrl: configData.drawingUrl || (prev as any)?.drawingUrl || '',
  assemblyDrawingUrl: configData.assemblyDrawingUrl || (prev as any)?.assemblyDrawingUrl || '',
  } as ProjectEntry;
  });
  }
  },
  (error) => {
  console.warn("Lỗi đồng bộ chi tiết module:", error);
  },
  );

   return () => {
    cancelled = true;
    unsubscribe();
   };
   }, [result, scanCount]);

  // Đồng bộ real-time trực tiếp từ Firestore qua onSnapshot ở trên, không dùng propsProjectEntries cũ để tránh ghi đè dữ liệu mới.

 const matchedEntry = scannedEntry;

 const [showAssemblyModal, setShowAssemblyModal] = useState(false);

 const getSuffix = (code: string): string => {
 if (!code) return "";

 // Bỏ phần sau dấu | trước để xử lý instanceId (nếu có)
 let result = code.split("|")[0];

 // Lấy phần sau dấu gạch dưới (_) cuối cùng thay vì đầu tiên
 const lastUnderscoreIndex = result.lastIndexOf("_");
 if (lastUnderscoreIndex >= 0) {
 result = result.substring(lastUnderscoreIndex + 1);
 }

 // Bỏ phần sau dấu - nếu phía sau bắt đầu bằng số
 result = result.replace(/-\d.*$/, "");

 return result.trim();
 };

 const assemblySiblingList = React.useMemo(() => {
 if (!scannedEntry) return [];

 // Trích xuất phần hậu tố của module cha (ví dụ BLDG1_KIT.T1 -> KIT.T1)
 const parentCode = scannedEntry.moduleCode || "";
 const firstUnderscoreIndex = parentCode.split("|")[0].indexOf("_");
 const searchSuffix =
 firstUnderscoreIndex >= 0
 ? parentCode
 .split("|")[0]
 .substring(firstUnderscoreIndex + 1)
 .toLowerCase()
 : parentCode.split("|")[0].toLowerCase();

 return projectEntries.filter((e) => {
 // Chỉ lấy cấu kiện cùng dự án và khác chính nó
 const isSameProjectAndNotSelf =
 e.projectCode === scannedEntry.projectCode &&
 e.id !== scannedEntry.id;
 if (!isSameProjectAndNotSelf) return false;

 // Lọc các cấu kiện có mã chứa hậu tố tìm kiếm
 const siblingCode = (e.moduleCode || "")
 .split("|")[0]
 .toLowerCase();
 return siblingCode.includes(searchSuffix);
 });
 }, [scannedEntry, projectEntries]);

 // Đồng bộ hóa danh sách cấu kiện đã được chọn khi mở modal Lắp Ráp
 useEffect(() => {
 if (showAssemblyModal && scannedEntry) {
 const initialChecked: Record<string, boolean> = {};
 const initialQtys: Record<string, number> = {};
 assemblySiblingList.forEach((e) => {
 const isChild =
 e.parentId === scannedEntry.id ||
 e.parentModuleCode === scannedEntry.moduleCode;
 if (isChild) {
 initialChecked[e.id] = true;
 initialQtys[e.id] = e.assemblyQuantity || e.quantity || 1;
 }
 });
 setSelectedAssemblyChildren(initialChecked);
 setAssemblyQuantities(initialQtys);
 }
 }, [showAssemblyModal, scannedEntry, assemblySiblingList]);

 const handleSaveAssemblyLinks = async () => {
 if (!scannedEntry) return;
 setSavingAssembly(true);
 try {
 const displayLabel = userProfile?.ten_that
 ? `${userProfile.ten_that}`
 : user?.displayName || user?.email || "LR2 Leader";

 const batchUpdatePromises = assemblySiblingList.map(async (sib) => {
 const wasLinked =
 sib.parentId === scannedEntry.id ||
 sib.parentModuleCode === scannedEntry.moduleCode;
 const isCurrentlySelected = !!selectedAssemblyChildren[sib.id];
 const qty = assemblyQuantities[sib.id] || sib.quantity || 1;

 if (isCurrentlySelected) {
 // Tạo hoặc cập nhật liên kết
 const childUpdate: any = {
 parentId: scannedEntry.id,
 parentModuleCode: scannedEntry.moduleCode,
 parentInstanceId: scannedEntry.id,
 childInstanceId: sib.id,
 assemblyQuantity: qty,
 };

 // Nếu chưa từng liên kết hoặc số lượng thay đổi, lưu thêm log và hoạt động
 const childHistory = [...(sib.statusHistory || [])];
 const logMsg = `Đã liên kết làm con của ${scannedEntry.moduleCode} với số lượng: ${qty} (${displayLabel})`;
 if (!wasLinked || sib.assemblyQuantity !== qty) {
 childHistory.push(`${logMsg}|${Date.now()}`);
 childUpdate.statusHistory = childHistory;

 await addDoc(collection(db, "activities"), {
 userId: user?.uid,
 userName: `${displayLabel} (LR2 Leader)`,
 userEmail: user?.email || "",
 action: `Liên kết Lắp ráp`,
 details: `LR2 Leader liên kết module con ${sib.moduleCode} vào module cha ${scannedEntry.moduleCode} với số lượng ${qty}`,
 projectCode: scannedEntry.projectCode,
 moduleCode: sib.moduleCode,
 timestamp: serverTimestamp(),
 });
 }

  await updateProjectModule(sib.id, childUpdate, scannedEntry.projectCode);
  } else if (wasLinked) {
  // Gỡ liên kết đã tồn tại
  const childHistory = [...(sib.statusHistory || [])];
  childHistory.push(
  `Đã hủy liên kết khỏi module cha ${scannedEntry.moduleCode} (${displayLabel})|${Date.now()}`,
  );

  await updateProjectModule(sib.id, {
  parentId: "",
  parentModuleCode: "",
  parentInstanceId: "",
  childInstanceId: "",
  assemblyQuantity: 0,
  statusHistory: childHistory,
  }, scannedEntry.projectCode);

 await addDoc(collection(db, "activities"), {
 userId: user?.uid,
 userName: `${displayLabel} (LR2 Leader)`,
 userEmail: user?.email || "",
 action: `Gỡ liên kết Lắp ráp`,
 details: `LR2 Leader gỡ liên kết module con ${sib.moduleCode} khỏi module cha ${scannedEntry.moduleCode}`,
 projectCode: scannedEntry.projectCode,
 moduleCode: sib.moduleCode,
 timestamp: serverTimestamp(),
 });
 }
 });

 await Promise.all(batchUpdatePromises);
 setShowAssemblyModal(false);
 } catch (err) {
 console.error("Lỗi cập nhật liên kết lắp ráp:", err);
 alert("Đã xảy ra lỗi khi lưu liên kết lắp ráp. Vui lòng thử lại!");
 } finally {
 setSavingAssembly(false);
 }
 };

 const handleOpenInspectionModal = (stage: any) => {
 setActiveStage(stage);
 const extInfo = parseExtendCode(result?.rawCode);
 const isSufPass = extInfo
 ? stage.data?.passedItems?.includes(extInfo.extCode) || false
 : stage.data?.status === "pass";

 const currentStatus = isSufPass
 ? "pass"
 : stage.data?.status === "fail"
 ? "fail"
 : "none";
 setQcStatus(currentStatus);
 setQcNotes(stage.data?.notes || "");
 setQcPhotos(stage.data?.generalPhotos || stage.data?.photos || []);
 setQcInspectedQty(
 stage.data?.passedQty ? String(stage.data.passedQty) : "",
 );

 // Khởi tạo các checkbox tiêu chí kiểm định và ảnh chụp tương ứng
 const initialChecked: Record<string, boolean> = {};
 const initialPhotos: Record<string, string[]> = {};
 if (scannedEntry) {
 const moduleType = getEntryType(scannedEntry);
 const ctList = getQCCriteria(moduleType, stage.id);

 const savedChecked = stage.data?.checkedCriteria || {};
 const savedPhotos = stage.data?.criterionPhotos || {};

 ctList.forEach((cri) => {
 if (savedChecked && typeof savedChecked[cri.id] === "boolean") {
 initialChecked[cri.id] = savedChecked[cri.id];
 } else {
 initialChecked[cri.id] = currentStatus === "pass";
 }
 initialPhotos[cri.id] = savedPhotos?.[cri.id] || [];
 });
 }
 setCheckedCriteria(initialChecked);
 setCriterionPhotos(initialPhotos);
 setIsQCModalOpen(true);
 };

 // Tự động đồng bộ qcStatus: đủ thì Pass, thiếu tự động Fail
 useEffect(() => {
 if (scannedEntry && activeStage) {
 const moduleType = getEntryType(scannedEntry);
 const criteriaList = getQCCriteria(moduleType, activeStage.id);
 if (criteriaList.length > 0) {
 const allChecked = criteriaList.every(
 (cri) => !!checkedCriteria[cri.id],
 );
 setQcStatus(allChecked ? "pass" : "fail");
 } else {
 setQcStatus("pass");
 }
 }
 }, [checkedCriteria, scannedEntry, activeStage]);

 const handleCriterionPhotoUpload = async (
 criId: string,
 filesInput: File | File[] | FileList,
 ) => {
 try {
 setCriterionUploading((prev) => ({ ...prev, [criId]: true }));

 const files: File[] = [];
 if (filesInput instanceof File) {
 files.push(filesInput);
 } else if (filesInput) {
 for (let i = 0; i < filesInput.length; i++) {
 files.push(filesInput[i]);
 }
 }

 if (files.length === 0) return;

 const urls: string[] = [];
 const errors: string[] = [];
 for (const file of files) {
 try {
 const url = await uploadToCloudinary(file, 'QC');
 urls.push(url);
 } catch (uploadErr) {
 console.error(
 "Lỗi upload một file: ",
 file.name,
 uploadErr,
 );
 errors.push(
 uploadErr instanceof Error
 ? uploadErr.message
 : String(uploadErr),
 );
 }
 }

 if (urls.length > 0) {
 setCriterionPhotos((prev) => {
 const current = prev[criId] || [];
 return {
 ...prev,
 [criId]: [...current, ...urls],
 };
 });
 } else {
 alert(
 "Không thể tải lên ảnh nào. Chi tiết: " + errors.join("; "),
 );
 }
 } catch (err) {
 alert(
 "Lỗi xử lý ảnh QC: " +
 (err instanceof Error ? err.message : String(err)),
 );
 } finally {
 setCriterionUploading((prev) => ({ ...prev, [criId]: false }));
 }
 };

 const removeCriterionPhoto = (criId: string, index: number) => {
 setCriterionPhotos((prev) => {
 const current = prev[criId] || [];
 return {
 ...prev,
 [criId]: current.filter((_, i) => i !== index),
 };
 });
 };

 const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
 const files = e.target.files;
 if (!files) return;

 setUploading(true);
 const urls: string[] = [];
 const errors: string[] = [];

 for (const file of Array.from(files)) {
 try {
 const url = await uploadToCloudinary(file, 'QC');
 urls.push(url);
 } catch (uploadErr) {
 console.error("Lỗi upload một file: ", file.name, uploadErr);
 errors.push(uploadErr instanceof Error ? uploadErr.message : String(uploadErr));
 }
 }

 if (urls.length > 0) {
 setQcPhotos((prev) => [...prev, ...urls]);
 } else {
 alert("Không thể tải lên ảnh nào. Chi tiết: " + errors.join("; "));
 }
 setUploading(false);
 };

 const removePhoto = (index: number) => {
 setQcPhotos((prev) => prev.filter((_, i) => i !== index));
 };

 const parseExtendCode = (rawCode: string | undefined | null) => {
 if (!rawCode) return null;
 const suffixRegex = /-(\d+)\/(\d+)$/;
 const match = suffixRegex.exec(rawCode.trim());
 if (match) {
 return {
 index: Number(match[1]),
 total: Number(match[2]),
 extCode: rawCode.trim(),
 };
 }
 return null;
 };

  const handleSaveQCResult = async () => {
  if (!scannedEntry || !activeStage) return;

  isSavingRef.current = true;
  try {
  setModalLoading(true);

 const displayLabel = userProfile?.ten_that
 ? `${userProfile.ten_that}`
 : user?.displayName || user?.email || "TaiKhoanQC";
 const roleLabel =
 hasRole("admin")
 ? "ADMIN"
 : hasRole("mod_qc")
 ? "QA/QC"
 : "MEMBER";

 const allGatheredPhotos = Object.values(criterionPhotos)
 .flat()
 .filter(Boolean) as string[];

 // Phân tích mã code mở rộng hiện tại từ result
 const qty = scannedEntry.quantity || 1;
 let nextPassedItems: string[] = [];
 let isFullyPassed = true;
 let nextPassedQty = 0;
 let resolvedStatus = "pending";
 let updatedInstances: any[] = [];

 if (result?.instanceId) {
 const currentInstances =
 scannedEntry.instances && scannedEntry.instances.length > 0
 ? scannedEntry.instances
 : getModuleInstances(scannedEntry);

 const targetInstanceIndex = currentInstances.findIndex(
 (inst) =>
 inst.instanceId === result.instanceId ||
 inst.id === result.instanceId,
 );

 if (targetInstanceIndex !== -1) {
 updatedInstances = currentInstances.map((inst, idx) => {
 if (idx === targetInstanceIndex) {
 const currentLogs = inst.qcLogs || [];
 const isPassedNow = qcStatus === "pass";

 const instStageData = {
 status:
 qcStatus === "pass"
 ? ("pass" as const)
 : qcStatus === "fail"
 ? ("fail" as const)
 : ("pending" as const),
 date: new Date(),
 by: displayLabel,
 notes: qcNotes,
 photos: [...allGatheredPhotos, ...qcPhotos],
 generalPhotos: qcPhotos,
 checkedCriteria: checkedCriteria,
 };

 return {
 ...inst,
 [activeStage.field]: instStageData,
 qcStatus:
 qcStatus === "pass"
 ? ("pass" as const)
 : qcStatus === "fail"
 ? ("fail" as const)
 : ("pending" as const),
 qcDone: isPassedNow,
 qcNotes: qcNotes,
 qcDate: new Date(),
 qcBy: displayLabel,
 qcPhotos: [...allGatheredPhotos, ...qcPhotos],
 qcGeneralPhotos: qcPhotos,
 qcLogs: [
 ...currentLogs.filter(
 (log) => log.stage !== activeStage.id,
 ),
 {
 stage: activeStage.id,
 status:
 qcStatus === "pass"
 ? ("pass" as const)
 : qcStatus === "fail"
 ? ("fail" as const)
 : ("pending" as const),
 date: new Date(),
 by: displayLabel,
 notes: qcNotes,
 photos: [
 ...allGatheredPhotos,
 ...qcPhotos,
 ],
 generalPhotos: qcPhotos,
 },
 ],
 };
 }
 return inst;
 });
 } else {
 updatedInstances = currentInstances;
 }

 const allInstsPassed = updatedInstances.every(
 (inst) => inst[activeStage.field]?.status === "pass",
 );
 const anyInstFailed = updatedInstances.some(
 (inst) => inst[activeStage.field]?.status === "fail",
 );
 resolvedStatus = allInstsPassed
 ? "pass"
 : anyInstFailed
 ? "fail"
 : "pending";

 nextPassedItems = updatedInstances
 .filter(
 (inst) => inst[activeStage.field]?.status === "pass",
 )
 .map((inst) => inst.id || inst.instanceId);
 nextPassedQty = nextPassedItems.length;
 isFullyPassed = allInstsPassed;
 } else {
 // Legacy flow
 if (qcStatus === "pass") {
 if (qty > 1) {
 const tempVal = qcInspectedQty.trim();
 const inputQty =
 tempVal !== "" ? parseInt(tempVal, 10) : 1;
 const validQty = Math.max(
 1,
 Math.min(qty, isNaN(inputQty) ? 1 : inputQty),
 );

 nextPassedItems = [];
 const extInfo = parseExtendCode(result?.rawCode);
 if (extInfo && extInfo.extCode) {
 nextPassedItems.push(extInfo.extCode);
 }
 for (let i = 1; i <= qty; i++) {
 if (nextPassedItems.length >= validQty) break;
 const itemCode = `${scannedEntry.moduleCode}-${i}/${qty}`;
 if (!nextPassedItems.includes(itemCode)) {
 nextPassedItems.push(itemCode);
 }
 }
 while (nextPassedItems.length < validQty) {
 nextPassedItems.push(
 `${scannedEntry.moduleCode}-${nextPassedItems.length + 1}/${qty}`,
 );
 }
 nextPassedQty = nextPassedItems.length;
 if (nextPassedQty < qty) {
 isFullyPassed = false;
 }
 } else {
 nextPassedQty = 1;
 nextPassedItems = [`${scannedEntry.moduleCode}-1/1`];
 isFullyPassed = true;
 }
 } else if (qcStatus === "fail") {
 nextPassedQty = 0;
 nextPassedItems = [];
 isFullyPassed = false;
 } else {
 nextPassedQty = 0;
 nextPassedItems = [];
 isFullyPassed = false;
 }

 resolvedStatus = isFullyPassed ? qcStatus : "pending";
 }

 // Legacy flow: cập nhật instances nếu chưa có instanceId
 if (!result?.instanceId && updatedInstances.length === 0) {
  const currentInstances = scannedEntry.instances && scannedEntry.instances.length > 0
  ? scannedEntry.instances
  : getModuleInstances(scannedEntry);
  updatedInstances = currentInstances.map((inst: any) => ({
  ...inst,
  [activeStage.field]: {
  status: resolvedStatus === "pass" ? "pass" : resolvedStatus === "fail" ? "fail" : "pending",
  date: new Date(),
  by: displayLabel,
  notes: qcNotes,
  photos: [...allGatheredPhotos, ...qcPhotos],
  }
  }));
 }

 const qcData = {
 status: resolvedStatus,
 notes: qcNotes,
 photos: [...allGatheredPhotos, ...qcPhotos],
 generalPhotos: qcPhotos,
 date: new Date(),
 by: displayLabel,
 role: roleLabel,
 checkedCriteria: checkedCriteria,
 criterionPhotos: criterionPhotos,
 passedItems: nextPassedItems,
 passedQty: nextPassedItems.length,
 };

 const isMultiInstance = (scannedEntry.quantity || 1) > 1 && result?.instanceId;
  const hasInstances = updatedInstances && updatedInstances.length > 0;

  const updateData: any = {
    instances: updatedInstances,
    ...(hasInstances ? {} : {
      [`${activeStage.field}`]: qcData,
      qcNotes: qcNotes,
      qcPhotos: [...allGatheredPhotos, ...qcPhotos],
      qcDate: serverTimestamp(),
      qcBy: displayLabel,
      qcRole: roleLabel,
      qcCheckedCriteria: checkedCriteria,
      qcCriterionPhotos: criterionPhotos
    })
  };

  let autoPassWhiteData: any = null;
  let autoPassPaintData: any = null;
  let autoPassFinishData: any = null;

  if (resolvedStatus === 'pass') {
    const makePassBuData = (stageName: string, filterFunc: (inst: any) => boolean) => {
      const passedItems = updatedInstances
        .filter(filterFunc)
        .map(inst => inst.id || inst.instanceId);
      const passedQty = passedItems.length;
      const isAllPassed = passedQty === qty;
      const resolvedStatusVal = isAllPassed ? 'pass' : (passedQty > 0 ? 'pending' : 'none');

      return {
        status: resolvedStatusVal,
        notes: 'Pass bù',
        photos: [],
        date: new Date(),
        by: displayLabel,
        role: roleLabel,
        passedItems: passedItems,
        passedQty: passedQty
      };
    };

    if (activeStage.id === 'paint') {
      if (getModuleQcAggregate(scannedEntry, 'white')?.status !== 'pass') {
        autoPassWhiteData = makePassBuData('white', inst => inst.qcWhite?.status === 'pass');
      }
    } else if (activeStage.id === 'finish') {
      if (getModuleQcAggregate(scannedEntry, 'paint')?.status !== 'pass') {
        autoPassPaintData = makePassBuData('paint', inst => inst.qcPaint?.status === 'pass');
      }
      if (getModuleQcAggregate(scannedEntry, 'white')?.status !== 'pass') {
        autoPassWhiteData = makePassBuData('white', inst => inst.qcWhite?.status === 'pass');
      }
    } else if (activeStage.id === 'pack') {
      if (getModuleQcAggregate(scannedEntry, 'finish')?.status !== 'pass') {
        autoPassFinishData = makePassBuData('finish', inst => inst.qcFinish?.status === 'pass');
      }
      if (getModuleQcAggregate(scannedEntry, 'paint')?.status !== 'pass') {
        autoPassPaintData = makePassBuData('paint', inst => inst.qcPaint?.status === 'pass');
      }
      if (getModuleQcAggregate(scannedEntry, 'white')?.status !== 'pass') {
        autoPassWhiteData = makePassBuData('white', inst => inst.qcWhite?.status === 'pass');
      }
    }
      }

  const isStagePass = (activeStage.id === "paint" || activeStage.id === "finish") && resolvedStatus === "pass";
 if (isStagePass) {
 const currentRecQty = scannedEntry.receivedQuantity || 0;
 if (currentRecQty < qty) {
 updateData.receivedQuantity = qty;
 }
 }

 const resultText =
 resolvedStatus === "pass"
 ? "PASS"
 : resolvedStatus === "fail"
 ? "FAIL"
 : "CHỜ KIỂM";
 let statusText = `QC ${activeStage.label}: ${resultText}`;
 if (!isFullyPassed) {
 statusText = `QC ${activeStage.label}: Đạt ${nextPassedQty}/${qty}`;
 }
 const history = [...(scannedEntry.statusHistory || [])];
 if (isStagePass) {
 const currentRecQty = scannedEntry.receivedQuantity || 0;
 if (currentRecQty < qty) {
 history.push(`Giao Nhận - Đã nhận (Tự động theo QC Pass ${activeStage.label} - ${displayLabel})|${Date.now()}`);
 }
 }
 history.push(`${statusText} (${displayLabel})|${Date.now()}`);
 updateData.statusHistory = history;
 updateData.status = statusText;

  const childModulesMatched: ProjectEntry[] = [];
  const entryTypeActive = getEntryTypeLocal(
    scannedEntry.moduleCode,
    scannedEntry,
  );

  await updateProjectModule(
    scannedEntry.id,
    cleanUndefinedFields(updateData),
    scannedEntry.projectCode,
  );

  // Tự động pass bù các công đoạn trước và module con khi Thùng hoàn tất Đóng Gói
  if (activeStage.id === 'pack' && resolvedStatus === 'pass' && isFullyPassed && entryTypeActive === 'Thùng') {
    try {
      await autoPassBuForPackage(scannedEntry.id, {
        uid: user?.uid,
        email: user?.email,
        displayName: displayLabel
      }, projectEntries);
    } catch (passErr) {
      console.error("Lỗi tự động pass bù ở màn hình QuickScanner:", passErr);
    }
  }

 // Tự động pass luôn các module con khi pass module cha
 // Bỏ qua khi kiểm Hàng Trắng — chưa có giai đoạn trước để pass bù
 if (qcStatus === "pass" && activeStage.id !== "white") {
 try {
 const childrenModules = projectEntries.filter(
 (e) =>
 e.projectCode === scannedEntry.projectCode &&
 (e.parentId === scannedEntry.id ||
 (scannedEntry.moduleCode &&
 e.parentModuleCode ===
 scannedEntry.moduleCode)),
 );

 const childPromises = childrenModules.map(async (child) => {
 const childUpdateData: any = {};
 const makeChildQCData = (stageLabel: string) => ({
 status: "pass" as const,
 notes: `Tự động PASS theo Thùng cha ${scannedEntry.moduleCode}`,
 photos: allGatheredPhotos,
 date: new Date(),
 by: displayLabel,
 role: roleLabel,
 passedQty: child.quantity || 1,
 passedItems: Array.from({
 length: child.quantity || 1,
 }).map(
 (_, i) =>
 `${child.moduleCode}-${i + 1}/${child.quantity || 1}`,
 ),
 });

 const childQCData = makeChildQCData(activeStage.label);

 // Align child current stage field
 childUpdateData[`${activeStage.field}`] = childQCData;

 let autoChildWhite = child.qcWhite;
 let autoChildPaint = child.qcPaint;
 let autoChildFinish = child.qcFinish;

 if (activeStage.id === "paint") {
 if (!child.qcWhite || child.qcWhite.status !== "pass") {
 autoChildWhite = makeChildQCData("Hàng Trắng");
 }
 } else if (activeStage.id === "finish") {
 if (!child.qcPaint || child.qcPaint.status !== "pass") {
 autoChildPaint = makeChildQCData("Hàng Sơn");
 }
 if (!child.qcWhite || child.qcWhite.status !== "pass") {
 autoChildWhite = makeChildQCData("Hàng Trắng");
 }
 } else if (activeStage.id === "pack") {
 if (!child.qcFinish || child.qcFinish.status !== "pass") {
 autoChildFinish = makeChildQCData("Hoàn Thiện");
 }
 if (!child.qcPaint || child.qcPaint.status !== "pass") {
 autoChildPaint = makeChildQCData("Hàng Sơn");
 }
 if (!child.qcWhite || child.qcWhite.status !== "pass") {
 autoChildWhite = makeChildQCData("Hàng Trắng");
 }
  }

  if (child.instances && Array.isArray(child.instances)) {
 childUpdateData.instances = child.instances.map((inst: any) => {
 const newInst = { ...inst };
 newInst[`${activeStage.field}`] = {
 status: "pass",
 date: new Date(),
 by: displayLabel,
 notes: `Tự động PASS theo Thùng cha ${scannedEntry.moduleCode}`
 };

 let instLogs = inst.qcLogs || [];
 instLogs = instLogs.filter((l: any) => l.stage !== activeStage.id);
 instLogs.push({
 stage: activeStage.id,
 status: "pass",
 date: new Date(),
 by: displayLabel,
 notes: `Tự động PASS theo Thùng cha ${scannedEntry.moduleCode}`
 });

 if (activeStage.id === "paint") {
 if (!inst.qcWhite || inst.qcWhite.status !== "pass") {
 newInst.qcWhite = { status: "pass", date: new Date(), by: displayLabel, notes: "Pass bù", checkedCriteria: {} };
 instLogs = instLogs.filter((l: any) => l.stage !== "white");
 instLogs.push({ stage: "white", status: "pass", date: new Date(), by: displayLabel, notes: "Pass bù" });
 }
 } else if (activeStage.id === "finish") {
 if (!inst.qcPaint || inst.qcPaint.status !== "pass") {
 newInst.qcPaint = { status: "pass", date: new Date(), by: displayLabel, notes: "Pass bù", checkedCriteria: {} };
 instLogs = instLogs.filter((l: any) => l.stage !== "paint");
 instLogs.push({ stage: "paint", status: "pass", date: new Date(), by: displayLabel, notes: "Pass bù" });
 }
 if (!inst.qcWhite || inst.qcWhite.status !== "pass") {
 newInst.qcWhite = { status: "pass", date: new Date(), by: displayLabel, notes: "Pass bù", checkedCriteria: {} };
 instLogs = instLogs.filter((l: any) => l.stage !== "white");
 instLogs.push({ stage: "white", status: "pass", date: new Date(), by: displayLabel, notes: "Pass bù" });
 }
 } else if (activeStage.id === "pack") {
 if (!inst.qcFinish || inst.qcFinish.status !== "pass") {
 newInst.qcFinish = { status: "pass", date: new Date(), by: displayLabel, notes: "Pass bù", checkedCriteria: {} };
 instLogs = instLogs.filter((l: any) => l.stage !== "finish");
 instLogs.push({ stage: "finish", status: "pass", date: new Date(), by: displayLabel, notes: "Pass bù" });
 }
 if (!inst.qcPaint || inst.qcPaint.status !== "pass") {
 newInst.qcPaint = { status: "pass", date: new Date(), by: displayLabel, notes: "Pass bù", checkedCriteria: {} };
 instLogs = instLogs.filter((l: any) => l.stage !== "paint");
 instLogs.push({ stage: "paint", status: "pass", date: new Date(), by: displayLabel, notes: "Pass bù" });
 }
 if (!inst.qcWhite || inst.qcWhite.status !== "pass") {
 newInst.qcWhite = { status: "pass", date: new Date(), by: displayLabel, notes: "Pass bù", checkedCriteria: {} };
 instLogs = instLogs.filter((l: any) => l.stage !== "white");
 instLogs.push({ stage: "white", status: "pass", date: new Date(), by: displayLabel, notes: "Pass bù" });
 }
 }

 newInst.qcLogs = instLogs;
 newInst.qcDone = activeStage.id === "pack";
 return newInst;
 });
  }

  const currentChildRecQty = child.receivedQuantity || 0;
 const childQty = child.quantity || 1;
 if (currentChildRecQty < childQty) {
 childUpdateData.receivedQuantity = childQty;
 }

 const childHistory = [...(child.statusHistory || [])];
 if (currentChildRecQty < childQty) {
 childHistory.push(`Giao Nhận - Đã nhận (Tự động theo QC Pass ${activeStage.label} - ${displayLabel})|${Date.now()}`);
 }
 childHistory.push(
 `Đồng bộ PASS ${activeStage.label} từ Thùng cha ${scannedEntry.moduleCode}|${Date.now()}`,
 );
 childUpdateData.statusHistory = childHistory;
 childUpdateData.status = `QC ${activeStage.label}: PASS (Đồng bộ Thùng cha)`;

  await updateProjectModule(
  child.id,
  cleanUndefinedFields(childUpdateData),
  scannedEntry.projectCode,
  );
  childModulesMatched.push(child);
 });

 await Promise.all(childPromises);
 } catch (childSyncErr) {
 console.error(
 "Lỗi đồng bộ QC pass cho các module con:",
 childSyncErr,
 );
 }
 }

 // Synchronize "Đợt di động" if matched
 try {
 const shelfModuleCode = makeShelfModuleCode(
 scannedEntry.moduleCode,
 );
 const matchedShelf = projectEntries.find(
 (e) =>
 e.projectCode === scannedEntry.projectCode &&
 e.moduleCode === shelfModuleCode,
 );
 if (matchedShelf) {
 const shelfUpdateData: any = {
 [`${activeStage.field}`]: qcData,
 };

 const isShelfPass = (activeStage.id === "paint" || activeStage.id === "finish") && qcStatus === "pass";
 if (isShelfPass) {
 const currentShelfRecQty = matchedShelf.receivedQuantity || 0;
 if (currentShelfRecQty < matchedShelf.quantity) {
 shelfUpdateData.receivedQuantity = matchedShelf.quantity;
 }
 }

 const shelfHistory = [
 ...(matchedShelf.statusHistory || []),
 ];
 if (isShelfPass) {
 const currentShelfRecQty = matchedShelf.receivedQuantity || 0;
 if (currentShelfRecQty < matchedShelf.quantity) {
 shelfHistory.push(`Giao Nhận - Đã nhận (Tự động theo QC Pass ${activeStage.label} - ${displayLabel})|${Date.now()}`);
 }
 }
 const shelfResultText =
 qcStatus === "pass"
 ? "PASS"
 : qcStatus === "fail"
 ? "FAIL"
 : "CHỜ KIỂM";
 const shelfStatusText = `QC ${activeStage.label}: ${shelfResultText}`;
 shelfHistory.push(
 `${shelfStatusText} (${displayLabel} - Đồng bộ)|${Date.now()}`,
 );
 shelfUpdateData.statusHistory = shelfHistory;
 shelfUpdateData.status = shelfStatusText;

  await updateProjectModule(
  matchedShelf.id,
  cleanUndefinedFields(shelfUpdateData),
  scannedEntry.projectCode,
  );
 if (qcStatus === "pass" && entryTypeActive === "Thùng") {
 childModulesMatched.push(matchedShelf);
 }
 }
 } catch (shelfErr) {
 console.error("Lỗi đồng bộ Đợt di động:", shelfErr);
 }

 // Log activity
 await addDoc(
 collection(db, "activities"),
 cleanUndefinedFields({
 userId: user?.uid,
 userName: displayLabel,
 userEmail: user?.email || "",
 action: `QC ${activeStage.label}`,
 details: `QC cho ${scannedEntry.moduleCode}: ${qcStatus.toUpperCase()}. Ghi chú: ${qcNotes || "Không"}`,
 projectCode: scannedEntry.projectCode,
 moduleCode: scannedEntry.moduleCode,
 timestamp: serverTimestamp(),
 }),
 );

 

 // Synchronize in ALL active/pending QC tickets containing this module as pending
 try {
 const ticketsRef = collection(db, "qc_tickets");
 const q = query(ticketsRef, where("status", "==", "pending"));
 const querySnapshot = await getDocs(q);

 const batchPromises = querySnapshot.docs.map(
 async (ticketDoc) => {
 const ticketData = ticketDoc.data();
 const ticketModules = ticketData.modules || [];

 let hasChanges = false;
 const matchedChildIds = childModulesMatched.map(
 (c) => c.id,
 );
 const updatedModules = ticketModules.map((m: any) => {
 if (m.id === scannedEntry.id || getBaseModuleId(m.id) === scannedEntry.id) {
 hasChanges = true;
 return {
 ...m,
 status: qcStatus,
 qcNotes: qcNotes,
 qcPhotos: qcPhotos,
 };
 }
 if (matchedChildIds.includes(m.id) || matchedChildIds.includes(getBaseModuleId(m.id))) {
 hasChanges = true;
 return {
 ...m,
 status: "pass",
 qcNotes: `Tự động PASS theo Thùng cha ${scannedEntry.moduleCode}`,
 qcPhotos: qcPhotos,
 };
 }
 return m;
 });

 if (hasChanges) {
 const allInspected = updatedModules.every(
 (m: any) =>
 m.status === "pass" || m.status === "fail",
 );
 const ticketStatus = allInspected
 ? "completed"
 : "pending";

 await updateDoc(
 doc(db, "qc_tickets", ticketDoc.id),
 cleanUndefinedFields({
 modules: updatedModules,
 status: ticketStatus,
 }),
 );
 }
 },
 );
 await Promise.all(batchPromises);
 } catch (ticketSyncErr) {
 console.error("Lỗi đồng bộ vào QC Tickets:", ticketSyncErr);
 }

  // Cập nhật local instances ngay lập tức để UI phản hồi tức thì
  setScannedEntry(prev => {
    if (!prev) return prev;
    return {
      ...prev,
      ...updateData,
    } as ProjectEntry;
  });

  // Đồng bộ projectEntries ở App.tsx để Management tab cập nhật ngay
  setProjectEntries?.(prev =>
    prev.map(e => e.id === scannedEntry?.id ? { ...e, ...updateData } as ProjectEntry : e)
  );

  setIsQCModalOpen(false);
  setActiveStage(null);
  } catch (err) {
  console.error(err);
  alert("Đã xảy ra lỗi khi lưu kiểm định. Vui lòng thử lại!");
  } finally {
  setModalLoading(false);
  setTimeout(() => { isSavingRef.current = false; }, 2000);
  }
  };

  const instancesOfModuleResult = matchedEntry ? getModuleInstances(matchedEntry) : [];
  const selectedInstanceCurrent = result?.instanceId
  ? instancesOfModuleResult.find((inst) => inst.instanceId === result.instanceId || inst.id === result.instanceId)
  : null;

  // Tính toán QC status từ instances thay vì module-level
  const qcStatuses = matchedEntry ? {
  white: getModuleQcAggregate(matchedEntry, 'white'),
  paint: getModuleQcAggregate(matchedEntry, 'paint'),
  finish: getModuleQcAggregate(matchedEntry, 'finish'),
  pack: getModuleQcAggregate(matchedEntry, 'pack'),
  } : null;

 return (
 <div className="space-y-4 md:space-y-6 pb-6 md:pb-24 h-full flex flex-col min-h-0">
 <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 md:gap-4 shrink-0">
 <div>
 <h1 className="text-2xl md:text-3xl font-black text-slate-900 uppercase tracking-tight">
 Quét Tra Cứu QR
 </h1>
 <p className="text-[10.5px] md:text-sm font-bold text-slate-400 uppercase tracking-widest mt-0.5">
 Truy xuất thông tin module thời gian thực
 </p>
 </div>
 </div>

 {!result ? (
 <div className="flex-grow flex flex-col items-center justify-center p-6 md:py-20 bg-white border border-slate-200 rounded-lg min-h-0">
 <div className="w-32 h-32 md:w-40 md:h-40 bg-indigo-100 rounded-full flex items-center justify-center text-indigo-600 animate-pulse border border-indigo-100 mb-6 md:mb-8 shrink-0">
 <ScanQrCode size={64} strokeWidth={1.5} />
 </div>
 <div className="text-center space-y-2 md:space-y-3 mb-6 md:mb-10 px-4">
 <h3 className="text-xl md:text-2xl font-black text-slate-900 uppercase tracking-tight">
 Sẵn sàng quét mã
 </h3>
 <p className="text-[10px] md:text-xs text-slate-400 font-bold max-w-xs mx-auto uppercase tracking-widest leading-normal md:leading-loose">
 Hướng camera về phía mã QR trên module để máy tự
 động nhận diện và hiển thị thông tin.
 </p>
 </div>
 <button
 onClick={() => setShowScanner(true)}
 className="w-full max-w-xs py-3.5 md:py-4 bg-indigo-600 text-white rounded-sm font-black uppercase text-[11px] tracking-[0.2em] shadow-lg shadow-indigo-100 flex items-center justify-center gap-3 hover:bg-indigo-700 active:scale-95 transition-all shrink-0 cursor-pointer"
 >
 <ScanQrCode size={18} />
 BẮT ĐẦU QUÉT
 </button>
 </div>
 ) : (
 <motion.div
 initial={{ opacity: 0, y: 10 }}
 animate={{ opacity: 1, y: 0 }}
 className="bg-white rounded-lg border border-slate-200 overflow-hidden flex-grow flex flex-col min-h-0"
 >
 <div
 className={`p-4 md:p-6 flex items-center justify-between text-white shrink-0 ${matchedEntry ? "bg-emerald-600" : "bg-orange-500"}`}
 >
 <div className="flex items-center gap-3 md:gap-4">
 <div className="w-10 h-10 md:w-12 md:h-12 bg-white/20 rounded-lg flex items-center justify-center backdrop-blur-md">
 {matchedEntry ? (
 <CheckCircle size={24} />
 ) : (
 <AlertTriangle size={24} />
 )}
 </div>
 <div>
 <h3 className="font-black text-sm md:text-base uppercase tracking-tight leading-none mb-1 md:mb-1.5">
 {matchedEntry
 ? ((matchedEntry.moduleCode || '').toLowerCase().includes('ctht') || matchedEntry.classification === 'CTHT' || (matchedEntry.classification as string) === 'ctht')
  ? "Đã Nhận Diện Kiện CTHT"
  : "Đã Nhận Diện Module"
 : "Mã QR Không Thuộc Dự Án"}
 </h3>
 <p className="text-[9px] md:text-[10px] font-black uppercase tracking-widest opacity-80 leading-none">
 {matchedEntry
 ? `Dự án: ${matchedEntry.projectName}`
 : "Thông tin quét tự động"}
 </p>
 </div>
 </div>
 <button
 onClick={() => {
 setResult(null);
 setShowScanner(true);
 }}
 className="p-2 hover:bg-white/20 rounded-lg transition-colors cursor-pointer"
 >
 <X size={20} />
 </button>
 </div>

 <div className="p-4 md:p-6 space-y-4 md:space-y-6 overflow-y-auto flex-1">
 <div className="flex flex-col items-center gap-1.5 pt-2">
 <div className="text-[9px] md:text-[10px] font-black text-slate-400 uppercase tracking-[0.3em]">
 {selectedInstanceCurrent ? "Mã số định danh kiện/thùng" : "Mã số định danh"}
 </div>
 <div className="text-xl md:text-2xl font-black text-slate-900 font-mono tracking-tighter text-center break-all uppercase">
 {selectedInstanceCurrent
 ? `${matchedEntry ? matchedEntry.moduleCode : (result.rawCode || result.moduleCode)} - Kiện ${ selectedInstanceCurrent.instanceIndex}/${matchedEntry?.quantity || 1}`
 : (matchedEntry
 ? matchedEntry.moduleCode
 : result.rawCode || result.moduleCode)}
 </div>
 <div className="flex items-center gap-2 mt-1 flex-wrap justify-center">
 {matchedEntry && (
 <span className="px-2 py-0.5 bg-indigo-100 text-indigo-600 rounded-lg text-[8px] md:text-[9.5px] font-black uppercase tracking-widest border border-indigo-100">
 Phân loại: {getEntryType(matchedEntry)}
 </span>
 )}
 {matchedEntry && (
 <span className="px-2 py-0.5 bg-slate-100 text-slate-700 rounded-lg text-[8px] md:text-[9.5px] font-black uppercase tracking-widest border border-slate-200">
 ID: {matchedEntry.id}
 </span>
 )}
 </div>
 </div>

 {/* Giao diện hiển thị chi tiết liền mạch cuộn dọc (Không chia Tabs) */}
 {isLookingUp && !matchedEntry && (
 <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-8 text-center space-y-4">
 <Loader2 size={32} className="animate-spin text-indigo-600 mx-auto" />
 <div>
 <h4 className="text-sm font-black text-indigo-800 uppercase tracking-tight">
 Đang tra cứu module...
 </h4>
 <p className="text-[11px] text-indigo-600 font-bold mt-1 leading-relaxed">
 Vui lòng đợi hệ thống xử lý kết quả quét.
 </p>
 </div>
 </div>
 )}

 {!isLookingUp && !matchedEntry && (
 <div className="bg-rose-100/50 border border-rose-300 rounded-lg p-5 text-left space-y-4">
 <div className="flex items-start gap-3">
 <div className="p-2 bg-rose-100/80 text-rose-605 rounded-lg shrink-0">
 <XCircle size={18} />
 </div>
 <div>
 <h4 className="text-sm font-black text-rose-800 uppercase tracking-tight">
 Lỗi: Không tìm thấy Module có trong
 hệ thống
 </h4>
 <p className="text-[11px] text-rose-600 font-bold mt-1 leading-relaxed">
 Mã QR quét được không tồn tại trong
 danh sách dữ liệu của toàn bộ dự án
 sau khi đã áp dụng quy trình quy đổi
 tự động 3 bước.
 </p>
 </div>
 </div>

 <div className="bg-white rounded-lg p-4 border border-rose-100 text-[11px] space-y-3 font-sans shadow-xs">
 <p className="font-black text-rose-700 uppercase tracking-wider text-[10px] border-b border-rose-100 pb-1.5 flex items-center gap-1.5">
 <AlertCircle size={12} /> Tra cứu tiến
 trình quy đổi 3 bước:
 </p>

 <div className="space-y-2">
 <div className="flex items-start gap-2 border-b border-slate-100 pb-2">
 <span className="font-bold text-slate-405 shrink-0 min-w-[150px]">
 Mã QR gốc quét được:
 </span>
 <code className="bg-slate-100 text-slate-800 px-1.5 py-0.5 rounded-sm font-mono font-bold text-[10px] break-all">
 {result.rawCode ||
 result.moduleCode}
 </code>
 </div>

 <div className="flex items-start gap-2 border-b border-slate-100 pb-2">
 <span className="font-bold text-slate-405 shrink-0 min-w-[150px]">
 Bước 1: Loại bỏ số thứ tự:
 </span>
 <div className="flex flex-col gap-1 min-w-0">
 <code className="bg-slate-100 text-slate-700 px-1.5 py-0.5 rounded-sm font-mono font-bold text-[10px] break-all border border-slate-200">
 {(() => {
 const rawText = (
 result.rawCode ||
 result.moduleCode ||
 ""
 ).trim();
 return rawText
 .replace(
 /^\d+\./,
 "",
 )
 .trim();
 })()}
 </code>
 <span className="text-[9px] text-rose-600 font-black uppercase tracking-wider flex items-center gap-1">
 ✗ Không tìm thấy
 </span>
 </div>
 </div>

 <div className="flex items-start gap-2">
 <span className="font-bold text-slate-405 shrink-0 min-w-[150px]">
 Bước 2: Quy đổi Đầu_Cuối:
 </span>
 <div className="flex flex-col gap-1 min-w-0">
 <code className="bg-slate-100 text-slate-700 px-1.5 py-0.5 rounded-sm font-mono font-bold text-[10px] break-all border border-slate-200">
 {(() => {
 const rawText = (
 result.rawCode ||
 result.moduleCode ||
 ""
 ).trim();
 const step1Code =
 rawText
 .replace(
 /^\d+\./,
 "",
 )
 .trim();
 const parts =
 step1Code.split(
 "_",
 );
 if (parts.length >= 2) {
 return `${parts[0]}_${parts[parts.length - 1]}`;
 }
 return 'Không hợp lệ để phân tách phân rã dạng "Đầu_Cuối"';
 })()}
 </code>
 <span className="text-[9px] text-rose-605 font-black uppercase tracking-wider flex items-center gap-1">
 ✗ Không tìm thấy
 </span>
 </div>
 </div>
 </div>

 <div className="text-[9.5px] text-rose-700 font-black uppercase tracking-wider pt-2 border-t border-rose-100/70 flex items-center gap-1">
 <AlertTriangle
 size={12}
 className="text-rose-500"
 />
 <span>
 Bước 3: Dừng tìm kiếm & báo lỗi hệ
 thống.
 </span>
 </div>
 </div>

 <div className="p-3 bg-slate-100/85 rounded-lg border border-slate-200 text-[10.5px] text-slate-500 font-semibold leading-relaxed">
 Lưu ý: Bạn hãy chắc chắn đã nạp chính xác
 tệp Excel thiết kế / thi công mới nhất của
 dự án này, hoặc kiểm tra mã QR in trên tem
 có trùng cấu trúc chuẩn hay không.
 </div>
 </div>
 )}

 {matchedEntry && (
 <div className="space-y-6">
 {(() => {
 const isCtht = (matchedEntry.moduleCode || '').toLowerCase().includes('ctht') ||
   matchedEntry.classification === 'CTHT' ||
   (matchedEntry.classification as string) === 'ctht';
 return (
 <>
 {/* 1. THÔNG TIN CƠ BẢN (BENTO CARD STYLE) */}
 <div className="bg-slate-100/50 rounded-lg p-4 border border-slate-100 space-y-4">
 <div className="flex items-center gap-2 border-b border-slate-200 pb-2">
 <Info
 size={14}
 className="text-indigo-600"
 />
 <h4 className="text-[10px] font-black text-slate-800 uppercase tracking-widest leading-none">
 {isCtht ? 'Thông tin kiện CTHT' : 'Thông tin cấu kiện cơ bản'}
 </h4>
 </div>

 <div className="grid grid-cols-2 gap-4">
 <div className="space-y-1">
 <p className="text-[8.5px] font-black text-slate-400 uppercase tracking-widest leading-none">
 Cụm / Khu vực
 </p>
 <p className="text-[12.5px] font-black text-slate-800 uppercase leading-none">
 {matchedEntry.cluster ||
 result.cluster ||
 "Chưa phân cụm"}
 </p>
 </div>
 <div className="space-y-1">
 <p className="text-[8.5px] font-black text-slate-400 uppercase tracking-widest leading-none">
 Kích thước (D x R x C)
 </p>
 <p className="text-[12px] font-black text-slate-705 font-mono leading-none">
 {`${matchedEntry.pWidth || matchedEntry.width || result.width || 0}x${matchedEntry.pDepth || matchedEntry.depth || result.depth || 0}x${matchedEntry.pHeight || matchedEntry.height || result.height || 0}`}
 </p>
 </div>
 </div>

 {/* Tiến độ giao nhận - ẩn khi đạt 100% */}
 {(matchedEntry.receivedQuantity || 0) < matchedEntry.quantity && (
 <div className="pt-2 border-t border-slate-200/60">
 <div className="flex justify-between items-center mb-1.5">
 <p className="text-[8.5px] font-black text-slate-400 uppercase tracking-widest leading-none">
 Tiến độ Giao Nhận dự án
 </p>
 <span
 className={`text-[9px] font-black px-1.5 py-0.5 rounded-sm uppercase tracking-tight ${matchedEntry.receivedQuantity === matchedEntry.quantity ? "bg-emerald-600 text-white" : "bg-slate-200 text-slate-500"}`}
 >
 {matchedEntry.receivedQuantity ||
 0}{" "}
 / {matchedEntry.quantity} (
 {Math.round(
 ((matchedEntry.receivedQuantity ||
 0) /
 matchedEntry.quantity) *
 100,
 )}
 %)
 </span>
 </div>
 <div className="w-full bg-slate-200 h-2 rounded-full overflow-hidden">
 <div
 className="bg-indigo-600 h-full rounded-full transition-all duration-500"
 style={{
 width: `${Math.min(100, Math.round(((matchedEntry.receivedQuantity || 0) / matchedEntry.quantity) * 100))}%`,
 }}
 />
 </div>
 </div>
 )}

 </div>

  {/* 3D Model và Hình ảnh ngoại quan thực tế từ Chi tiết dự án */}
  {(() => {
  const projectCode = matchedEntry.projectCode;
  const dbGlbUrl =
  projectEntries.find(
  (p) => p.projectCode === projectCode && p.glbUrl,
  )?.glbUrl ||
  matchedEntry.glbUrl ||
  "";
  const projectGlbUrl = dbGlbUrl.trim();
  if (!projectGlbUrl) return null;

  // Với kiện CTHT, ưu tiên tìm object trong 3D CAD theo tên Phụ kiện đi kèm
  const isCthtEntry =
  (matchedEntry.moduleCode || '').toLowerCase().includes('ctht') ||
  matchedEntry.classification === 'CTHT' ||
  (matchedEntry.classification as string) === 'ctht';

  let cadModuleName: string | string[] = matchedEntry.moduleCode;
  if (isCthtEntry && matchedEntry.accessories && matchedEntry.accessories.length > 0) {
    const accessoryNames = matchedEntry.accessories
      .map((acc: any) => acc.name)
      .filter((name: string) => !!name);
    if (accessoryNames.length > 0) {
      cadModuleName = accessoryNames;
    }
  }

 return (
 <div className="w-full space-y-2.5 text-left bg-slate-100/50 rounded-lg p-4 border border-slate-200/60 font-sans">
 <div className="flex items-center gap-2 border-b border-slate-200 pb-2">
 <Cuboid size={14} className="text-indigo-600 animate-pulse" />
 <h4 className="text-[10px] font-black text-slate-800 uppercase tracking-widest leading-none">
 Mô hình 3D cấu kiện (CAD ISO View)
 </h4>
 </div>
 <ModuleThreeViewer
 url={projectGlbUrl}
 moduleName={cadModuleName}
 />
 </div>
 );
 })()}

 {/* Bộ sưu tập hình ảnh ngoại quan */}
 {(() => {
 const allPhotos: { url: string; label: string }[] = [];
 const seenUrls = new Set<string>();
 const addPhoto = (url: string, label: string) => { if (url && !seenUrls.has(url)) { seenUrls.add(url); allPhotos.push({ url, label }); } };

 if (matchedEntry.qcPhotos?.length) {
  matchedEntry.qcPhotos.forEach((p: string) => addPhoto(p, "QC"));
 }

 const instances = getModuleInstances(matchedEntry);
 const stageFields = [
  { field: "qcWhite" as const, lbl: "T" },
  { field: "qcPaint" as const, lbl: "S" },
  { field: "qcFinish" as const, lbl: "H" },
  { field: "qcPack" as const, lbl: "Đ" },
 ];

 if (instances.length > 0) {
  instances.forEach(inst => {
   stageFields.forEach(({ field, lbl }) => {
    const qcData = (inst as any)[field];
    if (qcData && qcData.status !== "fail" && qcData.photos?.length) {
     qcData.photos.forEach((p: string) => addPhoto(p, `${lbl} - #${inst.instanceIndex || 1}`));
    }
   });
  });
 }
 if (!seenUrls.size) {
  stageFields.forEach(({ field, lbl }) => {
   const data = matchedEntry[field];
   if (data && data.status !== "fail" && data.photos?.length) {
    data.photos.forEach((p: string) => addPhoto(p, lbl));
   }
  });
 }

 if (packingPhotos.length) {
  packingPhotos.forEach((p) => addPhoto(p, "Gói"));
 }

 if (!allPhotos.length) return null;
 const urls = allPhotos.map((p) => p.url);

 return (
 <div className="space-y-3 pt-3 border-t border-slate-100 font-sans text-left bg-slate-100/20 p-4 rounded-lg border border-slate-100">
 <h4 className="text-[9.5px] font-black text-slate-400 uppercase tracking-[0.2em] flex items-center">
 <span className="w-1.5 h-1.5 bg-indigo-500 mr-2 rounded-full"></span>
 Hình ảnh ngoại quan thực tế ({allPhotos.length})
 </h4>
 <div className="grid grid-cols-4 gap-2">
 {allPhotos.map((img, i) => (
 <button
 key={i}
 type="button"
 className="relative aspect-square rounded-lg overflow-hidden border border-slate-200 focus:outline-none block w-full cursor-pointer group hover:shadow-md transition-all"
 onClick={() => {
 setLightboxImages(urls);
 setLightboxStartIndex(i);
 (document.getElementById("scanner-photo-dialog") as HTMLDialogElement)?.showModal();
 }}
 >
 <img
 src={img.url}
 alt={img.label}
 referrerPolicy="no-referrer"
 className="w-full h-full object-cover"
 />
 <span className="absolute bottom-1 left-1 right-1 text-[7px] md:text-[8px] font-black uppercase text-center text-white bg-black/60 px-1 py-0.5 rounded-lg truncate select-none">
 {img.label}
 </span>
 </button>
 ))}
 </div>
 </div>
 );
 })()}

  {/* 3. TÌNH TRẠNG KIỂM ĐỊNH (4 CÔNG ĐOẠN) */}
  {matchedEntry && (
  <QcStageBadges
  module={matchedEntry}
  instance={selectedInstanceCurrent}
  qcTickets={localQcTickets}
  isQC={isQC}
  canEditQc={hasRole("admin") || hasRole("mod_qc")}
  packStatus={selectedInstanceCurrent?.packStatus}
  canOpenPacking={hasRole('admin') || hasRole('mod_dg') || (hasRole('mod_x2') && ((userProfile?.chuc_danh || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().includes('dg')))}
  label={(() => {
    const codeLower = (matchedEntry.moduleCode || '').toLowerCase();
    const isKienCtht = codeLower.includes('kiện ctht') || codeLower.includes('kien ctht') || codeLower.includes('finished panel') || matchedEntry.moduleType === 'bo';
    return isKienCtht ? 'Tình trạng giám sát QC' : 'Tình trạng giám sát QC các công đoạn';
  })()}
  stages={(() => {
    const codeLower = (matchedEntry.moduleCode || '').toLowerCase();
    const isKienCtht = codeLower.includes('kiện ctht') || codeLower.includes('kien ctht') || codeLower.includes('finished panel') || matchedEntry.moduleType === 'bo';
    return isKienCtht ? [{ id: 'pack', label: 'Đóng Gói', short: 'Đ' }] : undefined;
  })()}
  onOpenPacking={(instIdx?: number) => {
   if (setParentActiveTab) {
    setParentActiveTab('packing');
    window.dispatchEvent(new CustomEvent('focus-packing-module', { detail: { moduleName: matchedEntry.moduleCode, instanceIndex: instIdx } }));
   }
  }}
  onStageClick={(stageId) => {
  if (!isQC) return;
  const field = `qc${stageId.charAt(0).toUpperCase() + stageId.slice(1)}`;
  const stageData = selectedInstanceCurrent ? (selectedInstanceCurrent as any)[field] : { status: 'none', by: '', notes: '', date: null };
  const stage = { id: stageId, field: field, data: stageData };
  handleOpenInspectionModal(stage);
  }}
  />
  )}
 {/* DANH SÁCH CẤU KIỆN CON LIÊN KẾT */}

 {matchedEntry &&
 (() => {
 const childrenList =
 projectEntries.filter(
 (e) =>
 e.projectCode ===
 matchedEntry.projectCode &&
 (e.parentId ===
 matchedEntry.id ||
 (matchedEntry.moduleCode &&
 e.parentModuleCode ===
 matchedEntry.moduleCode)),
 );
 if (childrenList.length === 0)
 return null;
 return (
 <div className="">
 <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] flex items-center mb-4">
 <span className="w-1.5 h-1.5 bg-indigo-500 mr-2 rounded-full "></span>
 Danh sách cấu kiện con
 </h4>
 <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-1">
 {childrenList.map(
 (child, idx) => {
 const ratio =
 child.assemblyQuantity ||
 (child.quantity &&
 matchedEntry.quantity
 ? Math.round(
 (child.quantity /
 matchedEntry.quantity) *
 100,
 ) / 100
 : 1);
 return (
 <div
 key={
 child.id ||
 idx
 }
 onClick={(
 e,
 ) => {
 e.stopPropagation();
 setSelectedChildModule(
 child,
 );
 }}
 className="flex items-center justify-between p-2.5 bg-slate-100 rounded-lg border border-slate-200 hover:border-indigo-500 transition-all cursor-pointer group"
 >
 <div className="flex flex-col min-w-0">
 <span className="text-[11px] font-black uppercase text-slate-800 truncate group-hover:text-indigo-600 leading-tight">
 {
 child.moduleCode
 }
 </span>
 <span className="text-[8px] font-bold text-slate-400 truncate uppercase mt-0.5 leading-none">
 {child.classification ||
 "Cấu kiện con"}
 </span>
 </div>
 <div className="shrink-0 bg-indigo-100/50 px-2 py-0.5 rounded-lg border border-indigo-100">
 <span className="text-[9px] font-black text-indigo-600">
 x{
 ratio
 }{" "}
 </span>
 </div>
 </div>
 );
 },
 )}
 </div>
 </div>
 );
 })()}
 {/* 2. PHỤ KIỆN ĐÍNH KÈM (In-line block) */}
 {matchedEntry.accessories &&
 matchedEntry.accessories.length > 0 && (
 <div className="space-y-2.5">
 <h4 className="text-[9.5px] font-black text-slate-400 uppercase tracking-[0.2em] flex items-center">
 <span className="w-1.5 h-1.5 bg-orange-500 mr-2 rounded-full"></span>
 {((matchedEntry.moduleCode || '').toLowerCase().includes('ctht') || matchedEntry.classification === 'CTHT' || (matchedEntry.classification as string) === 'ctht')
  ? `Các CTHT bên trong (${matchedEntry.accessories.length})`
  : `Phụ kiện đi kèm (${matchedEntry.accessories.length})`}
 </h4>
 <div className="grid grid-cols-1 gap-2">
 {matchedEntry.accessories.map(
 (acc, aIdx) => (
 <div
 key={aIdx}
 className="flex items-center justify-between px-3 py-2 bg-slate-100/70 rounded-md border border-slate-100"
 >
 <div className="flex items-center gap-2 min-w-0">
 <Boxes
 size={13}
 className="text-slate-400 shrink-0"
 />
 <span className="text-[10px] font-bold text-slate-700 uppercase tracking-tight truncate">
 {acc.name}
 </span>
 </div>
 <div className="flex items-center gap-2 shrink-0">
 <span className="text-[9px] font-black text-indigo-700">
 SL:{" "}
 {
 acc.quantity
 }
 </span>
 <span
 className={`text-[8px] font-black px-1.5 py-0.5 rounded-sm uppercase border ${acc.status === "Đã cấp" ? "bg-emerald-100 text-emerald-600 border-emerald-100" : "bg-orange-100 text-orange-600 border-orange-100"}`}
 >
 {acc.status}
 </span>
 </div>
 </div>
 ),
 )}
 </div>
 </div>
 )}

 {/* 5. NHẬT KÝ CẬP NHẬT HỆ THỐNG */}
 <div className="space-y-3 pt-3 border-t border-slate-100 font-sans">
 <h4 className="text-[9.5px] font-black text-slate-400 uppercase tracking-[0.2em] flex items-center">
 <span className="w-1.5 h-1.5 bg-teal-500 mr-2 rounded-full"></span>
 Nhật ký lịch sử cấu kiện
 </h4>

 {matchedEntry.statusHistory &&
 matchedEntry.statusHistory.length > 0 ? (
 <div className="relative border-l border-slate-200 pl-3.5 ml-1.5 space-y-4 max-h-[240px] overflow-y-auto pr-1">
 {matchedEntry.statusHistory
 .slice()
 .reverse()
 .map((historyLog, hIdx) => {
 const parts =
 historyLog.split("|");
 const detailText =
 parts[0] || "";
 const timestampVal =
 parts[1]
 ? Number(parts[1])
 : null;

 let dateStr = "N/A";
 if (timestampVal) {
 dateStr = new Date(
 timestampVal,
 ).toLocaleString(
 "vi-VN",
 {
 day: "2-digit",
 month: "2-digit",
 year: "2-digit",
 hour: "2-digit",
 minute: "2-digit",
 },
 );
 }

 let dotColor =
 "bg-slate-300 border-white";
 if (
 detailText
 .toLowerCase()
 .includes("pass") ||
 detailText
 .toLowerCase()
 .includes("đạt")
 ) {
 dotColor =
 "bg-emerald-500 border-emerald-100 ring-2 ring-emerald-100";
 } else if (
 detailText
 .toLowerCase()
 .includes("fail") ||
 detailText
 .toLowerCase()
 .includes("lỗi")
 ) {
 dotColor =
 "bg-rose-500 border-rose-100 ring-2 ring-rose-100";
 } else if (
 detailText
 .toLowerCase()
 .includes("tạo") ||
 detailText
 .toLowerCase()
 .includes("create")
 ) {
 dotColor =
 "bg-indigo-500 border-indigo-100 ring-2 ring-indigo-100";
 }

 return (
 <div
 key={hIdx}
 className="relative text-left"
 >
 <span
 className={`absolute -left-[20.5px] top-1 w-2.5 h-2.5 rounded-full border border-white ${dotColor}`}
 />
 <div className="space-y-0.5">
 <p className="text-[11px] font-bold text-slate-800 leading-normal uppercase tracking-tight">
 {detailText}
 </p>
 <p className="text-[8.5px] text-slate-400 font-medium font-mono">
 {dateStr}
 </p>
 </div>
 </div>
 );
 })}
 </div>
 ) : (
 <div className="p-4 text-center rounded-lg border border-dashed border-slate-200 text-slate-400 space-y-1">
 <History
 size={18}
 className="mx-auto text-slate-300"
 />
 <p className="text-[8.5px] font-black uppercase tracking-widest">
 Không có lịch sử
 </p>
 <p className="text-[8.5px] text-slate-400">
 Hệ thống chưa ghi nhận các hoạt
 động thay đổi cấu kiện này.
 </p>
 </div>
 )}
 </div>
 </>
 );
 })()}
 </div>
 )}

 {result.notes && (
 <div className="p-3 bg-indigo-100 rounded-lg border border-indigo-100 flex gap-3 italic shadow-sm shrink-0">
 <Info
 size={16}
 className="text-indigo-600 shrink-0"
 />
 <p className="text-[10px] text-indigo-800 leading-tight font-bold uppercase tracking-tight">
 {result.notes}
 </p>
 </div>
 )}
 </div>
 </motion.div>
 )}

 {showScanner && (
 <ScannerModal
 onClose={() => setShowScanner(false)}
 onScan={(res) => {
  setResult(res);
  setScanCount(c => c + 1);
  setShowScanner(false);
  }}
 projectEntries={projectEntries}
 />
 )}

 {/* Floating QC Inspection Modal */}
 <AnimatePresence>
 {isQCModalOpen && activeStage && scannedEntry && (
 <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 backdrop-blur-sm p-0 md:p-4">
 <motion.div
 initial={{ opacity: 0, scale: 1, y: 0 }}
 animate={{ opacity: 1, scale: 1, y: 0 }}
 exit={{ opacity: 0, scale: 1, y: 0 }}
 transition={{ duration: 0.12, ease: "easeOut" }}
 className="bg-white w-screen md:w-full md:max-w-lg h-screen md:h-auto md:max-h-[90vh] rounded-none md:rounded-lg shadow-2xl overflow-hidden border border-slate-200 flex flex-col"
 >
 {/* Header */}
 <div className="bg-white px-8 py-6 border-b border-slate-100 flex items-center justify-between shrink-0">
 <div className="flex flex-col">
 <span className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400 mb-1">
 {scannedEntry.projectName}
 </span>
 <div className="flex items-center gap-3">
 <h3 className="text-xl md:text-2xl font-black text-slate-800 uppercase tracking-tighter leading-none">
 {selectedInstanceCurrent
 ? `${scannedEntry.moduleCode} - Kiện ${selectedInstanceCurrent.stt || selectedInstanceCurrent.tempLabelIndex || selectedInstanceCurrent.instanceIndex}/${scannedEntry.quantity || 1}`
 : scannedEntry.moduleCode}
 </h3>
 <span className="bg-indigo-100 text-indigo-600 px-2.5 py-1 rounded-lg text-[9px] font-black uppercase tracking-widest border border-indigo-100">
 {activeStage.label}
 </span>
 </div>
 </div>
 <button
 onClick={() => {
 setIsQCModalOpen(false);
 setActiveStage(null);
 }}
 className="p-2 text-slate-400 hover:text-rose-500 transition-colors cursor-pointer"
 >
 <X size={20} />
 </button>
 </div>

 {/* Sub-Header */}
 <div className="bg-slate-100 px-8 py-3 flex items-center gap-6 border-b border-slate-100 shrink-0 overflow-x-auto">
 <div className="flex items-center gap-2 shrink-0">
 <p className="text-[9px] font-black uppercase text-slate-400 tracking-widest">
 KÍCH THƯỚC:
 </p>
 <p className="text-[11px] font-black text-slate-700 font-mono tracking-tight">
 {scannedEntry.pWidth ||
 scannedEntry.width ||
 0}
 x
 {scannedEntry.pHeight ||
 scannedEntry.height ||
 0}
 x
 {scannedEntry.pDepth ||
 scannedEntry.depth ||
 0}
 </p>
 </div>
 <div className="flex items-center gap-2 shrink-0">
 <p className="text-[9px] font-black uppercase text-slate-400 tracking-widest">
 CỤM:
 </p>
 <p className="text-[11px] font-black text-slate-700 uppercase truncate max-w-[120px]">
 {scannedEntry.cluster || "N/A"}
 </p>
 </div>
 </div>

 {/* Content Panel */}
 <div className="p-8 space-y-8 overflow-y-auto bg-white flex-1 custom-scrollbar">
 {/* Checklist tiêu chí chất lượng tương ứng */}
 <div className="space-y-4">
 <div className="flex items-center justify-between border-b border-slate-100 pb-3">
 <div className="flex items-center gap-3">
 <div className="p-1.5 bg-slate-100 text-slate-500 rounded-lg">
 <CheckSquare size={14} />
 </div>
 <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block leading-none">
 Checklist kiểm định{" "}
 {getEntryType(scannedEntry)} (
 {activeStage.label})
 </label>
 </div>
 <span className="text-[8px] font-black uppercase text-indigo-600 bg-indigo-100 px-2 py-0.5 rounded-sm tracking-widest">
 Chuẩn quy trình
 </span>
 </div>

 <div className="space-y-2.5">
 {getQCCriteria(
 getEntryType(scannedEntry),
 activeStage.id,
 ).map((cri) => {
 const isChecked =
 !!checkedCriteria[cri.id];
 const photos =
 criterionPhotos[cri.id] || [];
 const isUploading =
 !!criterionUploading[cri.id];

 return (
 <div
 key={cri.id}
 className={`p-3 rounded-lg border transition-all text-left ${
 isChecked
 ? "bg-indigo-100/30 border-indigo-200/60"
 : "bg-slate-100 border-slate-100 hover:border-slate-205"
 }`}
 >
 <div className="flex items-start justify-between gap-3">
 {/* Checkbox action */}
 <div
 onClick={() => {
 const nextChecked =
 !isChecked;
 const updated =
 {
 ...checkedCriteria,
 [cri.id]:
 nextChecked,
 };
 setCheckedCriteria(
 updated,
 );
 }}
 className="flex items-start gap-3 flex-1 cursor-pointer select-none min-w-0"
 >
 {/* Custom Checkbox to rõ */}
 <div
 className={`w-5.5 h-5.5 rounded-sm border flex items-center justify-center transition-all shrink-0 mt-0.5 ${
 isChecked
 ? "bg-indigo-600 border-indigo-600 shadow-sm"
 : "bg-white border-slate-300"
 }`}
 >
 {isChecked && (
 <Check
 size={
 13
 }
 strokeWidth={
 3
 }
 className="text-white"
 />
 )}
 </div>

 <div className="flex-1 min-w-0 leading-tight">
 <span className="text-[7.5px] font-black uppercase bg-slate-300/80 text-slate-600 px-1 py-0.2 rounded-sm mr-1.5 shrink-0 inline-block tracking-widest leading-none">
 {
 cri.category
 }
 </span>
 <span className="text-[11px] font-bold text-slate-800 leading-snug">
 {cri.text}
 </span>
 </div>
 </div>

 {/* Chọn nhiều ảnh từ thư viện cho từng tiêu chí */}
 <div className="shrink-0">
 {isUploading ? (
 <Loader2
 size={16}
 className="animate-spin text-indigo-600"
 />
 ) : (
 <label
 className="p-1 px-2.5 bg-white hover:bg-slate-100 border border-slate-200 text-slate-500 hover:text-slate-700 rounded-sm cursor-pointer flex items-center gap-1.5 transition-all active:scale-95"
 title="Chọn nhiều ảnh sẵn có từ máy"
 >
 <input
 type="file"
 accept="image/*"
 multiple
 className="hidden"
 onChange={(
 e,
 ) => {
 const files =
 e
 .target
 .files;
 if (
 files &&
 files.length >
 0
 ) {
 handleCriterionPhotoUpload(
 cri.id,
 files,
 );
 }
 }}
 />
 <ImageIcon
 size={
 13
 }
 className="text-slate-400"
 />
 <span className="text-[8.5px] font-black uppercase tracking-wider text-slate-500">
 Thêm ảnh
 lỗi
 </span>
 </label>
 )}
 </div>
 </div>

 {/* Thumbnail ảnh lỗi của tiêu chí */}
 {photos.length > 0 && (
 <div className="flex gap-2 mt-2.5 flex-wrap pl-8.5 border-t border-dashed border-slate-200 pt-2">
 {photos.map(
 (
 photo,
 pIdx,
 ) => (
 <div
 key={
 pIdx
 }
 className="w-12 h-12 rounded-sm border border-slate-300 overflow-hidden relative group shrink-0 shadow-sm bg-slate-100"
 >
 <img
 src={
 photo
 }
 alt=""
 className="w-full h-full object-cover"
 referrerPolicy="no-referrer"
 />
 <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
 <button
 type="button"
 onClick={() =>
 removeCriterionPhoto(
 cri.id,
 pIdx,
 )
 }
 className="text-white p-1 bg-rose-600 rounded-sm hover:scale-110 transition-transform cursor-pointer"
 >
 <X
 size={
 10
 }
 />
 </button>
 </div>
 </div>
 ),
 )}
 </div>
 )}
 </div>
 );
 })}
 </div>
 </div>

 {/* Mục nhập số lượng đạt nhanh */}
 {scannedEntry && !selectedInstanceCurrent &&
 (scannedEntry.quantity || 1) > 1 && (
 <div className="space-y-4">
 <div className="flex items-center gap-3 border-b border-slate-100 pb-3">
 <div className="p-1.5 bg-slate-100 text-slate-500 rounded-lg">
 <Boxes size={14} />
 </div>
 <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block leading-none">
 Số lượng đã kiểm đạt nhanh
 (Tối đa:{" "}
 {scannedEntry.quantity})
 </label>
 </div>
 <div className="pt-2">
 <input
 type="number"
 min={1}
 max={scannedEntry.quantity}
 value={qcInspectedQty}
 onChange={(e) =>
 setQcInspectedQty(
 e.target.value,
 )
 }
 placeholder="Nhập số lượng đạt... (bỏ trống mặc định là 1)"
 className="w-full bg-slate-100 border border-slate-200 rounded-lg px-4 py-3 text-[11px] font-black text-slate-800 focus:border-indigo-600 outline-none transition-all shadow-none placeholder:text-slate-400"
 />
 </div>
 </div>
 )}

 {/* Notes/Ghi chú */}
 <div className="space-y-4">
 <div className="flex items-center gap-3 border-b border-slate-100 pb-3">
 <div className="p-1.5 bg-slate-100 text-slate-500 rounded-lg">
 <MessageSquare size={14} />
 </div>
 <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block leading-none">
 Hồ sơ ghi chú công đoạn
 </label>
 </div>
 <div className="pt-2">
 <textarea
 value={qcNotes}
 onChange={(e) =>
 setQcNotes(e.target.value)
 }
 placeholder="Nhập chi tiết các sai lỗi hoặc ghi chú đặc biệt..."
 rows={2}
 className="w-full bg-slate-100 border border-slate-200 rounded-lg px-4 py-3 text-[11px] font-black text-slate-800 uppercase focus:border-indigo-600 outline-none transition-all resize-none shadow-none tracking-tight leading-relaxed placeholder:text-slate-400"
 />
 </div>

 {/* Tải lên ảnh ngoại quan công đoạn */}
 <div className="space-y-3 pt-2 border-t border-slate-100/60">
 <div className="flex items-center justify-between">
 <span className="text-[9px] font-black text-slate-400 uppercase tracking-wider block">
 Ảnh ngoại quan công đoạn (
 {qcPhotos.length})
 </span>
 <label className="text-[9px] font-black uppercase text-indigo-600 hover:text-indigo-700 tracking-wider flex items-center gap-1.5 cursor-pointer transition-colors px-2.5 py-1.5 bg-indigo-100 hover:bg-indigo-100 rounded-lg select-none">
 <Camera
 size={13}
 className="text-indigo-600"
 />
 <span>Chọn ảnh</span>
 <input
 type="file"
 multiple
 accept="image/*"
 onChange={handlePhotoUpload}
 className="hidden"
 />
 </label>
 </div>

 {uploading && (
 <div className="flex items-center gap-2 text-xs text-indigo-600 justify-center py-2.5 bg-indigo-100/50 rounded-lg border border-dashed border-indigo-200 animate-pulse">
 <Loader2
 size={13}
 className="animate-spin text-indigo-600"
 />
 <span className="uppercase tracking-widest text-[8.5px] font-black">
 Đang nạp ảnh ngoại quan...
 </span>
 </div>
 )}

 {qcPhotos.length > 0 && (
 <div className="grid grid-cols-4 gap-2 pt-1">
 {qcPhotos.map((photo, pIdx) => (
 <div
 key={pIdx}
 className="relative aspect-square bg-slate-100 border border-slate-200 rounded-lg overflow-hidden shadow-xs"
 >
 <img
 src={photo}
 alt={`General QC ${pIdx + 1}`}
 referrerPolicy="no-referrer"
 className="w-full h-full object-cover"
 />
 <button
 type="button"
 onClick={() =>
 removePhoto(
 pIdx,
 )
 }
 className="absolute top-1 right-1 p-1 bg-rose-600 hover:bg-rose-700 text-white rounded-lg opacity-90 hover:opacity-100 transition-all shadow-xs cursor-pointer"
 >
 <X size={10} />
 </button>
 </div>
 ))}
 </div>
 )}
 </div>
 </div>
 </div>

 {/* Footer controls */}
 <div className="p-6 bg-slate-100 border-t border-slate-100 flex items-center justify-between gap-4 shrink-0">
 <button
 type="button"
 onClick={() => {
 setIsQCModalOpen(false);
 setActiveStage(null);
 }}
 className="px-6 py-3.5 bg-white text-slate-600 border border-slate-200 rounded-sm text-[10px] font-black uppercase tracking-widest hover:bg-slate-100 transition-all cursor-pointer"
 >
 Huỷ bỏ
 </button>
 <button
 type="button"
 disabled={modalLoading}
 onClick={handleSaveQCResult}
 className={`flex-1 py-3.5 text-white rounded-sm font-black uppercase tracking-widest text-[11px] flex items-center justify-center gap-3 active:scale-95 disabled:opacity-100 transition-all cursor-pointer ${
 qcStatus === "fail"
 ? "bg-rose-600 hover:bg-rose-700 shadow-xl shadow-rose-100"
 : "bg-indigo-600 hover:bg-indigo-700 shadow-xl shadow-indigo-100"
 }`}
 >
 {modalLoading ? (
 <Loader2
 size={18}
 className="animate-spin"
 />
 ) : (
 <Save size={18} />
 )}
 {qcStatus === "fail"
 ? "HOÀN TẤT PHIẾU (FAIL)"
 : "PHÊ DUYỆT CÔNG ĐOẠN"}
 </button>
 </div>
 </motion.div>
 </div>
 )}
 </AnimatePresence>

 {showDetailModal && matchedEntry && (
 <ModuleDetailModal
 module={scannedEntry || matchedEntry}
 onClose={() => setShowDetailModal(false)}
 projectAccessories={projectAccessories}
 allEntries={projectEntries}
 onOpenModule={(m) => setSelectedChildModule(m)}
 onOpenPacking={(instIdx?: number) => {
  if (setParentActiveTab) {
   setParentActiveTab('packing');
   window.dispatchEvent(new CustomEvent('focus-packing-module', { detail: { moduleName: matchedEntry.moduleCode, instanceIndex: instIdx } }));
  }
 }}
 />
 )}

 {selectedChildModule && (
 <ModuleDetailModal
 module={selectedChildModule}
 onClose={() => setSelectedChildModule(null)}
 projectAccessories={projectAccessories}
 allEntries={projectEntries}
 onOpenModule={(m) => setSelectedChildModule(m)}
 onOpenPacking={(instIdx?: number) => {
  if (setParentActiveTab) {
   setParentActiveTab('packing');
   window.dispatchEvent(new CustomEvent('focus-packing-module', { detail: { moduleName: selectedChildModule.moduleCode, instanceIndex: instIdx } }));
  }
 }}
 />
 )}

 {showAssemblyModal && scannedEntry && (
 <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
 <motion.div
 initial={{ opacity: 0, scale: 0.95 }}
 animate={{ opacity: 1, scale: 1 }}
 exit={{ opacity: 0, scale: 0.95 }}
 className="bg-white w-full max-w-lg rounded-lg shadow-2xl overflow-hidden border border-slate-200 flex flex-col max-h-[85vh]"
 >
 {/* Header */}
 <div className="bg-slate-100 px-6 py-4 border-b border-slate-100 flex items-center justify-between shrink-0">
 <div className="flex flex-col text-left">
 <span className="text-[9px] font-black uppercase tracking-[0.2em] text-orange-600 mb-0.5">
 LR2 LEADER - LẮP RÁP THỦ CÔNG
 </span>
 <h3 className="text-base font-black text-slate-800 uppercase tracking-tight">
 Liên kết module con cho:{" "}
 {scannedEntry.moduleCode}
 </h3>
 </div>
 <button
 onClick={() => setShowAssemblyModal(false)}
 className="p-1.5 text-slate-400 hover:text-rose-500 hover:bg-rose-100 rounded-sm transition-colors cursor-pointer"
 >
 <X size={18} />
 </button>
 </div>

 {/* Content */}
 <div className="p-6 overflow-y-auto space-y-4">
 <div className="p-4 bg-indigo-100/50 rounded-lg border border-indigo-100 text-[11px] text-indigo-900 font-bold leading-relaxed shadow-sm">
 📌 Hãy tích chọn các cấu kiện thuộc cùng dự án
 phía dưới để thi công, lắp ráp thủ công làm con
 của module{" "}
 <span className="underline font-black">
 {scannedEntry.moduleCode}
 </span>{" "}
 này. Nhập số lượng liên kết cho từng cấu kiện.
 Nhấn <strong>Xác nhận</strong> để cập nhật.
 </div>

 <div className="space-y-2">
 <div className="flex items-center justify-between block mb-2">
 <h4 className="text-[9px] font-black text-slate-400 uppercase tracking-[0.2em]">
 Danh sách cấu kiện cùng dự án (
 {assemblySiblingList.length})
 </h4>
 </div>

 {assemblySiblingList.length > 0 ? (
 <div className="grid grid-cols-1 gap-2.5 max-h-[40vh] overflow-y-auto pr-1">
 {assemblySiblingList.map((sib) => {
 const isChecked =
 !!selectedAssemblyChildren[
 sib.id
 ];
 const hasOtherParent =
 (sib.parentId &&
 sib.parentId !==
 scannedEntry.id) ||
 (sib.parentModuleCode &&
 sib.parentModuleCode !==
 scannedEntry.moduleCode);

 return (
 <div
 key={sib.id}
 className={`p-3 rounded-lg border flex items-center justify-between transition-all ${
 isChecked
 ? "bg-indigo-100/40 border-indigo-200"
 : "bg-white hover:bg-slate-100 border-slate-200"
 }`}
 >
 <div className="flex items-center gap-3 text-left">
 <input
 type="checkbox"
 id={`child-${sib.id}`}
 checked={isChecked}
 onChange={(ev) => {
 setSelectedAssemblyChildren(
 (prev) => ({
 ...prev,
 [sib.id]:
 ev
 .target
 .checked,
 }),
 );
 if (
 ev.target
 .checked &&
 !assemblyQuantities[
 sib.id
 ]
 ) {
 setAssemblyQuantities(
 (
 prev,
 ) => ({
 ...prev,
 [sib.id]:
 sib.quantity ||
 1,
 }),
 );
 }
 }}
 className="w-4 h-4 text-indigo-600 border-slate-400 rounded-sm focus:ring-indigo-500 cursor-pointer"
 />
 <div className="flex flex-col">
 <label
 htmlFor={`child-${sib.id}`}
 className="text-[12px] font-black text-slate-800 font-mono uppercase cursor-pointer"
 >
 {sib.moduleCode}
 </label>
 <div className="flex items-center gap-2 mt-0.5 text-[9px] text-slate-500 font-bold uppercase tracking-tight">
 <span>
 Phân loại:{" "}
 {getEntryTypeLocal(
 sib.moduleCode,
 sib,
 )}
 </span>
 <span>•</span>
 <span>
 Hệ số lượng
 gốc:{" "}
 {
 sib.quantity
 }
 </span>
 {hasOtherParent && (
 <span className="text-amber-600 bg-amber-100 px-1 rounded-sm border border-amber-100">
 Đang lắp
 ở:{" "}
 {
 sib.parentModuleCode
 }
 </span>
 )}
 </div>
 </div>
 </div>

 {isChecked && (
 <div className="flex items-center gap-1.5 shrink-0">
 <span className="text-[9px] font-black uppercase text-slate-400">
 SL lắp:
 </span>
 <input
 type="number"
 min="1"
 value={
 assemblyQuantities[
 sib.id
 ] || 1
 }
 onChange={(
 ev,
 ) => {
 const val =
 Math.max(
 1,
 Number(
 ev
 .target
 .value,
 ) ||
 1,
 );
 setAssemblyQuantities(
 (
 prev,
 ) => ({
 ...prev,
 [sib.id]:
 val,
 }),
 );
 }}
 className="w-16 border border-slate-200 rounded-lg px-2 py-1 text-center font-bold text-xs bg-white text-slate-800 focus:border-indigo-500 focus:outline-none"
 />
 </div>
 )}
 </div>
 );
 })}
 </div>
 ) : (
 <div className="p-8 text-center rounded-lg border border-dashed border-slate-200 text-slate-400 space-y-1">
 <Boxes
 size={24}
 className="mx-auto text-slate-300"
 />
 <p className="text-[10px] font-black uppercase tracking-widest">
 Không có cấu kiện khác
 </p>
 <p className="text-[10px] text-slate-400">
 Không tìm thấy các cấu kiện khả dụng
 khác trong cùng dự án này.
 </p>
 </div>
 )}
 </div>
 </div>

 {/* Footer */}
 <div className="px-6 py-4 bg-slate-100 border-t border-slate-100 flex items-center justify-between shrink-0">
 <button
 onClick={() => setShowAssemblyModal(false)}
 className="px-5 py-2.5 bg-white text-slate-600 border border-slate-200 rounded-lg text-[10px] font-black uppercase tracking-widest hover:bg-slate-100 transition-all cursor-pointer"
 >
 Hủy bỏ
 </button>
 <button
 onClick={handleSaveAssemblyLinks}
 disabled={savingAssembly}
 className="px-6 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-100 text-white rounded-lg text-[10px] font-black uppercase tracking-widest transition-all flex items-center gap-2 cursor-pointer shadow-lg shadow-indigo-500/15"
 >
 {savingAssembly ? (
 <Loader2
 size={14}
 className="animate-spin"
 />
 ) : (
 <Check size={14} />
 )}
 <span>Xác nhận liên kết</span>
 </button>
 </div>
 </motion.div>
 </div>
 )}

 {/* Floating Action Menu (FAB) góc dưới bên phải */}

 {scannedEntry && matchedEntry && (
 <div className="fixed bottom-24 right-6 z-[90] flex flex-col items-end">
 {isQuickActionOpen && (
 <div>
 {isLR2Leader && (
 <div className="mb-3 bg-white rounded-lg border border-slate-300 shadow-xl p-2.5 flex flex-col gap-1 min-w-[100px]">
 <button
 type="button"
 onClick={(e) => {
 e.stopPropagation();
 setShowAssemblyModal(true);
 }}
 className="flex items-center gap-2 px-3 py-2.5 text-left text-[11px] font-black text-green-600 hover:bg-green-100 rounded-sm uppercase tracking-wider transition-all cursor-pointer"
 >
 <Plus size={10} />
 <span>Lắp ráp</span>
 </button>
 </div>
 )}
 <div className="mb-3 bg-white rounded-lg border border-slate-300 shadow-xl p-2.5 flex flex-col gap-1 min-w-[100px]">
 <button
 type="button"
 onClick={() => {
 setShowReportErrorModal(true);
 setIsQuickActionOpen(false);
 }}
 className="flex items-center gap-2 px-3 py-2.5 text-left text-[11px] font-black text-rose-600 hover:bg-rose-100 rounded-sm uppercase tracking-wider transition-all cursor-pointer"
 >
 <AlertOctagon
 size={14}
 className="text-rose-600"
 />
 Báo lỗi QC
 </button>
 </div>
 </div>
 )}
 <button
 type="button"
 onClick={() => setIsQuickActionOpen(!isQuickActionOpen)}
 className="w-18 h-18 bg-indigo-600 hover:bg-indigo-800 text-white rounded-full flex items-center justify-center shadow-lg hover:shadow-indigo-200 active:scale-95 transition-all cursor-pointer"
 title="Tác vụ nhanh"
 >
 {isQuickActionOpen ? (
 <X size={34} />
 ) : (
 <Plus size={34} />
 )}
 </button>
 </div>
 )}

 {/* Modal Báo lỗi QC */}
 <AnimatePresence>
 {showReportErrorModal && scannedEntry && (
 <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
 <motion.div
 initial={{ opacity: 0, scale: 0.95 }}
 animate={{ opacity: 1, scale: 1 }}
 exit={{ opacity: 0, scale: 0.95 }}
 className="bg-white w-full max-w-md rounded-lg shadow-2xl overflow-hidden border border-slate-200 flex flex-col max-h-[90vh]"
 >
 {/* Header */}
 <div className="bg-slate-100 px-6 py-4 border-b border-slate-100 flex items-center justify-between shrink-0">
 <div className="flex flex-col text-left">
 <span className="text-[9px] font-black uppercase tracking-[0.2em] text-rose-600 mb-0.5">
 BÁO LỖI QC CẤU KIỆN
 </span>
 <h3 className="text-base font-black text-slate-800 uppercase tracking-tight">
 {scannedEntry.moduleCode}
 </h3>
 </div>
 <button
 onClick={() =>
 setShowReportErrorModal(false)
 }
 className="p-1.5 text-slate-400 hover:text-rose-500 hover:bg-rose-100 rounded-sm transition-colors cursor-pointer"
 >
 <X size={18} />
 </button>
 </div>

 {/* Content */}
 <div className="p-6 overflow-y-auto space-y-5 text-left">
 {/* Chọn giai đoạn lỗi */}
 <div className="space-y-2">
 <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">
 Chọn giai đoạn phát hiện lỗi
 </label>
 <div className="grid grid-cols-2 gap-1.5 bg-slate-100 p-1 rounded-lg border border-slate-200">
 {[
 {
 id: "white",
 label: "Hàng Trắng",
 },
 { id: "paint", label: "Hàng Sơn" },
 {
 id: "finish",
 label: "Hoàn Thiện",
 },
 { id: "pack", label: "Đóng Gói" },
 ].map((stg) => (
 <button
 key={stg.id}
 type="button"
 onClick={() =>
 setErrorStage(stg.id as any)
 }
 className={`text-center py-6 rounded-lg text-[10px] font-black uppercase tracking-wider transition-all border cursor-pointer ${
 errorStage === stg.id
 ? "bg-primary text-white"
 : "bg-white text-slate-500 hover:bg-slate-100 border-slate-200"
 }`}
 >
 {stg.label}
 </button>
 ))}
 </div>
 </div>

 {/* Mô tả lỗi */}
 <div className="space-y-2">
 <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">
 Mô tả chi tiết lỗi ngoại quan / lỗi kỹ
 thuật
 </label>
 <textarea
 rows={3}
 value={errorDescription}
 onChange={(e) =>
 setErrorDescription(e.target.value)
 }
 placeholder="Nhập mô tả lỗi cụ thể tại đây..."
 className="w-full bg-slate-100 border border-slate-200 rounded-sm p-3.5 text-[11px] font-bold text-slate-800 focus:border-rose-500 outline-none transition-all placeholder:text-slate-400"
 />
 </div>

 {/* Đăng nhiều ảnh lỗi một lúc */}
 <div className="space-y-2">
 <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">
 Đăng ảnh bằng chứng ngoại quan (Cho phép
 đăng nhiều ảnh)
 </label>
 <div className="flex items-center gap-3">
 <label className="flex-1 border-2 border-dashed border-slate-200 hover:border-rose-500 p-4 rounded-sm flex flex-col items-center justify-center gap-1.5 cursor-pointer bg-slate-100/50 hover:bg-rose-100/10 transition-all">
 <input
 type="file"
 accept="image/*"
 multiple
 className="hidden"
 onChange={(e) => {
 if (
 e.target.files &&
 e.target.files.length >
 0
 ) {
 handleErrorPhotoUpload(
 e.target.files,
 );
 }
 }}
 />
 {errorUploading ? (
 <Loader2
 size={18}
 className="animate-spin text-rose-600"
 />
 ) : (
 <ImageIcon
 size={18}
 className="text-slate-400"
 />
 )}
 <span className="text-[9px] font-black uppercase text-slate-500 tracking-wider">
 {errorUploading
 ? "ĐANG TẢI LÊN..."
 : "CHỌN NHIỀU FILE ẢNH"}
 </span>
 </label>
 </div>

 {/* Grid hình ảnh đã đăng */}
 {errorPhotos.length > 0 && (
 <div className="grid grid-cols-4 gap-2 pt-2 border-t border-dashed border-slate-200">
 {errorPhotos.map((url, index) => (
 <div
 key={index}
 className="aspect-square rounded-sm border border-slate-300 overflow-hidden relative group bg-slate-100"
 >
 <img
 src={url}
 alt=""
 className="w-full h-full object-cover"
 referrerPolicy="no-referrer"
 />
 <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
 <button
 type="button"
 onClick={() =>
 removeErrorPhoto(
 index,
 )
 }
 className="bg-rose-600 text-white p-1 rounded-sm hover:scale-110 transition-transform cursor-pointer"
 >
 <X size={10} />
 </button>
 </div>
 </div>
 ))}
 </div>
 )}
 </div>
 </div>

 {/* Footer */}
 <div className="px-6 py-4 bg-slate-100 border-t border-slate-100 flex items-center justify-between shrink-0">
 <button
 onClick={() =>
 setShowReportErrorModal(false)
 }
 className="px-4 py-2.5 bg-white text-slate-500 border border-slate-200 rounded-sm text-[10px] font-black uppercase tracking-widest hover:bg-slate-100 transition-all cursor-pointer"
 >
 Hủy
 </button>
 <button
 onClick={handleSubmitQCError}
 disabled={modalLoading || errorUploading}
 className="px-5 py-2.5 bg-rose-600 text-white rounded-sm text-[10px] font-black uppercase tracking-widest hover:bg-rose-700 transition-all active:scale-95 flex items-center gap-1.5 shadow-md shadow-rose-100 disabled:opacity-100 cursor-pointer"
 >
 {modalLoading ? (
 <Loader2
 size={13}
 className="animate-spin"
 />
 ) : (
 <Save size={12} />
 )}
 BÁO CÁO LỖI
 </button>
 </div>
 </motion.div>
 </div>
 )}
 </AnimatePresence>

 {/* Dialog lightbox cho Hình ảnh QR Scanner */}
 <dialog
 id="scanner-photo-dialog"
 className="m-auto bg-transparent p-0 lightbox-dialog-content backdrop:bg-black/90 backdrop:backdrop-blur-md rounded-lg max-w-4xl w-full outline-none"
 onClick={(e) => {
 if (e.target === e.currentTarget) {
 (e.target as HTMLDialogElement).close();
 }
 }}
 >
 <div className="relative flex flex-col items-center justify-center p-4">
 <div className="absolute top-4 right-4 z-100 flex items-center gap-3">
 <span className="text-xs font-black uppercase tracking-wider font-mono text-gray-300">
 {lightboxStartIndex + 1} / {lightboxImages.length}
 </span>
 <button
 type="button"
 onClick={() => (document.getElementById('scanner-photo-dialog') as HTMLDialogElement)?.close()}
 className="p-2 hover:bg-white/10 rounded-full transition-all text-gray-300 hover:text-white cursor-pointer"
 >
 <X size={24} />
 </button>
 </div>

 <div className="relative flex items-center justify-center w-full max-h-[80vh] min-h-[300px]">
 {lightboxImages.length > 1 && (
 <button
 type="button"
 onClick={() => setLightboxStartIndex((prev) => (prev - 1 + lightboxImages.length) % lightboxImages.length)}
 className="absolute left-2 p-3 bg-black/50 hover:bg-black/70 text-white rounded-full transition-all border border-white/10 z-20 cursor-pointer"
 >
 <ChevronLeft size={28} />
 </button>
 )}
 {lightboxImages[lightboxStartIndex] && (
 <img
 key={lightboxStartIndex}
 src={lightboxImages[lightboxStartIndex]}
 className="max-w-full max-h-[80vh] object-contain rounded-lg shadow-2xl"
 />
 )}
 {lightboxImages.length > 1 && (
 <button
 type="button"
 onClick={() => setLightboxStartIndex((prev) => (prev + 1) % lightboxImages.length)}
 className="absolute right-2 p-3 bg-black/50 hover:bg-black/70 text-white rounded-full transition-all border border-white/10 z-20 cursor-pointer"
 >
 <ChevronRight size={28} />
 </button>
 )}
 </div>

 {lightboxImages.length > 1 && (
 <div className="flex gap-2.5 mt-5 overflow-x-auto max-w-full px-4 py-2 select-none">
 {lightboxImages.map((img, i) => (
 <img
 key={i}
 src={img}
 className={`w-9 h-9 object-cover rounded-md cursor-pointer border transition-all ${
 i === lightboxStartIndex
 ? 'border-indigo-500 scale-105 ring-2 ring-indigo-500/30'
 : 'border-white/10 opacity-60 hover:opacity-100'
 }`}
 onClick={() => setLightboxStartIndex(i)}
 />
 ))}
 </div>
 )}
 </div>
 </dialog>

 </div>
 );
}

function InfoCard({
 label,
 value,
 icon,
 color,
}: {
 label: string;
 value: string;
 icon: React.ReactNode;
 color: string;
}) {
 const colorMap: any = {
 blue: "text-indigo-600 bg-indigo-100 border-indigo-100 shadow-sm",
 green: "text-emerald-600 bg-emerald-100 border-emerald-100 shadow-sm",
 orange: "text-orange-600 bg-orange-100 border-orange-100 shadow-sm",
 };

 return (
 <div
 className={`p-5 rounded-lg border ${colorMap[color] || colorMap.blue} transition-all hover:scale-[1.02]`}
 >
 <div className="flex items-center gap-3 mb-2.5 opacity-80">
 <div className="p-2 bg-white rounded-lg shadow-sm">
 {icon}
 </div>
 <span className="text-[10px] font-black uppercase tracking-[0.2em] leading-none">
 {label}
 </span>
 </div>
 <div className="text-sm font-black uppercase tracking-tight truncate leading-tight">
 {value}
 </div>
 </div>
 );
}