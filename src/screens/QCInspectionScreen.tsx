/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Search, Plus, Trash2, Camera, CheckCircle, XCircle,
  ChevronRight, Save, Loader2, X, Image as ImageIcon, RotateCw,
  AlertCircle, MessageSquare, ClipboardCheck, ArrowLeft, History,
  PlusCircle, ScanQrCode, CheckSquare, Check, Boxes, ArchiveRestore, RefreshCw
} from 'lucide-react';
import {
  doc, updateDoc, serverTimestamp, addDoc, collection,
  query, where, onSnapshot, orderBy, limit, deleteDoc, deleteField, getDoc, setDoc
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType, cleanUndefinedFields } from '../lib/firebase';
import { updateProjectModule, findProjectConfigId } from '../lib/dualWrite';
import { useAuth } from '../lib/AuthContext';
import { ProjectEntry, getModuleInstances, ModuleInstance, matchSearchQuery, getModuleQcAggregate } from '../types';
import { formatProjectCode, formatProjectName } from '../lib/formatters';
import { ScannerModal, ScannedResult } from '../components/ScannerModal';
import { buildAndSortTree, getParentCodeCandidate } from './ProjectManagementScreen';
import { getEntryType, getQCCriteria, QCCriterion } from '../lib/qcCriteria';
import { uploadToCloudinary } from '../lib/cloudinary';
import { ImageLightboxModal } from '../components/ImageLightboxModal';
import { ModuleDetailModal } from '../components/project/ModuleDetailModal';
import { autoPassBuForPackage } from '../lib/qcPassBu';

interface QCInspectionScreenProps {
  projectEntries: ProjectEntry[];
  setProjectEntries?: (entries: ProjectEntry[] | ((prev: ProjectEntry[]) => ProjectEntry[])) => void;
  pendingQCAction?: { moduleId: string; stageId: string } | null;
  clearPendingQCAction?: () => void;
  setParentActiveTab?: (tab: any) => void;
}

const QC_STAGES = [
  { id: 'white', label: 'Hàng Trắng', field: 'qcWhite', requiredPrev: null },
  { id: 'paint', label: 'Hàng Sơn', field: 'qcPaint', requiredPrev: 'qcWhite' },
  { id: 'finish', label: 'Hoàn Thiện', field: 'qcFinish', requiredPrev: 'qcPaint' },
  { id: 'pack', label: 'Đóng Gói', field: 'qcPack', requiredPrev: 'qcFinish' },
] as const;

const getEntryTypeLocal = (moduleCode: string, entry?: any): 'Thùng' | 'Cánh' | 'Đợt' | 'Đợt di động' | 'Mặt HK' | 'CTHT' | 'Gia công ngoài' => {
  return getEntryType(entry || { moduleCode });
};

const makeShelfModuleCode = (parentCode: string): string => {
  if (!parentCode) return '';
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

interface QCCameraModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCapture: (file: File) => void;
}

export function QCCameraModal({ isOpen, onClose, onCapture }: QCCameraModalProps) {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('environment');

  useEffect(() => {
    if (isOpen) {
      startCamera();
    } else {
      stopCamera();
    }
    return () => {
      stopCamera();
    };
  }, [isOpen, facingMode]);

  const startCamera = async () => {
    setIsLoading(true);
    setError(null);
    if (stream) {
      stream.getTracks().forEach(track => track.stop());
    }

    try {
      const constraints: MediaStreamConstraints = {
        video: {
          facingMode: facingMode === 'environment' ? 'environment' : 'user',
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: false
      };

      const mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
      setStream(mediaStream);
      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream;
      }
    } catch (err) {
      console.warn("Lỗi khởi tạo Camera:", err);
      // Nếu cố mở camera sau không được (ví dụ không có hoặc bị chặn), thử camera trước
      if (facingMode === 'environment') {
        setFacingMode('user');
      } else {
        setError("Không thể truy cập camera của thiết bị. Hãy cấp quyền truy cập hoặc tải tệp ảnh từ thiết bị.");
      }
    } finally {
      setIsLoading(false);
    }
  };

  const stopCamera = () => {
    if (stream) {
      stream.getTracks().forEach(track => track.stop());
      setStream(null);
    }
  };

  const handleCapture = () => {
    if (!videoRef.current) return;
    const video = videoRef.current;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;

    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => {
        if (blob) {
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const file = new File([blob], `QC_Photo_${timestamp}.jpg`, { type: 'image/jpeg' });

          // 1. Tự động tải xuống máy theo nguyện vọng của người dùng
          const downloadUrl = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = downloadUrl;
          a.download = `QC_Photo_${timestamp}.jpg`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(downloadUrl);

          // 2. Trả file về để upload
          onCapture(file);
          onClose();
        }
      }, 'image/jpeg', 0.85);
    }
  };

  const toggleFacingMode = () => {
    setFacingMode(prev => prev === 'environment' ? 'user' : 'environment');
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/90 backdrop-blur-md z-[9999] flex flex-col items-center justify-between p-4 font-sans text-white">
      {/* Header */}
      <div className="w-full flex items-center justify-between p-2 max-w-lg">
        <h3 className="text-sm font-black uppercase tracking-wider text-indigo-400">Chụp Ảnh Kiểm QC</h3>
        <button onClick={onClose} className="p-2 bg-slate-900 rounded-sm text-slate-300 hover:text-white transition-colors">
          <X size={18} />
        </button>
      </div>

      {/* Screen Area */}
      <div className="relative w-full max-w-lg aspect-video md:aspect-[4/3] bg-slate-900 rounded-sm overflow-hidden flex items-center justify-center border border-slate-900 shadow-2xl">
        {isLoading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-slate-955/80">
            <Loader2 className="animate-spin text-white" size={32} />
            <p className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">Đang kết nối camera...</p>
          </div>
        )}

        {error ? (
          <div className="p-6 text-center max-w-sm flex flex-col items-center gap-3">
            <AlertCircle className="text-amber-500" size={36} />
            <p className="text-xs text-slate-300 font-medium leading-relaxed">{error}</p>
            <label className="mt-2 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-800 text-white rounded-lg text-xs font-black uppercase tracking-widest cursor-pointer shadow-lg active:scale-95 transition-all text-center">
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    onCapture(file);
                    onClose();
                  }
                }}
              />
              Chọn ảnh từ máy
            </label>
          </div>
        ) : (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="w-full h-full object-cover"
          />
        )}
      </div>

      {/* Bottom Controls */}
      <div className="w-full max-w-lg p-4 flex flex-col gap-4 items-center">
        {!error && !isLoading && (
          <div className="flex items-center justify-between w-full px-6">
            <button
              onClick={toggleFacingMode}
              className="p-3 bg-slate-800 rounded-full hover:bg-slate-700 text-slate-200 transition-transform active:scale-90"
              title="Đổi camera trước/sau"
            >
              <RotateCw size={20} />
            </button>

            <button
              onClick={handleCapture}
              className="w-16 h-16 rounded-full border-4 border-white bg-red-600 flex items-center justify-center transition-all active:scale-90 shadow-xl shadow-red-900/40 relative group"
            >
              <span className="absolute inset-1.5 rounded-full border-2 border-white/50 group-active:scale-90 transition-transform" />
            </button>

            <label className="p-3 bg-slate-800 rounded-full hover:bg-slate-700 text-slate-200 cursor-pointer transition-transform active:scale-90" title="Chọn từ thư viện">
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    onCapture(file);
                    onClose();
                  }
                }}
              />
              <ImageIcon size={20} />
            </label>
          </div>
        )}

        <p className="text-[10px] text-center text-slate-400 max-w-xs leading-relaxed italic">
          Bấm nút chụp đỏ để Chụp ảnh. Ảnh sẽ tự động tải xuống thiết bị & tự động tải lên Cloudinary/Firestore.
        </p>
      </div>
    </div>
  );
}

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

export function QCInspectionScreen({
  projectEntries,
  setProjectEntries,
  pendingQCAction,
  clearPendingQCAction,
  setParentActiveTab
}: QCInspectionScreenProps) {
  const { user, userProfile, role, roles, hasRole } = useAuth();
  const [activeInspectionStage, setActiveInspectionStage] = useState<'white' | 'paint' | 'finish' | 'pack' | null>(null);
  const [selectedProjectCode, setSelectedProjectCode] = useState<string>('');
  const [selectedCreationStage, setSelectedCreationStage] = useState<'paint' | 'finish' | null>(null);
  const [inspectedModules, setInspectedModules] = useState<ProjectEntry[]>([]);
  const [allDbModules, setAllDbModules] = useState<ProjectEntry[]>([]);
  const [showScanner, setShowScanner] = useState(false);
  const [scannerMode, setScannerMode] = useState<'add' | 'verify' | 'select' | 'inspect' | 'add_to_ticket' | null>(null);
  const [activeModuleId, setActiveModuleId] = useState<string | null>(null);
  const [openedFromScanner, setOpenedFromScanner] = useState(false);
  const [cameraActiveCriId, setCameraActiveCriId] = useState<string | null>(null);

  // States for Lightbox image viewing
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxImages, setLightboxImages] = useState<string[]>([]);
  const [lightboxStartIndex, setLightboxStartIndex] = useState(0);

  const [scannedQRResult, setScannedQRResult] = useState<ScannedResult | null>(null);

  const parseExtendCode = (rawCode: string | undefined | null) => {
    if (!rawCode) return null;
    const suffixRegex = /-(\d+)\/(\d+)$/;
    const match = suffixRegex.exec(rawCode.trim());
    if (match) {
      return {
        index: Number(match[1]),
        total: Number(match[2]),
        extCode: rawCode.trim()
      };
    }
    return null;
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

    let entry =
      projectEntries.find(
        (e) => (e.moduleCode || "").toLowerCase() === rawText.toLowerCase(),
      ) || null;

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

    return entry;
  };

  // Helper: resolve module từ projectEntries theo id hoặc moduleCode (fallback cho QC tickets cũ)
  const resolveModule = (m: { id?: string; moduleCode?: string; projectCode?: string }): ProjectEntry | undefined => {
    if (m.id) {
      const byId = projectEntries.find(e => e.id === m.id);
      if (byId) return byId;
    }
    if (m.moduleCode) {
      return projectEntries.find(e => e.moduleCode === m.moduleCode && (!m.projectCode || e.projectCode === m.projectCode));
    }
    return undefined;
  };

  // Helper: Lấy danh sách projectCode duy nhất từ modules trong phiếu
  const getTicketProjectCodes = (ticket: any): string[] => {
    const codes = new Set<string>();
    if (ticket.projectCode) codes.add(ticket.projectCode);
    (ticket.modules || []).forEach((m: any) => {
      if (m.projectCode) codes.add(m.projectCode);
    });
    return Array.from(codes);
  };

  const closeInspectionModal = () => {
    setActiveModuleId(null);
    setIsInspectionModalOpen(false);
    setIsInspectionReadOnly(false);
    setScannedQRResult(null);
    setQcInspectedQty('');
    if (openedFromScanner) {
      if (setParentActiveTab) {
        setParentActiveTab('scanner');
      }
      setOpenedFromScanner(false);
    }
  };

  // Memo hóa danh sách module lỗi QC (QC Fail) — đọc từ instances
  const failedModules = React.useMemo(() => {
    return projectEntries.filter(entry =>
      getModuleQcAggregate(entry, 'white')?.status === 'fail' ||
      getModuleQcAggregate(entry, 'paint')?.status === 'fail' ||
      getModuleQcAggregate(entry, 'finish')?.status === 'fail' ||
      getModuleQcAggregate(entry, 'pack')?.status === 'fail'
    );
  }, [projectEntries]);

  // Hàm mở nhanh xem chi tiết module lỗi
  const handleInspectFailedModule = (module: ProjectEntry, readOnly: boolean = false, targetFailedInstId?: string) => {
    let failStage: 'white' | 'paint' | 'finish' | 'pack' = 'white';
    if (getModuleQcAggregate(module, 'pack')?.status === 'fail') failStage = 'pack';
    else if (getModuleQcAggregate(module, 'finish')?.status === 'fail') failStage = 'finish';
    else if (getModuleQcAggregate(module, 'paint')?.status === 'fail') failStage = 'paint';
    else if (getModuleQcAggregate(module, 'white')?.status === 'fail') failStage = 'white';

    // Hiển thị chi tiết module thay vì mở modal kiểm định
    setViewingModuleQcStage(failStage);
    const failedInst = targetFailedInstId
      ? getModuleInstances(module).find(inst => inst.id === targetFailedInstId)
      : null;
    setViewingModuleInstanceIndex(failedInst?.instanceIndex);
    setViewingModule(module);
  };
  const [manualCode, setManualCode] = useState('');
  const [showManualAddModal, setShowManualAddModal] = useState(false);
  const [manualAddClusterFilter, setManualAddClusterFilter] = useState('');
  const [classificationFilter, setClassificationFilter] = useState<'all' | 'thung' | 'canh' | 'mat_hk' | 'ctht' | 'fail'>('all');
  const [searchModuleSuggestion, setSearchModuleSuggestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [scanError, setScanError] = useState<{
    raw?: string;
    fix1?: string;
    fix2?: string;
    message: string;
  } | string | null>(null);
  const [previewModule, setPreviewModule] = useState<ProjectEntry | null>(null);
  const [stagedModules, setStagedModules] = useState<{ module: ProjectEntry; instanceIndex: number }[]>([]);
  const [showPaintClusterPicker, setShowPaintClusterPicker] = useState(false);
  const [confirmingModule, setConfirmingModule] = useState<ProjectEntry | null>(null);
  const [deleteConfirmEntry, setDeleteConfirmEntry] = useState<ProjectEntry | null>(null);
  const [qcTickets, setQcTickets] = useState<any[]>([]);
  const [ticketStageFilter, setTicketStageFilter] = useState<'all' | 'white' | 'paint' | 'finish' | 'pack'>('all');
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);
  const [ticketToDelete, setTicketToDelete] = useState<any | null>(null);
  const [ticketToClose, setTicketToClose] = useState<any | null>(null);
  const [closeMode, setCloseMode] = useState<'revert' | 'passAll' | null>(null);
  const [viewingModule, setViewingModule] = useState<ProjectEntry | null>(null);
  const [viewingModuleQcStage, setViewingModuleQcStage] = useState<string | undefined>(undefined);
  const [viewingModuleInstanceIndex, setViewingModuleInstanceIndex] = useState<number | undefined>(undefined);
  const [showAddModuleModal, setShowAddModuleModal] = useState(false);
  const [addingModuleSearchText, setAddingModuleSearchText] = useState('');
  const [moduleToRemove, setModuleToRemove] = useState<any | null>(null);
  const [mergeNotice, setMergeNotice] = useState<{
    projectName: string;
    ticketName: string;
    moduleCodes: string[];
  } | null>(null);

  // Inspection State for active module
  const [qcStatus, setQcStatus] = useState<'pass' | 'fail' | 'pending' | 'none'>('none');
  const [qcNotes, setQcNotes] = useState('');
  const [qcPhotos, setQcPhotos] = useState<string[]>([]);
  const [qcInspectedQty, setQcInspectedQty] = useState('');
  const [uploading, setUploading] = useState(false);
  const [qcGeneralUploading, setQcGeneralUploading] = useState(false);
  const [checkedCriteria, setCheckedCriteria] = useState<Record<string, boolean>>({});
  const [criterionPhotos, setCriterionPhotos] = useState<Record<string, string[]>>({});
  const [criterionUploading, setCriterionUploading] = useState<Record<string, boolean>>({});
  const [selectedInstanceIds, setSelectedInstanceIds] = useState<string[]>([]);
  const instanceSyncOverrideRef = React.useRef(false);

  // Đồng bộ danh sách instances được chọn khi đổi module
  useEffect(() => {
    // Bỏ qua nếu resetInspectionState đã set override
    if (instanceSyncOverrideRef.current) {
      instanceSyncOverrideRef.current = false;
      return;
    }
    const targetModule = allDbModules.find(m => m.id === activeModuleId) || inspectedModules.find(m => m.id === activeModuleId);
    if (activeModuleId && targetModule) {
      const instances = getModuleInstances(targetModule);
      if (scannedQRResult && scannedQRResult.matchedId === activeModuleId && scannedQRResult.instanceId) {
        const found = instances.find(inst => inst.id === scannedQRResult.instanceId || inst.instanceId === scannedQRResult.instanceId);
        if (found) {
          setSelectedInstanceIds([found.id]);
          return;
        }
      }
      setSelectedInstanceIds(instances.map(inst => inst.id));
    } else {
      setSelectedInstanceIds([]);
    }
  }, [activeModuleId, allDbModules, inspectedModules, scannedQRResult]);

  useEffect(() => {
    const targetModule = allDbModules.find(m => m.id === activeModuleId) || inspectedModules.find(m => m.id === activeModuleId);
    if (activeModuleId && targetModule && activeInspectionStage) {
      const moduleType = getEntryType(targetModule);
      const ctList = getQCCriteria(moduleType, activeInspectionStage);
      const initialChecked: Record<string, boolean> = {};
      const initialPhotos: Record<string, string[]> = {};

      const stageField = QC_STAGES.find(s => s.id === activeInspectionStage)?.field;
      const instances = getModuleInstances(targetModule);
      const singleSelectedId = selectedInstanceIds.length === 1 ? selectedInstanceIds[0] : null;
      const selectedInstance = singleSelectedId ? instances.find(inst => inst.id === singleSelectedId) : null;

      const activeStageData = selectedInstance && stageField
        ? (selectedInstance as any)[stageField]
        : (activeInspectionStage ? getModuleQcAggregate(targetModule, activeInspectionStage) : null);

      const activeStatus = activeStageData?.status || 'none';
      const savedChecked = activeStageData?.checkedCriteria || {};
      const savedPhotos = activeStageData?.criterionPhotos || {};

      ctList.forEach(cri => {
        if (savedChecked && typeof savedChecked[cri.id] === 'boolean') {
          initialChecked[cri.id] = savedChecked[cri.id];
        } else {
          initialChecked[cri.id] = (activeStatus === 'pass');
        }
        initialPhotos[cri.id] = savedPhotos?.[cri.id] || [];
      });
      setCheckedCriteria(initialChecked);
      setCriterionPhotos(initialPhotos);
      setQcNotes(activeStageData?.notes || '');
      setQcPhotos(activeStageData?.photos || []);
      setQcStatus(activeStatus === 'pending' ? 'none' : (activeStatus || 'none'));
    } else {
      setCheckedCriteria({});
      setCriterionPhotos({});
    }
  }, [activeModuleId, activeInspectionStage, allDbModules, inspectedModules, selectedInstanceIds]);

  // Tự động đồng bộ qcStatus: đủ thì Pass, thiếu tự động Fail
  useEffect(() => {
    if (activeModuleId && activeInspectionStage) {
      const targetModule = allDbModules.find(m => m.id === activeModuleId) || inspectedModules.find(m => m.id === activeModuleId);
      if (targetModule) {
        const moduleType = getEntryType(targetModule);
        const criteriaList = getQCCriteria(moduleType, activeInspectionStage);
        if (criteriaList.length > 0) {
          const allChecked = criteriaList.every(cri => !!checkedCriteria[cri.id]);
          setQcStatus(allChecked ? 'pass' : 'fail');
        } else {
          setQcStatus('pass');
        }
      }
    }
  }, [checkedCriteria, activeModuleId, activeInspectionStage, allDbModules, inspectedModules]);

  const handleCriterionPhotoUpload = async (criId: string, filesInput: File | File[] | FileList) => {
    try {
      setCriterionUploading(prev => ({ ...prev, [criId]: true }));

      const files: File[] = [];
      if (filesInput instanceof File) {
        files.push(filesInput);
      } else if (filesInput) {
        for (let i = 0; i < filesInput.length; i++) {
          files.push(filesInput[i]);
        }
      }

      if (files.length === 0) return;

      // Tạo tên ảnh QC: projectCode_moduleCode_stage_criteria_idx
      const targetModule = allDbModules.find(m => m.id === activeModuleId) || inspectedModules.find(m => m.id === activeModuleId);
      const projCode = (targetModule?.projectCode || 'unknown').replace(/[^a-zA-Z0-9]/g, '_');
      const modCode = (targetModule?.moduleCode || 'module').replace(/[^a-zA-Z0-9]/g, '_');
      const stageName = activeInspectionStage || 'unknown';

      const urls: string[] = [];
      const errors: string[] = [];
      for (let i = 0; i < files.length; i++) {
        try {
          const suffix = files.length > 1 ? `_${i + 1}` : '';
          const url = await uploadToCloudinary(files[i], 'QC', `${projCode}_${modCode}_${stageName}_${criId}${suffix}`);
          urls.push(url);
        } catch (uploadErr) {
          console.error("Lỗi upload một file: ", files[i].name, uploadErr);
          errors.push(uploadErr instanceof Error ? uploadErr.message : String(uploadErr));
        }
      }

      if (urls.length > 0) {
        setCriterionPhotos(prev => {
          const current = prev[criId] || [];
          return {
            ...prev,
            [criId]: [...current, ...urls]
          };
        });
      } else {
        alert("Không thể tải lên ảnh nào. Chi tiết: " + errors.join("; "));
      }
    } catch (err) {
      alert("Lỗi xử lý ảnh QC: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setCriterionUploading(prev => ({ ...prev, [criId]: false }));
    }
  };

  const removeCriterionPhoto = (criId: string, idx: number) => {
    setCriterionPhotos(prev => {
      const current = prev[criId] || [];
      return {
        ...prev,
        [criId]: current.filter((_, i) => i !== idx)
      };
    });
  };

  const handleQcGeneralPhotoUpload = async (filesInput: File | File[] | FileList) => {
    try {
      setQcGeneralUploading(true);
      const files: File[] = [];
      if (filesInput instanceof File) {
        files.push(filesInput);
      } else if (filesInput) {
        for (let i = 0; i < filesInput.length; i++) {
          files.push(filesInput[i]);
        }
      }

      if (files.length === 0) return;

      const targetModule = allDbModules.find(m => m.id === activeModuleId) || inspectedModules.find(m => m.id === activeModuleId);
      const projCode = (targetModule?.projectCode || 'unknown').replace(/[^a-zA-Z0-9]/g, '_');
      const modCode = (targetModule?.moduleCode || 'module').replace(/[^a-zA-Z0-9]/g, '_');
      const stageName = activeInspectionStage || 'unknown';

      const urls: string[] = [];
      const errors: string[] = [];
      for (let i = 0; i < files.length; i++) {
        try {
          const suffix = files.length > 1 ? `_${i + 1}` : '';
          const url = await uploadToCloudinary(files[i], 'QC', `${projCode}_${modCode}_${stageName}_chung${suffix}`);
          urls.push(url);
        } catch (uploadErr) {
          console.error("Lỗi upload tệp ảnh đối chiếu chung: ", files[i].name, uploadErr);
          errors.push(uploadErr instanceof Error ? uploadErr.message : String(uploadErr));
        }
      }

      if (urls.length > 0) {
        setQcPhotos(prev => [...prev, ...urls]);
      } else {
        alert("Không thể tải lên ảnh nào. Chi tiết: " + errors.join("; "));
      }
    } catch (err) {
      alert("Lỗi xử lý ảnh QC đối chiếu: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setQcGeneralUploading(false);
    }
  };

  const removeQcGeneralPhoto = (idx: number) => {
    setQcPhotos(prev => prev.filter((_, i) => i !== idx));
  };

  const isModOrAdmin = hasRole('admin') || hasRole('mod_x1') || hasRole('mod_x2');
  const isQC = hasRole('admin') || hasRole('qc') || hasRole('mod_qc');

  // Real-time counts for each stage
  const [stageCounts, setStageCounts] = useState<{ [key: string]: number }>({
    white: 0,
    paint: 0,
    finish: 0,
    pack: 0
  });

  // Logic to determine which stage the current user can add to and the descriptive title
  const getCreationConfig = () => {
    if (hasRole('mod_qc')) {
      return null;
    }
    if (hasRole('admin')) {
      const title = (userProfile?.chuc_danh || '').toLowerCase();
      if (title.includes('sơn leader') || title.includes('son leader')) return { stageId: 'paint', label: 'Admin - Hàng sơn' };
      if (title.includes('lr2 leader')) return { stageId: 'finish', label: 'Admin - Hàng sơn / Hoàn thiện', multiStage: true as const };
      if (title.includes('đg leader') || title.includes('dg leader')) return { stageId: 'pack', label: 'Admin - Hàng đóng gói' };
      return { stageId: 'white', label: 'Admin - Hàng trắng' };
    }
    if (hasRole('mod_x1')) {
      return { stageId: 'white', label: 'Xưởng 1 - Hàng trắng' };
    }
    const title = (userProfile?.chuc_danh || '').toLowerCase();
    if (title.includes('sơn leader') || title.includes('son leader')) return { stageId: 'paint', label: 'Xưởng 2 - Hàng sơn' };
    if (title.includes('lr2 leader')) return { stageId: 'finish', label: 'Xưởng 2 - Hàng sơn / Hoàn thiện', multiStage: true as const };
    if (title.includes('đg leader') || title.includes('dg leader')) return { stageId: 'pack', label: 'Xưởng 2 - Hàng đóng gói' };

    return null;
  };

  const getCanAddStage = () => {
    const config = getCreationConfig();
    if (!config) return null;
    if (config.multiStage && selectedCreationStage) return selectedCreationStage;
    return config.stageId;
  };

  // Đồng bộ projectEntries ở App.tsx sau khi update module
  const syncProjectEntry = (moduleId: string, updateData: any) => {
    setProjectEntries?.(prev =>
      prev.map(e => e.id === moduleId ? { ...e, ...updateData } as ProjectEntry : e)
    );
  };

  // Mirror allDbModules từ projectEntries (nguồn chính từ projectConfigs)
  useEffect(() => {
    setAllDbModules(projectEntries);

    const pending = projectEntries.filter(m => {
      const w = getModuleQcAggregate(m, 'white');
      const p = getModuleQcAggregate(m, 'paint');
      const f = getModuleQcAggregate(m, 'finish');
      const pk = getModuleQcAggregate(m, 'pack');
      return w?.status === 'pending' || p?.status === 'pending' || f?.status === 'pending' || pk?.status === 'pending';
    });
    setInspectedModules(pending);

    const counts = { white: 0, paint: 0, finish: 0, pack: 0 };
    projectEntries.forEach(m => {
      if (getModuleQcAggregate(m, 'white')?.status === 'pending') counts.white++;
      if (getModuleQcAggregate(m, 'paint')?.status === 'pending') counts.paint++;
      if (getModuleQcAggregate(m, 'finish')?.status === 'pending') counts.finish++;
      if (getModuleQcAggregate(m, 'pack')?.status === 'pending') counts.pack++;
    });
    setStageCounts(counts);
  }, [projectEntries]);

  // Listen to external pendingQCAction triggers (e.g. from Menu QR QuickScanner screen)
  useEffect(() => {
    if (pendingQCAction && projectEntries) {
      setOpenedFromScanner(true);
      const timer = setTimeout(() => {
        const projEntry = projectEntries.find(e => e.id === pendingQCAction.moduleId) || inspectedModules.find(e => e.id === pendingQCAction.moduleId) || allDbModules.find(e => e.id === pendingQCAction.moduleId);
        if (projEntry) {
          const stageId = pendingQCAction.stageId as 'white' | 'paint' | 'finish' | 'pack';
          // Hiển thị chi tiết module thay vì mở modal kiểm định
          setViewingModuleQcStage(stageId);
          setViewingModuleInstanceIndex(undefined);
          setViewingModule(projEntry);
        }
        if (clearPendingQCAction) {
          clearPendingQCAction();
        }
      }, 250);

      return () => clearTimeout(timer);
    }
  }, [pendingQCAction, projectEntries, qcTickets, inspectedModules, allDbModules, clearPendingQCAction]);

  // Tự động kiểm tra và sửa lỗi nếu tài liệu người dùng bị thiếu roles hoặc role
  useEffect(() => {
    if (!user) return;
    const healUserProfile = async () => {
      try {
        const userRef = doc(db, 'users', user.uid);
        const userDoc = await getDoc(userRef);
        const data = userDoc.data();
        const needsSync = !userDoc.exists() || 
                          !data?.role || 
                          !Array.isArray(data?.roles) || 
                          data?.roles.length === 0;
        if (needsSync) {
          console.log("[Self-Heal] Đồng bộ lại thông tin tài khoản người dùng trên Firestore...");
          const existingRole = data?.role;
          const existingRoles = data?.roles;
          const resolvedRoles = Array.isArray(existingRoles) && existingRoles.length > 0
            ? existingRoles
            : existingRole
              ? [existingRole]
              : [user.email === 'nguyenkimqza@gmail.com' ? 'admin' : 'pending'];
          
          await setDoc(userRef, {
            uid: user.uid,
            displayName: user.displayName || 'User',
            email: user.email,
            photoURL: user.photoURL,
            ten_that: data?.ten_that || '',
            chuc_danh: data?.chuc_danh || 'Nhân viên',
            role: existingRole || resolvedRoles[0],
            roles: resolvedRoles,
            createdAt: data?.createdAt || serverTimestamp()
          }, { merge: true });
        }
      } catch (err) {
        console.warn("[Self-Heal] Lỗi đồng bộ thông tin tài khoản:", err);
      }
    };
    healUserProfile();
  }, [user]);

  // Fetch all QC Tickets in real-time (limited to 100 latest)
  useEffect(() => {
    const q = query(collection(db, 'qc_tickets'), limit(100));
    const unsub = onSnapshot(q, (snapshot) => {
      const tickets = snapshot.docs.map(doc => {
        const data = doc.data();
        let createdAtDate = new Date();
        if (data.createdAt) {
          if (data.createdAt.toDate) createdAtDate = data.createdAt.toDate();
          else if (data.createdAt.seconds) createdAtDate = new Date(data.createdAt.seconds * 1000);
          else createdAtDate = new Date(data.createdAt);
        }
        return {
          id: doc.id,
          ...data,
          _createdAtDate: createdAtDate
        };
      });
      // Sắp xếp giảm dần theo ngày tạo
      tickets.sort((a: any, b: any) => b._createdAtDate.getTime() - a._createdAtDate.getTime());
      setQcTickets(tickets);
    }, (error) => {
      console.warn("Lỗi tải danh sách phiếu chờ kiểm:", error);
    });
    return () => unsub();
  }, []);

  // Tự động hoàn tất các phiếu QC chờ kiểm khi hết ngày (tự động dọn dẹp)
  useEffect(() => {
    if (!qcTickets || qcTickets.length === 0 || !user || loading) return;

    // Chỉ cho phép admin hoặc QC chạy dọn dẹp tự động để tránh xung đột ghi đè dữ liệu nhiều người
    const isQcUser = hasRole('admin') || hasRole('qc') || hasRole('mod_qc');
    if (!isQcUser) return;

    const autoCleanupTickets = async () => {
      const now = new Date();

      const ticketsToAutoComplete = qcTickets.filter((ticket: any) => {
        if (ticket.status !== 'pending') return false;

        const createdDate = ticket._createdAtDate;
        if (!createdDate) return false;

        const todayReset = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const createdReset = new Date(createdDate.getFullYear(), createdDate.getMonth(), createdDate.getDate());

        if (createdReset < todayReset) {
          return true;
        }

        return false;
      });

      if (ticketsToAutoComplete.length === 0) return;

      for (const ticket of ticketsToAutoComplete) {
        console.log(`[Hệ thống tự động] Đang tự động hoàn tất phiếu QC cũ: ${ticket.name} (Tạo lúc ${ticket._createdAtDate.toLocaleString()})`);

        const stage = QC_STAGES.find(s => s.id === ticket.stage);
        if (!stage) continue;

        const stageField = stage.field;

        // Resolve trạng thái QC thực tế từ instance data thay vì dùng raw status từ phiếu
        const resolvedTicketModules = (ticket.modules || []).map((m: any) => {
          const actualModuleId = m.moduleId || m.id;
          const projectModule = projectEntries.find(e => e.id === getBaseModuleId(actualModuleId));
          if (!projectModule) return { ...m, _resolvedStatus: 'pending' };

          if (m.instanceIndex != null) {
            const instances = getModuleInstances(projectModule);
            const targetInst = instances.find((inst: any) => inst.instanceIndex === m.instanceIndex);
            if (targetInst) {
              const instQcData = (targetInst as any)[stageField];
              return { ...m, _resolvedStatus: instQcData?.status || 'pending' };
            }
          }

          const agg = getModuleQcAggregate(projectModule, stage.id as any);
          return { ...m, _resolvedStatus: agg?.status || 'pending' };
        });

        const checkedModules = resolvedTicketModules
          .filter((m: any) => m._resolvedStatus === 'pass' || m._resolvedStatus === 'fail')
          .map(({ _resolvedStatus, ...rest }: any) => rest);
        const uninspectedModules = resolvedTicketModules.filter((m: any) => m._resolvedStatus !== 'pass' && m._resolvedStatus !== 'fail');

        // Đổi trạng thái cấu kiện chưa QC sang pending (giữ nguyên data, không xoá)
        const statusUpdates = uninspectedModules.map(async (m: any) => {
          const actualModuleId = m.moduleId || m.id;
          const existingModule = projectEntries.find(e => e.id === getBaseModuleId(actualModuleId));
          if (!existingModule) return;

          const updateData: any = {};

          // Đổi status thành 'none' (rỗng) — giữ nguyên data, chỉ xoá trạng thái
          if (existingModule.instances && existingModule.instances.length > 0) {
            updateData.instances = existingModule.instances.map((inst: any) => {
              const newInst = { ...inst };
              const stageData = newInst[stageField];
              if (stageData) {
                newInst[stageField] = { ...stageData, status: 'none' };
              }
              return newInst;
            });
          }

          await updateProjectModule(getBaseModuleId(actualModuleId), updateData, existingModule?.projectCode);
          syncProjectEntry(getBaseModuleId(actualModuleId), updateData);
        });

        await Promise.all(statusUpdates);

        await updateDoc(doc(db, 'qc_tickets', ticket.id), cleanUndefinedFields({
          modules: checkedModules,
          status: 'completed'
        }));

        await addDoc(collection(db, 'activities'), {
          userId: 'system',
          userName: 'Hệ thống tự động',
          userEmail: 'system@automation.com',
          action: 'Hệ thống tự động hoàn tất phiếu QC',
          details: `Hệ thống tự động hoàn tất phiếu QC ${ticket.name} (Hết ngày) — Đã chuyển ${uninspectedModules.length} cấu kiện chưa QC sang trạng thái pending và lưu ${checkedModules.length} cấu kiện đã QC`,
          projectCode: ticket.projectCode,
          timestamp: serverTimestamp()
        });
      }
    };

    autoCleanupTickets();
  }, [qcTickets, user, projectEntries, loading]);

  const projects = Array.from(new Set(projectEntries.map(e => e.projectCode))).map(code => {
    const entry = projectEntries.find(e => e.projectCode === code);
    return {
      code,
      name: formatProjectName(entry?.projectName) || 'Không tên'
    };
  });

  const activeModule = inspectedModules.find(m => m.id === getBaseModuleId(activeModuleId))
    || allDbModules.find(m => m.id === getBaseModuleId(activeModuleId))
    || projectEntries.find(m => m.id === getBaseModuleId(activeModuleId));

  const filteredTicketGroups = useMemo(() => {
    let list = qcTickets;
    if (ticketStageFilter !== 'all') {
      list = list.filter(t => t.stage === ticketStageFilter);
    }

    const pending: any[] = [];
    const completed: any[] = [];

    list.forEach(ticket => {
      const stage = QC_STAGES.find(s => s.id === ticket.stage);

      // Lọc sạch cấu kiện bị trùng lặp ID trong phiếu
      const uniqueModulesInTicket: any[] = [];
      const seenIds = new Set<string>();

      (ticket.modules || []).forEach((m: any) => {
        if (m && m.id && !seenIds.has(m.id)) {
          seenIds.add(m.id);
          uniqueModulesInTicket.push(m);
        }
      });

      // Đối chiếu trạng thái thực tế thời gian thực từ instances trong projectEntries
      const resolvedModules = uniqueModulesInTicket.map((m: any) => {
        let projectModule = resolveModule(m);
        if (!projectModule) return null; // Loại bỏ cấu kiện nếu nó không tồn tại trong dự án

        let currentRealStatus = 'pending';
        let instNotes = '';
        let instPhotos: string[] = [];

        if (m.instanceIndex != null && stage) {
          // Instance-specific: check trực tiếp instance đang xét
          const instances = getModuleInstances(projectModule);
          const targetInst = instances.find((inst: any) => inst.instanceIndex === m.instanceIndex);
          if (targetInst) {
            const stageField = QC_STAGES.find(s => s.id === stage.id)?.field;
            const instQcData = stageField ? (targetInst as any)[stageField] : null;
            currentRealStatus = instQcData?.status || 'pending';
            instNotes = instQcData?.notes || '';
            instPhotos = instQcData?.photos || [];
          }
        } else {
          // Fallback: dùng aggregate cho module-level entries (phiếu cũ)
          const agg = stage ? getModuleQcAggregate(projectModule, stage.id as any) : null;
          currentRealStatus = agg?.status || 'pending';
          instNotes = agg?.notes || '';
          instPhotos = agg?.photos || [];
        }

        return {
          ...m,
          status: currentRealStatus,
          quantity: projectModule.quantity || m.quantity || 1,
          cluster: projectModule.cluster || m.cluster || 'N/A',
          moduleCode: projectModule.moduleCode || m.moduleCode,
          passedQty: currentRealStatus === 'pass' ? 1 : (m.passedQty || 0),
          qcNotes: instNotes || m.qcNotes || '',
          qcPhotos: instPhotos || m.qcPhotos || []
        };
      }).filter(Boolean); // Chỉ giữ lại các cấu kiện có trong dự án

      // Phiếu rỗng (chưa thêm cấu kiện nào) vẫn hiển thị trong danh sách chờ

      const totalModules = resolvedModules.length;
      const passModules = resolvedModules.filter((m: any) => m.status === 'pass').length;
      const failModules = resolvedModules.filter((m: any) => m.status === 'fail').length;
      const inspectedCount = passModules + failModules;

      // Kiểm tra xem còn cấu kiện nào chưa pass không ( trạng thái 'pending' hoặc chưa có )
      const hasPendingModules = resolvedModules.some((m: any) => m.status === 'pending' || m.status === 'none');
      const isTicketCompleted = ticket.status === 'completed' || (totalModules > 0 && !hasPendingModules && inspectedCount === totalModules);

      const ticketWithMeta = {
        ...ticket,
        modules: resolvedModules,
        _totalModules: totalModules,
        _passModules: passModules,
        _failModules: failModules,
        _inspectedCount: inspectedCount,
        _percent: totalModules > 0 ? Math.round((inspectedCount / totalModules) * 100) : 0,
        _isCompleted: isTicketCompleted
      };

      if (isTicketCompleted) {
        completed.push(ticketWithMeta);
      } else {
        pending.push(ticketWithMeta);
      }
    });

    return { pending, completed };
  }, [qcTickets, ticketStageFilter, projectEntries]);

  const selectableModules = useMemo(() => {
    // Xác định project code: ưu tiên từ phiếu đang mở, fallback về selectedProjectCode
    let projectCode = selectedProjectCode;
    let canAddStageId: string | null = getCanAddStage();

    if (selectedTicketId) {
      const ticket = [...filteredTicketGroups.pending, ...filteredTicketGroups.completed].find(t => t.id === selectedTicketId);
      if (ticket) {
        canAddStageId = ticket.stage || canAddStageId;
        // Lấy project code từ phiếu
        const ticketProjectCodes = getTicketProjectCodes(ticket);
        if (ticketProjectCodes.length > 0) {
          projectCode = ticketProjectCodes[0];
        }
      }
    }

    if (!projectCode) return [];
    if (!canAddStageId) return [];

    const stage = QC_STAGES.find(s => s.id === canAddStageId);
    if (!stage) return [];

    // Lấy danh sách gốc của dự án này từ projectEntries và sắp xếp theo sortIndex như ở trang dự án
    const rawEntriesOfProject = [...projectEntries]
      .filter(e => e.projectCode === projectCode)
      .sort((a, b) => (a.sortIndex || 0) - (b.sortIndex || 0));

    // Xây dựng cây phân cấp với thứ tự cấu trúc đúng như trang dự án
    const sortedTree = buildAndSortTree(rawEntriesOfProject);

    return sortedTree.filter(entry => {
      // Module loại "đợt" không cần hiển thị
      const entryType = getEntryTypeLocal(entry.moduleCode, entry);
      if (entryType === 'Đợt di động') {
        return false;
      }

      // Gia công ngoài chỉ QC 1 lần ở Hàng Trắng, bỏ qua các công đoạn sau
      if (entryType === 'Gia công ngoài' && canAddStageId !== 'white') {
        return false;
      }

      // Tìm thông tin DB mới nhất của mọc/module này
      const currDbModule = allDbModules.find(m => m.id === entry.id || m.moduleCode === entry.moduleCode);

      // Chỉ chặn module đã đạt (pass) ở công đoạn này; cho phép thêm instance pending
      if (currDbModule && stage.field) {
        const stageData = (currDbModule as any)[stage.field];
        if (stageData && stageData.status === 'pass') {
          return false;
        }
      }

      // Nếu stage hiện tại yêu cầu công đoạn trước
      if (stage.requiredPrev) {
        const prevStage = currDbModule ? (currDbModule as any)[stage.requiredPrev] : null;
        const isThungBypass = entryType === 'Thùng' && stage.requiredPrev === 'qcPaint';
        // CTHT/Cánh/Mặt HK bypass qcWhite khi ở stage paint (kiểm trực tiếp sơn)
        const isCthtPaintBypass = canAddStageId === 'paint' && ['CTHT', 'Cánh', 'Mặt HK'].includes(entryType);
        // CTHT bypass qcPaint khi ở stage finish (kiểm hàng hoàn thiện)
        const isCthtFinishBypass = canAddStageId === 'finish' && entryType === 'CTHT';

        if (!isThungBypass && !isCthtPaintBypass && !isCthtFinishBypass && (!prevStage || prevStage.status !== 'pass')) {
          return false;
        }
      }

      return true;
    });
  }, [selectedProjectCode, projectEntries, allDbModules, role, userProfile, selectedTicketId, filteredTicketGroups]);

  const filteredSuggestions = useMemo(() => {
    let result = selectableModules;

    const canAddStageId = getCanAddStage();
    const stage = QC_STAGES.find(s => s.id === canAddStageId);

    // Áp dụng bộ lọc phân loại
    if (classificationFilter === 'thung') {
      result = result.filter(m => getEntryTypeLocal(m.moduleCode, m) === 'Thùng');
    } else if (classificationFilter === 'canh') {
      result = result.filter(m => getEntryTypeLocal(m.moduleCode, m) === 'Cánh');
    } else if (classificationFilter === 'mat_hk') {
      result = result.filter(m => getEntryTypeLocal(m.moduleCode, m) === 'Mặt HK');
    } else if (classificationFilter === 'ctht') {
      // CTHT = tất cả KHÔNG PHẢI Thùng, KHÔNG PHẢI Cánh, KHÔNG PHẢI Mặt HK, loại trừ LEN/FILLER và Thanh treo
      result = result.filter(m => {
        const type = getEntryTypeLocal(m.moduleCode, m);
        if (type === 'Thùng' || type === 'Cánh' || type === 'Mặt HK') return false;
        const nameLower = (m.moduleCode || '').toLowerCase();
        if (nameLower.includes('len') || nameLower.includes('filler') || nameLower.includes('fillter')) return false;
        if (nameLower.includes('thanh treo')) return false;
        return true;
      });
    } else if (classificationFilter === 'fail') {
      result = result.filter(m => {
        const currDbModule = allDbModules.find(dbM => dbM.id === m.id || dbM.moduleCode === m.moduleCode);
        if (!currDbModule) return false;

        const currentStageField = stage?.field;
        const failedCurrent = currentStageField && (currDbModule as any)[currentStageField]?.status === 'fail';
        const failedAny =
          getModuleQcAggregate(currDbModule, 'white')?.status === 'fail' ||
          getModuleQcAggregate(currDbModule, 'paint')?.status === 'fail' ||
          getModuleQcAggregate(currDbModule, 'finish')?.status === 'fail' ||
          getModuleQcAggregate(currDbModule, 'pack')?.status === 'fail';

        return failedCurrent || failedAny;
      });
    }

    if (manualCode.trim()) {
      let cleanFilter = manualCode.trim().toLowerCase();
      if (cleanFilter.includes("----")) {
        cleanFilter = cleanFilter.split("----")[0].trim();
      }
      result = result.filter(m =>
        (m.moduleCode || '').toLowerCase().includes(cleanFilter) ||
        (m.cluster && m.cluster.toLowerCase().includes(cleanFilter))
      );
    }

    if (searchModuleSuggestion.trim()) {
      const lower = searchModuleSuggestion.toLowerCase();
      result = result.filter(m =>
        (m.moduleCode || '').toLowerCase().includes(lower) ||
        (m.cluster && m.cluster.toLowerCase().includes(lower)) ||
        (m.projectName && String(m.projectName).toLowerCase().includes(lower))
      );
    }

    // Lọc theo cụm khi modal thêm thủ công đang mở
    if (showManualAddModal && manualAddClusterFilter) {
      result = result.filter(m => m.cluster === manualAddClusterFilter);
    }

    return result;
  }, [selectableModules, manualCode, searchModuleSuggestion, classificationFilter, allDbModules, getCanAddStage(), showManualAddModal, manualAddClusterFilter]);

  useEffect(() => {
    setClassificationFilter('all');
  }, [selectedProjectCode, getCanAddStage()]);

  const handleScanResult = async (result: ScannedResult) => {
    // Lưu kết quả quét chất lượng
    setScannedQRResult(result);

    const rawTextOriginal = result.rawCode || result.moduleCode || '';

    // Chuẩn hóa mã QR bằng logic chung từ QuickScannerScreen
    const normalizedCode = normalizeScannedCode(rawTextOriginal);

    // Trích xuất instanceId từ result hoặc từ rawCode nếu có ký hiệu '|'
    let qrInstanceId = result.instanceId || '';
    if (!qrInstanceId && rawTextOriginal.includes('|')) {
      const pipeParts = rawTextOriginal.split('|');
      qrInstanceId = pipeParts[1]?.trim() || '';
    }

    const canAddStageId = getCanAddStage();

    // TRƯỜNG HỢP THÊM CẤU KIỆN VÀO PHIẾU QUA QR (quét từ chi tiết phiếu)
    if (scannerMode === 'add_to_ticket' && selectedTicketId) {
      const ticket = [...filteredTicketGroups.pending, ...filteredTicketGroups.completed].find(t => t.id === selectedTicketId);
      if (!ticket) {
        setToast({ message: 'Không tìm thấy phiếu đang mở.', type: 'error' });
        setShowScanner(false);
        setScannerMode(null);
        return;
      }

      // Tìm module trong projectEntries bằng logic chuẩn hóa từ QuickScannerScreen
      const entry = getMatchedEntry(result);

      if (!entry) {
        setToast({ message: `Không tìm thấy cấu kiện "${normalizedCode}" trong hệ thống.`, type: 'error' });
        setShowScanner(false);
        setScannerMode(null);
        return;
      }

      const totalQty = entry.quantity || getModuleInstances(entry).length || '?';

      // Xác định instance cụ thể từ QR
      const instances = getModuleInstances(entry);
      let targetInstance = null;
      let targetInstanceId = '';
      let targetInstanceIndex = 0;

      if (qrInstanceId) {
        targetInstance = instances.find(inst => inst.instanceId === qrInstanceId || inst.id === qrInstanceId);
        if (targetInstance) {
          targetInstanceId = targetInstance.id || targetInstance.instanceId;
          targetInstanceIndex = targetInstance.instanceIndex || 0;
        }
      }
      // Nếu không quét được instance, thử lấy từ parsed result
      if (!targetInstance && result.parsedModuleId) {
        targetInstance = instances.find(inst => inst.id === result.parsedModuleId || inst.instanceId === result.parsedModuleId);
        if (targetInstance) {
          targetInstanceId = targetInstance.id || targetInstance.instanceId;
          targetInstanceIndex = targetInstance.instanceIndex || 0;
        }
      }
      // Nếu vẫn không có, và module chỉ có 1 instance → dùng instance đó
      if (!targetInstance && instances.length === 1) {
        targetInstance = instances[0];
        targetInstanceId = targetInstance.id || targetInstance.instanceId;
        targetInstanceIndex = targetInstance.instanceIndex || 0;
      }

      // Tạo ticket module ID duy nhất = moduleId_instanceIndex
      const ticketModuleId = targetInstance
        ? `${entry.id}_${targetInstanceIndex}`
        : entry.id;

      // Kiểm tra instance này đã có trong phiếu chưa
      const alreadyInTicket = (ticket.modules || []).some((m: any) => m.id === ticketModuleId);

      if (alreadyInTicket) {
        setToast({ message: `Cấu kiện "${entry.moduleCode}" #${targetInstanceIndex || '?'}/${totalQty} đã có trong phiếu.`, type: 'error' });
        setShowScanner(false);
        setScannerMode(null);
        return;
      }

      // Kiểm tra stage có khớp với phiếu không
      const ticketStage = QC_STAGES.find(s => s.id === ticket.stage);

      // Thêm vào phiếu
      try {
        setLoading(true);
        const displayLabel = userProfile?.ten_that || user?.displayName || 'Unknown';

        // 1. Cập nhật trạng thái module thành pending
        const stageField = ticketStage?.field;
        if (stageField) {
          const updateData: any = {};

          // Set instance-level QC status — chỉ cho instance được quét
          const existingInstances = getModuleInstances(entry);
          if (existingInstances.length > 0) {
            updateData.instances = existingInstances.map(inst => {
              const isTarget = targetInstance && (inst.id === targetInstance.id || inst.instanceId === targetInstance.instanceId);
              if (isTarget) {
                return {
                  ...inst,
                  [stageField]: {
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
          }

          // Root-level QC: set pending nếu module không có instances (module cũ)
          if (existingInstances.length === 0) {
            updateData[`${stageField}.status`] = 'pending';
            updateData[`${stageField}.by`] = displayLabel;
            updateData[`${stageField}.date`] = serverTimestamp();
          }

          const history = [...(entry.statusHistory || [])];
          const instanceLabel = targetInstance ? ` (#${targetInstanceIndex}/${totalQty})` : '';
          const statusText = `Chờ kiểm ${ticketStage.label}${instanceLabel} (${displayLabel})`;
          history.push(`${statusText}|${Date.now()}`);
          updateData.statusHistory = history;
          updateData.status = statusText;

          await updateProjectModule(entry.id, updateData, entry.projectCode);
          syncProjectEntry(entry.id, updateData);
        }

        // 2. Thêm vào phiếu (đầu danh sách)
        const newModuleObj = {
          id: ticketModuleId,
          moduleId: entry.id,
          instanceIndex: targetInstanceIndex,
          moduleCode: entry.moduleCode,
          cluster: entry.cluster || 'N/A',
          quantity: 1,
          status: 'pending',
          qcNotes: '',
          qcPhotos: []
        };

        const updatedModules = [newModuleObj, ...(ticket.modules || [])];
        await updateDoc(doc(db, 'qc_tickets', ticket.id), cleanUndefinedFields({
          modules: updatedModules,
          status: 'pending'
        }));

        // 3. Log hoạt động
        await addDoc(collection(db, 'activities'), {
          userId: user?.uid,
          userName: displayLabel,
          userEmail: user?.email || '',
          action: 'Thêm Cấu Kiện vào Phiếu (QR)',
          details: `Thêm cấu kiện ${entry.moduleCode} (#${targetInstanceIndex || '?'}/${totalQty}) vào phiếu chờ kiểm ${ticket.name}`,
          projectCode: ticket.projectCode,
          moduleCode: entry.moduleCode,
          timestamp: serverTimestamp()
        });

        const displayInstance = targetInstance ? ` #${targetInstanceIndex}/${totalQty}` : '';
        setToast({ message: `Đã thêm "${entry.moduleCode}${displayInstance}" vào phiếu "${ticket.name}"`, type: 'success' });
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, 'qc_tickets');
        setToast({ message: 'Lỗi khi thêm cấu kiện vào phiếu.', type: 'error' });
      } finally {
        setLoading(false);
        setShowScanner(false);
        setScannerMode(null);
      }
      return;
    }

    // TRƯỜNG HỢP DUYỆT TRONG PHIẾU CHỜ KIỂM ĐANG MỞ
    if (selectedTicketId) {
      const ticket = [...filteredTicketGroups.pending, ...filteredTicketGroups.completed].find(t => t.id === selectedTicketId);
      if (ticket) {
        // Tìm module trùng khớp trong phiếu kiểm
        const matchedEntry = getMatchedEntry(result);
        const matched = matchedEntry ? ticket.modules.find((m: any) =>
          m.id === result.matchedId ||
          m.id === matchedEntry.id ||
          (m.moduleCode || '').toLowerCase() === (matchedEntry.moduleCode || '').toLowerCase()
        ) : null;

        // Nếu module có trong phiếu → hiển thị chi tiết trực tiếp
        if (matched) {
          const projEntry = projectEntries.find(e => e.id === getBaseModuleId(matched.id));
          if (projEntry) {
            let targetInstanceId = qrInstanceId;
            const insts = getModuleInstances(projEntry);
            const foundInst = insts.find(inst => inst.instanceId === qrInstanceId || inst.id === qrInstanceId);
            if (foundInst) {
              targetInstanceId = foundInst.id || foundInst.instanceId;
            }
            // Hiển thị chi tiết module thay vì mở modal kiểm định
            setViewingModuleQcStage(ticket.stage);
            setViewingModuleInstanceIndex(foundInst?.instanceIndex);
            setViewingModule(projEntry);
            setShowScanner(false);
            setScannerMode(null);
            return;
          }
        }

        // Module không có trong phiếu → hiển thị chi tiết
        const fallbackEntry = matchedEntry || getMatchedEntry(result);

        if (fallbackEntry) {
          let targetInstanceId = qrInstanceId;
          const insts = getModuleInstances(fallbackEntry);
          const foundInst = insts.find(inst => inst.instanceId === qrInstanceId || inst.id === qrInstanceId);
          // Hiển thị chi tiết module thay vì mở modal kiểm định
          setViewingModuleQcStage(ticket.stage);
          setViewingModuleInstanceIndex(foundInst?.instanceIndex);
          setViewingModule(fallbackEntry);
        } else {
          setScanError({
            raw: rawTextOriginal,
            fix1: normalizedCode,
            fix2: '',
            message: `Không tìm thấy cấu kiện "${normalizedCode}" trong hệ thống.`
          });
        }
      }
      setShowScanner(false);
      setScannerMode(null);
      return;
    }

    // TRƯỜNG HỢP 1: KIỂM TRA/PHÊ DUYỆT TRONG MODAL KIỂM ĐỊNH (XÁC MINH MODULE)
    if (scannerMode === 'verify' || (activeModuleId && activeModule)) {
      if (activeModuleId && activeModule) {
        const activeCodeLower = (activeModule.moduleCode || '').toLowerCase();
        const isMatch =
          (normalizedCode && normalizedCode.toLowerCase() === activeCodeLower) ||
          (result.matchedId === activeModuleId);

        if (isMatch) {
          setQcStatus('pass');
        } else {
          setScanError({
            raw: rawTextOriginal,
            fix1: normalizedCode,
            fix2: '',
            message: `Mã QR quét được không khớp với Module đang kiểm định (${activeModule.moduleCode}).`
          });
        }
      }
      setShowScanner(false);
      setScannerMode(null);
      return;
    }

    // TRƯỜNG HỢP 2: THÊM HÀNG VÀO DANH SÁCH TẠO PHIẾU (Vào hàng chờ tạm, không chuyển pending ngay)
    if (scannerMode === 'add') {
      if (!selectedProjectCode) {
        setScanError({
          raw: rawTextOriginal,
          fix1: normalizedCode,
          fix2: '',
          message: `Vui lòng chọn dự án trước khi quét.`
        });
        setShowScanner(false);
        setScannerMode(null);
        return;
      }

      // Thử tìm theo normalizedCode và khớp theo projectCode
      let entry = projectEntries.find(e =>
        (e.moduleCode || '').toLowerCase() === normalizedCode.toLowerCase() &&
        e.projectCode === selectedProjectCode
      );

      // Nếu không tìm thấy, thử match bằng getMatchedEntry và kiểm tra projectCode
      if (!entry) {
        const matched = getMatchedEntry(result);
        if (matched && matched.projectCode === selectedProjectCode) {
          entry = matched;
        }
      }

      if (entry) {
        let parsedInstanceIndex: number | undefined;
        if (qrInstanceId) {
          const instMatch = qrInstanceId.match(/(\d+)$/);
          if (instMatch) parsedInstanceIndex = parseInt(instMatch[1], 10);
        }
        addModuleToStaged(entry, parsedInstanceIndex);
      } else {
        setScanError({
          raw: rawTextOriginal,
          fix1: normalizedCode,
          fix2: '',
          message: `Không tìm thấy module trong dự án đã chọn.`
        });
      }
      setShowScanner(false);
      setScannerMode(null);
      return;
    }

    // TRƯỜNG HỢP 3: QUÉT TỪ DANH SÁCH BÊN NGOÀI ĐỂ KIỂM QC
    if (isQC) {
      const matchModule = (e: ProjectEntry) =>
        e.id === result.matchedId ||
        (e.moduleCode || '').toLowerCase() === normalizedCode.toLowerCase();

      // Tìm trong danh sách modules chờ kiểm (pending stage)
      let entry = inspectedModules.find(matchModule);

      let isGCNReceivedSpecial = false;

      // Nếu không có trong inspectedModules, tìm trong allDbModules
      // và kiểm tra xem có nằm trong phiếu kiểm nào không
      if (!entry) {
        const fromAllDb = allDbModules.find(matchModule);
        if (fromAllDb) {
          const isInTicket = qcTickets.some(t =>
            (t.modules || []).some((m: any) => m.id === fromAllDb.id || m.moduleCode === fromAllDb.moduleCode)
          );
          if (isInTicket) {
            entry = fromAllDb;
          } else {
            const entryType = getEntryTypeLocal(fromAllDb.moduleCode, fromAllDb);
            const isReceived = fromAllDb.status?.includes('Đã nhận') || false;
            // Kiểm tra xem module có parent Thùng nào không
            const hasParentThung = projectEntries.some(p => {
              if (p.projectCode !== fromAllDb.projectCode) return false;
              if (getEntryTypeLocal(p.moduleCode, p) !== 'Thùng') return false;
              const parentCandidate = getParentCodeCandidate(fromAllDb.moduleCode || '').toLowerCase();
              return parentCandidate === (p.moduleCode || '').toLowerCase();
            });
            if (isReceived && (entryType === 'Gia công ngoài' || !hasParentThung)) {
              entry = fromAllDb;
              isGCNReceivedSpecial = true;
            }
          }
        }
      }

      if (entry) {
        // Tìm stage có pending status trên module
        const pendingStage = QC_STAGES.find(s => (entry as any)[s.field]?.status === 'pending') || (isGCNReceivedSpecial ? QC_STAGES[0] : null);

        // Nếu không có pending stage, tìm trong qcTickets xem module có nằm trong phiếu nào không
        let ticketStage = pendingStage;
        let foundTicket: any = null;
        if (!ticketStage) {
          for (const ticket of qcTickets) {
            const match = (ticket.modules || []).find((m: any) =>
              m.id === entry.id || m.moduleCode === entry.moduleCode
            );
            if (match) {
              foundTicket = ticket;
              ticketStage = QC_STAGES.find(s => s.id === ticket.stage) || null;
              break;
            }
          }
        }

        if (ticketStage) {
          // Hiển thị chi tiết module thay vì mở modal kiểm định
          setViewingModuleQcStage(ticketStage.id);
          let targetInstanceId = qrInstanceId;
          const insts = getModuleInstances(entry);
          const foundInst = insts.find(inst => inst.instanceId === qrInstanceId || inst.id === qrInstanceId);
          setViewingModuleInstanceIndex(foundInst?.instanceIndex);
          setViewingModule(entry);
        } else {
          setScanError({
            raw: rawTextOriginal,
            fix1: normalizedCode,
            fix2: '',
            message: `Module "${entry.moduleCode}" chưa được gửi chờ kiểm ở bất kỳ công đoạn nào.`
          });
        }
      } else {
        setScanError({
          raw: rawTextOriginal,
          fix1: normalizedCode,
          fix2: '',
          message: `Không tìm thấy module "${normalizedCode}" trong hệ thống.`
        });
      }
    } else if (canAddStageId) {
      if (!selectedProjectCode) {
        setScanError({
          raw: rawTextOriginal,
          fix1: normalizedCode,
          fix2: '',
          message: `Vui lòng chọn dự án trước khi quét.`
        });
        setShowScanner(false);
        return;
      }

      // Thử tìm theo normalizedCode và khớp theo projectCode
      let entry = projectEntries.find(e =>
        (e.moduleCode || '').toLowerCase() === normalizedCode.toLowerCase() &&
        e.projectCode === selectedProjectCode
      );

      // Nếu không tìm thấy, thử match bằng getMatchedEntry và kiểm tra projectCode
      if (!entry) {
        const matched = getMatchedEntry(result);
        if (matched && matched.projectCode === selectedProjectCode) {
          entry = matched;
        }
      }

      if (entry) {
        let parsedInstanceIndex: number | undefined;
        if (qrInstanceId) {
          const instMatch = qrInstanceId.match(/(\d+)$/);
          if (instMatch) parsedInstanceIndex = parseInt(instMatch[1], 10);
        }
        addModuleToStaged(entry, parsedInstanceIndex);
      } else {
        setScanError({
          raw: rawTextOriginal,
          fix1: normalizedCode,
          fix2: '',
          message: `Không tìm thấy module trong dự án đã chọn.`
        });
      }
    }

    setShowScanner(false);
    setScannerMode(null);
  };

  const addModuleToStaged = (module: ProjectEntry, targetInstanceIndex?: number) => {
    // Khi đang mở phiếu (selectedTicketId), dùng stage của phiếu
    let canAddStageId: string | null = null;
    if (selectedTicketId) {
      const ticket = [...filteredTicketGroups.pending, ...filteredTicketGroups.completed].find(t => t.id === selectedTicketId);
      canAddStageId = ticket?.stage || getCanAddStage();
    } else {
      canAddStageId = getCanAddStage();
    }
    if (!canAddStageId) return false;

    const entryType = getEntryTypeLocal(module.moduleCode, module);
    if (entryType === 'Đợt di động') {
      setScanError(`Khép/Cấu kiện "${module.moduleCode}" là loại Đợt di động, kết quả kiểm định sẽ tự động tính và đồng bộ theo module Thùng cha.`);
      return false;
    }

    const stage = QC_STAGES.find(s => s.id === canAddStageId);
    if (!stage) return false;

    const currDbModule = allDbModules.find(m => m.id === module.id || m.moduleCode === module.moduleCode);
    if (currDbModule && stage.field) {
      const stageData = (currDbModule as any)[stage.field];
      if (stageData && stageData.status === 'pass') {
        setScanError(`Module "${module.moduleCode}" đã đạt (Pass) công đoạn ${stage.label}. Không thể tạo phiếu chờ kiểm mới.`);
        return false;
      }
    }

    if (stage?.requiredPrev) {
      const prevStage = (module as any)[stage.requiredPrev];
      const isThungBypass = entryType === 'Thùng' && stage.requiredPrev === 'qcPaint';
      if (!isThungBypass && (!prevStage || prevStage.status !== 'pass')) {
        const prevLabel = QC_STAGES.find(s => s.field === stage.requiredPrev)?.label;
        setScanError(`Module "${module.moduleCode}" chưa Pass ${prevLabel}. Phải Pass ${prevLabel} mới có thể chuyển sang ${stage.label}.`);
        return false;
      }
    }

    const maxQty = module.quantity || 1;
    const stagedForModule = stagedModules.filter(sm => sm.module.id === module.id);
    const usedIndices = new Set(stagedForModule.map(sm => sm.instanceIndex));

    let nextIndex: number;
    if (targetInstanceIndex && targetInstanceIndex >= 1 && targetInstanceIndex <= maxQty && !usedIndices.has(targetInstanceIndex)) {
      nextIndex = targetInstanceIndex;
    } else {
      nextIndex = 1;
      while (usedIndices.has(nextIndex) && nextIndex <= maxQty) {
        nextIndex++;
      }
    }

    if (nextIndex > maxQty) {
      setScanError(`Module "${module.moduleCode}" đã đủ ${maxQty} bản số (#${maxQty}/${maxQty}) trong danh sách chờ.`);
      return false;
    }

    let extraModules: { module: ProjectEntry; instanceIndex: number }[] = [];
    if (canAddStageId === 'paint' && entryType === 'Thùng') {
      const children = projectEntries.filter(m =>
        m.projectCode === selectedProjectCode &&
        m.id !== module.id &&
        ['Cánh', 'Mặt HK', 'CTHT'].includes(getEntryTypeLocal(m.moduleCode, m)) &&
        getParentCodeCandidate(m.moduleCode || '').toLowerCase() === (module.moduleCode || '').toLowerCase()
      );

      children.forEach(child => {
        const childStaged = stagedModules.filter(sm => sm.module.id === child.id);
        const childUsedIndices = new Set(childStaged.map(sm => sm.instanceIndex));
        const childMaxQty = child.quantity || 1;
        let childIdx = 1;
        while (childUsedIndices.has(childIdx) && childIdx <= childMaxQty) childIdx++;
        if (childIdx <= childMaxQty) {
          extraModules.push({ module: child, instanceIndex: childIdx });
        }
      });
    }

    const newItem = { module, instanceIndex: nextIndex };
    setStagedModules(prev => [...prev, newItem, ...extraModules]);
    return true;
  };

  // Thêm module trực tiếp vào phiếu đang mở (dùng cho modal thêm thủ công)
  const addModuleToTicket = async (module: ProjectEntry, instanceIndex: number): Promise<boolean> => {
    if (!selectedTicketId) return false;

    const ticket = [...filteredTicketGroups.pending, ...filteredTicketGroups.completed].find(t => t.id === selectedTicketId);
    if (!ticket) return false;

    const ticketModuleId = `${module.id}_${instanceIndex}`;

    // Kiểm tra đã có trong phiếu chưa
    const alreadyInTicket = (ticket.modules || []).some((m: any) => m.id === ticketModuleId);
    if (alreadyInTicket) {
      setScanError(`Cấu kiện "${module.moduleCode}" #${instanceIndex} đã có trong phiếu.`);
      return false;
    }

    try {
      setLoading(true);

      const displayLabel = userProfile?.ten_that || user?.displayName || 'Nhân viên QC';
      const totalQty = module.quantity || 1;
      const ticketStage = QC_STAGES.find(s => s.id === ticket.stage);

      // 1. Đồng bộ trạng thái instance trong dự án
      const stageField = ticketStage?.field;
      if (stageField) {
        const updateData: any = {};
        const existingInstances = getModuleInstances(module);

        if (existingInstances.length > 0) {
          updateData.instances = existingInstances.map(inst => {
            const isTarget = inst.instanceIndex === instanceIndex;
            if (isTarget) {
              return {
                ...inst,
                [stageField]: {
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
        }

        // Root-level QC: set pending nếu chưa có stage data (module cũ không có instances)
        const hasAnyInstanceData = existingInstances.some(inst => {
          const stageData = (inst as any)[stageField];
          return stageData && (stageData.status === 'pending' || stageData.status === 'pass' || stageData.status === 'fail');
        });
        if (!hasAnyInstanceData && existingInstances.length === 0) {
          updateData[`${stageField}.status`] = 'pending';
          updateData[`${stageField}.by`] = displayLabel;
          updateData[`${stageField}.date`] = serverTimestamp();
        }

        const history = [...(module.statusHistory || [])];
        const statusText = `Chờ kiểm ${ticketStage?.label || ''} (#${instanceIndex}/${totalQty}) (${displayLabel})`;
        history.push(`${statusText}|${Date.now()}`);
        updateData.statusHistory = history;
        updateData.status = statusText;

        await updateProjectModule(module.id, updateData, module.projectCode);
        syncProjectEntry(module.id, updateData);
      }

      // 2. Thêm vào phiếu
      const newModuleObj = {
        id: ticketModuleId,
        moduleId: module.id,
        instanceIndex: instanceIndex,
        moduleCode: module.moduleCode,
        cluster: module.cluster || 'N/A',
        quantity: 1,
        status: 'pending',
        qcNotes: '',
        qcPhotos: []
      };

      const updatedModules = [newModuleObj, ...(ticket.modules || [])];
      await updateDoc(doc(db, 'qc_tickets', ticket.id), cleanUndefinedFields({
        modules: updatedModules,
        status: 'pending'
      }));

      // 3. Log hoạt động
      await addDoc(collection(db, 'activities'), {
        userId: user?.uid,
        userName: displayLabel,
        userEmail: user?.email || '',
        action: 'Thêm Cấu Kiện vào Phiếu (Thủ Công)',
        details: `Thêm cấu kiện ${module.moduleCode} (#${instanceIndex}/${totalQty}) vào phiếu chờ kiểm ${ticket.name}`,
        projectCode: ticket.projectCode,
        moduleCode: module.moduleCode,
        timestamp: serverTimestamp()
      });

      setToast({ message: `Đã thêm "${module.moduleCode} #${instanceIndex}" vào phiếu`, type: 'success' });
      return true;
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, 'qc_tickets');
      setToast({ message: 'Lỗi khi thêm cấu kiện vào phiếu.', type: 'error' });
      return false;
    } finally {
      setLoading(false);
    }
  };

  // Thêm toàn bộ instances của nhiều modules vào phiếu 1 lần (batch)
  const addAllInstancesToTicket = async (modules: ProjectEntry[]): Promise<number> => {
    if (!selectedTicketId || modules.length === 0) return 0;

    // Đọc ticket mới nhất từ Firestore
    const ticketSnap = await getDoc(doc(db, 'qc_tickets', selectedTicketId));
    if (!ticketSnap.exists()) return 0;
    const ticket = ticketSnap.data() as any;
    const existingModules: any[] = ticket.modules || [];
    const existingIds = new Set(existingModules.map((m: any) => m.id));

    const displayLabel = userProfile?.ten_that || user?.displayName || 'Nhân viên QC';
    const ticketStage = QC_STAGES.find(s => s.id === ticket.stage);
    const stageField = ticketStage?.field;

    // 1. Build danh sách module mới + cập nhật instance status
    const newModuleObjs: any[] = [];
    const moduleUpdatesMap = new Map<string, { moduleId: string; updateData: any; projectCode?: string }>();

    for (const module of modules) {
      // Luôn lấy instance data mới nhất từ allDbModules
      const latestModule = allDbModules.find(m => m.id === module.id || m.moduleCode === module.moduleCode) || module;
      const instances = getModuleInstances(latestModule);
      const maxQty = latestModule.quantity || instances.length || 1;
      const totalQty = maxQty;

      for (let i = 1; i <= maxQty; i++) {
        const ticketModuleId = `${latestModule.id}_${i}`;
        if (existingIds.has(ticketModuleId)) continue; // Bỏ qua nếu đã có

        // Loại trừ instance đã pass ở stage hiện tại — dùng data mới nhất
        const targetInst = instances.find(inst => inst.instanceIndex === i);
        if (targetInst && stageField) {
          const instStageData = (targetInst as any)[stageField];
          if (instStageData?.status === 'pass') continue; // Bỏ qua instance đã pass
        }

        newModuleObjs.push({
          id: ticketModuleId,
          moduleId: latestModule.id,
          instanceIndex: i,
          moduleCode: latestModule.moduleCode,
          cluster: latestModule.cluster || 'N/A',
          quantity: 1,
          status: 'pending',
          qcNotes: '',
          qcPhotos: []
        });

        // Cập nhật instance status trong dự án — merge theo moduleId
        if (stageField) {
          const existing = moduleUpdatesMap.get(latestModule.id);
          // Lấy instances hiện tại (từ update trước hoặc từ DB)
          let currentInstances = existing?.updateData?.instances || instances;

          // Set pending cho instance i
          currentInstances = currentInstances.map((inst: any) => {
            if (inst.instanceIndex === i) {
              return {
                ...inst,
                [stageField]: {
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

          const history = [...(latestModule.statusHistory || [])];
          history.push(`Chờ kiểm ${ticketStage?.label || ''} (#${i}/${totalQty}) (${displayLabel})|${Date.now()}`);

          moduleUpdatesMap.set(latestModule.id, {
            moduleId: latestModule.id,
            updateData: {
              instances: currentInstances,
              statusHistory: history,
              status: `Chờ kiểm ${ticketStage?.label || ''} (#${i}/${totalQty}) (${displayLabel})`,
            },
            projectCode: latestModule.projectCode,
          });
        }
      }
    }

    const moduleUpdates = Array.from(moduleUpdatesMap.values());

    if (newModuleObjs.length === 0) return 0;

    try {
      setLoading(true);

      // 2. Ghi toàn bộ vào phiếu TRƯỚC (nhanh)
      const allModules = [...newModuleObjs, ...existingModules];
      await updateDoc(doc(db, 'qc_tickets', selectedTicketId), cleanUndefinedFields({
        modules: allModules,
        status: 'pending'
      }));

      // 3. Cập nhật instance status trong dự án song song (background)
      Promise.all(moduleUpdates.map(({ moduleId, updateData, projectCode }) =>
        updateProjectModule(moduleId, updateData, projectCode).then(() => syncProjectEntry(moduleId, updateData))
      )).catch(err => console.error('Lỗi background update:', err));

      // 4. Log hoạt động (background)
      addDoc(collection(db, 'activities'), {
        userId: user?.uid,
        userName: displayLabel,
        userEmail: user?.email || '',
        action: 'Thêm Toàn Bộ Cấu Kiện (Thủ Công)',
        details: `Thêm ${newModuleObjs.length} instance vào phiếu chờ kiểm ${ticket.name}`,
        projectCode: ticket.projectCode,
        timestamp: serverTimestamp()
      }).catch(err => console.error('Lỗi log activity:', err));

      return newModuleObjs.length;
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, 'qc_tickets');
      return 0;
    } finally {
      setLoading(false);
    }
  };

  // Danh sách cụm có chứa CTHT, Mặt HK, Cánh (dùng cho "Thêm hàng sơn")
  const paintClusters = useMemo(() => {
    if (!selectedProjectCode || getCanAddStage() !== 'white') return [];
    const targetTypes = ['CTHT', 'Mặt HK', 'Cánh'];
    const clusterSet = new Set<string>();
    projectEntries.forEach(e => {
      if (e.projectCode === selectedProjectCode && targetTypes.includes(getEntryTypeLocal(e.moduleCode, e)) && e.cluster) {
        clusterSet.add(e.cluster.trim());
      }
    });
    return Array.from(clusterSet).sort((a, b) => a.localeCompare(b, 'vi', { numeric: true }));
  }, [selectedProjectCode, projectEntries, getCanAddStage()]);

  const handleAddPaintCluster = (cluster: string) => {
    const canAddStageId = getCanAddStage();
    if (!canAddStageId || canAddStageId !== 'white' || !selectedProjectCode) return;

    const targetTypes = ['CTHT', 'Mặt HK', 'Cánh'];
    const candidates = projectEntries.filter(e =>
      e.projectCode === selectedProjectCode &&
      (e.cluster || '').trim() === cluster.trim() &&
      targetTypes.includes(getEntryTypeLocal(e.moduleCode, e))
    );

    let addedCount = 0;
    candidates.forEach(entry => {
      const result = addModuleToStaged(entry);
      if (result) addedCount++;
    });

    setShowPaintClusterPicker(false);
    if (addedCount === 0) {
      setScanError(`Cụm "${cluster}" không có module CTHT/Mặt HK/Cánh nào phù hợp để thêm (có thể đã pass hoặc đang chờ kiểm).`);
    }
  };

  // Thêm tất cả module loại Thùng từ dự án vào phiếu kiểm (Hoàn Thiện / Đóng gói)
  const handleAddAllThung = () => {
    if (!selectedProjectCode) return;

    const rawEntriesOfProject = [...projectEntries]
      .filter(e => e.projectCode === selectedProjectCode)
      .sort((a, b) => (a.sortIndex || 0) - (b.sortIndex || 0));

    const sortedTree = buildAndSortTree(rawEntriesOfProject);

    // Them tat ca module loai Thung, khong quan tam tinh trang QC
    const thungModules = sortedTree.filter(entry => {
      const entryType = getEntryTypeLocal(entry.moduleCode, entry);
      return entryType === 'Thùng';
    });

    if (thungModules.length === 0) {
      setScanError(`Không tìm thấy module Thùng nào trong dự án "${selectedProjectCode}".`);
      return;
    }

    // Them truc tiep vao stagedModules, khong qua check
    let addedCount = 0;
    thungModules.forEach(entry => {
      const maxQty = entry.quantity || 1;
      const stagedForModule = stagedModules.filter(sm => sm.module.id === entry.id);
      const usedIndices = new Set(stagedForModule.map(sm => sm.instanceIndex));

      // Them tat ca instances chua co trong staged
      for (let i = 1; i <= maxQty; i++) {
        if (!usedIndices.has(i)) {
          setStagedModules(prev => [...prev, { module: entry, instanceIndex: i }]);
          addedCount++;
        }
      }
    });

    if (addedCount === 0) {
      setScanError(`Không thể thêm module Thùng nào (có thể đã được thêm trước đó).`);
    }
  };

  const handleConfirmAdd = async () => {
    console.log("Confirming module:", confirmingModule);
    if (!confirmingModule) return;
    const canAddStageId = getCanAddStage();
    console.log("Can add stage ID:", canAddStageId);
    if (!canAddStageId) return;

    const stage = QC_STAGES.find(s => s.id === canAddStageId);
    if (!stage) return;
    console.log("Stage to add:", stage);

    // Ràng buộc công đoạn trước cần đạt Pass
    if (stage.requiredPrev) {
      const prevStage = (confirmingModule as any)[stage.requiredPrev];
      const entryType = getEntryTypeLocal(confirmingModule.moduleCode, confirmingModule);
      const isThungBypass = (entryType === 'Thùng' || entryType === 'Đợt di động') && stage.requiredPrev === 'qcPaint';
      const isCthtPaintBypass = canAddStageId === 'paint' && ['CTHT', 'Cánh', 'Mặt HK'].includes(entryType);
      const isCthtFinishBypass = canAddStageId === 'finish' && entryType === 'CTHT';
      if (!isThungBypass && !isCthtPaintBypass && !isCthtFinishBypass && (!prevStage || prevStage.status !== 'pass')) {
        const prevLabel = QC_STAGES.find(s => s.field === stage.requiredPrev)?.label;
        setScanError(`Module "${confirmingModule.moduleCode}" chưa Pass ${prevLabel}. Phải Pass ${prevLabel} mới có thể chuyển sang ${stage.label}.`);
        setConfirmingModule(null);
        return;
      }
    }

    try {
      setLoading(true);
      const displayLabel = userProfile?.ten_that || user?.displayName || 'Unknown';
      const stageField = stage.field;

      // Ghi pending vào instances thay vì module root
      const existingInstances = getModuleInstances(confirmingModule);
      const updateData: any = {};

      if (existingInstances.length > 0) {
        updateData.instances = existingInstances.map(inst => ({
          ...inst,
          [stageField]: {
            status: 'pending',
            by: displayLabel,
            date: new Date(),
            notes: '',
            photos: [],
          }
        }));
      } else {
        // Fallback cho module cũ không có instances
        updateData[`${stageField}.status`] = 'pending';
        updateData[`${stageField}.by`] = displayLabel;
        updateData[`${stageField}.date`] = serverTimestamp();
      }

      const history = [...(confirmingModule.statusHistory || [])];
      const statusText = `Chờ kiểm ${stage.label}`;
      history.push(`${statusText}|${Date.now()}`);
      updateData.statusHistory = history;
      updateData.status = statusText;

      await updateProjectModule(confirmingModule.id, updateData, confirmingModule.projectCode);
      syncProjectEntry(confirmingModule.id, updateData);

      // Log hoạt động
      await addDoc(collection(db, 'activities'), {
        userId: user?.uid,
        userName: displayLabel,
        userEmail: user?.email || '',
        action: 'Gửi chờ kiểm',
        details: `Gửi chờ kiểm ${stage.label} cho Module ${confirmingModule.moduleCode}`,
        projectCode: confirmingModule.projectCode,
        moduleCode: confirmingModule.moduleCode,
        timestamp: serverTimestamp()
      });

      setConfirmingModule(null);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, 'projects');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateBatch = async () => {
    if (stagedModules.length === 0) return;
    const canAddStageId = getCanAddStage();
    if (!canAddStageId) return;

    const stage = QC_STAGES.find(s => s.id === canAddStageId);
    if (!stage) return;

    try {
      setLoading(true);
      const chucDanh = userProfile?.chuc_danh || '';
      const senderName = userProfile?.ten_that || user?.displayName || 'Nhân viên';

      // Tạo tên phiếu có tên công đoạn từ stage, chức danh và tên người gửi
      const ticketName = `${stage.label}${chucDanh ? ' - ' + chucDanh : ''} (${senderName})`;

      // Tìm phiếu có sẵn chung dự án và cùng công đoạn và đang trong trạng thái pending ("hàng chờ")
      const existingTicket = qcTickets.find(t =>
        t.projectCode === selectedProjectCode &&
        t.stage === canAddStageId &&
        t.status === 'pending'
      );

      let targetTicketId = '';
      let targetTicketName = '';
      let isMerged = false;

      const newModulesPayload = stagedModules.map((item) => {
        const m = item.module;
        // Dung chung nguon du lieu voi hien thi (allDbModules)
        const currDbModule = allDbModules.find(dbM => dbM.id === m.id || dbM.moduleCode === m.moduleCode);
        const isReinspect = currDbModule && stage ? (currDbModule as any)[stage.field]?.status === 'fail' : false;

        // Lay QC status tu instance cu the
        let moduleStatus = 'pending';
        if (currDbModule && canAddStageId) {
          const instances = getModuleInstances(currDbModule);
          const targetInstance = instances.find(inst => inst.instanceIndex === item.instanceIndex);
          if (targetInstance) {
            const stageField = QC_STAGES.find(s => s.id === canAddStageId)?.field;
            const instQcData = stageField ? (targetInstance as any)[stageField] : null;
            if (instQcData?.status === 'pass') moduleStatus = 'pass';
            else if (instQcData?.status === 'fail') moduleStatus = 'fail';
          }
        }

        return {
          id: `${m.id}_${item.instanceIndex}`,
          moduleCode: m.moduleCode,
          cluster: m.cluster || 'N/A',
          quantity: 1,
          instanceIndex: item.instanceIndex,
          status: moduleStatus,
          qcNotes: '',
          qcPhotos: [],
          isReinspect: !!isReinspect
        };
      });

      if (existingTicket) {
        targetTicketId = existingTicket.id;
        targetTicketName = existingTicket.name;
        isMerged = true;

        const currentModules = existingTicket.modules || [];
        const mergedModules = [...currentModules];

        newModulesPayload.forEach((newMod: any) => {
          if (!mergedModules.some((m: any) => m.id === newMod.id)) {
            mergedModules.push(newMod);
          }
        });

        // 1. Cập nhật phiếu hiện có
        await updateDoc(doc(db, 'qc_tickets', existingTicket.id), cleanUndefinedFields({
          modules: mergedModules
        }));
      } else {
        const newTicketDocRef = doc(collection(db, 'qc_tickets'));
        const generatedTicketId = newTicketDocRef.id;
        const dateCode = (() => {
          const now = new Date();
          const yyyy = now.getFullYear();
          const mm = String(now.getMonth() + 1).padStart(2, '0');
          const dd = String(now.getDate()).padStart(2, '0');
          return `${yyyy}${mm}${dd}`;
        })();
        const ticketName = `#${dateCode} - ${selectedProjectCode}/${stage.label}`;

        const ticketDoc = {
          name: ticketName,
          projectCode: selectedProjectCode,
          stage: canAddStageId,
          createdBy: senderName,
          createdByEmail: user?.email || '',
          createdAt: new Date(), // Sẽ dùng Date cục bộ hoặc client-side fallback rồi sort
          status: 'pending',
          modules: newModulesPayload,
          ownerId: user?.uid || ''
        };

        // 1. Tạo phiếu mới
        await setDoc(newTicketDocRef, cleanUndefinedFields(ticketDoc));
        targetTicketId = generatedTicketId;
        targetTicketName = ticketName;

        // Tự động tạo thông báo nghiệp vụ cho các user có chức danh hoặc vai trò 'QC'
        await addDoc(collection(db, 'notifications'), {
          title: 'Có phiếu mới chờ QC kiểm tra',
          content: `Có phiếu mới chờ QC kiểm tra: ${ticketName} cho dự án ${selectedProjectCode}.`,
          type: 'qc',
          createdAt: serverTimestamp(),
          targetUsers: [],
          targetRoles: ['QC', 'mod_qc'],
          readBy: [],
          linkTo: 'qc'
        });
      }

      // 2. Cập nhật tất cả module trong phiếu thành trạng thái pending của công đoạn đó
      const uniqueModuleIds = new Set<string>();
      const updates = stagedModules.map(async (item) => {
        const module = item.module;
        if (uniqueModuleIds.has(module.id)) return;
        uniqueModuleIds.add(module.id);

        const stageField = stage.field;
        const updateData: any = {};

        // Set instance-level QC status cho instance cụ thể
        const existingInstances = getModuleInstances(module);
        if (existingInstances.length > 0) {
          updateData.instances = existingInstances.map(inst => {
            if (item.instanceIndex === inst.instanceIndex) {
              return {
                ...inst,
                [stageField]: {
                  status: 'pending',
                  by: senderName,
                  date: new Date(),
                  notes: '',
                  photos: [],
                }
              };
            }
            return inst;
          });
        }

        const history = [...(module.statusHistory || [])];
        const statusText = `Chờ kiểm ${stage.label} (${senderName})`;
        history.push(`${statusText}|${Date.now()}`);
        updateData.statusHistory = history;
        updateData.status = statusText;

        await updateProjectModule(module.id, updateData, module.projectCode);
        syncProjectEntry(module.id, updateData);

        // Log hoạt động
        await addDoc(collection(db, 'activities'), {
          userId: user?.uid,
          userName: senderName,
          userEmail: user?.email || '',
          action: isMerged ? 'Gộp gửi chờ kiểm' : 'Gửi chờ kiểm',
          details: isMerged
            ? `Gộp và gửi chờ kiểm ${stage.label} cho Module ${module.moduleCode} vào phiếu có sẵn: ${targetTicketName}`
            : `Gửi chờ kiểm ${stage.label} cho Module ${module.moduleCode} qua phiếu ${targetTicketName}`,
          projectCode: module.projectCode,
          moduleCode: module.moduleCode,
          timestamp: serverTimestamp()
        });
      });

      await Promise.all(updates);

      // Nếu có gộp, set thông tin hiển thị thông báo gộp
      if (isMerged) {
        setMergeNotice({
          projectName: selectedProjectCode,
          ticketName: targetTicketName,
          moduleCodes: stagedModules.map(item => item.module.moduleCode)
        });
      }

      setStagedModules([]);
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, 'qc_tickets');
    } finally {
      setLoading(false);
    }
  };

  const removeFromStaged = (index: number) => {
    setStagedModules(prev => prev.filter((_, idx) => idx !== index));
  };

  const handleSyncTicketToProject = async (ticket: any) => {
    if (!ticket?.modules?.length) return;
    const stage = QC_STAGES.find(s => s.id === ticket.stage);
    if (!stage) return;

    if (!confirm(`Đồng bộ kết quả QC giai đoạn "${stage.label}" từ phiếu vào các instance trong dự án?\nCác instance chưa có QC sẽ được ghi theo thứ tự.`)) return;

    try {
      setLoading(true);
      let syncCount = 0;
      const updates: Promise<void>[] = [];

      for (const ticketModule of ticket.modules) {
        const projEntry = projectEntries.find(e => e.id === ticketModule.id || e.moduleCode === ticketModule.moduleCode);
        if (!projEntry) continue;

        const instances = getModuleInstances(projEntry);
        const ticketStatus = ticketModule.status;
        const ticketNotes = ticketModule.qcNotes || '';
        const ticketPhotos = ticketModule.qcPhotos || [];

        if (ticketStatus === 'pass' || ticketStatus === 'fail' || ticketStatus === 'pending') {
          // Đồng bộ trạng thái từ phiếu vào instance (pass/fail/pending)
          const updatedInstances = instances.map(inst => {
            const stageData = (inst as any)[stage.field];
            // Nếu instance đã pass/fail thì giữ nguyên, chỉ sync pending nếu instance chưa có trạng thái
            if (stageData?.status === 'pass' || stageData?.status === 'fail') return inst;
            if (ticketStatus === 'pending' && stageData?.status === 'pending') return inst;

            return {
              ...inst,
              [stage.field]: {
                status: ticketStatus,
                by: ticketModule.qcBy || ticket.createdBy,
                date: new Date(),
                notes: ticketNotes,
                photos: ticketPhotos,
              }
            };
          });

          const hasChanges = updatedInstances.some((inst, i) => {
            const old = (instances[i] as any)[stage.field]?.status;
            const nw = (inst as any)[stage.field]?.status;
            return old !== nw;
          });

          if (hasChanges) {
            const mockEntry = { ...projEntry, instances: updatedInstances };
            const aggWhite = getModuleQcAggregate(mockEntry, 'white');
            const aggPaint = getModuleQcAggregate(mockEntry, 'paint');
            const aggFinish = getModuleQcAggregate(mockEntry, 'finish');
            const aggPack = getModuleQcAggregate(mockEntry, 'pack');

            const displayLabel = ticketModule.qcBy || ticket.createdBy || 'System';

            const syncUpdateData: any = {
              instances: updatedInstances,
            };

            const lastActiveStage = aggPack?.status !== 'none' ? 'Đóng Gói' :
              aggFinish?.status !== 'none' ? 'Lắp Ráp' :
                aggPaint?.status !== 'none' ? 'Sơn' :
                  aggWhite?.status !== 'none' ? 'Hàng Trắng' : null;

            if (lastActiveStage) {
              const stageStatus = aggPack?.status !== 'none' ? aggPack?.status :
                aggFinish?.status !== 'none' ? aggFinish?.status :
                  aggPaint?.status !== 'none' ? aggPaint?.status :
                    aggWhite?.status;
              const resultText = stageStatus === 'pass' ? 'PASS' : stageStatus === 'fail' ? 'FAIL' : 'CHỜ KIỂM';
              const statusText = `QC ${lastActiveStage}: ${resultText}`;
              syncUpdateData.status = statusText;

              const history = [...(projEntry.statusHistory || [])];
              history.push(`${statusText} (Đồng bộ từ Phiếu kiểm - ${displayLabel})|${Date.now()}`);
              syncUpdateData.statusHistory = history;
            }

            updates.push(updateProjectModule(projEntry.id, syncUpdateData, projEntry.projectCode).then(() => {
              syncProjectEntry(projEntry.id, syncUpdateData);
            }));
            syncCount++;
          }
        }
      }

      await Promise.all(updates);
      alert(`Đã đồng bộ QC cho ${syncCount} cấu kiện vào dự án.`);
    } catch (err) {
      console.error("Lỗi đồng bộ:", err);
      alert("Đã xảy ra lỗi khi đồng bộ.");
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteTicket = (e: React.MouseEvent, ticket: any) => {
    e.stopPropagation(); // Ngăn hiển thị chi tiết hoặc chuyển đổi
    setTicketToDelete(ticket);
  };

  const executeDeleteTicket = async (ticketParam?: any) => {
    const ticketTarget = (ticketParam && ticketParam.id) ? ticketParam : ticketToDelete;
    if (!ticketTarget) return;
    const ticket = ticketTarget;

    if (!ticket.id) {
      alert("Không thể xóa phiếu vì không tìm thấy mã phiếu (ID) hợp lệ.");
      return;
    }

    try {
      setLoading(true);
      const displayLabel = userProfile?.ten_that ? `${userProfile.ten_that}` : (user?.displayName || user?.email || 'Unknown');
      const stage = QC_STAGES.find(s => s.id === ticket.stage);

      if (!stage) {
        // Stage không hợp lệ → bỏ qua revert modules, xóa ticket trực tiếp
        await deleteDoc(doc(db, 'qc_tickets', ticket.id));
        await addDoc(collection(db, 'activities'), {
          userId: user?.uid,
          userName: displayLabel,
          userEmail: user?.email || '',
          action: 'Xóa Phiếu QC',
          details: `Đã xóa phiếu chờ kiểm ${ticket.name} của dự án ${ticket.projectCode} (stage không hợp lệ, bỏ qua revert)`,
          projectCode: ticket.projectCode,
          timestamp: serverTimestamp()
        });
        if (selectedTicketId === ticket.id) {
          setSelectedTicketId(null);
        }
        return;
      }

      const stageField = stage.field;
      const stageLabel = stage.label;
      const historyTextToFilterOut = stageLabel.toLowerCase();

      // 1. Cập nhật từng module nằm trong phiếu này — chỉ xóa pending, giữ pass/fail
      const updates = (ticket.modules || []).map(async (m: any) => {
        const updateData: any = {};

        const existingModule = resolveModule(m);
        if (existingModule) {
          // Chỉ xóa history liên quan đến pending, giữ lại pass/fail
          const remainingHistory = (existingModule.statusHistory || []).filter((item: string) => {
            const itemLower = item.toLowerCase();
            // Chỉ xóa nếu chứa "chờ kiểm" (pending) ở stage này
            const isPendingForStage = itemLower.includes('chờ kiểm') &&
              (itemLower.includes(historyTextToFilterOut) ||
                (ticket.stage === 'white' && itemLower.includes('hàng sơn')));
            return !isPendingForStage;
          });

          updateData.statusHistory = remainingHistory;

          // Tính lại status từ history còn lại
          if (remainingHistory.length > 0) {
            const lastItem = remainingHistory[remainingHistory.length - 1];
            const lastStatus = lastItem.split('|')[0] || 'Chưa nhận';
            updateData.status = lastStatus;
          } else {
            updateData.status = 'Chưa nhận';
          }

          if (existingModule.instances && existingModule.instances.length > 0) {
            updateData.instances = existingModule.instances.map((inst: any) => {
              const newInst = { ...inst };
              // Chỉ xóa trạng thái pending, giữ nguyên pass/fail
              const stagesToClean = ticket.stage === 'white'
                ? ['qcWhite', 'qcPaint', 'qcFinish', 'qcPack']
                : [stageField];

              stagesToClean.forEach(field => {
                const stageData = (newInst as any)[field];
                if (stageData && stageData.status === 'pending') {
                  delete (newInst as any)[field];
                }
              });

              // Chỉ xóa qcLogs có status 'pending'
              if (newInst.qcLogs && Array.isArray(newInst.qcLogs)) {
                newInst.qcLogs = newInst.qcLogs.filter((log: any) => {
                  if (ticket.stage === 'white') {
                    const isWhiteStage = ['white', 'paint', 'finish', 'pack'].includes(log.stage);
                    return !(isWhiteStage && log.status === 'pending');
                  }
                  return !(log.stage === ticket.stage && log.status === 'pending');
                });
              }
              return newInst;
            });
          }
        }

        await updateProjectModule(m.id, updateData, m.projectCode);
        syncProjectEntry(m.id, updateData);

        // Khôi phục đồng bộ "Đợt di động" nếu có
        try {
          const shelfModuleCode = makeShelfModuleCode(m.moduleCode);
          const matchedShelf = projectEntries.find(e =>
            e.projectCode === ticket.projectCode &&
            e.moduleCode === shelfModuleCode
          );
          if (matchedShelf) {
            const shelfUpdateData: any = {
              [stageField]: deleteField()
            };
            if (ticket.stage === 'white') {
              shelfUpdateData.qcPaint = deleteField();
            }

            const shelfRemainingHistory = (matchedShelf.statusHistory || []).filter((item: string) => {
              const itemLower = item.toLowerCase();
              const matchesStage = itemLower.includes(historyTextToFilterOut) ||
                (ticket.stage === 'white' && itemLower.includes('hàng sơn'));
              return !matchesStage;
            });

            shelfUpdateData.statusHistory = shelfRemainingHistory;

            if (shelfRemainingHistory.length > 0) {
              const lastItem = shelfRemainingHistory[shelfRemainingHistory.length - 1];
              const lastStatus = lastItem.split('|')[0] || 'Chưa nhận';
              shelfUpdateData.status = lastStatus;
            } else {
              shelfUpdateData.status = 'Chưa nhận';
            }

            await updateProjectModule(matchedShelf.id, shelfUpdateData, matchedShelf.projectCode);
          }
        } catch (shelfErr) {
          console.error("Lỗi hoàn tác Đợt di động:", shelfErr);
        }

        // Log hoạt động từng phần
        await addDoc(collection(db, 'activities'), {
          userId: user?.uid,
          userName: displayLabel,
          userEmail: user?.email || '',
          action: 'Hoàn tác QC (Xóa Phiếu)',
          details: `Hoàn tác trạng thái sản xuất cho Module ${m.moduleCode} do xóa phiếu kiểm ${ticket.name}`,
          projectCode: ticket.projectCode,
          moduleCode: m.moduleCode,
          timestamp: serverTimestamp()
        });
      });

      await Promise.all(updates);

      // 2. Xóa tài liệu Phiếu kiểm định
      await deleteDoc(doc(db, 'qc_tickets', ticket.id));

      // 3. Toàn cục: log xoá phiếu
      await addDoc(collection(db, 'activities'), {
        userId: user?.uid,
        userName: displayLabel,
        userEmail: user?.email || '',
        action: 'Xóa Phiếu QC',
        details: `Đã xóa phiếu chờ kiểm ${ticket.name} của dự án ${ticket.projectCode}`,
        projectCode: ticket.projectCode,
        timestamp: serverTimestamp()
      });

      // Reset
      if (selectedTicketId === ticket.id) {
        setSelectedTicketId(null);
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, 'qc_tickets');
    } finally {
      setLoading(false);
      setTicketToDelete(null);
    }
  };

  const handleCloseTicket = (ticket: any) => {
    if (!hasRole('admin')) return;
    setTicketToClose(ticket);
    setCloseMode(null);
  };

  const executeCloseTicket = async () => {
    if (!ticketToClose || !closeMode) return;
    const ticket = ticketToClose;
    if (!hasRole('admin')) return;

    try {
      setLoading(true);
      const stage = QC_STAGES.find(s => s.id === ticket.stage);
      if (!stage) {
        throw new Error("Công đoạn không hợp lệ");
      }

      const stageField = stage.field;
      const stageLabel = stage.label;
      const historyTextToFilterOut = stageLabel.toLowerCase();
      const displayLabel = userProfile?.ten_that ? `${userProfile.ten_that}` : (user?.displayName || user?.email || 'Unknown');

      // 1. Lọc ra danh sách các module chưa QC trong phiếu (dùng getModuleQcAggregate để lấy trạng thái từ instances)
      // Bao gồm cả module 'fail' để đảm bảo instance được cập nhật khi đóng phiếu
      const uninspectedModules = (ticket.modules || []).filter((m: any) => {
        const projectModule = resolveModule(m);
        if (!projectModule) return true;
        const agg = getModuleQcAggregate(projectModule, ticket.stage as any);
        const currentRealStatus = agg?.status || 'pending';
        return currentRealStatus !== 'pass';
      });

      if (closeMode === 'passAll') {
        // MODE: Pass hết — ghi pass cho tất cả module chưa QC
        const passUpdates = uninspectedModules.map(async (m: any) => {
          const updatedInstances = getModuleInstances(resolveModule(m) || m).map((inst: any) => ({
            ...inst,
            [stageField]: {
              status: 'pass',
              by: displayLabel,
              date: new Date(),
              notes: 'Đóng phiếu — Auto Pass',
              photos: [],
            }
          }));

          const history = [...((resolveModule(m) || m).statusHistory || [])];
          history.push(`QC ${stageLabel}: PASS - Đóng phiếu (${displayLabel})|${Date.now()}`);

          await updateProjectModule(m.id, {
            instances: updatedInstances,
            statusHistory: history,
            status: `QC ${stageLabel}: PASS - Đóng phiếu`,
          }, m.projectCode);
          syncProjectEntry(m.id, { instances: updatedInstances, statusHistory: history, status: `QC ${stageLabel}: PASS - Đóng phiếu` });
        });

        await Promise.all(passUpdates);
      } else {
        // MODE: Hoàn trạng thái — khôi phục trạng thái mộc cho module chưa QC
        const revertUpdates = uninspectedModules.map(async (m: any) => {
          const updateData: any = {};

          const existingModule = resolveModule(m);
          if (existingModule) {
            const remainingHistory = (existingModule.statusHistory || []).filter((item: string) => {
              const itemLower = item.toLowerCase();
              const matchesStage = itemLower.includes(historyTextToFilterOut) ||
                (ticket.stage === 'white' && itemLower.includes('hàng sơn'));
              return !matchesStage;
            });

            updateData.statusHistory = remainingHistory;

            if (remainingHistory.length > 0) {
              const lastItem = remainingHistory[remainingHistory.length - 1];
              const lastStatus = lastItem.split('|')[0] || 'Chưa nhận';
              updateData.status = lastStatus;
            } else {
              updateData.status = 'Chưa nhận';
            }
          }

          // Reset instances cho module chưa QC
          const currentInstances = getModuleInstances(existingModule || m);
          const resetInstances = currentInstances.map((inst: any) => ({
            ...inst,
            [stageField]: null,
          }));
          updateData.instances = resetInstances;

          await updateProjectModule(m.id, updateData, m.projectCode);
          syncProjectEntry(m.id, updateData);

          // Khôi phục Đợt di động
          try {
            const shelfModuleCode = makeShelfModuleCode(m.moduleCode);
            const matchedShelf = projectEntries.find(e =>
              e.projectCode === ticket.projectCode &&
              e.moduleCode === shelfModuleCode
            );
            if (matchedShelf) {
              const shelfUpdateData: any = {
                [stageField]: deleteField()
              };

              const shelfRemainingHistory = (matchedShelf.statusHistory || []).filter((item: string) => {
                const itemLower = item.toLowerCase();
                const matchesStage = itemLower.includes(historyTextToFilterOut) ||
                  (ticket.stage === 'white' && itemLower.includes('hàng sơn'));
                return !matchesStage;
              });
              shelfUpdateData.statusHistory = shelfRemainingHistory;
              if (shelfRemainingHistory.length > 0) {
                shelfUpdateData.status = shelfRemainingHistory[shelfRemainingHistory.length - 1].split('|')[0] || 'Chưa nhận';
              } else {
                shelfUpdateData.status = 'Chưa nhận';
              }
              const shelfInstances = getModuleInstances(matchedShelf);
              shelfUpdateData.instances = shelfInstances.map((inst: any) => ({ ...inst, [stageField]: null }));
              await updateProjectModule(matchedShelf.id, shelfUpdateData, matchedShelf.projectCode);
            }
          } catch (shelfErr) {
            console.error("Lỗi hoàn tác Đợt di động:", shelfErr);
          }
        });

        await Promise.all(revertUpdates);
      }

      // Log hoạt động
      await addDoc(collection(db, 'activities'), {
        userId: user?.uid,
        userName: displayLabel,
        userEmail: user?.email || '',
        action: 'Đóng Phiếu QC',
        details: closeMode === 'passAll'
          ? `Admin đã đóng phiếu QC ${ticket.name} — Đã tự động PASS ${uninspectedModules.length} cấu kiện chưa kiểm`
          : `Admin đã đóng phiếu QC ${ticket.name} — Hoàn tác trạng thái ${uninspectedModules.length} cấu kiện chưa QC`,
        projectCode: ticket.projectCode,
        timestamp: serverTimestamp()
      });

      // Cập nhật ticket
      const updatedTicketModules = (ticket.modules || []).map((m: any) => ({
        ...m,
        status: closeMode === 'passAll' ? 'pass' : 'closed',
      }));

      await updateDoc(doc(db, 'qc_tickets', ticket.id), cleanUndefinedFields({
        modules: updatedTicketModules,
        status: 'completed'
      }));

      setTicketToClose(null);
      setCloseMode(null);
    } catch (err: any) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const getAddableModulesForTicket = (ticket: any) => {
    if (!ticket) return [];
    const stage = QC_STAGES.find(s => s.id === ticket.stage);
    if (!stage) return [];

    const rawEntriesOfProject = [...projectEntries]
      .filter(e => e.projectCode === ticket.projectCode)
      .sort((a, b) => (a.sortIndex || 0) - (b.sortIndex || 0));

    const sortedTree = buildAndSortTree(rawEntriesOfProject);

    return sortedTree.filter(entry => {
      const entryType = getEntryTypeLocal(entry.moduleCode, entry);
      if (entryType === 'Đợt di động') {
        return false;
      }

      // Không được nằm trong phiếu hiện tại
      const alreadyInTicket = (ticket.modules || []).some((m: any) => m.id === entry.id);
      if (alreadyInTicket) return false;

      // Không được đang ở trạng thái chờ kiểm hoặc đã pass ở công đoạn này từ các phiếu khác hoặc đơn lẻ
      const currDbModule = allDbModules.find(m => m.id === entry.id || m.moduleCode === entry.moduleCode);
      const currStageData = currDbModule ? (currDbModule as any)[stage.field] : null;
      if (currStageData && (currStageData.status === 'pending' || currStageData.status === 'pass')) {
        return false;
      }

      if (stage.requiredPrev) {
        const prevStage = currDbModule ? (currDbModule as any)[stage.requiredPrev] : null;
        const isThungBypass = entryType === 'Thùng' && stage.requiredPrev === 'qcPaint';
        const isCthtPaintBypass = ticket.stage === 'paint' && ['CTHT', 'Cánh', 'Mặt HK'].includes(entryType);
        const isCthtFinishBypass = ticket.stage === 'finish' && entryType === 'CTHT';

        if (!isThungBypass && !isCthtPaintBypass && !isCthtFinishBypass && (!prevStage || prevStage.status !== 'pass')) {
          return false;
        }
      }

      return true;
    });
  };

  const handleRemoveModuleFromTicket = async (ticket: any, moduleId: string) => {
    try {
      setLoading(true);
      const stage = QC_STAGES.find(s => s.id === ticket.stage);
      if (!stage) return;

      const stageField = stage.field;
      const stageLabel = stage.label;
      const historyTextToFilterOut = stageLabel.toLowerCase();
      const displayLabel = userProfile?.ten_that ? `${userProfile.ten_that}` : (user?.displayName || user?.email || 'Unknown');

      const targetModule = ticket.modules.find((m: any) => m.id === moduleId);
      if (!targetModule) return;

      // 1. Cập nhật trạng thái module về mộc
      const updateData: any = {
        [stageField]: deleteField()
      };

      if (ticket.stage === 'white') {
        updateData.qcStatus = deleteField();
        updateData.qcNotes = deleteField();
        updateData.qcPhotos = deleteField();
        updateData.qcDate = deleteField();
        updateData.qcBy = deleteField();
        updateData.qcRole = deleteField();
        updateData.qcPaint = deleteField();
      }

      const existingModule = projectEntries.find(e => e.id === getBaseModuleId(moduleId));
      if (existingModule) {
        const remainingHistory = (existingModule.statusHistory || []).filter((item: string) => {
          const itemLower = item.toLowerCase();
          const matchesStage = itemLower.includes(historyTextToFilterOut) ||
            (ticket.stage === 'white' && itemLower.includes('hàng sơn'));
          return !matchesStage;
        });

        updateData.statusHistory = remainingHistory;
        if (remainingHistory.length > 0) {
          const lastItem = remainingHistory[remainingHistory.length - 1];
          const lastStatus = lastItem.split('|')[0] || 'Chưa nhận';
          updateData.status = lastStatus;
        } else {
          updateData.status = 'Chưa nhận';
        }

        if (existingModule.instances && existingModule.instances.length > 0) {
          updateData.instances = existingModule.instances.map((inst: any) => {
            const newInst = { ...inst };
            if (ticket.stage === 'white') {
              delete newInst.qcWhite;
              delete newInst.qcPaint;
              delete newInst.qcFinish;
              delete newInst.qcPack;
            } else {
              delete newInst[stageField];
            }

            if (newInst.qcLogs && Array.isArray(newInst.qcLogs)) {
              if (ticket.stage === 'white') {
                newInst.qcLogs = newInst.qcLogs.filter((log: any) =>
                  log.stage !== 'white' && log.stage !== 'paint' && log.stage !== 'finish' && log.stage !== 'pack'
                );
              } else {
                newInst.qcLogs = newInst.qcLogs.filter((log: any) => log.stage !== ticket.stage);
              }
            }
            return newInst;
          });
        }
      }

      await updateProjectModule(getBaseModuleId(moduleId), updateData, existingModule?.projectCode);
      syncProjectEntry(getBaseModuleId(moduleId), updateData);

      // 1b. Khôi phục đồng bộ "Đợt di động" nếu có
      try {
        const shelfModuleCode = makeShelfModuleCode(targetModule.moduleCode);
        const matchedShelf = projectEntries.find(e =>
          e.projectCode === ticket.projectCode &&
          e.moduleCode === shelfModuleCode
        );
        if (matchedShelf) {
          const shelfUpdateData: any = {
            [stageField]: deleteField()
          };

          const shelfRemainingHistory = (matchedShelf.statusHistory || []).filter((item: string) => {
            const itemLower = item.toLowerCase();
            const matchesStage = itemLower.includes(historyTextToFilterOut) ||
              (ticket.stage === 'white' && itemLower.includes('hàng sơn'));
            return !matchesStage;
          });

          shelfUpdateData.statusHistory = shelfRemainingHistory;

          if (shelfRemainingHistory.length > 0) {
            const lastItem = shelfRemainingHistory[shelfRemainingHistory.length - 1];
            const lastStatus = lastItem.split('|')[0] || 'Chưa nhận';
            shelfUpdateData.status = lastStatus;
          } else {
            shelfUpdateData.status = 'Chưa nhận';
          }

          await updateProjectModule(matchedShelf.id, shelfUpdateData, matchedShelf.projectCode);
        }
      } catch (shelfErr) {
        console.error("Lỗi hoàn tác Đợt di động khi xóa cấu kiện khỏi phiếu:", shelfErr);
      }

      // Log hoạt động
      await addDoc(collection(db, 'activities'), {
        userId: user?.uid,
        userName: displayLabel,
        userEmail: user?.email || '',
        action: 'Xóa Cấu Kiện khỏi Phiếu',
        details: `Xóa cấu kiện ${targetModule.moduleCode} khỏi phiếu chờ kiểm ${ticket.name} (hoàn tác trạng thái về trước đó)`,
        projectCode: ticket.projectCode,
        moduleCode: targetModule.moduleCode,
        timestamp: serverTimestamp()
      });

      // 2. Cập nhật tài liệu Phiếu kiểm định — giữ phiếu trống nếu xóa hết module
      const updatedModules = ticket.modules.filter((m: any) => m.id !== moduleId);

      const passModules = updatedModules.filter((m: any) => m.status === 'pass').length;
      const failModules = updatedModules.filter((m: any) => m.status === 'fail').length;
      const inspectedCount = passModules + failModules;
      const allInspected = updatedModules.length > 0 && inspectedCount === updatedModules.length;
      const ticketStatus = allInspected ? 'completed' : 'pending';

      await updateDoc(doc(db, 'qc_tickets', ticket.id), cleanUndefinedFields({
        modules: updatedModules,
        status: ticketStatus
      }));

    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, 'qc_tickets');
    } finally {
      setLoading(false);
    }
  };

  const handleCompleteTicketWithQC = async (ticket: any) => {
    try {
      setLoading(true);
      const stage = QC_STAGES.find(s => s.id === ticket.stage);
      if (!stage) return;

      const stageField = stage.field;
      const stageLabel = stage.label;
      const historyTextToFilterOut = stageLabel.toLowerCase();
      const displayLabel = userProfile?.ten_that ? `${userProfile.ten_that}` : (user?.displayName || user?.email || 'Unknown');

      // Resolve trạng thái QC thực tế từ instance data thay vì dùng raw status từ phiếu
      const resolvedTicketModules = (ticket.modules || []).map((m: any) => {
        const actualModuleId = m.moduleId || m.id;
        const projectModule = projectEntries.find(e => e.id === getBaseModuleId(actualModuleId));
        if (!projectModule) return { ...m, _resolvedStatus: 'pending' };

        if (m.instanceIndex != null) {
          const instances = getModuleInstances(projectModule);
          const targetInst = instances.find((inst: any) => inst.instanceIndex === m.instanceIndex);
          if (targetInst) {
            const instQcData = (targetInst as any)[stageField];
            return { ...m, _resolvedStatus: instQcData?.status || 'pending' };
          }
        }

        const agg = getModuleQcAggregate(projectModule, stage.id as any);
        return { ...m, _resolvedStatus: agg?.status || 'pending' };
      });

      const checkedModules = resolvedTicketModules
        .filter((m: any) => m._resolvedStatus === 'pass' || m._resolvedStatus === 'fail')
        .map(({ _resolvedStatus, ...rest }: any) => rest);
      const uninspectedModules = resolvedTicketModules.filter((m: any) => m._resolvedStatus !== 'pass' && m._resolvedStatus !== 'fail');

      const revertUpdates = uninspectedModules.map(async (m: any) => {
        const updateData: any = {
          [stageField]: deleteField()
        };

        if (ticket.stage === 'white') {
          updateData.qcStatus = deleteField();
          updateData.qcNotes = deleteField();
          updateData.qcPhotos = deleteField();
          updateData.qcDate = deleteField();
          updateData.qcBy = deleteField();
          updateData.qcRole = deleteField();
          updateData.qcPaint = deleteField();
        }

        const actualModuleId = m.moduleId || m.id;
        const existingModule = projectEntries.find(e => e.id === getBaseModuleId(actualModuleId));
        if (existingModule) {
          const remainingHistory = (existingModule.statusHistory || []).filter((item: string) => {
            const itemLower = item.toLowerCase();
            const matchesStage = itemLower.includes(historyTextToFilterOut) ||
              (ticket.stage === 'white' && itemLower.includes('hàng sơn'));
            return !matchesStage;
          });

          updateData.statusHistory = remainingHistory;
          if (remainingHistory.length > 0) {
            const lastItem = remainingHistory[remainingHistory.length - 1];
            const lastStatus = lastItem.split('|')[0] || 'Chưa nhận';
            updateData.status = lastStatus;
          } else {
            updateData.status = 'Chưa nhận';
          }

          if (existingModule.instances && existingModule.instances.length > 0) {
            updateData.instances = existingModule.instances.map((inst: any) => {
              const newInst = { ...inst };
              const stagesToClean = ticket.stage === 'white'
                ? ['qcWhite', 'qcPaint', 'qcFinish', 'qcPack']
                : [stageField];

              stagesToClean.forEach(field => {
                const stageData = (newInst as any)[field];
                if (stageData && stageData.status === 'pending') {
                  delete (newInst as any)[field];
                }
              });

              if (newInst.qcLogs && Array.isArray(newInst.qcLogs)) {
                newInst.qcLogs = newInst.qcLogs.filter((log: any) => {
                  if (ticket.stage === 'white') {
                    const isWhiteStage = ['white', 'paint', 'finish', 'pack'].includes(log.stage);
                    return !(isWhiteStage && log.status === 'pending');
                  }
                  return !(log.stage === ticket.stage && log.status === 'pending');
                });
              }
              return newInst;
            });
          }
        }

        await updateProjectModule(getBaseModuleId(actualModuleId), updateData, existingModule?.projectCode);
        syncProjectEntry(getBaseModuleId(actualModuleId), updateData);

        try {
          const shelfModuleCode = makeShelfModuleCode(m.moduleCode);
          const matchedShelf = projectEntries.find(e =>
            e.projectCode === ticket.projectCode &&
            e.moduleCode === shelfModuleCode
          );
          if (matchedShelf) {
            const shelfUpdateData: any = {
              [stageField]: deleteField()
            };

            const shelfRemainingHistory = (matchedShelf.statusHistory || []).filter((item: string) => {
              const itemLower = item.toLowerCase();
              const matchesStage = itemLower.includes(historyTextToFilterOut) ||
                (ticket.stage === 'white' && itemLower.includes('hàng sơn'));
              return !matchesStage;
            });

            shelfUpdateData.statusHistory = shelfRemainingHistory;

            if (shelfRemainingHistory.length > 0) {
              const lastItem = shelfRemainingHistory[shelfRemainingHistory.length - 1];
              const lastStatus = lastItem.split('|')[0] || 'Chưa nhận';
              shelfUpdateData.status = lastStatus;
            } else {
              shelfUpdateData.status = 'Chưa nhận';
            }

            await updateProjectModule(matchedShelf.id, shelfUpdateData, matchedShelf.projectCode);
          }
        } catch (shelfErr) {
          console.error("Lỗi hoàn tác Đợt di động khi hoàn tất phiếu:", shelfErr);
        }
      });

      await Promise.all(revertUpdates);

      await addDoc(collection(db, 'activities'), {
        userId: user?.uid,
        userName: displayLabel,
        userEmail: user?.email || '',
        action: 'Hoàn Tất Phiếu QC',
        details: `Hoàn tất phiếu QC ${ticket.name} — Đã lọc bỏ ${uninspectedModules.length} cấu kiện chưa QC và giữ lại ${checkedModules.length} cấu kiện đã QC`,
        projectCode: ticket.projectCode,
        timestamp: serverTimestamp()
      });

      await updateDoc(doc(db, 'qc_tickets', ticket.id), cleanUndefinedFields({
        modules: checkedModules,
        status: 'completed'
      }));

      if (selectedTicketId === ticket.id) {
        setSelectedTicketId(null);
      }

    } catch (err: any) {
      console.error("Lỗi khi hoàn tất phiếu kiểm định:", err);
      handleFirestoreError(err, OperationType.UPDATE, 'qc_tickets');
    } finally {
      setLoading(false);
    }
  };

  const handleEndDay = async () => {
    const pendingTickets = filteredTicketGroups.pending;
    if (pendingTickets.length === 0) {
      alert("Không có phiếu kiểm định nào chưa hoàn thành!");
      return;
    }

    const confirmEnd = window.confirm(
      `Bạn có chắc chắn muốn kết thúc ngày làm việc? Hệ thống sẽ tự động hoàn tất ${pendingTickets.length} phiếu QC chưa kiểm xong. Các cấu kiện chưa QC trong các phiếu này sẽ tự động được xóa khỏi phiếu và hoàn trả về trạng thái mộc.`
    );
    if (!confirmEnd) return;

    try {
      setLoading(true);
      const displayLabel = userProfile?.ten_that ? `${userProfile.ten_that}` : (user?.displayName || user?.email || 'Unknown');

      for (const ticket of pendingTickets) {
        const stage = QC_STAGES.find(s => s.id === ticket.stage);
        if (!stage) continue;

        const stageField = stage.field;
        const stageLabel = stage.label;
        const historyTextToFilterOut = stageLabel.toLowerCase();

        // Resolve trạng thái QC thực tế từ instance data
        const resolvedTicketModules = (ticket.modules || []).map((m: any) => {
          const actualModuleId = m.moduleId || m.id;
          const projectModule = projectEntries.find(e => e.id === getBaseModuleId(actualModuleId));
          if (!projectModule) return { ...m, _resolvedStatus: 'pending' };

          if (m.instanceIndex != null) {
            const instances = getModuleInstances(projectModule);
            const targetInst = instances.find((inst: any) => inst.instanceIndex === m.instanceIndex);
            if (targetInst) {
              const instQcData = (targetInst as any)[stageField];
              return { ...m, _resolvedStatus: instQcData?.status || 'pending' };
            }
          }

          const agg = getModuleQcAggregate(projectModule, stage.id as any);
          return { ...m, _resolvedStatus: agg?.status || 'pending' };
        });

        const checkedModules = resolvedTicketModules
          .filter((m: any) => m._resolvedStatus === 'pass' || m._resolvedStatus === 'fail')
          .map(({ _resolvedStatus, ...rest }: any) => rest);
        const uninspectedModules = resolvedTicketModules.filter((m: any) => m._resolvedStatus !== 'pass' && m._resolvedStatus !== 'fail');

        const revertUpdates = uninspectedModules.map(async (m: any) => {
          const updateData: any = {
            [stageField]: deleteField()
          };

          if (ticket.stage === 'white') {
            updateData.qcStatus = deleteField();
            updateData.qcNotes = deleteField();
            updateData.qcPhotos = deleteField();
            updateData.qcDate = deleteField();
            updateData.qcBy = deleteField();
            updateData.qcRole = deleteField();
            updateData.qcPaint = deleteField();
          }

          const actualModuleId = m.moduleId || m.id;
          const existingModule = projectEntries.find(e => e.id === getBaseModuleId(actualModuleId));
          if (existingModule) {
            const remainingHistory = (existingModule.statusHistory || []).filter((item: string) => {
              const itemLower = item.toLowerCase();
              const matchesStage = itemLower.includes(historyTextToFilterOut) ||
                (ticket.stage === 'white' && itemLower.includes('hàng sơn'));
              return !matchesStage;
            });

            updateData.statusHistory = remainingHistory;
            if (remainingHistory.length > 0) {
              const lastItem = remainingHistory[remainingHistory.length - 1];
              const lastStatus = lastItem.split('|')[0] || 'Chưa nhận';
              updateData.status = lastStatus;
            } else {
              updateData.status = 'Chưa nhận';
            }

            if (existingModule.instances && existingModule.instances.length > 0) {
              updateData.instances = existingModule.instances.map((inst: any) => {
                const newInst = { ...inst };
                if (ticket.stage === 'white') {
                  delete newInst.qcWhite;
                  delete newInst.qcPaint;
                  delete newInst.qcFinish;
                  delete newInst.qcPack;
                } else {
                  delete newInst[stageField];
                }

                if (newInst.qcLogs && Array.isArray(newInst.qcLogs)) {
                  if (ticket.stage === 'white') {
                    newInst.qcLogs = newInst.qcLogs.filter((log: any) =>
                      log.stage !== 'white' && log.stage !== 'paint' && log.stage !== 'finish' && log.stage !== 'pack'
                    );
                  } else {
                    newInst.qcLogs = newInst.qcLogs.filter((log: any) => log.stage !== ticket.stage);
                  }
                }
                return newInst;
              });
            }
          }

          await updateProjectModule(getBaseModuleId(actualModuleId), updateData, existingModule?.projectCode);
          syncProjectEntry(getBaseModuleId(actualModuleId), updateData);

          try {
            const shelfModuleCode = makeShelfModuleCode(m.moduleCode);
            const matchedShelf = projectEntries.find(e =>
              e.projectCode === ticket.projectCode &&
              e.moduleCode === shelfModuleCode
            );
            if (matchedShelf) {
              const shelfUpdateData: any = {
                [stageField]: deleteField()
              };

              const shelfRemainingHistory = (matchedShelf.statusHistory || []).filter((item: string) => {
                const itemLower = item.toLowerCase();
                const matchesStage = itemLower.includes(historyTextToFilterOut) ||
                  (ticket.stage === 'white' && itemLower.includes('hàng sơn'));
                return !matchesStage;
              });

              shelfUpdateData.statusHistory = shelfRemainingHistory;

              if (shelfRemainingHistory.length > 0) {
                const lastItem = shelfRemainingHistory[shelfRemainingHistory.length - 1];
                const lastStatus = lastItem.split('|')[0] || 'Chưa nhận';
                shelfUpdateData.status = lastStatus;
              } else {
                shelfUpdateData.status = 'Chưa nhận';
              }

              await updateProjectModule(matchedShelf.id, shelfUpdateData, matchedShelf.projectCode);
            }
          } catch (shelfErr) {
            console.error("Lỗi hoàn tác Đợt di động khi Kết thúc ngày:", shelfErr);
          }
        });

        await Promise.all(revertUpdates);

        await updateDoc(doc(db, 'qc_tickets', ticket.id), cleanUndefinedFields({
          modules: checkedModules,
          status: 'completed'
        }));
      }

      await addDoc(collection(db, 'activities'), {
        userId: user?.uid,
        userName: displayLabel,
        userEmail: user?.email || '',
        action: 'Kết Thúc Ngày QC',
        details: `Người dùng đã Kết Thúc Ngày — Đã tự động hoàn tất ${pendingTickets.length} phiếu QC chưa kiểm xong`,
        timestamp: serverTimestamp()
      });

      setSelectedTicketId(null);
      alert(`Đã hoàn tất kết thúc ngày! Đã tự động xử lý ${pendingTickets.length} phiếu.`);
    } catch (err: any) {
      console.error("Lỗi khi kết thúc ngày:", err);
      alert("Đã có lỗi xảy ra khi kết thúc ngày!");
    } finally {
      setLoading(false);
    }
  };

  const handleAddModuleToTicket = async (ticket: any, moduleToAdd: ProjectEntry) => {
    try {
      setLoading(true);
      const stage = QC_STAGES.find(s => s.id === ticket.stage);
      if (!stage) return;

      const stageField = stage.field;
      const displayLabel = userProfile?.ten_that ? `${userProfile.ten_that}` : (user?.displayName || user?.email || 'Unknown');

      // 1. Cập nhật trạng thái module thành 'pending'
      const updateData: any = {
        [`${stageField}.status`]: 'pending',
        [`${stageField}.by`]: displayLabel,
        [`${stageField}.date`]: serverTimestamp(),
      };

      // Set instance-level QC status for all instances
      const existingInstances = getModuleInstances(moduleToAdd);
      if (existingInstances.length > 0) {
        updateData.instances = existingInstances.map(inst => ({
          ...inst,
          [stageField]: {
            status: 'pending',
            by: displayLabel,
            date: new Date(),
            notes: '',
            photos: [],
          }
        }));
      }

      const history = [...(moduleToAdd.statusHistory || [])];
      const statusText = `Chờ kiểm ${stage.label} (${displayLabel})`;
      history.push(`${statusText}|${Date.now()}`);
      updateData.statusHistory = history;
      updateData.status = statusText;

      await updateProjectModule(moduleToAdd.id, updateData, moduleToAdd.projectCode);
      syncProjectEntry(moduleToAdd.id, updateData);

      // Log hoạt động
      await addDoc(collection(db, 'activities'), {
        userId: user?.uid,
        userName: displayLabel,
        userEmail: user?.email || '',
        action: 'Bổ sung Cấu Kiện vào Phiếu',
        details: `Bổ sung cấu kiện ${moduleToAdd.moduleCode} vào phiếu chờ kiểm ${ticket.name}`,
        projectCode: ticket.projectCode,
        moduleCode: moduleToAdd.moduleCode,
        timestamp: serverTimestamp()
      });

      // 2. Cập nhật tài liệu Phiếu kiểm định
      const newModuleObj = {
        id: moduleToAdd.id,
        moduleCode: moduleToAdd.moduleCode,
        cluster: moduleToAdd.cluster || 'N/A',
        quantity: moduleToAdd.quantity || 1,
        status: 'pending',
        qcNotes: '',
        qcPhotos: []
      };

      // Thêm mới vào ĐẦU danh sách (để instance mới nhất hiển thị trên cùng)
      const updatedModules = [newModuleObj, ...(ticket.modules || [])];
      const passModules = updatedModules.filter((m: any) => m.status === 'pass').length;
      const failModules = updatedModules.filter((m: any) => m.status === 'fail').length;
      const inspectedCount = passModules + failModules;
      const allInspected = inspectedCount === updatedModules.length;
      const ticketStatus = allInspected ? 'completed' : 'pending';

      await updateDoc(doc(db, 'qc_tickets', ticket.id), cleanUndefinedFields({
        modules: updatedModules,
        status: ticketStatus
      }));

    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, 'qc_tickets');
    } finally {
      setLoading(false);
    }
  };

  const handleDeletePending = (e: React.MouseEvent, entry: ProjectEntry) => {
    e.stopPropagation(); // Ngăn hiển thị modal kiểm tra
    if (!hasRole('admin')) return;
    setDeleteConfirmEntry(entry);
  };

  const executeDeletePending = async () => {
    if (!deleteConfirmEntry) return;
    const entry = deleteConfirmEntry;

    try {
      setLoading(true);
      const pendingStages = QC_STAGES.filter(s => (entry as any)[s.field]?.status === 'pending');
      const updateData: any = {};

      pendingStages.forEach(s => {
        updateData[`${s.field}.status`] = 'none';
        updateData[`${s.field}.notes`] = '';
        updateData[`${s.field}.photos`] = [];
        updateData[`${s.field}.by`] = '';
      });

      const history = [...(entry.statusHistory || [])];
      const statusText = `Hủy yêu cầu chờ kiểm (${pendingStages.map(s => s.label).join(', ')})`;
      const displayLabel = userProfile?.ten_that ? `${userProfile.ten_that}` : (user?.displayName || user?.email || 'Admin');
      history.push(`${statusText} (${displayLabel})|${Date.now()}`);
      updateData.statusHistory = history;
      updateData.status = 'Chưa kiểm';

      await updateProjectModule(entry.id, updateData, entry.projectCode);
      syncProjectEntry(entry.id, updateData);

      // Log hoạt động
      await addDoc(collection(db, 'activities'), {
        userId: user?.uid,
        userName: displayLabel,
        userEmail: user?.email || '',
        action: 'Hủy chờ kiểm',
        details: `Hủy yêu cầu chờ kiểm cho module ${entry.moduleCode} (${pendingStages.map(s => s.label).join(', ')})`,
        projectCode: entry.projectCode,
        moduleCode: entry.moduleCode,
        timestamp: serverTimestamp()
      });

      if (activeModuleId === entry.id) {
        setActiveModuleId(null);
        setIsInspectionModalOpen(false);
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, 'projects');
    } finally {
      setLoading(false);
      setDeleteConfirmEntry(null);
    }
  };

  const resetInspectionState = (entry: ProjectEntry, stageId: 'white' | 'paint' | 'finish' | 'pack', optTicketModPassedQty?: number, overrideSelectedInstanceIds?: string[]) => {
    const stageField = QC_STAGES.find(s => s.id === stageId)?.field as keyof ProjectEntry;

    // Check if there is exactly 1 selected instance
    const instances = getModuleInstances(entry);
    const activeIds = overrideSelectedInstanceIds !== undefined ? overrideSelectedInstanceIds : selectedInstanceIds;
    // Đồng bộ selectedInstanceIds khi có override
    if (overrideSelectedInstanceIds !== undefined) {
      instanceSyncOverrideRef.current = true;
      setSelectedInstanceIds(overrideSelectedInstanceIds);
    }
    const singleSelectedId = activeIds.length === 1 ? activeIds[0] : null;
    const selectedInstance = singleSelectedId ? instances.find(inst => inst.id === singleSelectedId) : null;

    const stageData = selectedInstance && stageField
      ? (selectedInstance as any)[stageField]
      : (entry[stageField] as any);

    setQcStatus(stageData?.status === 'pending' ? 'none' : (stageData?.status || 'none'));
    setQcNotes(stageData?.notes || '');
    setQcPhotos(stageData?.photos || []);
    setCheckedCriteria(stageData?.checkedCriteria || {});
    setCriterionPhotos(stageData?.criterionPhotos || {});
    const qty = optTicketModPassedQty !== undefined
      ? optTicketModPassedQty
      : (stageData?.passedQty || (stageData?.status === 'pass' ? entry.quantity : 0) || 0);
    setQcInspectedQty(qty ? String(qty) : '');
  };

  const handleManualAdd = async () => {
    const canAddStageId = getCanAddStage();
    if (!manualCode.trim() || !canAddStageId) return;

    if (!selectedProjectCode) {
      setScanError('Vui lòng chọn dự án trước.');
      return;
    }

    let inputCode = manualCode.trim();
    if (inputCode.includes("----")) {
      inputCode = inputCode.split("----")[0].trim();
    }

    const entry = projectEntries.find(e =>
      (e.moduleCode || '').toLowerCase() === (inputCode || '').toLowerCase() &&
      e.projectCode === selectedProjectCode
    );

    if (entry) {
      const added = addModuleToStaged(entry);
      if (added) {
        setManualCode('');
      }
    } else {
      setScanError(`Không tìm thấy module "${inputCode}" trong dự án đã chọn.`);
    }
  };

  const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    setUploading(true);
    const urls: string[] = [];
    const errors: string[] = [];

    const targetModule = allDbModules.find(m => m.id === activeModuleId) || inspectedModules.find(m => m.id === activeModuleId);
    const projCode = (targetModule?.projectCode || 'unknown').replace(/[^a-zA-Z0-9]/g, '_');
    const modCode = (targetModule?.moduleCode || 'module').replace(/[^a-zA-Z0-9]/g, '_');
    const stageName = activeInspectionStage || 'unknown';

    for (let i = 0; i < Array.from(files).length; i++) {
      const file = Array.from(files)[i];
      try {
        const suffix = Array.from(files).length > 1 ? `_${i + 1}` : '';
        const url = await uploadToCloudinary(file, 'QC', `${projCode}_${modCode}_${stageName}_chung${suffix}`);
        urls.push(url);
      } catch (uploadErr) {
        console.error("Lỗi upload một file: ", file.name, uploadErr);
        errors.push(uploadErr instanceof Error ? uploadErr.message : String(uploadErr));
      }
    }

    if (urls.length > 0) {
      setQcPhotos(prev => [...prev, ...urls]);
    } else {
      alert("Không thể tải lên ảnh nào. Chi tiết: " + errors.join("; "));
    }
    setUploading(false);
  };

  const removePhoto = (idx: number) => {
    setQcPhotos(prev => prev.filter((_, i) => i !== idx));
  };

  const saveQCResult = async () => {
    if (!activeModuleId || qcStatus === 'none' || !activeModule) return;
    setLoading(true);
    try {
      const displayLabel = userProfile?.ten_that ? `${userProfile.ten_that}` : (user?.displayName || user?.email || 'Unknown');
      const roleLabel = userProfile?.chuc_danh || 'NV QC';
      const stage = QC_STAGES.find(s => s.id === activeInspectionStage);

      const currentStage = QC_STAGES.find(s => s.id === activeInspectionStage);
      const stageField = currentStage?.field;
      if (!stageField) throw new Error('Không tìm thấy trường tương ứng với công đoạn kiểm QC.');

      const allGatheredPhotos = [
        ...qcPhotos,
        ...(Object.values(criterionPhotos).flat().filter(Boolean) as string[])
      ];

      if (activeModule.moduleType === 'bo') {
        const boPassedQty = parseInt(qcInspectedQty || '0', 10);
        if (isNaN(boPassedQty) || boPassedQty < 0) {
          alert("Số lượng đạt QC không hợp lệ!");
          setLoading(false);
          return;
        }
        if (boPassedQty > activeModule.quantity) {
          alert(`Số lượng đạt không vượt quá tổng số lượng của bộ (${activeModule.quantity})!`);
          setLoading(false);
          return;
        }

        const isFullyPassed = boPassedQty === activeModule.quantity;
        const resolvedStatus = isFullyPassed ? 'pass' : (boPassedQty > 0 ? 'pending' : qcStatus);

        // Ghi QC data vào instances thay vì module root
        const boInstances = getModuleInstances(activeModule);
        let finalBoInstances = boInstances;

        // Tạo instance mặc định nếu module chưa có instances
        if (boInstances.length === 0) {
          finalBoInstances = [{
            id: `${activeModule.moduleCode}|0`,
            instanceId: `${activeModule.moduleCode}|0`,
            instanceIndex: 0,
            tempLabelIndex: 0,
            delivered: false
          } as any];
        }

        // Ghi QC data cho từng instance: đánh dấu boPassedQty instance là pass, còn lại là fail
        finalBoInstances = finalBoInstances.map((inst, idx) => {
          const isInstPassed = idx < boPassedQty;
          const instStatus = isInstPassed ? 'pass' as const : 'fail' as const;

          let instQcWhite = inst.qcWhite;
          let instQcPaint = inst.qcPaint;
          let instQcFinish = inst.qcFinish;

          // Auto pass bù công đoạn trước cho instance
          if (isInstPassed) {
            const makeInstPassBuData = () => ({
              status: 'pass' as const,
              date: new Date(),
              by: displayLabel,
              notes: 'Tự động pass bù công đoạn trước',
              photos: [],
              checkedCriteria: {}
            });

            if (activeInspectionStage === 'paint') {
              if (!instQcWhite || instQcWhite.status !== 'pass') {
                instQcWhite = makeInstPassBuData();
              }
            } else if (activeInspectionStage === 'finish') {
              if (!instQcPaint || instQcPaint.status !== 'pass') {
                instQcPaint = makeInstPassBuData();
              }
              if (!instQcWhite || instQcWhite.status !== 'pass') {
                instQcWhite = makeInstPassBuData();
              }
            } else if (activeInspectionStage === 'pack') {
              if (!instQcFinish || instQcFinish.status !== 'pass') {
                instQcFinish = makeInstPassBuData();
              }
              if (!instQcPaint || instQcPaint.status !== 'pass') {
                instQcPaint = makeInstPassBuData();
              }
              if (!instQcWhite || instQcWhite.status !== 'pass') {
                instQcWhite = makeInstPassBuData();
              }
            }
          }

          const resultInst: any = {
            ...inst,
            [stageField]: {
              status: instStatus,
              date: new Date(),
              by: displayLabel,
              notes: qcNotes,
              photos: allGatheredPhotos,
              checkedCriteria: checkedCriteria,
              criterionPhotos: criterionPhotos,
              passedQty: isInstPassed ? 1 : 0
            },
            qcStatus: instStatus,
            qcDone: activeInspectionStage === 'pack' && isInstPassed,
            qcNotes: qcNotes,
            qcDate: new Date(),
            qcBy: displayLabel,
            qcPhotos: allGatheredPhotos,
          };

          if (instQcWhite !== undefined) resultInst.qcWhite = instQcWhite;
          if (instQcPaint !== undefined) resultInst.qcPaint = instQcPaint;
          if (instQcFinish !== undefined) resultInst.qcFinish = instQcFinish;

          return resultInst;
        });

        const updateData: any = {
          instances: finalBoInstances,
        };

        let autoWhiteBoData: any = null;
        let autoPaintBoData: any = null;
        let autoFinishBoData: any = null;

        if (resolvedStatus === 'pass') {
          const makePassBuData = () => ({
            status: 'pass',
            notes: 'Hệ thống tự động pass bù công đoạn trước',
            photos: [],
            date: new Date(),
            by: displayLabel,
            role: roleLabel,
            passedQty: activeModule.quantity
          });

          if (activeInspectionStage === 'paint') {
            if (getModuleQcAggregate(activeModule, 'white')?.status !== 'pass') {
              autoWhiteBoData = makePassBuData();
            }
          } else if (activeInspectionStage === 'finish') {
            if (getModuleQcAggregate(activeModule, 'paint')?.status !== 'pass') {
              autoPaintBoData = makePassBuData();
            }
            if (getModuleQcAggregate(activeModule, 'white')?.status !== 'pass') {
              autoWhiteBoData = makePassBuData();
            }
          } else if (activeInspectionStage === 'pack') {
            if (getModuleQcAggregate(activeModule, 'finish')?.status !== 'pass') {
              autoFinishBoData = makePassBuData();
            }
            if (getModuleQcAggregate(activeModule, 'paint')?.status !== 'pass') {
              autoPaintBoData = makePassBuData();
            }
            if (getModuleQcAggregate(activeModule, 'white')?.status !== 'pass') {
              autoWhiteBoData = makePassBuData();
            }
          }
        }

        const isStagePass = (activeInspectionStage === 'paint' || activeInspectionStage === 'finish') && resolvedStatus === 'pass';
        if (isStagePass) {
          const currentRecQty = activeModule.receivedQuantity || 0;
          if (currentRecQty < activeModule.quantity) {
            updateData.receivedQuantity = activeModule.quantity;
          }
        }

        const resultText = resolvedStatus === 'pass' ? 'PASS' : resolvedStatus === 'fail' ? 'FAIL' : 'CHỜ KIỂM';
        let statusText = `QC ${stage?.label}: ${resultText}`;
        if (!isFullyPassed) {
          statusText = `QC ${stage?.label}: Đạt ${boPassedQty}/${activeModule.quantity}`;
        }

        const history = [...(activeModule.statusHistory || [])];
        if (autoWhiteBoData) {
          history.push(`QC Hàng Trắng: PASS (Tự động Pass bù - ${displayLabel})|${Date.now()}`);
        }
        if (autoPaintBoData) {
          history.push(`QC Hàng Sơn: PASS (Tự động Pass bù - ${displayLabel})|${Date.now()}`);
        }
        if (autoFinishBoData) {
          history.push(`QC Hoàn Thiện: PASS (Tự động Pass bù - ${displayLabel})|${Date.now()}`);
        }
        if (isStagePass) {
          const currentRecQty = activeModule.receivedQuantity || 0;
          if (currentRecQty < activeModule.quantity) {
            history.push(`Giao Nhận - Đã nhận (Tự động theo QC Pass ${stage?.label} - ${displayLabel})|${Date.now()}`);
          }
        }
        history.push(`${statusText} (${displayLabel})|${Date.now()}`);
        updateData.statusHistory = history;
        updateData.status = statusText;

        await updateProjectModule(activeModule.id, cleanUndefinedFields(updateData), activeModule.projectCode);
        syncProjectEntry(activeModule.id, updateData);

        // Dong bo neu co qc_tickets
        if (selectedTicketId) {
          const ticket = [...filteredTicketGroups.pending, ...filteredTicketGroups.completed].find(t => t.id === selectedTicketId);
          if (ticket) {
            const updatedModules = ticket.modules.map((m: any) => {
              if (m.id === activeModuleId) {
                return {
                  ...m,
                  status: resolvedStatus,
                  passedQty: boPassedQty,
                  qcNotes: qcNotes,
                  qcPhotos: allGatheredPhotos
                };
              }
              return m;
            });

            const allInspected = updatedModules.every((m: any) => m.status === 'pass' || m.status === 'fail');
            const ticketStatus = allInspected ? 'completed' : 'pending';

            await updateDoc(doc(db, 'qc_tickets', selectedTicketId), cleanUndefinedFields({
              modules: updatedModules,
              status: ticketStatus
            }));
          }
        }

        closeInspectionModal();
        setLoading(false);
        return;
      }

      const instances = getModuleInstances(activeModule);
      const qty = instances.length;

      // Cập nhật trạng thái từng instance
      const updatedInstances = instances.map(inst => {
        if (selectedInstanceIds.includes(inst.id)) {
          const newQcLog = {
            stage: activeInspectionStage || 'finish',
            status: qcStatus === 'pass' ? 'pass' as const : qcStatus === 'fail' ? 'fail' as const : 'pending' as const,
            date: new Date(),
            by: displayLabel,
            notes: qcNotes,
            photos: allGatheredPhotos
          };

          const currentLogs = inst.qcLogs || [];
          let updatedLogs = [...currentLogs];

          // Filter out existing logs for activeInspectionStage
          updatedLogs = updatedLogs.filter(log => log.stage !== activeInspectionStage);

          let instQcWhite = inst.qcWhite;
          let instQcPaint = inst.qcPaint;
          let instQcFinish = inst.qcFinish;

          const isPassedNow = qcStatus === 'pass';

          if (isPassedNow) {
            const makeInstPassBuData = () => ({
              status: 'pass' as const,
              date: new Date(),
              by: displayLabel,
              notes: 'Tự động pass bù công đoạn trước',
              photos: [],
              checkedCriteria: {}
            });

            if (activeInspectionStage === 'paint') {
              if (!instQcWhite || instQcWhite.status !== 'pass') {
                instQcWhite = makeInstPassBuData();
                updatedLogs = updatedLogs.filter(log => log.stage !== 'white');
                updatedLogs.push({ stage: 'white', status: 'pass', date: new Date(), by: displayLabel, notes: 'Pass bù', photos: [] });
              }
            } else if (activeInspectionStage === 'finish') {
              if (!instQcPaint || instQcPaint.status !== 'pass') {
                instQcPaint = makeInstPassBuData();
                updatedLogs = updatedLogs.filter(log => log.stage !== 'paint');
                updatedLogs.push({ stage: 'paint', status: 'pass', date: new Date(), by: displayLabel, notes: 'Pass bù', photos: [] });
              }
              if (!instQcWhite || instQcWhite.status !== 'pass') {
                instQcWhite = makeInstPassBuData();
                updatedLogs = updatedLogs.filter(log => log.stage !== 'white');
                updatedLogs.push({ stage: 'white', status: 'pass', date: new Date(), by: displayLabel, notes: 'Pass bù', photos: [] });
              }
            } else if (activeInspectionStage === 'pack') {
              if (!instQcFinish || instQcFinish.status !== 'pass') {
                instQcFinish = makeInstPassBuData();
                updatedLogs = updatedLogs.filter(log => log.stage !== 'finish');
                updatedLogs.push({ stage: 'finish', status: 'pass', date: new Date(), by: displayLabel, notes: 'Pass bù', photos: [] });
              }
              if (!instQcPaint || instQcPaint.status !== 'pass') {
                instQcPaint = makeInstPassBuData();
                updatedLogs = updatedLogs.filter(log => log.stage !== 'paint');
                updatedLogs.push({ stage: 'paint', status: 'pass', date: new Date(), by: displayLabel, notes: 'Pass bù', photos: [] });
              }
              if (!instQcWhite || instQcWhite.status !== 'pass') {
                instQcWhite = makeInstPassBuData();
                updatedLogs = updatedLogs.filter(log => log.stage !== 'white');
                updatedLogs.push({ stage: 'white', status: 'pass', date: new Date(), by: displayLabel, notes: 'Pass bù', photos: [] });
              }
            }
          }

          // Then add current stage log
          updatedLogs.push(newQcLog);

          const instStageData = {
            status: qcStatus === 'pass' ? 'pass' as const : qcStatus === 'fail' ? 'fail' as const : 'pending' as const,
            date: new Date(),
            by: displayLabel,
            notes: qcNotes,
            photos: allGatheredPhotos,
            checkedCriteria: checkedCriteria,
            criterionPhotos: criterionPhotos
          };

          const resultInst: any = {
            ...inst,
            [stageField]: instStageData,
            qcStatus: qcStatus === 'pass' ? ('pass' as const) : qcStatus === 'fail' ? ('fail' as const) : ('pending' as const),
            qcDone: activeInspectionStage === 'pack' && isPassedNow, // ONLY DONE IF PACKING STAGE PASSES
            qcNotes: qcNotes,
            qcDate: new Date(),
            qcBy: displayLabel,
            qcPhotos: allGatheredPhotos,
            qcLogs: updatedLogs
          };

          if (scannedQRResult && scannedQRResult.cncid && scannedQRResult.instanceId === inst.id) {
            resultInst.cncid = scannedQRResult.cncid;
          }

          if (instQcWhite !== undefined) resultInst.qcWhite = instQcWhite;
          if (instQcPaint !== undefined) resultInst.qcPaint = instQcPaint;
          if (instQcFinish !== undefined) resultInst.qcFinish = instQcFinish;
          return resultInst;
        }
        return inst;
      });

      // Tính tổng số lượng đạt của công đoạn hiện tại
      const nextPassedItems = updatedInstances
        .filter(inst => inst[stageField]?.status === 'pass')
        .map(inst => inst.id);

      const nextPassedQty = nextPassedItems.length;
      const isFullyPassed = nextPassedQty === qty;
      const resolvedStatus = isFullyPassed ? 'pass' : (nextPassedQty > 0 ? 'pending' : qcStatus);

      const qcData = {
        status: resolvedStatus,
        notes: qcNotes,
        photos: allGatheredPhotos,
        date: new Date(),
        by: displayLabel,
        role: roleLabel,
        checkedCriteria: checkedCriteria,
        criterionPhotos: criterionPhotos,
        passedItems: nextPassedItems,
        passedQty: nextPassedQty
      };

      const hasInstances = instances.length > 0;

      let finalInstances = updatedInstances;

      // Nếu module không có instances, tạo instance ID 0 và ghi QC vào đó
      if (!hasInstances) {
        const defaultInst = {
          id: `${activeModule.moduleCode}|0`,
          instanceId: `${activeModule.moduleCode}|0`,
          instanceIndex: 0,
          tempLabelIndex: 0,
          [stageField]: {
            status: qcStatus === 'pass' ? 'pass' as const : qcStatus === 'fail' ? 'fail' as const : 'pending' as const,
            date: new Date(),
            by: displayLabel,
            notes: qcNotes,
            photos: allGatheredPhotos,
            checkedCriteria,
            criterionPhotos
          },
          qcLogs: [{
            stage: activeInspectionStage,
            status: qcStatus === 'pass' ? 'pass' as const : qcStatus === 'fail' ? 'fail' as const : 'pending' as const,
            date: new Date(),
            by: displayLabel,
            notes: qcNotes,
            photos: allGatheredPhotos
          }],
          delivered: false
        };
        finalInstances = [defaultInst as any];
      }

      // Chỉ ghi QC vào instances, KHÔNG ghi lên module-level
      const updateData: any = {
        instances: finalInstances,
      };

      let autoPassWhiteData: any = null;
      let autoPassPaintData: any = null;
      let autoPassFinishData: any = null;

      if (resolvedStatus === 'pass') {
        const makePassBuData = (stageName: string, filterFunc: (inst: any) => boolean) => {
          const passedItems = updatedInstances
            .filter(filterFunc)
            .map(inst => inst.id);
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

        if (activeInspectionStage === 'paint') {
          if (getModuleQcAggregate(activeModule, 'white')?.status !== 'pass') {
            autoPassWhiteData = makePassBuData('white', inst => inst.qcWhite?.status === 'pass');
          }
        } else if (activeInspectionStage === 'finish') {
          if (getModuleQcAggregate(activeModule, 'paint')?.status !== 'pass') {
            autoPassPaintData = makePassBuData('paint', inst => inst.qcPaint?.status === 'pass');
          }
          if (getModuleQcAggregate(activeModule, 'white')?.status !== 'pass') {
            autoPassWhiteData = makePassBuData('white', inst => inst.qcWhite?.status === 'pass');
          }
        } else if (activeInspectionStage === 'pack') {
          if (getModuleQcAggregate(activeModule, 'finish')?.status !== 'pass') {
            autoPassFinishData = makePassBuData('finish', inst => inst.qcFinish?.status === 'pass');
          }
          if (getModuleQcAggregate(activeModule, 'paint')?.status !== 'pass') {
            autoPassPaintData = makePassBuData('paint', inst => inst.qcPaint?.status === 'pass');
          }
          if (getModuleQcAggregate(activeModule, 'white')?.status !== 'pass') {
            autoPassWhiteData = makePassBuData('white', inst => inst.qcWhite?.status === 'pass');
          }
        }
      }

      const isStagePass = (activeInspectionStage === 'paint' || activeInspectionStage === 'finish') && resolvedStatus === 'pass';
      if (isStagePass) {
        const currentRecQty = activeModule.receivedQuantity || 0;
        if (currentRecQty < qty) {
          updateData.receivedQuantity = qty;
        }
      }

      const resultText = resolvedStatus === 'pass' ? 'PASS' : resolvedStatus === 'fail' ? 'FAIL' : 'CHỜ KIỂM';
      let statusText = `QC ${stage?.label}: ${resultText}`;
      if (!isFullyPassed) {
        statusText = `QC ${stage?.label}: Đạt ${nextPassedQty}/${qty}`;
      }

      const history = [...(activeModule.statusHistory || [])];
      if (autoPassWhiteData) {
        const hText = autoPassWhiteData.status === 'pass' ? 'PASS' : autoPassWhiteData.status === 'pending' ? `Đạt ${autoPassWhiteData.passedQty}/${qty}` : 'FAIL';
        history.push(`QC Hàng Trắng: ${hText} (Tự động Pass bù - ${displayLabel})|${Date.now()}`);
      }
      if (autoPassPaintData) {
        const hText = autoPassPaintData.status === 'pass' ? 'PASS' : autoPassPaintData.status === 'pending' ? `Đạt ${autoPassPaintData.passedQty}/${qty}` : 'FAIL';
        history.push(`QC Hàng Sơn: ${hText} (Tự động Pass bù - ${displayLabel})|${Date.now()}`);
      }
      if (isStagePass) {
        const currentRecQty = activeModule.receivedQuantity || 0;
        if (currentRecQty < qty) {
          history.push(`Giao Nhận - Đã nhận (Tự động theo QC Pass ${stage?.label} - ${displayLabel})|${Date.now()}`);
        }
      }
      history.push(`${statusText} (${displayLabel})|${Date.now()}`);
      updateData.statusHistory = history;
      updateData.status = statusText;

      const entryTypeActive = getEntryTypeLocal(activeModule?.moduleCode, activeModule);

      await updateProjectModule(activeModule.id, cleanUndefinedFields(updateData), activeModule.projectCode);
      syncProjectEntry(activeModule.id, updateData);

      // Tu dong pass bu cac cong doan truoc va module con khi Thung hoan tat Hoàn Thiện
      if (activeInspectionStage === 'finish' && qcStatus === 'pass' && isFullyPassed && entryTypeActive === 'Thùng') {
        try {
          await autoPassBuForPackage(activeModule.id, {
            uid: user?.uid,
            email: user?.email,
            displayName: displayLabel
          }, projectEntries);
        } catch (passErr) {
          console.error("Lỗi tự động pass bù ở màn hình QC:", passErr);
        }
      }

      const childModulesMatched: ProjectEntry[] = [];

      // Đồng bộ "Đợt di động" tương ứng của module chính (chỉ chạy khi module chính đã pass hoàn toàn)
      // Bỏ qua khi kiểm Hàng Trắng — chưa có giai đoạn trước để pass bù
      if (isFullyPassed && activeInspectionStage !== 'white') {
        try {
          const shelfModuleCode = makeShelfModuleCode(activeModule.moduleCode);
          const matchedShelf = projectEntries.find(e =>
            e.projectCode === activeModule.projectCode &&
            e.moduleCode === shelfModuleCode
          );
          if (matchedShelf) {
            // Nếu module hiện tại được PASS và là loại Thùng, thì Đợt di động của Thùng đó cũng được tự động PASS luôn
            const isParentThungPass = (entryTypeActive === 'Thùng' && qcStatus === 'pass');
            const targetShelfStatus = isParentThungPass ? 'pass' : qcStatus;

            // Ghi QC data vào instances của shelf thay vì module root
            const shelfInstances = getModuleInstances(matchedShelf);
            const shelfUpdateData: any = {};

            if (shelfInstances.length > 0) {
              shelfUpdateData.instances = shelfInstances.map((inst: any) => ({
                ...inst,
                [stage?.field]: {
                  status: targetShelfStatus,
                  notes: isParentThungPass ? `Tự động PASS theo Thùng cha ${activeModule.moduleCode}` : qcNotes,
                  photos: allGatheredPhotos,
                  date: new Date(),
                  by: displayLabel,
                  role: roleLabel
                }
              }));
            } else {
              // Fallback cho shelf cũ không có instances
              shelfUpdateData[`${stage?.field}`] = {
                status: targetShelfStatus,
                notes: isParentThungPass ? `Tự động PASS theo Thùng cha ${activeModule.moduleCode}` : qcNotes,
                photos: allGatheredPhotos,
                date: new Date(),
                by: displayLabel,
                role: roleLabel
              };
            }

            const isShelfPass = (activeInspectionStage === 'paint' || activeInspectionStage === 'finish') && targetShelfStatus === 'pass';
            if (isShelfPass) {
              const currentShelfRecQty = matchedShelf.receivedQuantity || 0;
              if (currentShelfRecQty < matchedShelf.quantity) {
                shelfUpdateData.receivedQuantity = matchedShelf.quantity;
              }
            }

            const shelfHistory = [...(matchedShelf.statusHistory || [])];
            const shelfResultText = targetShelfStatus === 'pass' ? 'PASS' : targetShelfStatus === 'fail' ? 'FAIL' : 'CHỜ KIỂM';
            const shelfStatusText = `QC ${stage?.label}: ${shelfResultText}`;
            if (isShelfPass) {
              const currentShelfRecQty = matchedShelf.receivedQuantity || 0;
              if (currentShelfRecQty < matchedShelf.quantity) {
                shelfHistory.push(`Giao Nhận - Đã nhận (Tự động theo QC Pass ${stage?.label} - ${displayLabel})|${Date.now()}`);
              }
            }
            shelfHistory.push(`${shelfStatusText} (${displayLabel}${isParentThungPass ? ' - Tự động theo Thùng' : ' - Đồng bộ'})|${Date.now()}`);
            shelfUpdateData.statusHistory = shelfHistory;
            shelfUpdateData.status = shelfStatusText;

            await updateProjectModule(matchedShelf.id, shelfUpdateData, matchedShelf.projectCode);

            if (selectedTicketId && isParentThungPass) {
              childModulesMatched.push(matchedShelf);
            }
          }
        } catch (shelfErr) {
          console.error("Lỗi đồng bộ Đợt di động:", shelfErr);
        }
      }

      // Log activity
      await addDoc(collection(db, 'activities'), {
        userId: user?.uid,
        userName: displayLabel,
        userEmail: user?.email || '',
        action: `QC ${stage?.label}`,
        details: isFullyPassed
          ? `QC cho ${activeModule?.moduleCode}: ${qcStatus.toUpperCase()}. Ghi chú: ${qcNotes || 'Không'}`
          : `QC cho ${activeModule?.moduleCode}: Đạt ${nextPassedQty}/${qty}. Ghi chú: ${qcNotes || 'Không'}`,
        projectCode: activeModule?.projectCode,
        moduleCode: activeModule?.moduleCode,
        timestamp: serverTimestamp()
      });

      // Đồng bộ vào Phiếu chờ kiểm đang mở nếu có
      if (selectedTicketId) {
        const ticket = [...filteredTicketGroups.pending, ...filteredTicketGroups.completed].find(t => t.id === selectedTicketId);
        if (ticket) {
          const matchedChildIds = childModulesMatched.map(c => c.id);
          const updatedModules = ticket.modules.map((m: any) => {
            // Hỗ trợ cả old-style (m.id === activeModuleId) và new-style (m.moduleId === activeModuleId)
            const isMatchedModule = m.id === activeModuleId || m.moduleId === activeModuleId;

            if (isMatchedModule) {
              // Nếu là instance-based entry, lấy trạng thái từ instance cụ thể
              let instanceStatus = isFullyPassed ? qcStatus : 'pending';
              if (m.instanceIndex != null && stageField) {
                const matchedInst = updatedInstances.find((inst: any) => inst.instanceIndex === m.instanceIndex);
                if (matchedInst) {
                  const instQcData = matchedInst[stageField];
                  instanceStatus = instQcData?.status || 'pending';
                }
              }

              return {
                ...m,
                status: instanceStatus,
                passedQty: m.instanceIndex != null ? (instanceStatus === 'pass' ? 1 : 0) : nextPassedItems.length,
                qcNotes: qcNotes,
                qcPhotos: allGatheredPhotos,
                checkedCriteria: checkedCriteria,
                criterionPhotos: criterionPhotos
              };
            }
            if (matchedChildIds.includes(m.id)) {
              return {
                ...m,
                status: 'pass',
                passedQty: m.quantity || 1,
                qcNotes: `Tự động PASS theo Thùng cha ${activeModule.moduleCode}`,
                qcPhotos: allGatheredPhotos
              };
            }
            return m;
          });

          const allInspected = updatedModules.every((m: any) => m.status === 'pass' || m.status === 'fail');
          const ticketStatus = allInspected ? 'completed' : 'pending';

          await updateDoc(doc(db, 'qc_tickets', selectedTicketId), cleanUndefinedFields({
            modules: updatedModules,
            status: ticketStatus
          }));
        }
      }

      closeInspectionModal();
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, 'projects');
    } finally {
      setLoading(false);
    }
  };

  // Thêm vào cùng với các useState khác
  const [isInspectionModalOpen, setIsInspectionModalOpen] = useState(false);
  const [isInspectionReadOnly, setIsInspectionReadOnly] = useState(false);
  const [showCreateTicketModal, setShowCreateTicketModal] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  // Tự động dismiss toast sau 3 giây
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  // Tạo phiếu chờ kiểm TRỐNG (chọn dự án → tạo phiếu → chuyển vào chi tiết)
  const handleCreateEmptyTicket = async () => {
    if (!selectedProjectCode) {
      setToast({ message: 'Vui lòng chọn dự án trước.', type: 'error' });
      return;
    }
    const canAddStageId = getCanAddStage();
    if (!canAddStageId) {
      setToast({ message: 'Bạn không có quyền tạo phiếu chờ kiểm.', type: 'error' });
      return;
    }

    const stage = QC_STAGES.find(s => s.id === canAddStageId);
    if (!stage) return;

    try {
      setLoading(true);
      const senderName = userProfile?.ten_that || user?.displayName || 'Nhân viên';
      const chucDanh = userProfile?.chuc_danh || '';

      // Kiểm tra phiếu trùng
      const existingTicket = qcTickets.find(t =>
        t.projectCode === selectedProjectCode &&
        t.stage === canAddStageId &&
        t.status === 'pending'
      );

      if (existingTicket) {
        // Nếu đã có phiếu pending cùng stage + dự án → chuyển vào phiếu đó
        setShowCreateTicketModal(false);
        setSelectedProjectCode('');
        setSelectedTicketId(existingTicket.id);
        setToast({ message: `Phiếu "${existingTicket.name}" đã tồn tại. Đã chuyển vào phiếu.`, type: 'success' });
        return;
      }

      const newTicketDocRef = doc(collection(db, 'qc_tickets'));
      const generatedTicketId = newTicketDocRef.id;
      const dateCode = (() => {
        const now = new Date();
        const yyyy = now.getFullYear();
        const mm = String(now.getMonth() + 1).padStart(2, '0');
        const dd = String(now.getDate()).padStart(2, '0');
        return `${yyyy}${mm}${dd}`;
      })();
      const ticketName = `#${dateCode} - ${selectedProjectCode}/${stage.label}`;

      const ticketDoc = {
        name: ticketName,
        projectCode: selectedProjectCode,
        stage: canAddStageId,
        createdBy: senderName,
        createdByEmail: user?.email || '',
        createdAt: new Date(),
        status: 'pending',
        modules: [],
        ownerId: user?.uid || ''
      };

      await setDoc(newTicketDocRef, cleanUndefinedFields(ticketDoc));

      // Thông báo cho QC
      await addDoc(collection(db, 'notifications'), {
        title: 'Phiếu mới chờ QC',
        content: `${ticketName} cho dự án ${selectedProjectCode}.`,
        type: 'qc',
        createdAt: serverTimestamp(),
        targetRoles: ['QC', 'mod_qc'],
        readBy: [],
        linkTo: 'qc'
      });

      setShowCreateTicketModal(false);
      setSelectedProjectCode('');
      setSelectedTicketId(generatedTicketId);
      setToast({ message: `Đã tạo phiếu "${ticketName}" thành công!`, type: 'success' });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, 'qc_tickets');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6 pb-24">
      <div className="flex items-center justify-between border-b border-gray-200 pb-2">
        <div className="flex items-center gap-3">
          <ClipboardCheck className="text-indigo-600" size={24} />
          <h2 className="text-xl font-black text-gray-800 uppercase tracking-tight">Kiểm Hàng</h2>
        </div>
        {/* Section 1: Nút mở modal tạo phiếu kiểm */}
        {(isModOrAdmin || isQC) && !hasRole('mod_qc') && (
          <button
            onClick={() => { setShowCreateTicketModal(true); const cfg = getCreationConfig(); if (cfg?.multiStage) setSelectedCreationStage('finish'); else setSelectedCreationStage(null); }}
            className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-5 py-2.5 rounded-lg font-black uppercase text-[11px] tracking-widest active:scale-95 transition-all shadow-md shadow-indigo-100"
          >
            <Plus size={16} />
            Tạo phiếu kiểm
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 gap-8">


        {/* Section 2: Phiếu Chờ Kiểm QC & Chi Tiết */}
        <div className="space-y-6">
          {!selectedTicketId ? (
            // VIEW 1: DANH SÁCH CÁC PHIẾU CHỜ KIỂM
            <div className="space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="flex items-center gap-2">
                  <ClipboardCheck className="text-indigo-600" size={18} />
                  <h3 className="text-sm font-black text-gray-800 uppercase tracking-widest font-sans">Danh sách Phiếu Chờ Kiểm</h3>
                </div>
              </div>

              {/* Bộ lọc phân loại 5 nút theo yêu cầu */}
              <div className="flex flex-wrap gap-1.5 bg-slate-100 p-1 rounded-sm border border-slate-100">
                {[
                  { id: 'all', label: 'Tất cả' },
                  { id: 'white', label: 'Hàng trắng' },
                  { id: 'paint', label: 'Hàng sơn' },
                  { id: 'finish', label: 'Hoàn thiện' },
                  { id: 'pack', label: 'Đóng gói' }
                ].map((btn) => (
                  <button
                    key={btn.id}
                    type="button"
                    onClick={() => setTicketStageFilter(btn.id as any)}
                    className={`flex-1 min-w-[75px] md:min-w-[100px] text-center py-2 rounded-sm text-[11px] font-black uppercase tracking-wider transition-all border cursor-pointer ${ticketStageFilter === btn.id
                      ? 'bg-indigo-600 text-white border-indigo-600 shadow-xs'
                      : 'bg-white text-slate-500 hover:bg-slate-100 border-slate-200'
                      }`}
                  >
                    {btn.label}
                  </button>
                ))}
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
                {/* CỘT BÊN TRÁI (2/5): Danh sách cấu kiện được báo Fail để QC lại nhanh */}
                <div className="hidden lg:block lg:col-span-1 space-y-3">
                  <div className="border-b border-dashed border-slate-200 pb-1.5 flex items-center justify-between">
                    <span className="text-[10px] font-black text-rose-600 uppercase tracking-widest block">
                      Cấu kiện báo lỗi QC ({failedModules.length})
                    </span>
                  </div>

                  {failedModules.length > 0 ? (
                    <div className="grid grid-cols-1 gap-3 max-h-[700px] overflow-y-auto pr-1 font-sans">
                      {failedModules.map((mod) => {
                        let errorStageLabel = 'Không rõ';
                        let errorStageKey: 'white' | 'paint' | 'finish' | 'pack' = 'white';
                        let errorNotes = '';
                        let failedInstIndices: number[] = [];
                        const modInsts = getModuleInstances(mod);

                        const aggPack = getModuleQcAggregate(mod, 'pack');
                        const aggFinish = getModuleQcAggregate(mod, 'finish');
                        const aggPaint = getModuleQcAggregate(mod, 'paint');
                        const aggWhite = getModuleQcAggregate(mod, 'white');

                        if (aggPack?.status === 'fail') {
                          errorStageLabel = 'Đóng gói';
                          errorStageKey = 'pack';
                          errorNotes = aggPack.notes || '';
                        } else if (aggFinish?.status === 'fail') {
                          errorStageLabel = 'Hoàn thiện';
                          errorStageKey = 'finish';
                          errorNotes = aggFinish.notes || '';
                        } else if (aggPaint?.status === 'fail') {
                          errorStageLabel = 'Hàng sơn';
                          errorStageKey = 'paint';
                          errorNotes = aggPaint.notes || '';
                        } else if (aggWhite?.status === 'fail') {
                          errorStageLabel = 'Hàng trắng';
                          errorStageKey = 'white';
                          errorNotes = aggWhite.notes || '';
                        }

                        // Tìm instance cụ thể bị fail
                        const stageField = errorStageKey === 'white' ? 'qcWhite' : errorStageKey === 'paint' ? 'qcPaint' : errorStageKey === 'finish' ? 'qcFinish' : 'qcPack';
                        const failedInst = modInsts.find(inst => (inst as any)[stageField]?.status === 'fail');

                        return (
                          <div
                            key={mod.id}
                            onClick={() => {
                              if (hasRole('mod_qc') || hasRole('admin')) {
                                handleInspectFailedModule(mod, false, failedInst?.id);
                              } else {
                                setViewingModuleQcStage(errorStageKey);
                                setViewingModuleInstanceIndex(undefined);
                                setViewingModule(mod);
                              }
                            }}
                            className="bg-white rounded-lg border border-slate-200 hover:border-rose-400 p-4 transition-all group cursor-pointer shadow-sm hover:shadow-md flex flex-col justify-between text-left"
                          >
                            <div>
                              <div className="flex items-center justify-between gap-2 mb-2">
                                <span className="text-[9px] bg-slate-100 text-slate-700 px-2 py-0.5 rounded-lg font-black uppercase tracking-wider">
                                  {mod.projectCode}
                                </span>
                                <span className="text-[8.5px] font-black uppercase tracking-widest px-2 py-0.5 rounded-lg border bg-rose-500 text-white border-rose-100">
                                  {errorStageLabel.toUpperCase()} FAIL
                                </span>
                              </div>
                              <h4 className="text-[12px] font-black text-slate-800 group-hover:text-rose-600 uppercase mb-1 transition-colors tracking-tight">
                                {mod.moduleCode}
                                {failedInst && modInsts.length > 1 && (
                                  <span className="ml-1.5 text-[9px] font-black text-rose-500 normal-case">
                                    #{failedInst.instanceIndex}/{modInsts.length}
                                  </span>
                                )}
                              </h4>
                              <p className="text-[10px] text-slate-500 font-bold mb-2">
                                Cụm: <span className="text-slate-700 font-extrabold">{mod.cluster || 'Chưa phân cụm'}</span>
                              </p>
                              {errorNotes && (
                                <div className="bg-rose-100/50 p-2.5 rounded-lg border border-rose-100 text-[10px] text-rose-700 italic font-bold leading-relaxed">
                                  Mô tả lỗi: {errorNotes}
                                </div>
                              )}
                              <span className="text-[10px]">By: {mod.qcBy || 'N/A'}</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="bg-white rounded-lg border border-dashed border-slate-200 py-12 text-center text-slate-400 font-bold uppercase text-[9px] tracking-wider">
                      Không có cấu kiện nào đang ở trạng thái lỗi QC
                    </div>
                  )}
                </div>

                {/* CỘT BÊN PHẢI (3/5): Danh sách Phiếu Chờ Kiểm định gốc */}
                <div className="lg:col-span-4 space-y-4">
                  {filteredTicketGroups.pending.length === 0 && filteredTicketGroups.completed.length === 0 ? (
                    <div className="bg-white rounded-lg border border-gray-100 p-12 text-center">
                      <History size={40} className="mx-auto mb-3 text-gray-300 opacity-40 animate-pulse" />
                      <h4 className="text-xs font-black uppercase tracking-widest text-gray-400">Chưa có phiếu chờ kiểm nào thuộc công đoạn này</h4>
                      <p className="text-[11px] text-gray-400 font-medium mt-1">Các phiếu chờ kiểm thô, sơn, hoàn thiện hoặc đóng gói sẽ hiển thị ở đây khi được tạo.</p>
                    </div>
                  ) : (
                    <div className="space-y-8">
                      {/* PHẦN 1: PHIẾU CHƯA HOÀN THÀNH / ĐANG CHỜ KIỂM */}
                      <div className="space-y-3">
                        <div className="border-b border-dashed border-slate-200 pb-1.5">
                          <span className="text-[10px] font-black text-amber-600 uppercase tracking-widest block">
                            Phiếu Chưa Hoàn Thành / Đang chờ kiểm ({filteredTicketGroups.pending.length})
                          </span>
                        </div>

                        {filteredTicketGroups.pending.length > 0 ? (
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {filteredTicketGroups.pending.map((ticket: any) => (
                              <div
                                key={ticket.id}
                                onClick={() => setSelectedTicketId(ticket.id)}
                                className="bg-white rounded-lg border border-gray-100 hover:border-indigo-200 p-5 cursor-pointer hover:bg-slate-100/50 transition-all group flex flex-col justify-between shadow-sm"
                              >
                                <div>
                                  <div className="flex items-center justify-between gap-2 mb-2">
                                    <div className="flex items-center gap-1 flex-wrap">
                                      {getTicketProjectCodes(ticket).map(code => {
                                        const entry = projectEntries.find(e => e.projectCode === code);
                                        const projectName = entry?.projectName || code;
                                        return (
                                          <span key={code} className="text-[10px] bg-slate-200 text-slate-700 px-2.5 py-1 rounded-sm font-black uppercase tracking-wider">
                                            {formatProjectName(projectName)}
                                          </span>
                                        );
                                      })}
                                    </div>
                                    <div className="flex items-center gap-1.5">
                                      <span className="text-[9px] font-black uppercase tracking-widest px-2.5 py-1 rounded-sm border bg-amber-100 text-amber-700 border-amber-100">
                                        CHỜ KIỂM
                                      </span>
                                      {isQC && (
                                        <button
                                          type="button"
                                          onClick={(e) => handleDeleteTicket(e, ticket)}
                                          className="p-1 text-slate-400 hover:text-rose-600 hover:bg-rose-100 transition-colors rounded-sm border border-transparent hover:border-rose-100"
                                          title="Xóa phiếu và hoàn tác trạng thái"
                                        >
                                          <Trash2 size={13} />
                                        </button>
                                      )}
                                    </div>
                                  </div>

                                  <h4 className="text-sm font-black text-slate-800 group-hover:text-indigo-700 uppercase mb-2.5 transition-colors tracking-tight">
                                    {(() => {
                                      const name = ticket.name || '';
                                      const match = name.match(/^(#\d+\s*-\s*)(.+?)(\/.+)$/);
                                      if (match) {
                                        return (
                                          <>
                                            <span>{match[1]}</span>
                                            <span className="text-indigo-600">{match[2]}</span>
                                            <span>{match[3]}</span>
                                          </>
                                        );
                                      }
                                      return name;
                                    })()}
                                  </h4>

                                  <div className="flex flex-col gap-1 text-[11px] text-slate-550 font-bold mb-4">
                                    <p>Người tạo: <span className="text-slate-700 font-extrabold">{ticket.createdBy}</span></p>
                                    <p>Thời gian: <span className="text-slate-700 font-semibold">
                                      {ticket._createdAtDate ? ticket._createdAtDate.toLocaleString('vi-VN') : 'N/A'}
                                    </span></p>
                                  </div>
                                </div>

                                <div className="space-y-2 border-t border-slate-100 pt-3">
                                  <div className="flex items-center justify-between text-[11px] font-black text-slate-600 uppercase">
                                    <span>Tiến độ kiểm:</span>
                                    <span>{ticket._inspectedCount}/{ticket._totalModules} (Đạt: {ticket._passModules}, Lỗi: {ticket._failModules})</span>
                                  </div>
                                  <div className="w-full bg-slate-100 h-2 rounded-sm overflow-hidden">
                                    <div
                                      className="h-full transition-all duration-300 bg-indigo-500"
                                      style={{ width: `${ticket._percent}%` }}
                                    />
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="bg-slate-100/50 rounded-lg border border-dashed border-slate-200 py-6 text-center text-slate-400 font-bold uppercase text-[10px] tracking-wider">
                            Không có phiếu nào đang chờ kiểm định
                          </div>
                        )}
                      </div>

                      {/* PHẦN 2: CÁC PHIẾU ĐÃ XONG PHÂN LOẠI RIÊNG PHÍA DƯỚI CÙNG */}
                      <div className="space-y-3 pt-6 border-t border-slate-100">
                        <div className="border-b border-dashed border-slate-200 pb-1.5 flex items-center justify-between">
                          <span className="text-[10px] font-black text-emerald-600 uppercase tracking-widest block">
                            Phiếu Đã Hoàn Tất ({filteredTicketGroups.completed.length})
                          </span>
                        </div>

                        {filteredTicketGroups.completed.length > 0 ? (
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {filteredTicketGroups.completed.map((ticket: any) => (
                              <div
                                key={ticket.id}
                                onClick={() => setSelectedTicketId(ticket.id)}
                                className="bg-zinc-100/70 hover:bg-emerald-100/25 rounded-lg border border-zinc-200/60 hover:border-emerald-200 p-5 cursor-pointer transition-all group flex flex-col justify-between shadow-xs opacity-90 hover:opacity-100"
                              >
                                <div>
                                  <div className="flex items-center justify-between gap-2 mb-2">
                                    <div className="flex items-center gap-1 flex-wrap">
                                      {getTicketProjectCodes(ticket).map(code => {
                                        const entry = projectEntries.find(e => e.projectCode === code);
                                        const projectName = entry?.projectName || code;
                                        return (
                                          <span key={code} className="text-[10px] bg-slate-200 text-slate-700 px-2.5 py-1 rounded-sm font-black uppercase tracking-wider">
                                            {formatProjectName(projectName)}
                                          </span>
                                        );
                                      })}
                                    </div>
                                    <div className="flex items-center gap-1.5">
                                      <span className="text-[9px] font-black uppercase tracking-widest px-2.5 py-1 rounded-sm border bg-emerald-100 text-emerald-600 border-emerald-100">
                                        HOÀN TẤT
                                      </span>
                                      {isQC && (
                                        <button
                                          type="button"
                                          onClick={(e) => handleDeleteTicket(e, ticket)}
                                          className="p-1 text-slate-400 hover:text-rose-600 hover:bg-rose-100 transition-colors rounded-sm border border-transparent hover:border-rose-100"
                                          title="Xóa phiếu và hoàn tác trạng thái"
                                        >
                                          <Trash2 size={13} />
                                        </button>
                                      )}
                                    </div>
                                  </div>

                                  <h4 className="text-sm font-black text-slate-700 group-hover:text-emerald-700 uppercase mb-2.5 transition-colors tracking-tight">
                                    {(() => {
                                      const name = ticket.name || '';
                                      const match = name.match(/^(#\d+\s*-\s*)(.+?)(\/.+)$/);
                                      if (match) {
                                        return (
                                          <>
                                            <span>{match[1]}</span>
                                            <span className="text-indigo-600">{match[2]}</span>
                                            <span>{match[3]}</span>
                                          </>
                                        );
                                      }
                                      return name;
                                    })()}
                                  </h4>

                                  <div className="flex flex-col gap-1 text-[11px] text-slate-550 font-bold mb-3">
                                    <p>Người tạo: <span className="text-slate-600 font-extrabold">{ticket.createdBy}</span></p>
                                    <p>Thời gian: <span className="text-slate-600 font-semibold">
                                      {ticket._createdAtDate ? ticket._createdAtDate.toLocaleString('vi-VN') : 'N/A'}
                                    </span></p>
                                  </div>
                                </div>

                                <div className="space-y-2 border-t border-slate-200/50 pt-3">
                                  <div className="flex items-center justify-between text-[11px] font-black text-slate-600 uppercase">
                                    <span>Tiến độ kiểm:</span>
                                    <span>{ticket._inspectedCount}/{ticket._totalModules} (Đạt: {ticket._passModules}, Lỗi: {ticket._failModules})</span>
                                  </div>
                                  <div className="w-full bg-slate-200/50 h-2 rounded-sm overflow-hidden">
                                    <div
                                      className="h-full transition-all duration-300 bg-emerald-500"
                                      style={{ width: `${ticket._percent}%` }}
                                    />
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="bg-slate-100/50 rounded-lg border border-dashed border-slate-200 py-6 text-center text-slate-400 font-bold uppercase text-[10px] tracking-wider">
                            Không có phiếu nào đã hoàn thành thuộc bộ lọc này
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            // VIEW 2: CHI TIẾT PHIẾU CHỜ KIỂM ĐANG CHỌN
            (() => {
              // Tìm trong filteredTicketGroups trước, fallback về qcTickets trực tiếp
              let ticket = [...filteredTicketGroups.pending, ...filteredTicketGroups.completed].find(t => t.id === selectedTicketId);
              if (!ticket) {
                // Fallback: tìm trong qcTickets (trường hợp phiếu vừa tạo, onSnapshot chưa cập nhật filteredTicketGroups)
                const rawTicket = qcTickets.find(t => t.id === selectedTicketId);
                if (rawTicket) {
                  const stage = QC_STAGES.find(s => s.id === rawTicket.stage);
                  const totalModules = rawTicket.modules?.length || 0;
                  const passModules = rawTicket.modules?.filter((m: any) => m.status === 'pass').length || 0;
                  const failModules = rawTicket.modules?.filter((m: any) => m.status === 'fail').length || 0;
                  const inspectedCount = passModules + failModules;
                  ticket = {
                    ...rawTicket,
                    modules: rawTicket.modules || [],
                    _totalModules: totalModules,
                    _passModules: passModules,
                    _failModules: failModules,
                    _inspectedCount: inspectedCount,
                    _percent: totalModules > 0 ? Math.round((inspectedCount / totalModules) * 100) : 0,
                    _isCompleted: rawTicket.status === 'completed' || inspectedCount === totalModules
                  };
                }
              }
              if (!ticket) {
                return (
                  <div className="bg-white rounded-lg border border-gray-100 p-8 text-center">
                    <p className="text-sm font-black uppercase text-slate-500">Không tìm thấy thông tin phiếu</p>
                    <button
                      onClick={() => setSelectedTicketId(null)}
                      className="mt-4 bg-indigo-600 text-white px-4 py-2 rounded-sm text-xs font-black uppercase tracking-widest"
                    >
                      Quay lại danh sách
                    </button>
                  </div>
                );
              }

              const totalModules = ticket.modules?.length || 0;
              const passModules = ticket.modules?.filter((m: any) => m.status === 'pass').length || 0;
              const failModules = ticket.modules?.filter((m: any) => m.status === 'fail').length || 0;
              const inspectedCount = passModules + failModules;
              const percent = totalModules > 0 ? Math.round((inspectedCount / totalModules) * 100) : 0;
              const isTicketCompleted = ticket.status === 'completed' || inspectedCount === totalModules;
              const canManageThisTicket = hasRole('admin') || ticket.createdByEmail === user?.email || ticket.ownerId === user?.uid;

              return (
                <div className="space-y-6">
                  {/* Trình quay lại và Tiêu đề */}
                  <div className="flex items-center justify-between bg-white rounded-lg border border-gray-100 p-4 shadow-sm">
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => setSelectedTicketId(null)}
                        className="p-2 border border-slate-200 text-slate-600 hover:bg-slate-100 rounded-sm transition-colors active:scale-95"
                        title="Quay lại danh sách phiếu"
                      >
                        <ArrowLeft size={18} />
                      </button>
                      <div>
                        <h4 className="text-base font-black text-slate-800 uppercase leading-none">
                          {(() => {
                            const name = ticket.name || '';
                            const match = name.match(/^(#\d+\s*-\s*)(.+?)(\/.+)$/);
                            if (match) {
                              return (
                                <>
                                  <span>{match[1]}</span>
                                  <span className="text-indigo-600">{match[2]}</span>
                                  <span>{match[3]}</span>
                                </>
                              );
                            }
                            return name;
                          })()}
                        </h4>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 h-full">
                      {canManageThisTicket && isQC && !isTicketCompleted && (
                        <button
                          type="button"
                          onClick={() => {
                            const confirmClose = window.confirm(
                              `Bạn có chắc chắn muốn Hoàn Tất phiếu kiểm này?\nToàn bộ các cấu kiện CHƯA QC sẽ bị xóa khỏi phiếu và trả về trạng thái mộc.`
                            );
                            if (confirmClose) {
                              handleCompleteTicketWithQC(ticket);
                            }
                          }}
                          className="px-3.5 py-2 bg-emerald-600 text-white rounded-lg text-xs font-black uppercase tracking-wider hover:bg-emerald-700 active:scale-95 transition-all flex items-center gap-1.5"
                          title="Hoàn tất phiếu kiểm định"
                        >
                          <CheckCircle size={14} />
                          Hoàn tất phiếu
                        </button>
                      )}
                      {canManageThisTicket && isQC && hasRole('admin') && (
                        <button
                          type="button"
                          onClick={() => handleCloseTicket(ticket)}
                          className="p-2.5 text-amber-600 hover:bg-amber-100 rounded-lg transition-colors"
                          title="Đóng phiếu kiểm"
                        >
                          <ArchiveRestore size={18} />
                        </button>
                      )}
                      {canManageThisTicket && (
                        <button
                          type="button"
                          onClick={(e) => handleDeleteTicket(e, ticket)}
                          className="p-2.5 text-rose-500 hover:bg-rose-100 rounded-lg transition-colors"
                          title="Xóa phiếu"
                        >
                          <Trash2 size={18} />
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Nút Thêm Thủ Công & Quét QR */}
                  {canManageThisTicket && (
                    <div className="flex gap-2">
                      <button
                        onClick={() => setShowManualAddModal(true)}
                        className="flex-1 flex items-center justify-center gap-2 bg-white border border-slate-200 text-slate-700 px-4 py-3 rounded-lg text-xs font-black uppercase tracking-widest hover:bg-slate-50 active:scale-95 transition-all"
                      >
                        <Plus size={16} />
                        Thêm Thủ Công
                      </button>
                      <button
                        onClick={() => {
                          setScannerMode('add_to_ticket');
                          setShowScanner(true);
                        }}
                        className="flex-1 flex items-center justify-center gap-2 bg-indigo-600 text-white px-4 py-3 rounded-lg text-xs font-black uppercase tracking-widest hover:bg-indigo-700 active:scale-95 transition-all shadow-md"
                      >
                        <ScanQrCode size={16} />
                        Quét QR
                      </button>
                    </div>
                  )}
                  {/* Tiến trình tổng quan */}
                  <div className="bg-white rounded-lg border border-gray-100 p-6 space-y-3 shadow-sm">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs font-black text-slate-700 uppercase">
                      <span>TIẾN ĐỘ KIỂM TRA PHIẾU:</span>
                      <span>{inspectedCount}/{totalModules} cấu kiện ({percent}%)</span>
                    </div>

                    <div className="w-full bg-slate-100 h-3 rounded-full overflow-hidden">
                      <div
                        className={`h-full transition-all duration-300 ${isTicketCompleted ? 'bg-emerald-500' : 'bg-indigo-500'}`}
                        style={{ width: `${percent}%` }}
                      />
                    </div>

                    <div className="flex flex-wrap gap-4 text-xs font-bold text-slate-500 pt-1">
                      <p>Người tạo: <span className="text-slate-800">{ticket.createdBy}</span></p>
                      <p>Thời gian: <span className="text-slate-800">{ticket._createdAtDate ? ticket._createdAtDate.toLocaleString('vi-VN') : 'N/A'}</span></p>
                      <p>Công đoạn kiểm: <span className="text-indigo-600 font-extrabold uppercase">{QC_STAGES.find(s => s.id === ticket.stage)?.label}</span></p>
                      <p>Tình trạng: <span className={isTicketCompleted ? 'text-emerald-600 font-extrabold' : 'text-amber-600'}>{isTicketCompleted ? 'Đã hoàn tất tất cả' : 'Có cấu kiện chưa kiểm'}</span></p>
                    </div>
                  </div>

                  {/* Danh sách cấu kiện trong phiếu này */}
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <h4 className="text-xs font-black text-slate-700 uppercase tracking-wider">Danh Sách Cấu Kiện ({totalModules})</h4>
                    </div>

                    <div className="grid grid-cols-1">
                      {ticket.modules?.map((m: any, idx: number) => {
                        // Dùng moduleId (actual module ID) thay vì m.id (composite key)
                        const actualModuleId = m.moduleId || m.id;
                        // Lấy trạng thái QC từ instance-level thay vì từ ticket
                        const projEntryForStatus = projectEntries.find(e => e.id === actualModuleId || e.moduleCode === m.moduleCode);
                        const ticketStageField = QC_STAGES.find(s => s.id === ticket.stage)?.field;
                        let instStatus = m.status; // fallback từ ticket
                        if (projEntryForStatus && ticketStageField && m.instanceIndex != null) {
                          const insts = getModuleInstances(projEntryForStatus);
                          const targetInst = insts.find(inst => inst.instanceIndex === m.instanceIndex);
                          if (targetInst) {
                            const instQcData = (targetInst as any)[ticketStageField];
                            if (instQcData?.status) {
                              instStatus = instQcData.status;
                            }
                          }
                        }

                        return (
                          <div
                            key={`${m.id}-${idx}`}
                            onClick={() => {
                              const projEntry = projectEntries.find(e => e.id === actualModuleId) || resolveModule(m);
                              if (!projEntry) {
                                setScanError({ message: `Không tìm thấy chi tiết cấu kiện ${m.moduleCode} trong hệ thống.` });
                                return;
                              }
                              // Hiển thị chi tiết module thay vì mở modal kiểm định
                              setViewingModuleQcStage(ticket.stage);
                              setViewingModuleInstanceIndex(m.instanceIndex);
                              setViewingModule(projEntry);
                            }}
                            className={`bg-white rounded-lg border p-2.5 flex items-center gap-3 transition-all hover:bg-slate-100/40 relative overflow-hidden cursor-pointer ${instStatus === 'pass'
                              ? 'border-emerald-100 hover:border-emerald-200'
                              : instStatus === 'fail'
                                ? 'border-rose-100 hover:border-rose-200'
                                : 'border-slate-100 hover:border-indigo-100'
                              }`}
                          >
                            <span className="shrink-0 w-8 h-8 flex items-center justify-center text-[11px] font-black text-slate-500">
                              {idx + 1}
                            </span>
                            <span className={`shrink-0 text-[10px] font-black uppercase tracking-widest px-2.5 py-1 rounded-sm border ${instStatus === 'pass'
                              ? 'bg-emerald-100 text-emerald-600 border-emerald-200'
                              : instStatus === 'fail'
                                ? 'bg-rose-100 text-rose-600 border-rose-200'
                                : 'bg-slate-100 text-slate-400 border-slate-200'
                              }`}>
                              <span className="sm:hidden">{instStatus === 'pass' ? 'P' : instStatus === 'fail' ? 'F' : '/'}</span>
                              <span className="hidden sm:inline">{instStatus === 'pass' ? 'PASS' : instStatus === 'fail' ? 'FAIL' : 'PENDING'}</span>
                            </span>
                            <span className="shrink-0 w-24 text-[10px] font-black text-indigo-600 uppercase tracking-wider truncate" title={m.cluster || 'N/A'}>
                              {m.cluster || 'N/A'}
                            </span>
                            <div className="min-w-0 flex-1">
                              <h5 className="text-sm font-black text-slate-800 uppercase tracking-tight truncate">
                                {m.moduleCode}
                                {m.instanceIndex != null && (projEntryForStatus?.quantity || m.quantity || 1) > 1 && (
                                  <span className="ml-1.5 font-bold text-indigo-500 normal-case">#{m.instanceIndex}/{projEntryForStatus?.quantity || m.quantity || '?'}</span>
                                )}
                              </h5>
                              {m.qcNotes && (
                                <p className="text-[11px] text-slate-500 mt-0.5 truncate">
                                  <span className="font-extrabold text-slate-600">Ghi chú:</span> {m.qcNotes}
                                </p>
                              )}
                            </div>

                            <div className="shrink-0 flex items-center gap-2">
                              {canManageThisTicket && (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setModuleToRemove({ ticket, moduleId: m.id, moduleCode: m.moduleCode });
                                  }}
                                  className="p-1 px-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-100 rounded-sm border border-transparent hover:border-rose-100 transition-colors"
                                  title="Xóa cấu kiện khỏi phiếu và hoàn tác"
                                >
                                  <Trash2 size={13} strokeWidth={2.5} />
                                </button>
                              )}
                              <ChevronRight size={16} className="text-slate-300" />
                            </div>

                            {/* Accent color bar */}
                            <div className={`absolute left-0 top-0 bottom-0 w-1 ${instStatus === 'pass'
                              ? 'bg-emerald-500'
                              : instStatus === 'fail'
                                ? 'bg-rose-500'
                                : (m.passedQty || 0) > 0
                                  ? 'bg-indigo-500'
                                  : 'bg-slate-300'
                              }`} />
                          </div>
                        );
                      })}
                    </div>
                  </div>

                </div>
              );
            })()
          )}
        </div>
      </div>
      {/* Floating Inspection Modal */}
      <AnimatePresence mode="wait">
        {activeModule ? (
          <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
            <motion.div
              key={activeModule.id}
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              className="bg-white w-screen md:w-full md:max-w-lg h-screen md:h-auto md:max-h-[90vh] rounded-none md:rounded-lg shadow-2xl overflow-hidden border border-slate-200 flex flex-col"
            >
              {/* Modal Header */}
              <div className="bg-white px-8 py-6 border-b border-slate-100 flex items-center justify-between shrink-0">
                <div className="flex flex-col">
                  <span className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400 mb-1">{formatProjectName(activeModule.projectName)}</span>
                  <div className="flex items-center gap-3">
                    <h3 className="text-2xl font-black text-slate-800 uppercase tracking-tighter leading-none">
                      {activeModule.moduleCode}
                      {(() => {
                        const stage = QC_STAGES.find(s => s.id === activeInspectionStage);
                        const stageData = stage ? activeModule[stage.field] : null;
                        const passedCount = selectedTicketId
                          ? (() => {
                            const ticket = [...filteredTicketGroups.pending, ...filteredTicketGroups.completed].find(t => t.id === selectedTicketId);
                            const ticketMod = ticket?.modules?.find((tm: any) => tm.id === activeModule.id);
                            return ticketMod?.passedQty || 0;
                          })()
                          : (stageData?.passedItems?.length || stageData?.passedQty || 0);

                        return (activeModule.quantity || 1) > 1
                          ? ` pass ${passedCount}/${activeModule.quantity}`
                          : '';
                      })()}
                    </h3>
                    <button
                      onClick={() => {
                        setScannerMode('verify');
                        setShowScanner(true);
                      }}
                      className="p-1.5 bg-indigo-100 text-indigo-600 rounded-md border border-indigo-100 hover:bg-indigo-100 transition-colors"
                      title="Quét QR để xác minh lại module"
                    >
                      <ScanQrCode size={16} />
                    </button>
                    <span className="bg-indigo-100 text-indigo-600 px-2 py-0.5 rounded text-[9px] font-black uppercase tracking-widest border border-indigo-100">
                      {QC_STAGES.find(s => s.id === activeInspectionStage)?.label}
                    </span>
                    {/* Show progress if quantity > 1 within active ticket */}
                    {(() => {
                      if (selectedTicketId) {
                        const ticket = [...filteredTicketGroups.pending, ...filteredTicketGroups.completed].find(t => t.id === selectedTicketId);
                        const ticketMod = ticket?.modules?.find((tm: any) => tm.id === activeModule.id);
                        if (ticketMod && (ticketMod.quantity || 1) > 1) {
                          return (
                            <span className="bg-amber-100 text-amber-600 px-2 py-0.5 rounded text-[9px] font-black uppercase tracking-widest border border-amber-100 font-bold">
                              Tiến độ: {ticketMod.passedQty || 0}/{ticketMod.quantity}
                            </span>
                          );
                        }
                      }
                      return null;
                    })()}
                  </div>
                </div>
                <button
                  onClick={closeInspectionModal}
                  className="p-2 text-slate-400 hover:text-rose-500 transition-colors"
                >
                  <X size={20} />
                </button>
              </div>

              <div className="bg-slate-100 px-8 py-3 flex items-center gap-6 border-b border-slate-100 shrink-0 overflow-x-auto custom-scrollbar">
                <div className="flex items-center gap-2 shrink-0">
                  <p className="text-[9px] font-black uppercase text-slate-400 tracking-widest">KÍCH THƯỚC:</p>
                  <p className="text-[11px] font-black text-slate-700 mono tracking-tight">
                    {(activeModule.pWidth || activeModule.width || 0)}x{(activeModule.pHeight || activeModule.height || 0)}x{(activeModule.pDepth || activeModule.depth || 0)}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <p className="text-[9px] font-black uppercase text-slate-400 tracking-widest">CỤM:</p>
                  <p className="text-[11px] font-black text-slate-700 uppercase truncate max-w-[120px]">{activeModule.cluster || 'N/A'}</p>
                </div>
              </div>

              {/* Modal Content */}
              <div className="p-8 space-y-10 overflow-y-auto custom-scrollbar bg-white flex-1">

                {/* Checklist tiêu chí chất lượng tương ứng - ĐỐI LÊN ĐẦU TIÊN */}
                {activeInspectionStage && (
                  <div className="space-y-4">
                    <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                      <div className="flex items-center gap-3">
                        <div className="p-1.5 bg-slate-100 text-slate-500 rounded-lg">
                          <CheckSquare size={14} />
                        </div>
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block leading-none">
                          Checklist kiểm định {getEntryType(activeModule)} ({QC_STAGES.find(s => s.id === activeInspectionStage)?.label})
                        </label>
                      </div>
                      <span className="text-[8px] font-black uppercase text-indigo-600 bg-indigo-100 px-2 py-0.5 rounded-sm tracking-widest">
                        Chuẩn quy trình
                      </span>
                    </div>

                    <div className="space-y-2.5">
                      {getQCCriteria(getEntryType(activeModule), activeInspectionStage).map((cri) => {
                        const isChecked = !!checkedCriteria[cri.id];
                        const photos = criterionPhotos[cri.id] || [];
                        const isUploading = !!criterionUploading[cri.id];

                        return (
                          <div
                            key={cri.id}
                            className={`p-3 rounded-lg border transition-all text-left ${isChecked
                              ? 'bg-indigo-100/30 border-indigo-200/60'
                              : 'bg-slate-100 border-slate-100 hover:border-slate-205'
                              }`}
                          >
                            <div className="flex items-start justify-between gap-3">
                              {/* Checkbox action */}
                              <div
                                onClick={() => {
                                  if (isInspectionReadOnly) return;
                                  const nextChecked = !isChecked;
                                  const updated = {
                                    ...checkedCriteria,
                                    [cri.id]: nextChecked
                                  };
                                  setCheckedCriteria(updated);

                                  // Tự động Pass/Fail:
                                  const criteriaList = getQCCriteria(getEntryType(activeModule), activeInspectionStage);
                                  if (criteriaList.length > 0) {
                                    const allChecked = criteriaList.every(c => !!updated[c.id]);
                                    setQcStatus(allChecked ? 'pass' : 'fail');
                                  }
                                }}
                                className={`flex items-start gap-3 flex-1 ${isInspectionReadOnly ? 'cursor-default' : 'cursor-pointer'} select-none min-w-0`}
                              >
                                {/* Custom Checkbox to rõ như Packing */}
                                <div className={`w-5.5 h-5.5 rounded-sm border flex items-center justify-center transition-all shrink-0 mt-0.5 ${isChecked
                                  ? 'bg-indigo-600 border-indigo-600 shadow-sm'
                                  : 'bg-white border-slate-300'
                                  }`}>
                                  {isChecked && <Check size={13} strokeWidth={3} className="text-white" />}
                                </div>

                                <div className="flex-1 min-w-0 leading-tight">
                                  <span className="text-[7.5px] font-black uppercase bg-slate-300/80 text-slate-600 px-1 py-0.2 rounded-sm mr-1.5 shrink-0 inline-block tracking-widest leading-none">
                                    {cri.category}
                                  </span>
                                  <span className="text-[11px] font-bold text-slate-800 leading-snug">
                                    {cri.text}
                                  </span>
                                </div>
                              </div>

                              {/* Chọn nhiều ảnh từ thư viện cho từng tiêu chí */}
                              <div className="shrink-0">
                                {isUploading ? (
                                  <Loader2 size={16} className="animate-spin text-indigo-600" />
                                ) : isInspectionReadOnly ? (
                                  null
                                ) : (
                                  <label className="p-1 px-2.5 bg-white hover:bg-slate-100 border border-slate-200 text-slate-500 hover:text-slate-700 rounded-sm cursor-pointer flex items-center gap-1.5 transition-all active:scale-95" title="Chọn nhiều ảnh sẵn có từ máy">
                                    <input
                                      type="file"
                                      accept="image/*"
                                      multiple
                                      className="hidden"
                                      onChange={(e) => {
                                        const files = e.target.files;
                                        if (files && files.length > 0) {
                                          handleCriterionPhotoUpload(cri.id, files);
                                        }
                                      }}
                                    />
                                    <ImageIcon size={13} className="text-slate-400" />
                                    <span className="text-[8.5px] font-black uppercase tracking-wider text-slate-500">Thêm ảnh lỗi</span>
                                  </label>
                                )}
                              </div>
                            </div>

                            {/* Thumbnail ảnh lỗi của tiêu chí */}
                            {photos.length > 0 && (
                              <div className="flex gap-2 mt-2.5 flex-wrap pl-8.5 border-t border-dashed border-slate-200 pt-2">
                                {photos.map((photo, pIdx) => (
                                  <div key={pIdx} className="w-12 h-12 rounded-sm border border-slate-300 overflow-hidden relative group shrink-0 shadow-sm bg-slate-100">
                                    <img
                                      src={photo}
                                      alt=""
                                      className="w-full h-full object-cover cursor-pointer"
                                      referrerPolicy="no-referrer"
                                      onClick={() => {
                                        setLightboxImages(photos || []);
                                        setLightboxStartIndex(pIdx);
                                        setLightboxOpen(true);
                                      }}
                                    />
                                    {!isInspectionReadOnly && (
                                      <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center pointer-events-none">
                                        <button
                                          type="button"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            removeCriterionPhoto(cri.id, pIdx);
                                          }}
                                          className="text-white p-1 bg-rose-600 rounded-sm hover:scale-110 transition-transform pointer-events-auto shadow-sm"
                                        >
                                          <X size={10} />
                                        </button>
                                      </div>
                                    )}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Bộ sưu tập ảnh đối chiếu & lưu trữ chung của modal kiểm QC */}
                <div className="bg-slate-100 border border-slate-200 rounded-lg p-4 space-y-3">
                  <div className="flex items-center justify-between border-b border-slate-100 pb-2.5">
                    <div className="flex items-center gap-2.5">
                      <div className="p-1.5 bg-white text-indigo-600 rounded border border-slate-100">
                        <ImageIcon size={14} />
                      </div>
                      <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest font-sans leading-none">
                        Ảnh đối chiếu & Lưu trữ chung ({qcPhotos.length})
                      </span>
                    </div>
                    {!isInspectionReadOnly && (
                      <label className="p-1 px-3 bg-white hover:bg-indigo-100 border border-indigo-100 hover:border-indigo-200 text-indigo-600 rounded-sm cursor-pointer flex items-center gap-1.5 transition-all text-[9px] font-black uppercase tracking-wider font-sans active:scale-95 shadow-xs" title="Tải lên nhiều ảnh chụp sản phẩm">
                        <input
                          type="file"
                          accept="image/*"
                          multiple
                          className="hidden"
                          onChange={(e) => {
                            const files = e.target.files;
                            if (files && files.length > 0) {
                              handleQcGeneralPhotoUpload(files);
                            }
                          }}
                        />
                        {qcGeneralUploading ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
                        Đăng nhiều ảnh
                      </label>
                    )}
                  </div>

                  {qcGeneralUploading && (
                    <div className="flex items-center gap-2 text-xs font-bold text-indigo-600 animate-pulse font-sans">
                      <Loader2 size={14} className="animate-spin" />
                      Đang xử lý tải lên các tệp ảnh...
                    </div>
                  )}

                  {qcPhotos.length > 0 ? (
                    <div className="flex gap-2.5 flex-wrap">
                      {qcPhotos.map((photo, pIdx) => (
                        <div key={pIdx} className="w-16 h-16 rounded-md border border-slate-200 overflow-hidden relative group shrink-0 shadow-xs bg-white">
                          <img
                            src={photo}
                            alt=""
                            className="w-full h-full object-cover cursor-pointer"
                            referrerPolicy="no-referrer"
                            onClick={() => {
                              setLightboxImages(qcPhotos);
                              setLightboxStartIndex(pIdx);
                              setLightboxOpen(true);
                            }}
                          />
                          {!isInspectionReadOnly && (
                            <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center pointer-events-none">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  removeQcGeneralPhoto(pIdx);
                                }}
                                className="text-white p-1 bg-rose-600 rounded hover:scale-110 transition-transform pointer-events-auto shadow-sm"
                              >
                                <X size={11} strokeWidth={2.5} />
                              </button>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-center py-4 text-[10px] text-slate-500 font-semibold uppercase tracking-wider font-sans border border-dashed border-slate-200 rounded bg-white">
                      Chưa có hình ảnh đối chiếu chung nào được tải lên
                    </div>
                  )}
                </div>

                {/* Notes */}
                <div className={`space-y-4 ${isInspectionReadOnly ? 'opacity-85' : !isQC ? 'opacity-100 pointer-events-none' : ''}`}>
                  <div className="flex items-center gap-3 border-b border-slate-100 pb-3">
                    <div className="p-1.5 bg-slate-100 text-slate-500 rounded-lg">
                      <MessageSquare size={14} />
                    </div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block leading-none">Hồ sơ ghi chú công đoạn</label>
                  </div>
                  <div className="pt-2">
                    <textarea
                      id="qc-notes-textarea"
                      value={qcNotes}
                      onChange={(e) => setQcNotes(e.target.value)}
                      placeholder={isInspectionReadOnly ? "Không có ghi chú" : "Nhập chi tiết các sai lỗi hoặc ghi chú đặc biệt..."}
                      rows={2}
                      readOnly={isInspectionReadOnly}
                      className={`w-full bg-slate-100 border border-slate-200 rounded-lg px-4 py-3 text-[11px] font-black text-slate-800 uppercase focus:border-indigo-600 outline-none transition-all resize-none shadow-none tracking-tight leading-relaxed placeholder:text-slate-400 ${isInspectionReadOnly ? 'cursor-default bg-slate-100/50' : ''
                        }`}
                    />
                  </div>
                </div>

              </div>

              {/* Modal Footer */}
              <div className="p-6 bg-slate-100 border-t border-slate-100 flex items-center justify-between gap-4 shrink-0">
                <button onClick={closeInspectionModal} className="px-6 py-3.5 bg-white text-slate-600 border border-slate-200 rounded-lg text-[10px] font-black uppercase tracking-widest hover:bg-slate-100 transition-all transition-colors">Huỷ bỏ</button>
                {!isInspectionReadOnly ? (
                  <button
                    disabled={loading}
                    onClick={saveQCResult}
                    className={`flex-1 py-3.5 text-white rounded-lg font-black uppercase tracking-widest text-[11px] flex items-center justify-center gap-3 active:scale-95 disabled:opacity-100 transition-all ${qcStatus === 'fail'
                      ? 'bg-rose-600 hover:bg-rose-700 shadow-xl shadow-rose-100'
                      : 'bg-indigo-600 hover:bg-indigo-700 shadow-xl shadow-indigo-100'
                      }`}
                  >
                    {loading ? <Loader2 size={18} className="animate-spin" /> : <Save size={18} />}
                    {qcStatus === 'fail'
                      ? 'HOÀN TẤT PHIẾU (FAIL)'
                      : (() => {
                        if (selectedTicketId) {
                          const ticket = [...filteredTicketGroups.pending, ...filteredTicketGroups.completed].find(t => t.id === selectedTicketId);
                          const ticketMod = ticket?.modules?.find((tm: any) => tm.id === activeModule.id);
                          if (ticketMod && (ticketMod.quantity || 1) > 1) {
                            const nextNum = (ticketMod.passedQty || 0) + 1;
                            const totNum = ticketMod.quantity;
                            if (nextNum <= totNum) {
                              return `ĐẠT PHẦN TỬ THỨ ${nextNum}/${totNum}`;
                            }
                          }
                        }
                        return 'PHÊ DUYỆT CÔNG ĐOẠN';
                      })()}
                  </button>
                ) : (
                  <div className="flex-1 flex gap-3 text-sans">
                    <div className="flex-1 p-3 bg-slate-100 rounded-lg border border-slate-200 text-center flex items-center justify-center">
                      <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest leading-tight">
                        Chế độ xem thông tin kiểm định
                      </p>
                    </div>
                    {isQC && (
                      <button
                        type="button"
                        onClick={() => setIsInspectionReadOnly(false)}
                        className="px-6 py-3.5 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-[10px] font-black uppercase tracking-widest hover:scale-[1.02] shadow-md shadow-rose-100 transition-all cursor-pointer flex items-center justify-center gap-2 select-none font-bold shrink-0"
                      >
                        <ClipboardCheck size={14} /> QC Nhanh
                      </button>
                    )}
                  </div>
                )}
              </div>
            </motion.div>
          </div>
        ) : null}
      </AnimatePresence>

      {/* Modal Xác nhận Gửi Chờ Kiểm */}
      <AnimatePresence>
        {confirmingModule ? (
          <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              className="bg-white w-[calc(100%-2rem)] md:w-full md:max-w-md max-h-[80vh] rounded-lg shadow-2xl overflow-hidden border border-slate-200 flex flex-col"
            >
              {/* Modal Header */}
              <div className="bg-white px-6 py-5 border-b border-slate-100 flex items-center justify-between">
                <div className="flex flex-col">
                  <span className="text-[10px] font-black uppercase tracking-[0.2em] text-indigo-600 mb-1">Xác nhận gửi chờ kiểm</span>
                  <h3 className="text-lg font-black text-slate-800 uppercase tracking-tight">Thêm Mới Phiếu Kiểm</h3>
                </div>
                <button
                  onClick={() => setConfirmingModule(null)}
                  className="p-2 text-slate-400 hover:text-rose-500 transition-colors"
                >
                  <X size={18} />
                </button>
              </div>

              {/* Modal Content */}
              <div className="p-6 space-y-5 bg-white">
                <div className="bg-indigo-100/50 p-4 rounded-lg border border-indigo-100/50 space-y-3">
                  <div className="flex justify-between items-center text-xs">
                    <span className="text-slate-400 font-bold uppercase">Dự án:</span>
                    <span className="text-slate-800 font-extrabold uppercase">{formatProjectName(confirmingModule.projectName)}</span>
                  </div>
                  <div className="flex justify-between items-center text-xs">
                    <span className="text-slate-400 font-bold uppercase">Mã Module:</span>
                    <span className="text-indigo-600 font-black uppercase text-sm">{confirmingModule.moduleCode}</span>
                  </div>
                  <div className="flex justify-between items-center text-xs">
                    <span className="text-slate-400 font-bold uppercase">Phần khu / Cụm:</span>
                    <span className="text-slate-800 font-extrabold uppercase">{confirmingModule.cluster || 'N/A'}</span>
                  </div>
                  <div className="flex justify-between items-center text-xs">
                    <span className="text-slate-400 font-bold uppercase">Kích thước:</span>
                    <span className="text-slate-800 font-mono font-bold">
                      {(confirmingModule.pWidth || confirmingModule.width || 0)} x {(confirmingModule.pHeight || confirmingModule.height || 0)} x {(confirmingModule.pDepth || confirmingModule.depth || 0)} mm
                    </span>
                  </div>
                  <div className="flex justify-between items-center text-xs">
                    <span className="text-slate-400 font-bold uppercase">Số lượng:</span>
                    <span className="text-slate-800 font-extrabold">{confirmingModule.quantity || 1}</span>
                  </div>
                </div>

                {/* Công đoạn gửi tới */}
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block leading-none">Công đoạn chờ kiểm nhận:</label>
                  <div className="p-3 bg-amber-100 text-amber-800 rounded-lg border border-amber-100 text-xs font-black uppercase tracking-wider flex items-center justify-between">
                    <span>CHỜ KIỂM {QC_STAGES.find(s => s.id === getCanAddStage())?.label}</span>
                    <span className="bg-amber-100 text-[10px] px-2 py-0.5 rounded text-amber-700 font-black">PENDING</span>
                  </div>
                </div>
              </div>

              {/* Modal Footer */}
              <div className="p-5 bg-slate-100 border-t border-slate-100 flex items-center gap-3">
                <button
                  onClick={() => setConfirmingModule(null)}
                  className="flex-1 py-3 bg-white text-slate-600 border border-slate-200 rounded-lg text-[10px] font-black uppercase tracking-widest hover:bg-slate-100 transition-all active:scale-95"
                >
                  Huỷ bỏ
                </button>
                <button
                  disabled={loading}
                  onClick={handleConfirmAdd}
                  className="flex-1 py-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-black uppercase tracking-widest text-[10px] shadow-xl shadow-indigo-100 flex items-center justify-center gap-2 active:scale-95 disabled:opacity-100 transition-all"
                >
                  {loading ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                  THÊM HÀNG CHỜ
                </button>
              </div>
            </motion.div>
          </div>
        ) : null}
      </AnimatePresence>

      {showScanner && (
        <ScannerModal
          onClose={() => setShowScanner(false)}
          onScan={handleScanResult}
          projectEntries={projectEntries}
        />
      )}

      {/* Modal Thêm Thủ Công Cấu Kiện */}
      {showManualAddModal && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="bg-white w-full max-w-lg rounded-lg shadow-2xl flex flex-col max-h-[85vh] border border-slate-200"
          >
            {/* Header */}
            <div className="p-5 border-b border-slate-100 bg-white flex items-center justify-between">
              <div className="flex items-center space-x-3">
                <div className="w-10 h-10 bg-indigo-100 text-indigo-600 rounded-lg flex items-center justify-center border border-indigo-100">
                  <Plus size={22} />
                </div>
                <div>
                  <h3 className="text-base font-black text-slate-800 uppercase tracking-tight leading-none">Thêm Cấu Kiện Thủ Công</h3>
                  <p className="text-[10px] text-slate-400 font-bold mt-1 uppercase tracking-widest">
                    Dùng cho trường hợp tem QR bị rách hoặc lỗi
                  </p>
                </div>
              </div>
              <button
                onClick={() => {
                  setShowManualAddModal(false);
                  setSearchModuleSuggestion('');
                  setManualAddClusterFilter('');
                  setClassificationFilter('all');
                }}
                className="p-2 text-slate-400 hover:text-rose-500 transition-colors cursor-pointer"
              >
                <X size={20} />
              </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-5 space-y-4 bg-slate-100/30 flex flex-col">
              {/* Tìm kiếm */}
              <div className="space-y-1.5 shrink-0">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block leading-none">
                  Tìm kiếm theo mã Module / Cấu kiện:
                </label>
                <div className="relative">
                  <input
                    type="text"
                    placeholder="Nhập mã cấu kiện để tìm..."
                    className="w-full bg-white border border-slate-200 rounded px-3 py-2 text-xs font-bold text-slate-800 placeholder-slate-400 outline-none focus:border-indigo-700 focus:ring-1 focus:ring-indigo-700/10 transition-all"
                    value={searchModuleSuggestion}
                    onChange={(e) => setSearchModuleSuggestion(e.target.value)}
                  />
                  {searchModuleSuggestion && (
                    <button
                      type="button"
                      onClick={() => setSearchModuleSuggestion('')}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] font-black text-rose-500 hover:text-rose-700 bg-rose-100 px-1.5 py-0.5 rounded uppercase tracking-wider cursor-pointer"
                    >
                      Xóa
                    </button>
                  )}
                </div>
              </div>

              {/* Bộ lọc loại cấu kiện */}
              <div className="flex gap-1.5 shrink-0 flex-wrap">
                {[
                  { id: 'all', label: 'Tất cả' },
                  { id: 'thung', label: 'Thùng' },
                  { id: 'canh', label: 'Cánh' },
                  { id: 'mat_hk', label: 'Mặt HK' },
                  { id: 'ctht', label: 'CTHT' },
                ].map(f => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => setClassificationFilter(f.id as any)}
                    className={`px-3 py-1.5 rounded text-[10px] font-black uppercase tracking-wider border transition-all cursor-pointer ${
                      classificationFilter === f.id
                        ? 'bg-indigo-600 text-white border-indigo-600'
                        : 'bg-white text-slate-600 border-slate-200 hover:border-indigo-300'
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>

              {/* Bộ lọc cụm + Nút thêm toàn bộ */}
              {(() => {
                // Dùng allDbModules filtered theo project để hiển thị filter, không phụ thuộc selectableModules
                let projectCode = selectedProjectCode;
                if (selectedTicketId) {
                  const ticket = [...filteredTicketGroups.pending, ...filteredTicketGroups.completed].find(t => t.id === selectedTicketId);
                  if (ticket) {
                    const ticketProjectCodes = getTicketProjectCodes(ticket);
                    if (ticketProjectCodes.length > 0) projectCode = ticketProjectCodes[0];
                  }
                }
                const projectModules = allDbModules.filter(m => m.projectCode === projectCode);
                const clusters = [...new Set(projectModules.map(m => m.cluster).filter(Boolean))].sort();
                if (clusters.length === 0) return null;
                return (
                  <div className="flex gap-2 shrink-0">
                    <div className="space-y-1.5 flex-1">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block leading-none">
                        Lọc theo cụm:
                      </label>
                      <select
                        value={manualAddClusterFilter}
                        onChange={(e) => setManualAddClusterFilter(e.target.value)}
                        className="w-full bg-white border border-slate-200 rounded px-3 py-2 text-xs font-bold text-slate-800 outline-none focus:border-indigo-700 transition-all"
                      >
                        <option value="">Tất cả cụm ({selectableModules.length})</option>
                        {clusters.map(cluster => {
                          const count = selectableModules.filter(m => m.cluster === cluster).length;
                          return (
                            <option key={cluster} value={cluster}>{cluster} ({count})</option>
                          );
                        })}
                      </select>
                    </div>
                    <div className="space-y-1.5 shrink-0">
                      <label className="text-[10px] font-black text-transparent uppercase tracking-widest block leading-none select-none">
                        Thêm toàn bộ
                      </label>
                      <button
                        type="button"
                        disabled={filteredSuggestions.length === 0}
                        onClick={async () => {
                          if (!selectedTicketId) {
                            setToast({ message: 'Vui lòng mở phiếu QC trước khi thêm.', type: 'error' });
                            return;
                          }
                          const addedCount = await addAllInstancesToTicket(filteredSuggestions);
                          if (addedCount > 0) {
                            setToast({ message: `Đã thêm ${addedCount} instance vào phiếu`, type: 'success' });
                          } else {
                            setToast({ message: 'Không có instance mới nào được thêm (có thể đã tồn tại trong phiếu).', type: 'error' });
                          }
                        }}
                        className="px-3 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded text-xs font-black uppercase tracking-wider transition-all disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap flex items-center gap-1.5 cursor-pointer"
                      >
                        <CheckCircle size={13} />
                        Thêm toàn bộ
                      </button>
                    </div>
                  </div>
                );
              })()}

              {/* Thông tin */}
              <div className="bg-indigo-100 p-3 rounded-lg border border-indigo-100 flex items-start gap-2 shrink-0">
                <AlertCircle size={14} className="text-indigo-600 shrink-0 mt-0.5" />
                <p className="text-[10px] font-black text-indigo-700 uppercase leading-relaxed tracking-tight">
                  Bấm vào số thứ tự (#) để thêm từng kiện vào phiếu. Hoặc bấm "Thêm toàn bộ" để thêm tất cả instance đang hiển thị.
                </p>
              </div>

              {/* Danh sách modules với instances */}
              <div className="grid grid-cols-1 gap-2 flex-1">
                {filteredSuggestions.length > 0 ? (
                  filteredSuggestions.map(module => {
                    const instances = getModuleInstances(module);
                    const maxQty = module.quantity || 1;

                    // Lấy danh sách instance đã có trong phiếu (khi đang mở phiếu)
                    const ticketUsedIndices = new Set<number>();
                    if (selectedTicketId) {
                      const ticket = [...filteredTicketGroups.pending, ...filteredTicketGroups.completed].find(t => t.id === selectedTicketId);
                      if (ticket) {
                        (ticket.modules || []).forEach((m: any) => {
                          if (m.moduleId === module.id || m.id?.startsWith(module.id + '_')) {
                            if (m.instanceIndex) ticketUsedIndices.add(m.instanceIndex);
                          }
                        });
                      }
                    }

                    // Fallback về stagedModules khi không có phiếu
                    const stagedForModule = stagedModules.filter(sm => sm.module.id === module.id);
                    const usedIndices = selectedTicketId ? ticketUsedIndices : new Set(stagedForModule.map(sm => sm.instanceIndex));

                    return (
                      <div key={module.id} className="bg-white border border-slate-200 rounded-lg overflow-hidden shadow-sm">
                        {/* Header module */}
                        <div className="p-3 flex items-center gap-3 border-b border-slate-100">
                          <div className="w-9 h-9 bg-slate-100 rounded-lg text-slate-400 flex items-center justify-center border border-slate-100">
                            <Plus size={16} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-black text-slate-800 tracking-tight uppercase truncate">{module.moduleCode}</p>
                            <div className="flex items-center gap-2 mt-0.5">
                              <span className="text-[9px] text-slate-400 font-bold uppercase tracking-widest leading-none">
                                {getEntryTypeLocal(module.moduleCode, module)} {module.cluster ? `• ${module.cluster}` : ''}
                              </span>
                            </div>
                          </div>
                          <span className="text-[9px] font-black text-slate-400 uppercase">
                            {usedIndices.size}/{maxQty}
                          </span>
                        </div>
                        {/* Danh sách instances */}
                        <div className="p-2 flex flex-wrap gap-1.5">
                          {Array.from({ length: maxQty }, (_, i) => i + 1).map(idx => {
                            const isUsed = usedIndices.has(idx);
                            const inst = instances.find(inst => inst.instanceIndex === idx);
                            return (
                              <button
                                key={idx}
                                disabled={isUsed}
                                onClick={async () => {
                                  if (selectedTicketId) {
                                    await addModuleToTicket(module, idx);
                                  } else {
                                    addModuleToStaged(module, idx);
                                  }
                                }}
                                className={`px-3 py-1.5 rounded text-[10px] font-black uppercase tracking-wider transition-all ${
                                  isUsed
                                    ? 'bg-slate-100 text-slate-400 cursor-not-allowed border border-slate-100'
                                    : 'bg-indigo-50 text-indigo-600 hover:bg-indigo-100 border border-indigo-200 cursor-pointer active:scale-95'
                                }`}
                              >
                                #{idx}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <div className="p-8 text-center text-slate-400">
                    <Search size={24} className="mx-auto mb-2 text-slate-300" />
                    <p className="text-xs font-bold uppercase tracking-wider">
                      {searchModuleSuggestion ? 'Không tìm thấy cấu kiện phù hợp' : 'Không có cấu kiện nào khả dụng'}
                    </p>
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        </div>
      )}

      {/* Error Message Modal */}
      {scanError && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[200] flex items-center justify-center p-4">
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-white w-full max-w-md rounded-lg shadow-2xl overflow-hidden border border-slate-200"
          >
            <div className="p-6 text-center space-y-4">
              <div className="w-16 h-16 rounded-lg bg-rose-100 text-rose-500 border border-rose-100 flex items-center justify-center mx-auto">
                <AlertCircle size={32} />
              </div>
              <div className="space-y-1">
                <h3 className="text-lg font-black text-slate-800 uppercase tracking-tight">
                  Thông báo QC / Quét mã
                </h3>
                <div className="h-0.5 w-12 mx-auto bg-rose-500 rounded-full"></div>
              </div>

              <div className="text-center bg-slate-100 p-4 rounded-lg space-y-3 border border-slate-100 text-xs">
                <div className="text-rose-600 font-extrabold uppercase tracking-tight text-sm">
                  {typeof scanError === 'string' ? scanError : (scanError as any)?.message}
                </div>

                {typeof scanError === 'object' && scanError !== null && scanError.raw && (
                  <div className="border-t border-slate-200/60 pt-3 space-y-2 text-left font-sans text-xs text-slate-500">
                    <div className="flex flex-col gap-0.5">
                      <span className="font-bold text-[10px] text-slate-400 uppercase tracking-wider">Mã gốc (Raw QR):</span>
                      <span className="font-mono bg-white border border-slate-100 px-2 py-1 rounded text-[11px] text-slate-700 break-all">{scanError.raw}</span>
                    </div>
                    {scanError.fix1 && (
                      <div className="flex flex-col gap-0.5">
                        <span className="font-bold text-[10px] text-slate-400 uppercase tracking-wider">Fix lần 1 (Bỏ prefix số):</span>
                        <span className="font-mono bg-white border border-slate-100 px-2 py-1 rounded text-[11px] text-slate-700 break-all">{scanError.fix1}</span>
                      </div>
                    )}
                    {scanError.fix2 && (
                      <div className="flex flex-col gap-0.5">
                        <span className="font-bold text-[10px] text-slate-400 uppercase tracking-wider">Fix lần 2 (Rút gọn dấu _):</span>
                        <span className="font-mono bg-white border border-slate-100 px-2 py-1 rounded text-[11px] text-indigo-600 break-all font-bold">{scanError.fix2}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <button
                onClick={() => setScanError(null)}
                className="w-full py-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-black uppercase text-[11px] tracking-widest shadow-xl shadow-indigo-100 active:scale-95 transition-all"
              >
                Đã xác nhận
              </button>
            </div>
          </motion.div>
        </div>
      )}

      {/* Merge Notification Modal */}
      {mergeNotice && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[200] flex items-center justify-center p-4">
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-white w-full max-w-md rounded-lg shadow-2xl overflow-hidden border border-slate-200"
          >
            <div className="p-6 text-center space-y-4">
              <div className="w-16 h-16 rounded-lg bg-emerald-100 text-emerald-500 border border-emerald-100 flex items-center justify-center mx-auto">
                <CheckCircle size={32} />
              </div>
              <div className="space-y-1">
                <h3 className="text-sm font-black text-slate-800 uppercase tracking-wider">
                  Tự động gộp danh sách chờ
                </h3>
                <div className="h-0.5 w-12 mx-auto bg-emerald-500 rounded-full"></div>
              </div>

              <div className="text-center bg-slate-100 p-4 border border-slate-100 rounded-lg space-y-2 text-xs">
                <p className="font-extrabold text-slate-700 uppercase tracking-tight text-center">
                  Dự án: <span className="text-indigo-600">{mergeNotice.projectName}</span>
                </p>
                <div className="border-t border-slate-200 my-2 pt-2 text-left space-y-1.5 text-slate-600 font-medium">
                  <div>
                    📌 Đã tự động gộp các cấu kiện vào phiếu chờ kiểm có sẵn: <strong className="text-slate-800">{mergeNotice.ticketName}</strong>
                  </div>
                  <div>
                    📦 Các cấu kiện được gộp:
                  </div>
                  <div className="flex flex-wrap gap-1 mt-1 max-h-[100px] overflow-y-auto p-1 bg-white border border-slate-100 rounded">
                    {mergeNotice.moduleCodes.map((code, idx) => (
                      <span key={idx} className="bg-slate-100 text-slate-600 font-extrabold text-[9px] px-1.5 py-0.5 rounded uppercase border border-slate-100">
                        {code}
                      </span>
                    ))}
                  </div>
                </div>
              </div>

              <button
                onClick={() => setMergeNotice(null)}
                className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-black uppercase text-[10px] tracking-widest transition-all active:scale-95 shadow-none cursor-pointer"
              >
                Đồng ý / Đóng
              </button>
            </div>
          </motion.div>
        </div>
      )}

      {/* Custom Delete Pending Confirmation Modal */}
      {deleteConfirmEntry && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[200] flex items-center justify-center p-4">
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-white w-full max-w-md rounded-lg shadow-2xl overflow-hidden border border-slate-200"
          >
            <div className="p-6 text-center space-y-4">
              <div className="w-16 h-16 rounded-lg bg-rose-100 text-rose-500 border border-rose-100 flex items-center justify-center mx-auto">
                <Trash2 size={32} />
              </div>
              <div className="space-y-1">
                <h3 className="text-lg font-black text-slate-800 uppercase tracking-tight">
                  Xác nhận hủy chờ kiểm
                </h3>
                <div className="h-0.5 w-12 mx-auto bg-rose-500 rounded-full"></div>
              </div>

              <div className="text-center bg-slate-100 p-4 rounded-lg border border-slate-100 text-xs text-slate-600">
                Bạn có chắc chắn muốn hủy yêu cầu chờ kiểm cho module:
                <p className="text-indigo-600 font-extrabold text-sm uppercase mt-1">
                  {deleteConfirmEntry.moduleCode}
                </p>
                {deleteConfirmEntry.cluster && (
                  <p className="text-[10px] text-slate-400 uppercase mt-0.5">
                    Cụm: {deleteConfirmEntry.cluster}
                  </p>
                )}
              </div>

              <div className="flex gap-3">
                <button
                  onClick={() => setDeleteConfirmEntry(null)}
                  disabled={loading}
                  className="flex-1 py-3 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-sm font-black uppercase text-[10px] tracking-widest transition-all disabled:opacity-100"
                >
                  Bỏ qua
                </button>
                <button
                  onClick={executeDeletePending}
                  disabled={loading}
                  className="flex-1 py-3 bg-rose-600 hover:bg-rose-700 text-white rounded-sm font-black uppercase text-[10px] tracking-widest shadow-xl shadow-rose-100 flex items-center justify-center gap-2 active:scale-95 transition-all disabled:opacity-100"
                >
                  {loading ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                  Xác nhận xóa
                </button>
              </div>
            </div>
          </motion.div>
        </div>
      )}

      {/* Custom Delete Ticket Confirmation Modal */}
      {ticketToDelete && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[200] flex items-center justify-center p-4">
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-white w-full max-w-md rounded-lg shadow-2xl overflow-hidden border border-slate-200"
          >
            <div className="p-6 text-center space-y-4">
              <div className="w-16 h-16 rounded-lg bg-rose-100 text-rose-500 border border-rose-100 flex items-center justify-center mx-auto">
                <Trash2 size={32} />
              </div>
              <div className="space-y-1">
                <h3 className="text-lg font-black text-slate-800 uppercase tracking-tight">
                  Xác nhận xóa phiếu kiểm
                </h3>
                <div className="h-0.5 w-12 mx-auto bg-rose-500 rounded-full"></div>
              </div>

              <div className="text-center bg-slate-100 p-4 rounded-lg border border-slate-100 text-xs text-slate-600 leading-relaxed">
                Bạn có chắc chắn muốn xóa phiếu kiểm định:
                <p className="text-indigo-600 font-extrabold text-sm uppercase mt-1">
                  {ticketToDelete.name}
                </p>
                <div className="mt-3 text-[11px] text-slate-500 font-medium bg-white p-3 border border-slate-200 rounded-lg">
                  ⚠️ Hành động này sẽ <strong className="text-rose-500 font-black">XÓA HOÀN TOÀN</strong> phiếu này và <strong className="text-indigo-600 font-extrabold">HOÀN TÁC</strong> toàn bộ thông tin sản xuất & lịch sử QC của <strong className="font-extrabold text-slate-700">{ticketToDelete.modules?.reduce((sum: number, m: any) => sum + (m.quantity || 1), 0) || 0} cấu kiện</strong> trong phiếu về trạng thái trước đó.
                </div>
              </div>

              <div className="flex gap-3">
                <button
                  onClick={() => setTicketToDelete(null)}
                  disabled={loading}
                  className="flex-1 py-3 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg font-black uppercase text-[10px] tracking-widest transition-all disabled:opacity-100"
                >
                  Bỏ qua
                </button>
                <button
                  onClick={() => executeDeleteTicket()}
                  disabled={loading}
                  className="flex-1 py-3 bg-rose-600 hover:bg-rose-700 text-white rounded-lg font-black uppercase text-[10px] tracking-widest shadow-xl shadow-rose-100 flex items-center justify-center gap-2 active:scale-95 transition-all disabled:opacity-100"
                >
                  {loading ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                  Xác nhận xóa
                </button>
              </div>
            </div>
          </motion.div>
        </div>
      )}

      {/* Custom Close Ticket Confirmation Modal */}
      {ticketToClose && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[200] flex items-center justify-center p-4">
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-white w-full max-w-md rounded-lg shadow-2xl overflow-hidden border border-slate-200"
          >
            <div className="p-6 text-center space-y-4">
              <div className="w-16 h-16 rounded-lg bg-amber-100 text-amber-500 border border-amber-100 flex items-center justify-center mx-auto">
                <ArchiveRestore size={32} />
              </div>
              <div className="space-y-1">
                <h3 className="text-lg font-black text-slate-800 uppercase tracking-tight">
                  Đóng Phiếu Kiểm
                </h3>
                <div className="h-0.5 w-12 mx-auto bg-amber-500 rounded-full"></div>
              </div>

              <div className="text-center bg-slate-100 p-4 rounded-lg border border-slate-100 text-xs text-slate-600">
                Phiếu: <p className="text-indigo-600 font-extrabold text-sm uppercase mt-1">{ticketToClose.name}</p>
              </div>

              {!closeMode ? (
                <div className="space-y-3">
                  <p className="text-[11px] text-slate-500 font-medium">Chọn cách xử lý cấu kiện chưa kiểm:</p>

                  <button
                    onClick={() => setCloseMode('passAll')}
                    className="w-full py-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-black uppercase text-[11px] tracking-widest flex items-center justify-center gap-2 active:scale-95 transition-all shadow-md"
                  >
                    <CheckCircle size={16} />
                    Pass Hết
                  </button>
                  <p className="text-[9px] text-slate-400 -mt-1">Tự động ĐẠT tất cả cấu kiện chưa kiểm</p>

                  <button
                    onClick={() => setCloseMode('revert')}
                    className="w-full py-3 bg-amber-500 hover:bg-amber-600 text-white rounded-lg font-black uppercase text-[11px] tracking-widest flex items-center justify-center gap-2 active:scale-95 transition-all shadow-md"
                  >
                    <ArchiveRestore size={16} />
                    Hoàn Trạng Thái
                  </button>
                  <p className="text-[9px] text-slate-400 -mt-1">Trả về trạng thái mộc cho cấu kiện chưa kiểm</p>

                  <button
                    onClick={() => { setTicketToClose(null); setCloseMode(null); }}
                    disabled={loading}
                    className="w-full py-3 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg font-black uppercase text-[10px] tracking-widest transition-all"
                  >
                    Bỏ qua
                  </button>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className={`p-3 rounded-lg border text-[11px] font-bold ${closeMode === 'passAll' ? 'bg-emerald-100 border-emerald-200 text-emerald-800' : 'bg-amber-100 border-amber-200 text-amber-800'}`}>
                    {closeMode === 'passAll'
                      ? 'Tất cả cấu kiện chưa kiểm sẽ được đánh giá ĐẠT (PASS)'
                      : 'Cấu kiện chưa kiểm sẽ được hoàn trả về trạng thái MỘC'}
                  </div>

                  <div className="flex gap-3">
                    <button
                      onClick={() => setCloseMode(null)}
                      disabled={loading}
                      className="flex-1 py-3 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg font-black uppercase text-[10px] tracking-widest transition-all"
                    >
                      Quay lại
                    </button>
                    <button
                      onClick={executeCloseTicket}
                      disabled={loading}
                      className={`flex-1 py-3 text-white rounded-lg font-black uppercase text-[10px] tracking-widest shadow-xl flex items-center justify-center gap-2 active:scale-95 transition-all disabled:opacity-[0.5] ${closeMode === 'passAll' ? 'bg-emerald-600 hover:bg-emerald-700 shadow-emerald-100' : 'bg-amber-500 hover:bg-amber-600 shadow-amber-100'
                        }`}
                    >
                      {loading ? <Loader2 size={12} className="animate-spin" /> : (closeMode === 'passAll' ? <CheckCircle size={12} /> : <ArchiveRestore size={12} />)}
                      {closeMode === 'passAll' ? 'PASS & ĐÓNG PHIẾU' : 'HOÀN TRẠNG THÁI & ĐÓNG'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        </div>
      )}

      {/* Custom Remove Module from Ticket Confirmation Modal */}
      {moduleToRemove && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[200] flex items-center justify-center p-4">
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-white w-full max-w-md rounded-lg shadow-2xl overflow-hidden border border-slate-200"
          >
            <div className="p-6 text-center space-y-4">
              <div className="w-16 h-16 rounded-lg bg-rose-100 text-rose-500 border border-rose-100 flex items-center justify-center mx-auto">
                <Trash2 size={32} />
              </div>
              <div className="space-y-1">
                <h3 className="text-lg font-black text-slate-800 uppercase tracking-tight">
                  Xác nhận xóa cấu kiện khỏi phiếu
                </h3>
                <div className="h-0.5 w-12 mx-auto bg-rose-500 rounded-full"></div>
              </div>

              <div className="text-center bg-slate-100 p-4 rounded-lg border border-slate-100 text-xs text-slate-600 leading-relaxed">
                Bạn có chắc chắn muốn xóa cấu kiện:
                <p className="text-indigo-600 font-extrabold text-sm uppercase mt-1">
                  {moduleToRemove.moduleCode}
                </p>
                <div className="mt-3 text-[11px] text-slate-500 font-medium bg-white p-3 border border-slate-200 rounded-sm">
                  ⚠️ Hành động này sẽ <strong className="text-rose-500 font-black">XÓA</strong> cấu kiện này khỏi phiếu kiểm và <strong className="text-indigo-600 font-extrabold">HOÀN TÁC</strong> toàn bộ thông tin sản xuất & lịch sử QC của cấu kiện này về trạng thái mộc lúc trước.
                </div>
              </div>

              <div className="flex gap-3">
                <button
                  onClick={() => setModuleToRemove(null)}
                  disabled={loading}
                  className="flex-1 py-3 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-sm font-black uppercase text-[10px] tracking-widest transition-all disabled:opacity-100"
                >
                  Bỏ qua
                </button>
                <button
                  onClick={async () => {
                    const { ticket, moduleId } = moduleToRemove;
                    await handleRemoveModuleFromTicket(ticket, moduleId);
                    setModuleToRemove(null);
                  }}
                  disabled={loading}
                  className="flex-1 py-3 bg-rose-600 hover:bg-rose-700 text-white rounded-sm font-black uppercase text-[10px] tracking-widest shadow-xl shadow-rose-100 flex items-center justify-center gap-2 active:scale-95 transition-all disabled:opacity-100"
                >
                  {loading ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                  Xác nhận xóa
                </button>
              </div>
            </div>
          </motion.div>
        </div>
      )}

      {/* Custom Add Module to Ticket Modal */}
      {showAddModuleModal && (() => {
        const ticket = [...filteredTicketGroups.pending, ...filteredTicketGroups.completed].find(t => t.id === selectedTicketId);
        if (!ticket) return null;

        const availableList = getAddableModulesForTicket(ticket);
        const filteredList = availableList.filter(e =>
          matchSearchQuery(e.moduleCode, addingModuleSearchText) ||
          matchSearchQuery(e.cluster || '', addingModuleSearchText)
        );

        return (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[200] flex items-center justify-center p-4">
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="bg-white w-full max-w-lg rounded-lg shadow-2xl overflow-hidden border border-slate-200 flex flex-col max-h-[85vh]"
            >
              {/* Modal Header */}
              <div className="p-4 border-b border-slate-100 flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-black text-slate-800 uppercase tracking-wider">
                    Bổ sung cấu kiện vào phiếu
                  </h3>
                  <p className="text-[10px] text-indigo-500 font-extrabold uppercase mt-0.5">
                    {ticket.name}
                  </p>
                </div>
                <button
                  onClick={() => setShowAddModuleModal(false)}
                  className="p-1 px-1.5 text-slate-400 hover:text-slate-600 rounded-sm hover:bg-slate-100"
                >
                  <X size={16} />
                </button>
              </div>

              {/* Search Bar */}
              <div className="p-4 border-b border-slate-100 bg-slate-100/50">
                <div className="relative">
                  <Search className="absolute left-3 top-2.5 text-slate-400" size={16} />
                  <input
                    type="text"
                    placeholder="Tìm mã cấu kiện hoặc cụm..."
                    value={addingModuleSearchText}
                    onChange={(e) => setAddingModuleSearchText(e.target.value)}
                    className="w-full pl-9 pr-4 py-2 border border-slate-200 rounded-lg bg-white text-slate-800 text-xs focus:ring-1 focus:ring-indigo-500 focus:outline-none transition-all placeholder:text-slate-400"
                  />
                </div>
              </div>

              {/* Scrollable list of modules */}
              <div className="flex-1 overflow-y-auto p-4 space-y-2 min-h-[300px] max-h-[400px]">
                {filteredList.length === 0 ? (
                  <div className="py-12 text-center text-slate-400 text-xs">
                    {availableList.length === 0
                      ? "Không tìm thấy cấu kiện nào của dự án này đủ điều kiện chờ kiểm giai đoạn này."
                      : "Không tìm thấy cấu kiện nào trùng khớp với từ khóa tìm kiếm."
                    }
                  </div>
                ) : (
                  filteredList.map((entry, idx) => {
                    const entryType = getEntryTypeLocal(entry.moduleCode, entry);
                    return (
                      <div
                        key={`${entry.id}-${idx}`}
                        className="flex items-center justify-between border border-slate-100 p-3 rounded-lg hover:bg-slate-100/50 transition-all gap-4"
                      >
                        <div className="min-w-0 flex-1">
                          <span className="text-[9px] bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded-sm font-black uppercase tracking-wider inline-block mb-1">
                            {entryType}
                          </span>
                          <span className="text-[9px] text-slate-400 font-bold ml-2 uppercase">
                            Cụm: {entry.cluster || 'N/A'} (SL: {entry.quantity || 1})
                          </span>
                          <h5 className="text-xs font-black text-slate-800 uppercase tracking-tight truncate">
                            {entry.moduleCode}
                          </h5>
                        </div>

                        <button
                          type="button"
                          onClick={() => handleAddModuleToTicket(ticket, entry)}
                          disabled={loading}
                          className="flex items-center gap-1 bg-indigo-600 hover:bg-indigo-700 text-white px-2.5 py-1.5 rounded-sm text-[10px] font-black uppercase tracking-wider transition-colors disabled:opacity-100 shrink-0 select-none cursor-pointer"
                        >
                          <Plus className="shrink-0" size={11} strokeWidth={3} />
                          Thêm
                        </button>
                      </div>
                    );
                  })
                )}
              </div>

              {/* Modal Footer */}
              <div className="p-3 bg-slate-100 border-t border-slate-100 text-right">
                <button
                  onClick={() => setShowAddModuleModal(false)}
                  className="px-4 py-2 bg-white hover:bg-slate-100 border border-slate-200 text-slate-700 text-[10px] font-black uppercase tracking-widest rounded-sm transition-colors active:scale-95"
                >
                  Đóng
                </button>
              </div>
            </motion.div>
          </div>
        );
      })()}

      {viewingModule && (
        <ModuleDetailModal
          module={viewingModule}
          onClose={() => { setViewingModule(null); setViewingModuleQcStage(undefined); setViewingModuleInstanceIndex(undefined); }}
          qcStage={viewingModuleQcStage}
          instanceIndex={viewingModuleInstanceIndex}
          onOpenPacking={(instIdx?: number) => {
            if (setParentActiveTab) {
              setParentActiveTab('packing');
              window.dispatchEvent(new CustomEvent('focus-packing-module', { detail: { moduleName: viewingModule.moduleCode, instanceIndex: instIdx ?? viewingModuleInstanceIndex } }));
            }
          }}
        />
      )}

      {/* Modal: Tạo Phiếu Chờ Kiểm QC */}
      <AnimatePresence>
        {showCreateTicketModal && (
          <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              className="bg-white w-[calc(100%-2rem)] md:w-full md:max-w-md max-h-[80vh] rounded-lg shadow-2xl overflow-hidden border border-slate-200 flex flex-col"
            >
              {/* Modal Header */}
              <div className="bg-gradient-to-r from-gray-100 to-white px-6 py-4 border-b border-gray-100 flex items-center justify-between shrink-0">
                <div className="flex items-center gap-2">
                  <Plus className="text-indigo-600" size={18} />
                  <h3 className="text-sm font-black text-gray-800 uppercase tracking-widest">Tạo Phiếu Chờ Kiểm QC</h3>
                  {getCreationConfig() && (
                    <span className="bg-indigo-100 text-indigo-600 px-3 py-1 rounded-sm text-[10px] font-black uppercase tracking-widest border border-indigo-100">
                      {getCreationConfig()?.label}
                    </span>
                  )}
                </div>
                <button
                  onClick={() => setShowCreateTicketModal(false)}
                  className="p-2 text-slate-400 hover:text-rose-500 transition-colors"
                >
                  <X size={20} />
                </button>
              </div>

              {/* Modal Content */}
              <div className="p-6 space-y-5 overflow-y-auto flex-1">
                <div>
                  <label className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-2 block">Chọn Dự Án</label>
                  <select
                    value={selectedProjectCode}
                    onChange={(e) => setSelectedProjectCode(e.target.value)}
                    className="w-full bg-gray-100 border border-gray-200 rounded-lg px-4 py-3 text-sm font-bold focus:border-indigo-500 outline-none transition-all"
                  >
                    <option value="">-- CHỌN DỰ ÁN --</option>
                    {projects.map(p => (
                      <option key={p.code} value={p.code}>{formatProjectCode(p.code)}: {p.name}</option>
                    ))}
                  </select>
                </div>

                {getCreationConfig()?.multiStage && (
                  <div>
                    <label className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-2 block">Loại Kiểm</label>
                    <div className="flex gap-3">
                      <button
                        onClick={() => setSelectedCreationStage('paint')}
                        className={`flex-1 py-3 rounded-lg text-[11px] font-black uppercase tracking-widest border-2 transition-all ${
                          selectedCreationStage === 'paint'
                            ? 'bg-amber-100 border-amber-400 text-amber-700'
                            : 'bg-white border-gray-200 text-gray-400 hover:border-gray-300'
                        }`}
                      >
                        Hàng Sơn
                      </button>
                      <button
                        onClick={() => setSelectedCreationStage('finish')}
                        className={`flex-1 py-3 rounded-lg text-[11px] font-black uppercase tracking-widest border-2 transition-all ${
                          selectedCreationStage === 'finish'
                            ? 'bg-sky-100 border-sky-400 text-sky-700'
                            : 'bg-white border-gray-200 text-gray-400 hover:border-gray-300'
                        }`}
                      >
                        Hàng Hoàn Thiện
                      </button>
                    </div>
                  </div>
                )}

                <div className="bg-amber-100 rounded-lg p-4 border border-amber-100">
                  <div className="flex items-center gap-2 text-amber-700 mb-2">
                    <AlertCircle size={14} />
                    <span className="text-[10px] font-black uppercase tracking-widest">Hướng dẫn</span>
                  </div>
                  <p className="text-[11px] text-amber-800/80 leading-relaxed font-semibold">
                    Hệ thống sẽ tạo một phiếu kiểm <strong>trống</strong> theo giai đoạn bạn được phân công.
                    Sau đó, bạn dùng nút <strong>"Quét QR"</strong> trong phiếu để thêm cấu kiện vào danh sách.
                  </p>
                </div>
              </div>

              {/* Modal Footer */}
              <div className="px-6 py-3 bg-slate-100 border-t border-slate-100 flex items-center justify-end gap-2 shrink-0">
                <button
                  onClick={() => setShowCreateTicketModal(false)}
                  className="px-4 py-2 bg-white hover:bg-slate-100 border border-slate-200 text-slate-700 text-[10px] font-black uppercase tracking-widest rounded-lg transition-colors active:scale-95"
                >
                  Hủy
                </button>
                <button
                  onClick={handleCreateEmptyTicket}
                  disabled={loading || !selectedProjectCode || (getCreationConfig()?.multiStage && !selectedCreationStage)}
                  className="px-5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-[10px] font-black uppercase tracking-widest rounded-lg transition-all active:scale-95 disabled:opacity-40 disabled:pointer-events-none flex items-center gap-2"
                >
                  {loading ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                  Tạo Phiếu
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <ImageLightboxModal
        images={lightboxImages}
        startIndex={lightboxStartIndex}
        isOpen={lightboxOpen}
        onClose={() => setLightboxOpen(false)}
      />

      {/* Toast Notification */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: -20, x: '-50%' }}
            animate={{ opacity: 1, y: 0, x: '-50%' }}
            exit={{ opacity: 0, y: -20, x: '-50%' }}
            className={`fixed top-4 left-1/2 z-[9999] px-5 py-3 rounded-lg shadow-lg border font-sans text-sm font-bold flex items-center gap-2 ${toast.type === 'success'
              ? 'bg-emerald-100 text-emerald-800 border-emerald-200'
              : 'bg-rose-100 text-rose-800 border-rose-200'
              }`}
          >
            {toast.type === 'success' ? <CheckCircle size={16} /> : <AlertCircle size={16} />}
            {toast.message}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );

}

